import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeConfig } from '../assets/js/config.js';
import { createProjection, normalizeCalibration } from '../assets/js/coords.js';

// Run the actual app functions without bootstrap/network/DOM construction.
// Only imports and the bootstrap call are removed; dependencies are injected.
const appSource = readFileSync(new URL('../assets/js/app.js', import.meta.url), 'utf8')
  .replace(/^import .* from .*;\r?$/gm, '')
  .replace(/^bootstrap\(\);\r?$/m, '');
const size = { width: 200, height: 100 };
const calibration = { xMin: -100, xMax: 100, zMin: -50, zMax: 50, calibrated: true };
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const dimension = (id, extra = {}) => ({ id, image: `${id}.png`, calibration, ...extra });
const manifest = { imageWidth: 1024, imageHeight: 512 };

function harness(dimensions, options = {}) {
  const normalized = normalizeConfig({ dimensions, ui: options.ui });
  const nodes = new Map([
    ['map-image', { hidden: false }],
    ['map-canvas', { hidden: false }],
    ['waypoint-search', { value: 'old query' }],
    ['coord-readout', { hidden: false }],
    ['scale-bar', { hidden: false, querySelector: () => ({ style: {} }) }],
    ['scale-bar-label', {}],
    ['map-state', { hidden: true, dataset: {}, querySelector: () => null }],
  ]);
  const calls = { images: [], rasters: [], sizeReads: 0, warnings: [], gridClears: 0 };
  const view = {
    projection: null,
    cancelImageLoad() { calls.cancelled = (calls.cancelled || 0) + 1; },
    setProjection(value) { this.projection = value; },
    getViewState: () => ({ scale: 1, tx: 0, ty: 0, viewWidth: 800, viewHeight: 600, imageWidth: 200, imageHeight: 100 }),
    setImage(url) { calls.images.push(url); return options.setImage ? options.setImage(url) : Promise.resolve(size); },
    setRasterBase(value) { calls.rasters.push(value); return options.setRasterBase ? options.setRasterBase(value) : Promise.resolve(value); },
    getImageSize() { calls.sizeReads += 1; return size; },
    centerOnImagePoint() {},
    setViewState() {},
  };
  const sidebar = {
    setDimensions() {}, setActiveWaypoint() {}, setCalibrationNotice() {},
    setLoading(value) { this.loading = value; },
    setData(value) { this.data = value; },
    setStats(value) { this.stats = value; },
    clearSearch() { this.query = ''; },
  };
  const markers = {
    setData(waypoints, groups, projection) { this.projection = projection; },
    setFilter(value) { this.filter = value; },
    setGroupVisible() {}, setLabelMode() {}, update() {},
  };
  const measure = {
    points: [], hover: null,
    setProjection(value) { this.projection = value; },
    clear() { this.points = []; this.hover = null; },
    setHover(value) { this.hover = value; },
  };
  const tileLayer = { active: true, setActive(value) { this.active = value; }, update() {} };
  const gridCtx = { setTransform() {}, clearRect() { calls.gridClears += 1; } };
  const fixture = { view, sidebar, markers, measure, tileLayer, gridCtx, config: normalized.config };
  const context = vm.createContext({
    fixture, createProjection, normalizeCalibration,
    loadTileset: options.loadTileset || (() => Promise.resolve(manifest)),
    document: { body: { dataset: {} }, getElementById: (id) => nodes.get(id) || null },
    window: { devicePixelRatio: 1 },
    location: { hash: '' },
    console: { warn: (...args) => calls.warnings.push(args), error: (...args) => calls.warnings.push(args) },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1,
  });
  const api = new vm.Script(`${appSource}\n
    view = fixture.view; sidebar = fixture.sidebar; markers = fixture.markers;
    measure = fixture.measure; tileLayer = fixture.tileLayer;
    gridCtx = fixture.gridCtx; gridCanvas = { width: 800, height: 600 };
    state.config = fixture.config;
    ({ app: window.__mapApp, defaultSpanBlocks, buildProjection });
  `).runInContext(context);
  return { ...api, ...fixture, calls, nodes, warnings: normalized.warnings, body: context.document.body };
}

