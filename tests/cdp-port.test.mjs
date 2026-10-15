/* Tests for runtime/cdp-port.mjs — the port-discovery logic that decides which CDP
 * port the injector talks to. Pure filesystem logic, so it is fully testable.
 *
 * Run: node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readPaths, activePortFiles, readActivePort, discoverCdpPort } from '../runtime/cdp-port.mjs'

const scratch = () => mkdtempSync(join(tmpdir(), 'hsa-cdp-'))

/** Build a fake Hermes layout: <dir>/data/webview2/<name>/DevToolsActivePort */
function fixture(webviewDirs) {
  const root = scratch()
  const hermesDir = join(root, 'hermes')
  for (const [name, content] of Object.entries(webviewDirs)) {
    const dir = join(hermesDir, 'data', 'webview2', name)
    mkdirSync(dir, { recursive: true })
    if (content !== null) writeFileSync(join(dir, 'DevToolsActivePort'), content)
  }
  return { root, hermesDir, paths: { hermesDir } }
}

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'HSS_CDP_PORT')
  const prev = process.env.HSS_CDP_PORT
  if (value === undefined) delete process.env.HSS_CDP_PORT
  else process.env.HSS_CDP_PORT = value
  try { return fn() } finally {
    if (had) process.env.HSS_CDP_PORT = prev
    else delete process.env.HSS_CDP_PORT
  }
}

test('readPaths: missing / broken / valid paths.json', () => {
  const root = scratch()
  assert.deepEqual(readPaths(root), {}, 'missing file must yield an empty object, not throw')

  writeFileSync(join(root, 'paths.json'), '{ not json')
  assert.deepEqual(readPaths(root), {}, 'broken JSON must yield an empty object')

  writeFileSync(join(root, 'paths.json'), JSON.stringify({ hermesDir: 'H:\\h', cdpPort: 0 }))
  assert.equal(readPaths(root).hermesDir, 'H:\\h')

  rmSync(root, { recursive: true, force: true })
})

test('activePortFiles: no hermesDir => no candidates; otherwise EBWebView first', () => {
  assert.deepEqual(activePortFiles({}), [])
  assert.deepEqual(activePortFiles(null), [])

  const { root, hermesDir } = fixture({ EBWebView: null, profile2: null })
  const files = activePortFiles({ hermesDir })
  assert.equal(files[0], join(hermesDir, 'data', 'webview2', 'EBWebView', 'DevToolsActivePort'),
    'the canonical EBWebView location must be probed first')
  assert.ok(files.some((f) => f.includes('profile2')), 'sibling webview dirs are probed too')
  rmSync(root, { recursive: true, force: true })
})

test('activePortFiles: missing webview2 dir is not an error', () => {
  const root = scratch()
  assert.deepEqual(activePortFiles({ hermesDir: join(root, 'nope') }), [join(root, 'nope', 'data', 'webview2', 'EBWebView', 'DevToolsActivePort')])
  rmSync(root, { recursive: true, force: true })
})

test('readActivePort: returns null when nothing is there', () => {
  const root = scratch()
  assert.equal(readActivePort({ hermesDir: join(root, 'hermes') }), null)
  assert.equal(readActivePort({}), null)
  rmSync(root, { recursive: true, force: true })
})

test('readActivePort: parses the first line and reports the file', () => {
  const { root, hermesDir } = fixture({ EBWebView: '49187\n/devtools/browser/abc-123\n' })
  const got = readActivePort({ hermesDir })
  assert.equal(got.port, 49187)
  assert.ok(got.file.endsWith('DevToolsActivePort'))
  rmSync(root, { recursive: true, force: true })
})

test('readActivePort: newest modification wins', () => {
  const { root, hermesDir } = fixture({ EBWebView: '1111\n', other: '2222\n' })
  const older = new Date(Date.now() - 60_000)
  const newer = new Date()
  utimesSync(join(hermesDir, 'data', 'webview2', 'EBWebView', 'DevToolsActivePort'), older, older)
  utimesSync(join(hermesDir, 'data', 'webview2', 'other', 'DevToolsActivePort'), newer, newer)
  assert.equal(readActivePort({ hermesDir }).port, 2222)

  // ...and flipping which one is fresh flips the answer
  utimesSync(join(hermesDir, 'data', 'webview2', 'EBWebView', 'DevToolsActivePort'), newer, newer)
  utimesSync(join(hermesDir, 'data', 'webview2', 'other', 'DevToolsActivePort'), older, older)
  assert.equal(readActivePort({ hermesDir }).port, 1111)
  rmSync(root, { recursive: true, force: true })
})

test('readActivePort: garbage / non-positive first lines are ignored', () => {
  const { root, hermesDir } = fixture({ a: '\n/devtools/browser/x\n', b: 'not-a-port\n', c: '0\n' })
  assert.equal(readActivePort({ hermesDir }), null)
  rmSync(root, { recursive: true, force: true })
})

test('discoverCdpPort: priority is explicit > env > fixed > DevToolsActivePort > none', () => {
  const { root, hermesDir } = fixture({ EBWebView: '49187\n/devtools/browser/abc\n' })
  const paths = { hermesDir, cdpPort: 9333 }

  assert.deepEqual(discoverCdpPort(paths, 9222), { port: 9222, source: 'explicit' })
  withEnv('8111', () => assert.deepEqual(discoverCdpPort(paths, undefined), { port: 8111, source: 'HSS_CDP_PORT' }))
  withEnv('8111', () => assert.deepEqual(discoverCdpPort(paths, 9222), { port: 9222, source: 'explicit' },
    'an explicit port still beats the environment'))
  withEnv(undefined, () => assert.deepEqual(discoverCdpPort(paths, undefined), { port: 9333, source: 'fixed' }))

  withEnv(undefined, () => {
    const auto = discoverCdpPort({ hermesDir, cdpPort: 0 }, undefined)
    assert.equal(auto.port, 49187)
    assert.equal(auto.source, 'DevToolsActivePort')
    assert.ok(auto.file.endsWith('DevToolsActivePort'))
  })

  withEnv(undefined, () => {
    const none = discoverCdpPort({ hermesDir: join(root, 'absent'), cdpPort: 0 }, undefined)
    assert.deepEqual(none, { port: null, source: 'none' })
  })
  rmSync(root, { recursive: true, force: true })
})

test('discoverCdpPort: cdpPort 0 means "auto", never "port zero"', () => {
  const { root, hermesDir } = fixture({ EBWebView: '5555\n' })
  withEnv(undefined, () => {
    const r = discoverCdpPort({ hermesDir, cdpPort: 0 }, undefined)
    assert.notEqual(r.port, 0)
    assert.equal(r.port, 5555)
  })
  rmSync(root, { recursive: true, force: true })
})
