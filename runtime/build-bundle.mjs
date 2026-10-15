/* Build the self-contained splash bundle from the upstream plugin source.
 *
 *   node build-bundle.mjs [src/plugin.js] [splash-bundle.js]
 *
 * Why a bundle at all: the Hermes desktop window renders its UI from assets
 * embedded in hermes-agent-cn-desktop.exe and served over the `hermesui://`
 * custom protocol, so no extra file can be added next to index.html and no
 * import map / module loader is available to us. The only way in is a single
 * synchronous script evaluated in the page, so everything the plugin needs is
 * inlined here:
 *   1. minimal @hermes/plugin-sdk + react shims,
 *   2. plugin.js with its bare-specifier imports stripped,
 *   3. a bootstrap that clears the session gate and drives register().
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULTS, ENUMS, RANGES, BOOLS, LABELS, HINTS, ENUM_LABELS, GROUPS, COLORS,
} from './schema.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(process.argv[2] || join(HERE, 'src', 'plugin.js'))
const OUT = resolve(process.argv[3] || join(HERE, 'splash-bundle.js'))
const PANEL_SRC = readFileSync(join(HERE, 'src', 'panel.js'), 'utf8')
const SCHEMA_LITERAL = JSON.stringify({
  DEFAULTS, ENUMS, RANGES, BOOLS, LABELS, HINTS, ENUM_LABELS, GROUPS, COLORS,
})

let src = readFileSync(SRC, 'utf8')
const sourceLength = src.length

/* ── 1. strip bare-specifier imports (bindings come from the shims) ─────── */
const importRes = [
  /^[ \t]*import\s*\{[\s\S]*?\}\s*from\s*['"]@hermes\/plugin-sdk['"];?[ \t]*\r?\n/m,
  /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"]react\/jsx-runtime['"];?[ \t]*\r?\n/m,
  /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"]react['"];?[ \t]*\r?\n/m,
]
for (const re of importRes) {
  const before = src
  src = src.replace(re, '')
  if (src === before) throw new Error('expected import statement not found: ' + re)
}

/* ── 2. default export → local binding ─────────────────────────────────── */
const exportRe = /^export default\s*\{/m
if (!exportRe.test(src)) throw new Error('export default { ... } not found')
src = src.replace(exportRe, 'var __HSS_PLUGIN__ = {')

/* Only a statement at the start of a line counts. The old
   /\b(export|import)\b/ also matched the words inside strings, so changing one
   piece of UI copy (e.g. a label reading "Export") could make the build fail
   somewhere completely unrelated. */
const leftoverRe = /^[ \t]*(import|export)\b/m
if (leftoverRe.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''))) {
  throw new Error('leftover import/export statement after transform')
}

/* ── 3. shims + bootstrap ──────────────────────────────────────────────── */
const SHIMS = `
/* ── @hermes/plugin-sdk shim ─────────────────────────────────────────────── */
var host = {
  notify: function (n) { try { console.log('[hermes-startup-screen]', n && n.message) } catch (e) {} },
  navigate: function (p) { try { location.hash = '#' + String(p || '') } catch (e) {} }
}
var haptic = function () {}
var APPEARANCE_AREAS = { extra: 'appearance.extra' }
var PALETTE_AREA = 'palette'
var ROUTES_AREA = 'routes'
var SIDEBAR_NAV_AREA = 'sidebar-nav'
var ToggleRow = function () { return null }
var ListRow = function () { return null }
var SegmentedControl = function () { return null }
var Input = function () { return null }
var Button = function () { return null }

/* ── react shim (the cold-boot path never renders React) ─────────────────── */
function jsx(type, props) { return { __hermesJsxShim: true, type: type, props: props } }
function jsxs(type, props) { return { __hermesJsxShim: true, type: type, props: props } }
function useState(initial) {
  return [typeof initial === 'function' ? initial() : initial, function () {}]
}
`

