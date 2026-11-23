// Analytics aggregation over one fixture set: every row type (kind, escalated, fallback, type,
// lead, other, unrouted), partial coverage, Unattributed, Unknown model, no price, retries, a
// handover, a comparable and an incomparable pair; and every level adds up.
import { assert, test } from 'orca/testing'
import {
  activity, analyticsView, analyticsWindow, buildModel, usageSummary, workstreamView, zeroSpend, addSpend,
  type AnalyticsInputs, type AnalyticsModel
} from './analytics.ts'
import { estimate, priceFor, priceKey, PRICES } from './prices.ts'
import { normalizeRouting } from './routing.ts'
import type { DispatchLink, LinkRecord, RouteLine } from './usage-links.ts'
import type { Usage } from './usage-store.ts'
import type { Spend } from './protocol.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-11-23T12:00:00.000Z')
const ago = (h: number) => NOW - h * HOUR
const iso = (t: number) => new Date(t).toISOString()
const close = (a: number, b: number, what = '') => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} ≠ ${b}`)

const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5', GPT = 'gpt-6.2-astra'

// ---------- fixture builders ----------

const links: LinkRecord[] = []
const routes: RouteLine[] = []
const usage: Usage[] = []
let seq = 0

type D = {
  id: string; ws: string; parent?: string; role: 'lead' | 'worker'; start: number; end?: number; outcome?: 'accepted' | 'failed' | null
  sessions?: string[]; kind?: string; type?: string; risk?: string; context?: string; attempt?: number; retryOf?: string
  source?: string; choice?: { agent: string; model?: string; effort?: string }; arm?: 'baseline' | 'variant'; pair?: string; noRoute?: boolean
}
function dispatch(d: D) {
  const workspace = `repo::/w/${d.ws}`
  const sessions = d.sessions ?? [`s-${d.id}`]
  for (const [i, s] of sessions.entries()) {
    const rec: DispatchLink = {
      type: 'dispatch', at: iso(d.start + i * 60_000), paneKey: `pane-${d.id}`, providerSession: { provider: 'claude', id: s }, dispatchId: d.id,
      taskId: `task-${d.retryOf ?? d.id}`, runId: `run-${d.ws}`, parentDispatchId: d.parent ?? null, retryOf: d.retryOf ?? null,
      role: d.noRoute ? null : d.role, workspace, kind: d.noRoute ? null : d.kind ?? null, taskType: d.type ?? null, risk: d.risk ?? null,
      context: d.context ?? null, attempt: d.attempt ?? 0, model: d.choice ? { agent: d.choice.agent, model: d.choice.model ?? null, effort: d.choice.effort ?? null } : null,
      arm: d.arm ?? null, pair: d.pair ?? null, dispatchedAt: iso(d.start), completedAt: null, outcome: null
    }
    links.push(rec)
  }
  // The completion, seen by a later sample (the pane's session carried forward).
  if (d.end != null) links.push({ ...(links[links.length - 1] as DispatchLink), at: iso(d.end), completedAt: iso(d.end), outcome: d.outcome ?? null })
  if (!d.noRoute) routes.push({
    at: iso(d.start), role: d.role, taskId: `task-${d.id}`, dispatchId: d.id, workspace, choice: d.choice ?? { agent: 'claude' },
    source: d.source ?? (d.role === 'lead' ? 'default' : d.type ? 'type' : 'kind'), type: d.type ?? null, kind: d.kind ?? (d.role === 'lead' ? 'normal' : null),
    risk: d.risk ?? null, context: d.context ?? null, attempt: d.attempt ?? 0, ...(d.retryOf ? { retryOf: d.retryOf } : {}), ...(d.arm ? { arm: d.arm, pair: d.pair } : {})
  })
}
/** One response at `t` on `session`: input, cache read, cache write 5m, cache write 1h, output. */
function use(session: string, t: number, model: string, [i, r, w5, w1, o]: number[], provider: 'claude' | 'codex' = 'claude') {
  usage.push({ provider, session, id: `m${++seq}`, model, start: t - 30_000, end: t, in: i, cacheRead: r, cacheWrite5m: w5, cacheWrite1h: w1, out: o })
}

const routing = normalizeRouting({
  types: [{ id: 'browser-checks', name: 'Browser checks', description: 'Click through pages', route: { model: { agent: 'codex', model: GPT, effort: 'medium' }, fallback: { agent: 'claude', model: 'sonnet', effort: 'medium' } } }]
})

// perm (variant of pair p1, today): lead with a handover, five workers, a failed one retried one row up.
dispatch({ id: 'L', ws: 'perm', role: 'lead', start: ago(6), end: ago(1), outcome: 'accepted', sessions: ['sLa', 'sLb'], arm: 'variant', pair: 'p1' })
use('sLa', ago(5.9), OPUS, [1000, 2_000_000, 0, 100_000, 20_000])
use('sLb', ago(1.2), OPUS, [500, 800_000, 0, 50_000, 8_000])
dispatch({ id: 'W1', ws: 'perm', parent: 'L', role: 'worker', start: ago(5.5), end: ago(5), outcome: 'accepted', kind: 'normal', risk: 'high', choice: { agent: 'claude', model: 'opus', effort: 'high' } })
use('s-W1', ago(5.2), OPUS, [2000, 1_500_000, 0, 140_000, 27_000])
dispatch({ id: 'W2', ws: 'perm', parent: 'L', role: 'worker', start: ago(5.5), end: ago(5.1), outcome: 'failed', kind: 'normal', choice: { agent: 'claude', model: 'sonnet', effort: 'medium' } })
use('s-W2', ago(5.2), SONNET, [1500, 1_200_000, 98_000, 0, 24_000])
dispatch({ id: 'W2r', ws: 'perm', parent: 'L', role: 'worker', start: ago(5), end: ago(4.5), outcome: 'accepted', kind: 'normal', attempt: 1, retryOf: 'W2', choice: { agent: 'claude', model: 'opus', effort: 'high' } })
use('s-W2r', ago(4.7), OPUS, [900, 640_000, 61_000, 0, 13_800])
dispatch({ id: 'W3', ws: 'perm', parent: 'L', role: 'worker', start: ago(4), end: ago(3.8), outcome: 'accepted', kind: 'simple', source: 'fallback', choice: { agent: 'claude', model: 'sonnet', effort: 'low' } })
use('s-W3', ago(3.9), SONNET, [400, 180_000, 21_000, 0, 2600])
dispatch({ id: 'W4', ws: 'perm', parent: 'L', role: 'worker', start: ago(4), end: ago(3.5), outcome: 'accepted', type: 'browser-checks', choice: { agent: 'codex', model: GPT, effort: 'medium' } })
use('s-W4', ago(3.6), GPT, [182_000, 1_020_000, 0, 0, 21_000])
// started by hand: no routes.jsonl line, and its log named no model
dispatch({ id: 'W5', ws: 'perm', parent: 'L', role: 'worker', start: ago(3), end: ago(2.5), outcome: 'accepted', noRoute: true })
use('s-W5', ago(2.8), 'codex', [5000, 10_000, 0, 0, 1000])
// an explicit --model
dispatch({ id: 'W6', ws: 'perm', parent: 'L', role: 'worker', start: ago(3), end: ago(2), outcome: 'accepted', kind: 'simple', source: 'override', choice: { agent: 'claude', model: 'haiku' } })
use('s-W6', ago(2.2), HAIKU, [3000, 180_000, 22_000, 0, 3200])
links.push({ type: 'handover', at: iso(ago(2)), from: { provider: 'claude', id: 'sLa' }, to: { provider: 'claude', id: 'sLb' } })

// p1 baseline: the lead alone, three runs, one failed.
for (const [i, [h, outcome, out]] of ([[100, 'accepted', 80_000], [80, 'failed', 74_000], [60, 'accepted', 88_000]] as const).entries()) {
  dispatch({ id: `B${i}`, ws: `perm-b${i}`, role: 'lead', start: ago(h), end: ago(h - 2), outcome, arm: 'baseline', pair: 'p1' })
  use(`s-B${i}`, ago(h - 1), OPUS, [2500, 6_500_000, 0, 500_000, out])
}

// p2: the models changed between the arms (lead Opus vs lead Sonnet).
dispatch({ id: 'C0', ws: 'cmp-b', role: 'lead', start: ago(50), end: ago(48), outcome: 'accepted', arm: 'baseline', pair: 'p2', choice: { agent: 'claude', model: 'opus', effort: 'high' } })
use('s-C0', ago(49), OPUS, [1000, 1_000_000, 0, 0, 10_000])
dispatch({ id: 'C1', ws: 'cmp-v', role: 'lead', start: ago(40), end: ago(38), outcome: 'accepted', arm: 'variant', pair: 'p2', choice: { agent: 'claude', model: 'sonnet', effort: 'medium' } })
use('s-C1', ago(39), SONNET, [1000, 1_000_000, 0, 0, 10_000])
// p3: only a baseline run so far.
dispatch({ id: 'P3', ws: 'only-base', role: 'lead', start: ago(30), end: ago(29), outcome: 'accepted', arm: 'baseline', pair: 'p3' })
use('s-P3', ago(29.5), OPUS, [100, 100_000, 0, 0, 1000])

// billing: 9 days long, finished yesterday; its logs were read only for the last two days of it.
dispatch({ id: 'BL', ws: 'billing', role: 'lead', start: ago(9 * 24), end: ago(24), outcome: 'accepted', choice: { agent: 'claude', model: 'sonnet', effort: 'medium' } })
use('s-BL', ago(8 * 24), SONNET, [700, 880_000, 0, 70_000, 12_000]) // outside the 7 days: whole run only
use('s-BL', ago(30), SONNET, [400, 420_000, 0, 38_000, 7000])
dispatch({ id: 'BW', ws: 'billing', parent: 'BL', role: 'worker', start: ago(3 * 24), end: ago(26), outcome: null, kind: 'normal', context: 'large', choice: { agent: 'claude', model: 'sonnet', effort: 'medium' } })
use('s-BW', ago(27), SONNET, [1000, 1_300_000, 0, 120_000, 22_000])

// old: finished 20 days ago (in 30 days, not in 7).
dispatch({ id: 'OL', ws: 'old', role: 'lead', start: ago(20 * 24 + 3), end: ago(20 * 24), outcome: 'accepted' })
use('s-OL', ago(20 * 24 + 1), OPUS, [2900, 7_800_000, 0, 600_000, 96_000])

// running now: a lead and its worker.
dispatch({ id: 'RL', ws: 'live', role: 'lead', start: ago(2) })
use('s-RL', ago(1), OPUS, [900, 1_420_000, 0, 140_000, 17_000])
dispatch({ id: 'RW', ws: 'live', parent: 'RL', role: 'worker', start: ago(1.5), kind: 'hard', choice: { agent: 'claude', model: 'opus', effort: 'high' } })
use('s-RW', ago(0.5), OPUS, [1400, 2_100_000, 0, 190_000, 46_000])

// Unattributed: a plain terminal session.
use('term-1', ago(3), OPUS, [400, 520_000, 0, 61_000, 9000])
use('term-1', ago(10 * 24), OPUS, [300, 380_000, 0, 40_000, 6000])

/**
 * Coverage as the store keeps it, per session: logs read for the whole of each dispatch (a minute in
 * from either end), the plain terminal's from its records; billing's only for its last two days.
 */
function coverageOf(us: Usage[]) {
  const c = new Map<string, [number, number]>()
  const widen = (k: string, a: number, b: number) => { const s = c.get(k); c.set(k, s ? [Math.min(s[0], a), Math.max(s[1], b)] : [a, b]) }
  const last = new Map<string, DispatchLink>()
  for (const l of links) if (l.type === 'dispatch') last.set(l.dispatchId, l)
  for (const l of links) if (l.type === 'dispatch' && l.providerSession) {
    const d = last.get(l.dispatchId)!
    widen(`claude/${l.providerSession.id}`, Date.parse(d.dispatchedAt!) + 60_000, (d.completedAt ? Date.parse(d.completedAt) : NOW) - 60_000)
  }
  for (const u of us) if (u.session === 'term-1') widen(`${u.provider}/${u.session}`, u.start, u.end)
  c.set('claude/s-BL', [ago(48), ago(24)])
  c.set('claude/s-BW', [ago(48), ago(26)])
  return c
}

const inputs: AnalyticsInputs = { now: NOW, usage, coverage: coverageOf(usage), links, routes, routing }
const model: AnalyticsModel = buildModel(inputs)
const view7 = analyticsView(model, '7d')
const view30 = analyticsView(model, '30d')
const viewAll = analyticsView(model, 'all')

const sum = (ss: Spend[]) => ss.reduce((a, b) => addSpend(a, b), zeroSpend())
const spendEq = (a: Spend, b: Spend, what: string) => {
  for (const k of ['in', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'out', 'total', 'cost', 'unpriced'] as const) close(a[k], b[k], `${what} ${k}`)
}
const row = (v: typeof view7, id: string) => v.rows.find((r) => r.id === id)!

// ---------- prices ----------

test('prices: Anthropic ids normalised, every other model has no estimate, Haiku priced by prompt size', () => {
  assert.equal(priceKey('claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(priceKey('claude-sonnet-4-6-20260101'), 'claude-sonnet-4-6')
  assert.equal(priceKey('us.anthropic.claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(priceKey('claude-opus-5-5[1m]'), 'claude-opus-5-5')
  for (const m of ['gpt-6.2-astra', 'gpt-6-astra', 'codex', '', null, 'claude-sonnet-4-5-20250929']) assert.equal(priceKey(m), null, String(m))
  // §7: in × in + read × read + write5m × 1.25 in + write1h × 2 in + out × out
  const one = { in: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, out: 1_000_000 }
  close(estimate(OPUS, one)!, 4 + 0.2 + 5 + 8 + 20, 'opus')
  close(estimate('claude-fable-5-2', one)!, 8 + 0.2 + 10 + 16 + 40, 'fable')
  assert.equal(estimate(GPT, one), null)
  const small = { in: 50_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, out: 1000 }
  close(priceFor(HAIKU, small)!.in, 0.1, 'haiku short')
  close(priceFor(HAIKU, { ...small, cacheRead: 60_000 })!.in, 0.5, 'haiku long')
  assert.equal(PRICES.version, 'v1')
})

// ---------- rows ----------

test('by task kind: one row per Settings → Models row and Lead, other and unrouted only when used', () => {
  assert.deepEqual(view7.rows.map((r) => r.id), ['simple', 'normal', 'hard', 'browser-checks', 'lead', 'other', 'unrouted'])
  assert.equal(row(view7, 'normal').model, 'Claude Sonnet · medium')
  assert.equal(row(view7, 'normal').fallback, 'Claude Opus · medium')
  assert.equal(row(view7, 'lead').model, 'provider default')
  assert.equal(row(view7, 'browser-checks').model, 'Codex gpt-6.2-astra · medium')
})

test('a task counts on the row it ran on: high risk one up, a retry one more, large context at least normal', () => {
  const hard = row(view7, 'hard')
  assert.deepEqual(hard.tasks.map((t) => t.dispatchId).sort(), ['W1', 'W2r'])
  assert.equal(hard.tasks.find((t) => t.dispatchId === 'W1')!.dispatchedAs, 'normal, high risk')
  assert.equal(hard.tasks.find((t) => t.dispatchId === 'W2r')!.dispatchedAs, 'normal, retry 1')
  assert.equal(hard.running, 1, 'the live worker')
  assert.equal(hard.retries, 1)
  // n < 3: few tasks, no medians
  assert.equal(hard.few, true)
  assert.equal(hard.medianTokens, null)
  const normal = row(view7, 'normal')
  assert.deepEqual(normal.tasks.map((t) => t.dispatchId).sort(), ['BW', 'W2'])
  assert.equal(normal.tasks.find((t) => t.dispatchId === 'BW')!.dispatchedAs, 'normal, large context')
  assert.equal(normal.failed, 1)
  assert.equal(normal.retried, 1)
  close(normal.failedOrRetried!, 0.5, 'failed or retried')
  assert.equal(normal.tasks.find((t) => t.dispatchId === 'BW')!.result, 'unknown', 'an unknown outcome is never accepted')
})

test('fallback ran, no price, explicit model and not routed', () => {
  const simple = row(view7, 'simple')
  assert.equal(simple.n, 1)
  assert.equal(simple.fallbackRan, 1)
  assert.equal(simple.fallback, 'Claude Sonnet · low')
  const browser = row(view7, 'browser-checks')
  assert.equal(browser.unpricedTasks, 1)
  const w4 = browser.tasks[0]
  assert.equal(w4.spend.cost, 0)
  assert.equal(w4.spend.unpriced, w4.spend.total)
  assert.deepEqual(row(view7, 'other').tasks.map((t) => [t.dispatchId, t.dispatchedAs]), [['W6', 'explicit model']])
  const unrouted = row(view7, 'unrouted')
  assert.deepEqual(unrouted.tasks.map((t) => [t.dispatchId, t.model]), [['W5', null]])
})

test('the Lead row: one task per finished lead, its own sessions only; medians once there are three', () => {
  const lead = row(view7, 'lead')
  assert.deepEqual(lead.tasks.map((t) => t.dispatchId).sort(), ['B0', 'B1', 'B2', 'BL', 'C0', 'C1', 'L', 'P3'])
  assert.equal(lead.few, false)
  const L = lead.tasks.find((t) => t.dispatchId === 'L')!
  // both lead sessions, none of the workers'
  const expected = sum(usage.filter((u) => u.session === 'sLa' || u.session === 'sLb').map((u) => buildSpend(u)))
  spendEq(L.spend, expected, 'lead L')
  assert.equal(lead.failed, 1, 'baseline run 1 failed')
  assert.ok(lead.medianTokens! > 0 && lead.medianCost! > 0 && lead.medianMs! > 0)
  assert.equal(row(view30, 'lead').n, 9, '+ the run 20 days ago')
})

// ---------- strip, window and totals ----------

function buildSpend(u: Usage): Spend {
  return analyticsView(buildModel({ ...inputs, usage: [u], links: [], routes: [] }), 'all').strip.tokens
}

test('the strip: window activity clipped, Unattributed and Unknown visible, cache share, model share, biggest, priciest', () => {
  const inWeek = usage.filter((u) => u.end >= NOW - 7 * DAY)
  spendEq(view7.strip.tokens, sum(inWeek.map(buildSpend)), '7d activity')
  spendEq(view7.strip.unattributed, buildSpend(usage.find((u) => u.session === 'term-1' && u.end > NOW - DAY)!), 'unattributed 7d')
  assert.equal(view7.strip.unknownModel, 16_000, 'W5 logged no model')
  assert.ok(view7.strip.models.some((m) => m.model === null && m.label === 'Unknown model'))
  close(view7.strip.models.reduce((a, m) => a + m.share, 0), 1, 'shares')
  const t = view7.strip.tokens
  close(view7.strip.cacheShare!, t.cacheRead / (t.in + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h), 'cache share')
  assert.equal(view7.strip.biggest!.id, 'L')
  assert.ok(view7.strip.tokens.unpriced >= 16_000 + 1_223_000, 'Codex and the model-less log have no price')
  assert.equal(view7.strip.priciest!.workstream.id, view7.rows.flatMap((r) => r.tasks).sort((a, b) => b.spend.cost - a.spend.cost)[0].workstream.id)
  assert.equal(view7.prices.tip, 'at API list prices · not your bill')
})

test('activity adds up: workstreams + Unattributed = the total, in every window; all = every record', () => {
  for (const w of ['7d', '30d', 'all'] as const) {
    const a = activity(model, w)
    spendEq(a.total, addSpend(sum([...a.byWorkstream.values()]), a.unattributed), `window ${w}`)
  }
  spendEq(viewAll.strip.tokens, sum(usage.map(buildSpend)), 'all records')
})

test('whole runs add up: every attributed record is in one dispatch, every dispatch in one row (or running), rows = workstreams', () => {
  const attributed = sum(model.attributed.map(({ u }) => buildSpend(u)))
  spendEq(sum([...model.workstreams.values()].map((w) => w.spend)), attributed, 'workstreams')
  const finishedTasks = sum(viewAll.rows.flatMap((r) => r.tasks.map((t) => t.spend)))
  const running = sum([...model.dispatches.values()].filter((d) => d.result === 'running').map((d) => d.spend))
  spendEq(addSpend(finishedTasks, running), attributed, 'rows + running')
  assert.equal(viewAll.rows.reduce((n, r) => n + r.n, 0), [...model.dispatches.values()].filter((d) => d.result !== 'running').length)
})

test('workstreams: whole-run totals, partial coverage, finished by last activity, running line', () => {
  const top = view7.workstreams.top
  assert.ok(top.length <= 5)
  assert.ok(top.every((w, i) => i === 0 || top[i - 1].spend.total >= w.spend.total), 'by whole-run tokens')
  const billing = model.workstreams.get('BL')!
  assert.equal(billing.dispatches.length, 2)
  assert.deepEqual(top.map((w) => w.id), ['L', 'B2', 'B0', 'B1', 'BL'])
  const b7 = top.find((w) => w.id === 'BL')!
  // per dispatch: the lead's 192 h with 24 h read, the worker's 46 h with 22 h read
  close(Math.round(billing.coverage * 1000) / 1000, 0.194, 'billing coverage')
  assert.equal(b7.partial, true)
  assert.equal(top.find((w) => w.id === 'B1')!.result, 'failed')
  // in the 7-day list at its whole run, but only its in-window part is 7-day activity
  const in7 = activity(model, '7d').byWorkstream.get('BL')!
  assert.ok(in7.total < billing.spend.total)
  assert.equal(b7.inWindow, in7.total)
  assert.equal(b7.spend.total, billing.spend.total)
  spendEq(billing.spend, sum(usage.filter((u) => u.session === 's-BL' || u.session === 's-BW').map(buildSpend)), 'billing whole run')
  const perm = model.workstreams.get('L')!
  assert.equal(perm.coverage, 1)
  // a worker whose session was never seen leaves its active time uncovered, whatever the lead's session spans
  const unseen = buildModel({ ...inputs, coverage: new Map([...inputs.coverage].filter(([k]) => k !== 'claude/s-W1')) }).workstreams.get('L')!
  assert.ok(unseen.coverage < 0.99 && unseen.coverage > 0.9, `unseen worker coverage ${unseen.coverage}`)
  assert.equal(view7.workstreams.running.count, 1)
  spendEq(view7.workstreams.running.spend, sum(usage.filter((u) => u.session === 's-RL' || u.session === 's-RW').map(buildSpend)), 'running')
  assert.equal(view7.workstreams.finished + 0, [...model.workstreams.values()].filter((w) => w.result !== 'running' && w.finishedAt! >= NOW - 7 * DAY).length)
  assert.ok(!view7.workstreams.top.some((w) => w.id === 'OL') && model.workstreams.get('OL')!.finishedAt! < NOW - 7 * DAY)
})

test('lead overhead: median lead share over finished workstreams with workers, three heaviest', () => {
  const o = view7.leadOverhead
  assert.equal(o.n, 2, 'perm and billing have workers; the lead-alone runs are left out')
  const perm = model.workstreams.get('L')!, billing = model.workstreams.get('BL')!
  const shares = [perm.lead!.spend.total / perm.spend.total, billing.lead!.spend.total / billing.spend.total]
  close(o.median!, (shares[0] + shares[1]) / 2, 'median')
  assert.deepEqual(o.heaviest.map((h) => h.id), shares[0] > shares[1] ? ['L', 'BL'] : ['BL', 'L'])
})

// ---------- comparisons ----------

test('a comparison: per accepted run, delta = variant − baseline, small sample said', () => {
  const p1 = view7.comparisons.find((c) => c.pair === 'p1')!
  assert.equal(p1.comparable, true)
  assert.deepEqual(p1.notes, ['small-sample'])
  assert.equal(p1.baseline.runs, 3)
  assert.equal(p1.baseline.accepted, 2)
  assert.equal(p1.baseline.failed, 1)
  const base = sum(['B0', 'B1', 'B2'].map((id) => model.dispatches.get(id)!.spend))
  close(p1.baseline.tokensPerAccepted!, base.total / 2, 'baseline per accepted run (failed run included)')
  const variant = model.workstreams.get('L')!
  close(p1.variant.tokensPerAccepted!, variant.spend.total, 'variant')
  assert.equal(p1.variant.costPerAccepted, null, 'the variant has unpriced tokens: no comparable estimate')
  close(p1.delta!.tokensPerAccepted!, variant.spend.total - base.total / 2, 'delta')
  assert.equal(p1.delta!.costPerAccepted, null)
  assert.equal(p1.delta!.passed, 1 - 2)
  close(p1.delta!.wallMs!, 5 * HOUR - 2 * HOUR, 'wall: variant 5 h, baseline 2 h')
  assert.equal(p1.runs.length, 4)
  assert.equal(view7.comparisons[0].pair, 'p1', 'comparable first')
})

test('incomparable pairs: model changed, or an arm missing, in one sentence', () => {
  const p2 = view7.comparisons.find((c) => c.pair === 'p2')!
  assert.equal(p2.comparable, false)
  assert.deepEqual(p2.why, ['models-differ'])
  assert.equal(p2.delta, null)
  assert.equal(p2.sentence, 'Not comparable: model changed.')
  const p3 = view7.comparisons.find((c) => c.pair === 'p3')!
  assert.deepEqual(p3.why, ['arm-missing'])
  assert.equal(p3.sentence, 'Not comparable: no finished variant run.')
})

// ---------- one workstream ----------

test('workstream detail: one row per lead session (handover linked), workers and retries; rows and models add up', () => {
  const w = workstreamView(model, 'L')!
  assert.equal(w.title, 'perm')
  assert.deepEqual(w.pair, { id: 'p1', arm: 'variant' })
  assert.deepEqual(w.rows.map((r) => r.who), ['lead', 'lead', 'worker', 'worker', 'worker', 'worker', 'worker', 'worker', 'retry'])
  assert.equal(w.rows[0].label, 'Lead')
  assert.equal(w.rows[0].continuedIn, 'claude:sLb')
  assert.equal(w.rows[1].label, 'Lead, after handover')
  const retry = w.rows.find((r) => r.who === 'retry')!
  assert.equal(retry.dispatchId, 'W2r')
  assert.equal(retry.rowName, 'Hard')
  spendEq(sum(w.rows.map((r) => r.spend)), w.spend, 'rows')
  spendEq(sum(w.byModel.map((m) => m.spend)), w.spend, 'models')
  assert.ok(w.byModel.some((m) => m.model === null))
  assert.equal(workstreamView(model, 'nope'), null)
  const billing = workstreamView(model, 'BL')!
  assert.equal(billing.partial, true)
})

test('a usage with no link is Unattributed; a session reused later attributes by dispatch start', () => {
  const m = buildModel({
    ...inputs,
    usage: [
      { provider: 'claude', session: 'x', id: 'a', model: OPUS, start: ago(10), end: ago(10), in: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, out: 1 },
      { provider: 'claude', session: 'x', id: 'b', model: OPUS, start: ago(1), end: ago(1), in: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, out: 1 }
    ],
    links: [{ ...(links.find((l) => l.type === 'dispatch' && l.dispatchId === 'RL') as DispatchLink), providerSession: { provider: 'claude', id: 'x' } }]
  })
  assert.equal(m.unattributed.length, 1, 'before the dispatch started')
  assert.equal(m.attributed.length, 1)
})

// ---------- sidebar ----------

test('sidebar line: last 7 days, tokens and estimate, unpriced kept apart', () => {
  const s = usageSummary(usage, NOW)
  close(s.tokens, view7.strip.tokens.total, 'tokens')
  close(s.cost, view7.strip.tokens.cost, 'cost')
  close(s.unpriced, view7.strip.tokens.unpriced, 'unpriced')
  assert.equal(s.days, 7)
  assert.equal(s.prices, 'prices v1, 2026-11-03')
  assert.equal(analyticsWindow('30d'), '30d')
  assert.equal(analyticsWindow('bogus'), '7d')
})
