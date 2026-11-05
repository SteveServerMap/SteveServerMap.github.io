/**
 * config.js —— 配置载入与规范化
 *
 * 设计要点：
 *   - 站点是纯静态的，配置放在 config.json，用户直接编辑该文件来增删路径点/分组/维度。
 *   - 路径点只存「世界坐标」，图片像素由 calibration（画幅校准）换算，
 *     所以基底图片重新导出、裁剪、改分辨率之后，只要重新校准一次，路径点全部自动对回。
 *   - 这里只做「结构与类型」的规范化与校验，不做像素数学（那是 coords.js 的事）。
 */

const DEFAULT_SITE = {
  title: 'Steve Server 地图',
  subtitle: '离线地图 · 路径点可配置',
  footer: '路径点由 config.json 驱动',
};

const DEFAULT_UI = {
  labelMode: 'hover', // always | hover | never
  grid: false,
  startCollapsed: false,
  showCoords: true,
  defaultSpanBlocks: 1024,
};

const DEFAULT_GROUP_COLOR = '#8fa3a0';

/** 内置兜底分组：路径点没写 group 时落到这里 */
export const DEFAULT_GROUP = {
  id: 'default',
  name: '未分组',
  color: DEFAULT_GROUP_COLOR,
  visible: true,
};

/**
 * 读取并规范化配置。
 * @param {string} [url]
 * @returns {Promise<{config: object|null, error: Error|null, warnings: string[]}>}
 */
export async function loadConfig(url = 'config.json') {
  let raw;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    try {
      raw = JSON.parse(stripBom(text));
    } catch (err) {
      throw new Error(`config.json 不是合法的 JSON：${err.message}`);
    }
  } catch (err) {
    return { config: null, error: err, warnings: [] };
  }
  const { config, warnings } = normalizeConfig(raw);
  return { config, error: config ? null : new Error('配置内容为空或缺少 dimensions'), warnings };
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}

/**
 * 规范化配置：补默认值、去重、校验必填字段，收集 warning。
 * @param {any} raw
 * @returns {{config: object|null, warnings: string[]}}
 */
export function normalizeConfig(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { config: null, warnings: ['配置根对象无效'] };
  }

  const site = { ...DEFAULT_SITE, ...(isObject(raw.site) ? pickStrings(raw.site) : {}) };
  const ui = normalizeUi(raw.ui, warnings);

  const rawDims = Array.isArray(raw.dimensions) ? raw.dimensions : [];
  if (rawDims.length === 0) {
    return { config: null, warnings: ['config.json 缺少 dimensions 数组（至少需要一个维度）'] };
  }

  const seenDimIds = new Set();
  const dimensions = [];
  rawDims.forEach((rawDim, index) => {
    const dim = normalizeDimension(rawDim, index, warnings);
    if (!dim) return;
    if (seenDimIds.has(dim.id)) {
      warnings.push(`维度 id 重复：${dim.id}，已自动改名`);
      dim.id = `${dim.id}-${index + 1}`;
    }
    seenDimIds.add(dim.id);
    dimensions.push(dim);
  });

  if (dimensions.length === 0) {
    return { config: null, warnings: ['dimensions 中没有可用维度（需要 id / name / image）'] };
  }

  let defaultDimension = typeof raw.defaultDimension === 'string' ? raw.defaultDimension : null;
  if (!defaultDimension || !dimensions.some((d) => d.id === defaultDimension)) {
    if (defaultDimension) warnings.push(`defaultDimension "${defaultDimension}" 不存在，改用第一个维度`);
    defaultDimension = dimensions[0].id;
  }

  return {
    config: {
      version: Number.isFinite(raw.version) ? raw.version : 1,
      site,
      ui,
      defaultDimension,
      dimensions,
    },
    warnings,
  };
}

