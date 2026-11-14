import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TileLayer, Tileset, parseManifest, formatGeneratedAt,
  TILE_RETRY_DELAYS, TILE_TRANSIENT_TTL,
} from '../assets/js/tiles.js';

function installFakes(t) {
  const images = [];
  const frames = new Map();
  let nextFrame = 0;
  const replacements = {
    Image: class {
      naturalWidth = 256;
      naturalHeight = 256;
      alpha = 0.5;
      constructor() { images.push(this); }
    },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  for (const [key, value] of Object.entries(replacements)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  return { images, frames };
}

function tileset(baseUrl = 'first/', span = 256, levels = [0]) {
  return new Tileset({
    baseUrl, tileSize: 256,
    bounds: { xMin: 0, xMax: span, zMin: 0, zMax: span },
    levels: levels.map((level) => ({
      level, blocksPerPixel: 2 ** level, minX: 0, minZ: 0,
      maxX: Math.ceil(span / (256 * 2 ** level)) - 1,
      maxZ: Math.ceil(span / (256 * 2 ** level)) - 1,
      originBlockX: 0, originBlockZ: 0,
    })),
  });
}

// A single sampled pixel with source-over alpha, not a browser canvas emulator.
// Tests render one tile at a time so alpha accumulation is deterministic.
function canvasFake() {
  let width = 0, height = 0;
  const ctx = {
    alpha: 0, image: null, clears: 0, resizes: 0,
    setTransform() {},
    clearRect() { this.alpha = 0; this.image = null; this.clears += 1; },
    drawImage(img) {
      this.alpha = img.alpha + this.alpha * (1 - img.alpha);
      this.image = img;
    },
  };
  const canvas = {
    style: {}, getContext: () => ctx,
    get width() { return width; },
    set width(value) { width = value; ctx.resizes += 1; ctx.clearRect(); },
    get height() { return height; },
    set height(value) { height = value; ctx.resizes += 1; ctx.clearRect(); },
  };
  return { canvas, ctx };
}

for (const resetMode of ['new-source', 'clear-cache', 'keep-cache']) {
  for (const event of ['load', 'error', 'empty-load']) {
    test(`${resetMode}: stale ${event} cannot delete pending, pollute cache or mark missing`, (t) => {
      const { images, frames } = installFakes(t);
      const { canvas } = canvasFake();
      const layer = new TileLayer(canvas, { tileset: tileset() });
      t.after(() => layer.destroy());
      layer._loadTile(layer.tileset.levels[0], 0, 0);
      const old = images[0];
      if (resetMode === 'new-source') layer.setTileset(tileset('second/'));
      else layer.reset({ keepCache: resetMode === 'keep-cache' });
      layer._loadTile(layer.tileset.levels[0], 0, 0);
      assert.equal(images.length, 2, 'reset allows a new request with the same tile key');
      const current = images[1];
      const before = layer.stats;
      const fireOld = () => {
        if (event === 'empty-load') old.naturalWidth = 0;
        if (event === 'error') old.onerror();
        else old.onload();
      };
      fireOld();
      assert.equal(layer._pending.has('0/0_0'), true);
      assert.equal(layer._images.size, 0);
      assert.equal(layer._missing.size, 0);
      assert.deepEqual(layer.stats, before);
      assert.equal(frames.size, 0);
      layer._loadTile(layer.tileset.levels[0], 0, 0);
      assert.equal(images.length, 2, 'late old completion must not cause a duplicate request');
      current.onload();
      assert.equal(layer._pending.size, 0);
      assert.equal(layer._images.get('0/0_0'), current);
      assert.equal(frames.size, 1);
      const completed = layer.stats;
      fireOld();
      assert.equal(layer._images.get('0/0_0'), current);
      assert.equal(layer._missing.size, 0);
      assert.deepEqual(layer.stats, completed);
    });
  }
}

test('destroy isolates pending callbacks and cancels scheduled redraws', (t) => {
  const { images, frames } = installFakes(t);
  const { canvas } = canvasFake();
  const layer = new TileLayer(canvas, { tileset: tileset() });
  layer._loadTile(layer.tileset.levels[0], 0, 0);
  layer.destroy();
  images[0].onload();
  images[0].onerror();
  assert.equal(layer._pending.size, 0);
  assert.equal(layer._images.size, 0);
  assert.equal(layer._missing.size, 0);
  assert.equal(frames.size, 0);
});

test('repeated frames do not accumulate translucent tile alpha', (t) => {
  const { images } = installFakes(t);
  const { canvas, ctx } = canvasFake();
  const layer = new TileLayer(canvas, { tileset: tileset() });
  t.after(() => layer.destroy());
  layer.setActive(true);
  const vs = { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 };
  layer.update(vs);
  images[0].onload();
  for (let i = 0; i < 5; i += 1) {
    layer.update(vs);
    assert.equal(ctx.alpha, 0.5);
    assert.equal(layer.stats.drawn, 1);
  }
  assert.equal(images.length, 1, 'redraw uses the decoded cache');
  layer.update({ ...vs, tx: 512 });
  assert.equal(ctx.alpha, 0, 'an out-of-bounds view also clears old content');
  assert.equal(layer.stats.drawn, 0);
});

test('pans freeze the backing inside the always-overscan window', (t) => {
  const { images } = installFakes(t);
  const { canvas, ctx } = canvasFake();
  const layer = new TileLayer(canvas, { tileset: tileset() });
  t.after(() => layer.destroy());
  layer.setActive(true);
  const vs = { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 };
  layer.update(vs);

  // 静止即外扩窗口：盒 = 视口每边外扩 25%（32px），位图 = 1.5×视口
  assert.equal(canvas.style.left, '-32px');
  assert.equal(canvas.style.top, '-32px');
  assert.equal(canvas.style.width, '192px');
  assert.equal(canvas.width, 192);
  assert.equal(canvas.height, 192);

  // 瓦片解码完成强制一次重画（否则冻结判定会把新内容永远挡在门外）
  images[0].onload();
  layer.draw();
  assert.equal(layer.stats.drawn, 1);
  const settled = [canvas.width, canvas.height, ctx.clears, ctx.resizes, canvas.style.left, canvas.style.width];

  // 窗口内平移（无需 interacting 信号）：完全冻结 —— 不清屏、不重设位图、盒不动，
  // 画面移动交给 #stage 的 transform
  layer.update({ ...vs, tx: 10 });
  layer.update({ ...vs, tx: 31.7 });
  layer.update({ ...vs, ty: 20 });
  assert.deepEqual(
    [canvas.width, canvas.height, ctx.clears, ctx.resizes, canvas.style.left, canvas.style.width],
    settled,
  );

  // 视口滑出窗口左缘（x0 = -tx < -32）：重画一次，窗口重新居中，位图尺寸不变
  layer.update({ ...vs, tx: 50 });
  assert.equal(ctx.clears, settled[2] + 1);
  assert.equal(canvas.style.left, '-82px');
  assert.equal(canvas.width, settled[0], 'window size stays constant across reframe');

  // 缩放变化（捏合 / 动画）：立即重画。窗口在图片像素空间变大（384px），
  // 但位图 = 窗口 × scale 恒为 1.5×视口 = 192px，无需 resize —— 只多一次清屏重画
  const beforeZoom = ctx.clears;
  layer.update({ ...vs, tx: 50, scale: 0.5 });
  assert.equal(ctx.clears, beforeZoom + 1);
  assert.equal(canvas.width, settled[0], 'bitmap size is constant across scale');
  assert.equal(canvas.style.width, '384px');

  // 缩放恢复：重画（scale 变化），盒回到 192px
  layer.update({ ...vs, tx: 50 });
  assert.equal(canvas.style.width, '192px');

  // 进出交互都不换窗口：interacting 翻转不引起任何重画（静止与拖拽同一路径）
  const beforeEnd = ctx.clears;
  layer.update({ ...vs, tx: 50, interacting: true });
  layer.update({ ...vs, tx: 50, interacting: false });
  assert.equal(ctx.clears, beforeEnd);
  assert.equal(canvas.style.width, '192px');
});

test('freeze works without the interacting flag (config tool shares this path)', (t) => {
  const { images } = installFakes(t);
  const { canvas, ctx } = canvasFake();
  const layer = new TileLayer(canvas, { tileset: tileset() });
  t.after(() => layer.destroy());
  layer.setActive(true);
  const vs = { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 };
  layer.update(vs);
  images[0].onload();
  layer.draw();
  const settled = [ctx.clears, ctx.resizes, canvas.style.left, canvas.width, layer.stats.drawn];
  // 无 interacting 字段的视图状态（配置工具不传）：窗口内平移同样冻结
  layer.update({ ...vs, tx: 10 });
  layer.update({ ...vs, tx: 20 });
  assert.deepEqual([ctx.clears, ctx.resizes, canvas.style.left, canvas.width, layer.stats.drawn], settled);
});

test('switching capped levels with identical backing dimensions clears stale tiles', (t) => {
  const { images } = installFakes(t);
  const { canvas, ctx } = canvasFake();
  // Both levels exceed the pixel cap and therefore get equal backing sizes.
  const layer = new TileLayer(canvas, { tileset: tileset('large/', 16384, [0, 1]) });
  t.after(() => layer.destroy());
  layer.setActive(true);
  const vs = { scale: 1, tx: 0, ty: 0, viewWidth: 32, viewHeight: 32 };
  layer.update(vs);
  images[0].onload();
  layer.draw();
  assert.equal(ctx.alpha, 0.5);
  const backing = [canvas.width, canvas.height, ctx.resizes];
  layer.update({ ...vs, scale: 0.5 });
  assert.equal(layer.stats.level, 1);
  assert.deepEqual([canvas.width, canvas.height, ctx.resizes], backing);
  assert.equal(ctx.alpha, 0, 'no implicit resize occurred, but previous level must be gone');
  assert.equal(ctx.image, null);
  images[1].onerror();
  layer.draw();
  assert.equal(ctx.alpha, 0, 'a missing tile must remain transparent');
});

test('parseManifest carries raw generatedAt onto the Tileset', () => {
  const raw = {
    tileSize: 256,
    generatedAt: '2026-11-05T12:34:56.789Z',
    source: 'xaero',
    worldBlockRange: { xMin: 0, xMax: 512, zMin: 0, zMax: 512 },
    levels: [{
      level: 0, blocksPerPixel: 1, minX: 0, maxX: 1, minZ: 0, maxZ: 1,
      cols: 2, rows: 2, originBlockX: 0, originBlockZ: 0,
    }],
  };
  const tileset = parseManifest(raw, { manifestUrl: 'tiles/overworld/manifest.json' });
  assert.ok(tileset);
  assert.equal(tileset.generatedAt, '2026-11-05T12:34:56.789Z');
  assert.equal(tileset.version, '2026-11-05T123456.789Z');
  assert.equal(tileset.toJSON().generatedAt, '2026-11-05T12:34:56.789Z');

  const noDate = parseManifest({ ...raw, generatedAt: undefined }, { manifestUrl: 'tiles/o/manifest.json' });
  assert.equal(noDate.generatedAt, '');
  assert.equal(noDate.version, '');
});

test('formatGeneratedAt renders local date plus relative day', () => {
  // 用注入的 now 固定「今天」，避免跨时区/跨日波动：now 为 2026-11-06 中午（本地时区）
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const sameDay = new Date(2026, 10, 6, 8, 5, 0).toISOString();
  assert.match(formatGeneratedAt(sameDay, now), /^瓦片更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（今天）$/);

  const yesterday = new Date(2026, 10, 5, 23, 59, 0).toISOString();
  assert.match(formatGeneratedAt(yesterday, now), /（昨天）$/);

  const threeDaysAgo = new Date(2026, 10, 3, 9, 30, 0).toISOString();
  assert.match(formatGeneratedAt(threeDaysAgo, now), /（3 天前）$/);

  assert.equal(formatGeneratedAt('', now), '');
  assert.equal(formatGeneratedAt(null, now), '');
  assert.equal(formatGeneratedAt(undefined, now), '');
  assert.equal(formatGeneratedAt('not-a-date', now), '');
  assert.equal(formatGeneratedAt(12345, now), '');
});

/* -------------------------------------------------------------------------- *
 * 瞬时错误重试（404 = 永久缺失，5xx / 断网 = 退避重试）
 * -------------------------------------------------------------------------- */

/** 伪造 Resource Timing：按 URL 返回一个带 responseStatus 的条目（没列出的 URL 无条目） */
function installResourceStatus(t, statusByUrl) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    writable: true,
    value: {
      getEntriesByName(url) {
        return url in statusByUrl ? [{ name: url, responseStatus: statusByUrl[url] }] : [];
      },
    },
  });
  t.after(() => (
    descriptor ? Object.defineProperty(globalThis, 'performance', descriptor) : delete globalThis.performance
  ));
}

