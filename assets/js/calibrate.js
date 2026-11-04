/**
 * calibrate.js —— 校准向导（style-dev 拥有）
 *
 * 目标：地图画幅（裁剪范围 / 分辨率）变化后，用「两个已知世界坐标的地标」重新反解出
 *       calibration，让全部路径点（存的是世界坐标）自动落回正确位置。
 *
 * 对外 API（契约 §6）：
 *   openCalibrator({ dimension, view, projection, imageSize, onPreview, onApply, onClose })
 *   closeCalibrator()
 *
 * 依赖：coords.js 的 calibrationFromTwoPoints / normalizeCalibration（纯函数）。
 * 不依赖任何第三方库，所有节点都取自 index.html 已存在的 #calibrator。
 */

import { calibrationFromTwoPoints, normalizeCalibration } from './coords.js';

/* ============================== 常量 / 小工具 ============================== */

const MODAL_ID = 'calibrator';
const VIEWPORT_ID = 'viewport';

/** 当前打开的会话（同一时间只允许一个向导） */
let activeSession = null;

const $ = (id) => document.getElementById(id);

/** 数值四舍五入到 3 位（写进 config.json 时足够精确又不至于太长） */
function round3(n) {
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 1000) / 1000;
}

/** 读取数字输入框：空串 / 非法 → null */
function toNum(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 数字排版：整数不带小数点，小数最多 3 位 */
function fmt(n) {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n * 1000) / 1000;
  if (Object.is(r, -0)) return '0';
  return String(r);
}

/** 提示条（复用 index.html 的 #toast；与 app.js 的行为保持一致） */
let toastTimer = null;
function toast(message, kind = 'ok') {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('is-error', 'is-ok');
  if (kind === 'error') el.classList.add('is-error');
  else if (kind === 'ok') el.classList.add('is-ok');
  el.hidden = false;
  el.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-show');
    setTimeout(() => {
      if (!el.classList.contains('is-show')) el.hidden = true;
    }, 240);
  }, 2800);
}

/* ============================== 拾取兼容层 ============================== */

/**
 * 安装「点击地图拾取图片像素」的监听。
 *
 * 兼容三种后端（按优先级）：
 *   1. view.session.setPickHandler(fn)        —— 若 MapView 内部维护了交互会话
 *   2. view.setPickHandler(fn) / setPickMode  —— 若 MapView 直接暴露拾取接口
 *   3. 自己挂在 #viewport 上的 pointerdown/up —— 通用回退，用 view.viewportToImage 换算
 *
 * @returns {() => void} 卸载函数（幂等）
 */
export function __setPickHandler(view, handler) {
  return installPickHandler(view, handler);
}

function installPickHandler(view, handler) {
  if (typeof handler !== 'function') return () => {};

  // 1) / 2) 优先用 MapView 自己的拾取入口
  if (view) {
    const host =
      view.session && typeof view.session.setPickHandler === 'function' ? view.session : view;
    if (typeof host.setPickHandler === 'function') {
      try {
        host.setPickHandler(handler);
        return () => {
          try {
            host.setPickHandler(null);
          } catch (err) {
            console.warn('[calibrate] 卸载拾取失败', err);
          }
        };
      } catch (err) {
        console.warn('[calibrate] setPickHandler 不可用，改用自带监听', err);
      }
    }
    if (typeof view.setPickMode === 'function') {
      try {
        view.setPickMode(true, handler);
        return () => {
          try {
            view.setPickMode(false, null);
          } catch (err) {
            console.warn('[calibrate] 退出拾取模式失败', err);
          }
        };
      } catch (err) {
        console.warn('[calibrate] setPickMode 不可用，改用自带监听', err);
      }
    }
  }

  // 3) 通用回退
  const vp = (view && view.viewport) instanceof HTMLElement ? view.viewport : $(VIEWPORT_ID);
  if (!vp) {
    console.warn('[calibrate] 找不到 #viewport，无法拾取');
    return () => {};
  }
  if (!view || typeof view.viewportToImage !== 'function') {
    console.warn('[calibrate] view.viewportToImage 不可用，无法把屏幕坐标换算成图片像素');
    return () => {};
  }

  const ac = new AbortController();
  const opts = { signal: ac.signal };
  let down = null;

  /** 命中这些 UI 的点击不算「在地图上拾取」，避免把标记/控件的位置当成地标 */
  const UI_BLOCK_SELECTOR =
    '.marker, .marker-popup, .zoom-panel, .coord-readout, .map-hint, .scale-bar, .map-state, #cal-pick-hint, #calibrator';

  const isBlockedTarget = (target) => {
    if (!target || typeof target.closest !== 'function') return false;
    try {
      return !!target.closest(UI_BLOCK_SELECTOR);
    } catch (err) {
      return false;
    }
  };

  const pickAt = (clientX, clientY) => {
    const rect = vp.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return;
    }
    let pt = null;
    try {
      pt = view.viewportToImage(clientX, clientY);
    } catch (err) {
      console.warn('[calibrate] viewportToImage 调用失败', err);
    }
    if (!pt || !Number.isFinite(pt.px) || !Number.isFinite(pt.py)) return;
    handler({ px: pt.px, py: pt.py, clientX, clientY });
  };

  const onDown = (e) => {
    if (isBlockedTarget(e.target)) {
      down = null;
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    down = { x: e.clientX, y: e.clientY, t: Date.now() };
  };

  const onUp = (e) => {
    const d = down;
    down = null;
    if (!d) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return; // 拖拽结束不算点击
    if (Date.now() - d.t > 1500) return; // 长按不算
    if (isBlockedTarget(e.target)) return; // 点在控件/标记上：忽略，继续留在拾取模式
    pickAt(e.clientX, e.clientY);
  };

  vp.addEventListener('pointerdown', onDown, opts);
  vp.addEventListener('pointerup', onUp, opts);
  vp.addEventListener(
    'pointercancel',
    () => {
      down = null;
    },
    opts,
  );

  return () => {
    try {
      ac.abort();
    } catch (err) {
      /* ignore */
    }
  };
}

