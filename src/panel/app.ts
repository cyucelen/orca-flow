// Wires the panel: asks the worker for snapshots, redraws with src/view.ts, handles clicks.
// All UI state (what is open or folded) lives here; the worker only sends data, and reads the folds
// from storage for Option+1..9.
import type { AgentInfo, CockpitStats, Look, Priority, Snapshot, WorkspaceRow } from '../protocol.ts'
import { busy, character, chatDigit, chatTargets, crew, emptyUi, faceOf, FOLDED_KEY, finishedAgents, freeLooks, render, updateButton } from '../view.ts'
import { pressGate } from './press.ts'

const ui = emptyUi()
let snap: Snapshot | null = null
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
  const { cockpit, copen, main, attention, footer } = render(snap, ui)
  cockpitEl.innerHTML = cockpit
  copenEl.innerHTML = copen
  copenEl.hidden = !copen // an empty slot would still take a gap in the column
  mainEl.innerHTML = main
  // What asks you, pinned under the tree, so the tree never moves when an ask comes or goes.
  attentionEl.innerHTML = attention
  attentionEl.hidden = !attention
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
  // A row's PR icon opens the PR, not the row's session.
  const pr = (event.target as Element).closest<HTMLElement>('[data-pr]')
  if (pr?.dataset.pr) {
    void orca.shell?.openExternal(pr.dataset.pr)
    return
  }
  const el = (event.target as Element).closest<HTMLElement>('[data-open],[data-brief],[data-fold],[data-unfold],[data-act],[data-yes],[data-no],[data-coordinator],[data-new-coordinator],[data-cockpit]')
  if (!el) return
  const d = el.dataset
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
    // One footer fold open at a time keeps the footer from taking over the panel.
    const wasOpen = ui.unfolded.has(d.unfold)
    ui.unfolded.clear()
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
// Holding Option brightens the number badges.

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

const holdingOption = (on: boolean) => document.body.classList.toggle('option', on)
document.addEventListener('keydown', (e) => {
  holdingOption(e.altKey && !e.metaKey && !e.ctrlKey)
  // Typing in the search or name field keeps its characters.
  if ((e.target as Element).closest('input, textarea')) return
  const n = chatDigit(e)
  if (n === null) return
  e.preventDefault()
  openNth(n)
})
document.addEventListener('keyup', (e) => holdingOption(e.altKey && !e.metaKey && !e.ctrlKey))
window.addEventListener('blur', () => holdingOption(false))

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
type Action = { label: string; icon?: string; run?: () => void | Promise<void>; danger?: boolean }
/** A row of toggles inside the menu (Priority): no submenu, so nothing overlaps in a narrow sidebar. */
type Chips = { chips: string; icon?: string; options: { label: string; active: boolean; run: () => void | Promise<void> }[] }
type MenuItem = Action | Chips | 'separator'

// Icons in Orca's menu style (16px outline).
const MI: Record<string, string> = {
  open: '<path d="M7 17 17 7M8 7h9v9"/>',
  flag: '<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>',
  pr: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M6 8.2v7.6M18 15.8V9a3 3 0 0 0-3-3h-4m0 0 2.5-2.5M11 6l2.5 2.5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  shuffle: '<path d="M3 7h3c4 0 5 10 9 10h6m-3-3 3 3-3 3M3 17h3c1.5 0 2.5-1.3 3.4-3M14.6 10C15.5 8.3 16.5 7 18 7h3m-3-3 3 3-3 3"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4h4"/>',
  download: '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
  warning: '<path d="M12 4 21.5 20h-19Z"/><path d="M12 10v4.5M12 17.2v.1"/>'
}
const svgIcon = (name?: string) => (name ? `<svg class="micon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${MI[name]}</svg>` : '<span class="micon"></span>')


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

/** Opens a coordinator, showing "Waking…" on its row while Orca starts or resumes its session. */
function wake(key: string): Promise<void> {
  const c = snap?.coordinators.find((x) => x.key === key)
  return inline(`coordinator:${key}`, c?.session ? 'Opening…' : 'Waking…', 'Open', () => orca.plugin.request('sidebar.openCoordinator', { key }, { timeoutMs: 90_000 }))
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
  if (!row.main) items.push({ label: 'Remove worktree', icon: 'trash', danger: true, run: () => removeWorktree(row, target) })
  return items
}

/**
 * Removes a worktree after a confirm; the menu and a finished lead's remove button both use it. When
 * only uncommitted files stand in the way, asks once more, naming them, and removes anyway on yes.
 */
