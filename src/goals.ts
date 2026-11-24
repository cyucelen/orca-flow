// The worker's side of the Goals section: reads the goals files (skills/orca-flow/scripts/goals.mjs, shared with
// the `orca-flow goal` commands) and applies the panel's edits. The panel's edits are the user's: they record
// "you". Everything the panel needs to draw comes from goalViews (goals-view.ts).
import { add, addStep, beginAssign, currentAssignment, done, finishAssign, get, list, reopen, setStep, update } from '../skills/orca-flow/scripts/goals.mjs'
import type { AssignedSession, GoalAssignment } from '../skills/orca-flow/scripts/goals.d.mts'
import { goalStepMessage, goalViews, type GoalView } from './goals-view.ts'
import type { WorkspaceRow } from './protocol.ts'

/** What the panel can do to a goal. confirm: the user accepts a proposed done; reject: "Not yet", back to open. */
export type GoalAction =
  | { action: 'add'; title: string }
  | { action: 'update'; id: string; patch: { title?: string; note?: string; next?: string; doneWhen?: string } }
  | { action: 'step'; id: string; step: number; done: boolean }
  | { action: 'addStep'; id: string; text: string }
  | { action: 'done' | 'reopen' | 'confirm' | 'reject'; id: string }
  /** Undo of a reopen (the Completed goals tab): done again with the original completion time and proposer. */
  | { action: 'restore'; id: string; doneAt?: number; proposedBy?: string }

export const BY_USER = 'you'

export const readGoals = (rows: Pick<WorkspaceRow, 'id' | 'path' | 'agents'>[], data?: string): GoalView[] => goalViews(list({ data }), rows, (g) => currentAssignment(g))

/** Applies one edit; answers the goals after it, or why it was refused (an unknown id, a step out of range, an empty title). */
export function applyGoalAction(a: GoalAction, rows: Pick<WorkspaceRow, 'id' | 'path' | 'agents'>[], data?: string): { ok: boolean; error?: string; goals: GoalView[] } {
  try {
    if (a.action === 'add') add(a.title, {}, { data, by: BY_USER })
    else if (a.action === 'update') update(a.id, a.patch, BY_USER, { data })
    else if (a.action === 'step') setStep(a.id, a.step, a.done, BY_USER, { data })
    else if (a.action === 'addStep') addStep(a.id, a.text, BY_USER, { data })
    else if (a.action === 'done' || a.action === 'confirm') done(a.id, BY_USER, { data })
    else if (a.action === 'reopen') reopen(a.id, BY_USER, { data })
    else if (a.action === 'restore') done(a.id, BY_USER, { data, doneAt: a.doneAt, proposedBy: a.proposedBy })
    else if (a.action === 'reject') {
      // "Not yet" answers a proposal; a goal that is no longer proposed (the user already acted elsewhere) stays as it is.
      if (get(a.id, { data })?.status === 'proposed') reopen(a.id, BY_USER, { data })
    } else return { ok: false, error: 'Unknown goal action', goals: readGoals(rows, data) }
    return { ok: true, goals: readGoals(rows, data) }
  } catch (e) {
    return { ok: false, error: (e as Error).message, goals: readGoals(rows, data) }
  }
}

// ---------- Assign to coordinator ----------

/** The panel's Assign to coordinator: the goal, the coordinator chosen, and the exact Next text the button was drawn for. */
export type GoalAssign = { id: string; coordinator: string; next: string }

/**
 * What an assignment needs from the worker. `target`: the coordinator's name and current live session,
 * throwing when it has none. `stillOn`: whether an earlier assignee still has a live session (a step
 * delivered to a coordinator that is gone may be assigned again). `deliver`: types the message into the
 * coordinator's current session, answering where it went; `uncertain` when Orca did not confirm a turn.
 * `changed`: posts the goals to every panel.
 */
export type AssignIo = {
  rows: () => Pick<WorkspaceRow, 'id' | 'path' | 'agents'>[]
  data?: string
  target: (key: string) => { name: string; session: AssignedSession }
  stillOn: (a: GoalAssignment) => boolean
  deliver: (key: string, message: string) => Promise<{ session?: AssignedSession; uncertain?: boolean }>
  changed?: () => void
}

const UNCONFIRMED = 'Orca did not confirm the coordinator got it: open it with Jump → and check before sending again.'

/**
 * Hands the goal's exact Next step to a coordinator. The store refuses a second assignment of the same
 * step (pending, or delivered to a coordinator still there) and one for a Next text that changed. The
 * delivery's answer is recorded only while the goal still has this assignment for the same Next text:
 * if the step changed meanwhile, the new step stays unassigned.
 */
export async function assignNext(input: GoalAssign, io: AssignIo): Promise<{ ok: boolean; error?: string; warning?: string; goals: GoalView[] }> {
  const goalsNow = () => readGoals(io.rows(), io.data)
  let begun: { goal: import('../skills/orca-flow/scripts/goals.d.mts').Goal; token: string }
  try {
    const { name, session } = io.target(input.coordinator)
    begun = beginAssign(input.id, { coordinator: input.coordinator, name, next: input.next, session }, BY_USER, { data: io.data, stillOn: io.stillOn })
  } catch (e) {
    return { ok: false, error: (e as Error).message, goals: goalsNow() }
  }
  io.changed?.()
  const id = begun.goal.id
  let answer: { session?: AssignedSession; uncertain?: boolean }
  try {
    answer = await io.deliver(input.coordinator, goalStepMessage(begun.goal))
  } catch (e) {
    finishAssign(id, begun.token, { ok: false }, { data: io.data })
    io.changed?.()
    return { ok: false, error: (e as Error).message, goals: goalsNow() }
  }
  const { applied } = finishAssign(id, begun.token, { ok: true, state: answer.uncertain ? 'unconfirmed' : 'delivered', session: answer.session }, { data: io.data })
  io.changed?.()
  if (!applied) return { ok: false, error: 'The next step changed while it was being sent: the coordinator got the old step, and the new one is not assigned.', goals: goalsNow() }
  return { ok: true, ...(answer.uncertain ? { warning: UNCONFIRMED } : {}), goals: goalsNow() }
}
