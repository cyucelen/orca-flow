import { assert, test } from 'orca/testing'
import { choiceLabel, type Candidate, DEFAULT_ROUTING, launchArgs, normalizeRouting, requiredTier, route, type Availability, type RouteDecision, type RouteRequest, type RoutingSettings } from './routing.ts'

const CODEX = [
  { id: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] as const },
  { id: 'gpt-6.2-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const }
].map((m) => ({ id: m.id, efforts: [...m.efforts] }))
const AVAIL: Availability = { agents: ['claude', 'codex'], models: { claude: null, codex: CODEX } }
const S = (over: Partial<RoutingSettings> = {}): RoutingSettings => ({ ...normalizeRouting(undefined), ...over })
const ok = (d: RouteDecision) => { assert.equal(d.ok, true, d.ok ? '' : d.error); return d as Extract<RouteDecision, { ok: true }> }
const bad = (d: RouteDecision) => { assert.equal(d.ok, false); return (d as Extract<RouteDecision, { ok: false }>).error }
const worker = (req: Partial<RouteRequest> = {}, settings = S(), avail = AVAIL) => route(settings, { role: 'worker', ...req }, avail)

test('normalize: defaults, clamps, drops and dedupes', () => {
  for (const raw of [undefined, null, 'x', 4, [], {}, { nonsense: 1 }]) assert.deepEqual(normalizeRouting(raw), DEFAULT_ROUTING)
  const n = normalizeRouting({
    coordinator: { agent: 'claude', model: 'opus', effort: 'max' }, lead: { agent: 'weird', effort: 'high' }, worker: 'nope',
    workerMode: 'fixed', maxEscalations: 9, maxParallel: 0,
    candidates: [
      { agent: 'claude', model: 'haiku', tier: 0, cost: 99, enabled: false },
      { agent: 'claude', model: 'haiku', tier: 3, cost: 1 },
      { agent: 'codex', model: 'gpt-6-luna', tier: 1.4, cost: 2.6, effort: 'ultra' },
      { agent: 'codex', model: '', tier: 1, cost: 1 }, { agent: 'x', model: 'y', tier: 'a', cost: 1 }, 7
    ]
  })
  assert.deepEqual(n, {
    coordinator: { agent: 'claude', model: 'opus', effort: 'max' }, lead: { agent: 'weird' }, workerMode: 'fixed', worker: null,
    candidates: [{ agent: 'claude', model: 'haiku', tier: 1, cost: 5, enabled: false }, { agent: 'codex', model: 'gpt-6-luna', tier: 1, cost: 3, enabled: true }],
    maxEscalations: 2, maxParallel: 1
  })
  assert.equal(JSON.stringify(n), JSON.stringify(normalizeRouting(n)))
  assert.deepEqual(normalizeRouting({ candidates: [] }).candidates, [])
  assert.deepEqual(normalizeRouting({ candidates: [1] }).candidates, DEFAULT_ROUTING.candidates)
  normalizeRouting(undefined).candidates.pop()
  assert.equal(DEFAULT_ROUTING.candidates.length, 3)
})

test('requiredTier: each class, risk, context, escalation and the effort boost', () => {
  assert.deepEqual(requiredTier({ role: 'worker' }), { tier: 2, effortBoost: 0, why: 'standard task' })
  assert.equal(requiredTier({ role: 'worker', taskClass: 'trivial' }).tier, 1)
  assert.equal(requiredTier({ role: 'worker', taskClass: 'complex' }).why, 'complex task')
  assert.deepEqual(requiredTier({ role: 'worker', taskClass: 'trivial', risk: 'high' }), { tier: 2, effortBoost: 0, why: 'trivial task, high risk' })
  assert.equal(requiredTier({ role: 'worker', risk: 'high' }).why, 'standard task, high risk')
  assert.equal(requiredTier({ role: 'worker', risk: 'high' }).tier, 3)
  assert.equal(requiredTier({ role: 'worker', taskClass: 'trivial', context: 'large' }).tier, 2)
  assert.equal(requiredTier({ role: 'worker', taskClass: 'complex', context: 'large' }).tier, 3)
  const t = requiredTier({ role: 'worker', taskClass: 'trivial', attempt: 1 })
  assert.deepEqual(t, { tier: 2, effortBoost: 0, why: 'trivial task, escalated once after a failure' })
  assert.deepEqual(requiredTier({ role: 'worker', taskClass: 'complex', attempt: 1 }), { tier: 3, effortBoost: 1, why: 'complex task, escalated once after a failure' })
  assert.equal(requiredTier({ role: 'worker', taskClass: 'complex', risk: 'high', attempt: 2 }).effortBoost, 3)
})

