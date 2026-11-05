# 质量与验证（QA）

本文件描述 `tests/` 下的自动化检查：如何运行、覆盖了哪些验收项、最近一次结果和已知限制。

## 交互体检修正（2026-11-05）

按"反人类交互"体检结果修的站点侧 8 处，逐条实测（本地无头 Edge）：

- 初次加载地址栏保持干净（`hash=""`），点「放大」按钮后才写入 `#dim=…&x=…&z=…&s=…` ✓
- 切维度记忆视角：主世界 `scale 3.2 / tx -5000 / ty -9000` → 切下界 → 切回 **原样恢复** ✓
- 切维度清空搜索框并恢复列表（15 个标记回来）✓
- 切维度清空测量点并 toast「切换维度已清空 2 个测量点」✓
- Esc 最上层优先：详情卡开着 + 测距模式 → 第一次 Esc 只关卡片、测距仍在 ✓
- 深链 `#dim=overworld&wp=wp-2` → 打开「四核刷铁机」卡片并选中 ✓
- 「展开」按钮展开所有分组（折叠 1 个 → 0 个，可见 15 项）✓
- 快捷键首次提示 / `smoke measure.interact` 的 Esc 断言改为"最多按两次" ✓

⚠️ 仍存在的 5 项失败是数据耦合项（`pos.zoom`/`pos.drag`/`cal.crop-change`/`sidebar.search`/`deep-link`），与本次无关。

## 缩放下限收紧（2026-11-05）

- 现象：滚轮一直缩小，地图会缩成看不清的小点（原 `minScale: 0.02`，3584px 的图只有 72px 宽）。
- 修复：`MapView` 新增 `minScaleFit`（站点已开启），最小缩放 = **整图适配比例**（`_effectiveMinScale()`），
  视口变化时自动重新钳制；「整图」按钮、深链 `s` 值都落在同一比例上。
- 验证（本地）：25 次滚轮缩小后 `scale 0.1313 = fit 0.1313`（不再是 0.02）；「整图」结果一致；
  深链 `s=0.01` 被钳制到 0.1313；窗口缩到 900×700 后仍不低于新下限 0.1102。
- 回归：其余检查与改动前一致（仍是那 5 项数据耦合失败）。

## 密集路径点去重叠（2026-11-05）

- 现象：路径点密集时，图标与标签互相遮挡，被盖住的点既看不清也点不到。
- 方案（`markers._layoutDenseMarkers`）：
  - z 序按屏幕 y 排列（越靠下越上），选中 / 悬停置顶；
  - 屏幕距离 ≤ 12px 归为一堆，堆顶显示 `×N` 徽标；**连点同一个标记在同堆点之间轮换选中**；
  - 标签避让：同堆只保留堆顶标签，其余与已放标签 / 别人图标矩形相交时加 `.is-label-collided` 隐藏（悬停、选中仍强制显示）。
- smoke 新增 `markers.dense`：注入 4 个点（3 个几乎重合 + 1 个远处）→ 断言 1 个 `×3` 徽标、2 个标签被避让、堆顶标签可见、连点轮换到 3 个不同点、选中后标签强制可见，最后恢复真实数据 ✓
- 回归：其余检查与改动前一致（仍是那 5 项数据耦合失败）。

## 测距面板点击穿透（2026-11-05）

- 现象：测距模式下点左下角读数面板（撤销 / 清空 / 退出）时，点击会同时落到地图上，多出一个测量点。
- 原因：`#measure-readout` 是 `#viewport` 的子元素，但没进 viewer 的 `IGNORE_SELECTOR`，事件冒泡到 viewport 后按"点地图"处理。
- 修复：把 `.measure-readout` 加入 `assets/js/viewer.js` 的 `IGNORE_SELECTOR`（点击与滚轮都不再穿透；面板自己滚列表也不会缩放地图）。
- 回归：smoke 新增 `measure.panel` —— 面板标题点击不加点、点「撤销」真的撤销、点「清空」真的清空、面板上滚轮不缩放、地图空白处仍可加点（全部通过）。

## 测距工具（2026-11-05）

