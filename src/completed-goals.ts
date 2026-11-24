// The worker's side of the Completed goals tab: the completed goals, each worktree link with the workspace it still names.
// Reading changes nothing on disk. The tab's changes (Reopen, Undo) go through applyGoalAction (goals.ts), as the sidebar's do.
import { list } from '../skills/orca-flow/scripts/goals.mjs'
import type { CompletedGoal } from './completed-goals-view.ts'
import { linkedTo } from './goals-view.ts'
import type { WorkspaceRow } from './protocol.ts'

type Row = Pick<WorkspaceRow, 'id' | 'path'> & Partial<Pick<WorkspaceRow, 'queueKey' | 'folderOf' | 'historical'>>

/**
 * Completed goals, newest first. A worktree link carries `workspaceId`: the workspace now showing that worktree, or null
 * when none does (removed). With no workspaces known at all it is left out: nothing is claimed about a worktree
 * when the list simply has not been read.
 */
export function readCompleted(rows: Row[], data?: string): CompletedGoal[] {
  // Queue, folder and past-conversation rows stand for sessions, never for the worktree itself.
  const real = rows.filter((r) => !r.queueKey && !r.folderOf && !r.historical)
  return list({ data, status: 'done' }).map((g) => ({
    ...g,
    links: {
      ...g.links,
      worktrees: g.links.worktrees.map((w) => (real.length ? { ...w, workspaceId: real.find((r) => linkedTo(w, r))?.id ?? null } : w))
    }
  }))
}
