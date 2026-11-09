/**
 * assets/js/sidebar.js —— 左侧路径点菜单（ui-dev 拥有）
 *
 * 只操作 index.html 里既有的节点：
 *   #sidebar #dimension-switch #waypoint-count #waypoint-search #search-clear
 *   #waypoint-list #waypoint-empty
 *   #sidebar-error #site-title #site-subtitle
 *   #sidebar-backdrop #btn-collapse #sidebar-toggle #btn-all-visible #btn-all-hidden
 *   #btn-sort #btn-toggle-labels #btn-fit #btn-grid #btn-reset #btn-copy-link
 *   #zoom-in #zoom-out #zoom-fit
 * 节点缺失时只 console.warn，不抛错（便于分阶段集成）。
 *
 * 图标与坐标格式化复用 markers.js 的导出（契约 §7：ICONS 写在 markers.js）。
 */

import { resolveIcon, formatWaypointCoords } from './markers.js';

const DEFAULT_COLOR = '#5ad26f';
const MOBILE_QUERY = '(max-width: 860px)';
const SORT_ORDER = ['name', 'x', 'z'];
const SORT_LABELS = { none: '配置顺序', name: '名称', x: 'X 坐标', z: 'Z 坐标' };

/** 元素 id 表：构造函数里逐个缓存，缺失就 warn。 */
const NODES = {
  dimensionSwitch: 'dimension-switch',
  count: 'waypoint-count',
  search: 'waypoint-search',
  searchClear: 'search-clear',
  groupList: 'group-list',
  waypointList: 'waypoint-list',
  waypointEmpty: 'waypoint-empty',
  sidebarError: 'sidebar-error',
  siteTitle: 'site-title',
  siteSubtitle: 'site-subtitle',
  backdrop: 'sidebar-backdrop',
  btnCollapse: 'btn-collapse',
  sidebarToggle: 'sidebar-toggle',
  btnAllVisible: 'btn-all-visible',
  btnAllHidden: 'btn-all-hidden',
  btnExpandAll: 'btn-expand-all',
  btnSort: 'btn-sort',
  btnToggleLabels: 'btn-toggle-labels',
  btnFit: 'btn-fit',
  btnGrid: 'btn-grid',
  btnReset: 'btn-reset',
  btnCopyLink: 'btn-copy-link',
  zoomIn: 'zoom-in',
  zoomOut: 'zoom-out',
  zoomFit: 'zoom-fit',
};

function roundBlock(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '—';
}

