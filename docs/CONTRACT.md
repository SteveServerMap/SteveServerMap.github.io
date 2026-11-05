# 内部接口契约（所有开发者必读）

本项目是**纯静态站点**（GitHub Pages），无构建步骤、无第三方依赖（禁止引入 CDN / npm 包）。
所有 JS 都是原生 ES Module，直接由浏览器加载。

```
index.html                 页面骨架（Lead 拥有，其他人不要修改）
config.json                用户配置文件（Lead 拥有）
config.schema.json         配置的 JSON Schema（Lead 拥有）
主世界.png / 下界.png / 末地.png  基底图片
assets/css/style.css       style-dev 拥有
assets/js/config.js        config/normalize（Lead 拥有）
assets/js/coords.js        viewer-dev 拥有（纯函数，无 DOM）
assets/js/viewer.js        viewer-dev 拥有（平移缩放引擎）
assets/js/markers.js       ui-dev 拥有（标记图层）
assets/js/sidebar.js       ui-dev 拥有（左侧路径点菜单）
assets/js/app.js           Lead 拥有（装配所有模块）
tests/                     qa-dev 拥有
```

**只改自己拥有的文件。** 需要别人改的东西 → 发消息给 Lead。

---

## 1. 核心概念：世界坐标 ↔ 图片像素

用户渲染离线地图时画幅（crop / 分辨率）会变，所以**路径点一律存 Minecraft 世界坐标（方块坐标）**，
再由「校准参数」换算到图片像素。画幅变化后只要重新校准一次，所有路径点自动跟随，永不丢失。

校准参数（`config.json` 里每个维度各一份）：

```jsonc
"calibration": {
  "calibrated": true,         // false 时 UI 显示「未校准」提示
  "xMin": -1792, "xMax": 1792,  // 图片左边缘 = 世界 X 最小值；右边缘 = 最大值
  "zMin": -2560, "zMax": 2560,  // 图片上边缘 = 世界 Z 最小值；下边缘 = 最大值
  "flipZ": false,             // 可选，北在下时置 true（默认 false）
  "note": "自由文本"
}
```

也支持「缩放+原点」写法（二选一，`xMin` 优先）：
`{"pixelsPerBlock": 1, "originX": 0, "originZ": 0}`，其中 origin 是图片左上角对应的世界坐标。

映射公式（`px,py` 为图片像素，左上为 0,0；`W,H` 为图片原始像素宽高）：

```
px = (x - xMin) / (xMax - xMin) * W
py = (z - zMin) / (zMax - zMin) * H     // flipZ 时改为 *(1 - t)
```

---

## 2. `assets/js/coords.js`（viewer-dev）—— 纯函数，必须可在 Node 下单测

```js
/** 创建投影器。imageWidth/imageHeight 取图片原始像素尺寸（naturalWidth/Height）。 */
export function createProjection({ xMin, xMax, zMin, zMax, imageWidth, imageHeight, flipZ = false })
//   返回 { xMin, xMax, zMin, zMax, imageWidth, imageHeight, flipZ,
//          worldToImage(x, z) -> {px, py},
//          imageToWorld(px, py) -> {x, z},
//          blocksPerPixelX, blocksPerPixelZ,
//          isValid -> true/false（参数非法时为 false，映射退化为恒等） }

/** 校验并返回规范化校准对象；缺字段返回 null */
export function normalizeCalibration(raw, { imageWidth, imageHeight })

/** 由「两点已知地标」反解画幅。A/B 为 {px,py,x,z}。同一轴两点像素重复则返回 null */
export function calibrationFromTwoPoints(a, b, { imageWidth, imageHeight })  // -> {xMin,xMax,zMin,zMax}

/** 由「缩放+原点」转成 bounds */
export function boundsFromScale({ pixelsPerBlock, originX, originZ }, { imageWidth, imageHeight })

/** 世界坐标格式化：formatCoords({x,y,z}) -> "123 64 -45"；fmtBlock(n) -> 取整字符串 */
export function formatCoords({ x, y, z })
export function fmtBlock(n)

/** 两点世界距离（XZ 平面）：distanceXZ(a, b) */
export function distanceXZ(a, b)
```

