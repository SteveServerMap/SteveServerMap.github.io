# 质量与验证（QA）

本文件描述 `tests/` 下的自动化检查：如何运行、覆盖了哪些验收项、最近一次结果和已知限制。

## 手动校准残留移除（2026-11-10）

画幅校准早已统一在 **SteveServerMapConfig** 配置工具里做（站内校准向导 2026-11-05 移除），
本轮删掉站内仅存的「手动校准」痕迹：

- `assets/js/app.js`：删 `applyCalibration()` 调试 API 与 `updateCalibrationNotice()`，
  以及全部 `setCalibrationNotice` 调用与 `body[data-calibrated]` 标记；
  `window.__mapApp` 不再暴露 `applyCalibration`（`resolveCalibration` 保留，单测仍用）。
- `assets/js/sidebar.js` + `index.html` + `assets/css/style.css`：`#calibration-notice`
  「未校准」横幅整链删除（节点、`setCalibrationNotice`、`.notice` 样式）。
- `assets/js/coords.js`：删 `calibrationFromTwoPoints()`（站内已无调用方，属死代码）；
  对应单测 4 项一并移除（79 → 75）。
- `tests/smoke.mjs`：删 `cal.crop-change`（依赖 `applyCalibration` 调试 API；40 → 39 项）；
  诊断快照不再收集 `#calibration-notice`。
- `assets/js/config.js`：缺 calibration 的告警文案改为指向 SteveServerMapConfig 配置工具。
- `tests/static-checks.mjs`：契约导出清单移除 `calibrationFromTwoPoints`。
- **保留**：`calibration` 数据本身（下界/末地单图维度与瓦片回退仍靠它定位）、
  `normalizeCalibration`/`boundsFromScale`/`createProjection`/`buildProjection`、
  config.schema 的 `calibrated` 字段（历史数据字段，不再驱动 UI）。
- 回归：单测 **75/75**、`static-checks.mjs` **30/30**、`smoke.mjs` **39 通过 / 0 失败 / 0 跳过**。

## 玩家皮肤 3D 预览（2026-11-10）

- 新增顶栏「皮肤」按钮 + 右下角 `#skin-panel`：输入正版 ID 查询，或导入本地皮肤 PNG；
  canvas 3D 预览（拖拽旋转、**右键平移**、滚轮缩放），与换算面板互斥显示，Esc 关闭。
- **默认静止不旋转**；面板内五个动作按钮「走路 / 奔跑 / 静止 / 旋转 / 回正」：
  走路/奔跑/静止互斥切换 skinview3d 动画（Walking/Running/IdleAnimation），
  「旋转」为开关（`autoRotate`，速度 1.2）；左键拖拽（旋转手势）后自动停转并复位按钮，
  右键平移不打断旋转开关。「回正」先停旋转（与左键拖拽一致），再把**模型转回正面**
  （`playerWrapper.rotation.y = 0`）并恢复**首次渲染成功时的相机位姿快照**
  （position + controls.target）。
  两个关键事实（均已核实 bundle 源码）：
  1. **skinview3d 3.4.2 的 autoRotate 转的是模型（playerWrapper），不是相机**——
     渲染循环里 `this.playerWrapper.rotation.y += dt * autoRotateSpeed`。若回正只复位相机，
     模型会停在转出的角度上（用户反馈「回正后人物视图向右偏」的根因）。
  2. 不用 `controls.reset()`：其 position0 是 OrbitControls 构造时的位姿，与 skinview3d
     加载后摆好的默认视角不一致。
