// Analytics (docs/analytics-brief.md §3-§8): turns the usage store's observations, the link
// snapshots, routes.jsonl and the price table into exactly what the Usage view and the sidebar's
// usage line show. Pure: no IO, no clock; the worker reads the files and passes `now`.
//
// The model, built once per request burst (buildModel), then read per window (analyticsView) or per
// workstream (workstreamView):
// - Attribution: each observation goes to exactly one dispatch by its own provider session
//   (usage-links resolve), or to Unattributed. Nothing is counted twice: a worker's usage is on its
//   own dispatch and rolls up into its workstream, never into the lead's own figures.
// - Workstream: a lead dispatch and every dispatch below it (by parent). Dispatches with no lead
//   above them (a coordinator's direct workers) group by their Orca run and worktree.
// - Task: one dispatch. A retry is its own task (attempt n), on the row it ran on. A lead is a task
//   of the Lead row.
// - Row: the Settings → Models row a task RAN on, by src/routing.ts: its type's row, else its kind,
//   one up for high risk, at least normal for large context, one more per retry (rowFor). A task
//   with an explicit model, or a type no longer in Settings, counts on "other"; one with no
//   routes.jsonl line on "unrouted". Both rows show only when they have tasks.
// - Window (§5): activity totals are clipped to the window (the strip). Finished tasks and
//   workstreams are selected by their finish (last recorded activity) inside the window and
//   counted at their whole-run totals. A comparison lists a pair with a run finished in the window
//   or running, and counts every finished run of each arm.
// - Coverage (§5): the share of a workstream's active time (first dispatch → finish, or now) that
//   the read logs of its sessions span; under 100 % it is partial and its numbers are a floor.
// - Estimates (§7): per response at its model's list price; a model with no price adds to
//   `unpriced` and never to `cost`.
import type {
  AnalyticsTask, AnalyticsView, AnalyticsWindow, ArmStats, Comparison, KindRow, Spend, TaskResult, UsageSummaryWire, WorkstreamDetail, WorkstreamLine, WorkstreamRow
} from './protocol.ts'
import { ESTIMATE_LABEL, ESTIMATE_TIP, estimate, PRICES, type PriceTable } from './prices.ts'
import { choiceLabel, findType, rowFor, taskKind, TASK_KINDS, type ModelChoice, type RoutingSettings } from './routing.ts'
import { modelLabel } from './model-label.ts'
import { resolve, type DispatchLink, type LinkRecord, type RouteLine } from './usage-links.ts'
import type { Coverage, Usage } from './usage-store.ts'

const DAY = 86_400_000
export const WINDOW_MS: Record<AnalyticsWindow, number | null> = { '7d': 7 * DAY, '30d': 30 * DAY, all: null }
/** Under this many finished tasks a row gives no medians ("few tasks"). */
export const FEW = 3
/** Below this many runs per arm a comparison says "small sample". */
export const SMALL_SAMPLE = 3
/** A session's read span counts this much wider each side: agent start-up and the report after the last response. */
export const COVERAGE_SLACK_MS = 5 * 60_000
/** Coverage under this is "partial". */
const FULL = 0.995

export const analyticsWindow = (v: unknown): AnalyticsWindow => (v === '30d' || v === 'all' ? v : '7d')

// ---------- spend ----------

export const zeroSpend = (): Spend => ({ in: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, out: 0, total: 0, cost: 0, unpriced: 0 })

/** A log's model id, or null when it named none (Codex rollouts without a model are stored as "codex"). */
export const knownModel = (m: string | null | undefined): string | null =>
  typeof m === 'string' && m && m !== 'codex' && m !== 'unknown' && m !== '<synthetic>' ? m : null

export const usageTotal = (u: Pick<Usage, 'in' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h' | 'out'>) => u.in + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.out

function addUsage(s: Spend, u: Usage, prices: PriceTable): Spend {
  const t = usageTotal(u)
  s.in += u.in; s.cacheRead += u.cacheRead; s.cacheWrite5m += u.cacheWrite5m; s.cacheWrite1h += u.cacheWrite1h; s.out += u.out; s.total += t
  const c = estimate(knownModel(u.model), u, prices)
  if (c == null) s.unpriced += t
  else s.cost += c
  return s
}

export function addSpend(a: Spend, b: Spend): Spend {
  a.in += b.in; a.cacheRead += b.cacheRead; a.cacheWrite5m += b.cacheWrite5m; a.cacheWrite1h += b.cacheWrite1h; a.out += b.out
  a.total += b.total; a.cost += b.cost; a.unpriced += b.unpriced
  return a
}

const spendOf = (us: Usage[], prices: PriceTable) => us.reduce((s, u) => addUsage(s, u, prices), zeroSpend())
const sumSpend = (ss: Spend[]) => ss.reduce((a, b) => addSpend(a, b), zeroSpend())

export function median(xs: (number | null | undefined)[]): number | null {
  const a = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q)
  if (!a.length) return null
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

const ms = (v: string | number | null | undefined): number | null => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}
const maxOf = (xs: (number | null)[]) => { const a = xs.filter((x): x is number => x != null); return a.length ? Math.max(...a) : null }
const minOf = (xs: (number | null)[]) => { const a = xs.filter((x): x is number => x != null); return a.length ? Math.min(...a) : null }
const sessionKey = (provider: string, id: string) => `${provider}:${id}`

