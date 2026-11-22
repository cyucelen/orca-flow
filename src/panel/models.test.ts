// Settings → Models: what it lists, and that its changes round-trip through the dialog's draft.
import { assert, test } from 'orca/testing'
import { addTaskType, agentsShown, cardName, cardProblem, choiceText, editTaskType, effortBar, effortsFor, effortView, fallbackText, missingTip, modelOptions, pickEffort, pickModel, pickNone, pickPreset, popoverView, presetView, refFrom, refKey, removeTaskType, routingRows, saveNamed, suggestedTypes, unavailable, UNKNOWN } from './models.ts'
import { DEFAULT_SETTINGS, fromDraft, settingsSession, toDraft, type FlowSettings } from '../settings.ts'
import { DEFAULT_ROUTING, deletePreset, MAX_TYPES, resetRouting, supportedEfforts, SUGGESTED_TYPES, type Availability, type RoutingSettings } from '../routing.ts'

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

test('unavailable rows say why', () => {
  assert.equal(unavailable('gemini', 'g-1', avail), 'Gemini isn’t installed in Orca')
  assert.equal(unavailable('codex', 'gpt-old', avail), 'Codex doesn’t list this model')
  assert.equal(unavailable('claude', 'opus', avail), null)
})

test('Claude models come from discovery, aliases first, with display labels', () => {
  const found: Availability = { agents: ['claude'], models: { claude: [{ id: 'claude-x-1', label: 'Claude X' }, { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'high'] }, { id: 'haiku', label: 'Haiku 5.5', efforts: [] }] } }
  assert.deepEqual(modelOptions('claude', found).map((m) => m.label), ['Haiku 5.5', 'Opus 5.5', 'Claude X'])
  assert.deepEqual(effortsFor('claude', 'opus', found), ['low', 'high'], 'the discovered efforts that Orca accepts')
  assert.deepEqual(effortsFor('claude', 'sonnet', found), ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('picking a preset applies it and keeps saved presets; editing a row shows Custom (draft round trip)', async () => {
  const saved: FlowSettings[] = []
  const session = settingsSession(async (settings) => { saved.push(settings); return { ok: true, settings } })
  session.load(structuredClone(DEFAULT_SETTINGS))
  assert.equal(presetView(session.shown.routing).selected, 'balanced')
  await session.change((d) => { d.routing = pickPreset(d.routing, 'best') })
  assert.equal(saved.length, 1, 'saved at once')
  assert.equal(saved[0].routing.workers.hard.model.model, 'fable')
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
  const lowOnly: Availability = { agents: null, models: { claude: [{ id: 'sonnet', efforts: ['low', 'medium'] }] } }
  const stale = effortView({ agent: 'claude', model: 'sonnet', effort: 'xhigh' }, lowOnly)
  assert.deepEqual(stale.efforts, ['low', 'medium'], 'only accepted efforts are listed')
  assert.equal(stale.shown, 'medium', 'the nearest lower one is what routing uses')
  assert.match(stale.tip, /Xhigh is saved but .* does not accept it, so routing uses medium/)
  const pv = popoverView({ ...structuredClone(DEFAULT_ROUTING), lead: { agent: 'claude', model: 'sonnet', effort: 'xhigh' } }, { type: 'role', role: 'lead' }, 'model', lowOnly)
  assert.deepEqual(pv.efforts.options.filter((o) => o.selected).map((o) => o.value), ['medium'])
  assert.ok(pv.efforts.adjusted && !pv.efforts.options.some((o) => o.value === 'xhigh'))
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
  })
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].routing.coordinator, { agent: 'claude', model: 'opus', effort: 'high' })
  assert.deepEqual(saved[0].routing.workers.simple, { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'low' }, fallback: null })
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

// ---------- the routing map ----------

const withTypes = (): RoutingSettings => {
  let r = structuredClone(DEFAULT_ROUTING)
  for (const t of SUGGESTED_TYPES.slice(0, 2)) { const e = addTaskType(r, t.name, t.description); if (!e.ok) throw new Error(e.error); r = e.routing }
  return r
}
const NORMAL = { type: 'kind', kind: 'normal' } as const
const HARD = { type: 'kind', kind: 'hard' } as const
const LEAD = { type: 'role', role: 'lead' } as const