- 3D 查看器 = **skinview3d 3.4.2**，自托管 `assets/vendor/skinview3d.bundle.js`（UMD 自包含 three.js +
  skinview-utils，477KB，普通 `<script>` 先于 module 引入，挂全局 `window.skinview3d`）。
  项目保持零 npm 依赖 / 无构建步骤，故不用其 ESM 分发包（libs/*.js 依赖 skinview-utils）。
- `assets/js/skin.js`：纯函数（`normalizeSkinId` / `skinProfileUrl` / `skinUuidUrls` / `isSkinSize` /
  `legacyPatchRects` / `LEGACY_PATCHES` / `padLegacySkin`）+ `SkinPanel`（懒创建 SkinViewer、竞态令牌、单源 8s 超时、FileReader 导入）。
  **尺寸：64×64 / 128×128（HD）与旧版 64×32 / 128×64**，旧版自动补全为正方形：
  `legacyPatchRects(w,h)` 把 64×32 布局按 s=w/64 等比缩放（以 skinview3d 3.4.2 `model.js` 的
  UV 布局为准，每肢体 16×12 块内各面顺序均为 -x/front/+x/back），左臂/左腿基座 = 右臂/右腿
  整块复制，无需逐面翻转；肢体第二层保持透明（旧版本就无肢体第二层，左右对称最忠实）。
  **128×128 为原生渲染**：已核实 bundle 源码，`loadSkin` 接受任意正方形（或宽=高×2 的旧版），
  UV 按 64 归一化，而 HD 布局正是 64 布局的等比 2× 放大，坐标天然吻合；slim 检测也按
  `width/64` 缩放，故 128× 无需降采样。
- `assets/js/viewer.js`：`.skin-panel` 加入 `IGNORE_SELECTOR`（否则 3D 拖拽被 setPointerCapture 吞掉，
  同 `convert.real-click` 回归的由来）。`viewer.controls.enablePan = true` 打开右键平移
  （skinview3d 默认关闭 pan，mouseButtons 默认 左键旋转 / 中键缩放 / 右键平移）。
- **正版 ID 查询：名称先解析为 UUID，再按 UUID 取皮肤**。2026-11-10 实测定位「皮肤是错的」根因：
  第三方皮肤源的**名称直查会命中旧名称缓存**——minotar 同名返回的是一张 64×32 村民皮
  （旧持有者/旧缓存），而同一玩家的 UUID 返回 64×64 动漫皮；Mojang sessionserver 官方纹理
  （2026-11-09 刚换肤，slim）与两者都不同，即**所有代理源都是滞后缓存**，且 Mojang 官方接口
  （sessionserver / api.mojang.com / api.minecraftservices.com）不带 CORS，纯静态站无法直连。
  最终链（均带 CORS）：
  1. `playerdb.co/api/player/minecraft/{id}`（JSON）→ 名称→UUID（`raw_id`）+ 官方纹理直链
     `skin_texture`（textures.minecraft.net，实测带 ACAO:*，http 会改写为 https 防混合内容）；
  2. 皮肤按 UUID 依次回退：`mineatar`（`api.mineatar.io/skin/{uuid}.png`，实测 200 + ACAO:* +
     `Cache-Control: max-age=86400, stale-while-revalidate=14400`，可达源中刷新最勤）
     → `mc-heads`（缓存较勤，但本机被 Cloudflare 403 限流）→ `minotar`；
  3. 兜底：playerdb 附带的官方纹理直链（时效同 playerdb 缓存，实测滞后约 6 天）。
  **crafatar 被排除**：实测它以 HTTP 500 但有时 200 返回自己的错误占位图（一张风景图，
  64×64 合法 PNG），会被当成皮肤贴到模型上（表现为「绿衫棕裤」的假人）。
  `api.ashcon.app` 未入链：实测 429（Mojang 限流）且其 `textures.skin.url` 直链才最鲜，
  恢复后可作为最鲜源。各源均为缓存代理，换肤后可能滞后一段时间；状态行会标注实际来源（如「来源 minotar」）。
- 面板布局稳定性：状态行固定两行高度（line-clamp），查询中/结果文案长度变化时
  面板高度不变（实测打开面板 / 查询中 / 查询完成三阶段均为 655.19px）；
  五个动作按钮为分段式控件（凹槽 + 高亮药丸，`aria-pressed` 同步；「回正」为瞬时按钮无 active 态）。
- 回归：
  - `tests/skin.test.mjs` 8 项（ID 规范 / playerdb 档案地址 / UUID 多源列表与非法 UUID /
    尺寸（64 / 128 两档）/ 补全矩形表边界与 128 档等比缩放 / 无 DOM 守卫）；
  - `tests/smoke.mjs` 新增 `skin.panel`：真实点击开合与互斥、非法 ID 本地报错（离线安全，
    不发网络请求）、DataTransfer 导入页内生成的 64×64 PNG、旧版 64×32 PNG（断言
    「已补全为 64×64」）与 **128×128 HD PNG（断言状态行 128×128 且不走补全路径）**、
    3D 查看器就绪（playerObject.skin.visible）、**默认静止**
    （autoRotate=false + 静止按钮 active）、真实点击走路/奔跑/静止（动画实例更换 +
    aria-pressed 迁移）、「旋转」开关真实点击开、左键真实拖拽停转复位且不穿透地图
    （视野中心不动）、**右键真实拖拽平移相机（camera.position 变化）且地图视野不动**、
    **「回正」真实点击（旋转开启时模型已转 ≥0.05 rad，点击后模型 yaw 归零 ±0.001 且
    相机回到导入后初始位姿，误差 < 0.01）**、
    Esc 关闭复位、全程无 console error；
  - 全量：单测 **79/79**、`static-checks.mjs` **30/30**、`smoke.mjs` **40/40**（2026-11-10 UI 精简轮后）。
    当轮曾为 38/1/1：唯一失败 `ui.toggles`（全隐前可见 29/31）随后被 UI 精简轮的「删除页脚」顺带修复
    （见下方 UI 精简节：页脚 32px 占高导致钳制整图下 zMin 侧 6525 方块被裁、wp-24/wp-26 离屏；
    删页脚后地图区 +33px，裁剪区缩到 4500 方块，两标记回到视口内，属真实通过而非放宽断言）。

## UI 精简：左下角面板 / 「整图」 / 底栏 / 瓦片时间（2026-11-10，同日两轮）

按用户要求，第一轮六项改动，同日第二轮追加三项（各条内以「第二轮」标注）：

1. **左下角按钮上方的描述行去掉**：第一轮 `#dimension-meta` 删掉 `dim-meta-state` 已校准/未校准徽标
   与 `dim-meta-bounds` 范围行，只保留当前维度名称一行；第二轮**维度名称行也去掉**——
   `#dimension-meta` 整体删除（`sidebar.js _renderDimensionMeta` 及三处调用点全部移除），
   `.sidebar-foot` 只保留按钮。
2. **「已校准」提示去掉**：同上，徽标整体移除；同日第三轮又把 `#calibration-notice`
   未校准横幅整体删除（见文件开头「手动校准残留移除」节）。
3. **「整图」按钮改为以出生点居中、放大视野**（`app.js` 新增 `fitToSpawn()`）：
   出生点 = 当前维度 `icon === 'spawn'` 的路径点（其次 id 叫 `spawn`/`wp`），找不到回退世界原点 (0,0)；
   视野横向 ≈ `FIT_SPAN_BLOCKS` 方块（`viewWidth × blocksPerPixelX / span`，与 `focusOrigin` 同公式）。
   `#btn-fit` 与 `#zoom-fit` 都改绑 `fitToSpawn`；真正的整图适配（最小缩放）仍可一路滚轮缩小到达。
   第二轮 `FIT_SPAN_BLOCKS` 2048 → **1536**：视野更窄、缩放更大（约 ×1.33）。
4. **底栏去掉**：`<footer class="app-footer">`（站点口号 / 维度名 / 瓦片时间）整体删除；
   `style.css` 的 `.app-footer`/`.footer-*`/`--footer-h` 清掉，`.app` 网格改 `auto 1fr` 两行；
   `app.js` 的 `setText('site-footer')`/`setText('footer-dim')` 与 `sidebar.js` 的
   `siteFooter`/`footerDim` 节点、`setSiteInfo` 的 footer 分支一并删除（`config.site.footer` 字段仍被
   config 校验容忍，只是不再显示）。
5. **瓦片更新时间**：第一轮移到顶栏右侧（`.topbar-right` 末尾、主题按钮之后）；
   第二轮**再移到侧栏底脚 `.sidebar-foot` 内、视图按钮上侧，无边框**——
   纯文本（muted 11px 单行省略），flex 纵列 + `gap:8px` 自然排在 `.foot-actions` 上方，
   ≤620px 窄屏隐藏规则移除。`updateFooterStatus()` 更名 `updateTilesTime()`，行为不变
   （`state.tileset.generatedAt` 存在时显示 `formatGeneratedAt` 文案，否则隐藏）。
6. **测试跟进**（`tests/smoke.mjs`）：
   - `resetView()` 基建改为直接调 `window.__mapApp.fitToContent({ animate:false })`（全图适配 = 最小缩放，
     其余检查需要「所有标记可见」的前置状态；与 `centerOnOrigin`/`applyDimension` 同类基建 API）；
   - `view.reset` 重写为新语义断言：**真实鼠标点击** `#zoom-fit`（`page.clickSelector`），
     断言视图中心距出生点 < 3 图片像素、缩放 ≥ 全图适配 × 1.2（1536 档实测约 ×30.7）。
   - `pos.initial`/`tiles.levels` 等仍走 `resetView()` 基建，断言语义不变（far 档仍是最粗层级）。
- 回归：单测 **79/79**、`static-checks.mjs` **30/30**、`smoke.mjs` **40 通过 / 0 失败 / 0 跳过**。
  上轮的已知失败 `ui.toggles` 本轮转绿，根因与机制：
  旧布局有 32px 页脚 → 地图区高 811px → 整图适配 rawFit ≈ 0.0149 被 `MIN_SCALE=0.02` 钳制 →
  上下各裁 130px，zMin 侧 6525 方块内的标记 `is-offscreen`（`wp-24` z=-3889、`wp-26` z=-3933
  距 zMin=-8704 仅 4815 方块）→ 全隐前可见 29/31。本轮删除页脚后地图区 +33px（844px），
  裁剪区缩到 4500 方块，两标记回到视口内 → 31/31。属真实通过（未放宽断言）；
  注意余量约 6px，若画幅再扩大可能复发，届时再议（渲染不动前提下不动 `MIN_SCALE`）。

## 瓦片底图改为视口渲染（2026-11-06）

- 背景：主世界瓦片 level 0 栅格 47104×10240（约 4.8 亿像素）。旧渲染器把整幅地图画进一张 backing canvas，
  超过 `MAX_CANVAS_PIXELS`（2400 万）上限后按比例降采样（backingFactor ≈ 0.22），放大时只剩约 1/5 细节，
  表现为「瓦片图很糊」。
- 变更（`assets/js/tiles.js`）：TileLayer 改为**视口渲染**——backing canvas 位图 = 视口 × dpr（超过上限才降采样），
  canvas 的 CSS 盒 = 视口在图片像素空间里的矩形（随视图平移/缩放内联更新 left/top/width/height），
  每帧只绘制与视口相交的瓦片（dx/dy = 瓦片世界像素位置 − 视口原点，再 × scale×dpr×factor）。
  放大时 `image-rendering: pixelated` 关插值，缩小时允许平滑；整图不再整张驻留显存。
- 配套改动：
  - `viewer.js`：`_applyImageSize` 跳过瓦片 canvas（其 CSS 盒由 TileLayer 按视口接管）；
  - `docs/CONTRACT.md` §10.2/§10.3 改为视口渲染语义（位图=视口×dpr、层级选择公式不变、只画视口、像素上限语义变化）；
  - `tests/smoke.mjs`：`IMAGE_INFO` 的 rect 改读 `#stage`（瓦片 canvas 盒现在是视口大小）；`tiles.render`
    不透明像素阈值随 `stats.drawn` 缩放；`tiles.levels` 改为断言「位图恒为视口 × dpr，不随层级放大」；
    期望位置改用**页面实时投影**（瓦片 = manifest / 单图 = calibration，`IMAGE_INFO.calibration` 携带
    `state.calibration`）；`cal.crop-change` 应用校准后先 `resetView()` 重拟合视图。
- 过程中定位并修复的两个真实渲染 bug（各有独立机制，都会造成「标记与图片差 ~1.7px」）：
  1. **标记缓存漂移**（`markers.js`）：`update()` 跳过 DOM 写入时仍把 `_pos` 缓存更新成未写入的值。
     视图动画尾段每帧位移 < 0.25px 阈值，缓存一路漂移；末帧相对漂移后缓存的差值仍 < 0.25px，
     最终位置永远写不进去——标记冻结在动画倒数第二帧的位置（实测差 1.66px 且 1.4s 内不收敛）。
     修复：缓存只记录「上次实际写入 DOM」的值，跳过写入时不更新缓存（累计偏差越过阈值后自然补写）。
  2. **渲染状态舍入不一致**（`viewer.js`）：`_applyTransform` 写 `#stage` transform 时用 `n4()` 把
     tx/ty/scale 舍入到 4 位小数，而 `imageToViewport` / `viewportToImage` 用未舍入的内部状态。
     标记层不在 `#stage` 变换内，于是标记与屏幕上真实渲染的图片之间产生
     「图片像素坐标 × 舍入误差」的系统偏差（fit 视图 39430px 处 = 1.65px）。
     修复：两个换算函数与 DOM 共用同一份 n4 舍入状态（`_renderState()`），
     标记 / 点击命中与渲染图片逐像素对齐（实测偏差 0.004px）。
- 回归：站点单测 **71/71**、`static-checks.mjs` **30/30**、`smoke.mjs` **39/39**（含 `tiles.render` /
  `tiles.levels` / `dim.switch` / `pos.*` / 全程无 console error；`tiles.levels` 从旧代码的失败变为通过；
  71 项含后续新增的 tiles 冻结窗口 2 项）。
- 配置工具 e2e 排查出两处测试 bug（与站点无关，见下），修复后 `17 通过 / 0 失败 / 0 跳过`：
  `tiles/overworld/tiles/6/1_0.png` 磁盘缺失（2026-11-06 14:10 瓦片重生成遗留）被 e2e 的
  瓦片 404 放行正则漏判（正则没覆盖 `tiles/<维度>/tiles/...` 布局），属「未导出瓦片 404 正常」设计内情况，
  按设计放行即可，无需重新生成。

> 2026-11-06 曾上线「交互中双线性」修复拖动抖动，实测亚像素连续但放大时拖动画面发糊
> （双线性柔化是逐帧重光栅化下连续与锐利不可兼得的代价），已回退；后续改走
> 「拖动期间复用锐利位图 + CSS 亚像素平移」方案（见下节，2026-11-07 落地，
> 同日晚改为「静止态也恒用外扩窗口」，进出交互零重画零变化）。

## 拖动抖动：恒外扩窗口 + CSS 亚像素平移（2026-11-07）

- 现象：拖动地图时画面 1px 级台阶抖动——逐帧重光栅化既做不到连续（整数像素取整），
  改用双线性又发糊。目标：既连续又锐利。
- 机制（改动 `assets/js/tiles.js`，两仓库共用同一实现）：
  1. **恒外扩窗口**：光栅化窗口 = 视口每边外扩 25%（位图 = 窗口 × scale × dpr
     = 1.5×视口 × dpr，与层级无关）。静止与拖拽同一路径，不再区分。
  2. **平移冻结**：视口仍落在窗口内且 scale / 视口尺寸 / dpr 未变时 `draw()` 直接返回——
     瓦片位图与 canvas CSS 盒全部冻结，画面移动完全由 `#stage` 的 `translate3d` 交给
     浏览器合成器完成（纯纹理搬移，无重采样、像素锐利、位移与指针逐像素一致）。
  3. **越界才重画**：视口滑出窗口（或缩放 / 尺寸 / dpr 变化 / 新瓦片解码完成）才重画一次
     并换新窗口；新瓦片解码完成强制重画，否则内容永远出不来。
  4. 早前随方案引入的 `viewState.interacting` 信号（viewer.js + 4 条测试）因不再被消费，
     已回退（git restore 到 HEAD），机制完全收敛到 tiles.js。
- 实测（`tests/probe-freeze.mjs`，headless CDP + 帧截图分析）：
  - 176 帧拖动全程 **0 次**地图画布重画（mapClears 恒 0），box / 位图（1440×1069）全程不变；
  - **松手零变化**：松手后盒 / 位图 / 清屏计数与末帧拖动完全一致（进出交互不再有换窗口那一帧微跳）；
  - 静止态窗口即外扩 1.5×（盒 = 1.5×视口/scale、位图 = 1.5×视口×dpr）；
  - 画面位移与鼠标位移逐像素一致（10–11px/对），`image-rendering: pixelated` 全程保持；
  - 拖动首尾锐度 0.99 → 1.37 无衰减（无逐帧糊化）；静止对照两连拍残差精确为 0（测量管道干净）。
- 回归：站点单测 **71/71**（tiles 冻结窗口 2 项）、`static-checks.mjs` **30/30**、
  `smoke.mjs` **39/39**（35.5 s，`tiles.levels` 位图断言改为 1.5×视口×dpr）；
  配置工具 e2e **17 通过 / 0 失败 / 0 跳过**（修复 404 放行正则与 manifest 画幅期望换算两处测试 bug 后，
  `c0c-tiles` 全程跑通：level 6→3、位图恒 1167×1167）。

## 下界与末地切换为瓦片底图（2026-11-06）

- 变更：`config.json` 给 `nether`、`the_end` 补上 `tiles`（`tiles/nether/manifest.json`、`tiles/the_end/manifest.json`），
  站点三个维度全部走瓦片底图；单张 PNG（`下界.png` / `末地.png`）仅作瓦片加载失败时的兜底。
- 数据源（用户选定「用现有 PNG 直接切」）：
  - 下界：`下界.png` 2048×2048，1 像素 = 1 方块，直切 → 8×8 块 level 0（4 层），世界范围 X/Z ±1024；
  - 末地：`末地.png` 2048×2048，2 像素 = 1 方块，`--scale=0.5` 降采样后切 → 4×4 块 level 0（3 层），世界范围 X/Z ±512。
- 配套：配置仓库新增 `tools/png-to-tiles.mjs`（整图 → 瓦片 + manifest，`--x-min/--z-min/--scale/--tile/--out`），
  契约与 `xaero-tiles.mjs` 一致（grid-halving 金字塔、worldBlockRange 向外补齐到瓦片整数倍）；
  新增 `tests/png-to-tiles.test.mjs` 3 项（直切 / 降采样 / 非法参数，含站点 `parseManifest` 真实契约校验）。
- 回归：
  - 站点单测 **69/69**、`smoke.mjs` **34/34**（`dim.switch` 依次切下界/末地并校验底图来源为各自 manifest）；
  - 配置仓库 `xaero-tiles.test.mjs` + `png-to-tiles.test.mjs` **6/6**。

## 换算面板：方向自适应 + 画幅外定位提示（2026-11-06）

- 现象（使用反馈，非代码 bug）：双向换算逻辑一直正确，但两个场景让人误以为「只有主世界→下界能用」：
  1. 在下界地图上打开面板，预填的是下界坐标，默认方向却是 ÷8；
  2. 「下界 → 主世界」×8 的结果几乎必然超出主世界地图画幅（下界 ±1024 × 8 = ±8192，主世界图只有 X ±2048），
     点「定位」会静默跳到地图外的空白区域。
- 修复：
  1. `ConverterPanel.setOpen()` 增加 `direction` 参数：预填实际生效时方向跟随（预填值取自哪个维度，就按哪个维度解释）；
     `app.js` 打开面板时按当前维度传方向（下界 → `n2ow`，主世界 → `ow2n`），其他维度（末地）不预填；
     用户已输入的值不会被重新解释（方向只在预填生效时切换）。
  2. `app.js` 的「定位」回调先检查目标是否在当前地图画幅（`projection.xMin..xMax / zMin..zMax`）内，
     画幅外 toast「目标坐标 (x, z) 不在当前地图画幅内，未定位」并中止，不再静默跳空白区。
- 回归：
  - `tests/converter.test.mjs` 6/6（纯函数不变）；
  - `tests/smoke.mjs` 新增 §6e 三项：`convert.directions`（双向换算 + 画幅内定位到 640,640）、
    `convert.prefill`（下界维度打开自动 ×8 并预填）、`convert.oob`（画幅外定位 toast 且视野不动）；
  - 全量 `smoke.mjs` **34/34**、`static-checks.mjs` **30/30**、`app-regressions` **16/16**。

## 换算工具 + 瓦片更新日期徽标（2026-11-06）

- 新增 `assets/js/converter.js`：主世界 ↔ 下界坐标换算（÷8 / ×8，`Math.round`，负数一半向零取整，
  与 Minecraft Java 实际传送一致：`-12.5 → -12`）。顶栏「换算」按钮打开面板（`#convert-panel`），
  预填当前视野中心，可切换方向 / 复制 / 定位跳转，Esc 关闭。
- 新增瓦片更新徽标：页脚状态栏在瓦片维度显示「瓦片更新于 …（今天/昨天/N 天前）」
  （`formatGeneratedAt`，两个日界取本地午夜、Math.round 吸收夏令时）。
- 伴随改动：`Tileset` 透传 manifest 原始 `generatedAt`；瓦片 URL 带 `?v=<generatedAt 净化串>`
  防 GitHub Pages HTTP 缓存（`max-age=600`）吃旧图。
- 回归：
  - `tests/converter.test.mjs` 6/6（÷8 / ×8 / 往返 ±4 方块 / 字符串输入 / 非法输入 null）；
  - `tests/tiles-regressions.test.mjs` 增补 generatedAt 透传与徽标文案（今天/昨天/N 天前/非法输入）；
  - 全量单测 **69/69**、`static-checks.mjs` **30/30**、`smoke.mjs` **31/31**（无 console error；
    瓦片 404 带 `?v=` 属预期，全部静默跳过）；
  - 浏览器实测：徽标显示「瓦片更新于 2026-11-06 02:04（今天）」；换算预填视野中心 2143/7356 → 268/920；
    方向切换、复制 toast、Esc 关闭、窄屏（≤860px）面板铺底全部符合预期。

## 测距点击守卫 + 退出面板语义（2026-11-06）

- 现象 1（真 bug）：**没开测距时左键点地图也会加测量点**，而且点击被测量逻辑吞掉，路径点选不中。
  原因：`app.js` 的 `handleMeasureClick()` 只判断 `!measure || !imagePoint`，没判断 `state.measureActive`；
  `measure.js` 的 `addPoint()` 也没有 active 守卫。
- 修复：`handleMeasureClick()` 开头加 `if (!state.measureActive) return false;`；
  `MeasureLayer.addPoint()` 开头加 `if (!this.active) return null;`（双保险）。
  调试接口 `window.__mapApp.addMeasurePoint()` 自动进入测距模式，旧脚本/测试不受影响。
- 现象 2（设计问题）：只要有测量点，点「退出」面板仍可见、看起来「没反应」。
  修复（上一轮已改、本轮回归）：退出 = 收起面板，测量线/点保留；再点「测距」恢复编辑。
- 回归：3 项浏览器级守卫已并入 `tests/smoke.mjs`（`measure.guard-inactive` / `measure.guard-exit` /
  `measure.guard-reopen`，随 smoke 自动跑，独立脚本 measure-guards.mjs 已删除）；
  `measure.*` 其余五项保持通过。

## 瓦片底图（2026-11-06）

- 新增 `assets/js/tiles.js`（manifest 解析 / 层级选择 / canvas 渲染 / LRU 缓存）。`config.json` 里配了 `tiles` 的维度走瓦片，
  没配的维度保持原来的「单张 PNG + `calibration`」，一行未改。
- 主世界切到瓦片：世界范围取 `tiles/overworld/manifest.json` 的 `worldBlockRange` = X[-2048, 2048]、Z[-3584, 1536]，1 像素 = 1 方块。
  与原 calibration（`xMin=-2048.5 / zMin=-3584.375`）的像素对齐差是常量 `(0.5, 0.375)`，
  **15 个路径点的像素位置最大偏移 0.625 px**（所有点相同），远小于 2 px 阈值；像素对齐差异只影响 `focusOrigin` 的取整。
- 底图元素：瓦片维度用 `<canvas id="map-canvas">`，与 `<img id="map-image">` 共用同一套定位 / 变换语义
  （CSS 尺寸 = 整幅图片尺寸，位图尺寸 = 当前层级栅格），markers / measure / sidebar / popup 全部零改动。
- smoke 新增 2 项：
  - `tiles.render`：`#map-canvas` 可见且 `#map-image` 隐藏、逻辑尺寸 = manifest 跨度、投影范围 = `worldBlockRange`、
    画布真有像素（整图 level 3 下 58360/327680 不透明）、`drawImage` 次数 > 0、缓存不超上限 ✓
  - `tiles.levels`：整图 level 3（512px 位图 / 6 张）→ 放大到 1:1 变 level 0（4096px 位图 / 一屏 24 张，全层 320 张）
    → 缩回 level 2（1024px），层级与 canvas 位图随缩放单调变化 ✓
- 测试设施：`createDiagnostics(page, { ignore })` 放行缺瓦片的 404（全透明瓦片不导出，属正常）；
  `#map-image` 的旧断言改成「当前底图元素」选择器，`createDiagnostics` 的 ignore 同样作用于新标签页。
- 结果：**25 通过 / 5 失败 / 1 跳过**（跳过的仍是「全绿才截图」）。5 项失败与本次无关，仍是数据耦合项
  （`pos.zoom` / `pos.drag` / `cal.crop-change` / `sidebar.search` / `deep-link`）。
  整轮 smoke 里瓦片请求 **121 次**，其中 **53 次 404**（全部静默跳过），缓存 68 张（上限 400）。
- 已知限制：
  - level 0 的 canvas 位图是 4096×5120（约 84 MB）；`MAX_CANVAS_PIXELS = 2400 万` 是硬上限，更大的导出会自动降位图分辨率。
  - （2026-11-06 补充）`Tileset.levelForScale(scale, dpr)` / `TileLayer({ dpr })` 支持设备像素比：
    站点默认仍传 1（行为不变），工具预览会传 `devicePixelRatio`，高分屏自动选更细层级；
    dpr 只参与层级选择与插值判定，**不乘进 canvas 位图尺寸**，内存上限不变。
  - 瓦片维度的世界范围由 manifest 决定，与 `config.json` 里该维度的 `calibration` 无关
    （后者只作说明；`applyCalibration` 调试 API 已于 2026-11-10 移除）。
  - 层级切换会重新分配 canvas 位图（level 0 ↔ level 3），连续跨层级缩放有少量重分配开销。

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
| `view.reset` | 真实点击「整图」按钮：视图中心距出生点 < 3 图片像素（出生点 = `icon='spawn'` 路径点，找不到回退 (0,0)），且缩放 ≥ 全图适配 × 1.2（不显示整张地图） |
| `tiles.render` | `#map-canvas` 可见且 `#map-image` 隐藏、逻辑尺寸 = manifest 跨度、投影范围 = `worldBlockRange`、画布真有像素、`drawImage` 次数 > 0、缓存不超上限 |
| `tiles.levels` | 整图（最粗层级）→ 放大到 1:1 变 level 0 → 缩回中间层级，层级与 canvas 位图随缩放单调变化（当前 manifest 9 层：整图 level 6 → level 0 → level 2） |
| `data.config` | 列表项 id/名称/顺序与 `config.json` 逐条一致；分组行数量、id、名称与 config 一致 |
| `sidebar.search` | 搜索「农场」列表项 10 → 2，清空后恢复 10；有结果时 `#waypoint-empty` 隐藏 |
| `sidebar.empty` | 搜索无结果时列表 0 项且 `#waypoint-empty` 可见 |
| `sidebar.click` | 点击列表项后该标记锚点距视口中心 < 40px |
| `group.toggle` | 分组眼睛按钮隐藏后该组可见标记 2 → 0，再点恢复 2 |
| `ui.toggles` | 网格：点一次 `aria-pressed=true` 且 `.map-grid` `opacity=1`，再点回 `false`/0（一次点击只切换一次，验证无重复绑定）；标签：连点三次 `body[data-labels]` 依次 hover → always → never → hover；全隐：可见标记 0 且 `#waypoint-count=0/10`，全显恢复 10/10 |
| `deep-link` | `focusWaypoint('castle')` 后 `location.hash` 同步出 `dim/x/z/s`（x/z 与 castle 相差 < 5 方块）；用该 hash 打开**新标签页**：`body[data-dimension]` 正确、视图中心世界坐标与 hash 相差 < 5 方块、无 console error |
| `measure.two` | 测距两点距离与总长正确（(0,0)→(300,400) = 500 格） |
| `measure.polyline` | 多段折线每段独立标注、合计正确（100+240=340） |
| `measure.interact` | 点地图可加点并吸附路径点、可撤销、Esc 退出测距 |
| `measure.shift-detail` | 测距中 Shift+点路径点打开详情卡且不新增测量点 |
| `measure.panel` | 测距读数面板上的点击/滚轮不穿透到地图（撤销/清空不误加点） |
| `measure.guard-inactive` | 测距未开启时点地图不误加点、不进入测距点击路径（`window.__measureLastClick` 保持 null） |
| `measure.guard-exit` | 点「退出」后读数面板收起、测量点保留 |
| `measure.guard-reopen` | 再点「测距」面板恢复且测量点还在 |
| `markers.dense` | 密集路径点合成 ×N 徽标、标签互相避让、连点可轮换选中 |
| `convert.directions` | 换算面板双向换算正确，定位到画幅内坐标有效 |
| `convert.real-click` | 换算面板方向按钮真实鼠标点击可切换（viewer 指针捕获回归） |
| `convert.prefill` | 下界维度打开面板自动切 ×8 并预填下界坐标 |
| `convert.oob` | 定位到画幅外坐标时提示且不移动视野 |
| `skin.panel` | 皮肤预览：真实点击开合与互斥、非法 ID 本地报错（离线安全）、DataTransfer 导入 64×64 与旧版 64×32 PNG（自动补全）、3D 查看器就绪、默认静止、走路/奔跑/静止真实点击切换、旋转开关与左键拖拽停转复位、右键平移相机且不穿透地图、Esc 关闭复位、无 console error |
| `narrow.layout` | `Emulation.setDeviceMetricsOverride(390×844)` 下：`#viewport` 宽 ≈ `window.innerWidth`（±1）、`document.scrollingElement.scrollWidth ≤ innerWidth+1`（无横向溢出）；抽屉打开时（fixed 覆盖层）地图宽度同样 == innerWidth；收起后布局恢复 |
| `narrow.transition` | 桌面收起侧栏后把窗口缩到 390px，`#viewport` 不被压成 0（回归：曾被桌面端多列 grid 规则泄漏到移动断点压成 0px） |
| `theme.toggle` | 主题真实点击切换、localStorage 持久化、系统偏好跟随 |
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
| 2026-11-10（Asia/Shanghai） | Node v24.22.1 / Windows x64 / 本地服务 | **单测 78 通过 / 0 失败（含 skin.test.mjs 7 项）；static-checks 30 通过 / 0 失败；smoke 38 通过 / 1 失败（36.2 s；新增 skin.panel 通过，唯一失败为已知数据耦合项 ui.toggles 29/31，见「玩家皮肤 3D 预览」章节）** |
| 2026-11-07（Asia/Shanghai） | Node v24.22.1 / Windows x64 / 本地服务 | **单测 71 通过 / 0 失败；static-checks 30 通过 / 0 失败；smoke 39 通过 / 0 失败 / 0 跳过（35.5 s）；probe-freeze 探针通过（静止外扩窗口、拖动全程零重画、松手零变化、位移与鼠标一致、拖动锐利）** |
| 2026-11-06 14:10（Asia/Shanghai） | Node v24.22.1 / Windows x64 / 本地服务 | **单测 69 通过 / 0 失败（`node --test tests/*.test.mjs`）；static-checks 30 通过 / 0 失败；smoke 39 通过 / 0 失败 / 0 跳过（35.4 s）** |
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

1. **依赖调试接口**：`pos.zoom` 的 scale 断言使用 `app.js` 暴露的
   `window.__mapApp`（`view.getViewState()`、`state.calibration`）。
   若该接口被移除：`pos.zoom` 会退化为仅用图片矩形宽度断言并给出警告。
2. **只覆盖 Chromium**（Edge / Chrome）。Firefox / Safari 未验证；`Input.dispatchMouseEvent` 的滚轮/拖拽在别的浏览器内核上行为可能不同。
3. **不做视觉像素比对**：截图仅作留证；布局断言全部基于几何数值（`getBoundingClientRect`、computed style）。
4. **窄屏只做「尺寸 + 开合」验证**：`Emulation.setDeviceMetricsOverride` 不是真实触屏，双指捏合缩放、触摸滚动未覆盖。
5. **搜索用例使用固定词「农场」**：依赖 `config.json` 示例数据。若示例路径点改名，需要同步更新 `sidebar.search` 的查询词（断言本身仍以 config 数据动态计算期望值）。
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
