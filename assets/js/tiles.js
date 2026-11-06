/**
 * assets/js/tiles.js —— 瓦片底图（manifest 解析 + 视口内渲染 + LRU 缓存）
 * =============================================================================
 * 与「单张 PNG + calibration」并列的第二种底图：一种维度既可以用一张大图，
 * 也可以切成一堆小瓦片（本模块）。
 *
 * 依赖边界：
 *   - 纯计算部分（manifest 校验 / 层级选择 / 瓦片 URL）不碰 DOM，可在 Node 下 import；
 *   - 渲染部分只操作调用方给的 <canvas>，不创建任何顶层 DOM；
 *   - 不 import viewer.js / coords.js：视图状态由调用方以「普通对象」传入
 *     （MapView.getViewState() 的产物），本模块只读书面量字段。
 *
 * 坐标语义（与 docs/CONTRACT.md §1 一致）：
 *   - 世界坐标 = 方块坐标；level 0 的 1 瓦片像素 = 1 方块，层级 L 的 1 像素 = 2^L 方块；
 *   - 图片像素（image px）恒等于 level 0 的像素：px = x - worldBlockRange.xMin，
 *     py = z - worldBlockRange.zMin（因此整幅「图片」尺寸 = worldBlockRange 的跨度）；
 *   - 每个层级自带 originBlockX/Z（该层级 (0,0) 瓦片左上角的世界坐标），
 *     正常情况下等于 worldBlockRange 的左上角，代码按差值做偏移，不假设两者相等。
 *
 * 渲染策略（视口渲染）：
 *   - canvas 的 CSS 盒 = 当前视口在「图片像素」空间里的矩形（left/top = -tx/scale，
 *     width/height = viewWidth/scale），由 #stage 的 transform 映射回屏幕视口，
 *     因此位图与屏幕 1:1 —— 位图多大、瓦片画多大就多大，绝不整图降采样；
 *   - canvas 的**位图**尺寸 = 视口尺寸 × dpr（超出 MAX_CANVAS_PIXELS 时才等比降），
 *     与层级 / 世界尺寸无关；宿主必须给 canvas 绝对定位（position: absolute）；
 *   - 每帧先清屏，再按当前层级贴「视口覆盖到的瓦片」，瓦片按
 *     tileSize × blocksPerPixel × scale × dpr 的目标尺寸绘制（可放大可缩小），
 *     避免半透明像素反复叠加，也避免层级切换后留下旧栅格内容；
 *   - 放大（1 瓦片像素 ≥ 1 canvas 像素）时关掉 imageSmoothingEnabled，保持像素锐利；
 *   - 瓦片缺失（404）是正常情况（导出的都是非全透明瓦片），一律静默跳过；
 *   - 已解码图片走 LRU 缓存（默认 400 张），缺失列表单独记，避免反复请求；
 *   - 瓦片 URL 带 ?v=<manifest.generatedAt> 版本参数：瓦片重新生成后 URL 变化，
 *     自动绕开浏览器 HTTP 缓存（GitHub Pages 静态资源默认 max-age=600）。
 */

/** 已解码瓦片的内存上限（张）。256×256 RGBA 约 256 KB/张，400 张 ≈ 100 MB。 */
export const MAX_CACHED_TILES = 400;

/** 「缺失瓦片」负缓存的条目上限（只是一个 URL 集合，几乎不占内存） */
export const MAX_MISSING_TILES = 4096;

/**
 * canvas 位图的像素上限（视口渲染下 = 视口 × dpr 的像素数，约等于一个高清屏的量级）。
 * 4K 屏幕 dpr=1 时约 830 万像素，远在上限内；只有超高分屏（如 4K × dpr 2）才会触发
 * 等比降采样兜底 —— 该上限保证任何视口都不会把显卡/内存撑爆。
 */
export const MAX_CANVAS_PIXELS = 24_000_000;

