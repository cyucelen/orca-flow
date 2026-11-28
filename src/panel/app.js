// Wires the panel: asks the worker for snapshots, redraws with src/view.ts, handles clicks.
// All UI state (what is open or folded) lives here; the worker only sends data, and reads the folds
// from storage for Option+1..9.

import { goalsOn, asleep, RELOAD_ALL, BOTS_UI_KEY, busy, character, chatDigit, chatTargets, coordinatorCharacter, coordinatorOrder, crew, emptyUi, esc, faceOf, FOLDED_KEY, finishedAgents, freeLooks, explainError, failedStatus, linearOn, projectDot, render, tokenSpeedOn, updateButton, wakeDisplay,                               } from '../view.js'
import { nextText } from '../../skills/orca-flow/scripts/goal-next.mjs'
import { goalCard, GOALS_UI_KEY, goalsUiOf, jumpTarget, liveCoordinators,               } from '../goals-view.js'

import { SPEED_UI_KEY, speedUiOf, tokenSpeedSection } from '../token-speed-view.js'



import { decodeLinear, DEFAULT_DISPLAY, FILTERS, GROUP_NAME, GROUPS, HIDEABLE, LINEAR_MARK, LINEAR_UI_KEY, linearUiOf, sendTargets, SORT_NAME, SORTS, STATE_NAME, toggleProject, viewOf,                                 } from '../linear.js'
import { accessLine, approvalSummary, versionDelta } from '../approval.js'
import { pressGate } from './press.js'
import { openerToggle } from './opener.js'
import { externalLink } from './links.js'
import { findByKey, stableKey } from './stable.js'
import { canRemove } from '../rank.js'
import { sessionChoices } from '../coordinator-sessions.js'
import { providerBadge, providerOf } from '../providers.js'
import { PROVIDER_LOGOS } from '../provider-logos.js'
import { coordinatorHandover } from '../handover-providers.js'
import { openSettings, settingsHooks, settingsOpen, settingsUpdateState } from './settings.js'

import { confirmText, reloadPlan,                  } from '../skill-reload.js'

const ui = emptyUi()
let snap                  = null
/** The Linear section's data; null hides the section (Linear not connected, or not read yet). */
let linear                    = null
/** The Goals section's goals; null hides the section (not read yet). */
let goals                    = null
/** The Analytics section's data from the worker, and its fold and range (kept in storage). */
let speed                        = null
const speedUi                                                                                       = { folded: false, range: '1h', metric: 'tokens', window: '7d' }
/** The section's usage block: the worker's analytics.view for the chosen window, and Details open or not (not kept). */
const usage                                                                                     = { view: null, details: false, error: null, at: 0 }
const $ = (id        ) => document.getElementById(id)
const cockpitEl = $('cockpit')
const mainEl = $('main')
const attentionEl = $('attention')
const searchEl = $('search')
const searchBox = $('searchbox')
const searchOpen = $('search-open')
const copenEl = $('copen')
const updateEl = $('update-slot')
const linearEl = $('linear')
const botsEl = $('bots')
const goalsEl = $('goals')
const goalsHeadEl = $('goals-head')
const goalsRowsEl = $('goals-rows')
const goalAddEl = $('goal-add')
const goalNewEl = $('goal-new')
const goalPop = $('goalpop')
const speedEl = $('tokenspeed')
const toastEl = $('toast')

const openedAt = Date.now()
/** How long the panel waits for the coordinator lineage before showing agents without it. */
const LINEAGE_WAIT_MS = 8000

function paint()       {
  const focused = focusKey()
  paintRows()
  keepAnimationPhase()
  restoreFocus(focused)
  paintGoalCard()
  followTip()
}

/** The redrawn sections; keyboard focus inside them is kept across a redraw by its logical key. */
const painted = () => [cockpitEl, copenEl, goalsHeadEl, goalsRowsEl, mainEl, attentionEl, botsEl, linearEl, speedEl, updateEl]
let restoringFocus = false
function focusKey()                {
  const el = document.activeElement
  return el instanceof HTMLElement && painted().some((p) => p !== el && p.contains(el)) ? stableKey(el) : null
}
function restoreFocus(key               )       {
  if (!key || (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected)) return
  const el = findByKey(document, 'button,a[href],input,[tabindex]', key)
  if (!el) return
  restoringFocus = true
  try { el.focus({ preventScroll: true }) } finally { restoringFocus = false }
}

/**
 * A paint replaces the rows, so each new spinner starts again at 0° and jumps back.
 * Start every CSS animation at the origin of the timeline, so a new spinner continues at the phase of the old one.
 */
function keepAnimationPhase()       {
  for (const a of document.getAnimations()) if (a instanceof CSSAnimation) a.startTime = 0
}

function paintRows()       {
  if (!snap) return
  updateEl.innerHTML = searchBox.hidden ? updateButton(snap.update) : ''
  // Until the worker knows who each agent works for, agents would show under You and then jump to
  // their coordinator; keep the loader instead, for a few seconds at most.
  if (snap.ready === false && Date.now() - openedAt < LINEAGE_WAIT_MS) {
    mainEl.innerHTML = crew('Loading workspaces…')
    return
  }
  ui.now = Date.now()
  const { cockpit, copen, goalsHead, goalsRows, main, attention, bots, linear: linearHtml } = render(snap, ui, linear, goals)
  cockpitEl.innerHTML = cockpit
  copenEl.innerHTML = copen
  // Goals, above the tree. Its add box and the open card are not part of what is redrawn, so typing in them survives.
  goalsHeadEl.innerHTML = goalsHead
  goalsRowsEl.innerHTML = goalsRows
  goalsEl.hidden = !goalsHead
  goalsEl.classList.toggle('folded', ui.goalsFolded)
  if (!goalsHead) goalAddEl.hidden = true
  flashGoal()
  copenEl.hidden = !copen // an empty slot would still take a gap in the column
  mainEl.innerHTML = main
  // What asks you, pinned under the tree, so the tree never moves when an ask comes or goes.
  attentionEl.innerHTML = attention
  attentionEl.hidden = !attention
  // Bots, between Up next and Linear: one line per bot, folded to its header like Linear.
  botsEl.innerHTML = bots
  botsEl.hidden = !bots
  botsEl.classList.toggle('folded', ui.botsFolded)
  // Linear, pinned under Bots: its own scroll area while open, one header row while folded.
  linearEl.innerHTML = linearHtml
  linearEl.hidden = !linearHtml
  linearEl.classList.toggle('folded', ui.linearFolded)
  // Analytics, under Linear (Usage first, Speed & traffic at the bottom); hidden while searching, like the other sections.
  const speedHtml = ui.query ? '' : tokenSpeedSection(speed, { speedFolded: speedUi.folded, speedRange: speedUi.range, usage: { view: usage.view, window: speedUi.window, metric: speedUi.metric, details: usage.details, error: usage.error }, now: ui.now, speedOff: !speedIsOn() })
  speedEl.innerHTML = speedHtml
  speedEl.hidden = !speedHtml
  speedEl.classList.toggle('folded', speedUi.folded)
  if (typeof markTarget === 'function') markTarget()
}

// Every redraw goes through the gate: one landing mid-press would replace the pressed row, and the
// browser then drops the click (src/panel/press.ts).
const gate = pressGate(paint)
const draw = ()       => gate.draw()
document.addEventListener('pointerdown', () => gate.down(), true)
document.addEventListener('pointerup', () => gate.up(), true)
document.addEventListener('pointercancel', () => gate.up(), true)

function toggle(set             , key        )       {
  set.has(key) ? set.delete(key) : set.add(key)
}

// The first snapshot can take a few seconds (Orca's CLI is slow on a busy machine).
mainEl.innerHTML = crew('Loading workspaces…')
setTimeout(draw, LINEAGE_WAIT_MS)
orca.plugin.request('sidebar.list').then((s) => ((snap = s            ), settingsUpdateState(snap.update), applyFeatures(), draw())).catch((e       ) => (mainEl.innerHTML = `<div class="empty">Could not load workspaces: ${e.message}</div>`))
orca.plugin.on('sidebar.changed', (s) => ((snap = s            ), settingsUpdateState(snap.update), applyFeatures(), draw()))

// Settings → Features: Linear and Analytics (stored as tokenSpeed). While one is off its data is dropped and not asked
// for; switching it on asks at once, so the section shows fresh data, not what it had before.
const linearIsOn = () => !snap || linearOn(snap)
const goalsIsOn = () => !!snap && goalsOn(snap)
const speedIsOn = () => !snap || tokenSpeedOn(snap)
let linearWasOn = true
let goalsWasOn = false
let speedWasOn = true
function applyFeatures()       {
  const l = linearIsOn()
  const t = speedIsOn()
  if (!l) linear = null
  if (!t) speed = null
  const reread = (l && !linearWasOn) || (t && !speedWasOn)
  const lAgain = l && !linearWasOn
  const tAgain = t && !speedWasOn
  linearWasOn = l
  // Goals: off hides the section and its card at once and drops the data; on reads the goals at once.
  const gOn = goalsIsOn()
  if (!gOn && (goals || ui.goalOpen)) { goals = null; hideGoalCard() }
  if (gOn && !goalsWasOn) queueMicrotask(() => void readGoals())
  goalsWasOn = gOn
  speedWasOn = t
  if (reread) queueMicrotask(() => { if (lAgain) readLinear(true); if (tAgain) readSpeed() })
}
// Relative times ("4m") stay current.
setInterval(draw, 60_000)

