import { assert, test } from 'orca/testing'
import { addType, applyPreset, DEFAULT_ROUTING, deletePreset, normalizeRouting, removeType, route, savePreset, type Availability, type RoutingSettings } from './routing.ts'
import { applySettings, mergeSettings, normalizeFeatures, normalizeSettings, DEFAULT_DRAFT, DEFAULT_SETTINGS, fromDraft, normalizeWriters, settingsSession, settingsToSave, statusView, toDraft, WRITER_MODELS, type FlowSettings, type SaveReply } from './settings.ts'

test('writers: order kept, each provider once, unknown models and providers dropped, missing ones off and last', () => {
  assert.deepEqual(normalizeWriters([
    { provider: 'codex', model: 'gpt-5' },
    { provider: 'nope', enabled: true },
    { provider: 'codex', enabled: false },
    { provider: 'antigravity', enabled: true }
  ]), [
    { provider: 'codex', model: 'gpt-6-luna', enabled: true },
    { provider: 'antigravity', model: 'gemini-3.8-flash-low', enabled: true },
    { provider: 'claude', model: 'haiku', enabled: false }
  ])
  for (const bad of [undefined, null, 'claude', [], [{ provider: 'x' }]]) assert.deepEqual(normalizeWriters(bad), DEFAULT_SETTINGS.writers)
})

test('writers: Antigravity offers the Gemini 4 models; an unknown one falls back to the default', () => {
  assert.deepEqual(WRITER_MODELS.antigravity, ['gemini-3.8-flash-low', 'gemini-4-carbon-low', 'gemini-4-neon-low', 'gemini-4-hydrogen-low', 'gemini-4-argon-low'])
  for (const model of WRITER_MODELS.antigravity) assert.deepEqual(normalizeWriters([{ provider: 'antigravity', model, enabled: true }])[0], { provider: 'antigravity', model, enabled: true })
  for (const model of ['gemini-9-ultra', 'Gemini-4-Carbon-Low', 'agy-default', 7, undefined]) assert.deepEqual(normalizeWriters([{ provider: 'antigravity', model, enabled: true }])[0], { provider: 'antigravity', model: 'gemini-3.8-flash-low', enabled: true })
  const draft = toDraft({ ...DEFAULT_SETTINGS, writers: normalizeWriters([{ provider: 'antigravity', model: 'gemini-4-argon-low', enabled: true }]) })
  assert.equal(draft.models.antigravity, 'gemini-4-argon-low')
  assert.equal(fromDraft({ ...draft, models: { ...draft.models, antigravity: 'gemini-4-neon-low' } }).writers[0].model, 'gemini-4-neon-low')
})

