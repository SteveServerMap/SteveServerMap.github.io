/* 探针：实测「恒外扩窗口 + 平移冻结」方案
 * 验证：(1) 静止态窗口即外扩 1.5×（位图 = 1.5×视口×dpr）
 *       (2) 拖动全程零重画（位图冻结、纯 CSS 平移）(3) 松手零重画零变化
 *       (4) #stage 亚像素连续移动 (5) 画面保持锐利
 * 方法：CDP 真实鼠标事件分步拖动 + 连拍截图互相关（整数位移残差 / 梯度锐度）
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import zlib from 'node:zlib';
import { startStaticServer, launchBrowser, CDP, Page, sleep, ensureDir } from './headless.mjs';

/* ---------- 最小 PNG 解码（8-bit RGB/RGBA 非隔行，够截图用） ---------- */
function decodePng(buf) {
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  for (;;) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('隔行 PNG 不支持');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`不支持的颜色格式 ${colorType}/${bitDepth}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);
  const prev = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    for (let x = 0; x < stride; x += 1) { row[x] = raw[pos]; pos += 1; }
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 0xff;
    }
    row.copy(out, y * stride);
    row.copy(prev);
  }
  return { width, height, bpp, data: out };
}

function cropLuma(img, x, y, w, h) {
  const luma = new Float64Array(w * h);
  for (let j = 0; j < h; j += 1) {
    const src = (y + j) * img.width * img.bpp + x * img.bpp;
    for (let i = 0; i < w; i += 1) {
      const p = src + i * img.bpp;
      luma[j * w + i] = 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2];
    }
  }
  return luma;
}

/** 在 [-max..max]² 内找整数位移的残差最小值：残差≈0 说明画面是整数台阶移动 */
function bestShift(a, b, w, h, maxShift) {
  let best = { dx: 0, dy: 0, resid: Infinity };
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
      const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
      if (x1 - x0 < 64 || y1 - y0 < 64) continue;
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const d = a[y * w + x] - b[(y + dy) * w + (x + dx)];
          sum += d * d;
          n += 1;
        }
      }
      const resid = Math.sqrt(sum / n);
      if (resid < best.resid) best = { dx, dy, resid };
    }
  }
  return best;
}

/** 平均梯度幅值：边缘锐度的代理指标 */
function gradientScore(luma, w, h) {
  let sum = 0, n = 0;
  for (let y = 1; y < h; y += 1) {
    for (let x = 1; x < w; x += 1) {
      sum += Math.abs(luma[y * w + x] - luma[y * w + x - 1]);
      sum += Math.abs(luma[y * w + x] - luma[(y - 1) * w + x]);
      n += 2;
    }
  }
  return sum / n;
}

/* ---------- 最小 PNG 编码（RGBA 8-bit 无隔行，够探针存档用） ---------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function cropPng(img, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const src = ((y + j) * img.width + (x + i)) * img.bpp;
      const dst = (j * w + i) * 4;
      out[dst] = img.data[src];
      out[dst + 1] = img.data[src + 1];
      out[dst + 2] = img.data[src + 2];
      out[dst + 3] = 0xff;
    }
  }
  return encodePng(w, h, out);
}

const root = path.resolve('.');
const artifacts = path.join(root, 'tests', 'artifacts');
await ensureDir(artifacts);
const server = await startStaticServer({ root, quiet: true });
const browser = await launchBrowser({});
const conn = await CDP.connect(browser.wsUrl);
const page = await Page.open(conn, { url: server.url });
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

try {
  await page.waitFor(
    () => { const c = document.querySelector('#map-canvas'); return Boolean(c && !c.hidden); },
    { timeout: 20_000, label: '瓦片 canvas 可见' },
  );

  // 仪器：全局 clearRect 计数（默认 grid 关闭 → 只有瓦片 canvas 在清屏）
  await page.evalFn(() => {
    const orig = CanvasRenderingContext2D.prototype.clearRect;
    window.__probeClears = 0;
    window.__probeMapClears = 0;
    window.__probeClearSources = [];
    window.__probeFrames = [];
    window.__probeRecording = false;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      const src = this.canvas ? (this.canvas.className || this.canvas.id || '?') : '?';
      window.__probeClears += 1;
      if (src.includes('map-canvas')) window.__probeMapClears += 1;
      window.__probeClearSources.push(src);
      return orig.apply(this, args);
    };
    return true;
  });

  const snapshot = () => page.evalFn(() => {
    const stage = document.querySelector('#stage');
    const canvas = document.querySelector('#map-canvas');
    return JSON.stringify({
      st: stage.style.transform,
      clears: window.__probeClears,
      box: [canvas.style.left, canvas.style.top, canvas.style.width, canvas.style.height],
      bit: [canvas.width, canvas.height],
    });
  });

  // 每次放大后等动画停稳（变换 700ms 不变）；最后等画面全静止（含瓦片加载）
  const transformStable = async () => {
    for (let i = 0; i < 30; i += 1) {
      const a = await snapshot();
      await sleep(700);
      if (a === (await snapshot())) return true;
    }
    throw new Error('缩放动画迟迟不停');
  };
  const fullyQuiet = async () => {
    for (let i = 0; i < 40; i += 1) {
      const a = await snapshot();
      await sleep(1500);
      if (a === (await snapshot())) return true;
    }
    throw new Error('画面迟迟不静止（瓦片加载不完？）');
  };

  for (let i = 0; i < 7; i += 1) {
    await page.clickSelector('#zoom-in');
    await transformStable();
  }
  await page.waitFor(
    () => {
      const st = document.querySelector('#stage').style.transform;
      const m = /scale\(([\d.]+)\)/.exec(st);
      return m && Number(m[1]) > 2;
    },
    { timeout: 15_000, label: 'scale > 2' },
  );
  await fullyQuiet();

  // 关掉网格再连拍（网格每帧重画，会污染截图相关性；真实点击开关）
  const gridWasOn = await page.evalFn(() => {
    const gc = document.querySelector('.map-grid');
    return gc ? getComputedStyle(gc).opacity === '1' : false;
  });
  if (gridWasOn) {
    await page.clickSelector('#btn-grid');
    await transformStable();
    await fullyQuiet();
    await page.waitFor(
      () => { const t = document.getElementById('toast'); return !t || t.hidden === true; },
      { timeout: 8_000, label: 'toast 消失' },
    );
  }
  await page.evalFn(() => { window.__probeMapClears = 0; window.__probeClearSources = []; return true; });

  // 静止态窗口断言：盒 = 视口每边外扩 25%（图片像素），位图 ≈ 1.5×视口×dpr
  const restWindow = await page.evalFn(() => {
    const vp = document.querySelector('#viewport');
    const canvas = document.querySelector('#map-canvas');
    const stage = document.querySelector('#stage');
    const vr = vp.getBoundingClientRect();
    const m = /scale\(([\d.]+)\)/.exec(stage.style.transform);
    return {
      vpW: Math.round(vr.width), vpH: Math.round(vr.height),
      scale: m ? Number(m[1]) : 0,
      boxW: parseFloat(canvas.style.width), boxH: parseFloat(canvas.style.height),
      bitW: canvas.width, bitH: canvas.height,
    };
  });

  // 找安全拖点（避开标记 / 面板）
  const anchor = await page.evalFn(() => {
    const vp = document.querySelector('#viewport');
    const r = vp.getBoundingClientRect();
    let x = r.left + r.width * 0.5;
    let y = r.top + r.height * 0.45;
    const rects = [...document.querySelectorAll('#overlay .marker')].map((el) => el.getBoundingClientRect());
    for (const mr of rects) {
      if (x >= mr.left && x <= mr.right && y >= mr.top && y <= mr.bottom) { x = mr.left - 60; y = mr.top - 60; break; }
    }
    return { x, y };
  });

  // 找截图裁剪区：视口内 192×192 且不压到标记 / 面板
  const crop = await page.evalFn(() => {
    const vp = document.querySelector('#viewport');
    const r = vp.getBoundingClientRect();
    const w = 192, h = 192;
    const rects = [...document.querySelectorAll('#overlay .marker, .zoom-panel, aside, .panel')]
      .map((el) => el.getBoundingClientRect());
    const hits = (cx, cy) => rects.some((m) => cx + w > m.left && cx < m.right && cy + h > m.top && cy < m.bottom);
    for (let cy = r.top + 40; cy + h <= r.bottom - 40; cy += 32) {
      for (let cx = r.left + 40; cx + w <= r.right - 40; cx += 32) {
        if (!hits(cx, cy)) return { x: Math.round(cx), y: Math.round(cy), w, h };
      }
    }
    return { x: Math.round(r.left + r.width / 2 - w / 2), y: Math.round(r.top + r.height / 2 - h / 2), w, h };
  });

  // 记录器：每帧采样 stage 变换 + 瓦片 canvas 盒 + clears
  await page.evalFn(() => {
    window.__probeFrames = [];
    window.__probeRecording = true;
    const tick = () => {
      if (!window.__probeRecording) return;
      const stage = document.querySelector('#stage');
      const canvas = document.querySelector('#map-canvas');
      const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px[^)]*\)\s*scale\(([\d.]+)\)/.exec(stage.style.transform);
      if (m) {
        const vp = document.querySelector('#viewport');
        const vr = vp.getBoundingClientRect();
        window.__probeFrames.push({
          tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]),
          clears: window.__probeClears,
          mapClears: window.__probeMapClears,
          boxLeft: canvas.style.left, boxTop: canvas.style.top,
          boxW: canvas.style.width, boxH: canvas.style.height,
          bitW: canvas.width, bitH: canvas.height,
          imgRendering: getComputedStyle(canvas).imageRendering,
          vpW: Math.round(vr.width), vpH: Math.round(vr.height),
          winW: window.innerWidth, winH: window.innerHeight,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  });

  const mouse = (type, x, y, extra = {}) =>
    page.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', pointerType: 'mouse', ...extra,
    });

  // 对照：不动鼠标的两连拍（残差应 ≈0：证明拖动时的残差来自运动相位，而非测量噪声）
  const ctrlA = decodePng(Buffer.from(await page.screenshotBase64(), 'base64'));
  await sleep(300);
  const ctrlB = decodePng(Buffer.from(await page.screenshotBase64(), 'base64'));
  const ctrlResid = bestShift(
    cropLuma(ctrlA, crop.x, crop.y, crop.w, crop.h),
    cropLuma(ctrlB, crop.x, crop.y, crop.w, crop.h),
    crop.w, crop.h, 14,
  );
  console.log('staticControlResid:', JSON.stringify(ctrlResid));

  // 分步拖动（非整数步长，每 2 步截一张屏）→ 200×120px
  // 拖动期间隐藏标记：标记是 DOM 层按 n4 小数位移动，会污染截图相关性
  const visibleMarkers = await page.evalFn(async () => {
    const sheet = document.createElement('style');
    sheet.id = 'probe-hide-markers';
    sheet.textContent = '#overlay .marker, #overlay .marker-popup { display: none !important; }';
    document.head.appendChild(sheet);
    await new Promise((r) => requestAnimationFrame(r));
    return [...document.querySelectorAll('#overlay .marker')].filter((el) => el.getBoundingClientRect().width > 0).length;
  });
  console.log('visibleMarkersAfterHide:', visibleMarkers);
  const steps = 37, dx = 200 / steps, dy = 120 / steps;
  await mouse('mouseMoved', anchor.x, anchor.y, { button: 'none', buttons: 0 });
  await mouse('mousePressed', anchor.x, anchor.y, { buttons: 1, clickCount: 1 });
  await mouse('mouseMoved', anchor.x + dx, anchor.y + dy, { buttons: 1 });
  await sleep(80);
  await page.evalFn(() => { window.__probeFrames = []; return true; }); // 清掉按下/首移之前的帧，只分析纯拖动帧
  const shots = [];
  for (let i = 2; i <= steps; i += 1) {
    const x = anchor.x + dx * i;
    const y = anchor.y + dy * i;
    await mouse('mouseMoved', x, y, { buttons: 1 });
    await sleep(30);
    if (i % 2 === 0) {
      const png = Buffer.from(await page.screenshotBase64(), 'base64');
      shots.push({ i, x, y, png });
    }
  }
  const frames = await page.evalFn(() => {
    window.__probeRecording = false;
    return { frames: window.__probeFrames, clearSources: window.__probeClearSources };
  });
  await mouse('mouseReleased', anchor.x + dx * steps, anchor.y + dy * steps, { buttons: 0, clickCount: 1 });
  await sleep(400);
  const afterRelease = await page.evalFn(() => {
    const canvas = document.querySelector('#map-canvas');
    return {
      box: [canvas.style.left, canvas.style.top, canvas.style.width, canvas.style.height].join('|'),
      bit: `${canvas.width}x${canvas.height}`,
      mapClears: window.__probeMapClears,
    };
  });
  await page.evalFn(() => { document.getElementById('probe-hide-markers')?.remove(); return true; });
  const afterShot = Buffer.from(await page.screenshotBase64(), 'base64');

  /* ---------- 分析 ---------- */
  const dragFrames = frames.frames.filter((f) => f.clears !== undefined);
  console.log('clearSources:', JSON.stringify([...new Set(frames.clearSources)]));
  console.log('viewport sizes:', JSON.stringify([...new Set(dragFrames.map((f) => `${f.vpW}x${f.vpH}`))]));
  console.log('scales:', JSON.stringify([...new Set(dragFrames.map((f) => f.scale))]));
  const txDeltas = [];
  for (let i = 1; i < dragFrames.length; i += 1) txDeltas.push(Math.abs(dragFrames[i].tx - dragFrames[i - 1].tx));
  const mapClearsSeries = [...new Set(dragFrames.map((f) => f.mapClears))];
  const boxes = [...new Set(dragFrames.map((f) => `${f.boxLeft}|${f.boxTop}|${f.boxW}|${f.boxH}`))];
  const bitmaps = [...new Set(dragFrames.map((f) => `${f.bitW}x${f.bitH}`))];
  const renderings = [...new Set(dragFrames.map((f) => f.imgRendering))];

  // 截图互相关：拖中相邻帧（每对相距 10 屏幕 px）
  const decoded = shots.map((s) => decodePng(s.png));
  const pairs = [];
  for (let i = 1; i < decoded.length; i += 1) {
    const a = cropLuma(decoded[i - 1], crop.x, crop.y, crop.w, crop.h);
    const b = cropLuma(decoded[i], crop.x, crop.y, crop.w, crop.h);
    pairs.push(bestShift(a, b, crop.w, crop.h, 14));
  }
  const residMin = Math.min(...pairs.map((p) => p.resid));
  const residMax = Math.max(...pairs.map((p) => p.resid));
  const residMean = pairs.reduce((s, p) => s + p.resid, 0) / pairs.length;

  const restImg = decodePng(afterShot);
  const restLuma = cropLuma(restImg, crop.x, crop.y, crop.w, crop.h);
  const sharpRest = gradientScore(restLuma, crop.w, crop.h);
  // 同一张冻结纹理在拖动首尾的锐度：若逐帧重栅格化糊化，梯度会随拖动衰减
  const sharpDragFirst = gradientScore(cropLuma(decoded[0], crop.x, crop.y, crop.w, crop.h), crop.w, crop.h);
  const sharpDragLast = gradientScore(cropLuma(decoded[decoded.length - 1], crop.x, crop.y, crop.w, crop.h), crop.w, crop.h);

  // 残差地图：最佳位移下逐像素差，找出高残差像素的聚集区（静态覆盖物 vs 地形重采样）
  {
    const a = cropLuma(decoded[0], crop.x, crop.y, crop.w, crop.h);
    const b = cropLuma(decoded[1], crop.x, crop.y, crop.w, crop.h);
    const best = bestShift(a, b, crop.w, crop.h, 14);
    let minX = crop.w, maxX = -1, minY = crop.h, maxY = -1, count = 0;
    const diffRgba = Buffer.alloc(crop.w * crop.h * 4);
    for (let y = 0; y < crop.h; y += 1) {
      for (let x = 0; x < crop.w; x += 1) {
        const bx = x + best.dx, by = y + best.dy;
        let d = 0;
        if (bx >= 0 && by >= 0 && bx < crop.w && by < crop.h) {
          d = Math.abs(a[y * crop.w + x] - b[by * crop.w + bx]);
        }
        const v = Math.min(255, Math.round(d * 5));
        const p = (y * crop.w + x) * 4;
        diffRgba[p] = v; diffRgba[p + 1] = v; diffRgba[p + 2] = v; diffRgba[p + 3] = 255;
        if (d > 25) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          count += 1;
        }
      }
    }
    console.log('residualHotspot:', JSON.stringify({ count, bbox: [minX, minY, maxX, maxY], crop: crop }));
    await fsp.writeFile(path.join(artifacts, 'probe-resid-diff.png'), encodePng(crop.w, crop.h, diffRgba));
  }
  await fsp.writeFile(path.join(artifacts, 'probe-freeze-drag-mid.png'), shots[Math.floor(shots.length / 2)].png);
  await fsp.writeFile(path.join(artifacts, 'probe-freeze-after.png'), afterShot);
  await fsp.writeFile(path.join(artifacts, 'probe-crop-drag.png'),
    cropPng(decoded[Math.floor(decoded.length / 2)], crop.x, crop.y, crop.w, crop.h));
  await fsp.writeFile(path.join(artifacts, 'probe-crop-rest.png'),
    cropPng(decodePng(afterShot), crop.x, crop.y, crop.w, crop.h));
  const cropElements = await page.evalFn((c) => {
    const found = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left < c.x + c.w && r.right > c.x && r.top < c.y + c.h && r.bottom > c.y) {
        found.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}#${el.id || ''}`);
        if (found.length > 30) break;
      }
    }
    return found;
  }, crop);
  console.log('cropElements:', JSON.stringify(cropElements, null, 2));

  const summary = {
    restWindow,
    afterRelease,
    dragFrames: dragFrames.length,
    txStart: dragFrames[0]?.tx, txEnd: dragFrames[dragFrames.length - 1]?.tx,
    maxTxDeltaPerFrame: Math.max(...txDeltas),
    mapClearsSeries,
    boxVariants: boxes.length,
    bitmapSizes: bitmaps,
    imgRenderings: renderings,
    shiftResiduals: pairs.map((p) => `${p.dx},${p.dy}:${p.resid.toFixed(2)}`),
    residMean: residMean.toFixed(2), residMin: residMin.toFixed(2), residMax: residMax.toFixed(2),
    sharpDragFirst: sharpDragFirst.toFixed(2), sharpDragLast: sharpDragLast.toFixed(2), sharpRest: sharpRest.toFixed(2),
  };
  console.log(JSON.stringify(summary, null, 2));

  /* ---------- 判定 ---------- */
  const problems = [];
  if (Math.abs(restWindow.boxW - (restWindow.vpW * 1.5) / restWindow.scale) > 1
      || Math.abs(restWindow.boxH - (restWindow.vpH * 1.5) / restWindow.scale) > 1) {
    problems.push(`静止态窗口未外扩 1.5×（图片像素）：盒 ${restWindow.boxW.toFixed(2)}×${restWindow.boxH.toFixed(2)}，` +
      `scale ${restWindow.scale.toFixed(3)}，期望 ≈${((restWindow.vpW * 1.5) / restWindow.scale).toFixed(1)}×${((restWindow.vpH * 1.5) / restWindow.scale).toFixed(1)}`);
  }
  if (Math.abs(restWindow.bitW - restWindow.vpW * 1.5) > 2 || Math.abs(restWindow.bitH - restWindow.vpH * 1.5) > 2) {
    problems.push(`静止态位图 ≠ 1.5×视口×dpr：${restWindow.bitW}×${restWindow.bitH} vs 视口 ${restWindow.vpW}×${restWindow.vpH}`);
  }
  if (boxes.length > 1) problems.push(`拖动期间瓦片盒变化 ${boxes.length} 次（应只有 1 种：外扩窗口）`);
  if (bitmaps.length > 1) problems.push(`拖动期间位图尺寸变化：${bitmaps.join(' → ')}`);
  if (mapClearsSeries.length !== 1 || mapClearsSeries[0] !== 0) {
    problems.push(`拖动期间瓦片层有重画：mapClears 序列 ${mapClearsSeries.join(',')}（恒外扩窗口下应全程为 0）`);
  }
  if (txDeltas.length && Math.max(...txDeltas) > 6) problems.push(`单帧位移过大：${Math.max(...txDeltas).toFixed(2)}px`);
  if (!pairs.length || pairs.some((p) => p.dx < 10 || p.dx > 12)) {
    problems.push(`画面位移与鼠标不一致：${pairs.map((p) => p.dx).join(',')}（每对两步 ≈ 10-12px）`);
  }
  if (ctrlResid.resid > 0.5) problems.push(`静止对照残差 ${ctrlResid.resid.toFixed(2)} > 0.5（测量管道有噪声）`);
  if (ctrlResid.dx !== 0 || ctrlResid.dy !== 0) problems.push('静止对照居然测出位移（页面在自主动画？）');
  if (sharpDragFirst > 0 && sharpDragLast / sharpDragFirst < 0.95) {
    problems.push(`拖动首尾锐度衰减：${sharpDragFirst.toFixed(2)} → ${sharpDragLast.toFixed(2)}（疑似逐帧糊化）`);
  }
  if (!renderings.every((r) => r === 'pixelated')) problems.push(`拖动中 imageRendering 非 pixelated：${renderings.join(',')}`);
  const lastDrag = dragFrames[dragFrames.length - 1];
  if (lastDrag && afterRelease.box !== `${lastDrag.boxLeft}|${lastDrag.boxTop}|${lastDrag.boxW}|${lastDrag.boxH}`) {
    problems.push(`松手后瓦片盒变化：${afterRelease.box}（应零重画零变化）`);
  }
  if (afterRelease.mapClears !== 0) problems.push(`松手后仍有清屏：${afterRelease.mapClears}（应零重画零变化）`);
  if (problems.length) {
    console.error('✗ 探针发现异常：\n - ' + problems.join('\n - '));
    process.exitCode = 1;
  } else {
    console.log('✓ 探针通过：静止外扩窗口、拖动全程零重画、位移与鼠标一致、拖动锐利、松手零变化');
  }
} finally {
  await browser.close({ conn });
  await server.close();
}