// Linear: read once a minute while the panel shows (the worker answers from its cache when it is
// fresh); a send or a new read is posted. The fold and the filter come back from storage.
const readLinear = (force = false) => {
  if (document.visibilityState !== 'visible' || !linearIsOn()) return
  orca.plugin.request('sidebar.linear', { force }).then((d) => { linear = decodeLinear(d); draw() }).catch(() => null)
}
orca.plugin.on('sidebar.linearChanged', (d) => { if (linearIsOn()) { linear = decodeLinear(d                     ); draw() } })
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
// The Bots section's fold comes back from storage, like Linear's.
orca.storage.get(BOTS_UI_KEY).then((stored) => {
  ui.botsFolded = (stored                               )?.folded === true
  draw()
}).catch(() => null)
document.addEventListener('visibilitychange', () => readLinear())
// Analytics (Usage on top, Speed & traffic at the bottom): the worker samples every 30 s and posts each sample; the panel asks once on open and
// when it shows again. The fold and the 1 h / 24 h range come back from storage.
/** Usage changes with each 30 s sample, but a minute is fresh enough; the worker rebuilds at most every 30 s. */
const USAGE_REFRESH_MS = 60_000
const readUsage = (force = false) => {
  if (document.visibilityState !== 'visible' || !speedIsOn() || speedUi.folded) return
  if (!force && Date.now() - usage.at < USAGE_REFRESH_MS) return
  usage.at = Date.now()
  const asked = speedUi.window
  orca.plugin.request('analytics.view', { window: asked })
    .then((v) => { if (asked === speedUi.window) { usage.view = v                 ; usage.error = null; draw() } })
    .catch((e       ) => { usage.error = e.message; draw() })
}
const readSpeed = () => {
  if (document.visibilityState !== 'visible' || !speedIsOn()) return
  orca.plugin.request('sidebar.tokenSpeed').then((d) => { speed = d                  ; draw() }).catch(() => null)
  readUsage()
}
orca.plugin.on('sidebar.tokenSpeedChanged', (d) => { if (speedIsOn()) { speed = d                  ; readUsage(); draw() } })
orca.storage.get(SPEED_UI_KEY).then((stored) => {
  const was = speedUi.window
  Object.assign(speedUi, speedUiOf(stored))
  if (speedUi.window !== was) { usage.view = null; readUsage(true) }
  draw()
}).catch(() => null)
readSpeed()
document.addEventListener('visibilitychange', readSpeed)
const saveSpeedUi = () => void orca.storage.set(SPEED_UI_KEY, { folded: speedUi.folded, range: speedUi.range, metric: speedUi.metric, window: speedUi.window }).catch(() => null)
const saveLinearUi = () =>
  void orca.storage.set(LINEAR_UI_KEY, { folded: ui.linearFolded, filter: ui.linearFilter, display: ui.linearDisplay, groupFolds: [...ui.linearGroupFolds] }).catch(() => null)
// No Orca event reports a switch between tabs of one workspace. While the panel shows, the worker
// looks every 2 s (one quick `orca terminal list`) and posts sidebar.changed only when the front tab moved.
const lookAtFocus = () => { if (document.visibilityState === 'visible') void orca.plugin.request('sidebar.focus').catch(() => null) }
setInterval(lookAtFocus, 2000)
document.addEventListener('visibilitychange', lookAtFocus)

document.addEventListener('click', (event) => {
  // A finished row's remove button: the same confirm and inline progress as the menu's Remove worktree.
  const rm = (event.target           ).closest             ('[data-remove]')
  if (rm?.dataset.remove && snap) {
    const row = snap.rows.find((r) => r.id === rm.dataset.remove)
    if (row) void removeWorktree(row, rm.dataset.target ?? `agent:${row.id}`)
    return
  }
  // The top bar's update button: confirm, then the worker updates (or, needing approval, the command).
  const upd = (event.target           ).closest             ('[data-update]')
  if (upd) {
    void updateClick()
    return
  }
  // Reload skills in every running agent: the scope confirmation names who gets it, then the worker writes the request.
  if ((event.target           ).closest('[data-reload-skills]')) {
    void reloadSkills('all', 'across all coordinators and your chats', RELOAD_ALL)
    return
  }
  // The Bots section's header folds it; the fold is kept in storage.
  if ((event.target           ).closest('[data-bfold]')) {
    ui.botsFolded = !ui.botsFolded
    void orca.storage.set(BOTS_UI_KEY, { folded: ui.botsFolded }).catch(() => null)
    draw()
    return
  }
  // The Analytics section: fold, range, usage window, measure and Details.
  const sp = (event.target           ).closest             ('[data-tfold],[data-trange],[data-umetric],[data-uwin],[data-udetails]')
  if (sp) {
    const d = sp.dataset
    if ('tfold' in d) { speedUi.folded = !speedUi.folded; saveSpeedUi(); readUsage() }
    if ((d.uwin === '7d' || d.uwin === '30d' || d.uwin === 'all') && d.uwin !== speedUi.window) { speedUi.window = d.uwin; saveSpeedUi(); usage.view = null; readUsage(true) }
    if ('udetails' in d) usage.details = !usage.details
    if (d.trange === '1h' || d.trange === '24h') { speedUi.range = d.trange; saveSpeedUi() }
    if (d.umetric === 'tokens' || d.umetric === 'cost') { speedUi.metric = d.umetric; saveSpeedUi() }
    draw()
    return
  }
  // The Linear section: fold, filter, display options, groups, the folds at its end, and a row's send menu.
  const lin = (event.target           ).closest             ('[data-lfold],[data-lfilter],[data-lmore],[data-lsend],[data-lgroup],[data-ldisplay],[data-lprojects-clear]')
  if (lin) {
    const d = lin.dataset
    if ('lfold' in d) { ui.linearFolded = !ui.linearFolded; saveLinearUi() }
    if (d.lfilter && FILTERS.includes(d.lfilter                )) { ui.linearFilter = d.lfilter                ; saveLinearUi() }
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
  const url = externalLink(event.target           )
  if (url) {
    void orca.shell?.openExternal(url)
    return
  }
  const el = (event.target           ).closest             ('[data-open],[data-resume],[data-status],[data-handover],[data-sessions],[data-history],[data-brief],[data-fold],[data-act],[data-yes],[data-no],[data-coordinator],[data-new-coordinator],[data-cockpit]')
  if (!el) return
  const d = el.dataset
  if (d.handover) {
    const target = `handover:${d.handover}`
    if (menuTarget === target) closeMenu()
    else if (opener.shouldOpen(target)) {
      const c = snap?.coordinators.find(c => c.key === d.handover)
      if (c) openMenu(handoverItems(c, false), 12, 12, target, el.getBoundingClientRect(), 'session-menu')
    }
    return
  }
  if (d.status) { if (opener.shouldOpen(`status:${d.status}`)) showStatus(d.status); return }
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
  for (const [k, st] of ui.status) if (st.tone === 'bad' || st.tone === 'warn') { ui.status.delete(k); statusMenus.delete(k) }
  if (d.act) ui.confirming = d.act
  if ('no' in d) ui.confirming = null
  if (d.yes) { void runAction(d.yes); return }
  if ('cockpit' in d) toggleCockpit()
  if (d.open) {
    void orca.plugin.request('sidebar.open', d.terminal ? { workspaceId: d.open, terminal: d.terminal } : { workspaceId: d.open })
    return
  }
  if (d.resume && d.workspace) { void resumeAsleep(d.workspace, d.resume); return }
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
  draw()
})

function loadStats()       {
  ui.statsLoading = true
  orca.plugin.request('sidebar.cockpit').then((stats) => {
    ui.stats = stats
  }).catch((e       ) => { ui.notice = { key: 'load', text: e.message, ok: false } }).finally(() => {
    ui.statsLoading = false
    draw()
  })
}

function toggleCockpit()       {
  ui.cockpitOpen = !ui.cockpitOpen
  ui.confirming = null
  ui.notice = null
  // The last stats stay on screen while new ones load; the first open shows a skeleton.
  if (ui.cockpitOpen) loadStats()
}

/** Runs a confirmed action, shows its result in place, then reloads the stats. */
async function runAction(key        )                {
  ui.confirming = null
  ui.pending = key
  draw()
  try {
    if (key === 'closeall' && snap) {
      // Every finished session (a lead waiting on its workers, or not yet reported, is not one).
      const panes = finishedAgents(snap.rows).map((a) => a.paneKey)
      const { closed, reason } = await orca.plugin.request('sidebar.closeSessions', { panes })
      ui.notice = { key, text: closed ? `${closed} asleep` : reason ?? 'Nothing was put to sleep', ok: closed > 0 }
    } else if (key.startsWith('close:')) {
      const { closed, reason } = await orca.plugin.request('sidebar.closeSessions', { panes: [key.slice(6)] })
      ui.notice = { key, text: closed ? 'Asleep' : reason ?? 'Could not sleep it', ok: closed > 0 }
    } else if (key.startsWith('remove:')) {
      const r = await orca.plugin.request('sidebar.removeWorktree', { workspaceId: key.slice(7) })
      ui.notice = { key, text: r.removed ? 'Removed' : `Kept: ${r.reason ?? 'refused'}`, ok: r.removed }
    }
  } catch (e) {
    ui.notice = { key, text: (e         ).message, ok: false }
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
 * that needs approval is approved only by the dialog's own Approve and update click.
 */
async function updateClick(given              )                {
  const st = given ?? snap?.update
  if (!st) return
  if (st.kind === 'available' || st.kind === 'confirm' || st.kind === 'failed') {
    if (!(await confirmAction('update', `Update Orca Flow to ${st.version}?`, 'Orca Flow restarts on the new version.', 'Update', 'download', 'warn', false))) return
    await orca.plugin.request('sidebar.update').catch(() => null)
  } else if (st.kind === 'approval') {
    const choice = await approvalDialog(st)
    if (choice === 'copy') await navigator.clipboard?.writeText(st.command).catch(() => {})
    // Only this click approves, once, for the fingerprint the dialog showed; a new fingerprint comes back as a new dialog to read.
    else if (choice === 'approve' && st.fingerprint) await orca.plugin.request('sidebar.approveUpdate', { fingerprint: st.fingerprint }).catch(() => null)
  }
}

// Search is its own control: it expands inline over the cockpit row and gives it back on close.
function setSearching(on         )       {
  searchBox.hidden = !on
  cockpitEl.hidden = on
  searchOpen.hidden = on
  settingsBtn.hidden = on
  updateEl.hidden = on
  if (on) { ui.cockpitOpen = false; searchEl.focus() } else { searchEl.value = ''; ui.query = '' }
  draw()
}
searchOpen.addEventListener('click', () => setSearching(true))
// The gear: Orca Flow's Settings dialog (src/panel/settings.ts).
const settingsBtn = $('settings-open')
settingsBtn.addEventListener('click', () => openSettings())
// Settings' Update button goes through the same confirm and sidebar.update as the top bar's.
settingsHooks.update = (state) => void updateClick(state)
$('search-close').addEventListener('click', () => setSearching(false))
searchEl.addEventListener('input', () => { ui.query = searchEl.value.trim(); draw() })
searchEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSearching(false) })

// ---------- Option+1..9: open the nth chat of the tree ----------
// Orca runs the chat.N commands (contributes.keybindings) anywhere outside this panel. Keys pressed
// in the panel stay in its frame, so it opens the chat itself, the way a click on the row does.

/** The worker numbers the chats too, and a folded group gives its team's numbers away: store the folds where it reads them. */
function sendFolds()       {
  void orca.storage.set(FOLDED_KEY, [...ui.folded]).catch(() => null)
}
sendFolds()

function openNth(n        )       {
  const t = snap ? chatTargets(snap, ui.folded)[n - 1] : undefined
  if (!t) return
  if ('coordinator' in t) void wake(t.coordinator)
  else void orca.plugin.request('sidebar.open', t.terminal ? { workspaceId: t.workspaceId, terminal: t.terminal } : { workspaceId: t.workspaceId })
}

document.addEventListener('keydown', (e) => {
  // Typing in the search or name field keeps its characters; the Settings dialog keeps its keys.
  if ((e.target           ).closest('input, textarea') || settingsOpen()) return
  const n = chatDigit(e)
  if (n === null) return
  e.preventDefault()
  openNth(n)
})

// ---------- tooltips (cockpit gauges, character status, row errors) ----------
// One floating element for every [data-tip], in its tone: shown after a short hover, at once on keyboard
// focus, placed below the target (above when there is no room) and kept inside the panel. A redraw
// replaces the target's node; the tooltip follows its logical element (stableKey), so it neither
// flashes nor restarts its delay while the pointer or focus stays on the same thing.
const tip = document.createElement('div')
tip.className = 'tip'
tip.setAttribute('role', 'tooltip')
document.body.append(tip)
let tipTarget                     = null
/** The logical element the tooltip shows for, or waits to show for. */
let tipKey                = null
let tipTimer
const tipShown = () => tip.classList.contains('on')

function placeTip(target             )       {
  const r = target.getBoundingClientRect()
  const t = tip.getBoundingClientRect()
  const below = r.bottom + 6 + t.height <= window.innerHeight
  const top = below ? r.bottom + 6 : r.top - 6 - t.height
  const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8)
  tip.style.top = `${Math.max(8, top)}px`
  tip.style.left = `${left}px`
}

