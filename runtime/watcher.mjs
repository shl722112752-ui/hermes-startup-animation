/* Hermes 启动动画注入守护进程
 * ============================================================================
 * 为什么需要它：
 *   Hermes Agent CN 桌面版的界面资源嵌在 hermes-agent-cn-desktop.exe 里，通过
 *   `hermesui://` 自定义协议提供，磁盘上没有任何可注入的 index.html，CN 版也没有
 *   原生桌面插件宿主。唯一可行的入口是 WebView2 的调试协议（CDP）：往页面里同步
 *   求值一段自包含脚本。
 *
 * 它做什么：
 *   1. 轮询 http://127.0.0.1:9333/json/list（由用户环境变量
 *      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 开启）；
 *   2. 一旦出现 Hermes 的 page target 就附加，然后做两件事：
 *      a. Page.addScriptToEvaluateOnNewDocument —— 覆盖之后每一次文档加载/刷新；
 *      b. 每 700ms 探一次 location.href 与注入标记，只要文档是 hermesui 且还没注入
 *         就立刻求值一次。
 *      两条路必须都留：冷启动时应用窗口常常先以 about:blank 出现、随后才导航到
 *      hermesui，此时 (a) 刚注册完就撞上导航会漏掉第一个文档（实测如此），
 *      而 (b) 能在导航提交后 1 个轮询周期内补上，并且自带验证。
 *   3. 应用退出后 socket 断开，回到轮询，等下一次启动。
 *
 * 失败模式是安全的：守护进程不在或注入失败时，Hermes 照常启动，只是没有动画。
 */

import { readFileSync, appendFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withDefaults, coercePatch } from './schema.mjs'
import { readPaths, discoverCdpPort } from './cdp-port.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const BUNDLE_FILE = join(DIR, 'splash-bundle.js')
const CONFIG_FILE = join(DIR, 'config.json')
const LOG_FILE = join(DIR, 'watcher.log')
const PID_FILE = join(DIR, 'watcher.pid')
const IDLE_POLL_MS = 300
const LIVE_POLL_MS = 2000
const PROBE_MS = 700

const VERBOSE = process.env.HSS_VERBOSE === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 调试端口不是写死的：默认由 Chromium 随机挑（--remote-debugging-port=0），
   实际端口从 Hermes 自己的 DevToolsActivePort 里读。详见 cdp-port.mjs。 */
const PATHS = readPaths(DIR)
/* 面板 API 端口：环境变量 > paths.json 的 apiPort（安装器 -ApiPort）> 默认 */
const API_PORT = Number(process.env.HSS_API_PORT || PATHS.apiPort || 9334)
let cdpPort = null
let cdpPortSource = 'none'
let cdpPortLogged = null

function refreshCdpPort(force) {
  if (cdpPort && !force) return cdpPort
  const found = discoverCdpPort(PATHS)
  cdpPort = found.port
  cdpPortSource = found.source
  if (cdpPort && cdpPort !== cdpPortLogged) {
    cdpPortLogged = cdpPort
    log(`CDP port ${cdpPort} (${cdpPortSource}${found.file ? ': ' + found.file : ''})`)
  }
  return cdpPort
}

function readConfigFile() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}
function writeCfgFile(obj) {
  writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

/* config.json（可选）：动画参数种子。只在页面没有自己的 localStorage 配置时生效，
   所以用户之后在页面里改动仍然优先。改完这个文件不需要重启守护进程——
   下面按指纹检测变化并重新注册注入脚本。 */
function loadConfigSeed() {
  try {
    if (!existsSync(CONFIG_FILE)) return ''
    const obj = readConfigFile()
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('root must be a JSON object')
    }
    return `window.__HSS_CONFIG__ = ${JSON.stringify(obj)};\n`
  } catch (e) {
    log(`config.json ignored: ${e.message}`)
    return ''
  }
}

/* ── 本地设置 API ────────────────────────────────────────────────────────
   窗口里的设置面板（注入的 src/panel.js）靠它读写同一个 config.json，
   这样面板、命令行、文件三者永远是一份数据。
   页面 origin 是 http://hermesui.localhost，属跨源请求，所以要带宽松 CORS 头；
   exe 内嵌的 CSP connect-src 允许 http://127.0.0.1:*，页面可以直接 fetch。
   只监听 127.0.0.1：本机进程本来就能通过调试端口控制窗口，这里不额外扩大信任面。 */
