/**
 * assets/js/coords.js —— 世界坐标 ↔ 图片像素 的纯函数投影层
 * =============================================================================
 * 本文件是整个站点正确性的地基，因此遵守三条铁律：
 *   1. 纯函数 / 零 DOM：可在 Node 下直接 `import` 单测（tests/coords.test.mjs）。
 *   2. 永不抛异常：非法入参一律「降级 + isValid=false」，由调用方决定提示文案。
 *   3. 只认「画幅」不认「像素」：路径点永远存世界坐标（方块），
 *      重新导出地图（裁剪范围 / 分辨率变化）后只要重新校准一次，所有点自动跟随。
 *
 * 为什么需要这一层？
 *   用户重新渲染离线地图时，画幅（crop）与分辨率都可能变：
 *     - 老图：1024×1024 像素，覆盖 [0,1024] 方块；
 *     - 新图：2048×2048 像素，覆盖 [-512,1536] 方块。
 *   同一座城堡在世界里没动，但它的像素坐标变了。
 *   所以「像素坐标」是画幅的因变量，"世界坐标"才是自变量；
 *   本文件把二者用一条线性映射联系起来，画幅一变只换参数，数据不动。
 *
 * 线性映射（契约 §1）：
 *   px = (x - xMin) / (xMax - xMin) * W
 *   py = (z - zMin) / (zMax - zMin) * H        // flipZ 时 py = (1 - t) * H
 * 其中 W/H 是图片原始像素宽高（naturalWidth / naturalHeight）。
 *
 * flipZ 的语义（务必记牢）：
 *   zMin / zMax 永远是「世界 Z 的最小值 / 最大值」，与翻不翻转无关；
 *   flipZ 只表示这张图上「世界 Z 小的一端画在上面还是下面」。
 *     flipZ = false：图片上边缘 = zMin（北在上，Minecraft 默认观感）
 *     flipZ = true ：图片上边缘 = zMax（北在下）
 *   这样存储的 zMin < zMax 恒成立，投影器只需换一个 t 的方向即可。
 */

/* -------------------------------------------------------------------------- */
/* 内部小工具                                                                  */
/* -------------------------------------------------------------------------- */

const EPS = 1e-9;

/** 有限数字？ */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 宽松数值化：接受 number 或「看起来像数字的字符串」（config.json 里手写容易带引号）。
 * 空串 / null / undefined / 布尔 / 对象一律视为非法 → NaN。
 */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** 宽松布尔化：兼容 JSON 里写成 "true" / 1 的情况 */
function toBool(v) {
  return v === true || v === 1 || v === 'true' || v === '1';
}

/** 只有有限数字才放进结果对象，否则放 null（避免把 NaN 泄给 UI 去渲染成 "NaN"） */
function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

/* -------------------------------------------------------------------------- */
/* 1. 投影器                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 创建投影器。
 *
 * @param {object} params
 * @param {number} params.xMin          图片左边缘对应的世界 X
 * @param {number} params.xMax          图片右边缘对应的世界 X
 * @param {number} params.zMin          世界 Z 最小值（flipZ=false 时即图片上边缘）
 * @param {number} params.zMax          世界 Z 最大值（flipZ=false 时即图片下边缘）
 * @param {number} params.imageWidth    图片原始像素宽（naturalWidth）
 * @param {number} params.imageHeight   图片原始像素高（naturalHeight）
 * @param {boolean} [params.flipZ]      true 表示图片上边缘是 zMax（北在下）
 * @returns {{
 *   xMin: number|null, xMax: number|null, zMin: number|null, zMax: number|null,
 *   imageWidth: number|null, imageHeight: number|null, flipZ: boolean,
 *   worldToImage: (x: number, z: number) => {px: number, py: number},
 *   imageToWorld: (px: number, py: number) => {x: number, z: number},
 *   blocksPerPixelX: number, blocksPerPixelZ: number, isValid: boolean
 * }}
 *
 * 非法参数（宽高 <= 0、xMin >= xMax、zMin >= zMax、非数值…）时：
 *   isValid = false，两个映射函数退化为「恒等映射」——
 *   worldToImage(x,z) => {px:x, py:z}，imageToWorld 同理。
 *   这样调用方即使拿到坏配置也不会崩，只是标记画在错误位置（并且可以查 isValid 提示用户）。
 */