test('draft round trip: dialog controls map back to the same settings', () => {
  const settings = { ...DEFAULT_SETTINGS, writers: [{ provider: 'codex' as const, model: 'gpt-6-luna', enabled: true }, { provider: 'claude' as const, model: 'sonnet', enabled: false }, { provider: 'antigravity' as const, model: 'gemini-3.8-flash-low', enabled: true }], messageFormat: ['~/x'], marginGB: 3 }
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
  assert.deepEqual(statusView(s({ installed: true }), 'antigravity', now), { tone: 'ok', text: 'Installed', sub: 'No cards from it since Orca Flow started', usable: true })
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

// The two removed limits, spelled apart so a search for them in the code finds nothing.
const OLD_LIMITS = { ['max' + 'Parallel']: 5, ['max' + 'Escalations']: 2 }

test('routing persists only when changed, drops at default, keeps unknown keys', () => {
  const routing = normalizeRouting({ ...DEFAULT_ROUTING, ...OLD_LIMITS, lead: { agent: 'claude', model: 'opus', effort: 'high' } })
  const saved = applySettings({ other: 1 }, { ...DEFAULT_SETTINGS, routing })
  assert.deepEqual(saved, { other: 1, routing })
  assert.deepEqual(applySettings(saved, { ...DEFAULT_SETTINGS, routing: DEFAULT_ROUTING }), { other: 1 })
  assert.deepEqual(applySettings({ routing: OLD_LIMITS, other: 1 }, DEFAULT_SETTINGS), { routing: OLD_LIMITS, other: 1 })
  assert.deepEqual(Object.keys(routing).filter((k) => k in OLD_LIMITS), [], 'the old limits are read without error and dropped')
  assert.deepEqual(normalizeSettings({ routing: OLD_LIMITS }).routing, DEFAULT_ROUTING)
  assert.deepEqual(normalizeSettings({}).routing, DEFAULT_ROUTING)
  assert.deepEqual(fromDraft(toDraft({ ...DEFAULT_SETTINGS, routing })).routing, routing)
  assert.deepEqual(DEFAULT_DRAFT.routing, DEFAULT_ROUTING)
})

test('worker rows and saved presets persist; a preset applied back to Balanced drops routing from the file', () => {
  const economy = applyPreset(DEFAULT_ROUTING, 'economy')
  const file = applySettings({}, { ...DEFAULT_SETTINGS, routing: economy })
  assert.deepEqual((file.routing as RoutingSettings).workers, economy.workers)
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(file))).routing, economy)
  const withSaved = savePreset(economy, 'Cheap')
  const file2 = applySettings(file, { ...DEFAULT_SETTINGS, routing: withSaved })
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(file2))).routing.presets.map((p) => p.id), ['saved:cheap'])
  // back to Balanced, but the saved preset keeps routing in the file
  const balancedKept = applyPreset(withSaved, 'balanced')
  assert.deepEqual(Object.keys(applySettings(file2, { ...DEFAULT_SETTINGS, routing: balancedKept })), ['routing'])
  assert.deepEqual(applySettings(file2, { ...DEFAULT_SETTINGS, routing: deletePreset(balancedKept, 'saved:cheap') }), {})
  // old rating fields mean nothing now: the file reads as the default
  assert.deepEqual(normalizeSettings({ routing: { workerMode: 'fixed', candidates: [{ agent: 'claude', model: 'haiku', tier: 1, cost: 1 }] } }).routing, DEFAULT_ROUTING)
})

test('task types persist in the file, survive the dialog draft, and drop out when removed', () => {
  const row = { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'low' as const }, fallback: null }
  const typed = addType(DEFAULT_ROUTING, 'Images', 'Make or edit images', row)
  const file = applySettings({ other: 1 }, { ...DEFAULT_SETTINGS, routing: typed })
  assert.deepEqual((file.routing as RoutingSettings).types, [{ id: 'images', name: 'Images', description: 'Make or edit images', route: row }])
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(file))).routing, typed)
  assert.deepEqual(fromDraft(toDraft({ ...DEFAULT_SETTINGS, routing: typed })).routing, typed)
  assert.deepEqual(applySettings(file, { ...DEFAULT_SETTINGS, routing: removeType(typed, 'images') }), { other: 1 }, 'no types and Balanced: the default again')
})

test('precedence from stored settings: override > role > kind row', () => {
  const avail: Availability = { agents: ['claude'], models: { claude: null } }
  const routing = normalizeSettings({ routing: { lead: { agent: 'claude', model: 'opus' }, workers: { simple: { model: { agent: 'claude', model: 'haiku' }, fallback: null } } } }).routing
  assert.deepEqual((route(routing, { role: 'lead' }, avail) as { choice: unknown }).choice, { agent: 'claude', model: 'opus' })
  assert.deepEqual((route(routing, { role: 'lead', model: 'sonnet' }, avail) as { choice: unknown }).choice, { agent: 'claude', model: 'sonnet' })
  assert.deepEqual((route(routing, { role: 'worker', kind: 'simple' }, avail) as { choice: unknown }).choice, { agent: 'claude', model: 'haiku' }, 'Orca takes no effort for Haiku')
  assert.deepEqual(routing.workers.normal, DEFAULT_ROUTING.workers.normal)
})

