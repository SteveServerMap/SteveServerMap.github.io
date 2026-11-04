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
      if (!prev || Math.abs(prev.x - x) > 0.25 || Math.abs(prev.y - y) > 0.25) {
        marker.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        this._pos.set(id, { x, y });
      } else if (prev) {
        prev.x = x;
        prev.y = y;
      }

      const offscreen = !point || x < 0 || y < 0 || x > vw || y > vh;
      if (marker.classList.contains('is-offscreen') !== offscreen) {
        marker.classList.toggle('is-offscreen', offscreen);
      }
    }

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
      const waypoint = this._byId.get(markerEl.dataset.id);
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
    // 点击标记 / 弹窗时不要触发地图拖拽与 onMapClick（MapView 的点击判定基于 pointerdown）。
    if (target.closest('.marker') || (this._popup && this._popup.contains(target))) {
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
