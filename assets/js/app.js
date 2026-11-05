/**
 * app.js —— 装配层（Lead 拥有）
 *
 * 职责：
 *   1. 载入 config.json → 规范化；
 *   2. 创建 MapView / MarkerLayer / Sidebar 并接线；
 *   3. 维度切换（三张基底图）、画幅校准（含本地覆盖）、坐标读数、网格、比例尺、URL 深链。
 *
 * 所有跨模块调用都做了「存在性检查」，任何一个模块的方法名与契约有偏差都不会让整页崩溃。
 */

import { loadConfig } from './config.js';
import { createProjection } from './coords.js';
import { MapView } from './viewer.js';
import { MarkerLayer } from './markers.js';
import { MeasureLayer, formatDistance } from './measure.js';
import { Sidebar } from './sidebar.js';

/* ============================== 小工具 ============================== */

const $ = (id) => document.getElementById(id);

/** 调用可能存在的方法，出错只警告不中断 */
function tryCall(obj, method, ...args) {
  if (!obj) return undefined;
  const fn = obj[method];
  if (typeof fn !== 'function') {
    console.warn(`[app] 缺少可选方法：${method}`);
    return undefined;
  }
  try {
    return fn.apply(obj, args);
  } catch (err) {
    console.error(`[app] 调用 ${method} 失败：`, err);
    return undefined;
  }
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/* ============================== 运行时状态 ============================== */

const state = {
  config: null,
  dimension: null,
  imageSize: null,
  projection: null,
  calibration: null,
  /** 测距模式开关 */
  measureActive: false,
  /** 用户是否已经手动操作过视角（没操作前不往地址栏写 hash，避免"复制地址栏"误分享视角） */
  hashArmed: false,
  /** 每个维度最近一次的视角（切回来时恢复，而不是每次重新回原点） */
  dimensionView: new Map(),
  labelMode: 'hover',
  grid: false,
  query: '',
  activeWaypointId: null,
  visibleGroups: new Map(),
  ready: false,
  loadToken: 0,
};

let view = null;
let markers = null;
let sidebar = null;
let gridCanvas = null;
let gridCtx = null;
let toastTimer = null;
let hashTimer = null;


/* ============================== 启动 ============================== */

bootstrap();

async function bootstrap() {
  try {
    const { config, error, warnings } = await loadConfig('config.json');
    if (error) {
      showFatalConfigError(error);
      return;
    }
    state.config = config;
    if (warnings && warnings.length) {
      console.warn('[config] 配置提示：\n - ' + warnings.join('\n - '));
      state.configWarnings = warnings;
    }

      state.labelMode = config.ui.labelMode || 'hover';
    state.grid = config.ui.grid === true;
    document.body.dataset.labels = state.labelMode;

    initChrome();
    initViewer();
    initSidebar();
    initMarkers();
    initMeasure();

    const hash = readHash();
    const startDim = hash.dim || config.defaultDimension;
    await applyDimension(startDim, { hash });

    // 窄屏抽屉：进入窄屏自动收起（否则抽屉会盖住地图），离开窄屏自动展开
    const narrow = window.matchMedia('(max-width: 860px)');
    if (narrow.matches) tryCall(sidebar, 'setCollapsed', true);
    else if (config.ui.startCollapsed) tryCall(sidebar, 'setCollapsed', true);
    const onNarrowChange = (event) => {
      tryCall(sidebar, 'setCollapsed', event.matches ? true : false);
      drawGrid(safeViewState());
      updateScaleBar(safeViewState());
    };
    if (typeof narrow.addEventListener === 'function') narrow.addEventListener('change', onNarrowChange);
    else if (typeof narrow.addListener === 'function') narrow.addListener(onNarrowChange);

    bindGlobalKeys();
    state.ready = true;
    document.body.dataset.ready = '1';
    updateFooterStatus();
    if (state.configWarnings && state.configWarnings.length) {
      console.warn('[app] 配置存在警告，详见上方。');
    }
  } catch (err) {
    console.error('[app] 启动失败：', err);
    showMapState({
      tone: 'error',
      title: '页面初始化失败',
      text: String(err && err.message ? err.message : err),
      hint: '请打开浏览器控制台查看详细堆栈。',
    });
  }
}

/* ============================== 顶栏 / 页脚 ============================== */

function initChrome() {
  const site = state.config.site;
  document.title = site.title;
  setText('site-title', site.title);
  setText('site-subtitle', site.subtitle);
  setText('site-footer', site.footer);
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute('content', `${site.title} · ${site.subtitle}`);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

/* ============================== 地图引擎 ============================== */

function initViewer() {
  const viewport = $('viewport');
  if (!viewport) throw new Error('缺少 #viewport');

  gridCanvas = document.createElement('canvas');
  gridCanvas.className = 'map-grid';
  gridCanvas.setAttribute('aria-hidden', 'true');
  Object.assign(gridCanvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: '0',
    opacity: state.grid ? '1' : '0',
    transition: 'opacity .18s ease',
  });
  const overlay = $('overlay');
  if (overlay) overlay.prepend(gridCanvas);
  gridCtx = gridCanvas.getContext('2d');

  view = new MapView(viewport, {
    // 最小缩放 = 整图适配（minScaleFit），避免滚轮把地图缩成一个点
    minScale: 0.02,
    maxScale: 8,
    minScaleFit: true,
    minScaleFitFactor: 1,
    onViewChange: handleViewChange,
    onMapClick: handleMapClick,
    onMapPointerMove: handlePointerMove,
    onDoubleClick: null,
  });

  // 缩放按钮（index.html 里的常驻控件）
  bindClick('zoom-in', () => {
    armHashSync();
    tryCall(view, 'zoomBy', 1.35);
  });
  bindClick('zoom-out', () => {
    armHashSync();
    tryCall(view, 'zoomBy', 1 / 1.35);
  });
  bindClick('zoom-fit', () => fitToContent());
  bindClick('btn-fit', () => fitToContent());
  // 左下角「原点」：回到世界原点 + 恢复默认视野比例（与进入页面时一致）
  bindClick('btn-reset', () => {
    if (!focusOrigin({ animate: true })) gotoWorld(0, 0, { animate: true });
  });
  bindClick('btn-grid', toggleGrid);
  bindClick('btn-measure', toggleMeasure);
  bindClick('measure-undo', () => undoMeasurePoint());
  bindClick('measure-clear', () => clearMeasure());
  bindClick('measure-exit', () => setMeasureActive(false));

  // 首次交互后淡出操作提示
  const hint = $('map-hint');
  const dismissHint = () => {
    if (hint) hint.classList.add('is-hidden');
    viewport.removeEventListener('pointerdown', dismissHint);
    viewport.removeEventListener('wheel', dismissHint);
  };
  viewport.addEventListener('pointerdown', dismissHint);
  viewport.addEventListener('wheel', dismissHint, { passive: true });
  // 用户一操作视角就"武装" hash 同步（在此之前不动地址栏）
  viewport.addEventListener('pointerdown', armHashSync, { passive: true });
  viewport.addEventListener('wheel', armHashSync, { passive: true });
}

/** 每次视图变化：标记重排 + 缩放百分比 + 比例尺 + 网格 + hash */
const handleViewChange = (() => {
  let raf = 0;
  return (viewState) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const vs = viewState || safeViewState();
      tryCall(markers, 'update');
      tryCall(measure, 'update', vs);
      updateZoomIndicator(vs);
      updateScaleBar(vs);
      drawGrid(vs);
      scheduleHashSync();
    });
  };
})();