test('worker auto: cheapest capable per class, with explained reasons', () => {
  const light = ok(worker({ taskClass: 'trivial' }))
  assert.deepEqual(light.choice, { agent: 'claude', model: 'haiku', effort: 'low' })
  assert.equal(light.source, 'auto')
  const std = ok(worker())
  assert.deepEqual(std.choice, { agent: 'claude', model: 'sonnet', effort: 'medium' })
  assert.equal(std.reason, 'standard task → Claude Sonnet · medium: cheapest enabled Standard model (relative cost 2)')
  assert.deepEqual(std.skipped.map((s) => s.why), ['rated Light, task needs Standard', 'costs more (relative cost 4, not 2)'])
  assert.deepEqual(ok(worker({ taskClass: 'complex' })).choice, { agent: 'claude', model: 'opus', effort: 'high' })
  assert.deepEqual(ok(worker({ risk: 'high' })).choice, { agent: 'claude', model: 'opus', effort: 'medium' })
})

test('worker auto: escalation raises the tier, boosts effort at the top, and stops at the limit', () => {
  const up = ok(worker({ taskClass: 'trivial', attempt: 1 }))
  assert.equal(up.choice.model, 'sonnet')
  const top = ok(worker({ taskClass: 'complex', attempt: 1 }))
  assert.deepEqual(top.choice, { agent: 'claude', model: 'opus', effort: 'xhigh' })
  assert.match(top.reason, /^complex task, escalated once after a failure → Claude Opus · xhigh: /)
  assert.equal(bad(worker({ attempt: 2 })), 'Escalation limit reached (1): ask the user before trying again')
  assert.equal(ok(worker({ attempt: 2 }, S({ maxEscalations: 2 }))).requiredTier, 3)
  assert.match(bad(worker({ attempt: 1 }, S({ maxEscalations: 0 }))), /Escalation limit reached \(0\)/)
})

test('worker auto: unavailable agent, unavailable Codex model, Claude accepted unverified', () => {
  const cands: Candidate[] = [
    { agent: 'codex', model: 'gpt-6-luna', tier: 2, cost: 1, enabled: true },
    { agent: 'codex', model: 'gpt-9-ghost', tier: 2, cost: 1, enabled: true },
    { agent: 'claude', model: 'sonnet', tier: 2, cost: 3, enabled: true },
    { agent: 'claude', model: 'weird-model', tier: 2, cost: 1, enabled: true }
  ]
  const s = S({ candidates: cands })
  assert.equal(ok(worker({}, s)).choice.model, 'gpt-6-luna')
  const noCodex = ok(worker({}, s, { agents: ['claude'], models: { claude: null, codex: null } }))
  assert.deepEqual(noCodex.choice, { agent: 'claude', model: 'sonnet', effort: 'medium' })
  assert.deepEqual(noCodex.skipped.slice(0, 2).map((x) => x.why), ['codex not installed', 'codex not installed'])
  const noModel = ok(worker({}, s))
  assert.ok(noModel.skipped.some((x) => x.candidate === 'codex gpt-9-ghost' && x.why === "not in Codex's model list"))
  // Codex catalog unknown (null): accepted unverified; unknown agents list (null): not checked
  assert.equal(ok(worker({}, s, { agents: null, models: { claude: null, codex: null } })).choice.model, 'gpt-6-luna')
  assert.equal(ok(worker({}, S({ candidates: [cands[2]] }), { agents: null, models: {} })).choice.model, 'sonnet')
})

test('worker auto: nothing eligible is an error, never a premium fallback', () => {
  const s = S({ candidates: [{ agent: 'claude', model: 'haiku', tier: 1, cost: 1, enabled: true }, { agent: 'claude', model: 'opus', tier: 3, cost: 4, enabled: false }] })
  const e = bad(worker({ taskClass: 'complex' }, s))
  assert.match(e, /Strong/)
  assert.match(e, /Settings → Models/)
  assert.match(e, /--model/)
  assert.match(bad(worker({}, S({ candidates: [] }))), /Standard/)
})

test('tie-breaking is deterministic: cost, then lower tier, then list order', () => {
  const c = (model: string, tier: 1 | 2 | 3, cost: number): Candidate => ({ agent: 'claude', model, tier, cost, enabled: true })
  assert.equal(ok(worker({ taskClass: 'trivial' }, S({ candidates: [c('opus', 3, 2), c('sonnet', 2, 2), c('haiku', 1, 2)] }))).choice.model, 'haiku')
  assert.equal(ok(worker({}, S({ candidates: [c('opus', 3, 2), c('sonnet', 2, 2)] }))).choice.model, 'sonnet')
  const a = S({ candidates: [c('fable', 2, 2), c('sonnet', 2, 2)] })
  const b = S({ candidates: [c('sonnet', 2, 2), c('fable', 2, 2)] })
  assert.equal(ok(worker({}, a)).choice.model, 'fable')
  assert.equal(ok(worker({}, b)).choice.model, 'sonnet')
  assert.deepEqual(worker({}, a), worker({}, a))
})

