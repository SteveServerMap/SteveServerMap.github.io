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

function IMAGE_INFO() {
  const img = document.querySelector('#map-image');
  const viewport = document.querySelector('#viewport');
  if (!img) return null;
  const rect = img.getBoundingClientRect();
  const viewRect = viewport ? viewport.getBoundingClientRect() : null;
  const stage = document.querySelector('#stage');
  return {
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    complete: img.complete,
    src: img.currentSrc || img.src,
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

function CAL_JSON() {
  const el = document.querySelector('#cal-json');
  if (!el) return { found: false };
  const raw = (el.textContent || '').trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!cleaned || cleaned === '—' || cleaned === '-') return { found: true, empty: true, raw };
  try {
    return { found: true, empty: false, raw, json: JSON.parse(cleaned) };
  } catch (error) {
    return { found: true, empty: false, raw, parseError: String(error) };
  }
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
  };
}

function DIMENSION_STATE() {
  const buttons = [...document.querySelectorAll('#dimension-switch button, #dimension-switch [role="tab"]')];
  const img = document.querySelector('#map-image');
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
    imageSrc: img ? img.currentSrc || img.src : null,
    imageNaturalWidth: img ? img.naturalWidth : 0,
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
  const cal = dimension.calibration;
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
    items.push(`[${error.kind}] ${truncate(error.text, 300)}${error.where ? ` @ ${truncate(error.where, 200)}` : ''}`);
  }
  for (const error of snapshot.injected) {
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
        calibrationNotice: pick('#calibration-notice'),
        calibrator: pick('#calibrator', 1200),
        calJson: pick('#cal-json'),
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

async function resetView() {
  const clicked = await page.evalFn(() => {
    const button = document.querySelector('#zoom-fit') || document.querySelector('#btn-fit');
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error('找不到「整图」按钮（#zoom-fit / #btn-fit）');
  await page.settle(260);
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
  '.marker, .marker-popup, .zoom-panel, .coord-readout, .map-hint, .scale-bar, .map-state, .modal';

/**
 * 在视口内找一个安全的落点：elementFromPoint 必须真正命中 #map-image
 * （而不是标记 / 弹窗 / 缩放面板 / 地图状态层）。
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
        if (el.id !== 'map-image') continue;
        return { x, y, hit: { tag: el.tagName, id: el.id, cls: String(el.className || '') } };
      }
      return null;
    },
    viewport,
    fractions,
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

/** 刷新 / 切换后等待应用就绪（维度按钮 + 基底图 + 标记都就位） */
async function waitForAppReady(label = '应用就绪') {
  return page.waitFor(
    () => {
      const buttons = document.querySelectorAll('#dimension-switch button, #dimension-switch [role="tab"]');
      const image = document.querySelector('#map-image');
      const markers = document.querySelectorAll('#overlay .marker');
      if (buttons.length < 3 || !image || !image.complete || image.naturalWidth <= 0 || markers.length === 0) {
        return null;
      }
      return { buttons: buttons.length, markers: markers.length, imageWidth: image.naturalWidth };
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

async function openCalibratorPanel(label = '#calibrator 可见') {
  await page.clickSelector('#btn-calibrate');
  return page.waitFor(
    () => {
      const el = document.querySelector('#calibrator');
      if (!el) return null;
      const style = getComputedStyle(el);
      if (el.hidden || style.display === 'none' || style.visibility === 'hidden') return null;
      const panel = el.querySelector('.modal-panel') ?? el.firstElementChild;
      const rect = panel ? panel.getBoundingClientRect() : el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    },
    { timeout: WAIT.short, interval: 100, label },
  );
}

/**
 * 按「图片相对位置」找一个真正命中 #map-image 的点并点击。
 * 拾取模式下弹窗应让开（pointer-events:none），命中标记 / 提示条的点会被跳过。
 */
async function clickImageFraction(fractions, { label = '地图落点' } = {}) {
  for (const [fx, fy] of fractions) {
    const point = await page.evalFn(
      (fxv, fyv) => {
        const img = document.querySelector('#map-image');
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
    if (!point) throw new Error('找不到 #map-image，无法在图片上取点');
    if (point.hit?.id !== 'map-image') continue;
    await page.click(point.x, point.y);
    await page.settle(160);
    return point;
  }
  throw new Error(
    `在图片上找不到命中 #map-image 的点击位置（${label}，尝试了 ${fractions.length} 个候选；` +
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
  const expectedFile = dimension.image;
  let observed = null;
  try {
    await waitUntil(
      async () => {
        observed = await page.evalFn(DIMENSION_STATE);
        const srcDecoded = observed.imageSrc ? decodeURIComponent(observed.imageSrc) : '';
        return (
          observed.bodyDimension === dimension.id ||
          srcDecoded.includes(expectedFile) ||
          observed.markerCount === expectedMarkers
        );
      },
      { timeout: WAIT.normal, interval: 120, label: `切换到维度 ${dimension.id}` },
    );
  } catch (error) {
    throw new Error(
      `${error.message}；当前状态：${JSON.stringify({
        bodyDimension: observed?.bodyDimension,
        src: observed?.imageSrc,
        markers: observed?.markerCount,
      })}`,
    );
  }
  await page.settle(200);
  observed = await page.evalFn(DIMENSION_STATE);
  return { target, state: observed };
}

async function waitForImageLoaded(label = '#map-image 加载完成') {
  return page.waitFor(
    () => {
      const img = document.querySelector('#map-image');
      if (!img || !img.complete || img.naturalWidth <= 0) return null;
      return { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, src: img.currentSrc || img.src };
    },
    { timeout: WAIT.long, interval: 120, label },
  );
}

/** 位置测量：与 config 的 calibration + 图片实际显示区域对比 */
async function measurePositions(dimension) {
  const info = await page.evalFn(IMAGE_INFO);
  if (!info) throw new Error('找不到 #map-image');
  if (!info.naturalWidth || !info.naturalHeight) {
    throw new Error(`#map-image 尚未加载（naturalWidth=${info.naturalWidth}）`);
  }
  if (!(info.rect.width > 0 && info.rect.height > 0)) {
    throw new Error(`#map-image 显示尺寸为 0（width=${info.rect.width}, height=${info.rect.height}）`);
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
  diag = createDiagnostics(page);

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

  await check('boot.image', '#map-image 加载完成（complete=true 且 naturalWidth>0）', async () => {
    if (rep.failed.some((result) => result.id === 'boot.ui')) {
      throw new Error('#map-image 未加载：应用脚本执行失败（见 boot.ui 失败项）');
    }
    try {
      const info = await waitForImageLoaded();
      return `${info.naturalWidth}×${info.naturalHeight} ${truncate(decodeURIComponent(info.src || ''), 80)}`;
    } catch (error) {
      const state = await page
        .evalFn(() => {
          const img = document.querySelector('#map-image');
          if (!img) return { found: false };
          return {
            found: true,
            src: img.currentSrc || img.src || '',
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            display: getComputedStyle(img).display,
            visibility: getComputedStyle(img).visibility,
          };
        })
        .catch(() => null);
      throw new Error(
        `${error.message}；#map-image 实际状态：${JSON.stringify(state)}（期望 complete=true 且 naturalWidth>0）`,
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

  await checkIfReady('dim.switch', '依次切换「下界」「末地」并切回主世界（基底图与标记数量随之变化）', async () => {
    const details = [];
    for (const dimensionId of ['nether', 'the_end', 'overworld']) {
      const dimension = dimensionById(dimensionId);
      const { state } = await switchDimension(dimensionId);
      const srcDecoded = state.imageSrc ? decodeURIComponent(state.imageSrc) : '';
      if (!srcDecoded.includes(dimension.image)) {
        throw new Error(
          `切到 ${dimension.name} 后基底图是 ${truncate(srcDecoded, 120)}，期望包含 ${dimension.image}`,
        );
      }
      if (state.bodyDimension && state.bodyDimension !== dimensionId) {
        throw new Error(`切到 ${dimension.name} 后 body[data-dimension]=${state.bodyDimension}`);
      }
      if (!(state.imageNaturalWidth > 0)) {
        throw new Error(`切到 ${dimension.name} 后基底图未加载（naturalWidth=0）`);
      }
      if (state.markerCount !== dimension.waypoints.length) {
        throw new Error(
          `切到 ${dimension.name} 后标记数 ${state.markerCount}，config 里是 ${dimension.waypoints.length}`,
        );
      }
      ctx.currentDimensionId = dimensionId;
      details.push(`${dimension.name}:${state.markerCount} 点`);
    }
    const overlord = dimensionById('overworld');
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
  await checkIfReady('pos.initial', '标记位置与 config.calibration 换算结果一致（误差 < 1.5px）', async () => {
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
    // 落点必须真正命中 #map-image：标记 / 详情弹窗 / 缩放面板上的滚轮会被 viewer 有意忽略
    const point = await findSafeMapPoint(viewport);
    if (!point) {
      throw new Error(
        '视口内找不到命中 #map-image 的落点（被标记 / 弹窗 / 浮层完全覆盖）；' +
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
    const start = await findSafeMapPoint(viewport, [
      [0.2, 0.25],
      [0.25, 0.3],
      [0.3, 0.35],
      [0.5, 0.3],
      [0.35, 0.5],
      [0.5, 0.5],
    ]);
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

  await checkIfReady('view.reset', '「整图」按钮可恢复视图', async () => {
    await resetView();
    const info = await page.evalFn(IMAGE_INFO);
    if (!(info.rect.width > 0)) throw new Error('恢复视图后图片尺寸为 0');
    return `图片 ${Math.round(info.rect.width)}×${Math.round(info.rect.height)}`;
  });

  /* ---------------- 4b. 配置驱动 + 画幅变化后重新校准 ---------------- */
  await checkIfReady('data.config', '侧栏列表 / 分组完全由 config.json 驱动（名称、顺序、数量一致）', async () => {
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
    if (actualIds.join(',') !== expectedIds.join(',')) {
      throw new Error(
        `列表顺序与 config 不一致：实际 [${actualIds.join(', ')}]，期望 [${expectedIds.join(', ')}]`,
      );
    }

    const groups = await page.evalFn(GROUP_STATS);
    if (!groups) throw new Error('找不到 #group-list');
    const expectedGroupIds = dimension.groups.map((group) => group.id);
    if (groups.count !== expectedGroupIds.length) {
      throw new Error(
        `分组行 ${groups.count} 个，config 分组 ${expectedGroupIds.length} 个（实际：${groups.ids.join(', ') || '空'}）`,
      );
    }
    const missingGroups = expectedGroupIds.filter((id) => !groups.ids.includes(id));
    if (missingGroups.length) {
      throw new Error(`分组列表缺少：${missingGroups.join(', ')}（实际：${groups.ids.join(', ')}）`);
    }
    for (const group of dimension.groups) {
      const index = groups.ids.indexOf(group.id);
      if (index >= 0 && groups.names[index] && !groups.names[index].includes(group.name)) {
        throw new Error(`分组 ${group.id} 名称「${groups.names[index]}」，config 里是「${group.name}」`);
      }
    }
    return `${items.length} 个路径点、${groups.count} 个分组与 config 一致`;
  });

  await checkIfReady(
    'cal.crop-change',
    '画幅变化后重新校准：标记自动对回（用新 calibration 手算，误差 < 1.5px）',
    async () => {
      const dimension = dimensionById('overworld');
      await resetView();
      const original = await page.evaluate(
        `(() => {
          const cal = window.__mapApp && window.__mapApp.state && window.__mapApp.state.calibration;
          if (!cal) return null;
          return { xMin: cal.xMin, xMax: cal.xMax, zMin: cal.zMin, zMax: cal.zMax, flipZ: !!cal.flipZ };
        })()`,
      );
      if (!original) {
        throw new Error('读取 window.__mapApp.state.calibration 失败（app.js 未暴露 __mapApp 调试接口）');
      }
      // 模拟「重新导出地图」：画幅放大 1.5 倍并平移（X +200 / Z -150）
      const centerX = (original.xMin + original.xMax) / 2;
      const centerZ = (original.zMin + original.zMax) / 2;
      const halfX = ((original.xMax - original.xMin) / 2) * 1.5;
      const halfZ = ((original.zMax - original.zMin) / 2) * 1.5;
      const changed = {
        xMin: centerX - halfX + 200,
        xMax: centerX + halfX + 200,
        zMin: centerZ - halfZ - 150,
        zMax: centerZ + halfZ - 150,
        flipZ: original.flipZ,
        calibrated: true,
      };
      const beforeMarkers = await page.evalFn(MARKER_RECTS);
      const beforeCastle = beforeMarkers.find((marker) => marker.id === 'castle');
      let markerMove = 0;
      let positionReport = null;
      try {
        const applied = await page.evalFn((calibration) => {
          const api = window.__mapApp;
          if (!api || typeof api.applyCalibration !== 'function') {
            return { ok: false, reason: 'window.__mapApp.applyCalibration 不可用' };
          }
          api.applyCalibration(calibration);
          const now = api.state && api.state.calibration ? { ...api.state.calibration } : null;
          return { ok: true, now };
        }, changed);
        if (!applied.ok) throw new Error(applied.reason);
        await page.settle(280);

        const afterMarkers = await page.evalFn(MARKER_RECTS);
        const afterCastle = afterMarkers.find((marker) => marker.id === 'castle');
        if (beforeCastle && afterCastle) {
          markerMove = Math.hypot(
            afterCastle.rect.left - beforeCastle.rect.left,
            afterCastle.rect.top - beforeCastle.rect.top,
          );
        }
        if (!(markerMove > 5)) {
          throw new Error(
            `applyCalibration 后标记几乎没移动（castle 位移 ${markerMove.toFixed(1)}px，期望 > 5px），校准可能未生效`,
          );
        }
        positionReport = await measurePositions({ ...dimension, calibration: changed });
        assertPositions(positionReport, { minChecked: 3, phase: '应用新画幅后' });
      } finally {
        await page
          .evalFn((calibration) => window.__mapApp.applyCalibration(calibration), {
            xMin: original.xMin,
            xMax: original.xMax,
            zMin: original.zMin,
            zMax: original.zMax,
            flipZ: original.flipZ,
            calibrated: true,
          })
          .catch(() => {});
        await page.settle(220);
        await resetView();
      }
      return (
        `新画幅 X[${changed.xMin.toFixed(0)}, ${changed.xMax.toFixed(0)}] Z[${changed.zMin.toFixed(0)}, ${changed.zMax.toFixed(0)}]，` +
        `castle 位移 ${markerMove.toFixed(0)}px；${summarizePositions(positionReport)}`
      );
    },
  );

  /* ---------------- 5. 侧栏交互 ---------------- */
  await checkIfReady('sidebar.search', '搜索框输入后列表项减少，清空后恢复', async () => {
    await ensureSidebarOpen();
    const dimension = dimensionById('overworld');
    const total = dimension.waypoints.length;
    const before = await page.evalFn(LIST_STATS);
    if (!before) throw new Error('找不到 #waypoint-list');
    if (before.count !== total) throw new Error(`搜索前列表项 ${before.count}，期望 ${total}`);

    const query = '农场';
    const expectedMatches = dimension.waypoints.filter((waypoint) => waypoint.name.includes(query)).length;
    if (expectedMatches === 0) throw new Error(`测试数据里没有名称包含「${query}」的路径点`);

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

  await checkIfReady('group.toggle', '分组眼睛按钮可隐藏/恢复该组标记', async () => {
    await ensureSidebarOpen();
    await resetView();
    const dimension = dimensionById('overworld');
    const group = dimension.groups.find((item) => item.id === 'event') ?? dimension.groups[0];
    const groupSize = dimension.waypoints.filter((waypoint) => (waypoint.group ?? 'default') === group.id).length;

    const target = await page.evalFn((groupId) => {
      const root = document.querySelector('#group-list');
      if (!root) return { found: false, reason: '缺少 #group-list' };
      const rows = [...root.querySelectorAll('[data-group-id], [data-group], [data-id]')];
      const row = rows.find(
        (el) => (el.dataset.groupId || el.dataset.group || el.dataset.id) === groupId,
      );
      const scope = row ?? root;
      const buttons = [...scope.querySelectorAll('button')];
      const toggle =
        buttons.find((button) => /eye|toggle|visible|switch/i.test(`${button.className} ${button.getAttribute('aria-label') ?? ''} ${button.title ?? ''}`)) ??
        buttons[0] ??
        (scope.tagName === 'BUTTON' ? scope : null);
      if (!toggle) {
        return {
          found: false,
          reason: `分组行 ${groupId} 里找不到眼睛按钮`,
          html: root.innerHTML.slice(0, 600),
        };
      }
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
    const statsBefore = await page.evalFn(MARKER_STATS, null);
    if (!statsBefore || statsBefore.shown !== total) {
      throw new Error(`全隐前可见标记 ${statsBefore?.shown ?? '?'} 个，期望 ${total} 个（整图视图下应全部可见）`);
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
    if (shownStats?.shown !== total) {
      throw new Error(`#btn-all-visible 后可见标记 ${shownStats?.shown ?? '?'} 个，期望 ${total} 个`);
    }
    if (shownBadge !== `${total}/${total}`) {
      throw new Error(`#btn-all-visible 后 #waypoint-count=「${shownBadge}」，期望「${total}/${total}」`);
    }

    return (
      `网格 ${gridBefore.pressed}/opacity ${gridBefore.opacity} → ${gridOn.pressed}/1 → ${gridOff.pressed}/0；` +
      `标签 ${labelsBefore} → ${labelSequence.join(' → ')}；` +
      `全隐 0/${total} → 全显 ${total}/${total}`
    );
  });

  /* ---------------- 5c. URL 深链 ---------------- */
  await checkIfReady('deep-link', 'URL 深链：#dim/x/z/s 随视图同步，新标签页按 hash 还原视角且无 console error', async () => {
    const dimension = dimensionById('overworld');
    const castle = dimension.waypoints.find((waypoint) => waypoint.id === 'castle');
    if (!castle) throw new Error('config 主世界缺少 castle 路径点，无法测试深链');

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
      secondDiag = createDiagnostics(second);
      await second.setViewport({ ...VIEWPORT });
      const secondUrl = `${baseUrl}${hash.raw}`;
      await second.navigate(secondUrl, { timeout: WAIT.long });
      await second.waitFor(
        () => {
          const buttons = document.querySelectorAll('#dimension-switch button, #dimension-switch [role="tab"]');
          const image = document.querySelector('#map-image');
          if (buttons.length < 3 || !image || !image.complete || image.naturalWidth <= 0) return null;
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
        const image = document.querySelector('#map-image');
        return {
          bodyDimension: document.body.dataset.dimension ?? null,
          hash: location.hash,
          naturalWidth: image?.naturalWidth ?? 0,
          naturalHeight: image?.naturalHeight ?? 0,
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
        dimension.calibration,
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

  /* ---------------- 6. 校准向导 ---------------- */
  let calErrorsAtOpen = 0;

  await checkIfReady('cal.open', '点击 #btn-calibrate 后 #calibrator 可见', async () => {
    calErrorsAtOpen = await errorCount();
    await page.clickSelector('#btn-calibrate');
    const state = await page.waitFor(
      () => {
        const el = document.querySelector('#calibrator');
        if (!el) return null;
        const style = getComputedStyle(el);
        const visible = !el.hidden && style.display !== 'none' && style.visibility !== 'hidden';
        if (!visible) return null;
        const panel = el.querySelector('.modal-panel') ?? el.firstElementChild;
        const rect = panel ? panel.getBoundingClientRect() : el.getBoundingClientRect();
        return { visible: true, width: rect.width, height: rect.height };
      },
      { timeout: WAIT.short, interval: 100, label: '#calibrator 可见' },
    );
    if (!(state.width > 0 && state.height > 0)) {
      throw new Error(`#calibrator 面板尺寸为 0（${state.width}×${state.height}）`);
    }
    return `面板 ${Math.round(state.width)}×${Math.round(state.height)}`;
  });

  const manualCalibration = { xMin: -1800, xMax: 1800, zMin: -2500, zMax: 2500 };

  await checkIfReady('cal.manual', '「直接输入画幅」页签：填入边界值后 #cal-json 输出可解析且字段正确的 JSON', async () => {
    await page.clickSelector('[data-cal-tab="manual"]');
    await page.waitFor(
      () => {
        const pane = document.querySelector('[data-cal-pane="manual"]');
        if (!pane) return false;
        const style = getComputedStyle(pane);
        return !pane.hidden && style.display !== 'none';
      },
      { timeout: WAIT.short, interval: 100, label: '手动输入页签可见' },
    );

    for (const [selector, value] of Object.entries({
      '#cal-x-min': manualCalibration.xMin,
      '#cal-x-max': manualCalibration.xMax,
      '#cal-z-min': manualCalibration.zMin,
      '#cal-z-max': manualCalibration.zMax,
    })) {
      const done = await page.evalFn(SET_INPUT, selector, value);
      if (!done) throw new Error(`找不到输入框 ${selector}`);
    }

    let lastState = null;
    try {
      return await waitUntil(
        async () => {
          lastState = await page.evalFn(CAL_JSON);
          const json = lastState?.json;
          if (!json) return null;
          const matches = Object.entries(manualCalibration).every(
            ([key, value]) => Number.isFinite(Number(json[key])) && Math.abs(Number(json[key]) - value) < 0.5,
          );
          if (!matches) return null;
          return `${JSON.stringify(json)}`;
        },
        { timeout: WAIT.short, interval: 150, label: '#cal-json 输出匹配画幅的 JSON' },
      );
    } catch (error) {
      throw new Error(
        `${error.message}；#cal-json 当前内容：${truncate(lastState?.raw ?? '（空）', 300)}` +
          (lastState?.parseError ? `；解析错误：${truncate(lastState.parseError, 200)}` : ''),
      );
    }
  });

  await checkIfReady('cal.close', '关闭校准向导后恢复原状且无 console error', async () => {
    const cancel = await page.evalFn(() => {
      const button = document.querySelector('#cal-cancel') ?? document.querySelector('#cal-close');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!cancel) throw new Error('找不到关闭按钮（#cal-cancel / #cal-close）');
    await page.waitFor(
      () => {
        const el = document.querySelector('#calibrator');
        if (!el) return false;
        const style = getComputedStyle(el);
        return el.hidden || style.display === 'none' || style.visibility === 'hidden';
      },
      { timeout: WAIT.short, interval: 100, label: '#calibrator 关闭' },
    );
    if (!ctx.uiReady) return '已关闭';
    await expectNoErrorsSince(calErrorsAtOpen, '校准向导');
    return '已关闭，无 console error';
  });

  /* ---------------- 6b. 本地校准覆盖（localStorage 持久化） ---------------- */
  const persistedCalibration = { xMin: -1700, xMax: 1700, zMin: -2400, zMax: 2400 };

  await checkIfReady(
    'cal.persist',
    '应用校准后 #footer-status 提示、localStorage 持久化，刷新后仍生效',
    async () => {
      const dimension = dimensionById('overworld');
      const openCalibrator = async (label) => {
        await page.clickSelector('#btn-calibrate');
        await page.waitFor(
          () => {
            const el = document.querySelector('#calibrator');
            if (!el) return null;
            const style = getComputedStyle(el);
            return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' ? true : null;
          },
          { timeout: WAIT.short, interval: 100, label },
        );
        await page.clickSelector('[data-cal-tab="manual"]');
        await page.waitFor(
          () => {
            const pane = document.querySelector('[data-cal-pane="manual"]');
            if (!pane) return null;
            return !pane.hidden && getComputedStyle(pane).display !== 'none' ? true : null;
          },
          { timeout: WAIT.short, interval: 100, label: '手动输入页签可见（持久化检查）' },
        );
      };

      await openCalibrator('#calibrator 打开（持久化检查）');
      for (const [selector, value] of Object.entries({
        '#cal-x-min': persistedCalibration.xMin,
        '#cal-x-max': persistedCalibration.xMax,
        '#cal-z-min': persistedCalibration.zMin,
        '#cal-z-max': persistedCalibration.zMax,
      })) {
        if (!(await page.evalFn(SET_INPUT, selector, value))) {
          throw new Error(`找不到输入框 ${selector}`);
        }
      }
      await page
        .waitFor(
          () => {
            const button = document.querySelector('#cal-apply');
            return button && !button.disabled ? true : null;
          },
          { timeout: WAIT.short, interval: 100, label: '#cal-apply 变为可用' },
        )
        .catch(async () => {
          const state = await page.evaluate(
            '(() => { const b = document.querySelector("#cal-apply"); return b ? { disabled: b.disabled } : null; })()',
          );
          throw new Error(`填入合法画幅后 #cal-apply 仍不可用：${JSON.stringify(state)}`);
        });

      await page.clickSelector('#cal-apply');
      await page.waitFor(
        () => {
          const el = document.querySelector('#calibrator');
          if (!el) return null;
          const style = getComputedStyle(el);
          return el.hidden || style.display === 'none' ? true : null;
        },
        { timeout: WAIT.short, interval: 100, label: '#calibrator 应用后关闭' },
      );
      await page.settle(260);

      const readFooter = () =>
        page.evalFn(() => {
          const el = document.querySelector('#footer-status');
          if (!el) return null;
          return {
            hidden: Boolean(el.hidden),
            text: (el.textContent || '').trim(),
            display: getComputedStyle(el).display,
          };
        });

      const footer = await readFooter();
      if (!footer || footer.hidden || footer.display === 'none' || !footer.text.includes('本地校准')) {
        throw new Error(
          `应用校准后 #footer-status=${JSON.stringify(footer)}，期望可见且文案含「本地校准」`,
        );
      }

      const storedRaw = await page.evaluate(
        `localStorage.getItem('steveservermap.calibration.v1')`,
      );
      if (!storedRaw) {
        throw new Error('localStorage 中没有 steveservermap.calibration.v1（期望写入本地校准覆盖）');
      }
      let stored;
      try {
        stored = JSON.parse(storedRaw);
      } catch (error) {
        throw new Error(`localStorage 中的校准不是合法 JSON：${truncate(storedRaw, 200)}`);
      }
      const storedDimension = stored && stored[dimension.id];
      if (!storedDimension) {
        throw new Error(
          `localStorage 校准缺少维度 ${dimension.id}（实际键：${Object.keys(stored || {}).join(', ') || '空'}）`,
        );
      }
      for (const [key, value] of Object.entries(persistedCalibration)) {
        const actual = Number(storedDimension[key]);
        if (!Number.isFinite(actual) || Math.abs(actual - value) > 0.5) {
          throw new Error(`localStorage.${dimension.id}.${key}=${storedDimension[key]}，期望 ${value}`);
        }
      }

      const appliedDimension = { ...dimension, calibration: { ...dimension.calibration, ...persistedCalibration } };
      const positionsApplied = await measurePositions(appliedDimension);
      assertPositions(positionsApplied, { minChecked: 3, phase: '应用本地校准后' });

      // 刷新：本地覆盖应继续生效（视觉状态 + localStorage 都在）
      await page.navigate(baseUrl, { timeout: WAIT.long });
      await waitForAppReady('刷新后应用就绪（本地校准）');
      await page.settle(200);
      const footerAfterReload = await readFooter();
      if (
        !footerAfterReload ||
        footerAfterReload.hidden ||
        footerAfterReload.display === 'none' ||
        !footerAfterReload.text.includes('本地校准')
      ) {
        throw new Error(
          `刷新后 #footer-status=${JSON.stringify(footerAfterReload)}，期望仍提示「本地校准」`,
        );
      }
      const positionsReload = await measurePositions(appliedDimension);
      assertPositions(positionsReload, { minChecked: 3, phase: '刷新后' });

      // 清理：点击 #footer-status 清除本地覆盖，避免污染后续检查
      await page.clickSelector('#footer-status');
      await page.waitFor(
        () => {
          const el = document.querySelector('#footer-status');
          return el ? Boolean(el.hidden) : null;
        },
        { timeout: WAIT.short, interval: 120, label: '#footer-status 清除后隐藏' },
      );
      const storedAfterClear = await page.evaluate(
        `localStorage.getItem('steveservermap.calibration.v1')`,
      );
      if (storedAfterClear) {
        throw new Error(`点击 #footer-status 后 localStorage 仍有覆盖：${truncate(storedAfterClear, 200)}`);
      }
      await resetView();
      return `footer=「${footer.text}」；localStorage 已写入且刷新后仍生效；点击后清除成功`;
    },
  );

  /* ---------------- 6c. 两点拾取端到端 ---------------- */
  await checkIfReady(
    'cal.pick',
    '两点拾取端到端：拾取像素 → 填世界坐标 → 解出画幅 ≈ 原画幅 → 应用后标记对回',
    async () => {
      const dimension = dimensionById('overworld');
      await page.setViewport({ ...VIEWPORT });
      await page.settle(220);
      await ensureSidebarOpen();
      await resetView();
      await dismissMarkerPopup();

      const imageInfo = await page.evalFn(IMAGE_INFO);
      if (!imageInfo || !(imageInfo.naturalWidth > 0)) throw new Error('#map-image 未加载，无法测试拾取');
      const original = await readAppCalibration();
      if (!original) throw new Error('无法读取 window.__mapApp.state.calibration（期望 app.js 暴露调试接口）');

      let pickSummary = '';
      let solvedCalibration = null;

      try {
        await openCalibratorPanel('#calibrator 打开（两点拾取）');

        // A) 进入拾取模式并检查让路状态
        await page.clickSelector('#cal-pick-a');
        const pickMode = await page.evalFn(() => {
          const calibrator = document.getElementById('calibrator');
          const viewport = document.getElementById('viewport');
          const hint = document.getElementById('cal-pick-hint');
          const hintVisible = hint
            ? !hint.hidden &&
              getComputedStyle(hint).display !== 'none' &&
              getComputedStyle(hint).visibility !== 'hidden'
            : false;
          const panel = document.querySelector('#calibrator .modal-panel');
          let panelHit = null;
          if (panel) {
            const rect = panel.getBoundingClientRect();
            const hit = document.elementFromPoint(
              Math.round(rect.left + rect.width / 2),
              Math.round(rect.top + rect.height / 2),
            );
            panelHit = hit
              ? { insideCalibrator: Boolean(hit.closest('#calibrator')), tag: hit.tagName, id: hit.id }
              : null;
          }
          return {
            calibratorPicking: Boolean(calibrator && calibrator.classList.contains('is-picking')),
            viewportPicking: Boolean(viewport && viewport.classList.contains('is-picking')),
            bodyPicking: document.body.classList.contains('is-cal-picking'),
            hintVisible,
            panelHit,
          };
        });
        if (!pickMode.calibratorPicking) throw new Error('点击 #cal-pick-a 后 #calibrator 没有 .is-picking 类');
        if (!pickMode.viewportPicking) throw new Error('点击 #cal-pick-a 后 #viewport 没有 .is-picking 类');
        if (!pickMode.hintVisible) throw new Error('拾取模式下 #cal-pick-hint 不可见（期望提示条显示）');
        if (pickMode.panelHit?.insideCalibrator) {
          throw new Error(
            `拾取模式下弹窗中心仍命中 #calibrator（${JSON.stringify(pickMode.panelHit)}），遮罩仍在拦截地图点击`,
          );
        }

        // 在地图上点 A（必须命中 #map-image）
        const pointA = await clickImageFraction(
          [
            [0.15, 0.15],
            [0.12, 0.18],
            [0.2, 0.12],
            [0.1, 0.25],
          ],
          { label: '地标 A' },
        );
        const pxA = clientToImagePoint(imageInfo, pointA.x, pointA.y);
        const worldA = imagePointToWorld(
          original,
          imageInfo.naturalWidth,
          imageInfo.naturalHeight,
          pxA.px,
          pxA.py,
        );
        const afterA = await page.evalFn(() => ({
          pxText: (document.getElementById('cal-a-px')?.textContent || '').trim(),
          calibratorPicking: Boolean(document.getElementById('calibrator')?.classList.contains('is-picking')),
          viewportPicking: Boolean(document.getElementById('viewport')?.classList.contains('is-picking')),
          focusId: document.activeElement?.id ?? null,
        }));
        const matchA = /图片像素\s*\((-?\d+),\s*(-?\d+)\)/.exec(afterA.pxText);
        if (!matchA) {
          throw new Error(`拾取 A 后 #cal-a-px=「${afterA.pxText}」，期望形如「图片像素 (1373, 2011)」`);
        }
        const displayedA = { px: Number(matchA[1]), py: Number(matchA[2]) };
        if (
          Math.abs(displayedA.px - pxA.px) > 1.5 ||
          Math.abs(displayedA.py - pxA.py) > 1.5
        ) {
          throw new Error(
            `#cal-a-px 显示 (${displayedA.px}, ${displayedA.py})，按图片矩形手算为 ` +
              `(${pxA.px.toFixed(1)}, ${pxA.py.toFixed(1)})，相差 > 1.5px`,
          );
        }
        if (afterA.calibratorPicking || afterA.viewportPicking) {
          throw new Error('拾取 A 完成后仍处于拾取模式（.is-picking 未移除）');
        }
        if (afterA.focusId !== 'cal-a-x') {
          throw new Error(`拾取 A 后焦点在「${afterA.focusId || '无'}」，期望 #cal-a-x`);
        }
        if (!(await page.evalFn(SET_INPUT, '#cal-a-x', Number(worldA.x.toFixed(3))))) {
          throw new Error('找不到输入框 #cal-a-x');
        }
        if (!(await page.evalFn(SET_INPUT, '#cal-a-z', Number(worldA.z.toFixed(3))))) {
          throw new Error('找不到输入框 #cal-a-z');
        }

        // B) 换一个 px、py 都不同的位置
        await page.clickSelector('#cal-pick-b');
        const pickModeB = await page.evalFn(() =>
          Boolean(document.getElementById('calibrator')?.classList.contains('is-picking')),
        );
        if (!pickModeB) throw new Error('点击 #cal-pick-b 后 #calibrator 没有 .is-picking 类');
        const pointB = await clickImageFraction(
          [
            [0.85, 0.85],
            [0.88, 0.82],
            [0.82, 0.88],
            [0.9, 0.75],
          ],
          { label: '地标 B' },
        );
        const pxB = clientToImagePoint(imageInfo, pointB.x, pointB.y);
        const worldB = imagePointToWorld(
          original,
          imageInfo.naturalWidth,
          imageInfo.naturalHeight,
          pxB.px,
          pxB.py,
        );
        const afterB = await page.evalFn(() => ({
          pxText: (document.getElementById('cal-b-px')?.textContent || '').trim(),
          calibratorPicking: Boolean(document.getElementById('calibrator')?.classList.contains('is-picking')),
          focusId: document.activeElement?.id ?? null,
        }));
        const matchB = /图片像素\s*\((-?\d+),\s*(-?\d+)\)/.exec(afterB.pxText);
        if (!matchB) {
          throw new Error(`拾取 B 后 #cal-b-px=「${afterB.pxText}」，期望形如「图片像素 (…)」`);
        }
        const displayedB = { px: Number(matchB[1]), py: Number(matchB[2]) };
        if (
          Math.abs(displayedB.px - pxB.px) > 1.5 ||
          Math.abs(displayedB.py - pxB.py) > 1.5
        ) {
          throw new Error(
            `#cal-b-px 显示 (${displayedB.px}, ${displayedB.py})，按图片矩形手算为 ` +
              `(${pxB.px.toFixed(1)}, ${pxB.py.toFixed(1)})，相差 > 1.5px`,
          );
        }
        if (afterB.calibratorPicking) throw new Error('拾取 B 完成后仍处于拾取模式（.is-picking 未移除）');
        if (afterB.focusId !== 'cal-b-x') {
          throw new Error(`拾取 B 后焦点在「${afterB.focusId || '无'}」，期望 #cal-b-x`);
        }
        if (Math.abs(pxB.px - pxA.px) < 5 || Math.abs(pxB.py - pxA.py) < 5) {
          throw new Error('两个拾取点在像素上拉不开（px/py 差 < 5），无法反解画幅');
        }
        if (!(await page.evalFn(SET_INPUT, '#cal-b-x', Number(worldB.x.toFixed(3))))) {
          throw new Error('找不到输入框 #cal-b-x');
        }
        if (!(await page.evalFn(SET_INPUT, '#cal-b-z', Number(worldB.z.toFixed(3))))) {
          throw new Error('找不到输入框 #cal-b-z');
        }

        // C) 等解出的画幅
        let lastCalState = null;
        const solved = await waitUntil(
          async () => {
            lastCalState = await page.evalFn(CAL_JSON);
            const json = lastCalState?.json;
            if (!json) return null;
            const fields = ['xMin', 'xMax', 'zMin', 'zMax'];
            if (!fields.every((key) => Number.isFinite(Number(json[key])))) return null;
            return json;
          },
          { timeout: WAIT.normal, interval: 120, label: '#cal-json 解出画幅' },
        ).catch((error) => {
          throw new Error(
            `${error.message}；#cal-json 当前内容：${truncate(lastCalState?.raw ?? '（空）', 300)}`,
          );
        });

        const diffs = {};
        for (const key of ['xMin', 'xMax', 'zMin', 'zMax']) {
          diffs[key] = Math.abs(Number(solved[key]) - Number(original[key]));
        }
        const maxDiff = Math.max(...Object.values(diffs));
        if (maxDiff > 2) {
          throw new Error(
            `解出的画幅与原始 calibration 最大相差 ${maxDiff.toFixed(2)} 方块（期望 < 2）：` +
              `解出 ${JSON.stringify({
                xMin: solved.xMin,
                xMax: solved.xMax,
                zMin: solved.zMin,
                zMax: solved.zMax,
                flipZ: solved.flipZ,
              })}，原始 ${JSON.stringify(original)}`,
          );
        }
        if (Boolean(solved.flipZ) !== Boolean(original.flipZ)) {
          throw new Error(`解出的 flipZ=${solved.flipZ}，原始为 ${original.flipZ}`);
        }

        // D) 应用并验证标记位置
        const applyEnabled = await page.evalFn(() => {
          const button = document.querySelector('#cal-apply');
          return button ? !button.disabled : null;
        });
        if (!applyEnabled) throw new Error('#cal-json 解出画幅后 #cal-apply 仍不可用');
        await page.clickSelector('#cal-apply');
        await page.waitFor(
          () => {
            const el = document.querySelector('#calibrator');
            if (!el) return null;
            return el.hidden || getComputedStyle(el).display === 'none' ? true : null;
          },
          { timeout: WAIT.short, interval: 100, label: '#calibrator 应用后关闭' },
        );
        await page.settle(300);

        solvedCalibration = {
          xMin: Number(solved.xMin),
          xMax: Number(solved.xMax),
          zMin: Number(solved.zMin),
          zMax: Number(solved.zMax),
          flipZ: Boolean(solved.flipZ),
        };
        const appliedState = await readAppCalibration();
        if (!appliedState) throw new Error('应用后无法读取 window.__mapApp.state.calibration');
        for (const key of ['xMin', 'xMax', 'zMin', 'zMax']) {
          if (Math.abs(Number(appliedState[key]) - solvedCalibration[key]) > 0.05) {
            throw new Error(
              `应用后 state.calibration.${key}=${appliedState[key]}，期望 ${solvedCalibration[key]}`,
            );
          }
        }
        const positions = await measurePositions({ ...dimension, calibration: solvedCalibration });
        assertPositions(positions, { minChecked: 3, phase: '两点校准应用后' });

        pickSummary =
          `A 像素 (${displayedA.px}, ${displayedA.py}) / B 像素 (${displayedB.px}, ${displayedB.py})；` +
          `解出 X[${solvedCalibration.xMin.toFixed(1)}, ${solvedCalibration.xMax.toFixed(1)}] ` +
          `Z[${solvedCalibration.zMin.toFixed(1)}, ${solvedCalibration.zMax.toFixed(1)}]，` +
          `与原画幅最大差 ${maxDiff.toFixed(2)} 方块；应用后 ${summarizePositions(positions)}`;
        return pickSummary;
      } finally {
        // 清理：关掉可能还开着的向导 → 清除本地校准覆盖 → 必要时刷新
        await page
          .evalFn(() => {
            const calibrator = document.getElementById('calibrator');
            if (calibrator && !calibrator.hidden) {
              const cancel = document.getElementById('cal-cancel') || document.getElementById('cal-close');
              if (cancel) cancel.click();
            }
          })
          .catch(() => {});
        await page.settle(200);
        await page
          .evalFn(() => {
            const footer = document.getElementById('footer-status');
            if (footer && !footer.hidden) footer.click();
          })
          .catch(() => {});
        await page.settle(220);
        const leftover = await page
          .evaluate(`localStorage.getItem('steveservermap.calibration.v1')`)
          .catch(() => null);
        if (leftover) {
          await page.evaluate(`localStorage.removeItem('steveservermap.calibration.v1')`).catch(() => {});
          await page.send('Page.reload', { ignoreCache: true }).catch(() => {});
          await page
            .waitFor(() => document.readyState === 'complete', {
              timeout: WAIT.long,
              interval: 120,
              label: '清理后刷新完成',
            })
            .catch(() => {});
          await waitForAppReady('清理后应用就绪').catch(() => {});
        }
        await dismissMarkerPopup().catch(() => {});
        await resetView().catch(() => {});
      }
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

  /* ---------------- 8. 全程 console error ---------------- */
  await check('run.console', '整个测试过程无 console error / 未捕获异常 / 未处理 Promise 拒绝', () =>
    expectNoErrorsSince(0, '全程'),
  );

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