function safeViewState() {
  return tryCall(view, 'getViewState') || null;
}

function updateZoomIndicator(vs) {
  const el = $('zoom-level');
  if (!el || !vs) return;
  const pct = Math.round((vs.scale || 0) * 100);
  el.textContent = `${pct}%`;
  el.title = `当前缩放：1 图片像素 = ${(vs.scale || 0).toFixed(2)} 屏幕像素`;
}

function handleMapClick(imagePoint) {
  if (!imagePoint) return;
  // 测量模式：点一下加一个测量点，不触发路径点选中
  if (handleMeasureClick(imagePoint)) return;
  // 点击空白处取消选中（弹窗由 markers 自己处理点击外部关闭）
  tryCall(markers, 'setSelected', null);
  tryCall(sidebar, 'setActiveWaypoint', null);
  state.activeWaypointId = null;
}

function handlePointerMove(imagePoint) {
  if (measure && state.measureActive) {
    const world = imagePoint && state.projection ? state.projection.imageToWorld(imagePoint.px, imagePoint.py) : null;
    const snapped = imagePoint ? snapToWaypoint(imagePoint) : null;
    tryCall(measure, 'setHover', snapped || (world && Number.isFinite(world.x) ? { x: world.x, z: world.z } : null));
  }
  const el = $('coord-readout');
  if (!el) return;
  if (!state.config || state.config.ui.showCoords === false) {
    el.hidden = true;
    return;
  }
  if (!imagePoint || !state.projection) {
    el.hidden = true;
    return;
  }
  const world = state.projection.imageToWorld(imagePoint.px, imagePoint.py);
  if (!world || !Number.isFinite(world.x)) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `X ${Math.round(world.x)}   Z ${Math.round(world.z)}`;
}

/* ============================== 侧栏 ============================== */

function initSidebar() {
  const root = $('sidebar');
  if (!root) throw new Error('缺少 #sidebar');

  sidebar = new Sidebar(root, {
    onSelectWaypoint: (id) => focusWaypoint(id, { fromList: true }),
    onToggleGroup: (groupId, visible) => setGroupVisible(groupId, visible),
    onDimensionChange: (id) => applyDimension(id),
    onSearch: (query) => {
      state.query = String(query || '').trim();
      applySearchFilter();
    },
    onAction: (name) => handleAction(name),
    onHoverWaypoint: (id) => tryCall(markers, 'setHighlight', id),
  });

  tryCall(sidebar, 'setSiteInfo', state.config.site);
  tryCall(sidebar, 'setDimensions', state.config.dimensions, state.config.defaultDimension);
  tryCall(sidebar, 'setCalibrationNotice', false);
}

function handleAction(name) {
  switch (name) {
    case 'fit':
      fitToContent();
      break;
    case 'expand-all':
      tryCall(sidebar, 'expandAllGroups', true);
      break;
    case 'reset':
      // 左下角「原点」：回到世界原点，并恢复到默认视野比例（而不是保持当前缩放）
      if (!focusOrigin({ animate: true })) gotoWorld(0, 0, { animate: true });
      break;
    case 'grid':
      toggleGrid();
      break;
    case 'copy-link':
      copyShareLink();
      break;
    case 'zoom-in':
      armHashSync();
      tryCall(view, 'zoomBy', 1.35);
      break;
    case 'zoom-out':
      armHashSync();
      tryCall(view, 'zoomBy', 1 / 1.35);
      break;
    case 'all-visible':
      setAllGroupsVisible(true);
      break;
    case 'all-hidden':
      setAllGroupsVisible(false);
      break;
    case 'toggle-labels':
      cycleLabelMode();
      break;
    default:
      console.debug('[app] 未处理的动作：', name);
  }
}

/* ============================== 标记层 ============================== */

