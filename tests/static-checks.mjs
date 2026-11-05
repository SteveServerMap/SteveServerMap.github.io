/**
 * tests/static-checks.mjs
 * 不需要浏览器的静态检查：文件存在性、index.html 引用可解析、config.json 合法性、
 * ES Module import 路径存在、CSS 是否覆盖契约 §8 要求。
 *
 * 运行：node tests/static-checks.mjs [--root=<项目根>]
 * 退出码：0 全部通过；1 有失败项。
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  createReporter,
  ensureDir,
  formatDuration,
  parseArgs,
  truncate,
} from './headless.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const args = parseArgs();
const root = path.resolve(args.root ? String(args.root) : projectRoot);
const artifactsDir = path.join(projectRoot, 'tests', 'artifacts');

const rep = createReporter('static-checks');

const abs = (rel) => path.join(root, rel);

async function readText(rel) {
  return fsp.readFile(abs(rel), 'utf8');
}

async function isFile(relOrAbs) {
  const target = path.isAbsolute(relOrAbs) ? relOrAbs : abs(relOrAbs);
  try {
    const stat = await fsp.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(rel, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${rel} 不是合法 JSON：${error.message}`);
  }
}

async function main() {
  console.log(`静态检查目录：${root}`);
  console.log('');

  /* ---------------- 1. 骨架文件 ---------------- */
  const requiredFiles = [
    'index.html',
    'config.json',
    'config.schema.json',
    'assets/css/style.css',
    'assets/js/app.js',
    'assets/js/config.js',
    'assets/js/coords.js',
    'assets/js/viewer.js',
    'assets/js/markers.js',
    'assets/js/sidebar.js',
    'assets/js/measure.js',
    'assets/js/tiles.js',
  ];

  const fileState = {};
  await rep.check('files.required', `契约要求的 ${requiredFiles.length} 个文件都存在`, async () => {
    const missing = [];
    for (const rel of requiredFiles) {
      const exists = await isFile(rel);
      fileState[rel] = exists;
      if (!exists) missing.push(rel);
    }
    ok(missing.length === 0, `缺少文件：${missing.join('、')}`);
    return `${requiredFiles.length}/${requiredFiles.length}`;
  });

  /* ---------------- 2. 图片资源 ---------------- */
  const imageState = new Map();
  await rep.check('files.images', '维度基底图（PNG）存在且是有效 PNG', async () => {
    const config = parseJson('config.json', await readText('config.json').catch(() => '{}'));
    const dims = Array.isArray(config.dimensions) ? config.dimensions : [];
    ok(dims.length > 0, 'config.json 里没有 dimensions');
    const problems = [];
    for (const dim of dims) {
      const image = dim?.image;
      if (!image) {
        problems.push(`${dim?.id ?? '?'}：缺少 image 字段`);
        continue;
      }
      const target = abs(image);
      const exists = await isFile(target);
      if (!exists) {
        problems.push(`${dim.id}：图片不存在 ${image}`);
        continue;
      }
      const size = await fsp.stat(target);
      const handle = await fsp.open(target, 'r');
      try {
        const buffer = Buffer.alloc(24);
        await handle.read(buffer, 0, 24, 0);
        const isPng =
          buffer[0] === 0x89 &&
          buffer.toString('ascii', 1, 4) === 'PNG' &&
          buffer[4] === 0x0d &&
          buffer[5] === 0x0a &&
          buffer[6] === 0x1a &&
          buffer[7] === 0x0a;
        if (!isPng) {
          problems.push(`${dim.id}：${image} 不是 PNG（静态检查只校验 PNG 头）`);
          continue;
        }
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        if (!(width > 0 && height > 0)) problems.push(`${dim.id}：${image} 尺寸非法 ${width}x${height}`);
        imageState.set(dim.id, { file: image, width, height, bytes: size.size });
      } finally {
        await handle.close();
      }
    }
    ok(problems.length === 0, problems.join('；'));
    return [...imageState.entries()]
      .map(([id, info]) => `${id} ${info.width}×${info.height}（${(info.bytes / 1024 / 1024).toFixed(1)} MB）`)
      .join('，');
  });

  /* ---------------- 3. index.html 引用 ---------------- */
  let indexHtml = '';
  const indexRefs = [];
  await rep.check('index.parse', 'index.html 可读取并解析出本地引用', async () => {
    indexHtml = await readText('index.html');
    ok(indexHtml.includes('<!DOCTYPE html>'), 'index.html 缺少 <!DOCTYPE html>');
    const pattern = /<(script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = pattern.exec(indexHtml))) {
      indexRefs.push({ tag: match[1].toLowerCase(), url: match[2], raw: match[0] });
    }
    ok(indexRefs.length > 0, 'index.html 里没有找到 script/link/img 引用');
    return `${indexRefs.length} 条引用`;
  });

  await rep.check('index.refs-exist', 'index.html 的 script/css 引用都能在磁盘上解析', async () => {
    const missing = [];
    for (const ref of indexRefs) {
      if (/^(data:|https?:|\/\/|#|mailto:)/i.test(ref.url)) continue;
      const clean = ref.url.split('?')[0].split('#')[0];
      if (!(await isFile(clean))) missing.push(`<${ref.tag}> ${ref.url}`);
    }
    ok(missing.length === 0, `无法解析：${missing.join('、')}`);
    return '全部命中';
  });

  await rep.check('index.no-cdn', 'index.html 没有引入外部 CDN / 远程资源', async () => {
    const external = indexRefs
      .filter((ref) => /^(https?:)?\/\//i.test(ref.url))
      .map((ref) => `<${ref.tag}> ${ref.url}`);
    ok(external.length === 0, `发现远程资源：${external.join('、')}（项目要求零第三方依赖）`);
    return '无远程依赖';
  });

  await rep.check('index.module-entry', 'index.html 用 <script type="module"> 加载 assets/js/app.js', async () => {
    ok(
      /<script[^>]+type=["']module["'][^>]+src=["']assets\/js\/app\.js["']/.test(indexHtml),
      '没有找到 <script type="module" src="assets/js/app.js">',
    );
    return 'OK';
  });

  await rep.check('index.ids', '契约要求的 DOM id 全部存在于 index.html', async () => {
    const requiredIds = [
      'map-image',
      'stage',
      'viewport',
      'overlay',
      'map-state',
      'dimension-switch',
      'sidebar',
      'sidebar-toggle',
      'sidebar-backdrop',
      'waypoint-search',
      'waypoint-list',
      'waypoint-empty',
      'waypoint-count',
      'btn-fit',
      'btn-reset',
      'btn-grid',
      'btn-measure',
      'measure-readout',
      'toast',
    ];
    const missing = requiredIds.filter((id) => !new RegExp(`id=["']${id}["']`).test(indexHtml));
    ok(missing.length === 0, `缺少 id：${missing.join('、')}`);
    return `${requiredIds.length} 个 id`;
  });

  /* ---------------- 4. config.json ---------------- */
  let config = null;
  await rep.check('config.json', 'config.json 是合法 JSON', async () => {
    config = parseJson('config.json', await readText('config.json').catch(() => ''));
    return `顶层字段：${Object.keys(config).join(', ')}`;
  });

  await rep.check('config.site', 'config.site / version / defaultDimension 字段齐全', async () => {
    ok(config && typeof config === 'object', 'config.json 未解析');
    ok(Number.isFinite(config.version), 'version 必须是数字');
    ok(config.site && typeof config.site.title === 'string' && config.site.title.trim(), 'site.title 缺失');
    ok(typeof config.defaultDimension === 'string', 'defaultDimension 缺失');
    return `title=「${truncate(config.site.title, 40)}」，defaultDimension=${config.defaultDimension}`;
  });

  await rep.check('config.dimensions', 'dimensions 包含 overworld / nether / the_end 三个维度', async () => {
    const dims = Array.isArray(config?.dimensions) ? config.dimensions : [];
    const ids = dims.map((dim) => dim?.id);
    for (const expected of ['overworld', 'nether', 'the_end']) {
      ok(ids.includes(expected), `缺少维度 id=${expected}（现有：${ids.join(', ')}）`);
    }
    const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
    ok(dupes.length === 0, `维度 id 重复：${dupes.join('、')}`);
    ok(ids.includes(config.defaultDimension), `defaultDimension=${config.defaultDimension} 不在 dimensions 里`);
    for (const dim of dims) {
      ok(typeof dim.name === 'string' && dim.name, `维度 ${dim.id} 缺少 name`);
      ok(Array.isArray(dim.groups), `维度 ${dim.id} 缺少 groups 数组`);
      ok(Array.isArray(dim.waypoints), `维度 ${dim.id} 缺少 waypoints 数组`);
    }
    return dims.map((dim) => `${dim.id}(${dim.waypoints.length} 点)`).join('，');
  });

  await rep.check('config.waypoints', '路径点坐标 / id / 分组引用合法', async () => {
    const problems = [];
    for (const dim of config.dimensions) {
      const groupIds = new Set(dim.groups.map((group) => group?.id));
      const wpIds = dim.waypoints.map((wp) => wp?.id);
      const dupes = wpIds.filter((id, index) => wpIds.indexOf(id) !== index);
      if (dupes.length) problems.push(`${dim.id}：重复路径点 id ${dupes.join('、')}`);
      dim.waypoints.forEach((wp, index) => {
        const label = `${dim.id}[${index}] ${wp?.id ?? '?'}`;
        if (typeof wp?.id !== 'string' || !wp.id) problems.push(`${label}：缺少 id`);
        if (typeof wp?.name !== 'string' || !wp.name) problems.push(`${label}：缺少 name`);
        if (!Number.isFinite(wp?.x)) problems.push(`${label}：x 不是数字`);
        if (!Number.isFinite(wp?.z)) problems.push(`${label}：z 不是数字`);
        if (wp?.y !== undefined && wp?.y !== null && !Number.isFinite(wp.y)) problems.push(`${label}：y 不是数字`);
        if (wp?.group && !groupIds.has(wp.group)) problems.push(`${label}：group=${wp.group} 未定义`);
      });
      if (dim.groups.length === 0) problems.push(`${dim.id}：没有任何分组`);
    }
    ok(problems.length === 0, problems.join('；'));
    return '全部合法';
  });

  await rep.check('config.calibration', '每个维度都有可用的 calibration（bound + 布尔标志）', async () => {
    const problems = [];
    for (const dim of config.dimensions) {
      const cal = dim?.calibration;
      if (!cal || typeof cal !== 'object') {
        problems.push(`${dim.id}：缺少 calibration`);
        continue;
      }
      for (const key of ['xMin', 'xMax', 'zMin', 'zMax']) {
        if (!Number.isFinite(cal[key])) problems.push(`${dim.id}：calibration.${key} 不是数字`);
      }
      if (Number.isFinite(cal.xMin) && Number.isFinite(cal.xMax) && cal.xMin >= cal.xMax) {
        problems.push(`${dim.id}：xMin(${cal.xMin}) 必须小于 xMax(${cal.xMax})`);
      }
      if (Number.isFinite(cal.zMin) && Number.isFinite(cal.zMax) && cal.zMin >= cal.zMax) {
        problems.push(`${dim.id}：zMin(${cal.zMin}) 必须小于 zMax(${cal.zMax})`);
      }
      if (cal.calibrated !== undefined && typeof cal.calibrated !== 'boolean') {
        problems.push(`${dim.id}：calibration.calibrated 必须是布尔值`);
      }
      if (cal.flipZ !== undefined && typeof cal.flipZ !== 'boolean') {
        problems.push(`${dim.id}：calibration.flipZ 必须是布尔值`);
      }
    }
    ok(problems.length === 0, problems.join('；'));
    return config.dimensions
      .map((dim) => {
        const cal = dim.calibration;
        return `${dim.id}: X[${cal.xMin},${cal.xMax}] Z[${cal.zMin},${cal.zMax}]`;
      })
      .join('，');
  });

  await rep.check('config.calibration-sanity', 'calibration 与图片分辨率的比例合理（不出现 0 或极端值）', async () => {
    const problems = [];
    for (const dim of config.dimensions) {
      const image = imageState.get(dim.id);
      if (!image) continue;
      const cal = dim.calibration;
      const ppbX = image.width / (cal.xMax - cal.xMin);
      const ppbZ = image.height / (cal.zMax - cal.zMin);
      if (!(ppbX > 0) || !(ppbZ > 0)) problems.push(`${dim.id}：每方块像素数非法`);
      if (ppbX > 100 || ppbZ > 100) problems.push(`${dim.id}：每方块像素数过大（X=${ppbX.toFixed(3)}, Z=${ppbZ.toFixed(3)}）`);
      if (ppbX < 0.002 || ppbZ < 0.002) problems.push(`${dim.id}：每方块像素数过小（X=${ppbX.toFixed(4)}, Z=${ppbZ.toFixed(4)}）`);
    }
    ok(problems.length === 0, problems.join('；'));
    return config.dimensions
      .filter((dim) => imageState.has(dim.id))
      .map((dim) => {
        const image = imageState.get(dim.id);
        const cal = dim.calibration;
        return `${dim.id} ${(image.width / (cal.xMax - cal.xMin)).toFixed(3)} px/方块`;
      })
      .join('，');
  });

  await rep.check('config.schema', 'config.schema.json 是合法 JSON 且描述了 dimensions', async () => {
    const schema = parseJson('config.schema.json', await readText('config.schema.json').catch(() => ''));
    ok(schema && typeof schema === 'object', 'schema 不是对象');
    const text = JSON.stringify(schema);
    ok(text.includes('dimensions'), 'schema 里没有 dimensions 定义');
    ok(text.includes('calibration'), 'schema 里没有 calibration 定义');
    return schema.title ? `title=${schema.title}` : 'OK';
  });

  await rep.check('ui-defaults', 'config.ui 的默认值合法（labelMode / grid / startCollapsed）', async () => {
    const ui = config?.ui;
    ok(ui && typeof ui === 'object', 'config.ui 缺失（契约 §7 要求）');
    ok(['always', 'hover', 'never'].includes(ui.labelMode), `ui.labelMode 非法：${ui.labelMode}`);
    ok(typeof ui.grid === 'boolean', 'ui.grid 必须是布尔值');
    ok(typeof ui.startCollapsed === 'boolean', 'ui.startCollapsed 必须是布尔值');
    return `labelMode=${ui.labelMode}, grid=${ui.grid}, startCollapsed=${ui.startCollapsed}`;
  });

  /* ---------------- 5. ES Module import 解析 ---------------- */
  const jsFiles = [
    'assets/js/app.js',
    'assets/js/config.js',
    'assets/js/coords.js',
    'assets/js/viewer.js',
    'assets/js/markers.js',
    'assets/js/sidebar.js',
    'assets/js/measure.js',
    'assets/js/tiles.js',
  ].filter((rel) => fileState[rel]);

  const jsSources = new Map();
  await rep.check('js.readable', '各 JS 模块可读取', async () => {
    for (const rel of jsFiles) jsSources.set(rel, await readText(rel));
    return `${jsSources.size} 个模块`;
  });

  function extractSpecifiers(source) {
    const specs = new Set();
    const fromPattern = /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const pattern of [fromPattern, dynamicPattern]) {
      let match;
      while ((match = pattern.exec(source))) specs.add(match[1]);
    }
    return [...specs];
  }

  await rep.check('js.imports-exist', '所有相对 import/export 路径都能解析到真实文件', async () => {
    const problems = [];
    let checked = 0;
    for (const [rel, source] of jsSources) {
      for (const spec of extractSpecifiers(source)) {
        if (/^(https?:|data:)/.test(spec)) continue;
        if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // bare 另行检查
        checked += 1;
        const baseDir = path.dirname(abs(rel));
        const target = spec.startsWith('/') ? path.join(root, spec.slice(1)) : path.resolve(baseDir, spec);
        const candidates = [target, `${target}.js`, `${target}.mjs`, path.join(target, 'index.js')];
        let found = false;
        for (const candidate of candidates) {
          if (await isFile(candidate)) {
            found = true;
            break;
          }
        }
        if (!found) problems.push(`${rel} → ${spec}`);
      }
    }
    ok(problems.length === 0, `无法解析：${problems.join('、')}`);
    return `${checked} 条 import`;
  });

  await rep.check('js.no-bare-imports', '没有裸模块名 import（项目零第三方依赖，浏览器无法解析）', async () => {
    const problems = [];
    for (const [rel, source] of jsSources) {
      for (const spec of extractSpecifiers(source)) {
        if (spec.startsWith('.') || spec.startsWith('/')) continue;
        if (/^(https?:|data:)/.test(spec)) continue;
        problems.push(`${rel} → ${spec}`);
      }
    }
    ok(problems.length === 0, problems.join('、'));
    return '无裸模块依赖';
  });

  await rep.check('js.no-node-builtins', '浏览器模块没有引用 node: 内置模块', async () => {
    const problems = [];
    for (const [rel, source] of jsSources) {
      for (const spec of extractSpecifiers(source)) {
        if (spec.startsWith('node:')) problems.push(`${rel} → ${spec}`);
      }
    }
    ok(problems.length === 0, problems.join('、'));
    return '干净';
  });

  function extractExports(source) {
    const names = new Set();
    const patterns = [
      /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /export\s+class\s+([A-Za-z_$][\w$]*)/g,
      /export\s+const\s+([A-Za-z_$][\w$]*)/g,
      /export\s+let\s+([A-Za-z_$][\w$]*)/g,
      /export\s+\{([^}]*)\}/g,
      /export\s+default\s+(?:class|function)?\s*([A-Za-z_$][\w$]*)?/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        const chunk = match[1];
        if (!chunk) continue;
        if (pattern === patterns[4]) {
          chunk.split(',').forEach((part) => {
            const alias = part.trim().split(/\s+as\s+/);
            const exported = (alias[1] ?? alias[0] ?? '').trim();
            if (exported) names.add(exported);
          });
        } else {
          names.add(chunk);
        }
      }
    }
    return names;
  }

  const expectedExports = {
    'assets/js/coords.js': [
      'createProjection',
      'normalizeCalibration',
      'calibrationFromTwoPoints',
      'boundsFromScale',
      'formatCoords',
      'fmtBlock',
      'distanceXZ',
    ],
    'assets/js/viewer.js': ['MapView'],
    'assets/js/markers.js': ['MarkerLayer', 'ICONS'],
    'assets/js/sidebar.js': ['Sidebar'],
    'assets/js/measure.js': ['MeasureLayer', 'distanceBetween', 'formatDistance'],
    'assets/js/tiles.js': ['Tileset', 'TileLayer', 'parseManifest', 'loadTileset'],
  };

  await rep.check('js.module-api', '契约 §2~§6 要求的模块导出名齐全', async () => {
    const problems = [];
    for (const [rel, names] of Object.entries(expectedExports)) {
      const source = jsSources.get(rel);
      if (source === undefined) {
        problems.push(`${rel} 不存在`);
        continue;
      }
      const exported = extractExports(source);
      const missing = names.filter((name) => !exported.has(name));
      if (missing.length) problems.push(`${rel} 缺少导出：${missing.join('、')}`);
    }
    ok(problems.length === 0, problems.join('；'));
    return '全部导出已定义';
  });

  await rep.check('js.app-imports', 'app.js 引用了其他模块（装配入口不是空壳）', async () => {
    const source = jsSources.get('assets/js/app.js');
    if (source === undefined) throw new Error('assets/js/app.js 不存在');
    const specs = extractSpecifiers(source).filter((spec) => spec.startsWith('.'));
    ok(specs.length >= 2, `app.js 只 import 了 ${specs.length} 个模块（${specs.join(', ')}）`);
    return specs.join(', ');
  });

  /* ---------------- 6. CSS 契约 ---------------- */
  let css = '';
  await rep.check('css.readable', 'assets/css/style.css 可读取', async () => {
    css = await readText('assets/css/style.css').catch(() => '');
    ok(css.length > 0, 'style.css 为空或不存在');
    return `${css.length} 字符`;
  });

  await rep.check('css.vars', '契约 §8 要求的 CSS 变量已定义', async () => {
    const required = [
      '--bg',
      '--panel',
      '--panel-2',
      '--border',
      '--text',
      '--muted',
      '--accent',
      '--accent-2',
      '--danger',
      '--radius',
      '--shadow',
      '--sidebar-w',
    ];
    const missing = required.filter((name) => !new RegExp(`${name.replace(/-/g, '\\-')}\\s*:`).test(css));
    ok(missing.length === 0, `缺少变量：${missing.join('、')}`);
    ok(/--sidebar-w\s*:\s*320px/.test(css), '--sidebar-w 必须是 320px');
    return `${required.length} 个变量`;
  });

  await rep.check('css.hidden', '[hidden] { display: none !important; } 规则存在', async () => {
    ok(
      /\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/.test(css),
      '缺少 [hidden] { display: none !important; }',
    );
    return 'OK';
  });

  await rep.check('css.collapsed', 'body[data-sidebar="collapsed"] 样式存在', async () => {
    ok(/body\[data-sidebar=["']collapsed["']\]/.test(css), '缺少 body[data-sidebar="collapsed"] 规则');
    return 'OK';
  });

  await rep.check('css.app-grid', '.app 使用 grid-template-rows: auto 1fr auto', async () => {
    const block = /\.app\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(block.length > 0, '找不到 .app 规则块');
    ok(/display\s*:\s*grid/.test(block), '.app 没有 display: grid');
    ok(/grid-template-rows\s*:\s*auto\s+1fr\s+auto/.test(block), '.app 的 grid-template-rows 不是 auto 1fr auto');
    return 'OK';
  });

  await rep.check('css.breakpoint', '响应式断点 max-width: 860px 存在', async () => {
    ok(/max-width\s*:\s*860px/.test(css), '缺少 max-width: 860px 断点');
    return 'OK';
  });

  await rep.check('css.core-selectors', '核心布局选择器存在（.app/.sidebar/.map-viewport/.map-stage/.map-overlay）', async () => {
    const required = ['.app', '.sidebar', '.map-viewport', '.map-stage', '.map-overlay'];
    const missing = required.filter((selector) => !new RegExp(selector.replace(/\./g, '\\.') + '(?![\\w-])').test(css));
    ok(missing.length === 0, `缺少选择器：${missing.join('、')}`);
    return 'OK';
  });

  await rep.check('css.marker-selectors', '标记层 DOM 类（契约 §4）在 CSS 中有对应样式', async () => {
    const required = ['.marker', '.marker-pin', '.marker-label', '.marker-popup', '.is-offscreen'];
    const missing = required.filter((selector) => !new RegExp(selector.replace(/\./g, '\\.') + '(?![\\w-])').test(css));
    ok(missing.length === 0, `缺少选择器：${missing.join('、')}`);
    return 'OK';
  });

  await rep.check('css.no-external', 'style.css 没有 @import 远程样式 / 外部字体', async () => {
    const external = [];
    const pattern = /@import\s+(?:url\()?['"]?((?:https?:)?\/\/[^'")\s]+)/g;
    let match;
    while ((match = pattern.exec(css))) external.push(match[1]);
    ok(external.length === 0, `发现远程样式：${external.join('、')}`);
    return '无远程依赖';
  });

  /* ---------------- 7. 汇总 ---------------- */
  const summary = rep.summary();

  try {
    await ensureDir(artifactsDir);
    const reportPath = path.join(artifactsDir, 'static-checks.json');
    await fsp.writeFile(reportPath, `${JSON.stringify(rep.toJSON(), null, 2)}\n`, 'utf8');
    console.log(`  报告：${reportPath}`);
  } catch (error) {
    console.error(`  ! 写报告失败：${error.message}`);
  }

  console.log(`  耗时：${formatDuration(rep.durationMs)}`);
  process.exitCode = summary.ok ? 0 : 1;
}

main().catch((error) => {
  console.error('');
  console.error('✗ static-checks 崩溃：', error?.stack ?? error);
  process.exitCode = 1;
});
