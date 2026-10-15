/* Tests for runtime/schema.mjs — the single source of truth for every setting.
 * These guard the schema against drift and pin down the validation rules that the
 * settings panel, the CLI and the watcher all rely on.
 *
 * Run: node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULTS, ENUMS, ENUM_LABELS, RANGES, BOOLS, COLORS, LABELS, GROUPS,
  coerceValue, coercePatch, withDefaults,
} from '../runtime/schema.mjs'

const groupKeys = GROUPS.flatMap((g) => g.keys)

test('schema drift guards', () => {
  assert.deepEqual(groupKeys.filter((k) => !(k in DEFAULTS)), [],
    'every key shown in the settings panel must exist in DEFAULTS')
  assert.deepEqual(Object.keys(DEFAULTS).filter((k) => !groupKeys.includes(k)), [],
    'every setting must be reachable from some panel group')
  assert.deepEqual(groupKeys.filter((k, i) => groupKeys.indexOf(k) !== i), [],
    'a setting must not be listed twice')
  assert.deepEqual(groupKeys.filter((k) => !(k in LABELS)), [],
    'every setting needs a human label')
  for (const [name, keys] of [['BOOLS', BOOLS], ['RANGES', Object.keys(RANGES)],
    ['ENUMS', Object.keys(ENUMS)], ['COLORS', COLORS], ['LABELS', Object.keys(LABELS)]]) {
    assert.deepEqual(keys.filter((k) => !(k in DEFAULTS)), [], `${name} refers to unknown settings`)
  }
  for (const [key, values] of Object.entries(ENUMS)) {
    assert.ok(ENUM_LABELS[key], `enum ${key} needs labels`)
    assert.deepEqual(values.filter((v) => !(v in ENUM_LABELS[key])), [],
      `every value of ${key} needs a label`)
  }
})

test('coerceValue: booleans accept the documented spellings', () => {
  for (const v of ['true', 'TRUE', 'on', 'ON', '1', 'yes', '是', '开']) {
    assert.equal(coerceValue('enabled', v), true, `"${v}" should mean true`)
  }
  for (const v of ['false', 'off', '0', 'no', '否', '关']) {
    assert.equal(coerceValue('enabled', v), false, `"${v}" should mean false`)
  }
  assert.equal(coerceValue('enabled', true), true)
  assert.equal(coerceValue('enabled', false), false)
  assert.throws(() => coerceValue('enabled', 'maybe'), /只接受 true\/false/)
  assert.throws(() => coerceValue('enabled', null), /只接受 true\/false/)
})

test('coerceValue: numbers are range checked', () => {
  assert.equal(coerceValue('speed', 1.5), 1.5)
  assert.equal(coerceValue('speed', '2'), 2)
  assert.equal(coerceValue('soundVolume', 0), 0)
  assert.throws(() => coerceValue('speed', 0.1), /必须在/)
  assert.throws(() => coerceValue('speed', 10), /必须在/)
  assert.throws(() => coerceValue('soundVolume', 2), /必须在/)
  assert.throws(() => coerceValue('speed', 'fast'), /必须在/)
})

test('coerceValue: enums are case-insensitive and closed', () => {
  assert.equal(coerceValue('mode', 'SESSION'), 'session')
  assert.equal(coerceValue('mode', 'daily'), 'daily')
  assert.equal(coerceValue('theme', 'DARK'), 'dark')
  assert.equal(coerceValue('voiceLang', 'BOTH'), 'both')
  assert.equal(coerceValue('sfx', 'Synth'), 'synth')
  assert.throws(() => coerceValue('mode', 'hourly'), /只能是/)
  assert.throws(() => coerceValue('theme', ''), /只能是/)
})

test('coerceValue: colours must be hex (regression: the check used to be skipped)', () => {
  // COLORS is an array; `COLORS[key]` is always undefined, which silently disabled
  // this branch and let any string through. `COLORS.includes(key)` fixed it.
  assert.equal(coerceValue('accent', '#ff7500'), '#ff7500')
  assert.equal(coerceValue('accent', '#ABC'), '#ABC')
  assert.equal(coerceValue('accent', '#12345678'), '#12345678')
  assert.equal(coerceValue('accent', '  #fff  '), '#fff', 'surrounding whitespace is trimmed')
  assert.throws(() => coerceValue('accent', 'red'), /必须是 #rrggbb/)
  assert.throws(() => coerceValue('accent', '#123456789'), /必须是 #rrggbb/)
  assert.throws(() => coerceValue('glitchB', 'javascript:alert(1)'), /必须是 #rrggbb/)
  assert.throws(() => coerceValue('accent', ''), /必须是 #rrggbb/)
})

test('coerceValue: free-form text passes through, empties do not', () => {
  assert.equal(coerceValue('brand1', 'HERMES'), 'HERMES')
  assert.equal(coerceValue('identityId', '23D126'), '23D126')
  assert.equal(coerceValue('brand1', 42), '42', 'non-strings are stringified')
  assert.equal(coerceValue('brand1', ''), '', 'an explicit empty string is allowed')
  assert.throws(() => coerceValue('brand1', null), /不能为空/)
  assert.throws(() => coerceValue('brand1', undefined), /不能为空/)
})

test('coercePatch: shape is enforced before any value is touched', () => {
  for (const bad of [null, undefined, 'mode=daily', 42, [], [['mode', 'daily']]]) {
    assert.throws(() => coercePatch(bad), /请求体必须是一个对象/, `${JSON.stringify(bad)} is not a patch`)
  }
  assert.deepEqual(coercePatch({}), {})
})

test('coercePatch: cleans a mixed patch and rejects the whole thing on one bad value', () => {
  assert.deepEqual(coercePatch({ mode: 'daily', speed: '1.25', accent: '#0af', enabled: 'off' }),
    { mode: 'daily', speed: 1.25, accent: '#0af', enabled: false })
  assert.deepEqual(coercePatch({ whatever: 7 }), { whatever: '7' },
    'unknown keys are kept so the panel can carry them, but still coerced')
  assert.throws(() => coercePatch({ mode: 'daily', speed: 99 }), /必须在/)
})

test('withDefaults: fills gaps without mutating the input', () => {
  assert.deepEqual(withDefaults({}), DEFAULTS)
  assert.deepEqual(withDefaults(null), DEFAULTS)
  assert.deepEqual(withDefaults(undefined), DEFAULTS)

  const given = Object.freeze({ mode: 'always', speed: 2 })
  const out = withDefaults(given)
  assert.equal(out.mode, 'always')
  assert.equal(out.speed, 2)
  assert.equal(out.theme, DEFAULTS.theme, 'unspecified keys fall back to the default')
  assert.deepEqual({ ...given }, { mode: 'always', speed: 2 }, 'the input object is untouched')
  assert.notEqual(out, given)
})

test('DEFAULTS ship as auto-play with the card entry hidden', () => {
  assert.equal(DEFAULTS.enabled, true)
  assert.equal(DEFAULTS.mode, 'session')
  assert.equal(DEFAULTS.requireInteraction, false, 'a fresh install must not wait for a keypress')
  assert.equal(DEFAULTS.showEntry, false, 'the skills-page card replaces the floating entry')
  assert.equal(DEFAULTS.accent, '#ff7500')
})
