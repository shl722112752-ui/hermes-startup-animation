# 配置项

设置文件是 `%LOCALAPPDATA%\HermesSplash\config.json`（安装目录下的 `config.json`）。
**界面里改、命令行改、直接编辑文件，三者是同一份数据**：
界面通过注入进程的本地 API（`127.0.0.1:9334`）读写它，命令行直接读写它，
注入进程每 700ms 比对指纹并重新挂载注入脚本。

文件缺失或损坏时，监督进程会用默认值重建（坏文件先备份成 `config.json.bad-<时间>`），
所以永远不会因为配置坏了导致动画不播。

## 键值表

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `mode` | `session` | `session` 每次启动播一次 / `always` 每次页面加载都播 / `daily` 每天一次 |
| `theme` | `light` | `light` 暖白 / `dark` 暗色 |
| `speed` | `1` | 整段动画倍速，0.35 – 3 |
| `requireInteraction` | `false` | `true` 第 1、2 步停下来等确认；`false` 六幕自动播完 |
| `allowSkip` | `true` | 显示右上角 SKIP 按钮，并响应 Esc |
| `identity` | — | 终幕「欢迎 xxx 访问」里的名字 |
| `identityId` | — | 第 2 幕身份卡上的编号 |
| `accessLevel` | — | 第 2 幕身份卡上的权限等级 |
| `voice` | `true` | 语音播报 |
| `voiceSource` | `asset` | `asset` 真声素材 / `tts` 系统合成 |
| `voiceLang` | `en` | `en` / `zh` / `both`（只影响 TTS 回落） |
| `voiceName` | `""` | 音色，留空 = 自动挑 |
| `voiceRate` / `voicePitch` / `voiceVolume` | `0.88` / `0.85` / `0.9` | 语速 / 音调 / 音量 |
| `voiceCue` | `true` | 念台词前先响两声提示音 |
| `voiceLead` | `240` | 提示音后停多久再开口，0 – 1200 ms |
| `sound` | `true` | 界面音效（文字出现、阶段推进、按钮确认） |
| `soundVolume` | `0.5` | 界面音效音量 |
| `sfx` | `audio` | `audio` 内置素材 / `synth` 现场合成 |
| `accent` | `#ff7500` | 强调色（阶段条、进度条、准星） |
| `glitchA` / `glitchB` | `#ff3b30` / `#2971b8` | 揭幕色散故障的红与蓝 |
| `brand1` / `brand2` / `brand3a` / `brand3b` | — | 左上角品牌块 |
| `orgZh` / `orgEn` / `orgSub` | — | 开场黑幕上的三行字 |
| `welcomeBox` | — | 揭幕后中央的黑底白字框 |
| `footer` | — | 右下角页脚 |
| `showEntry` | `false` | 是否在窗口左下角显示浮动入口按钮（技能页卡片之外的备用入口） |

> `showEntry` 是本项目自己的开关，动画本体不认识它（会忽略未知键）。

## 与 DSH「启动动画」设置页的对应

动画本体是 DSH 插件 `dsh-startup-screen` 的移植，**键名一一对应**。
如果你在 DSH 那边已经调好过，可以直接搬过来。

| DSH 设置项 | 本项目的键 |
|---|---|
| 启用 | `enabled` |
| 显示模式 | `mode`（DSH 的 `always` 是"每次浏览器刷新都播"，桌面上一般用 `session`） |
| 主题 | `theme` |
| 速度 | `speed` |
| **要求确认** | `requireInteraction` |
| 允许跳过 | `allowSkip` |
| 身份名称 / 编号 / 权限等级 | `identity` / `identityId` / `accessLevel` |
| 语音播报 / 语音来源 / 语言 / 音色 | `voice` / `voiceSource` / `voiceLang` / `voiceName` |
| 语速 / 音调 / 音量 / 播报前提示音 / 开口前留白 | `voiceRate` / `voicePitch` / `voiceVolume` / `voiceCue` / `voiceLead` |
| 界面音效 / 音效音量 / 音效来源 | `sound` / `soundVolume` / `sfx` |
| 强调色 / 故障色 A / 故障色 B | `accent` / `glitchA` / `glitchB` |
| 品牌三行 | `brand1` / `brand2` / `brand3a` / `brand3b` |
| 黑幕三行 | `orgZh` / `orgEn` / `orgSub` |
| 终幕方框 / 页脚 | `welcomeBox` / `footer` |

装了本机 DSH 的话，可以一条命令整份导入（安装时用 `-DshConfig` 指定
`dsh-startup.json` 的位置）：

```powershell
& "$env:LOCALAPPDATA\HermesSplash\hermes-splash.cmd" dsh
```

## 生效时机

| 改动方式 | 什么时候生效 |
|---|---|
| 界面里改（卡片 / 抽屉） | 立刻写盘；当前窗口想看到效果点「预览动画」 |
| 命令行改 | 立刻写盘；`hermes-splash now` 重载窗口即可看到，否则下次启动生效 |
| 直接编辑 `config.json` | 注入进程 700ms 内发现变化；下次页面加载生效，`now` 立刻生效 |