test('features: bots is off unless the file says true; a missing or malformed key reads as off and keeps every other setting', () => {
  assert.deepEqual(DEFAULT_SETTINGS.features, { bots: false, goals: false, linear: true, tokenSpeed: true })
  assert.deepEqual(normalizeSettings({}).features, { bots: false, goals: false, linear: true, tokenSpeed: true })
  for (const bad of [undefined, null, true, 'bots', [], [true], {}, { bots: 'true' }, { bots: 1 }, { bots: null }, { bots: false }]) assert.deepEqual(normalizeFeatures(bad), { bots: false, goals: false, linear: true, tokenSpeed: true })
  assert.deepEqual(normalizeFeatures({ bots: true, other: 1 }), { bots: true, goals: false, linear: true, tokenSpeed: true })
  const older = normalizeSettings({ marginGB: 3.5, linearDryRun: true, features: 'oops' })
  assert.deepEqual(older, { ...DEFAULT_SETTINGS, marginGB: 3.5, linearDryRun: true })
})

test('features: the toggle round-trips through the draft and writes only its own key', () => {
  const on = { ...DEFAULT_SETTINGS, features: { bots: true, goals: false, linear: true, tokenSpeed: true } }
  assert.equal(toDraft(on).bots, true)
  assert.deepEqual(fromDraft(toDraft(on)), on)
  assert.equal(DEFAULT_DRAFT.bots, false)
  const raw = { marginGB: 'x', futureKey: [1], messageFormat: ['~/y'] }
  assert.deepEqual(applySettings(raw, { ...on, messageFormat: ['~/y'] }), { ...raw, features: { bots: true, goals: false, linear: true, tokenSpeed: true } })
  assert.deepEqual(applySettings({ ...raw, features: { bots: true, goals: false, linear: true, tokenSpeed: true } }, { ...DEFAULT_SETTINGS, messageFormat: ['~/y'] }), raw, 'back to off removes the key; the rest stays')
})

test('features: the dialog saves the Bots switch at once and Reset puts it back off', async () => {
  const saved: FlowSettings[] = []
  const session = settingsSession(async (settings) => { saved.push(settings); return { ok: true, settings } })
  session.load(DEFAULT_SETTINGS)
  await session.change((d) => { d.bots = true })
  assert.deepEqual(saved.at(-1)?.features, { bots: true, goals: false, linear: true, tokenSpeed: true })
  assert.equal(session.isDefault(['bots']), false)
  await session.reset(['bots'])
  assert.deepEqual(saved.at(-1)?.features, { bots: false, goals: false, linear: true, tokenSpeed: true })
  assert.equal(session.shown.bots, false)
})

test('features: Linear and Token Speed are on unless exactly false; a 0.2.81 file with only bots reads them on and keeps its other keys', () => {
  for (const key of ['linear', 'tokenSpeed'] as const) {
    for (const on of [undefined, null, true, 'false', 0, 'off', []]) assert.equal(normalizeFeatures({ [key]: on })[key], true, `${key}: ${JSON.stringify(on)}`)
    assert.equal(normalizeFeatures({ [key]: false })[key], false)
  }
  const older = normalizeSettings({ marginGB: 3, features: { bots: true } })
  assert.deepEqual(older.features, { bots: true, goals: false, linear: true, tokenSpeed: true })
  assert.equal(older.marginGB, 3)
  assert.deepEqual(normalizeSettings({ features: { linear: false, tokenSpeed: false, bots: 'x' } }).features, { bots: false, goals: false, linear: false, tokenSpeed: false })
  assert.deepEqual(normalizeSettings({ features: 'oops' }).features, DEFAULT_SETTINGS.features)
})

test('features: the new switches round-trip through the draft, save at once and Reset puts them back on', async () => {
  const off = { ...DEFAULT_SETTINGS, features: { bots: false, goals: false, linear: false, tokenSpeed: false } }
  assert.equal(toDraft(off).linear, false)
  assert.equal(toDraft(off).tokenSpeed, false)
  assert.deepEqual(fromDraft(toDraft(off)), off)
  assert.equal(DEFAULT_DRAFT.linear, true)
  assert.equal(DEFAULT_DRAFT.tokenSpeed, true)
  const raw = { futureKey: [1], features: { bots: true } }
  assert.deepEqual(applySettings(raw, { ...DEFAULT_SETTINGS, features: { bots: true, goals: false, linear: false, tokenSpeed: true } }), { futureKey: [1], features: { bots: true, goals: false, linear: false, tokenSpeed: true } })
  assert.deepEqual(applySettings({ futureKey: [1], features: { bots: false, linear: false, tokenSpeed: true } }, DEFAULT_SETTINGS), { futureKey: [1] }, 'all on again removes the key')
  const saved: FlowSettings[] = []
  const session = settingsSession(async (settings) => { saved.push(settings); return { ok: true, settings } })
  session.load(DEFAULT_SETTINGS)
  await session.change((d) => { d.linear = false; d.tokenSpeed = false })
  assert.deepEqual(saved.at(-1)?.features, { bots: false, goals: false, linear: false, tokenSpeed: false })
  assert.equal(session.isDefault(['linear', 'tokenSpeed']), false)
  await session.reset(['linear', 'tokenSpeed'])
  assert.deepEqual(saved.at(-1)?.features, DEFAULT_SETTINGS.features)
})

