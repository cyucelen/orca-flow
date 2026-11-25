// The Goals section's HTML and rules, shared by the worker (which attaches the live agents on each goal) and the
// panel (which draws it). Goals are read by skills/orca-flow/scripts/goals.mjs (worker side only); this
// file has no Node imports, so the panel bundles it. Every goal text is untrusted: escaped when drawn.
import type { Goal, GoalAssignment } from '../skills/orca-flow/scripts/goals.d.mts'
import type { AgentInfo, Coordinator, Snapshot, WorkspaceRow } from './protocol.ts'
import { allStepsDone, goalNext, nextText } from '../skills/orca-flow/scripts/goal-next.mjs'
import { ARROW } from './icons.ts'
import { worktreeLead } from './rank.ts'

/**
 * A goal as the panel gets it: the stored goal, the live agents on its linked worktrees (goalAgents), and the
 * assignment of its next step when it is for the current effective next (goals.mjs currentAssignment; the
 * worker fills it, absent on older views).
 */
export type GoalView = Goal & { livePanes: string[]; assigned?: GoalAssignment | null }

/** Persist the active list’s fold across panel reloads. (An older `showDone` stored beside it is ignored: completed goals have their own tab.) */
export const GOALS_UI_KEY = 'goals-ui'
export type GoalsUi = { folded: boolean }
export const goalsUiOf = (stored: unknown): GoalsUi => {
  const s = (stored ?? {}) as Partial<GoalsUi>
  return { folded: s.folded === true }
}

export type GoalsState = { folded: boolean; open: string | null; now: number }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// ---------- which agents are on a goal ----------

/** Does the goal's worktree link point at this row? By Orca identity key, Orca id or path. */
export const linkedTo = (w: Goal['links']['worktrees'][number], row: Pick<WorkspaceRow, 'id' | 'path'>) =>
  (!!w.key && row.id === `identity:${w.key}`) || (!!w.worktreeId && row.id === w.worktreeId) || (!!w.path && row.path === w.path)

/** Waiting for the user: a question, or a permission prompt. */
const ASKING: AgentInfo['state'][] = ['waiting', 'blocked']

type Row = Pick<WorkspaceRow, 'id' | 'path' | 'agents'> & Partial<Pick<WorkspaceRow, 'name' | 'historical' | 'lastActivityAt'>>

/**
 * The one rule for who is on a goal, used by its avatars and by Jump →: the agents on its linked worktrees that still
 * have a live session, in any state, until they sleep (their session closes) or are removed (the worktree or terminal is
 * gone). Working and asking agents count unless Orca says their session is closed; a done or idle one only with positive
 * evidence that it is live. Terminals in `gone` (seen dead) are left out. In Jump →'s order: working, else waiting for
 * the user, else a worktree's lead, else the others, most recently active first. A done goal has none.
 */
export function goalAgents<R extends Row>(g: Pick<Goal, 'status' | 'links'>, rows: R[], gone: ReadonlySet<string> = new Set()): { row: R; a: AgentInfo }[] {
  if (g.status === 'done') return []
  const live = (a: AgentInfo) => !!a.terminal && !gone.has(a.terminal) && (a.state === 'working' || ASKING.includes(a.state) ? a.live !== false : a.live === true)
  const placed = rows
    .filter((row) => !row.historical && g.links.worktrees.some((w) => linkedTo(w, row)))
    .sort((x, y) => (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0))
    .flatMap((row) => row.agents.filter(live).map((a) => ({ row, a })))
  const rank = ({ row, a }: (typeof placed)[number]) => (a.state === 'working' ? 0 : ASKING.includes(a.state) ? 1 : worktreeLead(row)?.paneKey === a.paneKey ? 2 : 3)
  const seen = new Set<string>()
  return placed
    .filter(({ a }) => !seen.has(a.paneKey) && !!seen.add(a.paneKey))
    .sort((x, y) => rank(x) - rank(y) || (rank(x) === 3 ? (y.a.summary?.updatedAt ?? 0) - (x.a.summary?.updatedAt ?? 0) : 0))
}

/** Each goal with the panes of the agents on it (goalAgents), once each, even when a goal links its worktree twice. */
export function goalViews(goals: Goal[], rows: Row[], assignedOf: (g: Goal) => GoalAssignment | null = () => null): GoalView[] {
  return goals.map((g) => ({
    ...g,
    assigned: g.status === 'done' ? null : assignedOf(g),
    livePanes: goalAgents(g, rows).map(({ a }) => a.paneKey)
  }))
}

// ---------- the Next step's button: Jump to agent, or Assign to coordinator ----------

