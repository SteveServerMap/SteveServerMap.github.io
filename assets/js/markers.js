/**
 * assets/js/markers.js —— 标记图层（ui-dev 拥有）
 *
 * 把「世界坐标路径点」渲染成 #overlay 里的屏幕坐标 <button class="marker">。
 *
 * 依赖边界（非常重要）：
 *   - 只调用 MapView 的公开方法：imageToViewport(px, py) / getViewState()；
 *   - 只调用 projection 的公开方法：worldToImage(x, z)；
 *   - 本文件不做任何世界坐标 ↔ 图片像素的投影数学，也不读 viewer.js 的私有字段；
 *   - 不 import coords.js，坐标显示格式化在本文件内完成（避免耦合与加载顺序问题）。
 *
 * 事件约定：
 *   - 点击标记：先 event.stopPropagation()，再 onSelect(waypoint)，并打开 .marker-popup；
 *   - 悬停标记：onHover(waypoint | null)；
 *   - 复制坐标：写入剪贴板后调用 onCopy(waypoint, { text, ok })（app 可据此弹 toast）；
 *   - 过滤 / 分组可见性变化后调用 onVisibleChange({ visible, total, hidden })（可选）。
 */

/** 契约 §7 的图标表：key -> emoji。sidebar.js 会复用这张表。 */
export const ICONS = Object.freeze({
  pin: '🧷',
  home: '🏠',
  village: '🏘️',
  farm: '🌾',
  mine: '⛏️',
  portal: '🌀',
  chest: '📦',
  diamond: '💎',
  skull: '☠️',
  tower: '🏰',
  ship: '⛵',
  mountain: '⛰️',
  redstone: '🔴',
  nether: '🐷',
  end: '🐉',
  shop: '🛒',
  spawn: '🌍',
  bed: '🛏️',
  pvp: '⚔️',
  event: '🎪',
  question: '❓',
});

const LABEL_MODES = ['always', 'hover', 'never'];

/** 屏幕距离 ≤ 这个值视为「堆在一起」：合成一个 ×N 徽标，点击可在同堆点之间轮换 */
const STACK_RADIUS_PX = 12;
/** 标签避让时两个标签之间至少留的间距 */
const LABEL_PAD_PX = 2;
/** 标记元素几何（与 style.css 的 .marker 一致：盒子 30×35，锚点在底边中点） */
const MARKER_W = 30;
const MARKER_H = 35;
const DEFAULT_COLOR = '#5ad26f';
const POPUP_GAP = 14;
const POPUP_MARGIN = 8;

/** 把坐标取整成显示字符串；非有限值显示 — */
function fmtBlock(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '—';
}

/**
 * 解析图标：ICONS 命中 → emoji；1~2 个字符（自定义 emoji / 短符号）→ 原样；其它 → pin。
 * @param {string} icon
 * @returns {string}
 */
export function resolveIcon(icon) {
  if (typeof icon !== 'string') return ICONS.pin;
  const value = icon.trim();
  if (!value) return ICONS.pin;
  if (Object.prototype.hasOwnProperty.call(ICONS, value)) return ICONS[value];
  if (Array.from(value).length <= 2) return value;
  return ICONS.pin;
}

/**
 * 路径点坐标文本。
 *   labels=true  → "X 0 · Y 65 · Z 0"，无 y 时 "X 0 · Z 0"
 *   labels=false → "0 65 0" / "0 0"（便于粘贴到 MC 聊天框）
 * @param {{x:number, y?:number|null, z:number}} waypoint
 * @param {{labels?: boolean}} [options]
 * @returns {string}
 */
export function formatWaypointCoords(waypoint, { labels = true } = {}) {
  if (!waypoint) return '';
  const hasY = Number.isFinite(waypoint.y);
  const keys = hasY ? ['X', 'Y', 'Z'] : ['X', 'Z'];
  const values = hasY ? [waypoint.x, waypoint.y, waypoint.z] : [waypoint.x, waypoint.z];
  if (labels) return values.map((value, i) => `${keys[i]} ${fmtBlock(value)}`).join(' · ');
  return values.map((value) => fmtBlock(value)).join(' ');
}

