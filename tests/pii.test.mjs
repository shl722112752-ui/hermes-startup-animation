// 个人信息护栏（在 CI 里跟着 `node --test` 一起跑）
// ---------------------------------------------------------------------------
// 目的：保证仓库里**不会再次出现**个人信息——真实姓名、私人邮箱、本机用户目录、
// 手机号/身份证号、各种凭据。历史被改写干净之后，这道测试是防止它重新长回来的
// 那道闸门。
//
// 为什么本文件里看不到被禁止的字面量：
//   * 结构性检查（邮箱、手机号、身份证、密钥、带中文的绝对路径）写死在这里；
//   * 和具体某个人绑定的词（例如维护者的姓名）通过环境变量传入，避免「护栏本身
//     又把名字写进仓库」：
//         HSS_PII_DENY="张三,zhangsan@example.org" node --test
//     CI 里没有这些词就自动跳过这一条，本地发布前跑一次即可。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, extname, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 这些后缀是二进制或压缩过的，按文本扫描只会产生噪音。 */
const BINARY = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz',
  '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm',
  '.zip', '.gz', '.tgz', '.7z', '.rar', '.exe', '.dll', '.woff', '.woff2', '.ttf', '.otf'
])

/** 单文件扫描上限，避免把巨大的内联资源整个读进内存。 */
const MAX_BYTES = 2 * 1024 * 1024

/** 允许出现的邮箱：GitHub 的匿名提交邮箱、github.com 本身（URL 里的 user@host）与 example.com。 */
const EMAIL_ALLOW = [
  /(^|\.)users\.noreply\.github\.com$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)example\.(com|org|net)$/i
]

/** 用户目录里可以出现的占位名（写文档用的），其余一律视为泄露。 */
const USER_DIR_ALLOW = new Set(['you', 'your-name', '<you>', '<name>', '%username%', 'me', 'public', 'default'])

/** 绝不能被 git 跟踪的文件（本机状态、生成物、凭据）。 */
const FORBIDDEN_TRACKED = [
  /(^|\/)runtime\/paths\.json$/,
  /(^|\/)runtime\/config\.json$/,
  /(^|\/)runtime\/splash-bundle\.js$/,
  /(^|\/)\.credentials\.yaml$/,
  /(^|\/)auth\.json$/,
  /\.log$/,
  /\.pid$/,
  /\.pem$/,
  /\.key$/
]

function listFiles() {
  try {
    // 已跟踪的文件 + 还没提交但没被忽略的文件：护栏要在 commit 之前就拦住
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 28
    })
    return [...new Set(out.split('\0').filter(Boolean))].map((p) => p.replace(/\\/g, '/'))
  } catch {
    // 没有 git（例如从 zip 解压出来的副本）：退化成遍历目录
    const found = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === '.git' || name === 'node_modules') continue
        const full = join(dir, name)
        const st = statSync(full)
        if (st.isDirectory()) walk(full)
        else found.push(relative(ROOT, full).replace(/\\/g, '/'))
      }
    }
    walk(ROOT)
    return found
  }
}

function loadTextFiles() {
  const files = []
  for (const rel of listFiles()) {
    if (BINARY.has(extname(rel).toLowerCase())) continue
    const full = join(ROOT, rel)
    if (!existsSync(full)) continue
    const st = statSync(full)
    if (!st.isFile() || st.size > MAX_BYTES) continue
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    // 带 NUL 的当二进制处理（内联音频之类的 base64 不会有 NUL，正常扫）
    if (text.includes('\0')) continue
    files.push({ rel, text, lines: text.split(/\r?\n/) })
  }
  return files
}

const FILES = loadTextFiles()

function hits(pattern) {
  const out = []
  for (const f of FILES) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
    f.lines.forEach((line, i) => {
      re.lastIndex = 0
      const m = re.exec(line)
      if (m) out.push({ file: f.rel, line: i + 1, match: m[0], text: line.trim() })
    })
  }
  return out
}