function showTip(target             )       {
  const text = target.dataset.tip
  if (!text) { hideTip(); return }
  clearTimeout(tipTimer)
  tipTarget = target
  tipKey = stableKey(target)
  // A command in the update button's tip wraps at its spaces, never at its dashes.
  const shown = 'update' in target.dataset ? text.replace(/-/g, '\u2011') : text
  if (tip.textContent !== shown) tip.textContent = shown
  const cls = `tip on ${target.dataset.tone ?? ''}`
  if (tip.className !== cls) tip.className = cls
  placeTip(target)
}

function hideTip()       {
  clearTimeout(tipTimer)
  tipTarget = null
  tipKey = null
  tip.className = 'tip'
}

/** After a redraw: the tooltip moves to its target's new node, with its new text, or closes when it is gone. */
function followTip()       {
  if (!tipKey || tipTarget?.isConnected) return
  const el = findByKey(document, '[data-tip]', tipKey)
  if (!el) hideTip()
  else if (tipShown()) showTip(el)
}

document.addEventListener('pointerover', (e) => {
  const target = (e.target           ).closest             ('[data-tip]')
  if (!target) { if (tipKey) hideTip(); return }
  const key = stableKey(target)
  if (key === tipKey) { if (tipShown()) tipTarget = target; return }
  hideTip()
  tipKey = key
  // Found again by key when it fires: a redraw may have replaced the node meanwhile.
  tipTimer = setTimeout(() => { const el = findByKey(document, '[data-tip]', key); if (el) showTip(el); else hideTip() }, 350)
})
document.addEventListener('pointerleave', hideTip)
// A memory tile and its legend pill light up together; the sliver of small consumers with all their pills.
let lit = ''
document.addEventListener('pointerover', (e) => {
  const el = (e.target           ).closest             ('[data-use]')
  const use = el?.dataset.use ?? '', within = el?.dataset.in ?? ''
  if (`${use}|${within}` === lit && (!use || document.querySelector('.lit'))) return
  for (const x of document.querySelectorAll('.lit')) x.classList.remove('lit')
  lit = `${use}|${within}`
  if (!use) return
  const q = (v        ) => CSS.escape(v)
  for (const x of document.querySelectorAll(`[data-use="${q(use)}"],[data-in="${q(use)}"]${within ? `,[data-use="${q(within)}"]` : ''}`)) x.classList.add('lit')
})
document.addEventListener('focusin', (e) => {
  if (restoringFocus) return // a redraw put focus back where it was; followTip keeps the tooltip
  const target = (e.target           ).closest             ('[data-tip]')
  target ? showTip(target) : hideTip()
})
// A scroll moves the target under a fixed tooltip: keep it with its target while that is in view.
document.addEventListener('scroll', () => {
  if (!tipShown() || !tipTarget?.isConnected) return
  const r = tipTarget.getBoundingClientRect()
  r.bottom < 0 || r.top > window.innerHeight ? hideTip() : placeTip(tipTarget)
}, true)
document.addEventListener('pointerdown', hideTip)

// ---------- New coordinator modal ----------
// Static DOM (not redrawn), so typing is never interrupted by a snapshot. Just a name and a
// character; the coordinator learns its projects later, when you tell it.
const modal = $('modal')
const form = $('coord-form')
const nameEl = $('coord-name')
const lookEl = $('coord-look')
const errorEl = $('coord-error')
const createEl = $('coord-create')
let look              = null

function showError(text               )       {
  errorEl.textContent = text ?? ''
  errorEl.hidden = !text
}

/** A random character no other coordinator has, different from the one shown. */
function shuffle()       {
  const free = freeLooks(snap?.coordinators ?? []).filter((l) => !look || l.color !== look.color || l.shape !== look.shape)
  look = free.length ? free[Math.floor(Math.random() * free.length)] : look
  if (look) lookEl.innerHTML = character(look.color, look.shape, 'done', 56, false)
}

function openModal()       {
  form.reset()
  showError(null)
  createEl.disabled = false
  createEl.textContent = 'Create'
  look = null
  shuffle()
  modal.hidden = false
  nameEl.focus()
}