/** 记录每次 drawImage 的全部参数（区分细层 5 参数与粗层兜底 9 参数） */
function recordingCanvas() {
  const calls = [];
  let width = 0;
  let height = 0;
  const ctx = {
    setTransform() {},
    clearRect() {},
    drawImage(...args) { calls.push(args); },
  };
  const canvas = {
    style: {},
    getContext: () => ctx,
    get width() { return width; },
    set width(value) { width = value; },
    get height() { return height; },
    set height(value) { height = value; },
  };
  return { canvas, ctx, calls };
}

function makeActiveLayer(canvas, set, viewState) {
  const layer = new TileLayer(canvas, { tileset: set });
  layer.setActive(true);
  layer.update(viewState);
  return layer;
}

test('404 是永久缺失：不重试、不进瞬时失败、之后也不再请求', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { images } = installFakes(t);
  installResourceStatus(t, { 'first/0/0_0.png': 404 });
  const { canvas } = canvasFake();
  const layer = makeActiveLayer(canvas, tileset(), { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 });
  t.after(() => layer.destroy());

  images[0].onerror();
  assert.equal(layer._missing.has('0/0_0'), true, '404 进永久缺失');
  assert.equal(layer.stats.missing, 1);
  assert.equal(layer.stats.transient, 0);
  assert.equal(layer.stats.retries, 0, '404 不排队重试');
  assert.equal(layer._retryTimers.size, 0);

  t.mock.timers.tick(TILE_TRANSIENT_TTL * 2);
  layer.draw();
  assert.equal(images.length, 1, '永久缺失不会再请求');
});