// ---------- the model ----------

export type AnalyticsInputs = {
  now: number
  /** The usage store's records (deduped), any order. */
  usage: Usage[]
  coverage: Coverage
  links: LinkRecord[]
  routes: RouteLine[]
  routing: RoutingSettings
  prices?: PriceTable
  /** Orca task titles by task id (the `--task-title` given at dispatch). Metadata, never chat or log content. */
  titles?: Record<string, string>
}

type RowKind = KindRow['kind']

export type Dispatch = {
  id: string
  /** The task's title; else the worktree's name; else the short dispatch id. */
  title: string
  link: DispatchLink
  route: RouteLine | null
  role: 'lead' | 'worker'
  parent: string | null
  workstream: string
  /** Its provider sessions ("claude:<id>"), in the order first linked. */
  sessions: string[]
  usage: Usage[]
  spend: Spend
  row: string
  rowName: string
  rowKind: RowKind
  dispatchedAs: string
  attempt: number
  retryOf: string | null
  retried: boolean
  fallback: boolean
  routed: string | null
  /** Per role and row, the model it was routed to (comparisons hold these fixed). */
  choiceKey: string
  choiceText: string
  model: string | null
  result: TaskResult
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  arm: 'baseline' | 'variant' | null
  pair: string | null
}

export type Workstream = {
  id: string
  title: string
  workspace: string | null
  runId: string | null
  lead: Dispatch | null
  dispatches: Dispatch[]
  result: TaskResult
  startedAt: number | null
  finishedAt: number | null
  wallMs: number | null
  coverage: number
  spend: Spend
  arm: 'baseline' | 'variant' | null
  pair: string | null
}

export type AnalyticsModel = {
  now: number
  prices: PriceTable
  routing: RoutingSettings
  dispatches: Map<string, Dispatch>
  workstreams: Map<string, Workstream>
  /** Every attributed observation with its dispatch, and the Unattributed ones. */
  attributed: { u: Usage; d: Dispatch }[]
  unattributed: Usage[]
  /** "provider:id" → the session that continued it (handover links). */
  continuedIn: Map<string, string>
}

/** The last routes.jsonl line per dispatch (a replayed start logs twice). */
function routesByDispatch(routes: RouteLine[]): Map<string, RouteLine> {
  const out = new Map<string, RouteLine>()
  for (const r of routes) if (r && typeof r.dispatchId === 'string' && r.dispatchId) out.set(r.dispatchId, r)
  return out
}

const KIND_NAMES: Record<string, string> = { simple: 'Simple', normal: 'Normal', hard: 'Hard' }

/** The row a dispatch ran on, and how it was dispatched, from its route line (or the link's copy of it). */
function rowOf(role: 'lead' | 'worker', link: DispatchLink, route: RouteLine | null, routing: RoutingSettings, attempt: number): { row: string; rowName: string; rowKind: RowKind; dispatchedAs: string } {
  if (role === 'lead') return { row: 'lead', rowName: 'Lead', rowKind: 'lead', dispatchedAs: attempt ? `lead, retry ${attempt}` : 'lead' }
  const retry = attempt ? `, retry ${attempt}` : ''
  const routed = !!route || !!link.kind || !!link.taskType
  if (!routed) return { row: 'unrouted', rowName: 'Not routed', rowKind: 'unrouted', dispatchedAs: 'not routed' }
  if (route?.source === 'override') return { row: 'other', rowName: 'Other', rowKind: 'other', dispatchedAs: `explicit model${retry}` }
  const typeName = (typeof route?.type === 'string' && route.type) || link.taskType
  if (typeName) {
    const t = findType(routing, typeName)
    if (!t) return { row: 'other', rowName: 'Other', rowKind: 'other', dispatchedAs: `${typeName} (type not in Settings)${retry}` }
    return { row: t.id, rowName: t.name, rowKind: 'type', dispatchedAs: `${t.name}${retry}` }
  }
  const asked = taskKind(route?.kind ?? route?.class ?? link.kind) ?? 'normal'
  const risk = (route?.risk ?? link.risk) === 'high' ? 'high' : undefined
  const context = (route?.context ?? link.context) === 'large' ? 'large' : undefined
  const at = rowFor({ role: 'worker', kind: asked, risk, context, attempt })
  const as = `${asked}${risk ? ', high risk' : ''}${context ? ', large context' : ''}${retry}`
  return { row: at.kind, rowName: KIND_NAMES[at.kind], rowKind: 'kind', dispatchedAs: as }
}