function startConfigApi() {
  /* 只放行 Hermes 窗口自己的来源。以前这里无条件回 `*`，意味着你随手打开的
     任意网页都能 fetch http://127.0.0.1:9334/config 读写你的动画配置
     （典型的 localhost CSRF 暴露面；端口固定，扫一下就能找到）。
     没有 Origin 的调用（本机脚本、curl、CLI）照旧放行。 */
  const isAllowedOrigin = (origin) => {
    if (!origin) return true
    const o = origin.toLowerCase()
    return o.startsWith('hermesui://') ||
      o === 'http://hermesui.localhost' || o.startsWith('http://hermesui.localhost:') ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)
  }
  const server = createServer((req, res) => {
    const origin = req.headers.origin || ''
    const allowed = isAllowedOrigin(origin)
    const cors = allowed
      ? {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
          'Vary': 'Origin',
          'Cache-Control': 'no-store',
        }
      : { 'Cache-Control': 'no-store' }
    const json = (code, body) => {
      res.writeHead(code, { ...cors, 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    /* 预检被 CORS 拦掉时浏览器不会发真正的请求，但简单请求会照发，
       所以在服务端也直接拒掉，别让写入发生。 */
    if (!allowed) { res.writeHead(403, cors); res.end('origin not allowed'); return }

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }

    let path = '/'
    try { path = new URL(req.url, 'http://127.0.0.1').pathname } catch { /* keep default */ }

    if (req.method === 'GET' && path === '/config') {
      return json(200, { config: withDefaults(readConfigFile()), file: CONFIG_FILE })
    }
    if (req.method === 'GET' && path === '/health') {
      return json(200, { ok: true, pid: process.pid, api: 1 })
    }
    if (req.method === 'POST' && path === '/config') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 256 * 1024) { req.destroy(); }
      })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const patch = (parsed.patch && typeof parsed.patch === 'object') ? parsed.patch : parsed
          const clean = coercePatch(patch)
          const next = { ...readConfigFile(), ...clean }
          writeCfgFile(next)
          log(`panel saved: ${Object.keys(clean).join(', ')}`)
          json(200, { ok: true, config: withDefaults(next), changed: Object.keys(clean) })
        } catch (e) {
          json(400, { ok: false, error: e.message })
        }
      })
      return
    }
    json(404, { ok: false, error: 'not found' })
  })
  let apiRetries = 0
  server.on('error', (e) => {
    log(`config API listen failed on ${API_PORT}: ${e.message}`)
    /* 端口被占（大多是上一个 watcher 还没退干净）就等一会儿再绑，
       否则设置面板会一直「保存失败」直到下次重启 */
    if (e.code === 'EADDRINUSE' && apiRetries < 20) {
      apiRetries++
      setTimeout(() => {
        try { server.listen(API_PORT, '127.0.0.1') } catch (e2) { log(`config API retry failed: ${e2.message}`) }
      }, 3000)
    }
  })
  server.listen(API_PORT, '127.0.0.1', () => log(`config API on http://127.0.0.1:${API_PORT}`))
  return server
}

/* config.json / splash-bundle.js 的指纹：变了就重建注入脚本并重挂 new-document hook，
   否则用户刚改的设置会在下一次页面加载时被旧 hook 覆盖。 */
function sourceFingerprint() {
  try {
    const c = statSync(CONFIG_FILE)
    const b = statSync(BUNDLE_FILE)
    return `${c.mtimeMs}:${c.size}:${b.mtimeMs}:${b.size}`
  } catch {
    return 'missing'
  }
}

function buildSource(launchToken) {
  return `window.__HSS_LAUNCH_TOKEN__ = ${JSON.stringify(launchToken)};\n` +
    `window.__HSS_API_PORT__ = ${API_PORT};\n` +
    loadConfigSeed() + readFileSync(BUNDLE_FILE, 'utf8')
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 512 * 1024) writeFileSync(LOG_FILE, '')
    appendFileSync(LOG_FILE, line)
  } catch { /* logging must never kill the watcher */ }
}

/* ── 单实例保护 ──────────────────────────────────────────────────────────── */
function alreadyRunning() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    if (!pid || pid === process.pid) return false
    process.kill(pid, 0) // 不抛异常 = 进程还活着
    return true
  } catch {
    return false
  }
}

/* 由 supervisor.mjs 拉起时跳过 pid 锁：监督进程保证只有一个 watcher，
   而且它正是靠「子进程退出」来发现异常，锁会让它以为启动失败而反复重启。 */
const SUPERVISED = process.env.HSS_SUPERVISED === '1'
if (!SUPERVISED && alreadyRunning()) {
  log(`another watcher is already running, exiting (pid ${process.pid})`)
  process.exit(0)
}
writeFileSync(PID_FILE, String(process.pid))

