#!/usr/bin/env node
/* Hermes 启动动画设置工具（hermes-splash）
 * ============================================================================
 * 改 config.json + 管理注入守护进程。给人和给 Agent 用都行，命令是纯文本输出。
 *
 *   hermes-splash status              看当前设置与运行状态
 *   hermes-splash interactive         第 1、2 步等你确认（交互，和本地 dsh 一致）
 *   hermes-splash auto                六幕自动播完，不停下来等确认
 *   hermes-splash mode always         每次页面加载都播 / session 每次启动播一次 / daily 每天一次
 *   hermes-splash speed 1.4           总倍速 0.35–3
 *   hermes-splash on | off            总开关
 *   hermes-splash set accent=#3b82f6  改任意一项（值按 JSON 解析）
 *   hermes-splash now                 让改动立刻生效：重载 Hermes 窗口（会重播动画）
 *   hermes-splash restart             重启注入守护进程
 *   hermes-splash doctor              自检
 *   hermes-splash reset               恢复默认值（保留 config.json 里已有的键）
 *   hermes-splash dsh                 从本地 dsh-startup.json 导入设置
 */

import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { DEFAULTS, coerceValue } from './schema.mjs'
import { readPaths, discoverCdpPort } from './cdp-port.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const CFG_FILE = join(DIR, 'config.json')
const BUNDLE = join(DIR, 'splash-bundle.js')
const SRC = join(DIR, 'src', 'plugin.js')
const PID_FILE = join(DIR, 'watcher.pid')
const SUP_PID_FILE = join(DIR, 'supervisor.pid')
const LOG_FILE = join(DIR, 'watcher.log')
const SUP_LOG = join(DIR, 'supervisor.log')
const VBS = join(DIR, 'hermes-splash-supervisor.vbs')

/* 机器相关信息由 install.ps1 写在 paths.json 里（Hermes 目录、HERMES_HOME、
   可选的本机 dsh-startup.json）。代码里不含任何绝对路径。 */
const paths = (() => {
  try { return JSON.parse(readFileSync(join(DIR, 'paths.json'), 'utf8')) } catch { return {} }
})()
const DSH_CFG = paths.dshConfig || ''

/* 期望写进用户级环境变量的值。paths.json 的 cdpPort 为 0（默认）= 自动：
   让 Chromium 自己挑空闲端口，避免和本机其它 WebView2 应用抢同一个端口。 */
const WANT_CDP_ENV = `--remote-debugging-port=${Number(paths.cdpPort) > 0 ? Number(paths.cdpPort) : 0}`
const cdpEnvValue = () => WANT_CDP_ENV
const API = `http://127.0.0.1:${Number(process.env.HSS_API_PORT || 9334)}`

/* 单一定义在 schema.mjs：命令行、守护进程的本地 API、窗口里的设置面板共用 */
const parseValue = coerceValue

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readCfg = () => {
  try { return JSON.parse(readFileSync(CFG_FILE, 'utf8')) } catch { return {} }
}
const writeCfg = (obj) => writeFileSync(CFG_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8')

function applyChanges(changes) {
  const cfg = { ...readCfg() }
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in DEFAULTS)) console.log(`  注意：${k} 不是内置键，仍然写入（插件会忽略未知键）`)
    cfg[k] = v
  }
  writeCfg(cfg)
  for (const [k, v] of Object.entries(changes)) console.log(`  ${k} = ${JSON.stringify(v)}`)
}

/* ── 运行时状态 ─────────────────────────────────────────────────────────── */
const pidOf = (file) => {
  try { return Number(readFileSync(file, 'utf8').trim()) || null } catch { return null }
}
const alive = (pid) => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
const watcherPid = () => pidOf(PID_FILE)
const watcherAlive = () => alive(watcherPid())
const supervisorPid = () => pidOf(SUP_PID_FILE)

/* 监督进程的存活以「锁端口是否被占」为准，不看 pid 文件：
   重启后 pid 会被复用，旧号可能落在别的进程上。 */
