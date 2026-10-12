/* CDP 端口发现
 * ============================================================================
 * 用户级环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 对本机**所有** WebView2 应用
 * 都生效。如果写死一个端口，就是"谁先启动谁占"——实测 9333 被「微软电脑管家」的
 * WebView2 抢走，Hermes 于是拿不到调试端口，动画静默失效。
 *
 * 所以默认用 --remote-debugging-port=0：Chromium 自己挑一个空闲端口，并把实际端口
 * 写进该应用 user-data-dir 下的 DevToolsActivePort。我们只读 Hermes 自己的那一份，
 * 于是既不会撞端口，也不可能连到别的应用上。
 *
 * paths.json 里的 cdpPort：
 *   0  = 自动（读 DevToolsActivePort）
 *   >0 = 固定端口（给明确要这么干的用户）
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function readPaths(installDir) {
  try {
    return JSON.parse(readFileSync(join(installDir, 'paths.json'), 'utf8')) || {}
  } catch {
    return {}
  }
}

/** DevToolsActivePort 的候选位置：Hermes 的 WebView2 用户数据目录。 */
export function activePortFiles(paths) {
  const out = []
  const hermesDir = paths && paths.hermesDir
  if (!hermesDir) return out
  const root = join(hermesDir, 'data', 'webview2')
  out.push(join(root, 'EBWebView', 'DevToolsActivePort'))
  try {
    for (const name of readdirSync(root)) out.push(join(root, name, 'DevToolsActivePort'))
  } catch { /* 目录不存在很正常（应用还没跑过） */ }
  return out
}

/** 读最新的那份 DevToolsActivePort（第一行是端口）。 */
export function readActivePort(paths) {
  let best = null
  for (const file of activePortFiles(paths)) {
    try {
      if (!existsSync(file)) continue
      const st = statSync(file)
      if (best && st.mtimeMs <= best.mtime) continue
      const port = Number(String(readFileSync(file, 'utf8')).split(/\r?\n/)[0].trim())
      if (Number.isFinite(port) && port > 0) best = { port, mtime: st.mtimeMs, file }
    } catch { /* 正在被写、权限问题等，跳过 */ }
  }
  return best
}

/**
 * 解析出本次该连哪个端口。
 * @returns {{port: number|null, source: string, file?: string}}
 */
export function discoverCdpPort(paths, explicitPort) {
  if (explicitPort) return { port: Number(explicitPort), source: 'explicit' }
  if (process.env.HSS_CDP_PORT) return { port: Number(process.env.HSS_CDP_PORT), source: 'HSS_CDP_PORT' }

  const configured = Number(paths && paths.cdpPort)
  if (Number.isFinite(configured) && configured > 0) return { port: configured, source: 'fixed' }

  const active = readActivePort(paths)
  if (active) return { port: active.port, source: 'DevToolsActivePort', file: active.file }
  return { port: null, source: 'none' }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