export class Sidebar {
  /**
   * @param {HTMLElement} rootEl #sidebar
   * @param {{
   *   onSelectWaypoint?: (id: string, waypoint?: object) => void,
   *   onHover?: (waypoint: object|null) => void,
   *   onToggleGroup?: (groupId: string, visible: boolean) => void,
   *   onDimensionChange?: (dimensionId: string) => void,
   *   onSearch?: (query: string) => void,
   *   onAction?: (name: string) => void,
   *   onToggleCollapsed?: (collapsed: boolean) => void,
   * }} [options]
   */
  constructor(rootEl, options = {}) {
    this.root = rootEl || document.getElementById('sidebar');
    this.options = options || {};

    this.el = {};
    for (const [key, id] of Object.entries(NODES)) {
      const node = document.getElementById(id);
      if (!node) console.warn(`[sidebar] 找不到节点 #${id}，对应功能已跳过`);
      this.el[key] = node;
    }

    this._listeners = [];
    this._raf = 0;

    this._waypoints = [];
    this._groups = [];
    this._byId = new Map();
    this._groupById = new Map();
    this._groupVisible = new Map();
    this._userGroupToggles = new Map();
    this._projection = null;
    this._dimension = null;
    this._dimensions = [];
    this._activeDimensionId = null;

    this._query = this.el.search ? String(this.el.search.value || '').trim() : '';
    this._sortMode = 'none';
    this._activeId = null;
    this._highlightId = null;
    this._hoverId = null;
    this._labelMode = 'hover';
    this._stats = null;
    this._visibleCount = 0;
    this._lastRenderedIds = [];
    this._loading = false;
    this._collapsed = document.body ? document.body.dataset.sidebar === 'collapsed' : false;

    /** 路径点列表里被折叠的分组：Set<"dimId::groupId">，持久化到 localStorage */
    this._collapsedGroups = new Set();
    this._collapsedGroupsKey = 'ssm.collapsedGroups.v1';
    try {
      const raw = localStorage.getItem(this._collapsedGroupsKey);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) this._collapsedGroups = new Set(list.map(String));
      }
    } catch {
      /* 忽略：隐私模式下 localStorage 可能不可用 */
    }

    this._bindEvents();
    this._syncSearchClear();
    this._updateSortButton();
    this._renderDimensions();
    this.setCollapsed(this._collapsed);
    this._renderCount();
  }

  /* ------------------------------------------------------------------ *
   * 公开 API（契约 §5）
   * ------------------------------------------------------------------ */

  /** @param {{title?: string, subtitle?: string}} info */
  setSiteInfo(info) {
    if (!info || typeof info !== 'object') return;
    if (typeof info.title === 'string' && info.title) {
      if (this.el.siteTitle) this.el.siteTitle.textContent = info.title;
      document.title = info.title;
    }
    if (typeof info.subtitle === 'string' && this.el.siteSubtitle) {
      this.el.siteSubtitle.textContent = info.subtitle;
    }
  }

  /**
   * 渲染维度切换按钮。
   * @param {Array<{id: string, name?: string}>} dimensions
   * @param {string} [activeId]
   */
  setDimensions(dimensions, activeId) {
    this._dimensions = Array.isArray(dimensions)
      ? dimensions.filter((dim) => dim && dim.id != null).map((dim) => dim)
      : [];
    if (activeId != null && activeId !== '') this._activeDimensionId = String(activeId);
    if (this._activeDimensionId == null) {
      const fallback = this._dimensions[0];
      if (fallback) this._activeDimensionId = String(fallback.id);
    }
    this._renderDimensions();
    this._updateBodyDimension();
  }

  /**
   * 载入当前维度的数据并渲染分组 + 列表。
   * @param {{waypoints?: Array<object>, groups?: Array<object>, projection?: object|null, dimension?: object}} payload
   */
  setData(payload = {}) {
    const data = payload || {};
    this._waypoints = Array.isArray(data.waypoints)
      ? data.waypoints.filter((wp) => wp && wp.id != null).map((wp) => wp)
      : [];
    this._groups = Array.isArray(data.groups) ? data.groups.slice() : [];
    this._projection = data.projection || null;
    if (data.dimension && typeof data.dimension === 'object') {
      this._dimension = data.dimension;
      if (data.dimension.id != null) this._activeDimensionId = String(data.dimension.id);
    }

    this._byId = new Map(this._waypoints.map((wp) => [String(wp.id), wp]));
    this._groupVisible = new Map(this._groups.map((group) => [String(group.id), group.visible !== false]));
    // 保留用户在本次会话里做过的分组显隐（app.js 的 state.visibleGroups 也是跨维度持久的），
    // 避免「全隐」后 app 重建 setData 把分组状态又拉回配置默认值。
    for (const [groupId, visible] of this._userGroupToggles) {
      if (this._groupVisible.has(groupId)) this._groupVisible.set(groupId, visible);
    }
    this._groupById = new Map(this._effectiveGroups().map((group) => [String(group.id), group]));
    this._stats = null;

    this._renderDimensions();
    this._renderGroups();
    this._updateBodyDimension();
    this._renderList();
  }

  /** 列表高亮并滚动到可见。 */
  setActiveWaypoint(id) {
    this._activeId = id != null ? String(id) : null;
    const list = this.el.waypointList;
    if (!list) return;
    let target = null;
    for (const item of list.querySelectorAll('.waypoint-item')) {
      const active = item.dataset.id === this._activeId;
      item.classList.toggle('is-active', active);
      if (active) {
        item.setAttribute('aria-current', 'true');
        target = item;
      } else {
        item.removeAttribute('aria-current');
      }
    }
    if (target && typeof target.scrollIntoView === 'function') {
      try {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (error) {
        target.scrollIntoView(false);
      }
    }
  }

  /** hover 高亮（不滚动）。 */
  setHighlight(id) {
    this._highlightId = id != null ? String(id) : null;
    const list = this.el.waypointList;
    if (!list) return;
    for (const item of list.querySelectorAll('.waypoint-item')) {
      item.classList.toggle('is-highlighted', item.dataset.id === this._highlightId);
    }
  }

  /**
   * 更新计数徽标。
   * @param {{total?: number, visible?: number, hidden?: number}} stats
   */
  setStats(stats) {
    if (!stats || typeof stats !== 'object') {
      this._stats = null;
    } else {
      this._stats = {
        total: Number.isFinite(stats.total) ? stats.total : this._waypoints.length,
        visible: Number.isFinite(stats.visible) ? stats.visible : this._visibleCount,
        hidden: Number.isFinite(stats.hidden) ? stats.hidden : null,
      };
    }
    this._renderCount();
  }

  /** 折叠 / 展开；通过 body[data-sidebar] 驱动 CSS。 */
  setCollapsed(collapsed) {
    this._collapsed = !!collapsed;
    if (document.body) {
      document.body.dataset.sidebar = this._collapsed ? 'collapsed' : 'open';
    }
    if (this.root) this.root.classList.toggle('is-collapsed', this._collapsed);
    if (this.el.sidebarToggle) {
      this.el.sidebarToggle.setAttribute('aria-expanded', this._collapsed ? 'false' : 'true');
    }
    this._syncBackdrop();
  }

  isCollapsed() {
    return this._collapsed;
  }

  setLoading(loading) {
    this._loading = !!loading;
    if (this.root) this.root.classList.toggle('is-loading', this._loading);
    if (this.el.waypointList) {
      this.el.waypointList.setAttribute('aria-busy', this._loading ? 'true' : 'false');
    }
    this._renderList();
  }

  /** 在列表区域显示错误；传 null 清除。 */
  setError(message) {
    const box = this.el.sidebarError;
    if (!box) return;
    if (message == null || message === '') {
      box.textContent = '';
      box.hidden = true;
      box.classList.remove('is-visible');
      return;
    }
    box.textContent = String(message);
    box.hidden = false;
    box.classList.add('is-visible');
  }

  /* ---- 约定之外的少量辅助方法（供 app.js 使用） ---- */

  /** 由 app.js 在分组显隐落盘 / 应用后调用，只更新 UI 不触发回调。 */
  setGroupVisibility(groupId, visible) {
    if (groupId == null) return;
    const id = String(groupId);
    this._groupVisible.set(id, visible !== false);
    this._userGroupToggles.set(id, visible !== false);
    this._renderGroups();
    this._renderList();
  }

  /** 让「标签」按钮反映当前标签策略：always / hover / never。 */
  setLabelMode(mode) {
    const btn = this.el.btnToggleLabels;
    if (!btn) return;
    if (mode === 'always' || mode === 'hover' || mode === 'never') this._labelMode = mode;
    const labels = { always: '常显', hover: '悬浮显示', never: '隐藏' };
    const current = this._labelMode || 'hover';
    btn.setAttribute('aria-pressed', current === 'always' ? 'true' : 'false');
    btn.title = `标签：${labels[current] || current}（点击切换）`;
    btn.classList.toggle('is-active', current === 'always');
  }

  /** 让「网格」按钮反映网格开关状态。 */
  setGridActive(active) {
    const btn = this.el.btnGrid;
    if (!btn) return;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('is-active', !!active);
  }

  getQuery() {
    return this._query;
  }

  /** 清空搜索框并恢复完整列表（切维度时用） */
  clearSearch() {
    if (!this.el.search) return this._query;
    this.el.search.value = '';
    this._handleSearchInput();
    return this._query;
  }

  focusSearch() {
    if (this.el.search && typeof this.el.search.focus === 'function') this.el.search.focus();
  }

  destroy() {
    for (const { node, type, handler, options } of this._listeners) {
      node.removeEventListener(type, handler, options);
    }
    this._listeners = [];
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    if (this._media && this._mediaHandler) {
      if (typeof this._media.removeEventListener === 'function') {
        this._media.removeEventListener('change', this._mediaHandler);
      } else if (typeof this._media.removeListener === 'function') {
        this._media.removeListener(this._mediaHandler);
      }
    }
    this._media = null;
    this._mediaHandler = null;
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */

  _on(node, type, handler, options) {
    if (!node || typeof node.addEventListener !== 'function') return;
    node.addEventListener(type, handler, options);
    this._listeners.push({ node, type, handler, options });
  }

  _emit(name, ...args) {
    const handler = this.options ? this.options[name] : null;
    if (typeof handler !== 'function') return;
    try {
      handler(...args);
    } catch (error) {
      console.error(`[sidebar] ${name} 回调抛错`, error);
    }
  }

  _bindEvents() {
    /* 折叠 */
    this._on(this.el.btnCollapse, 'click', () => this._userToggleCollapsed(true));
    this._on(this.el.sidebarToggle, 'click', () => this._userToggleCollapsed(!this._collapsed));
    this._on(this.el.backdrop, 'click', () => this._userToggleCollapsed(true));

    /* 搜索 */
    this._on(this.el.search, 'input', () => this._handleSearchInput());
    this._on(this.el.search, 'keydown', (event) => this._handleSearchKeydown(event));
    this._on(this.el.searchClear, 'click', () => {
      if (this.el.search) this.el.search.value = '';
      this._handleSearchInput();
      this.focusSearch();
    });

    /* 列表 / 分组（事件委托） */
    this._on(this.el.waypointList, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const item = target.closest('.waypoint-item');
      if (!item) return;
      event.preventDefault();
      this._selectWaypoint(item.dataset.id);
    });
    this._on(this.el.waypointList, 'pointerover', (event) => this._handleItemPointerOver(event));
    this._on(this.el.waypointList, 'pointerout', (event) => this._handleItemPointerOut(event));

    /* 路径点列表：点分组头折叠 / 点眼睛切换显隐 */
    this._on(this.el.waypointList, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const head = target.closest('.wp-group-head');
      if (!head) return;
      const actionEl = target.closest('[data-act="toggle"]');
      if (actionEl) {
        event.preventDefault();
        event.stopPropagation();
        this._toggleGroup(head.dataset.group);
        return;
      }
      event.preventDefault();
      this._toggleGroupCollapse(head.dataset.group);
    });
    this._on(this.el.waypointList, 'keydown', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const head = target.closest('.wp-group-head');
      if (!head) return;
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        this._toggleGroupCollapse(head.dataset.group);
      }
    });

    this._on(this.el.groupList, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const actionEl = target.closest('[data-act]');
      if (!actionEl) return;
      const row = actionEl.closest('.group-item');
      if (!row) return;
      if (actionEl.dataset.act === 'toggle') {
        event.preventDefault();
        this._toggleGroup(row.dataset.group);
      }
    });

    /* 维度切换 */
    this._on(this.el.dimensionSwitch, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('[data-dim]');
      if (!button) return;
      event.preventDefault();
      this._handleDimensionChange(button.dataset.dim);
    });
    this._on(this.el.dimensionSwitch, 'keydown', (event) => this._handleDimensionKeydown(event));

    /* 底部 / 顶栏按钮 → onAction(name) */
    const actionButtons = [
      [this.el.btnAllVisible, 'all-visible'],
      [this.el.btnAllHidden, 'all-hidden'],
      [this.el.btnExpandAll, 'expand-all'],
      [this.el.btnFit, 'fit'],
      [this.el.btnGrid, 'grid'],
      [this.el.btnReset, 'reset'],
      [this.el.btnCopyLink, 'copy-link'],
          [this.el.zoomIn, 'zoom-in'],
      [this.el.zoomOut, 'zoom-out'],
      [this.el.zoomFit, 'fit'],
    ];
    for (const [node, name] of actionButtons) {
      this._on(node, 'click', (event) => {
        // app.js 的 bindClick() 会 preventDefault()；若它已经处理了这个按钮，
        // 这里就不再重复派发 onAction，避免「点一次网格开关两次」这类双触发。
        if (event.defaultPrevented) return;
        // 全显 / 全隐：先在侧栏本地生效（app.js 随后会逐一调用 marks.setGroupVisible），
        // 这样即使 app 之后重建 setData，分组状态也不会被配置默认值覆盖。
        if (name === 'all-visible' || name === 'all-hidden') this._setAllGroupsVisible(name === 'all-visible');
        this._emit('onAction', name);
      });
    }
    this._on(this.el.btnToggleLabels, 'click', () => this._emit('onAction', 'toggle-labels'));
    this._on(this.el.btnSort, 'click', () => this._cycleSort());

    /* 移动端断点变化时同步 backdrop */
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this._media = window.matchMedia(MOBILE_QUERY);
      this._mediaHandler = () => this._syncBackdrop();
      if (typeof this._media.addEventListener === 'function') {
        this._media.addEventListener('change', this._mediaHandler);
      } else if (typeof this._media.addListener === 'function') {
        this._media.addListener(this._mediaHandler);
      }
    }
  }

  _userToggleCollapsed(collapsed) {
    this.setCollapsed(collapsed);
    this._emit('onToggleCollapsed', this._collapsed);
  }

  _syncBackdrop() {
    const backdrop = this.el.backdrop;
    if (!backdrop) return;
    const isMobile = this._media ? this._media.matches : false;
    backdrop.hidden = this._collapsed || !isMobile;
  }

  _handleSearchInput() {
    this._query = this.el.search ? String(this.el.search.value || '').trim() : '';
    this._syncSearchClear();
    this._scheduleRender();
    this._emit('onSearch', this._query);
  }

  _handleSearchKeydown(event) {
    if (event.key === 'Escape' || event.key === 'Esc') {
      if (!this.el.search || !this.el.search.value) return;
      event.preventDefault();
      this.el.search.value = '';
      this._handleSearchInput();
      return;
    }
    if (event.key === 'Enter') {
      const firstId = this._lastRenderedIds[0];
      if (!firstId) return;
      event.preventDefault();
      this._selectWaypoint(firstId);
    }
  }

  _handleDimensionChange(dimensionId) {
    if (dimensionId == null) return;
    const id = String(dimensionId);
    if (id === this._activeDimensionId) return;
    this._activeDimensionId = id;
    this._dimension = null;
    this._renderDimensions();
    this._updateBodyDimension();
    this._emit('onDimensionChange', id);
  }

  _handleDimensionKeydown(event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const box = this.el.dimensionSwitch;
    if (!box) return;
    const buttons = [...box.querySelectorAll('[data-dim]')];
    if (buttons.length < 2) return;
    const index = buttons.indexOf(document.activeElement);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = buttons[(index + step + buttons.length) % buttons.length];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  }

  _handleItemPointerOver(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest('.waypoint-item');
    if (!item) return;
    const related = event.relatedTarget;
    if (related instanceof Node && item.contains(related)) return;
    if (this._hoverId === item.dataset.id) return;
    this._hoverId = item.dataset.id;
    item.classList.add('is-hover');
    this._emitHover(this._byId.get(this._hoverId) || null);
  }

  _handleItemPointerOut(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest('.waypoint-item');
    if (!item) return;
    const related = event.relatedTarget;
    if (related instanceof Node && item.contains(related)) return;
    if (this._hoverId !== item.dataset.id) return;
    this._hoverId = null;
    item.classList.remove('is-hover');
    this._emitHover(null);
  }

  /**
   * 同时支持两种 hover 回调写法（app.js 用的是 onHoverWaypoint(id)）：
   *   onHoverWaypoint(id | null)  → 标记层 setHighlight(id)
   *   onHover(waypoint | null)    → 需要完整对象时使用
   */
  _emitHover(waypoint) {
    this._emit('onHoverWaypoint', waypoint ? waypoint.id : null);
    this._emit('onHover', waypoint);
  }

  _selectWaypoint(id) {
    if (id == null) return;
    const key = String(id);
    const waypoint = this._byId.get(key) || null;
    this.setActiveWaypoint(key);
    this._emit('onSelectWaypoint', key, waypoint);
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._renderList();
    });
  }

  _dimensionList() {
    if (this._dimensions.length) return this._dimensions;
    if (this._dimension) return [this._dimension];
    return [];
  }

  _currentDimension() {
    const list = this._dimensionList();
    const active = this._activeDimensionId;
    if (active != null) {
      const found = list.find((dim) => String(dim.id) === active);
      if (found) return found;
    }
    return this._dimension || list[0] || null;
  }

  _renderDimensions() {
    const box = this.el.dimensionSwitch;
    if (!box) return;
    const list = this._dimensionList();
    box.textContent = '';
    for (const dim of list) {
      const id = String(dim.id);
      const active = id === this._activeDimensionId;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dim-btn';
      button.dataset.dim = id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
      button.textContent = dim.name != null ? String(dim.name) : id;
      button.classList.toggle('is-active', active);
      box.appendChild(button);
    }
    if (!list.length) {
      const placeholder = document.createElement('span');
      placeholder.className = 'dim-empty';
      placeholder.textContent = '无维度';
      box.appendChild(placeholder);
    }
  }

  _renderGroups() {
    const box = this.el.groupList;
    if (!box) return;
    box.textContent = '';
    const groups = this._effectiveGroups();
    if (!groups.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '暂无分组';
      box.appendChild(empty);
      return;
    }
    for (const group of groups) {
      const id = String(group.id);
      const visible = this._isGroupVisible(id);
      const row = document.createElement('div');
      row.className = 'group-item';
      row.dataset.group = id;
      row.classList.toggle('is-off', !visible);

      const color = typeof group.color === 'string' && group.color ? group.color : DEFAULT_COLOR;
      const dot = document.createElement('span');
      dot.className = 'group-dot';
      dot.style.setProperty('--group-color', color);
      dot.style.background = color;

      const name = document.createElement('span');
      name.className = 'group-name';
      name.textContent = group.name != null ? String(group.name) : id;

      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = String(this._countInGroup(id));

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'group-eye icon-btn tiny';
      eye.dataset.act = 'toggle';
      eye.setAttribute('aria-pressed', visible ? 'true' : 'false');
      eye.setAttribute('aria-label', `${visible ? '隐藏' : '显示'}分组「${name.textContent}」`);
      eye.title = visible ? '隐藏该分组' : '显示该分组';
      eye.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${visible ? 'eye' : 'eye-off'}"></use></svg>`;

      row.append(dot, name, count, eye);
      box.appendChild(row);
    }
  }

  /** 折叠状态键：维度 + 分组（同一分组 id 在不同维度下互不影响） */
  _collapsedKey(groupId) {
    const dim = this._currentDimension();
    const dimId = dim && dim.id != null ? String(dim.id) : 'default';
    return dimId + '::' + groupId;
  }

  _isGroupCollapsed(groupId) {
    return this._collapsedGroups.has(this._collapsedKey(groupId));
  }

  /** 展开全部分组（列表头「展开」按钮 / 用户折叠乱了时的逃生口） */
  expandAllGroups() {
    this._collapsedGroups.clear();
    try {
      localStorage.setItem(this._collapsedGroupsKey, JSON.stringify([]));
    } catch {
      /* 忽略 */
    }
    this._renderList();
    return true;
  }

  _toggleGroupCollapse(groupId) {
    const key = this._collapsedKey(groupId);
    if (this._collapsedGroups.has(key)) this._collapsedGroups.delete(key);
    else this._collapsedGroups.add(key);
    try {
      localStorage.setItem(this._collapsedGroupsKey, JSON.stringify([...this._collapsedGroups]));
    } catch {
      /* 忽略 */
    }
    this._renderList();
  }

  _updateBodyDimension() {
    const dim = this._currentDimension();
    if (!dim) return;
    const id = String(dim.id);
    if (document.body) document.body.dataset.dimension = id;
  }

  _renderList() {
    const list = this.el.waypointList;
    const empty = this.el.waypointEmpty;

    this._stats = null;

    if (this._loading) {
      if (list) list.textContent = '';
      this._lastRenderedIds = [];
      this._visibleCount = 0;
      if (empty) {
        this._setEmptyText('载入中…');
        empty.hidden = false;
      }
      this._renderCount();
      return;
    }

    if (!list) {
      this._renderCount();
      return;
    }

    const matching = this._waypoints.filter((wp) => this._matchesQuery(wp, this._query));
    const sorted = this._sortWaypoints(matching);

    list.textContent = '';
    const fragment = document.createDocumentFragment();
    let visibleCount = 0;

    // 按分组归拢（顺序跟随分组定义），用可折叠的分组头包起来 —— 与配置工具的左树一致
    const groups = this._effectiveGroups();
    const order = new Map(groups.map((group, index) => [String(group.id), index]));
    const buckets = new Map();
    for (const waypoint of sorted) {
      const groupId = String(waypoint.group || 'default');
      if (!buckets.has(groupId)) buckets.set(groupId, []);
      buckets.get(groupId).push(waypoint);
    }
    const groupIds = [...buckets.keys()].sort((a, b) => {
      const ia = order.has(a) ? order.get(a) : Number.MAX_SAFE_INTEGER;
      const ib = order.has(b) ? order.get(b) : Number.MAX_SAFE_INTEGER;
      return ia === ib ? a.localeCompare(b, 'zh-CN') : ia - ib;
    });

    for (const groupId of groupIds) {
      const items = buckets.get(groupId);
      const group = this._groupById.get(groupId) || null;
      // 搜索时强制展开，否则用户搜到了却看不见
      const searching = !!this._query;
      const collapsed = !searching && this._isGroupCollapsed(groupId);
      const groupVisible = this._isGroupVisible(groupId);

      const section = document.createElement('section');
      section.className = 'wp-group';
      section.dataset.group = groupId;
      section.classList.toggle('is-collapsed', collapsed);
      section.classList.toggle('is-off', !groupVisible);

      const head = document.createElement('div');
      head.className = 'wp-group-head';
      head.dataset.act = 'toggle-collapse';
      head.dataset.group = groupId;
      head.setAttribute('role', 'button');
      head.tabIndex = 0;
      head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      head.title = collapsed ? '展开该分组的路径点' : '收起该分组的路径点';

      const caret = document.createElement('span');
      caret.className = 'wp-group-caret';
      caret.setAttribute('aria-hidden', 'true');
      caret.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chevron-down"></use></svg>';

      const dot = document.createElement('span');
      dot.className = 'group-dot';
      const color = (group && typeof group.color === 'string' && group.color) || DEFAULT_COLOR;
      dot.style.setProperty('--group-color', color);
      dot.style.background = color;

      const name = document.createElement('span');
      name.className = 'wp-group-name';
      name.textContent = (group && (group.name || group.id)) || (groupId === 'default' ? '默认' : groupId);

      const count = document.createElement('span');
      count.className = 'wp-group-count';
      count.textContent = String(items.length);

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'group-eye icon-btn tiny';
      eye.dataset.act = 'toggle';
      eye.setAttribute('aria-pressed', groupVisible ? 'true' : 'false');
      eye.setAttribute('aria-label', (groupVisible ? '隐藏' : '显示') + '分组「' + name.textContent + '」');
      eye.title = groupVisible ? '隐藏该分组' : '显示该分组';
      eye.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-' + (groupVisible ? 'eye' : 'eye-off') + '"></use></svg>';

      head.append(caret, dot, name, count, eye);

      const body = document.createElement('div');
      body.className = 'wp-group-items';
      body.setAttribute('role', 'group');
      for (const waypoint of items) {
        const item = this._createListItem(waypoint);
        if (groupVisible) visibleCount += 1;
        body.appendChild(item);
      }

      section.append(head, body);
      fragment.appendChild(section);
    }
    list.appendChild(fragment);

    this._lastRenderedIds = sorted.map((waypoint) => String(waypoint.id));
    this._visibleCount = visibleCount;

    this._lastRenderedIds = sorted.map((waypoint) => String(waypoint.id));
    this._visibleCount = visibleCount;

    if (empty) {
      const isEmpty = sorted.length === 0;
      empty.hidden = !isEmpty;
      if (isEmpty) {
        this._setEmptyText(this._waypoints.length === 0 ? '该维度暂无路径点' : '没有匹配的路径点');
      }
    }
    this._renderCount();
  }

  _createListItem(waypoint) {
    const id = String(waypoint.id);
    const group = this._groupById.get(String(waypoint.group || 'default')) || null;
    const color = (typeof waypoint.color === 'string' && waypoint.color)
      || (group && typeof group.color === 'string' && group.color)
      || DEFAULT_COLOR;

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'waypoint-item';
    item.dataset.id = id;
    item.setAttribute('role', 'listitem');
    item.style.setProperty('--marker-color', color);
    if (!this._isGroupVisible(waypoint.group)) item.classList.add('is-muted');
    if (this._activeId === id) {
      item.classList.add('is-active');
      item.setAttribute('aria-current', 'true');
    }
    if (this._highlightId === id) item.classList.add('is-highlighted');
    item.title = `${waypoint.name != null ? waypoint.name : id} · ${formatWaypointCoords(waypoint, { labels: false })}`;

    const icon = document.createElement('span');
    icon.className = 'waypoint-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = resolveIcon(waypoint.icon);

    const main = document.createElement('span');
    main.className = 'waypoint-main';

    const name = document.createElement('span');
    name.className = 'waypoint-name';
    name.textContent = waypoint.name != null ? String(waypoint.name) : id;

    const coords = document.createElement('span');
    coords.className = 'waypoint-coords';
    coords.textContent = formatWaypointCoords(waypoint);

    main.append(name, coords);

    item.append(icon, main);
    return item;
  }

  _setEmptyText(text) {
    const empty = this.el.waypointEmpty;
    if (!empty) return;
    for (const node of [...empty.childNodes]) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'svg') continue;
      node.remove();
    }
    empty.appendChild(document.createTextNode(text));
  }

  _renderCount() {
    const badge = this.el.count;
    if (!badge) return;
    const stats = this._stats;
    const total = stats ? stats.total : this._waypoints.length;
    const visible = stats ? stats.visible : this._visibleCount;
    badge.textContent = `${visible}/${total}`;
    const hidden = stats && stats.hidden != null ? stats.hidden : Math.max(0, total - visible);
    badge.title = `可见 ${visible} / 共 ${total}${hidden ? `（隐藏 ${hidden}）` : ''}`;
    badge.classList.toggle('is-empty', total === 0 || visible === 0);
  }

  _updateSortButton() {
    const button = this.el.btnSort;
    if (!button) return;
    const label = SORT_LABELS[this._sortMode] || SORT_LABELS.none;
    button.title = `排序：${label}（点击切换 名称 → X → Z）`;
    button.setAttribute('aria-pressed', this._sortMode === 'none' ? 'false' : 'true');
    button.classList.toggle('is-active', this._sortMode !== 'none');
  }

  _cycleSort() {
    const index = SORT_ORDER.indexOf(this._sortMode);
    this._sortMode = index === -1 ? SORT_ORDER[0] : SORT_ORDER[(index + 1) % SORT_ORDER.length];
    this._renderList();
    this._updateSortButton();
    this._emit('onAction', 'sort');
  }

  _sortWaypoints(list) {
    const mode = this._sortMode;
    const arr = list.slice();
    if (mode === 'none') return arr;
    const byName = (a, b) => String(a.name != null ? a.name : a.id)
      .localeCompare(String(b.name != null ? b.name : b.id), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    if (mode === 'name') {
      arr.sort(byName);
    } else if (mode === 'x') {
      arr.sort((a, b) => (Number(a.x) - Number(b.x)) || (Number(a.z) - Number(b.z)) || byName(a, b));
    } else if (mode === 'z') {
      arr.sort((a, b) => (Number(a.z) - Number(b.z)) || (Number(a.x) - Number(b.x)) || byName(a, b));
    }
    return arr;
  }

  /* ------------------------------------------------------------------ *
   * 分组 / 搜索工具
   * ------------------------------------------------------------------ */

  _effectiveGroups() {
    if (this._groups.length) return this._groups;
    const map = new Map();
    for (const waypoint of this._waypoints) {
      const id = String(waypoint.group || 'default');
      if (map.has(id)) continue;
      map.set(id, {
        id,
        name: id === 'default' ? '默认' : id,
        color: (typeof waypoint.color === 'string' && waypoint.color) || DEFAULT_COLOR,
        visible: true,
      });
    }
    return [...map.values()];
  }

  _isGroupVisible(groupId) {
    return this._groupVisible.get(String(groupId || 'default')) !== false;
  }

  _countInGroup(groupId) {
    const id = String(groupId);
    return this._waypoints.filter((waypoint) => String(waypoint.group || 'default') === id).length;
  }

  _toggleGroup(groupId) {
    if (groupId == null) return;
    const id = String(groupId);
    const next = !this._isGroupVisible(id);
    this._groupVisible.set(id, next);
    this._userGroupToggles.set(id, next);
    this._renderGroups();
    this._renderList();
    this._emit('onToggleGroup', id, next);
  }

  /** 「全显 / 全隐」的侧栏本地状态；app.js 会自动把标记层同步到同一状态。 */
  _setAllGroupsVisible(visible) {
    const next = visible !== false;
    for (const group of this._effectiveGroups()) {
      const id = String(group.id);
      this._groupVisible.set(id, next);
      this._userGroupToggles.set(id, next);
    }
    this._renderGroups();
    this._renderList();
  }

  /**
   * 与 app.js 的 matchQuery() 保持同一套判定，保证「侧栏列表可见项」= 「地图上可见标记」：
   * 名称 / 描述 / "x z" 坐标文本包含，以及 "x z" 两数字前缀匹配。
   */
  _matchesQuery(waypoint, rawQuery) {
    const query = String(rawQuery || '').trim().toLowerCase();
    if (!query) return true;

    const name = String(waypoint.name != null ? waypoint.name : waypoint.id).toLowerCase();
    if (name.includes(query)) return true;
    if (waypoint.description && String(waypoint.description).toLowerCase().includes(query)) return true;

    const coordText = `${roundBlock(waypoint.x)} ${roundBlock(waypoint.z)}`;
    if (coordText.includes(query)) return true;

    const numbers = query.match(/-?\d+(?:\.\d+)?/g);
    if (numbers && numbers.length >= 2) {
      const [rawX, rawZ] = numbers;
      const nx = String(Math.trunc(Number(rawX)));
      const nz = String(Math.trunc(Number(rawZ)));
      return String(Math.round(waypoint.x)).startsWith(nx) && String(Math.round(waypoint.z)).startsWith(nz);
    }
    return false;
  }

  _syncSearchClear() {
    if (!this.el.searchClear) return;
    this.el.searchClear.hidden = this._query.length === 0;
  }
}

export default Sidebar;