约定：坐标一律四舍五入到整数方块用于显示；内部计算保留浮点。

---

## 3. `assets/js/viewer.js`（viewer-dev）—— 平移 / 缩放引擎

只操作 `index.html` 里已存在的节点，不创建顶层 DOM：

- `#viewport.map-viewport`：裁剪容器（`overflow:hidden`、`position:relative`）
- `#stage.map-stage`：被 transform 的图层（内含 `<img id="map-image">`）
- `#overlay.map-overlay`：屏幕坐标覆盖层（标记、网格、准星），**不随 transform 缩放**

变换语义：图片像素 `px,py` → 视口 CSS 像素 `sx = tx + px*scale`，`sy = ty + py*scale`。
`#stage` 用 `transform: translate3d(tx,ty,0) scale(scale)`，`transform-origin: 0 0`。

```js
export class MapView {
  constructor(viewportEl, {
    onViewChange(viewState),          // 每次变换后调用（用于标记重排、坐标读数）
    onMapClick(imagePoint),           // 单击地图（拖拽结束不算点击）
    onMapPointerMove(imagePoint|null),// 悬停 / 移出（null）
    onDoubleClick(imagePoint),
    minScale = 0.05, maxScale = 8,
  })

  /** 载入基底图。resolves 后 getImageSize() 可用；失败 reject */
  setImage(url)                        // -> Promise<{width,height}>
  getImageSize()                       // -> {width, height} | null

  setProjection(projection)            // 保存当前投影，供 getWorldAt 使用
  getProjection()

  getViewState() // -> { scale, tx, ty, viewWidth, viewHeight, imageWidth, imageHeight }
  setViewState({scale, tx, ty}, { animate = false } = {})
  zoomBy(factor, anchorViewportPoint?)      // anchor 默认视口中心
  fitToContent({ padding = 24, animate = false } = {})   // 整图适配
  fitToImageRect({ px, py, width, height }, { padding = 24, animate = false }) // 适配到图片矩形
  centerOnImagePoint(px, py, { scale, animate = true } = {})
  resetView()

  viewportToImage(clientX, clientY)  // -> {px, py}
  imageToViewport(px, py)            // -> {x, y}（相对视口左上）
  clientToWorld(clientX, clientY)    // -> {x, z} | null（无投影时 null）
  worldToClient(x, z)                // -> {x, y}（相对页面 clientX/Y）
  render()                           // 手动重绘（标记层用它对齐）
  destroy()
}
```

行为要求：
- 滚轮缩放以鼠标位置为锚点；`Ctrl`/`⌘ + 滚轮` 也要缩放（阻止页面缩放）。
- 拖拽平移（Pointer Events，`setPointerCapture`）；触摸双指捏合缩放 + 单指平移。
- 键盘：`+`/`-` 缩放，方向键平移（挂到 viewport `tabindex=0`）。
- 拖拽后不要触发 click（区分阈值 4px）。
- 只在需要时创建/移除 `requestAnimationFrame`；无动画时同步渲染。
- 提供一个可读的 `console.warn` 而不是抛异常：非法 scale 时钳制。

---

## 4. `assets/js/markers.js`（ui-dev）—— 标记图层

```js
export class MarkerLayer {
  constructor(overlayEl, view, { onSelect(waypoint), onHover(waypoint|null), onCopy(waypoint) })

  /** waypoints: 已规范化的路径点数组；groups: 分组数组；projection 可空 */
  setData(waypoints, groups, projection)
  update()                        // view 变化后重排（由 app.js 在 onViewChange 里调用）
  setGroupVisible(groupId, visible)
  setFilter(predicate)            // predicate(waypoint)=>boolean，null 清除；被过滤的标记 hidden
  setLabelMode('always' | 'hover' | 'never')
  setHighlight(id)                // 侧栏 hover / 选中联动
  setSelected(id)                 // 弹出详情卡片
  focusWaypoint(id)               // 若被视口裁掉则平移视图，由 app.js 处理视图，不必实现
  refresh()                       // 重新计算可见性（搜索过滤后用）
  destroy()
}
```

