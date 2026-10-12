# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-12

首个公开版本。

### 新增

- 通过 WebView2 调试协议向 Hermes 桌面窗口注入六幕开机动画，**不修改 exe**。
- 注入进程同时提供本地设置 API（`127.0.0.1:9334`），界面与命令行共用同一份 `config.json`。
- 窗口内设置界面（`runtime/src/panel.js`）：
  - `配置 → 技能` 页顶部一张「启动动画」卡片（启用 / 自动·交互 / 预览 / 完整设置）；
  - `Ctrl+Alt+S` 抽屉面板，七个分区共 33 项，改一下即时保存。
- 监督进程 `supervisor.mjs`：注入进程退出后 2 秒内重启；
  每 60 秒自检并修复环境变量、`config.json`、`splash-bundle.js`。
- 计划任务 `HermesSplashWatchdog`（登录触发 + 每 2 分钟）保证监督进程存活。
- 幂等的 `install.ps1`：自动发现 Hermes 安装目录、`HERMES_HOME`、可用 Node（≥22），
  生成与本机匹配的启动器和命令行包装，装好启动项与计划任务并自检。**无需管理员权限**。
- `uninstall.ps1`：停止进程、移除自启（含计划任务）、可选移除技能与安装目录。
- Hermes 技能 `hermes-startup-animation`，让 Hermes Agent 自己也知道怎么改这些设置。
- DSH 设置导入：`hermes-splash dsh` 可从本机 `dsh-startup.json` 整份搬过来。

### 修复（这些是开发过程中真实踩到的坑）

- **调试端口被别的应用抢走**：用户级环境变量对所有 WebView2 应用都生效，固定端口就是
  "谁先启动谁占"——实测 9333 被「微软电脑管家」占走，Hermes 完全没有调试端口、动画静默失效。
  改为默认 `--remote-debugging-port=0`（Chromium 自己挑空闲端口并写进 `DevToolsActivePort`），
  注入进程只读 Hermes 自己那一份文件。
- **动画被应用的启动遮罩盖住**：应用自己的 `#hermes-bootstrap-overlay` 使用
  `z-index: 2147483647`（上限），普通层叠无法压过。改为把动画遮罩提升到
  top layer（`popover="manual"` + `showPopover()`）。
- **重启后整套不再启动**：原先用 pid 文件判断监督进程是否存活，重启后 pid 会被复用，
  旧号落在别的进程上就会一直认为"已有实例"。改为**绑定回环端口（9335）作为互斥锁**。
- **改了设置不生效**：注入脚本原先在附加时缓存，页面重载时被旧 hook 覆盖。
  改为按 `config.json` / `splash-bundle.js` 指纹重新挂载。
- **应用内刷新会重播动画**：WebView2 的 `sessionStorage` 跨应用重启存活，
  原先只能无条件清除门控。改为每次附加带"本轮启动"token，`mode: session` 语义正确。
- **技能页卡片可能掉到页面最末**：原先按 `main.children[2]` 硬编码索引定位，
  页面是渐进渲染的。改为按内容定位并每 2 秒自查位置。
- **注入进程被外部杀掉后静默失效**：现在由监督进程 + 计划任务两层兜底。
- 设置面板保存失败时给出明确提示；交互动画停住时面板仍可打开（层级在动画之上）。

[1.0.0]: https://github.com/OWNER/hermes-startup-animation/releases/tag/v1.0.0