export class MarkerLayer {
  /**
   * @param {HTMLElement} overlayEl #overlay
   * @param {object} view MapView 实例
   * @param {{ onSelect?: Function, onHover?: Function, onCopy?: Function,
   *           onVisibleChange?: Function, labelMode?: 'always'|'hover'|'never' }} [options]
   */
  constructor(overlayEl, view, options = {}) {
    this.overlayEl = overlayEl || null;
    this.view = view || null;
    this.options = options || {};

    this.labelMode = LABEL_MODES.includes(this.options.labelMode) ? this.options.labelMode : 'hover';

    /** @type {Array<object>} */
    this.waypoints = [];
    /** @type {Array<object>} */
    this.groups = [];
    this.projection = null;

    this.selectedId = null;
    this.highlightId = null;

    this._byId = new Map();
    this._els = new Map();
    this._pos = new Map();
    /** 标签尺寸缓存：id → {w, h}（避免每帧读 offsetWidth 造成 layout thrash） */
    this._labelSize = new Map();
    /** 堆叠分组：id → [同堆 id...]（按 id 排序，点击时轮换） */
    this._stacks = new Map();
    this._groupVisible = new Map();
    this._visibleIds = new Set();
    this._filter = null;
    this._hoverId = null;

    this._popup = null;
    this._popupEls = null;
    this._popupSize = { width: 0, height: 0 };

    if (!this.overlayEl) {
      console.warn('[markers] 未找到 #overlay，MarkerLayer 处于空转状态');
      return;
    }
    this.overlayEl.dataset.labelMode = this.labelMode;

    this._onOverlayClick = (event) => this._handleClick(event);
    this._onOverlayPointerOver = (event) => this._handlePointerOver(event);
    this._onOverlayPointerOut = (event) => this._handlePointerOut(event);
    this._onOverlayPointerDown = (event) => this._handlePointerDown(event);
    this._onDocumentPointerDown = (event) => this._handleDocumentPointerDown(event);
    this._onDocumentKeyDown = (event) => this._handleDocumentKeyDown(event);

    this.overlayEl.addEventListener('click', this._onOverlayClick);
    this.overlayEl.addEventListener('pointerover', this._onOverlayPointerOver);
    this.overlayEl.addEventListener('pointerout', this._onOverlayPointerOut);
    this.overlayEl.addEventListener('pointerdown', this._onOverlayPointerDown);
    document.addEventListener('pointerdown', this._onDocumentPointerDown, true);
    document.addEventListener('keydown', this._onDocumentKeyDown);
  }

  /* ------------------------------------------------------------------ *
   * 数据
   * ------------------------------------------------------------------ */

  /**
   * 载入（或重建）当前维度的数据。只在切换维度 / 编辑配置后调用；
   * 视图变化请调用 update()，搜索过滤请调用 setFilter()。
   * @param {Array<object>} waypoints
   * @param {Array<object>} groups
   * @param {object|null} projection
   */
  setData(waypoints, groups, projection) {
    if (!this.overlayEl) return;
    this.waypoints = Array.isArray(waypoints)
      ? waypoints.filter((wp) => wp && wp.id != null).map((wp) => wp)
      : [];
    this.groups = Array.isArray(groups) ? groups.slice() : [];
    this.projection = projection || null;

    // 新数据集 = 新上下文（切换维度 / 重新载入 / 校准后重排）：
    // 清掉选中与弹窗，避免旧维度的选中 id 在新数据里“复活”弹出详情。
    this.selectedId = null;
    this.highlightId = null;
    this._hoverId = null;
    this._closePopup();

    this._labelSize.clear();
    this._stacks = new Map();
    this._byId = new Map(this.waypoints.map((wp) => [String(wp.id), wp]));
    this._groupVisible = new Map(this.groups.map((group) => [String(group.id), group.visible !== false]));

    this._buildMarkers();
    this.refresh();
  }

  /** 重新计算可见性（搜索过滤 / 分组显隐之后调用），返回可见 id 数组。 */
  refresh() {
    if (!this.overlayEl) return [];
    const visible = [];
    for (const wp of this.waypoints) {
      const id = String(wp.id);
      const marker = this._els.get(id);
      if (!marker) continue;
      const groupVisible = this._groupVisible.get(String(wp.group || 'default')) !== false;
      let passFilter = true;
      if (this._filter) {
        try {
          passFilter = !!this._filter(wp);
        } catch (error) {
          console.warn('[markers] filter 回调抛错，已按可见处理', error);
          passFilter = true;
        }
      }
      const shown = groupVisible && passFilter;
      marker.hidden = !shown;
      marker.classList.toggle('is-group-hidden', !groupVisible);
      marker.classList.toggle('is-filtered', !passFilter);
      if (shown) visible.push(wp.id);
    }
    this._visibleIds = new Set(visible.map(String));

    this.update();

    const selected = this.selectedId != null ? this._els.get(String(this.selectedId)) : null;
    if (!selected || selected.hidden) this._closePopup();
    else this._ensurePopupFor(this._byId.get(String(this.selectedId)));

    this._emit('onVisibleChange', {
      visible: this._visibleIds.size,
      total: this.waypoints.length,
      hidden: this.waypoints.length - this._visibleIds.size,
    });
    return visible;
  }