test('rows come in routing order: roles, then task types, then difficulty', () => {
  const rows = routingRows(withTypes())
  assert.deepEqual(rows.map((r) => r.key), ['role:coordinator', 'role:lead', 'type:browser-checks', 'type:images', 'kind:simple', 'kind:normal', 'kind:hard'])
  assert.deepEqual(rows.map((r) => r.section), ['roles', 'roles', 'types', 'types', 'difficulty', 'difficulty', 'difficulty'])
  assert.deepEqual(rows.slice(4).map((r) => r.sub), ['rename, config, typo', 'a change with tests', 'design, debugging, data'])
  assert.equal(rows[2].sub, SUGGESTED_TYPES[0].description, 'a type shows its description')
  assert.ok(rows.slice(2).every((r) => r.hasFallback) && rows.slice(0, 2).every((r) => !r.hasFallback), 'a role has no fallback')
  assert.deepEqual(routingRows(DEFAULT_ROUTING).map((r) => r.section), ['roles', 'roles', 'difficulty', 'difficulty', 'difficulty'], 'no types: no type rows')
  assert.deepEqual(refFrom(refKey({ type: 'type', id: 'browser-checks' })), { type: 'type', id: 'browser-checks' })
  assert.equal(refFrom('kind:bogus'), null)
})

test('cards: names, effort bars, fallback text and why a card is dimmed', () => {
  assert.equal(cardName(null, avail), 'Provider default')
  assert.equal(cardName({ agent: 'codex', model: 'gpt-6-luna' }, avail), 'GPT-6 Luna')
  assert.equal(cardName({ agent: 'codex' }, avail), 'Codex default')
  assert.deepEqual(effortBar({ agent: 'claude', model: 'opus', effort: 'high' }), { on: 3, total: 5, label: 'high' })
  assert.equal(effortBar({ agent: 'claude', model: 'haiku' }), null, 'no effort: the word default')
  assert.equal(fallbackText({ agent: 'claude', model: 'sonnet', effort: 'low' }, avail), 'Sonnet · low')
  assert.equal(fallbackText(null, avail), 'None')
  const gone = { agent: 'codex', model: 'gpt-old' }
  assert.equal(cardProblem(gone, 'model', true, avail), 'Codex doesn’t list this model. The fallback is used.')
  assert.equal(cardProblem(gone, 'fallback', false, avail), 'Codex doesn’t list this model. This fallback can’t be used.')
  assert.equal(cardProblem({ agent: 'claude', model: 'opus' }, 'model', true, avail), null)
})

test('a preset pill applies and saves; Custom shows after an edit; the types stay', async () => {
  const saved: FlowSettings[] = []
  const session = settingsSession(async (settings) => { saved.push(settings); return { ok: true, settings } })
  session.load(structuredClone(DEFAULT_SETTINGS))
  await session.change((d) => { d.routing = withTypes() })
  await session.change((d) => { d.routing = pickPreset(d.routing, 'economy') })
  assert.equal(saved.at(-1)!.routing.workers.hard.model.model, 'sonnet', 'saved at once')
  assert.equal(presetView(session.shown.routing).selected, 'economy')
  assert.deepEqual(saved.at(-1)!.routing.types.map((t) => t.id), ['browser-checks', 'images'], 'a built-in keeps the user’s types')
  await session.change((d) => { d.routing = pickModel(d.routing, NORMAL, 'model', 'claude', 'opus', avail) })
  assert.equal(presetView(session.shown.routing).selected, '', 'Custom')
  assert.deepEqual(presetView(session.shown.routing).builtIn.map((p) => p.name), ['Balanced', 'Economy', 'Best quality'])
})