/* ============================== 原始校准解析 ============================== */

/**
 * 从「当前维度配置 / 当前投影」里取出可作为「默认/原始」的画幅。
 * 支持 bounds 写法与「pixelsPerBlock + origin」写法。
 * @returns {{calibrated:boolean,xMin:number,xMax:number,zMin:number,zMax:number,flipZ:boolean,note:string}|null}
 */
function readOriginalCalibration(dimension, image, projection) {
  const raw = (dimension && dimension.calibration) || {};

  const direct = {
    xMin: toNum(raw.xMin),
    xMax: toNum(raw.xMax),
    zMin: toNum(raw.zMin),
    zMax: toNum(raw.zMax),
  };
  if (
    direct.xMin !== null &&
    direct.xMax !== null &&
    direct.zMin !== null &&
    direct.zMax !== null
  ) {
    return {
      calibrated: raw.calibrated === true,
      xMin: Math.min(direct.xMin, direct.xMax),
      xMax: Math.max(direct.xMin, direct.xMax),
      zMin: Math.min(direct.zMin, direct.zMax),
      zMax: Math.max(direct.zMin, direct.zMax),
      flipZ: raw.flipZ === true,
      note: typeof raw.note === 'string' ? raw.note : '',
    };
  }

  // 「缩放 + 原点」写法
  const ppb = toNum(raw.pixelsPerBlock);
  const ox = toNum(raw.originX);
  const oz = toNum(raw.originZ);
  if (ppb !== null && ppb > 0 && ox !== null && oz !== null && image && image.width) {
    return {
      calibrated: raw.calibrated === true,
      xMin: ox,
      xMax: ox + image.width / ppb,
      zMin: oz,
      zMax: oz + image.height / ppb,
      flipZ: raw.flipZ === true,
      note: typeof raw.note === 'string' ? raw.note : '',
    };
  }

  // 投影兜底
  if (
    projection &&
    Number.isFinite(projection.xMin) &&
    Number.isFinite(projection.xMax) &&
    Number.isFinite(projection.zMin) &&
    Number.isFinite(projection.zMax)
  ) {
    return {
      calibrated: raw.calibrated === true,
      xMin: Math.min(projection.xMin, projection.xMax),
      xMax: Math.max(projection.xMin, projection.xMax),
      zMin: Math.min(projection.zMin, projection.zMax),
      zMax: Math.max(projection.zMin, projection.zMax),
      flipZ: projection.flipZ === true,
      note: typeof raw.note === 'string' ? raw.note : '',
    };
  }

  return null;
}

/* ============================== 主入口 ============================== */

/**
 * 打开校准向导。
 * @param {{
 *   dimension?: object,
 *   view?: object,
 *   projection?: object,
 *   imageSize?: {width:number,height:number}|null,
 *   onPreview?: (cal:object)=>void,
 *   onApply?: (cal:object)=>void,
 *   onClose?: ()=>void,
 * }} options
 * @returns {{close:function, apply:function, isOpen:function, refresh:function}|null}
 */
