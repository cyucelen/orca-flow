// Wires the panel: asks the worker for snapshots, redraws with src/view.ts, handles clicks.
// All UI state (what is open or folded) lives here; the worker only sends data, and reads the folds
// from storage for Option+1..9.
import type { AgentInfo, CockpitStats, Coordinator, LinearData, LinearIssue, LinearWire, Look, Priority, Snapshot, WakeOutcome, WorkspaceRow } from '../protocol.ts'
import { busy, character, chatDigit, chatTargets, coordinatorCharacter, coordinatorOrder, crew, emptyUi, esc, faceOf, FOLDED_KEY, finishedAgents, freeLooks, projectDot, render, updateButton, wakeView, type WakeMenu } from '../view.ts'
import { decodeLinear, DEFAULT_DISPLAY, FILTERS, GROUP_NAME, GROUPS, HIDEABLE, LINEAR_MARK, LINEAR_UI_KEY, linearUiOf, sendTargets, SORT_NAME, SORTS, STATE_NAME, toggleProject, viewOf, type Display, type LinearFilter } from '../linear.ts'
import { pressGate } from './press.ts'
import { openerToggle } from './opener.ts'
import { externalLink } from './links.ts'
import { canRemove } from '../rank.ts'
import { sessionChoices } from '../coordinator-sessions.ts'
import { providerBadge } from '../providers.ts'

const ui = emptyUi()
let snap: Snapshot | null = null
/** The Linear section's data; null hides the section (Linear not connected, or not read yet). */
let linear: LinearData | null = null
const $ = (id: string) => document.getElementById(id)!
const cockpitEl = $('cockpit')
const mainEl = $('main')
const footerEl = $('footer')
const attentionEl = $('attention')
const searchEl = $('search') as HTMLInputElement
const searchBox = $('searchbox')
const searchOpen = $('search-open')
const copenEl = $('copen')
const updateEl = $('update-slot')
const linearEl = $('linear')
const toastEl = $('toast')

const openedAt = Date.now()
/** How long the panel waits for the coordinator lineage before showing agents without it. */
const LINEAGE_WAIT_MS = 8000

function paint(): void {
  paintRows()
  keepAnimationPhase()
}

/**
 * A paint replaces the rows, so each new spinner starts again at 0° and jumps back.
 * Start every CSS animation at the origin of the timeline, so a new spinner continues at the phase of the old one.
 */
function keepAnimationPhase(): void {
  for (const a of document.getAnimations()) if (a instanceof CSSAnimation) a.startTime = 0
}

function paintRows(): void {
  if (!snap) return
  updateEl.innerHTML = searchBox.hidden ? updateButton(snap.update) : ''
  // Until the worker knows who each agent works for, agents would show under You and then jump to
  // their coordinator; keep the loader instead, for a few seconds at most.
  if (snap.ready === false && Date.now() - openedAt < LINEAGE_WAIT_MS) {
    mainEl.innerHTML = crew('Loading workspaces…')
    return
  }
  ui.now = Date.now()
  const { cockpit, copen, main, attention, linear: linearHtml, footer } = render(snap, ui, linear)
  cockpitEl.innerHTML = cockpit
  copenEl.innerHTML = copen
  copenEl.hidden = !copen // an empty slot would still take a gap in the column
  mainEl.innerHTML = main
  // What asks you, pinned under the tree, so the tree never moves when an ask comes or goes.
  attentionEl.innerHTML = attention
  attentionEl.hidden = !attention
  // Linear, pinned under Up next: its own scroll area while open, one header row while folded.
  linearEl.innerHTML = linearHtml
  linearEl.hidden = !linearHtml
  linearEl.classList.toggle('folded', ui.linearFolded)
  footerEl.innerHTML = footer
  footerEl.hidden = !footer
  if (typeof markTarget === 'function') markTarget()
}

// Every redraw goes through the gate: one landing mid-press would replace the pressed row, and the
// browser then drops the click (src/panel/press.ts).
const gate = pressGate(paint)
const draw = (): void => gate.draw()
document.addEventListener('pointerdown', () => gate.down(), true)
document.addEventListener('pointerup', () => gate.up(), true)
document.addEventListener('pointercancel', () => gate.up(), true)

function toggle(set: Set<string>, key: string): void {
  set.has(key) ? set.delete(key) : set.add(key)
}

// The first snapshot can take a few seconds (Orca's CLI is slow on a busy machine).
mainEl.innerHTML = crew('Loading workspaces…')
setTimeout(draw, LINEAGE_WAIT_MS)
orca.plugin.request('sidebar.list').then((s) => ((snap = s as Snapshot), draw())).catch((e: Error) => (mainEl.innerHTML = `<div class="empty">Could not load workspaces: ${e.message}</div>`))
orca.plugin.on('sidebar.changed', (s) => ((snap = s as Snapshot), draw()))
// Relative times ("4m") stay current.
setInterval(draw, 60_000)

// Linear: read once a minute while the panel shows (the worker answers from its cache when it is
// fresh); a send or a new read is posted. The fold and the filter come back from storage.
const readLinear = (force = false) => {
  if (document.visibilityState !== 'visible') return
  orca.plugin.request('sidebar.linear', { force }).then((d) => { linear = decodeLinear(d); draw() }).catch(() => null)
}
orca.plugin.on('sidebar.linearChanged', (d) => { linear = decodeLinear(d as LinearWire | null); draw() })
orca.storage.get(LINEAR_UI_KEY).then((stored) => {
  const saved = linearUiOf(stored)
  ui.linearFolded = saved.folded
  ui.linearFilter = saved.filter
  ui.linearDisplay = saved.display
  ui.linearGroupFolds = new Set(saved.groupFolds)
  draw()
}).catch(() => null)
readLinear()
setInterval(readLinear, 60_000)
document.addEventListener('visibilitychange', () => readLinear())
const saveLinearUi = () =>
  void orca.storage.set(LINEAR_UI_KEY, { folded: ui.linearFolded, filter: ui.linearFilter, display: ui.linearDisplay, groupFolds: [...ui.linearGroupFolds] }).catch(() => null)