- 新增 `assets/js/measure.js`（MeasureLayer）：两点距离、多段折线（每段独立标注）、总长、虚线预览、路径点吸附。
- 站点 UI：顶栏 `#btn-measure`、左下角读数面板 `#measure-readout`（总长 / 逐段 / 撤销 / 清空 / 退出）、
  SVG 图层 `.measure-layer`；快捷键 `Backspace`（撤销）、`Enter`/`Esc`（退出）。
- 关键设计：测量点存**世界坐标**，视图变化只重算屏幕坐标 → 缩放/平移后距离不变；吸附在图片像素空间判定（`14/scale`）。
- smoke 新增 3 项：
  - `measure.two`：`(0,0)→(300,400)` = **500 格**，段标注 + 总长标注 + 读数面板齐备 ✓
  - `measure.polyline`：三点两段 `100 / 240`，合计 **340 格**，折线 3 个顶点、面板有「合计」行 ✓
  - `measure.interact`：真实点击地图加点并**吸附到路径点 `wp`**、撤销/清空、`Esc` 退出 ✓
- 回归：其余检查结果与改动前一致（仍是那 5 项数据耦合失败：`pos.zoom`/`pos.drag`/`cal.crop-change`/`sidebar.search`/`deep-link`）。

## 站内校准向导移除（2026-11-05）

- 移除：顶栏「校准」按钮、提示条「去校准」链接、`#calibrator` 弹窗、`assets/js/calibrate.js`（41KB）、
  CSS 07 段（约 11.7KB），以及 `localStorage` 本地校准覆盖。
- smoke 同步删除：`cal.open` / `cal.manual` / `cal.close` / `cal.persist` / `cal.pick` 五项及其辅助函数
  （`openCalibratorPanel`、`CAL_JSON`、选择器映射里的 calibrator/calJson）。
  保留 `cal.crop-change`（走 `__mapApp.applyCalibration` API，模拟画幅变化后标记对回）。
- 验证（本地无头 Edge）：`#btn-calibrate` / `#calibrator` / `#notice-calibrate` 均不存在、`__mapApp.openCalibration` 已消失、
  `applyCalibration` 仍可用、15 个标记正常渲染、无 console error、无 404（不再请求 calibrate.js）。
- ⚠️ 现存失败仍是那 5 项数据耦合项（`pos.zoom` / `pos.drag` / `cal.crop-change` / `sidebar.search` / `deep-link`），与本次无关。

## 「分组」面板移除（2026-11-05）

- 侧栏新增可折叠分组头之后，原「分组」面板（`#panel-groups` / `#group-list`）变成纯重复：颜色、名称、数量、眼睛开关在分组头上都有。
- 处理：删除该面板；「全显 / 全隐」(`#btn-all-visible` / `#btn-all-hidden`) 移到「列表」面板标题栏；
  `sidebar.js` 的 `_renderGroups()` 在 `#group-list` 不存在时直接返回，其它逻辑共用。
- 测试同步：
  - `data.config` 改为校验**分组头**（名称 / 数量 / 眼睛按钮 / aria-expanded），不再依赖 `#group-list`；
  - `group.toggle` 改为点列表分组头上的眼睛按钮（折叠状态下会先展开）。
- 验证：全隐/全显（4 个分组头全部 `is-off`、眼睛 `aria-pressed=false`、标记隐藏）✓、折叠仍工作 ✓、`data.config` ✓、`group.toggle` ✓，
  无 console error。剩余 5 项 `pos.zoom`/`pos.drag`/`cal.crop-change`/`sidebar.search`/`deep-link` 仍为改动前就存在的数据耦合失败。

## 侧栏分组折叠（2026-11-05）

- 新能力：站点 `#waypoint-list` 按分组分区渲染（`section.wp-group`），分组头可折叠/展开；
  眼睛按钮与 `#group-list` 分组面板联动；折叠状态按「维度::分组」持久化到 `localStorage`；搜索时强制展开。
- 验证（无头 Edge，本地 1440×900）：分组分区渲染 ✓、点头部折叠（节点保留、视觉隐藏、aria-expanded=false）✓、
  再点展开 ✓、刷新后保持 ✓、搜索强制展开 ✓、眼睛按钮与分组面板联动 ✓（6/6）。
