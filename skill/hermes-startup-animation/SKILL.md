---
name: hermes-startup-animation
description: "在 Hermes 内开关与调整桌面启动动画（自动/交互）。"
version: 1.4.0
author: shl722112752-ui, Hermes Agent
license: MIT
platforms: [windows]
metadata:
  hermes:
    tags: [desktop, startup, splash, animation, settings-card, skills-page, webview2, cdp, top-layer, dsh-startup-screen]
    category: software-development
    related_skills: [hermes-desktop-plugins, inspecting-hermes-desktop-dom]
---

# Hermes 桌面启动动画 Skill

控制 **Hermes Agent CN 桌面端**的开机六幕动画（黑幕标识 → 过曝洗白 → 档案底板 →
五步授权 → 色散故障揭幕）。动画本体是插件 `hermes-startup-screen`（改自
DeepSeek Harness 的 `dsh-startup-screen`），通过 WebView2 调试协议注入到窗口里，
**不修改 exe**。

**它是全自动的**：登录自启 + 计划任务双层兜底，注入进程挂了 2 秒内自动重启，
监督进程挂了 2 分钟内自动重启，环境变量/配置/生成物每 60 秒自检修复。
**正常情况下用户不需要做任何操作，你也不需要**——本 skill 主要是「想改设置时怎么改」
和「万一要排查时怎么查」。

改设置有三个入口，改的是同一份 `config.json`：

1. **配置 → 技能 页里的卡片**（推荐）：Hermes 左侧「02 配置 → 技能」(`/skills`)，
   标签行下面就是「启动动画」卡片——启用开关、自动/交互两段开关、预览、完整设置。
2. **抽屉面板**：任何页面按 `Ctrl+Alt+S`，33 项全在里面。
3. **命令行**：`hermes-splash` （`auto` / `interactive` / `set` / `doctor` …）。

## When to Use

- 「启动动画改成交互 / 自动」「开机动画关掉 / 打开」「动画放太快 / 太慢」
- 「在哪改这些设置」——答案是 **配置 → 技能 页顶部的卡片**，或 `Ctrl+Alt+S`；
  也可以由你执行 `hermes-splash panel` 直接把抽屉打开给用户看
- 想改动画文案、配色、身份资料（终端里那句「欢迎 xxx 访问」）
- 「开机动画不播了」这类反馈：**先别急着改代码**——九成是环境问题，跑一次 `doctor` 看现状
  （多数情况系统已经自己修好了，`restart` 只是让修复立刻生效）
- **不要**用于：添加别的桌面 UI 面板或状态栏组件（那是 `hermes-desktop-plugins`）；
  也不要以为能在应用设置页里注册一个新条目——CN 版没有插件宿主，
  设置卡片是注入进技能页的（见「在 Hermes 界面里改」）

## Prerequisites

- Hermes Agent CN 桌面端的位置**不用手填**：安装时已写进
  `%LOCALAPPDATA%\HermesSplash\paths.json` 的 `hermesDir` / `hermesHome`
- 安装目录：`%LOCALAPPDATA%\HermesSplash\`（下称 `$HSS`）
- 这三样装好之后由系统自己维持，**不需要人工看护**；`doctor` 只负责把它们念出来：
  1. `$HSS\splash-bundle.js` 等文件存在（过期会被自动重打包）
  2. 用户级环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=0`
     （丢了或被改成固定端口都会自动改回；端口 0 = Chromium 自己挑空闲端口，
     避免和本机其它 WebView2 应用抢端口）
  3. 登录自启的 `hermes-splash-supervisor.vbs` + 计划任务 `HermesSplashWatchdog`
     （登录触发 + 每 2 分钟），共同保证监督进程与注入进程活着
- 设置界面另需注入进程的本地 API `http://127.0.0.1:9334`；它和注入同生共死，挂了会在 2 秒内被重启

## How to Run

一律通过 `terminal` 工具调用：

```
terminal(command='& "$env:LOCALAPPDATA\HermesSplash\hermes-splash.cmd" interactive')
```

先 `status` 再改，改完 `status` 复核——这是本 skill 的固定节奏。

## Quick Reference