// No Orca event reports a switch between tabs of one workspace. While the panel shows, the worker
// looks every 2 s (one quick `orca terminal list`) and posts sidebar.changed only when the front tab moved.
const lookAtFocus = () => { if (document.visibilityState === 'visible') void orca.plugin.request('sidebar.focus').catch(() => null) }
setInterval(lookAtFocus, 2000)
document.addEventListener('visibilitychange', lookAtFocus)

document.addEventListener('click', (event) => {
  // A finished row's remove button: the same confirm and inline progress as the menu's Remove worktree.
  const rm = (event.target as Element).closest<HTMLElement>('[data-remove]')
  if (rm?.dataset.remove && snap) {
    const row = snap.rows.find((r) => r.id === rm.dataset.remove)
    if (row) void removeWorktree(row, rm.dataset.target ?? `agent:${row.id}`)
    return
  }
  // The top bar's update button: confirm, then the worker updates (or, needing approval, the command).
  const upd = (event.target as Element).closest<HTMLElement>('[data-update]')
  if (upd) {
    void updateClick()
    return
  }
  // The Linear section: fold, filter, display options, groups, the folds at its end, and a row's send menu.
  const lin = (event.target as Element).closest<HTMLElement>('[data-lfold],[data-lfilter],[data-lmore],[data-lsend],[data-lgroup],[data-ldisplay],[data-lprojects-clear]')
  if (lin) {
    const d = lin.dataset
    if ('lfold' in d) { ui.linearFolded = !ui.linearFolded; saveLinearUi() }
    if (d.lfilter && FILTERS.includes(d.lfilter as LinearFilter)) { ui.linearFilter = d.lfilter as LinearFilter; saveLinearUi() }
    if (d.lmore) toggle(ui.unfolded, d.lmore)
    if (d.lgroup) { toggle(ui.linearGroupFolds, d.lgroup); saveLinearUi() }
    if ('lprojectsClear' in d) { ui.linearDisplay = { ...ui.linearDisplay, projects: [] }; saveLinearUi() }
    // A second click on the button closes its menu: the press already did, and the click must not open it again.
    if ('ldisplay' in d) { if (opener.shouldOpen('display')) openMenu(displayMenu, 0, 0, 'display', lin.getBoundingClientRect(), 'display'); return }
    if (d.lsend) { if (opener.shouldOpen(`linear:${d.lsend}`)) openMenu(sendMenu(d.lsend), 0, 0, `linear:${d.lsend}`, lin.getBoundingClientRect()); return }
    draw()
    return
  }
  // A row's PR icon opens the PR, and its Linear label the issue, not the row's session (links.ts).
  const url = externalLink(event.target as Element)
  if (url) {
    void orca.shell?.openExternal(url)
    return
  }
  const el = (event.target as Element).closest<HTMLElement>('[data-open],[data-sessions],[data-history],[data-brief],[data-fold],[data-unfold],[data-act],[data-yes],[data-no],[data-coordinator],[data-new-coordinator],[data-cockpit]')
  if (!el) return
  const d = el.dataset
  if (d.sessions) { if (opener.shouldOpen(`sessions:${d.sessions}`)) showSessionPicker(d.sessions); return }
  if (d.history && d.member) { void showHistory(d.history, d.member, d.historyTerminal, d.historySession); return }
  // One action at a time; opening, folding and briefs still work while one runs.
  const action = d.act ?? d.yes
  if (ui.pending && action) {
    ui.notice = { key: action, text: 'Wait: another action is still running', ok: false }
    draw()
    return
  }
  if (ui.notice && !ui.notice.ok) ui.notice = null // an error stays until the next click
  for (const [k, st] of ui.status) if (st.tone === 'bad') ui.status.delete(k)
  if (d.act) ui.confirming = d.act
  if ('no' in d) ui.confirming = null
  if (d.yes) { void runAction(d.yes); return }
  if ('cockpit' in d) toggleCockpit()
  if (d.open) {
    void orca.plugin.request('sidebar.open', d.terminal ? { workspaceId: d.open, terminal: d.terminal } : { workspaceId: d.open })
    return
  }
  if (d.coordinator) {
    if (toastEl.contains(el)) hideToast()
    void wake(d.coordinator)
    return
  }
  if ('newCoordinator' in d) { openModal(); return }
  if (d.brief) {
    // The first briefing is open by default; remember what the person changed either way.
    const isOpen = el.getAttribute('aria-expanded') === 'true'
    if (isOpen) { ui.opened.delete(d.brief); ui.closed.add(d.brief) } else { ui.closed.delete(d.brief); ui.opened.add(d.brief) }
  }
  if (d.fold) {
    toggle(ui.folded, d.fold)
    sendFolds()
  }
  if (d.unfold) {
    // One footer fold open at a time keeps the footer from taking over the panel (the Linear section's folds are its own).
    const wasOpen = ui.unfolded.has(d.unfold)
    for (const k of [...ui.unfolded]) if (!k.startsWith('linear-')) ui.unfolded.delete(k)
    if (!wasOpen) ui.unfolded.add(d.unfold)
  }
  draw()
})

function loadStats(): void {
  ui.statsLoading = true
  orca.plugin.request('sidebar.cockpit').then((stats) => {
    ui.stats = stats as CockpitStats
  }).catch((e: Error) => { ui.notice = { key: 'load', text: e.message, ok: false } }).finally(() => {
    ui.statsLoading = false
    draw()
  })
}

function toggleCockpit(): void {
  ui.cockpitOpen = !ui.cockpitOpen
  ui.confirming = null
  ui.notice = null
  // The last stats stay on screen while new ones load; the first open shows a skeleton.
  if (ui.cockpitOpen) loadStats()
}

/** Runs a confirmed action, shows its result in place, then reloads the stats. */
async function runAction(key: string): Promise<void> {
  ui.confirming = null
  ui.pending = key
  draw()
  try {
    if (key === 'closeall' && snap) {
      // Every finished session (a lead waiting on its workers, or not yet reported, is not one).
      const panes = finishedAgents(snap.rows).map((a) => a.paneKey)
      const { closed } = await orca.plugin.request('sidebar.closeSessions', { panes })
      ui.notice = { key, text: `${closed} asleep`, ok: closed > 0 }
    } else if (key.startsWith('close:')) {
      const { closed } = await orca.plugin.request('sidebar.closeSessions', { panes: [key.slice(6)] })
      ui.notice = { key, text: closed ? 'Asleep' : 'Could not sleep it', ok: closed > 0 }
    } else if (key.startsWith('remove:')) {
      const r = await orca.plugin.request('sidebar.removeWorktree', { workspaceId: key.slice(7) })
      ui.notice = { key, text: r.removed ? 'Removed' : `Kept: ${r.reason ?? 'refused'}`, ok: r.removed }
    }
  } catch (e) {
    ui.notice = { key, text: (e as Error).message, ok: false }
  }
  ui.pending = null
  draw()
  if (ui.cockpitOpen) loadStats()
  // Successes fade; errors stay until the next click.
  if (ui.notice?.ok) setTimeout(() => { if (ui.notice?.key === key && ui.notice.ok) { ui.notice = null; draw() } }, 2500)
}