/** The routed choice as a link stored it (agent, requested model alias, effort). */
const linkChoice = (link: DispatchLink): ModelChoice | null =>
  link.model?.agent ? { agent: link.model.agent, ...(link.model.model ? { model: link.model.model, ...(link.model.effort ? { effort: link.model.effort as ModelChoice['effort'] } : {}) } : {}) } : null

const resultOf = (link: DispatchLink): TaskResult =>
  link.outcome === 'accepted' ? 'accepted' : link.outcome === 'failed' ? 'failed' : link.completedAt ? 'unknown' : 'running'

/** The worktree folder's name ("repo::/a/b/tree" → "tree"), else the fallback. */
function titleOf(workspace: string | null, fallback: string): string {
  const path = workspace?.includes('::') ? workspace.split('::').slice(1).join('::') : workspace
  const name = path?.split('/').filter(Boolean).pop()
  return name || fallback
}

/** "ctx_52c9d7f4887d" → "52c9d7f4": what a dispatch is called when nothing better is known. */
export const shortId = (id: string) => id.replace(/^[a-z]+_/, '').slice(0, 8)

/** Length of the union of [a, b] spans clipped to [from, to]. */
function covered(spans: [number, number][], from: number, to: number): number {
  const clipped = spans.map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0])
  let sum = 0, end = -Infinity
  for (const [a, b] of clipped) {
    if (b <= end) continue
    sum += b - Math.max(a, end)
    end = b
  }
  return sum
}