| 命令 | 作用 |
|---|---|
| `hermes-splash panel` | 在 Hermes 窗口里打开设置面板（= 窗口内按 Ctrl+Alt+S） |
| `hermes-splash status` | 设置 + 运行状态（监督进程 / 注入进程 / 调试端口 / 当前是否在播） |
| `hermes-splash interactive` | **交互**：第 1、2 步点按钮 / Enter / 空格继续，Esc 跳过 |
| `hermes-splash auto` | **自动**：六幕一路播完，不停下来等确认 |
| `hermes-splash on` / `off` | 总开关 |
| `hermes-splash mode session\|always\|daily` | 每次启动播一次 / 每次页面加载都播 / 每天一次 |
| `hermes-splash speed <0.35-3>` | 总倍速（1.4 左右能把 24 秒压到 17 秒） |
| `hermes-splash skip on\|off` | 是否显示 SKIP 按钮、是否响应 Esc |
| `hermes-splash set <key>=<value>` | 改任意一项，值按 JSON 解析（字符串要带引号） |
| `hermes-splash get <key>` | 读一项的生效值 |
| `hermes-splash now` | 让改动**立刻**生效：重载 Hermes 窗口，动画会重播一次 |
| `hermes-splash restart` | 重启监督进程（连带重启注入进程；改完源码想立刻生效时用） |
| `hermes-splash doctor` | 12 项只读自检；非 0 退出码表示有不通过项 |
| `hermes-splash reset` | 恢复内置默认（旧文件备份成 `config.json.bak`） |
| `hermes-splash dsh` | 从本地 `dsh-startup.json` 导入设置 |

## 在 Hermes 界面里改

注入的 `src/panel.js` 往窗口里挂两样东西，都读同一个 `config.json`：

### 配置 → 技能 页的卡片

`/skills` 页（左侧「02 配置 → 技能」）标签行下面会插一块卡片：

```
启动动画   Hermes 桌面开机六幕动画 · 由 hermes-startup-animation 技能管理
           [启用 ●]  [自动播放 | 交互确认]  [预览]  [完整设置]
```

- 节点插在 `<main>` 的第 3 个子位置（顶部栏、标签行之后，技能列表之前）；
  用 `main.insertBefore(card, main.children[2] || null)`，所以 React 重渲染或切标签后
  由 2 秒的守护定时器重新插回。路由切走时随页面一起消失。
- 你这页的「我的 Skills」标签里也能看到本 skill 本身（按 SKILL.md 的 description 展示）。
- 前提没满足时（比如 API 不通）卡片里的开关会报保存失败，命令行 `doctor` 会指出哪一项。

### 抽屉面板

- `Ctrl+Alt+S` 打开；`Esc` 关闭（不会漏给动画的「跳过」）。
- 顶部「播放方式：自动播放 / 交互确认」，下面七个分区：播放 / 身份资料 / 语音 /
  界面音效 / 视觉 / 文案 / 面板。
- 改一下即时保存，页脚显示「已保存 · 时间」；保存失败红字提示（通常守护进程没跑）。
- 「预览动画」收起面板播一遍，播完自动收回；交互模式下面板顶上留「预览中 · 点这里回到设置」
  的芯片，不用等动画播完。
- 动画正在播、或停在第一步等确认时，面板照样能开——层级在动画之上
  （面板 2147483400 > 遮罩 2147483000）。
- 窗口左下角的浮动入口按钮**默认已关**；要显示：面板 → 面板 → 显示入口按钮。

## Procedure

### A. 切换自动 / 交互

1. 先看当前值：`hermes-splash get requireInteraction`。
2. 三条路任选：
   - 界面（最省事）：让用户打开「02 配置 → 技能」，卡片上点「自动播放 / 交互确认」；
     或按 `Ctrl+Alt+S` 在抽屉顶部点同样两个按钮。
   - 命令行：`hermes-splash auto`（或 `interactive`）——完成判据：输出里
     `requireInteraction = false/true`。
   - 由你代劳打开界面：`hermes-splash panel`。
3. 想立刻看到效果：`hermes-splash now`——完成判据：输出「已重载 Hermes 窗口」。
   窗口会重播一次动画，交互模式下会停在第 1 幕等用户按 Enter / 点按钮，`Esc` 跳过。
4. 不需要即时效果就跳过第 3 步：设置会在**下次启动 Hermes** 时生效。

### B. 改文案 / 身份 / 配色 / 倍速

1. `hermes-splash status` 看清所有键及其生效值（带 `*` 的是内置默认）。
2. 改：
   - 命令行：`hermes-splash set identity="JOYCE MOORE"`、`set accent=#3b82f6`、`speed 1.4`。
     字符串要按 JSON 写引号；`enabled`/`requireInteraction` 这类布尔项接受 `on`/`off`。
   - 界面里：`hermes-splash panel` 打开面板，一格一格改，改完即时落盘。
3. 生效方式同 A.3 / A.4。全部键的含义见本 skill 末尾的 DSH 对照表。