  /**
   * 搜索过滤。predicate(waypoint) => boolean；传 null / 非函数表示清除过滤。
   * 被过滤掉的标记会 hidden 并计入不可见。
   * @param {Function|null} predicate
   * @returns {string[]} 可见 id
   */
  setFilter(predicate) {
    this._filter = typeof predicate === 'function' ? predicate : null;
    return this.refresh();
  }

  /**
   * 分组显隐（与 sidebar 的 onToggleGroup 联动）。
   * @param {string} groupId
   * @param {boolean} visible
   * @returns {string[]} 可见 id
   */
  setGroupVisible(groupId, visible) {
    if (groupId == null) return [...this._visibleIds];
    this._groupVisible.set(String(groupId), visible !== false);
    return this.refresh();
  }

  /**
   * 标签策略。单个路径点的 label 字段优先。
   * @param {'always'|'hover'|'never'} mode
   */
  setLabelMode(mode) {
    this.labelMode = LABEL_MODES.includes(mode) ? mode : 'hover';
    this._labelSize.clear();
    if (this.overlayEl) this.overlayEl.dataset.labelMode = this.labelMode;
    for (const wp of this.waypoints) {
      const marker = this._els.get(String(wp.id));
      if (marker) this._applyLabelMode(marker, wp);
    }
  }

  /** 侧栏 hover / 选中的联动高亮。 */
  setHighlight(id) {
    this.highlightId = id != null ? String(id) : null;
    for (const [markerId, marker] of this._els) {
      marker.classList.toggle('is-highlighted', markerId === this.highlightId);
    }
  }

  /** 选中路径点并弹出详情卡片；传 null 关闭。 */
  setSelected(id) {
    this.selectedId = id != null ? String(id) : null;
    for (const [markerId, marker] of this._els) {
      marker.classList.toggle('is-selected', markerId === this.selectedId);
    }
    if (!this.selectedId) {
      this._closePopup();
      return;
    }
    const waypoint = this._byId.get(this.selectedId);
    const marker = this._els.get(this.selectedId);
    if (waypoint && marker && !marker.hidden) this._openPopup(waypoint);
    else this._closePopup();
  }

  /**
   * 契约要求的占位方法：视图平移由 app.js 负责（view.centerOnImagePoint 等），
   * 这里只返回路径点并展开详情。返回 null 表示没有该 id。
   * @param {string} id
   * @returns {object|null}
   */
  focusWaypoint(id) {
    const waypoint = id != null ? this._byId.get(String(id)) || null : null;
    if (waypoint) this.setSelected(waypoint.id);
    return waypoint;
  }

  /* ------------------------------------------------------------------ *
   * 视图更新（每帧调用，保持廉价：只写 transform / classList）
   * ------------------------------------------------------------------ */

  update() {
    if (!this.overlayEl) return;
    const state = this._viewState();
    let vw = state && Number.isFinite(state.viewWidth) && state.viewWidth > 0 ? state.viewWidth : 0;
    let vh = state && Number.isFinite(state.viewHeight) && state.viewHeight > 0 ? state.viewHeight : 0;
    if (!vw) vw = this.overlayEl.clientWidth;
    if (!vh) vh = this.overlayEl.clientHeight;

    for (const wp of this.waypoints) {
      const id = String(wp.id);
      const marker = this._els.get(id);
      if (!marker) continue;

      const point = this._projectToViewport(wp);
      const x = point ? point.x : 0;
      const y = point ? point.y : 0;

      const prev = this._pos.get(id);
      // 缓存必须等于「上次实际写入 DOM」的值：跳过写入时不能更新缓存，
      // 否则动画尾段每帧位移 < 0.25px 时缓存会悄悄漂移，
      // 末帧与漂移后缓存的差值仍 < 0.25，最终位置永远写不进去。
      if (!prev || Math.abs(prev.x - x) > 0.25 || Math.abs(prev.y - y) > 0.25) {
        marker.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        this._pos.set(id, { x, y });
      }

      const offscreen = !point || x < 0 || y < 0 || x > vw || y > vh;
      if (marker.classList.contains('is-offscreen') !== offscreen) {
        marker.classList.toggle('is-offscreen', offscreen);
      }
    }

    // 密集点去重叠：z 序 / 堆叠徽标 / 标签避让
    this._layoutDenseMarkers(vw, vh);

    if (this._popup && !this._popup.hidden) this._placePopup();
  }