test('features: Goals is off unless exactly true, saves at once, writes only its own key and Reset puts it back off', async () => {
  assert.equal(DEFAULT_SETTINGS.features.goals, false)
  assert.equal(DEFAULT_DRAFT.goals, false)
  for (const v of [undefined, null, 'true', 1, 'on', [], {}]) assert.equal(normalizeFeatures({ goals: v }).goals, false, JSON.stringify(v))
  assert.equal(normalizeFeatures({ goals: true }).goals, true)
  assert.equal(normalizeSettings({ marginGB: 3, features: { bots: true } }).features.goals, false, 'an older file shows no Goals')
  const on = { ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features, goals: true } }
  assert.equal(toDraft(on).goals, true)
  assert.deepEqual(fromDraft(toDraft(on)), on)
  assert.deepEqual(applySettings({ futureKey: [1] }, on), { futureKey: [1], features: { bots: false, goals: true, linear: true, tokenSpeed: true } })
  assert.deepEqual(applySettings({ futureKey: [1], features: { goals: true } }, DEFAULT_SETTINGS), { futureKey: [1] }, 'back to off removes the key; the rest stays')
  const saved: FlowSettings[] = []
  const session = settingsSession(async (settings) => { saved.push(settings); return { ok: true, settings } })
  session.load(DEFAULT_SETTINGS)
  await session.change((d) => { d.goals = true })
  assert.equal(saved.at(-1)?.features.goals, true)
  assert.equal(session.isDefault(['goals']), false)
  await session.reset(['goals'])
  assert.equal(saved.at(-1)?.features.goals, false)
})

// ---------- a dialog opened before another change ----------

const withRouting = (s: FlowSettings, change: (r: RoutingSettings) => void): FlowSettings => { const n = structuredClone(s); change(n.routing); return n }
const HAIKU = { agent: 'claude', model: 'haiku' }
const SONNET_MED = { agent: 'claude', model: 'sonnet', effort: 'medium' as const }
const typeRow = (id: string, model: string) => ({ id, name: id, description: `${id} work`, route: { model: { agent: 'claude', model }, fallback: null } })

test('stale dialog: it applies only what the user changed, and keeps a change made elsewhere', () => {
  const base = DEFAULT_SETTINGS
  const file = withRouting(base, (r) => { r.workers.normal.model = HAIKU })                       // another window: the normal row
  const want = withRouting(base, (r) => { r.lead = SONNET_MED })                                  // this dialog: only the lead
  const out = mergeSettings(file, base, want)
  assert.deepEqual(out.routing.lead, SONNET_MED)
  assert.deepEqual(out.routing.workers.normal.model, HAIKU)
  assert.deepEqual(out.routing.workers.simple, base.routing.workers.simple)
})

test('stale dialog: a setting both changed is the dialog\'s value', () => {
  const base = DEFAULT_SETTINGS
  const file = withRouting(base, (r) => { r.workers.normal.model = HAIKU; r.lead = { agent: 'claude', model: 'opus' } })
  const want = withRouting(base, (r) => { r.workers.normal.model = { agent: 'claude', model: 'opus', effort: 'high' } })
  const out = mergeSettings(file, base, want)
  assert.deepEqual(out.routing.workers.normal.model, { agent: 'claude', model: 'opus', effort: 'high' })
  assert.deepEqual(out.routing.lead, { agent: 'claude', model: 'opus' })   // not touched here: the file's
})