export function buildModel(inputs: AnalyticsInputs): AnalyticsModel {
  const { now, routing } = inputs
  const prices = inputs.prices ?? PRICES
  const routes = routesByDispatch(inputs.routes)

  // Dispatches: the last record of each, and every session any of its records named.
  const latest = new Map<string, DispatchLink>()
  const sessionsOf = new Map<string, string[]>()
  const continuedIn = new Map<string, string>()
  for (const r of inputs.links) {
    if (r?.type === 'handover') { continuedIn.set(sessionKey(r.from.provider, r.from.id), sessionKey(r.to.provider, r.to.id)); continue }
    if (r?.type !== 'dispatch' || !r.dispatchId) continue
    latest.set(r.dispatchId, r)
    if (r.providerSession) {
      const list = sessionsOf.get(r.dispatchId) ?? []
      const key = sessionKey(r.providerSession.provider, r.providerSession.id)
      if (!list.includes(key)) list.push(key)
      sessionsOf.set(r.dispatchId, list)
    }
  }
  const children = new Set<string>()
  for (const l of latest.values()) if (l.parentDispatchId && latest.has(l.parentDispatchId)) children.add(l.parentDispatchId)

  // Attribution: each observation to one dispatch or Unattributed.
  const resolved = resolve(inputs.usage.map((u) => ({ ...u, at: u.end })), inputs.links)
  const usageOf = new Map<string, Usage[]>()
  const unattributed: Usage[] = []
  const owner: [Usage, string][] = []
  resolved.forEach(({ to }, i) => {
    const u = inputs.usage[i]
    if (!to) { unattributed.push(u); return }
    const list = usageOf.get(to.dispatchId) ?? []
    list.push(u)
    usageOf.set(to.dispatchId, list)
    owner.push([u, to.dispatchId])
  })

  // Retries: an explicit retry-of, or a higher attempt for the same task.
  const retriedIds = new Set<string>()
  const attemptOf = (id: string) => { const r = routes.get(id), l = latest.get(id)!; return typeof r?.attempt === 'number' ? r.attempt : l.attempt ?? 0 }
  const maxAttempt = new Map<string, number>()
  for (const [id, l] of latest) {
    const retryOf = l.retryOf ?? (typeof routes.get(id)?.retryOf === 'string' ? routes.get(id)!.retryOf! : null)
    if (retryOf) retriedIds.add(retryOf)
    if (l.taskId) maxAttempt.set(l.taskId, Math.max(maxAttempt.get(l.taskId) ?? 0, attemptOf(id)))
  }

  const dispatches = new Map<string, Dispatch>()
  for (const [id, link] of latest) {
    const route = routes.get(id) ?? null
    const roleText = route?.role ?? link.role
    const role: 'lead' | 'worker' = roleText === 'lead' || roleText === 'coordinator' ? 'lead' : roleText === 'worker' ? 'worker' : !link.parentDispatchId && children.has(id) ? 'lead' : 'worker'
    const attempt = attemptOf(id)
    const usage = (usageOf.get(id) ?? []).sort((a, b) => a.end - b.end)
    const byModel = new Map<string, number>()
    for (const u of usage) { const m = knownModel(u.model); if (m) byModel.set(m, (byModel.get(m) ?? 0) + usageTotal(u)) }
    const model = [...byModel].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
    const r = rowOf(role, link, route, routing, attempt)
    const choice = linkChoice(link)
    const choiceText = choice ? (choice.model ? choiceLabel(choice) : `${choiceLabel(choice)}: ${model ? modelLabel(model) : 'unknown'}`) : model ? modelLabel(model) : 'unknown'
    const result = resultOf(link)
    const dispatchedAt = ms(link.dispatchedAt)
    const completedAt = ms(link.completedAt)
    const lastUse = usage.length ? usage[usage.length - 1].end : null
    const retryOf = link.retryOf ?? (typeof route?.retryOf === 'string' ? route.retryOf : null)
    const named = link.taskId ? inputs.titles?.[link.taskId]?.trim() : ''
    dispatches.set(id, {
      id, link, route, role,
      title: named || titleOf(link.workspace, shortId(id)),
      parent: link.parentDispatchId && latest.has(link.parentDispatchId) ? link.parentDispatchId : null,
      workstream: '',
      sessions: sessionsOf.get(id) ?? [],
      usage,
      spend: spendOf(usage, prices),
      ...r,
      attempt,
      retryOf,
      retried: retriedIds.has(id) || (!!link.taskId && (maxAttempt.get(link.taskId) ?? 0) > attempt),
      fallback: route?.source === 'fallback',
      routed: choice ? choiceLabel(choice) : null,
      choiceKey: `${role}:${r.row}`,
      choiceText,
      model,
      result,
      startedAt: dispatchedAt ?? (usage.length ? Math.min(usage[0].start, usage[0].end) : ms(link.at)),
      finishedAt: result === 'running' ? null : maxOf([completedAt, lastUse]) ?? ms(link.at),
      durationMs: dispatchedAt != null && completedAt != null ? Math.max(0, completedAt - dispatchedAt) : null,
      arm: link.arm ?? (route?.arm === 'baseline' || route?.arm === 'variant' ? route.arm : null),
      pair: link.pair ?? (typeof route?.pair === 'string' && route.pair ? route.pair : null)
    })
  }

  // Workstreams: up the parents to a lead; no lead above → the topmost dispatch's run and worktree.
  const rootOf = (d: Dispatch): Dispatch => {
    const seen = new Set<string>()
    let cur = d
    while (cur.role !== 'lead' && cur.parent && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = dispatches.get(cur.parent)!
    }
    return cur
  }
  const groups = new Map<string, { root: Dispatch; lead: Dispatch | null; members: Dispatch[] }>()
  for (const d of dispatches.values()) {
    const root = rootOf(d)
    const key = root.role === 'lead' ? root.id : root.link.runId ? `run:${root.link.runId}@${root.link.workspace ?? ''}` : `dispatch:${root.id}`
    const g = groups.get(key) ?? { root, lead: root.role === 'lead' ? root : null, members: [] }
    g.members.push(d)
    groups.set(key, g)
    d.workstream = key
  }

  const workstreams = new Map<string, Workstream>()
  for (const [id, g] of groups) {
    const members = g.members.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
    const finals = members.filter((d) => !d.retried)
    const result: TaskResult = g.lead
      ? g.lead.result
      : members.some((d) => d.result === 'running') ? 'running'
        : finals.some((d) => d.result === 'failed') ? 'failed'
          : finals.some((d) => d.result === 'unknown') ? 'unknown' : 'accepted'
    const startedAt = minOf(members.map((d) => d.startedAt))
    const finishedAt = result === 'running' ? null : maxOf(members.map((d) => d.finishedAt))
    const firstDispatch = minOf(members.map((d) => ms(d.link.dispatchedAt)))
    const lastCompleted = maxOf(members.map((d) => ms(d.link.completedAt)))
    const wallMs = finishedAt == null ? null : firstDispatch != null && lastCompleted != null ? Math.max(0, lastCompleted - firstDispatch) : startedAt != null ? finishedAt - startedAt : null
    // Coverage: per dispatch, the part of its active time (dispatch → completion, or now) that the read
    // spans of its own sessions cover (a little wider for start-up and the final report), summed over
    // its dispatches. A lead's long session never covers a worker whose session was not seen.
    let active = 0, seen = 0
    for (const d of members) {
      const from = d.startedAt ?? now
      const to = d.finishedAt ?? now
      if (!(to > from)) continue
      const spans: [number, number][] = []
      for (const s of d.sessions) {
        const span = inputs.coverage.get(s.replace(':', '/'))
        if (span) spans.push([span[0] - COVERAGE_SLACK_MS, span[1] + COVERAGE_SLACK_MS])
      }
      active += to - from
      seen += covered(spans, from, to)
    }
    const coverage = active > 0 ? Math.min(1, seen / active) : 1
    const armed = [g.root, ...members].find((d) => d.arm && d.pair)
    const workspace = g.root.link.workspace ?? members.find((d) => d.link.workspace)?.link.workspace ?? null
    workstreams.set(id, {
      id,
      title: (g.lead ?? g.root).title,
      workspace,
      runId: g.root.link.runId,
      lead: g.lead,
      dispatches: members,
      result,
      startedAt,
      finishedAt,
      wallMs,
      coverage,
      spend: sumSpend(members.map((d) => d.spend)),
      arm: armed?.arm ?? null,
      pair: armed?.pair ?? null
    })
  }

  return {
    now, prices, routing, dispatches, workstreams,
    attributed: owner.map(([u, id]) => ({ u, d: dispatches.get(id)! })),
    unattributed,
    continuedIn
  }
}

