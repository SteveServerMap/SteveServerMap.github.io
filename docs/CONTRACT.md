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
assets/js/calibrate.js     style-dev 拥有（校准向导）
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
图标解析 `ICONS` 表（见 §7）。详情卡片由 markers.js 生成到 `#overlay` 内的 `.marker-popup`。

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

## 6. `assets/js/calibrate.js`（style-dev）—— 校准向导

```js
export function openCalibrator({
  dimension,            // 当前维度对象（含 calibration）
  view,                 // MapView 实例（用于取像素、切换拾取模式）
  projection,           // 当前投影
  imageSize,            // {width, height}
  onPreview(calibration),   // 实时预览（临时应用，不落盘）
  onApply(calibration),     // 用户点「应用」：写入运行时并刷新
  onClose(),                // 关闭（若未应用则回滚预览）
})
```
流程：① 点「开始拾取」→ 在地图上点已知地标 A → 弹出输入 X/Z（或 Y 可选）→ 确定；
② 再点地标 B → 输入 X/Z；③ 实时显示解出的 `xMin/xMax/zMin/zMax`、每方块像素数与校验提示；
④ 提供「复制配置片段」（JSON，可直接粘进 `config.json` 的 `calibration`）、「应用」、「取消」。
另外提供「直接输入画幅」页签（手填 xMin/xMax/zMin/zMax），以及「恢复默认」。取消要回滚 `onPreview`。
窗口尺寸取 `#calibrator` 内的既有节点（见 index.html）。

---

## 7. 配置格式（`config.json`）

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

## 8. CSS 约定（style-dev 定，其他人只加类名不改 style.css）

- 全局变量：`--bg --panel --panel-2 --border --text --muted --accent --accent-2 --danger --radius --shadow`
- 侧栏展开宽度 `--sidebar-w: 320px`；`body[data-sidebar="collapsed"]` 时侧栏移出（移动端为覆盖抽屉）。
- `.app` 为 CSS Grid：`grid-template-rows: auto 1fr auto`，顶栏 / 主体 / 页脚。
- 必须包含 `[hidden] { display: none !important; }`
- 深色主题（背景接近 `#0f1210`），强调色 Minecraft 草绿 `#5ad26f`。
- 响应式断点：`max-width: 860px` 走抽屉模式，`#sidebar-backdrop` 显示。

---

## 9. 验收标准（qa-dev 会跑）

1. `python -m http.server` 起静态服务后，页面无 console error，`#map-image` 有 `naturalWidth > 0`。
2. 三个维度都能切换；缺图维度显示 `#map-state` 提示而不是崩溃。
3. 路径点数量 = config 中该维度数量，且位置随缩放/平移正确跟随（误差 < 1px）。
4. 侧栏点击路径点 → 视图居中该点；分组开关生效。
5. 校准向导能由两点反解画幅，并给出可粘贴的 JSON。
6. 窄屏（390×844）下侧栏可开合，地图可用。