/** 摘录只留头尾，避免把命中的内容整段复制进测试输出。 */
function excerpt(text) {
  const t = text.length > 80 ? `${text.slice(0, 40)}…${text.slice(-20)}` : text
  return t.replace(/[\u0000-\u001f]/g, ' ')
}

function describe(list) {
  return list.map((h) => `  ${h.file}:${h.line}  ${excerpt(h.text)}`).join('\n')
}

test('扫描范围合理（至少覆盖源码、脚本、文档与工作流）', () => {
  assert.ok(FILES.length >= 15, `只扫到 ${FILES.length} 个文本文件，扫描逻辑可能坏了`)
  for (const must of ['README.md', 'LICENSE', 'install.ps1', 'uninstall.ps1', 'get.ps1', 'runtime/schema.mjs', '.github/workflows/ci.yml']) {
    assert.ok(FILES.some((f) => f.rel === must), `没扫到 ${must}`)
  }
})

test('没有私人邮箱（只允许 GitHub 匿名邮箱与 example.com）', () => {
  const bad = hits(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/).filter((h) => {
    const domain = h.match.split('@').pop()
    return !EMAIL_ALLOW.some((ok) => ok.test(domain))
  })
  assert.equal(bad.length, 0, `发现非白名单邮箱：\n${describe(bad)}`)
})

test('没有写死某台机器的用户目录', () => {
  const bad = hits(/[A-Za-z]:\\{1,2}Users\\{1,2}([^\\\s"'>)]+)/i).filter((h) => {
    const name = h.match.replace(/.*Users\\{1,2}/i, '').toLowerCase()
    // <名字> / %USERNAME% 这类占位符是文档里正常的写法
    if (name.startsWith('<') || name.startsWith('%')) return false
    return !USER_DIR_ALLOW.has(name)
  })
  assert.equal(bad.length, 0, `发现写死的用户目录：\n${describe(bad)}`)
})

test('没有带非 ASCII 字符的绝对路径（中文用户名会这样泄露）', () => {
  const bad = hits(/[A-Za-z]:\\{1,2}[^\s"'>]*[^\x00-\x7f]/).filter((h) => !/[<>%]/.test(h.text))
  assert.equal(bad.length, 0, `发现含非 ASCII 的绝对路径：\n${describe(bad)}`)
})

test('没有手机号 / 身份证号', () => {
  const phones = hits(/(?<!\d)1[3-9]\d{9}(?!\d)/)
  const ids = hits(/(?<!\d)\d{17}[\dXx](?!\d)/)
  assert.equal(phones.length, 0, `发现疑似手机号：\n${describe(phones)}`)
  assert.equal(ids.length, 0, `发现疑似身份证号：\n${describe(ids)}`)
})

test('没有凭据（GitHub/Slack/OpenAI token 与私钥）', () => {
  const patterns = [
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  ]
  for (const p of patterns) {
    const bad = hits(p)
    assert.equal(bad.length, 0, `发现疑似凭据 ${p}：\n${describe(bad)}`)
  }
})

test('本机状态与生成物没被 git 跟踪', () => {
  const tracked = listFiles()
  const bad = tracked.filter((f) => FORBIDDEN_TRACKED.some((p) => p.test(f)))
  assert.equal(bad.length, 0, `这些文件不该进仓库：\n  ${bad.join('\n  ')}`)
})

test('自定义黑名单（HSS_PII_DENY）不出现——本地发布前跑一次', () => {
  const deny = (process.env.HSS_PII_DENY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (deny.length === 0) {
    // CI 里没有这些词，跳过；本地可以这样跑：
    //   HSS_PII_DENY="姓名,私人邮箱" node --test
    return
  }
  for (const word of deny) {
    const bad = hits(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(bad.length, 0, `黑名单词命中：\n${describe(bad)}`)
  }
})