// ---------- reading the model ----------

const windowStart = (window: AnalyticsWindow, now: number) => { const w = WINDOW_MS[window]; return w == null ? -Infinity : now - w }
const inWindow = (t: number | null, from: number, now: number) => t != null && t >= from && t <= now

/** Activity in the window (clipped): the total, per workstream, and Unattributed. The parts add up to the total. */
export function activity(model: AnalyticsModel, window: AnalyticsWindow) {
  const from = windowStart(window, model.now)
  const total = zeroSpend(), unattributed = zeroSpend()
  const byWorkstream = new Map<string, Spend>()
  const byModel = new Map<string | null, number>()
  let unknownModel = 0
  const take = (u: Usage, into: Spend) => {
    addUsage(into, u, model.prices)
    addUsage(total, u, model.prices)
    const m = knownModel(u.model)
    byModel.set(m, (byModel.get(m) ?? 0) + usageTotal(u))
    if (!m) unknownModel += usageTotal(u)
  }
  for (const { u, d } of model.attributed) {
    if (u.end < from) continue
    let s = byWorkstream.get(d.workstream)
    if (!s) byWorkstream.set(d.workstream, (s = zeroSpend()))
    take(u, s)
  }
  for (const u of model.unattributed) if (u.end >= from) take(u, unattributed)
  return { total, unattributed, byWorkstream, byModel, unknownModel }
}

function taskOf(d: Dispatch, model: AnalyticsModel): AnalyticsTask {
  const w = model.workstreams.get(d.workstream)!
  return {
    dispatchId: d.id, taskId: d.link.taskId, title: d.title, workstream: { id: w.id, title: w.title }, role: d.role, row: d.row, dispatchedAs: d.dispatchedAs,
    attempt: d.attempt, retryOf: d.retryOf, retried: d.retried, fallback: d.fallback, routed: d.routed, model: d.model, result: d.result,
    startedAt: d.startedAt, finishedAt: d.finishedAt, durationMs: d.durationMs, spend: { ...d.spend }
  }
}

const fullyPriced = (s: Spend) => s.unpriced === 0
const mostCommon = (xs: (string | null)[]) => {
  const n = new Map<string, number>()
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
}

function kindRow(id: string, name: string, kind: RowKind, settings: { model: string | null; fallback: string | null }, done: Dispatch[], running: number, model: AnalyticsModel): KindRow {
  const n = done.length
  const few = n > 0 && n < FEW
  const priced = done.filter((d) => fullyPriced(d.spend))
  const failed = done.filter((d) => d.result === 'failed').length
  const retried = done.filter((d) => d.retried).length
  return {
    id, name, kind, model: settings.model, fallback: settings.fallback,
    loggedModel: mostCommon(done.map((d) => d.model)),
    n, running, few,
    medianTokens: n && !few ? median(done.map((d) => d.spend.total)) : null,
    medianCost: n && !few ? median(priced.map((d) => d.spend.cost)) : null,
    unpricedTasks: done.filter((d) => d.spend.unpriced > 0).length,
    failed, retried,
    failedOrRetried: n ? done.filter((d) => d.result === 'failed' || d.retried).length / n : null,
    medianMs: n && !few ? median(done.map((d) => d.durationMs)) : null,
    fallbackRan: done.filter((d) => d.fallback).length,
    retries: done.filter((d) => d.attempt > 0 || !!d.retryOf).length,
    tasks: done.map((d) => taskOf(d, model)).sort((a, b) => b.spend.total - a.spend.total || a.dispatchId.localeCompare(b.dispatchId))
  }
}

