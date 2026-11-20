import { assert, test } from 'orca/testing'
import { applySettings, DEFAULT_DRAFT, DEFAULT_SETTINGS, fromDraft, normalizeWriters, settingsSession, statusView, toDraft, type FlowSettings, type SaveReply } from './settings.ts'

test('writers: order kept, each provider once, unknown models and providers dropped, missing ones off and last', () => {
  assert.deepEqual(normalizeWriters([
    { provider: 'codex', model: 'gpt-5' },
    { provider: 'nope', enabled: true },
    { provider: 'codex', enabled: false },
    { provider: 'antigravity', enabled: true }
  ]), [
    { provider: 'codex', model: 'gpt-6-luna', enabled: true },
    // Orca Flow cannot run Antigravity yet: it stays off whatever the file says.
    { provider: 'antigravity', enabled: false },
    { provider: 'claude', model: 'haiku', enabled: false }
  ])
  for (const bad of [undefined, null, 'claude', [], [{ provider: 'x' }]]) assert.deepEqual(normalizeWriters(bad), DEFAULT_SETTINGS.writers)
})

test('draft round trip: dialog controls map back to the same settings', () => {
  const settings = { ...DEFAULT_SETTINGS, writers: [{ provider: 'codex' as const, model: 'gpt-6-luna', enabled: true }, { provider: 'claude' as const, model: 'sonnet', enabled: false }, { provider: 'antigravity' as const, enabled: false }], messageFormat: ['~/x'], marginGB: 3 }
  assert.deepEqual(fromDraft(toDraft(settings)), settings)
  assert.deepEqual(fromDraft(DEFAULT_DRAFT), DEFAULT_SETTINGS)
  assert.deepEqual(DEFAULT_DRAFT.folders, ['~/orca/coordinators'])
})

test('applySettings touches only changed keys', () => {
  assert.deepEqual(applySettings({ other: 1, marginGB: 'x' }, { ...DEFAULT_SETTINGS, linearDryRun: true }), { other: 1, marginGB: 'x', linearDryRun: true })
})

test('status comes from what the writer last saw, then from the install list', () => {
  const now = 10_000_000
  const s = (over: object) => ({ provider: 'claude' as const, lastSuccessAt: null, failure: null, installed: null, ...over })
  assert.deepEqual(statusView(s({ lastSuccessAt: now - 120_000 }), 'claude', now), { tone: 'ok', text: 'Ready', sub: 'Last card 2 min ago', usable: true })
  assert.deepEqual(statusView(s({ failure: { kind: 'quota', until: now + 4 * 60_000 - 1 } }), 'claude', now), { tone: 'warn', text: 'Usage limit', sub: 'Skipped for 4 more min, then tried again', usable: false })
  assert.deepEqual(statusView(s({ failure: { kind: 'timeout', until: now + 20_000 } }), 'claude', now).sub, 'Skipped for 20 more s, then tried again')
  assert.deepEqual(statusView(s({ failure: { kind: 'auth', until: now - 1 } }), 'claude', now), { tone: 'bad', text: 'Not signed in', sub: 'Tried again at the next card', usable: true })
  assert.equal(statusView(s({ installed: true }), 'claude', now).text, 'Installed')
  assert.deepEqual(statusView(s({ installed: false }), 'codex', now), { tone: 'bad', text: 'Not installed', sub: 'Orca doesn’t see the Codex CLI', usable: false })
  assert.equal(statusView(undefined, 'claude', now).text, 'Not used yet')
  assert.deepEqual(statusView(s({ installed: true }), 'antigravity', now), { tone: 'idle', text: 'Not available yet', sub: 'Orca Flow can’t write cards with the Antigravity CLI yet', usable: false })
})

// ---------- instant save ----------

const saver = (answer: (s: FlowSettings, n: number) => SaveReply | Promise<SaveReply>) => {
  const calls: FlowSettings[] = []
  return { calls, save: async (s: FlowSettings) => { calls.push(structuredClone(s)); return answer(s, calls.length) } }
}

test('a change shows at once and sends exactly one save of the new settings', async () => {
  const io = saver((s) => ({ ok: true, settings: s }))
  let updates = 0
  const session = settingsSession(io.save, () => updates++)
  session.load(DEFAULT_SETTINGS)
  const done = session.change((d) => { d.models.claude = 'sonnet' })
  assert.equal(session.shown.models.claude, 'sonnet', 'shown before the save answers')
  await done
  assert.equal(io.calls.length, 1)
  assert.deepEqual(io.calls[0].writers[0], { provider: 'claude', model: 'sonnet', enabled: true })
  assert.equal(session.saved.models.claude, 'sonnet')
  assert.equal(session.error, null)
  assert.ok(updates >= 2)
})

test('a failed save puts the control back to the saved value and keeps a short error', async () => {
  for (const io of [saver(() => ({ ok: false, error: 'config.json isn’t valid JSON' })), saver(() => { throw new Error('worker gone') })]) {
    const session = settingsSession(io.save)
    session.load({ ...DEFAULT_SETTINGS, marginGB: 3 })
    await session.change((d) => { d.marginGB = 3.5; d.linearDryRun = true })
    assert.equal(io.calls.length, 1)
    assert.equal(session.shown.marginGB, 3)
    assert.equal(session.shown.linearDryRun, false)
    assert.ok(session.error)
  }
})

test('changes made while a save is in flight go in one more save, newest last', async () => {
  let release!: () => void
  const first = new Promise<void>((r) => { release = r })
  const io = saver(async (s, n) => { if (n === 1) await first; return { ok: true, settings: s } })
  const session = settingsSession(io.save)
  session.load(DEFAULT_SETTINGS)
  const a = session.change((d) => { d.marginGB = 2.5 })
  const b = session.change((d) => { d.marginGB = 3 })
  const c = session.change((d) => { d.marginGB = 3.5 })
  release()
  await Promise.all([a, b, c])
  assert.deepEqual(io.calls.map((s) => s.marginGB), [2.5, 3.5])
  assert.equal(session.shown.marginGB, 3.5)
})

test('a change that does not reach the file sends nothing, and reset saves defaults once', async () => {
  const io = saver((s) => ({ ok: true, settings: s }))
  const session = settingsSession(io.save)
  session.load({ ...DEFAULT_SETTINGS, linearDryRun: true, messageFormat: 'all' })
  // Editing the folder list while "All agents" is chosen changes nothing in config.json.
  await session.change((d) => { d.folders.push('~/x') })
  assert.equal(io.calls.length, 0)
  assert.equal(session.isDefault(['linearDryRun']), false)
  await session.reset(['linearDryRun', 'format', 'folders'])
  assert.equal(io.calls.length, 1)
  assert.deepEqual(io.calls[0], DEFAULT_SETTINGS)
  assert.equal(session.isDefault(['linearDryRun', 'format']), true)
})
