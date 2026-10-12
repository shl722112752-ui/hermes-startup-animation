/* 启动动画监督进程
 * ============================================================================
 * 这是唯一常驻的进程，负责让整套东西「装好之后不用管」：
 *
 *   1. 拉起并盯着 watcher.mjs —— 子进程一退出就立刻重启（2 秒；一分钟内反复
 *      退出就退避到 30 秒，避免打转）。
 *   2. 自检并修好注入的前提条件：
 *        · 用户级环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS（丢了就用 setx 补回来）
 *        · config.json（丢了/坏了就用默认值重建，坏文件先备份）
 *        · splash-bundle.js（不存在或比源码旧就自动重新打包）
 *   3. 单实例（supervisor.pid）；watcher 由它独占，所以子进程跳过自己的 pid 锁。
 *
 * 它自己绝不允许退出：uncaughtException / unhandledRejection 只记日志。
 * 就算它真的死了，计划任务 HermesSplashWatchdog 每 2 分钟会把它再拉起来。
 */

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS } from './schema.mjs'
import { readPaths } from './cdp-port.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const WATCHER = join(DIR, 'watcher.mjs')
const BUILDER = join(DIR, 'build-bundle.mjs')
const SUP_PID_FILE = join(DIR, 'supervisor.pid')
const WATCHER_PID_FILE = join(DIR, 'watcher.pid')
const LOG_FILE = join(DIR, 'supervisor.log')
const CONFIG_FILE = join(DIR, 'config.json')
const BUNDLE_FILE = join(DIR, 'splash-bundle.js')

const PATHS = readPaths(DIR)
const ENV_NAME = 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'
/* cdpPort 0（默认）= 让 Chromium 自己挑空闲端口，不和本机其它 WebView2 应用抢端口 */
const ENV_VALUE = `--remote-debugging-port=${Number(PATHS.cdpPort) > 0 ? Number(PATHS.cdpPort) : 0}`

/* bundle 依赖这些源文件，任一比生成物新就重打包 */
const SOURCES = [
  join(DIR, 'src', 'plugin.js'),
  join(DIR, 'src', 'panel.js'),
  join(DIR, 'schema.mjs'),
  join(DIR, 'build-bundle.mjs'),
]

const OK = { stdio: 'ignore', windowsHide: true, timeout: 20000 }
/* 要读输出的调用必须用这个：OK 里的 stdio:'ignore' 会让 execFileSync 拿不到 stdout */
const CAPTURE = { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 512 * 1024) writeFileSync(LOG_FILE, '')
    appendFileSync(LOG_FILE, line)
  } catch { /* 记日志本身绝不能弄死监督进程 */ }
}