function normalizeUi(rawUi, warnings) {
  const ui = { ...DEFAULT_UI };
  if (!isObject(rawUi)) return ui;
  if (typeof rawUi.labelMode === 'string') {
    if (['always', 'hover', 'never'].includes(rawUi.labelMode)) ui.labelMode = rawUi.labelMode;
    else warnings.push(`ui.labelMode 取值非法：${rawUi.labelMode}（应为 always/hover/never）`);
  }
  if (typeof rawUi.grid === 'boolean') ui.grid = rawUi.grid;
  if (typeof rawUi.startCollapsed === 'boolean') ui.startCollapsed = rawUi.startCollapsed;
  if (typeof rawUi.showCoords === 'boolean') ui.showCoords = rawUi.showCoords;
  if (rawUi.defaultSpanBlocks !== undefined) {
    const span = rawUi.defaultSpanBlocks;
    if (Number.isInteger(span) && span >= 64 && span <= 16384) ui.defaultSpanBlocks = span;
    else warnings.push('ui.defaultSpanBlocks 应为 64..16384 的整数，已使用默认值 1024');
  }
  return ui;
}

function normalizeDimension(rawDim, index, warnings) {
  if (!isObject(rawDim)) {
    warnings.push(`dimensions[${index}] 不是对象，已跳过`);
    return null;
  }
  const name = str(rawDim.name) || `维度 ${index + 1}`;
  const id = str(rawDim.id) || slugify(name) || `dim-${index + 1}`;
  const image = str(rawDim.image);
  const tiles = normalizeTiles(rawDim.tiles, warnings, name);
  if (!image && !tiles) {
    warnings.push(`维度「${name}」既没有 image 也没有 tiles，无法显示底图`);
  } else if (!image) {
    warnings.push(`维度「${name}」使用瓦片底图，没有配置 image（回退底图）`);
  }

  const groups = normalizeGroups(rawDim.groups, warnings, name);
  const groupIds = new Set(groups.map((g) => g.id));
  const waypoints = normalizeWaypoints(rawDim.waypoints, groupIds, groups, warnings, name);

  return {
    id,
    name,
    image,
    // 配了 tiles 就用瓦片底图；image + calibration 只在没有 tiles（或瓦片加载失败）时生效
    tiles,
    calibration: normalizeCalibrationRaw(rawDim.calibration, warnings, name),
    groups,
    waypoints,
    // 仅用于 UI 的元信息
    order: index,
  };
}

/**
 * 瓦片底图配置的规范化。
 * 支持两种写法：
 *   "tiles": { "manifest": "tiles/overworld/manifest.json" }
 *   "tiles": "tiles/overworld/manifest.json"
 * 没有 manifest 字段 → 视为没配置（继续走单张 image）。
 */
function normalizeTiles(raw, warnings, dimName) {
  if (raw === undefined || raw === null) return null;
  const manifest = typeof raw === 'string'
    ? str(raw)
    : (isObject(raw) ? str(raw.manifest) : '');
  if (!manifest) {
    warnings.push(`维度「${dimName}」的 tiles 缺少 manifest 字段，已忽略（继续使用 image）`);
    return null;
  }
  return { manifest };
}


function normalizeGroups(rawGroups, warnings, dimName) {
  const list = [];
  const seen = new Set();
  if (Array.isArray(rawGroups)) {
    rawGroups.forEach((g, i) => {
      if (!isObject(g)) {
        warnings.push(`维度「${dimName}」groups[${i}] 不是对象，已跳过`);
        return;
      }
      const name = str(g.name) || `分组 ${i + 1}`;
      let id = str(g.id) || slugify(name) || `group-${i + 1}`;
      if (seen.has(id)) {
        warnings.push(`维度「${dimName}」分组 id 重复：${id}，已自动改名`);
        id = `${id}-${i + 1}`;
      }
      seen.add(id);
      list.push({
        id,
        name,
        color: str(g.color) || DEFAULT_GROUP_COLOR,
        visible: g.visible !== false,
      });
    });
  }
  return list;
}

