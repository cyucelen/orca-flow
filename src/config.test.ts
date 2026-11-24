import { assert, test } from 'orca/testing'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFile, configuredWriters, readSettings, writeSettings } from './config.ts'
import { DEFAULT_CONFIG } from './capacity.ts'
import { DEFAULT_SETTINGS, normalizeSettings, settingsToSave, type FlowSettings } from './settings.ts'

const temp = () => mkdtempSync(join(tmpdir(), 'orca-flow-config-'))
const fileOf = (dir: string) => JSON.parse(readFileSync(configFile(dir), 'utf8'))
const withSettings = (over: Partial<FlowSettings>): FlowSettings => ({ ...structuredClone(DEFAULT_SETTINGS), ...over })

test('no file reads as defaults; saving defaults creates no file', () => {
  const dir = temp()
  try {
    const read = readSettings(dir)
    assert.deepEqual(read.settings, DEFAULT_SETTINGS)
    assert.equal(read.error, null)
    writeSettings(DEFAULT_SETTINGS, dir)
    assert.equal(existsSync(configFile(dir)), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('only keys that differ from defaults are written; a key set back to default is removed', () => {
  const dir = temp()
  try {
    writeSettings(withSettings({ marginGB: 3.5, linearDryRun: true }), dir)
    assert.deepEqual(fileOf(dir), { marginGB: 3.5, linearDryRun: true })
    writeSettings(withSettings({ marginGB: 2, linearDryRun: true }), dir)
    assert.deepEqual(fileOf(dir), { linearDryRun: true })
    writeSettings(DEFAULT_SETTINGS, dir)
    assert.deepEqual(fileOf(dir), {})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unknown keys and untouched keys stay exactly as written', () => {
  const dir = temp()
  try {
    // marginGB written as the default and an unknown key from a newer version: both survive an unrelated save.
    writeFileSync(configFile(dir), JSON.stringify({ marginGB: 2, futureKey: { a: [1, 2] }, messageFormat: ['~/orca/coordinators'] }))
    const read = readSettings(dir)
    assert.deepEqual(read.settings.messageFormat, ['~/orca/coordinators'])
    writeSettings({ ...read.settings, warnHeadroomGB: 4 }, dir)
    assert.deepEqual(fileOf(dir), { marginGB: 2, futureKey: { a: [1, 2] }, messageFormat: ['~/orca/coordinators'], warnHeadroomGB: 4 })
    writeSettings({ ...readSettings(dir).settings, messageFormat: 'off' }, dir)
    assert.deepEqual(fileOf(dir), { marginGB: 2, futureKey: { a: [1, 2] }, warnHeadroomGB: 4 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('message check keeps the shapes stop-check reads: "all" or a folder list', () => {
  const dir = temp()
  try {
    writeSettings(withSettings({ messageFormat: 'all' }), dir)
    assert.deepEqual(fileOf(dir), { messageFormat: 'all' })
    writeSettings(withSettings({ messageFormat: ['~/orca/workspaces/a', ' ~/b '] }), dir)
    assert.deepEqual(fileOf(dir), { messageFormat: ['~/orca/workspaces/a', '~/b'] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a broken file is reported and never overwritten', () => {
  for (const text of ['{ "marginGB": 3,', '[1, 2]', '"all"']) {
    const dir = temp()
    try {
      writeFileSync(configFile(dir), text)
      const read = readSettings(dir)
      assert.ok(read.error, `error for ${text}`)
      assert.deepEqual(read.settings, DEFAULT_SETTINGS)
      assert.throws(() => writeSettings(withSettings({ marginGB: 5 }), dir), /won’t overwrite/)
      assert.equal(readFileSync(configFile(dir), 'utf8'), text)
      // Its writers read as today's default, so cards keep coming.
      assert.deepEqual(configuredWriters(dir), DEFAULT_SETTINGS.writers)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('writes are atomic: no temporary file is left beside config.json', () => {
  const dir = temp()
  try {
    writeSettings(withSettings({ writers: [{ provider: 'codex', model: 'gpt-6-luna', enabled: true }, { provider: 'claude', model: 'sonnet', enabled: true }, { provider: 'antigravity', model: 'gemini-3.8-flash-low', enabled: false }] }), dir)
    assert.deepEqual(readdirSync(dir), ['config.json'])
    assert.deepEqual(fileOf(dir).writers, [{ provider: 'codex', model: 'gpt-6-luna', enabled: true }, { provider: 'claude', model: 'sonnet', enabled: true }, { provider: 'antigravity', model: 'gemini-3.8-flash-low', enabled: false }])
    assert.deepEqual(configuredWriters(dir).map((w) => `${w.provider}:${w.model ?? ''}`), ['codex:gpt-6-luna', 'claude:sonnet', 'antigravity:gemini-3.8-flash-low'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a saved Antigravity model is kept; an unknown one reads as the default', () => {
  const dir = temp()
  try {
    writeSettings(withSettings({ writers: [{ provider: 'antigravity', model: 'gemini-4-hydrogen-low', enabled: true }] }), dir)
    assert.equal(configuredWriters(dir)[0].model, 'gemini-4-hydrogen-low')
    writeFileSync(configFile(dir), JSON.stringify({ writers: [{ provider: 'antigravity', model: 'gemini-9-ultra', enabled: true }] }))
    assert.deepEqual(configuredWriters(dir)[0], { provider: 'antigravity', model: 'gemini-3.8-flash-low', enabled: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('defaults agree with the capacity check and the stop hook', () => {
  assert.equal(DEFAULT_SETTINGS.marginGB, DEFAULT_CONFIG.marginGB)
  assert.equal(DEFAULT_SETTINGS.warnHeadroomGB, DEFAULT_CONFIG.warnHeadroomGB)
  // stop-check reads anything but "all" or a list as off.
  assert.equal(normalizeSettings({ messageFormat: 'yes' }).messageFormat, 'off')
})

test('the Bots switch is saved under features, leaves other keys as written, and reads back; an older file reads as off', () => {
  const dir = temp()
  try {
    writeFileSync(configFile(dir), JSON.stringify({ marginGB: 2, futureKey: { a: 1 }, linearDryRun: true }))
    assert.equal(readSettings(dir).settings.features.bots, false)
    writeSettings(withSettings({ linearDryRun: true, features: { bots: true, goals: false, linear: true, tokenSpeed: true } }), dir)
    assert.deepEqual(fileOf(dir), { marginGB: 2, futureKey: { a: 1 }, linearDryRun: true, features: { bots: true, goals: false, linear: true, tokenSpeed: true } })
    assert.equal(readSettings(dir).settings.features.bots, true)
    writeSettings(withSettings({ linearDryRun: true }), dir)
    assert.deepEqual(fileOf(dir), { marginGB: 2, futureKey: { a: 1 }, linearDryRun: true })
    writeFileSync(configFile(dir), JSON.stringify({ marginGB: 4, features: ['x'] }))
    assert.deepEqual(readSettings(dir).settings, { ...DEFAULT_SETTINGS, marginGB: 4 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the Linear and Token Speed switches are saved under features; a 0.2.81 file with only bots reads them on', () => {
  const dir = temp()
  try {
    writeFileSync(configFile(dir), JSON.stringify({ marginGB: 2, futureKey: 1, features: { bots: true } }))
    assert.deepEqual(readSettings(dir).settings.features, { bots: true, goals: false, linear: true, tokenSpeed: true })
    writeSettings(withSettings({ features: { bots: true, goals: false, linear: false, tokenSpeed: true } }), dir)
    assert.deepEqual(fileOf(dir), { marginGB: 2, futureKey: 1, features: { bots: true, goals: false, linear: false, tokenSpeed: true } })
    assert.equal(readSettings(dir).settings.features.linear, false)
    writeSettings(withSettings({ features: { bots: true, goals: false, linear: true, tokenSpeed: true } }), dir)
    assert.deepEqual(fileOf(dir).futureKey, 1)
    assert.equal(readSettings(dir).settings.features.linear, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The worker's sidebar.saveSettings: writeSettings(settingsToSave(file now, the dialog's base, the dialog's settings)).
const saveFromDialog = (dir: string, want: FlowSettings, base?: FlowSettings) => writeSettings(settingsToSave(readSettings(dir).settings, base, want), dir)

test('a dialog opened before another change: its save keeps that change and adds only what the user changed', () => {
  const dir = temp()
  try {
    const opened = readSettings(dir).settings                       // the dialog opens: Models as they are
    const elsewhere = structuredClone(opened)                       // a second window (or a hand edit) saves the normal row on Haiku
    elsewhere.routing.workers.normal.model = { agent: 'claude', model: 'haiku' }
    saveFromDialog(dir, elsewhere)
    const draft = structuredClone(opened)                           // in the stale dialog the user changes only the lead
    draft.routing.lead = { agent: 'claude', model: 'sonnet', effort: 'medium' }
    saveFromDialog(dir, draft, opened)
    const routing = readSettings(dir).settings.routing
    assert.deepEqual(routing.lead, { agent: 'claude', model: 'sonnet', effort: 'medium' })
    assert.deepEqual(routing.workers.normal.model, { agent: 'claude', model: 'haiku' })
    // a conflict on one row is the dialog's value
    const conflict = structuredClone(opened)
    conflict.routing.workers.normal.model = { agent: 'claude', model: 'opus', effort: 'high' }
    saveFromDialog(dir, conflict, opened)
    assert.deepEqual(readSettings(dir).settings.routing.workers.normal.model, { agent: 'claude', model: 'opus', effort: 'high' })
    assert.deepEqual(readSettings(dir).settings.routing.lead, { agent: 'claude', model: 'sonnet', effort: 'medium' })
    // an older panel sends no base: written as it is, as before
    saveFromDialog(dir, draft)
    assert.deepEqual(readSettings(dir).settings.routing.workers.normal.model, DEFAULT_SETTINGS.routing.workers.normal.model)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