function initMarkers() {
  const overlay = $('overlay');
  if (!overlay) throw new Error('缺少 #overlay');
  markers = new MarkerLayer(overlay, view, {
    onSelect: (wp) => {
      state.activeWaypointId = wp ? wp.id : null;
      tryCall(sidebar, 'setActiveWaypoint', wp ? wp.id : null);
    },
    onHover: (wp) => tryCall(sidebar, 'setHighlight', wp ? wp.id : null),
    onCopy: () => toast('坐标已复制'),
  });
  tryCall(markers, 'setLabelMode', state.labelMode);
}

/* ============================== 维度切换 ============================== */

async function applyDimension(dimensionId, opts = {}) {
  const dim =
    state.config.dimensions.find((d) => d.id === dimensionId) || state.config.dimensions[0];
  if (!dim) return;

  // 切走之前先记下当前维度的视角（切回来时恢复）
  if (state.dimension && String(state.dimension.id) !== String(dim.id)) rememberDimensionView(state.dimension.id);

  const token = ++state.loadToken;
  state.dimension = dim;
  state.imageSize = null;
  state.projection = null;
  state.calibration = null;
  state.activeWaypointId = null;
  document.body.dataset.dimension = dim.id;
  setText('footer-dim', dim.name);
  tryCall(sidebar, 'setDimensions', state.config.dimensions, dim.id);
  tryCall(sidebar, 'setActiveWaypoint', null);
  tryCall(sidebar, 'setLoading', true);
  tryCall(markers, 'setData', [], [], null);
  hideMapState();
  showMapState({ tone: 'loading', title: '正在载入地图…', text: dim.image || '（未配置图片）' });

  let size = null;
  try {
    size = await view.setImage(dim.image);
    if (!size && view.getImageSize) size = view.getImageSize();
  } catch (err) {
    console.warn(`[app] 基底图加载失败：${dim.image}`, err);
    size = null;
  }
  if (token !== state.loadToken) return; // 期间又切换了维度
  if (!size || !size.width) {
    // 缺图：仍然可用（路径点列表照常显示），但地图区给出引导
    tryCall(sidebar, 'setLoading', false);
    tryCall(sidebar, 'setData', {
      waypoints: dim.waypoints,
      groups: dim.groups,
      projection: null,
      dimension: dim,
    });
    tryCall(sidebar, 'setCalibrationNotice', false);
    tryCall(markers, 'setData', [], [], null);
    updateStats();
    showMapState({
      tone: 'warn',
      title: `「${dim.name}」的地图还没上传`,
      text: dim.image ? `找不到基底图片：${dim.image}` : '该维度没有配置 image 字段',
      hint: '把导出的地图图片按这个文件名放到站点根目录即可；路径点会按世界坐标自动落位。',
    });
    updateFooterStatus();
    return;
  }

  state.imageSize = { width: size.width, height: size.height };
  state.calibration = resolveCalibration(dim, state.imageSize);
  state.projection = buildProjection(state.calibration, state.imageSize);
  tryCall(view, 'setProjection', state.projection);
  // 换维度时测量点不再有效：先记下数量再清空（提示要用）
  const measurePointsBeforeSwitch = measure ? measure.points.length : 0;
  tryCall(measure, 'setProjection', state.projection);
  tryCall(measure, 'clear');
  updateMeasureReadout();

  // 视角：优先 URL 深链 → 该维度上次的视角 → 默认聚焦世界原点
  const hash = opts.hash || readHash();
  const applied = hash && hash.dim === dim.id ? applyHashView(hash) : false;
  if (!applied && !restoreDimensionView(dim.id, size)) {
    if (!focusOrigin({ animate: false, arm: false })) fitToContent({ animate: false, arm: false });
  }

  // 换维度后旧的搜索词/测量结果都不适用了，清掉并说清楚（否则会以为"这个维度没有点"）
  if (state.query) {
    state.query = '';
    const search = $('waypoint-search');
    if (search) search.value = '';
    tryCall(sidebar, 'clearSearch');
  }
  if (measurePointsBeforeSwitch > 0) {
    toast(`切换维度已清空 ${measurePointsBeforeSwitch} 个测量点`, 'info', 2600);
  }

  pushDataToSidebar();
  refreshMarkers();
  hideMapState();
  tryCall(sidebar, 'setLoading', false);
  updateCalibrationNotice();
  updateFooterStatus();
  drawGrid(safeViewState());
  scheduleHashSync();
}

function pushDataToSidebar() {
  const dim = state.dimension;
  if (!dim) return;
  tryCall(sidebar, 'setData', {
    waypoints: dim.waypoints,
    groups: dim.groups,
    projection: state.projection,
    dimension: dim,
  });
  for (const g of dim.groups) {
    if (!state.visibleGroups.has(g.id)) state.visibleGroups.set(g.id, g.visible !== false);
  }
  updateStats();
}

function refreshMarkers() {
  const dim = state.dimension;
  if (!dim) return;
  tryCall(markers, 'setData', dim.waypoints, dim.groups, state.projection);
  for (const [groupId, visible] of state.visibleGroups) {
    tryCall(markers, 'setGroupVisible', groupId, visible);
  }
  tryCall(markers, 'setLabelMode', state.labelMode);
  applySearchFilter();
  tryCall(markers, 'update');
  updateStats();
}

function updateStats() {
  const dim = state.dimension;
  if (!dim) return;
  const visible = dim.waypoints.filter((w) => state.visibleGroups.get(w.group) !== false);
  const shown = state.query ? visible.filter(matchQuery(state.query)) : visible;
  tryCall(sidebar, 'setStats', {
    total: dim.waypoints.length,
    visible: shown.length,
    hidden: dim.waypoints.length - shown.length,
  });
}