DOM：每个路径点生成
```html
<button class="marker" data-id="xxx" data-group="base" style="--marker-color:#5ad26f">
  <span class="marker-pin"><span class="marker-icon">🏠</span></span>
  <span class="marker-label">出生点</span>
</button>
```
定位用 `style.transform = translate3d(x px, y px, 0)`（外层 `.marker` 有 `position:absolute; left:0; top:0`，
通过 `translate(-50%,-100%)` 让针尖对准坐标点）。视口外的标记加 `.is-offscreen`（`visibility:hidden`）。
图标解析 `ICONS` 表（见 §6）。详情卡片由 markers.js 生成到 `#overlay` 内的 `.marker-popup`。

---

## 5. `assets/js/sidebar.js`（ui-dev）—— 左侧菜单

```js
export class Sidebar {
  constructor(rootEl /* #sidebar */, {
    onSelectWaypoint(id), onToggleGroup(groupId, visible),
    onDimensionChange(id), onSearch(query), onAction(name),   // name 见下
    onToggleCollapsed(collapsed),
  })
  setSiteInfo({ title, subtitle, footer })
  setDimensions(dimensions, activeId)        // 渲染 #dimension-switch 与 #sidebar 内维度信息
  setData({ waypoints, groups, projection, dimension })  // 渲染分组 + 列表
  setActiveWaypoint(id)     // 列表高亮并滚动到可见
  setHighlight(id)          // hover 高亮（不滚动）
  setCalibrationNotice(show)   // 是否显示「未校准」横幅
  setStats({ total, visible, hidden })  // 更新计数徽标
  setCollapsed(bool)
  isCollapsed()
  setLoading(bool)
  setError(message|null)    // 在列表区域显示错误
}
```

`onAction(name)` 会收到：`'fit'` `'reset'` `'grid'` `'copy-link'` `'calibrate'` `'zoom-in'` `'zoom-out'`
`'all-visible'` `'all-hidden'` `'sort'` `'toggle-labels'`。按钮若在 `index.html` 里已存在（`#btn-*`），
sidebar.js 负责绑定它们。

---

> **2026-11-05 起「分组」面板已移除**：分组信息（颜色 / 名称 / 数量 / 眼睛开关）只保留在路径点列表的分组头上，
> 「全显 / 全隐」按钮移到了「列表」面板的标题栏。`#group-list` 与 `#panel-groups` 不再存在于 `index.html`，
> `sidebar.js` 里相关代码路径仍保留（`this.el.groupList` 为空时自动跳过），便于将来需要时恢复。

### 5.x 侧栏路径点列表的分组折叠

- `#waypoint-list` 的内容按「分组」分区渲染：每个分组一个 `section.wp-group[data-group]`，
  里面依次是 `div.wp-group-head`（箭头 + 色块 + 名称 + 数量 + 眼睛按钮）与 `div.wp-group-items`（组内路径点）。
- 点分组头 = 折叠/展开（`is-collapsed`，`aria-expanded` 同步；折叠时组内节点仍在 DOM 里，只是 `display:none`）。
- 分组头里的眼睛按钮 = 切换该分组显隐，与 `#group-list` 的分组面板联动（两处的 `aria-pressed` 保持一致）。
- 折叠状态按「维度 + 分组」记在 `localStorage['ssm.collapsedGroups.v1']`（元素形如 `overworld::base`），刷新后保持。
- 搜索（`#waypoint-search`）时强制展开所有分组，避免「搜到了却看不见」；清空搜索后恢复用户之前的折叠状态。
- 分组顺序跟随 `config.json` 里 `dimensions[].groups` 的定义顺序，组内顺序跟随 `waypoints` 数组顺序。