/** Where Jump to agent goes: an exact live session (its workspace and terminal), checked against a snapshot. */
export type JumpTarget = { workspaceId: string; terminal: string; paneKey: string; name: string; coordinator?: string }

type SnapLike = Pick<Snapshot, 'rows' | 'coordinators'>

/**
 * A coordinator's current session when it is live: the explicitly current member's live pane
 * (Snapshot.coordinators[].session), so after a handover it is the new session, never the old pane.
 */
export function coordinatorTarget(c: Coordinator | undefined, gone: ReadonlySet<string> = new Set()): JumpTarget | null {
  const s = c?.session
  if (!c || !s || s.live === false || !s.terminal || gone.has(s.terminal)) return null
  const member = c.sessions?.members.find((m) => m.id === c.sessions?.current)
  const workspaceId = member?.workspaceId ?? c.workspaceId
  return workspaceId ? { workspaceId, terminal: s.terminal, paneKey: s.paneKey, name: c.name, coordinator: c.key } : null
}

/** The coordinators the picker offers: those with a live current session, in the snapshot's order. */
export const liveCoordinators = (snap: SnapLike): Coordinator[] => snap.coordinators.filter((c) => coordinatorTarget(c))

/**
 * Who Jump → goes to, by the given snapshot: the first of goalAgents (the live agents on its linked worktrees, working
 * first). Else the coordinator the current step was assigned to, at its current live session. Sessions in `gone` (seen
 * dead) are skipped. Null (Assign →): no linked worktree, none that still exists, or no live agent on one, and no live
 * assigned coordinator.
 */
export function jumpTarget(g: GoalView, snap: SnapLike, gone: ReadonlySet<string> = new Set()): JumpTarget | null {
  if (g.status === 'done') return null
  const pick = goalAgents(g, snap.rows, gone)[0]
  if (pick) return { workspaceId: pick.row.id, terminal: pick.a.terminal!, paneKey: pick.a.paneKey, name: pick.a.title || pick.row.name }
  const a = g.assigned
  if (!a || a.state === 'pending' || a.next !== nextText(g)) return null
  return coordinatorTarget(snap.coordinators.find((c) => c.key === a.coordinator), gone)
}

export type NextButton = { kind: 'jump'; target: JumpTarget } | { kind: 'assign' } | { kind: 'pending' }

/**
 * The one button for an open goal's next step (its written next, else its first open todo: goal-next.mjs); null for a
 * done or proposed goal, or one with no next step. Pending while this panel sends it (`assigning`) or the store says a send is under way.
 */
export function nextButton(g: GoalView, snap: SnapLike, opts: { assigning?: ReadonlySet<string>; gone?: ReadonlySet<string> } = {}): NextButton | null {
  const next = nextText(g)
  if (g.status !== 'open' || !next) return null
  if (opts.assigning?.has(g.id) || (g.assigned?.state === 'pending' && g.assigned.next === next)) return { kind: 'pending' }
  const target = jumpTarget(g, snap, opts.gone)
  return target ? { kind: 'jump', target } : { kind: 'assign' }
}

/**
 * The button's HTML: the Linear row's hover pill (`act pill send`, "Send →"), one word and the arrow, with the full
 * meaning in its tooltip and accessible name. Its own element beside the row, so pressing it never opens the card.
 * Pending is a row status, like Linear's "Sending…": nothing to press, shown without hover.
 */
export function nextButtonHtml(g: Pick<GoalView, 'id'>, b: NextButton | null): string {
  if (!b) return ''
  if (b.kind === 'pending') return '<span class="gact rstatus pending" role="status"><span class="refreshing"></span>Assigning…</span>'
  if (b.kind === 'jump') {
    const tip = esc(`Jump to ${b.target.name}`)
    return `<button class="gact act pill send" data-gjump="${esc(g.id)}" aria-label="${tip}">Jump ${ARROW}</button>`
  }
  const tip = 'Assign the next step to a coordinator'
  return `<button class="gact act pill send" data-gassign="${esc(g.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${tip}">Assign ${ARROW}</button>`
}