const LOCK_PORT = Number(process.env.HSS_LOCK_PORT || 9335)
function portBusy(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = netConnect({ host: '127.0.0.1', port })
    const done = (v) => { try { sock.destroy() } catch { } resolve(v) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}
const supervisorAlive = () => portBusy(LOCK_PORT)

/* 调试端口是动态的（默认由 Chromium 随机挑，见 cdp-port.mjs），每次用前解析一次；
   连不上就丢弃缓存，下次重新读 DevToolsActivePort。 */
let cdpPortInfo = null
function cdpPort() {
  if (!cdpPortInfo || !cdpPortInfo.port) cdpPortInfo = discoverCdpPort(paths)
  return cdpPortInfo
}
function cdpPortLabel() {
  const info = cdpPort()
  if (!info.port) return '未发现（Hermes 没在跑？）'
  return info.source === 'DevToolsActivePort' ? `${info.port}（自动）` : `${info.port}（${info.source}）`
}
async function cdpTargets() {
  const info = cdpPort()
  if (!info.port) return null
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/json/list`, { signal: AbortSignal.timeout(2000) })
    return await res.json()
  } catch { cdpPortInfo = null; return null }
}

/* 最小的 CDP 求值/命令客户端（Node 24 自带 WebSocket） */
async function cdpCall(wsUrl, calls) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('websocket 超时')), 5000)
    ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('websocket 失败')) }, { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  })
  const send = (method, params = {}) => {
    const id = ++seq
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (pending.delete(id)) reject(new Error('CDP 超时: ' + method)) }, 8000)
    })
  }
  try { return await calls(send) } finally { try { ws.close() } catch {} }
}

async function liveState() {
  const list = await cdpTargets()
  if (!list) return null
  const page = list.find((t) => t.type === 'page' && /hermesui/i.test(t.url || ''))
  if (!page) return null
  return await cdpCall(page.webSocketDebuggerUrl, async (send) => {
    const r = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `JSON.stringify({
        root: !!document.getElementById('hermes-startup-root'),
        step: (((document.getElementById('hermes-startup-root')||{}).innerText||'').match(/\\[\\s*(\\d+)\\s*\\/\\s*06\\s*\\]/)||[])[1] || null,
        injected: window.__HSS_ACTIVE__ === true,
        requireInteraction: (window.__DSH_STARTUP__||{}).requireInteraction
      })`,
    })
    return JSON.parse(r.result.value)
  })
}

/* ── 命令 ───────────────────────────────────────────────────────────────── */
async function cmdStatus() {
  const cfg = readCfg()
  const view = { ...DEFAULTS, ...cfg }
  console.log('设置文件 :', CFG_FILE)
  console.log('监督进程 :', (await supervisorAlive()) ? `运行中（锁端口 ${LOCK_PORT}，pid ${supervisorPid()}）` : '未运行  ← 接下来 2 分钟内会被计划任务拉起')
  console.log('注入进程 :', watcherAlive() ? `运行中 (pid ${watcherPid()})` : '未运行（监督进程会在 2 秒内重启它）')
  /* 看用户级变量而不是当前进程的：Hermes 从快捷方式启动时读的是前者 */
  const userEnv = readUserEnv()
  console.log('端口设置 :', userEnv
    ? `用户环境变量 ${userEnv}${/-remote-debugging-port=0$/.test(userEnv) ? '（自动，不与其他应用抢端口）' : ''}`
    : '⚠ 未设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS —— Hermes 启动时不会开调试端口')
  const list = await cdpTargets()
  console.log('Hermes   :', list ? `窗口已开（CDP 端口 ${cdpPortLabel()}）` : `未运行，或调试端口没开（CDP 端口 ${cdpPortLabel()}）`)
  const apiOk = await apiAlive()
  console.log('设置面板 :', apiOk
    ? `本地 API 就绪（${API}）`
    : `⚠ 本地 API 不通（${API}）—— 窗口里的面板改不了设置，试 hermes-splash restart`)
  if (list) {
    const live = await liveState().catch(() => null)
    if (live) {
      console.log('当前动画 :', live.root ? `正在播放（第 ${live.step || '?'} 幕）` : (live.injected ? '本轮已播完' : '本轮未注入'))
    }
  }
  console.log('')
  for (const k of Object.keys(DEFAULTS)) {
    const mark = k in cfg ? ' ' : '*'
    console.log(`  ${mark} ${k.padEnd(18)} ${JSON.stringify(view[k])}`)
  }
  console.log('')
  console.log('  (* = 用内置默认值，config.json 里没写)')
  console.log(`  模式解读: requireInteraction=${view.requireInteraction ? '交互（第 1、2 步等你确认）' : '自动（六幕播完）'} / mode=${view.mode}`)
}

const apiAlive = () => fetch(API + '/health', { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok).catch(() => false)

function cmdDoctor() {
  return cmdDoctorAsync()
}

async function cmdDoctorAsync() {
  const checks = []
  const add = (ok, label, hint) => checks.push({ ok, label, hint })
  add(existsSync(CFG_FILE), 'config.json 存在', CFG_FILE)
  add(existsSync(BUNDLE), '注入脚本 splash-bundle.js 存在', BUNDLE)
  add(existsSync(SRC), '插件源码 src/plugin.js 存在', SRC)
  add(existsSync(join(DIR, 'src', 'panel.js')), '设置界面源码 src/panel.js 存在', join(DIR, 'src', 'panel.js'))
  if (existsSync(BUNDLE) && existsSync(SRC)) {
    add(statSync(BUNDLE).mtimeMs >= statSync(SRC).mtimeMs, '生成物不比源码旧', '监督进程会自动重打包；也可手动跑 build-bundle.mjs')
  }
  add(await supervisorAlive(), '监督进程在运行', 'hermes-splash restart（计划任务也会在 2 分钟内拉起）')
  add(watcherAlive(), '注入进程在运行', '监督进程会在 2 秒内重启它；hermes-splash restart')
  add(await apiAlive(), '设置面板 API 可用', `本地 ${API} 不通；hermes-splash restart`)
  const startupDir = join(process.env.APPDATA || '', 'Microsoft\\Windows\\Start Menu\\Programs\\Startup')
  add(existsSync(join(startupDir, 'hermes-splash-supervisor.vbs')), '登录自启项已安装', startupDir)
  const userEnv = readUserEnv()
  const wantEnv = cdpEnvValue()
  add(userEnv === wantEnv, '调试端口环境变量正确（用户级）',
    userEnv ? `当前是 "${userEnv}"；应为 "${wantEnv}"` : `监督进程会自动补成 "${wantEnv}"`)
  if (await cdpTargets()) {
    add(!!cdpPort().port, '能解析到 Hermes 的调试端口', 'DevToolsActivePort 还没写出来？稍后重试')
  }
  let taskOk = false
  try {
    /* 只看退出码：schtasks 的输出是本地化的（中文系统是「就绪」而不是 Ready） */
    execFileSync('schtasks', ['/query', '/tn', 'HermesSplashWatchdog'],
      { stdio: 'ignore', windowsHide: true, timeout: 15000 })
    taskOk = true
  } catch { taskOk = false }
  add(taskOk, '看门狗计划任务已注册', 'powershell -ExecutionPolicy Bypass -File install-watchdog.ps1')
  add(existsSync(SUP_LOG) || existsSync(LOG_FILE), '有运行日志', LOG_FILE)
  for (const c of checks) console.log(`${c.ok ? '  OK  ' : '  FAIL'} ${c.label}${c.ok ? '' : '\n        → ' + c.hint}`)
  const bad = checks.filter((c) => !c.ok).length
  console.log('')
  console.log(bad ? `${bad} 项不通过` : '全部通过')
  if (existsSync(LOG_FILE)) {
    console.log('\n最近日志：')
    for (const line of readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-6)) console.log('  ' + line)
  }
  return bad === 0
}

function readUserEnv() {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','User')"],
      { encoding: 'utf8' }).trim()
  } catch { return '' }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

async function cmdRestart() {
  const pid = supervisorPid()
  if (pid && alive(pid)) {
    try { process.kill(pid); console.log(`  已停止监督进程 pid ${pid}`) } catch { console.log(`  pid ${pid} 已不在`) }
    /* 监督进程退出时会把子进程一起带走（它是父进程） */
    const t0 = Date.now()
    while (Date.now() - t0 < 4000 && alive(pid)) await sleep(150)
  }
  try {
    execFileSync('wscript.exe', [VBS], { stdio: 'ignore' })
  } catch (e) {
    console.log('  启动失败：', e.message)
    return false
  }
  const t0 = Date.now()
  let sup = false
  while (Date.now() - t0 < 10000) {
    sup = await supervisorAlive()
    if (sup && watcherAlive()) {
      console.log(`  监督进程 pid ${supervisorPid()} / 注入进程 pid ${watcherPid()} 已启动`)
      return true
    }
    await sleep(250)
  }
  sup = await supervisorAlive()
  console.log(`  监督进程 ${sup ? '已起' : '没起来'}，注入进程 ${watcherAlive() ? '已起' : '没起来'}；看 supervisor.log`)
  return false
}

async function cmdNow() {
  if (!watcherAlive()) {
    console.log('  注意：注入进程没在运行，重载后不会注入动画（2 秒内监督进程会重启它）')
  }
  const list = await cdpTargets()
  if (!list) { console.log('  Hermes 没在运行（或调试端口没开），改动会在下次启动时生效'); return }
  const page = list.find((t) => t.type === 'page' && /hermesui/i.test(t.url || ''))
  if (!page) { console.log('  没找到 Hermes 窗口，改动会在下次启动时生效'); return }

  /* 清掉会话门控，让本次重载一定能看到动画（不然 mode=session 会跳过） */
  await cdpCall(page.webSocketDebuggerUrl, async (send) => {
    await send('Runtime.evaluate', {
      returnByValue: true,
      expression: "try{sessionStorage.removeItem('hermes-startup-screen:shown')}catch(e){};'ok'",
    })
  })
  /* watcher 每 700ms 检查一次 config.json 指纹并重挂 new-document hook，
     等一个周期再重载，重载才会用上新设置。 */
  sleepSync(1400)
  await cdpCall(page.webSocketDebuggerUrl, async (send) => { await send('Page.reload', {}) })
  console.log('  已重载 Hermes 窗口：新设置立即生效，动画会重播一次')
}

function cmdDsh() {
  if (!DSH_CFG) {
    console.log('  还没配置 dsh-startup.json 的位置。用安装器指定一次即可：')
    console.log('    install.ps1 -DshConfig "<dsh-startup.json 的完整路径>"')
    return false
  }
  if (!existsSync(DSH_CFG)) { console.log('  找不到 ' + DSH_CFG); return false }
  const dsh = JSON.parse(readFileSync(DSH_CFG, 'utf8'))
  const cfg = { ...readCfg() }
  const ported = []
  for (const k of Object.keys(DEFAULTS)) {
    if (k in dsh && k !== 'mode') { cfg[k] = dsh[k]; ported.push(k) }
  }
  writeCfg(cfg)
  console.log(`  已从 ${DSH_CFG} 导入 ${ported.length} 项`)
  console.log('  ' + ported.join(', '))
  console.log(`  requireInteraction=${cfg.requireInteraction}  → ${cfg.requireInteraction ? '交互' : '自动'}`)
  console.log('  （mode 保持 Hermes 的值：dsh 的 always 是每次刷新都播，桌面上是每次启动播一次）')
  return true
}

async function cmdPanel() {
  const list = await cdpTargets()
  if (!list) { console.log('  Hermes 没在运行（或调试端口没开）'); return }
  const page = list.find((t) => t.type === 'page' && /hermesui/i.test(t.url || ''))
  if (!page) { console.log('  没找到 Hermes 窗口'); return }
  const out = await cdpCall(page.webSocketDebuggerUrl, async (send) => {
    const res = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(()=>{ if (window.__HSS_PANEL__) { window.__HSS_PANEL__.open(); return 'opened' } return 'not-injected' })()`,
    })
    return res.result?.value
  })
  console.log(out === 'opened'
    ? '  已在 Hermes 窗口里打开设置面板（也可以直接在窗口里按 Ctrl+Alt+S）'
    : '  窗口里还没有面板：守护进程没附加，先 hermes-splash restart，必要时重载窗口')
}

