/**
 * assets/js/viewer.js —— 地图平移 / 缩放引擎（MapView）
 * =============================================================================
 * 只操作 index.html 里已经存在的节点，不创建任何顶层 DOM：
 *   #viewport.map-viewport   裁剪容器（overflow:hidden / position:relative）
 *   #stage.map-stage         被 transform 的图层（内含底图元素）
 *   #overlay.map-overlay     屏幕坐标覆盖层（标记 / 网格 / 准星），不随 transform 缩放
 *
 * 底图元素（base layer）有两种，同一时刻只有一个可见，但「定位 / 变换 / 尺寸」的语义完全一样：
 *   <img id="map-image">      单张图片维度：由 setImage(url) 载入，尺寸取 naturalWidth/Height；
 *   <canvas id="map-canvas">  瓦片维度：由 setRasterBase({width,height}) 直接给出逻辑尺寸，
 *                             内容由 assets/js/tiles.js 的 TileLayer 绘制。
 *
 * 变换语义（契约 §3，全模块唯一真相）：
 *   图片像素 (px, py) → 视口 CSS 像素 (sx, sy) = (tx + px * scale, ty + py * scale)
 *   #stage 用 transform: translate3d(tx, ty, 0) scale(scale)，transform-origin: 0 0。
 *   CSS transform 的函数是「右到左」作用于点的：先 scale 再 translate，
 *   正好等价于 sx = tx + px * scale。
 *
 * 设计要点：
 *   - 状态（scale / tx / ty）只在本类里维护；DOM 写入只发生在 _applyTransform() 一处。
 *   - 每次状态变化后同步调用 onViewChange(viewState)，用 rAF 合并高频事件（指针移动）。
 *   - 拖拽用 Pointer Events + setPointerCapture；触摸双指捏合单独维护一套手势状态。
 *   - 键盘：+ / - 缩放，方向键平移（#viewport 有 tabindex=0）。
 *   - 非法 scale 只 console.warn + 钳制，绝不抛异常。
 *   - 零依赖、无构建步骤、原生 ES Module。
 */

/** 这些 UI 子元素上的指针/滚轮事件不参与地图拖拽与地图点击（标记由别的模块渲染，事件会冒泡到 viewport） */
const IGNORE_SELECTOR = [
  '.marker',
  '.marker-popup',
  '.zoom-panel',
  '.convert-panel',
  '.skin-panel',
  '.coord-readout',
  '.scale-bar',
  '.map-state',
  '.modal',
  '.measure-readout',
].join(', ');

const ANIM_DURATION = 220;      // 视图动画时长（ms，契约要求约 220ms）
const DRAG_THRESHOLD = 4;       // 拖拽判定阈值（px），超过则不算点击
const WHEEL_ZOOM_RATE = 0.0015; // 滚轮缩放灵敏度：scale *= exp(-deltaY * rate)
const KEY_ZOOM_STEP = 1.25;     // 键盘 / 按钮单次缩放倍率

/** 有限数字？ */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** 回调统一包一层 try/catch：外部模块（标记层 / 应用壳）报错不应该把地图引擎带崩 */
function safeCall(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch (err) {
    console.error('[MapView] 回调执行失败：', err);
  }
}

/** 写进 transform 字符串的数值：限制到 4 位小数，避免超长字符串与亚像素抖动 */
function n4(v) {
  return Math.round(v * 1e4) / 1e4;
}

