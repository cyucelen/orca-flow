// The Goals section's HTML and rules, shared by the worker (which attaches "an agent works on it") and the
// panel (which draws it). Goals are read by skills/orca-flow/scripts/goals.mjs (worker side only); this
// file has no Node imports, so the panel bundles it. Every goal text is untrusted: escaped when drawn.
import type { Goal } from '../skills/orca-flow/scripts/goals.d.mts'
import type { AgentInfo, WorkspaceRow } from './protocol.ts'

/** A goal as the panel gets it: the stored goal, and whether an agent on a worktree it links is working now. */
export type GoalView = Goal & { working: boolean }

/** Where the panel keeps the section's fold and the done toggle (plugin storage). */
export const GOALS_UI_KEY = 'goals-ui'
export type GoalsUi = { folded: boolean; showDone: boolean }
export const goalsUiOf = (stored: unknown): GoalsUi => {
  const s = (stored ?? {}) as Partial<GoalsUi>
  return { folded: s.folded === true, showDone: s.showDone === true }
}

/** The part of the panel's state the section draws: its fold, the done toggle, the add box and the goal whose card is open. */
export type GoalsState = { folded: boolean; showDone: boolean; open: string | null; now: number }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// ---------- which goals an agent is working on ----------

/** Does the goal's worktree link point at this row? By Orca identity key, Orca id or path. */
const linkedTo = (w: Goal['links']['worktrees'][number], row: Pick<WorkspaceRow, 'id' | 'path'>) =>
  (!!w.key && row.id === `identity:${w.key}`) || (!!w.worktreeId && row.id === w.worktreeId) || (!!w.path && row.path === w.path)

const isWorking = (a: Pick<AgentInfo, 'state'>) => a.state === 'working'

/** Goals with their dot: lit when an agent on a linked worktree is working. A finished goal never is. */
export function goalViews(goals: Goal[], rows: Pick<WorkspaceRow, 'id' | 'path' | 'agents'>[]): GoalView[] {
  return goals.map((g) => ({
    ...g,
    working: g.status !== 'done' && g.links.worktrees.some((w) => rows.some((r) => linkedTo(w, r) && r.agents.some(isWorking)))
  }))
}

// ---------- small helpers ----------

/** "just now", "5m ago", "2h ago", "3d ago". */
export function agoText(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000))
  if (m < 1) return 'just now'
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

const FIELD = { title: 'Title', note: 'Note', next: 'Next', doneWhen: 'Done criteria', steps: 'Steps', links: 'Links' } as const
/** The one muted line at the foot of a card: "Next updated by you · 2h ago". */
export function lastChangeText(g: Pick<Goal, 'lastChange'>, now: number): string {
  const { by, field, at } = g.lastChange
  const when = agoText(at, now)
  if (field === 'created') return `Added by ${by} · ${when}`
  if (field === 'status') return `Status changed by ${by} · ${when}`
  const names = field.split(',').map((f) => FIELD[f as keyof typeof FIELD] ?? f)
  return `${names.join(' and ')} updated by ${by} · ${when}`
}

const completedSteps = (g: Goal) => g.steps.filter((s) => s.done).length

function stepProgress(g: Goal): string {
  const total = g.steps.length
  if (!total) return ''
  const done = completedSteps(g)
  const arc = done ? `<circle cx="7" cy="7" r="5.5" pathLength="${total}" stroke-dasharray="${done} ${total}" transform="rotate(-90 7 7)"/>` : ''
  return `<span class="gprogress" data-tip="${done} of ${total} steps complete"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14"><circle class="track" cx="7" cy="7" r="5.5"/>${arc}</svg><span class="cnt">${done}/${total}</span></span>`
}

const CHEV = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2l3 3-3 3"/></svg>'
const CHECK = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 5.4L4 7.6L8.2 2.6"/></svg>'

// ---------- the section ----------

/** Goals the section lists: open and proposed first, then (when shown) the done ones. */
export const activeGoals = (goals: GoalView[]) => goals.filter((g) => g.status !== 'done')

/**
 * The section's header: "GOALS n" (folds it), "· N done" (shows them), and "+" (adds one). With no
 * goals at all, just the title and "+". Empty while searching.
 */