export function openCalibrator(options = {}) {
  const root = $(MODAL_ID);
  if (!root) {
    console.warn('[calibrate] 找不到 #calibrator，无法打开校准向导');
    return null;
  }
  // 已经打开：复用（避免重复绑定监听器）
  if (activeSession) return activeSession.handle;

  const {
    dimension = null,
    view = null,
    projection = null,
    imageSize = null,
    onPreview = null,
    onApply = null,
    onClose = null,
  } = options || {};

  const state = {
    tab: 'pick',
    pts: { a: null, b: null },
    current: null,
    original: null,
    pickTarget: null,
    pickHint: null,
    uninstallPick: null,
    lastPreviewKey: '',
    closed: false,
    applied: false,
    manualDirty: false,
  };

  const ac = new AbortController();
  const on = (target, type, handler, extra) => {
    if (!target) return;
    try {
      target.addEventListener(type, handler, { signal: ac.signal, ...(extra || {}) });
    } catch (err) {
      console.warn('[calibrate] 绑定事件失败', err);
    }
  };

  /* ---------- 节点 ---------- */
  const els = {
    panel: root.querySelector('.modal-panel'),
    close: $('cal-close'),
    tabs: Array.from(root.querySelectorAll('[data-cal-tab]')),
    panes: Array.from(root.querySelectorAll('[data-cal-pane]')),
    pointA: root.querySelector('.cal-point[data-point="a"]'),
    pointB: root.querySelector('.cal-point[data-point="b"]'),
    aPx: $('cal-a-px'),
    bPx: $('cal-b-px'),
    aX: $('cal-a-x'),
    aZ: $('cal-a-z'),
    bX: $('cal-b-x'),
    bZ: $('cal-b-z'),
    pickA: $('cal-pick-a'),
    pickB: $('cal-pick-b'),
    pickClear: $('cal-pick-clear'),
    xMin: $('cal-x-min'),
    xMax: $('cal-x-max'),
    zMin: $('cal-z-min'),
    zMax: $('cal-z-max'),
    flipZ: $('cal-flip-z'),
    status: $('cal-status'),
    copy: $('cal-copy'),
    json: $('cal-json'),
    reset: $('cal-reset'),
    cancel: $('cal-cancel'),
    apply: $('cal-apply'),
  };

  const prevFocus = document.activeElement;

  /* ---------- 基础读取 ---------- */

  /** 当前可用的图片尺寸（参数优先，其次问 MapView） */
  function imageNow() {
    if (imageSize && Number(imageSize.width) > 0 && Number(imageSize.height) > 0) {
      return { width: Number(imageSize.width), height: Number(imageSize.height) };
    }
    if (view && typeof view.getImageSize === 'function') {
      try {
        const size = view.getImageSize();
        if (size && Number(size.width) > 0 && Number(size.height) > 0) {
          return { width: Number(size.width), height: Number(size.height) };
        }
      } catch (err) {
        console.warn('[calibrate] view.getImageSize 调用失败', err);
      }
    }
    return null;
  }

  function viewportEl() {
    if (view && view.viewport instanceof HTMLElement) return view.viewport;
    return $(VIEWPORT_ID);
  }

  function readWorld(which) {
    const xEl = which === 'a' ? els.aX : els.bX;
    const zEl = which === 'a' ? els.aZ : els.bZ;
    if (!xEl || !zEl) return null;
    const x = toNum(xEl.value);
    const z = toNum(zEl.value);
    if (x === null || z === null) return null;
    return { x, z };
  }

  /* ---------- 界面更新 ---------- */

  function setStatus(level, html) {
    if (!els.status) return;
    if (!html) {
      els.status.className = 'cal-status';
      els.status.innerHTML = '';
      return;
    }
    const safeLevel = level === 'ok' || level === 'bad' || level === 'warn' ? level : 'warn';
    els.status.className = `cal-status is-${safeLevel}`;
    els.status.innerHTML = html;
  }

  function setCurrent(calibration, html, level) {
    state.current = calibration || null;
    const usable = !!state.current;
    if (els.apply) els.apply.disabled = !usable;
    if (els.copy) {
      if ('disabled' in els.copy) els.copy.disabled = !usable;
      els.copy.setAttribute('aria-disabled', usable ? 'false' : 'true');
    }
    if (els.json) els.json.textContent = usable ? JSON.stringify(state.current, null, 2) : '—';
    setStatus(level || (usable ? 'ok' : 'warn'), html || '');
    if (usable) preview(state.current);
  }

  function preview(cal) {
    if (typeof onPreview !== 'function') return;
    const key = JSON.stringify(cal);
    if (key === state.lastPreviewKey) return;
    state.lastPreviewKey = key;
    try {
      onPreview(cal);
    } catch (err) {
      console.error('[calibrate] onPreview 回调出错', err);
    }
  }

  function updatePointDom(which) {
    const pt = state.pts[which];
    const pxEl = which === 'a' ? els.aPx : els.bPx;
    const field = which === 'a' ? els.pointA : els.pointB;
    if (pxEl) {
      pxEl.textContent = pt
        ? `图片像素 (${Math.round(pt.px)}, ${Math.round(pt.py)})`
        : '尚未拾取';
    }
    if (field) field.classList.toggle('is-picked', !!pt);
  }

  function updatePickButtons() {
    const map = [
      [els.pickA, 'a'],
      [els.pickB, 'b'],
    ];
    for (const [btn, target] of map) {
      if (!btn) continue;
      btn.classList.toggle('is-active', state.pickTarget === target);
      btn.setAttribute('aria-pressed', state.pickTarget === target ? 'true' : 'false');
    }
  }

  /* ---------- 拾取提示条（拾取模式下唯一可点的元素） ---------- */

  function ensurePickHint() {
    if (state.pickHint && state.pickHint.isConnected) return state.pickHint;
    const hint = document.createElement('div');
    hint.id = 'cal-pick-hint';
    hint.hidden = true;
    hint.innerHTML =
      '<span class="pick-dot" aria-hidden="true"></span>' +
      '<span class="pick-hint-text"></span>' +
      '<button class="link-btn" type="button" data-act="cancel-pick">取消拾取</button>';
    hint.addEventListener('click', (e) => {
      const btn = e.target && typeof e.target.closest === 'function'
        ? e.target.closest('[data-act="cancel-pick"]')
        : null;
      if (!btn) return;
      e.preventDefault();
      cancelPick();
    });
    document.body.appendChild(hint);
    state.pickHint = hint;
    return hint;
  }

  function showPickHint(target) {
    const hint = ensurePickHint();
    const text = hint.querySelector('.pick-hint-text');
    if (text) text.textContent = `点击地图选择地标 ${target.toUpperCase()}（可拖拽/缩放后再点）`;
    hint.hidden = false;
  }

  function hidePickHint() {
    if (!state.pickHint) return;
    state.pickHint.hidden = true;
    state.pickHint.remove();
    state.pickHint = null;
  }

  /* ---------- 页签 ---------- */

  function switchTab(name, { silent = false } = {}) {
    const next = name === 'manual' ? 'manual' : 'pick';
    state.tab = next;
    for (const tab of els.tabs) {
      const on2 = tab.getAttribute('data-cal-tab') === next;
      tab.classList.toggle('is-active', on2);
      tab.setAttribute('aria-selected', on2 ? 'true' : 'false');
      tab.setAttribute('tabindex', on2 ? '0' : '-1');
    }
    for (const pane of els.panes) {
      pane.hidden = pane.getAttribute('data-cal-pane') !== next;
    }
    // pick → manual：把已解出的画幅同步到手动输入框，避免页签一切换就跳变
    if (next === 'manual' && state.current && !state.manualDirty) {
      fillManual(state.current);
    }
    if (!silent) recompute();
  }

  function fillManual(cal) {
    if (!cal) return;
    if (els.xMin) els.xMin.value = String(round3(cal.xMin));
    if (els.xMax) els.xMax.value = String(round3(cal.xMax));
    if (els.zMin) els.zMin.value = String(round3(cal.zMin));
    if (els.zMax) els.zMax.value = String(round3(cal.zMax));
    if (els.flipZ) els.flipZ.checked = cal.flipZ === true;
    state.manualDirty = false;
  }

  /* ---------- 校验 / 组装 ---------- */

  function crossCheck(cal, image) {
    if (!image) return '';
    try {
      const normalized = normalizeCalibration(
        { ...cal, calibrated: true },
        { imageWidth: image.width, imageHeight: image.height },
      );
      if (!normalized) {
        return '<br><span class="cal-dim">（coords.js 未接受这组参数，请再核对一次边界值。）</span>';
      }
    } catch (err) {
      // coords.js 版本差异不应该阻断向导
      console.debug('[calibrate] normalizeCalibration 校验跳过：', err && err.message);
    }
    return '';
  }

  function makeCalibration(bounds, note) {
    return {
      calibrated: true,
      xMin: round3(bounds.xMin),
      xMax: round3(bounds.xMax),
      zMin: round3(bounds.zMin),
      zMax: round3(bounds.zMax),
      flipZ: bounds.flipZ === true,
      note: note || '',
    };
  }

  const degenerate = (b) =>
    !Number.isFinite(b.xMin) ||
    !Number.isFinite(b.xMax) ||
    !Number.isFinite(b.zMin) ||
    !Number.isFinite(b.zMax) ||
    !(b.xMax > b.xMin) ||
    !(b.zMax > b.zMin);

  /** 每方块像素数 / 1 像素多少方块 / 比例是否可疑 */
  function scaleInfo(cal, image) {
    const worldW = cal.xMax - cal.xMin;
    const worldH = cal.zMax - cal.zMin;
    const pxPerBlockX = worldW > 0 ? image.width / worldW : NaN;
    const pxPerBlockZ = worldH > 0 ? image.height / worldH : NaN;
    const blocksPerPxX = pxPerBlockX > 0 ? 1 / pxPerBlockX : NaN;
    const blocksPerPxZ = pxPerBlockZ > 0 ? 1 / pxPerBlockZ : NaN;
    let ratioWarning = '';
    if (Number.isFinite(pxPerBlockX) && Number.isFinite(pxPerBlockZ)) {
      const ratio =
        Math.max(pxPerBlockX, pxPerBlockZ) / Math.min(pxPerBlockX, pxPerBlockZ);
      if (ratio > 1.15) {
        ratioWarning =
          `<br><span class="cal-dim">提示：X / Z 方向的每方块像素数相差 ${fmt(
            ratio,
          )} 倍（${fmt(pxPerBlockX)} vs ${fmt(
            pxPerBlockZ,
          )}）。若地图比例本身是 1:1，则可能是某个地标的坐标填错了。</span>`;
      }
    }
    let magnitudeWarning = '';
    if (Number.isFinite(pxPerBlockX) && (pxPerBlockX < 0.01 || pxPerBlockX > 200)) {
      magnitudeWarning = `<br><span class="cal-dim">提示：每方块 ${fmt(
        pxPerBlockX,
      )} px 看起来不太寻常，请确认地标坐标与拾取位置是否对应。</span>`;
    }
    return {
      pxPerBlockX,
      pxPerBlockZ,
      blocksPerPxX,
      blocksPerPxZ,
      warnings: ratioWarning + magnitudeWarning,
    };
  }

  function okHtml(cal, image, { heading, extra }) {
    const info = scaleInfo(cal, image);
    return (
      `<strong>${heading}</strong>` +
      `<br>图片 ${image.width} × ${image.height} px` +
      `<br>X：<span class="cal-num">${fmt(cal.xMin)}</span> → <span class="cal-num">${fmt(
        cal.xMax,
      )}</span>　每方块 <span class="cal-num">${fmt(info.pxPerBlockX)}</span> px（1 px ≈ <span class="cal-num">${fmt(
        info.blocksPerPxX,
      )}</span> 方块）` +
      `<br>Z：<span class="cal-num">${fmt(cal.zMin)}</span> → <span class="cal-num">${fmt(
        cal.zMax,
      )}</span>　每方块 <span class="cal-num">${fmt(info.pxPerBlockZ)}</span> px（1 px ≈ <span class="cal-num">${fmt(
        info.blocksPerPxZ,
      )}</span> 方块）` +
      (cal.flipZ ? '<br>南北翻转：<span class="cal-num">flipZ = true</span>' : '') +
      (extra || '') +
      `${info.warnings}${crossCheck(cal, image)}` +
      '<br><span class="cal-dim">下一步：点「复制 JSON 片段」写进 config.json 对应维度的 calibration 字段（把 calibrated 保持 true），或先点「应用并刷新」在本浏览器即时预览。</span>'
    );
  }

  /* ---------- 解算：两点 ---------- */

  function computePick() {
    const image = imageNow();
    if (!image) {
      return noResult(
        'bad',
        '这张基底图的尺寸还取不到（图片可能还在加载）。请等地图显示了再试，或切到「直接输入画幅」手动填写。',
      );
    }
    const a = state.pts.a;
    const b = state.pts.b;

    if (!a && !b) {
      return noResult(
        'warn',
        '点「拾取 A」，然后在地图上点击一个<b>已知世界坐标</b>的地标（例如出生点、传送门、主城中心）。',
      );
    }
    if (!a || !b) {
      const got = a ? 'A' : 'B';
      const need = a ? 'B' : 'A';
      return noResult('warn', `已拾取地标 ${got}，还差地标 ${need}：点「拾取 ${need}」再在地图上点一下。`);
    }

    const wa = readWorld('a');
    const wb = readWorld('b');
    if (!wa || !wb) {
      return noResult(
        'warn',
        '两个地标的像素位置都拾取好了，请分别填写它们真实的世界坐标 <b>X</b> / <b>Z</b>（方块坐标，可带小数）。',
      );
    }

    // 像素轴重合 → 该轴无法反解
    if (Math.abs(b.px - a.px) < 0.5) {
      return noResult(
        'bad',
        'A、B 两点在图片上的<b>横向像素</b>几乎相同，无法反解 X 方向的画幅。请换两个左右也拉开距离的地标重新拾取。',
      );
    }
    if (Math.abs(b.py - a.py) < 0.5) {
      return noResult(
        'bad',
        'A、B 两点在图片上的<b>纵向像素</b>几乎相同，无法反解 Z 方向的画幅。请换两个上下也拉开距离的地标重新拾取。',
      );
    }
    if (Math.abs(wb.x - wa.x) < 1e-6) {
      return noResult(
        'bad',
        '两个地标的世界 X 坐标相同，但图片上的横向像素不同 —— 请检查 X 是否填反或填错。',
      );
    }
    if (Math.abs(wb.z - wa.z) < 1e-6) {
      return noResult(
        'bad',
        '两个地标的世界 Z 坐标相同，但图片上的纵向像素不同 —— 请检查 Z 是否填反或填错。',
      );
    }

    const W = image.width;
    const H = image.height;

    // 本地线性解算：x = xMin + (px / W) * (xMax - xMin)
    const kx = (wb.x - wa.x) / (b.px - a.px); // 方块 / 像素
    if (!(kx > 0)) {
      return noResult(
        'bad',
        '两个地标的<b>横向像素</b>与世界 X 的方向相反（图片上更靠右的点 X 反而更小）。' +
          'X 方向没有「翻转」语义，请检查两个地标的 X 坐标是否填反了。',
      );
    }
    const leftX = wa.x - a.px * kx;
    const rightX = leftX + W * kx;
    const kz = (wb.z - wa.z) / (b.py - a.py);
    const topZ = wa.z - a.py * kz;
    const bottomZ = topZ + H * kz;

    const local = {
      xMin: Math.min(leftX, rightX),
      xMax: Math.max(leftX, rightX),
      zMin: Math.min(topZ, bottomZ),
      zMax: Math.max(topZ, bottomZ),
      // 图片上方是 +Z（Z 随向下像素减小）→ 需要 flipZ
      flipZ: topZ > bottomZ,
    };

    if (degenerate(local)) {
      return noResult(
        'bad',
        '解出的画幅边界非法（最小值 ≥ 最大值）。请确认两个地标的坐标与顺序是否对应得上。',
      );
    }

    // 用 coords.js 的纯函数交叉校验（契约要求调用它）
    let solved = local;
    let crossNote = '';
    try {
      const fromCoords = calibrationFromTwoPoints(
        { px: a.px, py: a.py, x: wa.x, z: wa.z },
        { px: b.px, py: b.py, x: wb.x, z: wb.z },
        { imageWidth: W, imageHeight: H },
      );
      if (fromCoords) {
        const rx = [Number(fromCoords.xMin), Number(fromCoords.xMax)];
        const rz = [Number(fromCoords.zMin), Number(fromCoords.zMax)];
        if (rx.every(Number.isFinite) && rz.every(Number.isFinite)) {
          const cand = {
            xMin: Math.min(rx[0], rx[1]),
            xMax: Math.max(rx[0], rx[1]),
            zMin: Math.min(rz[0], rz[1]),
            zMax: Math.max(rz[0], rz[1]),
            // 若 coords.js 直接返回「上边缘 Z 更大」的原始顺序，说明方向是翻转的
            flipZ: rz[0] > rz[1] ? true : local.flipZ,
          };
          const tolerance = Math.max(1, Math.abs(local.xMax - local.xMin) * 1e-9) + 0.5;
          const consistent =
            Math.abs(cand.xMin - local.xMin) <= tolerance &&
            Math.abs(cand.xMax - local.xMax) <= tolerance &&
            Math.abs(cand.zMin - local.zMin) <= tolerance &&
            Math.abs(cand.zMax - local.zMax) <= tolerance;
          if (consistent) {
            // 与本地解算一致 → 采用 coords.js 的结果（契约的权威实现）
            solved = { ...local, ...cand, flipZ: local.flipZ };
          } else {
            crossNote =
              '<br><span class="cal-dim">注意：coords.js 的 calibrationFromTwoPoints 与本地解算结果不一致，已采用本地解算。</span>';
          }
        }
      } else {
        crossNote =
          '<br><span class="cal-dim">注意：coords.js 未能由这两点反解出画幅（返回 null），已改用本地解算。</span>';
      }
    } catch (err) {
      console.warn('[calibrate] calibrationFromTwoPoints 调用失败，改用本地解算', err);
      crossNote =
        '<br><span class="cal-dim">注意：coords.js 反解调用出错，已改用本地解算。</span>';
    }

    if (degenerate(solved)) {
      return noResult('bad', '解出的画幅边界非法，请检查两个地标的像素位置与世界坐标。');
    }

    const note = `两点校准 · 图片 ${W}×${H}px · 每方块 ${fmt(
      W / (solved.xMax - solved.xMin),
    )}px · 由校准向导生成`;
    const cal = makeCalibration(solved, note);
    setCurrent(cal, okHtml(cal, image, { heading: '画幅已解出', extra: crossNote }), 'ok');
    return { ok: true };
  }

  /* ---------- 解算：手动输入 ---------- */

  function computeManual() {
    const image = imageNow();
    const raw = {
      xMin: els.xMin ? toNum(els.xMin.value) : null,
      xMax: els.xMax ? toNum(els.xMax.value) : null,
      zMin: els.zMin ? toNum(els.zMin.value) : null,
      zMax: els.zMax ? toNum(els.zMax.value) : null,
    };
    const missing = Object.keys(raw).filter((k) => raw[k] === null);
    if (missing.length) {
      return noResult(
        'warn',
        `请填写四个边界值（还差：${missing.map((k) => k.replace('Min', ' min').replace('Max', ' max')).join('、')}）。` +
          '<br><span class="cal-dim">边界含义：左边缘世界 X = xMin，右边缘 = xMax，上边缘世界 Z = zMin，下边缘 = zMax。</span>',
      );
    }
    if (!(raw.xMax > raw.xMin)) {
      return noResult('bad', '右边缘世界 X（xMax）必须大于左边缘世界 X（xMin）。');
    }
    if (!(raw.zMax > raw.zMin)) {
      return noResult('bad', '下边缘世界 Z（zMax）必须大于上边缘世界 Z（zMin）。');
    }
    if (!image) {
      return noResult(
        'bad',
        '这张基底图的尺寸还取不到（图片可能还在加载），暂时无法计算每方块像素数。',
      );
    }

    const cal = makeCalibration(
      { ...raw, flipZ: !!(els.flipZ && els.flipZ.checked) },
      `手动输入画幅 · 图片 ${image.width}×${image.height}px · 由校准向导生成`,
    );
    setCurrent(cal, okHtml(cal, image, { heading: '画幅已就绪（手动输入）' }), 'ok');
    return { ok: true };
  }

  function noResult(level, html) {
    state.current = null;
    if (els.apply && !state.applied) els.apply.disabled = true;
    if (els.json) els.json.textContent = '—';
    setStatus(level, html);
    return { ok: false };
  }

  function recompute() {
    const image = imageNow();
    // 两点都拾取后才允许预览；手动页签随时可解
    if (state.tab === 'manual') return computeManual();
    return computePick(image);
  }

  /* ---------- 拾取流程 ---------- */

  function startPick(target) {
    const image = imageNow();
    if (!image) {
      setStatus(
        'bad',
        '基底图还没有加载完成，无法把点击换算成图片像素。请等地图出现后重试，或切到「直接输入画幅」。',
      );
      return;
    }
    // 再次点击同一个按钮 = 取消拾取
    if (state.pickTarget === target) {
      cancelPick();
      return;
    }
    endPick({ silent: true });
    state.pickTarget = target;

    // 关键：整个弹窗进入「让路」状态（样式见 style.css 的 #calibrator.is-picking）
    root.classList.add('is-picking');
    document.body.classList.add('is-cal-picking');
    const vp = viewportEl();
    if (vp) {
      vp.classList.add('is-picking');
      try {
        vp.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    }
    if (target === 'a' && els.pointA) els.pointA.classList.add('is-picking');
    if (target === 'b' && els.pointB) els.pointB.classList.add('is-picking');
    updatePickButtons();
    showPickHint(target);

    setStatus(
      'warn',
      `拾取模式：在地图上<b>单击</b>地标 ${target.toUpperCase()} 的位置（拖拽平移不会误触）。` +
        '<br><span class="cal-dim">拾取后请填写它的世界坐标 X / Z。点「取消拾取」或按 Esc 可以退出。</span>',
    );

    state.uninstallPick = installPickHandler(view, (pt) => handlePick(target, pt));
  }

  function handlePick(target, pt) {
    if (state.pickTarget !== target) return;
    state.pts[target] = { px: pt.px, py: pt.py };
    updatePointDom(target);
    endPick({ silent: true });

    const image = imageNow();
    if (image) {
      const outside = pt.px < 0 || pt.py < 0 || pt.px > image.width || pt.py > image.height;
      if (outside) {
        setStatus(
          'warn',
          `地标 ${target.toUpperCase()} 的拾取点落在图片范围之外（像素 ${Math.round(
            pt.px,
          )}, ${Math.round(pt.py)}）。如果这是有意为之（地图有留白）可以忽略，否则请重新拾取。`,
        );
      }
    }

    // 立即把焦点交给世界坐标输入框并全选，方便直接键入数字
    const xInput = target === 'a' ? els.aX : els.bX;
    if (xInput) {
      try {
        xInput.focus({ preventScroll: true });
        if (typeof xInput.select === 'function') xInput.select();
      } catch (err) {
        xInput.focus();
      }
    }
    recompute();
  }

  /** 取消拾取：恢复面板、收起提示条、留在向导里 */
  function cancelPick() {
    const wasPicking = !!state.pickTarget;
    endPick({ silent: true });
    if (wasPicking) {
      setStatus(
        'warn',
        '已取消拾取。需要继续时点「拾取 A」或「拾取 B」，然后在地图上单击地标位置。',
      );
    }
  }

  function endPick({ silent = false } = {}) {
    state.pickTarget = null;
    if (typeof state.uninstallPick === 'function') {
      try {
        state.uninstallPick();
      } catch (err) {
        console.warn('[calibrate] 卸载拾取监听失败', err);
      }
    }
    state.uninstallPick = null;

    root.classList.remove('is-picking');
    document.body.classList.remove('is-cal-picking');
    hidePickHint();
    const vp = viewportEl();
    if (vp) vp.classList.remove('is-picking');
    if (els.pointA) els.pointA.classList.remove('is-picking');
    if (els.pointB) els.pointB.classList.remove('is-picking');
    updatePickButtons();
    if (!silent) {
      /* 由调用方决定提示文案 */
    }
  }

  function clearPoints() {
    endPick({ silent: true });
    state.pts = { a: null, b: null };
    updatePointDom('a');
    updatePointDom('b');
    if (els.aX) els.aX.value = '';
    if (els.aZ) els.aZ.value = '';
    if (els.bX) els.bX.value = '';
    if (els.bZ) els.bZ.value = '';
    setCurrent(null, null, 'warn');
    setStatus('warn', '已清除两个地标。点「拾取 A」重新开始。');
  }

  /* ---------- 复制 JSON ---------- */

  async function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.warn('[calibrate] clipboard API 失败，尝试 execCommand', err);
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      Object.assign(ta.style, {
        position: 'fixed',
        top: '-1000px',
        left: '-1000px',
        opacity: '0',
      });
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (err) {
      console.warn('[calibrate] execCommand 复制失败', err);
      return false;
    }
  }

  function selectJson() {
    if (!els.json) return false;
    try {
      const range = document.createRange();
      range.selectNodeContents(els.json);
      const sel = window.getSelection();
      if (!sel) return false;
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function handleCopy() {
    if (!state.current) {
      toast('还没有解出画幅：先拾取两点并填好世界坐标', 'error');
      return;
    }
    const text = JSON.stringify(state.current, null, 2);
    if (els.json) els.json.textContent = text;
    const ok = await copyText(text);
    if (ok) {
      toast('已复制 JSON 片段 → 粘贴到 config.json 里该维度的 calibration 字段', 'ok');
    } else {
      selectJson();
      toast('复制失败，已选中 JSON 文本，请按 Ctrl+C 手动复制', 'error');
    }
  }

  /* ---------- 应用 / 关闭 ---------- */

  function handleApply() {
    if (!state.current || state.applied) return;
    const cal = { ...state.current };
    state.applied = true;
    cleanup();
    try {
      if (typeof onApply === 'function') onApply(cal);
    } catch (err) {
      console.error('[calibrate] onApply 回调出错', err);
    }
  }

  function handleCancel() {
    if (state.closed) return;
    const wasApplied = state.applied;
    cleanup();
    if (!wasApplied) {
      try {
        if (typeof onClose === 'function') onClose();
      } catch (err) {
        console.error('[calibrate] onClose 回调出错', err);
      }
    }
  }

  function cleanup() {
    if (state.closed) return;
    state.closed = true;
    endPick({ silent: true });
    try {
      ac.abort();
    } catch (err) {
      /* ignore */
    }
    const vp = viewportEl();
    if (vp) vp.classList.remove('is-picking');
    root.classList.remove('is-picking');
    document.body.classList.remove('is-cal-picking');
    hidePickHint();
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('cal-open');
    if (activeSession && activeSession.state === state) activeSession = null;
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try {
        prevFocus.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    }
  }

  function handleReset() {
    if (!state.original) {
      setStatus(
        'warn',
        '这个维度的 config.json 里没有可用的原始 calibration（或图片尺寸未知），无法恢复默认。请手动填写，或用两点校准。',
      );
      return;
    }
    endPick({ silent: true });
    state.pts = { a: null, b: null };
    updatePointDom('a');
    updatePointDom('b');
    if (els.aX) els.aX.value = '';
    if (els.aZ) els.aZ.value = '';
    if (els.bX) els.bX.value = '';
    if (els.bZ) els.bZ.value = '';
    // 先清掉当前解，避免 switchTab 用旧解覆盖「恢复默认」填充的值
    state.current = null;
    state.manualDirty = false;
    fillManual(state.original);
    switchTab('manual', { silent: true });
    state.manualDirty = false;
    // 直接按原始值算一遍（手动页签此刻就是原始画幅）
    computeManual();
    if (state.current) {
      setStatus(
        'warn',
        `<strong>已恢复为 config.json 里的画幅</strong>：X <span class="cal-num">${fmt(
          state.original.xMin,
        )}</span> → <span class="cal-num">${fmt(state.original.xMax)}</span>，Z <span class="cal-num">${fmt(
          state.original.zMin,
        )}</span> → <span class="cal-num">${fmt(state.original.zMax)}</span>。` +
          '<br><span class="cal-dim">如果这就是你要的画幅，点「应用并刷新」即可；否则继续两点校准。</span>',
      );
    }
  }

  /* ---------- 预填 ---------- */
  function prefill() {
    state.original = readOriginalCalibration(dimension, imageNow(), projection);

    updatePointDom('a');
    updatePointDom('b');
    if (els.aX) els.aX.value = '';
    if (els.aZ) els.aZ.value = '';
    if (els.bX) els.bX.value = '';
    if (els.bZ) els.bZ.value = '';

    if (state.original) {
      fillManual(state.original);
    } else {
      if (els.xMin) els.xMin.value = '';
      if (els.xMax) els.xMax.value = '';
      if (els.zMin) els.zMin.value = '';
      if (els.zMax) els.zMax.value = '';
      if (els.flipZ) els.flipZ.checked = false;
    }

    if (els.apply) els.apply.disabled = true;
    if (els.copy) {
      if ('disabled' in els.copy) els.copy.disabled = true;
      els.copy.setAttribute('aria-disabled', 'true');
    }
    if (els.json) els.json.textContent = '—';
    // 契约要求：打开时状态区为空
    setStatus('', '');
    switchTab('pick', { silent: true });
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    // 页签
    for (const tab of els.tabs) {
      on(tab, 'click', () => switchTab(tab.getAttribute('data-cal-tab')));
    }
    // 拾取按钮
    on(els.pickA, 'click', () => startPick('a'));
    on(els.pickB, 'click', () => startPick('b'));
    on(els.pickClear, 'click', clearPoints);
    // 世界坐标输入（实时解算）
    for (const input of [els.aX, els.aZ, els.bX, els.bZ]) {
      on(input, 'input', () => {
        if (state.tab !== 'pick') return;
        recompute();
      });
    }
    // 手动页签输入
    for (const input of [els.xMin, els.xMax, els.zMin, els.zMax]) {
      on(input, 'input', () => {
        state.manualDirty = true;
        if (state.tab === 'manual') recompute();
      });
    }
    on(els.flipZ, 'change', () => {
      state.manualDirty = true;
      if (state.tab === 'manual') recompute();
    });
    // 复制 / 重置 / 应用 / 取消 / 关闭
    on(els.copy, 'click', handleCopy);
    on(els.reset, 'click', handleReset);
    on(els.apply, 'click', handleApply);
    on(els.cancel, 'click', handleCancel);
    on(els.close, 'click', handleCancel);
    // 点遮罩关闭
    on(root, 'click', (e) => {
      if (e.target === root) handleCancel();
    });
    // Esc：拾取模式下只取消拾取，否则关闭向导
    // （app.js 检测到 #calibrator 打开时会跳过自己的 Esc 处理）
    on(
      window,
      'keydown',
      (e) => {
        if (state.closed) return;
        if (e.key === 'Escape' || e.key === 'Esc') {
          e.preventDefault();
          e.stopPropagation();
          if (state.pickTarget) cancelPick();
          else handleCancel();
        }
      },
      { capture: true },
    );
  }

  /* ---------- 打开 ---------- */
  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('cal-open');
  if (els.panel && !els.panel.hasAttribute('tabindex')) els.panel.setAttribute('tabindex', '-1');
  prefill();
  bind();

  // 焦点移入对话框（Esc / Tab 都在弹窗内更自然）
  const focusTarget = els.pickA || els.close || els.panel;
  if (focusTarget && typeof focusTarget.focus === 'function') {
    try {
      focusTarget.focus({ preventScroll: true });
    } catch (err) {
      focusTarget.focus();
    }
  }

  const handle = {
    close: handleCancel,
    apply: handleApply,
    isOpen: () => !state.closed,
    refresh: () => {
      if (!state.closed) recompute();
    },
  };

  activeSession = { state, handle, cancel: handleCancel };

  return handle;
}

/** 关闭当前打开的校准向导（不触发 onApply，会触发 onClose） */
export function closeCalibrator() {
  if (activeSession && typeof activeSession.cancel === 'function') {
    activeSession.cancel();
    return true;
  }
  return false;
}
