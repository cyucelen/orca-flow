import { assert, test } from 'orca/testing'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFile, configuredWriters, readSettings, writeSettings } from './config.ts'
import { DEFAULT_CONFIG } from './capacity.ts'
import { DEFAULT_SETTINGS, normalizeSettings, type FlowSettings } from './settings.ts'

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
    writeSettings(withSettings({ writers: [{ provider: 'codex', model: 'gpt-6-luna', enabled: true }, { provider: 'claude', model: 'sonnet', enabled: true }, { provider: 'antigravity', enabled: false }] }), dir)
    assert.deepEqual(readdirSync(dir), ['config.json'])
    assert.deepEqual(fileOf(dir).writers, [{ provider: 'codex', model: 'gpt-6-luna', enabled: true }, { provider: 'claude', model: 'sonnet', enabled: true }, { provider: 'antigravity', enabled: false }])
    assert.deepEqual(configuredWriters(dir).map((w) => `${w.provider}:${w.model ?? ''}`), ['codex:gpt-6-luna', 'claude:sonnet', 'antigravity:'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('defaults agree with the capacity check and the stop hook', () => {
  assert.equal(DEFAULT_SETTINGS.marginGB, DEFAULT_CONFIG.marginGB)
  assert.equal(DEFAULT_SETTINGS.warnHeadroomGB, DEFAULT_CONFIG.warnHeadroomGB)
  // stop-check reads anything but "all" or a list as off.
  assert.equal(normalizeSettings({ messageFormat: 'yes' }).messageFormat, 'off')
})