### C. 「动画不播了」排查

正常情况下**已经自动修好了**（注入进程 2 秒、监督进程 ≤2 分钟、前提条件 ≤60 秒）。
所以先读现状，别急着改东西：

1. `hermes-splash doctor` ——12 项自检。它是**只读诊断**，不修东西：
   - 监督进程 / 注入进程 FAIL → 系统会自己拉起来；想立刻恢复用 `hermes-splash restart`
   - 登录自启 FAIL → `install.ps1` 会补齐（把 `hermes-splash-supervisor.vbs` 放进「启动」文件夹）
   - 调试端口 FAIL → 监督进程会自动补环境变量，但**要下次启动 Hermes 才生效**
   - 看门狗计划任务 FAIL → `install-watchdog.ps1`
2. `hermes-splash get enabled` ——`false` 就是被关了，`hermes-splash on`。
3. 看日志（`doctor` 打印尾部，或 `read_file` 读 `$HSS\supervisor.log` 与 `$HSS\watcher.log`）：
   - `supervisor.log` 有 `watcher spawned (pid …)` 紧跟一次 `watcher exited` → 正在自愈，正常
   - `watcher.log` 有 `injected into http://hermesui.localhost/…` → 注入成功，问题在动画配置
   - 一整段没有 attach → Hermes 没带调试端口启动（当前这个实例没法补救，下次启动即可）
   - `config API listen failed … EADDRINUSE` → 旧进程占着 9334；监督进程会清场，或 `restart`
4. `hermes-splash status` 会显示「监督进程 / 注入进程 / 当前动画」三行，一眼看出谁不在。
5. 卡片在但位置怪 → 卡片每 2 秒按内容重新定位一次，切一下页面或等两秒；结构大改才需要动代码。
6. 换机器 / 大修后 → `install.ps1` 一次性把环境变量、启动项、计划任务补齐并自检，幂等。

### D. 彻底卸载

```
terminal(command='powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\HermesSplash\uninstall.ps1" -Purge')
```
完成判据：输出结尾提示重启 Hermes 后不再播放；exe 从未被修改，无需还原。

## 机制（排查时必须知道）

**设计目标是「装好之后不需要任何人工操作」**，所以常驻的不是一个进程而是两层：

```
登录 / 每 2 分钟
  └─ 计划任务 HermesSplashWatchdog → wscript hermes-splash-supervisor.vbs
       （登录触发 + 每 2 分钟重复；已有监督进程时新进程立刻退出 = 空操作）
            └─ node supervisor.mjs   ← 唯一常驻进程
                 ├─ 每 60 秒自检并修复：环境变量丢了 setx 补回 / config.json 坏了用默认值重建
                 │  （坏文件备份成 .bad-<时间>）/ splash-bundle.js 过期自动重新打包
                 ├─ 接管现场：watcher.pid 里还活着的旧 watcher 先清掉（否则它占着 API 端口）
                 └─ node watcher.mjs（子进程）——退出就 2 秒内重启
                      ├─ 轮询 http://127.0.0.1:9333/json/list
                      ├─ 发现 Hermes 窗口 → 附加 CDP
                      ├─ Page.addScriptToEvaluateOnNewDocument(注入脚本)：覆盖之后每次加载/刷新
                      ├─ 每 700ms 探一次：文档是 hermesui 且还没注入 → 立刻注入
                      │    同时比对 config.json / splash-bundle.js 指纹，变了就重挂 hook
                      └─ 本地 API http://127.0.0.1:9334 （GET/POST /config）
                            ↑ 技能页卡片 + Ctrl+Alt+S 抽屉靠它读写同一份 config.json
Hermes 启动 → 内嵌 CSP 允许 'unsafe-inline' → 注入脚本在黑幕根节点上跑六幕动画 → 揭幕
                 └─ 同一个脚本顺手挂上技能页卡片和抽屉面板，并提升到 top layer
```

三层自愈（**所以正常情况下不需要你或用户做任何事**）：

| 挂掉的东西 | 谁在多久内修好 |
|---|---|
| 注入进程 watcher | 监督进程，**2 秒**（实测 2.6s） |
| 监督进程 supervisor | 计划任务，**≤ 2 分钟**（实测 10s） |
| 环境变量 / 配置 / 生成物 | 监督进程，**≤ 60 秒** |