/* 常驻进程绝不能因为一个漏网的 promise 拒绝就退出：记下来，继续轮询。 */
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e && e.message ? e.message : String(e)}`))
process.on('uncaughtException', (e) => log(`uncaughtException: ${e && e.message ? e.message : String(e)}`))

if (!existsSync(BUNDLE_FILE)) {
  log(`FATAL: bundle missing: ${BUNDLE_FILE} — run build-bundle.mjs first`)
  process.exit(1)
}

/* ── 极简 CDP 客户端 ─────────────────────────────────────────────────────── */
function makeClient(ws) {
  let seq = 0
  const pending = new Map()

  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id == null) return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  })

  const send = (method, params = {}) => {
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }
      }, 15000)
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        clearTimeout(timer)
        pending.delete(id)
        reject(e)
      }
    })
  }

  /* 求值助手：上下文在导航中被销毁是常态，调用方按需忽略 */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate threw')
    return r.result?.value
  }

  return { send, evaluate }
}

async function listTargets() {
  const port = refreshCdpPort(false)
  if (!port) throw new Error('no CDP port (Hermes 没在跑，或调试端口没开)')
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2500),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return await res.json()
}

/* 应用窗口冷启动时常常先以 about:blank 出现；两种情况都要接管。 */
const isHermesTarget = (t) =>
  t.type === 'page' &&
  (t.url === '' || t.url === 'about:blank' || /hermesui/i.test(t.url || ''))

const attached = new Map() // webSocketDebuggerUrl -> { ws }

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 8000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket error')) }, { once: true })
  })

  const key = target.webSocketDebuggerUrl
  let closed = false
  const cdp = makeClient(ws)
  /* 每次附加 = 应用的一次启动。带一个新 token 告诉页面「这是新一轮启动」，
     这样 mode=session 只在启动时播一次，应用内刷新不会重播。 */
  const launchToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  let source = buildSource(launchToken)
  let fingerprint = sourceFingerprint()

  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
  } catch (e) {
    /* 失败时不能把 target 留在 attached 里：主循环用 attached.has() 去重，
       留着这个条目会让**本次应用运行期间永远不再尝试注入**。 */
    try { ws.close() } catch { /* already gone */ }
    throw e
  }

  const entry = { ws }
  attached.set(key, entry)
  ws.addEventListener('close', () => {
    closed = true
    attached.delete(key)
    log(`detached ${target.id}`)
  })

  /* (a) 之后所有文档：刷新 / 重新导航都在 document-start 就注入 */
  let hookId = null
  const registerHook = async () => {
    try {
      if (hookId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hookId })
    } catch { /* 旧 hook 可能已经随导航失效 */ }
    try {
      const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
      hookId = r?.identifier ?? null
    } catch (e) {
      log(`addScriptToEvaluateOnNewDocument failed: ${e.message}`)
    }
  }
  await registerHook()

  /* (b) 当前及后续文档的兜底探针——自带验证，漏了就补；同时盯着设置有没有改 */
  ;(async () => {
    while (!closed && ws.readyState === 1) {
      try {
        const fp = sourceFingerprint()
        if (fp !== fingerprint) {
          fingerprint = fp
          source = buildSource(launchToken)
          await registerHook()
          log('config.json / splash-bundle.js changed → injection refreshed')
        }

        const href = await cdp.evaluate('location.href')
        if (typeof href === 'string' && /hermesui/i.test(href)) {
          const loaded = await cdp.evaluate(
            'window.__HSS_ACTIVE__===true || window.__HSS_BUNDLE_LOADED__===true'
          )
          if (loaded !== true) {
            /* 再确认一次上下文没在求值期间被导航换掉，然后注入 */
            const href2 = await cdp.evaluate('location.href')
            if (typeof href2 === 'string' && /hermesui/i.test(href2)) {
              await cdp.evaluate(source)
              log(`injected into ${href2}`)
            }
          }
        }
      } catch (e) {
        if (VERBOSE) log(`probe: ${e.message}`)
      }
      await sleep(PROBE_MS)
    }
  })()

  log(`attached ${target.id} (${target.url || 'about:blank'})`)
}

log(`watcher started (pid ${process.pid}, api ${API_PORT}, ${PATHS.cdpPort > 0 ? 'cdp ' + PATHS.cdpPort : 'cdp auto'})`)
refreshCdpPort(false)
startConfigApi()

for (;;) {
  try {
    const targets = await listTargets()
    for (const t of targets) {
      if (!isHermesTarget(t)) continue
      if (attached.has(t.webSocketDebuggerUrl)) continue
      try {
        await attach(t)
      } catch (e) {
        log(`attach failed for ${t.id}: ${e.message}`)
      }
    }
    await sleep(attached.size ? LIVE_POLL_MS : IDLE_POLL_MS)
  } catch (e) {
    for (const [key, e2] of attached) {
      if (e2.ws.readyState !== 1) attached.delete(key)
    }
    /* 连不上就丢弃当前端口：下次轮询重新读 DevToolsActivePort
       （Hermes 重启后端口会变，占着旧值会一直失败） */
    if (cdpPort) { cdpPort = null; cdpPortLogged = null }
    if (VERBOSE) log(`poll: ${e.message}`)
    await sleep(IDLE_POLL_MS)
  }
}
