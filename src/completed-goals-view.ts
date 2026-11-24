// The Completed goals tab as HTML and rules: which goals match the search and filters, how a row, the details and the
// states read. Pure, no Node imports and no DOM: src/editor/goals-main.ts draws it and handles the clicks, the tests
// (completed-goals-view.test.ts) and scripts/goals-history-preview.mjs call it. Every goal text is untrusted: escaped when drawn.
import type { Goal, WorktreeLink } from '../skills/orca-flow/scripts/goals.d.mts'
import { agoText } from './goals-view.ts'

/** A completed goal as the tab gets it: the stored goal, and for each worktree link the workspace it still names (null: removed). */
export type CompletedGoal = Omit<Goal, 'links'> & { links: { linear: string[]; worktrees: (WorktreeLink & { workspaceId?: string | null })[] } }

/** What `goals.completed` answers. `on`: Settings → Features → Goals. */
export type CompletedWire = { on: boolean; goals: CompletedGoal[] }

/** Rows drawn per batch ("Show 50 more"). */
export const BATCH = 50
export const DAY = 86_400_000

export const WITHIN = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']] as const
export const LINKED = [['any', 'Any'], ['linear', 'Linear issue'], ['worktree', 'Worktree'], ['none', 'Nothing']] as const
export const SORT = [['new', 'Newest first'], ['old', 'Oldest first']] as const
export type Within = (typeof WITHIN)[number][0]
export type Linked = (typeof LINKED)[number][0]
export type Sort = (typeof SORT)[number][0]

/** What the person has set on the page. Only `within` and `sort` are kept between visits (UI_KEY). */
export type CompletedUi = {
  q: string
  within: Within
  linked: Linked
  sort: Sort
  /** Rows shown (batches of BATCH). */
  limit: number
  /** The goal whose details show. */
  sel: string | null
  /** The goal whose row is the list's one tab stop. */
  rove: string | null
  screen: 'list' | 'detail'
}

export const UI_KEY = 'goals-history-ui'
export const completedUi = (): CompletedUi => ({ q: '', within: 'all', linked: 'any', sort: 'new', limit: BATCH, sel: null, rove: null, screen: 'list' })
/** The part of the page kept between visits, read from storage: anything unknown is the default. */
export function savedUiOf(stored: unknown): Pick<CompletedUi, 'within' | 'sort'> {
  const s = (stored ?? {}) as Record<string, unknown>
  return { within: WITHIN.find(([v]) => v === s.within)?.[0] ?? 'all', sort: SORT.find(([v]) => v === s.sort)?.[0] ?? 'new' }
}

export type CompletedData = { phase: 'loading' | 'ready' | 'off'; goals: CompletedGoal[]; error: string | null }

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// ---------- goal facts ----------

