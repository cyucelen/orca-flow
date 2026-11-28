// The Completed goals tab's frame: asks the worker for the completed goals (goals.completed), draws src/completed-goals-view.ts, and
// handles search, filters, the details, Reopen and Undo. Read-only apart from Reopen and Undo, which the worker applies as the
// user's (goals.reopen, goals.restore). The file the tab shows is only a stub (src/usage-open.ts): its content is ignored.
import { BATCH, completedParts, completedUi, doneAtOf, filterCompleted, LINKED, SKELETON, savedUiOf, SORT, toastHtml, UI_KEY, WITHIN,                                                             } from '../completed-goals-view.js'
import { externalLink } from '../panel/links.js'

const $ =                                      (id        ) => document.getElementById(id)
const app = $('app')
app.innerHTML = SKELETON
const head = $('head')
const tools = $('tools')
const filtersEl = $('filters')
const sideEl = $('qside')
const countEl = $('count')
const body = $('body')
const search = $                  ('q')
const toastSlot = $('toast-slot')
const liveEl = $('live')

const ui = completedUi()
const data                = { phase: 'loading', goals: [], error: null }
/** Read again while the tab is visible: a goal completed by an agent's `orca-flow goal` is also announced by the worker (goals.changed). */
const REFRESH_MS = 20_000
const message = (e         ) => (e instanceof Error ? e.message : String(e)).split('\n')[0]
const wide = () => matchMedia('(min-width: 760px)').matches
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const wait = (ms        ) => new Promise      ((r) => setTimeout(r, ms))

// ---------- drawing ----------

/** What has the keyboard focus, as a selector that finds the same logical element after a redraw. */
function focusSelector()                {
  const el = document.activeElement
  if (!el || !app.contains(el) || el === search) return null
  const d = el.dataset
  if (d.open) return `[data-open="${CSS.escape(d.open)}"]`
  if (d.reopen) return `[data-reopen="${CSS.escape(d.reopen)}"]${el.closest('.dpane,.dscreen') ? '.gbtn:not(.quiet)' : '.rbtn'}`
  if (d.f) return `[data-f="${d.f}"][data-v="${d.v}"]`
  if ('more' in d) return '[data-more]'
  if ('backto' in d) return '[data-backto]'
  if ('clearAll' in d) return '[data-clear-all]'
  if ('retry' in d) return '[data-retry]'
  return null
}

function draw()       {
  const keep = { x: window.scrollX, y: window.scrollY }
  const focus = focusSelector()
  const p = completedParts(data, ui, Date.now())
  head.innerHTML = p.head
  tools.hidden = !p.tools
  filtersEl.innerHTML = p.filters
  sideEl.innerHTML = p.side
  countEl.innerHTML = p.count
  body.innerHTML = p.body
  if (document.activeElement === document.body && focus) app.querySelector             (focus)?.focus({ preventScroll: true })
  window.scrollTo(keep.x, keep.y)
}

// ---------- reading ----------

let reading = false
let readAgain = false
async function load()                {
  if (reading) { readAgain = true; return }
  reading = true
  try {
    const wire = await orca.plugin.request('goals.completed')
    const before = filterCompleted(data.goals, ui, Date.now()).rows.map((r) => r.g.id)
    data.goals = wire.goals
    data.phase = wire.on ? 'ready' : 'off'
    data.error = null
    // The selected goal is gone (reopened in the sidebar or by an agent): the selection moves to the next row, with no toast.
    const stillThere = (id               ) => !!id && data.goals.some((g) => g.id === id && g.status === 'done')
    if (ui.sel && !stillThere(ui.sel)) {
      const after = new Set(filterCompleted(data.goals, ui, Date.now()).rows.map((r) => r.g.id))
      const i = before.indexOf(ui.sel)
      const next = before.slice(i + 1).find((id) => after.has(id)) ?? before.slice(0, Math.max(0, i)).reverse().find((id) => after.has(id)) ?? null
      ui.sel = wide() ? next : null
      if (!ui.sel) ui.screen = 'list'
    }
    if (ui.rove && !stillThere(ui.rove)) ui.rove = null
  } catch (e) {
    data.error = message(e)
  } finally {
    reading = false
  }
  draw()
  if (readAgain) { readAgain = false; void load() }
}

// ---------- the toast ----------

