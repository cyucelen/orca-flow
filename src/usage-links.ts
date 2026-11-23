// Analytics attribution (docs/analytics-brief.md §4): which dispatch, task and workstream each usage
// observation belongs to. Pure functions plus small file IO; nothing here runs on its own, the worker
// wires it in.
//
// Why snapshots: src/transcripts.ts knows only the CURRENT provider session of a pane, and a pane is
// reused (a fresh TASK block, /clear, another agent). So while a dispatch is live its pane's binding
// is copied into ~/.orca-flow/usage/links.jsonl, one line per change, and attribution later reads
// that history instead of the pane.
//
// Sources, all read-only:
// - Pane → provider session: discoverTranscript (src/transcripts.ts), see paneBinding.
// - Dispatch → task, run, pane, parent, retry, dates: `orca orchestration worker-show --dispatch <id>
//   --json --full` (`dispatch`, `worker`, `projection` objects) or `dispatch-show --task <id> --json`
//   (snake_case `dispatch`); the concise worker-show has no pane, parent or retry. See dispatchInfo.
// - Outcome: Orca keeps the worker_done outcome in the message payload (`inbox --terminal run:<id>
//   --json --full` → messages[].payload {taskId, dispatchId, outcome: succeeded|failed}) and projects
//   it on the dispatch as worker-show --full `projection.outcome` / `worker.state` ("succeeded").
//   The dispatch row itself only says `status: completed`. Seen on this machine for succeeded
//   reports only (2026-11-23, 21 settled dispatches, none failed); the failed spelling is taken from
//   `orca orchestration send --help` (`--outcome <succeeded|failed>`). See outcomeOf.
// - Routing inputs and comparison arms: ~/.orca-flow/routes.jsonl (skills/orca-flow/scripts/dispatch.mjs).
//
// Only ids, timestamps, models and routing fields are read or stored: never a message subject or body.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverTranscript, transcriptFiles, type ProviderSession, type TranscriptFiles } from './transcripts.ts'
import { taskKind } from './routing.ts'

export const LINKS_FILE = join(homedir(), '.orca-flow', 'usage', 'links.jsonl')
export const ROUTES_FILE = join(homedir(), '.orca-flow', 'routes.jsonl')

/** A dispatch's result as its worker reported it: worker_done succeeded → accepted, failed → failed. Null while open or unknown. */
export type Outcome = 'accepted' | 'failed' | null
export type Arm = 'baseline' | 'variant'

/** What Orca says about one dispatch, normalised from worker-show --full or dispatch-show. */
export type DispatchInfo = {
  dispatchId: string
  taskId: string | null
  runId: string | null
  paneKey: string | null
  /** creator_dispatch_id: the lead (or coordinator dispatch) that started it. */
  parentDispatchId: string | null
  /** retry_of_dispatch_id. */
  retryOf: string | null
  workspace: string | null
  /** ISO 8601. */
  dispatchedAt: string | null
  completedAt: string | null
  outcome: Outcome
}

/** The routes.jsonl fields attribution uses (dispatch.mjs routeEntry). */
export type RouteLine = {
  at?: string; role?: string; taskId?: string | null; dispatchId?: string | null; workspace?: string | null
  choice?: { agent?: string; model?: string; effort?: string } | null
  /** routing.ts RouteDecision source: kind, type, fallback, role, override, default. */
  source?: string | null
  type?: string | null; kind?: string | null; class?: string | null; risk?: string | null; context?: string | null; attempt?: number
  retryOf?: string; arm?: Arm; pair?: string
}

/** One links.jsonl line: a dispatch as last seen, with the provider session its pane held. */
export type DispatchLink = {
  type: 'dispatch'
  at: string
  paneKey: string | null
  providerSession: ProviderSession | null
  dispatchId: string
  taskId: string | null
  runId: string | null
  parentDispatchId: string | null
  retryOf: string | null
  role: string | null
  workspace: string | null
  kind: string | null
  taskType: string | null
  risk: string | null
  context: string | null
  attempt: number | null
  /** The routed choice (requested alias, e.g. opus), not the model the log reports. */
  model: { agent: string | null; model: string | null; effort: string | null } | null
  arm: Arm | null
  pair: string | null
  dispatchedAt: string | null
  completedAt: string | null
  outcome: Outcome
}

