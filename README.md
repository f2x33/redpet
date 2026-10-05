# dsh-redteam-pet · 红队小队员

> 网络安全红队主题的 **DeepSeek Harness 桌面宠物**。
> 超变形 Q 版小队员：蓝色长卷发 + 呆毛、鲸鱼鳍耳与鲸鱼尾巴，一身**亮红色连体工装**，
> 黑框方眼镜 + 额上护目镜，腰侧挂着青色全息身份牌，双手在胸前托一块**悬浮全息键盘**。
> 你在 DSH 里干活时它陪着（踩点 / 打点 / 卡在授权 / 拿下 / 翻车都有反应），
> 闲下来会碎碎念战况，点它、拖它、右键点播动作都照常。

**血统**：本包是从 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) `0.3.5`（MIT）改造而来 ——
保留它成熟的渲染与投递机制（双 `<video>` 互切、blob 载入素材、SSE 状态帧、右键菜单、设置页），
把**动作从 106 个精简到 10 个**，并把**人设 / 台词 / 工作状态文案 / 配置目录 / 路由前缀**全部换成红队自己的。
两者**完全解耦**：素材、配置、记忆都在各自的目录里，关掉或卸载其中一个不影响另一个。

---

## 一、10 个动作

| 动作名（素材文件名，逐字一致） | 触发时机 |
|---|---|
| `待机呼吸休闲` | 空闲待机，循环播 |
| `东张西望` | 转向（`fixedEnabled: true` 时随机链不抽，右键可点播） |
| `被鼠标拖拽悬空反馈` | 被拖拽时 |
| `点击回应-元气挥手` | 点一下宠物（随机二选一） |
| `点击回应-开心跃动` | 点一下宠物（随机二选一）/ 任务成功 |
| `写代码` | 随机小动作（权重 40） |
| `原地敲击桌面互动` | 随机小动作（权重 40） |
| `工作状态-思考冒泡` | 回合开始（思考）/ 等你授权 / 碎碎念 |
| `工作状态-忙碌点按` | 工具调用中 / 工具返回整理 |
| `工作状态-垂头叹气冒汗` | 回合出错 / 达上限 |

权重账：`idle 10 + turn 5 + move 5 + 随机小动作 (40+40) = 100`。
`moves.actions` 是空的（红队原地干活，不自己走开），余额功能默认关闭（这一版没有余额那 6 段素材）。

---

## 二、安装

### 0. 前置

- DSH `0.2.0-rc.2`（见 `package.json` 的 `dsh.compatibility`）
- Node.js ≥ 22.12

### 1. 建依赖解析链接（**本机从源码目录开发时才需要**）

本包放在 profile 目录**之外**（比如 `D:\...\dsh-redteam-pet`）。Node 的 ESM 解析规则是
「从文件所在目录往上找 `node_modules`」，所以 `lib/index.js` 里那句
`import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'` 永远找不到包，
插件会以 `failed to import` 挂掉。

解法：在包目录里放一个 `node_modules`，里面 3 个 junction 指回 profile：

```
dsh-redteam-pet\node_modules\
├─ @deepseek-ai       -> C:\Users\<你>\.dsh\profiles\node_modules\@deepseek-ai
├─ @electron          -> C:\Users\<你>\.dsh\profiles\web\node_modules\@electron
└─ @electron-internal -> C:\Users\<你>\.dsh\profiles\web\node_modules\@electron-internal
```

一条命令搞定（脚本会识别 junction 与残留目录，只摘链接、不跟进目标）：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\2.dsh\1.红队版数字人\dsh-redteam-pet\tools\fix-node-modules.ps1"
```

> 从 npm 安装（pack 后 `install_bundle` 一个 tgz）的普通用户**不需要**这一步 ——
> 那时包会落在 profile 的 `node_modules` 里，依赖由 pnpm 装好。

### 2. 挂进 DSH

```powershell
# 用 DSH 的插件管理器（会把 link: 写进 profile 的 dependencies）
dsh plugin --profile web install D:\2.dsh\1.红队版数字人\dsh-redteam-pet
```

**插件行不需要包自己插。** 本包的 `cordis.patch.yml` 是**空数组 `[]`**，插件行由
profile 用户层插入（`$DSH_HOME\profiles\web\cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-redteam-pet
      name: 'dsh-redteam-pet'
