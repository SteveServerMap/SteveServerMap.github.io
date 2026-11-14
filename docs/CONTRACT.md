# 内部接口契约（所有开发者必读）

本项目是**纯静态站点**（GitHub Pages），无构建步骤、无第三方依赖（禁止引入 CDN / npm 包）。
所有 JS 都是原生 ES Module，直接由浏览器加载。

```
index.html                 页面骨架（Lead 拥有，其他人不要修改）
config.json                用户配置文件（Lead 拥有）
config.schema.json         配置的 JSON Schema（Lead 拥有）
主世界.png / 下界.png / 末地.png  基底图片（单张模式；配了 tiles 的维度只作兜底）
tiles/<dim>/manifest.json + tiles/<dim>/tiles/<level>/<x>_<y>.png  瓦片底图（见 §10）
assets/css/style.css       style-dev 拥有
assets/js/config.js        config/normalize（Lead 拥有）
assets/js/coords.js        viewer-dev 拥有（纯函数，无 DOM）
assets/js/viewer.js        viewer-dev 拥有（平移缩放引擎）
assets/js/tiles.js         瓦片底图（manifest 解析 / 层级选择 / canvas 渲染 / LRU 缓存）
assets/js/converter.js     坐标换算工具（主世界 ↔ 下界 ÷8 / ×8，见 §11）
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
  "calibrated": true,         // 是否已确认校准（历史字段，站点 UI 不再显示提示）
  "xMin": -1792, "xMax": 1792,  // 图片左边缘 = 世界 X 最小值；右边缘 = 最大值
  "zMin": -2560, "zMax": 2560,  // 图片上边缘 = 世界 Z 最小值；下边缘 = 最大值
  "flipZ": false,             // 可选，北在下时置 true（默认 false）
  "note": "自由文本"
}
```

也支持「缩放+原点」写法（二选一，`xMin` 优先）：
`{"pixelsPerBlock": 1, "originX": 0, "originZ": 0}`，其中 origin 是图片左上角对应的世界坐标。

映射公式（`px,py` 为图片像素，左上为 0,0；`W,H` 为图片原始像素宽高）：

> **第二种投影：瓦片底图（§10）**。维度配了 `tiles` 时不再用 `calibration`：
> 世界范围直接取 `manifest.worldBlockRange`，且 level 0 的 **1 像素 = 1 方块**，
> 于是 `W = xMax - xMin`、`H = zMax - zMin`，代入上面的公式正好等价于
> `px = x - xMin`、`py = z - zMin`。`coords.createProjection` 一行都不用改，
> `app.js` 只是换了一组参数（见 §10.2）。

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
- `#stage.map-stage`：被 transform 的图层，内含**当前底图元素**（二选一，另一个 `hidden`）：
  - `<img id="map-image" class="map-image">`：单张图片维度（`setImage(url)`）；
  - `<canvas id="map-canvas" class="map-image map-canvas">`：瓦片维度（`setRasterBase({width,height})`，内容由 `tiles.js` 画，见 §10）。
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

  /** 载入基底图（单张图片）。resolves 后 getImageSize() 可用；失败 reject。
   *  调用后底图元素切回 <img id="map-image"> */
  setImage(url)                        // -> Promise<{width,height}>
  /** 直接把底图设为「已知逻辑尺寸的栅格」（瓦片 <canvas>）；不加载图片 */
  setRasterBase({ width, height, element? })  // -> Promise<{width,height}>
  /** 切换当前底图元素（img / canvas），尺寸与样式语义不变 */
  setBaseLayer(el)                     // -> Element|null
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

### 3.x 缩放下限：整图适配（2026-11-05）