/**
 * The update button. A new release (or a failed try) asks first, then the worker starts the update
 * as the status bar's second click does; the button follows the state the worker posts. An update
 * that needs approval is never approved from here: the dialog shows the command to run.
 */
async function updateClick(): Promise<void> {
  const st = snap?.update
  if (!st) return
  if (st.kind === 'available' || st.kind === 'confirm' || st.kind === 'failed') {
    if (!(await confirmAction('update', `Update Orca Flow to ${st.version}?`, 'Orca Flow restarts on the new version.', 'Update', 'download', 'warn', false))) return
    await orca.plugin.request('sidebar.update').catch(() => null)
  } else if (st.kind === 'approval') {
    const copy = await confirmAction('update-approval', `Orca Flow ${st.version} needs your approval`, `${st.reason}\nTo approve and update, run:\n${st.command}`, 'Copy command', 'warning', 'warn', false)
    if (copy) await navigator.clipboard?.writeText(st.command).catch(() => {})
  }
}

// Search is its own control: it expands inline over the cockpit row and gives it back on close.
function setSearching(on: boolean): void {
  searchBox.hidden = !on
  cockpitEl.hidden = on
  searchOpen.hidden = on
  updateEl.hidden = on
  if (on) { ui.cockpitOpen = false; searchEl.focus() } else { searchEl.value = ''; ui.query = '' }
  draw()
}
searchOpen.addEventListener('click', () => setSearching(true))
$('search-close').addEventListener('click', () => setSearching(false))
searchEl.addEventListener('input', () => { ui.query = searchEl.value.trim(); draw() })
searchEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSearching(false) })

// ---------- Option+1..9: open the nth chat of the tree ----------
// Orca runs the chat.N commands (contributes.keybindings) anywhere outside this panel. Keys pressed
// in the panel stay in its frame, so it opens the chat itself, the way a click on the row does.

/** The worker numbers the chats too, and a folded group gives its team's numbers away: store the folds where it reads them. */
function sendFolds(): void {
  void orca.storage.set(FOLDED_KEY, [...ui.folded]).catch(() => null)
}
sendFolds()

function openNth(n: number): void {
  const t = snap ? chatTargets(snap, ui.folded)[n - 1] : undefined
  if (!t) return
  if ('coordinator' in t) void wake(t.coordinator)
  else void orca.plugin.request('sidebar.open', t.terminal ? { workspaceId: t.workspaceId, terminal: t.terminal } : { workspaceId: t.workspaceId })
}

document.addEventListener('keydown', (e) => {
  // Typing in the search or name field keeps its characters.
  if ((e.target as Element).closest('input, textarea')) return
  const n = chatDigit(e)
  if (n === null) return
  e.preventDefault()
  openNth(n)
})

// ---------- tooltips (cockpit gauges, character status) ----------
// One floating element for every [data-tip], in its tone: shown after a short hover, at once on keyboard
// focus, placed below the target (above when there is no room) and kept inside the panel.
const tip = document.createElement('div')
tip.className = 'tip'
tip.setAttribute('role', 'tooltip')
document.body.append(tip)
let tipTarget: HTMLElement | null = null
let tipTimer: ReturnType<typeof setTimeout> | undefined

function showTip(target: HTMLElement): void {
  const text = target.dataset.tip
  if (!text) return
  tipTarget = target
  // A command in the update button's tip wraps at its spaces, never at its dashes.
  tip.textContent = 'update' in target.dataset ? text.replace(/-/g, '\u2011') : text
  tip.className = `tip on ${target.dataset.tone ?? ''}`
  const r = target.getBoundingClientRect()
  const t = tip.getBoundingClientRect()
  const below = r.bottom + 6 + t.height <= window.innerHeight
  const top = below ? r.bottom + 6 : r.top - 6 - t.height
  const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8)
  tip.style.top = `${Math.max(8, top)}px`
  tip.style.left = `${left}px`
}

function hideTip(): void {
  clearTimeout(tipTimer)
  tipTarget = null
  tip.className = 'tip'
}

document.addEventListener('pointerover', (e) => {
  const target = (e.target as Element).closest<HTMLElement>('[data-tip]')
  if (target === tipTarget) return
  hideTip()
  if (target) tipTimer = setTimeout(() => showTip(target), 350)
})
document.addEventListener('pointerleave', hideTip)

// A memory tile and its legend pill light up together; the sliver of small consumers with all their pills.
let lit = ''
document.addEventListener('pointerover', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-use]')
  const use = el?.dataset.use ?? '', within = el?.dataset.in ?? ''
  if (`${use}|${within}` === lit && (!use || document.querySelector('.lit'))) return
  for (const x of document.querySelectorAll('.lit')) x.classList.remove('lit')
  lit = `${use}|${within}`
  if (!use) return
  const q = (v: string) => CSS.escape(v)
  for (const x of document.querySelectorAll(`[data-use="${q(use)}"],[data-in="${q(use)}"]${within ? `,[data-use="${q(within)}"]` : ''}`)) x.classList.add('lit')
})
document.addEventListener('focusin', (e) => {
  const target = (e.target as Element).closest<HTMLElement>('[data-tip]')
  target ? showTip(target) : hideTip()
})
document.addEventListener('scroll', hideTip, true)
document.addEventListener('pointerdown', hideTip)

// ---------- New coordinator modal ----------
// Static DOM (not redrawn), so typing is never interrupted by a snapshot. Just a name and a
// character; the coordinator learns its projects later, when you tell it.
const modal = $('modal')
const form = $('coord-form') as HTMLFormElement
const nameEl = $('coord-name') as HTMLInputElement
const lookEl = $('coord-look')
const errorEl = $('coord-error')
const createEl = $('coord-create') as HTMLButtonElement
let look: Look | null = null