- `data.config` 检查同步改为「分组分区 + 组内顺序」校验（原为全局扁平顺序，与分组渲染冲突）。
- ⚠️ 现存失败（**改动前就存在**，与本次无关）：`pos.zoom`、`pos.drag`、`cal.crop-change`、`sidebar.search`、`deep-link`。
  它们依赖示例配置里的 `castle` / `农场` 名称，以及「路径点分散在全图」的分布；站点 `config.json` 现在是用户自己的
  15 个点（聚集在一小片区域，下界/末地为 0 个），所以断言不成立。修复方式：这几个用例改成从 `config.json`
  动态取样本（名称、分组、坐标），不要写死示例数据。



测试**零 npm 依赖**：只使用 Node 24 内置的 `WebSocket` / `fetch` / `node:http` / `node:child_process` / `node:fs`，
直接驱动 Microsoft Edge（或 Chrome）的 DevTools 协议。

```
tests/
  headless.mjs        可复用的无头浏览器 / CDP 驱动库（静态服务器、浏览器生命周期、Page 封装、诊断收集、报告器）
  smoke.mjs           端到端验收：逐条覆盖 docs/CONTRACT.md §8，并补充配置驱动 / 重新校准 / 本地覆盖 / 窄屏回归
  static-checks.mjs   无需浏览器的静态检查：文件、引用、config、import 解析、CSS 契约
  coords.test.mjs     （viewer-dev 维护）coords.js 纯函数单测，node --test 运行
  artifacts/          运行产物：成功截图、失败截图 + DOM dump、report.json（默认不入库）
```

---

## 1. 快速开始

```powershell
# 1) 静态检查（毫秒级，不启动浏览器）
node tests/static-checks.mjs

# 2) 端到端验收（自起静态服务器 + 无头 Edge，约 15 秒）
node tests/smoke.mjs

# 3) coords 纯函数单测（viewer-dev 维护）
node --test tests/coords.test.mjs
```

环境要求：

- Node.js **24+**（需要全局 `WebSocket`、`fetch`；本机实测 v24.18.0）。
- Microsoft Edge（默认 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）。
  也可用 `--browser=<路径>` 或环境变量 `EDGE_PATH` 指定 Chrome/Edge。
- Windows 下无需 `pnpm install`，也没有任何第三方包。

退出码：全部通过 `0`，有失败项 / 运行中断 `1`。

### smoke.mjs 选项

| 参数 | 说明 |
| --- | --- |
| `--url=<地址>` | 指向已启动的静态服务（默认自起服务器，随机空闲端口）。例如 `python -m http.server 8791` 后 `--url=http://127.0.0.1:8791/index.html` |
| `--browser=<路径>` | 指定浏览器可执行文件 |
| `--headed` | 有头模式，便于人工观察 |
| `--keep` | 保留临时浏览器 profile（默认删除） |
| `--debug` | 浏览器 stderr 直接输出（排查启动问题） |
| `--timeout=<倍数>` | 放大所有等待超时（慢机器 / CI 用 `--timeout=2`） |

产物写入 `tests/artifacts/`：

- `ok-desktop.png` / `ok-narrow.png`：**只有全部检查通过时**才保存。
- `error-<checkId>.png`：失败的检查项各存一张截图。
- `report.json`：机器可读报告，含每条检查的耗时、错误文案，以及失败时的相关 DOM 片段（`failures[].artifacts.dom`）。
- `static-checks.json`：静态检查报告。

每次运行会先清理上一次的 `ok-*` / `error-*` / `report.json`，避免旧产物误导。

### 进程与临时目录保证

- 静态服务器监听 `127.0.0.1` 的**随机**端口，运行结束即关闭。
- 浏览器 profile 用 `fs.mkdtemp` 生成唯一临时目录；结束顺序为
  `Browser.close`（优雅退出）→ `taskkill /T /F`（杀进程树）→ 按唯一 `--user-data-dir` 兜底清理 → 删除 profile。
- 连续重复运行不会残留 `msedge --headless` 进程或 `%TEMP%\ssm-qa-*` 目录（本机实测 0 残留）。

---

## 2. headless.mjs 提供的 API

