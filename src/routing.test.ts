import { assert, test } from 'orca/testing'
import { applyPreset, BUILT_IN_PRESETS, choiceLabel, DEFAULT_ROUTING, deletePreset, launchArgs, matchingPreset, MAX_SAVED_PRESETS, normalizeRouting, orcaLaunchEfforts, presetsOf, route, rowFor, savePreset, supportedEfforts, modelProblem, taskKind, type Availability, type KindRoute, type RouteDecision, type RouteRequest, type RoutingSettings } from './routing.ts'

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
