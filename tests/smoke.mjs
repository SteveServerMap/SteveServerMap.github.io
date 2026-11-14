/**
 * tests/smoke.mjs
 * SteveServerMap 端到端验收脚本 —— 逐条覆盖 docs/CONTRACT.md §9。
 *
 * 运行：
 *   node tests/smoke.mjs                       # 自起静态服务器 + 无头 Edge
 *   node tests/smoke.mjs --url=http://...      # 指向已启动的外部服务
 *   node tests/smoke.mjs --headed              # 有头模式（排障用）
 *   node tests/smoke.mjs --browser=<路径>      # 指定浏览器
 *   node tests/smoke.mjs --keep                # 保留临时 profile 便于排查
 *
 * 退出码：0 全部通过；1 有失败项 / 运行中断。
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  CDP,
  Page,
  createDiagnostics,
  createReporter,
  ensureDir,
  formatDuration,
  launchBrowser,
  parseArgs,
  sleep,
  startStaticServer,
  truncate,
  waitUntil,
} from './headless.mjs';

/* ------------------------------------------------------------------ *
 * 环境与参数
 * ------------------------------------------------------------------ */

const projectRoot = path.resolve(import.meta.dirname, '..');
const artifactsDir = path.join(projectRoot, 'tests', 'artifacts');
const runLockPath = path.join(artifactsDir, '.run.lock');
const args = parseArgs();
const VIEWPORT = { width: 1440, height: 900 };
const POSITION_TOLERANCE = 1.5; // 契约 §9.3：误差 < 1.5px
const CENTER_TOLERANCE = 40; // 契约 §9.4：侧栏点击后接近视口中心（px）
const timeoutScale = Math.max(0.2, Number(args.timeout) || 1);
const WAIT = {
  short: Math.round(3000 * timeoutScale),
  normal: Math.round(8000 * timeoutScale),
  long: Math.round(20000 * timeoutScale),
};

/**
 * 瓦片底图里「文件不存在」是正常情况（导出时全透明的瓦片不落地），
 * 浏览器会为每个 404 记一条 network / log 错误。这类错误必须放行，
 * 否则 run.console 会被它们刷屏（契约 §10：瓦片 404 静默忽略）。
 */
// 兼容根清单 tiles/tiles/… 与按维度分目录 tiles/<dim>/tiles/… 两种布局。
const TILE_404_PATTERN = /\/tiles\/(?:[^/]+\/)?tiles\/\d+\/\d+_\d+\.png(?:[?#].*)?$/i;
const isExpectedTileMiss = (error) =>
  /404/.test(String(error?.text || '')) &&
  TILE_404_PATTERN.test(String(error?.where || ''));

const rep = createReporter('smoke');
let server = null;
let browser = null;
let conn = null;
let page = null;
let diag = null;
let baseUrl = '';
let reportPath = '';
let runLockHeld = false;

const ctx = {
  config: null,
  currentDimensionId: null,
  uiReady: false,
  lastPositions: null,
};

/* ------------------------------------------------------------------ *
 * 页面内执行的小工具（通过 evalFn 序列化传入，必须是纯函数）
 * ------------------------------------------------------------------ */

const INIT_SCRIPT = `
(() => {
  const state = { errors: [], unhandled: [] };
  try {
    Object.defineProperty(window, '__qa', { value: state, configurable: true });
  } catch (error) {
    window.__qa = state;
  }
  addEventListener('error', (event) => {
    const target = event.target;
    let message = String(event.message || (event.error && event.error.message) || '');
    let source = event.filename || '';
    if (!message && target && target !== window && target.tagName) {
      // 模块 <script> / <img> 资源加载失败时 error 事件没有 message，退回到元素 URL
      source = target.src || target.href || '';
      message = target.tagName.toLowerCase() + ' 资源加载失败：' + (source || '(未知 URL)');
    }
    state.errors.push({
      kind: 'window.error',
      message: message || 'unknown error',
      source,
      line: event.lineno || 0,
    });
  }, true);
  addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    let message;
    if (reason && typeof reason === 'object') message = reason.stack || reason.message || String(reason);
    else message = String(reason);
    state.unhandled.push({ message: String(message) });
  });
  window.__qaErrors = () => ({
    errors: state.errors.slice(),
    unhandled: state.unhandled.slice(),
  });
})();
`;

/**
 * 读取「当前底图元素」的几何信息。
 * 单张图片维度是 <img id="map-image">，瓦片维度是 <canvas id="map-canvas">：
 * 底图几何一律读 #stage 的显示矩形 —— 瓦片渲染是外扩窗口渲染，<canvas> 的 CSS 盒盖住
 * 视口外扩一圈的区域，只有 #stage 才是「整幅地图」在屏幕上的盒子，rect/natural 换算对两边都成立
 * （canvas 的逻辑尺寸写在 data-image-width/height 上，因为它的 width 属性是窗口位图尺寸）。
 */
function IMAGE_INFO() {
  const img = document.querySelector('#map-image');
  const canvas = document.querySelector('#map-canvas');
  const el = canvas && !canvas.hidden ? canvas : img;
  const viewport = document.querySelector('#viewport');
  if (!el) return null;
  const stage = document.querySelector('#stage');
  const rect = (stage || el).getBoundingClientRect();
  const viewRect = viewport ? viewport.getBoundingClientRect() : null;
  const isCanvas = el.tagName === 'CANVAS';
  const naturalWidth = isCanvas ? Number(el.dataset.imageWidth || 0) : el.naturalWidth;
  const naturalHeight = isCanvas ? Number(el.dataset.imageHeight || 0) : el.naturalHeight;
  return {
    kind: isCanvas ? 'tiles' : 'image',
    id: el.id,
    naturalWidth,
    naturalHeight,
    complete: isCanvas ? naturalWidth > 0 : el.complete,
    src: isCanvas ? String(el.dataset.manifest || '') : String(el.currentSrc || el.src || ''),
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    },
    viewport: viewRect
      ? {
          left: viewRect.left,
          top: viewRect.top,
          width: viewRect.width,
          height: viewRect.height,
          right: viewRect.right,
          bottom: viewRect.bottom,
        }
      : null,
    stageTransform: stage ? getComputedStyle(stage).transform : null,
    calibration: (() => {
      const cal = window.__mapApp && window.__mapApp.state && window.__mapApp.state.calibration;
      if (!cal) return null;
      return { xMin: cal.xMin, xMax: cal.xMax, zMin: cal.zMin, zMax: cal.zMax, flipZ: !!cal.flipZ };
    })(),
  };
}

function MARKER_STATS(groupId) {
  const overlay = document.querySelector('#overlay');
  if (!overlay) return null;
  const isVisible = (el) => {
    if (!el || el.hidden) return false;
    const style = getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch (error) {
        /* 忽略：旧版浏览器没有 checkVisibility 选项 */
      }
    }
    return true;
  };
  const all = [...overlay.querySelectorAll('.marker')];
  const scoped = groupId ? all.filter((marker) => marker.dataset.group === groupId) : all;
  return {
    total: all.length,
    shown: all.filter(isVisible).length,
    // is-offscreen：最小缩放（0.02）下画幅高于视口时，边缘路径点会被主动裁掉（不算缺陷）
    offscreen: all.filter((marker) => marker.classList.contains('is-offscreen')).length,
    groupTotal: scoped.length,
    groupShown: scoped.filter(isVisible).length,
    ids: all.map((marker) => marker.dataset.id || null),
  };
}

function MARKER_RECTS() {
  const overlay = document.querySelector('#overlay');
  if (!overlay) return [];
  return [...overlay.querySelectorAll('.marker')].map((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      id: el.dataset.id || null,
      group: el.dataset.group || null,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      },
      visible:
        !el.hidden &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        parseFloat(style.opacity || '1') > 0.05,
      offscreen: el.classList.contains('is-offscreen'),
      transform: style.transform,
    };
  });
}

function LIST_STATS() {
  const list = document.querySelector('#waypoint-list');
  const empty = document.querySelector('#waypoint-empty');
  if (!list) return null;
  const pickItems = () => {
    const selectors = ['[data-waypoint-id]', '[data-id]', '.waypoint-item', 'li'];
    for (const selector of selectors) {
      const found = [...list.querySelectorAll(selector)].filter((el) => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && !el.hidden;
      });
      if (found.length > 0) return { items: found, strategy: selector };
    }
    const fallback = [...list.children].filter((el) => {
      if (el.hidden || el.tagName === 'TEMPLATE') return false;
      const style = getComputedStyle(el);
      return style.display !== 'none';
    });
    return { items: fallback, strategy: ':scope > *' };
  };
  const { items, strategy } = pickItems();
  return {
    count: items.length,
    strategy,
    ids: items.map(
      (el) =>
        el.dataset?.id ||
        el.dataset?.waypointId ||
        el.querySelector?.('[data-id]')?.dataset?.id ||
        null,
    ),
    texts: items.slice(0, 12).map((el) => (el.textContent || '').trim().slice(0, 40)),
    emptyHidden: empty ? Boolean(empty.hidden) : null,
    emptyVisible: empty
      ? !empty.hidden && getComputedStyle(empty).display !== 'none'
      : null,
    countBadge: (document.querySelector('#waypoint-count')?.textContent || '').trim(),
    sampleHtml: list.innerHTML.slice(0, 600),
  };
}

function SET_INPUT(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return false;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor.set.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function LAYOUT() {
  const sidebar = document.querySelector('#sidebar');
  const viewport = document.querySelector('#viewport');
  const backdrop = document.querySelector('#sidebar-backdrop');
  const toggle = document.querySelector('#sidebar-toggle');
  const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
  const viewRect = viewport ? viewport.getBoundingClientRect() : null;
  const toggleRect = toggle ? toggle.getBoundingClientRect() : null;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    bodySidebar: document.body.dataset.sidebar ?? null,
    sidebar: sidebarRect
      ? { left: sidebarRect.left, right: sidebarRect.right, width: sidebarRect.width, height: sidebarRect.height }
      : null,
    viewport: viewRect
      ? { left: viewRect.left, right: viewRect.right, width: viewRect.width, height: viewRect.height }
      : null,
    backdrop: backdrop
      ? {
          hidden: Boolean(backdrop.hidden),
          display: getComputedStyle(backdrop).display,
          visibility: getComputedStyle(backdrop).visibility,
        }
      : null,
    toggleUsable: Boolean(toggleRect && toggleRect.width > 0 && toggleRect.height > 0),
    sidebarDisplay: sidebar ? getComputedStyle(sidebar).display : null,
    sidebarShadow: sidebar ? getComputedStyle(sidebar).boxShadow : null,
  };
}

function DIMENSION_STATE() {
  const buttons = [...document.querySelectorAll('#dimension-switch button, #dimension-switch [role="tab"]')];
  const img = document.querySelector('#map-image');
  const canvas = document.querySelector('#map-canvas');
  const layer = canvas && !canvas.hidden ? canvas : img;
  const isCanvas = Boolean(layer) && layer.tagName === 'CANVAS';
  return {
    bodyDimension: document.body.dataset.dimension ?? null,
    buttons: buttons.map((button) => ({
      text: (button.textContent || '').trim(),
      dimension:
        button.dataset.dimension || button.dataset.dim || button.dataset.id || null,
      active:
        button.getAttribute('aria-selected') === 'true' ||
        button.getAttribute('aria-pressed') === 'true' ||
        button.classList.contains('is-active'),
    })),
    baseLayer: document.body.dataset.base ?? null,
    layerKind: isCanvas ? 'tiles' : 'image',
    imageSrc: layer ? (isCanvas ? String(layer.dataset.manifest || '') : layer.currentSrc || layer.src) : null,
    imageNaturalWidth: layer
      ? (isCanvas ? Number(layer.dataset.imageWidth || 0) : layer.naturalWidth)
      : 0,
    markerCount: document.querySelectorAll('#overlay .marker').length,
    markerIds: [...document.querySelectorAll('#overlay .marker')].map((el) => el.dataset.id || null),
  };
}

/** 列表项（名称 / id / 顺序），用于验证「配置驱动」 */
function LIST_ITEMS() {
  const list = document.querySelector('#waypoint-list');
  if (!list) return null;
  let items = [...list.querySelectorAll('.waypoint-item')];
  if (items.length === 0) items = [...list.querySelectorAll('[data-id], [data-waypoint-id]')];
  if (items.length === 0) {
    items = [...list.children].filter(
      (el) => !el.hidden && (el.tagName === 'BUTTON' || el.tagName === 'LI' || el.dataset?.id),
    );
  }
  return items.map((el) => {
    const nameEl = el.querySelector('.waypoint-name, [data-name]');
    return {
      id: el.dataset?.id || el.dataset?.waypointId || null,
      name: (nameEl?.textContent || el.textContent || '').trim().slice(0, 80),
      text: (el.textContent || '').trim().slice(0, 120),
    };
  });
}