export class MapView {
  /**
   * @param {HTMLElement} viewportEl #viewport 元素
   * @param {object} [options]
   * @param {(state: object) => void} [options.onViewChange] 每次变换后同步调用
   * @param {(imagePoint: {px:number, py:number}) => void} [options.onMapClick] 单击地图（拖拽结束不算）
   * @param {(imagePoint: {px:number, py:number}|null) => void} [options.onMapPointerMove] 悬停 / 移出（null）
   * @param {(imagePoint: {px:number, py:number}) => void} [options.onDoubleClick]
   * @param {number} [options.minScale=0.05]
   * @param {number} [options.maxScale=8]
   * @param {boolean} [options.minScaleFit=false] 为 true 时最小缩放取「整图适配」（地图最多缩到铺满视口，不会变成一个点）
   * @param {number} [options.minScaleFitFactor=1] 配合 minScaleFit 使用：1 = 整图；0.9 = 允许比整图再小 10%
   */
  constructor(viewportEl, {
    onViewChange,
    onMapClick,
    onMapPointerMove,
    onDoubleClick,
    minScale = 0.05,
    maxScale = 8,
    minScaleFit = false,
    minScaleFitFactor = 1,
  } = {}) {
    if (!viewportEl || typeof viewportEl.querySelector !== 'function') {
      throw new Error('[MapView] 构造函数需要一个 #viewport 元素');
    }

    this.viewport = viewportEl;
    this.stage = viewportEl.querySelector('#stage, .map-stage');
    // 单张图片底图 / 瓦片底图（canvas）。imageEl 始终指向「当前生效」的那一个。
    this.imgEl = viewportEl.querySelector('#map-image, .map-image')
      || (this.stage ? this.stage.querySelector('#map-image, .map-image') : null);
    this.canvasEl = viewportEl.querySelector('#map-canvas')
      || (this.stage ? this.stage.querySelector('#map-canvas') : null);
    this.imageEl = this.imgEl || this.canvasEl;
    this.overlayEl = viewportEl.querySelector('#overlay, .map-overlay');

    this.onViewChange = typeof onViewChange === 'function' ? onViewChange : null;
    this.onMapClick = typeof onMapClick === 'function' ? onMapClick : null;
    this.onMapPointerMove = typeof onMapPointerMove === 'function' ? onMapPointerMove : null;
    this.onDoubleClick = typeof onDoubleClick === 'function' ? onDoubleClick : null;

    // ---- 缩放范围 ----
    const min = Number(minScale);
    this.minScale = isNum(min) && min > 0 ? min : 0.05;
    const max = Number(maxScale);
    this.maxScale = isNum(max) && max > 0 ? max : 8;
    if (this.maxScale <= this.minScale) {
      console.warn('[MapView] maxScale 必须大于 minScale，已重置为 minScale * 10。');
      this.maxScale = this.minScale * 10;
    }
    this._minScaleFit = minScaleFit === true;
    const fitFactor = Number(minScaleFitFactor);
    this._minScaleFitFactor = isNum(fitFactor) && fitFactor > 0 ? Math.min(1, fitFactor) : 1;
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, 1));

    // ---- 平移量（视口 CSS 像素） ----
    this.tx = 0;
    this.ty = 0;

    // ---- 图片 / 投影 ----
    this._imageSize = null;     // {width, height} 图片原始像素尺寸
    this._projection = null;    // coords.createProjection 的产物
    this._loadToken = 0;        // 连续 setImage 的竞态令牌
    this._cancelImageLoad = null; // 解除监听并拒绝当前尚未完成的 setImage
    this._pendingAutoFit = false; // setImage 期间用户是否已经手动指定过视图

    // ---- 视口尺寸缓存（ResizeObserver 维护，读取时优先用实时 clientWidth） ----
    this._viewWidth = viewportEl.clientWidth || 0;
    this._viewHeight = viewportEl.clientHeight || 0;

    // ---- 交互状态 ----
    this._pointers = new Map(); // pointerId -> {x, y}（client 坐标）
    this._drag = null;          // 单指/鼠标拖拽状态
    this._pinch = null;         // 双指捏合状态
    this._anim = 0;             // requestAnimationFrame id
    this._destroyed = false;
    this._lastClampWarn = 0;

    // ---- 事件绑定 ----
    this._handlers = {};
    this._bind();

    // ---- 样式兜底：即使 style.css 没写到，也保证变换语义正确 ----
    this._applyStaticStyle();
    this.render();
  }

  /* ====================================================================== */
  /* 初始化 / 清理                                                          */
  /* ====================================================================== */

  /** 把与「变换语义」强相关的样式兜底设好（transform-origin 缺失会直接导致定位错乱） */
  _applyStaticStyle() {
    const vp = this.viewport;
    // 触摸设备上必须禁用浏览器默认手势，否则捏合会变成页面缩放而不是地图缩放
    vp.style.touchAction = 'none';
    vp.style.cursor = 'grab';

    if (this.stage) {
      const st = this.stage.style;
      st.transformOrigin = '0 0';
      // 兜底定位：舞台必须贴在视口左上角，否则 transform 的参考点会偏移
      st.position = 'absolute';
      st.left = '0px';
      st.top = '0px';
      st.willChange = 'transform';
      st.transform = 'translate3d(0px, 0px, 0) scale(1)';
      st.backfaceVisibility = 'hidden';
    }

    if (this.imageEl) {
      // 图片必须严格按「原始像素」布局，否则 scale=1 时 1 图片像素 ≠ 1 CSS 像素，
      // 标记层与底图就会错位。style.css 里的 max-width:100% 之类必须被覆盖。
      this.imageEl.style.maxWidth = 'none';
      this.imageEl.style.maxHeight = 'none';
      this.imageEl.style.display = 'block';
      this.imageEl.draggable = false;
    }
  }

  _bind() {
    const vp = this.viewport;

    this._handlers = {
      wheel: this._onWheel.bind(this),
      pointerdown: this._onPointerDown.bind(this),
      pointermove: this._onPointerMove.bind(this),
      pointerup: this._onPointerUp.bind(this),
      pointercancel: this._onPointerCancel.bind(this),
      pointerleave: this._onPointerLeave.bind(this),
      dblclick: this._onDoubleClick.bind(this),
      keydown: this._onKeyDown.bind(this),
    };

    // passive:false —— Ctrl/⌘ + 滚轮要能被我们接管（否则浏览器会缩放整个页面）
    vp.addEventListener('wheel', this._handlers.wheel, { passive: false });
    vp.addEventListener('pointerdown', this._handlers.pointerdown);
    vp.addEventListener('pointermove', this._handlers.pointermove);
    vp.addEventListener('pointerup', this._handlers.pointerup);
    vp.addEventListener('pointercancel', this._handlers.pointercancel);
    vp.addEventListener('pointerleave', this._handlers.pointerleave);
    vp.addEventListener('dblclick', this._handlers.dblclick);
    vp.addEventListener('keydown', this._handlers.keydown);

    // 视口尺寸变化（侧栏收起、窗口缩放、移动端旋转）
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(() => this._onResize());
      this._resizeObserver.observe(vp);
    }
  }

  /** 销毁：解绑所有监听、取消动画与观察者。可重复调用。 */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.cancelImageLoad();

    this._cancelAnim();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    const vp = this.viewport;
    vp.removeEventListener('wheel', this._handlers.wheel);
    vp.removeEventListener('pointerdown', this._handlers.pointerdown);
    vp.removeEventListener('pointermove', this._handlers.pointermove);
    vp.removeEventListener('pointerup', this._handlers.pointerup);
    vp.removeEventListener('pointercancel', this._handlers.pointercancel);
    vp.removeEventListener('pointerleave', this._handlers.pointerleave);
    vp.removeEventListener('dblclick', this._handlers.dblclick);
    vp.removeEventListener('keydown', this._handlers.keydown);

    this._pointers.clear();
    this._drag = null;
    this._pinch = null;
  }

  /* ====================================================================== */
  /* 渲染：DOM 写入的唯一出口                                                */
  /* ====================================================================== */

  /**
   * 把当前 {scale, tx, ty} 写到 #stage。
   * 只改一个 style 属性（transform），不碰 DOM 树结构，不触发布局回流（transform 走合成层）。
   */
  _applyTransform() {
    if (!this.stage) return;
    const { scale, tx, ty } = this;
    // 注意：这里必须用 translate3d + scale 的组合，顺序不能反。
    this.stage.style.transform =
      `translate3d(${n4(tx)}px, ${n4(ty)}px, 0) scale(${n4(scale)})`;
  }

  /** 同步通知外部：标记重排 / 坐标读数 / 比例尺都靠这个回调 */
  _emit() {
    if (!this.onViewChange) return;
    safeCall(this.onViewChange, this.getViewState());
  }

  /**
   * 状态变化统一出口：写 DOM → 同步通知。
   * @param {{scale:number, tx:number, ty:number}} state
   */
  _commit(state) {
    this.scale = state.scale;
    this.tx = state.tx;
    this.ty = state.ty;
    this._applyTransform();
    this._emit();
  }

  /**
   * 手动重绘：把当前状态同步写进 DOM。
   * 不触发 onViewChange —— 标记层可以在自己的重排逻辑里安全调用它做微调而不会递归。
   * （契约 §3：render() 供标记层用它对齐）
   */
  render() {
    this._applyTransform();
  }

  /* ====================================================================== */
  /* 尺寸 / 图片 / 投影                                                      */
  /* ====================================================================== */

  /** 视口实时尺寸（clientWidth/Height），隐藏时退化为缓存值，再退化为 1 防止除零 */
  _viewSize() {
    const w = this.viewport.clientWidth || this._viewWidth || 1;
    const h = this.viewport.clientHeight || this._viewHeight || 1;
    return { width: w, height: h };
  }

  /** 视口尺寸变化：保持「视口中心对应的图片点」不动，视觉上不跳 */
  _onResize() {
    if (this._destroyed) return;
    const w = this.viewport.clientWidth;
    const h = this.viewport.clientHeight;
    if (!(w > 0) || !(h > 0)) return;
    this._cancelAnim();

    const prevW = this._viewWidth;
    const prevH = this._viewHeight;
    this._viewWidth = w;
    this._viewHeight = h;

    if (prevW > 0 && prevH > 0 && (prevW !== w || prevH !== h) && this.scale > 0) {
      const cx = (prevW / 2 - this.tx) / this.scale;
      const cy = (prevH / 2 - this.ty) / this.scale;
      this.tx = w / 2 - cx * this.scale;
      this.ty = h / 2 - cy * this.scale;
    }

    // 视口尺寸变了 → 「整图适配」也变了，当前比例可能已经低于新的下限
    if (this._minScaleFit && this._imageSize) {
      const min = this._effectiveMinScale();
      if (this.scale < min - 1e-9) {
        const cx = (w / 2 - this.tx) / this.scale;
        const cy = (h / 2 - this.ty) / this.scale;
        this.scale = min;
        this.tx = w / 2 - cx * min;
        this.ty = h / 2 - cy * min;
      }
    }

    this._applyTransform();
    this._emit();
  }

  /** 取消尚未完成的图片加载；立即以 AbortError 拒绝旧 Promise，不等待网络事件。 */
  cancelImageLoad() {
    this._loadToken += 1;
    if (this._cancelImageLoad) this._cancelImageLoad();
  }

  /**
   * 载入基底图（单张图片）。resolve 后 getImageSize() 可用；失败时 reject（不抛同步异常）。
   * 被新图片 / 栅格替换、取消或销毁时以 AbortError reject。
   * 调用它会把底图元素切回 <img id="map-image">。
   * @param {string} url
   * @returns {Promise<{width:number, height:number}>}
   */
  setImage(url) {
    if (this._destroyed) return Promise.reject(new Error('[MapView] 已销毁'));
    const img = this.imgEl || this.imageEl;
    if (!img) return Promise.reject(new Error('[MapView] 找不到 #map-image 元素'));
    if (!url || typeof url !== 'string') {
      return Promise.reject(new Error('[MapView] setImage 需要一个图片地址'));
    }
    this._cancelAnim();
    this.cancelImageLoad();
    // 从瓦片维度切回来时，底图元素要换回 <img>
    this.setBaseLayer(img);

    const token = this._loadToken;
    this._pendingAutoFit = true; // 新图载入后若用户没动过视图，自动整图适配

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        if (this._cancelImageLoad === cancel) this._cancelImageLoad = null;
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const cancel = () => {
        const error = new Error(`[MapView] 图片加载已取消：${url}`);
        error.name = 'AbortError';
        fail(error);
      };

      const onLoad = () => {
        if (settled) return;
        if (token !== this._loadToken || this._destroyed) {
          cancel();
          return;
        }
        const width = img.naturalWidth || 0;
        const height = img.naturalHeight || 0;
        if (!(width > 0) || !(height > 0)) {
          fail(new Error(`[MapView] 图片尺寸无效：${url}`));
          return;
        }
        settled = true;
        cleanup();
        this._imageSize = { width, height };
        this._applyImageSize(width, height);
        if (this._pendingAutoFit) this._fitNow();
        this._applyTransform();
        this._emit();
        resolve({ width, height });
      };

      const onError = () => {
        if (token !== this._loadToken || this._destroyed) {
          cancel();
          return;
        }
        fail(new Error(`[MapView] 地图图片加载失败：${url}`));
      };

      this._cancelImageLoad = cancel;
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);

      // 同一张图已在缓存里时浏览器不会再触发 load，这里手动收尾
      const sameSrc = img.getAttribute('src') === url;
      if (sameSrc && img.complete && img.naturalWidth > 0) {
        onLoad();
        return;
      }

      try {
        img.src = url;
        // 极端情况：赋值后同步就 complete（data: URL、已缓存的小图等）
        if (img.complete && img.naturalWidth > 0 && img.getAttribute('src') === url) onLoad();
      } catch (error) {
        fail(error);
      }
    });
  }

  /**
   * 切换当前底图元素（<img> 或 <canvas>）。
   * 两种元素的定位 / 变换语义完全一致：都是 #stage 的子节点、按「原始像素」布局。
   * @param {Element|null} el
   * @returns {Element|null} 切换后的底图元素
   */
  setBaseLayer(el) {
    if (!el || el === this.imageEl) return this.imageEl;
    this.imageEl = el;
    this._applyStaticStyle();
    if (this._imageSize) this._applyImageSize(this._imageSize.width, this._imageSize.height);
    return this.imageEl;
  }

  /**
   * 直接把底图设成「已知逻辑尺寸的栅格」（瓦片底图的 <canvas>）。
   * 与 setImage 的区别：不加载网络图片，尺寸由调用方给出（瓦片 manifest 的世界跨度），
   * 内容由 TileLayer 自己画。
   *
   * @param {{width:number, height:number, element?: Element}} params
   * @returns {Promise<{width:number, height:number}>}
   */
  setRasterBase({ width, height, element } = {}) {
    if (this._destroyed) return Promise.reject(new Error('[MapView] 已销毁'));
    const w = Number(width);
    const h = Number(height);
    if (!(w > 0) || !(h > 0)) {
      return Promise.reject(new Error('[MapView] setRasterBase 需要正的 width / height'));
    }
    const layer = element || this.canvasEl;
    if (!layer) return Promise.reject(new Error('[MapView] 找不到瓦片底图 <canvas id="map-canvas">'));

    // 抢占 setImage：旧 Promise 立即结束，旧动画也不能覆盖新尺寸下的视图
    this._cancelAnim();
    this.cancelImageLoad();
    this.setBaseLayer(layer);
    this._pendingAutoFit = true;
    this._imageSize = { width: w, height: h };
    this._applyImageSize(w, h);
    if (this._pendingAutoFit) this._fitNow();
    this._applyTransform();
    this._emit();
    return Promise.resolve({ width: w, height: h });
  }

  /** 把图片原始尺寸写进 #stage / 底图元素的内联样式，保证 1 图片像素 = 1 CSS 像素（scale=1 时） */
  _applyImageSize(width, height) {
    if (this.stage) {
      this.stage.style.width = `${width}px`;
      this.stage.style.height = `${height}px`;
    }
    // 瓦片底图的 <canvas> 由 TileLayer 按视口摆放 CSS 盒（视口渲染），这里只摆 <img>
    if (this.imageEl && this.imageEl !== this.canvasEl) {
      this.imageEl.style.width = `${width}px`;
      this.imageEl.style.height = `${height}px`;
      this.imageEl.style.maxWidth = 'none';
      this.imageEl.style.maxHeight = 'none';
    }
  }

  /** @returns {{width:number, height:number}|null} setImage resolve 之前恒为 null */
  getImageSize() {
    return this._imageSize ? { width: this._imageSize.width, height: this._imageSize.height } : null;
  }

  /** 保存当前投影（coords.createProjection 的产物），供 getWorldAt / clientToWorld 使用 */
  setProjection(projection) {
    this._projection = projection && typeof projection === 'object' ? projection : null;
    this._applyTransform();
    this._emit();
  }

  /** @returns {object|null} */
  getProjection() {
    return this._projection;
  }

  /* ====================================================================== */
  /* 视图状态                                                               */
  /* ====================================================================== */

  /** @returns {{scale:number, tx:number, ty:number, viewWidth:number, viewHeight:number, imageWidth:number, imageHeight:number}} */
  getViewState() {
    const { width, height } = this._viewSize();
    return {
      scale: this.scale,
      tx: this.tx,
      ty: this.ty,
      viewWidth: width,
      viewHeight: height,
      imageWidth: this._imageSize ? this._imageSize.width : 0,
      imageHeight: this._imageSize ? this._imageSize.height : 0,
    };
  }

  /**
   * 直接设置视图状态（会钳制 scale）。
   * @param {{scale?:number, tx?:number, ty?:number}} state
   * @param {{animate?:boolean}} [options]
   */
  setViewState(state, { animate = false } = {}) {
    if (!state || typeof state !== 'object') return;
    const target = this._resolveState(state);
    this._pendingAutoFit = false;
    if (animate) {
      this._animateTo(target);
    } else {
      this._cancelAnim();
      this._commit(target);
    }
  }

  /** 把不完整的 state 补全 + 钳制为合法状态 */
  _resolveState(state = {}) {
    const scale = this._resolveScale(state.scale, this.scale);
    const tx = Number(state.tx);
    const ty = Number(state.ty);
    return {
      scale,
      tx: Number.isFinite(tx) ? tx : this.tx,
      ty: Number.isFinite(ty) ? ty : this.ty,
    };
  }

  /**
   * 解析/钳制缩放值：非法值告警并保留 fallback，越界则钳制到 [minScale, maxScale]。
   * @param {unknown} value
   * @param {number} fallback
   * @returns {number}
   */
  _resolveScale(value, fallback) {
    if (value === undefined || value === null) return fallback;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) {
      console.warn(`[MapView] 非法缩放值已忽略：${String(value)}（保持当前比例）`);
      return fallback;
    }
    const minScale = this._effectiveMinScale();
    if (v < minScale) {
      this._warnClamp();
      return minScale;
    }
    if (v > this.maxScale) {
      this._warnClamp();
      return this.maxScale;
    }
    return v;
  }

  /** 越界钳制的告警：同一条消息 1.2 秒内只打一次，避免滚轮刷屏 */
  _warnClamp() {
    const t = nowMs();
    if (t - this._lastClampWarn < 1200) return;
    this._lastClampWarn = t;
    console.warn(`[MapView] 缩放比例超出范围，已钳制到 [${this._effectiveMinScale()}, ${this.maxScale}]。`);
  }

  /* ====================================================================== */
  /* 缩放 / 平移                                                            */
  /* ====================================================================== */

  /**
   * 以某个视口坐标为锚点按倍率缩放（默认视口中心）。
   * @param {number} factor 倍率（>1 放大，<1 缩小）
   * @param {{x:number, y:number}} [anchorViewportPoint] 相对视口左上角的 CSS 像素
   * @param {{animate?:boolean}} [options] 额外扩展：允许按钮做动画缩放（默认 false，滚轮用）
   */
  zoomBy(factor, anchorViewportPoint, { animate = false } = {}) {
    const f = Number(factor);
    if (!Number.isFinite(f) || f <= 0) {
      console.warn(`[MapView] 非法缩放倍率已忽略：${String(factor)}`);
      return;
    }
    const { width, height } = this._viewSize();
    const anchor = anchorViewportPoint
      && Number.isFinite(Number(anchorViewportPoint.x))
      && Number.isFinite(Number(anchorViewportPoint.y))
      ? { x: Number(anchorViewportPoint.x), y: Number(anchorViewportPoint.y) }
      : { x: width / 2, y: height / 2 };

    const target = this._zoomTarget(f, anchor);
    this._pendingAutoFit = false;
    if (animate) {
      this._animateTo(target);
    } else {
      this._cancelAnim();
      this._commit(target);
    }
  }

  /** 计算以 anchor 为不动点、缩放 factor 倍之后的目标状态 */
  _zoomTarget(factor, anchor) {
    const next = this._resolveScale(this.scale * factor, this.scale);
    // 锚点下方的图片像素坐标（缩放前后必须保持不变）
    const imgX = (anchor.x - this.tx) / this.scale;
    const imgY = (anchor.y - this.ty) / this.scale;
    return {
      scale: next,
      tx: anchor.x - imgX * next,
      ty: anchor.y - imgY * next,
    };
  }

  /** 整图适配比例 */
  /** 不钳制的「整图适配」比例（内部用，避免和动态下限互相递归） */
  _rawFitScale(padding = 24) {
    if (!this._imageSize) return this.scale;
    const { width, height } = this._viewSize();
    const p = Math.max(0, Number(padding) || 0);
    const usableW = Math.max(1, width - p * 2);
    const usableH = Math.max(1, height - p * 2);
    return Math.min(usableW / this._imageSize.width, usableH / this._imageSize.height);
  }

  /**
   * 实际生效的最小缩放。
   * 默认就是构造参数 minScale（老行为）；开启 minScaleFit 后不小于「整图适配」，
   * 这样无论怎么滚轮缩小，地图最多缩到刚好铺满视口，不会缩成一个看不清的小点。
   */
  _effectiveMinScale() {
    if (!this._minScaleFit || !this._imageSize) return this.minScale;
    const fit = this._rawFitScale(24) * (this._minScaleFitFactor || 1);
    return Math.max(this.minScale, Math.min(this.maxScale, fit));
  }

  _fitScale(padding) {
    if (!this._imageSize) return this.scale;
    const raw = this._rawFitScale(padding);
    return this._resolveScale(raw, this.scale);
  }

  /** 立即整图适配（不通知，供 setImage 内部使用；公开 API 见 fitToContent） */
  _fitNow() {
    if (!this._imageSize) return;
    const { width, height } = this._viewSize();
    const scale = this._fitScale(24);
    this.scale = scale;
    this.tx = (width - this._imageSize.width * scale) / 2;
    this.ty = (height - this._imageSize.height * scale) / 2;
  }

  /**
   * 整图适配：让整张底图完整落在视口内（留 padding）。
   * @param {{padding?:number, animate?:boolean}} [options]
   */
  fitToContent({ padding = 24, animate = false } = {}) {
    if (!this._imageSize) {
      console.warn('[MapView] fitToContent：图片尚未载入');
      return;
    }
    this._pendingAutoFit = false;
    const { width, height } = this._viewSize();
    const scale = this._fitScale(padding);
    const target = {
      scale,
      tx: (width - this._imageSize.width * scale) / 2,
      ty: (height - this._imageSize.height * scale) / 2,
    };
    if (animate) this._animateTo(target);
    else {
      this._cancelAnim();
      this._commit(target);
    }
  }

  /**
   * 适配到图片上的某个矩形（图片像素坐标）。
   * @param {{px:number, py:number, width:number, height:number}} rect
   * @param {{padding?:number, animate?:boolean}} [options]
   */
  fitToImageRect({ px, py, width, height } = {}, { padding = 24, animate = false } = {}) {
    const rx = Number(px);
    const ry = Number(py);
    const rw = Number(width);
    const rh = Number(height);
    if (![rx, ry, rw, rh].every(Number.isFinite) || !(rw > 0) || !(rh > 0)) {
      console.warn('[MapView] fitToImageRect：矩形参数非法，已忽略');
      return;
    }
    this._pendingAutoFit = false;
    const view = this._viewSize();
    const p = Math.max(0, Number(padding) || 0);
    const usableW = Math.max(1, view.width - p * 2);
    const usableH = Math.max(1, view.height - p * 2);
    const scale = this._resolveScale(Math.min(usableW / rw, usableH / rh), this.scale);
    const target = {
      scale,
      tx: (view.width - rw * scale) / 2 - rx * scale,
      ty: (view.height - rh * scale) / 2 - ry * scale,
    };
    if (animate) this._animateTo(target);
    else {
      this._cancelAnim();
      this._commit(target);
    }
  }

  /**
   * 把某个图片像素点放到视口正中。
   * @param {number} px 图片像素 X
   * @param {number} py 图片像素 Y
   * @param {{scale?:number, animate?:boolean}} [options]
   */
  centerOnImagePoint(px, py, { scale, animate = true } = {}) {
    const ix = Number(px);
    const iy = Number(py);
    if (!Number.isFinite(ix) || !Number.isFinite(iy)) {
      console.warn('[MapView] centerOnImagePoint：坐标非法，已忽略');
      return;
    }
    this._pendingAutoFit = false;
    const { width, height } = this._viewSize();
    const nextScale = this._resolveScale(scale, this.scale);
    const target = {
      scale: nextScale,
      tx: width / 2 - ix * nextScale,
      ty: height / 2 - iy * nextScale,
    };
    if (animate) this._animateTo(target);
    else {
      this._cancelAnim();
      this._commit(target);
    }
  }

  /**
   * 回到初始视图：缩放回到「整图适配」级别，并把世界原点 (0, 0)（无投影时退化为图片中心）放到视口正中。
   * 动画 220ms。index.html 的 #btn-reset 标题是「回到原点 (0,0)」，语义对齐。
   */
  resetView() {
    if (!this._imageSize) {
      console.warn('[MapView] resetView：图片尚未载入');
      return;
    }
    this._pendingAutoFit = false;
    const { width, height } = this._viewSize();
    const scale = this._fitScale(24);

    let cx = this._imageSize.width / 2;
    let cy = this._imageSize.height / 2;
    const proj = this._projection;
    if (proj && typeof proj.worldToImage === 'function' && proj.isValid !== false) {
      const p = proj.worldToImage(0, 0);
      if (Number.isFinite(p.px) && Number.isFinite(p.py)) {
        cx = p.px;
        cy = p.py;
      }
    }

    this._animateTo({
      scale,
      tx: width / 2 - cx * scale,
      ty: height / 2 - cy * scale,
    });
  }

  /* ====================================================================== */
  /* 动画                                                                   */
  /* ====================================================================== */

  _cancelAnim() {
    if (this._anim) {
      cancelAnimationFrame(this._anim);
      this._anim = 0;
    }
  }

  /**
   * ease-out 动画到目标状态（约 220ms）。
   * 动画帧本身就是 rAF，所以每帧直接 _emit()，天然按帧合并。
   * @param {{scale:number, tx:number, ty:number}} target
   * @param {number} [duration]
   */
  _animateTo(target, duration = ANIM_DURATION) {
    this._cancelAnim();

    const to = target;
    const from = { scale: this.scale, tx: this.tx, ty: this.ty };
    const reduceMotion = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduceMotion || !(duration > 0)) {
      this._commit(to);
      return;
    }

    const startAt = nowMs();
    const step = () => {
      if (this._destroyed) {
        this._anim = 0;
        return;
      }
      const raw = Math.min(1, (nowMs() - startAt) / duration);
      const k = easeOutCubic(raw);

      if (raw >= 1) {
        this.scale = to.scale;
        this.tx = to.tx;
        this.ty = to.ty;
      } else {
        this.scale = from.scale + (to.scale - from.scale) * k;
        this.tx = from.tx + (to.tx - from.tx) * k;
        this.ty = from.ty + (to.ty - from.ty) * k;
      }

      this._applyTransform();
      this._emit();

      this._anim = raw < 1 ? requestAnimationFrame(step) : 0;
    };

    this._anim = requestAnimationFrame(step);
  }

  /* ====================================================================== */
  /* 坐标换算                                                               */
  /* ====================================================================== */

  /** client 坐标 → 视口内 CSS 像素坐标 */
  _localPoint(clientX, clientY) {
    const rect = this.viewport.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  /**
   * 屏幕坐标（页面 clientX/clientY）→ 图片像素坐标。
   * 永远返回 {px, py}，不抛异常（scale 恒 > 0，不会除零）。
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{px:number, py:number}}
   */
  viewportToImage(clientX, clientY) {
    const p = this._localPoint(Number(clientX), Number(clientY));
    // 与 #stage 实际渲染状态一致：_applyTransform 写 DOM 时把 tx/ty/scale 舍入到 4 位小数，
    // 这里用同一份舍入值反解，点击命中与屏幕上真实显示的图片逐像素对齐。
    const { tx, ty, scale } = this._renderState();
    return {
      px: (p.x - tx) / scale,
      py: (p.y - ty) / scale,
    };
  }

  /**
   * 图片像素坐标 → 视口内 CSS 像素坐标（相对视口左上角）。
   * 图片未载入 / 无投影时同样安全返回（纯变换计算，不抛错）；
   * 调用方可以用 getImageSize() 判断是否该渲染标记。
   * @param {number} px
   * @param {number} py
   * @returns {{x:number, y:number}}
   */
  imageToViewport(px, py) {
    // 必须用「实际渲染」的舍入状态（n4）：标记层不在 #stage 变换内，
    // 若用未舍入的 tx/scale，标记与屏幕上真实渲染的图片之间会有
    // 图片像素 × 舍入误差（最大 ~2px）的系统偏差。
    const { tx, ty, scale } = this._renderState();
    return {
      x: tx + Number(px) * scale,
      y: ty + Number(py) * scale,
    };
  }

  /** #stage 实际渲染用的状态：tx/ty/scale 舍入到 4 位小数（与 _applyTransform 完全一致） */
  _renderState() {
    return { tx: n4(this.tx), ty: n4(this.ty), scale: n4(this.scale) };
  }

  /**
   * 图片像素 → 页面 client 坐标（标记层 / 弹窗定位用）。
   * @param {number} px
   * @param {number} py
   * @returns {{x:number, y:number}}
   */
  imageToClient(px, py) {
    const rect = this.viewport.getBoundingClientRect();
    const p = this.imageToViewport(px, py);
    return { x: p.x + rect.left, y: p.y + rect.top };
  }

  /**
   * 屏幕坐标 → 世界坐标（无投影时返回 null）。
   * 契约 §3 的 setProjection 注释里提到的 getWorldAt 就是它：读取鼠标下方世界坐标。
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{x:number, z:number}|null}
   */
  clientToWorld(clientX, clientY) {
    const proj = this._projection;
    if (!proj || typeof proj.imageToWorld !== 'function') return null;
    const { px: ix, py: iy } = this.viewportToImage(clientX, clientY);
    const w = proj.imageToWorld(ix, iy);
    return { x: w.x, z: w.z };
  }

  /** clientToWorld 的别名（契约 §3 文档以 getWorldAt 称呼这个能力） */
  getWorldAt(clientX, clientY) {
    return this.clientToWorld(clientX, clientY);
  }

  /**
   * 世界坐标 → 页面 client 坐标（无投影时返回 null）。
   * @param {number} x
   * @param {number} z
   * @returns {{x:number, y:number}|null}
   */
  worldToClient(x, z) {
    const proj = this._projection;
    if (!proj || typeof proj.worldToImage !== 'function') return null;
    const p = proj.worldToImage(x, z);
    return this.imageToClient(p.px, p.py);
  }

  /* ====================================================================== */
  /* 事件：滚轮                                                             */
  /* ====================================================================== */

  /** 目标命中「不该由地图处理」的 UI 元素？ */
  _isIgnoredTarget(target) {
    if (!target || typeof target.closest !== 'function') return false;
    const hit = target.closest(IGNORE_SELECTOR);
    return !!hit && hit !== this.viewport;
  }

  _onWheel(event) {
    if (this._destroyed) return;
    // 标记本身不拦滚轮：鼠标停在路径点上也应该缩放地图。
    // 只有「弹窗 / 缩放面板 / 坐标读数」这类自身可能要滚动的 UI 才拦（否则长描述滚不动）。
    const hit = typeof event.target?.closest === 'function' ? event.target.closest(IGNORE_SELECTOR) : null;
    if (hit && hit !== this.viewport && !hit.classList.contains('marker')) return;

    // 必须阻止默认行为：Ctrl/⌘ + 滚轮时浏览器会缩放整个页面
    event.preventDefault();
    this._cancelAnim();

    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;           // 行模式
    else if (event.deltaMode === 2) delta *= Math.max(1, this._viewSize().height); // 页模式

    if (!Number.isFinite(delta) || delta === 0) return;

    const factor = Math.exp(-delta * WHEEL_ZOOM_RATE);
    const anchor = this._localPoint(event.clientX, event.clientY);
    this._pendingAutoFit = false;
    this._commit(this._zoomTarget(factor, anchor));
  }

  /* ====================================================================== */
  /* 事件：指针（拖拽 / 捏合 / 点击）                                        */
  /* ====================================================================== */

  /** 目标是否命中路径点标记本体（含 pin / label / 叠堆角标） */
  _isMarkerTarget(target) {
    return !!(target && typeof target.closest === 'function' && target.closest('.marker'));
  }

  _onPointerDown(event) {
    if (this._destroyed) return;
    const onMarker = this._isMarkerTarget(event.target);
    // 标记上起手：进入拖拽跟踪（移动越阈值转平移），原地松手仍由标记自己的 click 选中；
    // 弹窗 / 缩放面板等其余 UI 照旧完全忽略。
    if (this._isIgnoredTarget(event.target) && !onMarker) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    this._cancelAnim();
    this._pendingAutoFit = false;

    this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!onMarker) {
      try {
        // 指针捕获：拖出视口（甚至拖出窗口）也能继续收到 move / up。
        // 标记起手时先不捕获：捕获会改写 mouseup/click 的目标，原地松手就选不中标记了。
        this.viewport.setPointerCapture(event.pointerId);
      } catch { /* 某些旧环境不支持，忽略 */ }
    }

    if (this._pointers.size >= 2) {
      // 双指：进入捏合，取消单指拖拽，避免松手时误触发 click
      this._drag = null;
      this._startPinch();
      this.viewport.style.cursor = 'grabbing';
      return;
    }

    this._pinch = null;
    this._drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTx: this.tx,
      startTy: this.ty,
      moved: false,
      fromMarker: onMarker,
    };
    this.viewport.style.cursor = 'grabbing';
  }

  _onPointerMove(event) {
    if (this._destroyed) return;

    const tracked = this._pointers.get(event.pointerId);
    if (tracked) {
      tracked.x = event.clientX;
      tracked.y = event.clientY;
    }

    // ---- 双指捏合：缩放 + 双指中点跟随 ----
    if (this._pinch) {
      if (this._pointers.size >= 2) this._updatePinch();
      this._reportPointerMove(event);
      return;
    }

    // ---- 单指 / 鼠标拖拽平移 ----
    const drag = this._drag;
    if (drag && drag.pointerId === event.pointerId) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        drag.moved = true;
        if (drag.fromMarker) {
          // 越过阈值才捕获：此后的 move/up 重定向到视口，拖拽松手不会误点标记
          try { this.viewport.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
        }
      }
      if (drag.moved) {
        this._commit({
          scale: this.scale,
          tx: drag.startTx + dx,
          ty: drag.startTy + dy,
        });
      }
    }

    this._reportPointerMove(event);
  }

  _onPointerUp(event) {
    if (this._destroyed) return;
    this._pointers.delete(event.pointerId);
    try {
      this.viewport.releasePointerCapture(event.pointerId);
    } catch { /* 忽略 */ }

    // 捏合期间松手：不触发点击
    if (this._pinch) {
      if (this._pointers.size < 2) this._pinch = null;
      if (this._pointers.size === 0) this.viewport.style.cursor = 'grab';
      return;
    }

    const drag = this._drag;
    if (drag && drag.pointerId === event.pointerId) {
      this._drag = null;
      this.viewport.style.cursor = 'grab';

      // 拖拽超过阈值就不算点击（契约要求）
      if (!drag.moved && !this._isIgnoredTarget(event.target)) {
        const point = this.viewportToImage(event.clientX, event.clientY);
        safeCall(this.onMapClick, point);
      }
      return;
    }

    if (this._pointers.size === 0) this.viewport.style.cursor = 'grab';
  }

  _onPointerCancel(event) {
    if (this._destroyed) return;
    this._pointers.delete(event.pointerId);
    if (this._pinch && this._pointers.size < 2) this._pinch = null;
    if (this._drag && this._drag.pointerId === event.pointerId) this._drag = null;
    if (this._pointers.size === 0) this.viewport.style.cursor = 'grab';
    this._reportPointerMove(null);
  }

  _onPointerLeave(event) {
    if (this._destroyed) return;
    if (this._drag || this._pinch) return;     // 拖拽中离开视口不算移出
    if (event.pointerType === 'touch') return; // 触摸抬起后没有"悬停"概念
    this._reportPointerMove(null);
  }

  /** 上报悬停坐标（图片像素）；null 表示移出 */
  _reportPointerMove(event) {
    if (!this.onMapPointerMove) return;
    if (!event) {
      safeCall(this.onMapPointerMove, null);
      return;
    }
    safeCall(this.onMapPointerMove, this.viewportToImage(event.clientX, event.clientY));
  }

  /** 双指捏合开始：记录初始距离、中点、以及中点下方的图片像素坐标 */
  _startPinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) {
      this._pinch = null;
      return;
    }
    const [a, b] = pts;
    const rect = this.viewport.getBoundingClientRect();
    const mid = {
      x: (a.x + b.x) / 2 - rect.left,
      y: (a.y + b.y) / 2 - rect.top,
    };
    this._pinch = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startScale: this.scale,
      // 中点在缩放过程中始终压住这个图片像素
      imgMid: { x: (mid.x - this.tx) / this.scale, y: (mid.y - this.ty) / this.scale },
    };
  }

  _updatePinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2 || !this._pinch) return;
    const [a, b] = pts;
    const rect = this.viewport.getBoundingClientRect();
    const mid = {
      x: (a.x + b.x) / 2 - rect.left,
      y: (a.y + b.y) / 2 - rect.top,
    };
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const ratio = dist / this._pinch.startDist;
    const scale = this._resolveScale(this._pinch.startScale * ratio, this.scale);
    this._pendingAutoFit = false;
    this._commit({
      scale,
      tx: mid.x - this._pinch.imgMid.x * scale,
      ty: mid.y - this._pinch.imgMid.y * scale,
    });
  }

  /* ====================================================================== */
  /* 事件：双击 / 键盘                                                       */
  /* ====================================================================== */

  _onDoubleClick(event) {
    if (this._destroyed) return;
    if (this._isIgnoredTarget(event.target)) return;
    event.preventDefault();

    // 先取双击位置的图片坐标，再启动动画（reduce-motion 时动画是同步生效的）
    const point = this.viewportToImage(event.clientX, event.clientY);
    const anchor = this._localPoint(event.clientX, event.clientY);
    this._animateTo(this._zoomTarget(1.6, anchor));
    safeCall(this.onDoubleClick, point);
  }

  _onKeyDown(event) {
    if (this._destroyed) return;
    if (event.defaultPrevented) return;
    // Ctrl/⌘/Alt 组合键留给浏览器（页面缩放、快捷键），不抢
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const { width, height } = this._viewSize();
    const step = Math.round(Math.max(40, Math.min(width, height) * 0.12));

    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        this.zoomBy(KEY_ZOOM_STEP, undefined, { animate: true });
        break;
      case '-':
      case '_':
        event.preventDefault();
        this.zoomBy(1 / KEY_ZOOM_STEP, undefined, { animate: true });
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this._panBy(step, 0);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this._panBy(-step, 0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this._panBy(0, step);
        break;
      case 'ArrowDown':
        event.preventDefault();
        this._panBy(0, -step);
        break;
      default:
        break;
    }
  }

  /** 方向键平移：地图内容按 (dx, dy) 移动，视觉上就是视野朝反方向走 */
  _panBy(dx, dy) {
    this._cancelAnim();
    this._pendingAutoFit = false;
    this._commit({ scale: this.scale, tx: this.tx + dx, ty: this.ty + dy });
  }
}

export default MapView;