for (const flipZ of [false, true]) {
  test(`config -> app scale calibration preserves the top-left origin (flipZ=${flipZ})`, async () => {
    const h = harness([dimension('scale', {
      calibration: { pixelsPerBlock: '2', originX: '-100', originZ: '25', flipZ, calibrated: true, note: 'scale map' },
    })]);
    const dim = h.config.dimensions[0];
    assert.equal(dim.calibration.xMin, null);
    const resolved = h.app.resolveCalibration(dim, size);
    assert.deepEqual(plain(resolved), {
      xMin: -100, xMax: 0, zMin: flipZ ? -25 : 25, zMax: flipZ ? 25 : 75,
      flipZ, calibrated: true, note: 'scale map', source: 'scale',
      pixelsPerBlock: 2, originX: -100, originZ: 25,
    });
    await h.app.applyDimension('scale');
    assert.equal(h.app.state.projection.isValid, true);
    assert.deepEqual(h.app.state.projection.imageToWorld(0, 0), { x: -100, z: 25 });
    assert.equal(h.view.projection, h.app.state.projection);
    assert.equal(h.measure.projection, h.app.state.projection);
  });
}

test('config -> app retains valid bounds and rejects missing or invalid calibration', () => {
  const h = harness([dimension('bounds')]);
  const resolved = h.app.resolveCalibration(h.config.dimensions[0], size);
  assert.deepEqual(plain(resolved), { ...calibration, flipZ: false, note: '', source: 'bounds' });
  for (const raw of [undefined, {}, { pixelsPerBlock: 2, originX: null, originZ: 0 }, { ...calibration, xMax: -100 }]) {
    const { config } = normalizeConfig({ dimensions: [dimension('bad', { calibration: raw })] });
    assert.equal(h.app.resolveCalibration(config.dimensions[0], size), null);
  }
  const { config } = normalizeConfig({ dimensions: [dimension('scale', { calibration: { pixelsPerBlock: 1, originX: 0, originZ: 0 } })] });
  assert.equal(h.app.resolveCalibration(config.dimensions[0], null), null);
});

test('defaultSpanBlocks survives config normalization with schema integer/range validation', () => {
  for (const span of [64, 2048, 16384]) {
    const h = harness([dimension('a')], { ui: { defaultSpanBlocks: span } });
    assert.equal(h.config.ui.defaultSpanBlocks, span);
    assert.equal(h.defaultSpanBlocks(), span);
  }
  for (const span of [undefined, null, '', '2048', true, 63, 16385, 64.5, NaN, Infinity]) {
    const h = harness([dimension('a')], { ui: { defaultSpanBlocks: span } });
    assert.equal(h.config.ui.defaultSpanBlocks, 1024);
    assert.equal(h.defaultSpanBlocks(), 1024);
    assert.equal(h.warnings.some((warning) => warning.includes('defaultSpanBlocks')), span !== undefined);
  }
});