const DEFAULT_TILE_SIZE = 256;
const DEFAULT_MANIFEST = 'tiles/overworld/manifest.json';

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 宽松数值化：number / 数字字符串 → number；其余 → NaN */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** manifest 路径 → 瓦片根目录：'tiles/overworld/manifest.json' → 'tiles/overworld/tiles/' */
export function tileBaseFromManifest(manifestUrl = DEFAULT_MANIFEST) {
  const url = String(manifestUrl || DEFAULT_MANIFEST);
  const dir = url.includes('/') ? url.slice(0, url.lastIndexOf('/') + 1) : '';
  return `${dir}tiles/`;
}

/** CSS 盒写入取整到 1e-4：视觉上无损，但避免每帧产生不同的样式字符串 */
function roundPx(value) {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/* -------------------------------------------------------------------------- */
/* 1. Tileset：manifest 的规范化与查询                                          */
/* -------------------------------------------------------------------------- */

/**
 * 一个层级的规范化结果。
 * @typedef {object} TileLevel
 * @property {number} level           层级号（0 = 1 方块/像素）
 * @property {number} blocksPerPixel  该层级 1 像素覆盖多少方块（= 2^level）
 * @property {number} minX/maxX/minZ/maxZ 该层级存在的瓦片列/行范围（闭区间）
 * @property {number} cols/rows
 * @property {number} originBlockX    该层级 (0,0) 瓦片左上角的世界 X
 * @property {number} originBlockZ
 * @property {number} tileSize
 */

export class Tileset {
  /**
   * @param {object} params
   * @param {number} params.tileSize
   * @param {TileLevel[]} params.levels 按 level 升序
   * @param {{xMin:number,xMax:number,zMin:number,zMax:number}} params.bounds
   * @param {string} params.baseUrl 瓦片根目录（含末尾斜杠）
   * @param {string} [params.manifestUrl]
   * @param {string} [params.source]
   * @param {string} [params.generatedAt] manifest.generatedAt 原始值（ISO 时间串，供 UI 显示）
   */
  constructor({
    tileSize, levels, bounds, baseUrl, manifestUrl = '', source = '', version = '', generatedAt = '',
  }) {
    this.tileSize = tileSize;
    this.levels = levels;
    this.bounds = bounds;
    this.baseUrl = baseUrl;
    this.manifestUrl = manifestUrl;
    this.source = source;
    /** manifest.generatedAt 净化后的版本串：随瓦片重新生成而变化，用于绕开 HTTP 缓存 */
    this.version = version;
    /** manifest.generatedAt 原始串：给「瓦片更新于…」这类 UI 显示用（没生成时间就为空串） */
    this.generatedAt = typeof generatedAt === 'string' ? generatedAt : '';
    /** 图片像素尺寸 = 世界跨度（level 0 的 1 像素 = 1 方块） */
    this.imageWidth = bounds.xMax - bounds.xMin;
    this.imageHeight = bounds.zMax - bounds.zMin;
    this._byLevel = new Map(levels.map((entry) => [entry.level, entry]));
  }

  /** 最低（最细）层级号，通常是 0 */
  get minLevel() {
    return this.levels[0] ? this.levels[0].level : 0;
  }

  /** 最高（最粗）层级号 */
  get maxLevel() {
    return this.levels.length ? this.levels[this.levels.length - 1].level : 0;
  }

  getLevel(level) {
    return this._byLevel.get(level) || null;
  }

  /**
   * 按当前缩放挑层级：让「1 瓦片像素 ≈ 1 屏幕设备像素」。
   * 缩放 s、设备像素比 dpr 时，层级 L 的 1 像素占 s×2^L×dpr 个设备像素，
   * 所以取 |log2(2^L · s · dpr)| 最小的那层（等价于 2^L ≈ 1/(s·dpr)）。
   * dpr 缺省 1，与旧行为完全一致（站点不传 dpr 时不会改变任何层级选择）。
   * @param {number} scale 屏幕 CSS 像素 / 图片像素
   * @param {number} [dpr] 设备像素比（高分屏传 2 可让 canvas 选到更细的层级，避免发虚）
   * @returns {TileLevel}
   */
  levelForScale(scale, dpr = 1) {
    const s = toNum(scale);
    const ratio = toNum(dpr);
    const density = ratio > 0 ? ratio : 1;
    if (!(s > 0) || !this.levels.length) {
      return this.levels[0] || null;
    }
    let best = this.levels[0];
    let bestScore = Infinity;
    for (const entry of this.levels) {
      const score = Math.abs(Math.log2(entry.blocksPerPixel * s * density));
      // 分数相同（正好在两层中间）时取更细的那层：宁可多几张瓦片，也不要糊
      if (score < bestScore - 1e-9) {
        best = entry;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * 某层某瓦片的 URL：<base>/<level>/<x>_<y>.png。
   * 带 ?v=<generatedAt> 版本参数：瓦片重新生成后 URL 变化，强制绕过浏览器 HTTP 缓存
   * （GitHub Pages 对静态资源默认 max-age=600，同 URL 会命中旧图）。
   */
  urlFor(level, x, y) {
    const v = this.version ? `?v=${encodeURIComponent(this.version)}` : '';
    return `${this.baseUrl}${level}/${x}_${y}.png${v}`;
  }

  /** 供 UI 显示 / 调试用的摘要（纯 JSON） */
  toJSON() {
    return {
      tileSize: this.tileSize,
      baseUrl: this.baseUrl,
      manifestUrl: this.manifestUrl,
      source: this.source,
      version: this.version,
      generatedAt: this.generatedAt,
      imageWidth: this.imageWidth,
      imageHeight: this.imageHeight,
      bounds: { ...this.bounds },
      levels: this.levels.map((entry) => ({ ...entry })),
    };
  }
}

/**
 * 校验并规范化 manifest 的原始 JSON。
 * 结构不对 / 关键字段缺失时返回 null（调用方据此回退到 image）。
 *
 * @param {any} raw manifest.json 的内容
 * @param {{manifestUrl?: string}} [options]
 * @returns {Tileset|null}
 */
export function parseManifest(raw, { manifestUrl = DEFAULT_MANIFEST } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const tileSize = Math.round(toNum(raw.tileSize));
  if (!(tileSize > 0)) return null;

  const range = raw.worldBlockRange;
  if (!range || typeof range !== 'object') return null;
  const xMin = toNum(range.xMin);
  const xMax = toNum(range.xMax);
  const zMin = toNum(range.zMin);
  const zMax = toNum(range.zMax);
  if (!(isNum(xMin) && isNum(xMax) && isNum(zMin) && isNum(zMax))) return null;
  if (!(xMax > xMin) || !(zMax > zMin)) return null;

  const rawLevels = Array.isArray(raw.levels) ? raw.levels : [];
  const levels = [];
  for (const item of rawLevels) {
    if (!item || typeof item !== 'object') continue;
    const level = Math.round(toNum(item.level));
    const blocksPerPixel = toNum(item.blocksPerPixel);
    if (!isNum(level) || level < 0 || !(blocksPerPixel > 0)) continue;

    const bMinX = toNum(item.minX);
    const bMaxX = toNum(item.maxX);
    const bMinZ = toNum(item.minZ);
    const bMaxZ = toNum(item.maxZ);
    if (!(isNum(bMinX) && isNum(bMaxX) && isNum(bMinZ) && isNum(bMaxZ))) continue;
    if (bMaxX < bMinX || bMaxZ < bMinZ) continue;

    const originBlockX = toNum(item.originBlockX);
    const originBlockZ = toNum(item.originBlockZ);
    levels.push({
      level,
      blocksPerPixel,
      minX: Math.round(bMinX),
      maxX: Math.round(bMaxX),
      minZ: Math.round(bMinZ),
      maxZ: Math.round(bMaxZ),
      cols: Math.round(toNum(item.cols)) || Math.round(bMaxX - bMinX + 1),
      rows: Math.round(toNum(item.rows)) || Math.round(bMaxZ - bMinZ + 1),
      originBlockX: isNum(originBlockX) ? originBlockX : xMin,
      originBlockZ: isNum(originBlockZ) ? originBlockZ : zMin,
      tileSize,
    });
  }
  if (!levels.length) return null;
  levels.sort((a, b) => a.level - b.level);

  // 一致性自检：最细层级的栅格宽度必须正好覆盖世界跨度，
  // 否则瓦片和路径点会整体错位 —— 这种 manifest 直接判为不可用。
  const finest = levels[0];
  const rasterWidth = finest.cols * tileSize * finest.blocksPerPixel;
  const rasterHeight = finest.rows * tileSize * finest.blocksPerPixel;
  const tolerance = finest.blocksPerPixel; // 允许 1 个像素的取整误差
  if (
    Math.abs((finest.originBlockX - xMin)) > tolerance ||
    Math.abs((finest.originBlockZ - zMin)) > tolerance ||
    Math.abs(rasterWidth - (xMax - xMin)) > tolerance ||
    Math.abs(rasterHeight - (zMax - zMin)) > tolerance
  ) {
    console.warn(
      '[tiles] manifest 与 worldBlockRange 对不上，已忽略：',
      { rasterWidth, rasterHeight, worldWidth: xMax - xMin, worldHeight: zMax - zMin },
    );
    return null;
  }

  return new Tileset({
    tileSize,
    levels,
    bounds: { xMin, xMax, zMin, zMax },
    baseUrl: tileBaseFromManifest(manifestUrl),
    manifestUrl,
    source: typeof raw.source === 'string' ? raw.source : '',
    version: String(raw.generatedAt ?? '').replace(/[^A-Za-z0-9._-]/g, ''),
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
  });
}

/**
 * 把 manifest.generatedAt 格式化成「更新于 …（相对天数）」。
 * 纯函数、不碰 DOM，可在 Node 下测试；解析不了时返回空串（调用方隐藏徽标）。
 * @param {string|undefined|null} iso ISO 时间串
 * @param {number} [now] 当前时间戳（毫秒，测试注入用）
 * @returns {string}
 */
export function formatGeneratedAt(iso, now = Date.now()) {
  if (typeof iso !== 'string' || !iso) return '';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const local = new Date(time);
  const dateText =
    `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ` +
    `${pad(local.getHours())}:${pad(local.getMinutes())}`;
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThatDay = new Date(time);
  startOfThatDay.setHours(0, 0, 0, 0);
  // Math.round 吸收夏令时导致的 23/25 小时天
  const dayDiff = Math.round((startOfToday.getTime() - startOfThatDay.getTime()) / dayMs);
  const relative =
    dayDiff <= 0 ? '今天'
    : dayDiff === 1 ? '昨天'
    : `${dayDiff} 天前`;
  return `瓦片更新于 ${dateText}（${relative}）`;
}

/**
 * 拉取并解析 manifest。
 * @param {string} url
 * @returns {Promise<Tileset>} 失败时 reject（调用方决定是否回退到 image）
 */
export async function loadTileset(url = DEFAULT_MANIFEST) {
  if (typeof fetch !== 'function') {
    throw new Error('[tiles] 当前环境没有 fetch，无法加载瓦片 manifest');
  }
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`[tiles] manifest 加载失败：HTTP ${res.status} ${url}`);
  let raw;
  try {
    raw = await res.json();
  } catch (err) {
    throw new Error(`[tiles] manifest 不是合法 JSON：${url}`);
  }
  const tileset = parseManifest(raw, { manifestUrl: url });
  if (!tileset) throw new Error(`[tiles] manifest 结构不合法：${url}`);
  return tileset;
}

/* -------------------------------------------------------------------------- */
/* 2. TileLayer：把瓦片画进 <canvas>                                            */
/* -------------------------------------------------------------------------- */

export class TileLayer {
  /**
   * @param {HTMLCanvasElement} canvas 底图 canvas（必须是绝对定位；CSS 盒与位图尺寸都由本类按视口设置）
   * @param {object} [options]
   * @param {Tileset|null} [options.tileset]
   * @param {number} [options.maxTiles] 已解码图片的 LRU 上限
   * @param {number} [options.dpr] 设备像素比；>1 时层级会选得更细、位图按设备像素渲染（默认 1 = 旧行为）
   */
  constructor(canvas, { tileset = null, maxTiles = MAX_CACHED_TILES, dpr = 1 } = {}) {
    this.canvas = canvas || null;
    this.ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    this.maxTiles = isNum(maxTiles) && maxTiles > 0 ? Math.floor(maxTiles) : MAX_CACHED_TILES;
    this._dpr = isNum(dpr) && dpr > 0 ? dpr : 1;

    /** @type {Tileset|null} */
    this.tileset = null;
    /** LRU：key -> {img}（Map 的插入顺序即使用顺序） */
    this._images = new Map();
    /** 404 的瓦片（不重复请求） */
    this._missing = new Set();
    /** 正在请求中的瓦片 */
    this._pending = new Set();
    this._generation = 0;    // reset 后旧请求不得影响新一代的缓存 / pending

    this._active = false;
    this._level = null;      // 当前层级对象
    this._factor = 1;        // canvas 像素 / 视口像素（位图超上限时 < 1）
    this._viewState = null;
    this._raf = 0;
    this._destroyed = false;

    this._requests = 0;
    this._loaded = 0;
    this._missingCount = 0;
    this._drawn = 0;
    this._visibleTiles = 0;
    this._draws = 0;

    if (tileset) this.setTileset(tileset);
  }

  /* ------------------------------------------------------------------ */
  /* 数据 / 状态                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * 换一份瓦片集。同一个 baseUrl 时保留缓存（来回切维度不用重新下载）。
   * @param {Tileset|null} tileset
   */
  setTileset(tileset) {
    if (!tileset) {
      this.tileset = null;
      this.reset({ keepCache: false });
      return;
    }
    const sameSource = this.tileset && this.tileset.baseUrl === tileset.baseUrl;
    this.tileset = tileset;
    if (!sameSource) this.reset({ keepCache: false });
    else this._level = null; // 尺寸可能一致，但强制重算一次层级
  }

  /** 激活 / 停用（切到单张图片底图的维度时停用，避免继续请求瓦片） */
  setActive(active) {
    const next = active === true;
    if (this._active === next) return;
    this._active = next;
    if (!next) {
      this._cancelFrame();
      this._clearCanvas();
    } else if (this._viewState) {
      this.draw();
    }
  }

  get active() {
    return this._active;
  }

  /** 当前设备像素比（1 = 未开启 DPR 感知，与旧行为一致） */
  get dpr() {
    return this._dpr;
  }

  /**
   * 更新设备像素比：值变了就按当前视图重画（层级与插值判定都会跟着变）。
   * 位图尺寸跟着视口 × dpr 走，仍然受 MAX_CANVAS_PIXELS 上限兜底。
   * @param {number} dpr
   */
  setDpr(dpr) {
    const next = isNum(dpr) && dpr > 0 ? dpr : 1;
    if (next === this._dpr) return this._dpr;
    this._dpr = next;
    if (this._active && this._viewState) this.draw();
    return this._dpr;
  }

  /** 清空画面与（可选）缓存 */
  reset({ keepCache = true } = {}) {
    this._generation += 1;
    this._pending.clear();
    this._cancelFrame();
    this._clearCanvas();
    this._level = null;
    this._drawn = 0;
    this._visibleTiles = 0;
    if (!keepCache) {
      this._images.clear();
      this._missing.clear();
      this._requests = 0;
      this._loaded = 0;
      this._missingCount = 0;
      this._draws = 0;
    }
  }

  destroy() {
    this._destroyed = true;
    this._cancelFrame();
    this.reset({ keepCache: false });
    this.tileset = null;
    this.canvas = null;
    this.ctx = null;
  }

  /** 供测试 / 调试读取的运行数据（纯 JSON） */
  get stats() {
    return {
      active: this._active,
      level: this._level ? this._level.level : null,
      blocksPerPixel: this._level ? this._level.blocksPerPixel : null,
      scale: this._viewState && isNum(this._viewState.scale) ? this._viewState.scale : null,
      dpr: this._dpr,
      canvasWidth: this.canvas ? this.canvas.width : 0,
      canvasHeight: this.canvas ? this.canvas.height : 0,
      backingFactor: this._factor,
      requests: this._requests,
      loaded: this._loaded,
      missing: this._missingCount,
      cache: this._images.size,
      maxTiles: this.maxTiles,
      visibleTiles: this._visibleTiles,
      drawn: this._drawn,
      draws: this._draws,
      levelCount: this.tileset ? this.tileset.levels.length : 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * 视图变化后调用（app.js 在 onViewChange 的 rAF 里调）。
   * @param {{scale:number, tx:number, ty:number, viewWidth:number, viewHeight:number}} viewState
   */
  update(viewState) {
    if (!viewState || typeof viewState !== 'object') return;
    this._viewState = viewState;
    this.draw();
  }

  /** 立即按最后一次视图状态重画（异步瓦片到达后也走这里） */
  draw() {
    if (this._destroyed || !this._active || !this.ctx || !this.canvas || !this.tileset) return;
    const vs = this._viewState;
    if (!vs) return;

    const scale = Number(vs.scale);
    const tx = Number(vs.tx);
    const ty = Number(vs.ty);
    const viewWidth = Number(vs.viewWidth);
    const viewHeight = Number(vs.viewHeight);
    if (!(scale > 0) || !isNum(tx) || !isNum(ty)) return;
    if (!(viewWidth > 0) || !(viewHeight > 0)) return;

    const tileset = this.tileset;
    const dpr = this._dpr;
    const level = tileset.levelForScale(scale, dpr);
    if (!level) return;
    this._level = level;
    this._resizeBacking(viewWidth, viewHeight);

    const bpp = level.blocksPerPixel;
    const factor = this._factor;
    const canvas = this.canvas;
    const ctx = this.ctx;
    const tileSize = tileset.tileSize;

    // 视口渲染：CSS 盒 = 视口在图片像素空间里的矩形（#stage 的 transform 会把它
    // 映射回屏幕视口），位图 = 视口 × dpr，所以 canvas 像素与屏幕设备像素 1:1。
    const x0 = -tx / scale;
    const y0 = -ty / scale;
    const kk = scale * dpr * factor; // canvas 像素 / 图片像素
    if (canvas.style) {
      canvas.style.left = `${roundPx(x0)}px`;
      canvas.style.top = `${roundPx(y0)}px`;
      canvas.style.width = `${roundPx(viewWidth / scale)}px`;
      canvas.style.height = `${roundPx(viewHeight / scale)}px`;
    }

    // 1 个瓦片像素占多少 canvas 像素：>=1 说明在放大 → 关掉插值保持锐利
    // 但用户交互中（拖拽 / 捏合 / 动画）必须开双线性：nearest 会把瓦片栅格逐帧
    // 重锚到整数 canvas 像素，画面上看就是 1px 台阶式移动（拖起来抖）；
    // 双线性让画面以亚像素精度连续移动，静止后再回到 nearest 恢复锐利。
    const canvasPxPerTilePx = bpp * kk;
    const smooth = canvasPxPerTilePx < 1 || vs.interacting === true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = smooth;
    if (canvas.style) {
      canvas.style.imageRendering = smooth ? 'auto' : 'pixelated';
    }

    // 视口与地图的交集（钳制到地图范围，和瓦片裁剪一致）
    const clampX0 = Math.max(x0, 0);
    const clampY0 = Math.max(y0, 0);
    const clampX1 = Math.min(x0 + viewWidth / scale, tileset.imageWidth);
    const clampY1 = Math.min(y0 + viewHeight / scale, tileset.imageHeight);

    this._drawn = 0;
    if (!(clampX1 > clampX0) || !(clampY1 > clampY0)) {
      this._visibleTiles = 0;
      this._draws += 1;
      return;
    }

    // 层级栅格像素（= 图片像素 / bpp）：瓦片 (col,row) 的左缘在图片像素空间里位于
    // (originOffsetX + col * tileSize) * bpp。世界坐标只在 originOffset 里出现。
    const originOffsetX = (level.originBlockX - tileset.bounds.xMin) / bpp;
    const originOffsetZ = (level.originBlockZ - tileset.bounds.zMin) / bpp;
    const gx0 = clampX0 / bpp;
    const gy0 = clampY0 / bpp;
    const gx1 = clampX1 / bpp;
    const gy1 = clampY1 / bpp;

    const firstCol = Math.floor((gx0 - originOffsetX) / tileSize);
    const lastCol = Math.ceil((gx1 - originOffsetX) / tileSize) - 1;
    const firstRow = Math.floor((gy0 - originOffsetZ) / tileSize);
    const lastRow = Math.ceil((gy1 - originOffsetZ) / tileSize) - 1;

    let visible = 0;
    for (let row = Math.max(firstRow, level.minZ); row <= Math.min(lastRow, level.maxZ); row += 1) {
      for (let col = Math.max(firstCol, level.minX); col <= Math.min(lastCol, level.maxX); col += 1) {
        visible += 1;
        const img = this._loadTile(level, col, row);
        if (!img) continue;
        const dx = ((originOffsetX + col * tileSize) * bpp - x0) * kk;
        const dy = ((originOffsetZ + row * tileSize) * bpp - y0) * kk;
        const dsize = tileSize * bpp * kk;
        try {
          ctx.drawImage(img, dx, dy, dsize, dsize);
          this._drawn += 1;
        } catch (err) {
          // 极少见（图片被解绑 / 解码失败）：静默跳过这一张
        }
      }
    }
    this._visibleTiles = visible;
    this._draws += 1;
  }

  /** 按视口尺寸调整 canvas 位图：视口 × dpr，超出像素上限时等比降低 */
  _resizeBacking(viewWidth, viewHeight) {
    const canvas = this.canvas;
    if (!canvas) return;
    const baseWidth = Math.ceil(viewWidth * this._dpr);
    const baseHeight = Math.ceil(viewHeight * this._dpr);
    const pixels = baseWidth * baseHeight;
    this._factor = pixels > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / pixels) : 1;

    const nextWidth = Math.max(1, Math.round(baseWidth * this._factor));
    const nextHeight = Math.max(1, Math.round(baseHeight * this._factor));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    // 改 canvas.width 会重置上下文状态并清空内容，draw() 里会重新设好
  }

  _clearCanvas() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } catch {
      /* 忽略 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 瓦片加载 / 缓存                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * 取一张瓦片：命中缓存返回 <img>；未命中返回 null 并异步发起请求。
   * @returns {HTMLImageElement|null}
   */
  _loadTile(level, col, row) {
    const tileset = this.tileset;
    if (!tileset) return null;
    // 缓存键带上版本：manifest 更新后（同 baseUrl）旧解码不会命中，重新取新瓦片
    const key = tileset.version
      ? `v${tileset.version}/${level.level}/${col}_${row}`
      : `${level.level}/${col}_${row}`;

    const cached = this._images.get(key);
    if (cached) {
      // LRU：命中后挪到队尾
      this._images.delete(key);
      this._images.set(key, cached);
      return cached;
    }
    if (this._missing.has(key) || this._pending.has(key)) return null;

    this._request(key, tileset.urlFor(level.level, col, row));
    return null;
  }

  _request(key, url) {
    if (typeof Image !== 'function') return;
    const generation = this._generation;
    const img = new Image();
    img.decoding = 'async';
    this._pending.add(key);
    this._requests += 1;

    img.onload = () => {
      if (this._destroyed || generation !== this._generation) return;
      this._pending.delete(key);
      if (!img.naturalWidth || !img.naturalHeight) {
        this._markMissing(key);
        return;
      }
      this._loaded += 1;
      this._put(key, img);
      this._schedule();
    };
    // 404 / 解码失败都是正常情况（全透明瓦片不导出）：静默忽略，不再重试
    img.onerror = () => {
      if (this._destroyed || generation !== this._generation) return;
      this._pending.delete(key);
      this._markMissing(key);
    };

    try {
      img.src = url;
    } catch {
      img.onerror();
    }
  }

  _markMissing(key) {
    this._missingCount += 1;
    if (this._missing.size >= MAX_MISSING_TILES) {
      // 负缓存也做个上限：删最早插入的一条
      const first = this._missing.values().next();
      if (!first.done) this._missing.delete(first.value);
    }
    this._missing.add(key);
  }

  _put(key, img) {
    this._images.set(key, img);
    while (this._images.size > this.maxTiles) {
      const oldest = this._images.keys().next();
      if (oldest.done) break;
      this._images.delete(oldest.value);
    }
  }

  _schedule() {
    if (this._destroyed || this._raf) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._raf = raf(() => {
      this._raf = 0;
      this.draw();
    });
  }

  _cancelFrame() {
    if (!this._raf) return;
    const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    caf(this._raf);
    this._raf = 0;
  }
}

export default TileLayer;