function showError(text: string | null): void {
  errorEl.textContent = text ?? ''
  errorEl.hidden = !text
}

/** A random character no other coordinator has, different from the one shown. */
function shuffle(): void {
  const free = freeLooks(snap?.coordinators ?? []).filter((l) => !look || l.color !== look.color || l.shape !== look.shape)
  look = free.length ? free[Math.floor(Math.random() * free.length)] : look
  if (look) lookEl.innerHTML = character(look.color, look.shape, 'done', 56, false)
}

function openModal(): void {
  form.reset()
  showError(null)
  createEl.disabled = false
  createEl.textContent = 'Create'
  look = null
  shuffle()
  modal.hidden = false
  nameEl.focus()
}

function closeModal(): void {
  modal.hidden = true
}

$('coord-shuffle').addEventListener('click', shuffle)
$('coord-cancel').addEventListener('click', closeModal)
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })
modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal() })
nameEl.addEventListener('input', () => showError(null))

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = nameEl.value.trim()
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(name)) { showError('Lowercase letters, digits and dashes'); nameEl.focus(); return }
  createEl.disabled = true
  createEl.innerHTML = busy('Creating…')
  try {
    const r = await orca.plugin.request('sidebar.createCoordinator', { name, look: look! }, { timeoutMs: 90_000 })
    if (r.ok) closeModal()
    else showError(r.error ?? 'Could not create it')
  } catch (err) {
    showError((err as Error).message)
  }
  createEl.disabled = false
  createEl.textContent = 'Create'
})

// ---------- context menu ----------
// Right-click an agent or a coordinator. Destructive items ask first, with "Don't ask again"
// remembered per action in the plugin's storage.
const ctx = $('ctx')
/**
 * `iconHtml` (a character, Linear's mark) replaces the named icon; `right` is a quiet note at the
 * end, in the accent when `accent`; `checked` makes it a checkbox; `stay` keeps the menu open and
 * draws it again after it runs (the Display popover).
 */
type Action = { label: string; icon?: string; iconHtml?: string; right?: string; accent?: boolean; checked?: boolean; stay?: boolean; run?: () => void | Promise<void>; danger?: boolean }
/** A row of toggles inside the menu (Priority): no submenu, so nothing overlaps in a narrow sidebar. `wrap` lets many chips wrap. */
type Chips = { chips: string; icon?: string; iconHtml?: string; stay?: boolean; wrap?: boolean; options: { label: string; active: boolean; run: () => void | Promise<void> }[] }
/** A line of text heading the menu; `header` is HTML, escaped by whoever builds it; `tip` is its tooltip (text). */
type Header = { header: string; tip?: string }
type MenuItem = Action | Chips | Header | 'separator'

// Icons in Orca's menu style (16px outline).
const MI: Record<string, string> = {
  open: '<path d="M7 17 17 7M8 7h9v9"/>',
  flag: '<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>',
  pr: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M6 8.2v7.6M18 15.8V9a3 3 0 0 0-3-3h-4m0 0 2.5-2.5M11 6l2.5 2.5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  shuffle: '<path d="M3 7h3c4 0 5 10 9 10h6m-3-3 3 3-3 3M3 17h3c1.5 0 2.5-1.3 3.4-3M14.6 10C15.5 8.3 16.5 7 18 7h3m-3-3 3 3-3 3"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
  group: '<path d="M4 6h16M4 12h11M4 18h7"/>',
  sort: '<path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.75"/>',
  warning: '<path d="M12 4 21.5 20h-19Z"/><path d="M12 10v4.5M12 17.2v.1"/>'
}
const svgIcon = (name?: string) => (name ? `<svg class="micon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${MI[name]}</svg>` : '<span class="micon"></span>')
const iconOf = (it: { icon?: string; iconHtml?: string }) => (it.iconHtml ? `<span class="micon">${it.iconHtml}</span>` : svgIcon(it.icon))