/* ============================== 搜索 / 分组 ============================== */

function matchQuery(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return () => true;
  const nums = q.match(/-?\d+(\.\d+)?/g);
  return (wp) => {
    if (wp.name && wp.name.toLowerCase().includes(q)) return true;
    if (wp.description && wp.description.toLowerCase().includes(q)) return true;
    const coordText = `${Math.round(wp.x)} ${Math.round(wp.z)}`;
    if (coordText.includes(q)) return true;
    if (nums && nums.length >= 2) {
      const [nx, nz] = nums;
      return (
        String(Math.round(wp.x)).startsWith(String(Math.trunc(Number(nx)))) &&
        String(Math.round(wp.z)).startsWith(String(Math.trunc(Number(nz))))
      );
    }
    return false;
  };
}

function applySearchFilter() {
  const pred = state.query ? matchQuery(state.query) : null;
  if (typeof markers.setFilter === 'function') {
    tryCall(markers, 'setFilter', pred);
    tryCall(markers, 'update');
  } else if (pred) {
    const dim = state.dimension;
    const filtered = dim ? dim.waypoints.filter(pred) : [];
    tryCall(markers, 'setData', filtered, dim ? dim.groups : [], state.projection);
  }
  updateStats();
}

function setGroupVisible(groupId, visible) {
  state.visibleGroups.set(groupId, visible !== false);
  tryCall(markers, 'setGroupVisible', groupId, visible !== false);
  tryCall(markers, 'update');
  updateStats();
}

function setAllGroupsVisible(visible) {
  const dim = state.dimension;
  if (!dim) return;
  for (const g of dim.groups) {
    state.visibleGroups.set(g.id, visible);
    tryCall(markers, 'setGroupVisible', g.id, visible);
  }
  tryCall(markers, 'update');
  pushDataToSidebar();
  toast(visible ? '已显示全部分组' : '已隐藏全部分组');
}


/* ============================== 测距 ============================== */

/** @type {MeasureLayer|null} */
let measure = null;

function initMeasure() {
  const overlay = $('overlay');
  if (!overlay) return;
  measure = new MeasureLayer(overlay);
  tryCall(measure, 'setProjection', state.projection);
}

function isMeasureActive() {
  return !!(measure && state.measureActive);
}

function setMeasureActive(active) {
  if (!measure) return;
  state.measureActive = !!active;
  tryCall(measure, 'setActive', state.measureActive);
  const btn = $('btn-measure');
  if (btn) {
    btn.setAttribute('aria-pressed', state.measureActive ? 'true' : 'false');
    btn.classList.toggle('is-active', state.measureActive);
  }
  const panel = $('measure-readout');
  if (panel) panel.hidden = !state.measureActive && measure.points.length === 0;
  document.body.classList.toggle('is-measuring', state.measureActive);
  if (state.measureActive) {
    toast('测距已开启：点地图加测量点（点路径点会吸附）· Backspace 撤销 · Enter/Esc 结束（测量点会保留）', 'ok', 4200);
  }
  updateMeasureReadout();
}

function toggleMeasure() {
  setMeasureActive(!state.measureActive);
}

function clearMeasure() {
  if (!measure) return;
  tryCall(measure, 'clear');
  updateMeasureReadout();
}

function undoMeasurePoint() {
  if (!measure) return;
  const removed = tryCall(measure, 'undo');
  if (removed) toast('已撤销上一个测量点');
  updateMeasureReadout();
}

/**
 * 找最近的路径点并在 14 屏幕像素内吸附。
 * 判定放在**图片像素**空间：tolPx = 14 / scale，这样不用再依赖 client 坐标，
 * 缩放到任何级别行为都一致。
 */
function snapToWaypoint(imagePoint) {
  const proj = state.projection;
  if (!proj || !imagePoint) return null;
  const vs = safeViewState();
  const scale = vs && vs.scale > 0 ? vs.scale : 1;
  const tolPx = 14 / scale;
  let best = null;
  let bestDist = tolPx;
  const waypoints = state.dimension && Array.isArray(state.dimension.waypoints) ? state.dimension.waypoints : [];
  for (const waypoint of waypoints) {
    const img = proj.worldToImage(waypoint.x, waypoint.z);
    if (!img || !Number.isFinite(img.px)) continue;
    const dist = Math.hypot(img.px - imagePoint.px, img.py - imagePoint.py);
    if (dist < bestDist) {
      bestDist = dist;
      best = { x: Number(waypoint.x), z: Number(waypoint.z), snapped: waypoint.name || waypoint.id || null };
    }
  }
  if (best) return best;
  const world = proj.imageToWorld ? proj.imageToWorld(imagePoint.px, imagePoint.py) : null;
  return world && Number.isFinite(world.x) ? { x: world.x, z: world.z, snapped: null } : null;
}

/** 地图点击：测量模式下加一个测量点（不触发路径点选中） */
function handleMeasureClick(imagePoint) {
  if (!measure || !imagePoint) return false;
  const point = snapToWaypoint(imagePoint);
  // 调试用：记录最近一次测量点击（自动化测试与排查吸附问题会用）
  window.__measureLastClick = { imagePoint: { px: imagePoint.px, py: imagePoint.py }, point, active: state.measureActive };
  if (!point) return true;
  const added = tryCall(measure, 'addPoint', point);
  updateMeasureReadout();
  if (added && added.segment > 0) {
    toast(`本段 ${formatDistance(added.segment)} 格 · 总长 ${formatDistance(measure.total)} 格`, 2200);
  } else if (point.snapped) {
    toast(`起点已吸附到「${point.snapped}」`, 2000);
  }
  return true;
}