test('save, remove and the name errors', () => {
  const edited = pickModel(DEFAULT_ROUTING, LEAD, 'model', 'claude', 'opus', avail)
  const ok = saveNamed(edited, ' Mine ')
  assert.ok(ok.ok)
  if (!ok.ok) return
  assert.equal(presetView(ok.routing).selected, 'saved:mine')
  assert.equal(presetView(ok.routing).removable, 'saved:mine', 'the selected saved preset can be removed')
  assert.equal(presetView(DEFAULT_ROUTING).removable, null, 'a built-in cannot')
  const again = saveNamed(ok.routing, 'mine')
  assert.ok(again.ok && again.routing.presets.length === 1, 'the same name replaces it')
  const builtIn = saveNamed(DEFAULT_ROUTING, 'Economy')
  assert.ok(!builtIn.ok && /built-in/.test(builtIn.error))
  const empty = saveNamed(DEFAULT_ROUTING, '  ')
  assert.ok(!empty.ok && /needs a name/.test(empty.error))
  const after = deletePreset(ok.routing, 'saved:mine')
  assert.deepEqual(after.presets, [])
  assert.deepEqual(after.lead, { agent: 'claude', model: 'opus' }, 'removing a preset keeps the setup')
  assert.equal(presetView(after).selected, '', 'now Custom')
})

test('add, edit and remove a task type', () => {
  const added = addTaskType(DEFAULT_ROUTING, ' Browser checks ', 'Open pages')
  assert.ok(added.ok)
  if (!added.ok) return
  const t = added.routing.types[0]
  assert.deepEqual([t.id, t.name, t.description], ['browser-checks', 'Browser checks', 'Open pages'])
  assert.deepEqual(t.route, DEFAULT_ROUTING.workers.normal, 'it starts on the Normal row')
  assert.deepEqual(suggestedTypes(added.routing).map((s) => s.name), SUGGESTED_TYPES.slice(1).map((s) => s.name), 'a used suggestion is no longer offered')
  const dup = addTaskType(added.routing, 'browser CHECKS', '')
  assert.ok(!dup.ok && /already a type/.test(dup.error))
  const kind = addTaskType(added.routing, 'Hard', '')
  assert.ok(!kind.ok && /difficulty/.test(kind.error))
  const none = addTaskType(added.routing, ' ', '')
  assert.ok(!none.ok && /needs a name/.test(none.error))
  const edited = editTaskType(added.routing, 'browser-checks', 'Web checks', 'Pages and flows')
  assert.ok(edited.ok && edited.routing.types[0].id === 'browser-checks' && edited.routing.types[0].name === 'Web checks' && edited.routing.types[0].description === 'Pages and flows', 'the id stays')
  assert.ok(!editTaskType(added.routing, 'nope', 'X', '').ok)
  assert.deepEqual(removeTaskType(added.routing, 'browser-checks').types, [])
  let full = structuredClone(DEFAULT_ROUTING)
  for (let i = 0; i < MAX_TYPES; i++) { const e = addTaskType(full, `Type ${i}`, ''); if (!e.ok) throw new Error(e.error); full = e.routing }
  const over = addTaskType(full, 'One more', '')
  assert.ok(!over.ok && /At most/.test(over.error))
})