function closeModal()       {
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
    const r = await orca.plugin.request('sidebar.createCoordinator', { name, look: look  }, { timeoutMs: 90_000 })
    if (r.ok) closeModal()
    else showError(r.error ?? 'Could not create it')
  } catch (err) {
    showError((err         ).message)
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

/** A row of toggles inside the menu (Priority): no submenu, so nothing overlaps in a narrow sidebar. `wrap` lets many chips wrap. */

/** A line of text heading the menu; `header` is HTML, escaped by whoever builds it; `tip` is its tooltip (text). */





// Icons in Orca's menu style (16px outline).
const MI                         = {
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
const svgIcon = (name         ) => (name ? `<svg class="micon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${MI[name]}</svg>` : '<span class="micon"></span>')
const iconOf = (it                                      ) => (it.iconHtml ? `<span class="micon">${it.iconHtml}</span>` : svgIcon(it.icon))


/**
 * The update-approval dialog: the version and access change on top, Orca's whole text in a region
 * that scrolls, the command, and a footer that stays put. Approve and update is the person's own
 * click, for exactly the fingerprint shown here; Copy command is the same approval run by hand.
 */
function approvalDialog(st                                                                            )                                     {
  const a = approvalSummary(st)
  const dialog = $('approval')
  const form = $('approval-form')
  const ok = $('approval-ok')
  const copy = $('approval-copy')
  const cancel = $('approval-cancel')
  $('approval-title').textContent = `Orca Flow ${versionDelta(a)} needs your approval`
  $('approval-sum').textContent = accessLine(a)
  $('approval-scroll').textContent = a.text || 'Orca gave no details.'
  $('approval-cmd').textContent = a.command
  // Without a fingerprint there is nothing to bind an approval to: the command is the way.
  ok.hidden = !st.fingerprint
  dialog.hidden = false
  cancel.focus()
  return new Promise((resolve) => {
    const done = (r                           ) => {
      dialog.hidden = true
      form.onsubmit = null; cancel.onclick = null; copy.onclick = null; dialog.onkeydown = null; dialog.onclick = null
      resolve(r)
    }
    form.onsubmit = (e) => { e.preventDefault(); done('approve') }
    copy.onclick = () => done('copy')
    cancel.onclick = () => done(null)
    dialog.onclick = (e) => { if (e.target === dialog) done(null) }
    dialog.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); return }
      if (e.key !== 'Tab') return
      const stops = [$('approval-main'), $('approval-scroll'), cancel, copy, ...(ok.hidden ? [] : [ok])]
      const i = stops.indexOf(document.activeElement               )
      const next = stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]
      e.preventDefault(); next.focus()
    }
  })
}

/** Confirms a destructive action unless the person said not to ask again for this kind. */
async function confirmAction(kind        , title        , text        , okLabel        , icon = 'trash', tone                    = 'danger', rememberable = true)                   {
  const skip = ((await orca.storage.get('skipConfirm').catch(() => null)) ?? {})
  if (rememberable && skip[kind]) return true
  const dialog = $('confirm')
  const form = $('confirm-form')
  const remember = $('confirm-remember')
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  $('confirm-ok').textContent = okLabel
  $('confirm-ok').className = `btn ${tone}`
  $('confirm-icon').className = `dialog-icon ${tone}`
  $('confirm-icon').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${MI[icon]}</svg>`
  remember.checked = false
  ;(remember.closest('label')               ).hidden = !rememberable
  dialog.hidden = false
  ;($('confirm-cancel')                     ).focus()
  return new Promise((resolve) => {
    const done = async (ok         ) => {
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
async function wake(key        , provider         )                {
  const target = `coordinator:${key}`
  ui.status.set(target, { text: 'Opening…', tone: 'pending' })
  draw()
  let r
  try { r = await orca.plugin.request('sidebar.openCoordinator', { key, ...(provider ? { provider } : {}) }, { timeoutMs: 90_000 }) }
  catch (e) { r = { ok: false, kind: 'failed', error: (e         ).message } }
  if (r.kind === 'provider') {
    ui.status.delete(target)
    draw()
    showFirstProviderPicker(key, r.providers ?? [], r.error)
    return
  }
  const { row, menu } = wakeDisplay(r)
  if (row) ui.status.set(target, row)
  else ui.status.delete(target)
  // A click on the row's error opens this same menu again, with its reason and ways on.
  if (row && menu) statusMenus.set(target, menu)
  else statusMenus.delete(target)
  draw()
  if (menu) showSessionPicker(key, menu)
  if (r.ok) setTimeout(() => { if (ui.status.get(target)?.tone === 'ok') { ui.status.delete(target); draw() } }, 1800)
}

/**
 * Runs an action and shows its progress on the row itself (keyed like data-menu): a spinner and a
 * verb while it runs, a short confirmation that fades, or the reason in red until the next click.
 */
async function inline(target        , pending        , done        , call                        , showResult                = () => true)                {
  statusMenus.delete(target)
  ui.status.set(target, { text: pending, tone: 'pending' })
  draw()
  let ok = true
  let reason = ''
  try {
    const r = (await call())
    ok = !(r?.ok === false || r?.removed === false || r?.closed === 0)
    reason = r?.error ?? r?.reason ?? 'Could not do that'
  } catch (e) {
    ok = false
    reason = (e         ).message
  }
  if (!showResult()) return
  ui.status.set(target, ok ? { text: done, tone: 'ok' } : failedStatus(reason, FAILED[pending] ?? 'Failed'))
  draw()
  if (ok) setTimeout(() => { if (ui.status.get(target)?.tone === 'ok') { ui.status.delete(target); draw() } }, 1800)
}

/**
 * A click on an Asleep row: resumes its exact conversation (the worker finds it again and checks its
 * id), with the progress and the real outcome on the row. Still starting is said, not called done.
 */
async function resumeAsleep(workspaceId        , pane        )                {
  const target = `agent:${pane}`
  if (ui.status.get(target)?.tone === 'pending') return
  let starting = ''
  await inline(target, 'Opening…', 'Opened', async () => {
    const r = await orca.plugin.request('sidebar.resumeConversation', { workspaceId, pane }, { timeoutMs: 90_000 })
    if (r.starting) starting = r.error ?? 'The conversation is still resuming in its terminal, which is shown.'
    return r
  }, () => !starting)
  if (!starting) return
  ui.status.set(target, { text: 'Still starting', tone: 'warn', detail: starting })
  draw()
}

/** The short row label of a failed inline action, by its running verb; the reason is its detail. */
const FAILED                         = {
  'Handing over…': 'Handover failed', 'Starting…': "Couldn't start", 'Switching…': "Couldn't switch", 'Sleeping…': "Couldn't sleep",
  'Saving…': "Couldn't save", 'Removing…': "Couldn't remove", 'Restarting…': "Couldn't restart", 'Shuffling…': "Couldn't shuffle",
  'Deleting…': "Couldn't delete", 'Opening…': "Couldn't open"
}

/** The wake menu behind a coordinator row's error (wakeDisplay), keyed like ui.status. */
const statusMenus = new Map                  ()

/** The menu header of a failed or stopped row status: its label, and the full reason under it. */
const statusHeader = (st           )           => ({ header: `${esc(st.text)}<div class="mh-reason">${esc(st.detail ?? st.text)}</div>` })

/**
 * A click on a coordinator row's error icon: the full reason with the ways on. A coordinator click's
 * failure reopens its wake menu (Retry, Show terminal, Start new); any other failure opens the
 * coordinator's menu (Handover, Sessions, Start new) under the reason.
 */
function showStatus(target        )       {
  const key = target.slice(target.indexOf(':') + 1)
  const need = statusMenus.get(target)
  if (need && ui.status.get(target)) { showSessionPicker(key, need, `status:${target}`); return }
  const anchor = document.querySelector             (`[data-status="${CSS.escape(target)}"]`)?.getBoundingClientRect()
  openMenu(coordinatorMenu(key), 12, 12, `status:${target}`, anchor, 'session-menu')
}

const LEVELS                       = [['P0', 'now'], ['P1', 'today'], ['P2', 'soon'], ['P3', 'someday']]

function agentMenu(row              , a           )             {
  const target = `agent:${a.paneKey}`
  // Clicking the row already opens it, so the menu holds only what a click can't do.
  const items             = [
    {
      chips: 'Priority', icon: 'flag',
      options: LEVELS.map(([p, word]) => ({
        label: word,
        active: row.priority === p,
        run: () => inline(target, 'Saving…', row.priority === p ? 'Cleared' : `${p} ${word}`, () => orca.plugin.request('sidebar.setPriority', { workspaceId: row.id, priority: row.priority === p ? null : p }))
      }))
    }
  ]
  if (row.pr) items.push({ label: `Open PR #${row.pr.number}`, icon: 'pr', run: () => void orca.shell?.openExternal(row.pr .url) })
  // Sleep is reversible (the chat is kept), so it neither looks destructive nor asks first. An Asleep
  // conversation has no terminal to close: no Sleep that cannot work.
  if (!asleep(row)) items.push({ label: 'Sleep', icon: 'moon', run: () => inline(target, 'Sleeping…', 'Asleep', () => orca.plugin.request('sidebar.closeSessions', { panes: [a.paneKey] })) }, 'separator')
  // Hidden while any agent in the worktree is mid-turn: removing it would end that agent too.
  if (canRemove(row)) items.push({ label: 'Remove worktree', icon: 'trash', danger: true, run: () => removeWorktree(row, target) })
  return items
}

/**
 * Removes a worktree after a confirm; the menu and a finished lead's remove button both use it. When
 * only a missing PR or uncommitted files stand in the way, asks once more, naming what is lost, and
 * removes anyway on yes.
 */