```

为什么这么绕：**bundle 层是 DSH 启动那一刻的快照**，往 `dsh.profile.bundles` 里加包必须重启；
而**用户层是实时重载的**（`patchReload: live`），存盘即挂载。
两边都插会出**两只宠物**（`insert` 是追加、不按 id 去重），所以只留用户层这一处。

### 3. 停用 / 启用

| 想干什么 | 怎么做 |
|---|---|
| 临时不显示 | 用户层加 `- id: dsh-redteam-pet` + `disabled: true`（存盘即生效） |
| 彻底摘掉 | 删用户层那段 insert + `dsh plugin --profile web remove dsh-redteam-pet` |
| 只隐藏不卸载 | 配置里 `"enabled": false`（本包暂用 `pets[0].display: "none"` 等价） |

### 4. 验证

**一条命令全验收**（只读、不花钱；插件挂载 / 浏览器半侧登记 / 10 段素材来源一目了然）：

```powershell
node tools\verify-live.mjs
```

它检查三件事，并对失败给出具体原因：

| 检查 | 说明 |
|---|---|
| `/config`、`/state` 200 | 宿主半侧挂上了 |
| `/plugins/dsh-redteam-pet/client.js` 200 | **浏览器半侧登记了** —— 这一项**只在 DSH 启动时**扫描，没有重扫入口，所以必须重启过 DSH |
| 10 段 `/thumb/main/<动作名>.webm` 200 | 并告诉你哪几段是**红队自己的素材**、哪几段还是**包内占位**（按 HTTP 返回长度与两个目录比对） |

手动等价命令：

```powershell
# 必须带 Origin，否则会被 DSH 的浏览器信任检查挡成 401
Invoke-WebRequest "http://127.0.0.1:3080/dsh-redteam-pet-7340/config" -Headers @{Origin='http://127.0.0.1:3080'} -UseBasicParsing

