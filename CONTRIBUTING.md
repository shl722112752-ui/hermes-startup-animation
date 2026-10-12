# 贡献指南

欢迎 Issue 和 PR。这个项目只做一件事：**让 Hermes Agent CN 桌面端在启动时播放一段动画**，
所以范围之外的改动（应用本体、其它 UI 改动）请提 Issue 讨论而不是直接 PR。

## 开发环境

- Windows 10/11
- Node ≥ 22（Hermes 自带的 `data\versions\<版本>\node\node.exe` 也能用）
- 装了 Hermes Agent CN 桌面版

## 目录约定

```
runtime/          安装到 %LOCALAPPDATA%\HermesSplash 的内容（扁平结构，别加子目录层级）
runtime/src/      动画本体 plugin.js（上游）+ 窗口内设置面板 panel.js
install.ps1       安装器：负责所有“机器相关”的事（发现路径、生成启动器、注册自启）
uninstall.ps1     卸载器
skill/            Hermes 技能
docs/             原理 / 配置 / 排障
```

**不要把绝对路径写进 `runtime/` 里的代码**。机器相关信息一律由 `install.ps1` 写进
`paths.json`，代码从那里读。这是这个项目能被别人安装的前提。

## 改动画 / 改面板

1. 改 `runtime/src/plugin.js`（动画）或 `runtime/src/panel.js`（设置界面）。
2. 重新打包：`node runtime/build-bundle.mjs`
3. 让运行中的实例用上新代码：`& "$env:LOCALAPPDATA\HermesSplash\hermes-splash.cmd" restart`

`runtime/splash-bundle.js` 是生成物，**不入库**；监督进程发现它缺失或比源码旧会自动重建。

## 改设置项

设置项的键名、默认值、取值范围、中文标签都集中在 `runtime/schema.mjs`，
命令行、本地 API、设置面板、文档四处共用它。加一项的步骤：

1. 在 `schema.mjs` 的 `DEFAULTS` / `LABELS` / `GROUPS` 里加（数值或枚举再加到
   `RANGES` / `ENUMS` / `ENUM_LABELS`）；
2. 确认动画本体（`runtime/src/plugin.js` 的 `DEFAULTS` / `normalize`）认识这个键；
3. 更新 `docs/configuration.md`。

## 编码约定

- `.ps1` / `.vbs` 一律 **纯 ASCII**（Windows PowerShell 5.1 会按 ANSI 读无 BOM 的
  `.ps1`，WScript 也按 ANSI 读 `.vbs`，非 ASCII 会被解码坏掉）。
  需要写中文路径时：`.ps1` 里由用户环境取出、`install.ps1` 用明确编码写文件
  （`.vbs` 写 UTF-16，`.cmd` 写 ANSI，`paths.json` 写无 BOM 的 UTF-8）。
- 失败要安全：任何异常都不能让 Hermes 起不来，也不能白屏。注入层全挂时应用应当照常可用。
- 不修改 `hermes-agent-cn-desktop.exe`，也不假设它有插件宿主。

## 提交前

```powershell
# Node 语法
Get-ChildItem runtime -Recurse -Include *.mjs | ForEach-Object { node --check $_.FullName }
# 打包能过
node runtime/build-bundle.mjs
# 安装器语法
[void][System.Management.Automation.Language.Parser]::ParseFile("$PWD/install.ps1",[ref]$null,[ref]$errs)
```

CI 会跑同样的检查。

## 许可

提交即表示同意以 MIT 授权你的贡献。注意动画里的**音频与视觉素材是第三方素材**，
不在 MIT 范围内 —— 不要往仓库里再加来源不明的素材，详见 [NOTICE.md](NOTICE.md)。