async function removeWorktree(row              , target        )                {
  // A worktree can hold several chats; say they all go with it.
  const chats = row.agents.length > 1 ? `Removes ${row.name} and its ${row.agents.length} chats. Their sessions end` : 'Its sessions end'
  if (!(await confirmAction('remove-worktree', `Remove ${row.name}?`, `${chats} and the checkout is deleted. The branch is kept.`, 'Remove'))) return
  const remove = (force         ) => orca.plugin.request('sidebar.removeWorktree', { workspaceId: row.id, force }, { timeoutMs: 200_000 })
  // Set by the first try when what stands in the way can be waived.
  let waivable = null
  await inline(target, 'Removing…', 'Removed', async () => {
    const r = await remove(false)
    if (!r.removed && r.branch && r.reason) {
      waivable = { reason: r.reason, branch: r.branch, dirty: r.dirty ?? [] }
      return { ok: true }
    }
    return r
  }, () => waivable === null)
  if (!waivable) return
  ui.status.delete(target)
  draw()
  const { reason, branch, dirty } = waivable
  const files = dirty.length <= 3 ? dirty.join(', ') : `${dirty.slice(0, 3).join(', ')} and ${dirty.length - 3} more`
  const lost = dirty.length ? ` Uncommitted changes will be lost: ${files}.` : ''
  const warning = reason === 'PR status unknown' ? `Could not verify the PR status for branch ${branch}.`
    : reason === 'PR head differs' ? `The merged PR has a different head commit from branch ${branch}.`
    : reason === 'PR not merged' ? `No merged PR was found for branch ${branch}.` : ''
  const body = `${warning}${lost} The branch and its commits are kept.`.trim()
  // Losing work is never remembered: this one always asks.
  if (await confirmAction('remove-anyway', `Remove ${row.name} anyway?`, body, 'Remove anyway', 'trash', 'danger', false))
    await inline(target, 'Removing…', 'Removed', () => remove(true))
}

function handoverItems(c             , compact         )             {
  const key = c.key
  const status = ui.status.get(`coordinator:${key}`)
  const { choices, note, tip } = coordinatorHandover(c, snap?.handoverProviders, status?.tone === 'pending' && status.text === 'Handing over…')
  const actions = choices.map(({ provider, label, retry }) => ({
    provider, label, run: () => inline(`coordinator:${key}`, 'Handing over…', 'Handed over',
      () => orca.plugin.request('sidebar.handover', { key, provider, retry }, { timeoutMs: 150_000 }))
  }))
  const items             = compact && actions.length ? [{ handover: actions, note }]
    : actions.length ? actions.map(a => ({ ...a, iconHtml: `<span class="provider" aria-hidden="true">${PROVIDER_LOGOS[a.provider]}</span>` }))
    : [{ header: `${note === 'Unavailable' ? 'Handover unavailable' : 'Handing over…'}${tip ? `<div class="mh-reason">${esc(explainError(tip).detail)}</div>` : ''}` }]
  if (compact && c.handover?.error) items.push({ header: `Handover incomplete<div class="mh-reason">${esc(explainError(c.handover.error).detail)}</div>` })
  return items
}

function coordinatorMenu(key        )             {
  const c = snap?.coordinators.find((x) => x.key === key)
  if (!c) return []
  const VERBS = { look: ['Shuffling…', 'New look'], restart: ['Restarting…', 'Fresh session'], end: ['Sleeping…', 'Asleep'], delete: ['Deleting…', 'Deleted'] }
  const run = (action                                       , _label        ) =>
    inline(`coordinator:${key}`, VERBS[action][0], VERBS[action][1], () => orca.plugin.request('sidebar.coordinatorAction', { key, action }, { timeoutMs: 90_000 }))
  const st = ui.status.get(`coordinator:${key}`)
  const items             = [
    ...(st && (st.tone === 'bad' || st.tone === 'warn') ? [statusHeader(st), 'separator'         ] : []),
    { label: 'New look', icon: 'shuffle', run: () => run('look', 'New look') },
    reloadItem(c),
    ...handoverItems(c, true),
    'separator',
    { label: 'Start new conversation', icon: 'restart', danger: true, run: async () => {
      if (await confirmAction('restart-coordinator', `Start ${c.name} fresh?`, 'A separate member starts and becomes current. Previous conversations and their pending asks remain available as read-only history.', 'Start fresh', 'restart', 'warn')) await run('restart', 'Fresh session')
    } }
  ]
  const at = items.findIndex((it) => typeof it === 'object' && 'label' in it && it.label === 'New look') + 1
  if (c.members?.length) items.splice(at, 0, { label: 'Conversation history', icon: 'clock', run: () => showHistoryList(key) })
  if (c.session) items.splice(at, 0, { label: 'Sleep', icon: 'moon', run: () => run('end', 'Sleep') })
  items.push({ label: 'Delete coordinator', icon: 'trash', danger: true, run: async () => {
    if (await confirmAction('delete-coordinator', `Delete ${c.name}?`, 'Its sessions end and its folder is deleted. Workers it started keep running.', 'Delete')) await run('delete', 'Delete')
  } })
  return items
}

/** The coordinator menu's Reload skills, with how many of its agents it reaches on the right. */
function reloadItem(c             )           {
  const n = snap ? reloadPlan(snap, { coordinator: c.key }).targets.length : 0
  return { label: 'Reload skills', icon: 'restart', right: n ? `${n} ${n === 1 ? 'agent' : 'agents'}` : 'none running', run: () => reloadSkills({ coordinator: c.key }, `for ${c.name}`, `coordinator:${c.key}`) }
}

/**
 * Reload skills for a scope: shows exactly who gets it by role, who cannot (Codex: restart to
 * reload) and who is skipped (finished, asleep), then asks the worker to write the request. Its
 * progress and outcome show on `target` (the coordinator's row, or the Coordinators heading).
 */
async function reloadSkills(scope             , where        , target        )                {
  if (!snap) return
  const plan = reloadPlan(snap, scope)
  const { title, text, ok } = confirmText(plan, where)
  if (!ok) {
    ui.status.set(target, { text: 'Nothing to reload', tone: 'warn', detail: text })
    draw()
    return
  }
  // Asked every time: the counts are the point of the dialog.
  if (!(await confirmAction('reload-skills', title, text, 'Reload', 'restart', 'warn', false))) return
  await inline(target, 'Requesting…', `Asked ${plan.targets.length}`, () => orca.plugin.request('sidebar.reloadSkills', { scope }, { timeoutMs: 30_000 }))
}

// The row whose menu is open keeps its active look, even across redraws.
let menuTarget                = null
function markTarget()       {
  document.querySelectorAll('.menu-open').forEach((el) => el.classList.remove('menu-open'))
  if (menuTarget) document.querySelector(`[data-menu="${CSS.escape(menuTarget)}"]`)?.classList.add('menu-open')
  document.querySelectorAll             ('.session-trigger').forEach((el) => {
    el.setAttribute('aria-expanded', String(menuTarget === `handover:${el.dataset.handover}`))
  })
  document.querySelectorAll             ('[data-status]').forEach((el) => {
    el.setAttribute('aria-expanded', String(menuTarget === `status:${el.dataset.status}`))
  })
  // A goal's Assign → stays shown while its picker is open, as a Linear row's Send → does.
  document.querySelectorAll             ('[data-gassign]').forEach((el) => {
    const open = menuTarget === `goalassign:${el.dataset.gassign}`
    el.setAttribute('aria-expanded', String(open))
    el.parentElement?.classList.toggle('menu-open', open)
  })
}

function closeMenu()       {
  ctx.hidden = true
  ctx.innerHTML = ''
  menuTarget = null
  markTarget()
}

/** Separators only between groups: none at the ends, never two in a row. */
export function tidy(items            )             {
  const out             = []
  for (const it of items) if (it !== 'separator' || (out.length && out[out.length - 1] !== 'separator')) out.push(it)
  while (out[out.length - 1] === 'separator') out.pop()
  return out
}

function menuHtml(items            )         {
  return items.map((it, i) =>
    it === 'separator' ? '<div class="sep" role="separator"></div>'
      : 'header' in it ? `<div class="mh"${it.tip ? ` data-tip="${esc(it.tip)}"` : ''}>${it.header}</div>`
      : 'providers' in it
        ? `<div class="first-providers">${it.providers.map((p, j) => {
          const mark = providerOf(p.id)
          const label = `Start coordinator with ${p.name}`
          return `<button class="mi first-provider" role="menuitem" aria-label="${esc(label)}" title="${esc(label)}" data-tip="${esc(label)}" data-i="${i}" data-j="${j}">${mark ? `<span class="provider" aria-hidden="true">${PROVIDER_LOGOS[mark]}</span>` : esc(p.name)}</button>`
        }).join('')}</div>`
      : 'handover' in it
        ? `<div class="mchips handover-row"${it.tip ? ` data-tip="${esc(it.tip)}"` : ''}>${iconOf({ icon: 'shuffle' })}<span class="ml">Handover</span>${it.note ? `<span class="mr">${esc(it.note)}</span>` : ''}${it.handover.map((o, j) => `<button class="mi handover-target" role="menuitem" aria-label="${esc(o.label)}" data-tip="${esc(o.label)}" title="${esc(o.label)}" data-i="${i}" data-j="${j}"><span class="provider" aria-hidden="true">${PROVIDER_LOGOS[o.provider]}</span></button>`).join('')}</div>`
      : 'chips' in it
        ? `<div class="mchips" role="group" aria-label="${esc(it.chips)}">${iconOf(it)}<span class="ml">${esc(it.chips)}</span></div><div class="chips${it.wrap ? ' wrap' : ''}">${it.options.map((o, j) => `<button class="mi chip${o.active ? ' on' : ''}" role="menuitemradio" aria-checked="${o.active}" data-i="${i}" data-j="${j}">${esc(o.label)}</button>`).join('')}</div>`
        : `<button class="mi${it.danger ? ' danger' : ''}" role="${it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}"${it.checked === undefined ? '' : ` aria-checked="${it.checked}"`} data-i="${i}">${iconOf(it)}<span class="ml">${esc(it.label)}</span>${it.right ? `<span class="mr${it.accent ? ' sug' : ''}">${esc(it.right)}</span>` : ''}${it.checked === undefined ? '' : `<span class="check">${it.checked ? '✓' : ''}</span>`}</button>`
  ).join('')
}