/** Confirms a destructive action unless the person said not to ask again for this kind. */
async function confirmAction(kind: string, title: string, text: string, okLabel: string, icon = 'trash', tone: 'danger' | 'warn' = 'danger', rememberable = true): Promise<boolean> {
  const skip = ((await orca.storage.get('skipConfirm').catch(() => null)) ?? {}) as Record<string, boolean>
  if (rememberable && skip[kind]) return true
  const dialog = $('confirm')
  const form = $('confirm-form') as HTMLFormElement
  const remember = $('confirm-remember') as HTMLInputElement
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  $('confirm-ok').textContent = okLabel
  $('confirm-ok').className = `btn ${tone}`
  $('confirm-icon').className = `dialog-icon ${tone}`
  $('confirm-icon').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${MI[icon]}</svg>`
  remember.checked = false
  ;(remember.closest('label') as HTMLElement).hidden = !rememberable
  dialog.hidden = false
  ;($('confirm-cancel') as HTMLButtonElement).focus()
  return new Promise((resolve) => {
    const done = async (ok: boolean) => {
      dialog.hidden = true
      form.onsubmit = null
      $('confirm-cancel').onclick = null
      dialog.onkeydown = null
      dialog.onclick = null
      if (ok && remember.checked) await orca.storage.set('skipConfirm', { ...skip, [kind]: true }).catch(() => {})
      resolve(ok)
    }
    form.onsubmit = (e) => { e.preventDefault(); void done(true) }
    $('confirm-cancel').onclick = () => void done(false)
    dialog.onkeydown = (e) => { if (e.key === 'Escape') void done(false) }
    dialog.onclick = (e) => { if (e.target === dialog) void done(false) }
  })
}

/**
 * Opens a coordinator: its live session, its resumed previous conversation, or a new one. When it
 * needs the person (a conversation to pick, one that could not be restored), its row stays
 * "Sleeping" and the Sessions menu opens with the reason and the ways on (wakeView).
 */
async function wake(key: string): Promise<void> {
  const target = `coordinator:${key}`
  ui.status.set(target, { text: 'Opening…', tone: 'pending' })
  draw()
  let r: WakeOutcome
  try { r = await orca.plugin.request('sidebar.openCoordinator', { key }, { timeoutMs: 90_000 }) }
  catch (e) { r = { ok: false, kind: 'failed', error: (e as Error).message } }
  const { row, menu } = wakeView(r)
  if (row) ui.status.set(target, row)
  else ui.status.delete(target)
  draw()
  if (menu) showSessionPicker(key, menu)
  if (r.ok) setTimeout(() => { if (ui.status.get(target)?.tone === 'ok') { ui.status.delete(target); draw() } }, 1800)
}

/**
 * Runs an action and shows its progress on the row itself (keyed like data-menu): a spinner and a
 * verb while it runs, a short confirmation that fades, or the reason in red until the next click.
 */
async function inline(target: string, pending: string, done: string, call: () => Promise<unknown>, showResult: () => boolean = () => true): Promise<void> {
  ui.status.set(target, { text: pending, tone: 'pending' })
  draw()
  let ok = true
  let reason = ''
  try {
    const r = (await call()) as { ok?: boolean; error?: string; removed?: boolean; reason?: string; closed?: number } | undefined
    ok = !(r?.ok === false || r?.removed === false || r?.closed === 0)
    reason = r?.error ?? r?.reason ?? 'Could not do that'
  } catch (e) {
    ok = false
    reason = (e as Error).message
  }
  if (!showResult()) return
  ui.status.set(target, ok ? { text: done, tone: 'ok' } : { text: reason, tone: 'bad' })
  draw()
  if (ok) setTimeout(() => { if (ui.status.get(target)?.tone === 'ok') { ui.status.delete(target); draw() } }, 1800)
}

const LEVELS: [Priority, string][] = [['P0', 'now'], ['P1', 'today'], ['P2', 'soon'], ['P3', 'someday']]

function agentMenu(row: WorkspaceRow, a: AgentInfo): MenuItem[] {
  const target = `agent:${a.paneKey}`
  // Clicking the row already opens it, so the menu holds only what a click can't do.
  const items: MenuItem[] = [
    {
      chips: 'Priority', icon: 'flag',
      options: LEVELS.map(([p, word]) => ({
        label: word,
        active: row.priority === p,
        run: () => inline(target, 'Saving…', row.priority === p ? 'Cleared' : `${p} ${word}`, () => orca.plugin.request('sidebar.setPriority', { workspaceId: row.id, priority: row.priority === p ? null : p }))
      }))
    }
  ]
  if (row.pr) items.push({ label: `Open PR #${row.pr.number}`, icon: 'pr', run: () => void orca.shell?.openExternal(row.pr!.url) })
  // Sleep is reversible (the chat is kept), so it neither looks destructive nor asks first.
  items.push({ label: 'Sleep', icon: 'moon', run: () => inline(target, 'Sleeping…', 'Asleep', () => orca.plugin.request('sidebar.closeSessions', { panes: [a.paneKey] })) }, 'separator')
  // Hidden while any agent in the worktree is mid-turn: removing it would end that agent too.
  if (canRemove(row)) items.push({ label: 'Remove worktree', icon: 'trash', danger: true, run: () => removeWorktree(row, target) })
  return items
}

/**
 * Removes a worktree after a confirm; the menu and a finished lead's remove button both use it. When
 * only a missing PR or uncommitted files stand in the way, asks once more, naming what is lost, and
 * removes anyway on yes.
 */
async function removeWorktree(row: WorkspaceRow, target: string): Promise<void> {
  // A worktree can hold several chats; say they all go with it.
  const chats = row.agents.length > 1 ? `Removes ${row.name} and its ${row.agents.length} chats. Their sessions end` : 'Its sessions end'
  if (!(await confirmAction('remove-worktree', `Remove ${row.name}?`, `${chats} and the checkout is deleted. The branch is kept.`, 'Remove'))) return
  const remove = (force: boolean) => orca.plugin.request('sidebar.removeWorktree', { workspaceId: row.id, force }, { timeoutMs: 200_000 })
  // Set by the first try when what stands in the way can be waived.
  let waivable = null as { reason: string; dirty: string[] } | null
  await inline(target, 'Removing…', 'Removed', async () => {
    const r = await remove(false)
    if (!r.removed && (r.reason === 'PR not merged' || (r.reason === 'uncommitted changes' && r.dirty?.length))) {
      waivable = { reason: r.reason, dirty: r.dirty ?? [] }
      return { ok: true }
    }
    return r
  }, () => waivable === null)
  if (!waivable) return
  ui.status.delete(target)
  draw()
  const { reason, dirty } = waivable
  const files = dirty.length <= 3 ? dirty.join(', ') : `${dirty.slice(0, 3).join(', ')} and ${dirty.length - 3} more`
  const lost = dirty.length ? ` Uncommitted changes will be lost: ${files}.` : ''
  const body = reason === 'PR not merged'
    ? `${row.name} has no merged PR. The branch and its commits are kept.${lost}`
    : `Uncommitted changes will be lost: ${files}. The branch is kept.`
  // Losing work is never remembered: this one always asks.
  if (await confirmAction('remove-anyway', `Remove ${row.name} anyway?`, body, 'Remove anyway', 'trash', 'danger', false))
    await inline(target, 'Removing…', 'Removed', () => remove(true))
}