**动画和抽屉都在 top layer（`popover="manual"` + `showPopover()`）**：应用启动时有自己的
`#hermes-bootstrap-overlay`，用的是 `z-index: 2147483647`（z-index 上限），普通层叠压不过它
——动画开头几秒会被它整块盖住。top layer 绘制在一切 z-index 之上，所以必须走 popover。
代价：排查层级别只看 z-index，要看 `:popover-open`；抽屉面板靠「后 showPopover 者在上」
的规则，动画重播重建遮罩后要把面板再提一次。

四份东西共用一份 schema（`schema.mjs`）：插件本体的默认值、命令行的校验、
守护进程 API 的校验、界面里渲染出来的控件，所以不会出现「命令行能设、卡片设不了」。

三条容易踩的硬事实：

1. **桌面窗口的界面嵌在 exe 里**，走 `hermesui://` 自定义协议。磁盘上没有可改的
   `index.html`（`dashboard\web_dist` 是另一份东西，改它对窗口无效）。所以只能注入。
2. **调试端口必须在 Hermes 进程启动时就带**，中途开不了。因此依赖那个用户级环境变量；
   它丢了会被自动补回，但要**下一次启动 Hermes** 才生效（没法给运行中的进程加参数）。
3. **冷启动时窗口常先以 `about:blank` 出现再导航**，刚注册的 new-document hook 会漏掉
   第一个文档——所以注入进程必须保留「高频补注入」这条路径，两者缺一不可。

## DSH 对照表

本动画是 DSH 插件 `dsh-startup-screen` 的移植，键名一一对应。
DSH 那边在 **DSH 设置页 →「启动动画」**改；Hermes 这边在 `config.json` / `hermes-splash` 改。
DSH 的持久化文件是它 DSH_HOME 下的 `dsh-startup.json`（安装时用 `-DshConfig` 指过路径的话，
位置记在 `$HSS\paths.json` 的 `dshConfig`；`hermes-splash dsh` 会整份导入）。

| DSH 设置项 | Hermes 键 | 取值 |
|---|---|---|
| 启用 | `enabled` | `true` / `false` |
| 显示模式 | `mode` | `session` 每次启动 / `always` 每次加载 / `daily` 每天一次 |
| 主题 | `theme` | `light` 暖白 / `dark` 暗色 |
| 速度 | `speed` | 0.35 – 3 |
| **要求确认** | `requireInteraction` | `true` 交互（第 1、2 步等确认）/ `false` 自动 |
| 允许跳过 | `allowSkip` | 显示 SKIP、响应 Esc |
| 身份名称 / 编号 / 权限等级 | `identity` / `identityId` / `accessLevel` | 第 2 幕身份卡的资料与终幕欢迎语 |
| 语音播报 | `voice` | |
| 语音来源 | `voiceSource` | `asset` 真声素材 / `tts` 系统合成 |
| 音色 | `voiceName` | 留空 = 自动挑 |
| 语速 / 音调 / 音量 | `voiceRate` / `voicePitch` / `voiceVolume` | |
| 播报前提示音 | `voiceCue` | |
| 开口前留白 | `voiceLead` | 0 – 1200 ms |
| 界面音效 | `sound` | |
| 音效音量 | `soundVolume` | 0 – 1 |
| 音效来源 | `sfx` | `audio` 素材 / `synth` 合成 |
| 强调色 / 故障色 A、B | `accent` / `glitchA` / `glitchB` | 形如 `#ff7500` |
| 品牌三行 | `brand1` / `brand2` / `brand3a` / `brand3b` | |
| 黑幕三行 | `orgZh` / `orgEn` / `orgSub` | |
| 终幕方框 / 页脚 | `welcomeBox` / `footer` | |
| 语言 | `voiceLang` | `en` / `zh` / `both` |

**一键对齐 DSH**：`hermes-splash dsh` ——把 DSH 的设置整份导入（`mode` 除外，
DSH 的 `always` 是「每次浏览器刷新都播」，桌面上每次启动播一次用 `session` 更合适）。

## Pitfalls

- **不要为了改设置去重启 Hermes**。改 `config.json` 后 `hermes-splash now` 就够了；
  `now` 会先清掉会话门控再重载，所以重载后一定能看到动画。在技能页卡片/抽屉里改则
  连重载都不用（当前窗口想看到动画点「预览」）。
- **技能页卡片和抽屉都是注入的**，不是应用原生设置页——CN 版没有插件宿主，只能这么干。
  卡片按**内容**定位（找含「内置 Skills / 我的 Skills」的那一行，插到它后面），
  所以页面渐进渲染时也不会掉到页面最末；每 2 秒自查一次位置。应用大版本更新若大改结构，
  卡片可能挪位置；`Ctrl+Alt+S` 始终可用，不受影响。
