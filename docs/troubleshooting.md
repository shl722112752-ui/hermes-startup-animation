# 排障

**先记住一件事：正常情况下这套东西会自己修好。** 注入进程挂了 2 秒内自动重启，
监督进程挂了 2 分钟内自动重启，环境变量 / 配置 / 生成物每 60 秒自检修复。
所以遇到问题先**看现状**，不要急着重装。

```powershell
$h = "$env:LOCALAPPDATA\HermesSplash\hermes-splash.cmd"
& $h doctor      # 13 项只读自检
& $h status      # 监督进程 / 注入进程 / 调试端口 / 当前是否在播
```

日志：`%LOCALAPPDATA%\HermesSplash\supervisor.log` 和 `watcher.log`。

---

## 动画不播

按这个顺序看：

1. **`doctor` 里"调试端口环境变量正确（用户级）"是不是 FAIL**
   调试端口是**进程启动参数**，只能由启动时的环境变量打开。
   监督进程会自动把它补回来，但**要下次启动 Hermes 才生效**——
   当前这个已经在跑、且没带该变量的实例无法中途注入（任何方案都做不到）。
   → 关掉 Hermes 再启动一次即可。

   > 期望值是 `--remote-debugging-port=0`（让 Chromium 自己挑空闲端口）。
   > 如果这里显示的是一个固定端口，说明有人固定过端口——固定端口会被本机其它
   > WebView2 应用抢（实测被「微软电脑管家」抢过），重跑 `install.ps1` 即可改回自动。

2. **"监督进程 / 注入进程在运行"是不是 FAIL**
   是的话等 2 秒（会自愈）或 `hermes-splash restart`。日志里应该能看到
   `watcher exited` 紧跟 `watcher spawned`。

3. **`watcher.log` 里有没有 `injected into http://hermesui.localhost/…`**
   - 有 → 注入成功，问题在动画自身：`hermes-splash get enabled` 是不是 `false`？
     `mode` 是不是 `daily` 而今天已经播过？
   - 完全没有 → 窗口没带调试端口起来（见第 1 条）。

4. **`status` 的"当前动画"写着什么**
   - `正在播放（第 N 幕）` → 正常
   - `本轮已播完` → 这一次已经播过了（`mode: session` 下应用内刷新不会重播）
   - `本轮未注入` → 注入进程没连上这个窗口

---

## 设置卡片找不到

`配置 → 技能` 页顶部那张「启动动画」卡片由注入进程挂上去，所以**卡片消失几乎总是
注入进程没跑**（它一死，动画也一起停）。

- `hermes-splash status` 看"注入进程"；`doctor` 也会报。
- 2 秒内会自愈；想立刻恢复：`hermes-splash restart`，然后重载窗口
  （`hermes-splash now`）。
- 如果进程正常但卡片位置不对：卡片每 2 秒按内容（含「内置 Skills / 我的 Skills」的
  那一行）重新定位一次，切一下页面或等两秒。

## 动画被启动页遮住

那是最早版本的毛病，原因是应用自己的启动遮罩 `#hermes-bootstrap-overlay` 用了
`z-index: 2147483647`（上限），普通层叠压不过。现在动画遮罩被提升到 **top layer**
（`popover="manual"`），已经修好。

如果还有这个现象，说明跑的是旧生成物：`doctor` 的"生成物不比源码旧"应该 FAIL，
监督进程会自动重打包，或手动：

```powershell
node "$env:LOCALAPPDATA\HermesSplash\build-bundle.mjs"
& "$env:LOCALAPPDATA\HermesSplash\hermes-splash.cmd" restart
```

## 面板里"保存失败"

设置界面靠注入进程起的本地 API（`127.0.0.1:9334`）。保存失败 = 那个进程没跑
或者端口被别的进程占着（日志里会是 `config API listen failed … EADDRINUSE`）。

- 等 2 秒自愈，或 `hermes-splash restart`。
- 注入进程会把残留的旧进程清掉再启动，所以这种情况现在基本只出现在手动起了两个进程时。

## `hermes-splash` 命令报找不到 node

生成的 `hermes-splash.cmd` 会先试安装时的 Node 路径，再试 PATH 里的 `node`。
如果两个都不可用，重跑一次安装器即可（它会重新发现 Node）：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Hermes 自带的 Node（`<HermesDir>\data\versions\<版本>\node\node.exe`，≥22）也可以直接用。

## 想彻底重来

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge
powershell -ExecutionPolicy Bypass -File install.ps1
```

`config.json` 会被删掉（连同目录）。想保留设置就先备份它。

## 强杀 Hermes 之后窗口空白

有时强杀会留下孤立的 WebView2 进程占住用户数据目录，导致下次启动窗口空白。
这是应用/WebView2 自身的行为，与本项目无关。结束命令行里含
`Hermes Agent CN Desktop` 的 `msedgewebview2.exe` 进程再启动即可。