function coordinatorMenu(key: string): MenuItem[] {
  const c = snap?.coordinators.find((x) => x.key === key)
  if (!c) return []
  const VERBS = { look: ['Shuffling…', 'New look'], restart: ['Restarting…', 'Fresh session'], end: ['Sleeping…', 'Asleep'], delete: ['Deleting…', 'Deleted'] } as const
  const run = (action: 'look' | 'restart' | 'end' | 'delete', _label: string) =>
    inline(`coordinator:${key}`, VERBS[action][0], VERBS[action][1], () => orca.plugin.request('sidebar.coordinatorAction', { key, action }, { timeoutMs: 90_000 }))
  const items: MenuItem[] = [
    { label: 'New look', icon: 'shuffle', run: () => run('look', 'New look') },
    'separator',
    { label: 'Start new conversation', icon: 'restart', danger: true, run: async () => {
      if (await confirmAction('restart-coordinator', `Start ${c.name} fresh?`, 'A separate member starts and becomes current. Previous conversations and their pending asks remain available as read-only history.', 'Start fresh', 'restart', 'warn')) await run('restart', 'Fresh session')
    } }
  ]
  if (c.members?.length) items.splice(1, 0, { label: 'Conversation history', icon: 'clock', run: () => showHistoryList(key) })
  if (c.session) items.splice(1, 0, { label: 'Sleep', icon: 'moon', run: () => run('end', 'Sleep') })
  // The Linear teams it owns: a send of their issues suggests it. One chip per connected team.
  const teams = linear?.connectedTeams ?? []
  if (teams.length) {
    const own = c.linearTeams ?? []
    items.splice(1, 0, {
      chips: 'Linear teams', iconHtml: LINEAR_MARK,
      options: teams.map((t) => ({
        label: t,
        active: own.includes(t),
        run: () => inline(`coordinator:${key}`, 'Saving…', own.includes(t) ? `${t} removed` : `Owns ${t}`, () => orca.plugin.request('sidebar.setLinearTeams', { key, teams: own.includes(t) ? own.filter((x) => x !== t) : [...own, t] }))
      }))
    })
  }
  items.push({ label: 'Delete coordinator', icon: 'trash', danger: true, run: async () => {
    if (await confirmAction('delete-coordinator', `Delete ${c.name}?`, 'Its sessions end and its folder is deleted. Workers it started keep running.', 'Delete')) await run('delete', 'Delete')
  } })
  return items
}

// The row whose menu is open keeps its active look, even across redraws.
let menuTarget: string | null = null
function markTarget(): void {
  document.querySelectorAll('.menu-open').forEach((el) => el.classList.remove('menu-open'))
  if (menuTarget) document.querySelector(`[data-menu="${CSS.escape(menuTarget)}"]`)?.classList.add('menu-open')
  document.querySelectorAll<HTMLElement>('.session-trigger').forEach((el) => {
    el.setAttribute('aria-expanded', String(menuTarget === `sessions:${el.dataset.sessions}`))
  })
}

function closeMenu(): void {
  ctx.hidden = true
  ctx.innerHTML = ''
  menuTarget = null
  markTarget()
}

/** Separators only between groups: none at the ends, never two in a row. */
export function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = []
  for (const it of items) if (it !== 'separator' || (out.length && out[out.length - 1] !== 'separator')) out.push(it)
  while (out[out.length - 1] === 'separator') out.pop()
  return out
}

function menuHtml(items: MenuItem[]): string {
  return items.map((it, i) =>
    it === 'separator' ? '<div class="sep" role="separator"></div>'
      : 'header' in it ? `<div class="mh"${it.tip ? ` data-tip="${esc(it.tip)}"` : ''}>${it.header}</div>`
      : 'chips' in it
        ? `<div class="mchips" role="group" aria-label="${esc(it.chips)}">${iconOf(it)}<span class="ml">${esc(it.chips)}</span></div><div class="chips${it.wrap ? ' wrap' : ''}">${it.options.map((o, j) => `<button class="mi chip${o.active ? ' on' : ''}" role="menuitemradio" aria-checked="${o.active}" data-i="${i}" data-j="${j}">${esc(o.label)}</button>`).join('')}</div>`
        : `<button class="mi${it.danger ? ' danger' : ''}" role="${it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}"${it.checked === undefined ? '' : ` aria-checked="${it.checked}"`} data-i="${i}">${iconOf(it)}<span class="ml">${esc(it.label)}</span>${it.right ? `<span class="mr${it.accent ? ' sug' : ''}">${esc(it.right)}</span>` : ''}${it.checked === undefined ? '' : `<span class="check">${it.checked ? '✓' : ''}</span>`}</button>`
  ).join('')
}

function place(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect()
  el.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 6))}px`
  el.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`
}

function runFrom(items: MenuItem[], e: MouseEvent, build?: () => MenuItem[]): void {
  const b = (e.target as Element).closest<HTMLElement>('[data-i]')
  if (!b) return
  const item = items[Number(b.dataset.i)]
  if (!item || item === 'separator' || 'header' in item) return
  const stay = Boolean(item.stay && build)
  if (!stay) closeMenu()
  if ('chips' in item) void item.options[Number(b.dataset.j)]?.run()
  else void item.run?.()
  if (stay) showItems(tidy(build!()), build)
}

/** Draws a menu's items into the open menu and wires their clicks. */
function showItems(items: MenuItem[], build?: () => MenuItem[]): void {
  const scroll = ctx.scrollTop
  ctx.innerHTML = menuHtml(items)
  ctx.scrollTop = scroll
  ctx.onclick = (e) => runFrom(items, e, build)
}

/**
 * Opens a menu at the pointer, or under `anchor` (above it when there is no room below). Given a
 * builder, items marked `stay` keep it open and it is built again after each one runs.
 */
function openMenu(raw: MenuItem[] | (() => MenuItem[]), x: number, y: number, target: string, anchor?: DOMRect, cls = ''): void {
  const build = typeof raw === 'function' ? raw : undefined
  const items = tidy(build ? build() : (raw as MenuItem[]))
  if (!items.length) return
  menuTarget = target
  markTarget()
  ctx.className = cls ? `ctx ${cls}` : 'ctx'
  showItems(items, build)
  ctx.hidden = false
  if (anchor) {
    const h = ctx.getBoundingClientRect().height
    const below = anchor.bottom + 2 + h <= window.innerHeight - 6
    place(ctx, cls === 'session-menu' ? anchor.left : anchor.right - ctx.getBoundingClientRect().width, below ? anchor.bottom + 2 : anchor.top - 2 - h)
  } else place(ctx, x, y)
  // Focus the menu, not its first item: nothing looks hovered until the pointer or arrow keys move.
  ctx.focus()
}

