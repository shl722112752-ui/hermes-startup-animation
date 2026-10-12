/* hermes-startup-animation —— 窗口内设置面板
 * ============================================================================
 * 注入到 Hermes 窗口里，用窗口自己的位置放一个「启动动画」入口（左下角小按钮）
 * 和 Ctrl+Alt+S 热键，打开的抽屉式设置面板就是本文件。
 *
 * 它不直接写磁盘（页面写不了文件），而是调用 watcher.mjs 起的本地 API
 *   GET  http://127.0.0.1:9334/config
 *   POST http://127.0.0.1:9334/config  {patch:{...}}
 * 守护进程落到 config.json —— 于是「面板 / 命令行 / 文件」永远是同一份数据。
 *
 * 样式全部走应用自己的设计 token（--h-*），所以跟随应用主题，不写死颜色。
 * 本文件由 build-bundle.mjs 内联进 splash-bundle.js，schema 通过 __HSS_SCHEMA__ 传入。
 */
;(function () {
  'use strict'

  var S = window.__HSS_SCHEMA__
  if (!S) { console.warn('[hermes-splash] panel: schema missing'); return }
  if (window.__HSS_PANEL__) return

  var API = 'http://127.0.0.1:' + (window.__HSS_API_PORT__ || 9334)
  var Z_ENTRY = 2147482000   // 低于启动动画（2147483000），动画期间被盖住
  var Z_PANEL = 2147483400   // 高于启动动画，交互动画停住时也能打开面板
  var HOTKEY = { key: 's', ctrl: true, alt: true }

  var CFG = null
  var open = false
  var busy = false
  var rootEl = null
  var entryEl = null
  var previewing = false
  var saveTimer = null
  var pending = {}

  /* ── 小工具 ───────────────────────────────────────────────────────────── */
  function el(tag, style, kids) {
    var n = document.createElement(tag)
    if (style) for (var k in style) n.style[k] = style[k]
    if (kids) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null) return
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return n
  }
  function txt(s) { return document.createTextNode(s) }

  /* 应用的设计 token，缺失时给等价兜底 */
  var C = {
    surface: 'var(--h-color-bg-surface, #ffffff)',
    app: 'var(--h-bg-app, #f4f4f3)',
    soft: 'var(--h-bg-soft, #f7f7f6)',
    text: 'var(--h-text, #171716)',
    text2: 'var(--h-text-2, #3f3f3d)',
    text3: 'var(--h-text-3, #656562)',
    text4: 'var(--h-text-4, #858581)',
    line: 'var(--h-line, #d5d5d2)',
    lineSoft: 'var(--h-line-soft, #e8e8e5)',
    accent: 'var(--h-accent, #171716)',
    onAccent: 'var(--h-color-fg-on-accent, #ffffff)',
    accentSoft: 'var(--h-accent-soft, #ececeb)',
    danger: 'var(--h-color-danger-fg, #ef4444)',
    ok: 'var(--h-color-success-fg, #065f46)',
    font: 'var(--h-font-ui, "HarmonyOS Sans SC", "PingFang SC", system-ui, sans-serif)',
    mono: 'var(--h-font-mono, Consolas, monospace)',
    dur: 'var(--h-duration-normal, .16s)',
    inputH: 'var(--h-control-height-sm, 28px)',
    radius: 'var(--h-radius-sm, 0)',
  }

  function btnStyle(primary) {
    return {
      height: C.inputH, padding: '0 12px', font: 'inherit', cursor: 'pointer',
      border: '1px solid ' + (primary ? C.accent : C.line),
      background: primary ? C.accent : C.soft,
      color: primary ? C.onAccent : C.text,
      borderRadius: C.radius, transition: 'background ' + C.dur,
    }
  }

  /* ── 状态行 ───────────────────────────────────────────────────────────── */
  var statusEl = null
  var statusTimer = null
  function say(msg, kind) {
    if (!statusEl) return
    statusEl.textContent = msg
    statusEl.style.color = kind === 'err' ? C.danger : (kind === 'ok' ? C.ok : C.text3)
    if (statusTimer) clearTimeout(statusTimer)
    if (msg) statusTimer = setTimeout(function () { if (statusEl) statusEl.textContent = '' }, 4000)
  }

  /* 把节点放进 top layer。动画遮罩是 popover，普通 z-index 的面板会被它盖住，
     所以面板也走 popover；后 showPopover 的排在更上层。 */
  function promoteTopLayer(el, moveToTop) {
    if (!el || typeof el.showPopover !== 'function') return
    try {
      if (el.getAttribute('popover') !== 'manual') {
        el.setAttribute('popover', 'manual')
        el.style.setProperty('inset', '0', 'important')
        el.style.setProperty('width', 'auto', 'important')
        el.style.setProperty('height', 'auto', 'important')
        el.style.setProperty('margin', '0', 'important')
        el.style.setProperty('border', '0', 'important')
        el.style.setProperty('padding', '0', 'important')
        el.style.setProperty('max-width', 'none', 'important')
        el.style.setProperty('max-height', 'none', 'important')
        el.style.setProperty('overflow', 'visible', 'important')
        el.style.setProperty('background', 'transparent', 'important')
      }
      if (moveToTop && el.matches(':popover-open')) el.hidePopover()
      if (!el.matches(':popover-open')) el.showPopover()
    } catch (e) { /* 不支持就退回普通 z-index */ }
  }

  function demoteTopLayer(el) {
    try { if (el && el.matches && el.matches(':popover-open')) el.hidePopover() } catch (e) {}
  }

  /* ── 读写 ─────────────────────────────────────────────────────────────── */
  function applyLocal(patch) {
    CFG = Object.assign({}, CFG, patch)
    window.__HSS_CONFIG__ = Object.assign({}, CFG)   // 插件 storage 读的就是它
  }

  function queueSave(key, value) {
    pending[key] = value
    applyLocal({ [key]: value })
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 250)
  }

  function flush() {
    var patch = pending
    pending = {}
    if (!Object.keys(patch).length) return
    fetch(API + '/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: patch }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
      .then(function (res) {
        if (!res.ok || !res.j.ok) throw new Error(res.j.error || 'HTTP ' + res.ok)
        CFG = res.j.config
        window.__HSS_CONFIG__ = Object.assign({}, CFG)
        say('已保存 · ' + new Date().toLocaleTimeString(), 'ok')
        syncEntry()
      })
      .catch(function (e) {
        say('保存失败：' + e.message + '（守护进程没跑？）', 'err')
      })
  }

  function loadConfig() {
    return fetch(API + '/config').then(function (r) { return r.json() })
      .then(function (j) {
        CFG = j.config
        window.__HSS_CONFIG__ = Object.assign({}, CFG)
        if (rootEl) rootEl.fileLine.textContent = j.file || (API + '/config')
        return CFG
      })
      .catch(function () {
        /* API 不通就先用注入时带进来的那份，面板仍可用（保存会报错） */
        CFG = Object.assign({}, S.DEFAULTS, window.__HSS_CONFIG__ || {})
        if (rootEl) rootEl.fileLine.textContent = '本地 API 不通（' + API + '）—— 守护进程没跑？'
        return CFG
      })
  }

  function postAll(obj) {
    return fetch(API + '/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: obj }),
    }).then(function (r) { return r.json() }).then(function (j) {
      if (!j.ok) throw new Error(j.error || '保存失败')
      CFG = j.config
      window.__HSS_CONFIG__ = Object.assign({}, CFG)
      syncEntry()
      return CFG
    })
  }

  /* ── 控件 ─────────────────────────────────────────────────────────────── */
  function row(key) {
    var hint = S.HINTS[key]
    var label = el('div', { flex: '1 1 auto', minWidth: '0' }, [
      el('div', { fontSize: '12.5px', color: C.text }, S.LABELS[key] || key),
      hint ? el('div', { fontSize: '11px', color: C.text4, marginTop: '2px', lineHeight: '1.45' }, hint) : null,
    ])
    return { node: el('div', {
      display: 'flex', alignItems: 'center', gap: '16px',
      padding: '9px 0', borderBottom: '1px solid ' + C.lineSoft,
    }, [label]), label: label }
  }

  function switchCtl(key) {
    var on = CFG[key] !== false
    var knob = el('div', {
      width: 'var(--h-switch-thumb-size, 12px)', height: 'var(--h-switch-thumb-size, 12px)',
      background: on ? C.onAccent : C.text4, borderRadius: '50%',
      transform: on ? 'translateX(14px)' : 'translateX(2px)', transition: 'transform ' + C.dur,
    })
    var track = el('div', {
      width: 'var(--h-switch-width, 32px)', height: 'var(--h-switch-height, 20px)',
      display: 'flex', alignItems: 'center', cursor: 'pointer',
      border: '1px solid ' + (on ? C.accent : C.line),
      background: on ? C.accent : 'transparent', borderRadius: 'var(--h-radius-pill, 0)',
      transition: 'background ' + C.dur,
    }, [knob])
    track.addEventListener('click', function () {
      var next = !(CFG[key] !== false)
      queueSave(key, next)
      refreshUI()
    })
    track.setAttribute('role', 'switch')
    track.setAttribute('aria-checked', String(on))
    return track
  }

  function segmented(key, options, labels) {
    var wrap = el('div', { display: 'flex', border: '1px solid ' + C.line, borderRadius: C.radius, overflow: 'hidden' })
    options.forEach(function (opt) {
      var active = String(CFG[key]) === String(opt)
      var b = el('button', {
        height: 'var(--h-segment-height, 24px)', padding: '0 10px', font: 'inherit',
        cursor: 'pointer', border: 'none', borderRadius: '0',
        background: active ? C.accent : 'transparent',
        color: active ? C.onAccent : C.text2,
        transition: 'background ' + C.dur,
      }, (labels && labels[opt]) || String(opt))
      b.addEventListener('click', function () { queueSave(key, opt); refreshUI() })
      wrap.appendChild(b)
    })
    return wrap
  }

  function rangeCtl(key, lo, hi) {
    var step = (hi - lo) <= 3 ? 0.01 : (hi <= 1200 ? 20 : 0.01)
    var out = el('span', {
      fontFamily: C.mono, fontSize: '11px', color: C.text3,
      minWidth: '46px', textAlign: 'right',
    }, String(CFG[key]))
    var input = el('input', { width: '150px', accentColor: C.accent }, null)
    input.type = 'range'
    input.min = String(lo); input.max = String(hi); input.step = String(step)
    input.value = String(CFG[key])
    input.addEventListener('input', function () { out.textContent = input.value })
    input.addEventListener('change', function () {
      queueSave(key, Number(input.value))
      out.textContent = input.value
    })
    return el('div', { display: 'flex', alignItems: 'center', gap: '10px' }, [input, out])
  }

  function textCtl(key) {
    var input = el('input', {
      height: C.inputH, width: '230px', padding: '0 8px', font: 'inherit',
      color: C.text, background: 'var(--h-color-bg-input, #ffffff)',
      border: '1px solid ' + C.line, borderRadius: C.radius,
    })
    input.type = 'text'
    input.value = String(CFG[key] == null ? '' : CFG[key])
    input.addEventListener('change', function () { queueSave(key, input.value) })
    return input
  }

  function colorCtl(key) {
    var swatch = el('input', {
      width: C.inputH, height: C.inputH, padding: '0', cursor: 'pointer',
      background: 'transparent', border: '1px solid ' + C.line, borderRadius: C.radius,
    })
    swatch.type = 'color'
    swatch.value = String(CFG[key] || '#000000')
    var code = el('input', {
      height: C.inputH, width: '96px', padding: '0 8px', fontFamily: C.mono, fontSize: '11px',
      color: C.text, background: 'var(--h-color-bg-input, #ffffff)',
      border: '1px solid ' + C.line, borderRadius: C.radius,
    })
    code.type = 'text'
    code.value = String(CFG[key] || '')
    swatch.addEventListener('input', function () { code.value = swatch.value; queueSave(key, swatch.value) })
    code.addEventListener('change', function () {
      if (/^#[0-9a-f]{3,8}$/i.test(code.value.trim())) { swatch.value = code.value.trim(); queueSave(key, code.value.trim()) }
      else say('颜色要写成 #rrggbb', 'err')
    })
    return el('div', { display: 'flex', alignItems: 'center', gap: '8px' }, [swatch, code])
  }

  function controlFor(key) {
    if (S.BOOLS.indexOf(key) >= 0) return switchCtl(key)
    if (S.ENUMS[key]) return segmented(key, S.ENUMS[key], S.ENUM_LABELS[key])
    if (S.RANGES[key]) return rangeCtl(key, S.RANGES[key][0], S.RANGES[key][1])
    if (S.COLORS.indexOf(key) >= 0) return colorCtl(key)
    return textCtl(key)
  }

  function groupSection(title, keys) {
    var sec = el('div', null, [
      el('div', {
        fontSize: '11px', letterSpacing: '.08em', color: C.text3, fontWeight: '600',
        margin: '16px 0 4px', textTransform: 'uppercase',
      }, title),
    ])
    keys.forEach(function (key) {
      var r = row(key)
      r.node.appendChild(controlFor(key))
      sec.appendChild(r.node)
    })
    return sec
  }

  /* 「自动 / 交互」是这个面板最常改的一项，单独提到最上面。
     注意它对的是真实键 requireInteraction，不是虚构的 __quick。 */
  function quickSection() {
    var wrap = el('div', {
      display: 'flex', alignItems: 'center', gap: '12px',
      margin: '6px 0 12px', padding: '10px 12px',
      background: C.soft, border: '1px solid ' + C.lineSoft, borderRadius: C.radius,
    })
    wrap.appendChild(el('div', { flex: '1 1 auto' }, [
      el('div', { fontSize: '13px', fontWeight: '600' }, '播放方式'),
      el('div', { fontSize: '11px', color: C.text4, marginTop: '2px' },
        CFG.requireInteraction === false
          ? '六幕自动播完，约 24 秒后揭幕'
          : '第 1、2 步停下来等你按按钮 / Enter，Esc 可跳过'),
    ]))
    var isAuto = CFG.requireInteraction === false
    var seg = el('div', {
      display: 'flex', border: '1px solid ' + C.line,
      borderRadius: C.radius, overflow: 'hidden', flex: '0 0 auto',
    })
    ;[['auto', '自动播放', isAuto], ['interactive', '交互确认', !isAuto]].forEach(function (spec) {
      var b = el('button', {
        height: 'var(--h-segment-height, 24px)', padding: '0 12px', font: 'inherit',
        cursor: 'pointer', border: 'none', borderRadius: '0',
        background: spec[2] ? C.accent : 'transparent',
        color: spec[2] ? C.onAccent : C.text2,
        transition: 'background ' + C.dur,
      }, spec[1])
      b.addEventListener('click', function () {
        queueSave('requireInteraction', spec[0] === 'interactive')
        refreshUI()
      })
      seg.appendChild(b)
    })
    wrap.appendChild(seg)
    return wrap
  }

  /* ── 配置 → 技能 页面里的卡片 ───────────────────────────────────────────
     应用没有插件宿主，所以给技能页加一块自己的卡片只能靠注入：把节点插到
     <main> 的子元素里（React 只按引用管理自己创建的节点，多出来的兄弟节点
     不影响它）。路由切走时随 main 一起消失，切回来或页面重渲染后由定时器
     兜底重新插回。 */
  var pageCard = null
  var cardGuard = null

  function isSkillsRoute() {
    var h = String(location.hash || '')
    return /^#\/skills(\/|$|\?)/.test(h)
  }

  function renderPageCard() {
    if (!pageCard) return
    try {
      pageCard.textContent = ''
      pageCard.appendChild(el('div', { flex: '1 1 260px', minWidth: '220px' }, [
        el('div', { fontSize: '13px', fontWeight: '600' }, '启动动画'),
        el('div', { fontSize: '11px', color: C.text4, marginTop: '2px' },
          'Hermes 桌面开机六幕动画 · 由 hermes-startup-animation 技能管理'),
      ]))

      var enableWrap = el('div', { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' }, [
        el('span', { fontSize: '11.5px', color: C.text3 }, '启用'), switchCtl('enabled'),
      ])
      pageCard.appendChild(enableWrap)

      var isAuto = CFG.requireInteraction === false
      var seg = el('div', {
        display: 'flex', border: '1px solid ' + C.line, borderRadius: C.radius,
        overflow: 'hidden', flex: '0 0 auto',
      })
      ;[['auto', '自动播放', isAuto], ['interactive', '交互确认', !isAuto]].forEach(function (spec) {
        var b = el('button', {
          height: 'var(--h-segment-height, 24px)', padding: '0 12px', font: 'inherit',
          cursor: 'pointer', border: 'none', borderRadius: '0',
          background: spec[2] ? C.accent : 'transparent',
          color: spec[2] ? C.onAccent : C.text2,
          transition: 'background ' + C.dur,
        }, spec[1])
        b.addEventListener('click', function () {
          queueSave('requireInteraction', spec[0] === 'interactive')
          refreshUI()
        })
        seg.appendChild(b)
      })
      pageCard.appendChild(seg)

      var acts = el('div', { display: 'flex', gap: '8px', flex: '0 0 auto' }, [])
      var pv = el('button', btnStyle(false), '预览')
      pv.addEventListener('click', preview)
      var full = el('button', btnStyle(true), '完整设置')
      full.addEventListener('click', show)
      acts.appendChild(pv); acts.appendChild(full)
      pageCard.appendChild(acts)
    } catch (e) {
      console.error('[hermes-splash] skills card render failed:', e)
    }
  }

  /* 卡片该待的位置：标签行（含「内置 Skills / 我的 Skills」那一行）之后、技能列表之前。
     按内容找而不是按索引 —— 页面是逐步渲染的，用 main.children[2] 会在
     标签行还没出现时把卡片丢到页面最底部，之后就再也回不来了。 */
  function cardAnchor(main) {
    for (var i = 0; i < main.children.length; i++) {
      var c = main.children[i]
      if (c === pageCard) continue
      if (/内置\s*Skills|我的\s*Skills|Skill\s*市场/.test(c.textContent || '')) return c.nextElementSibling
    }
    return main.children[1] || null   // 退路：顶部栏之后
  }

  function ensurePageCard() {
    if (!isSkillsRoute()) return
    var main = document.querySelector('main')
    if (!main) return
    if (!pageCard) {
      pageCard = el('div', {
        margin: '12px 16px 0', padding: '12px 14px',
        display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap',
        background: C.soft, border: '1px solid ' + C.lineSoft, borderRadius: C.radius,
        font: '12.5px/1.5 ' + C.font, color: C.text,
      })
      pageCard.setAttribute('data-hss-card', '')
      renderPageCard()
    }
    var anchor = cardAnchor(main)
    if (anchor !== pageCard) main.insertBefore(pageCard, anchor)
  }

  function startCardGuard() {
    if (cardGuard) return
    /* 路由切过来时页面是渐进渲染的，多补几次 */
    window.addEventListener('hashchange', function () {
      ;[350, 1200, 2600].forEach(function (ms) { setTimeout(ensurePageCard, ms) })
    })
    cardGuard = setInterval(function () {
      if (isSkillsRoute()) ensurePageCard()
    }, 2000)
  }

  /* 重播会重建动画遮罩节点，新节点 showPopover 之后会排到面板上面。
     面板开着的时候就再提一次，保证「面板 > 动画」。 */
  function startSplashWatch() {
    try {
      new MutationObserver(function () {
        if (!open || !rootEl) return
        var splash = document.getElementById('hermes-startup-root')
        if (splash && splash.matches(':popover-open')) promoteTopLayer(rootEl.wrap, true)
      }).observe(document.body, { childList: true })
    } catch (e) {}
  }

  /* ── 面板 DOM ─────────────────────────────────────────────────────────── */
  /* 抽屉和技能页卡片共用同一份 CFG，改完两边一起刷 */
  function refreshUI() { rebuild(); renderPageCard() }

  function rebuild() {
    try {
      var body = rootEl && rootEl.body
      if (!body) return
      body.textContent = ''
      body.appendChild(quickSection())
      S.GROUPS.forEach(function (g) { body.appendChild(groupSection(g.title, g.keys)) })
    } catch (e) {
      /* 面板渲染炸了也不能连累窗口，如实报出来 */
      console.error('[hermes-splash] panel rebuild failed:', e)
      say('面板渲染失败：' + e.message, 'err')
    }
  }

  function buildPanel() {
    statusEl = el('div', { fontSize: '11px', color: C.text3, minHeight: '14px', flex: '1 1 auto' })

    var closeBtn = el('button', btnStyle(false), '关闭')
    closeBtn.addEventListener('click', hide)

    var previewBtn = el('button', btnStyle(true), '预览动画')
    previewBtn.addEventListener('click', preview)

    var resetBtn = el('button', btnStyle(false), '恢复默认')
    resetBtn.addEventListener('click', function () {
      busy = true
      postAll(S.DEFAULTS).then(function () { busy = false; refreshUI(); say('已恢复默认值', 'ok') })
        .catch(function (e) { busy = false; say('恢复失败：' + e.message, 'err') })
    })

    var hint = el('div', { fontSize: '11px', color: C.text4, marginTop: '2px' },
      '改动即时保存到 config.json；窗口左下角入口和 Ctrl+Alt+S 都能打开这里')

    var fileLine = el('div', { fontFamily: C.mono, fontSize: '11px', color: C.text4, marginTop: '2px' }, '')

    var header = el('div', {
      padding: '14px 16px 12px', borderBottom: '1px solid ' + C.lineSoft,
      display: 'flex', alignItems: 'flex-start', gap: '12px',
    }, [
      el('div', { flex: '1 1 auto', minWidth: '0' }, [
        el('div', { fontSize: '14px', fontWeight: '600' }, '启动动画设置'),
        hint, fileLine,
      ]),
      closeBtn,
    ])

    var body = el('div', { padding: '0 16px 16px', overflowY: 'auto', flex: '1 1 auto' })
    body.setAttribute('data-hss-body', '')

    var footer = el('div', {
      padding: '12px 16px', borderTop: '1px solid ' + C.lineSoft,
      display: 'flex', alignItems: 'center', gap: '8px', background: C.soft,
    }, [previewBtn, resetBtn, statusEl])

    var card = el('div', {
      position: 'fixed', top: '0', right: '0', bottom: '0',
      width: 'min(600px, 94vw)', display: 'flex', flexDirection: 'column',
      background: C.surface, color: C.text, font: '12.5px/1.55 ' + C.font,
      borderLeft: '1px solid ' + C.line, zIndex: String(Z_PANEL),
      transform: 'translateX(100%)', transition: 'transform ' + 'var(--h-duration-slow, .22s)',
    }, [header, body, footer])

    var backdrop = el('div', {
      position: 'fixed', inset: '0', background: 'rgba(23,23,22,.22)',
      zIndex: String(Z_PANEL - 1), opacity: '0', transition: 'opacity ' + C.dur,
    })
    backdrop.addEventListener('click', hide)

    var wrap = el('div', { position: 'fixed', inset: '0', zIndex: String(Z_PANEL), display: 'none' }, [backdrop, card])
    wrap.setAttribute('data-hss-panel', '')
    rootEl = { wrap: wrap, card: card, backdrop: backdrop, fileLine: fileLine, body: body }
    document.body.appendChild(wrap)
  }

  /* 可见性以 DOM 为准，不靠 open 变量推断——变量一旦和 DOM 不同步，
     热键就会「按一下没反应、再按一下才关」*/
  function isVisible() {
    return !!(rootEl && rootEl.wrap.style.display !== 'none')
  }

  function show() {
    if (isVisible()) return
    if (!rootEl) buildPanel()
    rootEl.wrap.style.display = 'block'
    promoteTopLayer(rootEl.wrap, true)
    // 下一帧再上过渡，不然 transform 不会动
    requestAnimationFrame(function () {
      rootEl.card.style.transform = 'translateX(0)'
      rootEl.backdrop.style.opacity = '1'
    })
    open = true
    loadConfig().then(function () {
      rootEl.fileLine.textContent = 'config.json · ' + API
      rebuild()
      say('')
    })
    rebuild()
  }

  function hide() {
    if (!rootEl || !isVisible()) return
    restorePanel()
    rootEl.card.style.transform = 'translateX(100%)'
    rootEl.backdrop.style.opacity = '0'
    demoteTopLayer(rootEl.wrap)
    open = false
    setTimeout(function () { if (!open && rootEl) rootEl.wrap.style.display = 'none' }, 240)
  }

  /* 预览：把面板藏起来播一遍，动画结束（遮罩消失）再露出来。
     交互模式下动画会停在第一步等人按，所以顶上留一个「回到设置」的芯片，
     不用等动画播完。 */
  var previewChip = null

  function showPreviewChip() {
    if (previewChip) return
    previewChip = el('button', {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
      zIndex: String(Z_PANEL + 1), height: '30px', padding: '0 14px',
      font: '12px/1 ' + C.font, cursor: 'pointer', whiteSpace: 'nowrap',
      background: C.accent, color: C.onAccent,
      border: '1px solid ' + C.accent, borderRadius: C.radius,
    }, '预览中 · 点这里回到设置')
    previewChip.addEventListener('click', restorePanel)
    document.body.appendChild(previewChip)
  }

  function hidePreviewChip() {
    if (previewChip && previewChip.parentNode) previewChip.parentNode.removeChild(previewChip)
    previewChip = null
  }

  function preview() {
    flush()
    var api = window.__DSH_STARTUP_API__
    if (!api || typeof api.replay !== 'function') { say('动画还没注入，无法预览（可先重启 Hermes）', 'err'); return }
    if (previewing) return
    previewing = true
    if (rootEl) { rootEl.card.style.opacity = '0'; rootEl.backdrop.style.opacity = '0' }
    showPreviewChip()
    setTimeout(function () {
      try { api.replay() } catch (e) { say('预览失败：' + e.message, 'err'); restorePanel() }
      var t0 = Date.now()
      var iv = setInterval(function () {
        var root = document.getElementById('hermes-startup-root')
        if (!root || Date.now() - t0 > 120000) { clearInterval(iv); restorePanel() }
      }, 300)
    }, 220)
  }

  function restorePanel() {
    previewing = false
    hidePreviewChip()
    if (rootEl && open) {
      rootEl.card.style.opacity = '1'
      rootEl.backdrop.style.opacity = '1'
      /* 动画遮罩也是 top layer，重新 showPopover 把面板提到它上面 */
      promoteTopLayer(rootEl.wrap, true)
    }
  }

  /* ── 左下角入口 ───────────────────────────────────────────────────────── */
  function mountEntry() {
    if (entryEl && entryEl.parentNode) return
    var cfg = CFG || window.__HSS_CONFIG__ || S.DEFAULTS
    if (cfg.showEntry === false) return
    entryEl = el('button', {
      position: 'fixed', left: '12px', bottom: '12px', zIndex: String(Z_ENTRY),
      height: 'var(--h-control-height-sm, 28px)', padding: '0 10px',
      display: 'flex', alignItems: 'center', gap: '6px',
      font: '11.5px/1 ' + C.font, color: C.text3, cursor: 'pointer',
      background: C.soft, border: '1px solid ' + C.line, borderRadius: C.radius,
      opacity: '.72', transition: 'opacity ' + C.dur,
    }, [el('span', { fontSize: '12px' }, '▶'), '启动动画'])
    entryEl.title = '打开启动动画设置（Ctrl+Alt+S）'
    entryEl.addEventListener('mouseenter', function () { entryEl.style.opacity = '1' })
    entryEl.addEventListener('mouseleave', function () { entryEl.style.opacity = '.72' })
    entryEl.addEventListener('click', show)
    document.body.appendChild(entryEl)
  }

  function removeEntry() {
    if (entryEl && entryEl.parentNode) entryEl.parentNode.removeChild(entryEl)
    entryEl = null
  }

  function syncEntry() {
    var cfg = CFG || window.__HSS_CONFIG__ || S.DEFAULTS
    if (cfg.showEntry === false) removeEntry()
    else mountEntry()
  }

  /* ── 热键 ─────────────────────────────────────────────────────────────── */
  var lastHotkeyAt = 0
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.altKey && String(e.key).toLowerCase() === HOTKEY.key) {
      e.preventDefault(); e.stopPropagation()
      /* 一次按键只切一次：万一监听器被登记了两遍也不会来回开合 */
      var now = Date.now()
      if (now - lastHotkeyAt < 300) return
      lastHotkeyAt = now
      if (isVisible()) hide(); else show()
      return
    }
    if (e.key === 'Escape' && isVisible()) {
      /* 抢在启动动画的 Esc 跳过之前，先关面板 */
      e.preventDefault(); e.stopPropagation(); hide()
    }
  }, true)

  window.__HSS_PANEL__ = {
    open: show,
    close: hide,
    toggle: function () { open ? hide() : show() },
    mount: function () {
      CFG = Object.assign({}, S.DEFAULTS, window.__HSS_CONFIG__ || {})
      syncEntry()
      startCardGuard()
      startSplashWatch()
      ensurePageCard()
      /* 拿一次权威配置：技能页卡片可能在 loadConfig 之前就要渲染 */
      loadConfig().then(function () { renderPageCard() })
    },
    get isOpen() { return open },
    get config() { return CFG },
  }

  /* 页面加载完就把入口挂上（启动动画期间会被自己的遮罩盖住，播完自然露出） */
  if (document.body) window.__HSS_PANEL__.mount()
  else document.addEventListener('DOMContentLoaded', function () { window.__HSS_PANEL__.mount() }, { once: true })
})()
