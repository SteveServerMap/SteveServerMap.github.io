import test from 'node:test';
import assert from 'node:assert/strict';
import { MapView } from '../assets/js/viewer.js';

class ElementFake {
  style = {};
  listeners = new Map();
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type) { for (const callback of [...(this.listeners.get(type) || [])]) callback(); }
  getAttribute(name) { return name === 'src' ? this._src : null; }
  set src(url) {
    this._src = url;
    this.complete = false;
    this.naturalWidth = this.naturalHeight = 0;
    this.onAssign?.();
  }
  load(width = 200, height = 100) {
    this.complete = true;
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.emit('load');
  }
}

function harness(t) {
  const frames = new Map();
  let frameId = 0;
  const replacements = {
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    matchMedia: () => ({ matches: false }),
  };
  for (const [key, value] of Object.entries(replacements)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const img = new ElementFake();
  const canvas = new ElementFake();
  const stage = new ElementFake();
  const viewport = new ElementFake();
  viewport.clientWidth = 800;
  viewport.clientHeight = 600;
  viewport.querySelector = (selector) => ({
    '#stage, .map-stage': stage,
    '#map-image, .map-image': img,
    '#map-canvas': canvas,
  })[selector] || null;
  const changes = [];
  const view = new MapView(viewport, { onViewChange: (value) => changes.push(value) });
  t.after(() => view.destroy());
  return { view, viewport, img, canvas, stage, changes, frames };
}

function observe(promise) {
  const result = { status: 'pending' };
  promise.then(
    (value) => Object.assign(result, { status: 'resolved', value }),
    (error) => Object.assign(result, { status: 'rejected', error }),
  );
  return result;
}
const assertAborted = (result) => {
  assert.equal(result.status, 'rejected', 'cancellation settles without waiting for a network event');
  assert.equal(result.error.name, 'AbortError');
};
const assertClean = (img) => {
  assert.equal(img.listeners.get('load')?.size || 0, 0);
  assert.equal(img.listeners.get('error')?.size || 0, 0);
};

test('a new image immediately settles the superseded load and ignores its saved callbacks', async (t) => {
  const { view, img, changes } = harness(t);
  const first = observe(view.setImage('first.png'));
  const oldLoad = [...img.listeners.get('load')][0];
  const oldError = [...img.listeners.get('error')][0];
  const second = view.setImage('second.png');
  await Promise.resolve();
  assertAborted(first);
  assert.equal(img.listeners.get('load').size, 1);
  oldLoad();
  oldError();
  assert.equal(view.getImageSize(), null);
  img.load(400, 300);
  assert.deepEqual(await second, { width: 400, height: 300 });
  oldLoad();
  oldError();
  assert.deepEqual(view.getImageSize(), { width: 400, height: 300 });
  assert.equal(changes.length, 1);
  assertClean(img);
  assert.equal(view._cancelImageLoad, null);
});

for (const boundary of ['raster', 'destroy', 'cancel']) {
  test(`${boundary} immediately settles pending image loads and removes listeners`, async (t) => {
    const { view, img, canvas } = harness(t);
    const result = observe(view.setImage('pending.png'));
    const lateLoad = [...img.listeners.get('load')][0];
    const lateError = [...img.listeners.get('error')][0];
    if (boundary === 'raster') await view.setRasterBase({ width: 1024, height: 512 });
    else if (boundary === 'destroy') view.destroy();
    else view.cancelImageLoad();
    await Promise.resolve();
    assertAborted(result);
    assertClean(img);
    img.load(10, 10);
    lateLoad();
    lateError();
    assert.deepEqual(view.getImageSize(), boundary === 'raster' ? { width: 1024, height: 512 } : null);
    if (boundary === 'raster') assert.equal(view.imageEl, canvas);
    if (boundary === 'destroy') {
      await assert.rejects(view.setImage('after-destroy.png'));
      await assert.rejects(view.setRasterBase({ width: 1, height: 1 }));
      assertClean(img);
    }
  });
}

test('cached and synchronous image completion settle once and clean listeners', async (t) => {
  const { view, img, changes } = harness(t);
  const first = view.setImage('cached.png');
  img.load();
  await first;
  await view.setImage('cached.png');
  assert.equal(changes.length, 2);
  assertClean(img);
  img.onAssign = () => img.load(400, 200);
  assert.deepEqual(await view.setImage('synchronous.png'), { width: 400, height: 200 });
  assert.equal(changes.length, 3, 'sync load event plus complete fast path must not finish twice');
  assertClean(img);
});

for (const failure of ['error-event', 'invalid-size', 'src-throws']) {
  test(`${failure} rejects and cleans the current image load`, async (t) => {
    const { view, img } = harness(t);
    if (failure === 'src-throws') img.onAssign = () => { throw new Error('src rejected'); };
    const result = observe(view.setImage('bad.png'));
    if (failure === 'error-event') img.emit('error');
    if (failure === 'invalid-size') img.load(0, 100);
    await Promise.resolve();
    assert.equal(result.status, 'rejected');
    assertClean(img);
    assert.equal(view._cancelImageLoad, null);
    assert.equal(view.getImageSize(), null);
  });
}

function pointerEvent(viewport, overrides = {}) {
  return {
    pointerType: 'mouse',
    button: 0,
    pointerId: 1,
    clientX: 100,
    clientY: 100,
    target: viewport,
    preventDefault() {},
    ...overrides,
  };
}
const fire = (viewport, type, event) => {
  const listener = [...(viewport.listeners.get(type) || [])][0];
  assert.ok(listener, `${type} listener registered`);
  listener(event);
};

test('interacting is true during a drag and release re-emits so the tile layer can redraw sharp', (t) => {
  const { view, viewport, changes } = harness(t);
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0 });
  assert.equal(view.getViewState().interacting, false);
  fire(viewport, 'pointerdown', pointerEvent(viewport));
  assert.equal(view.getViewState().interacting, true);
  fire(viewport, 'pointermove', pointerEvent(viewport, { clientX: 140, clientY: 120 }));
  assert.equal(view.getViewState().interacting, true);
  assert.equal(changes.at(-1).interacting, true, 'moved drag commits carry the interacting flag');
  const moved = changes.length;
  fire(viewport, 'pointerup', pointerEvent(viewport, { clientX: 140, clientY: 120 }));
  assert.equal(view.getViewState().interacting, false);
  assert.equal(view._drag, null);
  assert.equal(changes.length, moved + 1, 'release emits exactly one settle notification');
  assert.equal(changes.at(-1).interacting, false);
  assert.equal(changes.at(-1).scale, changes.at(-2).scale);
  assert.equal(changes.at(-1).tx, changes.at(-2).tx);
});