/** The rows "By task kind" shows, in Settings → Models order: kinds, types, Lead, then other and unrouted when used. */
function kindRows(model: AnalyticsModel, done: Dispatch[], running: Dispatch[]): KindRow[] {
  const r = model.routing
  const label = (c: ModelChoice | null | undefined) => (c ? choiceLabel(c) : null)
  const defs: { id: string; name: string; kind: RowKind; model: string | null; fallback: string | null }[] = [
    ...TASK_KINDS.map((k) => ({ id: k, name: KIND_NAMES[k], kind: 'kind' as const, model: label(r.workers[k]?.model), fallback: label(r.workers[k]?.fallback) })),
    ...r.types.map((t) => ({ id: t.id, name: t.name, kind: 'type' as const, model: label(t.route.model), fallback: label(t.route.fallback) })),
    { id: 'lead', name: 'Lead', kind: 'lead', model: r.lead ? choiceLabel(r.lead) : 'provider default', fallback: null },
    { id: 'other', name: 'Other', kind: 'other', model: 'explicit model, or a type not in Settings', fallback: null },
    { id: 'unrouted', name: 'Not routed', kind: 'unrouted', model: null, fallback: null }
  ]
  return defs
    .map((def) => kindRow(def.id, def.name, def.kind, def, done.filter((d) => d.row === def.id), running.filter((d) => d.row === def.id).length, model))
    .filter((row) => (row.kind !== 'other' && row.kind !== 'unrouted') || row.n > 0 || row.running > 0)
}

const line = (w: Workstream, inWindow: number): WorkstreamLine => ({ id: w.id, title: w.title, result: w.result, finishedAt: w.finishedAt, spend: { ...w.spend }, inWindow, coverage: w.coverage, partial: w.coverage < FULL })

function armStats(runs: Workstream[]): ArmStats {
  const done = runs.filter((w) => w.result !== 'running')
  const ok = done.filter((w) => w.result === 'accepted')
  const spend = sumSpend(done.map((w) => w.spend))
  return {
    runs: done.length,
    accepted: ok.length,
    failed: done.filter((w) => w.result === 'failed').length,
    running: runs.length - done.length,
    spend,
    tokensPerAccepted: ok.length ? spend.total / ok.length : null,
    // An arm with tokens that have no price has no comparable estimate.
    costPerAccepted: ok.length && spend.unpriced === 0 ? spend.cost / ok.length : null,
    medianWallMs: median(ok.map((w) => w.wallMs)),
    coverage: done.length ? Math.min(...done.map((w) => w.coverage)) : 1,
    models: [...new Set(done.flatMap((w) => w.dispatches.map((d) => `${d.role === 'lead' ? 'Lead' : d.rowName}: ${d.choiceText}`)))].sort()
  }
}

function comparison(pair: string, runs: Workstream[]): Comparison {
  const of = (arm: 'baseline' | 'variant') => runs.filter((w) => w.arm === arm)
  const baseline = armStats(of('baseline')), variant = armStats(of('variant'))
  const why: Comparison['why'] = []
  if (!baseline.runs || !variant.runs) why.push('arm-missing')
  // Models held fixed: per role and row, every finished run of both arms ran on the same routed choice.
  const choices = new Map<string, Set<string>>()
  for (const w of runs) if (w.result !== 'running') for (const d of w.dispatches) {
    const set = choices.get(d.choiceKey) ?? new Set<string>()
    set.add(d.choiceText)
    choices.set(d.choiceKey, set)
  }
  if ([...choices.values()].some((s) => s.size > 1)) why.push('models-differ')
  const notes: Comparison['notes'] = []
  if (!why.length && Math.min(baseline.runs, variant.runs) < SMALL_SAMPLE) notes.push('small-sample')
  if (!why.length && Math.min(baseline.coverage, variant.coverage) < FULL) notes.push('partial')
  const missing = !baseline.runs ? 'no finished baseline run' : 'no finished variant run'
  const sentence = why.length ? `Not comparable: ${why.map((w) => (w === 'models-differ' ? 'model changed' : missing)).join(', ')}.` : null
  const diff = (b: number | null, v: number | null) => (b == null || v == null ? null : v - b)
  return {
    pair, baseline, variant, comparable: !why.length, why, notes, sentence,
    delta: why.length ? null : {
      tokensPerAccepted: diff(baseline.tokensPerAccepted, variant.tokensPerAccepted),
      costPerAccepted: diff(baseline.costPerAccepted, variant.costPerAccepted),
      wallMs: diff(baseline.medianWallMs, variant.medianWallMs),
      passed: variant.accepted - baseline.accepted
    },
    runs: runs
      .filter((w) => w.arm)
      .sort((a, b) => (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity) || a.id.localeCompare(b.id))
      .map((w) => ({ workstream: w.id, title: w.title, arm: w.arm!, result: w.result, finishedAt: w.finishedAt, wallMs: w.wallMs, spend: { ...w.spend }, coverage: w.coverage }))
  }
}