### 5.y 默认视野（进入页面 / 「原点」按钮）

- 进入某个维度（且没有 `#dim/...` 深链）时，默认**聚焦世界原点 (0,0)**，视野横向约 `ui.defaultSpanBlocks`（默认 **1024**）个方块，
  不再使用「整图适配」（那是最小缩放，1 方块只占约 0.13 屏幕像素）。
- 左下角 **「原点」(#btn-reset)** 与进入页面时**完全同一行为**：回到原点 + 恢复默认视野比例。
- **「整图」(#btn-fit / #zoom-fit)** 仍是整图适配；`#btn-reset` 不再复用 `MapView.resetView()`。
- URL 深链 `#dim=<id>&x=<世界X>&z=<世界Z>&s=<缩放>` 优先于默认视野；`#dim=<id>&wp=<路径点id>` 会聚焦该路径点。
- 想调整"初始看多大一片"：在 `config.json` 里设 `ui.defaultSpanBlocks`（64~16384）。

### 5.z 滚轮 / 指针事件的忽略范围

- **滚轮**：只有 `.marker-popup`、`.zoom-panel`、`.coord-readout`、`.map-hint`、`.scale-bar` 这些自身可能要滚动的 UI 会吞掉滚轮；
  **鼠标停在路径点标记（`.marker` / `.marker-pin` / `.marker-label`）上时滚轮仍然缩放地图**（锚点为光标位置）。
- **指针**：`.marker` 仍然忽略拖拽/点击（点标记 = 选中并打开弹窗，不拖动地图）。

### 5.w 站内校准向导已移除（2026-11-05）

- 顶栏 `#btn-calibrate`、提示条里的 `#notice-calibrate`、`#calibrator` 弹窗、`assets/js/calibrate.js` 全部删除；
  校准统一在 **SteveServerMapConfig** 配置工具里做，写完 `config.json` 发布即可。
- 同时移除「本地校准覆盖」（`localStorage['steveservermap.calibration.v1']`）：画幅现在**只**来自 `config.json`，
  不会再出现"某台电脑上位置和别人的不一样"。旧的存储键不再读取（保留也不会生效）。
- 保留的 API：`window.__mapApp.applyCalibration(calibration)`（供自动化测试模拟画幅变化）、`resolveCalibration()`。
- `#calibration-notice` 仍在（画幅未校准时提示），只是不再带按钮。
- `assets/css/style.css` 的 07 段（校准向导样式）已删除。

### 5.y 测距（`assets/js/measure.js`）

```js
export function distanceBetween(a, b)      // 世界坐标两点距离（格）
export function formatDistance(value)      // 展示用格式化（<100 保留 1 位小数）
export class MeasureLayer {
  constructor(overlayEl)                   // 往 #overlay 里插一个 <svg class="measure-layer">
  setProjection(projection)
  setActive(bool)                          // 测距模式开关
  addPoint({x, z, snapped?})               // 加测量点，返回 { index, segment }
  undo() / clear()
  setHover({x, z} | null)                  // 鼠标预览段（虚线 + 实时距离）
  update(viewState)                         // 视图变化时重排（app.js 的 handleViewChange 调）
  get segments() / get total() / get summary()  // { points, segments, total, active }
}
```

- 测量点存**世界坐标**，缩放/平移/换画幅都不会错位；每次视图变化由 app.js 调 `update(viewState)` 重绘。
- 渲染：`polyline.measure-line`（实线）、`polyline.measure-preview`（虚线预览）、`g.measure-vertices`（顶点，起点带「起点」标签）、
  `g.measure-labels`（每段 `text.measure-seg-label` + 末尾 `text.measure-total-label`「总长 X 格」）。
- 交互（app.js 负责）：顶栏 `#btn-measure` 开关；`handleMapClick` 在测距模式下优先加点（不走路径点选中）；
  吸附判定在**图片像素**空间做（`tolPx = 14 / scale`），命中最近路径点则改用该点的世界坐标；
  `Backspace` 撤销、`Enter`/`Esc` 退出；读数面板 `#measure-readout`（总长 / 逐段 / 撤销 / 清空 / 退出）。
- 测距模式下 `body.is-measuring` 会禁用 `.marker / .marker-pin / .marker-label` 的 `pointer-events`，
  否则标记会吞掉点击、也没法吸附（与 `.is-picking` 同一套写法）。
- 调试接口：`window.__mapApp.measure` / `measureSummary()` / `addMeasurePoint(x, z)` / `toggleMeasure()` /
  `undoMeasurePoint()` / `clearMeasure()`；最近一次点击记在 `window.__measureLastClick`。

## 6. 配置格式（`config.json`）

```jsonc
{
  "version": 1,
  "site": { "title": "…", "subtitle": "…", "footer": "…" },
  "defaultDimension": "overworld",
  "ui": { "labelMode": "hover", "grid": false, "startCollapsed": false, "showCoords": true },
  "dimensions": [
    {
      "id": "overworld",
      "name": "主世界",
      "image": "主世界.png",
      "calibration": { "calibrated": false, "xMin": -1792, "xMax": 1792, "zMin": -2560, "zMax": 2560, "note": "…" },
      "groups": [
        { "id": "base", "name": "据点", "color": "#5ad26f", "visible": true }
      ],
      "waypoints": [
        { "id": "spawn", "name": "出生点", "x": 0, "z": 0, "y": 65,
          "group": "base", "icon": "home", "label": "always",
          "description": "服务器出生点" }
      ]
    }
  ]
}
```

- 规范化后的维度对象：`{ id, name, image, calibration, groups, waypoints, valid }`
- 规范化后的路径点：`{ id, name, x, y, z, group, icon, color, label, description, url }`
  - `y` 可省略（null）；`group` 缺省落到 `default` 分组；`icon` 缺省 `pin`；`color` 缺省取分组色。
- `label`：`always` | `hover` | `never`（缺省跟随全局 `ui.labelMode`）。
- 图标映射 `ICONS`（markers.js 与 sidebar.js 共用，写在 markers.js 里并 `export`）：

```
pin 🧷 home 🏠 village 🏘️ farm 🌾 mine ⛏️ portal 🌀 chest 📦 diamond 💎
skull ☠️ tower 🏰 ship ⛵ mountain ⛰️ redstone 🔴 nether 🐷 end 🐉 shop 🛒
spawn 🌍 bed 🛏️ pvp ⚔️ event 🎪 question ❓
```
若 `icon` 是 1~2 个字符的字符串则当作 emoji 原样使用；未知 key → `pin`。

---

## 7. CSS 约定（style-dev 定，其他人只加类名不改 style.css）

- 全局变量：`--bg --panel --panel-2 --border --text --muted --accent --accent-2 --danger --radius --shadow`
- 侧栏展开宽度 `--sidebar-w: 320px`；`body[data-sidebar="collapsed"]` 时侧栏移出（移动端为覆盖抽屉）。
- `.app` 为 CSS Grid：`grid-template-rows: auto 1fr auto`，顶栏 / 主体 / 页脚。
- 必须包含 `[hidden] { display: none !important; }`
- 深色主题（背景接近 `#0f1210`），强调色 Minecraft 草绿 `#5ad26f`。
- 响应式断点：`max-width: 860px` 走抽屉模式，`#sidebar-backdrop` 显示。

---

## 8. 验收标准（qa-dev 会跑）

1. `python -m http.server` 起静态服务后，页面无 console error，`#map-image` 有 `naturalWidth > 0`。
2. 三个维度都能切换；缺图维度显示 `#map-state` 提示而不是崩溃。
3. 路径点数量 = config 中该维度数量，且位置随缩放/平移正确跟随（误差 < 1px）。
4. 侧栏点击路径点 → 视图居中该点；分组开关生效。
6. 窄屏（390×844）下侧栏可开合，地图可用。