- 构造参数新增 `minScaleFit`（默认 `false` 保持老行为；站点在 `app.js` 里开启 `true`）与 `minScaleFitFactor`（默认 `1`，可设 `0.9` 允许比整图再小 10%）。
- 开启后 `_effectiveMinScale()` = `max(minScale, 整图适配比例 × factor)`：**怎么滚轮缩小，地图最多缩到刚好铺满视口**，不会缩成一个点。
- `_fitScale()` 拆成 `_rawFitScale()`（不钳制）+ `_fitScale()`（钳制），避免和动态下限互相递归。
- 视口尺寸变化（窗口缩放 / 侧栏收起）时 `_onResize()` 会按新的整图比例重新钳制当前缩放。
- 深链里的 `s` 值同样走 `_resolveScale`，过小的值会被钳制到整图比例。

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
详情卡的 `.popup-group` 只在有分组时显示；`group === 'default'`（未分组）时隐藏，标题下不再出现「未分组」。

---

### 4.x 密集点去重叠（v2，2026-11-05）

`markers.js` 的 `update()` 末尾会跑一次 `_layoutDenseMarkers()`，处理"点太密互相遮挡"：

1. **z 序**：按屏幕 y 从小到大赋值 `marker.style.zIndex`（越靠下越盖在上面），`is-highlighted` +1000、`is-selected` +2000；
2. **堆叠**：屏幕距离 ≤ `STACK_RADIUS_PX = 12` 的标记归为一堆（`this._stacks: Map<id, ids[]>`）；
   堆里**最上面**那个加 `.is-stacked` 并渲染 `<span class="marker-stack">×N</span>` 徽标；
   连点同一个标记会在同堆点之间**轮换选中**（否则被盖住的点永远点不到）；
3. **标签避让**：只对「常显 / 选中 / 悬停」的标签参与判定；同堆只保留堆顶那个标签，
   其余按矩形相交（彼此 + 别人的 pin 矩形，`LABEL_PAD_PX = 2`）加 `.is-label-collided` 隐藏；
   悬停 / 选中时 CSS 仍会强制显示（`:not(.is-selected):not(.is-hover)` 选择器）。
- 标签尺寸缓存在 `this._labelSize`（`setData` / `setLabelMode` 时清空），避免每帧读 `offsetWidth`。
- 几何常量 `MARKER_W = 30` / `MARKER_H = 35` 必须与 `style.css` 的 `.marker` 保持一致。

## 5. `assets/js/sidebar.js`（ui-dev）—— 左侧菜单

```js
export class Sidebar {
  constructor(rootEl /* #sidebar */, {
    onSelectWaypoint(id), onToggleGroup(groupId, visible),
    onDimensionChange(id), onSearch(query), onAction(name),   // name 见下
    onToggleCollapsed(collapsed),
  })
  setSiteInfo({ title, subtitle })
  setDimensions(dimensions, activeId)        // 渲染 #dimension-switch 与 #sidebar 内维度信息
  setData({ waypoints, groups, projection, dimension })  // 渲染分组 + 列表
  setActiveWaypoint(id)     // 列表高亮并滚动到可见
  setHighlight(id)          // hover 高亮（不滚动）
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

### 5.v 窄屏顶栏工具收纳（2026-11-13）

- 断点与抽屉一致：`matchMedia('(max-width: 860px)')`。
- `app.js` 的 `initResponsiveTools()` 在窄屏把 `#btn-skin`、`#btn-convert` 移入侧栏底脚
  `#sidebar-tools`（`index.html` 里预留的空容器，桌面 `hidden`）；变宽后按原顺序移回
  `.topbar-right`（`#btn-skin` 回到 `#btn-copy-link` 之前，`#btn-convert` 回到 `#btn-theme` 之前）。
- 从抽屉里启动皮肤 / 换算面板时自动收起抽屉，避免遮罩盖住面板。
- 移动用 `Element.append` / `Node.before`，节点不重建，事件绑定与无障碍属性保持不变。

### 5.x 侧栏路径点列表的分组折叠

- `#waypoint-list` 的内容按「分组」分区渲染：每个分组一个 `section.wp-group[data-group]`，
  里面依次是 `div.wp-group-head`（箭头 + 色块 + 名称 + 数量 + 眼睛按钮）与 `div.wp-group-items`（组内路径点）。