const taskName = (d: Dispatch) => (d.role === 'lead' ? 'Lead' : d.attempt > 0 || d.retryOf ? `Retry · ${d.dispatchedAs}` : `Worker · ${d.dispatchedAs}`)

/** The Usage view for one window. */
export function analyticsView(model: AnalyticsModel, window: AnalyticsWindow, backfill: AnalyticsView['backfill'] = { state: 'pending', read: 0, total: 0 }): AnalyticsView {
  const now = model.now
  const from = windowStart(window, now)
  const act = activity(model, window)
  const all = [...model.dispatches.values()]
  const done = all.filter((d) => d.result !== 'running' && inWindow(d.finishedAt, from, now))
  const running = all.filter((d) => d.result === 'running')
  const wss = [...model.workstreams.values()]
  const finished = wss.filter((w) => w.result !== 'running' && inWindow(w.finishedAt, from, now)).sort((a, b) => b.spend.total - a.spend.total || a.id.localeCompare(b.id))
  const live = wss.filter((w) => w.result === 'running')

  const totalTokens = act.total.total
  const models = [...act.byModel]
    .filter(([, t]) => t > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([m, t]) => ({ model: m, label: m ? modelLabel(m) : 'Unknown model', tokens: t, share: totalTokens ? t / totalTokens : 0 }))
  const input = act.total.in + act.total.cacheRead + act.total.cacheWrite5m + act.total.cacheWrite1h
  const priciest = done.filter((d) => d.spend.cost > 0).sort((a, b) => b.spend.cost - a.spend.cost || a.id.localeCompare(b.id))[0]
  const pw = priciest && model.workstreams.get(priciest.workstream)!

  // Lead overhead: finished workstreams with a lead and at least one worker.
  const withWorkers = finished.filter((w) => w.lead && w.dispatches.length > 1 && w.spend.total > 0)
  const shares = withWorkers.map((w) => ({ id: w.id, title: w.title, leadTokens: w.lead!.spend.total, tokens: w.spend.total, share: w.lead!.spend.total / w.spend.total }))

  // Comparisons: pairs with a run finished in the window or running.
  const pairs = new Map<string, Workstream[]>()
  for (const w of wss) if (w.pair && w.arm) pairs.set(w.pair, [...(pairs.get(w.pair) ?? []), w])
  const comparisons = [...pairs]
    .filter(([, runs]) => runs.some((w) => w.result === 'running' || inWindow(w.finishedAt, from, now)))
    .map(([pair, runs]) => comparison(pair, runs))
    .sort((a, b) => Number(b.comparable) - Number(a.comparable) || (maxOf(b.runs.map((r) => r.finishedAt)) ?? 0) - (maxOf(a.runs.map((r) => r.finishedAt)) ?? 0) || a.pair.localeCompare(b.pair))

  return {
    now,
    window,
    from: Number.isFinite(from) ? from : null,
    prices: { version: model.prices.version, dated: model.prices.dated, label: ESTIMATE_LABEL, tip: ESTIMATE_TIP },
    strip: {
      tokens: act.total,
      unattributed: act.unattributed,
      unknownModel: act.unknownModel,
      biggest: finished[0] ? { id: finished[0].id, title: finished[0].title, tokens: finished[0].spend.total } : null,
      models,
      cacheShare: input ? act.total.cacheRead / input : null,
      priciest: priciest ? { dispatchId: priciest.id, name: taskName(priciest), workstream: { id: pw!.id, title: pw!.title }, cost: priciest.spend.cost } : null
    },
    rows: kindRows(model, done, running),
    leadOverhead: {
      median: median(shares.map((s) => s.share)),
      n: shares.length,
      heaviest: [...shares].sort((a, b) => b.share - a.share || a.id.localeCompare(b.id)).slice(0, 3)
    },
    comparisons,
    backfill,
    workstreams: { top: finished.slice(0, 5).map((w) => line(w, act.byWorkstream.get(w.id)?.total ?? 0)), finished: finished.length, running: { count: live.length, spend: sumSpend(live.map((w) => w.spend)) } }
  }
}

