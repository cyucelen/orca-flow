// Types for goals.mjs, so the plugin's TypeScript (src/*.ts) can import it.
export type GoalStatus = 'open' | 'proposed' | 'done'
export type GoalStep = { text: string; done: boolean }
export type WorktreeLink = { key?: string; path?: string; name?: string; worktreeId?: string }
export type GoalChange = { by: string; field: string; at: number }
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
}
type Opts = { data?: string }
export const GOALS_DIR: string
export const STATUSES: GoalStatus[]
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