test('503 瞬时错误：2 秒后退避重试，成功即进缓存并清掉重试状态', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { images } = installFakes(t);
  installResourceStatus(t, { 'first/0/0_0.png': 503 });
  const { canvas } = canvasFake();
  const layer = makeActiveLayer(canvas, tileset(), { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 });
  t.after(() => layer.destroy());

  images[0].onerror();
  assert.equal(layer._missing.size, 0, '瞬时错误不进永久缺失');
  assert.equal(layer.stats.retries, 1);
  assert.equal(layer._retryTimers.size, 1);

  t.mock.timers.tick(TILE_RETRY_DELAYS[0] - 1);
  assert.equal(images.length, 1, '退避未到时间不重发');
  t.mock.timers.tick(1);
  assert.equal(images.length, 2, '2 秒后退避重试');

  images[1].onload();
  assert.equal(layer._images.get('0/0_0'), images[1]);
  assert.equal(layer.stats.transient, 0);
  assert.equal(layer.stats.retries, 1, 'retries 是累计次数');
  assert.equal(layer._retries.size, 0);
  assert.equal(layer._retryTimers.size, 0);
});

test('读不到 HTTP 状态时按瞬时错误处理（宁可多试，不把 503 变永久空白）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { images } = installFakes(t);
  installResourceStatus(t, {});
  const { canvas } = canvasFake();
  const layer = makeActiveLayer(canvas, tileset(), { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 });
  t.after(() => layer.destroy());

  images[0].onerror();
  assert.equal(layer._missing.size, 0);
  assert.equal(layer.stats.transient, 0);
  assert.equal(layer._retryTimers.size, 1);
});

