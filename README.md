<div align="center">

# Hermes 启动动画

**给 Hermes Agent CN 桌面端加上六幕电影感开机动画** —— 全自动、零维护、不改 exe。

黑幕标识 → 过曝洗白 → 档案底板 → 五步授权 → 色散故障揭幕

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6.svg)](#环境要求)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933.svg)](#环境要求)
[![No admin](https://img.shields.io/badge/admin-not%20required-success.svg)](#安装)

<!-- 想加演示：把录屏存成 docs/demo.gif，然后去掉下面这行的注释 -->
<!-- ![演示](docs/demo.gif) -->

</div>

---

## 这是什么

Hermes Agent CN 桌面版把界面**嵌在 exe 里**（Tauri + WebView2，走 `hermesui://` 协议），
磁盘上没有可以改的 `index.html`，也没有原生插件宿主——所以常见的“装个插件”路子走不通。

本项目换了个入口：通过 **WebView2 调试协议**往窗口里注入一段自包含脚本，让
[hermes-startup-screen](https://github.com/OMOX563/hermes-startup-screen)
的六幕开机动画在每次启动时播放。**不修改 `hermes-agent-cn-desktop.exe`**，
应用升级、回滚、卸载都不受影响；整套东西全挂掉时 Hermes 照常启动，只是没有动画。

## 特性

- **六幕启动动画**，播放完自动揭幕进主界面
- **可交互**：第 1、2 步等你点「授予访问权限」（可切换成自动播完）
- **在 Hermes 里改设置**：`配置 → 技能` 页顶部的卡片，或任意页面按 `Ctrl+Alt+S`
  打开抽屉，33 项实时生效（文案、配色、身份资料、语音、音效、倍速…）
- **全自动运行**：登录自启 + 计划任务双层兜底；注入进程挂了 2 秒内自动重启，
  监督进程挂了 2 分钟内自动重启，环境变量/配置/生成物每 60 秒自检修复
- **不碰应用本体**，不需要管理员权限，不影响 Hermes 更新

## 安装

**不需要管理员权限**，装完即用。

### 一键（推荐）

```powershell
git clone https://github.com/shl722112752-ui/hermes-startup-animation.git
cd hermes-startup-animation
powershell -ExecutionPolicy Bypass -File install.ps1
```

没有 git 也可以：

```powershell
$z = "$env:TEMP\hsa.zip"
Invoke-WebRequest https://github.com/shl722112752-ui/hermes-startup-animation/archive/refs/heads/main.zip -OutFile $z
Expand-Archive $z "$env:TEMP\hsa" -Force
powershell -ExecutionPolicy Bypass -File "$env:TEMP\hsa\hermes-startup-animation-main\install.ps1"
```

安装器会自己找到 Hermes 安装目录、`HERMES_HOME` 和可用的 Node，然后：
装上运行时 → 把设置面板需要的启动器按本机情况生成 → 设置调试端口环境变量 →
放进「启动」文件夹 → 注册计划任务 → 立刻启动 → 跑一遍自检（12 项；Hermes 窗口开着时 13 项）。

结束后**启动一次 Hermes** 就能看到动画（脚本运行前就已经开着的那个窗口不会补播）。

### 常用参数

```powershell
# Hermes 装在非常规位置时
powershell -ExecutionPolicy Bypass -File install.ps1 -HermesDir "D:\Apps\Hermes Agent CN Desktop"

# 自定义安装目录 / 端口
powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir "$env:LOCALAPPDATA\HermesSplash" -CdpPort 9333

# 只装运行时，不动自启和计划任务（调试用）
powershell -ExecutionPolicy Bypass -File install.ps1 -NoStartupEntry -NoTask -SkipStart
```

| 参数 | 说明 |
|---|---|
| `-HermesDir` | 含 `hermes-agent-cn-desktop.exe` 的目录；默认从注册表/常见路径/运行中进程自动识别 |
| `-InstallDir` | 安装目录，默认 `%LOCALAPPDATA%\HermesSplash` |
| `-HermesHome` | 默认 `<HermesDir>\data\hermes-home` |
| `-NodePath` | 默认取 PATH 或 Hermes 自带的 Node（要求 ≥ 22） |
| `-DshConfig` | 可选，本机 `dsh-startup.json`，只影响 `hermes-splash dsh` 导入命令 |
| `-CdpPort` | 调试端口。**默认 `0` = 让 Chromium 自己挑空闲端口**（推荐，见下方"安全说明"）；填正数则固定端口 |
| `-ApiPort` | 设置面板 API 端口，默认 9334 |
| `-NoSkill` / `-NoStartupEntry` / `-NoTask` / `-SkipStart` | 跳过对应步骤 |

## 使用

### 在 Hermes 界面里改（推荐）

1. **配置 → 技能**（左侧「02 配置」→「技能」，即 `/skills`）：标签行下方有一张
   「启动动画」卡片，含启用开关、`自动播放 / 交互确认`、预览、完整设置。
2. **任意页面按 `Ctrl+Alt+S`**：抽屉式面板，七个分区共 33 项，改一下即时保存。

改动立刻写进 `config.json`；想让当前窗口立刻看到效果，点面板里的「预览动画」。

### 命令行

```powershell
& "$env:LOCALAPPDATA\HermesSplash\hermes-splash.cmd" status
```

| 命令 | 作用 |
|---|---|
| `panel` | 在 Hermes 窗口里打开设置面板 |
| `status` | 设置 + 运行状态（监督进程 / 注入进程 / 调试端口 / 是否在播） |
| `interactive` / `auto` | 交互确认 / 自动播完 |
| `on` / `off` | 总开关 |
| `mode session\|always\|daily` | 每次启动播一次 / 每次加载都播 / 每天一次 |
| `speed <0.35-3>` | 总倍速 |
| `skip on\|off` | 是否显示 SKIP、是否响应 Esc |
| `get <key>` / `set <key>=<value>` | 读写单项 |
| `now` | 让改动立刻生效（重载窗口，动画重播一次） |
| `restart` | 重启监督进程（连带重启注入进程） |
| `doctor` | 13 项只读自检（条件项在 Hermes 未运行时报 SKIP，不算失败） |
| `reset` | 恢复默认值 |
| `dsh` | 从本机 DSH 的 `dsh-startup.json` 导入设置 |

配置项含义与 DSH 设置项的对应关系见 [docs/configuration.md](docs/configuration.md)。

## 工作原理

```
登录 / 每 2 分钟
  └─ 计划任务 HermesSplashWatchdog → hermes-splash-supervisor.vbs（无窗口）
       └─ supervisor.mjs   ← 唯一常驻进程
            ├─ 每 60 秒自检修复：环境变量 / config.json / splash-bundle.js
            ├─ 清掉残留的旧注入进程（否则它会占着设置 API 端口）
            └─ watcher.mjs（子进程，退出即 2 秒内重启）
                 ├─ 轮询 CDP，发现 Hermes 窗口就附加
                 ├─ 注册 new-document hook + 高频补注入（冷启动时窗口先出现在 about:blank）
                 └─ 本地设置 API（127.0.0.1:9334），界面设置就靠它读写 config.json

Hermes 启动 → 注入脚本在黑幕根节点上播放六幕动画
              └─ 遮罩被提升到 top layer（popover），压过应用自己的启动遮罩
```

细节（为什么必须注入、为什么必须进 top layer、自愈层级）见
[docs/how-it-works.md](docs/how-it-works.md)。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1          # 停用 + 移除自启，保留文件
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge   # 连安装目录一起删
```

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| 应用 | Hermes Agent CN 桌面版（Tauri + WebView2） |
| Node | ≥ 22（Hermes 自带的 `data\versions\<版本>\node\node.exe` 就够用） |
| 权限 | 不需要管理员（全部按用户配置） |

## 排障

绝大多数情况**已经自动修好了**——注入进程 2 秒、监督进程 ≤2 分钟、前提条件 ≤60 秒。
先看现状再动手：

```powershell
& "$env:LOCALAPPDATA\HermesSplash\hermes-splash.cmd" doctor
& "$env:LOCALAPPDATA\HermesSplash\hermes-splash.cmd" status
```

常见情况（动画不播、卡片找不到、被启动页遮挡等）见
[docs/troubleshooting.md](docs/troubleshooting.md)。

## 目录结构

```
install.ps1 / uninstall.ps1     安装/卸载（幂等，自动发现环境）
runtime/                        安装到 %LOCALAPPDATA%\HermesSplash 的内容
  supervisor.mjs                监督进程（自愈 + 前提条件自检）
  watcher.mjs                   注入进程（CDP 注入 + 本地设置 API）
  config-cli.mjs                命令行
  schema.mjs                    设置 schema 单一真源
  build-bundle.mjs              把 src/ 打包成自包含注入脚本
  src/plugin.js                 动画本体（上游 MIT）
  src/panel.js                  窗口内设置界面（技能页卡片 + 抽屉）
skill/                          Hermes 技能：装进 HERMES_HOME\skills\
docs/                           原理 / 配置 / 排障
tests/                          单元测试（node:test，`node --test` 直接跑）
```

## 安全说明

- **调试端口默认是随机的**：环境变量写的是 `--remote-debugging-port=0`，Chromium 自己挑一个
  空闲端口，并把实际端口写进 Hermes 自己的 `DevToolsActivePort`；本项目只读那一份。
  这样既不会和本机其它 WebView2 应用抢端口（实测被"微软电脑管家"抢走过固定端口，
  结果 Hermes 完全没有调试端口），也顺带让端口不可预测。
  用 `-CdpPort <n>` 可以改成固定端口，但**不推荐**。
- 设置 API 监听 `127.0.0.1:9334`，**只监听回环**，且只接受来自 Hermes 窗口
  （`hermesui://localhost` / `http://hermesui.localhost`）的跨源请求：别的网页对着这个
  端口发 `fetch` 会被 403 挡掉（没有 `Origin` 头的本机脚本与 CLI 照常放行）。
  本机任意进程仍然可以直接读写 `config.json`——不接受这个前提就不要装。
- 本项目需要用户级环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`。它是 WebView2 的
  通用变量，本机其它 WebView2 应用也会带上它（端口 0 时它们各自随机，互不干扰）。
- 卸载会移除这个变量（仅当它仍是本项目写入的形态）。

## 贡献

欢迎 Issue / PR。改动画本体请直接改 `runtime/src/plugin.js`，然后重新打包：

```powershell
node runtime/build-bundle.mjs
```

监督进程每 60 秒检查生成物是否过期，过旧会自动重打包；想立刻生效用
`hermes-splash restart`。

## 致谢与许可

- 动画本体来自 **沈宏厚** 的 [`hermes-startup-screen`](https://github.com/OMOX563/hermes-startup-screen) /
  `dsh-startup-screen`（MIT），本仓库是其移植 + 注入/自愈/设置层。
- 动画中的音频与视觉素材为**第三方素材，不在 MIT 范围内**，本项目不对其主张权利。
  使用前请阅读 [NOTICE.md](NOTICE.md)。
- 本项目原创部分：MIT，见 [LICENSE](LICENSE)。
- 非官方项目，与 Hermes Agent 中文社区、DeepSeek 无隶属关系。

---

<details>
<summary><b>English</b></summary>

A six-scene cinematic boot animation for the **Hermes Agent CN desktop app** (Tauri/WebView2),
injected over the WebView2 DevTools protocol because the app's UI ships embedded inside the exe
and has no plugin host. The exe is never modified.

```powershell
git clone https://github.com/shl722112752-ui/hermes-startup-animation.git
cd hermes-startup-animation
powershell -ExecutionPolicy Bypass -File install.ps1
```

The installer auto-detects the Hermes install directory, `HERMES_HOME` and a usable Node (≥22),
then installs a supervised injector that survives reboots, crashes and process cleaners
(2 s self-heal for the injector, ≤2 min for the supervisor, 60 s for prerequisites).

Settings live in the app: **Config → Skills** has a card, and `Ctrl+Alt+S` opens a drawer with
33 live options. No admin rights required; nothing about the app itself is patched.

The animation itself is a port of [hermes-startup-screen](https://github.com/OMOX563/hermes-startup-screen)
(MIT, by 沈宏厚); its audio/visual assets are third-party material **not** covered by the MIT
license — see [NOTICE.md](NOTICE.md).

</details>