/** When it was completed. Goals of the oldest files have no doneAt: their last update is the closest there is. */
export const doneAtOf = (g: Pick<CompletedGoal, 'doneAt' | 'updatedAt' | 'createdAt'>): number =>
  [g.doneAt, g.updatedAt, g.createdAt].find((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0) ?? 0

/** A worktree link's text: its name, else the last part of its path. */
export const worktreeName = (w: WorktreeLink): string => w.name || (w.path ? w.path.split('/').filter(Boolean).pop() : '') || w.key || 'worktree'

/**
 * Who completed it and which agent said it was done, as far as the file knows. Goals completed before doneBy was
 * recorded show nothing, except that the last change was the status change itself.
 */
export function completedBy(g: Pick<CompletedGoal, 'doneBy' | 'proposedBy' | 'lastChange' | 'status'>): { by: string | null; proposedBy: string | null } {
  const by = g.doneBy?.trim() || (g.status === 'done' && g.lastChange?.field === 'status' ? g.lastChange.by?.trim() : '') || null
  return { by, proposedBy: g.proposedBy?.trim() || null }
}

const linearUrl = (id: string) => `https://linear.app/issue/${encodeURIComponent(id)}`

// ---------- dates ----------

const LOCALE = 'en-US'
const yearOf = (t: number) => new Date(t).getFullYear()
/** "Nov 18", or "Nov 18, 2025" in another year than `now`. */
export const dateShort = (t: number, now: number) => new Date(t).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', ...(yearOf(t) !== yearOf(now) ? { year: 'numeric' } : {}) })
export const dateLong = (t: number) => new Date(t).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' })
export const dateTime = (t: number) => new Date(t).toLocaleString(LOCALE, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
export const monthOf = (t: number) => new Date(t).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' })
const took = (g: CompletedGoal) => {
  const d = Math.max(1, Math.round((doneAtOf(g) - g.createdAt) / DAY))
  return d === 1 ? '1 day' : `${d} days`
}
const nGoals = (n: number) => `${n.toLocaleString(LOCALE)} ${n === 1 ? 'goal' : 'goals'}`

// ---------- search and filters ----------

const FIELDS = [['title', 'Title'], ['note', 'Description'], ['doneWhen', 'Done when'], ['next', 'Next'], ['steps', 'Todo'], ['linear', 'Linear'], ['worktrees', 'Worktree']] as const
type Field = (typeof FIELDS)[number][0]
const textsOf = (g: CompletedGoal, f: Field): string[] =>
  f === 'steps' ? g.steps.map((s) => s.text) : f === 'linear' ? g.links.linear : f === 'worktrees' ? g.links.worktrees.map(worktreeName) : [g[f] ?? '']

const wordsOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean)

/** Where the search matched: the first field (title first) holding the first word; null: not every word is somewhere in the goal. */
export type Hit = { field: Field | null; label: string; text: string }
export function matchGoal(g: CompletedGoal, q: string): Hit | null {
  const words = wordsOf(q)
  if (!words.length) return { field: null, label: '', text: '' }
  const all = FIELDS.flatMap(([f]) => textsOf(g, f)).join('\n').toLowerCase()
  if (!words.every((w) => all.includes(w))) return null
  for (const [field, label] of FIELDS) for (const text of textsOf(g, field)) if (text.toLowerCase().includes(words[0])) return { field, label, text }
  return { field: null, label: '', text: '' }
}

/** `text` escaped, every search word in <mark>. With `around`, a long text starts shortly before the first word. */
export function highlight(text: string, q: string, around = false): string {
  const words = wordsOf(q)
  let s = text
  if (around && words.length) { const i = s.toLowerCase().indexOf(words[0]); if (i > 28) s = `…${s.slice(i - 24)}` }
  if (!words.length) return esc(s)
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
  let out = ''
  let last = 0
  for (const m of s.matchAll(re)) {
    out += `${esc(s.slice(last, m.index ?? 0))}<mark>${esc(m[0])}</mark>`
    last = (m.index ?? 0) + m[0].length
  }
  return out + esc(s.slice(last))
}

export type Row = { g: CompletedGoal; hit: Hit }

export const filtersOn = (ui: Pick<CompletedUi, 'q' | 'within' | 'linked'>) => ui.q.trim() !== '' || ui.within !== 'all' || ui.linked !== 'any'

/** The goals the search and filters leave, in the chosen order; `total` is every completed goal. */
export function filterCompleted(goals: CompletedGoal[], ui: Pick<CompletedUi, 'q' | 'within' | 'linked' | 'sort'>, now: number): { total: number; rows: Row[] } {
  const done = goals.filter((g) => g.status === 'done')
  const rows: Row[] = []
  for (const g of done) {
    if (ui.within !== 'all' && now - doneAtOf(g) > Number(ui.within) * DAY) continue
    const hasLinear = g.links.linear.length > 0
    const hasWorktree = g.links.worktrees.length > 0
    if (ui.linked === 'linear' && !hasLinear) continue
    if (ui.linked === 'worktree' && !hasWorktree) continue
    if (ui.linked === 'none' && (hasLinear || hasWorktree)) continue
    const hit = matchGoal(g, ui.q.trim())
    if (hit) rows.push({ g, hit })
  }
  rows.sort((a, b) => (ui.sort === 'new' ? doneAtOf(b.g) - doneAtOf(a.g) : doneAtOf(a.g) - doneAtOf(b.g)) || a.g.id.localeCompare(b.g.id))
  return { total: done.length, rows }
}

/** "No goal completed in the last 30 days and linked to a Linear issue matches “kubernetes”." */
export function noMatchText(ui: Pick<CompletedUi, 'q' | 'within' | 'linked'>): string {
  const parts: string[] = []
  if (ui.within !== 'all') parts.push(`completed in the last ${ui.within} days`)
  if (ui.linked !== 'any') parts.push(ui.linked === 'none' ? 'with nothing linked' : `linked to a ${ui.linked === 'linear' ? 'Linear issue' : 'worktree'}`)
  const q = ui.q.trim()
  return `No goal${parts.length ? ` ${parts.join(' and ')}` : ''}${q ? ` matches “${q}”` : ' fits these filters'}.`
}

// ---------- pieces ----------

const CHEV = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3.5 2l3 3-3 3"/></svg>'
const CHECK = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 5.4L4 7.6L8.2 2.6"/></svg>'
const XS = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8"/></svg>'
export const MAG = '<svg class="mag" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5L14 14" stroke-linecap="round"/></svg>'
const BRANCH = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="3.5" cy="2.8" r="1.4"/><circle cx="3.5" cy="9.2" r="1.4"/><circle cx="8.8" cy="4.2" r="1.4"/><path d="M3.5 4.2v3.6M8.8 5.6c0 2-2.2 2.2-5.3 2.2"/></svg>'

function progress(g: CompletedGoal): string {
  const total = g.steps.length
  if (!total) return ''
  const done = g.steps.filter((s) => s.done).length
  const arc = done ? `<circle cx="7" cy="7" r="5.5" pathLength="${total}" stroke-dasharray="${done} ${total}" transform="rotate(-90 7 7)"/>` : ''
  return `<span class="gprogress"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14"><circle class="track" cx="7" cy="7" r="5.5"/>${arc}</svg><span>${done}/${total}</span></span>`
}

/** The link pills of a row: plain, the row itself is the button. */
const chips = (g: CompletedGoal) => [
  ...g.links.linear.map((id) => `<span class="lchip"><span class="mono">${esc(id)}</span></span>`),
  ...g.links.worktrees.map((w) => `<span class="lchip">${BRANCH}${esc(worktreeName(w))}</span>`)
].join('')

/** The link pills of the details: a Linear id opens the issue, a worktree that still exists is shown; a removed one is faint. */
const detailChips = (g: CompletedGoal) => [
  ...g.links.linear.map((id) => `<button class="lchip link" data-url="${esc(linearUrl(id))}" title="Open ${esc(id)} in Linear" aria-label="Open ${esc(id)} in Linear"><span class="mono">${esc(id)}</span></button>`),
  ...g.links.worktrees.map((w) => w.workspaceId
    ? `<button class="lchip link" data-wt="${esc(w.workspaceId)}" title="Go to worktree ${esc(worktreeName(w))}" aria-label="Go to worktree ${esc(worktreeName(w))}">${BRANCH}${esc(worktreeName(w))}</button>`
    // null: no workspace shows it any more. undefined: the workspaces were not read, nothing is claimed.
    : w.workspaceId === null
      ? `<span class="lchip gone" title="Worktree removed">${BRANCH}${esc(worktreeName(w))}</span>`
      : `<span class="lchip">${BRANCH}${esc(worktreeName(w))}</span>`)
].join('')

const seg = (k: 'within' | 'linked' | 'sort', label: string, opts: readonly (readonly [string, string])[], current: string) =>
  `<span class="fgroup"><span class="flabel" id="fl-${k}">${label}</span><span class="seg" role="group" aria-labelledby="fl-${k}">${opts.map(([v, t]) => `<button data-f="${k}" data-v="${v}" aria-pressed="${current === v}">${t}</button>`).join('')}</span></span>`

export const filtersHtml = (ui: CompletedUi) => seg('within', 'Completed', WITHIN, ui.within) + seg('linked', 'Linked to', LINKED, ui.linked) + seg('sort', 'Sort', SORT, ui.sort)

/** What sits at the right end of the search box: a × once there is text, else the "/" hint. */
export const searchSideHtml = (q: string) => q ? `<button class="clear" data-clear-q aria-label="Clear search">${XS}</button>` : '<kbd aria-hidden="true">/</kbd>'

const headHtml = (total: number | null) => `<div class="vhead"><h1>Completed goals</h1>${total === null ? '' : `<span class="gc">${total.toLocaleString(LOCALE)}</span>`}</div>`

// ---------- a row ----------

function rowHtml({ g, hit }: Row, ui: CompletedUi, now: number, tabStop: boolean, locked: boolean): string {
  const at = doneAtOf(g)
  const q = ui.q.trim()
  const hitLine = q && hit.field && hit.field !== 'title' ? `<span class="hit"><span class="hf">${hit.label}:</span> ${highlight(hit.text, q, true)}</span>` : ''
  const second = hitLine || progress(g) + chips(g)
  const todo = g.steps.length ? `, ${g.steps.filter((s) => s.done).length} of ${g.steps.length} todos done` : ''
  const links = [...g.links.linear, ...g.links.worktrees.map(worktreeName)]
  const label = `${g.title}, completed ${dateLong(at)}${todo}${links.length ? `, linked to ${links.join(', ')}` : ''}`
  const sel = ui.sel === g.id
  const tab = tabStop ? 0 : -1
  return `<li class="crow${sel ? ' sel' : ''}" data-id="${esc(g.id)}">`
    + `<button class="copen" data-open="${esc(g.id)}" tabindex="${tab}" aria-label="${esc(label)}"${sel ? ' aria-current="true"' : ''} aria-controls="dpane">`
    + `<span class="l1"><span class="ti">${highlight(g.title, q)}</span><span class="dt" title="${esc(dateTime(at))}">${dateShort(at, now)}</span></span>`
    + `${second ? `<span class="l2">${second}</span>` : ''}</button>`
    + `<button class="gbtn quiet rbtn" data-reopen="${esc(g.id)}" tabindex="${tab}" aria-label="Reopen ${esc(g.title)}"${locked ? ' disabled' : ''}>Reopen</button></li>`
}

function listHtml(rows: Row[], ui: CompletedUi, now: number, locked: boolean): string {
  const shown = rows.slice(0, ui.limit)
  const stop = shown.some((r) => r.g.id === ui.rove) ? ui.rove : shown[0]?.g.id
  const counts = new Map<string, number>()
  for (const { g } of rows) counts.set(monthOf(doneAtOf(g)), (counts.get(monthOf(doneAtOf(g))) ?? 0) + 1)
  let html = ''
  let month = ''
  let group: string[] = []
  const flush = () => { if (group.length) html += `<ul class="crows" aria-labelledby="mh-${month.replace(/\W/g, '')}">${group.join('')}</ul>`; group = [] }
  for (const r of shown) {
    const m = monthOf(doneAtOf(r.g))
    if (m !== month) { flush(); month = m; html += `<h2 class="month label" id="mh-${m.replace(/\W/g, '')}">${esc(m)}<span class="n">${counts.get(m)}</span></h2>` }
    group.push(rowHtml(r, ui, now, r.g.id === stop, locked))
  }
  flush()
  if (rows.length > ui.limit) html += `<div class="more"><button class="gbtn quiet" data-more>Show ${Math.min(BATCH, rows.length - ui.limit)} more</button><span>Showing ${ui.limit.toLocaleString(LOCALE)} of ${rows.length.toLocaleString(LOCALE)}</span></div>`
  return `<section class="clist" aria-label="Completed goals list">${html}</section>`
}

// ---------- the details ----------

/** The details of one goal: the pane beside the list (`screen` false), or the screen that replaces it on a narrow tab. Read-only. */
export function detailHtml(g: CompletedGoal | null, screen: boolean, now: number, locked = false): string {
  if (!g) return '<aside class="dpane placeholder" id="dpane" aria-label="Goal details">Select a goal to see its details.</aside>'
  const at = doneAtOf(g)
  const { by, proposedBy } = completedBy(g)
  const total = g.steps.length
  const steps = total
    ? `<ul class="steps">${g.steps.map((s) => `<li class="step${s.done ? ' done' : ''}"><span class="box" aria-hidden="true">${CHECK}</span><span class="s">${esc(s.text)}</span><span class="sr">${s.done ? ', done' : ', not done'}</span></li>`).join('')}</ul>`
    : '<span class="v none">No todos</span>'
  const links = detailChips(g)
  const field = (k: string, v: string | undefined, cls = '') => `<div class="f"><span class="k">${k}</span>${v?.trim() ? `<span class="v ${cls}">${esc(v)}</span>` : '<span class="v none">None</span>'}</div>`
  const body = `<h2 class="dtitle" id="dtitle">${esc(g.title)}</h2>`
    + `<div class="dstat"><span class="okc">${CHECK}Completed</span><span title="${esc(dateTime(at))}">${dateLong(at)}${by ? ` by ${esc(by)}` : ''} · ${agoText(at, now)}</span>${proposedBy ? `<span>${esc(proposedBy)} said it was done</span>` : ''}</div>`
    + field('Description', g.note, 'note')
    + field('Done when', g.doneWhen)
    + `<div class="f"><span class="k">Todos${total ? ` · ${g.steps.filter((s) => s.done).length}/${total}` : ''}</span>${steps}</div>`
    + `<div class="f"><span class="k">Links</span>${links ? `<div class="dlinks">${links}</div>` : '<span class="v none">No ticket or worktree</span>'}</div>`
    + `<div class="dfoot"><span class="meta">Added ${dateLong(g.createdAt)} · took ${took(g)}</span><button class="gbtn" data-reopen="${esc(g.id)}"${locked ? ' disabled' : ''}>Reopen</button></div>`
  return screen
    ? `<div class="vhead"><button class="back" data-backto>${CHEV}<span>Completed goals</span></button></div><article class="dscreen" aria-labelledby="dtitle">${body}</article>`
    : `<aside class="dpane" id="dpane" aria-labelledby="dtitle" tabindex="-1">${body}</aside>`
}

// ---------- the toast ----------

export type Undo = { id: string; title: string; doneAt: number; proposedBy: string | null }
export type Toast = { kind: 'reopened'; title: string; undo: Undo } | { kind: 'undone'; title: string } | { kind: 'error'; text: string }
export const toastHtml = (t: Toast): string => {
  const text = t.kind === 'reopened' ? `Reopened <b>“${esc(t.title)}”</b>. It’s back in Goals.` : t.kind === 'undone' ? `<b>“${esc(t.title)}”</b> is completed again.` : esc(t.text)
  return `<div class="toast" role="status"><span class="t">${text}</span>${t.kind === 'reopened' ? '<button class="undo" data-undo>Undo</button>' : ''}<button class="x" data-dismiss aria-label="Dismiss">${XS}</button></div>`
}

// ---------- the page ----------

/** The static frame the tab draws into once; the parts below fill it. */
export const SKELETON = `<div id="head"></div>
<div class="tools" id="tools" role="search" hidden>
  <div class="search">${MAG}<input id="q" type="search" placeholder="Search titles, descriptions, todos, links" aria-label="Search completed goals" aria-describedby="count" autocomplete="off" spellcheck="false"><span id="qside"></span></div>
  <div class="filters" id="filters"></div>
</div>
<div class="countline" id="count"></div>
<div id="body"></div>`

export type Parts = { head: string; tools: boolean; filters: string; side: string; count: string; body: string; countText: string }

/**
 * Everything the page shows, in the parts of SKELETON. `error`: the last read failed; goals read before stay, and Reopen waits for a read that works.
 */
export function completedParts(data: CompletedData, ui: CompletedUi, now: number): Parts {
  const blank = { filters: '', side: '', count: '', countText: '' }
  const banner = data.error ? `<div class="banner bad" role="alert"><b>Could not read goals.</b><span>${esc(data.error.split('\n')[0])}</span><button class="cta" data-retry>Try again</button></div>` : ''
  if (data.phase === 'loading' && !data.error) return { ...blank, head: headHtml(null), tools: false, body: '<div class="note" role="status">Reading goals…</div>' }
  if (data.phase === 'off') return { ...blank, head: headHtml(null), tools: false, body: '<div class="empty-state"><h2>Goals is turned off</h2><p>Turn on Goals in Orca Flow Settings → Features to see your completed goals here.</p></div>' }
  const { total, rows } = filterCompleted(data.goals, ui, now)
  if (data.error && !data.goals.length) return { ...blank, head: headHtml(null) + banner, tools: false, body: '' }
  const sel = ui.sel ? data.goals.find((g) => g.id === ui.sel && g.status === 'done') ?? null : null
  const locked = !!data.error
  if (ui.screen === 'detail' && sel) return { ...blank, head: banner, tools: false, body: detailHtml(sel, true, now, locked) }
  if (!total) return { ...blank, head: headHtml(0) + banner, tools: false, body: '<div class="empty-state"><h2>No completed goals yet</h2><p>When you mark a goal done in the sidebar, it moves here. You can search it later and reopen it.</p></div>' }
  const countText = filtersOn(ui)
    ? `${rows.length.toLocaleString(LOCALE)} of ${nGoals(total)} match`
    : `${nGoals(total)}, ${ui.sort === 'new' ? 'newest' : 'oldest'} first`
  const count = filtersOn(ui)
    ? `<span><b>${rows.length.toLocaleString(LOCALE)}</b> of ${nGoals(total)} match</span>${rows.length ? '<button class="cta" data-clear-all>Clear filters</button>' : ''}`
    : `<span>${countText}</span>`
  const body = rows.length
    ? `<div class="split">${listHtml(rows, ui, now, locked)}${detailHtml(sel && rows.some((r) => r.g.id === sel.id) ? sel : null, false, now, locked)}</div>`
    : `<div class="empty-state flat"><h2>No goals match</h2><p>${esc(noMatchText(ui))}</p><button class="gbtn quiet" data-clear-all>Clear filters</button></div>`
  return { head: headHtml(total) + banner, tools: true, filters: filtersHtml(ui), side: searchSideHtml(ui.q), count, countText, body }
}