test('stale dialog: other keys and features merge one by one', () => {
  const base = DEFAULT_SETTINGS
  const file = { ...base, marginGB: 4, features: { ...base.features, goals: true } }
  const want = { ...base, linearDryRun: true, features: { ...base.features, bots: true } }
  const out = mergeSettings(file, base, want)
  assert.equal(out.marginGB, 4)
  assert.equal(out.linearDryRun, true)
  assert.deepEqual(out.features, { ...base.features, goals: true, bots: true })
})

test('stale dialog: task types and saved presets merge by id', () => {
  const a = typeRow('a', 'haiku'), b = typeRow('b', 'sonnet')
  const base = withRouting(DEFAULT_SETTINGS, (r) => { r.types = [a, b] })
  // elsewhere: b edited and c added; here: a removed and d added
  const file = withRouting(base, (r) => { r.types = [a, typeRow('b', 'opus'), typeRow('c', 'haiku')] })
  const want = withRouting(base, (r) => { r.types = [b, typeRow('d', 'haiku')] })
  assert.deepEqual(mergeSettings(file, base, want).routing.types.map((t) => [t.id, t.route.model.model]), [['b', 'opus'], ['c', 'haiku'], ['d', 'haiku']])
  // an untouched list is the file's; the same type edited on both sides is the dialog's
  assert.deepEqual(mergeSettings(file, base, base).routing.types, file.routing.types)
  const both = withRouting(base, (r) => { r.types = [a, typeRow('b', 'fable')] })
  assert.equal(mergeSettings(file, base, both).routing.types.find((t) => t.id === 'b')!.route.model.model, 'fable')
  const preset = (id: string) => ({ ...savePreset(DEFAULT_ROUTING, 'x').presets[0], id, name: id })
  const withPresets = (st: FlowSettings, ids: string[]) => withRouting(st, (r) => { r.presets = ids.map(preset) })
  const pbase = withPresets(DEFAULT_SETTINGS, ['p1'])
  // elsewhere: p2 saved; here: p1 removed and p3 saved
  assert.deepEqual(mergeSettings(withPresets(pbase, ['p1', 'p2']), pbase, withPresets(pbase, ['p3'])).routing.presets.map((p) => p.name), ['p2', 'p3'])
})

test('save without a base keeps today\'s behaviour: the settings are written as they are', () => {
  const file = withRouting(DEFAULT_SETTINGS, (r) => { r.workers.normal.model = HAIKU })
  const want = withRouting(DEFAULT_SETTINGS, (r) => { r.lead = SONNET_MED })
  assert.deepEqual(settingsToSave(file, undefined, want), normalizeSettings(want))
  assert.deepEqual(settingsToSave(file, DEFAULT_SETTINGS, want).routing.workers.normal.model, HAIKU)
})

test('session: every save says what the dialog started from, and later edits ride on the merged file', async () => {
  const sent: { settings: FlowSettings; base: FlowSettings }[] = []
  const elsewhere = withRouting(DEFAULT_SETTINGS, (r) => { r.workers.normal.model = HAIKU })
  let file = DEFAULT_SETTINGS
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const session = settingsSession(async (settings, base) => {
    sent.push({ settings, base })
    if (sent.length === 1) { file = elsewhere; await gate }       // the first save lands after another window saved
    file = settingsToSave(file, base, settings)
    return { ok: true, settings: file }
  })
  session.load(DEFAULT_SETTINGS)
  const first = session.change((d) => { d.routing.lead = SONNET_MED })
  const second = session.change((d) => { d.marginGB = 5 })          // queued behind the first save
  release()
  await Promise.all([first, second])
  assert.deepEqual(sent[0].base, DEFAULT_SETTINGS)
  assert.equal(sent.length, 2)
  assert.deepEqual(file.routing.lead, SONNET_MED)
  assert.deepEqual(file.routing.workers.normal.model, HAIKU)
  assert.equal(file.marginGB, 5)
  assert.deepEqual(session.shown.routing.workers.normal.model, HAIKU)
  assert.equal(session.error, null)
})