function normalizeWaypoints(rawWaypoints, groupIds, groups, warnings, dimName) {
  const list = [];
  const seen = new Set();
  const list0 = Array.isArray(rawWaypoints) ? rawWaypoints : [];

  list0.forEach((w, i) => {
    if (!isObject(w)) {
      warnings.push(`维度「${dimName}」waypoints[${i}] 不是对象，已跳过`);
      return;
    }
    const name = str(w.name) || `路径点 ${i + 1}`;
    const x = num(w.x);
    const z = num(w.z);
    if (x === null || z === null) {
      warnings.push(`路径点「${name}」缺少有效的 x / z 世界坐标，已跳过（这是最常见的配置错误）`);
      return;
    }
    let id = str(w.id) || slugify(name) || `wp-${i + 1}`;
    if (seen.has(id)) {
      warnings.push(`维度「${dimName}」路径点 id 重复：${id}，已自动改名`);
      id = `${id}-${i + 1}`;
    }
    seen.add(id);

    let group = str(w.group);
    if (group && !groupIds.has(group)) {
      warnings.push(`路径点「${name}」引用了不存在的分组 "${group}"，已归入「未分组」`);
      group = null;
    }
    if (!group) {
      group = DEFAULT_GROUP.id;
      if (!groupIds.has(group)) {
        groups.push({ ...DEFAULT_GROUP });
        groupIds.add(group);
      }
    }
    const groupMeta = groups.find((g) => g.id === group) || DEFAULT_GROUP;

    list.push({
      id,
      name,
      x,
      y: num(w.y),
      z,
      group,
      color: str(w.color) || groupMeta.color,
      icon: str(w.icon) || 'pin',
      label: ['always', 'hover', 'never'].includes(w.label) ? w.label : null,
      description: str(w.description),
      url: str(w.url),
      dimensionId: null, // 由 app.js 补齐
    });
  });

  // 补一个「未分组」分组（只有在真的用到时才加）
  return list;
}

/**
 * 校准参数的原始规范化。不做像素换算 —— 图片尺寸拿到之后由 coords.createProjection 处理。
 * 支持两种写法：
 *   1) xMin/xMax/zMin/zMax（推荐，校准向导输出的就是它）
 *   2) pixelsPerBlock + originX/originZ
 */
function normalizeCalibrationRaw(raw, warnings, dimName) {
  const out = {
    calibrated: false,
    xMin: null,
    xMax: null,
    zMin: null,
    zMax: null,
    flipZ: false,
    pixelsPerBlock: null,
    originX: null,
    originZ: null,
    note: '',
    source: 'none', // bounds | scale | none
  };
  if (!isObject(raw)) {
    warnings.push(`维度「${dimName}」没有 calibration，路径点将无法定位（可用左上角「校准」生成）`);
    return out;
  }

  out.calibrated = raw.calibrated === true;
  out.flipZ = raw.flipZ === true;
  out.note = str(raw.note);

  const hasBounds =
    num(raw.xMin) !== null && num(raw.xMax) !== null && num(raw.zMin) !== null && num(raw.zMax) !== null;
  if (hasBounds) {
    out.xMin = num(raw.xMin);
    out.xMax = num(raw.xMax);
    out.zMin = num(raw.zMin);
    out.zMax = num(raw.zMax);
    out.source = 'bounds';
    if (out.xMax <= out.xMin) warnings.push(`维度「${dimName}」calibration 的 xMax 应大于 xMin`);
    if (out.zMax <= out.zMin) warnings.push(`维度「${dimName}」calibration 的 zMax 应大于 zMin`);
    return out;
  }

  const ppb = num(raw.pixelsPerBlock);
  const ox = num(raw.originX);
  const oz = num(raw.originZ);
  if (ppb !== null && ppb > 0 && ox !== null && oz !== null) {
    out.pixelsPerBlock = ppb;
    out.originX = ox;
    out.originZ = oz;
    out.source = 'scale';
    return out;
  }

  warnings.push(`维度「${dimName}」calibration 不完整（需要 xMin/xMax/zMin/zMax 或 pixelsPerBlock+originX/originZ）`);
  return out;
}

/* ---------------------------------- 工具 ---------------------------------- */

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickStrings(obj) {
  const out = {};
  for (const key of ['title', 'subtitle', 'footer']) {
    if (typeof obj[key] === 'string') out[key] = obj[key];
  }
  return out;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 把规范化后的维度列表摊平成「全部路径点」并补 dimensionId，便于全局搜索/统计。
 */
export function flattenWaypoints(dimensions) {
  const out = [];
  for (const dim of dimensions) {
    for (const wp of dim.waypoints) {
      out.push({ ...wp, dimensionId: dim.id });
    }
  }
  return out;
}