test('effort: pinned, boosted, clamped to what the model supports', () => {
  const s = S({ candidates: [{ agent: 'codex', model: 'gpt-6-luna', effort: 'high', tier: 3, cost: 1, enabled: true }] })
  assert.equal(ok(worker({ taskClass: 'trivial' }, s)).choice.effort, 'high')
  // boost 1 would give xhigh; gpt-6-luna takes up to high → clamped down
  const boosted = ok(worker({ taskClass: 'complex', attempt: 1 }, s))
  assert.equal(boosted.choice.effort, 'high')
  const sol = S({ candidates: [{ agent: 'codex', model: 'gpt-6.2-sol', effort: 'max', tier: 3, cost: 1, enabled: true }] })
  assert.equal(ok(worker({ taskClass: 'complex', attempt: 1 }, sol)).choice.effort, 'max')
  const odd = { agents: ['codex'], models: { codex: [{ id: 'm', efforts: ['xhigh' as const, 'max' as const] }] } }
  const onlyHigh = S({ candidates: [{ agent: 'codex', model: 'm', tier: 3, cost: 1, enabled: true }] })
  assert.equal(ok(worker({ taskClass: 'trivial' }, onlyHigh, odd)).choice.effort, 'xhigh')
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
})

test('worker fixed mode uses the worker pick; null is the provider default', () => {
  const fixed = S({ workerMode: 'fixed', worker: { agent: 'claude', model: 'haiku', effort: 'low' } })
  const d = ok(worker({ taskClass: 'complex' }, fixed))
  assert.deepEqual([d.choice, d.source], [{ agent: 'claude', model: 'haiku', effort: 'low' }, 'fixed'])
  assert.deepEqual(ok(worker({}, S({ workerMode: 'fixed' }))).choice, { agent: 'claude' })
  // fixed mode never escalates by itself
  assert.equal(ok(worker({ attempt: 5 }, fixed)).source, 'fixed')
})

test('overrides win over role and auto, and invalid ones are refused, not substituted', () => {
  const set = S({ lead: { agent: 'claude', model: 'opus' } })
  const o = ok(route(set, { role: 'lead', model: 'haiku', effort: 'low' }, AVAIL))
  assert.deepEqual([o.choice, o.source], [{ agent: 'claude', model: 'haiku', effort: 'low' }, 'override'])
  assert.equal(ok(worker({ taskClass: 'trivial', model: 'opus' })).choice.model, 'opus')
  assert.deepEqual(ok(worker({ model: 'claude-sonnet-4-5' })).choice, { agent: 'claude', model: 'claude-sonnet-4-5' })
  assert.deepEqual(ok(worker({ model: 'gpt-6-luna' })).choice, { agent: 'codex', model: 'gpt-6-luna' })
  assert.match(bad(worker({ model: 'mystery' })), /pass --agent/)
  assert.match(bad(worker({ agent: 'codex', model: 'gpt-9-ghost' })), /not in Codex's model list/)
  assert.match(bad(worker({ agent: 'claude', model: 'gpt-6-luna' })), /not a Claude model name/)
  assert.match(bad(worker({ model: 'haiku' }, S(), { agents: ['codex'], models: {} })), /claude not installed/)
  assert.match(bad(worker({ agent: 'codex', model: 'gpt-6-luna', effort: 'max' })), /does not support effort max/)
  assert.match(bad(worker({ agent: 'cursor' })), /cursor not installed/)
})

test('agent-only override restricts auto candidates; effort-only keeps the routing', () => {
  const s = S({ candidates: [...DEFAULT_ROUTING.candidates, { agent: 'codex', model: 'gpt-6-luna', tier: 2, cost: 1, enabled: true }] })
  assert.equal(ok(worker({ agent: 'claude' }, s)).choice.model, 'sonnet')
  assert.equal(ok(worker({}, s)).choice.model, 'gpt-6-luna')
  assert.equal(ok(worker({ agent: 'codex', taskClass: 'trivial' }, s)).source, 'auto')
  assert.match(bad(worker({ agent: 'codex', taskClass: 'complex' }, s)), /Strong/)
  const e = ok(worker({ effort: 'high' }))
  assert.deepEqual(e.choice, { agent: 'claude', model: 'sonnet', effort: 'high' })
  assert.equal(e.source, 'auto')
  assert.match(bad(worker({ effort: 'max' }, S({ candidates: [{ agent: 'codex', model: 'gpt-6-luna', tier: 2, cost: 1, enabled: true }] }))), /does not support effort max/)
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
