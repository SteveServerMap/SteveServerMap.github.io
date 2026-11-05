import test from 'node:test';
import assert from 'node:assert/strict';
import { TileLayer, Tileset } from '../assets/js/tiles.js';

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
