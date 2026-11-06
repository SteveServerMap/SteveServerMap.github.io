import test from 'node:test';
import assert from 'node:assert/strict';
import { TileLayer, Tileset, parseManifest, formatGeneratedAt } from '../assets/js/tiles.js';

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

test('interacting switches tile sampling to bilinear, at rest stays nearest', (t) => {
  installFakes(t);
  const { canvas, ctx } = canvasFake();
  const layer = new TileLayer(canvas, { tileset: tileset() });
  t.after(() => layer.destroy());
  layer.setActive(true);
  // 1 瓦片像素 = 1 canvas 像素（放大）：静止时 nearest 保持像素锐利
  const vs = { scale: 1, tx: 0, ty: 0, viewWidth: 128, viewHeight: 128 };
  layer.update(vs);
  assert.equal(ctx.imageSmoothingEnabled, false);
  assert.equal(canvas.style.imageRendering, 'pixelated');
  // 拖拽 / 动画等交互中：双线性让画面亚像素连续移动（nearest 会逐帧重锚成 1px 台阶）
  layer.update({ ...vs, interacting: true });
  assert.equal(ctx.imageSmoothingEnabled, true);
  assert.equal(canvas.style.imageRendering, 'auto');
  // 缩小（1 瓦片像素 < 1 canvas 像素）：任何状态都平滑（防摩尔纹）
  layer.update({ ...vs, scale: 0.5 });
  assert.equal(ctx.imageSmoothingEnabled, true);
  assert.equal(canvas.style.imageRendering, 'auto');
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
