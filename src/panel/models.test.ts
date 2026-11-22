// Settings → Models: what it lists, and that its changes round-trip through the dialog's draft.
import { assert, test } from 'orca/testing'
import { agentsShown, choiceFrom, choiceText, choiceValue, effortsFor, effortView, fallbackPairs, missingTip, modelOptions, pairFrom, pairValue, pickPreset, presetView, saveNamed, unavailable, UNKNOWN } from './models.ts'
import { DEFAULT_SETTINGS, fromDraft, settingsSession, toDraft, type FlowSettings } from '../settings.ts'
import { DEFAULT_ROUTING, deletePreset, supportedEfforts, type Availability } from '../routing.ts'

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

test('Claude models come from discovery, aliases first, with display labels', () => {
  const found: Availability = { agents: ['claude'], models: { claude: [{ id: 'claude-x-1', label: 'Claude X' }, { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'high'] }, { id: 'haiku', label: 'Haiku 5.5', efforts: [] }] } }
  assert.deepEqual(modelOptions('claude', found).map((m) => m.label), ['Haiku 5.5', 'Opus 5.5', 'Claude X'])
  assert.deepEqual(effortsFor('claude', 'opus', found), ['low', 'high'], 'the discovered efforts that Orca accepts')
  assert.deepEqual(effortsFor('claude', 'sonnet', found), ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('picking a preset applies it and keeps the limits and saved presets; editing a row shows Custom', async () => {
  const saved: FlowSettings[] = []
  const session = settingsSession(async (settings) => { saved.push(settings); return { ok: true, settings } })
  session.load(structuredClone(DEFAULT_SETTINGS))
  assert.equal(presetView(session.shown.routing).selected, 'balanced')
  await session.change((d) => { d.routing.maxParallel = 5; d.routing = pickPreset(d.routing, 'best') })
  assert.equal(saved.length, 1, 'saved at once')
  assert.equal(saved[0].routing.workers.hard.model.model, 'fable')
  assert.equal(saved[0].routing.maxParallel, 5)
  assert.equal(presetView(session.shown.routing).selected, 'best')
  await session.change((d) => { d.routing.workers.normal.model = { agent: 'claude', model: 'sonnet', effort: 'high' } })
  assert.equal(presetView(session.shown.routing).selected, '', 'no preset matches: Custom')
  assert.deepEqual(presetView(session.shown.routing).builtIn.map((p) => p.name), ['Balanced', 'Economy', 'Best quality'])
})

test('Save as: a valid name saves and selects it; a built-in or empty name gives an error', () => {
  const edited = { ...structuredClone(DEFAULT_ROUTING), lead: { agent: 'claude', model: 'opus' } }
  const ok = saveNamed(edited, '  Mine ')
  assert.ok(ok.ok)
  if (!ok.ok) return
  const v = presetView(ok.routing)
  assert.deepEqual(v.saved.map((p) => p.name), ['Mine'])
  assert.equal(v.selected, 'saved:mine')
  assert.equal(v.removable, 'saved:mine')
  assert.equal(presetView(DEFAULT_ROUTING).removable, null, 'a built-in has no remove button')
  const builtIn = saveNamed(DEFAULT_ROUTING, 'balanced')
  assert.ok(!builtIn.ok && /built-in/.test(builtIn.error))
  const empty = saveNamed(DEFAULT_ROUTING, '   ')
  assert.ok(!empty.ok && /needs a name/.test(empty.error))
})

test('removing a saved preset keeps the setup', () => {
  const edited = { ...structuredClone(DEFAULT_ROUTING), lead: { agent: 'claude', model: 'opus' } }
  const saved = saveNamed(edited, 'Mine')
  if (!saved.ok) throw new Error(saved.error)
  const after = deletePreset(saved.routing, 'saved:mine')
  assert.deepEqual(after.presets, [])
  assert.deepEqual(after.lead, { agent: 'claude', model: 'opus' }, 'the models stay as they were')
  assert.equal(presetView(after).selected, '', 'now Custom')
})

test('effort pop-up: Haiku is disabled with a reason; others list what Orca accepts', () => {
  const none = effortView({ agent: 'claude', model: 'haiku' }, avail)
  assert.ok(none.disabled && none.efforts.length === 0 && /no effort for Haiku/.test(none.tip))
  const opus = effortView({ agent: 'claude', model: 'opus', effort: 'high' }, avail)
  assert.ok(!opus.disabled && opus.efforts.includes('max'))
  assert.deepEqual(effortView({ agent: 'codex', model: 'gpt-6-luna' }, avail).efforts, ['low', 'medium'])
  assert.ok(effortView(null, avail).disabled)
  assert.ok(effortView({ agent: 'claude', model: 'sonnet', effort: 'xhigh' }, { agents: null, models: { claude: [{ id: 'sonnet', efforts: ['low'] }] } }).efforts.includes('xhigh'), 'a saved effort stays listed')
})

test('the fallback pop-up offers model and effort pairs of the available models', () => {
  const groups = fallbackPairs(avail)
  assert.deepEqual(groups.map((g) => g.agent), ['claude', 'codex'])
  const claude = groups[0].pairs.map((p) => p.label)
  assert.ok(claude.includes('Haiku') && !claude.includes('Haiku · low'), 'Haiku only at Default')
  assert.deepEqual(claude.filter((l) => l.startsWith('Sonnet')), ['Sonnet', 'Sonnet · low', 'Sonnet · medium', 'Sonnet · high'])
  assert.deepEqual(groups[1].pairs.map((p) => p.label), ['GPT-6 Luna', 'GPT-6 Luna · low', 'GPT-6 Luna · medium', 'gpt-6-astra', 'gpt-6-astra · medium', 'gpt-6-astra · high'])
  assert.deepEqual(pairFrom(pairValue({ agent: 'claude', model: 'sonnet', effort: 'low' })), { agent: 'claude', model: 'sonnet', effort: 'low' })
  assert.equal(pairFrom(''), null, 'None')
  assert.equal(pairValue(null), '')
})

test('an unavailable model is dimmed with why, and says whether a fallback is used', () => {
  const gone = { agent: 'codex', model: 'gpt-old' }
  assert.equal(missingTip(gone, true, avail), 'Codex doesn’t list this model. The fallback is used.')
  assert.equal(missingTip(gone, false, avail), 'Codex doesn’t list this model. No fallback is set.')
  assert.equal(missingTip({ agent: 'claude', model: 'opus' }, true, avail), null)
  assert.equal(missingTip(null, true, avail), null)
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

test('the panel uses routing’s availability rules', () => {
  const listed: Availability = { agents: ['claude'], models: { claude: [{ id: 'claude-opus-5-5' }] } }
  assert.equal(unavailable('claude', 'sonnet', listed), null)
  assert.equal(unavailable('claude', 'claude-unlisted-1', listed), null)
  assert.equal(unavailable('claude', 'gpt-x', listed), 'Claude doesn’t list this model')
  assert.deepEqual(effortsFor('claude', 'haiku', listed), supportedEfforts('claude', 'haiku', listed))
  assert.deepEqual(effortsFor('claude', undefined, listed), [])
})
