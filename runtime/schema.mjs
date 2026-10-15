/* 启动动画的设置 schema —— 单一真源
 * ============================================================================
 * watcher.mjs（本地 API 的校验）、config-cli.mjs（命令行）、build-bundle.mjs
 * （把 schema 内联进窗口里的设置面板）都从这里取，避免三处各写一份漂移。
 * 键名与 src/plugin.js 顶部的 DEFAULTS / ENUMS / RANGES 一致（那是本体）。
 */

export const DEFAULTS = {
  enabled: true, mode: 'session', theme: 'light', speed: 1,
  requireInteraction: true, allowSkip: true,
  sound: true, soundVolume: 0.5, voice: true, voiceLang: 'en', voiceName: '',
  voiceRate: 0.88, voicePitch: 0.85, voiceVolume: 0.9, voiceCue: true,
  sfx: 'audio', voiceSource: 'asset', voiceLead: 240,
  identity: 'OMOX', identityId: '9b5b3b37a1b8ebf7', accessLevel: '0',
  brand1: 'HERMES', brand2: 'AGENTIC INTELLIGENCE', brand3a: 'DESKTOP', brand3b: 'APP',
  orgZh: '赫尔墨斯', orgEn: 'HERMES', orgSub: 'HERMES DESKTOP',
  welcomeBox: 'HERMES DESKTOP', footer: 'POWERED BY NOUS RESEARCH',
  accent: '#ff7500', glitchA: '#ff3b30', glitchB: '#2971b8',
  /* 以下是面板自己的开关，插件会忽略未知键。
     入口按钮默认关：设置卡片已经长在「配置 → 技能」页里，Ctrl+Alt+S 也随时可用。 */
  showEntry: false,
}

export const ENUMS = {
  mode: ['always', 'session', 'daily'],
  theme: ['light', 'dark'],
  voiceLang: ['en', 'zh', 'both'],
  sfx: ['audio', 'synth'],
  voiceSource: ['asset', 'tts'],
}

export const RANGES = {
  speed: [0.35, 3], soundVolume: [0, 1], voiceRate: [0.5, 2],
  voicePitch: [0, 2], voiceVolume: [0, 1], voiceLead: [0, 1200],
}

export const BOOLS = ['enabled', 'requireInteraction', 'allowSkip', 'sound', 'voice', 'voiceCue', 'showEntry']

/* 面板/文档用的中文标签（对齐 dsh-startup-screen 设置页的叫法） */
export const LABELS = {
  enabled: '启用', mode: '显示模式', theme: '主题', speed: '速度',
  requireInteraction: '要求确认', allowSkip: '允许跳过',
  sound: '界面音效', soundVolume: '音效音量', voice: '语音播报', voiceLang: '语言',
  voiceName: '音色', voiceRate: '语速', voicePitch: '音调', voiceVolume: '音量',
  voiceCue: '播报前提示音', sfx: '音效来源', voiceSource: '语音来源', voiceLead: '开口前留白',
  identity: '身份名称', identityId: '身份编号', accessLevel: '权限等级',
  brand1: '品牌行 1', brand2: '品牌行 2', brand3a: '品牌行 3（左）', brand3b: '品牌行 3（右）',
  orgZh: '黑幕中文行', orgEn: '黑幕英文行', orgSub: '黑幕副行',
  welcomeBox: '终幕方框', footer: '页脚',
  accent: '强调色', glitchA: '故障色 A', glitchB: '故障色 B',
  showEntry: '显示入口按钮',
}

export const HINTS = {
  mode: 'session 每次启动播一次 / always 每次页面加载都播 / daily 每天一次',
  requireInteraction: '开：第 1、2 步停下来等你按按钮或 Enter（可关）',
  allowSkip: '显示右上角 SKIP 按钮，并响应 Esc',
  speed: '整段动画的快慢',
  voiceSource: '真声素材 = 内置录音；系统 TTS = 浏览器合成音',
  sfx: '内置素材 = 录音；现场合成 = 代码合成',
  voiceLead: '提示音响过之后停多久再开口',
  identity: '终幕「欢迎 xxx 访问」里的名字',
  identityId: '第 2 幕身份卡上的编号',
  accessLevel: '第 2 幕身份卡上的权限等级',
  accent: '阶段条、进度条、准星的主题色',
  showEntry: '窗口左下角那个「启动动画」小按钮；关掉后仍可按 Ctrl+Alt+S 打开面板',
}

export const ENUM_LABELS = {
  mode: { always: '每次加载', session: '每次启动', daily: '每天' },
  theme: { light: '暖白', dark: '暗色' },
  voiceLang: { en: '英文', zh: '中文', both: '双语' },
  sfx: { audio: '内置素材', synth: '现场合成' },
  voiceSource: { asset: '真声素材', tts: '系统 TTS' },
}

/* 面板分组与顺序（对应 dsh 设置页的六个分区） */
export const GROUPS = [
  { title: '播放', keys: ['enabled', 'requireInteraction', 'allowSkip', 'mode', 'theme', 'speed'] },
  { title: '身份资料', keys: ['identity', 'identityId', 'accessLevel'] },
  { title: '语音', keys: ['voice', 'voiceSource', 'voiceLang', 'voiceName', 'voiceRate', 'voicePitch', 'voiceVolume', 'voiceCue', 'voiceLead'] },
  { title: '界面音效', keys: ['sound', 'soundVolume', 'sfx'] },
  { title: '视觉', keys: ['accent', 'glitchA', 'glitchB'] },
  { title: '文案', keys: ['brand1', 'brand2', 'brand3a', 'brand3b', 'orgZh', 'orgEn', 'orgSub', 'welcomeBox', 'footer'] },
  { title: '面板', keys: ['showEntry'] },
]

export const COLORS = ['accent', 'glitchA', 'glitchB']

/** 值归一化 + 校验；未知键放行（插件会忽略），已知键按类型检查。 */
export function coerceValue(key, raw) {
  if (BOOLS.includes(key)) {
    if (typeof raw === 'boolean') return raw
    if (/^(true|on|1|yes|是|开)$/i.test(String(raw))) return true
    if (/^(false|off|0|no|否|关)$/i.test(String(raw))) return false
    throw new Error(`${key} 只接受 true/false`)
  }
  if (RANGES[key]) {
    const n = Number(raw)
    const [lo, hi] = RANGES[key]
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${key} 必须在 ${lo}–${hi} 之间`)
    return n
  }
  if (ENUMS[key]) {
    const v = String(raw).toLowerCase()
    if (!ENUMS[key].includes(v)) throw new Error(`${key} 只能是 ${ENUMS[key].join(' / ')}`)
    return v
  }
  if (COLORS.includes(key)) {
    const v = String(raw).trim()
    if (!/^#[0-9a-f]{3,8}$/i.test(v)) throw new Error(`${key} 必须是 #rrggbb 形式`)
    return v
  }
  if (raw === null || raw === undefined) throw new Error(`${key} 不能为空`)
  return typeof raw === 'string' ? raw : String(raw)
}

/** 校验整份 patch；返回清洗后的对象。 */
export function coercePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('请求体必须是一个对象')
  }
  const out = {}
  for (const [k, v] of Object.entries(patch)) out[k] = coerceValue(k, v)
  return out
}

/** 补齐默认值（不改原对象）。 */
export function withDefaults(cfg) {
  return { ...DEFAULTS, ...(cfg || {}) }
}