export function createProjection({
  xMin, xMax, zMin, zMax, imageWidth, imageHeight, flipZ = false,
} = {}) {
  const x0 = toNum(xMin);
  const x1 = toNum(xMax);
  const z0 = toNum(zMin);
  const z1 = toNum(zMax);
  const w = toNum(imageWidth);
  const h = toNum(imageHeight);
  const flip = toBool(flipZ);

  // 合法性：四边有序 + 图片尺寸为正 + 全部是有限数字
  const isValid =
    Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0 &&
    Number.isFinite(z0) && Number.isFinite(z1) && z1 > z0 &&
    Number.isFinite(w) && w > 0 &&
    Number.isFinite(h) && h > 0;

  const spanX = x1 - x0; // 整幅图覆盖的世界 X 跨度（方块）
  const spanZ = z1 - z0; // 整幅图覆盖的世界 Z 跨度（方块）

  // 每像素代表多少方块：只用于比例尺 / 校准提示，不做内部计算
  const blocksPerPixelX = isValid ? spanX / w : NaN;
  const blocksPerPixelZ = isValid ? spanZ / h : NaN;

  /** 世界坐标 -> 图片像素 */
  const worldToImage = isValid
    ? (x, z) => {
      const X = toNum(x);
      const Z = toNum(z);
      if (!Number.isFinite(X) || !Number.isFinite(Z)) return { px: NaN, py: NaN };
      const px = ((X - x0) / spanX) * w;
      // t ∈ [0,1]：世界 Z 在画幅里的归一化位置
      let t = (Z - z0) / spanZ;
      if (flip) t = 1 - t; // 翻转时上下颠倒
      return { px, py: t * h };
    }
    // 退化：恒等映射（坏配置下仍可运行，不抛异常）
    : (x, z) => ({ px: toNum(x), py: toNum(z) });

  /** 图片像素 -> 世界坐标（worldToImage 的严格逆运算） */
  const imageToWorld = isValid
    ? (px, py) => {
      const P = toNum(px);
      const Q = toNum(py);
      if (!Number.isFinite(P) || !Number.isFinite(Q)) return { x: NaN, z: NaN };
      let t = Q / h;
      if (flip) t = 1 - t;
      return { x: x0 + (P / w) * spanX, z: z0 + t * spanZ };
    }
    : (px, py) => ({ x: toNum(px), z: toNum(py) });

  return {
    xMin: numOrNull(x0),
    xMax: numOrNull(x1),
    zMin: numOrNull(z0),
    zMax: numOrNull(z1),
    imageWidth: numOrNull(w),
    imageHeight: numOrNull(h),
    flipZ: flip,
    worldToImage,
    imageToWorld,
    blocksPerPixelX,
    blocksPerPixelZ,
    isValid,
  };
}

/* -------------------------------------------------------------------------- */
/* 2. 校准参数规范化                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 校验并返回规范化校准对象；无法解析时返回 null。
 *
 * 支持两种写法（契约 §1，「xMin 优先」）：
 *   A. 四边画幅：{ xMin, xMax, zMin, zMax, flipZ?, calibrated?, note? }
 *   B. 缩放+原点：{ pixelsPerBlock, originX, originZ, flipZ?, calibrated?, note? }
 *      origin 是图片**左上角**对应的世界坐标；图片宽 W 像素 → 世界跨度 W / pixelsPerBlock。
 *
 * 返回（两种写法统一成「四边画幅」）：
 *   { calibrated, xMin, xMax, zMin, zMax, flipZ, note, source: 'bounds'|'scale' }
 *   scale 写法额外带上 { pixelsPerBlock, originX, originZ } 便于回显示。
 *
 * 注意 flipZ 与 scale 写法的组合：origin 始终指「左上角」，
 * 所以 flipZ=true 时左上角的世界 Z 是**最大值**，即
 *   zMax = originZ，zMin = originZ - H / pixelsPerBlock。
 * 这样规范化结果里 zMin < zMax 恒成立，与 createProjection 的约定一致。
 *
 * @param {object} raw
 * @param {{imageWidth?: number, imageHeight?: number}} [opts] scale 写法必需图片尺寸
 * @returns {null | {calibrated: boolean, xMin: number, xMax: number, zMin: number, zMax: number,
 *                   flipZ: boolean, note: string, source: string,
 *                   pixelsPerBlock?: number, originX?: number, originZ?: number}}
 */
