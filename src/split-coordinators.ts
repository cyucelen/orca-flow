// Read-only sidebar evidence for independent coordinators sharing one folder after a manual split.
import { runRoutes, type RunRoute } from './handover.ts'
import type { AgentInfo, Coordinator, CoordinatorSplit, WorkspaceRow } from './protocol.ts'
import type { PsAgent, PsWorktree } from './worker.ts'

type Root = { terminal: string; pane: string; session: string }
type Run = (args: string[]) => Promise<any>
type Assignment = { terminal: string; run: string; task: string; parent?: string; open: boolean }
export type SplitEvidence = { roots: Root[]; routes: RunRoute[]; assignments: Assignment[] }

/** Join the host's terminal address, live pane and session in a coordinator folder. */
export function splitRoots(worktrees: PsWorktree[], dirs: string[]): Root[] {
  return worktrees.flatMap(w => {
    if (!w.path || !dirs.includes(w.path) || (w.hostId && w.hostId !== 'local')) return []
    const agents = w.agents ?? []
    const roots = agents.flatMap((a: PsAgent) => a.hasLivePty && a.parentPaneKey === null && a.paneKey && a.orcaSessionId && typeof a.address === 'string' && a.address.startsWith('term_')
      ? [{ terminal: a.address, pane: a.paneKey, session: a.orcaSessionId }] : [])
    return roots.length > 1 ? roots : []
  })
}

/** A partial or caller-bound worker inventory cannot rule out a dispatched lead owning a run. */
export async function readSplitEvidence(run: Run, roots: Root[]): Promise<SplitEvidence | undefined> {
  if (roots.length < 2) return
  const routes = await runRoutes(run)
  const owned = routes.filter(r => !r.legacy && roots.some(root => root.terminal === r.coordinator_handle))
  if (new Set(owned.map(r => r.id)).size !== owned.length) return
  if (new Set(owned.map(r => r.coordinator_handle)).size < 2) return
  const assignments: Assignment[] = [], seen = new Set<string>()
  let cursor: string | null = null
  do {
    const result = await run(['orchestration', 'worker-list', '--full', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])])
    if (result?.scope?.source !== 'all' || result.truncated || !Array.isArray(result.workers) || typeof result.page?.hasMore !== 'boolean') return
    for (const w of result.workers) {
      if (!w || !('agentTerminalHandle' in w)) return
      if (w.agentTerminalHandle === null) continue
      const open = w.dispatchStatus === 'dispatched' || w.dispatchStatus === 'pending'
      if (w.terminalState === 'released' && !open) continue
      if (typeof w.agentTerminalHandle !== 'string' || typeof w.runId !== 'string' || typeof w.taskId !== 'string') return
      assignments.push({ terminal: w.agentTerminalHandle, run: w.runId, task: w.taskId, parent: w.projection?.parent?.taskId, open })
    }
    cursor = result.page.nextCursor
    if (result.page.hasMore !== Boolean(cursor) || (cursor !== null && (typeof cursor !== 'string' || seen.has(cursor)))) return
    if (cursor) seen.add(cursor)
  } while (cursor)
  return { roots, routes: owned, assignments }
}

export function projectSplit(c: Coordinator, rows: WorkspaceRow[], psRoots: Root[], evidence?: SplitEvidence): CoordinatorSplit | undefined {
  const main = c.session
  if (!evidence || !main || !c.sessions?.current || !c.workspaceId) return
  const agents = rows.flatMap(r => r.agents)
  const home = rows.filter(r => r.id === c.workspaceId).flatMap(r => r.agents)
  const verifiedRuns = (a: AgentInfo) => {
    if (!a.live || !a.terminal || !a.orcaSession || !a.paneKey || a.parentPane || a.dispatch) return []
    // Require the same unique live identity in the current ps and the background routing snapshot.
    const matches = (roots: Root[]) => {
      const found = roots.filter(r => r.session === a.orcaSession || r.pane === a.paneKey || r.terminal === a.terminal)
      return found.length === 1 && found[0].session === a.orcaSession && found[0].pane === a.paneKey && found[0].terminal === a.terminal
    }
    if (!matches(psRoots) || !matches(evidence.roots) || home.some(b => b !== a && b.live && (b.orcaSession === a.orcaSession || b.paneKey === a.paneKey))) return []
    if (evidence.assignments.some(w => w.terminal === a.terminal)) return []
    return evidence.routes.filter(r => r.coordinator_handle === a.terminal && (!r.coordinator_orca_session_id || r.coordinator_orca_session_id === a.orcaSession))
      .map(r => ({ id: r.id, objective: r.objective || r.id }))
  }
  const mainRuns = verifiedRuns(main)
  if (!mainRuns.length) return
  const auxiliary = home.flatMap(a => {
    if (a === main || c.members?.some(m => m.orcaSession === a.orcaSession || (a.terminal && m.terminals.includes(a.terminal)))) return []
    const runs = verifiedRuns(a)
    return runs.length ? [{ pane: a.paneKey, runs }] : []
  })
  if (!auxiliary.length) return

  const owners = [{ pane: main.paneKey, runs: mainRuns }, ...auxiliary]
  const ownerByRun = new Map(owners.flatMap(root => root.runs.map(r => [r.id, root.pane] as const)))
  const ownerPanes = new Set(owners.map(root => root.pane))
  const parents: Record<string, string> = {}
  for (const a of agents) {
    if (!a.live || !a.terminal || agents.some(b => b !== a && b.live && b.terminal === a.terminal)) continue
    const matches = evidence.assignments.filter(w => w.terminal === a.terminal)
    const active = matches.filter(w => w.open)
    const assignments = active.length ? active : matches
    if (assignments.length !== 1) continue
    const assignment = assignments[0], coordinator = ownerByRun.get(assignment.run)
    if (!coordinator) continue
    // A dispatched lead can start another worker inside the same run. Preserve that direct edge.
    const parentWorkers = assignment.parent ? evidence.assignments.filter(w => w.run === assignment.run && w.task === assignment.parent) : []
    const parentAgents = agents.filter(b => b.live && b.terminal && parentWorkers.some(w => w.terminal === b.terminal))
    const original = agents.find(b => b.live && b.paneKey === a.parentPane)
    const otherRun = original && evidence.assignments.some(w => w.open && w.terminal === original.terminal && w.run !== assignment.run)
    const originalParent = original && !ownerPanes.has(original.paneKey) && !otherRun ? original.paneKey : null
    parents[a.paneKey] = parentAgents.length === 1 && parentAgents[0] !== a ? parentAgents[0].paneKey : originalParent ?? coordinator
  }
  return { mainRuns, auxiliary, parents }
}
