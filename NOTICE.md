# NOTICE —— 来源、改动与授权边界

## 一、本项目的血统

`dsh-redpet` 的**代码**（宿主半侧 `lib/index.js`、浏览器半侧 `lib/client.js`、
桌面模式运行时 `runtime/electron-helper/`）是从 **dsh-pet `0.3.5`** 的构建产物改造而来。

- 上游项目：dsh-pet（"吃白饭的蓝色大肥鱼"）
  作者：PC2005-cloud · 仓库：https://github.com/PC2005-cloud/dsh-pet
- 上游授权：**MIT**（见本目录 `LICENSE`，版权行 `Copyright (c) 2026 PC2005-cloud` 原样保留）

MIT 允许修改、再分发与再许可，条件是**保留原版权声明与许可全文**。本目录的 `LICENSE`
即为该原文，未被改动。

## 二、相对上游做了什么改动

| 类别 | 改动 |
|---|---|
| 标识 | 全局把 `dsh-pet` 改名为 `dsh-redpet`：包名、bundle patch 的 id、路由前缀 `/dsh-pet-7340` → `/dsh-redpet-7340`、用户数据目录 `$DSH_HOME/dsh-pet` → `$DSH_HOME/dsh-redpet`、CSS 类名前缀、settings 槽位键、日志前缀 |
| 插件身份 | Cordis 插件名 `pet` → `redpet`（与 dsh-pet 并存时不撞名） |
| 动作 | **106 个精简到 10 个**：`assets/config.jsonc` 的 `animations` 段重写（池子、权重、事件档位全部按 10 个素材重排） |
| 人设 | `whisperPrompt`、`workStatusTexts`（6 档）换成网络安全红队语境 |
| 素材 | 包内只保留 10 段；另有 `docs/01`、`docs/02` 两套提示词用于生成红队自己的素材 |
| 移除 | 独立模式 CLI（`bin.dsh-pet-standalone`、`lib/standalone.js`）——本包只做插件 |
| 新增 | `tools/selftest.mjs`（配置↔素材体检）、`tools/gen-api.mjs`（一键生成 10 段）、`tools/keyscreen.mjs`（绿幕抠像）、`tools/pipeline.mjs`（编排）、`tools/fix-node-modules.ps1`（本机依赖解析） |

## 三、授权边界（重要）

**代码**：MIT，可自由使用、修改、再分发。

**素材**：dsh-pet 的**素材**（角色立绘 / 动作 webm / 表情包 / logo / 字体）与代码**不是同一份授权**，
上游声明为「允许开源使用、禁止商用」。出于谨慎，本仓库**不随包分发任何上游素材**：

- `assets/webm/*.webm` —— 动作素材，由 `.gitignore` 排除，请按 `docs/` 自行生成
- `assets/memes/*.png` —— 表情包，默认关闭，不影响功能
- `assets/logo.png` —— 未在 `package.json` 里声明 `icon`，当前根本没被使用
- `assets/fonts/*.ttf` —— 取不到会回落到系统字体

要向本仓库加入你自己的素材，把 `.gitignore` 里对应的 `!` 例外打开即可。
**请勿**把上游素材直接提交进本仓库后对外发布。

## 四、角色设计

「红队小队员」的**外观设计**（亮红色连体工装、额上护目镜、腰侧全息身份牌、
悬浮全息键盘等）与全部提示词，见 `docs/01-定妆图提示词.md`，属于本项目原创。
角色保留了上游的蓝色长卷发、鲸鱼鳍耳与鲸鱼尾巴等身体特征，用以维持同源画风。