| 导出 | 作用 |
| --- | --- |
| `startStaticServer({ root, host, quiet })` | 最小静态服务器：正确 MIME（`.html/.js/.css/.png/.json`…）、URL 解码中文文件名、`Cache-Control: no-store`、防目录穿越、`favicon.ico` 静默 204 |
| `launchBrowser({ executablePath, headless, port, userDataDir, keepProfile })` | 启动 Edge/Chrome，轮询 `/json/version` 直到 DevTools 就绪，返回 `{ wsUrl, browser, close(), attach(conn) }` |
| `CDP.connect(wsUrl)` | 浏览器级 WebSocket：自增 `id` ↔ Promise 映射、事件订阅、`sessionId`（flatten 模式）透传 |
| `Page.open(conn)` + `Page` 类 | 页面级封装：`navigate`、`evaluate`、`evalFn(fn, ...args)`、`waitFor`、`settle`（两帧 rAF）、`click`、`clickSelector`、`wheel`、`drag`、`screenshot`、`setViewport`、`addInitScript` |
| `createDiagnostics(page)` | 收集 `Runtime.consoleAPICalled`（error/assert）、`Runtime.exceptionThrown`、`Log.entryAdded`（error）、`Network.responseReceived`（HTTP ≥ 400） |
| `createReporter(name)` | ✓/✗/⊘/! 报告器，统计耗时与通过/失败/跳过/警告，`toJSON()` 写报告 |
| `waitUntil` / `sleep` / `parseArgs` / `formatDuration` / `truncate` | 通用工具 |

页面侧另外注入 `window.__qa`（`error` / `unhandledrejection` 捕获），用于补齐 CDP 事件抓不到的未处理 Promise 拒绝。

---

## 3. 检查项清单

### static-checks.mjs（30 项，无需浏览器）

| 组 | 内容 |
| --- | --- |
| 文件骨架 | `index.html` / `config*.json` / `assets/js/*.js`（7 个）/ `style.css` 全部存在 |
| 基底图 | 三个维度的 PNG 存在、PNG 头合法、尺寸可解析（overworld 3584×5120、nether 2048×2048、the_end 2048×2048） |
| index.html | 本地 `src`/`href` 全部可解析；无 CDN/远程资源；`<script type="module" src="assets/js/app.js">`；契约要求的 29 个 DOM id 齐全 |
| config.json | 合法 JSON；`version/site/defaultDimension/ui`；3 个维度 id；路径点 id/坐标/分组引用合法；calibration 四边界与布尔标志；每方块像素数比例合理；`config.schema.json` 可解析且描述 dimensions |
| ES Module | 所有相对 `import/export ... from` 与动态 `import()` 都能解析；无裸模块名；无 `node:` 内置模块；契约 §2~§6 要求的导出名齐全（`createProjection`… / `MapView` / `MarkerLayer`+`ICONS` / `Sidebar`）；`app.js` 不是空壳 |
| CSS 契约 §8 | 12 个 CSS 变量 + `--sidebar-w: 320px`；`[hidden]{display:none!important}`；`body[data-sidebar="collapsed"]`；`.app` 的 `grid-template-rows: auto 1fr auto`；`max-width: 860px` 断点；`.map-viewport/.map-stage/.map-overlay`；标记层类名；无 `@import` 远程样式 |

### smoke.mjs（对应 CONTRACT §8 + 交付核心卖点）