let toast               = null
let toastTimer
const armToast = (ms        ) => { clearTimeout(toastTimer); toastTimer = setTimeout(() => showToast(null), ms) }
function showToast(t              )       {
  toast = t
  clearTimeout(toastTimer)
  toastSlot.innerHTML = t ? toastHtml(t) : ''
  if (t) armToast(t.kind === 'reopened' ? 8000 : t.kind === 'undone' ? 3000 : 6000)
}
// It waits while the pointer is on it or focus is inside it.
toastSlot.addEventListener('pointerenter', () => clearTimeout(toastTimer))
toastSlot.addEventListener('pointerleave', () => { if (toast) armToast(4000) })
toastSlot.addEventListener('focusin', () => clearTimeout(toastTimer))
toastSlot.addEventListener('focusout', () => { if (toast) armToast(4000) })

// ---------- Reopen and Undo ----------

let acting = false
async function reopen(id        )                {
  const g = data.goals.find((x) => x.id === id && x.status === 'done')
  if (!g || acting || data.error) return
  acting = true
  try {
    const rows = filterCompleted(data.goals, ui, Date.now()).rows
    const i = rows.findIndex((r) => r.g.id === id)
    const next = rows[i + 1]?.g.id ?? rows[i - 1]?.g.id ?? null
    const li = body.querySelector             (`.crow[data-id="${CSS.escape(id)}"]`)
    const animate = !!li && !reduced()
    if (animate) li .classList.add('gone')
    const [result] = await Promise.all([
      orca.plugin.request('goals.reopen', { id }).catch((e         ) => ({ ok: false, error: message(e) })),
      animate ? wait(200) : Promise.resolve()
    ])
    if (!result.ok) {
      li?.classList.remove('gone')
      showToast({ kind: 'error', text: `Could not reopen “${g.title}”: ${result.error ?? 'the worker refused'}` })
      return
    }
    const undo       = { id, title: g.title, doneAt: doneAtOf(g), proposedBy: g.proposedBy ?? null }
    data.goals = data.goals.filter((x) => x.id !== id)
    if (ui.sel === id) ui.sel = wide() ? next : null
    if (ui.rove === id) ui.rove = next
    if (!ui.sel) ui.screen = 'list'
    draw()
    showToast({ kind: 'reopened', title: g.title, undo })
    ;((next ? body.querySelector             (`[data-open="${CSS.escape(next)}"]`) : null) ?? (tools.hidden ? null : search))?.focus({ preventScroll: true })
    void load()
  } finally {
    acting = false
  }
}

async function undo(u      )                {
  if (acting) return
  acting = true
  try {
    const result = await orca.plugin.request('goals.restore', { id: u.id, doneAt: u.doneAt, ...(u.proposedBy ? { proposedBy: u.proposedBy } : {}) }).catch((e         ) => ({ ok: false, error: message(e) }))
    if (!result.ok) { showToast({ kind: 'error', text: `Could not mark “${u.title}” done again: ${result.error ?? 'the worker refused'}` }); return }
    acting = false
    await load()
    if (wide() && data.goals.some((g) => g.id === u.id)) ui.sel = u.id
    ui.rove = u.id
    draw()
    const li = body.querySelector             (`.crow[data-id="${CSS.escape(u.id)}"]`)
    li?.classList.add('back-in')
    li?.querySelector             ('.copen')?.focus({ preventScroll: false })
    showToast({ kind: 'undone', title: u.title })
  } finally {
    acting = false
  }
}

// ---------- persistence: Completed within and Sort only ----------

const saveUi = () => void orca.storage.set(UI_KEY, { within: ui.within, sort: ui.sort }).catch(() => null)

// ---------- events ----------

const focusRow = (id               ) => (id ? body.querySelector             (`[data-open="${CSS.escape(id)}"]`) : null)?.focus({ preventScroll: true })
let liveTimer
const say = () => { clearTimeout(liveTimer); liveTimer = setTimeout(() => { liveEl.textContent = completedParts(data, ui, Date.now()).countText }, 600) }

