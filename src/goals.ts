// The worker's side of the Goals section: reads the goals files (skills/orca-flow/scripts/goals.mjs, shared with
// the `orca-flow goal` commands) and applies the panel's edits. The panel's edits are the user's: they record
// "you". Everything the panel needs to draw comes from goalViews (goals-view.ts).
import { add, addStep, done, get, list, reopen, setStep, update } from '../skills/orca-flow/scripts/goals.mjs'
import { goalViews, type GoalView } from './goals-view.ts'
import type { WorkspaceRow } from './protocol.ts'

/** What the panel can do to a goal. confirm: the user accepts a proposed done; reject: "Not yet", back to open. */
export type GoalAction =
  | { action: 'add'; title: string }
  | { action: 'update'; id: string; patch: { title?: string; note?: string; next?: string; doneWhen?: string } }
  | { action: 'step'; id: string; step: number; done: boolean }
  | { action: 'addStep'; id: string; text: string }
  | { action: 'done' | 'reopen' | 'confirm' | 'reject'; id: string }

export const BY_USER = 'you'

export const readGoals = (rows: Pick<WorkspaceRow, 'id' | 'path' | 'agents'>[], data?: string): GoalView[] => goalViews(list({ data }), rows)

/** Applies one edit; answers the goals after it, or why it was refused (an unknown id, a step out of range, an empty title). */
export function applyGoalAction(a: GoalAction, rows: Pick<WorkspaceRow, 'id' | 'path' | 'agents'>[], data?: string): { ok: boolean; error?: string; goals: GoalView[] } {
  try {
    if (a.action === 'add') add(a.title, {}, { data, by: BY_USER })
    else if (a.action === 'update') update(a.id, a.patch, BY_USER, { data })
    else if (a.action === 'step') setStep(a.id, a.step, a.done, BY_USER, { data })
    else if (a.action === 'addStep') addStep(a.id, a.text, BY_USER, { data })
    else if (a.action === 'done' || a.action === 'confirm') done(a.id, BY_USER, { data })
    else if (a.action === 'reopen') reopen(a.id, BY_USER, { data })
    else if (a.action === 'reject') {
      // "Not yet" answers a proposal; a goal that is no longer proposed (the user already acted elsewhere) stays as it is.
      if (get(a.id, { data })?.status === 'proposed') reopen(a.id, BY_USER, { data })
    } else return { ok: false, error: 'Unknown goal action', goals: readGoals(rows, data) }
    return { ok: true, goals: readGoals(rows, data) }
  } catch (e) {
    return { ok: false, error: (e as Error).message, goals: readGoals(rows, data) }
  }
}