test('3 次退避仍失败 → 60 秒瞬时失败（不是永久缺失），到期自动重来', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { images } = installFakes(t);
  installResourceStatus(t, { 'first/0/0_0.png': 503 });
  const { canvas } = canvasFake();
  const layer = makeActiveLayer(canvas, tileset(), { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 });
  t.after(() => layer.destroy());

  // 首次 + 3 次重试：每次失败后按 2/5/10 秒排下一轮
  for (let attempt = 0; attempt < TILE_RETRY_DELAYS.length; attempt += 1) {
    images[attempt].onerror();
    t.mock.timers.tick(TILE_RETRY_DELAYS[attempt]);
  }
  images[TILE_RETRY_DELAYS.length].onerror();
  assert.equal(images.length, TILE_RETRY_DELAYS.length + 1);
  assert.equal(layer.stats.retries, TILE_RETRY_DELAYS.length);
  assert.equal(layer.stats.transient, 1, '重试耗尽后进入瞬时失败');
  assert.equal(layer._missing.size, 0, '绝不能写成永久缺失');

  // TTL 内：任何绘制都不再请求
  t.mock.timers.tick(TILE_TRANSIENT_TTL - 1);
  layer.draw();
  assert.equal(images.length, TILE_RETRY_DELAYS.length + 1, 'TTL 内不请求');

  // TTL 到期：静止画面也会自动放行一轮
  t.mock.timers.tick(1);
  layer.draw();
  assert.equal(layer.stats.transient, 0);
  assert.equal(images.length, TILE_RETRY_DELAYS.length + 2, 'TTL 到期后重新请求');
});