/** The text a coordinator gets: the exact step, the goal for context, and the commands to keep the goal current. Goal text is data, quoted, on one line each. */
export function goalStepMessage(g: Pick<Goal, 'id' | 'title' | 'doneWhen'> & Partial<Pick<Goal, 'next' | 'steps'>>): string {
  const next = goalNext(g)
  const line = (s: string | undefined) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  return [
    `The user assigned you the next step of their Orca Flow goal ${g.id} (from the Goals section).`,
    `Next step: "${line(next?.text)}"${next?.fromStep ? ` (todo ${next.fromStep} of the goal's list)` : ''}`,
    `Goal: "${line(g.title)}"`,
    ...(g.doneWhen ? [`Done when: "${line(g.doneWhen)}"`] : []),
    `Commands: orca-flow goal show ${g.id} · orca-flow goal link ${g.id} --worktree <sel> (link the worktree you start for it) · ${next?.fromStep ? `orca-flow goal step ${g.id} tick ${next.fromStep} (when this todo is done; the next open todo then becomes the next step)` : `orca-flow goal step ${g.id} tick <n|text> · orca-flow goal set ${g.id} --next "<the step after>" (when this one is done)`} · orca-flow goal propose-done ${g.id}`
  ].join('\n')
}

// ---------- small helpers ----------

/** "just now", "5m ago", "2h ago", "3d ago". */
export function agoText(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000))
  if (m < 1) return 'just now'
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

const completedSteps = (g: Goal) => g.steps.filter((s) => s.done).length

function stepProgress(g: Goal): string {
  const total = g.steps.length
  if (!total) return ''
  const done = completedSteps(g)
  const arc = done ? `<circle cx="7" cy="7" r="5.5" pathLength="${total}" stroke-dasharray="${done} ${total}" transform="rotate(-90 7 7)"/>` : ''
  return `<span class="gprogress" role="img" aria-label="${done} of ${total} ${total === 1 ? 'todo' : 'todos'} complete"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14"><circle class="track" cx="7" cy="7" r="5.5"/>${arc}</svg><span class="cnt">${done}/${total}</span></span>`
}

const CHEV = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2l3 3-3 3"/></svg>'
const CHECK = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 5.4L4 7.6L8.2 2.6"/></svg>'

// ---------- the section ----------

/** Goals the section lists: the open and proposed ones. */
export const activeGoals = (goals: GoalView[]) => goals.filter((g) => g.status !== 'done')

/** The Goals header: fold, "Completed ›" (opens the Completed goals tab; hidden with none completed, its total in the tooltip) and +. */
export function goalsHead(goals: GoalView[], s: GoalsState, searching = false): string {
  if (searching) return ''
  const active = activeGoals(goals).length
  const completed = goals.length - active
  const tip = `${completed} completed ${completed === 1 ? 'goal' : 'goals'} · opens a tab`
  const history = completed ? `<button class="ghistory" data-gcompleted data-tip="${tip}" aria-label="Open completed goals (${tip})">Completed ›</button>` : ''
  return `<div class="sechead ghead"><button class="label lfold" data-gfold aria-expanded="${!s.folded}">${CHEV}<span>Goals</span>${active ? `<span class="gc">${active}</span>` : ''}</button>${history}<button class="gplus" data-gadd aria-label="Add a goal" data-tip="Add a goal">+</button></div>`
}

const completedDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const TODO_GLYPH = '<svg class="tg" aria-hidden="true" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="1.5" width="7" height="7" rx="1.8"/></svg>'

/** An open goal's line under its title: the written next; else its first open todo (marked as one); else why there is none. */
function nextLine(g: Goal): string {
  const next = goalNext(g)
  if (!next) return `<span class="nx none">${allStepsDone(g) ? 'All todos done' : 'No next step yet'}</span>`
  return next.fromStep ? `<span class="nx todo" title="From the todos">${TODO_GLYPH}${esc(next.text)}</span>` : `<span class="nx">${esc(next.text)}</span>`
}

/**
 * One goal: its title and step count, and under it the next step (or "lead says done" while an agent proposes it).
 * `button` (nextButton) ends the right-hand cluster, after the avatars and progress, beside the row's button (not inside it).
 */
export function goalRow(g: GoalView, open: string | null, avatars = '', button: NextButton | null = null): string {
  const done = g.status === 'done'
  const second = done
    ? ''
    : g.status === 'proposed'
      ? '<span class="nx says">lead says done</span>'
      : nextLine(g)
  const detail = done ? `<span class="cnt">${completedDate.format(g.doneAt ?? g.updatedAt)}</span>` : stepProgress(g)
  const row = `<button class="g${done ? ' fin' : ''}${open === g.id ? ' menu-open' : ''}" data-gopen="${esc(g.id)}" aria-haspopup="dialog" aria-expanded="${open === g.id}"><span class="m"><span class="ti">${esc(g.title)}</span>${second}</span>${avatars}${detail}</button>`
  return button && !done ? `<div class="gline">${row}${nextButtonHtml(g, button)}</div>` : row
}

