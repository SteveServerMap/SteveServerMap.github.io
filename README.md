# Steve Server 地图

Minecraft 服务器的**离线地图站点**：一张导出的地图 PNG（或一套瓦片）+ 一份 `config.json`，就能得到一个可以拖动缩放、按维度切换、带分组和搜索的网页地图。

纯静态、零依赖、零构建：没有 npm、没有 CDN、不联网，把整个目录丢到 GitHub Pages、对象存储或内网 IIS/nginx 上就能用。

**线上地址：<https://steveservermap.github.io/>**（部署在 GitHub Pages，`main` 分支根目录，详见 [第 8 节](#8-部署到-github-pages)）

- 🗺️ **多维度**：主世界 / 下界 / 末地，一键切换
- 🧱 **瓦片底图**：三个维度都用瓦片（`tiles/`，按缩放自动切层级、只加载视口内的瓦片）；单张 PNG + `calibration` 作为瓦片加载失败时的兜底，对路径点、测距、搜索等上层功能完全一致
- 📍 **路径点由配置驱动**：加一个点 = 在 `config.json` 里加几行
- 🎯 **画幅变了也不丢点**：路径点存的是**世界坐标**，重新导出地图后重新校准一次，所有点自动对回（本项目的核心设计）
- 🔍 分组显隐与折叠、搜索、标签模式、坐标网格、比例尺、坐标读数、链接分享
- 📏 **测距**：点两下量两点距离，继续点就是多段折线（每段单独标注 + 总长），可吸附路径点
- 🔄 **坐标换算**：顶栏「换算」面板，主世界 ↔ 下界一键互算（÷8 / ×8），支持复制与跳转定位
- 🕒 **瓦片更新徽标**：瓦片底图页脚显示「瓦片更新于 …（今天 / 昨天 / N 天前）」，一眼看出地图新旧
- 🌙 深色 Minecraft 风格界面，手机 / 平板可用（侧栏变抽屉）
- 🧭 **校准在配套工具里做**：用 [SteveServerMapConfig](https://github.com/SteveServerMap/SteveServerMapConfig) 点两个已知地标 / 直接填世界原点，写进 `config.json` 即可（站点内不再有校准入口）

---

## 界面预览

线上实况（<https://steveservermap.github.io/>，点路径点后的详情卡片）：

![线上实况](docs/screenshots/live-github-pages.png)

| 桌面端（主世界 + 路径点菜单） | 手机端（侧栏变抽屉） |
| --- | --- |
| ![桌面端](docs/screenshots/desktop-main.png) | ![手机端](docs/screenshots/mobile-main.png) |

> 截图来自真实浏览器（Edge headless + 本地静态服务器），基底图为仓库内的瓦片 `tiles/`，路径点是 `config.json` 里的真实数据。

---

## 目录

- [1. 快速开始](#1-快速开始)
- [2. 目录结构](#2-目录结构)
- [3. 核心概念：为什么换了地图路径点也不会丢](#3-核心概念为什么换了地图路径点也不会丢)
- [4. config.json 字段说明](#4-configjson-字段说明)
- [5. 常见配置操作](#5-常见配置操作)
- [6. 画幅变了：重新校准](#6-画幅变了重新校准)
- [7. 替换基底地图](#7-替换基底地图)
- [8. 部署到 GitHub Pages](#8-部署到-github-pages)
- [9. 常用操作与小技巧](#9-常用操作与小技巧)
- [10. 常见问题](#10-常见问题)
- [11. 浏览器支持](#11-浏览器支持)
- [12. 后续可优化项（尚未实现）](#12-后续可优化项尚未实现)

---

## 1. 快速开始

### 本地预览（推荐）

在项目目录里启动一个静态服务器：

```bash
# 需要 Python 3
python -m http.server 8000
```

然后浏览器打开：

```
http://localhost:8000/
```

Windows 用户也可以直接双击仓库里的 **`serve.cmd`**：会自动切换到脚本所在目录并校验 Python 3；若 8000 端口已被占用（例如上一个预览窗口没关），会自动改用 8001–8010 的空闲端口，并在窗口里打印实际地址。

> ⚠️ **不要直接双击 `index.html` 用 `file://` 打开。**
> 页面用 `fetch()` 读取 `config.json`，而浏览器的同源策略会拦截 `file://` 下的本地文件请求，结果就是地图区一直显示「无法加载 config.json」。必须通过 `http://` 访问。
> 同理，用 VS Code 的 Live Server、`npx serve`、nginx 都可以，只要能从 http 访问到 `config.json` 和 PNG。

### 换成你自己的数据

1. 把导出的地图覆盖到 `主世界.png`（或改 `config.json` 里的 `image` 字段，见 [第 7 节](#7-替换基底地图)）；
2. 用配套的 [SteveServerMapConfig](https://github.com/SteveServerMap/SteveServerMapConfig) 校准一次画幅（见 [第 6 节](#6-画幅变了重新校准)），保存到 `config.json`；
3. 编辑 `config.json`，把你的路径点、分组填进去；
4. 刷新页面，完成。

---

## 2. 目录结构

```
SteveServerMap.github.io/
├── index.html                 页面骨架（唯一入口）
├── config.json                ★ 你要编辑的配置文件：维度 / 画幅 / 分组 / 路径点
├── config.schema.json         配置的 JSON Schema（供编辑器补全与校验）
├── tiles/                     ★ 三个维度的瓦片底图（manifest + 各层级 PNG，可选）
│   ├── overworld/             主世界：Xaero 导出图直切（16×20 → … → 1×2）
│   │   ├── manifest.json      瓦片清单：层级、世界范围、每层瓦片编号范围
│   │   └── tiles/<level>/<x>_<y>.png  瓦片本体（列_行，缺文件 = 该处全透明，属正常）
│   ├── nether/                下界：下界.png 整图直切（1 像素 = 1 方块）
│   └── the_end/               末地：末地.png 降采样 2×（原图 2 像素 = 1 方块）
├── 主世界.png                 单张基底图（瓦片加载失败时的兜底）
├── 下界.png                   基底地图（下界兜底）
├── 末地.png                   基底地图（末地兜底）
├── serve.cmd                  Windows 一键本地预览
├── docs/
│   ├── CONTRACT.md            内部接口契约（开发者用，使用者可以跳过）
│   ├── QA.md                  自动化验收说明与最近结果（开发者用）
│   └── screenshots/           界面截图（README 里引用）
├── assets/
│   ├── css/
│   │   └── style.css          全部样式（颜色变量都集中在 :root，方便换肤）
│   └── js/
│       ├── config.js          读取 + 规范化 config.json
│       ├── coords.js          世界坐标 ↔ 图片像素（纯函数）
│       ├── tiles.js           瓦片底图：manifest 解析 / 层级选择 / canvas 渲染 / LRU 缓存
│       ├── viewer.js          地图平移 / 缩放引擎
│       ├── markers.js         路径点标记与详情卡片
│       ├── sidebar.js         左侧菜单（分组 / 列表 / 搜索）
│       ├── measure.js         测距图层（世界坐标折线 + 距离标注）
│       ├── converter.js       主世界 ↔ 下界坐标换算（÷8 / ×8）
│       └── app.js             装配层（把上面这些接起来）
└── tests/                     自动化验收脚本（开发者用）
```

日常只需要动两个东西：**`config.json`** 和 **三张 PNG**。其他文件不用改。

---

## 3. 核心概念：为什么换了地图路径点也不会丢

很多人做离线地图的方式是「把路径点的坐标记成图片上的像素位置」。这样一旦重新导出地图（裁剪范围变了、分辨率变了、换了渲染器），所有点立刻全部错位，只能一个个重新摆。

这个项目不这么干：

```
路径点  ──世界坐标(x, z)──►  换算（靠 calibration）  ──►  图片像素(px, py)  ──►  屏幕位置
                                     ▲
                                     └── 换了地图，只改这里
```

- **路径点只存 Minecraft 世界坐标**（比如出生点就是 `x: 0, z: 0`），跟图片完全无关；
- **配置里额外存一份「画幅校准参数」**：图片左/右边缘对应世界的哪个 X、上/下边缘对应世界的哪个 Z；
- 页面每次都实时用这组参数把世界坐标换算成像素位置。

所以重新导出一张画幅不同的地图时：

1. 覆盖 PNG；
2. 用配套工具 SteveServerMapConfig 重新解一次画幅（两个已知地标就够），保存到 `config.json`；
3. 所有路径点**自动**回到正确位置 —— 一个点都不用改。

换算公式（`W/H` 是图片原始像素宽高，`px/py` 以图片左上角为原点）：

```
px = (x - xMin) / (xMax - xMin) * W
py = (z - zMin) / (zMax - zMin) * H        // 开了南北翻转 flipZ 时取 1 - t
```

---

## 4. config.json 字段说明

配置文件是普通 JSON，用 UTF-8 保存。JSON 不允许注释，也不允许结尾多余逗号（这是最常见的报错原因）。

### 4.1 顶层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `version` | number | `1` | 配置格式版本，当前固定 `1` |
| `site` | object | — | 站点文字，见下表 |
| `defaultDimension` | string | 第一个维度 | 打开页面时默认显示的维度 `id` |
| `ui` | object | — | 界面选项，见下表 |
| `dimensions` | array | **必填** | 维度列表，至少一个 |

`site`：

| 字段 | 说明 |
| --- | --- |
| `title` | 顶栏标题（也用作浏览器标签页标题） |
| `subtitle` | 顶栏副标题（窄屏自动隐藏） |
| `footer` | 页脚文字 |

`ui`：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `labelMode` | `"always"` / `"hover"` / `"never"` | `"hover"` | 路径点名称标签的显示方式；页面内可按 `L` 循环切换 |
| `grid` | boolean | `false` | 初始是否显示坐标网格；页面内可按 `G` 切换 |
| `startCollapsed` | boolean | `false` | 初始是否收起左侧菜单（窄屏默认收起） |
| `showCoords` | boolean | `true` | 是否在地图左下角显示鼠标处的坐标读数 |
| `defaultSpanBlocks` | number | `1024` | 进入页面 / 点「原点」时视野**长边**覆盖多少方块（横屏为宽、竖屏为高；64~16384）。越小越贴近地形，越大越接近全图 |

> 打开页面默认会**聚焦世界原点 (0,0)**，视野长边约 1024 方块（约 1 屏幕像素 = 1 方块；手机竖屏即纵向 1024、横向约 470）；左下角「原点」按钮行为完全一致，点「整图」才回到全图适配。

### 4.2 维度（`dimensions` 数组元素）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 维度标识，用于 URL 与内部引用，如 `overworld` / `nether` / `the_end` |
| `name` | string | ✅ | 显示名称，如 `主世界` |
| `image` | string | ✅ | 基底图片路径，**相对站点根目录**，如 `主世界.png`。配了 `tiles` 时它只在瓦片加载失败时兜底 |
| `tiles` | object / string | — | 瓦片底图，见 4.6；配了它就用瓦片渲染，世界范围以 manifest 为准（`calibration` 不再参与换算） |
| `calibration` | object | — | 画幅校准参数，见 4.3；缺失时路径点无法定位，界面会提示「未校准」 |
| `groups` | array | — | 分组，见 4.4 |
| `waypoints` | array | — | 路径点，见 4.5 |

### 4.3 校准参数 `calibration`

推荐写法（配置工具输出的就是它）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `calibrated` | boolean | 是否已经确认校准过（历史字段，站点 UI 不再显示提示） |
| `xMin` | number | **图片左边缘**对应的世界 X |
| `xMax` | number | **图片右边缘**对应的世界 X |
| `zMin` | number | **图片上边缘**对应的世界 Z |
| `zMax` | number | **图片下边缘**对应的世界 Z |
| `flipZ` | boolean | 南北翻转：图片**上方是 +Z** 时置 `true`（默认 `false`，即上方是 `-Z`） |
| `note` | string | 备注，只用于说明，可以随便写 |

替代写法（已知「每方块多少像素」时更方便，二选一，`xMin` 优先）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pixelsPerBlock` | number | 每方块像素数，如 `1` 表示 1 像素 = 1 方块 |
| `originX` | number | **图片左上角**对应的世界 X |
| `originZ` | number | **图片左上角**对应的世界 Z |

> `xMin/xMax/zMin/zMax` 必须严格递增（`xMax > xMin`、`zMax > zMin`）；方向由哪张图决定，填反了路径点会整体镜像。

### 4.4 分组 `groups`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 分组标识，路径点的 `group` 引用它 |
| `name` | string | ✅ | 显示名称 |
| `color` | string | — | 分组颜色（十六进制），如 `#5ad26f`；缺省灰色 |
| `visible` | boolean | — | 初始是否显示，默认 `true` |

### 4.5 路径点 `waypoints`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 唯一标识，用于 URL 深链 `#wp=spawn`（填 **id**，不是显示名称） |
| `name` | string | ✅ | 显示名称 |
| `x` | number | ✅ | 世界 X 坐标（方块） |
| `z` | number | ✅ | 世界 Z 坐标（方块） |
| `y` | number | — | 世界 Y 坐标，仅用于显示（如 `65`） |
| `group` | string | — | 所属分组 `id`，缺省归入「未分组」 |
| `icon` | string | — | 图标 key 或直接写 emoji，缺省 `pin`，见下表 |
| `color` | string | — | 覆盖分组色 |
| `label` | `"always"` / `"hover"` / `"never"` | — | 该点标签策略，缺省跟随 `ui.labelMode` |
| `description` | string | — | 详情卡片里的描述 |
| `url` | string | — | 详情卡片里的外链（如截图、攻略） |

可用图标 key（也可以直接写一两个字符的 emoji）：

| key | 图标 | key | 图标 | key | 图标 |
| --- | --- | --- | --- | --- | --- |
| `pin` | 🧷 | `home` | 🏠 | `village` | 🏘️ |
| `farm` | 🌾 | `mine` | ⛏️ | `portal` | 🌀 |
| `chest` | 📦 | `diamond` | 💎 | `skull` | ☠️ |
| `tower` | 🏰 | `ship` | ⛵ | `mountain` | ⛰️ |
| `redstone` | 🔴 | `nether` | 🐷 | `end` | 🐉 |
| `shop` | 🛒 | `spawn` | 🌍 | `bed` | 🛏️ |
| `pvp` | ⚔️ | `event` | 🎪 | `question` | ❓ |

### 4.6 瓦片底图 `tiles`（可选）

地图很大时，一张 PNG 可能有几十 MB，首屏要等很久。这时可以把地图切成瓦片：页面按当前缩放自动挑层级，只下载视口里那几张。

```json
"tiles": { "manifest": "tiles/overworld/manifest.json" }
```

也可以直接写成字符串：`"tiles": "tiles/overworld/manifest.json"`。

`manifest.json` 的结构（由导出工具生成，一般不用手改）：

| 字段 | 说明 |
| --- | --- |
| `tileSize` | 每张瓦片的像素边长（通常 256） |
| `source` | 导出工具标识，仅作备注 |
| `levels[]` | 每个缩放层级一条：`level`（0 = 1 像素 = 1 方块）、`blocksPerPixel`、`minX/maxX/minZ/maxZ`（该层实际存在的瓦片列/行范围）、`cols/rows`、`originBlockX/originBlockZ`（该层 (0,0) 瓦片左上角的世界坐标） |
| `worldBlockRange` | 整幅地图覆盖的世界范围 `{xMin,xMax,zMin,zMax}`，**1 像素 = 1 方块**，也是路径点换算的唯一依据 |

瓦片文件放在 manifest 同级的 `tiles/<level>/<x>_<y>.png`（列_行）。**全透明的瓦片不会被导出**，所以编号不连续、请求 404 是正常情况，页面会静默跳过，不报错也不影响其他功能。

行为说明：

- 世界范围 = `worldBlockRange`，所以配了 `tiles` 的维度**不需要 `calibration`**（写了也只当备注，站点不会用它换算）。
- 层级选择：让「1 瓦片像素 ≈ 1 屏幕像素」，即 `blocksPerPixel × 当前缩放` 最接近 1 的那一层。
- 放大时关掉插值（`imageSmoothingEnabled = false` + `image-rendering: pixelated`），保持像素锐利。
- 已解码瓦片走 LRU 缓存，上限 400 张（约 100 MB）；canvas 位图另有 2400 万像素的硬上限，超过时按比例降低位图分辨率，避免超大导出把内存撑爆。
- 配了 `tiles` 但 manifest 加载失败时，会自动退回 `image` + `calibration`（原来的单张底图）。

### 4.7 一份完整的示例

```json
{
  "version": 1,
  "site": {
    "title": "Steve Server 地图",
    "subtitle": "离线地图 · 不定期更新",
    "footer": "路径点由 config.json 驱动 · 修改后刷新页面生效"
  },
  "defaultDimension": "overworld",
  "ui": { "labelMode": "hover", "grid": false, "startCollapsed": false, "showCoords": true },
  "dimensions": [
    {
      "id": "overworld",
      "name": "主世界",
      "image": "主世界.png",
      "calibration": {
        "calibrated": true,
        "xMin": -1792,
        "xMax": 1792,
        "zMin": -2560,
        "zMax": 2560,
        "flipZ": false,
        "note": "2025 年春季导出，3584×5120 像素，1 像素 = 1 方块"
      },
      "groups": [
        { "id": "base", "name": "据点", "color": "#5ad26f", "visible": true },
        { "id": "resource", "name": "资源点", "color": "#59a6ff", "visible": true }
      ],
      "waypoints": [
        {
          "id": "spawn",
          "name": "出生点",
          "x": 0,
          "y": 65,
          "z": 0,
          "group": "base",
          "icon": "spawn",
          "label": "always",
          "description": "服务器出生点 / 传送落点。"
        },
        {
          "id": "iron-farm",
          "name": "铁傀儡农场",
          "x": -180,
          "y": 72,
          "z": 240,
          "group": "resource",
          "icon": "farm",
          "description": "自动刷铁机，24 小时运行。",
          "url": "https://example.com/iron-farm"
        }
      ]
    },
    {
      "id": "nether",
      "name": "下界",
      "image": "下界.png",
      "calibration": {
        "calibrated": true,
        "xMin": -1024,
        "xMax": 1024,
        "zMin": -1024,
        "zMax": 1024,
        "flipZ": false,
        "note": "下界坐标通常只有主世界的 1/8"
      },
      "groups": [{ "id": "portal", "name": "传送门", "color": "#b485ff", "visible": true }],
      "waypoints": [
        {
          "id": "nether-hub",
          "name": "下界交通枢纽",
          "x": 40,
          "y": 70,
          "z": -52,
          "group": "portal",
          "icon": "portal",
          "description": "连接各基地的冰道枢纽。"
        }
      ]
    }
  ]
}
```

> 编辑时把 `config.schema.json` 关联上（VS Code 里在文件顶部加 `"$schema": "./config.schema.json",`），可以获得字段补全和错误提示。

---

## 5. 常见配置操作

### 5.1 加一个路径点

在对应维度的 `waypoints` 数组里追加一项即可（`id` 在同一维度内唯一）：

```json
{
  "id": "gold-farm-2",
  "name": "金农场二期",
  "x": 640,
  "y": 68,
  "z": -420,
  "group": "resource",
  "icon": "farm",
  "description": "新增的刷金机。"
}
```

保存 → 刷新页面。坐标从游戏里按 `F3` 抄（X / Y / Z 是三个数字，注意别把 Y 当成 Z）。

### 5.2 加一个分组

```json
{ "id": "pvp", "name": "PVP 场地", "color": "#ff7ab6", "visible": true }
```

然后给路径点写 `"group": "pvp"`。引用了不存在的分组（或干脆不写）时，该点会静默归入「未分组」。

### 5.3 加一个维度

1. 把新地图图片放到站点根目录（如 `资源世界.png`）；
2. 在 `dimensions` 数组里加一项：

```json
{
  "id": "resource_world",
  "name": "资源世界",
  "image": "资源世界.png",
  "calibration": { "calibrated": false, "xMin": -2048, "xMax": 2048, "zMin": -2048, "zMax": 2048 },
  "groups": [{ "id": "ore", "name": "矿区", "color": "#ffbc4b", "visible": true }],
  "waypoints": []
}
```

3. 刷新后顶栏/侧栏会出现「资源世界」按钮；
4. 切换过去 → 点「校准」校准这张图的画幅（见下一节）。

### 5.4 改颜色 / 换肤

- 分组颜色：`groups[].color`，或单个点的 `waypoints[].color`；
- 界面主题色：`assets/css/style.css` 顶部 `:root` 里的 `--accent`（默认草绿 `#5ad26f`）、`--bg`、`--panel` 等变量，改一处全站生效。

---

## 6. 画幅变了：重新校准

**什么时候需要校准？** 只要「同一块世界在图片上占的像素位置」变了，就要重新校准：

- 重新导出了地图（换了渲染器、改了渲染范围、改了缩放倍率/分辨率）；
- 裁剪了图片（裁掉白边、只留主城）；
- 换了图片尺寸（大图压小图）。

**操作步骤（用配套工具 SteveServerMapConfig 校准）：**

1. 启动配置工具（`node server.mjs` → <http://127.0.0.1:5273/>），它会自动载入本站点的 `config.json`；
2. 选好维度 → 点「**校准**」→ 用「**两点校准**」在地图上点两个**你知道精确世界坐标**的地标（出生点、传送门、主城中心、某个方块的角都可以），填它们的 X / Z；
   - 两个地标要**尽量拉开距离**，并且**不能在几乎同一行或同一列**上（否则有一个方向解不出来，工具会用红色提示）；
   - 也可以直接用「**世界原点 (0,0)**」模式：在图上点出世界原点的位置 + 填每方块像素数，一步到位（适合离线地图导出时没有可辨认地标的情况）；
3. 工具会实时解出画幅：

   ```
   画幅已解出
   X：-1792 → 1792   每方块 1 px（1 px ≈ 1 方块）
   Z：-2560 → 2560   每方块 1 px（1 px ≈ 1 方块）
   ```

   - 两个方向的「每方块像素数」差很多时，工具会提示地标坐标可能填错（或图片被非等比拉伸过）；
   - 图片是「南在上」（上方是 +Z）时勾上「南北翻转」（`flipZ`）；
4. 点「**保存到站点**」，工具会把 `calibration` 写进本站点的 `config.json`（写前自动备份到 `.backups/`）；
5. 刷新本站页面，所有路径点自动对回新画幅。

> 站点本身**不再提供**校准入口：画幅只来自 `config.json`，这样每台电脑看到的位置都一致（不会出现"本地校准覆盖"导致各人看到的不一样）。

## 7. 替换基底地图

三个维度都走**瓦片底图**（`tiles/`），单张 PNG 只在瓦片加载失败时兜底：

| 维度 | 底图 | 说明 |
| --- | --- | --- |
| 主世界 | `tiles/overworld/manifest.json` + `tiles/overworld/tiles/<level>/<x>_<y>.png` | Xaero 导出图直切；`主世界.png`（3584×5120）只在 manifest 加载失败时兜底 |
| 下界 | `tiles/nether/manifest.json` + `tiles/nether/tiles/<level>/<x>_<y>.png` | `下界.png` 整图直切（2048×2048，1 像素 = 1 方块）；`下界.png` 兜底 |
| 末地 | `tiles/the_end/manifest.json` + `tiles/the_end/tiles/<level>/<x>_<y>.png` | `末地.png` 降采样 2×（原图 2 像素 = 1 方块）；`末地.png` 兜底 |

换瓦片地图：把新的 `manifest.json` 与同目录的 `tiles/` 整体覆盖 `tiles/<维度>/`，确认 `config.json` 里该维度的 `"tiles": { "manifest": "tiles/<维度>/manifest.json" }` 不变即可 —— 瓦片自带世界范围，**不需要再校准**（路径点会按新 manifest 的 `worldBlockRange` 自动对回）。

> 当前瓦片由配置工具（`SteveServerMapConfig`）生成：主世界走「XAERO 瓦片源」（导出图放进 `xaero/<维度名>/`，详见该仓库的 `docs/XAERO.md`）；下界 / 末地用「整图切瓦片」（`tools/png-to-tiles.mjs <整图.png> --x-min=<n> --z-min=<n> [--scale=0.5] --out=…`，适合只有拼好的整张 PNG 的场景）。

两种换法，任选其一：

1. **保持文件名**（最省事）：直接把新图覆盖同名文件，`config.json` 不动。换完记得重新校准。
2. **改配置**：把新图放进来（如 `overworld-2025.png`），然后把对应维度的 `"image"` 改成新文件名。

注意事项：

- `image` 是**相对站点根目录**的路径；放在子目录里也可以写成 `"maps/overworld.png"`。
- **文件名大小写敏感**（GitHub Pages 是 Linux）：`Overworld.PNG` ≠ `overworld.png`。
- 中文文件名可用，但少数旧浏览器/工具链对 URL 编码处理不好；追求稳妥可以改成英文名（`overworld.png` / `nether.png` / `end.png`）。
- 换图后**一定要重新校准**（第 6 节）：图片换了，画幅几乎必然变化。
- 大图建议：单边长不超过约 8000 px、文件控制在 10 MB 以内，否则手机端加载会慢。PNG 可以用 `pngquant` / `oxipng` 压缩；如果地图是纯色块风格，压完往往能小一半以上。
- 地图特别大时优先用**瓦片底图**（见 [4.6](#46-瓦片底图-tiles可选)）：首屏只下载视口内的瓦片，比一张几十 MB 的大图快得多。
- 地图渲染工具随意：Chunky、Minecraft Overviewer、unmined 等导出的俯视图都可以，只要是一张**正上方俯视、无透视变形**的图片。

---

## 8. 部署到 GitHub Pages

推荐直接用「用户名.github.io」仓库，地址最干净。

1. 新建仓库：`<你的GitHub用户名>.github.io`（**必须**是这个名字才能用根域名访问）。
2. 把整个项目目录推送上去（`index.html`、`config.json`、三张 PNG、`assets/` 等都在**仓库根目录**，不要多套一层文件夹）：

   ```bash
   git init
   git add -A
   git commit -m "update map"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<你的用户名>.github.io.git
   git push -u origin main
   ```

3. 打开仓库 → **Settings** → 左侧 **Pages** → *Source* 选 **Deploy from a branch** → Branch 选 `main`、目录选 `/ (root)` → **Save**。
4. 等 1~2 分钟，访问 `https://<你的用户名>.github.io/`。

其他要点：

- 也可以用普通仓库 + 子路径部署（`https://<用户名>.github.io/<仓库名>/`），此时所有路径都是相对的，无需改代码。
- 仓库是公开的才能免费用 Pages；私有仓库需要付费方案。
- 自定义域名：在 Pages 设置里填域名，再按提示配置 DNS 的 `CNAME`。
- **更新后看不到变化？** 先 `Ctrl + F5`（强制刷新）。GitHub Pages 有 CDN 缓存，PNG 同名覆盖后可能几分钟才更新；想立刻生效可以给图片改个名并同步改 `config.json` 的 `image`。
- 部署后如果只有地图不显示：打开开发者工具 → Network，看 PNG 是否 404（多半是文件名大小写或路径不对）。

---

## 9. 常用操作与小技巧

| 操作 | 说明 |
| --- | --- |
| 拖拽 / 单指拖动 | 平移地图 |
| 滚轮 / 双指捏合 / `+` `-` | 缩放（以鼠标位置为锚点） |
| 方向键 | 平移（先点一下地图让它获得焦点） |
| 双击路径点 / 点击列表项 | 居中到该点并弹出详情 |
| 顶栏「分享」 | 把当前维度 + 中心坐标 + 缩放级别写进 URL 并复制，别人打开就是同一个视角 |
| `G` | 显示/隐藏坐标网格 |
| `L` | 循环切换标签模式（悬停 / 常显 / 隐藏） |
| `Esc` | 关闭详情卡片 / 取消拾取 |
| 搜索框 | 支持名称、描述、坐标（如 `-512 640`） |
| 分组「眼睛」按钮 | 单独显示/隐藏某组；面板上的「全显 / 全隐」批量操作 |
| 「整图」 | 缩放到整张地图刚好铺满 |
| 「原点」 | 回到世界 `(0, 0)` |
| 顶栏「测量」 | 开关测距模式（点地图加点，点路径点会吸附） |
| `Backspace` | 测距时撤销上一个测量点 |
| `Enter` / `Esc` | 测距时结束 / 退出 |
| 顶栏「换算」 | 主世界 ↔ 下界坐标换算面板（打开时预填当前视野中心，方向自动匹配当前维度；窄屏收进侧栏底脚） |

### 测距怎么用

1. 点顶栏 **「测量」** 进入测距模式（鼠标变成十字，左下角出现读数面板）；
2. 在地图上点第一下 = 起点，第二下 = 终点，两点之间就显示**距离（格 = 方块 = 米）**；
3. 继续点就是多段折线：每一段单独标距离，最后一点后面显示**总长**，左下角面板逐段列出并可「撤销 / 清空 / 退出」；
4. 点在路径点上会自动**吸附**到该路径点的世界坐标（方便量"出生点→刷怪塔"这种）；
5. 缩放/平移时测量线跟着地图走，距离不会变（因为点存的是世界坐标）。

### 换算怎么用

1. 点顶栏 **「换算」** 打开面板（X / Z 自动预填当前视野中心的方块坐标）；
2. 选方向：**主世界 → 下界**（÷8）或 **下界 → 主世界**（×8），1 下界格 = 8 主世界格；
   在下界地图上打开时会自动选好「下界 → 主世界」（预填的是下界坐标，不会按反方向算）；
3. 结果可「复制」，或点「定位」直接跳转过去（切维度后坐标照常换算，不用管地图）；
4. 负数按 Minecraft（Java）的取整规则：`-12.5 → -12`（向零取整），和游戏内实际传送一致；
5. 定位目标超出当前地图画幅时（比如 ×8 后落在主世界地图之外），会提示「不在当前地图画幅内」而不是跳到空白区域。

URL 深链格式（可以手动拼，也可以从「分享」按钮拿）：

```
https://你的站点/#dim=overworld&x=120&z=-340&s=0.75&wp=spawn
```

---

## 10. 常见问题

**Q：双击 `index.html` 打开是一片空白 / 一直「无法加载 config.json」。**
浏览器的本地文件策略不允许 `file://` 页面用 `fetch` 读取同目录文件。请按 [第 1 节](#1-快速开始) 用 `python -m http.server 8000` 通过 `http://localhost:8000/` 访问。

**Q：地图区提示「地图还没上传」/ 图片 404。**
按顺序检查：① 文件名和 `config.json` 里的 `image` 是否**完全一致**（含扩展名、大小写）；② 图片是否在站点根目录（或 `image` 里写的相对路径是否正确）；③ 浏览器开发者工具 Network 面板看该图片请求是不是 404；④ 图片本身有没有损坏（能双击打开吗）。

**Q：Network 里一堆 `tiles/<维度>/tiles/<level>/<x>_<y>.png` 是 404，是坏了吗？**
不是。瓦片导出时**全透明的瓦片不会落地**，所以编号不连续是常态。页面会静默跳过缺的瓦片（显示为透明背景），不影响路径点、测距和搜索。只要不是整屏空白就不用管。

**Q：瓦片地图打开后某些区域是空的。**
那一片在导出时就是空的（未探索 / 没有地图数据），不是加载失败。可以对比 `manifest.json` 里各层级的 `minX/maxX/minZ/maxZ` 确认覆盖范围。

**Q：路径点整体偏移 / 全部跑到一起了。**
`calibration` 四个边界还是默认值（`calibrated: false`），就会整体偏。按 [第 6 节](#6-画幅变了重新校准) 用两个地标校准一次即可。如果校准后仍然偏：检查两个地标的坐标是否填错（最容易发生）、两点是否离得太近；如果地图图片被非等比拉伸过，X/Z 比例会不一致，向导会给出提示。

**Q：南北颠倒（上下反了）。**
图片上方是 `+Z` 时，把 `calibration.flipZ` 设为 `true`。用两点校准时向导会自动判断；手动输入时勾「南北翻转（图片上方是 +Z）」。

**Q：左右镜像（东西反了）。**
`xMin` 必须是图片**左边缘**的世界 X。不要把它和 `xMax` 填反，也不要抄错两个地标的 X。本项目没有 `flipX`：地图应当是从正上方俯视、东在右的正常朝向。

**Q：路径点互相重叠，点不到下面那个。**
放大即可分离；也可以打开标签模式（`L`）或按分组筛选。两个点在世界上本来就挨得很近时，视觉重叠是正常的 —— 点击命中的是最上层（通常是最后渲染的那个），建议把重要地点稍微错开或拆到不同分组。

**Q：改了 `config.json` 刷新不生效。**
① 浏览器缓存 → `Ctrl + F5`；② JSON 语法错误 → 按 `F12` 看 Console，页面会直接提示「config.json 不是合法的 JSON」；最常见原因是**结尾多余的逗号**、**中文引号 `“”`**、**注释**（JSON 不支持注释）。建议用支持 JSON Schema 的编辑器打开。

**Q：校准后只有我这台电脑是对的，别人打开还是歪的。**
站点没有本地校准功能：画幅只来自 `config.json`，所有浏览器看到的位置都一致。要把校准结果固化，必须在 SteveServerMapConfig 配置工具里校准后保存并部署 `config.json`（工具里的「复制 JSON 片段」→ 粘进 `config.json` 的 `calibration` → 保存并部署）。

**Q：瓦片维度还需要校准吗？**
不需要。瓦片自带世界范围（`manifest.json` 的 `worldBlockRange`），路径点按它换算；`config.json` 里该维度的 `calibration` 只作说明。只有用单张 `image` 的维度才需要校准。

**Q：下界 / 末地地图是空白的。**
仓库里的 `下界.png`、`末地.png` 目前是占位图。换成真实导出图，然后重新校准该维度即可。

**Q：手机上侧栏挡住地图 / 打不开侧栏。**
窄屏（≤ 860 px）下侧栏变成覆盖式抽屉：点左上角菜单按钮开合，点遮罩关闭。地图本身不受影响。

**Q：手机顶栏挤成一团，维度按钮点不到。**
≤ 620 px 时顶栏隐藏品牌，三个维度按钮完整显示；「皮肤」「换算」收进侧栏底脚，点开后抽屉自动收起，桌面宽度下自动回到顶栏原位。

**Q：搜索不到路径点。**
搜索匹配名称、描述和坐标文本。若该点所在分组被隐藏，地图上不显示但列表仍可搜到；如果是坐标搜索，试试写成 `X Z` 两段（如 `-512 640`）。

---

## 11. 浏览器支持

需要支持 ES Module（`<script type="module">`）、CSS `backdrop-filter` 和 `dvh` 单位的现代浏览器：

- ✅ Chrome / Edge 108+
- ✅ Safari 16+（macOS / iOS）
- ✅ Firefox 110+
- ❌ 不支持 Internet Explorer

页面完全离线：没有 CDN、没有外部字体、没有网络请求（除了本身的 `config.json`、PNG 与 `tiles/` 里的瓦片）。字体使用系统字体（`-apple-system` / `Segoe UI` / `Microsoft YaHei`），坐标用系统等宽字体显示。

---

## 12. 后续可优化项（尚未实现）

以下方向评估过、暂未实施，按性价比排序：

1. **粗层瓦片体积**（收益最大）
   现在粗层比细层还大：L1 平均 103 KB、L2 平均 119 KB，而 L0 只有 48 KB。原因是生成器用 2×2 平均降采样，抗锯齿产生的杂色让 PNG 压不动；移动端默认视野 1024 方块正好落在粗层。可改为「代表色 / 调色板」降采样或对粗层做轻量量化，字节有望减半；代价是远景可能出现轻微马赛克，需要肉眼验收。改动在配置仓库的 `tools/png-to-tiles.mjs`。
2. **缩小方向兜底**
   放大时已能用 LRU 里的粗瓦片先顶替（零额外请求）；缩小时没有更粗层的缓存，新层级到达前会短暂空白（与旧版一致）。可用缓存里的更细层瓦片铺满缺失的粗层格，代价是每格最多 4–16 次额外绘制与去重。
3. **移动端缓存上限自适应**
   已解码瓦片 LRU 固定 400 张（约 100 MB），低端手机可参考 `navigator.deviceMemory` 降到约 150 张；代价是来回缩放更容易重新下载。
4. **测试断言健壮性**
   `tests/probe-freeze.mjs` 的「拖动首尾锐度」阈值与画面内容强相关，在未改动的 HEAD 上同样失败；建议改成相对基线或只保留结构断言（拖动全程零重画、单一 canvas 盒）。
5. **空闲预取**（可选）
   在 `requestIdleCallback` 里预取视口邻域瓦片，拖动进入新区更顺；代价是闲置时多耗流量。

---

## 附：给开发者

接口契约、模块职责、验收标准在 [`docs/CONTRACT.md`](docs/CONTRACT.md) 里；自动化验收的检查项、最近结果与已知限制在 [`docs/QA.md`](docs/QA.md) 里。改样式只需要动 `assets/css/style.css`（颜色变量集中在 `:root`），改逻辑按模块各改各的，`app.js` 里所有跨模块调用都做了存在性检查，缺方法只会警告不会整页崩溃。

```bash
# 纯函数单测（不需要浏览器，最快）
node --test tests/coords.test.mjs

# 静态检查：文件/引用/config/import/CSS 契约（不需要浏览器）
node tests/static-checks.mjs

# 端到端验收：自起静态服务器 + 无头 Edge，约 22s，退出码 0/1
node tests/smoke.mjs
node tests/smoke.mjs --url=http://127.0.0.1:8000/index.html   # 也可指向已启动的服务
```

> 两个 smoke 实例不能同时跑（共用 `tests/artifacts/`，内置 pid 锁会拒绝第二次启动）。
> 测试只依赖本机已安装的 Edge / Chrome，无需 `npm install`。
