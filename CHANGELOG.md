# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.6] - 2026-10-15

### 修复

- **安装器第 8 步改用 `Start-Process` 启动监督进程**。原先用 `& wscript.exe <vbs>`，
  子进程会继承安装器的 stdout/stderr；监督进程与注入进程要活好几天，于是那条管道一直不关，
  **任何捕获安装器输出的调用方（脚本、CI、`get.ps1`）都会一直等到监督进程退出（等于永远挂着）**。
  `Start-Process` 走 ShellExecute，不再继承句柄 —— 实测同一调用从「600 秒超时」变成 7.7 秒完成。

## [1.0.5] - 2026-10-15

### 修复

- `get.ps1` 失败时不再抛异常打印堆栈（那看起来像崩了）：作为脚本文件运行时改为
  **打印一行 `ERROR: …` 并以退出码 1 结束**；只有在 `irm … | iex` 这种没有脚本文件的
  场景才仍旧抛出（否则 `exit` 会关掉用户的终端窗口）。
- `get.ps1` 遇到「该 Release 没有 SHA256SUMS.txt」时，除了拒绝安装，还会给出手动下载
  地址与 `-SkipVerify` 的说明。

## [1.0.4] - 2026-10-15

### 新增

- **`get.ps1`：一条命令装完**。取最新 Release 的 zip → 比对 `SHA256SUMS.txt` 里的 SHA-256 →
  解压 → 用**子进程**运行 `install.ps1`（所以 `install.ps1` 的 `exit` 不会关掉你的终端）。
  支持 `-Version` / `-Repo`（fork）/ `-Dest` / `-InstallArgs` / `-SkipVerify`；网络不通或校验
  失败时只报错并打印手动步骤，不留半装状态。
- **Release 附带 `SHA256SUMS.txt`**：打包时生成 `hermes-startup-animation-<tag>.zip` 的校验和，
  手动下载也能核对。
- **`tests/pii.test.mjs`：个人信息护栏**。扫描仓库里所有被跟踪（及新增未提交）的文本文件，
  禁止：非白名单邮箱（允许 GitHub 匿名邮箱 / `github.com` / `example.*`）、写死的用户目录、
  含非 ASCII 字符的绝对路径、手机号 / 身份证号、各类凭据与私钥；并断言本机生成物
  （`config.json` / `paths.json` / `splash-bundle.js`）没被 git 跟踪。可用环境变量
  `HSS_PII_DENY` 传自定义黑名单，本地发布前跑一次即可。

### 变更

- **README 安装章节重写**为三种方式：一条命令（`get.ps1`）、手动下载并校验、`git clone`；
  新增「安装器做了什么，失败会怎样」，明确失败只影响动画、不动 Hermes 本体，并给出回退方式。
- 安全说明补充：下载物可校验、发布包里不含任何生成物、`irm … | iex` 与落盘再跑是同一个脚本。

### 修复

- 修正 1.0.3 条目里已经过时的说法：`v1.0.0`–`v1.0.3` 四个 Release 的附件都已用清理后的源码
  重新构建并替换（附件与仓库源码里都不再出现旧署名），无需再重新上传。

## [1.0.3] - 2026-10-15

### 修复

- 1.0.2 的 CHANGELOG 条目在描述改动时把作者的真实姓名又写了一遍，导致发布包里依然能找到它。
  本条目改为不引用原署名。`v1.0.0`、`v1.0.1`、`v1.0.2` 三个发布包的 `LICENSE` / CHANGELOG
  中仍含旧署名，仓库的旧提交里也是（git 历史不重写）；需要时请把这三个版本的附件重新上传为新构建。

## [1.0.2] - 2026-10-15

### 变更

- **版权行与技能署名改用 GitHub 用户名**：`LICENSE` 的版权行署名人改为 `shl722112752-ui`
  （原为作者真实姓名）；`skill/hermes-startup-animation/SKILL.md` 的 `author` 同步为
  `shl722112752-ui, Hermes Agent`。当前源码与之后发布的包里不再出现作者的真实姓名。
- 上游作者署名照旧：`LICENSE` 附注与 [NOTICE.md](NOTICE.md) 里 `hermes-startup-screen` /
  `dsh-startup-screen` 的作者（沈宏厚）及其 MIT 许可不受本次改动影响，第三方素材的声明也保持不变。

## [1.0.1] - 2026-10-15

### 新增

- 单元测试 `tests/`：用 Node 自带的 `node:test`（无第三方依赖），CI 与打包前都会跑。
  - `schema.test.mjs`：33 项设置的校验规则、面板分组/标签的漂移检查、
    颜色必须是十六进制（回归测试，见下）、补默认值不改原对象。
  - `cdp-port.test.mjs`：调试端口发现优先级（显式 > 环境变量 > 固定 > `DevToolsActivePort`）、
    多份 `DevToolsActivePort` 取最新、垃圾内容与 `0` 的处理。

### 修复

- **新装用户的默认播放方式与文档不一致**：`runtime/schema.mjs` 的 `DEFAULTS.requireInteraction`
  是 `true`（照抄上游本体的默认值），而 [docs/configuration.md](docs/configuration.md) 的键值表
  写的是 `false`。监督进程正是拿这份 `DEFAULTS` 给新机器落盘 `config.json` 的，所以全新安装会
  停在第一幕等确认，而不是文档承诺的自动播完。已改为 `false`；想交互的用户在技能页卡片上切一下，
  或跑 `hermes-splash interactive`。
- **颜色设置其实没被校验过**：`schema.mjs` 里写成 `if (COLORS[key])`，而 `COLORS` 是数组，
  取键永远得到 `undefined`，于是任意字符串都能写进 `config.json`。改为 `COLORS.includes(key)`，
  并补了回归测试。

### 文档

- README 的「目录结构」补上 `tests/`；CONTRIBUTING 增加 `node --test` 与「测试写在哪」一节。
- 安装参数示例里的路径改成中性的 `D:\Apps\Hermes Agent CN Desktop`（原先用的是维护者本机的真实路径）。

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

[1.0.6]: https://github.com/shl722112752-ui/hermes-startup-animation/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/shl722112752-ui/hermes-startup-animation/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/shl722112752-ui/hermes-startup-animation/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/shl722112752-ui/hermes-startup-animation/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/shl722112752-ui/hermes-startup-animation/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/shl722112752-ui/hermes-startup-animation/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/shl722112752-ui/hermes-startup-animation/releases/tag/v1.0.0
