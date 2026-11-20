import { assert, test } from 'orca/testing'
import { applySettings, changedKeys, DEFAULT_DRAFT, DEFAULT_SETTINGS, fromDraft, normalizeWriters, statusView, toDraft } from './settings.ts'

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

test('changed keys: folders count only while the folder choice is in play', () => {
  const saved = structuredClone(DEFAULT_DRAFT)
  const draft = structuredClone(DEFAULT_DRAFT)
  draft.folders = ['~/elsewhere']
  assert.deepEqual(changedKeys(draft, saved), [])
  draft.format = 'folders'
  assert.deepEqual(changedKeys(draft, saved), ['format', 'folders'])
  draft.models.claude = 'sonnet'
  draft.writers.reverse()
  assert.deepEqual(changedKeys(draft, saved), ['writers', 'models', 'format', 'folders'])
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