| id | 断言 |
| --- | --- |
| `boot.navigate` | 页面导航到 `index.html` 并完成 |
| `boot.ui` | `#dimension-switch` 渲染 3 个维度按钮（入口模块 404/语法错误时立即失败并给出资源 URL） |
| `boot.image` | `#map-image` `complete===true` 且 `naturalWidth>0`（失败时打印 src/naturalWidth/display 实际值） |
| `boot.console` | 加载阶段无 console error / 未捕获异常 / 未处理 Promise 拒绝 / HTTP ≥ 400 |
| `ui.dimensions` | 三个维度名称正确，默认维度 == `config.defaultDimension` |
| `dim.switch` | 下界 → 末地 → 主世界：基底图 src、`naturalWidth`、`body[data-dimension]`、标记数量全部正确 |
| `counts.markers` | `#overlay .marker` 数量 == config 路径点数，`data-id` 集合一致；`#waypoint-list` 列表项数量一致；`#waypoint-empty` 隐藏 |
| `pos.initial` | 每个可见标记的锚点与「config.calibration + 图片实际显示区域」手算坐标偏差 **< 1.5px** |
| `pos.zoom` | `Input.dispatchMouseEvent` 滚轮（落点必须命中 `#map-image`）后 `view.getViewState().scale` 增大 ≥ 1.15 倍，图片矩形同步放大；标记偏差仍 < 1.5px，且每个标记位移与图片位移之差 < 1.5px |
| `pos.drag` | CDP 拖拽平移后图片位移 > 10px，标记偏差仍 < 1.5px，位移与图片同步 |
| `view.reset` | 「整图」按钮恢复视图 |
| `data.config` | 列表项 id/名称/顺序与 `config.json` 逐条一致；分组行数量、id、名称与 config 一致 |
| `cal.crop-change` | 用 `window.__mapApp.applyCalibration()` 应用「画幅放大 1.5 倍 + 平移」的新 calibration：已知标记确实移动（> 5px），且 10 个标记与**新画幅手算**坐标偏差 < 1.5px（证明「画幅变了、重新校准后路径点自动对回」），随后恢复原画幅 |
| `sidebar.search` | 搜索「农场」列表项 10 → 2，清空后恢复 10；有结果时 `#waypoint-empty` 隐藏 |
| `sidebar.empty` | 搜索无结果时列表 0 项且 `#waypoint-empty` 可见 |
| `sidebar.click` | 点击列表项后该标记锚点距视口中心 < 40px |
| `group.toggle` | 分组眼睛按钮隐藏后该组可见标记 2 → 0，再点恢复 2 |
| `ui.toggles` | 网格：点一次 `aria-pressed=true` 且 `.map-grid` `opacity=1`，再点回 `false`/0（一次点击只切换一次，验证无重复绑定）；标签：连点三次 `body[data-labels]` 依次 hover → always → never → hover；全隐：可见标记 0 且 `#waypoint-count=0/10`，全显恢复 10/10 |
| `deep-link` | `focusWaypoint('castle')` 后 `location.hash` 同步出 `dim/x/z/s`（x/z 与 castle 相差 < 5 方块）；用该 hash 打开**新标签页**：`body[data-dimension]` 正确、视图中心世界坐标与 hash 相差 < 5 方块、无 console error |
| `cal.open` | `#btn-calibrate` 打开 `#calibrator`，面板尺寸 > 0 |
| `cal.manual` | 「直接输入画幅」页签填入四个边界值后，`#cal-json` 是可 `JSON.parse` 的对象，四个字段与输入一致（±0.5） |
| `cal.close` | 取消关闭后 `#calibrator` 隐藏，且向导期间无新增 console error |
| `cal.persist` | 应用校准后 `#footer-status` 显示「本地校准」；`localStorage['steveservermap.calibration.v1']` 写入且数值正确；刷新页面后仍生效且标记位置正确；点击 `#footer-status` 清除成功、localStorage 同步删除 |
| `cal.pick` | 两点拾取端到端：进入拾取模式后 `.is-picking`（`#calibrator` + `#viewport`）与 `#cal-pick-hint` 正常，弹窗中心 `elementFromPoint` 不再命中面板（遮罩让路）；地图点击必须命中 `#map-image`；`#cal-a-px`/`#cal-b-px` 的像素与「图片显示矩形」手算一致（±1.5px）；拾取后退出拾取模式、焦点落到 `#cal-a-x`/`#cal-b-x`；填入手算世界坐标后 `#cal-json` 解出的画幅与原 calibration 相差 < 2 方块；`#cal-apply` 应用后 `state.calibration` 更新、标记与**新画幅手算**偏差 < 1.5px |
| `narrow.layout` | `Emulation.setDeviceMetricsOverride(390×844)` 下：`#viewport` 宽 ≈ `window.innerWidth`（±1）、`document.scrollingElement.scrollWidth ≤ innerWidth+1`（无横向溢出）；抽屉打开时（fixed 覆盖层）地图宽度同样 == innerWidth；收起后布局恢复 |
| `narrow.transition` | 桌面收起侧栏后把窗口缩到 390px，`#viewport` 不被压成 0（回归：曾被桌面端多列 grid 规则泄漏到移动断点压成 0px） |
| `run.console` | 全流程无 console error / 未捕获异常 / 未处理 Promise 拒绝 |
| `artifacts.screenshot` | 全部通过后恢复桌面视口并保存 `ok-desktop.png`（> 1KB） |