/** The active list: open and proposed goals. Completed goals are in their own tab (completed-goals-view.ts). */
export function goalsRows(goals: GoalView[], s: GoalsState, searching = false, avatars?: (g: GoalView) => string, button?: (g: GoalView) => NextButton | null): string {
  if (searching || s.folded) return ''
  return activeGoals(goals).map((g) => goalRow(g, s.open, avatars?.(g), button?.(g))).join('')
}

// ---------- the card ----------

const editable = (field: string, id: string, value: string | undefined, placeholder: string, cls = 'ed', label = placeholder) =>
  `<div class="${cls}" contenteditable="plaintext-only" spellcheck="false" role="textbox" aria-label="${esc(label)}" data-gedit="${field}" data-g="${esc(id)}" data-ph="${esc(placeholder)}">${esc(value ?? '')}</div>`

/** A worktree link's text: its name, else the last part of its path. */
const worktreeName = (w: Goal['links']['worktrees'][number]) => w.name || (w.path ? w.path.split('/').filter(Boolean).pop() : '') || w.key || 'worktree'

const ASSIGNED_WORD = { pending: 'Sending to', delivered: 'Assigned to', unconfirmed: 'Sent, unconfirmed, to' } as const
/** Under the card's Next: who the current step was handed to, while it is for this exact step. */
function assignedLine(g: GoalView, now: number): string {
  const a = g.assigned
  if (!a || g.status === 'done' || a.next !== nextText(g)) return ''
  return `<span class="gassigned">${ASSIGNED_WORD[a.state] ?? 'Assigned to'} ${esc(a.name || a.coordinator)} · ${agoText(a.deliveredAt ?? a.at, now)}</span>`
}

/** The Next field's placeholder: the first open todo it follows while empty, else the prompt. */
function cardNextPlaceholder(g: Goal): string {
  const next = goalNext(g)
  return next?.fromStep ? `${next.text} (from todos)` : 'What is the next thing to do?'
}

/**
 * The details card of a goal: its title, description, done criteria, next step, checklist, links, and the foot with the buttons that fit its status.
 * Every section is a direct child with a data-part, so a live redraw replaces the parts the person
 * is not typing in (see paintGoalCard in panel/app.ts).
 */
export function goalCard(g: GoalView, now: number): string {
  const steps = g.steps.map((s, i) => `<div class="step${s.done ? ' done' : ''}" data-gstep="${i + 1}" data-g="${esc(g.id)}" role="checkbox" aria-checked="${s.done}" tabindex="0"><span class="box">${CHECK}</span><span class="s">${esc(s.text)}</span></div>`).join('')
  const links = [
    ...g.links.linear.map((id) => `<span class="link"><span class="mono">${esc(id)}</span></span>`),
    ...g.links.worktrees.map((w) => `<span class="link">${esc(worktreeName(w))}</span>`)
  ].join('')
  const buttons = g.status === 'proposed'
    ? `<button class="gbtn quiet" data-gnot="${esc(g.id)}">Not yet</button><button class="gbtn" data-gconfirm="${esc(g.id)}">Confirm done</button>`
    : g.status === 'done'
      ? `<button class="gbtn quiet" data-greopen="${esc(g.id)}">Reopen</button>`
      : `<button class="gbtn calm" data-gfinish="${esc(g.id)}">Mark done</button>`
  return [
    `<div class="gpart" data-part="title">${editable('title', g.id, g.title, 'Goal', 'ed ph')}</div>`,
    `<div class="gpart f" data-part="note"><span class="k">Description</span>${editable('note', g.id, g.note, 'Add a description', 'ed note')}</div>`,
    `<div class="gpart f" data-part="doneWhen"><span class="k">Done criteria</span>${editable('doneWhen', g.id, g.doneWhen, 'How will you know it is done?')}</div>`,
    `<div class="gpart f" data-part="next"><span class="k">Next</span>${editable('next', g.id, g.next, cardNextPlaceholder(g), 'ed', 'Next')}${assignedLine(g, now)}</div>`,
    `<div class="gpart f" data-part="steps"><span class="k">Todos${g.steps.length ? ` · ${completedSteps(g)}/${g.steps.length}` : ''}</span><div class="steps">${steps}</div>${editable('newStep', g.id, '', 'Add a todo', 'ed addstep')}</div>`,
    `<div class="gpart f" data-part="links"><span class="k">Links</span><div class="links">${links || '<span class="nolinks">No ticket or worktree</span>'}</div></div>`,
    g.status === 'proposed' ? '<div class="gpart gsays" data-part="says">An agent says this is done. Is it?</div>' : '',
    `<div class="gpart pfoot${g.status === 'proposed' ? ' wrap' : ''}" data-part="foot">${buttons}</div>`
  ].join('')
}