/** 读数面板：总长 + 每段距离 */
function updateMeasureReadout() {
  const panel = $('measure-readout');
  const totalEl = $('measure-total');
  const listEl = $('measure-list');
  if (!measure || !panel || !totalEl) return;
  const summary = measure.summary || { segments: [], total: 0, points: [] };
  const hasPoints = summary.points.length > 0;
  panel.hidden = !state.measureActive && !hasPoints;
  totalEl.textContent = `${formatDistance(summary.total)} 格`;
  if (listEl) {
    listEl.textContent = '';
    summary.segments.forEach((value, index) => {
      const item = document.createElement('li');
      const a = summary.points[index];
      const b = summary.points[index + 1];
      item.textContent = `第 ${index + 1} 段：${formatDistance(value)} 格　(${Math.round(a.x)}, ${Math.round(a.z)}) → (${Math.round(b.x)}, ${Math.round(b.z)})`;
      listEl.appendChild(item);
    });
    if (summary.segments.length > 1) {
      const totalItem = document.createElement('li');
      totalItem.className = 'is-total';
      totalItem.textContent = `合计 ${formatDistance(summary.total)} 格（${summary.segments.length} 段）`;
      listEl.appendChild(totalItem);
    }
  }
}


/* ============================== 定位 ============================== */

function findWaypoint(id) {
  const dim = state.dimension;
  if (!dim) return null;
  return dim.waypoints.find((w) => w.id === id) || null;
}

function focusWaypoint(id, { fromList = false } = {}) {
  const wp = findWaypoint(id);
  if (!wp) return;
  state.activeWaypointId = id;
  tryCall(sidebar, 'setActiveWaypoint', id);

  // 该点所在分组若被隐藏，先自动显示，否则「点了列表却找不到标记」
  if (state.visibleGroups.get(wp.group) === false) {
    state.visibleGroups.set(wp.group, true);
    tryCall(markers, 'setGroupVisible', wp.group, true);
    tryCall(sidebar, 'setGroupVisibility', wp.group, true);
    tryCall(markers, 'update');
    updateStats();
  }

  if (!state.projection) {
    toast('该维度的地图尚未上传，暂时无法在地图上定位');
    return;
  }
  const pt = state.projection.worldToImage(wp.x, wp.z);
  if (!pt) return;
  const targetScale = Math.max(currentScale(), 0.6);
  if (fromList) armHashSync();
  tryCall(view, 'centerOnImagePoint', pt.px, pt.py, { scale: targetScale, animate: true });
  tryCall(markers, 'setSelected', id);
  if (fromList) tryCall(markers, 'update');
}

function currentScale() {
  const vs = safeViewState();
  return vs ? vs.scale || 0.1 : 0.1;
}

/** 记下某个维度当前的视角（来回切维度时恢复，而不是每次都回原点） */
function rememberDimensionView(dimensionId) {
  const vs = safeViewState();
  const size = state.imageSize;
  if (!dimensionId || !vs || !size) return;
  state.dimensionView.set(String(dimensionId), {
    scale: vs.scale,
    tx: vs.tx,
    ty: vs.ty,
    imageWidth: size.width,
    imageHeight: size.height,
  });
}

/** 恢复某维度上次的视角；画幅变了（图片换了）就放弃，交给默认视野 */
function restoreDimensionView(dimensionId, size) {
  const saved = state.dimensionView.get(String(dimensionId));
  if (!saved || !size) return false;
  if (saved.imageWidth !== size.width || saved.imageHeight !== size.height) return false;
  const viewState = safeViewState();
  if (!viewState || !(viewState.viewWidth > 0)) return false;
  tryCall(view, 'setViewState', { scale: saved.scale, tx: saved.tx, ty: saved.ty }, { animate: false });
  drawGrid(safeViewState());
  return true;
}

/** 用户第一次操作视角后，才允许把视角写进地址栏 */
/** 键盘暗门首次使用时给一次提示（同一会话只提示一次） */
function hintOnce(key, message) {
  try {
    const seen = JSON.parse(localStorage.getItem('ssm.hints.v1') || '{}');
    if (seen[key]) return;
    seen[key] = 1;
    localStorage.setItem('ssm.hints.v1', JSON.stringify(seen));
  } catch {
    /* 隐私模式下不记忆，但照常提示 */
  }
  toast(message, 'info', 3000);
}

function armHashSync() {
  if (state.hashArmed) return;
  state.hashArmed = true;
  scheduleHashSync();
}

function fitToContent(opts = {}) {
  if (!state.imageSize) return;
  if (opts.arm !== false) armHashSync();
  tryCall(view, 'fitToContent', { padding: 24, animate: opts.animate !== false });
  drawGrid(safeViewState());
}

/**
 * 进入页面 / 点「原点」时的默认视野：以世界原点 (0,0) 为中心，横向约显示 DEFAULT_SPAN_BLOCKS 个方块。
 *
 * 为什么不直接整图适配：整图适配是「最小缩放」，1 像素只占 0.1~0.2 个屏幕像素，
 * 进来只看到一整片模糊的地图缩略图，既看不清地形也找不到自己在哪。
 * 换成「约 1024 方块视野」后大约 1 屏幕像素 = 1 方块（Minecraft 地图的原生比例），
 * 出生点周边地形和附近的路径点都能一眼看到。想总览全图仍可点「整图」。
 */
const DEFAULT_SPAN_BLOCKS = 1024;
const MIN_SPAN_BLOCKS = 64;
const MAX_SPAN_BLOCKS = 16384;

