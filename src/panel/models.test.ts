// Settings → Models: what it lists, and that its changes round-trip through the dialog's draft.
import { assert, test } from 'orca/testing'
import { agentsShown, choiceFrom, choiceText, choiceValue, effortsFor, examples, modelOptions, unavailable, UNKNOWN } from './models.ts'
import { DEFAULT_SETTINGS, fromDraft, settingsSession, toDraft, type FlowSettings } from '../settings.ts'
import { DEFAULT_ROUTING, type Availability } from '../routing.ts'

const avail: Availability = { agents: ['opencode', 'codex', 'claude'], models: { claude: null, codex: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'medium'] }, { id: 'gpt-6-astra', efforts: ['medium', 'high', 'xhigh'] }] } }

test('models are grouped by installed agent: Claude aliases, the Codex catalog, others only their default', () => {
  assert.deepEqual(agentsShown(avail), ['claude', 'codex', 'opencode'])
  assert.deepEqual(agentsShown(UNKNOWN), ['claude', 'codex'])
  assert.deepEqual(modelOptions('claude', avail).map((m) => m.label), ['Haiku', 'Sonnet', 'Opus', 'Fable'])
  assert.deepEqual(modelOptions('codex', avail), [{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }, { id: 'gpt-6-astra', label: 'gpt-6-astra' }])
  assert.deepEqual(modelOptions('opencode', avail), [])
  assert.deepEqual(effortsFor('codex', 'gpt-6-luna', avail), ['low', 'medium'])
  assert.equal(effortsFor('claude', 'opus', avail).length, 5)
  assert.equal(choiceText({ agent: 'codex', model: 'gpt-6-luna', effort: 'low' }, avail), 'Codex GPT-6 Luna · low')
  assert.equal(choiceText(null, avail), 'Provider default')
})

test('unavailable rows say why; choice values round-trip', () => {
  assert.equal(unavailable('gemini', 'g-1', avail), 'Gemini isn’t installed in Orca')
  assert.equal(unavailable('codex', 'gpt-old', avail), 'Codex doesn’t list this model')
  assert.equal(unavailable('claude', 'opus', avail), null)
  assert.deepEqual(choiceFrom(choiceValue({ agent: 'claude', model: 'opus' }), 'high'), { agent: 'claude', model: 'opus', effort: 'high' })
  assert.deepEqual(choiceFrom('codex:'), { agent: 'codex' })
  assert.equal(choiceFrom(''), null)
})

test('each kind shows its row and what route() picks now', () => {
  const ex = examples(structuredClone(DEFAULT_ROUTING), avail)
  assert.deepEqual(ex.map((e) => e.kind), ['simple', 'normal', 'hard'])
  assert.deepEqual(ex.map((e) => e.text), ['Claude Haiku', 'Claude Sonnet · medium', 'Claude Opus · high'])
  assert.equal(ex[0].row, 'Claude Haiku, fallback Claude Sonnet · low')
  assert.equal(ex[2].row, 'Claude Opus · high, fallback none')
  assert.ok(ex.every((e) => e.ok && e.tip.length > 0))
  const none = examples(structuredClone(DEFAULT_ROUTING), { agents: ['codex'], models: {} })
  assert.ok(none.every((e) => !e.ok && e.text === 'No model available'))
})

test('routing changes round-trip through the draft and are saved instantly', async () => {
  const saved: FlowSettings[] = []
  const session = settingsSession(async (settings) => { saved.push(settings); return { ok: true, settings } })
  session.load(structuredClone(DEFAULT_SETTINGS))
  assert.ok(session.isDefault(['routing']))
  await session.change((d) => {
    d.routing.coordinator = { agent: 'claude', model: 'opus', effort: 'high' }
    d.routing.workers.simple = { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'low' }, fallback: null }
    d.routing.maxParallel = 5
  })
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].routing.coordinator, { agent: 'claude', model: 'opus', effort: 'high' })
  assert.deepEqual(saved[0].routing.workers.simple, { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'low' }, fallback: null })
  assert.equal(saved[0].routing.maxParallel, 5)
  assert.deepEqual(toDraft(fromDraft(session.shown)).routing, session.shown.routing)
  assert.ok(!session.isDefault(['routing']))
  await session.reset(['routing'])
  assert.deepEqual(saved.at(-1)!.routing, DEFAULT_ROUTING)
  assert.deepEqual(saved.at(-1)!.writers, DEFAULT_SETTINGS.writers, 'resetting Models leaves other pages alone')
})