async function removeWorktree(row: WorkspaceRow, target: string): Promise<void> {
  if (!(await confirmAction('remove-worktree', `Remove ${row.name}?`, "The checkout is deleted once it's clean and its PR is merged. The branch is kept.", 'Remove'))) return
  const remove = (force: boolean) => orca.plugin.request('sidebar.removeWorktree', { workspaceId: row.id, force }, { timeoutMs: 200_000 })
  let dirty: string[] = []
  await inline(target, 'Removing…', 'Removed', async () => {
    const r = await remove(false)
    if (!r.removed && r.reason === 'uncommitted changes' && r.dirty?.length) {
      dirty = r.dirty
      return { ok: true }
    }
    return r
  }, () => dirty.length === 0)
  if (!dirty.length) return
  ui.status.delete(target)
  draw()
  const files = dirty.length <= 3 ? dirty.join(', ') : `${dirty.slice(0, 3).join(', ')} and ${dirty.length - 3} more`
  // Losing work is never remembered: this one always asks.
  if (await confirmAction('remove-dirty', `Remove ${row.name} anyway?`, `Uncommitted changes will be lost: ${files}. The branch is kept.`, 'Remove anyway', 'trash', 'danger', false))
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
    { label: 'Start fresh session', icon: 'restart', danger: true, run: async () => {
      if (await confirmAction('restart-coordinator', `Start ${c.name} fresh?`, 'Its current conversation ends and a new one starts. Its notes and scope stay.', 'Start fresh', 'restart', 'warn')) await run('restart', 'Fresh session')
    } }
  ]
  if (c.session) items.splice(1, 0, { label: 'Sleep', icon: 'moon', run: () => run('end', 'Sleep') })
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
      : 'chips' in it
        ? `<div class="mchips" role="group" aria-label="${it.chips}">${svgIcon(it.icon)}<span class="ml">${it.chips}</span></div><div class="chips">${it.options.map((o, j) => `<button class="mi chip${o.active ? ' on' : ''}" role="menuitemradio" aria-checked="${o.active}" data-i="${i}" data-j="${j}">${o.label}</button>`).join('')}</div>`
        : `<button class="mi${it.danger ? ' danger' : ''}" role="menuitem" data-i="${i}">${svgIcon(it.icon)}<span class="ml">${it.label.replace(/</g, '&lt;')}</span></button>`
  ).join('')
}

function place(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect()
  el.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 6))}px`
  el.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`
}

function runFrom(items: MenuItem[], e: MouseEvent): void {
  const b = (e.target as Element).closest<HTMLElement>('[data-i]')
  if (!b) return
  const item = items[Number(b.dataset.i)]
  if (!item || item === 'separator') return
  closeMenu()
  if ('chips' in item) void item.options[Number(b.dataset.j)]?.run()
  else void item.run?.()
}

function openMenu(raw: MenuItem[], x: number, y: number, target: string): void {
  const items = tidy(raw)
  if (!items.length) return
  menuTarget = target
  markTarget()
  ctx.innerHTML = menuHtml(items)
  ctx.hidden = false
  place(ctx, x, y)
  ctx.onclick = (e) => runFrom(items, e)
  // Focus the menu, not its first item: nothing looks hovered until the pointer or arrow keys move.
  ctx.focus()
}

document.addEventListener('contextmenu', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-menu]')
  if (!el || !snap) return
  e.preventDefault()
  const target = el.dataset.menu!
  const [kind, id] = [target.split(':')[0], target.slice(target.indexOf(':') + 1)]
  if (kind === 'coordinator') return openMenu(coordinatorMenu(id), e.clientX, e.clientY, target)
  const row = snap.rows.find((r) => r.agents.some((a) => a.paneKey === id))
  const a = row?.agents.find((x) => x.paneKey === id)
  if (row && a) openMenu(agentMenu(row, a), e.clientX, e.clientY, target)
})
document.addEventListener('pointerdown', (e) => { if (!ctx.hidden && !ctx.contains(e.target as Node)) closeMenu() }, true)
document.addEventListener('scroll', closeMenu, true)
const menuKeys = (menu: HTMLElement) => (e: KeyboardEvent) => {
  const items = [...menu.querySelectorAll<HTMLElement>('.mi')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'Escape') closeMenu()
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[i < 0 ? 0 : (i + 1) % items.length]?.focus() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length]?.focus() }
  else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); items[i].click() }
}
ctx.addEventListener('keydown', menuKeys(ctx))