  destroy() {
    if (this.overlayEl) {
      this.overlayEl.removeEventListener('click', this._onOverlayClick);
      this.overlayEl.removeEventListener('pointerover', this._onOverlayPointerOver);
      this.overlayEl.removeEventListener('pointerout', this._onOverlayPointerOut);
      this.overlayEl.removeEventListener('pointerdown', this._onOverlayPointerDown);
      delete this.overlayEl.dataset.labelMode;
    }
    document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
    document.removeEventListener('keydown', this._onDocumentKeyDown);

    this._closePopup();
    if (this._popup) {
      this._popup.remove();
      this._popup = null;
      this._popupEls = null;
    }
    this._removeMarkers();
    this.waypoints = [];
    this.groups = [];
    this.projection = null;
    this._byId.clear();
    this._pos.clear();
    this._visibleIds.clear();
    this._groupVisible.clear();
    this.selectedId = null;
    this.highlightId = null;
    this._filter = null;
  }

  /* ------------------------------------------------------------------ *
   * DOM 构建
   * ------------------------------------------------------------------ */

  _buildMarkers() {
    this._removeMarkers();
    this._pos.clear();
    this._closePopup();
    const fragment = document.createDocumentFragment();
    for (const wp of this.waypoints) {
      const id = String(wp.id);
      const marker = this._createMarker(wp);
      this._els.set(id, marker);
      fragment.appendChild(marker);
    }
    this.overlayEl.appendChild(fragment);
  }

  _removeMarkers() {
    for (const marker of this._els.values()) marker.remove();
    this._els.clear();
  }

  _createMarker(waypoint) {
    const id = String(waypoint.id);
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'marker';
    marker.dataset.id = id;
    marker.dataset.group = String(waypoint.group || 'default');
    marker.style.setProperty('--marker-color', this._colorOf(waypoint));
    marker.style.transform = 'translate3d(-9999px, -9999px, 0)';
    marker.setAttribute('aria-label', `${waypoint.name || id}（路径点）`);

    const pin = document.createElement('span');
    pin.className = 'marker-pin';

    const icon = document.createElement('span');
    icon.className = 'marker-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = resolveIcon(waypoint.icon);
    pin.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'marker-label';
    label.textContent = waypoint.name != null ? String(waypoint.name) : id;

    marker.append(pin, label);
    this._applyLabelMode(marker, waypoint);
    marker.classList.toggle('is-selected', this.selectedId != null && this.selectedId === id);
    marker.classList.toggle('is-highlighted', this.highlightId != null && this.highlightId === id);
    return marker;
  }


  /* ------------------------------------------------------------------ *
   * 密集点去重叠
   * ------------------------------------------------------------------ */