test('online / 回到前台会立刻清掉瞬时失败并重新请求', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { images } = installFakes(t);
  installResourceStatus(t, { 'first/0/0_0.png': 503, 'first/0/1_0.png': 503 });

  const listeners = new Map();
  const eventTarget = () => ({
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
  });
  const documentFake = { visibilityState: 'hidden', ...eventTarget() };
  for (const [key, value] of [['window', eventTarget()], ['document', documentFake]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => (descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]));
  }

  const { canvas } = canvasFake();
  const layer = new TileLayer(canvas, { tileset: tileset() });
  layer.setActive(true);
  t.after(() => layer.destroy());

  layer._markTransient('0/0_0');
  assert.equal(layer.stats.transient, 1);
  listeners.get('online')();
  assert.equal(layer.stats.transient, 0, 'online 清空瞬时失败');
  layer._loadTile(layer.tileset.levels[0], 0, 0);
  assert.equal(images.length, 1, 'online 后允许重新请求');

  layer._markTransient('0/1_0');
  documentFake.visibilityState = 'visible';
  listeners.get('visibilitychange')();
  assert.equal(layer.stats.transient, 0, '回到前台清空瞬时失败');

  layer.destroy();
  assert.equal(listeners.has('online'), false, 'destroy 摘掉监听器');
});

/* -------------------------------------------------------------------------- *
 * 粗层兜底 + 逐级细化
 * -------------------------------------------------------------------------- */