document.addEventListener('click', (event) => {
  const target = event.target
  const url = externalLink(target)
  if (url) { void orca.shell?.openExternal(url); return }
  const t = target.closest             ('[data-f],[data-open],[data-reopen],[data-undo],[data-dismiss],[data-more],[data-clear-all],[data-clear-q],[data-backto],[data-wt],[data-retry]')
  if (!t) return
  const d = t.dataset
  if (d.f) {
    if (d.f === 'within' && WITHIN.some(([v]) => v === d.v)) ui.within = d.v
    else if (d.f === 'linked' && LINKED.some(([v]) => v === d.v)) ui.linked = d.v
    else if (d.f === 'sort' && SORT.some(([v]) => v === d.v)) ui.sort = d.v
    else return
    ui.limit = BATCH
    if (d.f !== 'linked') saveUi()
    draw()
    filtersEl.querySelector             (`[data-f="${d.f}"][data-v="${d.v}"]`)?.focus()
    say()
    return
  }
  if (d.open) {
    ui.sel = d.open
    ui.rove = d.open
    if (!wide()) { ui.screen = 'detail'; draw(); window.scrollTo(0, 0); body.querySelector             ('.back')?.focus(); return }
    draw()
    focusRow(d.open)
    return
  }
  if (d.reopen) { void reopen(d.reopen); return }
  if ('undo' in d) { if (toast?.kind === 'reopened') { const u = toast.undo; showToast(null); void undo(u) } return }
  if ('dismiss' in d) { showToast(null); return }
  if ('more' in d) {
    const first = ui.limit
    ui.limit += BATCH
    draw()
    body.querySelectorAll             ('.copen')[first]?.focus()
    return
  }
  if ('clearAll' in d) {
    ui.q = ''
    ui.within = 'all'
    ui.linked = 'any'
    ui.limit = BATCH
    search.value = ''
    saveUi()
    draw()
    search.focus()
    say()
    return
  }
  if ('clearQ' in d) { ui.q = ''; search.value = ''; ui.limit = BATCH; draw(); search.focus(); say(); return }
  if ('backto' in d) { const id = ui.sel; ui.screen = 'list'; draw(); focusRow(id); return }
  if (d.wt) { void orca.plugin.request('sidebar.open', { workspaceId: d.wt }).catch(() => null); return }
  if ('retry' in d) void load()
})

search.addEventListener('input', () => {
  ui.q = search.value
  ui.limit = BATCH
  draw()
  say()
})

document.addEventListener('keydown', (event) => {
  const e = event
  const t = e.target
  const inField = !!t.matches?.('input, textarea, [contenteditable]')
  if (e.key === '/' && !inField && !tools.hidden && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); search.focus(); return }
  if (e.key === 'Escape') {
    if (t === search && ui.q) { ui.q = ''; search.value = ''; draw(); say(); return }
    if (ui.screen === 'detail') { body.querySelector             ('[data-backto]')?.click(); return }
    if (toast) { showToast(null); return }
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !inField && toast?.kind === 'reopened') { e.preventDefault(); const u = toast.undo; showToast(null); void undo(u); return }
  // The list is one tab stop: Up, Down, Home and End move between rows, Tab goes on to the row's Reopen.
  const row = t.closest?.             ('.copen')
  if (row && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault()
    const all = [...body.querySelectorAll             ('.copen')]
    const i = all.indexOf(row)
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
    all.forEach((b, k) => { b.tabIndex = k === j ? 0 : -1; b.closest('.crow')?.querySelector             ('.rbtn')?.setAttribute('tabindex', k === j ? '0' : '-1') })
    ui.rove = all[j]?.dataset.open ?? ui.rove
    all[j]?.focus()
    all[j]?.scrollIntoView({ block: 'nearest' })
  }
})

// ---------- refresh: the worker's goals.changed, a visible tab, and a slow timer ----------

let soon
orca.plugin.on('goals.changed', () => { clearTimeout(soon); soon = setTimeout(() => void load(), 150) })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void load() })
setInterval(() => { if (document.visibilityState === 'visible') void load() }, REFRESH_MS)

// ---------- start ----------

async function start()                {
  draw()
  // The stub's text is never read; asking for the document only tells Orca the frame is up.
  void Promise.resolve((orca                                                         ).document?.get()).catch(() => null)
  try {
    Object.assign(ui, savedUiOf(await orca.storage.get(UI_KEY)))
  } catch {
    // no storage: unfiltered, newest first
  }
  await load()
}
void start()
// Generated by scripts/build-frames.mjs from the .ts file of the same name. Do not edit.
