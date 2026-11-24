// Types for goals.mjs, so the plugin's TypeScript (src/*.ts) can import it.
export type GoalStatus = 'open' | 'proposed' | 'done'
export type GoalStep = { text: string; done: boolean }
export type WorktreeLink = { key?: string; path?: string; name?: string; worktreeId?: string }
export type GoalChange = { by: string; field: string; at: number }
/** Where the step was delivered: the coordinator's current session at the time. */
export type AssignedSession = { workspaceId: string; terminal: string; paneKey?: string; orcaSession?: string | null; agentType?: string | null; member?: string }
export type AssignmentState = 'pending' | 'delivered' | 'unconfirmed'
/** The Next step handed to a coordinator; it applies only while `next` is the goal's Next text. */
export type GoalAssignment = { coordinator: string; name?: string; next: string; state: AssignmentState; at: number; by: string; token: string; session?: AssignedSession; deliveredAt?: number }
export type Goal = {
  id: string
  title: string
  note?: string
  next?: string
  doneWhen?: string
  steps: GoalStep[]
  links: { linear: string[]; worktrees: WorktreeLink[] }
  status: GoalStatus
  createdAt: number
  updatedAt: number
  doneAt?: number
  lastChange: GoalChange
  assignment?: GoalAssignment
}
type Opts = { data?: string }
export const GOALS_DIR: string
export const STATUSES: GoalStatus[]
/** Settings → Features → Goals: true only when config.json has features.goals: true. */
export function goalsEnabled(options?: Opts & { env?: Record<string, string | undefined> }): boolean
export const GOALS_OFF: string
export function list(options?: Opts & { status?: GoalStatus }): Goal[]
export function get(id: string, options?: Opts): Goal | null
export function add(title: string, fields?: { note?: string; next?: string; doneWhen?: string; steps?: (string | GoalStep)[]; linear?: string[]; worktrees?: WorktreeLink[] }, options?: Opts & { by?: string; now?: number }): Goal
export function update(id: string, patch: { title?: string; note?: string; next?: string; doneWhen?: string }, by: string, options?: Opts): Goal
/** ref: a 1-based step number, or text matching one step. */
export function setStep(id: string, ref: number | string, done: boolean, by: string, options?: Opts): Goal
export function tick(id: string, ref: number | string, by: string, options?: Opts): Goal
export function addStep(id: string, text: string, by: string, options?: Opts): Goal
export function link(id: string, link: { linear?: string; worktree?: WorktreeLink }, by: string, options?: Opts): Goal
export function unlink(id: string, link: { linear?: string; worktree?: WorktreeLink }, by: string, options?: Opts): Goal
export function forWorktree(worktree: string | WorktreeLink, options?: Opts & { all?: boolean }): Goal[]
export function propose(id: string, by: string, options?: Opts): Goal
export function done(id: string, by: string, options?: Opts): Goal
export function reopen(id: string, by: string, options?: Opts): Goal
export const ASSIGN_PENDING_MS: number
export const ASSIGN_STATES: AssignmentState[]
/** The assignment when it is for the goal's current Next text (and not an abandoned pending one), else null. */
export function currentAssignment(g: Pick<Goal, 'next' | 'assignment'> | null | undefined, now?: number): GoalAssignment | null
export function beginAssign(id: string, to: { coordinator: string; name?: string; next: string; session?: AssignedSession }, by: string, options?: Opts & { now?: number; stillOn?: (a: GoalAssignment) => boolean }): { goal: Goal; token: string }
export function finishAssign(id: string, token: string, outcome: { ok: boolean; state?: 'delivered' | 'unconfirmed'; session?: AssignedSession }, options?: Opts & { now?: number }): { goal: Goal | null; applied: boolean }