/** 当前配置希望的默认视野宽度（方块），可在 config.json 的 ui.defaultSpanBlocks 里改 */
function defaultSpanBlocks() {
  const raw = Number(state.config?.ui?.defaultSpanBlocks);
  if (!Number.isFinite(raw)) return DEFAULT_SPAN_BLOCKS;
  return Math.min(MAX_SPAN_BLOCKS, Math.max(MIN_SPAN_BLOCKS, raw));
}

/** 把视野聚焦到世界原点（等价于「回到原点」，但会主动设置一个合适的缩放） */
function focusOrigin(opts = {}) {
  if (!state.projection || !state.imageSize) return false;
  if (opts.arm !== false) armHashSync();
  const pt = state.projection.worldToImage(0, 0);
  if (!pt || !Number.isFinite(pt.px)) return false;

  // 每像素多少方块 → 想让视口宽度覆盖 span 个方块，需要的缩放比
  const blocksPerPixelX = (state.calibration ? state.calibration.xMax - state.calibration.xMin : state.imageSize.width) / state.imageSize.width;
  const viewState = safeViewState();
  const viewWidth = Number(viewState?.viewWidth) || 0;
  const span = defaultSpanBlocks();
  let scale = null;
  if (viewWidth > 0 && blocksPerPixelX > 0) {
    scale = (viewWidth * blocksPerPixelX) / span;
  }
  tryCall(view, 'centerOnImagePoint', pt.px, pt.py, { scale, animate: opts.animate !== false });
  drawGrid(safeViewState());
  return true;
}

function gotoWorld(x, z, opts = {}) {
  if (!state.projection) {
    toast('地图尚未载入');
    return;
  }
  const pt = state.projection.worldToImage(x, z);
  if (!pt) return;
  armHashSync();
  tryCall(view, 'centerOnImagePoint', pt.px, pt.py, { animate: opts.animate !== false });
}

/* ============================== 校准 ============================== */

function buildProjection(calibration, imageSize) {
  if (!calibration || !imageSize) return null;
  const params = {
    xMin: calibration.xMin,
    xMax: calibration.xMax,
    zMin: calibration.zMin,
    zMax: calibration.zMax,
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    flipZ: !!calibration.flipZ,
  };
  let proj = null;
  try {
    proj = createProjection(params);
  } catch (err) {
    console.error('[app] 创建投影失败', err);
    return null;
  }
  if (proj && proj.isValid === false) {
    console.warn('[app] 校准参数无效，路径点无法定位', params);
    return null;
  }
  return proj;
}

/** 合并 config.json 与浏览器本地校准覆盖，解析出最终画幅 */
function resolveCalibration(dim, imageSize) {
  const base = dim.calibration || {};
  let xMin = Number(base.xMin);
  let xMax = Number(base.xMax);
  let zMin = Number(base.zMin);
  let zMax = Number(base.zMax);

  if (![xMin, xMax, zMin, zMax].every(Number.isFinite)) {
    // 「缩放 + 原点」写法
    const ppb = Number(base.pixelsPerBlock);
    const ox = Number(base.originX);
    const oz = Number(base.originZ);
    if (Number.isFinite(ppb) && ppb > 0 && Number.isFinite(ox) && Number.isFinite(oz) && imageSize) {
      xMin = ox;
      zMin = oz;
      xMax = ox + imageSize.width / ppb;
      zMax = oz + imageSize.height / ppb;
    } else {
      return null;
    }
  }
  return {
    xMin: Math.min(xMin, xMax),
    xMax: Math.max(xMin, xMax),
    zMin: Math.min(zMin, zMax),
    zMax: Math.max(zMin, zMax),
    flipZ: base.flipZ === true,
    calibrated: base.calibrated === true,
    note: base.note || '',
  };
}

function applyCalibration(calibration) {
  const size = state.imageSize;
  if (!size || !calibration) return;
  const proj = buildProjection(calibration, size);
  if (!proj) {
    toast('校准参数无效，请检查四个边界值');
    return;
  }
  state.calibration = { ...calibration, calibrated: true };
  state.projection = proj;
  tryCall(view, 'setProjection', proj);
  refreshMarkers();
  updateCalibrationNotice();
  updateFooterStatus();
  drawGrid(safeViewState());
}

function updateCalibrationNotice() {
  const show = !state.calibration || state.calibration.calibrated !== true;
  tryCall(sidebar, 'setCalibrationNotice', show);
  document.body.dataset.calibrated = show ? '0' : '1';
}

/* ============================== 标签 / 网格 / 分享 ============================== */

const LABEL_CYCLE = ['hover', 'always', 'never'];

function cycleLabelMode() {
  const next = LABEL_CYCLE[(LABEL_CYCLE.indexOf(state.labelMode) + 1) % LABEL_CYCLE.length];
  state.labelMode = next;
  document.body.dataset.labels = next;
  tryCall(markers, 'setLabelMode', next);
  tryCall(markers, 'update');
  toast({ hover: '标签：悬停显示', always: '标签：始终显示', never: '标签：全部隐藏' }[next]);
}

function toggleGrid() {
  state.grid = !state.grid;
  document.body.dataset.grid = state.grid ? '1' : '0';
  const btn = $('btn-grid');
  if (btn) btn.setAttribute('aria-pressed', state.grid ? 'true' : 'false');
  if (gridCanvas) gridCanvas.style.opacity = state.grid ? '1' : '0';
  if (state.grid) drawGrid(safeViewState());
  toast(state.grid ? '已显示坐标网格' : '已隐藏坐标网格');
}

const GRID_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192];

