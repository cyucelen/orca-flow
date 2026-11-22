import { assert, test } from 'orca/testing'
import { addType, applyPreset, resetRouting, BUILT_IN_PRESETS, findType, MAX_TYPES, removeType, SUGGESTED_TYPES, updateType, choiceLabel, DEFAULT_ROUTING, deletePreset, launchArgs, matchingPreset, MAX_SAVED_PRESETS, normalizeRouting, orcaLaunchEfforts, presetsOf, route, rowFor, savePreset, supportedEfforts, modelProblem, taskKind, type Availability, type KindRoute, type RouteDecision, type RouteRequest, type RoutingSettings } from './routing.ts'

const CODEX = [
  { id: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] as const },
  { id: 'gpt-6.2-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const }
].map((m) => ({ id: m.id, efforts: [...m.efforts] }))
const AVAIL: Availability = { agents: ['claude', 'codex'], models: { claude: null, codex: CODEX } }
const S = (over: Partial<RoutingSettings> = {}): RoutingSettings => ({ ...normalizeRouting(undefined), ...over })
const withRow = (kind: 'simple' | 'normal' | 'hard', row: KindRoute, over: Partial<RoutingSettings> = {}) => { const s = S(over); s.workers = { ...s.workers, [kind]: row }; return s }
const ok = (d: RouteDecision) => { assert.equal(d.ok, true, d.ok ? '' : d.error); return d as Extract<RouteDecision, { ok: true }> }
const bad = (d: RouteDecision) => { assert.equal(d.ok, false); return (d as Extract<RouteDecision, { ok: false }>).error }
const worker = (req: Partial<RouteRequest> = {}, settings = S(), avail = AVAIL) => route(settings, { role: 'worker', ...req }, avail)

test('defaults: Balanced rows, no saved presets', () => {
  assert.deepEqual(DEFAULT_ROUTING.workers, BUILT_IN_PRESETS[0].workers)
  assert.deepEqual(DEFAULT_ROUTING.workers.simple, { model: { agent: 'claude', model: 'haiku' }, fallback: { agent: 'claude', model: 'sonnet', effort: 'low' } })
  assert.deepEqual([DEFAULT_ROUTING.coordinator, DEFAULT_ROUTING.lead, DEFAULT_ROUTING.presets], [null, null, []])
  assert.deepEqual(BUILT_IN_PRESETS.map((p) => [p.id, p.name]), [['balanced', 'Balanced'], ['economy', 'Economy'], ['best', 'Best quality']])
  for (const p of BUILT_IN_PRESETS) {
    assert.equal(p.builtIn, true)
    assert.deepEqual([p.coordinator, p.lead], [null, null])
    for (const row of Object.values(p.workers)) if (row.fallback) assert.notEqual(row.fallback.model, row.model.model, `${p.id}: the fallback is another model`)
  }
  assert.deepEqual(BUILT_IN_PRESETS[2].workers.hard, { model: { agent: 'claude', model: 'fable', effort: 'high' }, fallback: { agent: 'claude', model: 'opus', effort: 'xhigh' } })
})

test('normalize: defaults, clamps, bad rows fall back to Balanced, old fields dropped', () => {
  for (const raw of [undefined, null, 'x', 4, [], {}, { nonsense: 1 }]) assert.deepEqual(normalizeRouting(raw), DEFAULT_ROUTING)
  const n = normalizeRouting({
    coordinator: { agent: 'claude', model: 'opus', effort: 'max' }, lead: { agent: 'weird', effort: 'high' }, ...{ ['max' + 'Escalations']: 9, ['max' + 'Parallel']: 0 }, // an old config's limits are read without error and dropped
    workerMode: 'fixed', candidates: [{ agent: 'claude', model: 'haiku', tier: 1, cost: 1 }],
    workers: {
      simple: { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'ultra' }, fallback: { agent: 'claude' } },
      normal: { model: { agent: 'claude' }, fallback: { agent: 'claude', model: 'opus' } },
      hard: 'nope'
    }
  })
  assert.deepEqual(n, {
    coordinator: { agent: 'claude', model: 'opus', effort: 'max' }, lead: { agent: 'weird' },
    workers: {
      simple: { model: { agent: 'codex', model: 'gpt-6-luna' }, fallback: null },
      normal: DEFAULT_ROUTING.workers.normal,
      hard: DEFAULT_ROUTING.workers.hard
    },
    types: [],
    presets: []
  })
  assert.equal(JSON.stringify(n), JSON.stringify(normalizeRouting(n)))
  normalizeRouting(undefined).workers.simple.model.model = 'x'
  assert.equal(DEFAULT_ROUTING.workers.simple.model.model, 'haiku', 'a copy, never the default itself')
})

test('normalize: saved presets are validated, deduplicated and capped', () => {
  const p = (name: unknown, workers: unknown = DEFAULT_ROUTING.workers) => ({ name, workers, coordinator: { agent: 'claude', model: 'opus' } })
  const n = normalizeRouting({ presets: [p('Mine'), p('mine'), p('balanced'), p(''), p('Broken', { simple: 1 }), 'x', p('Late night!', BUILT_IN_PRESETS[1].workers)] })
  assert.deepEqual(n.presets.map((x) => [x.id, x.name, x.builtIn]), [['saved:mine', 'Mine', false], ['saved:late-night', 'Late night!', false]])
  assert.deepEqual(n.presets[0].coordinator, { agent: 'claude', model: 'opus' })
  assert.deepEqual(n.presets[1].workers, BUILT_IN_PRESETS[1].workers)
  const many = normalizeRouting({ presets: Array.from({ length: 13 }, (_, i) => p(`P${i}`)) })
  assert.equal(many.presets.length, MAX_SAVED_PRESETS)
  assert.equal(many.presets.at(-1)?.name, 'P9')
})