/** One workstream: lead sessions, workers and retries, each with its whole-run spend; null when unknown. */
export function workstreamView(model: AnalyticsModel, id: string): WorkstreamDetail | null {
  const w = model.workstreams.get(id)
  if (!w) return null
  const prices = model.prices
  const rows: WorkstreamRow[] = []
  const base = (d: Dispatch) => ({
    dispatchId: d.id, taskId: d.link.taskId, title: d.title, model: d.model,
    row: d.role === 'lead' ? null : d.row, rowName: d.role === 'lead' ? null : d.rowName, dispatchedAs: d.role === 'lead' ? null : d.dispatchedAs,
    fallback: d.fallback, result: d.result, durationMs: d.durationMs
  })
  if (w.lead) {
    const lead = w.lead
    // One row per lead session, by first activity; a later one continued the earlier (a handover or a new session in the pane).
    const bySession = new Map<string, Usage[]>()
    for (const u of lead.usage) { const k = sessionKey(u.provider, u.session); bySession.set(k, [...(bySession.get(k) ?? []), u]) }
    const sessions = [...new Set([...lead.sessions, ...bySession.keys()])]
      .sort((a, b) => (bySession.get(a)?.[0]?.end ?? Infinity) - (bySession.get(b)?.[0]?.end ?? Infinity) || a.localeCompare(b))
    if (!sessions.length) rows.push({ who: 'lead', label: 'Lead', session: null, continuedIn: null, ...base(lead), spend: zeroSpend() })
    sessions.forEach((s, i) => {
      const us = bySession.get(s) ?? []
      rows.push({
        who: 'lead', label: i === 0 ? 'Lead' : 'Lead, after handover', session: s,
        continuedIn: model.continuedIn.get(s) ?? sessions[i + 1] ?? null,
        ...base(lead), model: mostCommonModel(us) ?? lead.model, spend: spendOf(us, prices)
      })
    })
  }
  const order = { lead: 0, worker: 1, retry: 2 }
  const others = w.dispatches.filter((d) => d !== w.lead).map((d): WorkstreamRow => {
    const retry = d.attempt > 0 || !!d.retryOf
    return {
      who: d.role === 'lead' ? 'lead' : retry ? 'retry' : 'worker',
      label: d.role === 'lead' ? 'Lead' : retry ? `Retry ${d.attempt || ''} · ${d.rowName}`.replace('  ', ' ') : `${d.rowName} task`,
      session: d.sessions[0] ?? (d.usage[0] ? sessionKey(d.usage[0].provider, d.usage[0].session) : null),
      continuedIn: d.sessions[0] ? model.continuedIn.get(d.sessions[0]) ?? d.sessions[1] ?? null : null,
      ...base(d),
      spend: { ...d.spend }
    }
  }).sort((a, b) => order[a.who] - order[b.who])
  rows.push(...others)
  const byModel = new Map<string | null, Usage[]>()
  for (const d of w.dispatches) for (const u of d.usage) { const m = knownModel(u.model); byModel.set(m, [...(byModel.get(m) ?? []), u]) }
  return {
    id: w.id, title: w.title, workspace: w.workspace, runId: w.runId, result: w.result,
    startedAt: w.startedAt, finishedAt: w.finishedAt, wallMs: w.wallMs, coverage: w.coverage, partial: w.coverage < FULL,
    pair: w.pair && w.arm ? { id: w.pair, arm: w.arm } : null,
    spend: { ...w.spend },
    rows,
    byModel: [...byModel]
      .map(([m, us]) => ({ model: m, label: m ? modelLabel(m) : 'Unknown model', spend: spendOf(us, prices) }))
      .sort((a, b) => b.spend.total - a.spend.total || a.label.localeCompare(b.label))
  }
}

function mostCommonModel(us: Usage[]): string | null {
  const n = new Map<string, number>()
  for (const u of us) { const m = knownModel(u.model); if (m) n.set(m, (n.get(m) ?? 0) + usageTotal(u)) }
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
}

// ---------- the sidebar line ----------

export const SUMMARY_DAYS = 7

/** The sidebar's usage line: tokens and estimate of the last 7 days (records whose end is in it). */
export function usageSummary(usage: Usage[], now: number, prices: PriceTable = PRICES): UsageSummaryWire {
  const from = now - SUMMARY_DAYS * DAY
  const s = zeroSpend()
  for (const u of usage) if (u.end >= from && u.end <= now) addUsage(s, u, prices)
  return { days: SUMMARY_DAYS, tokens: s.total, cost: s.cost, unpriced: s.unpriced, prices: `prices ${prices.version}, ${prices.dated}`, tip: ESTIMATE_TIP }
}

