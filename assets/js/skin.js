/**
 * assets/js/skin.js —— 玩家皮肤 3D 预览
 * =============================================================================
 * 皮肤查看器基于 skinview3d 3.4.2（assets/vendor/skinview3d.bundle.js，UMD 自包含
 * three.js + skinview-utils，挂全局 window.skinview3d，由 index.html 普通 <script>
 * 先于 module 引入）。正版 ID 查询先经 playerdb 把名称解析为 UUID，再按 UUID 取皮肤
 * （名称直查会命中第三方名称缓存——实测 minotar 同名返回的是旧持有者的旧版皮肤），
 * 皮肤源按序回退：mineatar（24h TTL，可达源中最勤）→ mc-heads（可能被 Cloudflare 403）
 * → minotar → playerdb 携带的 Mojang 官方纹理直链（textures.minecraft.net 带 ACAO:*）。
 * 注意 crafatar 不可用：实测会以 200 返回它的错误占位图（一张风景图），贴到模型上像「绿衫棕裤」。
 * 各源均为缓存代理，换肤后可能滞后一段时间，状态行会标注实际来源。
 * 文件导入为离线主力路径；旧版 64×32 / 128×64 皮肤导入时自动补全为正方形。
 * 128×128（HD）原生支持：skinview3d 3.4.2 的 loadSkin 接受任意正方形纹理，
 * UV 按 64 归一化，HD 布局是 64 布局的等比放大，坐标天然吻合。
 *
 * 铁律沿用 converter.js：
 *   - 纯函数部分零 DOM，可在 Node 下 `import` 单测（tests/skin.test.mjs）；
 *   - 永不抛异常：非法入参返回 null / false，由调用方决定提示文案。
 */

export const SKIN_WIDTH = 64;
export const SKIN_HEIGHT = 64;
export const LEGACY_SKIN_HEIGHT = 32;

/** 单个皮肤源的查询超时（毫秒） */
export const SKIN_FETCH_TIMEOUT = 8000;

/**
 * 名称 → 正版档案（UUID + 官方纹理直链）的查询地址（playerdb，带 CORS 头）。
 * 非法 ID 返回 null。
 * @param {string} raw
 * @returns {string|null}
 */
export function skinProfileUrl(raw) {
  const id = normalizeSkinId(raw);
  if (!id) return null;
  return `https://playerdb.co/api/player/minecraft/${encodeURIComponent(id)}`;
}

/**
 * 按 UUID 生成皮肤图片候选列表（多源回退）。
 * 不用名称直查：第三方名称缓存可能命中旧持有者，实测会返回完全错误的皮肤。
 * @param {string} uuid 32 位十六进制（不带连字符）
 * @returns {null | Array<{name: string, url: string}>}
 */
export function skinUuidUrls(uuid) {
  if (typeof uuid !== 'string' || !/^[0-9a-fA-F]{32}$/.test(uuid)) return null;
  return [
    { name: 'mineatar', url: `https://api.mineatar.io/skin/${uuid}.png` },
    { name: 'mc-heads', url: `https://mc-heads.net/skin/${uuid}.png` },
    { name: 'minotar', url: `https://minotar.net/skin/${uuid}.png` },
  ];
}

/**
 * 尺寸合法：现代 64×64 / 128×128（HD）或旧版 64×32 / 128×64（后者导入时自动补全）。
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
export function isSkinSize(w, h) {
  return (w === 64 || w === 128) && (h === w || h === w / 2);
}

/**
 * 正版 ID 规范化：1-16 位字母 / 数字 / 下划线，非法返回 null。
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeSkinId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(id)) return null;
  return id;
}

/**
 * 旧版（宽 = 高 × 2）皮肤补全矩形表：64×32 布局按 s = w/64 等比缩放。
 * 以 skinview3d 3.4.2 model.js 的 UV 布局为准（每肢体 16×12 块内各面顺序均为
 * -x/front/+x/back），左臂 / 左腿基座 = 右臂 / 右腿整块复制，无需逐面翻转。
 * 第二层（旧版 y 36-48）保持透明：旧版皮肤本就无肢体第二层，左右对称最忠实。
 * @param {number} w 旧版宽度（64 或 128）
 * @param {number} h 旧版高度（须为 w/2）
 * @returns {null | Array<{sx: number, sy: number, sw: number, sh: number, dx: number, dy: number}>}
 */