const BOOTSTRAP = `
/* ── bootstrap ───────────────────────────────────────────────────────────── */
/* config.json 由 watcher.mjs 以 window.__HSS_CONFIG__ 带进来；窗口里的设置面板
   通过本地 API 改完就地更新这个对象，所以 storage.get 每次现读，不缓存。 */
var __HSS_CTX__ = {
  storage: {
    get: function (k, d) {
      if (k === 'config') {
        var live = window.__HSS_CONFIG__
        if (live && typeof live === 'object') return live
        return d
      }
      try {
        var v = window.localStorage.getItem('hss:' + k)
        return v == null ? d : JSON.parse(v)
      } catch (e) { return d }
    },
    set: function (k, v) {
      if (k === 'config') { window.__HSS_CONFIG__ = v; return }
      try { window.localStorage.setItem('hss:' + k, JSON.stringify(v)) } catch (e) {}
    }
  },
  register: function () {},
  onDispose: function () {}
}

/* Only the real Hermes window gets the splash. Two independent signals, and at
   least one must match:
     * the page's own origin - the window renders embedded assets over
       hermesui://localhost/index.html (shown as http://hermesui.localhost/...),
     * window.hermesDesktop, which the app injects.
   The origin check is defence in depth: DevToolsActivePort is a file that can go
   stale, and --remote-debugging-port=0 hands out recycled port numbers, so the
   new-document hook could otherwise inject this whole bundle into an unrelated
   WebView2 app that happened to grab the port. */
function __hssIsHermesPage() {
  try {
    if (String(location.protocol) === 'hermesui:') return true
    if (String(location.hostname) === 'hermesui.localhost') return true
    var d = window.hermesDesktop
    if (d && d.windowType === 'tauri') return true
  } catch (e) {}
  return false
}

/* A future secondary panel window would report a different windowType and is
   left alone. */
function __hssIsMainWindow() {
  try {
    var d = window.hermesDesktop
    if (d && d.windowType && d.windowType !== 'tauri') return false
  } catch (e) {}
  return true
}

function __hssCleanup() {
  try {
    var r = document.getElementById('hermes-startup-root')
    if (r && r.parentNode) r.parentNode.removeChild(r)
  } catch (e) {}
  try {
    document.documentElement.classList.remove('dsu-lock')
    document.documentElement.style.overflow = ''
    if (document.body) document.body.style.overflow = ''
  } catch (e) {}
}

function __hssMount() {
  if (window.__HSS_ACTIVE__) return
  window.__HSS_ACTIVE__ = true
  if (!__hssIsHermesPage()) { console.log('[hermes-splash] not the Hermes UI page, skipping'); return }
  if (!__hssIsMainWindow()) { console.log('[hermes-splash] not the main window, skipping'); return }

  /* WebView2 keeps sessionStorage alive across app restarts, so the plugin's
     mode='session' gate would otherwise skip the animation forever. watcher.mjs
     injects a fresh __HSS_LAUNCH_TOKEN__ once per app launch: a token we have
     not seen yet means a new launch → drop the gate. An in-app reload keeps the
     same token, so with mode='session' the animation does not replay on F5
     (mode='always' replays anyway; the plugin decides). */
  var newLaunch = true
  var token = String(window.__HSS_LAUNCH_TOKEN__ || '')
  try {
    if (token) {
      newLaunch = window.sessionStorage.getItem('hss:launch-token') !== token
      window.sessionStorage.setItem('hss:launch-token', token)
    }
  } catch (e) { newLaunch = true }
  if (newLaunch) {
    try { window.sessionStorage.removeItem('hermes-startup-screen:shown') } catch (e) {}
  }

  try {
    __HSS_PLUGIN__.register(__HSS_CTX__)
  } catch (e) {
    console.error('[hermes-splash] register failed:', e)
    __hssCleanup()
  }
}

/* Cover the window from the first paint: the bundled runtime expects the black
   root node to exist by the time it takes over. */
try {
  var __hssEarly = document.createElement('style')
  __hssEarly.id = 'hermes-startup-screen-early'
  __hssEarly.textContent = 'html.dsu-lock,html.dsu-lock body{overflow:hidden!important}'
  ;(document.head || document.documentElement).appendChild(__hssEarly)
} catch (e) {}

/* ── 把遮罩提到 top layer ─────────────────────────────────────────────────
   应用自己有一个启动遮罩 #hermes-bootstrap-overlay，用的是 z-index: 2147483647
   —— z-index 的上限，普通层叠永远压不过它。这就是「动画被启动页面遮挡」的原因。
   top layer（popover / dialog）绘制在一切 z-index 之上，所以给遮罩加
   popover="manual" 再 showPopover()。重播会重建节点，所以用观察器盯住。 */
function __hssPromote(el) {
  if (!el || !el.isConnected || typeof el.showPopover !== 'function') return
  try {
    if (el.getAttribute('popover') !== 'manual') {
      el.setAttribute('popover', 'manual')
      /* 抵消 popover 的 UA 默认样式（fit-content、margin:auto、border、padding），
         但**不动 background** —— 黑幕底色是插件自己的 CSS 在管 */
      el.style.setProperty('inset', '0', 'important')
      el.style.setProperty('width', 'auto', 'important')
      el.style.setProperty('height', 'auto', 'important')
      el.style.setProperty('margin', '0', 'important')
      el.style.setProperty('border', '0', 'important')
      el.style.setProperty('padding', '0', 'important')
      el.style.setProperty('max-width', 'none', 'important')
      el.style.setProperty('max-height', 'none', 'important')
      el.style.setProperty('overflow', 'hidden', 'important')
    }
    if (!el.matches(':popover-open')) el.showPopover()
  } catch (e) { /* 不支持 popover 就退回普通 z-index，动画照常播 */ }
}

var __hssRootWatched = false
function __hssWatchRoot() {
  if (__hssRootWatched) return
  __hssRootWatched = true
  __hssPromote(document.getElementById('hermes-startup-root'))
  try {
    new MutationObserver(function () {
      __hssPromote(document.getElementById('hermes-startup-root'))
    }).observe(document.body, { childList: true })
  } catch (e) {}
}

if (document.body) {
  __hssWatchRoot()
  __hssMount()
} else {
  var __hssObs = new MutationObserver(function () {
    if (document.body) { __hssObs.disconnect(); __hssWatchRoot(); __hssMount() }
  })
  try { __hssObs.observe(document.documentElement, { childList: true, subtree: true }) } catch (e) {}
  document.addEventListener('DOMContentLoaded', function () { __hssWatchRoot(); __hssMount() }, { once: true })
}
`

const bundle = `/* hermes-startup-screen — self-contained injectable bundle.
 * Generated from src/plugin.js + src/panel.js by build-bundle.mjs — do not edit by hand. */
;(function () {
'use strict'
if (window.__HSS_BUNDLE_LOADED__) return
window.__HSS_BUNDLE_LOADED__ = true
${SHIMS}
${src}
;
${BOOTSTRAP}
/* ── in-window settings panel ────────────────────────────────────────────── */
window.__HSS_SCHEMA__ = ${SCHEMA_LITERAL};
${PANEL_SRC}
})()
`

/* Write to a temp file and rename: an interrupted build must not leave a
   truncated bundle behind, because the watcher only checks that the file
   exists and would happily inject half a script. */
const tmp = `${OUT}.tmp-${process.pid}`
writeFileSync(tmp, bundle, 'utf8')
try {
  renameSync(tmp, OUT)
} catch (e) {
  try { unlinkSync(tmp) } catch { /* best effort */ }
  throw e
}
console.log('plugin source :', SRC, `(${sourceLength} chars)`)
console.log('bundle        :', OUT, `(${bundle.length} chars)`)
console.log('sha256        :', createHash('sha256').update(bundle).digest('hex'))