document.addEventListener('contextmenu', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-menu]')
  if (!el || !snap) return
  e.preventDefault()
  const target = el.dataset.menu!
  const [kind, id] = [target.split(':')[0], target.slice(target.indexOf(':') + 1)]
  if (kind === 'history') return showHistoryList(id)
  if (kind === 'coordinator') return openMenu(coordinatorMenu(id), e.clientX, e.clientY, target)
  if (kind === 'linear') return openMenu(sendMenu(id), e.clientX, e.clientY, target)
  const row = snap.rows.find((r) => r.agents.some((a) => a.paneKey === id))
  const a = row?.agents.find((x) => x.paneKey === id)
  if (row && a) openMenu(agentMenu(row, a), e.clientX, e.clientY, target)
})
/** The menu a button opens with a click (its key, as `menuTarget`), or null for anything else. */
function openerOf(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-ldisplay],[data-lsend],[data-sessions]') : null
  if (!el) return null
  if (el.dataset.sessions) return `sessions:${el.dataset.sessions}`
  return 'ldisplay' in el.dataset ? 'display' : `linear:${el.dataset.lsend}`
}
const opener = openerToggle()
// A press outside the open menu closes it; one on the button that opened it also keeps the click
// that follows from opening it again (src/panel/opener.ts).
document.addEventListener('pointerdown', (e) => {
  opener.press(ctx.hidden ? null : menuTarget, e.button === 0 ? openerOf(e.target) : null)
  if (!ctx.hidden && !ctx.contains(e.target as Node)) closeMenu()
}, true)
// Scrolling the page by hand closes a menu; scrolling inside a long one (Display's projects) does not.
// Listen for the wheel, not for scroll: a redraw that shortens a scrolled list (a Display option
// that hides issues, a Linear refresh) moves its scroll position too, and that must not close the menu.
document.addEventListener('wheel', (e) => { if (!ctx.hidden && !ctx.contains(e.target as Node)) closeMenu() }, { capture: true, passive: true })
const menuKeys = (menu: HTMLElement) => (e: KeyboardEvent) => {
  const items = [...menu.querySelectorAll<HTMLElement>('.mi')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'Escape') closeMenu()
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[i < 0 ? 0 : (i + 1) % items.length]?.focus() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length]?.focus() }
  else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); items[i].click() }
}
ctx.addEventListener('keydown', menuKeys(ctx))

// ---------- sending a Linear issue ----------

/**
 * The send menu: "Send <ID> to", one item per coordinator in tree order with the suggested one first
 * (and why, in the accent), then Open in Linear and Copy ID.
 */
function sendMenu(id: string): MenuItem[] {
  const issue = linear?.issues.find((i) => i.id === id)
  if (!issue || !snap) return []
  const order = coordinatorOrder(snap)
  const items: MenuItem[] = [{ header: `Send <b>${esc(issue.id)}</b> to` }]
  for (const t of sendTargets(issue.team, order, linear?.lastSent)) {
    const c = order.find((x) => x.key === t.key)!
    items.push({ label: c.name, iconHtml: coordinatorCharacter(c, 16), right: t.suggested ?? (c.repos.length ? c.repos.join(', ') : ''), accent: Boolean(t.suggested), run: () => sendIssue(issue, c) })
  }
  if (!order.length) items.push({ header: 'No coordinators yet' })
  items.push('separator')
  if (issue.url) items.push({ label: 'Open in Linear', iconHtml: LINEAR_MARK, run: () => void orca.shell?.openExternal(issue.url) })
  items.push({ label: 'Copy ID', icon: 'copy', run: () => void navigator.clipboard?.writeText(issue.id).catch(() => {}) })
  return items
}