export function normalizeCalibration(raw, { imageWidth, imageHeight } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const flipZ = toBool(raw.flipZ);
  const calibrated = toBool(raw.calibrated);
  const note = typeof raw.note === 'string' ? raw.note : '';

  // ---- 写法 A：四边画幅（优先） ----
  const bx0 = toNum(raw.xMin);
  const bx1 = toNum(raw.xMax);
  const bz0 = toNum(raw.zMin);
  const bz1 = toNum(raw.zMax);
  if (
    Number.isFinite(bx0) && Number.isFinite(bx1) &&
    Number.isFinite(bz0) && Number.isFinite(bz1) &&
    bx1 > bx0 && bz1 > bz0
  ) {
    return {
      calibrated, xMin: bx0, xMax: bx1, zMin: bz0, zMax: bz1, flipZ, note, source: 'bounds',
    };
  }

  // ---- 写法 B：缩放 + 原点 ----
  const ppb = toNum(raw.pixelsPerBlock);
  const ox = toNum(raw.originX);
  const oz = toNum(raw.originZ);
  const w = toNum(imageWidth);
  const h = toNum(imageHeight);
  if (
    Number.isFinite(ppb) && ppb > 0 &&
    Number.isFinite(ox) && Number.isFinite(oz) &&
    Number.isFinite(w) && w > 0 &&
    Number.isFinite(h) && h > 0
  ) {
    const spanX = w / ppb;
    const spanZ = h / ppb;
    // origin 是左上角：X 方向左右都不翻转；Z 方向取决于 flipZ
    const xMin = ox;
    const xMax = ox + spanX;
    const zMin = flipZ ? oz - spanZ : oz;
    const zMax = flipZ ? oz : oz + spanZ;
    return {
      calibrated, xMin, xMax, zMin, zMax, flipZ, note, source: 'scale',
      pixelsPerBlock: ppb, originX: ox, originZ: oz,
    };
  }

  // 两种写法都不完整 → 视为「未校准」
  return null;
}

/* -------------------------------------------------------------------------- */
/* 3. 「缩放 + 原点」→ 画幅                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 由「缩放 + 原点」转成 bounds。
 *
 *   pixelsPerBlock：1 方块占多少图片像素（导出分辨率越高该值越大）
 *   originX/originZ：图片左上角对应的世界坐标
 *
 *   xMax = originX + imageWidth  / pixelsPerBlock
 *   zMax = originZ + imageHeight / pixelsPerBlock
 *
 * 说明：本函数只产出「左上角 = (originX, originZ)、Z 向下递增」的常规画幅，
 * 不处理 flipZ；flipZ 的组合换算在 normalizeCalibration 里完成
 * （因为它知道 "origin 指左上角" 这条语义）。非法入参返回 null。
 *
 * @param {{pixelsPerBlock:number, originX:number, originZ:number}} params
 * @param {{imageWidth:number, imageHeight:number}} opts
 * @returns {null | {xMin:number, xMax:number, zMin:number, zMax:number, pixelsPerBlock:number}}
 */
export function boundsFromScale({ pixelsPerBlock, originX, originZ } = {}, { imageWidth, imageHeight } = {}) {
  const ppb = toNum(pixelsPerBlock);
  const ox = toNum(originX);
  const oz = toNum(originZ);
  const w = toNum(imageWidth);
  const h = toNum(imageHeight);
  if (!(ppb > 0) || !Number.isFinite(ox) || !Number.isFinite(oz) || !(w > 0) || !(h > 0)) {
    return null;
  }
  return {
    xMin: ox,
    xMax: ox + w / ppb,
    zMin: oz,
    zMax: oz + h / ppb,
    pixelsPerBlock: ppb,
  };
}

/* -------------------------------------------------------------------------- */
/* 5. 显示格式化                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 单个方块数取整为字符串。
 * 非法值（null / NaN / 空串）返回破折号 "—"，与页面里的占位符风格一致；
 * -0 归一化为 "0"，避免界面上出现 "-0"。
 *
 * @param {number|string|null|undefined} n
 * @returns {string}
 */
export function fmtBlock(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = typeof n === 'number' ? n : toNum(n);
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v); // 契约：显示一律四舍五入到整数方块
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * 世界坐标格式化：{x:123.4, y:64.6, z:-44.6} -> "123 65 -45"
 * y 缺失（null/NaN）时省略中间一段 → "123 -45"（路径点的 y 可空）。
 *
 * @param {{x?:number, y?:number|null, z?:number}} point
 * @returns {string}
 */
export function formatCoords({ x, y, z } = {}) {
  const xs = fmtBlock(x);
  const zs = fmtBlock(z);
  const ys = fmtBlock(y);
  return ys === '—' ? `${xs} ${zs}` : `${xs} ${ys} ${zs}`;
}

/**
 * XZ 平面直线距离（方块）。
 * 非数值入参返回 0（UI 上显示 "0 方块" 比 "NaN" 安全），不抛异常。
 *
 * @param {{x:number, z:number}} a
 * @param {{x:number, z:number}} b
 * @returns {number}
 */
export function distanceXZ(a, b) {
  if (!a || !b) return 0;
  const ax = toNum(a.x);
  const az = toNum(a.z);
  const bx = toNum(b.x);
  const bz = toNum(b.z);
  if (![ax, az, bx, bz].every(Number.isFinite)) return 0;
  return Math.hypot(bx - ax, bz - az);
}