test('细层请求中不预取粗层（首屏字节不翻倍），细层到达后直接贴细层', (t) => {
  const { images } = installFakes(t);
  const { canvas, calls } = recordingCanvas();
  const set = tileset('fb/', 512, [0, 1]);
  const layer = makeActiveLayer(canvas, set, { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 });
  t.after(() => layer.destroy());

  assert.equal(layer.stats.level, 0);
  assert.equal(layer.stats.requests, 1, '只请求细层，粗层留着到真正需要时再取');
  const fineImg = images.find((img) => img.src === 'fb/0/0_0.png');
  assert.ok(fineImg);
  assert.equal(images.find((img) => img.src === 'fb/1/0_0.png'), undefined);

  // 换窗口仍然是请求中的细层：依旧不抢救式地拉粗层
  layer.update({ scale: 1, tx: 60, ty: 0, viewWidth: 128, viewHeight: 128 });
  assert.equal(layer.stats.requests, 1);
  assert.equal(calls.length, 0, '没有可用的粗层就不画，自由合成外扩窗口继续等细层');

  fineImg.onload();
  calls.length = 0;
  layer.draw();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], fineImg);
  assert.equal(calls[0].length, 5);
  assert.equal(layer.stats.requests, 1, '全程不请求粗层');
});

test('粗层已在缓存（缩放留下的上一层）时先贴粗层兜底，细层到达后替换', (t) => {
  const { images } = installFakes(t);
  const { canvas, calls } = recordingCanvas();
  const set = tileset('fb/', 512, [0, 1]);
  const layer = new TileLayer(canvas, { tileset: set });
  layer.setActive(true);
  t.after(() => layer.destroy());

  // 先把粗层放进缓存，模拟从远景放大：上一层瓦片还在 LRU 里
  layer._loadTile(layer.tileset.levels[1], 0, 0);
  const coarseImg = images.find((img) => img.src === 'fb/1/0_0.png');
  coarseImg.onload();

  layer.update({ scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 });
  assert.equal(layer.stats.requests, 2, '兜底只读缓存，不额外请求');
  const fineImg = images.find((img) => img.src === 'fb/0/0_0.png');

  // 细层请求中：用 9 参数把 512px 粗瓦片按源矩形裁着贴上去
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], coarseImg);
  assert.equal(calls[0].length, 9);
  assert.equal(calls[0][5], 32, '粗瓦片左缘相对窗口原点（窗口每边外扩 32px）');
  assert.equal(calls[0][7], 512, '粗瓦片目标尺寸 = 256 × 2^1');

  // 细层到达：重画只贴细层（5 参数），粗层兜底不再出现
  fineImg.onload();
  calls.length = 0;
  layer.draw();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], fineImg);
  assert.equal(calls[0].length, 5);
  assert.equal(calls[0][3], 256);
  assert.equal(layer.stats.drawn, 1);
});

test('细层永久缺失时请求父级粗瓦片长期兜底（不留空白格）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { images } = installFakes(t);
  installResourceStatus(t, { 'fb/0/0_0.png': 404 });
  const { canvas, calls } = recordingCanvas();
  const set = tileset('fb/', 512, [0, 1]);
  const layer = makeActiveLayer(canvas, set, { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 });
  t.after(() => layer.destroy());

  const fineImg = images.find((img) => img.src === 'fb/0/0_0.png');
  assert.equal(layer.stats.requests, 1, '首屏只请求细层');
  fineImg.onerror();
  assert.equal(layer._missing.has('0/0_0'), true);

  // 判定永久缺失后才值得为补洞去请求粗层
  calls.length = 0;
  layer.draw();
  const coarseImg = images.find((img) => img.src === 'fb/1/0_0.png');
  assert.ok(coarseImg, '缺失的细层触发粗层请求');
  assert.equal(layer.stats.requests, 2);
  coarseImg.onload();

  calls.length = 0;
  layer.draw();
  assert.equal(layer.stats.drawn, 1);
  assert.equal(calls[0][0], coarseImg, '缺失的细层由粗层顶上');
  assert.equal(layer.stats.missing, 1);

  calls.length = 0;
  layer.update({ scale: 1, tx: 60, ty: 0, viewWidth: 128, viewHeight: 128 });
  assert.equal(calls[0][0], coarseImg, '换窗口重画时继续兜底，且不再请求');
  assert.equal(layer.stats.requests, 2);
});