# 素材与池子对齐（不用起 DSH）
node tools\selftest.mjs
```

页面上：**刷新（Ctrl+F5）** 就应该在右上角看到它。

---

## 三、素材（那 10 段 webm）怎么来

仓库**不分发** `assets/webm/*.webm`（见 `.gitignore` 里的说明：开发期临时放的是 dsh-pet 的素材，
授权是「允许开源使用、禁止商用」）。自己生成走这条流水线：

```
docs/01-定妆图提示词.md          ① 先生成「红队装定妆图」→ out/定妆图.png
        ↓                          （比例闸门：身高/头宽 ≤ 2.1）
docs/02-10段动作提示词.md        ② 每段两步：图生图（出绿幕静止帧）→ 图生视频（10 秒绿幕视频）
        ↓                          · 全自动：node tools/gen-api.mjs --probe --go（先试水）
        ↓                                    node tools/gen-api.mjs --limit 2 --go（验收 2 段）
        ↓                                    node tools/gen-api.mjs --all --go（全量 10 段）
        ↓                          · 手动：把提示词整段复制进豆包/即梦，下载视频丢进 out/raw/
out/raw/*.mp4                    绿幕原片
        ↓  node tools/keyscreen.mjs --in out/raw --out out/webm
out/webm/*.webm                  640×360 VP9-alpha 透明视频
        ↓  node tools/pipeline.mjs        （拷进用户素材目录 + 体检）
$DSH_HOME/dsh-redteam-pet/main-animation/webm/*.webm
```

**素材查找顺序**：`$DSH_HOME\dsh-redteam-pet\main-animation\webm\` **优先** → 包内 `assets\webm\`。
所以新素材、重做的素材都放用户目录，**包本身永远不用动**。

> 三条铁律（踩过的坑，别再踩）：
> 1. **读 VP9 alpha 必须显式 `-c:v libvpx-vp9`**，默认解码器会静默丢掉 alpha 通道。
> 2. **动作名必须逐字一致**（含中文、连字符）。差一个字：右键菜单有名字，点了 404。
> 3. **背景必须纯绿 `#00FF00`**；生成时关掉水印/字幕/logo。

### 3.1 模型 ID 与「开通」—— 最容易卡住的一步（2026-10-05 真实实测）

脚本里的默认模型 ID 是**占位值、会过期**。真实调用时三种报错的含义完全不同，别搞混：

| 报错 | 到底什么意思 | 怎么办 | 花钱吗 |
|---|---|---|---|
| `404 InvalidEndpointOrModel.NotFound` | 模型 ID 不存在 / 已下线 | 换个 ID | **不花**（生成前就被拒） |
| `404 ModelNotOpen` | **ID 是对的，但你的账号没开通这个模型** | 去方舟控制台「**开通管理**」点开通（开通免费，按量计费） | **不花** |
| `400 InvalidParameter` | 请求参数不全 | 看提示补参数 | **不花** |

> ⚠ **`400` 不能用来判断模型是否存在** —— 参数校验跑在模型校验**之前**，一个完全不存在的假模型名也返回 `400 InvalidParameter`。我们做过对照实验才确认这一点，别看 400 就以为模型是好的。

**零成本列出当前可用的模型 ID**（Ark 是 OpenAI 兼容端点）：

```powershell
$env:ARK_API_KEY = "你的key"
curl.exe -s -H "Authorization: Bearer $env:ARK_API_KEY" `
  "https://ark.cn-beijing.volces.com/api/v3/models"
```

**挑选规则（实测）**：条目里带 **`status: "Shutdown"` 或 `"Retiring"`** 的是已下线/正在下线，调用**必然 404**；**不带 `status` 字段**的才是当前可用。

把选定的 ID 写进 `out\_probe\models.json`（优先级：环境变量 > 这个文件 > 脚本内占位默认）：

```json
{ "image": "doubao-seedream-5-0-pro-260628", "video": "doubao-seedance-2-5-260628" }
```

**验证是否真的能用**：`node tools\gen-api.mjs --probe --go`。ID 不对 → 404，**不产生费用**；正确 → 生成 1 张图 + 1 段视频。

#### 花费：视频按 token 计费，公式可以精确预测

```
tokens ≈ (宽 × 高 × 帧率 × 时长) ÷ 1024        实测 720p/24fps/5s → 108,900 tokens（误差 <1%）
单价：Seedance 2.0（480P / 720P，不含视频输入）= 92 元/百万 tokens
```

| 方案 | tokens/段 | ¥/段 | 10 段合计 |
|---|---|---|---|
| 720p / 10 秒（脚本默认） | 216,000 | ¥19.9 | **¥199** ❌ |
| 720p / 5 秒 | 108,000 | ¥9.9 | ¥99 |
| 480p / 10 秒 | 96,000 | ¥8.8 | ¥88 |
| **480p / 5 秒（推荐）** | 48,000 | ¥4.4 | **¥44** ✅ |

**素材最终要被缩到 640×360，480p 完全够**，比默认的 720p/10 秒省 **78%**。所以：

```powershell
node tools\gen-api.mjs --limit 2 --resolution 480p --duration 5 --go   # 先验收 2 段
node tools\gen-api.mjs --all --resolution 480p --duration 5 --go       # 再全量
```

> ⚠ 480P 与 720P **单价相同**，省钱靠降分辨率（token 少），不是换便宜型号。
> ⚠ 我们用的是 seedance-**2-5**，单价可能高于 2.0；**以方舟控制台账单为准**。
> 📄 完整的实测记录（5 个踩坑、参数、价格推导、验收数据）见 [`docs/03-素材生成实测记录.md`](docs/03-素材生成实测记录.md)。

---

## 四、配置

| 层 | 文件 | 生效方式 |
|---|---|---|
| 包内默认 | `assets/config.jsonc` | 改了刷新页面即可（宿主运行时读盘） |
| 用户覆盖 | `$DSH_HOME\dsh-redteam-pet\main-config.jsonc` | 设置页保存的就是它 |
| 记忆 | `$DSH_HOME\dsh-redteam-pet\memory.json` | 对话历史 |

**合并口径：顶层字段整段替换** —— 你在用户层写了 `animations`，就必须把整个 `animations` 段写全，
缺的子键**不会**从包内那份补回来。

改人设 / 台词看这几处：

| 想改 | 字段 |
|---|---|
| 碎碎念人设 | `whisperPrompt` |
| 6 档工作状态文案 | `workStatusTexts`（`[[thinking...],[working...],[result...],[waiting...],[success...],[error...]]`） |
| 表情包开关 | `whisperImageEnabled` / `chatImageEnabled`（**默认关**，包内那 27 张还是女仆装版本） |
| 宠物显示名 / 大小 / 停靠角 | `pets[0].name` / `size` / `position` |

---

## 五、以后要加动作（10 → N → 106）

**不用改代码、不用重装、不用重启 DSH。**

```
① 生成新素材（提示词可从 dsh-pet 那份 106 段成品里挑，见文末）
② 抠成 640×360 VP9-alpha 的 webm，文件名 = 动作名，丢进
   C:\Users\<你>\.dsh\dsh-redteam-pet\main-animation\webm\
③ 把动作名填进一个池子（三选一）：
   · DSH 设置页 →「红队小宠物」→ 动画池输入框      ← 最省事
   · $DSH_HOME\dsh-redteam-pet\main-config.jsonc
   · 包内 assets/config.jsonc（改出厂默认）
④ 刷新页面（Ctrl+F5）
```

几个要注意的：

- **位移类动作**（会真的走动）不能塞进 `categories`，要写成
  `moves.actions: [{ "name": "螃蟹走路", "params": { "minDist": 120, "maxDist": 320 } }]`。
  本版 `moves.actions` 是空的，所以红队不会自己走开。
- **带文字或左右不对称的**动作，放进分类时标 `"noMirror": true` —— 宠物转向会整体镜像，字会反。
- `events.workStatus` **按索引对档位**（0 思考 / 1 执行 / 2 收结果 / 3 等授权 / 4 成功 / 5 出错），
  只能往末尾追加，不能中间插。
- 想恢复余额功能：补 6 段余额动画 → `pets[0].balanceEnabled: true` → `events.balance` 写成 6 档。

---

## 六、目录结构

```
dsh-redteam-pet\
├─ package.json                 包清单（name / dsh.bundle / dsh.client / peerDependencies）
├─ cordis.patch.yml             故意空数组 []（插件行在 profile 用户层，见第二节）
├─ lib\
│  ├─ index.js                  宿主半侧：路由 /dsh-redteam-pet-7340、配置读写、会话事件、SSE 状态、碎碎念与对话
│  ├─ client.js                 浏览器半侧：宠物渲染 + 右键菜单 + 设置页（settings.section）
│  └─ types\                    类型声明
├─ assets\
│  ├─ config.jsonc              **10 个动作 + 红队人设/台词**  ← 改动作改这里
│  ├─ webm\                     10 段素材（.gitignore 排除，需自行生成）
│  ├─ memes\  pic\  fonts\      表情包 / 图标 / 字体
│  └─ logo.png
├─ runtime\electron-helper\     桌面模式（Electron 透明窗）；本版 display=web，不启用
├─ docs\
│  ├─ 01-定妆图提示词.md         第一步：生成红队装定妆图
│  └─ 02-10段动作提示词.md       第二步：10 段的图生图 + 图生视频提示词
├─ tools\
│  ├─ selftest.mjs              配置 ↔ 素材体检（不用起 DSH）
│  ├─ gen-api.mjs               调火山方舟 API 一把生成 10 段（默认空跑，需 --go）
│  ├─ keyscreen.mjs             绿幕 → VP9-alpha 透明 webm（自动定位 ffmpeg）
│  ├─ pipeline.mjs              一键编排：生成 → 抠像 → 装素材 → 体检
│  └─ fix-node-modules.ps1      重建本机依赖解析链接
└─ out\                         生成过程的中间产物（.gitignore 排除）
   ├─ 定妆图.png
   ├─ raw\                      绿幕原片
   └─ webm\                     抠像结果
```

---

## 七、故障排查

| 症状 | 原因 / 怎么办 |
|---|---|
| 页面上没有宠物，路由 404 | 插件行没挂上：确认 profile 用户层有那段 `insert`；`node_modules\dsh-redteam-pet` 的 junction 在不在 |
| 插件管理器显示 `failed to import` | 包内 `node_modules` 那 3 个 junction 丢了 → 跑 `tools\fix-node-modules.ps1` |
| 插件管理器显示 `cannot resolve profile bundle` | profile 的 `dependencies` 里那条 `link:` 路径不对（包被搬过家）→ 重跑 `dsh plugin --profile web install <新路径>` |
| **两只宠物** | 包 patch 和用户层**都**插了插件行 → 把 `cordis.patch.yml` 改回 `[]` |
| 右键菜单有名字，点了没反应（404） | 素材文件名与配置里的动作名不一致（差空格/连字符/简体繁体）→ `node tools\selftest.mjs` 会列出名字 |
| 素材是透明背景但播放黑底 | VP9 alpha 只有 Chromium 内核认（Chrome/Edge/Electron）；普通播放器显示黑底是正常的 |
| **换了素材，页面上还是旧的那段** | **最容易踩的坑。** 用户目录里的同名素材会覆盖包内素材，但**文件名没变**，而素材路由的响应头是 `cache-control: public, max-age=3600` —— 浏览器最多缓存 **1 小时**，分不出新旧。实测踩到：换成红队素材后，页面上**和直接打开素材 URL** 都还是 dsh-pet 的女仆；同一个 URL 加个 `?v=2` 立刻正常。**已修**：客户端给素材 URL 加了随每次页面加载变化的 `?v=<时间戳>`，**刷新一次即生效**。想确认服务器在传哪一份：跑 `node tools\verify-live.mjs`（按返回字节数与两个目录比对，告诉你每段用的是红队素材还是包内占位） |
| 设置页提示「宿主半侧还没更新」 | 改了 `lib/index.js` 需要**重启 DSH**；只改 `lib/client.js` 刷新页面即可 |
| 插件在，但页面上**看不见宠物** | 先跑 `node tools\verify-live.mjs`。⚠ **`/plugins/dsh-redteam-pet/client.js` 返回 404 不代表有问题** —— 这条路由对命令行不可达（连官方插件、甚至首页 `/` 都是 404/401），脚本会拿官方插件当对照来判断。命令行想确认：查 client 平台的 Slots 占用者，`shell.overlay` 里应有一条 `registrant=pet` 且 `active=true`。浏览器半侧只在 **DSH 启动时**扫描登记，所以首次挂载/改名后要重启 DSH |
| 插件莫名其妙被关掉 | `dshmarket` 会把它的开关状态同步成用户层里一行裸的 `- id: dsh-redteam-pet / disabled: true`。查 `$DSH_HOME\profiles\web\.dsh-market\state.json` 的 `disabled` 列表，并删掉那一行 |
| 启动时插件被 `dsh-safe` 隔离 | 那是"启动保险丝"：插件启动失败时它会把该行置为 disabled（记在 `$DSH_HOME\dsh-safe\quarantine.json`）。修好插件后：`dsh-safe restore --profile web --id dsh-redteam-pet` |
| 跑 `pipeline`/`keyscreen` 时看到 `⚠ 首选 ffmpeg 不能做 VP9-alpha` | **正常现象**：本机 PATH 上那个 ffmpeg（剪映/IDE 自带的）没有 `libvpx-vp9` 编码器，脚本自动换用兜底候选。脚本退出码仍是 **0**；想固定用哪个就设 `$env:FFMPEG` |
| 改了 `cordis.patch.yml` 但没生效 | 加载器的实时重载偶尔会卡在 `previous operation is still pending`（反复快速改文件容易触发）→ **重启 DSH** |

---

## 八、授权与致谢

- 本包代码源自 **dsh-pet 0.3.5**（作者 PC2005-cloud，MIT），在此基础上做红队化改造。
  MIT 允许修改与再分发，**保留原 `LICENSE`** 与本节署名即可。
- 本仓库**不包含** dsh-pet 的素材。`assets/webm/` 由 `.gitignore` 排除，请按 `docs/` 自行生成。
- 完整 106 段动作的红队换装提示词成品（历史版本）在
  `workbuddy1\dsh-redpet\docs\02-106段提示词（红队换装版）.md`，以后从 10 扩到 106 时可直接取用。