function drawGrid(vs) {
  if (!gridCtx || !gridCanvas || !state.grid || !vs || !state.projection) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = gridCanvas.clientWidth || vs.viewWidth || 0;
  const h = gridCanvas.clientHeight || vs.viewHeight || 0;
  if (!w || !h) return;
  if (gridCanvas.width !== Math.round(w * dpr) || gridCanvas.height !== Math.round(h * dpr)) {
    gridCanvas.width = Math.round(w * dpr);
    gridCanvas.height = Math.round(h * dpr);
  }
  const ctx = gridCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cal = state.calibration;
  if (!cal) return;
  const worldW = cal.xMax - cal.xMin;
  const worldH = cal.zMax - cal.zMin;
  if (!worldW || !worldH) return;

  // 目标：网格线间距落在 48~140 屏幕像素
  let step = GRID_STEPS[GRID_STEPS.length - 1];
  for (const s of GRID_STEPS) {
    const px = (s / worldW) * vs.imageWidth * vs.scale;
    if (px >= 48) {
      step = s;
      break;
    }
  }

  const toScreen = (x, z) => {
    const proj = state.projection;
    const pt = proj.worldToImage(x, z);
    return { x: vs.tx + pt.px * vs.scale, y: vs.ty + pt.py * vs.scale };
  };

  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace';
  ctx.textBaseline = 'top';

  const startX = Math.ceil(cal.xMin / step) * step;
  const startZ = Math.ceil(cal.zMin / step) * step;

  for (let x = startX; x <= cal.xMax; x += step) {
    const p = toScreen(x, cal.zMin);
    if (p.x < -2 || p.x > w + 2) continue;
    const isAxis = Math.abs(x) < 0.0001;
    ctx.strokeStyle = isAxis ? 'rgba(90,210,111,.55)' : 'rgba(180,210,190,.13)';
    ctx.beginPath();
    ctx.moveTo(Math.round(p.x) + 0.5, 0);
    ctx.lineTo(Math.round(p.x) + 0.5, h);
    ctx.stroke();
    if (!isAxis) {
      ctx.fillStyle = 'rgba(200,220,205,.5)';
      ctx.fillText(String(x), Math.round(p.x) + 3, 4);
    }
  }

  for (let z = startZ; z <= cal.zMax; z += step) {
    const p = toScreen(cal.xMin, z);
    if (p.y < -2 || p.y > h + 2) continue;
    const isAxis = Math.abs(z) < 0.0001;
    ctx.strokeStyle = isAxis ? 'rgba(90,210,111,.55)' : 'rgba(180,210,190,.13)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(p.y) + 0.5);
    ctx.lineTo(w, Math.round(p.y) + 0.5);
    ctx.stroke();
    if (!isAxis) {
      ctx.fillStyle = 'rgba(200,220,205,.5)';
      ctx.fillText(String(z), 4, Math.round(p.y) + 2);
    }
  }
}

function updateScaleBar(vs) {
  const bar = $('scale-bar');
  const label = $('scale-bar-label');
  const line = bar ? bar.querySelector('.scale-bar-line') : null;
  if (!bar || !label || !line || !vs || !state.calibration) {
    if (bar) bar.hidden = true;
    return;
  }
  const cal = state.calibration;
  const worldW = cal.xMax - cal.xMin;
  if (!worldW || !vs.imageWidth) {
    bar.hidden = true;
    return;
  }
  const screenPxPerBlock = (vs.imageWidth / worldW) * vs.scale;
  const candidates = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000];
  let chosen = candidates[0];
  for (const c of candidates) {
    const px = c * screenPxPerBlock;
    if (px <= 140) chosen = c;
    else break;
  }
  bar.hidden = false;
  const width = Math.max(24, Math.round(chosen * screenPxPerBlock));
  line.style.width = `${width}px`;
  label.textContent = `${chosen.toLocaleString('zh-CN')} 方块`;
}

/* ============================== URL 深链 ============================== */

function readHash() {
  const out = {};
  try {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return out;
    const params = new URLSearchParams(raw);
    for (const key of ['dim', 'x', 'z', 's', 'wp']) {
      const v = params.get(key);
      if (v !== null) out[key] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function applyHashView(hash) {
  if (!state.projection) return false;
  const x = Number(hash.x);
  const z = Number(hash.z);
  const s = Number(hash.s);
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    if (hash.wp) focusWaypoint(hash.wp);
    return false;
  }
  const pt = state.projection.worldToImage(x, z);
  if (!pt) return false;
  tryCall(view, 'centerOnImagePoint', pt.px, pt.py, {
    scale: Number.isFinite(s) && s > 0 ? s : currentScale() || 0.5,
    animate: false,
  });
  if (hash.wp) {
    state.activeWaypointId = hash.wp;
    tryCall(markers, 'setSelected', hash.wp);
    tryCall(sidebar, 'setActiveWaypoint', hash.wp);
    tryCall(sidebar, 'setActiveWaypoint', hash.wp);
  }
  return true;
}

function scheduleHashSync() {
  if (hashTimer) return;
  hashTimer = setTimeout(() => {
    hashTimer = null;
    syncHash();
  }, 320);
}

function syncHash() {
  if (!state.dimension || !state.projection) return;
  if (!state.hashArmed) return; // 用户还没动过视角，先不写 hash
  const vs = safeViewState();
  if (!vs) return;
  const centerPx = (vs.viewWidth / 2 - vs.tx) / (vs.scale || 1);
  const centerPy = (vs.viewHeight / 2 - vs.ty) / (vs.scale || 1);
  const world = state.projection.imageToWorld(centerPx, centerPy);
  if (!world || !Number.isFinite(world.x)) return;
  const params = new URLSearchParams();
  params.set('dim', state.dimension.id);
  params.set('x', String(Math.round(world.x)));
  params.set('z', String(Math.round(world.z)));
  params.set('s', (vs.scale || 1).toFixed(3));
  if (state.activeWaypointId) params.set('wp', state.activeWaypointId);
  const next = `#${params.toString()}`;
  if (location.hash !== next) {
    try {
      history.replaceState(null, '', next);
    } catch {
      /* ignore */
    }
  }
}

function copyShareLink() {
  syncHash();
  const url = location.href;
  const done = () => toast('已复制当前视角链接');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => legacyCopy(url, done));
  } else {
    legacyCopy(url, done);
  }
}