/** A handover: `from` stopped and `to` continues its work. Usage is never moved between them. */
export type HandoverLink = { type: 'handover'; at: string; from: ProviderSession; to: ProviderSession }
export type LinkRecord = DispatchLink | HandoverLink

// ---------- normalising Orca's answers ----------

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Orca's timestamps: ISO, or SQLite's "YYYY-MM-DD HH:MM:SS" in UTC. ISO 8601 out, null for anything else. */
export function isoTime(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** worker_done's `--outcome`, in any of the places Orca shows it, as accepted/failed. */
export function outcomeOf(v: unknown): Outcome {
  return v === 'succeeded' ? 'accepted' : v === 'failed' ? 'failed' : null
}

/**
 * The dispatchId → worker_done outcome from an inbox answer (`inbox --json --full`): type and
 * payload only, never subject or body. A later report for the same dispatch wins.
 */
export function workerDoneOutcomes(inbox: any): Map<string, Outcome> {
  const out = new Map<string, Outcome>()
  const messages = Array.isArray(inbox?.messages) ? inbox.messages : Array.isArray(inbox) ? inbox : []
  const sorted = [...messages].sort((a, b) => (Number(a?.sequence) || 0) - (Number(b?.sequence) || 0))
  for (const m of sorted) {
    if (m?.type !== 'worker_done') continue
    let p = m.payload
    if (typeof p === 'string') { try { p = JSON.parse(p) } catch { p = null } }
    const id = str(p?.dispatchId), outcome = outcomeOf(p?.outcome)
    if (id && outcome) out.set(id, outcome)
  }
  return out
}

/**
 * One dispatch from `worker-show --dispatch <id> --json --full` (its `result`), the concise
 * worker-show, or `dispatch-show --json` (snake_case `dispatch`). `reported` is the worker_done
 * outcome from the inbox when known; it wins over Orca's projection of it.
 */
export function dispatchInfo(show: any, reported: Outcome = null): DispatchInfo | null {
  if (!show || typeof show !== 'object') return null
  const d = show.dispatch && typeof show.dispatch === 'object' ? show.dispatch : show
  const pick = (...keys: string[]) => { for (const k of keys) { const v = str(d[k]); if (v) return v } return null }
  const dispatchId = pick('id', 'dispatchId') ?? str(show.dispatchId)
  if (!dispatchId) return null
  const status = pick('status')
  const projected = outcomeOf(show.projection?.outcome) ?? outcomeOf(show.worker?.state) ?? outcomeOf(show.state)
  // A dispatch Orca failed without a report (circuit breaker, lost) counts as failed.
  const outcome = reported ?? projected ?? (status === 'failed' || status === 'circuit_broken' ? 'failed' : null)
  return {
    dispatchId,
    taskId: pick('taskId', 'task_id') ?? str(show.taskId),
    runId: pick('runId', 'run_id') ?? str(show.runId),
    paneKey: pick('assigneePaneKey', 'assignee_pane_key'),
    parentDispatchId: pick('creatorDispatchId', 'creator_dispatch_id'),
    retryOf: pick('retryOfDispatchId', 'retry_of_dispatch_id'),
    workspace: str(show.worker?.worktreeId) ?? str(show.projection?.workspace?.id) ?? str(show.workspace),
    dispatchedAt: isoTime(d.dispatchedAt ?? d.dispatched_at ?? d.createdAt ?? d.created_at),
    completedAt: isoTime(d.completedAt ?? d.completed_at),
    outcome
  }
}

/** The provider session a pane is bound to now (src/transcripts.ts, read-only), or null. */
export function paneBinding(paneKey: string, files: TranscriptFiles = transcriptFiles): ProviderSession | null {
  const found = discoverTranscript(paneKey, files)
  return found.path ? found.source?.providerSession ?? null : null
}

// ---------- snapshots ----------

export type SnapshotInputs = {
  /** ISO time of this sample. */
  at: string
  dispatches: DispatchInfo[]
  /** paneKey → its provider session now (paneBinding), null when unbound. Missing panes count as unknown. */
  bindings: Record<string, ProviderSession | null>
  routes: RouteLine[]
  /** Every record already in links.jsonl. */
  previous: LinkRecord[]
  handovers?: { from: ProviderSession; to: ProviderSession }[]
}

const sameSession = (a: ProviderSession | null | undefined, b: ProviderSession | null | undefined) =>
  !!a && !!b && a.provider === b.provider && a.id === b.id
const sessionKey = (s: ProviderSession) => `${s.provider}:${s.id}`
const linkKey = (r: LinkRecord) => r.type === 'dispatch' ? `d|${r.dispatchId}` : `h|${sessionKey(r.from)}|${sessionKey(r.to)}`
/** A record without its sample time: two records that differ only in `at` are the same. */
const content = (r: LinkRecord) => JSON.stringify({ ...r, at: undefined })

/** The last routes.jsonl line per dispatch id (a replayed start can log twice). */
function routesByDispatch(routes: RouteLine[]): Map<string, RouteLine> {
  const out = new Map<string, RouteLine>()
  for (const r of routes) if (r && typeof r.dispatchId === 'string' && r.dispatchId) out.set(r.dispatchId, r)
  return out
}

/**
 * The link records this sample adds: one per dispatch or handover whose record changed since its
 * last line (or has none). A dispatch's provider session is taken from its pane only while the
 * dispatch is open; once completed the pane may belong to other work, so the last known session
 * is carried forward. A live pane bound to a new session yields a new record, and the old one
 * stays in the file: both sessions keep resolving to the dispatch.
 */
export function snapshotLinks(inputs: SnapshotInputs): LinkRecord[] {
  const last = new Map<string, LinkRecord>()
  for (const r of inputs.previous) if (r && (r.type === 'dispatch' || r.type === 'handover')) last.set(linkKey(r), r)
  const routes = routesByDispatch(inputs.routes)
  const out: LinkRecord[] = []
  const emit = (r: LinkRecord) => {
    const before = last.get(linkKey(r))
    if (before && content(before) === content(r)) return
    last.set(linkKey(r), r)
    out.push(r)
  }
  for (const d of inputs.dispatches) {
    const before = last.get(`d|${d.dispatchId}`) as DispatchLink | undefined
    const route = routes.get(d.dispatchId)
    const live = !d.completedAt && !d.outcome
    const bound = live && d.paneKey && Object.prototype.hasOwnProperty.call(inputs.bindings, d.paneKey) ? inputs.bindings[d.paneKey] : undefined
    const providerSession = bound ?? before?.providerSession ?? null
    const kind = taskKind(route?.kind ?? route?.class)
    emit({
      type: 'dispatch',
      at: inputs.at,
      paneKey: d.paneKey ?? before?.paneKey ?? null,
      providerSession: providerSession ? { provider: providerSession.provider, id: providerSession.id } : null,
      dispatchId: d.dispatchId,
      taskId: d.taskId ?? str(route?.taskId) ?? before?.taskId ?? null,
      runId: d.runId ?? before?.runId ?? null,
      parentDispatchId: d.parentDispatchId ?? before?.parentDispatchId ?? null,
      retryOf: d.retryOf ?? str(route?.retryOf) ?? before?.retryOf ?? null,
      role: str(route?.role) ?? before?.role ?? null,
      workspace: d.workspace ?? str(route?.workspace) ?? before?.workspace ?? null,
      // routes.jsonl is append-only, but a line can be missing (a start by hand): keep what was seen.
      kind: kind ?? before?.kind ?? null,
      taskType: str(route?.type) ?? before?.taskType ?? null,
      risk: str(route?.risk) ?? before?.risk ?? null,
      context: str(route?.context) ?? before?.context ?? null,
      attempt: typeof route?.attempt === 'number' ? route.attempt : before?.attempt ?? null,
      model: route?.choice ? { agent: str(route.choice.agent), model: str(route.choice.model), effort: str(route.choice.effort) } : before?.model ?? null,
      arm: route?.arm === 'baseline' || route?.arm === 'variant' ? route.arm : before?.arm ?? null,
      pair: str(route?.pair) ?? before?.pair ?? null,
      dispatchedAt: d.dispatchedAt ?? before?.dispatchedAt ?? null,
      completedAt: d.completedAt ?? before?.completedAt ?? null,
      outcome: d.outcome ?? before?.outcome ?? null
    })
  }
  for (const h of inputs.handovers ?? []) {
    if (!h?.from || !h?.to || sameSession(h.from, h.to)) continue
    emit({ type: 'handover', at: inputs.at, from: { provider: h.from.provider, id: h.from.id }, to: { provider: h.to.provider, id: h.to.id } })
  }
  return out
}

// ---------- attribution ----------

/** What resolve needs from a usage observation (deduplicated upstream). `at`: ISO or epoch ms. */
export type Observed = { provider: string; session: string; at: string | number }
export type Resolved<T> = {
  observation: T
  /** The one dispatch it is attributed to, as last recorded; null = Unattributed. */
  to: DispatchLink | null
  /** The session that continued this one after a handover, if any. Nothing is moved to it. */
  continuedIn: ProviderSession | null
}

const ms = (v: string | number | null | undefined) => typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN

/**
 * Assigns each observation to exactly one dispatch, or to Unattributed (§4):
 * - by its own provider session only: a lead's and its workers' sessions are different, so a
 *   worker's usage is never also counted on its lead (the parent link rolls it up later);
 * - when one session served several dispatches (a reused pane), to the latest dispatch that had
 *   started by the observation's time; before the first, Unattributed;
 * - a retry is its own dispatch with retryOf set, so its usage stays on the retry;
 * - handover: usage stays with the session that spent it, the successor is only linked;
 * - no recorded binding (a plain terminal, a coordinator, history before links): Unattributed.
 */
export function resolve<T extends Observed>(observations: T[], links: LinkRecord[]): Resolved<T>[] {
  const latest = new Map<string, DispatchLink>()
  const started = new Map<string, number>()
  const sessionsOf = new Map<string, Set<string>>()
  const successor = new Map<string, ProviderSession>()
  for (const r of links) {
    if (r?.type === 'handover') { successor.set(sessionKey(r.from), r.to); continue }
    if (r?.type !== 'dispatch') continue
    latest.set(r.dispatchId, r)
    const t = ms(r.at)
    if (Number.isFinite(t) && t < (started.get(r.dispatchId) ?? Infinity)) started.set(r.dispatchId, t)
    if (r.providerSession) {
      const key = sessionKey(r.providerSession)
      if (!sessionsOf.has(key)) sessionsOf.set(key, new Set())
      sessionsOf.get(key)!.add(r.dispatchId)
    }
  }
  // Per session, its dispatches by start: Orca's dispatchedAt, else the first sample that saw it.
  const startOf = (id: string) => { const d = ms(latest.get(id)!.dispatchedAt); return Number.isFinite(d) ? d : started.get(id) ?? Infinity }
  const timeline = new Map<string, { id: string; start: number }[]>()
  for (const [key, ids] of sessionsOf) timeline.set(key, [...ids].map((id) => ({ id, start: startOf(id) })).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)))
  return observations.map((observation) => {
    const key = `${observation.provider}:${observation.session}`
    const t = ms(observation.at)
    let to: DispatchLink | null = null
    for (const { id, start } of timeline.get(key) ?? []) if (start <= t) to = latest.get(id)!
    return { observation, to, continuedIn: successor.get(key) ?? null }
  })
}

// ---------- files ----------

function readJsonl<T>(path: string): T[] {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T] } catch { return [] } })
}

export const readLinks = (path = LINKS_FILE): LinkRecord[] => readJsonl<LinkRecord>(path).filter((r) => r?.type === 'dispatch' || r?.type === 'handover')
export const readRouteLines = (path = ROUTES_FILE): RouteLine[] => readJsonl<RouteLine>(path)

/** Appends records to links.jsonl; nothing is written for none. */
export function appendLinks(records: LinkRecord[], path = LINKS_FILE): void {
  if (!records.length) return
  mkdirSync(join(path, '..'), { recursive: true })
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}