test('presets: list, match, apply keeps saved presets', () => {
  const s = S()
  assert.equal(matchingPreset(s)?.id, 'balanced')
  const eco = applyPreset(s, 'economy')
  assert.deepEqual(eco.workers, BUILT_IN_PRESETS[1].workers)
  assert.equal(matchingPreset(eco)?.name, 'Economy')
  const custom = withRow('hard', { model: { agent: 'claude', model: 'opus', effort: 'max' }, fallback: null })
  assert.equal(matchingPreset(custom), null, 'Custom')
  assert.equal(matchingPreset({ ...S(), lead: { agent: 'claude', model: 'opus' } }), null, 'the lead counts')
  assert.throws(() => applyPreset(s, 'saved:nope'), /No preset/)
  assert.deepEqual(presetsOf(S()).map((p) => p.id), ['balanced', 'economy', 'best'])
})

test('matchingPreset: a saved copy of a built-in wins, plain built-ins still match, edits match nothing', () => {
  const plain = S()
  assert.equal(matchingPreset(plain)?.id, 'balanced')
  const copy = savePreset(plain, 'My setup')
  assert.equal(matchingPreset(copy)?.id, 'saved:my-setup')
  assert.equal(matchingPreset(copy)?.builtIn, false)
  // the built-in itself is still there and still applies
  assert.equal(presetsOf(copy)[0].id, 'balanced')
  assert.equal(matchingPreset(applyPreset(copy, 'economy'))?.id, 'economy')
  // an edited setup matches nothing (Custom), with or without saved presets present
  const edited = withRow('hard', { model: { agent: 'claude', model: 'opus', effort: 'max' }, fallback: null })
  assert.equal(matchingPreset(edited), null, 'Custom')
  assert.equal(matchingPreset({ ...copy, lead: { agent: 'claude', model: 'opus' } }), null, 'Custom with saved presets')
})

test('presets: save, replace by name, refuse built-in names and empty names, cap, delete', () => {
  const custom = withRow('hard', { model: { agent: 'claude', model: 'fable', effort: 'max' }, fallback: null }, { lead: { agent: 'claude', model: 'opus' } })
  const saved = savePreset(custom, '  Deep work ')
  assert.deepEqual(saved.presets.map((p) => [p.id, p.name]), [['saved:deep-work', 'Deep work']])
  assert.deepEqual(saved.presets[0].workers, custom.workers)
  assert.deepEqual(saved.presets[0].lead, { agent: 'claude', model: 'opus' })
  assert.equal(matchingPreset(saved)?.id, 'saved:deep-work')
  assert.deepEqual(presetsOf(saved).map((p) => p.id), ['balanced', 'economy', 'best', 'saved:deep-work'])
  // the same name replaces it in place
  const again = savePreset(applyPreset(saved, 'best'), 'deep work')
  assert.equal(again.presets.length, 1)
  assert.deepEqual(again.presets[0].workers, BUILT_IN_PRESETS[2].workers)
  // applying a saved preset brings its coordinator, lead and workers back
  const back = applyPreset(saved, 'saved:deep-work')
  assert.deepEqual([back.lead, back.workers], [custom.lead, custom.workers])
  for (const name of ['Balanced', 'economy', ' BEST QUALITY ', '', '   ']) assert.throws(() => savePreset(S(), name))
  let full = S()
  for (let i = 0; i < MAX_SAVED_PRESETS; i++) full = savePreset(full, `P${i}`)
  assert.throws(() => savePreset(full, 'one more'), /At most 10 saved presets/)
  assert.equal(savePreset(full, 'P3').presets.length, MAX_SAVED_PRESETS, 'replacing is fine when full')
  assert.deepEqual(deletePreset(saved, 'saved:deep-work').presets, [])
  assert.deepEqual(deletePreset(saved, 'saved:other').presets.length, 1)
  assert.throws(() => deletePreset(saved, 'balanced'), /Built-in/)
  // round trip through normalize keeps saved presets
  assert.deepEqual(normalizeRouting(JSON.parse(JSON.stringify(saved))), saved)
})