function legacyCopy(text, onDone) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    Object.assign(ta.style, { position: 'fixed', top: '-1000px', opacity: '0' });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (onDone) onDone();
  } catch (err) {
    console.warn('[app] 复制失败', err);
    toast('复制失败，请手动复制地址栏');
  }
}

/* ============================== 状态展示 ============================== */

function showMapState({ tone = 'info', title = '', text = '', hint = '' } = {}) {
  const el = $('map-state');
  if (!el) return;
  el.hidden = false;
  el.dataset.tone = tone;
  el.innerHTML = `
    <div class="state-card">
      <div class="state-spinner" aria-hidden="true"></div>
      <h3 class="state-title"></h3>
      <p class="state-text"></p>
      <p class="state-hint"></p>
    </div>`;
  const setIf = (sel, value) => {
    const node = el.querySelector(sel);
    if (!node) return;
    node.textContent = value || '';
    if (!value) node.hidden = true;
  };
  setIf('.state-title', title);
  setIf('.state-text', text);
  setIf('.state-hint', hint);
  if (tone !== 'loading') {
    const spinner = el.querySelector('.state-spinner');
    if (spinner) spinner.hidden = true;
  }
  el.dataset.tone = tone;
}

function hideMapState() {
  const el = $('map-state');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
  }
}

function showFatalConfigError(error) {
  const isFile = location.protocol === 'file:';
  showMapState({
    tone: 'error',
    title: '无法加载 config.json',
    text: String(error && error.message ? error.message : error),
    hint: isFile
      ? '你正在用 file:// 直接打开页面，浏览器会阻止读取本地 JSON。请在本目录运行 `python -m http.server 8000`，然后访问 http://localhost:8000/'
      : '请检查 config.json 是否存在、JSON 语法是否正确（多余逗号 / 中文引号是最常见原因）。',
  });
  const list = $('waypoint-list');
  if (list) list.innerHTML = '';
  setText('footer-dim', '配置读取失败');
}

function updateFooterStatus() {
  const el = $('footer-status');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
  el.onclick = null;
}

function toast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-show');
    setTimeout(() => {
      el.hidden = true;
    }, 220);
  }, 2600);
}

/* ============================== 事件绑定 ============================== */

function bindClick(id, handler) {
  const el = $(id);
  if (!el) {
    console.warn(`[app] 找不到按钮 #${id}`);
    return;
  }
  el.addEventListener('click', (e) => {
    e.preventDefault();
    handler(e);
  });
}

function bindGlobalKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 最上层优先：先关路径点详情卡，再退测距，最后才是取消选中
      // 注意：详情卡元素是常驻 DOM 的，要按 hidden 判断是否真的开着，否则 Esc 永远被"关卡片"吃掉
      const popupEl = document.querySelector('.marker-popup');
      const popupOpen = !!popupEl && !popupEl.hidden;
      if (popupOpen) {
        tryCall(markers, 'setSelected', null);
        tryCall(sidebar, 'setActiveWaypoint', null);
        state.activeWaypointId = null;
        return;
      }
      if (isMeasureActive()) {
        setMeasureActive(false);
        return;
      }
      tryCall(markers, 'setSelected', null);
      tryCall(sidebar, 'setActiveWaypoint', null);
      state.activeWaypointId = null;
    }
    if (e.key === 'Backspace' && isMeasureActive() && !isTyping(e.target)) {
      e.preventDefault();
      undoMeasurePoint();
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Return') && isMeasureActive() && !isTyping(e.target)) {
      e.preventDefault();
      setMeasureActive(false);
      return;
    }
    if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !isTyping(e.target)) {
      toggleGrid();
      hintOnce('grid', 'G：显示/隐藏坐标网格');
    }
    if (e.key === 'l' && !e.ctrlKey && !e.metaKey && !isTyping(e.target)) {
      cycleLabelMode();
      hintOnce('labels', 'L：切换标签模式（悬停 / 常显 / 隐藏）');
    }
  });

  window.addEventListener('resize', () => {
    drawGrid(safeViewState());
    updateScaleBar(safeViewState());
  });

  window.addEventListener('hashchange', () => {
    const hash = readHash();
    if (hash.dim && state.dimension && hash.dim !== state.dimension.id) {
      applyDimension(hash.dim, { hash });
    } else {
      applyHashView(hash);
    }
  });
}

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/* 供调试/测试使用 */
window.__mapApp = {
  state,
  get view() {
    return view;
  },
  get markers() {
    return markers;
  },
  get sidebar() {
    return sidebar;
  },
  get projection() {
    return state.projection;
  },
  applyDimension,
  applyCalibration,
  resolveCalibration,
  focusWaypoint,
  toggleGrid,
  cycleLabelMode,
  fitToContent,
  toast,
  get measure() {
    return measure;
  },
  measureSummary: () => (measure ? measure.summary : null),
  toggleMeasure,
  setMeasureActive,
  clearMeasure,
  undoMeasurePoint,
  addMeasurePoint: (x, z) => {
    if (!measure) return null;
    const added = measure.addPoint({ x, z });
    updateMeasureReadout();
    return added;
  },
};