for (const outcome of ['resolve', 'reject']) {
  test(`stale manifest ${outcome} cannot switch raster or start image fallback`, async () => {
    const pending = deferred();
    const h = harness([dimension('old', { tiles: 'old/manifest.json' }), dimension('new')], {
      loadTileset: () => pending.promise,
    });
    const old = h.app.applyDimension('old');
    await h.app.applyDimension('new');
    const projection = h.app.state.projection;
    pending[outcome](outcome === 'resolve' ? manifest : new Error('old manifest failed'));
    await old;
    assert.deepEqual(h.calls.rasters, []);
    assert.deepEqual(h.calls.images, ['new.png']);
    assert.equal(h.app.state.projection, projection);
    assert.equal(h.sidebar.data.dimension.id, 'new');
    assert.equal(h.sidebar.loading, false);
    assert.deepEqual(h.calls.warnings, []);
  });

  test(`stale raster ${outcome} cannot publish data or fall back`, async () => {
    const pending = deferred();
    const started = deferred();
    const h = harness([dimension('old', { tiles: 'old/manifest.json' }), dimension('new')], {
      setRasterBase: () => { started.resolve(); return pending.promise; },
    });
    const old = h.app.applyDimension('old');
    await started.promise; // wait for the explicit raster boundary, not a guessed microtask count
    assert.equal(h.calls.rasters.length, 1);
    await h.app.applyDimension('new');
    pending[outcome](outcome === 'resolve' ? size : new Error('old raster failed'));
    await old;
    assert.deepEqual(h.calls.images, ['new.png']);
    assert.equal(h.sidebar.data.dimension.id, 'new');
    assert.deepEqual(h.calls.warnings, []);
  });

  test(`stale image ${outcome} cannot read fallback size or publish data`, async () => {
    const pending = deferred();
    const h = harness([dimension('old'), dimension('new')], {
      setImage: (url) => url === 'old.png' ? pending.promise : Promise.resolve(size),
    });
    const old = h.app.applyDimension('old');
    await h.app.applyDimension('new');
    pending[outcome](outcome === 'resolve' ? null : new Error('old image failed'));
    await old;
    assert.equal(h.calls.sizeReads, 0);
    assert.equal(h.sidebar.data.dimension.id, 'new');
    assert.deepEqual(h.calls.warnings, []);
  });
}

test('current manifest failure still falls back to its image', async () => {
  const h = harness([dimension('a', { tiles: 'a/manifest.json' })], {
    loadTileset: () => Promise.reject(new Error('unavailable')),
  });
  await h.app.applyDimension('a');
  assert.deepEqual(h.calls.images, ['a.png']);
  assert.equal(h.app.state.projection.isValid, true);
  assert.equal(h.body.dataset.base, 'image');
});

for (const mode of ['missing-image', 'failed-image', 'loading-image', 'failed-manifest']) {
  test(`${mode} resets measurement, search, projections and old layers before any early exit`, async () => {
    const pending = deferred();
    const extra = mode === 'missing-image' ? { image: '' }
      : mode === 'failed-manifest' ? { image: '', tiles: 'bad/manifest.json' } : {};
    const h = harness([dimension('a', { ...extra, waypoints: [{ id: 'point', name: 'Point', x: 0, z: 0 }] })], {
      setImage: () => mode === 'loading-image' ? pending.promise : Promise.reject(new Error('missing image')),
      loadTileset: () => Promise.reject(new Error('missing manifest')),
    });
    Object.assign(h.app.state, { query: 'old query', projection: {}, calibration, imageSize: size, measureActive: true, grid: true });
    h.view.projection = {};
    h.measure.projection = {};
    h.measure.points = [{ x: 0, z: 0 }, { x: 3, z: 4 }];
    h.measure.hover = { x: 5, z: 5 };
    h.markers.filter = () => false;
    h.sidebar.query = 'old query';
    const operation = h.app.applyDimension('a');
    assert.equal(h.app.state.projection, null);
    assert.equal(h.view.projection, null);
    assert.equal(h.measure.projection, null);
    assert.equal(h.measure.points.length, 0);
    assert.equal(h.measure.hover, null);
    assert.equal(h.app.state.query, '');
    assert.equal(h.sidebar.query, '');
    assert.equal(h.nodes.get('waypoint-search').value, '');
    assert.equal(h.markers.filter, null);
    assert.equal(h.tileLayer.active, false);
    assert.equal(h.nodes.get('map-image').hidden, true);
    assert.equal(h.nodes.get('map-canvas').hidden, true);
    assert.equal(h.nodes.get('coord-readout').hidden, true);
    assert.equal(h.nodes.get('scale-bar').hidden, true);
    assert.ok(h.calls.gridClears > 0);
    assert.equal(h.calls.cancelled, 1);
    if (mode === 'loading-image') pending.reject(new Error('missing image'));
    await operation;
    assert.equal(h.sidebar.loading, false);
    assert.equal(h.sidebar.data.waypoints.length, 1);
    assert.equal(h.sidebar.data.projection, null);
    assert.equal(h.body.dataset.base, 'empty');
  });
}
