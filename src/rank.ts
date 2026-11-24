// Which workspaces need the person, and in what order. Shared by the panel's sections and,
// later, the Next-up card. The order is the coordinator skill's: level, then asks that unblock
// other agents, then quick asks, then longest waiting.
import type { AgentInfo, WorkspaceRow } from './protocol.ts'

/**
 * A dispatched worker that ended its task: Orca settled its dispatch (worker_done, or abandoned). Its
 * report, a "decision for you" included, is for its lead, not the user.
 */
export const reported = (a: AgentInfo) => a.summary?.role === 'worker' && a.dispatch === 'settled'

/**
 * A summary may claim an ask only if it was written under the current rules (it carries
 * `glance`); older ones produced junk asks like terminal ids. A worker that reported claims none.
 */
export const claimsAsk = (a: AgentInfo) =>
  a.summary !== null && typeof a.summary.glance === 'string' && a.summary.needs.type !== 'none' && !reported(a)

/**
 * The one rule for "this agent needs you", mirroring Orca: its blocked (permission prompt) and
 * waiting (a question) states always do; a working agent never does; a finished turn does when its
 * summary asks something.
 */
export const asksYou = (a: AgentInfo) =>
  // A working agent has its answer: the last summary's ask is stale until its next turn ends.
  a.state === 'blocked' || a.state === 'waiting' || (a.state !== 'working' && claimsAsk(a))

/**
 * An ask that does not stop the agent ("Working · needs 2 files later"): the answer is needed only
 * later. Up next lists it after every ask that stops work, even while the agent works. Orca's own
 * question or permission prompt always stops it.
 */
export const laterAsk = (a: AgentInfo) =>
  claimsAsk(a) && a.summary!.needs.blocking === false && a.state !== 'blocked' && a.state !== 'waiting'

/** Orca marks it monitoring (its dashed circle): waiting on tests, CI, a deploy or its workers. */
export const monitoring = (a: AgentInfo) => a.workingMode === 'monitoring' && !asksYou(a)

/**
 * A lead owns its workstream until the user calls it done or its PR merges. It reports worker_done
 * for its dispatch then, but nothing wakes a lead when its PR merges, so a merged PR on its row
 * (`pr`, when the caller knows it) releases it too. Until then a quiet turn ("PR open, waiting on
 * CI") leaves it available, never finished, and nothing offers to put it to sleep.
 */
export const holdsWorkstream = (a: AgentInfo, pr?: WorkspaceRow['pr']) =>
  a.summary?.role === 'lead' && a.dispatch !== 'settled' && pr?.state !== 'merged'

/** Done, nothing asked, not monitoring: a session that only holds memory. `pr` is its row's PR, when known. */
export const finished = (a: AgentInfo, pr?: WorkspaceRow['pr']) =>
  a.state !== 'working' && !asksYou(a) && !monitoring(a) && !holdsWorkstream(a, pr)

/** An agent mid-turn in the worktree (Orca's working state, monitoring included): it keeps the worktree. */
export const workingIn = (row: WorkspaceRow): AgentInfo | undefined => row.agents.find((a) => a.state === 'working')

/** The sidebar offers to remove a worktree only when it is not the main checkout and no agent there is mid-turn. */
export const canRemove = (row: WorkspaceRow): boolean => !row.main && !row.folderOf && !workingIn(row)

/** The agent that speaks for the workspace: the one asking, else the most urgent state. */
/** The agent no other agent in its worktree dispatched (the first, when several were started by hand). */
export const worktreeLead = (row: Pick<WorkspaceRow, 'agents'>): AgentInfo | undefined =>
  row.agents.find((a) => ![a.leadPane, a.parentPane].some((p) => p && row.agents.some((b) => b.paneKey === p)))

export function leadAgent(row: WorkspaceRow): AgentInfo | undefined {
  return row.agents.find(asksYou) ??
    row.agents.find((a) => a.state === row.state)
}

/** A workspace needs you when one of its agents asks you something. */
export const needsYou = (row: WorkspaceRow): boolean => row.agents.some(asksYou)

const LEVEL = { P0: 0, P1: 1, P2: 2, P3: 3 }

export function byUrgency(a: WorkspaceRow, b: WorkspaceRow): number {
  const level = (r: WorkspaceRow) => (r.priority ? LEVEL[r.priority] : 4)
  const unblocks = (r: WorkspaceRow) => (r.agents.some((x) => x.summary?.role === 'coordinator' || x.summary?.role === 'lead') ? 0 : 1)
  const quick = (r: WorkspaceRow) => (leadAgent(r)?.summary?.effort === 'quick' ? 0 : 1)
  return (
    level(a) - level(b) ||
    unblocks(a) - unblocks(b) ||
    quick(a) - quick(b) ||
    (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0)
  )
}

/** Everything waiting on the person, most urgent first. */
export const waitingQueue = (rows: WorkspaceRow[]) => rows.filter(needsYou).sort(byUrgency)

/**
 * Where "jump to next" goes: the top of the queue, or, when the person jumped to that one moments
 * ago and is pressing again, the one after it, so skipping an item never traps them on it.
 */
export function nextTarget(
  queue: WorkspaceRow[],
  last: { id: string; at: number } | null,
  now: number
): WorkspaceRow | undefined {
  if (queue.length === 0) return undefined
  const i = last && now - last.at < 10 * 60_000 ? queue.findIndex((r) => (r.queueKey ?? r.id) === last.id) : -1
  return queue[(i + 1) % queue.length]
}