function place(el             , x        , y        )       {
  const r = el.getBoundingClientRect()
  el.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 6))}px`
  el.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`
}

function runFrom(items            , e            , build                   )       {
  const b = (e.target           ).closest             ('[data-i]')
  if (!b) return
  const item = items[Number(b.dataset.i)]
  if (!item || item === 'separator' || 'header' in item) return
  const stay = Boolean('stay' in item && item.stay && build)
  if (!stay) closeMenu()
  if ('providers' in item) void item.providers[Number(b.dataset.j)]?.run()
  else if ('handover' in item) void item.handover[Number(b.dataset.j)]?.run()
  else if ('chips' in item) void item.options[Number(b.dataset.j)]?.run()
  else void item.run?.()
  if (stay) showItems(tidy(build ()), build)
}

/** Draws a menu's items into the open menu and wires their clicks. */
function showItems(items            , build                   )       {
  const scroll = ctx.scrollTop
  ctx.innerHTML = menuHtml(items)
  ctx.scrollTop = scroll
  ctx.onclick = (e) => runFrom(items, e, build)
}

/**
 * Opens a menu at the pointer, or under `anchor` (above it when there is no room below). Given a
 * builder, items marked `stay` keep it open and it is built again after each one runs.
 */
function openMenu(raw                                 , x        , y        , target        , anchor          , cls = '')       {
  const build = typeof raw === 'function' ? raw : undefined
  const items = tidy(build ? build() : (raw              ))
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
  const el = (e.target           ).closest             ('[data-menu]')
  if (!el || !snap) return
  e.preventDefault()
  const target = el.dataset.menu
  const [kind, id] = [target.split(':')[0], target.slice(target.indexOf(':') + 1)]
  if (kind === 'history') return showHistoryList(id)
  if (kind === 'coordinator') return openMenu(coordinatorMenu(id), e.clientX, e.clientY, target)
  if (kind === 'linear') return openMenu(sendMenu(id), e.clientX, e.clientY, target)
  const row = snap.rows.find((r) => r.agents.some((a) => a.paneKey === id))
  const a = row?.agents.find((x) => x.paneKey === id)
  if (row && a) openMenu(agentMenu(row, a), e.clientX, e.clientY, target)
})
/** The menu a button opens with a click (its key, as `menuTarget`), or null for anything else. */
function openerOf(target                    )                {
  const el = target instanceof Element ? target.closest             ('[data-ldisplay],[data-lsend],[data-handover],[data-sessions],[data-status],[data-gassign]') : null
  if (!el) return null
  if (el.dataset.gassign) return `goalassign:${el.dataset.gassign}`
  if (el.dataset.status) return `status:${el.dataset.status}`
  if (el.dataset.handover) return `handover:${el.dataset.handover}`
  if (el.dataset.sessions) return `sessions:${el.dataset.sessions}`
  return 'ldisplay' in el.dataset ? 'display' : `linear:${el.dataset.lsend}`
}
const opener = openerToggle()
// A press outside the open menu closes it; one on the button that opened it also keeps the click
// that follows from opening it again (src/panel/opener.ts).
document.addEventListener('pointerdown', (e) => {
  opener.press(ctx.hidden ? null : menuTarget, e.button === 0 ? openerOf(e.target) : null)
  if (!ctx.hidden && !ctx.contains(e.target        )) closeMenu()
}, true)
// Scrolling the page by hand closes a menu; scrolling inside a long one (Display's projects) does not.
// Listen for the wheel, not for scroll: a redraw that shortens a scrolled list (a Display option
// that hides issues, a Linear refresh) moves its scroll position too, and that must not close the menu.
document.addEventListener('wheel', (e) => { if (!ctx.hidden && !ctx.contains(e.target        )) closeMenu() }, { capture: true, passive: true })
const menuKeys = (menu             ) => (e               ) => {
  const items = [...menu.querySelectorAll             ('.mi')]
  const i = items.indexOf(document.activeElement               )
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
function sendMenu(id        )             {
  const issue = linear?.issues.find((i) => i.id === id)
  if (!issue || !snap) return []
  const order = coordinatorOrder(snap)
  const items             = [{ header: `Send <b>${esc(issue.id)}</b> to` }]
  for (const t of sendTargets(issue.team, order, linear?.lastSent)) {
    const c = order.find((x) => x.key === t.key)
    items.push({ label: c.name, iconHtml: coordinatorCharacter(c, 16), right: t.suggested ?? (c.repos.length ? c.repos.join(', ') : ''), accent: Boolean(t.suggested), run: () => sendIssue(issue, c) })
  }
  if (!order.length) items.push({ header: 'No coordinators yet' })
  items.push('separator')
  if (issue.url) items.push({ label: 'Open in Linear', iconHtml: LINEAR_MARK, run: () => void orca.shell?.openExternal(issue.url) })
  items.push({ label: 'Copy ID', icon: 'copy', run: () => void navigator.clipboard?.writeText(issue.id).catch(() => {}) })
  return items
}

/** Sends an issue, with "Sending…" on its row; then a toast to open the coordinator's chat, or the reason on the row. */
async function sendIssue(issue             , c             )                {
  const target = `linear:${issue.id}`
  ui.status.set(target, { text: 'Sending…', tone: 'pending' })
  draw()
  try {
    const r = await orca.plugin.request('sidebar.linearSend', { issue: issue.id, coordinator: c.key }, { timeoutMs: 120_000 })
    if (r.ok) {
      ui.status.delete(target)
      showToast(c, issue.id, r.warnings ?? [], r.recipient)
    } else ui.status.set(target, failedStatus(r.error ?? 'Could not send', "Couldn't send"))
  } catch (e) {
    ui.status.set(target, failedStatus((e         ).message, "Couldn't send"))
  }
  draw()
}

let toastTimer
function showToast(c             , id        , warnings          , recipient                                             )       {
  clearTimeout(toastTimer)
  const warn = warnings.length ? `<span class="twarn" data-tip="${esc(warnings.join('\n'))}" data-tone="warn">Linear not updated</span>` : ''
  toastEl.innerHTML = `${coordinatorCharacter(c, 16, 'working')}<span class="t">Sent ${esc(id)} to ${esc(c.name)}</span>${warn}<button class="act" ${recipient ? `data-history="${esc(c.key)}" data-member="${esc(recipient.member)}" data-history-terminal="${esc(recipient.terminal)}" data-history-session="${esc(recipient.orcaSession ?? '')}"` : `data-sessions="${esc(c.key)}"`}>View recipient</button>`
  toastEl.hidden = false
  toastTimer = setTimeout(hideToast, warnings.length ? 12_000 : 8000)
}
function hideToast()       {
  clearTimeout(toastTimer)
  toastEl.hidden = true
}


// ---------- the Linear section's Display popover ----------

/**
 * Group by, Sort by and Show as chips; the projects of the current filter's issues (color, name,
 * count) to narrow to, "All projects" first and "No project" last; then Reset. It stays open while
 * options change, and every change is saved with the section's fold and filter.
 */
function displayMenu()             {
  if (!linear) return []
  const d = ui.linearDisplay
  const set = (next         ) => {
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
    ...[...projects, ...missing].map((p)           => ({ label: p.name, iconHtml: projectDot(p.key ? p.color : ''), right: String(p.count), checked: d.projects.includes(p.key), stay: true, run: () => set(toggleProject(d, p.key)) })),
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
function sessionDialog(title        , body        )       {
  sessionDialogVersion++
  sessionsDialog.innerHTML = `<header><strong>${esc(title)}</strong><button data-session-close aria-label="Close sessions">×</button></header>${body}`
  sessionsDialog.querySelector('[data-session-close]')?.addEventListener('click', () => sessionsDialog.close())
  if (!sessionsDialog.open) sessionsDialog.showModal()
}

async function showHistory(key        , member        , terminal         , sourceSession         )                {
  sessionDialog('Read-only history', '<p>Reading the exact recorded session…</p>')
  const version = sessionDialogVersion
  try {
    const history = await orca.plugin.request('sidebar.coordinatorHistory', { key, member, ...(terminal ? { terminal } : {}), ...(sourceSession !== undefined ? { orcaSession: sourceSession || null } : {}) })
    if (!sessionsDialog.open || version !== sessionDialogVersion) return
    sessionDialog(history.title, `<p class="session-note">Read-only terminal scrollback excerpt (not a complete transcript). Current recipient and existing run routes are unchanged.</p>${history.unavailable ? `<p role="status">${esc(history.unavailable)}</p>` : `<pre class="session-history">${esc(history.text || 'No readable output is available for this terminal.')}</pre>${history.truncated ? '<p class="session-note">Showing a bounded excerpt, not the full conversation.</p>' : ''}`}<button data-session-back>Back to history</button>`)
    sessionsDialog.querySelector('[data-session-back]')?.addEventListener('click', () => showHistoryList(key))
  } catch (e) { if (!sessionsDialog.open || version !== sessionDialogVersion) return; sessionDialog('History unavailable', `<p>${esc((e         ).message)}</p>`) }
}

/**
 * One choice is one explicit switch; opening the dropdown has no side effects. A coordinator click
 * that needs the person opens it with `need`: a short header with the full reason under it, Retry
 * when it may help, Show terminal when the attempt left one, the conversations to pick, then Start
 * new conversation.
 */
function showFirstProviderPicker(key        , providers                       , reason         )       {
  const anchor = document.querySelector             (`[data-menu="coordinator:${CSS.escape(key)}"] .coord-name`)
  const detail = reason && reason !== 'Choose a provider for the first conversation.' ? reason : ''
  const items             = [{ header: `Choose provider${detail ? `<div class="mh-reason">${esc(detail)}</div>` : ''}` }]
  if (providers.length) items.push({ providers: providers.map((p) => ({ ...p, run: () => wake(key, p.id) })) })
  else items.push({ label: 'Retry availability', icon: 'restart', run: () => wake(key) })
  openMenu(items, 12, 12, `providers:${key}`, anchor?.getBoundingClientRect(), 'first-provider-menu')
}

function showSessionPicker(key        , need           , menuKey = `sessions:${key}`)       {
  const c = snap?.coordinators.find((c) => c.key === key)
  if (!c || !snap) return
  const anchor = document.querySelector             (`[data-menu="coordinator:${CSS.escape(key)}"] .coord-name`)
  const target = `coordinator:${key}`
  const choices = !need || need.sessions ? sessionChoices(c, snap.rows) : []
  const picks             = choices.map((choice) => ({
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
  const items             = need ? [
    { header: `${esc(need.header)}${need.reason ? `<div class="mh-reason">${esc(need.reason)}</div>` : ''}` },
    ...(need.retry ? [{ label: 'Retry', icon: 'restart', run: () => wake(key) }] : []),
    ...(shown ? [{ label: 'Show terminal', icon: 'open', run: () => inline(target, 'Opening…', 'Shown', async () => ({ ok: (await orca.plugin.request('sidebar.open', shown)).opened })) }] : []),
    // A separator only parts picks from Start new; Retry sits directly above it.
    ...(picks.length ? [...picks, 'separator'         ] : []),
    { label: 'Start new conversation', icon: 'plus', run: () => inline(target, 'Starting…', 'Started', () => orca.plugin.request('sidebar.coordinatorSessions', { key, action: 'fresh', ...(need.agent ? { agent: need.agent } : {}) }, { timeoutMs: 90_000 })) }
  ] : picks.length ? picks : [{ header: 'No open conversations' }]
  if (!need && menuTarget === `sessions:${key}`) { closeMenu(); return }
  openMenu(items, 12, 12, menuKey, anchor?.getBoundingClientRect(), 'session-menu')
}

/** Read-only history is separate from choosing the main conversation. */
function showHistoryList(key        )       {
  const c = snap?.coordinators.find((c) => c.key === key)
  if (!c) return
  const members = c.members ?? []
  sessionDialog(`${c.name} / History`, members.map((m, i) => `<button class="session-history-choice" data-history-index="${i}">${esc(m.agentType ?? 'Session')} · ${esc(m.title)}</button>`).join('') || '<p>No recorded conversation history is available.</p>')
  sessionsDialog.querySelectorAll             ('[data-history-index]').forEach((b) => b.addEventListener('click', () => void showHistory(key, members[Number(b.dataset.historyIndex)].id)))
}

// ---------- Goals ----------
// The section (header and rows) is redrawn with the rest. The add box and the details card are not: they
// live outside every redrawn section, so a live repaint never takes the focus or the text out of them.
// The card is redrawn part by part, leaving the one the person types in alone.

const GOAL_CLICKS = '[data-gfold],[data-gcompleted],[data-gadd],[data-gopen],[data-gstep],[data-gfinish],[data-greopen],[data-gconfirm],[data-gnot],[data-gjump],[data-gassign]'
const saveGoalsUi = () => void orca.storage.set(GOALS_UI_KEY, { folded: ui.goalsFolded }).catch(() => null)
orca.storage.get(GOALS_UI_KEY).then((stored) => {
  const saved = goalsUiOf(stored)
  ui.goalsFolded = saved.folded
  draw()
}).catch(() => null)
const readGoals = () => !goalsIsOn() ? Promise.resolve() : orca.plugin.request('sidebar.goals').then((g) => { if (goalsIsOn()) { goals = g              ; draw() } }).catch(() => null)
orca.plugin.on('sidebar.goalsChanged', (g) => { if (!goalsIsOn()) return; goals = g              ; draw() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void readGoals() })

/** A short line in the toast: a refused goal edit, a session that is gone. */
function goalToast(text        )       {
  clearTimeout(toastTimer)
  toastEl.innerHTML = `<span class="t">${esc(text)}</span>`
  toastEl.hidden = false
  toastTimer = setTimeout(hideToast, 6000)
}

/** "Completed ›": the Completed goals tab opens (or comes forward) in the focused workspace. */
async function openCompletedTab()                {
  try {
    const r = await orca.plugin.request('goals.openCompleted')
    if (!r.opened) goalToast(r.reason ?? 'Could not open the Completed goals tab')
  } catch (e) {
    goalToast(`Could not open the Completed goals tab: ${(e         ).message}`)
  }
}

/**
 * A goal reopened in the Completed goals tab: its row in the active list is scrolled into view once and flashes once, without
 * opening its card. A redraw within the flash puts the class back, part-way through the animation.
 */
let flash                                                       = null
const FLASH_MS = 900
orca.plugin.on('sidebar.goalFlash', ({ id }) => { flash = { id, at: Date.now(), scrolled: false }; flashGoal() })
function flashGoal()       {
  if (!flash) return
  const age = Date.now() - flash.at
  if (age > FLASH_MS) { flash = null; return }
  const el = goalsIsOn() ? goalRowEl(flash.id) : null
  if (!el) return
  if (!flash.scrolled) { flash.scrolled = true; el.scrollIntoView({ block: 'nearest' }) }
  el.style.setProperty('--flash-delay', `-${age}ms`)
  el.classList.add('flash')
}

/** Runs one of the user's edits; the answer is the goals after it. A refusal is said in the toast. */
async function goalAct(a            )                   {
  if (!goalsIsOn()) return false
  try {
    const r = await orca.plugin.request('sidebar.goalAction', a)
    goals = r.goals
    if (!r.ok) goalToast(r.error ?? 'Could not change the goal')
    draw()
    return r.ok
  } catch (e) {
    void readGoals()
    return false
  }
}

const goalById = (id                    ) => goals?.find((g) => g.id === id)

// ---------- the Next step's button ----------

/**
 * Jump to agent: reads the snapshot again (the worker's refresh), checks that the session is still live and still
 * the current one (a coordinator's current session after a handover), and only then focuses its tab and pane
 * through sidebar.open, the path a row click takes. A session that is gone is never focused: the toast says so and
 * the button offers Assign to coordinator.
 */
async function goalJump(id        )                {
  try { snap = (await orca.plugin.request('sidebar.list'))             } catch {}
  const g = goalById(id)
  const target = g && snap ? jumpTarget(g, snap, ui.goalGone) : null
  if (!target) { goalToast('The agent on this step is gone. Assign it to a coordinator instead.'); draw(); return }
  let opened = false
  try { opened = (await orca.plugin.request('sidebar.open', { workspaceId: target.workspaceId, terminal: target.terminal })).opened } catch {}
  if (!opened) {
    ui.goalGone?.add(target.terminal)
    goalToast(`${target.name}'s session is gone. Assign this step to a coordinator instead.`)
  }
  draw()
}

/** Assign to coordinator: a small picker of the coordinators with a live current session; none: says so. */
function goalAssignMenu(id        )             {
  const g = goalById(id)
  if (!g || !snap) return []
  const live = liveCoordinators({ rows: snap.rows, coordinators: coordinatorOrder(snap) })
  if (!live.length) return [{ header: 'No coordinator has a live session' }]
  return [{ header: 'Assign next step to' }, ...live.map((c)           => {
    const mark = providerOf(c.session?.agentType ?? null)
    return { label: c.name, iconHtml: mark ? `<span class="provider" aria-hidden="true">${PROVIDER_LOGOS[mark]}</span>` : coordinatorCharacter(c, 16), run: () => goalAssign(g, c.key) }
  })]
}

/** Sends the exact Next text the button was drawn for; Assigning… until the worker answers, then Jump to agent. */
async function goalAssign(g          , coordinator        )                {
  const next = nextText(g)
  if (!goalsIsOn() || !next || ui.goalAssigning?.has(g.id)) return
  ui.goalAssigning?.add(g.id)
  draw()
  try {
    const r = await orca.plugin.request('sidebar.goalAssign', { id: g.id, coordinator, next }, { timeoutMs: 120_000 })
    goals = r.goals
    if (!r.ok) goalToast(r.error ?? 'Could not assign the step')
    else if (r.warning) goalToast(r.warning)
  } catch (e) {
    goalToast((e         ).message)
    void readGoals()
  } finally {
    ui.goalAssigning?.delete(g.id)
    draw()
  }
}
const goalRowEl = (id        ) => goalsRowsEl.querySelector             (`[data-gopen="${CSS.escape(id)}"]`)

function setGoalAdding(on         )       {
  if (on && ui.goalsFolded) { ui.goalsFolded = false; saveGoalsUi() }
  goalAddEl.hidden = !on
  if (on) { closeGoalCard(); draw(); goalNewEl.focus() } else { goalNewEl.value = ''; if (document.activeElement === goalNewEl) goalNewEl.blur() }
}

/** Saves the field the person was in, if it changed: the card's text fields, or a new step. */
function commitGoalEdit(el             )       {
  const field = el.dataset.gedit
  const g = goalById(el.dataset.g)
  if (!field || !g) return
  const value = (el.textContent ?? '').trim()
  if (field === 'newStep') {
    el.textContent = ''
    if (value) void goalAct({ action: 'addStep', id: g.id, text: value })
    return
  }
  const key = field
  if (key === 'title' && !value) { el.textContent = g.title; return }
  if (value !== (g[key] ?? '')) void goalAct({ action: 'update', id: g.id, patch: { [key]: value } })
}

function hideGoalCard()       {
  ui.goalOpen = null
  goalPop.hidden = true
  goalPop.innerHTML = ''
  goalPop.close()
}

function closeGoalCard(restoreFocusToRow = false)       {
  const id = ui.goalOpen
  if (!id) return
  const active = document.activeElement
  if (active instanceof HTMLElement && goalPop.contains(active)) {
    if (active.dataset.gedit) commitGoalEdit(active)
    if (restoreFocusToRow) queueMicrotask(() => goalRowEl(id)?.focus({ preventScroll: true }))
  }
  hideGoalCard()
  draw()
}

/** Puts the card under its row (above it when there is no room below) and keeps it on screen. */
function placeGoalCard()       {
  const row = ui.goalOpen ? goalRowEl(ui.goalOpen) : null
  if (!row || goalPop.hidden) return
  const r = row.getBoundingClientRect()
  const h = goalPop.getBoundingClientRect().height
  const below = r.bottom + 4
  const top = below + h <= window.innerHeight - 8 ? below : r.top - 4 - h >= 8 ? r.top - 4 - h : Math.max(8, window.innerHeight - 8 - h)
  goalPop.style.top = `${Math.round(top)}px`
}

/** Brings the open card up to date with the goals: part by part, leaving what the person types in alone. */
function sync(cur         , fresh         )       {
  const active = document.activeElement
  if (!active || !cur.contains(active)) {
    if (cur.innerHTML !== fresh.innerHTML) cur.innerHTML = fresh.innerHTML
    return
  }
  // A step that has focus (a click or Space gave it) is redrawn like the rest, and focus goes back to the same step.
  // Anything else with focus (the fields a person types in, a button) is left alone, with the part around it.
  const step = active instanceof HTMLElement ? active.dataset.gstep : undefined
  for (let i = 0; i < cur.children.length && i < fresh.children.length; i++) {
    const c = cur.children[i]
    const holdsFocus = c === active || c.contains(active)
    if (holdsFocus && !step) continue
    if (c.outerHTML === fresh.children[i].outerHTML) continue
    c.replaceWith(fresh.children[i].cloneNode(true))
    if (holdsFocus) cur.querySelector             (`[data-gstep="${step}"]`)?.focus({ preventScroll: true })
  }
}

function paintGoalCard()       {
  const g = goalById(ui.goalOpen ?? undefined)
  if (!g || !goalRowEl(g.id)) {
    if (ui.goalOpen) hideGoalCard()
    return
  }
  const html = goalCard(g, ui.now)
  if (goalPop.hidden) {
    goalPop.innerHTML = html
    goalPop.hidden = false
    goalPop.showModal()
    goalPop.focus({ preventScroll: true })
  } else {
    const fresh = document.createElement('div')
    fresh.innerHTML = html
    const names = (root         ) => [...root.children].map((c) => (c               ).dataset.part).join()
    if (names(goalPop) !== names(fresh)) {
      // A part came or went (the proposal note): rebuild, unless the person is typing in the card.
      if (!goalPop.contains(document.activeElement)) goalPop.innerHTML = html
    } else for (let i = 0; i < goalPop.children.length; i++) sync(goalPop.children[i], fresh.children[i])
  }
  placeGoalCard()
}
goalsEl.addEventListener('scroll', placeGoalCard, { passive: true })
window.addEventListener('resize', placeGoalCard)

document.addEventListener('click', (event) => {
  const el = (event.target           ).closest             (GOAL_CLICKS)
  if (!el) return
  const d = el.dataset
  if ('gfold' in d) { ui.goalsFolded = !ui.goalsFolded; saveGoalsUi(); draw(); return }
  if ('gcompleted' in d) { void openCompletedTab(); return }
  if ('gadd' in d) { setGoalAdding(!!goalAddEl.hidden); return }
  if (d.gopen) {
    const was = ui.goalOpen
    if (was) closeGoalCard()
    if (was !== d.gopen) { setGoalAdding(false); ui.goalOpen = d.gopen; el.scrollIntoView({ block: 'nearest' }); draw(); paintGoalCard() }
    return
  }
  if (d.gjump) { void goalJump(d.gjump); return }
  if (d.gassign) {
    const target = `goalassign:${d.gassign}`
    if (menuTarget === target) closeMenu()
    // Under the goal's row, as a Linear row's send menu opens under its row (the pill itself may be hidden: keyboard).
    else if (opener.shouldOpen(target)) openMenu(goalAssignMenu(d.gassign), 12, 12, target, (el.parentElement ?? el).getBoundingClientRect())
    return
  }
  if (d.gstep) {
    const step = Number(d.gstep)
    const g = el.dataset.g
    // The new value comes from the goal, never from the card's markup, which can be a moment behind.
    const now = g ? goalById(g)?.steps[step - 1] : undefined
    if (g && now) void goalAct({ action: 'step', id: g, step, done: !now.done })
    return
  }
  const id = d.gfinish ?? d.greopen ?? d.gconfirm ?? d.gnot
  if (!id) return
  const action = d.gfinish ? 'done' : d.greopen ? 'reopen' : d.gconfirm ? 'confirm' : 'reject'
  closeGoalCard()
  void goalAct({ action, id })
})

// Esc closes the card or the add box.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!ctx.hidden || settingsOpen()) return
    if (!goalAddEl.hidden && (document.activeElement === goalNewEl || !ui.goalOpen)) { e.preventDefault(); setGoalAdding(false); return }
    if (ui.goalOpen) { e.preventDefault(); closeGoalCard(true) }
    return
  }
  const t = e.target
  if (t === goalNewEl && e.key === 'Enter') {
    e.preventDefault()
    const title = goalNewEl.value.trim()
    if (title) { setGoalAdding(false); void goalAct({ action: 'add', title }) }
    return
  }
  if (t.dataset?.gedit && e.key === 'Enter' && !e.shiftKey && t.dataset.gedit !== 'note') {
    e.preventDefault()
    if (t.dataset.gedit === 'newStep') commitGoalEdit(t)
    else t.blur()
    return
  }
  if (t.dataset?.gstep && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); t.click() }
})
// The browser retargets backdrop events to the dialog. Dismiss on a completed click
// outside its bounds so a drag from a text field or a click on its padding stays inside.
function onGoalBackdrop(e            )          {
  if (e.target !== goalPop) return false
  const r = goalPop.getBoundingClientRect()
  return e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom
}
let pressedGoalBackdrop = false
goalPop.addEventListener('pointerdown', (e) => { pressedGoalBackdrop = onGoalBackdrop(e) })
goalPop.addEventListener('click', (e) => {
  if (pressedGoalBackdrop && onGoalBackdrop(e)) closeGoalCard(true)
  pressedGoalBackdrop = false
})
goalPop.addEventListener('cancel', (e) => { e.preventDefault(); closeGoalCard(true) })
goalPop.addEventListener('focusout', (e) => { const t = e.target               ; if (t.dataset?.gedit) commitGoalEdit(t) })
// "+" keeps the add box's focus on press, so a click on it closes the box instead of blurring it and opening it again.
goalsHeadEl.addEventListener('pointerdown', (e) => { if ((e.target           ).closest('[data-gadd]')) e.preventDefault() })
goalNewEl.addEventListener('blur', () => { if (!goalNewEl.value.trim()) setGoalAdding(false) })
// Generated by scripts/build-frames.mjs from the .ts file of the same name. Do not edit.