  /**
   * 屏幕上的路径点很密时，处理三件事：
   *   1. z 序：越靠下的标记盖住上面的（伪等距感），选中/悬停永远在最上层；
   *   2. 堆叠：屏幕距离 ≤ STACK_RADIUS_PX 的点视为一堆，最上面那个显示 ×N 徽标，
   *      连点同一个标记会在同堆点之间轮换选中（否则下面的点永远点不到）；
   *   3. 标签避让：只保留不互相遮挡的标签（选中/悬停的优先），其余加 .is-label-collided 隐藏。
   */
  _layoutDenseMarkers(viewWidth, viewHeight) {
    const items = [];
    for (const wp of this.waypoints) {
      const id = String(wp.id);
      const marker = this._els.get(id);
      if (!marker || marker.hidden) continue;
      if (marker.classList.contains('is-offscreen')) continue;
      const pos = this._pos.get(id);
      if (!pos) continue;
      items.push({ id, wp, marker, x: pos.x, y: pos.y });
    }

    /* ---------- 1) z 序 ---------- */
    const zOrder = [...items].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
    zOrder.forEach((item, index) => {
      let z = 10 + index;
      if (this.highlightId != null && String(this.highlightId) === item.id) z += 1000;
      if (this.selectedId != null && String(this.selectedId) === item.id) z += 2000;
      const text = String(z);
      if (item.marker.style.zIndex !== text) item.marker.style.zIndex = text;
    });

    /* ---------- 2) 堆叠 ---------- */
    this._stacks = new Map();
    const used = new Set();
    const stacks = [];
    for (const item of items) {
      if (used.has(item.id)) continue;
      const group = [item];
      used.add(item.id);
      for (const other of items) {
        if (used.has(other.id)) continue;
        if (Math.hypot(other.x - item.x, other.y - item.y) <= STACK_RADIUS_PX) {
          group.push(other);
          used.add(other.id);
        }
      }
      if (group.length > 1) stacks.push(group);
    }

    for (const item of items) item.marker.classList.remove('is-stacked');
    /** 堆叠分组 → 顶上的那个 id（标签避让时只留它的标签） */
    const stackTop = new Map();
    for (const group of stacks) {
      const members = group.map((entry) => entry.id).sort((a, b) => a.localeCompare(b));
      for (const id of members) this._stacks.set(id, members);
      // 徽标挂在「盖在最上面」的那个（y 最大）
      const top = group.reduce((acc, entry) => (entry.y >= acc.y ? entry : acc), group[0]);
      for (const id of members) stackTop.set(id, top.id);
      for (const entry of group) {
        entry.marker.classList.toggle('is-stacked', entry === top);
        entry.marker.dataset.stackSize = String(members.length);
      }
      let badge = top.marker.querySelector('.marker-stack');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'marker-stack';
        badge.setAttribute('aria-hidden', 'true');
        top.marker.appendChild(badge);
      }
      const text = `×${members.length}`;
      if (badge.textContent !== text) badge.textContent = text;
    }
    // 不在堆里的标记：清掉徽标与残留数据
    for (const item of items) {
      if (this._stacks.has(item.id)) continue;
      const badge = item.marker.querySelector('.marker-stack');
      if (badge) badge.remove();
      if (item.marker.dataset.stackSize) delete item.marker.dataset.stackSize;
    }

    /* ---------- 3) 标签避让 ---------- */
    const labelCandidates = [];
    for (const item of items) {
      const label = item.marker.querySelector('.marker-label');
      if (!label) continue;
      const mode = label.parentElement?.dataset.label || this.labelMode;
      const forceVisible =
        (this.selectedId != null && String(this.selectedId) === item.id) ||
        (this.highlightId != null && String(this.highlightId) === item.id);
      // 只有「常显」或「选中/悬停」的标签才需要参与避让（hover 标签平时不可见，不会挡人）
      if (!forceVisible && mode !== 'always') {
        item.marker.classList.remove('is-label-collided');
        continue;
      }
      let size = this._labelSize.get(item.id);
      if (!size) {
        // offsetWidth 在 visibility:hidden 时依然可测，所以这里能拿到真实尺寸
        size = { w: label.offsetWidth || 0, h: label.offsetHeight || 0 };
        if (size.w > 0 && size.h > 0) this._labelSize.set(item.id, size);
      }
      if (!size || !(size.w > 0)) continue;
      // 标签在标记盒子正上方：x 居中，底边贴着盒子顶边
      const rect = {
        left: item.x - size.w / 2,
        right: item.x + size.w / 2,
        top: item.y - MARKER_H - size.h,
        bottom: item.y - MARKER_H,
      };
      const priority = forceVisible ? 2 : 1;
      labelCandidates.push({ item, rect, priority });
    }

    // 选中/悬停的先放，然后按 y 从小到大（靠上的先占位，跟随视觉层级）
    labelCandidates.sort((a, b) => b.priority - a.priority || a.item.y - b.item.y || a.item.id.localeCompare(b.item.id));

    const placedLabels = [];
    const pinRects = items.map((item) => ({
      id: item.id,
      left: item.x - MARKER_W / 2,
      right: item.x + MARKER_W / 2,
      top: item.y - MARKER_H,
      bottom: item.y,
    }));

    const overlaps = (a, b) =>
      a.left < b.right + LABEL_PAD_PX &&
      a.right + LABEL_PAD_PX > b.left &&
      a.top < b.bottom + LABEL_PAD_PX &&
      a.bottom + LABEL_PAD_PX > b.top;