test('the popover lists the accepted efforts only; Haiku has Default alone, disabled', () => {
  const haiku = popoverView(DEFAULT_ROUTING, { type: 'kind', kind: 'simple' }, 'model', avail)
  assert.deepEqual(haiku.efforts.options.map((o) => o.label), ['Default'])
  assert.ok(haiku.efforts.disabled && /no effort for Haiku/.test(haiku.efforts.tip))
  assert.equal(haiku.none, null, 'a task’s model is never empty')
  const normal = popoverView(DEFAULT_ROUTING, NORMAL, 'model', avail)
  assert.deepEqual(normal.efforts.options.map((o) => o.label), ['Default', 'Low', 'Medium', 'High', 'Xhigh', 'Max'])
  assert.deepEqual(normal.efforts.options.filter((o) => o.selected).map((o) => o.value), ['medium'])
  assert.deepEqual(normal.groups.map((g) => g.name), ['Claude', 'Codex'], 'grouped by installed agent; an agent with no models is left out')
  assert.deepEqual(normal.groups[0].models.map((m) => m.label), ['Haiku', 'Sonnet', 'Opus', 'Fable'])
  const luna = pickModel(DEFAULT_ROUTING, NORMAL, 'model', 'codex', 'gpt-6-luna', avail)
  assert.deepEqual(popoverView(luna, NORMAL, 'model', avail).efforts.options.map((o) => o.value), ['', 'low', 'medium'], 'only what that model takes')
  assert.deepEqual(luna.workers.normal.model, { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' }, 'the effort stays when the new model takes it')
  const max = pickEffort(DEFAULT_ROUTING, HARD, 'model', 'max')
  assert.deepEqual(pickModel(max, HARD, 'model', 'codex', 'gpt-6-luna', avail).workers.hard.model, { agent: 'codex', model: 'gpt-6-luna' }, 'an effort the new model does not take falls back to Default')
  assert.deepEqual(pickEffort(DEFAULT_ROUTING, HARD, 'model', '').workers.hard.model, { agent: 'claude', model: 'opus' })
  assert.equal(pickEffort(DEFAULT_ROUTING, LEAD, 'model', 'high').lead, null, 'no effort without a model')
})

test('Provider default is a role’s choice; a fallback has None first', () => {
  const v = popoverView(DEFAULT_ROUTING, LEAD, 'model', avail)
  assert.deepEqual(v.none, { label: 'Provider default', selected: true })
  assert.ok(v.efforts.disabled, 'an effort needs a model')
  const picked = pickModel(DEFAULT_ROUTING, LEAD, 'model', 'claude', 'opus', avail)
  assert.deepEqual(picked.lead, { agent: 'claude', model: 'opus' })
  assert.equal(pickNone(picked, LEAD, 'model').lead, null, 'back to the provider default')
  assert.equal(pickModel(DEFAULT_ROUTING, LEAD, 'fallback', 'claude', 'opus', avail).lead, null, 'a role has no fallback')
  const fb = popoverView(DEFAULT_ROUTING, NORMAL, 'fallback', avail)
  assert.deepEqual(fb.none, { label: 'None', selected: false }, 'Normal has a fallback')
  assert.ok(fb.groups[0].models.some((m) => m.selected && m.id === 'opus'))
  const none = pickNone(DEFAULT_ROUTING, NORMAL, 'fallback')
  assert.equal(none.workers.normal.fallback, null)
  assert.deepEqual(popoverView(none, NORMAL, 'fallback', avail).none, { label: 'None', selected: true })
  assert.deepEqual(none.workers.normal.model, DEFAULT_ROUTING.workers.normal.model, 'the model is untouched')
  assert.equal(pickNone(DEFAULT_ROUTING, NORMAL, 'model').workers.normal.model.model, 'sonnet', 'a task’s model cannot be cleared')
})

test('a type’s cards change its row; an unavailable pick stays listed, dimmed with its reason', () => {
  const added = addTaskType(DEFAULT_ROUTING, 'Images', '')
  if (!added.ok) throw new Error(added.error)
  const ref = { type: 'type', id: 'images' } as const
  const next = pickModel(added.routing, ref, 'model', 'codex', 'gpt-6-luna', avail)
  assert.deepEqual(next.types[0].route.model, { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' })
  assert.deepEqual(next.workers, DEFAULT_ROUTING.workers, 'the difficulty rows are untouched')
  const gone = pickModel(added.routing, ref, 'model', 'codex', 'gpt-retired', { agents: ['claude', 'codex'], models: {} })
  const codex = popoverView(gone, ref, 'model', avail).groups.find((g) => g.agent === 'codex')!
  const m = codex.models.find((x) => x.id === 'gpt-retired')!
  assert.ok(m.selected && m.dim === 'Codex doesn’t list this model', 'kept, dimmed, with why')
  assert.ok(codex.models.filter((x) => x.id !== 'gpt-retired').every((x) => x.dim === null), 'the others are not dimmed')
  const gem = popoverView(pickModel(added.routing, ref, 'model', 'gemini', 'g-1', UNKNOWN), ref, 'model', avail)
  assert.equal(gem.groups.find((g) => g.agent === 'gemini')!.models[0].dim, 'Gemini isn’t installed in Orca')
})

test('Reset to Defaults: Balanced rows, the types and saved presets stay', () => {
  const s = saveNamed(withTypes(), 'Mine')
  if (!s.ok) throw new Error(s.error)
  const reset = resetRouting(pickPreset(s.routing, 'best'))
  assert.deepEqual(reset.workers, DEFAULT_ROUTING.workers)
  assert.deepEqual(reset.types.map((t) => t.id), ['browser-checks', 'images'])
  assert.deepEqual(reset.presets.map((p) => p.name), ['Mine'])
})