test('an unmoved press still reports interacting while held and emits nothing on release', (t) => {
  const { view, viewport, changes } = harness(t);
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0 });
  fire(viewport, 'pointerdown', pointerEvent(viewport));
  assert.equal(view.getViewState().interacting, true);
  const before = changes.length;
  fire(viewport, 'pointerup', pointerEvent(viewport));
  assert.equal(view.getViewState().interacting, false);
  assert.equal(changes.length, before, 'a plain click does not emit an extra view change');
});

test('pinch lifts the interacting flag as soon as the second finger releases', (t) => {
  const { view, viewport, changes } = harness(t);
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0 });
  fire(viewport, 'pointerdown', pointerEvent(viewport, { pointerId: 1, clientX: 100, clientY: 100 }));
  fire(viewport, 'pointerdown', pointerEvent(viewport, { pointerId: 2, clientX: 200, clientY: 100 }));
  assert.equal(view.getViewState().interacting, true);
  const before = changes.length;
  fire(viewport, 'pointerup', pointerEvent(viewport, { pointerId: 1, clientX: 100, clientY: 100 }));
  assert.equal(view.getViewState().interacting, false);
  assert.equal(changes.length, before + 1, 'pinch end emits one settle notification');
  assert.equal(changes.at(-1).interacting, false);
  fire(viewport, 'pointerup', pointerEvent(viewport, { pointerId: 2, clientX: 200, clientY: 100 }));
  assert.equal(changes.length, before + 1, 'the last finger lifting adds nothing');
});

test('pointercancel settles interacting with a single notification', (t) => {
  const { view, viewport, changes } = harness(t);
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0 });
  fire(viewport, 'pointerdown', pointerEvent(viewport));
  assert.equal(view.getViewState().interacting, true);
  const before = changes.length;
  fire(viewport, 'pointercancel', pointerEvent(viewport));
  assert.equal(view.getViewState().interacting, false);
  assert.equal(changes.length, before + 1);
  assert.equal(changes.at(-1).interacting, false);
});

for (const boundary of ['image', 'raster', 'resize']) {
  test(`${boundary} cancels old view animation before it can overwrite the new view`, async (t) => {
    const { view, viewport, img, frames } = harness(t);
    await view.setRasterBase({ width: 1000, height: 500 });
    view.setViewState({ scale: 2, tx: -100, ty: -200 }, { animate: true });
    assert.equal(frames.size, 1);
    if (boundary === 'image') {
      const pending = view.setImage('new.png');
      assert.equal(frames.size, 0, 'cancel before image finishes loading');
      img.load(600, 400);
      await pending;
    } else if (boundary === 'raster') {
      await view.setRasterBase({ width: 600, height: 400 });
    } else {
      const centerX = (viewport.clientWidth / 2 - view.tx) / view.scale;
      const centerY = (viewport.clientHeight / 2 - view.ty) / view.scale;
      viewport.clientWidth = 1000;
      viewport.clientHeight = 700;
      view._onResize();
      assert.equal((viewport.clientWidth / 2 - view.tx) / view.scale, centerX);
      assert.equal((viewport.clientHeight / 2 - view.ty) / view.scale, centerY);
    }
    assert.equal(frames.size, 0);
    assert.equal(view._anim, 0);
    const final = view.getViewState();
    for (const callback of frames.values()) callback();
    assert.deepEqual(view.getViewState(), final);
  });
}