    for (const candidate of labelCandidates) {
      const { item, rect } = candidate;
      const stack = this._stacks.get(item.id);
      const topId = stackTop.get(item.id) || item.id;
      // 一堆叠在一起的点：只保留「顶」那个的标签，其余一律让位（否则满屏重叠）
      if (stack && topId !== item.id) {
        item.marker.classList.add('is-label-collided');
        continue;
      }
      // 同一个堆里的图标不算冲突（它们本来就在标签底下）
      const sameStack = stack ? new Set(stack) : null;
      const hitLabel = placedLabels.some((other) => overlaps(rect, other));
      const hitPin = pinRects.some(
        (pin) => pin.id !== item.id && !(sameStack && sameStack.has(pin.id)) && overlaps(rect, pin),
      );
      const collided = hitLabel || hitPin;
      item.marker.classList.toggle('is-label-collided', collided);
      if (!collided) placedLabels.push(rect);
    }
  }

  _applyLabelMode(marker, waypoint) {
    const mode = LABEL_MODES.includes(waypoint.label) ? waypoint.label : this.labelMode;
    marker.dataset.label = mode;
    marker.classList.toggle('label-always', mode === 'always');
    marker.classList.toggle('label-hover', mode === 'hover');
    marker.classList.toggle('label-never', mode === 'never');
    marker.classList.toggle('is-always', mode === 'always');
  }

  /* ------------------------------------------------------------------ *
   * 坐标换算（只消费 view / projection 的公开 API）
   * ------------------------------------------------------------------ */

  _viewState() {
    const view = this.view;
    if (!view || typeof view.getViewState !== 'function') return null;
    try {
      const state = view.getViewState();
      return state && typeof state === 'object' ? state : null;
    } catch (error) {
      return null;
    }
  }

  _projectToViewport(waypoint) {
    const projection = this.projection;
    if (!projection || typeof projection.worldToImage !== 'function') return null;
    let imagePoint = null;
    try {
      imagePoint = projection.worldToImage(waypoint.x, waypoint.z);
    } catch (error) {
      return null;
    }
    if (!imagePoint) return null;
    const px = imagePoint.px;
    const py = imagePoint.py;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;

    const view = this.view;
    if (view && typeof view.imageToViewport === 'function') {
      let point = null;
      try {
        point = view.imageToViewport(px, py);
      } catch (error) {
        point = null;
      }
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        return { x: point.x, y: point.y };
      }
    }

    // imageToViewport 不可用时的兜底：只用 MapView 公开的 viewState 做一次线性换算。
    const state = this._viewState();
    if (state && Number.isFinite(state.scale) && Number.isFinite(state.tx) && Number.isFinite(state.ty)) {
      return { x: state.tx + px * state.scale, y: state.ty + py * state.scale };
    }
    return null;
  }

  _colorOf(waypoint) {
    if (typeof waypoint.color === 'string' && waypoint.color) return waypoint.color;
    const groupId = String(waypoint.group || 'default');
    const group = this.groups.find((item) => String(item.id) === groupId);
    if (group && typeof group.color === 'string' && group.color) return group.color;
    return DEFAULT_COLOR;
  }

  /* ------------------------------------------------------------------ *
   * 交互
   * ------------------------------------------------------------------ */

  _handleClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const markerEl = target.closest('.marker');
    if (markerEl && this.overlayEl.contains(markerEl)) {
      event.preventDefault();
      event.stopPropagation();
      const clickedId = String(markerEl.dataset.id);
      const stack = this._stacks.get(clickedId);
      // 多个路径点叠在同一处时，连点同一个标记 = 在同堆点之间轮换选中
      if (stack && stack.length > 1) {
        const current = this.selectedId != null ? stack.indexOf(String(this.selectedId)) : -1;
        const nextId = current >= 0 ? stack[(current + 1) % stack.length] : clickedId;
        const nextWaypoint = this._byId.get(nextId) || this._byId.get(clickedId);
        if (nextWaypoint) {
          this.setSelected(nextWaypoint.id);
          this._emit('onSelect', nextWaypoint);
          return;
        }
      }
      const waypoint = this._byId.get(clickedId);
      if (!waypoint) return;
      this.setSelected(waypoint.id);
      this._emit('onSelect', waypoint);
      return;
    }

    if (this._popup && this._popup.contains(target)) {
      event.stopPropagation();
      const actionEl = target.closest('[data-act]');
      const action = actionEl ? actionEl.dataset.act : '';
      const waypoint = this.selectedId != null ? this._byId.get(this.selectedId) : null;
      if (action === 'close') {
        this.setSelected(null);
      } else if (action === 'copy' && waypoint) {
        this._copyWaypoint(waypoint);
      }
      return;
    }
  }

  _handlePointerDown(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // 弹窗上的按下不交给地图（弹窗自身可能要滚动）。
    // 标记本体放行冒泡：viewer 会跟踪按下——移动越阈值转地图拖拽，原地松手仍由 click 选中。
    if (this._popup && this._popup.contains(target)) {
      event.stopPropagation();
    }
  }

  _handlePointerOver(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const markerEl = target.closest('.marker');
    if (!markerEl || !this.overlayEl.contains(markerEl)) return;
    const related = event.relatedTarget;
    if (related instanceof Node && markerEl.contains(related)) return;
    const waypoint = this._byId.get(markerEl.dataset.id);
    if (!waypoint) return;
    markerEl.classList.add('is-hover');
    if (this._hoverId === String(waypoint.id)) return;
    this._hoverId = String(waypoint.id);
    this._emit('onHover', waypoint);
  }

  _handlePointerOut(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const markerEl = target.closest('.marker');
    if (!markerEl || !this.overlayEl.contains(markerEl)) return;
    const related = event.relatedTarget;
    if (related instanceof Node && markerEl.contains(related)) return;
    const waypoint = this._byId.get(markerEl.dataset.id);
    if (!waypoint) return;
    markerEl.classList.remove('is-hover');
    if (this._hoverId !== null && this._hoverId === String(waypoint.id)) {
      this._hoverId = null;
      this._emit('onHover', null);
    }
  }

  _handleDocumentPointerDown(event) {
    if (!this._popup || this._popup.hidden) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (this._popup.contains(target)) return;
    if (target.closest('.marker')) return;
    this.setSelected(null);
  }

  _handleDocumentKeyDown(event) {
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    if (!this._popup || this._popup.hidden) return;
    this.setSelected(null);
  }

  _copyWaypoint(waypoint) {
    const text = formatWaypointCoords(waypoint, { labels: false });
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text).then(
        () => this._emit('onCopy', waypoint, { text, ok: true }),
        () => this._copyFallback(waypoint, text),
      );
      return;
    }
    this._copyFallback(waypoint, text);
  }

  _copyFallback(waypoint, text) {
    let ok = false;
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand('copy');
      area.remove();
    } catch (error) {
      ok = false;
    }
    this._emit('onCopy', waypoint, { text, ok });
  }

  /* ------------------------------------------------------------------ *
   * 详情弹窗
   * ------------------------------------------------------------------ */

  _ensurePopup() {
    if (this._popup) return this._popup;
    const popup = document.createElement('div');
    popup.className = 'marker-popup';
    popup.hidden = true;
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', '路径点详情');
    popup.innerHTML = [
      '<button type="button" class="popup-close icon-btn tiny" data-act="close" aria-label="关闭详情">',
      '  <svg class="icon" aria-hidden="true"><use href="#i-close"></use></svg>',
      '</button>',
      '<div class="popup-head">',
      '  <span class="popup-icon" aria-hidden="true"></span>',
      '  <div class="popup-titles">',
      '    <h3 class="popup-title"></h3>',
      '    <div class="popup-group">',
      '      <span class="popup-dot" aria-hidden="true"></span>',
      '      <span class="popup-group-name"></span>',
      '    </div>',
      '  </div>',
      '</div>',
      '<p class="popup-desc"></p>',
      '<div class="popup-coords"></div>',
      '<div class="popup-actions">',
      '  <button type="button" class="popup-copy btn small" data-act="copy">',
      '    <svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg><span>复制坐标</span>',
      '  </button>',
      '  <a class="popup-link btn ghost small" target="_blank" rel="noreferrer noopener" hidden><span>打开链接</span></a>',
      '</div>',
    ].join('\n');

    this._popup = popup;
    this._popupEls = {
      icon: popup.querySelector('.popup-icon'),
      title: popup.querySelector('.popup-title'),
      dot: popup.querySelector('.popup-dot'),
      groupWrap: popup.querySelector('.popup-group'),
      group: popup.querySelector('.popup-group-name'),
      desc: popup.querySelector('.popup-desc'),
      coords: popup.querySelector('.popup-coords'),
      link: popup.querySelector('.popup-link'),
    };
    this.overlayEl.appendChild(popup);
    return popup;
  }

  _ensurePopupFor(waypoint) {
    if (!waypoint) return;
    if (this._popup && this._popup.dataset.id === String(waypoint.id) && !this._popup.hidden) {
      this._placePopup();
      return;
    }
    this._openPopup(waypoint);
  }

  _openPopup(waypoint) {
    if (!this.overlayEl || !waypoint) return;
    const popup = this._ensurePopup();
    const parts = this._popupEls;
    if (!parts) return;

    const group = this.groups.find((item) => String(item.id) === String(waypoint.group || 'default'));
    const color = this._colorOf(waypoint);
    popup.style.setProperty('--marker-color', color);
    popup.dataset.id = String(waypoint.id);

    parts.icon.textContent = resolveIcon(waypoint.icon);
    parts.title.textContent = waypoint.name != null ? String(waypoint.name) : String(waypoint.id);
    parts.dot.style.background = color;
    parts.group.textContent = group ? group.name || group.id : String(waypoint.group || '默认');
    // 未分组的点不显示「未分组」这一行
    parts.groupWrap.hidden = String(waypoint.group || 'default') === 'default';

    const description = waypoint.description != null ? String(waypoint.description) : '';
    parts.desc.textContent = description;
    parts.desc.hidden = description === '';

    parts.coords.textContent = '';
    const entries = [
      ['X', waypoint.x],
      ['Y', waypoint.y],
      ['Z', waypoint.z],
    ];
    for (const [key, value] of entries) {
      if (key === 'Y' && !Number.isFinite(value)) continue;
      const cell = document.createElement('span');
      cell.className = 'popup-coord';
      const keyEl = document.createElement('span');
      keyEl.className = 'coord-key';
      keyEl.textContent = key;
      const valueEl = document.createElement('span');
      valueEl.className = 'coord-val';
      valueEl.textContent = fmtBlock(value);
      cell.append(keyEl, valueEl);
      parts.coords.appendChild(cell);
    }

    if (parts.link) {
      if (typeof waypoint.url === 'string' && waypoint.url) {
        parts.link.href = waypoint.url;
        parts.link.hidden = false;
      } else {
        parts.link.removeAttribute('href');
        parts.link.hidden = true;
      }
    }

    popup.hidden = false;
    popup.classList.add('is-open');
    this._popupSize = { width: popup.offsetWidth, height: popup.offsetHeight };
    this._placePopup();
  }

  _placePopup() {
    const popup = this._popup;
    if (!popup || popup.hidden || this.selectedId == null) return;
    const point = this._pos.get(String(this.selectedId));
    if (!point) return;

    const state = this._viewState();
    let vw = state && Number.isFinite(state.viewWidth) && state.viewWidth > 0 ? state.viewWidth : 0;
    let vh = state && Number.isFinite(state.viewHeight) && state.viewHeight > 0 ? state.viewHeight : 0;
    if (!vw) vw = this.overlayEl.clientWidth;
    if (!vh) vh = this.overlayEl.clientHeight;

    const width = this._popupSize.width || popup.offsetWidth;
    const height = this._popupSize.height || popup.offsetHeight;
    this._popupSize = { width, height };

    let left = point.x + POPUP_GAP;
    let top = point.y - height - POPUP_GAP;
    let below = false;

    if (left + width > vw - POPUP_MARGIN) left = point.x - width - POPUP_GAP;
    if (left < POPUP_MARGIN) left = POPUP_MARGIN;
    if (left + width > vw - POPUP_MARGIN) left = Math.max(POPUP_MARGIN, vw - width - POPUP_MARGIN);

    if (top < POPUP_MARGIN) {
      below = true;
      top = point.y + POPUP_GAP;
    }
    if (top + height > vh - POPUP_MARGIN) {
      top = Math.max(POPUP_MARGIN, vh - height - POPUP_MARGIN);
      if (top < point.y) below = false;
    }

    popup.classList.toggle('is-below', below);
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  _closePopup() {
    if (!this._popup) return;
    this._popup.hidden = true;
    this._popup.classList.remove('is-open');
  }

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  _emit(name, ...args) {
    const handler = this.options ? this.options[name] : null;
    if (typeof handler !== 'function') return;
    try {
      handler(...args);
    } catch (error) {
      console.error(`[markers] ${name} 回调抛错`, error);
    }
  }
}

export default MarkerLayer;