export function goalsHead(goals: GoalView[], s: GoalsState, searching = false): string {
  if (searching) return ''
  const active = activeGoals(goals)
  const done = goals.length - active.length
  return `<div class="sechead ghead"><button class="label lfold" data-gfold aria-expanded="${!s.folded}">${CHEV}<span>Goals</span>${active.length ? `<span class="gc">${active.length}</span>` : ''}</button>${done ? `<button class="gdn${s.showDone ? ' on' : ''}" data-gdone aria-pressed="${s.showDone}">· ${done} done</button>` : ''}<button class="gplus" data-gadd aria-label="Add a goal" data-tip="Add a goal">+</button></div>`
}

/** One goal: its title and step count, and under it the next step (or "lead says done" while an agent proposes it). */
export function goalRow(g: GoalView, open: string | null): string {
  const done = g.status === 'done'
  const second = done
    ? ''
    : g.status === 'proposed'
      ? '<span class="nx says">lead says done</span>'
      : g.next
        ? `<span class="nx">${esc(g.next)}</span>`
        : '<span class="nx none">No next step yet</span>'
  const dot = g.working ? '<span class="wd" data-tip="An agent is working"></span>' : ''
  return `<button class="g${done ? ' fin' : ''}${open === g.id ? ' menu-open' : ''}" data-gopen="${esc(g.id)}" aria-haspopup="dialog" aria-expanded="${open === g.id}"><span class="m"><span class="ti">${esc(g.title)}</span>${second}</span>${dot}${stepProgress(g)}</button>`
}

/** The rows under the header: nothing while folded or empty; done goals only when the toggle shows them. */
export function goalsRows(goals: GoalView[], s: GoalsState, searching = false): string {
  if (searching || s.folded) return ''
  const done = goals.filter((g) => g.status === 'done')
  const shown = [...activeGoals(goals), ...(s.showDone ? done : [])]
  return shown.map((g) => goalRow(g, s.open)).join('')
}

// ---------- the card ----------

const editable = (field: string, id: string, value: string | undefined, placeholder: string, cls = 'ed') =>
  `<div class="${cls}" contenteditable="plaintext-only" spellcheck="false" role="textbox" aria-label="${esc(placeholder)}" data-gedit="${field}" data-g="${esc(id)}" data-ph="${esc(placeholder)}">${esc(value ?? '')}</div>`

/** A worktree link's text: its name, else the last part of its path. */
const worktreeName = (w: Goal['links']['worktrees'][number]) => w.name || (w.path ? w.path.split('/').filter(Boolean).pop() : '') || w.key || 'worktree'

/**
 * The details card of a goal: its title, next, steps (tick on click, one more can be added), note, done
 * criteria, links, and the foot with who changed it last and the buttons that fit its status.
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
      : `<button class="gbtn" data-gfinish="${esc(g.id)}">Mark done</button>`
  return [
    `<div class="gpart" data-part="title">${editable('title', g.id, g.title, 'Goal', 'ed ph')}</div>`,
    g.status === 'proposed' ? '<div class="gpart gsays" data-part="says">An agent says this is done. Is it?</div>' : '',
    `<div class="gpart f" data-part="next"><span class="k">Next</span>${editable('next', g.id, g.next, 'What is the next thing to do?')}</div>`,
    `<div class="gpart f" data-part="steps"><span class="k">Steps${g.steps.length ? ` · ${completedSteps(g)}/${g.steps.length}` : ''}</span><div class="steps">${steps}</div>${editable('newStep', g.id, '', 'Add a step', 'ed addstep')}</div>`,
    `<div class="gpart f" data-part="note"><span class="k">Note</span>${editable('note', g.id, g.note, 'Add a note', 'ed note')}</div>`,
    `<div class="gpart f" data-part="doneWhen"><span class="k">Done when</span>${editable('doneWhen', g.id, g.doneWhen, 'How will you know it is done?')}</div>`,
    `<div class="gpart f" data-part="links"><span class="k">Linked</span><div class="links">${links || '<span class="nolinks">No ticket or worktree</span>'}</div></div>`,
    `<div class="gpart pfoot${g.status === 'proposed' ? ' wrap' : ''}" data-part="foot"><span class="meta">${esc(lastChangeText(g, now))}</span>${buttons}</div>`
  ].join('')
}