/** 分组行（id / 名称 / 数量） */
function GROUP_STATS() {
  const box = document.querySelector('#group-list');
  if (!box) return null;
  let rows = [...box.querySelectorAll('.group-item, [data-group]')];
  if (rows.length === 0) rows = [...box.children].filter((el) => el.tagName !== 'TEMPLATE');
  return {
    count: rows.length,
    ids: rows.map((el) => el.dataset?.group ?? el.dataset?.groupId ?? el.dataset?.id ?? null),
    names: rows.map((el) =>
      (el.querySelector('.group-name')?.textContent || el.textContent || '').trim().slice(0, 40),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Node 侧工具
 * ------------------------------------------------------------------ */

function dimensionById(id) {
  return (ctx.config?.dimensions ?? []).find((dim) => dim.id === id) ?? null;
}

function expectedScreenPoint(dimension, imageInfo, x, z) {
  // 瓦片维度 config.calibration 只是说明性字段（世界范围以 manifest 为准），
  // 期望值必须用页面实际生效的投影（瓦片 = manifest / 单图 = calibration）。
  const cal = (imageInfo && imageInfo.calibration) || dimension.calibration;
  const flipZ = Boolean(cal.flipZ);
  let px = ((x - cal.xMin) / (cal.xMax - cal.xMin)) * imageInfo.naturalWidth;
  let py = ((z - cal.zMin) / (cal.zMax - cal.zMin)) * imageInfo.naturalHeight;
  if (flipZ) py = imageInfo.naturalHeight - py;
  const sx = imageInfo.rect.left + px * (imageInfo.rect.width / imageInfo.naturalWidth);
  const sy = imageInfo.rect.top + py * (imageInfo.rect.height / imageInfo.naturalHeight);
  return { sx, sy, px, py };
}

/** 标记元素的「坐标锚点」候选：针尖/左上角等，取决于 marker 内部 transform 写法 */
function anchorCandidates(rect) {
  return [
    ['bottom-center', rect.left + rect.width / 2, rect.bottom],
    ['top-left', rect.left, rect.top],
    ['top-center', rect.left + rect.width / 2, rect.top],
    ['center', rect.left + rect.width / 2, rect.top + rect.height / 2],
    ['bottom-left', rect.left, rect.bottom],
    ['bottom-right', rect.right, rect.bottom],
    ['top-right', rect.right, rect.top],
  ];
}

async function errorSnapshot() {
  const cdp = diag ? diag.snapshot() : [];
  let injected = { errors: [], unhandled: [] };
  try {
    injected = (await page.evaluate(
      '(window.__qaErrors ? window.__qaErrors() : { errors: [], unhandled: [] })',
    )) ?? { errors: [], unhandled: [] };
  } catch {
    /* 页面可能已不可达 */
  }
  return {
    cdp,
    injected: injected.errors ?? [],
    unhandled: injected.unhandled ?? [],
  };
}

function flattenErrors(snapshot) {
  const items = [];
  for (const error of snapshot.cdp) {
    if (isExpectedTileMiss(error)) continue;
    items.push(`[${error.kind}] ${truncate(error.text, 300)}${error.where ? ` @ ${truncate(error.where, 200)}` : ''}`);
  }
  for (const error of snapshot.injected) {
    // <img> 的 error 事件会被 window 的捕获阶段监听器看到，缺瓦片同理，一并放行
    if (isExpectedTileMiss({ text: error.message, where: error.source })) continue;
    items.push(`[${error.kind}] ${truncate(error.message, 300)}${error.source ? ` @ ${error.source}:${error.line}` : ''}`);
  }
  for (const error of snapshot.unhandled) {
    items.push(`[unhandledrejection] ${truncate(error.message, 300)}`);
  }
  return items;
}

async function errorCount() {
  return flattenErrors(await errorSnapshot()).length;
}

async function expectNoErrorsSince(baseline, label) {
  const items = flattenErrors(await errorSnapshot());
  const fresh = items.slice(baseline);
  if (fresh.length > 0) {
    throw new Error(`${label}：出现 ${fresh.length} 条 console error / 未捕获异常 → ${fresh.slice(0, 6).join('；')}`);
  }
  return '无 console error';
}

async function captureFailure(id) {
  const artifacts = { screenshot: null, dom: null };
  if (!page) return artifacts;
  try {
    const shot = path.join(artifactsDir, `error-${id}.png`);
    await page.screenshot(shot);
    artifacts.screenshot = shot;
  } catch {
    /* 页面可能已崩溃 */
  }
  try {
    artifacts.dom = await page.evalFn(() => {
      const pick = (selector, max = 1500) => {
        const el = document.querySelector(selector);
        return el ? el.outerHTML.slice(0, max) : null;
      };
      return {
        url: location.href,
        bodyDataset: { ...document.body.dataset },
        mapState: pick('#map-state'),
        overlay: pick('#overlay', 2000),
        waypointList: pick('#waypoint-list', 2000),
        groupList: pick('#group-list', 1200),
        markerSamples: [...document.querySelectorAll('#overlay .marker')]
          .slice(0, 3)
          .map((el) => el.outerHTML.slice(0, 400)),
      };
    });
  } catch (error) {
    artifacts.dom = { error: String(error?.message ?? error) };
  }
  return artifacts;
}

async function check(id, label, fn) {
  const result = await rep.check(id, label, fn);
  if (result.status === 'fail') {
    result.artifacts = await captureFailure(id);
  }
  return result;
}

async function checkIfReady(id, label, fn) {
  if (!ctx.uiReady) {
    rep.skip(label, '应用未就绪（见 boot.* 失败项）', id);
    return { status: 'skip', id, label };
  }
  return check(id, label, fn);
}

/* ------------------------------------------------------------------ *
 * 页面动作
 * ------------------------------------------------------------------ */

/**
 * 测试基建：全图适配（最小缩放，所有标记可见）。
 * 「整图」按钮的新语义（出生点居中、放大视野）在 view.reset 里用真实点击单独断言；
 * 其余检查只需要「全图可见」的前置状态，直接走 __mapApp.fitToContent
 * （与 centerOnOrigin / applyDimension 同类的基建 API）。
 */
async function resetView() {
  const done = await page.evalFn(() => {
    const api = window.__mapApp;
    if (!api || typeof api.fitToContent !== 'function') return false;
    api.fitToContent({ animate: false });
    return true;
  });
  if (!done) throw new Error('window.__mapApp.fitToContent 不可用，无法整图适配');
  await page.settle(260);
}

/** 真实鼠标点击「整图」按钮（#zoom-fit）—— 用户路径 */
async function clickFitButton() {
  await page.clickSelector('#zoom-fit');
  await page.settle(500);
}

async function ensureSidebarOpen() {
  const state = await page.evalFn(() => {
    const sidebar = document.querySelector('#sidebar');
    const rect = sidebar ? sidebar.getBoundingClientRect() : null;
    return {
      dataset: document.body.dataset.sidebar ?? null,
      left: rect ? rect.left : 0,
      width: rect ? rect.width : 0,
    };
  });
  const isOpen = state.dataset === 'open' || (state.left >= 0 && state.width > 100);
  if (!isOpen) {
    await page.clickSelector('#sidebar-toggle');
    await page.settle(320);
  }
  return isOpen;
}

/**
 * 地图上「不该由地图处理」的元素（与 viewer.js 的 IGNORE_SELECTOR 保持一致）。
 * 滚轮 / 拖拽落在这些元素上时 viewer 会故意忽略，测试必须避开。
 */
const IGNORED_HIT_SELECTOR =
  '.marker, .marker-popup, .zoom-panel, .coord-readout, .scale-bar, .map-state, .modal';

/**
 * 在视口内找一个安全的落点：elementFromPoint 必须真正命中底图元素
 * （#map-image 单张图片 / #map-canvas 瓦片，而不是标记 / 弹窗 / 缩放面板 / 地图状态层）。
 */
async function findSafeMapPoint(
  viewport,
  fractions = [
    [0.5, 0.32],
    [0.35, 0.4],
    [0.65, 0.4],
    [0.3, 0.6],
    [0.7, 0.6],
    [0.5, 0.5],
    [0.2, 0.25],
    [0.8, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ],
) {
  if (!viewport) throw new Error('找不到 #viewport 尺寸，无法选择地图落点');
  return page.evalFn(
    (vp, candidates, ignored) => {
      for (const [fx, fy] of candidates) {
        const x = Math.round(vp.left + vp.width * fx);
        const y = Math.round(vp.top + vp.height * fy);
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        if (el.closest(ignored)) continue;
        if (el.id !== 'map-image' && el.id !== 'map-canvas') continue;
        return { x, y, hit: { tag: el.tagName, id: el.id, cls: String(el.className || '') } };
      }
      return null;
    },
    viewport,
    fractions,
    IGNORED_HIT_SELECTOR,
  );
}

/**
 * 在某个标记附近找一个命中底图的安全落点。
 * 缩放 / 拖拽测试用它作为起点，保证操作后至少有一个标记仍在视口内可校验。
 */
async function findSafePointNearMarker(viewport) {
  const anchor = await page.evalFn(
    (vp) => {
      const margin = 40;
      for (const el of document.querySelectorAll('.marker')) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < vp.left + margin || cx > vp.left + vp.width - margin) continue;
        if (cy < vp.top + margin || cy > vp.top + vp.height - margin) continue;
        return { x: cx, y: cy };
      }
      return null;
    },
    viewport,
  );
  if (!anchor) return null;
  const offsets = [
    [26, 26],
    [-26, 26],
    [26, -26],
    [-26, -26],
    [40, 0],
    [0, 40],
    [-40, 0],
    [0, -40],
    [56, 56],
    [-56, 56],
  ];
  return page.evalFn(
    (vp, base, offs, ignored) => {
      for (const [dx, dy] of offs) {
        const x = Math.round(base.x + dx);
        const y = Math.round(base.y + dy);
        if (x < vp.left + 2 || x > vp.left + vp.width - 2) continue;
        if (y < vp.top + 2 || y > vp.top + vp.height - 2) continue;
        const el = document.elementFromPoint(x, y);
        if (!el || el.closest(ignored)) continue;
        if (el.id !== 'map-image' && el.id !== 'map-canvas') continue;
        return { x, y, hit: { tag: el.tagName, id: el.id, cls: String(el.className || '') } };
      }
      return null;
    },
    viewport,
    anchor,
    offsets,
    IGNORED_HIT_SELECTOR,
  );
}

/** 关闭可能挡住地图的标记详情弹窗（viewer 的 IGNORE_SELECTOR 包含 .marker-popup） */
async function dismissMarkerPopup() {
  const hasPopup = await page.evaluate('Boolean(document.querySelector(".marker-popup"))');
  if (!hasPopup) return false;
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await page.settle(180);
  return true;
}

/** 读取 MapView 的 scale（app.js 暴露的调试接口） */
async function viewScale() {
  return page.evaluate(
    '(window.__mapApp && window.__mapApp.view && typeof window.__mapApp.view.getViewState === "function") ? window.__mapApp.view.getViewState().scale : null',
  );
}

/** 刷新 / 切换后等待应用就绪（维度按钮 + 底图（img 或 canvas）+ 标记都就位） */
async function waitForAppReady(label = '应用就绪') {
  return page.waitFor(
    () => {
      const buttons = document.querySelectorAll('#dimension-switch button, #dimension-switch [role="tab"]');
      const layer = document.querySelector('#map-canvas:not([hidden]), #map-image:not([hidden])');
      const markers = document.querySelectorAll('#overlay .marker');
      if (buttons.length < 3 || !layer || markers.length === 0) return null;
      const isCanvas = layer.tagName === 'CANVAS';
      const width = isCanvas ? Number(layer.dataset.imageWidth || 0) : layer.naturalWidth;
      if (!(width > 0)) return null;
      return { buttons: buttons.length, markers: markers.length, imageWidth: width };
    },
    { timeout: WAIT.long, interval: 120, label },
  );
}

/** 用 #map-image 的显示矩形把 client 坐标换算成图片像素（独立于 MapView 实现） */
function clientToImagePoint(imageInfo, clientX, clientY) {
  const scaleX = imageInfo.rect.width / imageInfo.naturalWidth;
  const scaleY = imageInfo.rect.height / imageInfo.naturalHeight;
  return {
    px: (clientX - imageInfo.rect.left) / scaleX,
    py: (clientY - imageInfo.rect.top) / scaleY,
  };
}

/** 图片像素 → 世界坐标（按 CONTRACT §1 公式独立手算） */
function imagePointToWorld(calibration, naturalWidth, naturalHeight, px, py) {
  const tx = px / naturalWidth;
  const ty = py / naturalHeight;
  const x = calibration.xMin + tx * (calibration.xMax - calibration.xMin);
  const z = calibration.flipZ
    ? calibration.zMax - ty * (calibration.zMax - calibration.zMin)
    : calibration.zMin + ty * (calibration.zMax - calibration.zMin);
  return { x, z };
}

async function readAppCalibration() {
  return page.evaluate(`(() => {
    const cal = window.__mapApp && window.__mapApp.state && window.__mapApp.state.calibration;
    if (!cal) return null;
    return { xMin: cal.xMin, xMax: cal.xMax, zMin: cal.zMin, zMax: cal.zMax, flipZ: !!cal.flipZ };
  })()`);
}

/**
 * 按「底图相对位置」找一个真正命中底图元素（img / canvas）的点并点击。
 * 拾取模式下弹窗应让开（pointer-events:none），命中标记 / 提示条的点会被跳过。
 */
async function clickImageFraction(fractions, { label = '地图落点' } = {}) {
  for (const [fx, fy] of fractions) {
    const point = await page.evalFn(
      (fxv, fyv) => {
        const img = document.querySelector('#map-canvas:not([hidden]), #map-image:not([hidden])');
        if (!img) return null;
        const rect = img.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width * fxv);
        const y = Math.round(rect.top + rect.height * fyv);
        const el = document.elementFromPoint(x, y);
        return {
          x,
          y,
          hit: el ? { tag: el.tagName, id: el.id, cls: String(el.className || '') } : null,
        };
      },
      fx,
      fy,
    );
    if (!point) throw new Error('找不到底图元素，无法在地图上取点');
    if (point.hit?.id !== 'map-image' && point.hit?.id !== 'map-canvas') continue;
    await page.click(point.x, point.y);
    await page.settle(160);
    return point;
  }
  throw new Error(
    `在地图上找不到命中底图的点击位置（${label}，尝试了 ${fractions.length} 个候选；` +
      `可能是遮罩未让开或标记覆盖）`,
  );
}

/** 侧栏当前状态（同时兼容 body[data-sidebar] 与纯几何实现） */
async function sidebarState() {
  return page.evalFn(() => {
    const sidebar = document.querySelector('#sidebar');
    const viewport = document.querySelector('#viewport');
    const backdrop = document.querySelector('#sidebar-backdrop');
    const sr = sidebar ? sidebar.getBoundingClientRect() : null;
    const vr = viewport ? viewport.getBoundingClientRect() : null;
    const backdropVisible = backdrop
      ? !backdrop.hidden &&
        getComputedStyle(backdrop).display !== 'none' &&
        getComputedStyle(backdrop).visibility !== 'hidden'
      : false;
    return {
      bodySidebar: document.body.dataset.sidebar ?? null,
      innerWidth: window.innerWidth,
      sidebar: sr ? { left: sr.left, right: sr.right, width: sr.width } : null,
      viewport: vr
        ? { left: vr.left, right: vr.right, width: vr.width, height: vr.height }
        : null,
      backdropVisible,
    };
  });
}

function isSidebarOpenState(state) {
  return (
    state.bodySidebar === 'open' ||
    Boolean(state.sidebar && state.sidebar.left >= -2 && state.sidebar.width > 100)
  );
}

/** 打开侧栏：窄屏抽屉关闭时点 topbar 的 #sidebar-toggle 是唯一入口 */
async function openSidebarForTest() {
  const before = await sidebarState();
  if (isSidebarOpenState(before)) return before;
  const target = await page.evalFn(() => {
    const toggle = document.querySelector('#sidebar-toggle');
    if (!toggle) return null;
    const rect = toggle.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (!target) throw new Error('侧栏收起时找不到可点击的 #sidebar-toggle');
  await page.click(target.x, target.y);
  await page.settle(400);
  return sidebarState();
}

/** 关闭侧栏：抽屉打开时 topbar 被遮住，优先用抽屉内 #btn-collapse，其次遮罩 */
async function closeSidebarForTest() {
  const before = await sidebarState();
  if (!isSidebarOpenState(before)) return before;
  const used = await page.evalFn(() => {
    const tryClick = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || !el.contains(hit)) return false;
      el.click();
      return true;
    };
    if (tryClick(document.querySelector('#btn-collapse'))) return '#btn-collapse';
    if (tryClick(document.querySelector('#sidebar-backdrop'))) return '#sidebar-backdrop';
    if (tryClick(document.querySelector('#sidebar-toggle'))) return '#sidebar-toggle';
    return null;
  });
  if (!used) {
    throw new Error('侧栏打开时找不到可点击的关闭入口（#btn-collapse / #sidebar-backdrop / #sidebar-toggle）');
  }
  await page.settle(420);
  const after = await sidebarState();
  if (isSidebarOpenState(after)) {
    throw new Error(`点击 ${used} 后侧栏仍未收起（body[data-sidebar]=${after.bodySidebar}）`);
  }
  return after;
}

async function findDimensionButton(dimensionId, dimensionName) {
  return page.evalFn(
    ({ id, name }) => {
      const buttons = [...document.querySelectorAll('#dimension-switch button, #dimension-switch [role="tab"]')];
      const el = buttons.find(
        (button) =>
          button.dataset.dimension === id ||
          button.dataset.dim === id ||
          button.dataset.id === id ||
          (button.textContent || '').includes(name),
      );
      if (!el) {
        return { found: false, labels: buttons.map((button) => (button.textContent || '').trim()) };
      }
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        found: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        text: (el.textContent || '').trim(),
      };
    },
    { id: dimensionId, name: dimensionName },
  );
}

async function switchDimension(dimensionId) {
  const dimension = dimensionById(dimensionId);
  if (!dimension) throw new Error(`config 里没有维度 ${dimensionId}`);
  const target = await findDimensionButton(dimension.id, dimension.name);
  if (!target.found) {
    throw new Error(
      `#dimension-switch 找不到维度按钮「${dimension.name}」（现有：${target.labels.join(' / ') || '无'}）`,
    );
  }
  await page.click(target.x, target.y);
  const expectedMarkers = dimension.waypoints.length;
  // 瓦片维度没有基底图片，底图来源是 manifest；单张图片维度仍然是 image
  const expectedTiles = Boolean(dimension.tiles && dimension.tiles.manifest);
  const expectedFile = expectedTiles ? dimension.tiles.manifest : dimension.image;
  let observed = null;
  try {
    await waitUntil(
      async () => {
        observed = await page.evalFn(DIMENSION_STATE);
        const srcDecoded = observed.imageSrc ? decodeURIComponent(observed.imageSrc) : '';
        // 必须「全部」满足：body 维度已切换、底图来源正确、底图已就绪（naturalWidth>0）、
        // 标记数已按新维度重建。原来用 || 只要 body[data-dimension] 一变就返回，
        // 在真实网络（GitHub Pages）上图片还没下载完就断言 naturalWidth，会出现假失败。
        return (
          observed.bodyDimension === dimension.id &&
          observed.layerKind === (expectedTiles ? 'tiles' : 'image') &&
          srcDecoded.includes(expectedFile) &&
          observed.imageNaturalWidth > 0 &&
          observed.markerCount === expectedMarkers
        );
      },
      {
        timeout: Math.max(WAIT.long, 25_000),
        interval: 120,
        label: `切换到维度 ${dimension.id}（含基底图下载与解码）`,
      },
    );
  } catch (error) {
    throw new Error(
      `${error.message}；当前状态：${JSON.stringify({
        bodyDimension: observed?.bodyDimension,
        src: observed?.imageSrc,
        naturalWidth: observed?.imageNaturalWidth,
        markers: observed?.markerCount,
        expected: { dimension: dimension.id, image: expectedFile, markers: expectedMarkers },
      })}`,
    );
  }
  await page.settle(200);
  observed = await page.evalFn(DIMENSION_STATE);
  return { target, state: observed };
}

async function waitForImageLoaded(label = '底图加载完成') {
  return page.waitFor(
    () => {
      const layer = document.querySelector('#map-canvas:not([hidden]), #map-image:not([hidden])');
      if (!layer) return null;
      const isCanvas = layer.tagName === 'CANVAS';
      const naturalWidth = isCanvas ? Number(layer.dataset.imageWidth || 0) : layer.naturalWidth;
      const naturalHeight = isCanvas ? Number(layer.dataset.imageHeight || 0) : layer.naturalHeight;
      if (!(naturalWidth > 0)) return null;
      return {
        naturalWidth,
        naturalHeight,
        src: isCanvas ? String(layer.dataset.manifest || '') : layer.currentSrc || layer.src,
      };
    },
    { timeout: WAIT.long, interval: 120, label },
  );
}

/** 位置测量：与配置里的世界范围 + 底图实际显示区域对比 */
async function measurePositions(dimension) {
  const info = await page.evalFn(IMAGE_INFO);
  if (!info) throw new Error('找不到底图元素');
  if (!info.naturalWidth || !info.naturalHeight) {
    throw new Error(`底图尚未加载（naturalWidth=${info.naturalWidth}）`);
  }
  if (!(info.rect.width > 0 && info.rect.height > 0)) {
    throw new Error(`底图显示尺寸为 0（width=${info.rect.width}, height=${info.rect.height}）`);
  }
  const stageScale = info.rect.width / info.naturalWidth;
  const scaleY = info.rect.height / info.naturalHeight;
  const aspectError = Math.abs(stageScale / scaleY - 1);

  const markers = await page.evalFn(MARKER_RECTS);
  const byId = new Map(markers.map((marker) => [marker.id, marker]));
  const rows = [];
  const problems = [];

  for (const waypoint of dimension.waypoints) {
    const marker = byId.get(waypoint.id);
    if (!marker) {
      problems.push(`缺少标记 [data-id="${waypoint.id}"]`);
      continue;
    }
    const expected = expectedScreenPoint(dimension, info, waypoint.x, waypoint.z);
    let best = null;
    for (const [anchor, x, y] of anchorCandidates(marker.rect)) {
      const dx = x - expected.sx;
      const dy = y - expected.sy;
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) best = { anchor, distance, dx, dy, x, y };
    }
    const viewport = info.viewport;
    const margin = 4;
    const insideViewport = Boolean(viewport) &&
      expected.sx >= viewport.left + margin &&
      expected.sx <= viewport.left + viewport.width - margin &&
      expected.sy >= viewport.top + margin &&
      expected.sy <= viewport.top + viewport.height - margin;

    rows.push({ id: waypoint.id, expected, rect: marker.rect, visible: marker.visible, insideViewport, best });

    if (marker.visible && insideViewport && best.distance > POSITION_TOLERANCE) {
      problems.push(
        `${waypoint.id} 偏差 ${best.distance.toFixed(2)}px` +
          `（锚点 ${best.anchor}，期望 (${expected.sx.toFixed(1)}, ${expected.sy.toFixed(1)})，` +
          `实际 (${best.x.toFixed(1)}, ${best.y.toFixed(1)}）`,
      );
    }
    if (!marker.visible && insideViewport) {
      problems.push(`${waypoint.id} 应位于视口内 (${expected.sx.toFixed(0)}, ${expected.sy.toFixed(0)}) 却不可见`);
    }
  }

  const checked = rows.filter((row) => row.visible && row.insideViewport);
  return { info, rows, problems, checked, aspectError, stageScale, scaleY };
}

function summarizePositions(result) {
  if (result.checked.length === 0) return '没有位于视口内且可见的标记';
  const worst = result.checked.reduce((max, row) => (row.best.distance > max.best.distance ? row : max));
  return (
    `${result.checked.length} 个标记，最大偏差 ${worst.best.distance.toFixed(2)}px` +
    `（${worst.id}），缩放 ${result.stageScale.toFixed(4)}`
  );
}

function assertPositions(result, { minChecked = 1, phase = '' } = {}) {
  const problems = [...result.problems];
  if (result.aspectError > 0.01) {
    problems.push(`图片显示比例失真：scaleX=${result.stageScale.toFixed(4)} scaleY=${result.scaleY.toFixed(4)}`);
  }
  if (result.checked.length < minChecked) {
    problems.push(`只有 ${result.checked.length} 个标记可校验（期望至少 ${minChecked} 个）`);
  }
  if (problems.length > 0) {
    throw new Error(`${phase ? `${phase}：` : ''}${problems.slice(0, 6).join('；')}`);
  }
}

function compareMarkerDeltas(before, after) {
  const problems = [];
  const beforeMap = new Map(before.checked.map((row) => [row.id, row]));
  let compared = 0;
  for (const row of after.checked) {
    const prev = beforeMap.get(row.id);
    if (!prev) continue;
    compared += 1;
    const actualDx = row.best.x - prev.best.x;
    const actualDy = row.best.y - prev.best.y;
    const expectedDx = row.expected.sx - prev.expected.sx;
    const expectedDy = row.expected.sy - prev.expected.sy;
    const diff = Math.hypot(actualDx - expectedDx, actualDy - expectedDy);
    if (diff > POSITION_TOLERANCE) {
      problems.push(
        `${row.id} 与图片不同步：实际位移 (${actualDx.toFixed(1)}, ${actualDy.toFixed(1)})，` +
          `期望 (${expectedDx.toFixed(1)}, ${expectedDy.toFixed(1)})，差 ${diff.toFixed(2)}px`,
      );
    }
  }
  if (problems.length > 0) throw new Error(problems.slice(0, 5).join('；'));
  return compared;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function cleanArtifacts() {
  await ensureDir(artifactsDir);
  const entries = await fsp.readdir(artifactsDir).catch(() => []);
  for (const entry of entries) {
    if (/^(error-.*\.png|ok-.*\.png|report\.json)$/.test(entry)) {
      await fsp.rm(path.join(artifactsDir, entry), { force: true }).catch(() => {});
    }
  }
}

/**
 * 同一时间只允许一个 smoke 运行：两个实例会共用 tests/artifacts/（截图 / 报告互相清理），
 * 还会各起一份浏览器，结果容易互相污染。用 pid 锁显式拒绝并给出原因。
 */
async function acquireRunLock() {
  await ensureDir(artifactsDir);
  const existing = await fsp.readFile(runLockPath, 'utf8').catch(() => null);
  if (existing) {
    const pid = Number(String(existing).trim().split(/\s+/)[0]);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw new Error(
        `另一个 smoke 正在运行（pid ${pid}）：两个实例会共用 tests/artifacts/ 且各起一份浏览器，` +
          `请等它结束后再跑（锁文件：${runLockPath}）`,
      );
    }
    await fsp.rm(runLockPath, { force: true }).catch(() => {});
  }
  await fsp.writeFile(runLockPath, `${process.pid} ${new Date().toISOString()}\n`, 'utf8');
}

async function releaseRunLock() {
  await fsp.rm(runLockPath, { force: true }).catch(() => {});
}

async function writeReport(extra = {}) {
  if (!runLockHeld) {
    console.log('  ! 未获取运行锁（另一个 smoke 正在运行），跳过写报告，避免覆盖对方的 results');
    return;
  }
  const data = rep.toJSON();
  Object.assign(data, {
    url: baseUrl,
    viewport: VIEWPORT,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      browser: browser?.browser ?? null,
      browserPath: browser?.executablePath ?? null,
      artifactsDir,
    },
    failures: rep.failed.map((result) => ({
      id: result.id,
      label: result.label,
      error: result.error,
      artifacts: result.artifacts ?? null,
    })),
    ...extra,
  });
  try {
    await ensureDir(artifactsDir);
    reportPath = path.join(artifactsDir, 'report.json');
    await fsp.writeFile(reportPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(`  ! 写报告失败：${error.message}`);
  }
}

async function teardown() {
  try {
    diag?.dispose();
  } catch {
    /* ignore */
  }
  if (browser) {
    try {
      // 先 Browser.close 优雅退出，再兜底杀进程树并清理临时 profile
      await browser.close({ conn });
    } catch (error) {
      console.error(`  ! 关闭浏览器失败：${error.message}`);
    }
  }
  try {
    conn?.close();
  } catch {
    /* ignore */
  }
  if (server) {
    try {
      await server.close();
    } catch (error) {
      console.error(`  ! 关闭静态服务器失败：${error.message}`);
    }
  }
  await releaseRunLock();
}