/** Sends an issue, with "Sending…" on its row; then a toast to open the coordinator's chat, or the reason on the row. */
async function sendIssue(issue: LinearIssue, c: Coordinator): Promise<void> {
  const target = `linear:${issue.id}`
  ui.status.set(target, { text: 'Sending…', tone: 'pending' })
  draw()
  try {
    const r = await orca.plugin.request('sidebar.linearSend', { issue: issue.id, coordinator: c.key }, { timeoutMs: 120_000 })
    if (r.ok) {
      ui.status.delete(target)
      showToast(c, issue.id, r.warnings ?? [], r.recipient)
    } else ui.status.set(target, { text: r.error ?? 'Could not send', tone: 'bad' })
  } catch (e) {
    ui.status.set(target, { text: (e as Error).message, tone: 'bad' })
  }
  draw()
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
function showToast(c: Coordinator, id: string, warnings: string[], recipient?: import('../protocol.ts').DeliveryRecipient): void {
  clearTimeout(toastTimer)
  const warn = warnings.length ? `<span class="twarn" data-tip="${esc(warnings.join('\n'))}" data-tone="warn">Linear not updated</span>` : ''
  toastEl.innerHTML = `${coordinatorCharacter(c, 16, 'working')}<span class="t">Sent ${esc(id)} to ${esc(c.name)}</span>${warn}<button class="act" ${recipient ? `data-history="${esc(c.key)}" data-member="${esc(recipient.member)}" data-history-terminal="${esc(recipient.terminal)}" data-history-session="${esc(recipient.orcaSession ?? '')}"` : `data-sessions="${esc(c.key)}"`}>View recipient</button>`
  toastEl.hidden = false
  toastTimer = setTimeout(hideToast, warnings.length ? 12_000 : 8000)
}
function hideToast(): void {
  clearTimeout(toastTimer)
  toastEl.hidden = true
}


// ---------- the Linear section's Display popover ----------

/**
 * Group by, Sort by and Show as chips; the projects of the current filter's issues (color, name,
 * count) to narrow to, "All projects" first and "No project" last; then Reset. It stays open while
 * options change, and every change is saved with the section's fold and filter.
 */
function displayMenu(): MenuItem[] {
  if (!linear) return []
  const d = ui.linearDisplay
  const set = (next: Display) => {
    ui.linearDisplay = next
    saveLinearUi()
    draw()
  }
  const { projects } = viewOf(linear, ui.linearFilter, new Set(), d)
  // A picked project the current filter has no issues in still shows, so it can be unpicked.
  const missing = d.projects.filter((k) => !projects.some((p) => p.key === k)).map((key) => ({ key, name: key || 'No project', color: '', count: 0 }))
  return [
    { chips: 'Group by', icon: 'group', stay: true, wrap: true, options: GROUPS.map((g) => ({ label: GROUP_NAME[g], active: d.group === g, run: () => set({ ...d, group: g }) })) },
    { chips: 'Sort by', icon: 'sort', stay: true, wrap: true, options: SORTS.map((o) => ({ label: SORT_NAME[o], active: d.sort === o, run: () => set({ ...d, sort: o }) })) },
    { chips: 'Show', icon: 'eye', stay: true, wrap: true, options: HIDEABLE.map((h) => ({ label: STATE_NAME[h], active: d.show[h], run: () => set({ ...d, show: { ...d.show, [h]: !d.show[h] } }) })) },
    'separator',
    { header: 'Projects' },
    { label: 'All projects', checked: d.projects.length === 0, stay: true, run: () => set({ ...d, projects: [] }) },
    ...[...projects, ...missing].map((p): MenuItem => ({ label: p.name, iconHtml: projectDot(p.key ? p.color : ''), right: String(p.count), checked: d.projects.includes(p.key), stay: true, run: () => set(toggleProject(d, p.key)) })),
    'separator',
    { label: 'Reset to default', icon: 'restart', stay: true, run: () => set(DEFAULT_DISPLAY) }
  ]
}

// Session inspection is local to the panel. It never switches native chats or changes current.
const sessionsDialog = document.createElement('dialog')
sessionsDialog.className = 'sessions-dialog'
document.body.append(sessionsDialog)
sessionsDialog.addEventListener('click', (event) => { if (event.target === sessionsDialog) sessionsDialog.close() })

let sessionDialogVersion = 0
function sessionDialog(title: string, body: string): void {
  sessionDialogVersion++
  sessionsDialog.innerHTML = `<header><strong>${esc(title)}</strong><button data-session-close aria-label="Close sessions">×</button></header>${body}`
  sessionsDialog.querySelector('[data-session-close]')?.addEventListener('click', () => sessionsDialog.close())
  if (!sessionsDialog.open) sessionsDialog.showModal()
}

async function showHistory(key: string, member: string, terminal?: string, sourceSession?: string): Promise<void> {
  sessionDialog('Read-only history', '<p>Reading the exact recorded session…</p>')
  const version = sessionDialogVersion
  try {
    const history = await orca.plugin.request('sidebar.coordinatorHistory', { key, member, ...(terminal ? { terminal } : {}), ...(sourceSession !== undefined ? { orcaSession: sourceSession || null } : {}) })
    if (!sessionsDialog.open || version !== sessionDialogVersion) return
    sessionDialog(history.title, `<p class="session-note">Read-only terminal scrollback excerpt (not a complete transcript). Current recipient and existing run routes are unchanged.</p>${history.unavailable ? `<p role="status">${esc(history.unavailable)}</p>` : `<pre class="session-history">${esc(history.text || 'No readable output is available for this terminal.')}</pre>${history.truncated ? '<p class="session-note">Showing a bounded excerpt, not the full conversation.</p>' : ''}`}<button data-session-back>Back to history</button>`)
    sessionsDialog.querySelector('[data-session-back]')?.addEventListener('click', () => showHistoryList(key))
  } catch (e) { if (!sessionsDialog.open || version !== sessionDialogVersion) return; sessionDialog('History unavailable', `<p>${esc((e as Error).message)}</p>`) }
}

/**
 * One choice is one explicit switch; opening the dropdown has no side effects. A coordinator click
 * that needs the person opens it with `need`: a short header with the full reason under it, Retry
 * when it may help, Show terminal when the attempt left one, the conversations to pick, then Start
 * new conversation.
 */
function showSessionPicker(key: string, need?: WakeMenu): void {
  const c = snap?.coordinators.find((c) => c.key === key)
  if (!c || !snap) return
  const anchor = document.querySelector<HTMLElement>(`.session-trigger[data-sessions="${CSS.escape(key)}"]`)
    ?? document.querySelector<HTMLElement>(`[data-menu="coordinator:${CSS.escape(key)}"] .coord-name`)
  const target = `coordinator:${key}`
  const choices = !need || need.sessions ? sessionChoices(c, snap.rows) : []
  const picks: MenuItem[] = choices.map((choice) => ({
    label: `${choice.agentType ? choice.agentType.charAt(0).toUpperCase() + choice.agentType.slice(1) : 'Session'} · ${choice.title}`,
    iconHtml: providerBadge(choice.agent, true),
    checked: choice.current,
    run: () => inline(target, 'Switching…', '', async () => {
      const result = await orca.plugin.request('sidebar.coordinatorSessions', { key, action: 'select', workspaceId: choice.workspaceId, paneKey: choice.paneKey, orcaSession: choice.orcaSession, ...(choice.agentType ? { agent: choice.agentType } : {}) })
      if (result.ok) ui.status.delete(target)
      return result
    })
  }))
  const shown = need?.terminal
  const items: MenuItem[] = need ? [
    { header: `${esc(need.header)}${need.reason ? `<div class="mh-reason">${esc(need.reason)}</div>` : ''}` },
    ...(need.retry ? [{ label: 'Retry', icon: 'restart', run: () => wake(key) }] : []),
    ...(shown ? [{ label: 'Show terminal', icon: 'open', run: () => inline(target, 'Opening…', 'Shown', async () => ({ ok: (await orca.plugin.request('sidebar.open', shown)).opened })) }] : []),
    // A separator only parts picks from Start new; Retry sits directly above it.
    ...(picks.length ? [...picks, 'separator' as const] : []),
    { label: 'Start new conversation', icon: 'plus', run: () => inline(target, 'Starting…', 'Started', () => orca.plugin.request('sidebar.coordinatorSessions', { key, action: 'fresh', ...(need.agent ? { agent: need.agent } : {}) }, { timeoutMs: 90_000 })) }
  ] : picks.length ? picks : [{ header: 'No open conversations' }]
  if (!need && menuTarget === `sessions:${key}`) { closeMenu(); return }
  openMenu(items, 12, 12, `sessions:${key}`, anchor?.getBoundingClientRect(), 'session-menu')
}

/** Read-only history is separate from choosing the main conversation. */
function showHistoryList(key: string): void {
  const c = snap?.coordinators.find((c) => c.key === key)
  if (!c) return
  const members = c.members ?? []
  sessionDialog(`${c.name} / History`, members.map((m, i) => `<button class="session-history-choice" data-history-index="${i}">${esc(m.agentType ?? 'Session')} · ${esc(m.title)}</button>`).join('') || '<p>No recorded conversation history is available.</p>')
  sessionsDialog.querySelectorAll<HTMLElement>('[data-history-index]').forEach((b) => b.addEventListener('click', () => void showHistory(key, members[Number(b.dataset.historyIndex)].id)))
}