export function legacyPatchRects(w, h) {
  if (w !== h * 2 || (w !== 64 && w !== 128)) return null;
  const s = w / 64;
  return [
    { sx: 0, sy: 0, sw: w, sh: h, dx: 0, dy: 0 },
    { sx: 0, sy: 20 * s, sw: 16 * s, sh: 12 * s, dx: 16 * s, dy: 52 * s }, // 右腿块 → 左腿基座
    { sx: 40 * s, sy: 20 * s, sw: 16 * s, sh: 12 * s, dx: 32 * s, dy: 52 * s }, // 右臂块 → 左臂基座
  ];
}

/** 64×32 旧版皮肤的补全矩形表（legacyPatchRects 的 64 档实例） */
export const LEGACY_PATCHES = legacyPatchRects(SKIN_WIDTH, LEGACY_SKIN_HEIGHT);

/**
 * 旧版皮肤补全为正方形 canvas（仅浏览器环境可用）。
 * @param {HTMLCanvasElement|HTMLImageElement} source 尺寸须为 64×32 或 128×64
 * @returns {HTMLCanvasElement|null}
 */
export function padLegacySkin(source) {
  const w = source && (source.width || source.naturalWidth || 0);
  const h = source && (source.height || source.naturalHeight || 0);
  const patches = legacyPatchRects(w, h);
  if (!patches || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = w;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  for (const p of patches) {
    ctx.drawImage(source, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.sw, p.sh);
  }
  return canvas;
}

/**
 * 皮肤预览面板：只操作 index.html 里既有的 #skin-panel 节点，
 * 节点缺失时只 console.warn（与 sidebar.js 的容错策略一致）。
 */
export class SkinPanel {
  /**
   * @param {HTMLElement} rootEl #skin-panel
   * @param {{ onOpenChange?: (open: boolean) => void }} [options]
   */
  constructor(rootEl, options = {}) {
    this.root =
      rootEl ||
      (typeof document !== 'undefined' ? document.getElementById('skin-panel') : null);
    this.options = options || {};
    this._open = false;
    this._token = 0; // 竞态令牌：关闭面板 / 新查询会使在途结果作废
    this._viewer = null; // SkinViewer 懒创建
    this._animMode = 'idle'; // 'idle' | 'walk' | 'run'（默认静止）
    this._rotate = false; // 默认不旋转
    this._defaultPose = null; // 首次渲染成功时的相机位姿快照（回正基准）
    this._listeners = [];

    this.el = {};
    for (const [key, id] of Object.entries({
      id: 'skin-id',
      load: 'skin-load',
      file: 'skin-file',
      fileName: 'skin-file-name',
      canvas: 'skin-canvas',
      status: 'skin-status',
      close: 'skin-close',
      actWalk: 'skin-act-walk',
      actRun: 'skin-act-run',
      actIdle: 'skin-act-idle',
      actRotate: 'skin-act-rotate',
      actReset: 'skin-act-reset',
    })) {
      const node = this.root ? this.root.querySelector(`#${id}`) : null;
      if (!node) console.warn(`[skin] 找不到节点 #${id}，对应功能已跳过`);
      this.el[key] = node;
    }

    this._bind();
    this._syncButtons();
  }

  /* ------------------------------------------------------------------ *
   * 公开 API
   * ------------------------------------------------------------------ */

  isOpen() {
    return this._open;
  }

  /**
   * 打开 / 收起面板。收起时作废所有在途查询。
   * @param {boolean} open
   */
  setOpen(open) {
    this._open = open === true;
    if (this.root) this.root.hidden = !this._open;
    if (!this._open) this._token++;
    this._emitOpenChange();
  }

  /** 当前 3D 查看器实例（懒创建；库未加载 / 创建失败时为 null） */
  getViewer() {
    return this._viewer;
  }

  /** 当前动画模式：'idle' | 'walk' | 'run' */
  getAnimMode() {
    return this._animMode;
  }

  /** 自动旋转是否开启 */
  isRotating() {
    return this._rotate;
  }

  destroy() {
    this._token++;
    if (this._viewer) {
      try {
        this._viewer.dispose();
      } catch (error) {
        console.warn('[skin] 3D 查看器销毁失败', error);
      }
      this._viewer = null;
    }
    this._defaultPose = null;
    for (const { node, type, handler, options } of this._listeners) {
      node.removeEventListener(type, handler, options);
    }
    this._listeners = [];
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  _on(node, type, handler, options) {
    if (!node || typeof node.addEventListener !== 'function') return;
    node.addEventListener(type, handler, options);
    this._listeners.push({ node, type, handler, options });
  }

  _bind() {
    this._on(this.el.close, 'click', () => this.setOpen(false));
    this._on(this.el.load, 'click', () => {
      this._fetchById(this.el.id ? String(this.el.id.value || '') : '');
    });
    this._on(this.el.id, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this._fetchById(this.el.id ? String(this.el.id.value || '') : '');
    });
    this._on(this.el.file, 'change', (event) => this._onFileChange(event));
    this._on(this.el.actWalk, 'click', () => this._setAnimMode('walk'));
    this._on(this.el.actRun, 'click', () => this._setAnimMode('run'));
    this._on(this.el.actIdle, 'click', () => this._setAnimMode('idle'));
    this._on(this.el.actRotate, 'click', () => this._setRotate(!this._rotate));
    this._on(this.el.actReset, 'click', () => this._resetView());
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this._on(document, 'keydown', (event) => {
        if (!this._open) return;
        if (event.key !== 'Escape' && event.key !== 'Esc') return;
        event.preventDefault();
        this.setOpen(false);
      });
    }
  }

  _emitOpenChange() {
    if (typeof this.options.onOpenChange === 'function') {
      try {
        this.options.onOpenChange(this._open);
      } catch (error) {
        console.warn('[skin] onOpenChange 回调抛错', error);
      }
    }
  }

  _setStatus(text, kind = '') {
    const el = this.el.status;
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', kind === 'error');
    el.classList.toggle('is-ok', kind === 'ok');
  }

  _setRotate(on) {
    this._rotate = on === true;
    if (this._viewer) this._viewer.autoRotate = this._rotate;
    this._syncButtons();
  }

  /**
   * 视图回正：先停自动旋转（与左键拖拽一致），再恢复首次渲染时的默认位姿。
   * skinview3d 3.4.2 的 autoRotate 转的是模型（playerWrapper.rotation.y），
   * 不是相机——光复位相机模型仍停在转出的角度上，必须一并归零。
   */
  _resetView() {
    if (this._rotate) this._setRotate(false);
    const viewer = this._viewer;
    const pose = this._defaultPose;
    if (!viewer || !pose) return;
    try {
      viewer.playerWrapper.rotation.y = 0;
      viewer.camera.position.copy(pose.position);
      viewer.controls.target.copy(pose.target);
      viewer.controls.update();
    } catch (error) {
      console.warn('[skin] 视图回正失败', error);
    }
  }

  _setAnimMode(mode) {
    if (mode !== 'idle' && mode !== 'walk' && mode !== 'run') return;
    this._animMode = mode;
    if (this._viewer) this._applyAnimation();
    this._syncButtons();
  }

  _applyAnimation() {
    const viewer = this._viewer;
    const lib = typeof window !== 'undefined' ? window.skinview3d : null;
    if (!viewer || !lib) return;
    try {
      if (this._animMode === 'walk') viewer.animation = new lib.WalkingAnimation();
      else if (this._animMode === 'run') viewer.animation = new lib.RunningAnimation();
      else viewer.animation = new lib.IdleAnimation();
    } catch (error) {
      console.warn('[skin] 动画切换失败', error);
      try {
        viewer.animation = null;
      } catch {
        /* ignore */
      }
    }
  }

  _syncButtons() {
    const pressed = (el, on) => {
      if (!el) return;
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      el.classList.toggle('is-active', on);
    };
    pressed(this.el.actWalk, this._animMode === 'walk');
    pressed(this.el.actRun, this._animMode === 'run');
    pressed(this.el.actIdle, this._animMode === 'idle');
    pressed(this.el.actRotate, this._rotate);
  }

  /** SkinViewer 懒创建（首次渲染时）。库缺失 / 初始化失败返回 null。 */
  _getViewer() {
    if (this._viewer) return this._viewer;
    const canvas = this.el.canvas;
    if (!canvas) return null;
    const lib = typeof window !== 'undefined' ? window.skinview3d : null;
    if (!lib || typeof lib.SkinViewer !== 'function') {
      this._setStatus('3D 查看器未加载（vendor 脚本缺失），请刷新页面重试', 'error');
      return null;
    }
    try {
      const viewer = new lib.SkinViewer({
        canvas,
        width: 300,
        height: 420,
        model: 'auto-detect',
        preserveDrawingBuffer: true,
      });
      // 默认静止、不旋转；右键拖拽平移（OrbitControls 默认右键即 PAN，只差 enablePan）
      viewer.controls.enablePan = true;
      viewer.autoRotateSpeed = 1.2;
      // 左键拖拽（旋转手势）后停止自动旋转；右键平移不打断旋转开关
      this._on(canvas, 'pointerdown', (event) => {
        if (this._rotate && event.button === 0) this._setRotate(false);
      });
      this._viewer = viewer;
      this._applyAnimation();
    } catch (error) {
      console.warn('[skin] 3D 查看器创建失败', error);
      this._setStatus(`3D 查看器初始化失败：${error.message}`, 'error');
      return null;
    }
    return this._viewer;
  }

  /** 把已解码图片喂给查看器（旧版 64×32 / 128×64 先补全为正方形）。成功返回 true。 */
  _renderSkin(img) {
    const viewer = this._getViewer();
    if (!viewer) return false;
    let source = img;
    if (img.width === img.height * 2) {
      const padded = padLegacySkin(img);
      if (!padded) {
        this._setStatus('旧版皮肤补全失败', 'error');
        return false;
      }
      source = padded;
    }
    try {
      viewer.loadSkin(source, { model: 'auto-detect' });
    } catch (error) {
      console.warn('[skin] 皮肤渲染失败', error);
      this._setStatus(`皮肤渲染失败：${error.message}`, 'error');
      return false;
    }
    if (!this._defaultPose) {
      this._defaultPose = {
        position: viewer.camera.position.clone(),
        target: viewer.controls.target.clone(),
      };
    }
    return true;
  }

  /** 尺寸校验 + 渲染 + 状态行（ID 查询与文件导入共用） */
  _applyLoaded(img, label, sourceName = '') {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (!isSkinSize(w, h)) {
      this._setStatus(
        `皮肤尺寸不符：${w}×${h}（需 64×64 / 128×128 或旧版 64×32 / 128×64 PNG）`,
        'error',
      );
      return;
    }
    const legacy = w === h * 2;
    if (this._renderSkin(img)) {
      const source = sourceName ? `（来源 ${sourceName}）` : '';
      this._setStatus(
        `${label}：${w}×${h}${legacy ? `（旧版，已补全为 ${w}×${w}）` : ''}${source}`,
        'ok',
      );
    }
  }

  /** 跨域加载图片（带超时与竞态令牌）。失败返回 null。 */
  _loadImage(url, token, timeoutMs) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      let done = false;
      const finish = (value) => {
        if (done || token !== this._token) return;
        done = true;
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      img.onload = () => {
        clearTimeout(timer);
        finish(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        finish(null);
      };
      img.src = url;
    });
  }

  /** 跨域加载 JSON（带超时与竞态令牌）。失败返回 null。 */
  _loadJson(url, token, timeoutMs) {
    return new Promise((resolve) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
      const finish = (value) => {
        if (token !== this._token) return;
        clearTimeout(timer);
        resolve(value);
      };
      fetch(url, { signal: controller.signal, mode: 'cors' })
        .then((res) => (res && res.ok ? res.json() : null))
        .then((data) => finish(data && typeof data === 'object' ? data : null))
        .catch(() => finish(null));
    });
  }

  /**
   * 正版 ID 查询：先 playerdb 名称→UUID，再按 UUID 取皮肤（多源回退）。
   * 名称直查第三方皮肤源会命中旧名称缓存（实测返回错误皮肤），不可用。
   */
  async _fetchById(raw) {
    const id = normalizeSkinId(raw);
    if (!id) {
      this._setStatus('ID 无效：仅支持 1-16 位字母、数字、下划线', 'error');
      return;
    }
    const token = ++this._token;
    this._setStatus(`正在查询 ${id} …`);
    const profileUrl = skinProfileUrl(id);
    const profile = profileUrl ? await this._loadJson(profileUrl, token, SKIN_FETCH_TIMEOUT) : null;
    if (token !== this._token) return;
    const player = profile && profile.data && profile.data.player;
    const uuid = player && player.raw_id;
    if (!uuid || !/^[0-9a-fA-F]{32}$/.test(uuid)) {
      this._setStatus(
        profile
          ? `未找到正版玩家 ${id}（仅限正版 ID，离线服昵称查不到）`
          : '查询失败：无法访问皮肤服务，请改用文件导入',
        'error',
      );
      return;
    }
    const sources = skinUuidUrls(uuid) || [];
    // playerdb 顺带返回的 Mojang 官方纹理直链（textures.minecraft.net 带 CORS 头）作兜底
    if (typeof player.skin_texture === 'string' && player.skin_texture) {
      sources.push({ name: 'mojang', url: String(player.skin_texture).replace(/^http:/, 'https:') });
    }
    for (const source of sources) {
      const img = await this._loadImage(source.url, token, SKIN_FETCH_TIMEOUT);
      if (token !== this._token) return; // 面板已关 / 新查询已开始
      if (!img) continue;
      this._applyLoaded(img, id, source.name);
      return;
    }
    if (token === this._token) {
      this._setStatus(
        `查询失败：无法访问皮肤服务（${sources.map((s) => s.name).join(' / ')}），请改用文件导入`,
        'error',
      );
    }
  }

  _onFileChange(event) {
    const input = event.currentTarget || event.target;
    const file = input && input.files && input.files[0];
    if (!file) return;
    if (this.el.fileName) this.el.fileName.textContent = file.name;
    if (file.type && file.type !== 'image/png') {
      this._setStatus('仅支持 PNG 皮肤文件', 'error');
      return;
    }
    const token = ++this._token;
    this._setStatus(`正在读取 ${file.name} …`);
    const reader = new FileReader();
    reader.onload = () => {
      if (token !== this._token) return;
      const img = new Image();
      img.onload = () => {
        if (token === this._token) this._applyLoaded(img, file.name);
      };
      img.onerror = () => {
        if (token === this._token) this._setStatus(`图片解析失败：${file.name}`, 'error');
      };
      img.src = String(reader.result || '');
    };
    reader.onerror = () => {
      if (token === this._token) this._setStatus(`文件读取失败：${file.name}`, 'error');
    };
    reader.readAsDataURL(file);
  }
}

export default SkinPanel;