test('rowFor: each kind, risk, context and escalation', () => {
  assert.deepEqual(rowFor({ role: 'worker' }), { kind: 'normal', spent: false, why: 'normal task' })
  assert.equal(rowFor({ role: 'worker', kind: 'simple' }).kind, 'simple')
  assert.equal(rowFor({ role: 'worker', kind: 'hard' }).why, 'hard task')
  assert.deepEqual(rowFor({ role: 'worker', kind: 'simple', risk: 'high' }), { kind: 'normal', spent: false, why: 'simple task, high risk' })
  assert.deepEqual(rowFor({ role: 'worker', risk: 'high' }), { kind: 'hard', spent: false, why: 'normal task, high risk' })
  assert.equal(rowFor({ role: 'worker', kind: 'simple', context: 'large' }).kind, 'normal')
  assert.equal(rowFor({ role: 'worker', kind: 'hard', context: 'large' }).kind, 'hard')
  assert.deepEqual(rowFor({ role: 'worker', kind: 'simple', attempt: 1 }), { kind: 'normal', spent: false, why: 'simple task, escalated once' })
  assert.deepEqual(rowFor({ role: 'worker', kind: 'hard', attempt: 1 }), { kind: 'hard', spent: true, why: 'hard task, escalated once' })
  assert.equal(rowFor({ role: 'worker', kind: 'normal', risk: 'high', attempt: 1 }).spent, true, 'it already ran on hard')
  assert.deepEqual(['simple', 'normal', 'hard', 'trivial', 'standard', 'complex', 'huge', 3].map(taskKind), ['simple', 'normal', 'hard', 'simple', 'normal', 'hard', undefined, undefined])
})