process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e && e.message ? e.message : String(e)}`))
process.on('uncaughtException', (e) => log(`uncaughtException: ${e && e.message ? e.message : String(e)}`))

/* ── 单实例：用回环端口当锁 ──────────────────────────────────────────────
   不用 pid 判断存活：重启之后 pid 会被复用，pid 文件里的旧号可能正好落在别的
   进程上，监督进程就会误以为「已有实例」而永远不启动（实测踩到过）。
   绑定一个专属回环端口做互斥，跨重启、跨 pid 复用都可靠。 */
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function readPid(file) {
  try {
    const n = Number(readFileSync(file, 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

const LOCK_PORT = Number(process.env.HSS_LOCK_PORT || 9335)
const lockServer = createServer((_req, res) => { res.writeHead(204); res.end() })
await new Promise((resolve) => {
  lockServer.once('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`another supervisor is already running (lock port ${LOCK_PORT} busy), exiting`)
      process.exit(0)
    }
    log(`WARNING: could not take lock port ${LOCK_PORT}: ${e.message} (continuing anyway)`)
    resolve()
  })
  lockServer.listen(LOCK_PORT, '127.0.0.1', () => resolve())
})
writeFileSync(SUP_PID_FILE, String(process.pid))
log(`supervisor started (pid ${process.pid}, lock ${LOCK_PORT})`)

/* ── 前提条件自检 ───────────────────────────────────────────────────────── */

/* 用户级环境变量：缺失就补上，值不对（且形状是本项目的）就改回来。
   setx 会同时广播 WM_SETTINGCHANGE，所以之后从资源管理器启动的 Hermes 能拿到它。
   如果用户自己往里加了别的参数，就只记日志、不覆盖。 */
function ensureEnvVar() {
  let current = null
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', ENV_NAME], CAPTURE) || ''
    const m = out.match(new RegExp(ENV_NAME + '\\s+REG_[A-Z_]+\\s+(.*)', 'i'))
    current = m ? m[1].trim() : ''
  } catch { current = null }   // 不存在时 reg 返回非 0

  if (current === ENV_VALUE) return

  if (current !== null && !/^--remote-debugging-port=\d+$/.test(current)) {
    log(`WARNING: ${ENV_NAME} is "${current}" (has extra flags), expected "${ENV_VALUE}" — leaving it alone`)
    return
  }

  try {
    execFileSync('setx', [ENV_NAME, ENV_VALUE], OK)
    log(`env ${ENV_NAME} ${current === null ? 'was missing' : `was "${current}"`} -> set to "${ENV_VALUE}" (applies to the next Hermes launch)`)
  } catch (e) {
    log(`could not set ${ENV_NAME}: ${e.message}`)
  }
}

function ensureConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) {
      writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8')
      log('config.json missing -> wrote defaults')
      return
    }
    const obj = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('root is not an object')
  } catch (e) {
    let backup = ''
    try {
      backup = CONFIG_FILE + '.bad-' + Date.now()
      renameSync(CONFIG_FILE, backup)
    } catch { /* 备份失败也要继续修 */ }
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8')
      log(`config.json unreadable (${e.message}) -> backed up to ${backup || '(failed)'}, wrote defaults`)
    } catch (e2) {
      log(`could not rewrite config.json: ${e2.message}`)
    }
  }
}

function ensureBundle() {
  try {
    if (!existsSync(BUILDER)) return
    let stale = !existsSync(BUNDLE_FILE)
    if (!stale) {
      const built = statSync(BUNDLE_FILE).mtimeMs
      stale = SOURCES.some((p) => existsSync(p) && statSync(p).mtimeMs > built)
    }
    if (!stale) return
    execFileSync(process.execPath, [BUILDER], { ...OK, cwd: DIR })
    log('splash-bundle.js missing/out of date -> rebuilt')
  } catch (e) {
    log(`bundle rebuild failed: ${e.message}`)
  }
}

function selfCheck() {
  try { ensureEnvVar() } catch (e) { log('ensureEnvVar threw: ' + e.message) }
  try { ensureConfig() } catch (e) { log('ensureConfig threw: ' + e.message) }
  try { ensureBundle() } catch (e) { log('ensureBundle threw: ' + e.message) }
}

/* ── 监督子进程 ─────────────────────────────────────────────────────────── */
let child = null
let pendingRestart = null
let exits = []

/* 接管现场：如果 watcher.pid 指向一个还活着的 node（比如这次升级前留下的裸
   watcher，或者上一次监督被外部杀掉后残留的子进程），先把它清掉，
   否则它会占着本地 API 端口 9334，新子进程绑不上、面板就改不了设置。
   只按我们自己的 pid 文件动手，并且确认真的是 node，避免 pid 复用误伤。 */
function retireStaleWatcher() {
  const pid = readPid(WATCHER_PID_FILE)
  if (!pid || pid === process.pid) return false
  try { process.kill(pid, 0) } catch { return false }   // 已经不在
  let isNode = false
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`], CAPTURE) || ''
    isNode = /node/i.test(out)
  } catch { isNode = false }
  if (!isNode) {
    log(`watcher.pid ${pid} is not a node process -> leaving it alone`)
    return false
  }
  try {
    process.kill(pid)
    log(`retired previous watcher (pid ${pid}) so this supervisor owns it`)
    return true
  } catch (e) {
    log(`could not retire watcher pid ${pid}: ${e.message}`)
    return false
  }
}

function startWatcher() {
  if (child || pendingRestart) return
  if (!existsSync(WATCHER)) { log(`FATAL: ${WATCHER} missing`); return }
  try {
    child = spawn(process.execPath, [WATCHER], {
      cwd: DIR,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, HSS_SUPERVISED: '1' },   // 子进程由此跳过自己的 pid 锁
    })
  } catch (e) {
    log('spawn failed: ' + e.message)
    child = null
    scheduleRestart(5000)
    return
  }
  log(`watcher spawned (pid ${child.pid})`)
  child.on('error', (e) => log('watcher process error: ' + e.message))
  child.on('exit', (code, signal) => {
    log(`watcher exited (code=${code}, signal=${signal || 'none'})`)
    child = null
    const now = Date.now()
    exits = exits.filter((t) => now - t < 60000)
    exits.push(now)
    const delay = exits.length > 5 ? 30000 : 2000
    if (exits.length > 5) log(`watcher exited ${exits.length} times in a minute -> backing off ${delay}ms`)
    scheduleRestart(delay)
  })
}

function scheduleRestart(delay) {
  if (pendingRestart) return
  pendingRestart = setTimeout(() => {
    pendingRestart = null
    startWatcher()
  }, delay)
}

/* ── 主循环 ─────────────────────────────────────────────────────────────── */
selfCheck()
if (retireStaleWatcher()) await sleep(1200)   // 让出本地 API 端口再起新的
startWatcher()

let lastCheck = Date.now()
for (;;) {
  await sleep(5000)
  try {
    /* 每 60 秒自检一次前提条件（reg query + 两次 stat，很轻） */
    if (Date.now() - lastCheck > 60000) {
      lastCheck = Date.now()
      selfCheck()
    }
    if (!child && !pendingRestart) {
      log('watcher not running -> starting it')
      startWatcher()
    }
  } catch (e) {
    log('main loop error: ' + e.message)
  }
}