- 点分组头 = 折叠/展开（`is-collapsed`，`aria-expanded` 同步；折叠时组内节点仍在 DOM 里，只是 `display:none`）。
- 分组头里的眼睛按钮 = 切换该分组显隐（`aria-pressed` 与按钮图标同步）；失效分组的路径点静默归入 `default`。
- 折叠状态按「维度 + 分组」记在 `localStorage['ssm.collapsedGroups.v1']`（元素形如 `overworld::base`），刷新后保持。
- 搜索（`#waypoint-search`）时强制展开所有分组，避免「搜到了却看不见」；清空搜索后恢复用户之前的折叠状态。
- 分组顺序跟随 `config.json` 里 `dimensions[].groups` 的定义顺序，组内顺序跟随 `waypoints` 数组顺序。

### 5.y 默认视野（进入页面 / 「原点」 / 「整图」按钮）

- 进入某个维度（且没有 `#dim/...` 深链）时，默认**聚焦世界原点 (0,0)**，视野**长边**（横屏为宽、竖屏为高）约 `ui.defaultSpanBlocks`（默认 **1024**）个方块，
  不再使用「整图适配」（那是最小缩放，1 方块只占约 0.13 屏幕像素）。竖屏按高度取 1024，避免纵向视野过大导致层级变粗、首屏流量翻倍。