function usage() {
  console.log(`Hermes 启动动画设置（hermes-splash）
  panel                  在 Hermes 窗口里打开设置面板（= 窗口内按 Ctrl+Alt+S）
  status                 看当前设置与运行状态
  interactive            交互模式：第 1、2 步等你点按钮 / Enter / 空格，Esc 跳过
  auto                   自动模式：六幕自动播完
  on | off               总开关
  mode session|always|daily   每次启动播一次 / 每次加载都播 / 每天一次
  speed <0.35-3>         总倍速
  skip on|off            是否显示 SKIP 按钮、是否响应 Esc
  get <key>              读一项
  set <key>=<value>      改任意一项（值按 JSON 解析）
  now                    改动立刻生效（重载 Hermes 窗口，动画会重播）
  restart                重启注入守护进程
  doctor                 自检
  reset                  恢复默认值（备份为 config.json.bak）
  dsh                    从本地 dsh-startup.json 导入设置`)
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */
const [cmd, ...rest] = process.argv.slice(2)
try {
  switch ((cmd || 'status').toLowerCase()) {
    case 'status': case '配置': await cmdStatus(); break
    case 'auto': case '自动': applyChanges({ enabled: true, requireInteraction: false }); console.log('  已切到自动：六幕播完，不等待确认（speed 可在 config.json 调）'); break
    case 'interactive': case '交互': applyChanges({ enabled: true, requireInteraction: true }); console.log('  已切到交互：第 1、2 步点按钮 / Enter / 空格继续，Esc 跳过'); break
    case 'on': applyChanges({ enabled: true }); break
    case 'off': applyChanges({ enabled: false }); break
    case 'mode': applyChanges({ mode: parseValue('mode', rest[0] || '') }); break
    case 'speed': applyChanges({ speed: parseValue('speed', rest[0] || '') }); break
    case 'skip': applyChanges({ allowSkip: parseValue('allowSkip', rest[0] || '') }); break
    case 'get': {
      const cfg = { ...DEFAULTS, ...readCfg() }
      console.log(JSON.stringify(cfg[rest[0]], null, 2))
      break
    }
    case 'set': {
      if (!rest[0] || !rest[0].includes('=')) throw new Error('用法: hermes-splash set key=value')
      const i = rest[0].indexOf('=')
      const k = rest[0].slice(0, i)
      applyChanges({ [k]: parseValue(k, rest[0].slice(i + 1)) })
      break
    }
    case 'panel': await cmdPanel(); break
    case 'now': await cmdNow(); break
    case 'restart': await cmdRestart(); break
    case 'doctor': process.exitCode = (await cmdDoctor()) ? 0 : 1; break
    case 'reset': { copyFileSync(CFG_FILE, CFG_FILE + '.bak'); writeCfg({}); console.log('  已恢复默认（旧文件备份为 config.json.bak）'); break }
    case 'dsh': cmdDsh(); break
    case 'help': case '-h': case '--help': usage(); break
    default: usage(); process.exitCode = 1
  }
} catch (e) {
  console.error('错误：' + e.message)
  process.exitCode = 1
}