- **动画和抽屉在 top layer**，压过应用 `z-index: 2147483647` 的启动遮罩。排查层级别只看
  z-index：`document.querySelectorAll(':popover-open')` 才是真相。重播会重建遮罩节点并把
  它排到面板之上，面板开着时会自动把自己再提一次。
- **`#hermes-bootstrap-overlay` 是应用自己的启动遮罩**，别去删它——我们只是盖在它上面。
- **窗口左下角的浮动入口默认已关**（技能页卡片取代了它）。要回来：抽屉 → 面板 → 显示入口按钮。
- **正常情况下什么都不用做**。三层自愈已经在跑（注入 2 秒 / 监督 ≤2 分钟 / 前提条件 ≤60 秒），
  `doctor` 只是把现状念出来、**不修东西**；修东西是监督进程和计划任务的活。
  只有想立刻生效时才需要 `restart`。
- **保存失败 / 卡片消失 = 注入进程没跑**（本地 API 9334 和注入都归它管）。2 秒内会被自动重启；
  页脚会红字提示，`doctor` 也会报。`hermes-splash restart` 只是让恢复立刻发生。
- **`mode: session` 不会在应用内刷新时重播**（守护进程每次附加带一个「本轮启动」token
  区分启动与刷新）。想每次刷新都播用 `mode: always`。
- **`requireInteraction: true` 下动画会真的停在第 1 幕**，不按 Enter / 空格 / 点按钮就
  一直停在黑幕，应用界面被遮住。这是插件设计行为，不是卡死；`Esc` 或右上角 SKIP 可退出。
  给不熟的人用建议 `auto`。面板在这个状态下仍然能开（层级在动画之上），可以一边看一边改。
- **`status` 里的「调试端口」看的是用户级变量**，不是当前 shell 的 —— 当前 shell 没有
  这个变量是正常的。
- **强杀 Hermes 可能留下孤立的 WebView2 进程占住用户数据目录**，下一次启动窗口会空白。
  那是应用自身的脾气，与本 skill 无关；正常退出不会出现。真遇到了，结束
  `msedgewebview2.exe` 里命令行含 `Hermes Agent CN Desktop` 的进程再启动。
- **别用 `hermes-desktop-plugins` 的路子装这个动画**：CN 版没有原生插件宿主，
  `%LOCALAPPDATA%\hermes\desktop-plugins` 不被识别。同理别改 `dashboard\web_dist`——
  窗口不从那加载。
- **新加的 skill 要新会话才可见**：本 skill 在当前会话之后才被登记，重启 Hermes
  或开新会话才会出现在技能列表里。
- 改 `src\plugin.js` 或 `src\panel.js` 后必须重跑 `build-bundle.mjs`，否则改的是源码、
  跑的是旧生成物。`doctor` 会检查生成物不比 `plugin.js` 旧。

## Verification

全部通过 =

1. `hermes-splash doctor` 退出码 0，12 项全 OK（含监督进程、注入进程、设置面板 API、看门狗任务）。
2. `hermes-splash get requireInteraction` 等于你刚设的值。
3. 重启 Hermes（或 `hermes-splash now`）后看得见动画：
   - `auto` → 六幕一路播到揭幕，约 24 秒（`speed: 1`）
   - `interactive` → 停在第 1 幕「授予访问权限 / GRANT ACCESS」，按 Enter 继续
   - `off` → 完全没有黑幕，直接进主界面
4. `hermes-splash status` 的「当前动画」不再显示「本轮未注入」。
5. 界面可用：打开「02 配置 → 技能」，标签行下面能看到「启动动画」卡片（含启用 / 自动播放 /
   交互确认 / 预览 / 完整设置），卡片上改一项后 `config.json` 里那一项确实变了；
   `Ctrl+Alt+S` 能打开抽屉且 `Esc` 能关。
6. **动画盖得住启动页**：冷启动时若还有应用的 `#hermes-bootstrap-overlay`，
   `document.elementFromPoint(窗口中心)` 命中的应该是遮罩内部（`dsu-*`），不是应用的元素；
   `document.querySelectorAll(':popover-open')` 里能看到遮罩。这一条不通过就说明
   top layer 提升没生效（检查 bundle 是否最新）。
7. **自愈还在**（怀疑自动化失效时验一次）：杀掉 `watcher.pid` 里的注入进程，
   几秒内 `supervisor.log` 应出现 `watcher spawned (pid …)`，`status` 里注入进程换成新 pid；
   再杀掉 `supervisor.pid`，2 分钟内它自己回来（计划任务）。两件事都不需要人工干预。