补充约定：

- 只在测试脚本内部起停服务器与浏览器，不修改站点源码、不执行 git 操作。
- 同一时间只跑一个 `smoke.mjs`：`tests/artifacts/.run.lock` 会阻止并行运行（避免截图 / 报告互相覆盖）。
- 失败时自动保存 `error-<id>.png` 并把 `#overlay` / `#waypoint-list` / `#group-list` / `#calibrator` / `#map-state` 等 DOM 片段写入 `report.json`。
- 所有失败文案都带「实际值 vs 期望值」，便于一次定位。

---

## 4. 最近一次结果

| 时间 | 环境 | 结果 |
| --- | --- | --- |
| 2026-11-05 02:05（Asia/Shanghai） | Node v24.18.0 / Windows x64 / Edge 155.0.4283.62 / 视口 1440×900 | **smoke 28 通过 / 0 失败 / 0 跳过 / 0 警告，22.4 s（本地服务）** |
| 同一轮 | 线上 GitHub Pages `https://steveservermap.github.io/index.html` | **smoke 28 通过 / 0 失败，26.7 s**（`--url=` 外部服务模式） |
| 同一轮 | — | **static-checks 30 通过 / 0 失败，19 ms** |
| 同一轮 | — | **coords 单测 24 通过 / 0 失败（`node --test tests/coords.test.mjs`）** |

关键数值（同一轮）：

- 主世界整图：10 个标记最大位置偏差 **0.07px**（容差 1.5px）。
- 滚轮缩放：`scale 0.1492 → 0.6298`；缩放后可见标记最大偏差 **0.02px**，位移与图片完全同步。
- 拖拽：图片位移 194px，可见标记同步（偏差 0.02px）。
- 点击侧栏「主城城堡」：标记距视口中心 **1.0px**（容差 40px）。
- 画幅变化后重新校准：新画幅 `X[-2488, 2888] Z[-3990, 3690]`，castle 位移 41px，10 个标记最大偏差 **0.06px**。
- 两点校准（`cal.pick`）：拾取 A 像素 (539, 771)、B 像素 (3045, 4349)，解出 `X[-1792.0, 1792.5] Z[-2560.0, 2560.6]`，与原画幅最大差 **0.64 方块**。
- 窄屏：窗口 390px 时侧栏收起 / 打开 / 再收起，地图宽度均为 **390 / 390 / 390px**，无横向溢出。
- URL 深链：`hash=#dim=overworld&x=420&z=180&s=0.600&wp=castle`，新标签页还原中心 **(420.0, 180.0)**，无 console error。
- 外部服务模式：`python -m http.server 8792` + `--url=http://127.0.0.1:8792/index.html` 同样 **28 通过 / 0 失败**。

历史缺陷（已修复，现有回归覆盖）：

- 窄屏 390px 时 `.body` 仍保留桌面端 `body[data-sidebar="collapsed"] .body` 的两列 grid，导致 `#viewport` 宽度被压到 0~17px；
  同时顶栏 min-content 436px 造成横向溢出。由 style-dev 修复，`narrow.layout` / `narrow.transition` 负责回归。
- 校准向导拾取模式下遮罩拦截了全部地图点击，两点校准无法完成。由 style-dev 修复（`#calibrator.is-picking` 全层透传 + 面板淡化 + 浮动提示条），
  `cal.pick` 负责回归。

### 4.2 README 一致性核对（2026-11-05，只读，未修改 README）

对 `README.md` 中的命令、目录树与反引号路径逐项核对：

