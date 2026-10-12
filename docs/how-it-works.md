# 工作原理

## 1. 为什么只能注入

Hermes Agent CN 桌面版是 **Tauri 应用**，界面资源被压缩后**嵌在
`hermes-agent-cn-desktop.exe` 里**，通过 `hermesui://` 自定义协议提供给 WebView2 窗口。
由此推出三件事：

| 事实 | 现场证据 |
|---|---|
| 窗口界面不是从磁盘加载的 | 窗口地址是 `http://hermesui.localhost/index.html`（对应 exe 内部的 `hermesui://localhost/index.html`），界面资源名能在 exe 二进制里直接搜到 |
| 往 webview 目录放文件没用 | 请求未知路径返回 `200 text/html`——一律回落到 `index.html` |
| CN 版没有原生插件宿主 | exe 里搜不到 `desktop-plugins`，官方插件目录不被识别 |

好消息是 exe 内嵌的 CSP 允许内联脚本：

```
script-src 'self' 'unsafe-inline' hermesui: http://hermesui.localhost;
img-src 'self' data: blob: ...;  media-src 'self' data: blob:;  style-src ... 'unsafe-inline'
```

`'unsafe-inline'` 让注入的内联脚本可执行，`data:`/`blob:` 让动画内嵌的音视频素材可用；
动画本体不含 `eval` / `new Function`，所以不需要 `'unsafe-eval'`。

**唯一入口**就是 WebView2 的调试协议：往页面里同步求值一段自包含脚本。
需要用户在启动 Hermes 之前就有 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`（调试端口是
**启动参数**，没法给运行中的进程加）。

### 端口不能写死

这个环境变量是**用户级**的，对本机**所有** WebView2 应用都生效。写死一个端口就等于
"谁先启动谁占"——实测 9333 被「微软电脑管家」的 WebView2 抢走，Hermes 于是完全没有
调试端口，动画静默失效。

所以默认写 `--remote-debugging-port=0`：Chromium 自己挑一个空闲端口，并把实际端口写进
**该应用 user-data-dir 下的 `DevToolsActivePort`**。我们只读 Hermes 自己那一份
（`<HermesDir>\data\webview2\*\DevToolsActivePort`），于是：

- 不可能和其它 WebView2 应用撞端口；
- 不可能误连到别的应用上（端口是每个应用独立分配的）；
- Hermes 重启后端口会变，注入进程连不上时会丢弃缓存重新读文件，所以照样能接上。

`paths.json` 里的 `cdpPort` 为 `0` 表示自动，正数表示固定端口（给明确要这么干的用户）。

## 2. 为什么是两层进程

```
登录 / 每 2 分钟
  └─ 计划任务 HermesSplashWatchdog → hermes-splash-supervisor.vbs（无窗口）
       └─ supervisor.mjs   ← 唯一常驻进程
            ├─ 每 60 秒自检修复
            ├─ 清掉残留的旧注入进程
            └─ watcher.mjs（子进程，退出即 2 秒内重启）
```

| 挂掉的东西 | 谁修 | 实测恢复时间 |
|---|---|---|
| 注入进程 `watcher` | 监督进程 `supervisor` | 2.6 秒 |
| 监督进程 `supervisor` | 计划任务（登录 + 每 2 分钟） | 10 秒（最坏 2 分钟） |
| 环境变量 / `config.json` / `splash-bundle.js` | 监督进程 | ≤ 60 秒 |

**单实例不用 pid 判断**：重启之后 pid 会被复用，pid 文件里的旧号可能正好落在别的进程上，
监督进程就会误以为"已有实例"而永远不启动（这是实测踩到过的 bug）。现在监督进程
**绑定一个专属回环端口（默认 9335）作为互斥锁**，跨重启、跨 pid 复用都可靠；
pid 文件只用于展示。

## 3. 注入的两条路径

冷启动时窗口常常先以 `about:blank` 出现、随后才导航到 `hermesui`。刚注册的
`Page.addScriptToEvaluateOnNewDocument` 会漏掉第一个文档（实测如此），所以注入进程
**两条路都留**：

1. 注册 new-document hook —— 覆盖之后每一次文档加载 / 刷新；
2. 每 700ms 探测一次：文档已经是 `hermesui` 且还没注入 → 立刻求值注入。

同时它比对 `config.json` 与 `splash-bundle.js` 的指纹，变了就重挂注入脚本，
所以改设置不需要重启进程。

另外每次附加会带一个**「本轮启动」token**：WebView2 的 `sessionStorage` 跨应用重启存活，
只有区分出"新一次启动"才能让 `mode: session` 真正做到"每次启动播一次、应用内刷新不重播"。

## 4. 为什么必须进 top layer

应用启动时自己有一个全屏遮罩 `#hermes-bootstrap-overlay`，用的是
**`z-index: 2147483647`** —— z-index 的上限。普通层叠里没有任何值能压过它，
动画开头几秒会被它整块盖住（实测 8.5s 时窗口中心的最上层元素是它而不是动画）。

top layer（`popover` / `dialog`）绘制在一切 z-index 之上，所以给动画遮罩加
`popover="manual"` 再 `showPopover()`，并抵消 popover 的 UA 默认样式
（`fit-content`、`margin:auto`、border/padding）——但**不动 background**，
黑幕底色仍由动画自己的 CSS 负责。设置抽屉同理；动画重播会重建遮罩节点并把新 popover
排到上面，所以抽屉开着时会再把自己提一次。

> 副作用：排查层级问题时别只看 z-index。真相是
> `document.querySelectorAll(':popover-open')`。

## 5. 为什么可以放心卸载

- **exe 从未被修改**：升级、回滚、重装 Hermes 都不会与它冲突。
- **失败是安全的**：整套东西全挂掉时 Hermes 照常启动，只是没有动画，不会白屏或卡住。
- **都在用户空间**：安装目录在 `%LOCALAPPDATA%`，自启在「启动」文件夹，兜底是一个
  登录用户级计划任务，环境变量写在 `HKCU\Environment`——不需要管理员。