async function main() {
  await acquireRunLock();
  runLockHeld = true;
  await cleanArtifacts();

  const configPath = path.join(projectRoot, 'config.json');
  try {
    ctx.config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    ctx.currentDimensionId = ctx.config.defaultDimension;
  } catch (error) {
    throw new Error(`无法读取 config.json：${error.message}`);
  }

  console.log('SteveServerMap 端到端验收（contract §9）');
  console.log(`  项目目录：${projectRoot}`);
  console.log(`  Node：${process.version}   视口：${VIEWPORT.width}×${VIEWPORT.height}`);
  console.log('');

  if (!args.url) {
    server = await startStaticServer({ root: projectRoot });
    baseUrl = server.url;
  } else {
    baseUrl = String(args.url);
  }
  console.log(`  页面地址：${baseUrl}`);

  browser = await launchBrowser({
    executablePath: args.browser ? String(args.browser) : undefined,
    headless: !args.headed,
    keepProfile: Boolean(args.keep),
    verbose: Boolean(args.debug),
  });
  console.log(`  浏览器：${browser.browser ?? 'unknown'}（调试端口 ${browser.port}）`);
  console.log('');

  conn = await CDP.connect(browser.wsUrl);
  browser.attach?.(conn);
  page = await Page.open(conn);
  await page.addInitScript(INIT_SCRIPT);
  diag = createDiagnostics(page, { ignore: isExpectedTileMiss });

  await page.setViewport({ ...VIEWPORT });
  await page.navigate(baseUrl, { timeout: WAIT.long });

  const bootErrorsAtStart = 0;

  /* ---------------- 1. 页面加载 ---------------- */
  await check('boot.navigate', '页面导航完成且 URL 正确', async () => {
    const url = await page.url();
    if (!url.includes('index.html') && url.replace(/\/$/, '') !== baseUrl.replace(/\/index\.html$/, '').replace(/\/$/, '')) {
      throw new Error(`当前 URL 不符：${url}`);
    }
    return truncate(url, 120);
  });

  await check('boot.ui', '应用脚本执行：#dimension-switch 渲染出 3 个维度按钮', async () => {
    const deadline = Date.now() + WAIT.normal;
    let state = await page.evalFn(DIMENSION_STATE);
    while (Date.now() < deadline && state.buttons.length < 3) {
      // 入口模块 404 / 语法错误时立即失败，不再白等
      const errors = flattenErrors(await errorSnapshot());
      const assetError = errors.find((line) => /assets\/(js|css)\//.test(line));
      if (assetError) {
        throw new Error(`应用入口资源加载失败（页面无法启动）：${assetError}`);
      }
      await sleep(150);
      state = await page.evalFn(DIMENSION_STATE);
    }
    if (state.buttons.length < 3) {
      const tail = flattenErrors(await errorSnapshot()).slice(0, 4);
      throw new Error(
        `等待 ${WAIT.normal} ms 后 #dimension-switch 只有 ${state.buttons.length} 个按钮` +
          `（现有：${state.buttons.map((button) => button.text).join(' / ') || '无'}）` +
          (tail.length ? `；页面错误：${tail.join('；')}` : ''),
      );
    }
    return `${state.buttons.map((button) => button.text).join(' / ')}；初始标记 ${state.markerCount} 个`;
  });

  await check('boot.lazy-skin', '皮肤 3D 库首屏不下载（未打开面板前无 vendor 请求、无全局 skinview3d）', async () => {
    const state = await page.evalFn(() => ({
      global: typeof window.skinview3d !== 'undefined',
      scripts: [...document.querySelectorAll('script[src]')]
        .map((node) => node.src)
        .filter((src) => src.includes('skinview3d.bundle.js')).length,
      resources: performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.includes('skinview3d.bundle.js')).length,
    }));
    if (state.global || state.scripts || state.resources) {
      throw new Error(
        `首屏不应加载皮肤库：global=${state.global} script=${state.scripts} resource=${state.resources}`,
      );
    }
    return '无 vendor 请求、无全局 skinview3d';
  });

  await check('boot.image', '底图加载完成（图片 complete=true 且 naturalWidth>0；瓦片维度读 manifest 逻辑尺寸）', async () => {
    if (rep.failed.some((result) => result.id === 'boot.ui')) {
      throw new Error('底图未加载：应用脚本执行失败（见 boot.ui 失败项）');
    }
    try {
      const info = await waitForImageLoaded();
      return `${info.naturalWidth}×${info.naturalHeight} ${truncate(decodeURIComponent(info.src || ''), 80)}`;
    } catch (error) {
      const state = await page
        .evalFn(() => {
          const img = document.querySelector('#map-image');
          const canvas = document.querySelector('#map-canvas');
          const layer = canvas && !canvas.hidden ? canvas : img;
          if (!layer) return { found: false };
          const isCanvas = layer.tagName === 'CANVAS';
          return {
            found: true,
            kind: isCanvas ? 'tiles' : 'image',
            src: isCanvas ? String(layer.dataset.manifest || '') : layer.currentSrc || layer.src || '',
            complete: isCanvas ? Number(layer.dataset.imageWidth || 0) > 0 : layer.complete,
            naturalWidth: isCanvas ? Number(layer.dataset.imageWidth || 0) : layer.naturalWidth,
            naturalHeight: isCanvas ? Number(layer.dataset.imageHeight || 0) : layer.naturalHeight,
            display: getComputedStyle(layer).display,
            visibility: getComputedStyle(layer).visibility,
            baseMode: document.body.dataset.base ?? null,
          };
        })
        .catch(() => null);
      throw new Error(
        `${error.message}；底图实际状态：${JSON.stringify(state)}（期望已就绪且尺寸 > 0）`,
      );
    }
  });

  await check('boot.console', '页面加载阶段无 console error / 未捕获异常 / 未处理 Promise 拒绝', () =>
    expectNoErrorsSince(bootErrorsAtStart, '页面加载'),
  );

  ctx.uiReady = rep.failed.length === 0;

  /* ---------------- 2. 维度切换 ---------------- */
  await checkIfReady('ui.dimensions', '三个维度按钮名称正确，默认维度为 config.defaultDimension', async () => {
    const state = await page.evalFn(DIMENSION_STATE);
    const names = ['主世界', '下界', '末地'];
    const labels = state.buttons.map((button) => button.text);
    for (const name of names) {
      if (!labels.some((label) => label.includes(name))) {
        throw new Error(`维度按钮缺少「${name}」（现有：${labels.join(' / ')}）`);
      }
    }
    const bodyDimension = state.bodyDimension || ctx.config.defaultDimension;
    if (bodyDimension !== ctx.config.defaultDimension) {
      throw new Error(`body[data-dimension]=${bodyDimension}，期望 ${ctx.config.defaultDimension}`);
    }
    ctx.currentDimensionId = bodyDimension;
    return labels.join(' / ');
  });

  await checkIfReady('dim.switch', '依次切换「下界」「末地」并切回主世界（底图与标记数量随之变化）', async () => {
    const details = [];
    for (const dimensionId of ['nether', 'the_end', 'overworld']) {
      const dimension = dimensionById(dimensionId);
      const { state } = await switchDimension(dimensionId);
      const srcDecoded = state.imageSrc ? decodeURIComponent(state.imageSrc) : '';
      const expectedSource = dimension.tiles ? dimension.tiles.manifest : dimension.image;
      if (!srcDecoded.includes(expectedSource)) {
        throw new Error(
          `切到 ${dimension.name} 后底图来源是 ${truncate(srcDecoded, 120)}，期望包含 ${expectedSource}`,
        );
      }
      if (state.bodyDimension && state.bodyDimension !== dimensionId) {
        throw new Error(`切到 ${dimension.name} 后 body[data-dimension]=${state.bodyDimension}`);
      }
      if (!(state.imageNaturalWidth > 0)) {
        throw new Error(`切到 ${dimension.name} 后底图未就绪（naturalWidth=0）`);
      }
      if (state.markerCount !== dimension.waypoints.length) {
        throw new Error(
          `切到 ${dimension.name} 后标记数 ${state.markerCount}，config 里是 ${dimension.waypoints.length}`,
        );
      }
      ctx.currentDimensionId = dimensionId;
      details.push(`${dimension.name}:${state.markerCount} 点/${state.layerKind === 'tiles' ? '瓦片' : '图片'}`);
    }
    ctx.currentDimensionId = 'overworld';
    return details.join(' → ');
  });

  /* ---------------- 3. 路径点数量 ---------------- */
  await checkIfReady('counts.markers', '主世界标记数 / 侧栏列表项数 = config 路径点数', async () => {
    await ensureSidebarOpen();
    const dimension = dimensionById('overworld');
    const stats = await page.evalFn(MARKER_STATS, null);
    if (!stats) throw new Error('找不到 #overlay');
    if (stats.total !== dimension.waypoints.length) {
      throw new Error(`#overlay .marker 数量 ${stats.total}，config 主世界路径点 ${dimension.waypoints.length}`);
    }
    const expectedIds = new Set(dimension.waypoints.map((waypoint) => waypoint.id));
    const missing = [...expectedIds].filter((id) => !stats.ids.includes(id));
    const extra = stats.ids.filter((id) => id && !expectedIds.has(id));
    if (missing.length || extra.length) {
      throw new Error(`标记 data-id 与 config 不一致：缺少 ${missing.join(', ') || '无'}；多余 ${extra.join(', ') || '无'}`);
    }

    const list = await page.evalFn(LIST_STATS);
    if (!list) throw new Error('找不到 #waypoint-list');
    if (list.count !== dimension.waypoints.length) {
      throw new Error(
        `#waypoint-list 列表项 ${list.count}，config 主世界路径点 ${dimension.waypoints.length}` +
          `（计数策略 ${list.strategy}；样例：${list.texts.join(' / ')}）`,
      );
    }
    if (list.emptyHidden === false) throw new Error('有数据时 #waypoint-empty 仍然可见');

    const detail = `${stats.total} 个标记 / ${list.count} 个列表项（${list.strategy}）`;
    if (list.countBadge && !list.countBadge.includes(String(dimension.waypoints.length))) {
      rep.warn(`#waypoint-count 徽标为「${list.countBadge}」，与路径点数 ${dimension.waypoints.length} 不一致`);
    }
    return detail;
  });

  /* ---------------- 4. 位置正确性（初始 / 缩放 / 拖拽） ---------------- */
  await checkIfReady('pos.initial', '标记位置与实际投影换算结果一致（瓦片=manifest / 单图=calibration，误差 < 1.5px）', async () => {
    await resetView();
    const dimension = dimensionById('overworld');
    const result = await measurePositions(dimension);
    assertPositions(result, { minChecked: 3, phase: '整图视图' });
    ctx.lastPositions = result;
    return summarizePositions(result);
  });

  await checkIfReady('pos.zoom', '滚轮缩放后标记与图片同步（世界坐标相对位置不变，误差 < 1.5px）', async () => {
    const dimension = dimensionById('overworld');
    await dismissMarkerPopup();
    const before = ctx.lastPositions ?? (await measurePositions(dimension));
    const imageBefore = before.info.rect;
    const viewport = before.info.viewport;
    if (!viewport) throw new Error('找不到 #viewport');
    // 落点必须真正命中底图元素：标记 / 详情弹窗 / 缩放面板上的滚轮会被 viewer 有意忽略
    // 优先在标记附近缩放：避免缩放后整屏都是未探索海域、没有任何标记可校验。
    const point = (await findSafePointNearMarker(viewport)) || (await findSafeMapPoint(viewport));
    if (!point) {
      throw new Error(
        '视口内找不到命中底图的落点（被标记 / 弹窗 / 浮层完全覆盖）；' +
          `当前命中：${await page.evaluate(
            '(() => { const vp = document.getElementById("viewport").getBoundingClientRect(); const el = document.elementFromPoint(vp.left + vp.width / 2, vp.top + vp.height / 2); return el ? el.tagName + "#" + el.id + "." + String(el.className) : "null"; })()',
          )}`,
      );
    }
    const scaleBefore = await viewScale();

    for (let index = 0; index < 4; index += 1) {
      await page.wheel({ x: point.x, y: point.y, deltaY: -240 });
    }
    await page.settle(260);
    const scaleAfter = await viewScale();
    const widthAfter = (await page.evalFn(IMAGE_INFO))?.rect?.width ?? 0;
    const scaleRatio = scaleBefore && scaleAfter ? scaleAfter / scaleBefore : null;
    const widthRatio = imageBefore.width > 0 ? widthAfter / imageBefore.width : null;

    const zoomProblems = [];
    if (typeof scaleRatio === 'number' && scaleRatio < 1.15) {
      zoomProblems.push(`view.scale ${scaleBefore} → ${scaleAfter}（×${scaleRatio.toFixed(2)}，期望 ≥ ×1.15）`);
    }
    if (typeof widthRatio === 'number' && widthRatio < 1.15) {
      zoomProblems.push(`图片宽度 ${imageBefore.width.toFixed(1)} → ${widthAfter.toFixed(1)}px（×${widthRatio.toFixed(2)}，期望 ≥ ×1.15）`);
    }
    if (zoomProblems.length > 0) {
      throw new Error(
        `鼠标滚轮未能缩放地图（落点 ${point.x},${point.y} 命中 ${JSON.stringify(point.hit)}）：` +
          `${zoomProblems.join('；')}；实际值 vs 期望值见上`,
      );
    }
    if (scaleRatio === null) {
      rep.warn('window.__mapApp.view.getViewState() 不可用，缩放仅通过图片矩形宽度断言');
    }

    const after = await measurePositions(dimension);
    assertPositions(after, { minChecked: 1, phase: '缩放后' });
    const compared = compareMarkerDeltas(before, after);
    ctx.lastPositions = after;
    const scaleText = scaleRatio === null ? `图片 ×${widthRatio.toFixed(2)}` : `scale ${scaleBefore} → ${scaleAfter}`;
    return `${summarizePositions(after)}；${compared} 个标记位移与图片同步；${scaleText}`;
  });

  await checkIfReady('pos.drag', '拖拽平移后标记与图片同步（世界坐标相对位置不变，误差 < 1.5px）', async () => {
    const dimension = dimensionById('overworld');
    const before = ctx.lastPositions ?? (await measurePositions(dimension));
    const viewport = before.info.viewport;
    if (!viewport) throw new Error('找不到 #viewport');
    const start =
      (await findSafePointNearMarker(viewport)) ||
      (await findSafeMapPoint(viewport, [
        [0.2, 0.25],
        [0.25, 0.3],
        [0.3, 0.35],
        [0.5, 0.3],
        [0.35, 0.5],
        [0.5, 0.5],
      ]));
    if (!start) throw new Error('视口内找不到可拖拽的地图落点（全被标记/浮层覆盖）');
    const end = { x: start.x + 160, y: start.y + 110 };
    await page.drag({ from: start, to: end, steps: 12 });
    await page.settle(260);

    const after = await measurePositions(dimension);
    const moved = Math.hypot(
      after.info.rect.left - before.info.rect.left,
      after.info.rect.top - before.info.rect.top,
    );
    if (moved < 10) {
      throw new Error(
        `拖拽未生效：图片位移仅 ${moved.toFixed(1)}px（起点 ${JSON.stringify(start.hit)}）`,
      );
    }
    assertPositions(after, { minChecked: 1, phase: '拖拽后' });
    const compared = compareMarkerDeltas(before, after);
    ctx.lastPositions = after;
    return `${summarizePositions(after)}；图片位移 ${moved.toFixed(0)}px，${compared} 个标记同步`;
  });

  await checkIfReady('pos.drag-marker', '标记上起手拖拽 = 平移地图且不选中；原地松手 = 选中并打开详情卡', async () => {
    const dimension = dimensionById('overworld');
    const info = await page.evalFn(IMAGE_INFO);
    const viewport = info?.viewport;
    if (!viewport) throw new Error('找不到 #viewport 尺寸');

    const pickMarker = () =>
      page.evalFn(
        (vp) => {
          const margin = 60;
          for (const el of document.querySelectorAll('#overlay .marker')) {
            if (!el.dataset.id) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            if (cx < vp.left + margin || cx > vp.left + vp.width - margin) continue;
            if (cy < vp.top + margin || cy > vp.top + vp.height - margin) continue;
            const hit = document.elementFromPoint(cx, cy);
            const top = hit ? hit.closest('.marker') : null;
            if (!top || !top.dataset.id) continue;
            return { id: String(top.dataset.id), x: cx, y: cy, hit: `${hit.tagName}.${hit.className}` };
          }
          return null;
        },
        viewport,
      );

    // 清掉此前测试可能残留的选中态（叠堆轮换依赖 selectedId，残留会影响断言）
    await page.evalFn(() => {
      window.__mapApp.markers.setSelected(null);
      window.__mapApp.state.activeWaypointId = null;
    });

    let marker = await pickMarker();
    if (!marker) throw new Error('视口内找不到可操作的路径点标记');

    // 路径 1：原地按下松开（真实鼠标、不移动）→ 选中 + 详情卡
    await page.click(marker.x, marker.y);
    await page.settle(420);
    const clicked = await page.evalFn(() => {
      const popup = document.querySelector('.marker-popup');
      return {
        active: window.__mapApp.state.activeWaypointId ?? null,
        popup: popup ? !popup.hidden : false,
      };
    });
    if (String(clicked.active) !== marker.id) {
      throw new Error(`点标记「${marker.id}」未选中：active=${JSON.stringify(clicked.active)}`);
    }
    if (!clicked.popup) throw new Error(`点标记「${marker.id}」未打开详情卡`);

    // 路径 1b：按下后微动 2px（未越 4px 阈值）松手 → 仍算点击选中
    await page.evalFn(() => {
      window.__mapApp.markers.setSelected(null);
      window.__mapApp.state.activeWaypointId = null;
    });
    const micro = { x: marker.x, y: marker.y };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: micro.x, y: micro.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: micro.x, y: micro.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: micro.x + 2, y: micro.y + 1, button: 'left', buttons: 1, pointerType: 'mouse' });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: micro.x + 2, y: micro.y + 1, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await page.settle(420);
    const microClick = await page.evalFn(() => {
      const popup = document.querySelector('.marker-popup');
      return {
        active: window.__mapApp.state.activeWaypointId ?? null,
        popup: popup ? !popup.hidden : false,
      };
    });
    if (String(microClick.active) !== marker.id || !microClick.popup) {
      throw new Error(`按下后微动 2px 松手应仍算点击选中「${marker.id}」：${JSON.stringify(microClick)}`);
    }

    // 收起详情卡并清空选中（setSelected(null) 不回写 app 状态，需一并清）
    await page.evalFn(() => {
      window.__mapApp.markers.setSelected(null);
      window.__mapApp.state.activeWaypointId = null;
    });
    await page.settle(160);

    // 路径 2：按住标记拖拽 +120,+80 → 地图平移，且不选中
    marker = await pickMarker();
    if (!marker) throw new Error('收起详情卡后找不到可拖拽的路径点标记');
    const before = await measurePositions(dimension);
    await page.drag({
      from: { x: marker.x, y: marker.y },
      to: { x: marker.x + 120, y: marker.y + 80 },
      steps: 12,
    });
    await page.settle(260);
    const after = await measurePositions(dimension);
    const movedPx = Math.hypot(
      after.info.rect.left - before.info.rect.left,
      after.info.rect.top - before.info.rect.top,
    );
    if (movedPx < 10) {
      throw new Error(
        `标记「${marker.id}」上起手拖拽未平移地图：图片位移 ${movedPx.toFixed(1)}px（起点命中 ${marker.hit}）`,
      );
    }
    const dragged = await page.evalFn(() => {
      const popup = document.querySelector('.marker-popup');
      return {
        active: window.__mapApp.state.activeWaypointId ?? null,
        popup: popup ? !popup.hidden : false,
      };
    });
    if (dragged.active != null || dragged.popup) {
      throw new Error(`拖拽松手后不应选中标记/打开详情卡：${JSON.stringify(dragged)}`);
    }
    assertPositions(after, { minChecked: 1, phase: '标记拖拽后' });
    return `原地松开/微动 2px 均选中「${marker.id}」；标记上拖拽平移 ${movedPx.toFixed(0)}px 未选中`;
  });

  await checkIfReady('view.reset', '「整图」按钮以出生点居中，缩放大于全图适配（不显示整张地图）', async () => {
    const dimension = dimensionById('overworld');
    const spawn =
      dimension.waypoints.find((waypoint) => waypoint.icon === 'spawn') ||
      dimension.waypoints.find((waypoint) => /^(spawn|wp)$/i.test(String(waypoint.id || ''))) ||
      { x: 0, z: 0 };
    const sx = spawn && Number.isFinite(spawn.x) ? spawn.x : 0;
    const sz = spawn && Number.isFinite(spawn.z) ? spawn.z : 0;
    await clickFitButton();
    const info = await page.evalFn(IMAGE_INFO);
    if (!info) throw new Error('找不到底图元素');
    if (!(info.rect.width > 0)) throw new Error('点击「整图」后图片尺寸为 0');
    const result = await page.evalFn((x, z) => {
      const api = window.__mapApp;
      const vs = api.view.getViewState();
      const proj = api.projection;
      if (!vs || !proj || !vs.viewWidth) return null;
      const center = {
        x: (vs.viewWidth / 2 - vs.tx) / vs.scale,
        y: (vs.viewHeight / 2 - vs.ty) / vs.scale,
      };
      const pt = proj.worldToImage(x, z);
      const fitScale = vs.viewWidth / vs.imageWidth;
      return {
        scale: vs.scale,
        fitScale,
        dist:
          pt && Number.isFinite(pt.px)
            ? Math.hypot(center.x - pt.px, center.y - pt.py)
            : null,
        imageWidth: vs.imageWidth,
        imageHeight: vs.imageHeight,
      };
    }, sx, sz);
    if (!result) throw new Error('getViewState / projection 不可用，无法校验「整图」视图');
    const problems = [];
    if (!(result.dist != null && result.dist <= 3)) {
      problems.push(`视图中心距出生点 ${result.dist != null ? result.dist.toFixed(1) : '?'} 图片像素（期望 ≤ 3）`);
    }
    if (!(result.scale > result.fitScale * 1.2)) {
      problems.push(
        `缩放 ${result.scale.toFixed(4)}，全图适配 ${result.fitScale.toFixed(4)}（期望 ≥ ×1.2，不要真正显示全部地图）`,
      );
    }
    if (problems.length) throw new Error(problems.join('；'));
    return `中心距出生点 ${result.dist.toFixed(1)}px · 缩放 ×${(result.scale / result.fitScale).toFixed(1)} 全图适配`;
  });

  /* ---------------- 4a. 瓦片底图（manifest 驱动 + 层级随缩放切换） ---------------- */
  await checkIfReady('tiles.render', '瓦片底图渲染：主世界用 <canvas> 出图，世界范围来自 manifest', async () => {
    await page.evalFn(() => window.__mapApp.applyDimension('overworld'));
    await page.settle(320);
    await resetView();

    const info = await page.evalFn(() => {
      const canvas = document.querySelector('#map-canvas');
      const img = document.querySelector('#map-image');
      const tiles = window.__mapApp.tiles ? window.__mapApp.tiles() : null;
      if (!canvas || !tiles) return { ok: false, reason: '找不到 #map-canvas 或 TileLayer（该维度没走瓦片？）' };
      const ctx = canvas.getContext('2d');
      // 位图 = 1.5×视口×dpr（恒外扩窗口），扫全图统计不透明像素；「画出来了」用绝对下限判定：
      // 每张已绘制的瓦片至少贡献一点内容（整图视图下瓦片缩得很小，128 像素/张是宽松下界）。
      let opaque = 0;
      let sampled = 0;
      try {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        sampled = canvas.width * canvas.height;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 8) opaque += 1;
        }
      } catch (error) {
        return { ok: false, reason: `读取 canvas 像素失败：${error.message}` };
      }
      const proj = window.__mapApp.projection;
      return {
        ok: true,
        canvasVisible: !canvas.hidden,
        imgHidden: Boolean(img && img.hidden),
        baseMode: document.body.dataset.base ?? null,
        logicalWidth: Number(canvas.dataset.imageWidth || 0),
        logicalHeight: Number(canvas.dataset.imageHeight || 0),
        manifest: canvas.dataset.manifest || '',
        cssWidth: canvas.getBoundingClientRect().width,
        stageWidth: document.querySelector('#stage').style.width,
        opaque,
        sampled,
        projection: proj
          ? {
              xMin: proj.xMin,
              xMax: proj.xMax,
              zMin: proj.zMin,
              zMax: proj.zMax,
              imageWidth: proj.imageWidth,
              imageHeight: proj.imageHeight,
            }
          : null,
        stats: tiles,
      };
    });
    if (!info || !info.ok) throw new Error(info?.reason || '读取瓦片底图状态失败');

    const tileset = await page.evalFn(() =>
      window.__mapApp.tileset ? window.__mapApp.tileset.toJSON() : null,
    );
    if (!tileset) throw new Error('window.__mapApp.tileset 为空（主世界应使用瓦片底图）');

    const problems = [];
    if (!info.canvasVisible || !info.imgHidden) {
      problems.push(`底图切换不对：canvas.hidden=${!info.canvasVisible} img.hidden=${!info.imgHidden}`);
    }
    if (info.baseMode !== 'tiles') problems.push(`body[data-base]=${info.baseMode}，期望 tiles`);
    if (!info.manifest.includes(tileset.manifestUrl)) {
      problems.push(`canvas 的 manifest 标记是「${info.manifest}」，期望 ${tileset.manifestUrl}`);
    }
    if (info.logicalWidth !== tileset.imageWidth || info.logicalHeight !== tileset.imageHeight) {
      problems.push(
        `底图逻辑尺寸 ${info.logicalWidth}×${info.logicalHeight}，manifest 世界跨度是 ` +
          `${tileset.imageWidth}×${tileset.imageHeight}`,
      );
    }
    const p = info.projection;
    const b = tileset.bounds;
    if (!p) {
      problems.push('没有投影');
    } else if (
      Math.abs(p.xMin - b.xMin) > 1e-6 || Math.abs(p.xMax - b.xMax) > 1e-6 ||
      Math.abs(p.zMin - b.zMin) > 1e-6 || Math.abs(p.zMax - b.zMax) > 1e-6
    ) {
      problems.push(
        `投影世界范围 X[${p.xMin}, ${p.xMax}] Z[${p.zMin}, ${p.zMax}] 与 manifest ` +
          `X[${b.xMin}, ${b.xMax}] Z[${b.zMin}, ${b.zMax}] 不一致`,
      );
    }
    const minOpaque = 128 * (info.stats.drawn || 1);
    if (!(info.opaque >= minOpaque)) {
      problems.push(
        `画布只有 ${info.opaque} 个不透明像素（绘制了 ${info.stats.drawn} 张瓦片，期望 ≥ ${minOpaque}），瓦片没画出来`,
      );
    }
    if (!(info.stats.requests > 0)) problems.push('一张瓦片都没请求');
    if (!(info.stats.drawn > 0)) problems.push('drawImage 次数为 0');
    if (!(info.stats.cache <= info.stats.maxTiles)) {
      problems.push(`缓存 ${info.stats.cache} 张，超过上限 ${info.stats.maxTiles}`);
    }
    if (problems.length) throw new Error(problems.slice(0, 5).join('；'));

    return (
      `画布 ${info.stats.canvasWidth}×${info.stats.canvasHeight} 中 ${info.opaque}/${info.sampled} 像素不透明；` +
      `世界范围 X[${p.xMin}, ${p.xMax}] Z[${p.zMin}, ${p.zMax}]；` +
      `层级 ${info.stats.level}，已请求 ${info.stats.requests} 张（缺 ${info.stats.missing}），` +
      `缓存 ${info.stats.cache}/${info.stats.maxTiles}`
    );
  });

  await checkIfReady('tiles.levels', '瓦片层级随缩放切换（放大更细 / 缩小更粗，只取视口内瓦片）', async () => {
    const tileset = await page.evalFn(() =>
      window.__mapApp.tileset ? window.__mapApp.tileset.toJSON() : null,
    );
    if (!tileset) throw new Error('当前维度不是瓦片底图');

    const sample = () =>
      page.evalFn(() => {
        const tiles = window.__mapApp.tiles();
        const vs = window.__mapApp.view.getViewState();
        return {
          scale: vs.scale,
          level: tiles.level,
          canvasWidth: tiles.canvasWidth,
          viewWidth: vs.viewWidth,
          dpr: window.devicePixelRatio || 1,
          requests: tiles.requests,
          drawn: tiles.drawn,
          visibleTiles: tiles.visibleTiles,
        };
      });

    const expectedLevel = (scale) => {
      let best = tileset.levels[0];
      let bestScore = Infinity;
      for (const entry of tileset.levels) {
        const score = Math.abs(Math.log2(entry.blocksPerPixel * scale));
        if (score < bestScore - 1e-9) {
          best = entry;
          bestScore = score;
        }
      }
      return best.level;
    };

    const centerOnOrigin = (scale) =>
      page.evalFn((value) => {
        const proj = window.__mapApp.projection;
        const pt = proj.worldToImage(0, 0);
        window.__mapApp.view.centerOnImagePoint(pt.px, pt.py, { scale: value, animate: false });
      }, scale);

    // ① 整图（最小缩放）→ 最粗的层级
    await resetView();
    await page.settle(420);
    const far = await sample();

    // ② 放大到 1 方块 = 1 屏幕像素 → 最细层级（level 0）
    await centerOnOrigin(1);
    await page.settle(900);
    const near = await sample();

    // ③ 缩回 4 方块 = 1 屏幕像素 → 中间层级
    await centerOnOrigin(0.25);
    await page.settle(700);
    const mid = await sample();

    await resetView();
    await page.settle(400);

    const problems = [];
    if (near.level !== expectedLevel(near.scale)) {
      problems.push(`scale=${near.scale.toFixed(3)} 选了层级 ${near.level}，期望 ${expectedLevel(near.scale)}`);
    }
    if (mid.level !== expectedLevel(mid.scale)) {
      problems.push(`scale=${mid.scale.toFixed(3)} 选了层级 ${mid.level}，期望 ${expectedLevel(mid.scale)}`);
    }
    if (!(near.level < mid.level && mid.level < far.level)) {
      problems.push(
        `层级没有随缩放单调变化：放大 ${near.level} / 中间 ${mid.level} / 整图 ${far.level}`,
      );
    }
    // 恒外扩窗口：位图 = 1.5×视口 × dpr，与层级无关（三档缩放应当一样大）
    if (!(near.canvasWidth === far.canvasWidth && far.canvasWidth === mid.canvasWidth)) {
      problems.push(
        `恒外扩窗口下位图尺寸不应随层级变化：放大 ${near.canvasWidth} / 中间 ${mid.canvasWidth} / 整图 ${far.canvasWidth}`,
      );
    }
    const expectedBacking = Math.ceil(far.viewWidth * far.dpr * 1.5);
    if (Math.abs(far.canvasWidth - expectedBacking) > 1) {
      problems.push(
        `位图宽度 ${far.canvasWidth} 与 1.5×视口宽度 ×dpr 不符（视口 ${far.viewWidth}px、dpr ${far.dpr}，期望 ≈${expectedBacking}）`,
      );
    }
    const totalTiles = tileset.levels[0].cols * tileset.levels[0].rows;
    // 整图视图应当正好覆盖最粗层级的全部瓦片；放大到 1:1 时只应覆盖视口那一小块
    if (far.visibleTiles > 12) {
      problems.push(`整图视图申报了 ${far.visibleTiles} 张可见瓦片，超过最粗层级的 6 张`);
    }
    if (!(near.visibleTiles > 0 && near.visibleTiles < totalTiles)) {
      problems.push(
        `放大到 1:1 时可见瓦片 ${near.visibleTiles} 张，期望 0 < n < ${totalTiles}（视口裁剪）`,
      );
    }
    if (!(near.drawn > 0 && far.drawn > 0)) {
      problems.push(`有视图没画出瓦片（整图 drawn=${far.drawn}，放大 drawn=${near.drawn}）`);
    }
    if (problems.length) throw new Error(problems.slice(0, 5).join('；'));

    return (
      `整图 level ${far.level}（位图 ${far.canvasWidth}px / ${far.visibleTiles} 张）→ 放大 level ${near.level}` +
      `（${near.visibleTiles} 张，全层 ${totalTiles} 张）` +
      `→ 缩回 level ${mid.level}（位图仍 ${mid.canvasWidth}px）`
    );
  });

  /* ---------------- 4b. 配置驱动 + 画幅变化后重新校准 ---------------- */
  await checkIfReady('data.config', '侧栏列表按分组分区渲染，组内顺序与 config 一致（名称、数量、归属一致）', async () => {
    await ensureSidebarOpen();
    await resetView();
    const dimension = dimensionById('overworld');
    const items = await page.evalFn(LIST_ITEMS);
    if (!items) throw new Error('找不到 #waypoint-list');
    const expectedIds = dimension.waypoints.map((waypoint) => waypoint.id);
    const actualIds = items.map((item) => item.id);
    if (items.length !== expectedIds.length) {
      throw new Error(
        `列表项 ${items.length} 个，config 路径点 ${expectedIds.length} 个（实际：${actualIds.join(', ')}）`,
      );
    }
    for (const waypoint of dimension.waypoints) {
      const item = items.find((entry) => entry.id === waypoint.id);
      if (!item) {
        throw new Error(
          `列表缺少路径点「${waypoint.name}」(id=${waypoint.id})；实际顺序：${actualIds.join(', ') || '空'}`,
        );
      }
      if (item.name !== waypoint.name) {
        throw new Error(`列表项 ${waypoint.id} 名称「${item.name}」，config 里是「${waypoint.name}」`);
      }
    }
    // 列表现在按分组分区渲染（与配置工具左树一致）：校验「分区归属 + 每组内顺序」，
    // 而不是全局扁平顺序 —— 全局顺序来自分组定义，不再是 config 的数组顺序。
    const sections = await page.evalFn(() =>
      [...document.querySelectorAll('#waypoint-list .wp-group')].map((section) => ({
        group: section.dataset.group,
        collapsed: section.classList.contains('is-collapsed'),
        items: [...section.querySelectorAll('[data-id]')].map((el) => el.dataset.id),
      })),
    );
    if (!sections || !sections.length) throw new Error('路径点列表没有按分组渲染（找不到 .wp-group）');

    const sectionGroupOf = new Map();
    for (const section of sections) {
      for (const id of section.items) {
        if (sectionGroupOf.has(id)) throw new Error(`路径点 ${id} 同时出现在多个分组分区里`);
        sectionGroupOf.set(id, section.group);
      }
    }
    const knownGroupIds = new Set([...dimension.groups.map((group) => String(group.id)), 'default']);
    for (const section of sections) {
      if (!knownGroupIds.has(String(section.group))) {
        throw new Error(`列表出现了 config 里没有的分组「${section.group}」`);
      }
    }

    // 每个分组内：成员集合与 config 一致，且内部顺序与 config 中出现顺序一致
    for (const group of [...dimension.groups, { id: 'default' }]) {
      const groupId = String(group.id);
      const expectedInGroup = dimension.waypoints
        .filter((waypoint) => String(waypoint.group || 'default') === groupId)
        .map((waypoint) => String(waypoint.id));
      if (!expectedInGroup.length) continue;
      const section = sections.find((entry) => String(entry.group) === groupId);
      if (!section) throw new Error(`列表缺少分组「${groupId}」的分区（应该有 ${expectedInGroup.length} 个路径点）`);
      const actualInGroup = section.items.map(String);
      const missing = expectedInGroup.filter((id) => !actualInGroup.includes(id));
      if (missing.length) throw new Error(`分组「${groupId}」缺少路径点：${missing.join(', ')}`);
      const actualOrder = expectedInGroup.filter((id) => actualInGroup.includes(id));
      const ordered = actualInGroup.filter((id) => expectedInGroup.includes(id));
      if (ordered.join(',') !== actualOrder.join(',')) {
        throw new Error(
          `分组「${groupId}」内部顺序与 config 不一致：实际 [${ordered.join(', ')}]，期望 [${actualOrder.join(', ')}]`,
        );
      }
    }

    // 「分组」面板已移除：分组信息现在只存在于路径点列表的分组头里（名称/数量/眼睛按钮）
    const headers = await page.evalFn(() =>
      [...document.querySelectorAll('#waypoint-list .wp-group')].map((section) => {
        const head = section.querySelector('.wp-group-head');
        return {
          group: section.dataset.group,
          collapsed: section.classList.contains('is-collapsed'),
          name: (head?.querySelector('.wp-group-name')?.textContent || '').trim(),
          count: Number(head?.querySelector('.wp-group-count')?.textContent || '0'),
          items: section.querySelectorAll('[data-id]').length,
          hasEye: !!head?.querySelector('.group-eye'),
          ariaExpanded: head?.getAttribute('aria-expanded'),
        };
      }),
    );
    if (!headers.length) throw new Error('列表里没有分组头（.wp-group-head）');
    for (const group of dimension.groups) {
      const target = headers.find((entry) => String(entry.group) === String(group.id));
      if (!target) throw new Error(`列表缺少分组「${group.name}」(${group.id}) 的分组头`);
      if (!target.name.includes(group.name) && !group.name.includes(target.name)) {
        throw new Error(`分组头名称「${target.name}」，config 里是「${group.name}」`);
      }
      if (target.count !== target.items) {
        throw new Error(`分组「${group.name}」头上写 ${target.count} 个，实际 ${target.items} 项`);
      }
      if (!target.hasEye) throw new Error(`分组「${group.name}」的分组头缺少眼睛按钮`);
      if (target.ariaExpanded !== 'true' && target.ariaExpanded !== 'false') {
        throw new Error(`分组「${group.name}」的分组头缺少 aria-expanded`);
      }
    }
    return `${items.length} 个路径点、${headers.length} 个分组头与 config 一致`;
  });

  /* ---------------- 5. 侧栏交互 ---------------- */
  await checkIfReady('sidebar.search', '搜索框输入后列表项减少，清空后恢复', async () => {
    await ensureSidebarOpen();
    const dimension = dimensionById('overworld');
    const total = dimension.waypoints.length;
    const before = await page.evalFn(LIST_STATS);
    if (!before) throw new Error('找不到 #waypoint-list');
    if (before.count !== total) throw new Error(`搜索前列表项 ${before.count}，期望 ${total}`);

    // 从 config 里挑一个能过滤出部分结果的名称，不依赖固定的示例数据。
    let query = '';
    let expectedMatches = 0;
    for (const waypoint of dimension.waypoints) {
      const name = String(waypoint.name || '').trim();
      if (!name) continue;
      const matches = dimension.waypoints.filter((item) => String(item.name || '').includes(name)).length;
      if (matches > 0 && matches < total) {
        query = name;
        expectedMatches = matches;
        break;
      }
    }
    if (!query) throw new Error('config 里找不到可用于搜索测试的路径点名称');

    if (!(await page.evalFn(SET_INPUT, '#waypoint-search', query))) {
      throw new Error('找不到搜索框 #waypoint-search');
    }
    const filtered = await waitUntil(
      async () => {
        const state = await page.evalFn(LIST_STATS);
        if (state && state.count === expectedMatches) return state;
        return null;
      },
      { timeout: WAIT.short, interval: 120, label: `搜索「${query}」后列表项变为 ${expectedMatches}` },
    ).catch(async () => {
      const state = await page.evalFn(LIST_STATS);
      throw new Error(
        `搜索「${query}」后列表项为 ${state?.count ?? '?'}，期望 ${expectedMatches}（结果：${state?.texts?.join(' / ') ?? ''}）`,
      );
    });
    if (filtered.emptyVisible) throw new Error('有搜索结果时 #waypoint-empty 仍然可见');

    await page.evalFn(SET_INPUT, '#waypoint-search', '');
    await waitUntil(
      async () => {
        const state = await page.evalFn(LIST_STATS);
        return state && state.count === total ? state : null;
      },
      { timeout: WAIT.short, interval: 120, label: '清空搜索后恢复列表' },
    );
    return `${total} → ${filtered.count} → ${total}`;
  });

  await checkIfReady('sidebar.empty', '搜索无结果时列表为空且 #waypoint-empty 可见', async () => {
    await ensureSidebarOpen();
    await page.evalFn(SET_INPUT, '#waypoint-search', 'zzz-不存在的路径点-zzz');
    const state = await waitUntil(
      async () => {
        const current = await page.evalFn(LIST_STATS);
        return current && current.count === 0 ? current : null;
      },
      { timeout: WAIT.short, interval: 120, label: '无结果时列表为空' },
    ).catch(async () => {
      const current = await page.evalFn(LIST_STATS);
      throw new Error(`搜索无结果后列表项为 ${current?.count ?? '?'}，期望 0`);
    });
    if (!state.emptyVisible) throw new Error('#waypoint-empty 未显示');
    await page.evalFn(SET_INPUT, '#waypoint-search', '');
    await page.settle(200);
    return '空状态正确';
  });

  await checkIfReady('sidebar.click', '点击侧栏列表项后视图以该点为中心（容差 40px）', async () => {
    await ensureSidebarOpen();
    await page.evalFn(SET_INPUT, '#waypoint-search', '');
    await resetView();
    const dimension = dimensionById('overworld');
    const waypoint = dimension.waypoints.find((item) => item.id === 'castle') ?? dimension.waypoints[0];

    const target = await page.evalFn((waypointId) => {
      const list = document.querySelector('#waypoint-list');
      if (!list) return { found: false, reason: '缺少 #waypoint-list' };
      const candidates = [...list.querySelectorAll('[data-id], [data-waypoint-id], .waypoint-item, li')];
      const el = candidates.find(
        (item) => item.dataset?.id === waypointId || item.dataset?.waypointId === waypointId,
      );
      if (!el) return { found: false, reason: `列表里找不到 ${waypointId}`, count: candidates.length };
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        found: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        text: (el.textContent || '').trim().slice(0, 60),
      };
    }, waypoint.id);
    if (!target.found) throw new Error(`无法点击列表项：${target.reason}（候选 ${target.count ?? 0} 个）`);
    if (!(target.width > 0)) throw new Error('列表项尺寸为 0（侧栏可能被收起）');

    await page.click(target.x, target.y);
    await sleep(120);

    let distance = Infinity;
    let detail = null;
    try {
      await waitUntil(
        async () => {
          const info = await page.evalFn(IMAGE_INFO);
          const markers = await page.evalFn(MARKER_RECTS);
          const marker = markers.find((item) => item.id === waypoint.id);
          if (!info || !marker || !info.viewport) return false;
          const expected = expectedScreenPoint(dimension, info, waypoint.x, waypoint.z);
          const best = anchorCandidates(marker.rect)
            .map(([anchor, x, y]) => ({ anchor, distance: Math.hypot(x - expected.sx, y - expected.sy), x, y }))
            .sort((a, b) => a.distance - b.distance)[0];
          distance = best.distance;
          detail = { expected, marker: best, viewport: info.viewport };
          return distance <= CENTER_TOLERANCE;
        },
        { timeout: WAIT.normal, interval: 120, label: `${waypoint.name} 居中` },
      );
    } catch {
      throw new Error(
        `点击「${waypoint.name}」后未居中：标记锚点与期望坐标相差 ${distance.toFixed(1)}px` +
          `（容差 ${CENTER_TOLERANCE}px；期望 (${detail?.expected?.sx?.toFixed?.(0) ?? '?'}, ${detail?.expected?.sy?.toFixed?.(0) ?? '?'})）`,
      );
    }
    return `点击「${target.text}」→ 偏差 ${distance.toFixed(1)}px`;
  });

  await checkIfReady('popup.group-row', '详情卡：有分组的点显示分组名，未分组点不显示分组行', async () => {
    await ensureSidebarOpen();
    await page.evalFn(SET_INPUT, '#waypoint-search', '');
    await resetView();
    const dimension = dimensionById('overworld');
    const grouped = dimension.waypoints.find((waypoint) => (waypoint.group || 'default') !== 'default');
    const ungrouped = dimension.waypoints.find((waypoint) => (waypoint.group || 'default') === 'default');
    if (!grouped) throw new Error('config 里没有已分组路径点，无法验证分组行');
    if (!ungrouped) throw new Error('config 里没有未分组路径点，无法验证隐藏分组行');

    const clickRow = async (waypoint) => {
      const target = await page.evalFn((waypointId) => {
        const el = document.querySelector(`#waypoint-list [data-id="${waypointId}"]`);
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, waypoint.id);
      if (!target) throw new Error(`列表里找不到「${waypoint.name}」`);
      await page.click(target.x, target.y);
      await page
        .waitFor(
          (id) => {
            const popup = document.querySelector('.marker-popup');
            return !!popup && !popup.hidden && popup.dataset.id === id;
          },
          { timeout: WAIT.short, interval: 80, label: `详情卡打开「${waypoint.name}」`, args: [waypoint.id] },
        )
        .catch(() => {});
      await page.settle(260);
    };
    const readPopup = () => page.evalFn(() => {
      const popup = document.querySelector('.marker-popup');
      if (!popup || popup.hidden) return null;
      const row = popup.querySelector('.popup-group');
      return {
        id: popup.dataset.id,
        rowHidden: !row || row.hidden,
        text: (popup.querySelector('.popup-group-name')?.textContent || '').trim(),
      };
    });

    await clickRow(grouped);
    const groupedView = await readPopup();
    if (!groupedView || groupedView.rowHidden || !groupedView.text) {
      throw new Error(
        `已分组点「${grouped.name}」详情卡应显示分组名：${JSON.stringify(groupedView)}`,
      );
    }

    await clickRow(ungrouped);
    const ungroupedView = await readPopup();
    if (!ungroupedView || !ungroupedView.rowHidden) {
      throw new Error(
        `未分组点「${ungrouped.name}」详情卡不应显示分组行：${JSON.stringify(ungroupedView)}`,
      );
    }
    return `「${grouped.name}」显示「${groupedView.text}」；「${ungrouped.name}」不显示分组行`;
  });

  await checkIfReady('group.toggle', '分组眼睛按钮可隐藏/恢复该组标记', async () => {
    await ensureSidebarOpen();
    await resetView();
    const dimension = dimensionById('overworld');
    const group = dimension.groups.find((item) => item.id === 'event') ?? dimension.groups[0];
    const groupSize = dimension.waypoints.filter((waypoint) => (waypoint.group ?? 'default') === group.id).length;

    // 「分组」面板已移除：现在用路径点列表里分组头上的眼睛按钮
    const target = await page.evalFn((groupId) => {
      const section = document.querySelector(`#waypoint-list .wp-group[data-group="${groupId}"]`);
      if (!section) return { found: false, reason: `列表里找不到分组分区「${groupId}」` };
      const toggle = section.querySelector('.wp-group-head .group-eye');
      if (!toggle) return { found: false, reason: `分组「${groupId}」的头部没有眼睛按钮`, html: section.outerHTML.slice(0, 600) };
      // 折叠状态下按钮不可见，先展开
      const head = section.querySelector('.wp-group-head');
      if (section.classList.contains('is-collapsed') && head) head.click();
      toggle.scrollIntoView({ block: 'center' });
      const rect = toggle.getBoundingClientRect();
      return {
        found: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        className: String(toggle.className),
        label: toggle.getAttribute('aria-label') ?? toggle.title ?? '',
      };
    }, group.id);
    if (!target.found) throw new Error(`找不到分组开关：${target.reason}${target.html ? `；HTML：${truncate(target.html, 400)}` : ''}`);

    const before = await page.evalFn(MARKER_STATS, group.id);
    if (!before) throw new Error('找不到 #overlay');
    if (before.groupShown === 0) {
      throw new Error(`分组「${group.name}」的标记在整图视图下不可见，无法验证开关`);
    }
    await page.click(target.x, target.y);
    await page.settle(320);
    const hidden = await page.evalFn(MARKER_STATS, group.id);
    const changed = hidden.groupShown < before.groupShown || hidden.groupTotal < before.groupTotal;
    if (!changed) {
      throw new Error(
        `点击分组「${group.name}」开关后标记数未变化（可见 ${before.groupShown} → ${hidden.groupShown}，DOM ${before.groupTotal} → ${hidden.groupTotal}）`,
      );
    }
    if (hidden.groupShown > 0) {
      throw new Error(`隐藏分组「${group.name}」后仍有 ${hidden.groupShown} 个标记可见`);
    }

    await page.click(target.x, target.y);
    await page.settle(320);
    const restored = await page.evalFn(MARKER_STATS, group.id);
    if (restored.groupShown !== before.groupShown) {
      throw new Error(
        `恢复分组「${group.name}」后可见标记 ${restored.groupShown}，期望 ${before.groupShown}`,
      );
    }
    return `分组「${group.name}」${before.groupShown} → ${hidden.groupShown} → ${restored.groupShown}（该组 ${groupSize} 点）`;
  });

  /* ---------------- 5b. 网格 / 标签 / 全显全隐 ---------------- */
  await checkIfReady('ui.toggles', '网格 / 标签 / 全显全隐开关行为正确（且无重复绑定）', async () => {
    await ensureSidebarOpen();
    await resetView();
    const dimension = dimensionById('overworld');
    const total = dimension.waypoints.length;

    const readGrid = () =>
      page.evalFn(() => {
        const button = document.querySelector('#btn-grid');
        const grid = document.querySelector('.map-grid');
        return {
          pressed: button ? button.getAttribute('aria-pressed') : null,
          opacity: grid ? getComputedStyle(grid).opacity : null,
          bodyGrid: document.body.dataset.grid ?? null,
        };
      });

    // ① 网格：一次点击只切换一次（若事件被重复绑定会立刻变回 false）
    const gridBefore = await readGrid();
    if (gridBefore.pressed !== 'false') {
      throw new Error(`#btn-grid 初始 aria-pressed=${gridBefore.pressed}，期望 "false"`);
    }
    if (gridBefore.opacity !== null && Math.abs(Number(gridBefore.opacity) - 0) > 0.05) {
      throw new Error(`.map-grid 初始 opacity=${gridBefore.opacity}，期望 0（网格默认关闭）`);
    }
    await page.clickSelector('#btn-grid');
    const gridOn = await waitUntil(
      async () => {
        const state = await readGrid();
        return state.pressed === 'true' && Math.abs(Number(state.opacity) - 1) < 0.05 ? state : null;
      },
      { timeout: WAIT.short, interval: 100, label: '网格开启（aria-pressed=true / opacity=1）' },
    ).catch(async () => {
      const state = await readGrid();
      throw new Error(
        `点击一次 #btn-grid 后 aria-pressed=${state.pressed}、opacity=${state.opacity}，` +
          `期望 "true" / 1（若为 "false" 说明按钮被重复绑定）`,
      );
    });
    await page.clickSelector('#btn-grid');
    const gridOff = await waitUntil(
      async () => {
        const state = await readGrid();
        return state.pressed === 'false' && Math.abs(Number(state.opacity) - 0) < 0.05 ? state : null;
      },
      { timeout: WAIT.short, interval: 100, label: '网格关闭（aria-pressed=false / opacity=0）' },
    ).catch(async () => {
      const state = await readGrid();
      throw new Error(
        `再次点击 #btn-grid 后 aria-pressed=${state.pressed}、opacity=${state.opacity}，期望 "false" / 0`,
      );
    });

    // ② 标签：hover → always → never → hover
    const readLabels = () => page.evaluate('document.body.dataset.labels ?? null');
    const labelsBefore = await readLabels();
    if (labelsBefore !== 'hover') {
      throw new Error(`body[data-labels] 初始为「${labelsBefore}」，期望 "hover"（config.ui.labelMode）`);
    }
    const labelSequence = [];
    for (let index = 0; index < 3; index += 1) {
      await page.clickSelector('#btn-toggle-labels');
      await page.settle(150);
      labelSequence.push(await readLabels());
    }
    const expectedLabels = ['always', 'never', 'hover'];
    if (labelSequence.join(',') !== expectedLabels.join(',')) {
      throw new Error(
        `#btn-toggle-labels 连点三次后 body[data-labels]=[${labelSequence.join(' → ')}]，` +
          `期望 [${expectedLabels.join(' → ')}]`,
      );
    }

    // ③ 全隐 / 全显
    // 注：整图视图受最小缩放（0.02）限制，画幅可能高于视口，少量贴边路径点会被 .is-offscreen 裁掉；
    // 这里把「视口外」计入合法不可见，只要求其余标记全部可见。
    const statsBefore = await page.evalFn(MARKER_STATS, null);
    if (!statsBefore || statsBefore.shown + statsBefore.offscreen !== total) {
      throw new Error(
        `全隐前可见标记 ${statsBefore?.shown ?? '?'} 个、视口外 ${statsBefore?.offscreen ?? '?'} 个，` +
          `合计期望 ${total} 个（整图视图下除视口外应全部可见）`,
      );
    }
    await page.clickSelector('#btn-all-hidden');
    await page.settle(320);
    const hiddenStats = await page.evalFn(MARKER_STATS, null);
    const hiddenBadge = await page.evalFn(() => (document.querySelector('#waypoint-count')?.textContent || '').trim());
    if (hiddenStats?.shown !== 0) {
      throw new Error(`#btn-all-hidden 后可见标记 ${hiddenStats?.shown ?? '?'} 个，期望 0（DOM 总数 ${hiddenStats?.total ?? '?'}）`);
    }
    if (hiddenBadge !== `0/${total}`) {
      throw new Error(`#btn-all-hidden 后 #waypoint-count=「${hiddenBadge}」，期望「0/${total}」`);
    }
    await page.clickSelector('#btn-all-visible');
    await page.settle(320);
    const shownStats = await page.evalFn(MARKER_STATS, null);
    const shownBadge = await page.evalFn(() => (document.querySelector('#waypoint-count')?.textContent || '').trim());
    if (shownStats?.shown !== statsBefore.shown) {
      throw new Error(
        `#btn-all-visible 后可见标记 ${shownStats?.shown ?? '?'} 个，期望恢复为 ${statsBefore.shown} 个`,
      );
    }
    if (shownBadge !== `${total}/${total}`) {
      throw new Error(`#btn-all-visible 后 #waypoint-count=「${shownBadge}」，期望「${total}/${total}」`);
    }

    return (
      `网格 ${gridBefore.pressed}/opacity ${gridBefore.opacity} → ${gridOn.pressed}/1 → ${gridOff.pressed}/0；` +
      `标签 ${labelsBefore} → ${labelSequence.join(' → ')}；` +
      `全隐 0/${total} → 全显 ${shownStats.shown}/${total}（视口外 ${statsBefore.offscreen}）`
    );
  });

  /* ---------------- 5c. URL 深链 ---------------- */
  await checkIfReady('deep-link', 'URL 深链：#dim/x/z/s 随视图同步，新标签页按 hash 还原视角且无 console error', async () => {
    const dimension = dimensionById('overworld');
    // 不依赖固定的 castle 示例点：用 config 里第一个坐标有效的路径点。
    const castle =
      dimension.waypoints.find((waypoint) => waypoint.id === 'castle') ||
      dimension.waypoints.find(
        (waypoint) => Number.isFinite(waypoint.x) && Number.isFinite(waypoint.z),
      );
    if (!castle) throw new Error('config 主世界没有坐标有效的路径点，无法测试深链');

    await page.setViewport({ ...VIEWPORT });
    await page.settle(220);
    await ensureSidebarOpen();
    await resetView();
    await dismissMarkerPopup();
    // 先让「整图」后的 hash（x=0,z=0）同步落定，避免把它当成 focus 后的结果
    await sleep(450);
    const hashBeforeFocus = await page.evaluate('location.hash');

    await page.evalFn((id) => {
      const api = window.__mapApp;
      if (!api || typeof api.focusWaypoint !== 'function') {
        throw new Error('window.__mapApp.focusWaypoint 不可用');
      }
      api.focusWaypoint(id);
    }, castle.id);

    const hash = await waitUntil(
      async () => {
        const raw = await page.evaluate('location.hash');
        if (!raw || raw.length < 6) return null;
        const params = new URLSearchParams(raw.replace(/^#/, ''));
        const x = Number(params.get('x'));
        const z = Number(params.get('z'));
        const s = Number(params.get('s'));
        if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(s) || s <= 0) return null;
        // 必须已经落到 castle 附近，否则可能是上一次 fit 留下的旧 hash
        if (Math.abs(x - castle.x) > 5 || Math.abs(z - castle.z) > 5) return null;
        return { raw, dim: params.get('dim'), x, z, s, wp: params.get('wp') };
      },
      { timeout: WAIT.normal, interval: 100, label: `hash 同步到「${castle.name}」` },
    ).catch(async (error) => {
      const raw = await page.evaluate('location.hash').catch(() => '');
      throw new Error(
        `${error.message}；当前 hash=「${raw || '(空)'}」，focus 前 hash=「${hashBeforeFocus || '(空)'}」`,
      );
    });

    if (hash.dim !== 'overworld') {
      throw new Error(`hash 中 dim=${hash.dim}，期望 overworld（hash=${hash.raw}）`);
    }
    if (hash.wp && hash.wp !== castle.id) {
      rep.warn(`hash 的 wp=${hash.wp}，期望 ${castle.id}（不影响视角还原）`);
    }

    const second = await Page.open(conn);
    let secondDiag = null;
    let secondCenter = null;
    try {
      await second.addInitScript(INIT_SCRIPT);
      secondDiag = createDiagnostics(second, { ignore: isExpectedTileMiss });
      await second.setViewport({ ...VIEWPORT });
      const secondUrl = `${baseUrl}${hash.raw}`;
      await second.navigate(secondUrl, { timeout: WAIT.long });
      await second.waitFor(
        () => {
          const buttons = document.querySelectorAll('#dimension-switch button, #dimension-switch [role="tab"]');
          const layer = document.querySelector('#map-canvas:not([hidden]), #map-image:not([hidden])');
          if (buttons.length < 3 || !layer) return null;
          const isCanvas = layer.tagName === 'CANVAS';
          const width = isCanvas ? Number(layer.dataset.imageWidth || 0) : layer.naturalWidth;
          if (!(width > 0)) return null;
          if (document.body.dataset.dimension !== 'overworld') return null;
          return true;
        },
        { timeout: WAIT.long, interval: 120, label: '新标签页按深链还原' },
      );
      await sleep(250);

      const secondState = await second.evalFn(() => {
        const api = window.__mapApp;
        const viewState =
          api && api.view && typeof api.view.getViewState === 'function' ? api.view.getViewState() : null;
        const image = document.querySelector('#map-canvas:not([hidden]), #map-image:not([hidden])');
        const isCanvas = Boolean(image) && image.tagName === 'CANVAS';
        return {
          bodyDimension: document.body.dataset.dimension ?? null,
          hash: location.hash,
          naturalWidth: image ? (isCanvas ? Number(image.dataset.imageWidth || 0) : image.naturalWidth) : 0,
          naturalHeight: image ? (isCanvas ? Number(image.dataset.imageHeight || 0) : image.naturalHeight) : 0,
          calibration:
            api && api.state && api.state.calibration
              ? {
                  xMin: api.state.calibration.xMin,
                  xMax: api.state.calibration.xMax,
                  zMin: api.state.calibration.zMin,
                  zMax: api.state.calibration.zMax,
                  flipZ: !!api.state.calibration.flipZ,
                }
              : null,
          viewState: viewState
            ? {
                scale: viewState.scale,
                tx: viewState.tx,
                ty: viewState.ty,
                viewWidth: viewState.viewWidth,
                viewHeight: viewState.viewHeight,
              }
            : null,
        };
      });
      if (secondState.bodyDimension !== 'overworld') {
        throw new Error(`新标签页 body[data-dimension]=${secondState.bodyDimension}，期望 overworld`);
      }
      if (!secondState.viewState) {
        throw new Error('新标签页无法读取 window.__mapApp.view.getViewState()');
      }
      const vs = secondState.viewState;
      const centerPx = (vs.viewWidth / 2 - vs.tx) / vs.scale;
      const centerPy = (vs.viewHeight / 2 - vs.ty) / vs.scale;
      secondCenter = imagePointToWorld(
        secondState.calibration || dimension.calibration,
        secondState.naturalWidth,
        secondState.naturalHeight,
        centerPx,
        centerPy,
      );
      if (Math.abs(secondCenter.x - hash.x) > 5 || Math.abs(secondCenter.z - hash.z) > 5) {
        throw new Error(
          `新标签页视图中心 (${secondCenter.x.toFixed(1)}, ${secondCenter.z.toFixed(1)}) 与 hash (${hash.x}, ${hash.z}) 相差 > 5 方块`,
        );
      }
      if (Math.abs(vs.scale - hash.s) > 0.02) {
        rep.warn(`新标签页 scale=${vs.scale.toFixed(3)}，hash 里 s=${hash.s}（期望相差 < 0.02）`);
      }

      const injected = await second
        .evaluate('(window.__qaErrors ? window.__qaErrors() : { errors: [], unhandled: [] })')
        .catch(() => ({ errors: [], unhandled: [] }));
      const secondErrors = flattenErrors({
        cdp: secondDiag.snapshot(),
        injected: injected?.errors ?? [],
        unhandled: injected?.unhandled ?? [],
      });
      if (secondErrors.length > 0) {
        throw new Error(`新标签页出现 ${secondErrors.length} 条 console error / 异常：${secondErrors.slice(0, 4).join('；')}`);
      }
      return (
        `hash=${hash.raw}；新标签页中心 (${secondCenter.x.toFixed(1)}, ${secondCenter.z.toFixed(1)})，` +
        `与 hash 相差 < 5 方块；无 console error`
      );
    } finally {
      secondDiag?.dispose();
      await second.close().catch(() => {});
    }
  });

  /* ---------------- 6d. 测距工具 ---------------- */
  await checkIfReady('measure.two', '测距：两点距离与总长正确（(0,0)→(300,400) = 500 格）', async () => {
    const opened = await page.evalFn(() => {
      const button = document.getElementById('btn-measure');
      if (!button) throw new Error('缺少 #btn-measure');
      button.click();
      window.__mapApp.clearMeasure();
      window.__mapApp.addMeasurePoint(0, 0);
      window.__mapApp.addMeasurePoint(300, 400);
      const summary = window.__mapApp.measureSummary();
      return {
        active: window.__mapApp.state.measureActive,
        pressed: button.getAttribute('aria-pressed'),
        panelHidden: document.getElementById('measure-readout')?.hidden,
        segments: summary.segments.map((v) => Math.round(v * 10) / 10),
        total: Math.round(summary.total),
        labels: [...document.querySelectorAll('.measure-seg-label')].map((el) => el.textContent),
        totalLabel: document.querySelector('.measure-total-label')?.textContent ?? null,
        listItems: [...document.querySelectorAll('#measure-list li')].map((li) => li.textContent),
      };
    });
    if (!opened.active || opened.pressed !== 'true') {
      throw new Error(`点「测量」后状态不对：active=${opened.active} aria-pressed=${opened.pressed}`);
    }
    if (opened.panelHidden !== false) throw new Error('测量读数面板 #measure-readout 未显示');
    if (opened.total !== 500 || opened.segments.length !== 1) {
      throw new Error(`两点距离应为 500 格，实际 segments=${JSON.stringify(opened.segments)} total=${opened.total}`);
    }
    if (!opened.labels.some((t) => /500/.test(t))) {
      throw new Error(`画布上没有 500 格的段标注：${JSON.stringify(opened.labels)}`);
    }
    if (!(opened.totalLabel || '').includes('总长')) {
      throw new Error(`缺少总长标注：${opened.totalLabel}`);
    }
    if (!opened.listItems.some((t) => /500/.test(t))) {
      throw new Error(`读数面板没有段距离：${JSON.stringify(opened.listItems)}`);
    }
    return `500 格 · 标注「${opened.labels[0]}」· 总长「${opened.totalLabel}」`;
  });

  await checkIfReady('measure.polyline', '测距：多段折线每段独立标注、合计正确（100+240=340）', async () => {
    const result = await page.evalFn(() => {
      window.__mapApp.clearMeasure();
      window.__mapApp.addMeasurePoint(0, 0);
      window.__mapApp.addMeasurePoint(100, 0);
      window.__mapApp.addMeasurePoint(100, 240);
      const summary = window.__mapApp.measureSummary();
      return {
        segments: summary.segments.map((v) => Math.round(v)),
        total: Math.round(summary.total),
        segLabels: [...document.querySelectorAll('.measure-seg-label')].map((el) => el.textContent),
        listItems: [...document.querySelectorAll('#measure-list li')].map((li) => li.textContent),
        pathPoints: document.querySelector('.measure-line')?.getAttribute('points') ?? '',
      };
    });
    if (result.segments.join(',') !== '100,240') {
      throw new Error(`分段应为 [100, 240]，实际 ${JSON.stringify(result.segments)}`);
    }
    if (result.total !== 340) throw new Error(`合计应为 340，实际 ${result.total}`);
    if (result.segLabels.length !== 2) {
      throw new Error(`画布上应有 2 个段标注，实际 ${JSON.stringify(result.segLabels)}`);
    }
    if (!result.listItems.some((t) => /合计\s*340/.test(t))) {
      throw new Error(`读数面板缺少合计行：${JSON.stringify(result.listItems)}`);
    }
    if (result.pathPoints.split(' ').filter(Boolean).length !== 3) {
      throw new Error(`折线应有 3 个顶点，实际 points="${result.pathPoints}"`);
    }
    return `2 段 100 / 240 · 合计 340 格`;
  });

  await checkIfReady('measure.interact', '测距：点地图可加点并吸附路径点、可撤销、Esc 退出', async () => {
    await ensureSidebarOpen();
    const target = await page.evalFn(() => {
      window.__mapApp.clearMeasure();
      if (!window.__mapApp.state.measureActive) document.getElementById('btn-measure').click();
      const waypoint = window.__mapApp.state.dimension.waypoints[0];
      if (!waypoint) return null;
      const client = window.__mapApp.view.worldToClient(waypoint.x, waypoint.z);
      return {
        id: waypoint.id,
        world: { x: waypoint.x, z: waypoint.z },
        client: { x: Math.round(client.x), y: Math.round(client.y) },
      };
    });
    if (!target) throw new Error('当前维度没有路径点，无法验证吸附');

    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.client.x, y: target.client.y, button: 'none' });
    await page.settle(120);
    await page.click(target.client.x, target.client.y);
    await page.settle(360);

    const afterClick = await page.evalFn(() => {
      const summary = window.__mapApp.measureSummary();
      return { points: summary.points, lastClick: window.__measureLastClick ?? null };
    });
    if (afterClick.points.length !== 1) {
      throw new Error(`点地图应加 1 个测量点，实际 ${afterClick.points.length}（lastClick=${JSON.stringify(afterClick.lastClick)}）`);
    }
    const point = afterClick.points[0];
    if (Math.abs(point.x - target.world.x) > 0.01 || Math.abs(point.z - target.world.z) > 0.01) {
      throw new Error(`应吸附到路径点 ${target.id}(${target.world.x}, ${target.world.z})，实际 (${point.x}, ${point.z})`);
    }

    // 再点一次加点 → 撤销 → 清空
    await page.evalFn(
      (world) => window.__mapApp.addMeasurePoint(world.x + 100, world.z),
      target.world,
    );
    const undo = await page.evalFn(() => {
      const before = window.__mapApp.measureSummary().points.length;
      window.__mapApp.undoMeasurePoint();
      const after = window.__mapApp.measureSummary().points.length;
      window.__mapApp.clearMeasure();
      return { before, after, cleared: window.__mapApp.measureSummary().points.length };
    });
    if (!(undo.before === 2 && undo.after === 1 && undo.cleared === 0)) {
      throw new Error(`撤销/清空行为不对：${JSON.stringify(undo)}`);
    }

    // Esc 退出测距：Esc 是「最上层优先」——有路径点详情卡时先关卡片，再按一次才退测距
    let exited = null;
    for (let press = 1; press <= 2; press += 1) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.settle(280);
      exited = await page.evalFn(() => ({
        active: window.__mapApp.state.measureActive,
        pressed: document.getElementById('btn-measure')?.getAttribute('aria-pressed'),
        popup: (() => {
          const el = document.querySelector('.marker-popup');
          return el ? !el.hidden : false;
        })(),
      }));
      if (!exited.active) break;
    }
    if (exited.active !== false || exited.pressed !== 'false') {
      throw new Error(`连按 Esc 后仍未退出测距：${JSON.stringify(exited)}`);
    }
    if (exited.popup) throw new Error(`退出测距后详情卡仍开着：${JSON.stringify(exited)}`);
    return `吸附到「${target.id}」· 撤销/清空正常 · Esc 退出`;
  });

  await checkIfReady('measure.shift-detail', '测距中 Shift+点路径点：打开详情卡且不新增测量点', async () => {
    const target = await page.evalFn(() => {
      window.__mapApp.clearMeasure();
      if (!window.__mapApp.state.measureActive) document.getElementById('btn-measure').click();
      const waypoint = window.__mapApp.state.dimension.waypoints[0];
      if (!waypoint) return null;
      const client = window.__mapApp.view.worldToClient(waypoint.x, waypoint.z);
      return { id: String(waypoint.id), x: Math.round(client.x), y: Math.round(client.y) };
    });
    if (!target) throw new Error('当前维度没有路径点，无法验证 Shift+详情');

    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none', modifiers: 8 });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1, modifiers: 8 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1, modifiers: 8 });
    await page.settle(420);

    const state = await page.evalFn(() => {
      const popup = document.querySelector('.marker-popup');
      return {
        points: window.__mapApp.measureSummary().points.length,
        popup: popup ? !popup.hidden : false,
        measureActive: window.__mapApp.state.measureActive,
        active: window.__mapApp.state.activeWaypointId ?? null,
      };
    });
    if (state.points !== 0) throw new Error(`Shift+点路径点不应加测量点，实际 ${state.points} 个`);
    if (!state.popup) throw new Error('Shift+点路径点应打开详情卡');
    if (!state.measureActive) throw new Error('Shift+看详情不应退出测距模式');

    await page.evalFn(() => {
      window.__mapApp.clearMeasure();
      window.__mapApp.setMeasureActive(false);
    });
    return `Shift+点击打开「${target.id}」详情，未加点`;
  });

  await checkIfReady('measure.panel', '测距读数面板上的点击/滚轮不会穿透到地图（撤销/清空不误加点）', async () => {
    await ensureSidebarOpen();
    const rectOf = (selector) =>
      page.evalFn((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      }, selector);

    const setup = await page.evalFn(() => {
      if (!window.__mapApp.state.measureActive) document.getElementById('btn-measure').click();
      window.__mapApp.clearMeasure();
      window.__mapApp.addMeasurePoint(0, 0);
      window.__mapApp.addMeasurePoint(300, 400);
      return { points: window.__mapApp.measureSummary().points.length };
    });
    if (setup.points !== 2) throw new Error(`准备两个测量点失败：${JSON.stringify(setup)}`);
    await page.settle(200);

    // A) 面板标题区域点一下：不能加测量点（点 title 本身，避免落到「撤销/结束/清空/退出」按钮上）
    const head = await rectOf('#measure-readout .measure-title');
    if (!head) throw new Error('找不到 #measure-readout .measure-title');
    await page.click(head.x, head.y);
    await page.settle(240);
    const afterPanelClick = await page.evalFn(() => window.__mapApp.measureSummary().points.length);
    if (afterPanelClick !== 2) {
      throw new Error(`点面板标题后测量点变成 ${afterPanelClick}（应保持 2，说明点击穿透到地图了）`);
    }

    // B) 点「撤销」：真撤销一点，且不额外加点
    const undo = await rectOf('#measure-undo');
    if (!undo) throw new Error('找不到 #measure-undo');
    await page.click(undo.x, undo.y);
    await page.settle(240);
    const afterUndo = await page.evalFn(() => window.__mapApp.measureSummary().points.length);
    if (afterUndo !== 1) throw new Error(`点「撤销」后应为 1 个点，实际 ${afterUndo}`);

    // C) 点「清空」：清空
    const clear = await rectOf('#measure-clear');
    if (!clear) throw new Error('找不到 #measure-clear');
    await page.click(clear.x, clear.y);
    await page.settle(240);
    const afterClear = await page.evalFn(() => window.__mapApp.measureSummary().points.length);
    if (afterClear !== 0) throw new Error(`点「清空」后应为 0 个点，实际 ${afterClear}`);

    // D) 面板上滚轮：不缩放地图（面板高度会随内容变化，重新取坐标）
    const head2 = await rectOf('#measure-readout .measure-title');
    const scaleBefore = await page.evalFn(() => Number(window.__mapApp.view.getViewState().scale.toFixed(4)));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: head2.x, y: head2.y, button: 'none' });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: head2.x,
      y: head2.y,
      deltaX: 0,
      deltaY: -300,
      modifiers: 0,
      pointerType: 'mouse',
    });
    await page.settle(240);
    const scaleAfter = await page.evalFn(() => Number(window.__mapApp.view.getViewState().scale.toFixed(4)));
    if (Math.abs(scaleAfter - scaleBefore) > 1e-6) {
      throw new Error(`面板上滚轮把地图缩放了：${scaleBefore} → ${scaleAfter}`);
    }

    // E) 地图空白处仍可加点，收尾恢复
    const viewport = await page.evalFn(() => {
      const rect = document.getElementById('viewport').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width * 0.55), y: Math.round(rect.top + rect.height * 0.2) };
    });
    await page.click(viewport.x, viewport.y);
    await page.settle(260);
    const afterMap = await page.evalFn(() => window.__mapApp.measureSummary().points.length);
    if (afterMap !== 1) throw new Error(`地图空白处点击应加 1 个点，实际 ${afterMap}`);

    await page.evalFn(() => {
      window.__mapApp.clearMeasure();
      window.__mapApp.setMeasureActive(false);
    });
    return '面板点击/滚轮不穿透 · 撤销与清空生效 · 地图点击正常';
  });

  await checkIfReady('measure.finish', '测距：结束（按钮/Enter）保留折线并留在测距模式；退出清空', async () => {
    await ensureSidebarOpen();
    const rectOf = (selector) =>
      page.evalFn((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      }, selector);

    const setup = await page.evalFn(() => {
      if (!window.__mapApp.state.measureActive) document.getElementById('btn-measure').click();
      window.__mapApp.clearMeasure();
      window.__mapApp.addMeasurePoint(0, 0);
      window.__mapApp.addMeasurePoint(200, 0);
      return { active: window.__mapApp.state.measureActive };
    });
    if (!setup.active) throw new Error('准备阶段未进入测距模式');
    await page.settle(200);

    // A) 真点「结束」：折线定格、仍在测距模式
    const finishBtn = await rectOf('#measure-finish');
    if (!finishBtn) throw new Error('找不到 #measure-finish');
    await page.click(finishBtn.x, finishBtn.y);
    await page.settle(240);
    const finished = await page.evalFn(() => {
      const summary = window.__mapApp.measureSummary();
      return {
        active: window.__mapApp.state.measureActive,
        current: summary.points.length,
        lines: summary.lines.map((line) => Math.round(line.total)),
        allTotal: Math.round(summary.allTotal),
        donePaths: document.querySelectorAll('.measure-line-done').length,
        listItems: [...document.querySelectorAll('#measure-list li')].map((li) => li.textContent),
      };
    });
    if (!finished.active) throw new Error('「结束」不应退出测距模式');
    if (finished.current !== 0 || finished.lines.join(',') !== '200' || finished.allTotal !== 200) {
      throw new Error(`「结束」后应保留 1 条 200 格折线且当前折线为空：${JSON.stringify(finished)}`);
    }
    if (finished.donePaths !== 1) throw new Error(`已结束折线应画 1 条，实际 ${finished.donePaths}`);
    if (!finished.listItems.some((t) => /第 1 条/.test(t))) {
      throw new Error(`读数面板缺少已结束条目：${JSON.stringify(finished.listItems)}`);
    }

    // B) Enter：结束第二条，同样留在测距模式
    await page.evalFn(() => {
      window.__mapApp.addMeasurePoint(0, 0);
      window.__mapApp.addMeasurePoint(0, 300);
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.settle(240);
    const afterEnter = await page.evalFn(() => {
      const summary = window.__mapApp.measureSummary();
      return {
        active: window.__mapApp.state.measureActive,
        lines: summary.lines.map((line) => Math.round(line.total)),
        donePaths: document.querySelectorAll('.measure-line-done').length,
      };
    });
    if (!afterEnter.active) throw new Error('Enter（结束）不应退出测距模式');
    if (afterEnter.lines.join(',') !== '200,300' || afterEnter.donePaths !== 2) {
      throw new Error(`两条折线应同时保留：${JSON.stringify(afterEnter)}`);
    }

    // C) 真点「退出」：退出测距并清空全部折线
    const exitBtn = await rectOf('#measure-exit');
    if (!exitBtn) throw new Error('找不到 #measure-exit');
    await page.click(exitBtn.x, exitBtn.y);
    await page.settle(260);
    const exited = await page.evalFn(() => {
      const summary = window.__mapApp.measureSummary();
      return {
        active: window.__mapApp.state.measureActive,
        pressed: document.getElementById('btn-measure')?.getAttribute('aria-pressed'),
        points: summary.points.length,
        lines: summary.lines.length,
        donePaths: document.querySelectorAll('.measure-line-done').length,
        currentPath: document.querySelector('.measure-line')?.getAttribute('points') ?? '',
        panelHidden: document.getElementById('measure-readout')?.hidden,
      };
    });
    if (exited.active || exited.pressed !== 'false') {
      throw new Error(`「退出」后应退出测距：${JSON.stringify(exited)}`);
    }
    if (exited.points !== 0 || exited.lines !== 0 || exited.donePaths !== 0 || exited.currentPath !== '') {
      throw new Error(`「退出」应清空所有折线：${JSON.stringify(exited)}`);
    }
    if (exited.panelHidden !== true) throw new Error('「退出」后读数面板应收起');
    return `结束 2 条（200 / 300 格）仍在测距 · 退出后折线全部清空`;
  });

  await checkIfReady('measure.guard-inactive', '测距未开启：点地图不误加点、不进入测距点击路径', async () => {
    await ensureSidebarOpen();
    const before = await page.evalFn(() => {
      window.__mapApp.clearMeasure();
      window.__mapApp.setMeasureActive(false);
      window.__measureLastClick = null;
      return {
        points: window.__mapApp.measureSummary().points.length,
        active: window.__mapApp.state.measureActive,
      };
    });
    const viewport = await page.evalFn(() => {
      const rect = document.getElementById('viewport').getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    const spot = await findSafeMapPoint(viewport);
    if (!spot) throw new Error('找不到安全地图落点');
    await page.click(spot.x, spot.y);
    await page.settle(300);
    const after = await page.evalFn(() => ({
      points: window.__mapApp.measureSummary().points.length,
      active: window.__mapApp.state.measureActive,
      lastClick: Boolean(window.__measureLastClick),
    }));
    if (after.points !== 0 || after.active !== false || after.lastClick !== false) {
      throw new Error(`未开测距点地图不应加点/进入测距路径：点击前 ${before.points} 点 → ${JSON.stringify(after)}`);
    }
    return `点击前 ${before.points} 点 → 点击后 ${after.points} 点（进入测距点击=${after.lastClick}）`;
  });

  await checkIfReady('measure.guard-exit', '测距退出：面板收起、全部折线清空', async () => {
    await ensureSidebarOpen();
    const viewport = await page.evalFn(() => {
      const rect = document.getElementById('viewport').getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    await page.evalFn(() => {
      window.__mapApp.clearMeasure();
      window.__mapApp.setMeasureActive(true);
    });
    const spots = [];
    for (const fractions of [[[0.42, 0.38]], [[0.58, 0.52]]]) {
      const spot = await findSafeMapPoint(viewport, fractions);
      if (!spot) throw new Error('找不到安全地图落点');
      spots.push(spot);
    }
    await page.click(spots[0].x, spots[0].y);
    await page.settle(260);
    await page.click(spots[1].x, spots[1].y);
    await page.settle(260);
    const during = await page.evalFn(() => {
      const panel = document.getElementById('measure-readout');
      return {
        points: window.__mapApp.measureSummary().points.length,
        donePaths: document.querySelectorAll('.measure-line-done').length,
        panelHidden: panel ? panel.hidden : null,
      };
    });
    if (during.points < 2) throw new Error(`测距中应点出至少 2 个测量点，实际 ${during.points}`);
    if (during.panelHidden !== false) throw new Error('测距中读数面板应显示');
    await page.evalFn(() => window.__mapApp.setMeasureActive(false));
    await page.settle(220);
    const exited = await page.evalFn(() => {
      const panel = document.getElementById('measure-readout');
      const summary = window.__mapApp.measureSummary();
      return {
        points: summary.points.length,
        lines: summary.lines.length,
        donePaths: document.querySelectorAll('.measure-line-done').length,
        panelHidden: panel ? panel.hidden : null,
        active: window.__mapApp.state.measureActive,
      };
    });
    const cleared = exited.points === 0 && exited.lines === 0 && exited.donePaths === 0;
    if (exited.panelHidden !== true || exited.active !== false || !cleared) {
      throw new Error(`退出后应收面板并清空折线：测量中 ${JSON.stringify(during)} → 退出后 ${JSON.stringify(exited)}`);
    }
    return `测量中 ${during.points} 点 → 退出后 ${exited.points} 点 / ${exited.lines} 条、面板隐藏`;
  });

  await checkIfReady('measure.guard-reopen', '测距重开：面板恢复且不残留上次折线', async () => {
    await ensureSidebarOpen();
    const before = await page.evalFn(() => {
      const summary = window.__mapApp.measureSummary();
      return { points: summary.points.length, lines: summary.lines.length };
    });
    if (before.points !== 0 || before.lines !== 0) {
      throw new Error(`前置检查失败：退出测距应已清空，实际 ${JSON.stringify(before)}`);
    }
    await page.evalFn(() => window.__mapApp.setMeasureActive(true));
    await page.settle(220);
    const reopened = await page.evalFn(() => {
      const panel = document.getElementById('measure-readout');
      const summary = window.__mapApp.measureSummary();
      return {
        points: summary.points.length,
        lines: summary.lines.length,
        donePaths: document.querySelectorAll('.measure-line-done').length,
        panelHidden: panel ? panel.hidden : null,
      };
    });
    const ok =
      reopened.panelHidden === false &&
      reopened.points === 0 &&
      reopened.lines === 0 &&
      reopened.donePaths === 0;
    await page.evalFn(() => {
      window.__mapApp.clearMeasure();
      window.__mapApp.setMeasureActive(false);
    });
    if (!ok) throw new Error(`重开测距应恢复空面板：${JSON.stringify(reopened)}`);
    return `重开后面板显示、${reopened.points} 点 / ${reopened.lines} 条`;
  });

  await checkIfReady('markers.dense', '密集路径点：合成 ×N 徽标、标签互相避让、连点可轮换选中', async () => {
    const STACK_ID = 'dense-smoke';
    try {
      const prepared = await page.evalFn((stackId) => {
        const app = window.__mapApp;
        const dim = app.state.dimension;
        const near = { x: 40, z: 40 };
        const list = [
          { id: `${stackId}-a`, name: '密集 A', x: near.x, z: near.z, group: 'default', icon: 'pin' },
          { id: `${stackId}-b`, name: '密集 B', x: near.x + 1, z: near.z, group: 'default', icon: 'pin' },
          { id: `${stackId}-c`, name: '密集 C', x: near.x, z: near.z + 1, group: 'default', icon: 'pin' },
          { id: `${stackId}-d`, name: '远处 D', x: near.x + 600, z: near.z + 600, group: 'default', icon: 'pin' },
        ];
        // 常显标签才能验证避让
        app.markers.setLabelMode('always');
        app.markers.setData(list, dim.groups, app.projection);
        const image = app.projection.worldToImage(near.x, near.z);
        app.view.centerOnImagePoint(image.px, image.py, { scale: 2, animate: false });
        return { count: document.querySelectorAll('#overlay .marker').length };
      }, STACK_ID);
      if (prepared.count !== 4) throw new Error(`注入 4 个密集点失败：${JSON.stringify(prepared)}`);
      await page.settle(420);

      const layout = await page.evalFn((stackId) => {
        const markers = [...document.querySelectorAll('#overlay .marker')];
        return {
          badges: markers
            .filter((m) => m.querySelector('.marker-stack'))
            .map((m) => ({ id: m.dataset.id, text: m.querySelector('.marker-stack').textContent, size: m.dataset.stackSize })),
          stacked: markers.filter((m) => m.classList.contains('is-stacked')).length,
          collided: markers.filter((m) => m.classList.contains('is-label-collided')).map((m) => m.dataset.id),
          visibleLabels: markers
            .filter((m) => {
              const label = m.querySelector('.marker-label');
              if (!label) return false;
              const style = getComputedStyle(label);
              return style.visibility !== 'hidden' && Number(style.opacity) > 0.5;
            })
            .map((m) => m.dataset.id),
          stackTop: markers.find((m) => m.querySelector('.marker-stack'))?.dataset.id ?? null,
          ids: markers.map((m) => m.dataset.id),
          stackId,
        };
      }, STACK_ID);

      if (layout.badges.length !== 1 || layout.badges[0].text !== '×3') {
        throw new Error(`应有 1 个 ×3 徽标，实际 ${JSON.stringify(layout.badges)}`);
      }
      if (layout.stacked !== 1) throw new Error(`只有堆叠顶部应带 .is-stacked，实际 ${layout.stacked} 个`);
      // 同堆只保留顶部标签：另外两个应被标记为 collided
      const stackIds = layout.ids.filter((id) => id.startsWith(`${STACK_ID}-`) && id !== `${STACK_ID}-d`);
      const expectedCollided = stackIds.filter((id) => id !== layout.stackTop);
      for (const id of expectedCollided) {
        if (!layout.collided.includes(id)) {
          throw new Error(`${id} 的标签应与顶部标签冲突而被隐藏，实际 collided=${JSON.stringify(layout.collided)}`);
        }
      }
      if (!layout.visibleLabels.includes(layout.stackTop)) {
        throw new Error(`堆叠顶部的标签应保持可见，实际可见 ${JSON.stringify(layout.visibleLabels)}`);
      }

      // 连点堆叠标记 → 轮换选中
      const cycle = await page.evalFn(async (topId) => {
        const marker = document.querySelector(`#overlay .marker[data-id="${topId}"]`);
        if (!marker) return null;
        const ids = [];
        for (let i = 0; i < 4; i += 1) {
          marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 120));
          ids.push(window.__mapApp.markers.selectedId);
        }
        return { ids, stack: [...window.__mapApp.markers._stacks.values()][0] ?? null };
      }, layout.stackTop);
      if (!cycle) throw new Error('找不到堆叠顶部标记');
      const unique = new Set(cycle.ids);
      if (unique.size !== 3) {
        throw new Error(`连点同一个标记应轮换到 3 个不同的点，实际选中序列 ${JSON.stringify(cycle.ids)}`);
      }

      // 选中后标签强制可见
      const selectedLabel = await page.evalFn(() => {
        const id = window.__mapApp.markers.selectedId;
        const marker = document.querySelector(`#overlay .marker[data-id="${id}"]`);
        const label = marker?.querySelector('.marker-label');
        const style = label ? getComputedStyle(label) : null;
        return { id, visible: style ? style.visibility !== 'hidden' && Number(style.opacity) > 0.5 : null };
      });
      if (selectedLabel.visible !== true) {
        throw new Error(`被避让的点选中后标签应强制显示：${JSON.stringify(selectedLabel)}`);
      }

      return `×3 徽标 · 避让 ${expectedCollided.length} 个标签 · 连点轮换 ${unique.size} 个点`;
    } finally {
      // 无论成败都恢复真实数据
      await page.evalFn(() => window.__mapApp.applyDimension('overworld')).catch(() => {});
      await page.settle(400);
      await page.evalFn(() => {
        const mode = window.__mapApp.state?.config?.ui?.labelMode || 'hover';
        window.__mapApp.markers.setLabelMode(mode);
      }).catch(() => {});
    }
  });

  /* ---------------- 6e. 坐标换算 ---------------- */
  await checkIfReady('convert.directions', '换算：双向换算正确，定位到画幅内坐标有效', async () => {
    await page.evalFn(() => window.__mapApp.applyDimension('overworld'));
    await page.settle(320);
    const opened = await page.evalFn(() => {
      const btn = document.getElementById('btn-convert');
      if (!btn) throw new Error('缺少 #btn-convert');
      btn.click();
      const x = document.getElementById('convert-x');
      const z = document.getElementById('convert-z');
      x.value = '80';
      z.value = '80';
      x.dispatchEvent(new Event('input', { bubbles: true }));
      z.dispatchEvent(new Event('input', { bubbles: true }));
      const res = () => document.getElementById('convert-result').textContent;
      const ow = res();
      document.getElementById('convert-dir-n').click();
      const n2ow = res();
      const nActive = document.getElementById('convert-dir-n').classList.contains('is-active');
      document.getElementById('convert-dir-ow').click();
      const back = res();
      document.getElementById('convert-dir-n').click();
      document.getElementById('convert-locate').click();
      return { ow, n2ow, back, nActive };
    });
    if (opened.ow !== 'X 10   Z 10') {
      throw new Error(`主世界→下界 80,80 应为「X 10 Z 10」，实际「${opened.ow}」`);
    }
    if (opened.n2ow !== 'X 640   Z 640') {
      throw new Error(`下界→主世界 80,80 应为「X 640 Z 640」，实际「${opened.n2ow}」`);
    }
    if (opened.back !== 'X 10   Z 10') {
      throw new Error(`切回 ÷8 后应为「X 10 Z 10」，实际「${opened.back}」`);
    }
    if (!opened.nActive) throw new Error('点「下界 → 主世界」后按钮未高亮');
    await page.settle(1400);
    const center = await page.evalFn(() => window.__mapApp.worldAtViewCenter());
    if (!center || Math.abs(center.x - 640) > 4 || Math.abs(center.z - 640) > 4) {
      throw new Error(`定位到 640,640 失败，视野中心 ${JSON.stringify(center)}`);
    }
    return '÷8 → 10/10 · ×8 → 640/640 · 定位到 640,640';
  });

  // 回归：面板按钮在 #viewport 内，若 viewer.js 的 IGNORE_SELECTOR 漏掉 .convert-panel，
  // pointerdown 会触发 setPointerCapture，真实鼠标点击永远点不到按钮（合成 .click() 则不受影响）。
  await checkIfReady('convert.real-click', '换算：方向按钮真实鼠标点击可切换（指针捕获回归）', async () => {
    await page.evalFn(() => {
      const p = document.getElementById('convert-panel');
      if (p.hidden) document.getElementById('btn-convert').click();
    });
    await page.settle(320);
    const clickCenter = async (id) => {
      const pt = await page.evalFn((sel) => {
        const el = document.getElementById(sel);
        if (!el) throw new Error(`缺少 #${sel}`);
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) throw new Error(`#${sel} 不可见`);
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, id);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await page.settle(160);
    };
    await clickCenter('convert-dir-n');
    const afterN = await page.evalFn(() => document.getElementById('convert-dir-n').classList.contains('is-active'));
    if (!afterN) throw new Error('真实点击「下界 → 主世界（×8）」后按钮未激活（viewer 指针捕获吞掉了 click）');
    await clickCenter('convert-dir-ow');
    const afterOw = await page.evalFn(() => document.getElementById('convert-dir-ow').classList.contains('is-active'));
    if (!afterOw) throw new Error('真实点击「主世界 → 下界（÷8）」后按钮未激活');
    await page.evalFn(() => document.getElementById('convert-close').click());
    return '真实鼠标点击 ×8 / ÷8 各一次，方向均正确切换';
  });

  await checkIfReady('convert.prefill', '换算：下界维度打开面板自动切 ×8 并预填下界坐标', async () => {
    await page.evalFn(() => window.__mapApp.applyDimension('nether'));
    await page.settle(320);
    const state = await page.evalFn(() => {
      document.getElementById('convert-close').click();
      const x = document.getElementById('convert-x');
      const z = document.getElementById('convert-z');
      x.value = '';
      z.value = '';
      x.dispatchEvent(new Event('input', { bubbles: true }));
      z.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-convert').click();
      const nActive = document.getElementById('convert-dir-n').classList.contains('is-active');
      const prefX = x.value;
      const prefZ = z.value;
      const preResult = document.getElementById('convert-result').textContent;
      x.value = '100';
      z.value = '100';
      x.dispatchEvent(new Event('input', { bubbles: true }));
      z.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        nActive,
        prefX,
        prefZ,
        preResult,
        result: document.getElementById('convert-result').textContent,
      };
    });
    if (!state.nActive) throw new Error('在下界维度打开面板，「下界 → 主世界」方向应自动选中');
    if (!(state.prefX !== '' && state.prefZ !== '')) {
      throw new Error(`打开时应预填当前视野中心，实际 X="${state.prefX}" Z="${state.prefZ}"`);
    }
    if (state.preResult === '—') throw new Error('预填后应有换算结果');
    if (state.result !== 'X 800   Z 800') {
      throw new Error(`下界 100,100 按 ×8 应为「X 800 Z 800」，实际「${state.result}」`);
    }
    return `预填 (${state.prefX}, ${state.prefZ}) · 方向自动 ×8 · 100 → 800`;
  });

  await checkIfReady('convert.oob', '换算：定位到画幅外时提示且不移动视野', async () => {
    const setup = await page.evalFn(() => {
      const x = document.getElementById('convert-x');
      const z = document.getElementById('convert-z');
      x.value = '500';
      z.value = '500';
      x.dispatchEvent(new Event('input', { bubbles: true }));
      z.dispatchEvent(new Event('input', { bubbles: true }));
      const before = window.__mapApp.worldAtViewCenter();
      document.getElementById('convert-locate').click();
      const toast = document.getElementById('toast');
      return {
        before,
        result: document.getElementById('convert-result').textContent,
        toastShown: toast ? toast.classList.contains('is-show') : false,
        toastText: toast ? toast.textContent : '',
      };
    });
    if (setup.result !== 'X 4000   Z 4000') {
      throw new Error(`下界 500,500 按 ×8 应为「X 4000 Z 4000」，实际「${setup.result}」`);
    }
    if (!setup.toastShown || !/画幅/.test(setup.toastText)) {
      throw new Error(`定位到画幅外应有提示，实际 toastShown=${setup.toastShown} text="${setup.toastText}"`);
    }
    await page.settle(600);
    const after = await page.evalFn(() => window.__mapApp.worldAtViewCenter());
    if (after.x !== setup.before.x || after.z !== setup.before.z) {
      throw new Error(`画幅外定位不应移动视野：${JSON.stringify(setup.before)} → ${JSON.stringify(after)}`);
    }
    await page.evalFn(() => {
      document.getElementById('convert-close').click();
      window.__mapApp.applyDimension('overworld');
    });
    await page.settle(320);
    return `toast「${setup.toastText}」· 视野保持 ${JSON.stringify(setup.before)}`;
  });

  /* ---------------- 6.5 皮肤预览 ---------------- */
  await checkIfReady(
    'skin.panel',
    '皮肤预览：互斥开合、非法 ID 报错、离线导入（64×64 / 64×32 / 128×128）、默认静止、动作按钮、旋转开关与左键拖拽停转、回正复位相机、右键平移不穿透、Esc 关闭',
    async () => {
      const skinErrorsAtStart = await errorCount();
      const clickCenter = async (id) => {
        const pt = await page.evalFn((sel) => {
          const el = document.getElementById(sel);
          if (!el) throw new Error(`缺少 #${sel}`);
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) throw new Error(`#${sel} 不可见`);
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }, id);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' });
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await page.settle(160);
      };
      const readButtons = async () =>
        page.evalFn(() => ({
          walk: document.getElementById('skin-act-walk').getAttribute('aria-pressed'),
          run: document.getElementById('skin-act-run').getAttribute('aria-pressed'),
          idle: document.getElementById('skin-act-idle').getAttribute('aria-pressed'),
          rotate: document.getElementById('skin-act-rotate').getAttribute('aria-pressed'),
        }));

      // 先真实点击打开换算面板，再点「皮肤」验证互斥收起
      await clickCenter('btn-convert');
      const convertOpen = await page.evalFn(() => !document.getElementById('convert-panel').hidden);
      if (!convertOpen) throw new Error('换算面板未打开（互斥测试的前置条件失败）');
      await clickCenter('btn-skin');
      const opened = await page.evalFn(() => ({
        skin: !document.getElementById('skin-panel').hidden,
        skinPressed: document.getElementById('btn-skin').getAttribute('aria-pressed'),
        convert: document.getElementById('convert-panel').hidden,
        convertPressed: document.getElementById('btn-convert').getAttribute('aria-pressed'),
      }));
      if (!opened.skin || opened.skinPressed !== 'true') {
        throw new Error(`点「皮肤」后面板未打开（skin=${opened.skin} pressed=${opened.skinPressed}）`);
      }
      if (!opened.convert || opened.convertPressed !== 'false') {
        throw new Error(`皮肤面板打开时换算面板应互斥收起（convert=${opened.convert} pressed=${opened.convertPressed}）`);
      }

      // 打开面板即预热 3D 库（懒加载）：脚本到位、全局可用
      // 注意：不能用 performance resource 条目判断——此前的瓦片请求早已把
      // 默认 250 条的 resource timing 缓冲区占满，新条目会被丢弃。
      await page.waitFor(
        () =>
          !!window.skinview3d &&
          typeof window.skinview3d.SkinViewer === 'function' &&
          !!document.querySelector('script[src*="skinview3d.bundle.js"]'),
        { timeout: 10_000, interval: 100, label: '皮肤 3D 库懒加载完成' },
      );

      // 非法 ID 走本地校验，不发网络请求（离线安全）
      await page.evalFn(() => {
        document.getElementById('skin-id').value = 'a-b';
      });
      await clickCenter('skin-load');
      const badStatus = await page.evalFn(() => {
        const s = document.getElementById('skin-status');
        return { text: s.textContent, error: s.classList.contains('is-error') };
      });
      if (!badStatus.error || !/ID 无效/.test(badStatus.text)) {
        throw new Error(`非法 ID 应报错，实际 status="${badStatus.text}"`);
      }

      // 页内生成 64×64 PNG → DataTransfer 导入（离线主力路径）
      await page.evalFn(async () => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#4caf50';
        ctx.fillRect(8, 8, 8, 8); // 头前脸
        ctx.fillStyle = '#2196f3';
        ctx.fillRect(20, 20, 8, 12); // 身体前脸
        const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
        const file = new File([blob], 'smoke-skin.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('skin-file');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitFor(
        () => {
          const panel = window.__mapApp && window.__mapApp.skin;
          const viewer = panel ? panel.getViewer() : null;
          const s = document.getElementById('skin-status');
          return (
            viewer &&
            viewer.playerObject &&
            viewer.playerObject.skin &&
            viewer.playerObject.skin.visible &&
            s.classList.contains('is-ok') &&
            /64×64/.test(s.textContent)
          );
        },
        { timeout: 10_000, interval: 150, label: '皮肤导入完成且 3D 查看器就绪' },
      );
      const imported = await page.evalFn(() => ({
        status: document.getElementById('skin-status').textContent,
        fileName: document.getElementById('skin-file-name').textContent,
        autoRotate: window.__mapApp.skin.getViewer().autoRotate,
        animMode: window.__mapApp.skin.getAnimMode(),
        isRotating: window.__mapApp.skin.isRotating(),
      }));
      if (!imported.fileName.includes('smoke-skin.png')) {
        throw new Error(`导入文件名未显示（实际 "${imported.fileName}"）`);
      }
      if (imported.autoRotate !== false || imported.isRotating !== false) {
        throw new Error(`导入后默认应静止不旋转（实际 autoRotate=${imported.autoRotate}）`);
      }
      if (imported.animMode !== 'idle') {
        throw new Error(`导入后默认动画应为静止（实际 ${imported.animMode}）`);
      }

      // 记录初始相机位姿（回正按钮的对照基准：viewer 创建后相机未动过）
      const camInit = await page.evalFn(() => {
        const c = window.__mapApp.skin.getViewer().camera.position;
        return { x: c.x, y: c.y, z: c.z };
      });

      // 按钮初始状态：静止 active，其余不 active
      const btnInit = await readButtons();
      if (btnInit.walk !== 'false' || btnInit.run !== 'false' || btnInit.idle !== 'true' || btnInit.rotate !== 'false') {
        throw new Error(`初始按钮状态不符：${JSON.stringify(btnInit)}`);
      }

      // 真实点击 走路 → 奔跑 → 静止：动画实例更换 + aria-pressed 迁移
      const animInit = await page.evalFn(() => window.__mapApp.skin.getViewer().animation);
      await clickCenter('skin-act-walk');
      const walkState = await page.evalFn(() => ({
        mode: window.__mapApp.skin.getAnimMode(),
        animation: window.__mapApp.skin.getViewer().animation,
      }));
      const walkBtn = await readButtons();
      if (walkState.mode !== 'walk' || !walkState.animation) {
        throw new Error(`点「走路」后动画未生效（mode=${walkState.mode} animation=${!!walkState.animation}）`);
      }
      if (walkBtn.walk !== 'true' || walkBtn.idle !== 'false') {
        throw new Error(`点「走路」后按钮状态不符：${JSON.stringify(walkBtn)}`);
      }
      if (walkState.animation === animInit) throw new Error('走路动画实例未更换');
      await clickCenter('skin-act-run');
      const runState = await page.evalFn(() => ({
        mode: window.__mapApp.skin.getAnimMode(),
        animation: window.__mapApp.skin.getViewer().animation,
      }));
      const runBtn = await readButtons();
      if (runState.mode !== 'run' || !runState.animation || runState.animation === walkState.animation) {
        throw new Error(`点「奔跑」后动画未切换（mode=${runState.mode}）`);
      }
      if (runBtn.run !== 'true' || runBtn.walk !== 'false') {
        throw new Error(`点「奔跑」后按钮状态不符：${JSON.stringify(runBtn)}`);
      }
      await clickCenter('skin-act-idle');
      const idleState = await page.evalFn(() => ({
        mode: window.__mapApp.skin.getAnimMode(),
        animation: window.__mapApp.skin.getViewer().animation,
      }));
      const idleBtn = await readButtons();
      if (idleState.mode !== 'idle' || !idleState.animation || idleState.animation === runState.animation) {
        throw new Error(`点「静止」后动画未切换（mode=${idleState.mode}）`);
      }
      if (idleBtn.idle !== 'true' || idleBtn.run !== 'false') {
        throw new Error(`点「静止」后按钮状态不符：${JSON.stringify(idleBtn)}`);
      }

      // 旋转开关：真实点击开 → autoRotate=true + 按钮 active
      await clickCenter('skin-act-rotate');
      const rotateOn = await page.evalFn(() => ({
        autoRotate: window.__mapApp.skin.getViewer().autoRotate,
        pressed: document.getElementById('skin-act-rotate').getAttribute('aria-pressed'),
      }));
      if (rotateOn.autoRotate !== true || rotateOn.pressed !== 'true') {
        throw new Error(`点「旋转」后应自动旋转（autoRotate=${rotateOn.autoRotate} pressed=${rotateOn.pressed}）`);
      }

      // 左键拖拽画布：自动旋转停转 + 按钮复位 + 不穿透到地图
      const stage = await page.evalFn(() => {
        const r = document.getElementById('skin-canvas').getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      const before = await page.evalFn(() => window.__mapApp.worldAtViewCenter());
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x, y: stage.y, button: 'none' });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: stage.x, y: stage.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x + 60, y: stage.y - 40, button: 'left' });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stage.x + 60, y: stage.y - 40, button: 'left', clickCount: 1 });
      await page.settle(250);
      const afterDrag = await page.evalFn(() => ({
        autoRotate: window.__mapApp.skin.getViewer().autoRotate,
        rotatePressed: document.getElementById('skin-act-rotate').getAttribute('aria-pressed'),
        center: window.__mapApp.worldAtViewCenter(),
      }));
      if (afterDrag.autoRotate !== false || afterDrag.rotatePressed !== 'false') {
        throw new Error(`左键拖拽后应停转并复位按钮（autoRotate=${afterDrag.autoRotate} pressed=${afterDrag.rotatePressed}）`);
      }
      if (
        !before || !afterDrag.center ||
        before.x !== afterDrag.center.x || before.z !== afterDrag.center.z
      ) {
        throw new Error(
          `皮肤画布拖拽不应移动地图视野（${JSON.stringify(before)} → ${JSON.stringify(afterDrag.center)}）`,
        );
      }

      // 右键拖拽画布：平移相机（camera.position 变化）+ 地图视野不动
      const camBefore = await page.evalFn(() => {
        const c = window.__mapApp.skin.getViewer().camera.position;
        return { x: c.x, y: c.y, z: c.z };
      });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x, y: stage.y, button: 'none' });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: stage.x, y: stage.y, button: 'right', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x + 40, y: stage.y + 25, button: 'right' });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stage.x + 40, y: stage.y + 25, button: 'right', clickCount: 1 });
      await page.settle(250);
      const afterPan = await page.evalFn(() => {
        const c = window.__mapApp.skin.getViewer().camera.position;
        return { x: c.x, y: c.y, z: c.z, center: window.__mapApp.worldAtViewCenter() };
      });
      const camDelta =
        Math.abs(afterPan.x - camBefore.x) +
        Math.abs(afterPan.y - camBefore.y) +
        Math.abs(afterPan.z - camBefore.z);
      if (camDelta < 0.01) {
        throw new Error(`右键拖拽应平移相机（camera.position 未变化：${JSON.stringify(camBefore)}）`);
      }
      if (
        !before || !afterPan.center ||
        before.x !== afterPan.center.x || before.z !== afterPan.center.z
      ) {
        throw new Error(
          `皮肤画布右键平移不应移动地图视野（${JSON.stringify(before)} → ${JSON.stringify(afterPan.center)}）`,
        );
      }

      // 回正按钮：旋转开启时点击 → 停转复位 + 相机回到初始位姿 + 模型转回正面
      // （skinview3d 3.4.2 的 autoRotate 转的是 playerWrapper 模型，不是相机）
      await clickCenter('skin-act-rotate'); // 再开旋转（此时相机已被拖拽/平移改过）
      const modelYawBefore = await page.evalFn(() => {
        const v = window.__mapApp.skin.getViewer();
        return v.playerWrapper ? v.playerWrapper.rotation.y : null;
      });
      await clickCenter('skin-act-reset');
      await page.settle(160);
      const afterReset = await page.evalFn(() => {
        const v = window.__mapApp.skin.getViewer();
        const c = v.camera.position;
        return {
          x: c.x,
          y: c.y,
          z: c.z,
          autoRotate: v.autoRotate,
          rotatePressed: document.getElementById('skin-act-rotate').getAttribute('aria-pressed'),
          modelYaw: v.playerWrapper ? v.playerWrapper.rotation.y : null,
        };
      });
      const resetDelta =
        Math.abs(afterReset.x - camInit.x) +
        Math.abs(afterReset.y - camInit.y) +
        Math.abs(afterReset.z - camInit.z);
      if (resetDelta > 0.01) {
        throw new Error(`回正后相机未回到初始位姿（${JSON.stringify(camInit)} → ${JSON.stringify(afterReset)}）`);
      }
      if (afterReset.autoRotate !== false || afterReset.rotatePressed !== 'false') {
        throw new Error(`回正应停转并复位旋转按钮（autoRotate=${afterReset.autoRotate} pressed=${afterReset.rotatePressed}）`);
      }
      if (modelYawBefore === null || Math.abs(modelYawBefore) < 0.05) {
        throw new Error(`旋转开启后模型应已转动（yaw=${modelYawBefore}），否则回正断言无意义`);
      }
      if (Math.abs(afterReset.modelYaw) > 0.001) {
        throw new Error(`回正后模型应转回正面（yaw=${afterReset.modelYaw}）`);
      }

      // 旧版 64×32 皮肤导入：应自动补全为 64×64 并正常渲染
      await page.evalFn(async () => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 32;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#4caf50';
        ctx.fillRect(8, 8, 8, 8); // 头前脸
        ctx.fillStyle = '#e91e63';
        ctx.fillRect(20, 20, 8, 12); // 身体前脸
        ctx.fillStyle = '#ff9800';
        ctx.fillRect(44, 20, 4, 12); // 右臂前脸（补全后应镜像到左臂）
        ctx.fillRect(4, 20, 4, 12); // 右腿前脸（补全后应镜像到左腿）
        const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
        const file = new File([blob], 'smoke-legacy.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('skin-file');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitFor(
        () => {
          const s = document.getElementById('skin-status');
          return s.classList.contains('is-ok') && /旧版，已补全为 64×64/.test(s.textContent);
        },
        { timeout: 10_000, interval: 150, label: '旧版 64×32 皮肤补全并渲染完成' },
      );
      const legacy = await page.evalFn(() => ({
        status: document.getElementById('skin-status').textContent,
        visible: window.__mapApp.skin.getViewer().playerObject.skin.visible,
      }));
      if (!legacy.visible) throw new Error('旧版皮肤补全后未渲染（skin.visible=false）');

      // 128×128（HD）皮肤导入：原生渲染，不走补全路径
      await page.evalFn(async () => {
        const c = document.createElement('canvas');
        c.width = 128;
        c.height = 128;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#e91e63';
        ctx.fillRect(16, 16, 16, 16); // 头前脸（128 空间）
        ctx.fillStyle = '#4caf50';
        ctx.fillRect(40, 40, 16, 24); // 身体前脸
        const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
        const file = new File([blob], 'smoke-hd128.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('skin-file');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitFor(
        () => {
          const s = document.getElementById('skin-status');
          return s.classList.contains('is-ok') && /128×128/.test(s.textContent);
        },
        { timeout: 10_000, interval: 150, label: '128×128 HD 皮肤导入并渲染完成' },
      );
      const hd = await page.evalFn(() => ({
        status: document.getElementById('skin-status').textContent,
        visible: window.__mapApp.skin.getViewer().playerObject.skin.visible,
      }));
      if (!hd.visible) throw new Error('128×128 皮肤未渲染（skin.visible=false）');
      if (/补全/.test(hd.status)) throw new Error(`128×128 不应走补全路径（status="${hd.status}"）`);

      // Esc 关闭并复位按钮
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.settle(160);
      const closed = await page.evalFn(() => ({
        hidden: document.getElementById('skin-panel').hidden,
        pressed: document.getElementById('btn-skin').getAttribute('aria-pressed'),
      }));
      if (!closed.hidden || closed.pressed !== 'false') {
        throw new Error(`Esc 后面板应关闭且按钮复位（hidden=${closed.hidden} pressed=${closed.pressed}）`);
      }

      await expectNoErrorsSince(skinErrorsAtStart, '皮肤预览');
      return `导入 ${imported.fileName}（${imported.status}）· 旧版 64×32 补全（${legacy.status}）· 128×128 HD（${hd.status}）· 默认静止 · 动作/旋转/回正按钮正常 · 右键平移不穿透 · 互斥与 Esc 正常`;
    },
  );

  /* ---------------- 7. 窄屏 ---------------- */
  await checkIfReady(
    'narrow.layout',
    '390×844 窄屏：#viewport 宽 ≈ window.innerWidth、无横向溢出、侧栏可开合',
    async () => {
      await page.evalFn(() => {
        const search = document.querySelector('#waypoint-search');
        if (search) search.blur();
      }).catch(() => {});
      // Lead 实测：mobile true/false 结果一致，false 更少 emulation 干扰
      await page.setViewport({ width: 390, height: 844, mobile: false });
      await page.settle(320);

      const problems = [];
      const readNarrow = async () => {
        const layout = await page.evalFn(LAYOUT);
        const scrollWidth = await page.evaluate(
          'document.scrollingElement ? document.scrollingElement.scrollWidth : document.documentElement.scrollWidth',
        );
        return { layout, scrollWidth };
      };
      const checkLayout = (state, phase) => {
        const { layout, scrollWidth } = state;
        if (layout.innerWidth !== 390) {
          problems.push(`${phase}：window.innerWidth=${layout.innerWidth}，期望 390`);
        }
        if (!layout.viewport) {
          problems.push(`${phase}：找不到 #viewport`);
        } else if (Math.abs(layout.viewport.width - layout.innerWidth) > 1) {
          problems.push(
            `${phase}：#viewport 宽 ${layout.viewport.width.toFixed(1)}px，` +
              `期望 ≈ window.innerWidth ${layout.innerWidth}px（差 ${(layout.viewport.width - layout.innerWidth).toFixed(1)}px）`,
          );
        }
        if (scrollWidth > layout.innerWidth + 1) {
          problems.push(
            `${phase}：存在横向溢出，document.scrollingElement.scrollWidth=${scrollWidth}px，` +
              `期望 ≤ ${layout.innerWidth + 1}px`,
          );
        }
      };

      // ① 收起抽屉：此时地图必须铺满可用宽度
      await closeSidebarForTest();
      const closedState = await readNarrow();
      checkLayout(closedState, '侧栏收起时');
      if (closedState.layout.sidebarShadow !== 'none') {
        problems.push(
          `侧栏收起时仍有投影（${closedState.layout.sidebarShadow}）：` +
            '元素移出屏幕后阴影会漏在左缘形成暗影，只应在抽屉打开时出现',
        );
      }
      if (problems.length > 0) throw new Error(problems.join('；'));

      // ② 打开抽屉：移动端是 fixed 覆盖层，不应挤占地图
      const opened = await openSidebarForTest();
      if (!isSidebarOpenState(opened)) {
        throw new Error(
          `点击 #sidebar-toggle 后侧栏未打开（body[data-sidebar]=${opened.bodySidebar}，` +
            `left=${Math.round(opened.sidebar?.left ?? NaN)}px）`,
        );
      }
      const openedState = await readNarrow();
      checkLayout(openedState, '抽屉打开时');
      if (!openedState.layout.sidebarShadow || openedState.layout.sidebarShadow === 'none') {
        problems.push('抽屉打开时侧栏缺少投影（阴影应只在打开态出现）');
      }
      if (!openedState.layout.sidebar || !(openedState.layout.sidebar.width > 100)) {
        problems.push(
          `抽屉打开时侧栏宽度 ${openedState.layout.sidebar?.width ?? 0}px，期望 > 100px`,
        );
      }
      if (problems.length > 0) throw new Error(problems.join('；'));

      // ③ 再收起：布局应完全恢复
      await closeSidebarForTest();
      const closedAgainState = await readNarrow();
      checkLayout(closedAgainState, '再次收起后');
      if (
        Math.abs(closedAgainState.layout.viewport.width - closedState.layout.viewport.width) > 2
      ) {
        problems.push(
          `开合侧栏后地图宽度未恢复：${closedState.layout.viewport.width.toFixed(1)}px → ` +
            `${closedAgainState.layout.viewport.width.toFixed(1)}px`,
        );
      }
      if (problems.length > 0) throw new Error(problems.join('；'));

      await page.screenshot(path.join(artifactsDir, 'ok-narrow.png'));
      return (
        `窗口 ${closedState.layout.innerWidth}px，侧栏收起/打开/收起时地图分别 ` +
        `${closedState.layout.viewport.width.toFixed(0)} / ${openedState.layout.viewport.width.toFixed(0)} / ` +
        `${closedAgainState.layout.viewport.width.toFixed(0)}px；` +
        `body[data-sidebar] ${closedState.layout.bodySidebar} → ${openedState.layout.bodySidebar} → ${closedAgainState.layout.bodySidebar}`
      );
    },
  );

  // 窄屏顶栏空间不足：维度切换必须完整可点；皮肤/换算收进侧栏抽屉，桌面恢复原位
  await checkIfReady(
    'narrow.toolbar',
    '窄屏三个维度按钮完整可点；皮肤/换算收进侧栏（启动即收起抽屉）；桌面恢复原位',
    async () => {
      const readDims = () => page.evalFn(() => {
        const sw = document.querySelector('#dimension-switch');
        if (!sw) return null;
        const box = sw.getBoundingClientRect();
        return [...sw.querySelectorAll('button')].map((b) => {
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            text: (b.textContent || '').trim(),
            full:
              r.width > 0 &&
              r.left >= box.left - 1 && r.right <= box.right + 1 &&
              r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
            hitSelf: !!(hit && (hit === b || b.contains(hit))),
          };
        });
      });

      const clickDim = async (label) => {
        const pt = await page.evalFn((text) => {
          const b = [...document.querySelectorAll('#dimension-switch button')]
            .find((el) => (el.textContent || '').trim() === text);
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, label);
        if (!pt) throw new Error(`找不到维度按钮「${label}」`);
        await page.click(pt.x, pt.y);
        await page.settle(420);
        return page.evalFn(() => document.body.dataset.dimension);
      };

      await page.setViewport({ width: 390, height: 844, mobile: false });
      await page.settle(320);
      await closeSidebarForTest();

      const dims390 = await readDims();
      if (!dims390 || dims390.length !== 3) {
        throw new Error(`390px 维度按钮 ${dims390?.length ?? 0} 个，期望 3`);
      }
      const clipped = dims390.filter((b) => !b.full || !b.hitSelf);
      if (clipped.length) {
        throw new Error(
          `390px 维度按钮不完整/不可点：${clipped
            .map((b) => `${b.text}(完整=${b.full},命中=${b.hitSelf})`)
            .join('、')}（疑似被窄屏顶栏挤压，见 narrow.toolbar 说明）`,
        );
      }

      const dimBefore = await page.evalFn(() => document.body.dataset.dimension);
      const other = dimBefore === 'the_end' ? '主世界' : '末地';
      const dimSwitched = await clickDim(other);
      if (dimSwitched === dimBefore) throw new Error(`真实点击「${other}」后维度仍是 ${dimBefore}`);
      await clickDim('主世界');

      const placement = await page.evalFn(() => ({
        toolsHidden: document.querySelector('#sidebar-tools')?.hidden !== false,
        skinParent: document.querySelector('#btn-skin')?.parentElement?.id || '',
        convertParent: document.querySelector('#btn-convert')?.parentElement?.id || '',
      }));
      if (placement.toolsHidden || placement.skinParent !== 'sidebar-tools' || placement.convertParent !== 'sidebar-tools') {
        throw new Error(`390px 皮肤/换算未收进侧栏：${JSON.stringify(placement)}`);
      }

      await openSidebarForTest();
      const tools = await page.evalFn(() =>
        ['btn-skin', 'btn-convert'].map((id) => {
          const b = document.getElementById(id);
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            id,
            visible: r.width > 0 && r.height > 0,
            hitSelf: !!(hit && (hit === b || b.contains(hit))),
          };
        }),
      );
      const deadTools = tools.filter((t) => !t.visible || !t.hitSelf);
      if (deadTools.length) throw new Error(`侧栏工具不可点：${deadTools.map((t) => t.id).join('、')}`);

      const skinPt = await page.evalFn(() => {
        const r = document.getElementById('btn-skin').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.click(skinPt.x, skinPt.y);
      await page.settle(420);
      const launched = await page.evalFn(() => ({
        drawer: document.body.dataset.sidebar,
        skinOpen: !document.querySelector('#skin-panel')?.hidden,
      }));
      if (launched.drawer !== 'collapsed' || !launched.skinOpen) {
        throw new Error(
          `从抽屉启动皮肤后：抽屉=${launched.drawer}，面板=${launched.skinOpen ? '开' : '关'}` +
            '（期望抽屉收起且面板打开，避免抽屉盖住面板）',
        );
      }
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.settle(320);

      await page.setViewport({ width: 360, height: 844, mobile: false });
      await page.settle(320);
      const dims360 = await readDims();
      const clipped360 = (dims360 || []).filter((b) => !b.full || !b.hitSelf);
      if (!dims360 || dims360.length !== 3 || clipped360.length) {
        throw new Error(
          `360px 维度按钮不完整/不可点：${clipped360.map((b) => b.text).join('、') || `数量 ${dims360?.length ?? 0}`}`,
        );
      }

      await page.setViewport({ ...VIEWPORT });
      await page.settle(420);
      const desktop = await page.evalFn(() => {
        const skin = document.querySelector('#btn-skin');
        const span = skin ? skin.querySelector('span') : null;
        return {
          toolsHidden: document.querySelector('#sidebar-tools')?.hidden !== false,
          skinParent: skin?.parentElement?.className || '',
          convertParent: document.querySelector('#btn-convert')?.parentElement?.className || '',
          labelDisplay: span ? getComputedStyle(span).display : 'none',
          order: [...document.querySelectorAll('.topbar-right > .btn')].map((b) => b.id),
        };
      });
      const expectedOrder = ['btn-measure', 'btn-skin', 'btn-copy-link', 'btn-convert', 'btn-theme'];
      if (
        !desktop.toolsHidden ||
        !desktop.skinParent.includes('topbar-right') ||
        !desktop.convertParent.includes('topbar-right') ||
        desktop.labelDisplay === 'none' ||
        desktop.order.join(',') !== expectedOrder.join(',')
      ) {
        throw new Error(`桌面未恢复原样：${JSON.stringify(desktop)}`);
      }

      return `390/360px 三维度完整可点；皮肤/换算在侧栏（启动后面板打开、抽屉收起）；桌面恢复 ${desktop.order.join(' / ')}`;
    },
  );

  // 窄屏的第二种现实路径：用户在桌面上收起了侧栏，之后把窗口拖窄（或手机端 startCollapsed）
  await checkIfReady('narrow.transition', '桌面收起侧栏后把窗口缩到 390px，地图仍然可用（不塌缩）', async () => {
    await page.setViewport({ ...VIEWPORT });
    await page.settle(280);
    await ensureSidebarOpen();
    await page.evalFn(() => document.querySelector('#btn-collapse')?.click());
    await page.settle(380);
    if (isSidebarOpenState(await sidebarState())) {
      throw new Error('桌面下点击 #btn-collapse 后侧栏未收起');
    }

    await page.setViewport({ width: 390, height: 844, mobile: true });
    await page.settle(380);
    const narrow = await page.evalFn(LAYOUT);
    const grid = await page.evalFn(
      () => getComputedStyle(document.querySelector('.body')).gridTemplateColumns,
    );
    if (!narrow.viewport || !(narrow.viewport.width > 150)) {
      throw new Error(
        `桌面收起侧栏 → 缩窄到 390px 后地图可视区域宽 ${Math.round(narrow.viewport?.width ?? 0)}px` +
          `（.body grid-template-columns=${grid}，body[data-sidebar]=${narrow.bodySidebar}；` +
          `疑似桌面端 body[data-sidebar="collapsed"] .body 的多列规则在 ≤860px 断点仍生效）`,
      );
    }
    return `地图 ${narrow.viewport.width.toFixed(0)}px（窗口 ${narrow.innerWidth}px）`;
  });

  /* ---------------- 7b. 主题切换（持久化 + 系统偏好） ---------------- */
  // 与其它 UI 断言一致：必须真实鼠标点击（合成 .click() 会绕过部分事件路径）。
  // 结束时把主题、localStorage 与系统偏好模拟全部还原，不影响后续检查。
  await checkIfReady('theme.toggle', '主题：真实点击切换、localStorage 持久化、系统偏好跟随', async () => {
    await page.setViewport({ ...VIEWPORT });
    await page.settle(280);
    const clickTheme = async () => {
      const pt = await page.evalFn(() => {
        const el = document.getElementById('btn-theme');
        if (!el) throw new Error('缺少 #btn-theme');
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) throw new Error('#btn-theme 不可见');
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await page.settle(220);
    };
    const readState = () => page.evalFn(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      saved: (() => { try { return localStorage.getItem('ssmap-theme'); } catch (e) { return null; } })(),
      icon: document.querySelector('#btn-theme use')?.getAttribute('href') ?? null,
      pressed: document.getElementById('btn-theme')?.getAttribute('aria-pressed') ?? null,
    }));
    const setScheme = async (scheme) => {
      await page.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await page.settle(420);
    };

    // 起点状态（--keep 模式下可能有残留保存值），结束时原样恢复
    const boot = await readState();
    const bootLight = boot.theme === 'light';
    const opposite = bootLight ? 'dark' : 'light';
    const name = (light) => (light ? 'light' : 'dark');

    // 1. 清除保存值后模拟相反系统偏好 → 主题实时跟随
    await page.evalFn(() => localStorage.removeItem('ssmap-theme'));
    await setScheme(opposite);
    let s = await readState();
    if (s.theme !== opposite) {
      throw new Error(`无保存值时系统偏好 ${opposite} 应实时跟随，实际 ${s.theme}`);
    }

    // 2. 真实点击 → 回到起点主题并写入 localStorage，按钮状态同步
    await clickTheme();
    s = await readState();
    if (s.theme !== name(bootLight) || s.saved !== name(bootLight)) {
      throw new Error(`点击后应为 ${name(bootLight)} 且保存 ${name(bootLight)}，实际 ${JSON.stringify(s)}`);
    }
    if (s.icon !== (bootLight ? '#i-moon' : '#i-sun') || s.pressed !== String(bootLight)) {
      throw new Error(`按钮状态未同步：图标 ${s.icon} / aria-pressed ${s.pressed}`);
    }

    // 3. 已有保存值后系统偏好再变 → 不跟随
    await setScheme(opposite);
    s = await readState();
    if (s.theme !== name(bootLight)) {
      throw new Error(`手动选择后系统偏好变化不应覆盖，实际 ${s.theme}`);
    }

    // 4. 再点一次 → 切到另一主题并保存
    await clickTheme();
    s = await readState();
    if (s.theme !== opposite || s.saved !== opposite) {
      throw new Error(`再次点击应切到 ${opposite} 并保存，实际 ${JSON.stringify(s)}`);
    }

    // 5. 还原：主题/按钮/保存值/系统模拟全部回到起点状态
    await page.evalFn((restore) => {
      if (restore.saved !== null) localStorage.setItem('ssmap-theme', restore.saved);
      else localStorage.removeItem('ssmap-theme');
      document.documentElement.setAttribute('data-theme', restore.theme);
      const btn = document.getElementById('btn-theme');
      if (btn) {
        const light = restore.theme === 'light';
        btn.setAttribute('aria-pressed', String(light));
        btn.title = light ? '切换为深色模式' : '切换为浅色模式';
        const use = btn.querySelector('use');
        if (use) use.setAttribute('href', light ? '#i-moon' : '#i-sun');
      }
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', restore.theme === 'light' ? '#e9ede6' : '#0f1210');
    }, { theme: boot.theme, saved: boot.saved });
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    await page.settle(420);
    s = await readState();
    if (s.theme !== boot.theme || s.saved !== boot.saved) {
      throw new Error(
        `还原后应为 ${JSON.stringify({ theme: boot.theme, saved: boot.saved })}，实际 ${JSON.stringify({ theme: s.theme, saved: s.saved })}`,
      );
    }
    return `跟随系统 ${opposite} → 点击存 ${name(bootLight)} → 系统变化不覆盖 → 再点 ${opposite} → 全部还原`;
  });

  /* ---------------- 8. 全程 console error ---------------- */
  await check('run.console', '整个测试过程无 console error / 未捕获异常 / 未处理 Promise 拒绝', async () => {
    const detail = await expectNoErrorsSince(0, '全程');
    // 顺带把瓦片层的累计数据打出来，方便对照「请求数 / 404 数 / 缓存」
    const tileStats = await page
      .evaluate('(window.__mapApp && window.__mapApp.tiles) ? window.__mapApp.tiles() : null')
      .catch(() => null);
    if (!tileStats) return detail;
    return (
      `${detail}；瓦片请求 ${tileStats.requests} 次（404 ${tileStats.missing}，` +
      `解码 ${tileStats.loaded}，缓存 ${tileStats.cache}/${tileStats.maxTiles}）`
    );
  });

  /* ---------------- 9. 截图（仅全程成功时） ---------------- */
  if (rep.failed.length > 0) {
    rep.skip(
      '成功截图 tests/artifacts/ok-desktop.png',
      `存在 ${rep.failed.length} 个失败项，已保存对应的 error-*.png`,
    );
  } else {
    await check('artifacts.screenshot', '恢复桌面视口并保存成功截图 tests/artifacts/ok-desktop.png', async () => {
      await page.setViewport({ ...VIEWPORT });
      await page.evalFn(() => {
        document.querySelector('#btn-collapse')?.click?.();
      }).catch(() => {});
      await page.settle(260);
      const ok = await ensureSidebarOpen();
      if (!ok) {
        await page.clickSelector('#sidebar-toggle');
        await page.settle(300);
      }
      await resetView();
      const file = await page.screenshot(path.join(artifactsDir, 'ok-desktop.png'));
      const stat = await fsp.stat(file);
      if (!(stat.size > 1000)) throw new Error(`截图文件过小：${stat.size} 字节`);
      return `${file}（${(stat.size / 1024).toFixed(0)} KB）`;
    });
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

let interrupted = false;
process.on('SIGINT', async () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log('\n收到 Ctrl+C，正在清理浏览器与服务器…');
  await teardown();
  process.exit(130);
});

main()
  .then(async (summary) => {
    const finalSummary = rep.summary();
    await writeReport();
    await teardown();
    console.log('');
    if (reportPath) console.log(`  报告：${reportPath}`);
    if (finalSummary.fail > 0) {
      console.log(`  失败截图 / DOM dump 见 ${artifactsDir}`);
    }
    process.exitCode = finalSummary.ok ? 0 : 1;
  })
  .catch(async (error) => {
    console.error('');
    console.error('✗ smoke 运行中断：', error?.stack ?? error);
    try {
      await check('fatal', '测试脚本自身异常', () => {
        throw error;
      });
    } catch {
      /* ignore */
    }
    rep.summary();
    await writeReport({ fatal: String(error?.message ?? error) });
    await teardown();
    if (reportPath) console.log(`  报告：${reportPath}`);
    process.exitCode = 1;
  });
