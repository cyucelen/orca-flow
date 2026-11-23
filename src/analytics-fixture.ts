// One realistic fixture for the Usage view: every row type, a handover, a comparable and an incomparable
// pair, partial coverage, Unattributed, no-price and unknown-model usage, running work. Used by the view's
// tests and by scripts/analytics-preview.mjs (screenshots outside Orca). Not part of the plugin at run time.
import { buildModel, type AnalyticsInputs } from './analytics.ts'
import { normalizeRouting } from './routing.ts'
import type { DispatchLink, LinkRecord, RouteLine } from './usage-links.ts'
import type { Usage } from './usage-store.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-11-23T12:00:00.000Z')
const ago = (h: number) => NOW - h * HOUR
const iso = (t: number) => new Date(t).toISOString()

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


/** Orca task titles of the fixture's tasks. */
export const FIXTURE_TITLES: Record<string, string> = {
  'task-L': 'Permission prompts: ask once per session',
  'task-W1': 'Escalate high-risk edits to Opus',
  'task-W2': 'Rewrite the settings migration',
  'task-W3': 'Rename the usage helpers',
  'task-W4': 'Click through the checkout in the browser',
  'task-W6': 'Fix the copy in the empty state',
  'task-BL': 'Billing: invoices page, export and filters',
  'task-BW': 'Billing: CSV export with large context',
  'task-OL': 'Migrate the old settings file',
  'task-RL': 'Analytics sidebar and Usage tab',
  'task-RW': 'Hard: rewrite the recording reader',
  'task-B0': 'Permissions baseline run 1', 'task-B1': 'Permissions baseline run 2', 'task-B2': 'Permissions baseline run 3'
}

export const FIXTURE_NOW = NOW

/** The fixture's analytics inputs; `titles` false leaves the tasks to be named by their worktrees. */
export function fixtureInputs(titles = true): AnalyticsInputs {
  return { now: NOW, usage, coverage: coverageOf(usage), links, routes, routing, ...(titles ? { titles: FIXTURE_TITLES } : {}) }
}
export const fixtureModel = (titles = true) => buildModel(fixtureInputs(titles))