- ✅ `python -m http.server 8000`：实测 `http://localhost:8000/` 返回 `index.html`（HTTP 200），`config.json` HTTP 200。
- ✅ `node --test tests/coords.test.mjs`：24 通过 / 0 失败。
- ✅ 目录树列出的 17 个文件全部存在；`serve.cmd` 存在，其 Python 分支与 README 描述一致。
- ✅ 深链示例 `#dim=overworld&x=120&z=-340&s=0.75&wp=spawn` 与实现一致（`wp` 取路径点 id）。
- ⚠️ §4.5 表格写「URL 深链 `#wp=出生点`」：实现里 `wp` 是**路径点 id**（如 `wp=spawn`），不是显示名；示例建议改成 id。
- ⚠️ README 未提到 `node tests/smoke.mjs`、`node tests/static-checks.mjs`，目录树里也没有 `docs/QA.md`；建议在「附：给开发者」补两行命令。
- ⚠️ `serve.cmd` 在找不到 python 时会回退到 `npx --yes http-server`（需要 npm/联网），与 README「纯静态、零依赖、不联网」的口径略有出入；Python 分支不受影响。
- ℹ️ `资源世界.png`、`overworld-2025.png`、`overworld.png`、`nether.png`、`end.png` 等是讲解用示例文件名，不是「现有文件」声明，无需存在。

以上 README 问题已报告 Lead（README 归 style-dev 所有，QA 不直接改）。

---

## 5. 已知限制

1. **依赖调试接口**：`pos.zoom` 的 scale 断言、`cal.crop-change`、`cal.persist` 使用 `app.js` 暴露的
   `window.__mapApp`（`view.getViewState()`、`state.calibration`、`applyCalibration`）。
   若该接口被移除：`cal.crop-change` 会直接失败并提示；`pos.zoom` 会退化为仅用图片矩形宽度断言并给出警告。
2. **只覆盖 Chromium**（Edge / Chrome）。Firefox / Safari 未验证；`Input.dispatchMouseEvent` 的滚轮/拖拽在别的浏览器内核上行为可能不同。
3. **不做视觉像素比对**：截图仅作留证；布局断言全部基于几何数值（`getBoundingClientRect`、computed style）。
4. **窄屏只做「尺寸 + 开合」验证**：`Emulation.setDeviceMetricsOverride` 不是真实触屏，双指捏合缩放、触摸滚动未覆盖。
5. **校准向导两点拾取已覆盖（`cal.pick`）**：但拾取依赖 `elementFromPoint` 必须命中 `#map-image`，如果将来 UI 上的浮层（提示条、弹窗）盖住地图中心区域，该用例需要换一个落点。
6. **搜索用例使用固定词「农场」**：依赖 `config.json` 示例数据。若示例路径点改名，需要同步更新 `sidebar.search` 的查询词（断言本身仍以 config 数据动态计算期望值）。
7. **未覆盖项**：分享按钮写剪贴板（`navigator.clipboard` 在无头环境需要权限）、键盘快捷键（`G` / `L` / 方向键）、`markers.js` 详情弹窗的排版细节。URL 深链、坐标网格、标签模式、全显/全隐已在 `deep-link` 与 `ui.toggles` 中覆盖。
8. **无 CI 集成**：目前只能在本机运行；GitHub Actions 上需要安装 Edge/Chrome 并把 `--browser` 指向可执行文件。
9. **同一时间只能跑一个 smoke**：`tests/artifacts/.run.lock` 用 pid 锁阻止并行运行（两个实例会共用 `tests/artifacts/`、互相清理截图/报告，并各起一份浏览器）。若上次异常退出留下锁，下次运行会检测到进程已不存在并自动接管。

---

## 6. 维护建议

- 新增断言统一用 `createReporter().check(id, label, fn)`，失败文案必须包含「实际值 vs 期望值」与可点击的元素/选择器线索。
- 测试只读站点文件；发现站点问题请报告 Lead，不要直接修改 `index.html` / `assets/**` / `config.json`。
- 页面里取坐标一律用 `getBoundingClientRect()`（client 坐标），CDP `Input.dispatchMouseEvent` 也使用同一坐标系。
- 滚轮 / 拖拽落点必须用 `elementFromPoint` 确认命中 `#map-image`：`.marker`、`.marker-popup`、`.zoom-panel`、`.coord-readout`、`.map-hint`、`.scale-bar`、`.map-state`、`.modal` 上的事件会被 MapView 有意忽略。
- 每次运行后如需人工看效果：打开 `tests/artifacts/ok-desktop.png`、`ok-narrow.png`；失败时看 `error-*.png` 与 `report.json`。