test('worker: each kind starts on its row, with short reasons', () => {
  const simple = ok(worker({ kind: 'simple' }))
  assert.deepEqual([simple.choice, simple.source, simple.reason], [{ agent: 'claude', model: 'haiku' }, 'kind', 'simple task → Claude Haiku'])
  assert.deepEqual(simple.row, { kind: 'simple', route: DEFAULT_ROUTING.workers.simple })
  const normal = ok(worker())
  assert.deepEqual([normal.choice, normal.reason, normal.skipped], [{ agent: 'claude', model: 'sonnet', effort: 'medium' }, 'normal task → Claude Sonnet · medium', []])
  assert.deepEqual(ok(worker({ kind: 'hard' })).choice, { agent: 'claude', model: 'opus', effort: 'high' })
  const risky = ok(worker({ risk: 'high' }))
  assert.deepEqual([risky.choice, risky.row?.kind, risky.reason], [{ agent: 'claude', model: 'opus', effort: 'high' }, 'hard', 'normal task, high risk → Claude Opus · high'])
  const large = ok(worker({ kind: 'simple', context: 'large' }))
  assert.deepEqual([large.choice.model, large.reason], ['sonnet', 'simple task, large context → Claude Sonnet · medium'])
  const codex = withRow('normal', { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' }, fallback: null })
  assert.deepEqual(ok(worker({}, codex)).choice, { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' })
  assert.deepEqual(worker({}, codex), worker({}, codex), 'deterministic')
})

test('worker: a failed task moves up n rows per n failures: simple → normal → hard → refused', () => {
  const path = [0, 1, 2].map((attempt) => ok(worker({ kind: 'simple', attempt })))
  assert.deepEqual(path.map((d) => d.row?.kind), ['simple', 'normal', 'hard'])
  assert.deepEqual(path.map((d) => d.choice.model), ['haiku', 'sonnet', 'opus'])
  assert.equal(path[2].reason, 'simple task, escalated twice → Claude Opus · high', 'no effort boost above the hard row')
  const refused = 'Already at the hard level: ask the user before trying again.'
  assert.equal(bad(worker({ kind: 'simple', attempt: 3 })), refused)
  assert.equal(bad(worker({ kind: 'hard', attempt: 1 })), refused, 'a hard task has no row above')
  assert.equal(bad(worker({ risk: 'high', attempt: 1 })), refused, 'it already ran on hard because of the risk')
  assert.equal(bad(worker({ attempt: 2 })), refused)
  assert.equal(bad(worker({ attempt: 2, agent: 'claude' })), refused, 'an agent-only override does not lift it')
  assert.equal(ok(worker({ attempt: 1 })).choice.model, 'opus')
})

test('worker: an unavailable model uses the row fallback and says so; both unavailable is refused', () => {
  const claudeList = { agents: ['claude'], models: { claude: [{ id: 'sonnet', efforts: ['low' as const, 'medium' as const, 'high' as const] }, { id: 'opus' }] } }
  // Claude aliases and claude-* ids stay usable when absent from the list; a non-Claude name does not
  const aliasRow = ok(worker({ kind: 'simple' }, S(), claudeList))
  assert.deepEqual([aliasRow.choice, aliasRow.source], [{ agent: 'claude', model: 'haiku' }, 'kind'])
  const ghostRow = withRow('simple', { model: { agent: 'claude', model: 'gpt-ghost' }, fallback: { agent: 'claude', model: 'sonnet', effort: 'low' } })
  const fb = ok(worker({ kind: 'simple' }, ghostRow, claudeList))
  assert.deepEqual([fb.choice, fb.source], [{ agent: 'claude', model: 'sonnet', effort: 'low' }, 'fallback'])
  assert.equal(fb.reason, "simple task → Claude Sonnet · low: gpt-ghost unavailable (not in Claude's model list), used the fallback")
  assert.deepEqual(fb.skipped, [{ model: 'Claude gpt-ghost', why: "not in Claude's model list" }])
  // the Codex primary is not installed: its fallback runs
  const codexRow = withRow('normal', { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' }, fallback: { agent: 'claude', model: 'sonnet', effort: 'high' } })
  const noCodex = ok(worker({}, codexRow, { agents: ['claude'], models: {} }))
  assert.deepEqual(noCodex.choice, { agent: 'claude', model: 'sonnet', effort: 'high' })
  assert.equal(noCodex.reason, 'normal task → Claude Sonnet · high: gpt-6-luna unavailable (codex not installed), used the fallback')
  // both gone, or no fallback: refused, naming both, never a provider default
  const both = bad(worker({ kind: 'simple' }, S(), { agents: ['codex'], models: {} }))
  assert.match(both, /Claude Haiku is unavailable \(claude not installed\) and its fallback Claude Sonnet · low is unavailable too \(claude not installed\)/)
  assert.match(both, /Settings → Models/)
  assert.match(both, /--model/)
  const none = bad(worker({ kind: 'hard' }, S(), { agents: ['codex'], models: {} }))
  assert.match(none, /Claude Opus · high is unavailable \(claude not installed\) and the row has no fallback\. Change the hard row in Settings → Models, or pass --model\./)
  const ghost = withRow('normal', { model: { agent: 'codex', model: 'gpt-9-ghost', effort: 'low' }, fallback: null })
  assert.match(bad(worker({}, ghost)), /not in Codex's model list/)
  // catalogs unknown: Claude aliases and any Codex id accepted unverified
  assert.equal(ok(worker({}, ghost, { agents: null, models: {} })).choice.model, 'gpt-9-ghost')
  assert.equal(bad(worker({}, withRow('normal', { model: { agent: 'claude', model: 'gpt-6-luna' }, fallback: null }))).includes('not a Claude model name'), true)
})

test('effort: the row effort, clamped to what the provider reports and Orca accepts', () => {
  const luna = withRow('hard', { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'xhigh' }, fallback: null })
  const clampedUp = ok(worker({ kind: 'hard' }, luna))
  assert.equal(clampedUp.choice.effort, 'high', 'xhigh asked, gpt-6-luna takes up to high')
  assert.match(clampedUp.reason, /xhigh not supported so high/)
  const sol = withRow('hard', { model: { agent: 'codex', model: 'gpt-6.2-sol', effort: 'max' }, fallback: null })
  assert.equal(ok(worker({ kind: 'hard' }, sol)).choice.effort, 'max')
  const odd = { agents: ['codex'], models: { codex: [{ id: 'm', efforts: ['xhigh' as const, 'max' as const] }] } }
  assert.equal(ok(worker({}, withRow('normal', { model: { agent: 'codex', model: 'm', effort: 'low' }, fallback: null }), odd)).choice.effort, 'xhigh')
  // Haiku with an effort set: Orca refuses one, so none is passed
  const hk = ok(worker({ kind: 'simple' }, withRow('simple', { model: { agent: 'claude', model: 'haiku', effort: 'low' }, fallback: null })))
  assert.deepEqual(hk.choice, { agent: 'claude', model: 'haiku' })
  assert.match(hk.reason, /low not supported so default effort/)
})

test('coordinator and lead: default, set pick, unavailable pick, effort clamp', () => {
  const lead = ok(route(S(), { role: 'lead' }, AVAIL))
  assert.deepEqual([lead.choice, lead.source, lead.reason], [{ agent: 'claude' }, 'default', 'provider default model (none set for leads)'])
  assert.deepEqual(ok(route(S(), { role: 'lead', agent: 'codex' }, AVAIL)).choice, { agent: 'codex' })
  const set = S({ coordinator: { agent: 'claude', model: 'opus', effort: 'high' } })
  const c = ok(route(set, { role: 'coordinator' }, AVAIL))
  assert.deepEqual([c.choice, c.source], [{ agent: 'claude', model: 'opus', effort: 'high' }, 'role'])
  const luna = S({ lead: { agent: 'codex', model: 'gpt-6-luna', effort: 'max' } })
  const clamped = ok(route(luna, { role: 'lead' }, AVAIL))
  assert.equal(clamped.choice.effort, 'high')
  assert.match(clamped.reason, /max not supported so high/)
  const gone = S({ lead: { agent: 'codex', model: 'gpt-9-ghost', effort: 'low' } })
  const d = ok(route(gone, { role: 'lead' }, AVAIL))
  assert.deepEqual([d.choice, d.source], [{ agent: 'codex' }, 'default'])
  assert.match(d.reason, /Codex gpt-9-ghost · low is unavailable/)
  assert.match(bad(route(gone, { role: 'lead' }, { agents: ['claude'], models: {} })), /Codex gpt-9-ghost · low is unavailable \(codex not installed\)/)
  // workers' rows never apply to coordinators or leads
  assert.equal(ok(route(S(), { role: 'lead', kind: 'hard' }, AVAIL)).source, 'default')
})

test('precedence: explicit flags beat role picks and rows, and invalid ones are refused, not substituted', () => {
  const set = S({ lead: { agent: 'claude', model: 'opus' } })
  const o = ok(route(set, { role: 'lead', model: 'sonnet', effort: 'low' }, AVAIL))
  assert.deepEqual([o.choice, o.source], [{ agent: 'claude', model: 'sonnet', effort: 'low' }, 'override'])
  assert.equal(ok(worker({ kind: 'simple', model: 'opus' })).choice.model, 'opus')
  assert.equal(ok(worker({ kind: 'hard', attempt: 5, model: 'sonnet' })).source, 'override', 'an explicit model is the user’s call, whatever the attempt')
  assert.deepEqual(ok(worker({ model: 'claude-sonnet-4-5' })).choice, { agent: 'claude', model: 'claude-sonnet-4-5' })
  assert.deepEqual(ok(worker({ model: 'gpt-6-luna' })).choice, { agent: 'codex', model: 'gpt-6-luna' })
  assert.match(bad(worker({ model: 'mystery' })), /pass --agent/)
  assert.match(bad(worker({ agent: 'codex', model: 'gpt-9-ghost' })), /not in Codex's model list/)
  assert.match(bad(worker({ agent: 'claude', model: 'gpt-6-luna' })), /not a Claude model name/)
  assert.match(bad(worker({ model: 'haiku' }, S(), { agents: ['codex'], models: {} })), /claude not installed/)
  assert.match(bad(worker({ agent: 'codex', model: 'gpt-6-luna', effort: 'max' })), /does not support effort max/)
  assert.match(bad(worker({ agent: 'cursor' })), /cursor not installed/)
  // agent only: the row when it runs on that agent, else that agent's default model
  assert.deepEqual(ok(worker({ agent: 'claude' })).choice, { agent: 'claude', model: 'sonnet', effort: 'medium' })
  const codex = ok(worker({ agent: 'codex' }))
  assert.deepEqual([codex.choice, codex.source], [{ agent: 'codex' }, 'override'])
  // effort only: routed normally, then that effort
  const e = ok(worker({ effort: 'high' }))
  assert.deepEqual([e.choice, e.source], [{ agent: 'claude', model: 'sonnet', effort: 'high' }, 'kind'])
  assert.match(e.reason, /effort high set explicitly$/)
  assert.match(bad(worker({ effort: 'max' }, withRow('normal', { model: { agent: 'codex', model: 'gpt-6-luna' }, fallback: null }))), /does not support effort max/)
})

test('launchArgs drops effort without a model; labels read plainly', () => {
  assert.deepEqual(launchArgs({ agent: 'claude' }), ['--agent', 'claude'])
  assert.deepEqual(launchArgs({ agent: 'claude', effort: 'high' }), ['--agent', 'claude'])
  assert.deepEqual(launchArgs({ agent: 'codex', model: 'gpt-6-luna', effort: 'low' }), ['--agent', 'codex', '--model', 'gpt-6-luna', '--effort', 'low'])
  assert.deepEqual(launchArgs({ agent: 'claude', model: 'opus' }), ['--agent', 'claude', '--model', 'opus'])
  assert.equal(choiceLabel({ agent: 'claude', model: 'sonnet', effort: 'medium' }), 'Claude Sonnet · medium')
  assert.equal(choiceLabel({ agent: 'codex', model: 'gpt-6-luna', effort: 'low' }), 'Codex gpt-6-luna · low')
  assert.equal(choiceLabel({ agent: 'claude' }), 'Claude (default model)')
  assert.equal(choiceLabel({ agent: 'claude', model: 'claude-opus-4-1' }), 'Claude claude-opus-4-1')
})

test('Orca launch limits: table, Haiku takes no effort, nothing Orca refuses is passed or accepted', () => {
  assert.deepEqual(orcaLaunchEfforts('claude', 'haiku'), [])
  assert.deepEqual(orcaLaunchEfforts('claude', 'sonnet'), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(orcaLaunchEfforts('claude', 'claude-opus-5-5')?.length, 5)
  assert.deepEqual(orcaLaunchEfforts('codex', 'gpt-5.5'), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(orcaLaunchEfforts('codex', 'gpt-9-new')?.length, 5)
  assert.equal(orcaLaunchEfforts('cursor', 'x'), null)
  // the provider reports efforts for haiku, Orca still refuses them
  const reported = { agents: ['claude'], models: { claude: [{ id: 'haiku', efforts: ['low' as const, 'high' as const] }, { id: 'sonnet', efforts: ['low' as const, 'medium' as const] }] } } as Availability
  assert.deepEqual(ok(worker({ kind: 'simple' }, S(), reported)).choice, { agent: 'claude', model: 'haiku' })
  // a hard row asking xhigh; Sonnet as the provider reports takes up to medium
  assert.equal(ok(worker({ kind: 'hard' }, withRow('hard', { model: { agent: 'claude', model: 'sonnet', effort: 'xhigh' }, fallback: null }), reported)).choice.effort, 'medium')
  // explicit efforts Orca would refuse are refused by route()
  assert.match(bad(worker({ model: 'haiku', effort: 'low' })), /Claude Haiku takes no effort setting, so effort low cannot be passed/)
  assert.match(bad(worker({ kind: 'simple', effort: 'low' })), /takes no effort setting/)
  assert.match(bad(route(S({ lead: { agent: 'claude', model: 'haiku' } }), { role: 'lead', effort: 'high' }, AVAIL)), /takes no effort setting/)
  assert.match(bad(worker({ model: 'sonnet', effort: 'max' }, S(), reported)), /it takes low, medium/)
  assert.equal(ok(worker({ model: 'sonnet', effort: 'max' })).choice.effort, 'max')
  assert.deepEqual(launchArgs(ok(worker({ kind: 'simple' })).choice), ['--agent', 'claude', '--model', 'haiku'])
})

test('an explicit --effort without a model is refused, never reported as applied', () => {
  assert.match(bad(route(S(), { role: 'lead', effort: 'high' }, AVAIL)), /--effort high.*only with --model.*Name a model/)
  assert.match(bad(route(S(), { role: 'worker', agent: 'codex', effort: 'low' }, AVAIL)), /only with --model/)
  assert.match(bad(route(S({ lead: { agent: 'claude' } }), { role: 'lead', effort: 'low' }, AVAIL)), /only with --model/)
  assert.equal(ok(route(S(), { role: 'worker', model: 'opus', effort: 'high' }, AVAIL)).choice.effort, 'high')
})

test('claude: aliases and unlisted claude-* ids are accepted when a model list is known; other names are not', () => {
  const listed: Availability = { agents: ['claude'], models: { claude: [{ id: 'claude-opus-5-5' }] } }
  for (const m of ['haiku', 'sonnet', 'opus', 'fable', 'claude-opus-5-5', 'claude-sonnet-9-9']) assert.equal(modelProblem('claude', m, listed), null, m)
  assert.equal(ok(route(S(), { role: 'worker', model: 'claude-future-1' }, listed)).choice.model, 'claude-future-1')
  assert.match(modelProblem('claude', 'gpt-6-luna', listed) ?? '', /not in Claude's model list/)
  assert.match(bad(route(S(), { role: 'worker', model: 'gpt-x', agent: 'claude' }, listed)), /Cannot use claude gpt-x/)
  assert.deepEqual(supportedEfforts('claude', 'claude-future-1', listed), ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('saved presets get unique ids: only an exact (case-insensitive) name replaces', () => {
  let s = savePreset(S(), '日本')
  s = savePreset(s, '中文')
  s = savePreset(s, 'fast')
  s = savePreset(s, 'Fast!')
  assert.equal(s.presets.length, 4)
  assert.equal(new Set(s.presets.map((p) => p.id)).size, 4)
  const ids = s.presets.map((p) => p.id)
  s = savePreset(s, ' FAST ')
  assert.equal(s.presets.length, 4)
  assert.deepEqual(s.presets.map((p) => p.id), ids, 'replace keeps the id')
  assert.deepEqual(normalizeRouting(s).presets.map((p) => p.id), ids, 'ids survive a round trip')
  assert.deepEqual(normalizeRouting(JSON.parse(JSON.stringify(s))).presets.map((p) => p.name), ['日本', '中文', 'FAST', 'Fast!'])
})

// ---------- task types ----------

const GEM: KindRoute = { model: { agent: 'antigravity', model: 'gemini-3.8-flash', effort: 'low' }, fallback: { agent: 'codex', model: 'gpt-6-luna', effort: 'low' } }
const LUNA: KindRoute = { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' }, fallback: { agent: 'claude', model: 'sonnet', effort: 'low' } }
const ALL3: Availability = { agents: ['claude', 'codex', 'antigravity'], models: { claude: null, codex: CODEX, antigravity: null } }
const typed = () => addType(addType(S(), 'Browser checks', 'Open pages, click through flows, take screenshots', GEM), 'Images', 'Make or edit images', LUNA)

test('types: suggestions are names and descriptions only, no models', () => {
  assert.deepEqual(SUGGESTED_TYPES.map((t) => t.name), ['Browser checks', 'Images', 'Docs & copy', 'Research', 'Code review'])
  for (const t of SUGGESTED_TYPES) assert.deepEqual(Object.keys(t), ['name', 'description'])
  assert.deepEqual(S().types, [])
})

test('types: add, update, remove; ids are stable unique slugs; refusals', () => {
  const s = typed()
  assert.deepEqual(s.types.map((t) => [t.id, t.name, t.description]), [['browser-checks', 'Browser checks', 'Open pages, click through flows, take screenshots'], ['images', 'Images', 'Make or edit images']])
  assert.deepEqual(s.types[0].route, GEM)
  // a renamed type keeps its id; the description and row change on their own
  const renamed = updateType(s, 'images', { name: '  Pictures ', description: ' Icons and art ' })
  assert.deepEqual([renamed.types[1].id, renamed.types[1].name, renamed.types[1].description, renamed.types[1].route], ['images', 'Pictures', 'Icons and art', LUNA])
  assert.deepEqual(updateType(s, 'images', { route: GEM }).types[1].route, GEM)
  // a new type whose slug is taken gets the next free id
  assert.equal(addType(renamed, 'Images!', '', LUNA).types[2].id, 'images-2')
  assert.equal(addType(S(), 'Hard!', '', LUNA).types[0].id, 'hard-2', 'never a kind name as id')
  // refusals
  assert.throws(() => addType(s, 'images', '', LUNA), /already a type named/)
  assert.throws(() => addType(s, '  ', '', LUNA), /needs a name/)
  for (const kind of ['Simple', 'normal', 'HARD', 'trivial']) assert.throws(() => addType(s, kind, '', LUNA), /is a difficulty/)
  assert.throws(() => addType(s, 'Long', 'x'.repeat(121), LUNA), /at most 120 characters/)
  assert.equal(addType(s, 'Long', 'x'.repeat(120), LUNA).types[2].description.length, 120)
  assert.throws(() => addType(s, 'x'.repeat(41), '', LUNA), /at most 40 characters/)
  assert.throws(() => addType(s, 'No model', '', { model: { agent: 'claude' }, fallback: null }), /needs a model/)
  assert.throws(() => updateType(s, 'images', { name: 'Browser Checks' }), /already a type named/)
  assert.equal(updateType(s, 'images', { name: 'IMAGES' }).types[1].name, 'IMAGES', 'its own name in another case is fine')
  assert.throws(() => updateType(s, 'nope', { name: 'x' }), /No task type nope/)
  let full = S()
  for (let i = 0; i < MAX_TYPES; i++) full = addType(full, `T${i}`, '', LUNA)
  assert.throws(() => addType(full, 'one more', '', LUNA), /At most 12 task types/)
  // remove; an unknown id changes nothing
  assert.deepEqual(removeType(s, 'browser-checks').types.map((t) => t.id), ['images'])
  assert.deepEqual(removeType(s, 'nope').types, s.types)
  // lookup by id or name, any case
  assert.equal(findType(s, 'BROWSER-checks')?.id, 'browser-checks')
  assert.equal(findType(s, ' browser checks ')?.id, 'browser-checks')
  assert.equal(findType(s, 'video'), undefined)
})

test('types: normalize drops bad ones, trims, caps, keeps ids, and round-trips through JSON', () => {
  const n = normalizeRouting({ types: [
    { id: 'browser', name: '  Browser checks ', description: `  ${'d'.repeat(130)}  `, route: GEM },
    { id: 'browser', name: 'Images', description: 'pictures', route: LUNA }, // a taken id: a fresh one
    { name: 'images', route: LUNA }, // same name
    { name: 'Normal', route: LUNA }, // a kind's name
    { name: 'No model', route: { model: { agent: 'claude' } } },
    { name: '', route: LUNA }, 'x', null,
    { id: 'Bad Id!', name: 'Docs', route: { model: { agent: 'claude', model: 'haiku' }, fallback: { agent: 'claude' } } }
  ] })
  assert.deepEqual(n.types.map((t) => [t.id, t.name, t.description.length]), [['browser', 'Browser checks', 120], ['images', 'Images', 8], ['docs', 'Docs', 0]])
  assert.deepEqual(n.types[2].route, { model: { agent: 'claude', model: 'haiku' }, fallback: null })
  assert.equal(normalizeRouting({ types: Array.from({ length: 15 }, (_, i) => ({ name: `T${i}`, route: LUNA })) }).types.length, MAX_TYPES)
  const s = typed()
  assert.deepEqual(normalizeRouting(JSON.parse(JSON.stringify(s))), s)
  assert.equal(JSON.stringify(normalizeRouting(s)), JSON.stringify(s), 'fixed key order')
})

test('types and presets: a saved preset carries its types; a built-in keeps the user types; matchingPreset', () => {
  const s = typed()
  assert.equal(matchingPreset(s)?.id, 'balanced', 'a built-in matches on roles and rows, whatever the types')
  assert.equal(matchingPreset(applyPreset(s, 'economy'))?.id, 'economy')
  const saved = savePreset(s, 'With types')
  assert.deepEqual(saved.presets[0].types, s.types)
  assert.equal(matchingPreset(saved)?.id, 'saved:with-types', 'saved wins over the built-in with the same rows')
  // a saved preset matches only with its types too; then the built-in with those rows shows
  assert.equal(matchingPreset(removeType(saved, 'images'))?.id, 'balanced', 'a removed type: not the saved one')
  assert.equal(matchingPreset(updateType(saved, 'images', { description: 'other' }))?.id, 'balanced', 'an edited type: not the saved one')
  const custom = withRow('hard', { model: { agent: 'claude', model: 'opus', effort: 'max' }, fallback: null }, { types: s.types })
  assert.equal(matchingPreset(custom), null, 'edited rows are Custom, types or not')
  // a built-in sets roles and rows only and keeps the user's types; a saved preset applies its own
  const eco = applyPreset({ ...saved, lead: { agent: 'claude', model: 'opus' } }, 'economy')
  assert.deepEqual([eco.lead, eco.workers, eco.types, eco.presets], [null, BUILT_IN_PRESETS[1].workers, s.types, saved.presets])
  const plainSaved = savePreset(S(), 'No types')
  const noTypes = applyPreset({ ...plainSaved, types: s.types }, 'saved:no-types')
  assert.deepEqual([noTypes.types, matchingPreset(noTypes)?.id], [[], 'saved:no-types'])
  assert.deepEqual(applyPreset(noTypes, 'saved:no-types').types, [])
  assert.deepEqual(applyPreset(applyPreset(saved, 'best'), 'saved:with-types').types, s.types)
  for (const p of BUILT_IN_PRESETS) assert.deepEqual(p.types, [])
  // an older saved preset without types reads as none
  const old = normalizeRouting({ presets: [{ name: 'Old', workers: DEFAULT_ROUTING.workers }] })
  assert.deepEqual(old.presets[0].types, [])
  assert.equal(matchingPreset(old)?.id, 'saved:old')
})

test('typed task: its type row, by id or name; kind, risk and context do not change it', () => {
  const s = typed()
  const d = ok(worker({ type: 'browser-checks' }, s, ALL3))
  assert.deepEqual([d.choice, d.source, d.reason], [{ agent: 'antigravity', model: 'gemini-3.8-flash', effort: 'low' }, 'type', 'Browser checks task → Antigravity gemini-3.8-flash · low'])
  assert.deepEqual(d.type, { id: 'browser-checks', name: 'Browser checks', route: GEM })
  assert.equal(d.row, undefined)
  for (const extra of [{ kind: 'hard' as const }, { kind: 'simple' as const, risk: 'high' as const }, { context: 'large' as const }, { type: 'Browser Checks' }]) {
    assert.deepEqual(ok(worker({ type: 'browser-checks', ...extra }, s, ALL3)).choice, d.choice, JSON.stringify(extra))
  }
  // a type only means something for workers
  assert.equal(ok(route(s, { role: 'lead', type: 'nope' }, ALL3)).source, 'default')
})

test('typed task: fallback when the model is unavailable, refused when both are', () => {
  const s = typed()
  const fb = ok(worker({ type: 'browser-checks' }, s, AVAIL))
  assert.deepEqual([fb.choice, fb.source], [{ agent: 'codex', model: 'gpt-6-luna', effort: 'low' }, 'fallback'])
  assert.equal(fb.reason, 'Browser checks task → Codex gpt-6-luna · low: gemini-3.8-flash unavailable (antigravity not installed), used the fallback')
  assert.deepEqual(fb.skipped, [{ model: 'Antigravity gemini-3.8-flash · low', why: 'antigravity not installed' }])
  const both = bad(worker({ type: 'browser-checks' }, s, { agents: ['claude'], models: {} }))
  assert.equal(both, 'No model for this Browser checks task: Antigravity gemini-3.8-flash · low is unavailable (antigravity not installed) and its fallback Codex gpt-6-luna · low is unavailable too (codex not installed). Change the Browser checks type in Settings → Models, or pass --model.')
  const lone = updateType(s, 'browser-checks', { route: { model: GEM.model, fallback: null } })
  assert.match(bad(worker({ type: 'browser-checks' }, lone, AVAIL)), /and the type has no fallback/)
})

test('typed task: an unknown type is refused with the known ones, never routed by difficulty', () => {
  const s = typed()
  assert.equal(bad(worker({ type: 'video', kind: 'simple' }, s)), 'No task type "video". Known types: browser-checks (Browser checks), images (Images). Use one of these, or route by difficulty with --kind.')
  assert.match(bad(worker({ type: 'video' })), /^No task type "video": no types are set, so tasks go by difficulty\. Pass --kind simple, normal or hard instead/)
  assert.match(bad(worker({ type: 'video', model: 'opus' }, s)), /No task type "video"/, 'a typo is refused even beside an override')
})

test('typed task: an explicit model, agent or effort still wins', () => {
  const s = typed()
  const model = ok(worker({ type: 'images', model: 'opus' }, s, ALL3))
  assert.deepEqual([model.choice, model.source], [{ agent: 'claude', model: 'opus' }, 'override'])
  const agent = ok(worker({ type: 'images', agent: 'claude' }, s, ALL3))
  assert.deepEqual([agent.choice, agent.source], [{ agent: 'claude' }, 'override'])
  assert.deepEqual(ok(worker({ type: 'images', agent: 'codex' }, s, ALL3)).choice, LUNA.model, 'the type row already runs on that agent')
  const effort = ok(worker({ type: 'images', effort: 'high' }, s, ALL3))
  assert.deepEqual([effort.choice, effort.reason], [{ agent: 'codex', model: 'gpt-6-luna', effort: 'high' }, 'Images task → Codex gpt-6-luna · medium; effort high set explicitly'])
})

test('typed task escalation: the first retry runs on the fallback, then refused; never the difficulty rows', () => {
  const s = typed()
  const retry = ok(worker({ type: 'images', attempt: 1 }, s, ALL3))
  assert.deepEqual([retry.choice, retry.source, retry.reason], [{ agent: 'claude', model: 'sonnet', effort: 'low' }, 'fallback', 'Images task, retried → Claude Sonnet · low: fallback after a failure'])
  assert.equal(bad(worker({ type: 'images', attempt: 2 }, s, ALL3)), 'No stronger model for Images: ask the user before trying again.')
  assert.deepEqual(ok(worker({ type: 'images', attempt: 1, kind: 'hard' }, s, ALL3)).choice, retry.choice, 'a hard kind does not lift the type, nor refuse it as "already hard"')
  // no fallback, the same choice as the model, or an unavailable fallback: refused at once
  const none = updateType(s, 'images', { route: { model: LUNA.model, fallback: null } })
  assert.equal(bad(worker({ type: 'images', attempt: 1 }, none, ALL3)), 'No stronger model for Images: ask the user before trying again.')
  const sameFb = updateType(s, 'images', { route: { model: LUNA.model, fallback: LUNA.model } })
  assert.equal(bad(worker({ type: 'images', attempt: 1 }, sameFb, ALL3)), 'No stronger model for Images: ask the user before trying again.')
  const gone = bad(worker({ type: 'images', attempt: 1 }, s, { agents: ['codex'], models: { codex: CODEX } }))
  assert.equal(gone, 'No stronger model for Images: ask the user before trying again.')
})

test('resetRouting: Balanced roles and rows; types and saved presets stay', () => {
  const s = savePreset(applyPreset(typed(), 'best'), 'Mine')
  const edited = { ...s, coordinator: { agent: 'claude', model: 'opus' }, lead: { agent: 'codex' } }
  const reset = resetRouting(edited)
  assert.deepEqual(reset, { ...DEFAULT_ROUTING, types: s.types, presets: s.presets })
  assert.equal(matchingPreset(reset)?.id, 'balanced')
  assert.deepEqual(resetRouting(S()), DEFAULT_ROUTING)
})