- 左下角 **「原点」(#btn-reset)** 与进入页面时**完全同一行为**：回到原点 + 恢复默认视野比例。
- **「整图」(#btn-fit / #zoom-fit)** 不再整图适配：改为**以出生点为中心**，视野横向约 **1536** 个方块
  （`app.js` 的 `FIT_SPAN_BLOCKS`）。出生点 = 当前维度 `icon === 'spawn'` 的路径点（其次 id 叫 `spawn`/`wp`），
  找不到就回退世界原点 (0,0)。真正的整图适配（最小缩放）仍可通过一路滚轮缩小到达（`minScaleFit` 兜底）。
- URL 深链 `#dim=<id>&x=<世界X>&z=<世界Z>&s=<缩放>` 优先于默认视野；`#dim=<id>&wp=<路径点id>` 会聚焦该路径点。
- 想调整"初始看多大一片"：在 `config.json` 里设 `ui.defaultSpanBlocks`（64~16384）。

### 5.z 滚轮 / 指针事件的忽略范围

- **滚轮**：只有 `.marker-popup`、`.zoom-panel`、`.coord-readout`、`.scale-bar` 这些自身可能要滚动的 UI 会吞掉滚轮；
  **鼠标停在路径点标记（`.marker` / `.marker-pin` / `.marker-label`）上时滚轮仍然缩放地图**（锚点为光标位置）。
- **指针**：在路径点标记（`.marker` 及其内部元素）上按下也会开始跟踪——
  移动超过 4px 阈值即为拖拽平移（松手不选中标记）；未越阈值则视为点击，原地松手 = 选中并打开弹窗。
  弹窗 `.marker-popup`、缩放面板等其他 UI 上的按下仍完全忽略（不拖拽、不触发地图点击）。

### 5.w 站内校准向导已移除（2026-11-05）

- 顶栏 `#btn-calibrate`、提示条里的 `#notice-calibrate`、`#calibrator` 弹窗、`assets/js/calibrate.js` 全部删除；
  校准统一在 **SteveServerMapConfig** 配置工具里做，写完 `config.json` 发布即可。
- 同时移除「本地校准覆盖」（`localStorage['steveservermap.calibration.v1']`）：画幅现在**只**来自 `config.json`，
  不会再出现"某台电脑上位置和别人的不一样"。旧的存储键不再读取（保留也不会生效）。
- 2026-11-10：`window.__mapApp.applyCalibration()` 调试 API 与 `#calibration-notice` 未校准横幅
  一并移除（画幅固定后站内不再需要校准通道）；保留 `resolveCalibration()`。
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
- **两道 active 守卫（2026-11-06 修）**：`handleMeasureClick()` 第一行 `if (!state.measureActive) return false;`，
  `MeasureLayer.addPoint()` 第一行 `if (!this.active) return null;`。
  修复前未开测距时点地图也会悄悄加点（且吞掉了路径点选中）；现在非测量模式下的左键点击完全走普通地图交互。
  调试接口 `window.__mapApp.addMeasurePoint()` 会在加点前自动 `setMeasureActive(true)`，保持脚本兼容。
- **退出语义（2026-11-06 确认）**：点「退出」= 只收起读数面板，测量点/折线保留在地图上；
  再点顶栏「测距」恢复面板继续编辑。`setMeasureActive()` 与 `updateMeasureReadout()` 统一用
  `panel.hidden = !state.measureActive`，不再看「有没有测量点」。
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
      "image": "主世界.png",              // 单张模式用；配了 tiles 时只作兜底
      "tiles": { "manifest": "tiles/overworld/manifest.json" },   // 可选，见 §10
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

- 规范化后的维度对象：`{ id, name, image, tiles, calibration, groups, waypoints, order }`
  - `tiles` 为 `null`（未配置）或 `{ manifest: "tiles/overworld/manifest.json" }`（也接受直接写字符串）。
- 规范化后的路径点：`{ id, name, x, y, z, group, icon, color, label, description, url }`
  - `y` 可省略（null）；`group` 缺省或指向不存在的分组时静默落到 `default` 分组（不产生配置警告）；`icon` 缺省 `pin`；`color` 缺省取分组色。
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
- `.app` 为 CSS Grid：`grid-template-rows: auto 1fr`，顶栏 / 主体（页脚已于 2026-11-10 移除）。
- 必须包含 `[hidden] { display: none !important; }`
- 深色主题（背景接近 `#0f1210`），强调色 Minecraft 草绿 `#5ad26f`。
- 响应式断点：`max-width: 860px` 走抽屉模式，`#sidebar-backdrop` 显示。
- 窄屏顶栏（2026-11-13）：`≤620px` 隐藏 `.brand`，`.dimension-switch` 不限宽、完整显示；
  `≤420px` 用 `.dimension-switch > .dim-btn` 收紧按钮内边距。品牌隐藏后按钮全体只留图标，
  皮肤 / 换算的位置由 `app.js` 决定（见 §5.v），桌面端规则不变。

---

## 8. 验收标准（qa-dev 会跑）

1. `python -m http.server` 起静态服务后，页面无 console error，`#map-image` 有 `naturalWidth > 0`。
2. 三个维度都能切换；缺图维度显示 `#map-state` 提示而不是崩溃。
3. 路径点数量 = config 中该维度数量，且位置随缩放/平移正确跟随（误差 < 1px）。
4. 侧栏点击路径点 → 视图居中该点；分组开关生效。
6. 窄屏（390×844）下侧栏可开合，地图可用；360~620px 三个维度按钮完整可点；
   皮肤 / 换算收进侧栏底脚，从抽屉启动后面板打开且抽屉收起；恢复桌面宽度后按钮回到顶栏原顺序。

## 9. 交互体检修正（2026-11-05）

1. **切换维度**（`applyDimension`）：
   - 切换前用 `rememberDimensionView(oldId)` 记住当前视角（`state.dimensionView`），切回来时 `restoreDimensionView()` 恢复
     （画幅变了就放弃恢复，退回默认视野）；首次进入某维度仍用「聚焦世界原点 + 1024 方块」。
   - 切维度会清空搜索框（`sidebar.clearSearch()`）与测量点，并 **toast 说明「已清空 N 个测量点」**。
2. **Esc 优先级（最上层优先）**：路径点详情卡（按 `.marker-popup` 的 `hidden` 判断）> 测距模式 > 取消选中。
3. **测距文案**：`Enter` 与 `Esc` 都是「结束/退出，测量点保留」，提示里写清楚。
4. **测距中看详情**：`Shift + 点路径点` 打开该点详情卡（不新增测量点、不退出测距）；吸附半径按屏幕 24px 折算。
5. **深链 `#dim=…&wp=…`**：现在会 `markers.setSelected(wp)` + `sidebar.setActiveWaypoint(wp)`，别人点链接能直接看到卡片。
6. **地址栏 hash 只在用户操作后写**：`state.hashArmed` 由滚轮/拖拽/缩放按钮/「整图」「原点」/列表点击定位 武装；
   初始载入不写（避免复制地址栏误分享视角）。「分享」按钮仍会强制同步一次。
7. **快捷键首次提示**：第一次按 `G` / `L` 时 toast 说明（`localStorage['ssm.hints.v1']` 只提示一次）。
8. **「展开」按钮**：列表头新增 `#btn-expand-all` → `sidebar.expandAllGroups()`（折叠乱了时的逃生口）。


---

## 10. 瓦片底图（`assets/js/tiles.js`，2026-11-06）

与「单张 PNG + calibration」并列的第二种底图。维度里写了 `tiles` 就走瓦片，没写就**一行不变**地走原来的单张图片逻辑。
当前三个维度（主世界 / 下界 / 末地）都配了 `tiles`，单张 PNG 仅作兜底；下界 / 末地由配置仓库的
`tools/png-to-tiles.mjs` 从整图直切生成（主世界仍走 Xaero 导出图管线）。

### 10.1 配置与 manifest

```jsonc
"tiles": { "manifest": "tiles/overworld/manifest.json" }   // 也接受 "tiles": "tiles/overworld/manifest.json"
```

瓦片 URL 由 manifest 位置推导：`<manifest 所在目录>/tiles/<level>/<x>_<y>.png`。
manifest 字段（`parseManifest` 负责校验，结构不对 → 返回 null → 回退单张图片）：

| 字段 | 含义 |
| --- | --- |
| `tileSize` | 瓦片边长（px） |
| `levels[].level` | 层级号；level 0 的 1 像素 = 1 方块，层级 L 的 1 像素 = 2^L 方块 |
| `levels[].blocksPerPixel` | 该层 1 像素覆盖的方块数 |
| `levels[].minX/maxX/minZ/maxZ` | 该层**实际存在**的瓦片列/行范围（闭区间） |
| `levels[].originBlockX/originBlockZ` | 该层 (0,0) 瓦片左上角的世界坐标 |
| `worldBlockRange` | 整幅地图的世界范围；`imageWidth = xMax-xMin`、`imageHeight = zMax-zMin`（1 像素 = 1 方块） |

自检：最细层级的栅格尺寸（`cols × tileSize × blocksPerPixel`）必须等于 `worldBlockRange` 的跨度（容差 1 个像素），
否则整份 manifest 判为不可用（否则瓦片与路径点会整体错位）。

### 10.2 与现有模块的接线

- `app.js`：`applyDimension` 先试 `loadTileset(dim.tiles.manifest)`；
  成功 → `view.setRasterBase({width: tileset.imageWidth, height: tileset.imageHeight})`，
  然后把底图切到 `#map-canvas`（`body[data-base="tiles"]`）；
  失败（或维度没配 tiles）→ 走原来的 `view.setImage(dim.image)`。
- **投影**：`state.calibration = { xMin, xMax, zMin, zMax, flipZ:false, calibrated:true, source:'tiles' }`
  （直接来自 manifest），再交给 `createProjection`。`coords.js` 无需改动。
- **canvas 语义（外扩窗口渲染 + 平移冻结）**：canvas 的 CSS 盒 = 「光栅化窗口」在图片像素空间里的矩形 ——
  视口每边外扩 25%（`left/top = -tx/scale - viewWidth/scale × 0.25`、
  `width/height = 1.5 × viewWidth/scale`，由 `TileLayer.draw()` 内联设置），
  靠 `#stage` 的 transform 映射回屏幕视口；`#stage` 的尺寸仍是整幅图片尺寸
  （由 `MapView._applyImageSize` 设置，只摆 `<img>`，不碰瓦片 canvas），
  `markers / measure / sidebar / popup` 完全不用改。canvas 的**位图**尺寸 = 窗口 × scale × dpr
  = 1.5×视口 × dpr，与层级无关 —— 瓦片按需放大/缩小绘制，大图永远不会被整图降采样。
  宿主必须给瓦片 canvas 绝对定位（`.map-canvas { position: absolute; }`）。
- `handleViewChange` 的 rAF 里调 `tileLayer.update(viewState)`；**必须用当场读到的 `getViewState()`**，
  不能用 emit 时捕获的那份（同一帧可能有多次变化，过期状态会贴错位置）。

### 10.3 渲染规则

1. **层级选择**：`levelForScale(scale, dpr = 1)` 取 `|log2(blocksPerPixel × scale × dpr)|` 最小的层级，
   也就是「1 瓦片像素 ≈ 1 **设备**像素」；同分时取更细的一层。
   `dpr` 缺省为 1，站点侧行为与旧版完全一致；配置与预览工具会传 `devicePixelRatio`，
   高分屏自动选更细的层级。
2. **只画窗口**：窗口 = 视口每边外扩 25%（图片像素）。把窗口四角换算成图片像素 → 除以 `2^L` →
   得到层级栅格矩形 → 只遍历相交的瓦片。每次光栅化先清屏再贴当前窗口的瓦片
   （半透明像素不能反复叠加，层级切换也不能留下旧内容）。
   瓦片目标尺寸 = `tileSize × 2^L × scale × dpr × backingFactor`，位置按
   `((originOffset + col × tileSize) × 2^L - 窗口原点) × scale × dpr × backingFactor` 计算。
3. **平移冻结**：视口仍落在上次窗口内且 scale / viewWidth / viewHeight / dpr 都没变时
   `draw()` 直接返回 —— 位图与 CSS 盒全部冻结，画面移动完全由 `#stage` 的 transform 平移完成
   （纯合成、无重采样、亚像素连续）。视口滑出窗口（或缩放 / 尺寸 / dpr 变化 /
   新瓦片解码完成）才重画一次并换新窗口；**新瓦片解码完成必须强制重画**，否则内容永远出不来。
   静止与拖拽同一条路径 —— 进出交互零重画零变化（没有「进入交互换窗口」那一帧的画面微跳）。
4. **像素锐利**：`canvasPxPerTilePx = 2^L × scale × dpr × backingFactor >= 1`（放大）时
   `ctx.imageSmoothingEnabled = false` 并给 canvas 加 `image-rendering: pixelated`；缩小时才允许插值。
5. **404 静默**：瓦片缺失是正常的（全透明瓦片不导出），`img.onerror` 只记进负缓存，不打印、不重试。
6. **缓存**：已解码图片 `Map<key, HTMLImageElement>`，LRU 上限 `MAX_CACHED_TILES = 400`（约 100 MB）；
   缺失 key 单独放在 `Set`（上限 `MAX_MISSING_TILES = 4096`），避免反复请求。
7. **位图上限**：`MAX_CANVAS_PIXELS = 24_000_000`，作用于「1.5×视口 × dpr」而不是整幅地图。
   4K 屏幕 dpr=1 约 1250 万像素，远在上限内；只有超高分屏（如 4K × dpr 2）才会触发
   等比降采样兜底（`stats.backingFactor < 1`）。

### 10.4 调试接口与测试

```js
window.__mapApp.tiles()      // -> { level, blocksPerPixel, scale, canvasWidth/Height, requests,
                             //      loaded, missing, cache, maxTiles, visibleTiles, drawn, ... }
window.__mapApp.tileLayer    // TileLayer 实例（只读排障用）
window.__mapApp.tileset      // Tileset 实例（toJSON() 得到纯数据）
document.body.dataset.base   // 'tiles' | 'image' | 'empty'
```

- `tests/smoke.mjs` 的 `tiles.render` / `tiles.levels` 两项覆盖「canvas 出图 + 世界范围来自 manifest」
  与「层级随缩放切换 + 视口裁剪」。
- 命中 `#map-image` 的旧断言已改为「当前底图元素」`#map-image:not([hidden]), #map-canvas:not([hidden])`。
- 缺瓦片的 404 由 `createDiagnostics(page, { ignore })` 放行（`/tiles/<dim>/tiles/<l>/<x>_<y>.png` 的 404 不算错误），
  否则 `run.console` 会被正常的缺瓦片刷满。
- **限制**：瓦片维度的世界范围由 manifest 决定，与 `config.json` 里该维度的 `calibration` 无关
  （后者只作说明）。

### 10.5 版本参数与更新徽标（2026-11-06）

- **`?v=` 版本参数**：`Tileset.urlFor()` 拼 `?v=<generatedAt 净化串>`；瓦片重新生成后 URL 变化，
  自动绕开 GitHub Pages 静态资源的 HTTP 缓存（默认 `max-age=600`）。缓存键（LRU）同样带版本，
  同一 baseUrl 换 manifest 后旧解码不会命中。
- **`generatedAt` 透传**：`Tileset.generatedAt` 保存 manifest 的**原始**字符串（不净化），`toJSON()` 一并输出；
  manifest 缺失时为 `''`。
- **更新徽标**：`formatGeneratedAt(iso, now)` 导出纯函数 —— `瓦片更新于 <本地日期>（今天/昨天/N 天前）`。
  两个日界都取**本地午夜**，`Math.round` 吸收夏令时造成的 23/25 小时天（UTC+8 不会把昨天算成今天）。
  侧栏底脚的 `#tiles-time`（`updateTilesTime`，左下角视图按钮上侧、无边框纯文本）在
  `state.tileset.generatedAt` 存在时显示该徽标（2026-11-10 起：页脚 → 顶栏 → 最终定在侧栏底脚）。
- 回归：`tests/tiles-regressions.test.mjs` 覆盖 generatedAt 透传 / 版本净化 / 徽标文案（今天/昨天/N 天前/非法输入）。

## 11. 坐标换算（`assets/js/converter.js`，2026-11-06）

纯函数 + 面板组件的组合，与地图渲染无关：

```js
export const NETHER_SCALE = 8;   // 1 下界格 = 8 主世界格
export function overworldToNether(x, z) // -> { x: Math.round(x/8), z: Math.round(z/8) } | null（输入非法）
export function netherToOverworld(x, z) // -> { x: x*8, z: z*8 } | null
export class ConverterPanel {           // 面板：方向切换 / 复制 / 定位 / Esc 关闭，坐标输入接受数字字符串
  constructor(rootEl, { getCenter, onLocate, onCopy })
  setOpen(open, { prefill, direction }) // prefill = 视野中心世界坐标 {x,z}；预填成功时方向跟随 direction
  isOpen() / convert() / destroy()
}
```

- **取整语义**：`Math.round`，负数一半向零取整（`-12.5 → -12`），与 Minecraft（Java）实际传送一致；
  `-0` 保留符号（`-0.5 → -0`），显示层按 `0` 处理即可。
- **接线**：`app.js` 的 `initConverter()` 挂到 `#btn-convert`；打开时用 `worldAtViewCenter()` 预填
  （投影 → `imageToWorld` → 取整），「定位」走 `gotoWorld`。换维度不影响换算本身（只换坐标空间）。
- **方向自适应（2026-11-06 补）**：预填值取自当前维度的视野中心，方向必须与之一致——
  下界维度打开时自动切到 `n2ow`（×8），主世界维度为 `ow2n`（÷8）；
  其他维度（如末地）不预填。方向只在「预填实际生效」时切换，用户已输入的值不被重新解释。
- **画幅守卫（2026-11-06 补）**：「定位」前检查目标是否在当前地图画幅（`projection.xMin..xMax / zMin..zMax`）内；
  画幅外（如 ×8 结果超出主世界地图）不再静默跳到空白区，改为 toast「目标坐标 … 不在当前地图画幅内，未定位」。
- 面板在 `#viewport` 内右下角（与测距读数面板同款样式，窄屏 `≤860px` 改铺底）。
- 回归：`tests/converter.test.mjs`（÷8/×8/往返/字符串输入/非法输入 6 例）；
  `tests/smoke.mjs` §6e 三项（双向换算 + 画幅内定位、下界预填自动 ×8、画幅外定位提示且视野不动）。
