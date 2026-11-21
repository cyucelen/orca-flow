// The Settings dialog, laid out like macOS System Settings: a sidebar of pages, a page title, rows in
// rounded groups with the label left and the control right, and every explanation in a tooltip
// (the panel's [data-tip]). Changes apply at once: each one is saved through the worker
// (sidebar.saveSettings), which owns ~/.orca-flow/config.json; a failed save puts the control back.
import type { SettingsState, UpdateState } from '../protocol.ts'
import type { UpdateCheck } from '../update.ts'
import { PROVIDER_LOGOS } from '../provider-logos.ts'
import { ago, DEFAULT_DRAFT, settingsSession, statusView, WRITABLE, type Draft, type DraftKey, type WriterProvider } from '../settings.ts'

const glyph = (d: string) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const ICON = {
  summaries: glyph('<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M5 6.5h6M5 9.5h4"/>'),
  format: glyph('<path d="M3 3.5h10v7H6.5L3 13.5z"/><path d="M6 7l1.5 1.5L10.5 5.5"/>'),
  capacity: glyph('<rect x="2" y="4.5" width="12" height="7" rx="1.5"/><path d="M5 7v2M8 7v2M11 7v2"/>'),
  about: glyph('<circle cx="8" cy="8" r="5.6"/><path d="M8 7.2v3.6M8 5.1v.1"/>'),
  advanced: glyph('<path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/>'),
  grip: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></svg>',
  minus: glyph('<path d="M4.5 8h7"/>'),
  plus: glyph('<path d="M8 4.5v7M4.5 8h7"/>'),
  warn: glyph('<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.1"/>')
}

const PROVIDERS: Record<WriterProvider, { name: string; logo: string; tip: string; models: { id: string; label: string }[] }> = {
  claude: { name: 'Claude', logo: PROVIDER_LOGOS.claude, tip: 'Claude CLI with your existing login. Haiku is fast and light on usage; Sonnet is slower and uses more of your plan.',
    models: [{ id: 'haiku', label: 'Haiku' }, { id: 'sonnet', label: 'Sonnet' }] },
  codex: { name: 'Codex', logo: PROVIDER_LOGOS.codex, tip: 'Codex CLI with Orca’s selected Codex account. GPT-6 Luna is fast and light on usage.',
    models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }] },
  antigravity: { name: 'Antigravity', logo: PROVIDER_LOGOS.antigravity, tip: 'Antigravity CLI with your existing Google sign-in. Runs in an isolated no-tools workspace; Gemini 3.8 Flash is fast and light on usage.',
    models: [{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash' }] }
}
const MODEL_LABEL: Record<string, string> = { haiku: 'Claude Haiku', sonnet: 'Claude Sonnet', 'gpt-6-luna': 'GPT-6 Luna', 'gemini-3.8-flash-low': 'Gemini 3.8 Flash', 'agy-default': 'Antigravity' }

type PageId = 'summaries' | 'format' | 'capacity' | 'advanced' | 'about'
const PAGES: { id: PageId; label: string; tint: string; keys: DraftKey[]; tip: string }[] = [
  { id: 'summaries', label: 'Titles & Summaries', tint: '#0a84ff', keys: ['writers', 'enabled', 'models'],
    tip: 'After each agent turn, one request writes the title, summary and ask on its Orca Flow card. Only Orca Flow’s sidebar cards change: Orca names its own tabs and chats.' },
  { id: 'format', label: 'Message Check', tint: '#30b158', keys: ['format', 'folders'],
    tip: 'Checks that coordinators and leads end each message with the status line and ask the sidebar reads. A miss stops the turn once so the agent can fix it. Your own chats and workers are never checked.' },
  { id: 'capacity', label: 'Memory', tint: '#f08c00', keys: ['marginGB', 'warnHeadroomGB'],
    tip: 'Before a coordinator or lead starts more work, Orca Flow checks free memory. Each agent costs about 0.5 GB, plus any dev servers its project runs.' },
  { id: 'advanced', label: 'Advanced', tint: '#8e8e93', keys: ['linearDryRun'], tip: 'Settings mostly used while testing Orca Flow.' },
  { id: 'about', label: 'About', tint: '#6e6e73', keys: [], tip: 'Orca Flow’s version and updates.' }
]

const $ = (id: string) => document.getElementById(id)!
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
/** A label with its explanation as a tooltip; controls get their own aria-label and the same text as a description. */
const label = (text: string, tip: string) => `<span class="s-label" data-tip="${esc(tip)}">${esc(text)}</span>`
const described = (name: string, tip: string) => `aria-label="${esc(name)}" aria-description="${esc(tip)}"`
const gb = (n: number) => `${Number(n.toFixed(1))} GB`

let state: SettingsState | null = null
let loadError: string | null = null
let pageId: PageId = 'summaries'
let newFolder = ''
let focusAfter: string | null = null
let opener: HTMLElement | null = null

const session = settingsSession(async (settings) => {
  const r = await orca.plugin.request('sidebar.saveSettings', { settings }) as { ok: boolean; error?: string; state: SettingsState }
  state = r.state
  return { ok: r.ok, error: r.error, settings: r.state.settings }
}, () => render())

const d = () => session.shown
const status = (p: WriterProvider) => statusView(state?.writers.find((w) => w.provider === p), p, Date.now())
/** Nothing can be saved while the file is broken (the worker refuses too), so the controls are off. */
const locked = () => !state || !!state.error
const off = (extra = false) => (locked() || extra ? 'disabled' : '')
const active = () => d().writers.filter((p) => d().enabled[p])

function group(rows: string[], header?: { text: string; tip: string }): string {
  return `<section class="s-group">${header ? `<h4 class="s-gh">${label(header.text, header.tip)}</h4>` : ''}<div class="s-card">${rows.join('')}</div></section>`
}
const row = (left: string, right: string, cls = '') => `<div class="s-row ${cls}">${left}<div class="s-ctl">${right}</div></div>`
function toggle(id: string, on: boolean, name: string, tip: string, disabled = false, attrs = ''): string {
  return `<label class="s-switch" ${disabled && tip ? `data-tip="${esc(tip)}"` : ''}><input type="checkbox" role="switch" ${attrs} id="${id}" ${on ? 'checked' : ''} ${off(disabled)} ${described(name, tip)}><span></span></label>`
}

function writerRow(p: WriterProvider): string {
  const prov = PROVIDERS[p]
  const writable = WRITABLE.includes(p)
  const on = d().enabled[p]
  const onlyOne = on && active().length === 1
  const st = status(p)
  const models = prov.models
  const model = models.length > 1
    ? `<select class="s-pop" data-model="${p}" ${off()} ${described(`${prov.name} model`, prov.tip)}>${models.map((m) => `<option value="${m.id}" ${d().models[p] === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`
    : `<span class="s-value">${esc(models[0].label)}</span>`
  const statusText = writable ? `${st.text} · ${st.sub}` : 'Not available yet'
  return `<div class="s-row s-wrow ${writable ? '' : 'dim'}" data-writer="${p}">
    <button type="button" class="s-handle" data-handle="${p}" ${off()} aria-label="Reorder ${esc(prov.name)}" aria-description="Drag, or press the up and down arrows, to change the order">${ICON.grip}</button>
    <span class="s-logo">${prov.logo}</span>
    ${label(prov.name, prov.tip)}
    <div class="s-ctl">
      ${model}
      <span class="s-dot ${writable ? st.tone : 'idle'}" tabindex="0" role="img" aria-label="${esc(`${prov.name}: ${statusText}`)}" data-tip="${esc(statusText)}"></span>
      ${toggle(`s-on-${p}`, on, `Use ${prov.name} for cards`, !writable ? prov.tip : onlyOne ? 'At least one writer stays on' : '', !writable || onlyOne, `data-enable="${p}"`)}
    </div>
  </div>`
}

/** The writer the next card would use: the first one turned on whose status lets it try. */
function writingNow(): string {
  const p = active().find((x) => status(x).usable)
  return p ? MODEL_LABEL[d().models[p]] : 'None available'
}

function errorLine(): string {
  const err = state?.error
    ? { text: 'Settings file can’t be read', tip: `${state.error} Orca Flow uses the defaults and saves nothing until you fix or remove the file.` }
    : session.error ? { text: 'Couldn’t save', tip: session.error }
    : loadError ? { text: 'Couldn’t load settings', tip: loadError } : null
  return err ? `<div class="s-err" role="alert" tabindex="0" data-tip="${esc(err.tip)}" aria-description="${esc(err.tip)}">${ICON.warn}<span>${esc(err.text)}</span></div>` : ''
}

function pageSummaries(): string {
  return group(d().writers.map(writerRow), { text: 'Card writers', tip: 'Tried top to bottom; the first one that works writes the card. One that hits a usage limit or sign-in problem is skipped for 5 minutes. Status comes from the last card each wrote; nothing is tested from here.' })
    + group([row(label('Writing now', 'The writer the next card would use: the first one turned on that isn’t skipped right now.'), `<span class="s-value">${esc(writingNow())}</span>`)])
}

function pageFormat(): string {
  const choice = `<select class="s-pop" id="s-format" ${off()} ${described('Check messages', PAGES[1].tip)}>${([['off', 'Off'], ['all', 'All agents'], ['folders', 'Some folders']] as const).map(([v, t]) => `<option value="${v}" ${d().format === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`
  const main = group([row(label('Check messages', 'Off: agents write as they like. All agents: every coordinator and lead. Some folders: only agents working in the folders listed below.'), choice)])
  if (d().format !== 'folders') return main
  const rows = d().folders.map((f, i) => row(`<span class="s-label s-mono" title="${esc(f)}">${esc(f)}</span>`, `<button type="button" class="s-round" data-rmfolder="${i}" ${off()} aria-label="Remove ${esc(f)}">${ICON.minus}</button>`))
  rows.push(row(`<input class="s-input" id="s-newfolder" placeholder="Add a folder" value="${esc(newFolder)}" autocomplete="off" spellcheck="false" ${off()} ${described('Folder to add', 'A folder path such as ~/orca/workspaces/app')}>`, `<button type="button" class="s-round" id="s-addfolder" ${off()} aria-label="Add folder">${ICON.plus}</button>`, 's-add'))
  return main + group(rows, { text: 'Folders', tip: 'A folder includes everything under it.' })
}

function stepper(key: 'marginGB' | 'warnHeadroomGB', name: string): string {
  const v = d()[key]
  return `<span class="s-value" aria-hidden="true">${gb(v)}</span><span class="s-seg" role="group" aria-label="${esc(name)}: ${gb(v)}">
    <button type="button" data-step="${key}" data-d="-0.5" ${off(v <= 0)} aria-label="${esc(name)}: less">${ICON.minus}</button><button type="button" data-step="${key}" data-d="0.5" ${off(v >= 16)} aria-label="${esc(name)}: more">${ICON.plus}</button></span>`
}

function pageCapacity(): string {
  return group([
    row(label('Always', 'New work waits when starting it would leave less free memory than this. Default 2 GB.'), stepper('marginGB', 'Free memory to keep, always')),
    row(label('Under memory pressure', 'When macOS reports memory pressure, a new worktree also needs this much spare, or half its dev servers’ size if larger. Default 2 GB.'), stepper('warnHeadroomGB', 'Free memory to keep under memory pressure'))
  ], { text: 'Free memory to keep', tip: 'Orca Flow keeps this much RAM free before agents start more work.' })
}

function pageAdvanced(): string {
  return group([
    row(label('Linear test mode', 'Log the Linear comments and status changes Orca Flow would send, and send nothing.'), toggle('s-linear', d().linearDryRun, 'Linear test mode', 'Log the Linear comments and status changes Orca Flow would send, and send nothing.')),
    row(label('Settings file', 'Saved in ~/.orca-flow/config.json. Settings you never change stay out of the file.'), '<button type="button" class="s-push" id="s-reveal">Show in Finder</button>')
  ])
}

/** A selector that finds the same control after a redraw, so keyboard focus stays where it was. */
function focusKey(el: Element | null): string | null {
  if (!el || !$('s-page').contains(el)) return null
  if (el.id) return `#${el.id}`
  const ds = (el as HTMLElement).dataset
  for (const k of ['handle', 'model', 'enable', 'rmfolder', 'reset']) if (ds[k]) return `[data-${k}="${ds[k]}"]`
  if (ds.step) return `[data-step="${ds.step}"][data-d="${ds.d}"]`
  return el.classList.contains('s-dot') ? `[data-writer="${el.closest<HTMLElement>('[data-writer]')?.dataset.writer}"] .s-dot` : null
}

// ---------- About: version and updates ----------

let checking = false
let updateCheck: UpdateCheck | null = null
let updateState: UpdateState | undefined
/** The panel's own update path (src/panel/app.ts): its confirm, then sidebar.update. */
export const settingsHooks: { update: (state: UpdateState) => void } = { update: () => {} }
/** Every snapshot carries the update state; the status bar item and the panel's button show the same. */
export function settingsUpdateState(state: UpdateState | undefined): void {
  updateState = state
  if (settingsOpen() && pageId === 'about') render()
}

function updatesRow(): string {
  const u = updateState, c = updateCheck
  const value = (text: string, tip?: string) => tip
    ? `<span class="s-value" tabindex="0" data-tip="${esc(tip)}" aria-description="${esc(tip)}">${esc(text)}</span>`
    : `<span class="s-value">${esc(text)}</span>`
  // A disabled button gets no pointer events, so its reason sits on a wrapper.
  const checkBtn = (disabled = false, tip = '') => `<span class="s-tipwrap" ${tip ? `data-tip="${esc(tip)}"` : ''}><button type="button" class="s-push" id="s-check" ${disabled ? 'disabled' : ''} ${tip ? `aria-description="${esc(tip)}"` : ''}>Check for Updates</button></span>`
  const updateBtn = (version: string, text = 'Update') => `<button type="button" class="s-push primary" id="s-update" data-version="${esc(version)}">${text}</button>`
  if (u?.kind === 'updating') return value(`Updating to ${u.version}…`)
  if (u?.kind === 'approval') return value('Needs approval', `${u.reason} To approve and update, run: ${u.command}`) + updateBtn(u.version, 'Update…')
  if (u?.kind === 'failed') return value('Update failed', u.reason) + updateBtn(u.version, 'Try Again')
  if (checking) return value('Checking…') + checkBtn(true)
  if (c?.kind === 'cannot') {
    const why = `${c.reason}${c.latest && c.latest !== c.current ? ` The newest release is ${c.latest}.` : ''}`
    return value('Can’t update', why) + checkBtn(true, why)
  }
  const offered = u?.kind === 'available' || u?.kind === 'confirm' ? u.version : c?.kind === 'available' ? c.version : null
  if (offered) return value(`${offered} available`) + updateBtn(offered)
  if (u?.kind === 'updated') return value(`Updated to ${u.version}`) + checkBtn()
  if (c?.kind === 'current') return value('Up to date', `${c.latest && c.latest !== c.current ? `You run ${c.current}; the newest release is ${c.latest}.` : `${c.current} is the newest release.`} Checked ${ago(Date.now() - c.at)}.`) + checkBtn()
  if (c?.kind === 'failed') return value('Couldn’t check', c.reason) + checkBtn()
  return checkBtn()
}

function pageAbout(): string {
  return group([
    row(label('Version', 'The Orca Flow version running now.'), `<span class="s-value">${esc(state?.version ?? '–')}</span>`),
    row(label('Updates', 'Looks for a newer Orca Flow release now; Orca Flow also looks every 15 minutes. Updating installs it and restarts Orca Flow.'), updatesRow(), 's-about')
  ])
}

async function checkUpdates(): Promise<void> {
  checking = true
  render()
  try {
    updateCheck = await orca.plugin.request('sidebar.checkUpdates') as UpdateCheck
  } catch (e) {
    updateCheck = { kind: 'failed', current: state?.version ?? '', reason: (e as Error).message, at: Date.now() }
  }
  checking = false
  focusAfter = '#s-check'
  render()
}

function render(): void {
  if ($('settings').hidden) return
  focusAfter ??= focusKey(document.activeElement)
  const page = PAGES.find((p) => p.id === pageId)!
  // A sidebar-width panel shows the pages as icon tabs; their names come back as tooltips.
  const narrow = window.innerWidth <= 520
  $('s-title').dataset.tip = state?.version ? `Orca Flow ${state.version}` : 'Orca Flow'
  $('s-nav').innerHTML = PAGES.map((p) => `<button class="s-nav-btn" type="button" data-page="${p.id}" ${p.id === pageId ? 'aria-current="page"' : ''} aria-label="${esc(p.label)}"${narrow ? ` data-tip="${esc(p.label)}"` : ''}><span class="s-tile" style="background:${p.tint}">${ICON[p.id]}</span><span class="s-nav-label">${esc(p.label)}</span></button>`).join('')
  const body = !state && !loadError ? '<p class="s-loading">Loading…</p>' : { summaries: pageSummaries, format: pageFormat, capacity: pageCapacity, advanced: pageAdvanced, about: pageAbout }[pageId]()
  const reset = state && !locked() && !session.isDefault(page.keys) ? `<div class="s-foot"><button type="button" class="s-push" data-reset="${page.id}">Reset to Defaults</button></div>` : ''
  $('s-page').innerHTML = `<h3 class="s-ptitle">${label(page.label, page.tip)}</h3>${errorLine()}${body}${reset}`
  if (focusAfter) {
    const el = document.querySelector<HTMLElement>(`#s-page ${focusAfter}`)
    // A control that is now disabled (the last writer on, the stepper's end) hands focus to the page.
    ;(el && !(el as HTMLButtonElement).disabled ? el : dialog).focus()
    focusAfter = null
  }
}

export const settingsOpen = (): boolean => !$('settings').hidden

export function openSettings(): void {
  opener = document.activeElement as HTMLElement | null
  state = null
  loadError = null
  newFolder = ''
  pageId = 'summaries'
  $('settings').hidden = false
  render()
  dialog.focus()
  orca.plugin.request('sidebar.settings')
    .then((s) => {
      state = s as SettingsState
      updateCheck = state.updateCheck ?? null
      if (state.update) updateState = state.update
      session.load(state.settings)
      render()
    })
    .catch((e: Error) => { loadError = e.message; render() })
}

function close(): void {
  $('settings').hidden = true
  opener?.focus()
}

/** Moves a writer one place up or down, and saves. */
function move(p: WriterProvider, by: number): void {
  const w = d().writers, i = w.indexOf(p), j = i + by
  if (j < 0 || j >= w.length) return
  focusAfter = `[data-handle="${p}"]`
  void session.change((x) => { [x.writers[i], x.writers[j]] = [x.writers[j], x.writers[i]] })
}

function addFolder(): void {
  const v = newFolder.trim()
  newFolder = ''
  focusAfter = '#s-newfolder'
  if (v && !d().folders.includes(v)) void session.change((x) => { x.folders.push(v) })
  else render()
}

function onClick(e: MouseEvent): void {
  const t = (e.target as Element).closest<HTMLElement>('button')
  if (!t || (t as HTMLButtonElement).disabled) return
  const ds = t.dataset
  if (ds.page) { pageId = ds.page as PageId; render(); return }
  if (ds.reset) { void session.reset(PAGES.find((p) => p.id === ds.reset)!.keys); return }
  if (ds.step) { const k = ds.step as 'marginGB' | 'warnHeadroomGB'; void session.change((x) => { x[k] = Math.min(16, Math.max(0, x[k] + Number(ds.d))) }); return }
  if (ds.rmfolder) { void session.change((x) => { x.folders.splice(Number(ds.rmfolder), 1) }); return }
  switch (t.id) {
    case 's-x': close(); break
    case 's-addfolder': addFolder(); break
    case 's-check': void checkUpdates(); break
    case 's-update': settingsHooks.update(updateState && updateState.kind !== 'none' ? updateState : { kind: 'available', version: t.dataset.version! }); break
    case 's-reveal': void orca.plugin.request('sidebar.revealSettings').catch(() => null); break
  }
}

function onChange(e: Event): void {
  const t = e.target as HTMLInputElement
  if (t.dataset.model) { const p = t.dataset.model as WriterProvider; void session.change((x) => { x.models[p] = t.value }) }
  else if (t.dataset.enable) { const p = t.dataset.enable as WriterProvider; void session.change((x) => { x.enabled[p] = t.checked }) }
  else if (t.id === 's-format') void session.change((x) => { x.format = t.value as Draft['format'] })
  else if (t.id === 's-linear') void session.change((x) => { x.linearDryRun = t.checked })
}

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement
  if (e.key === 'Escape') { e.preventDefault(); close() }
  else if (t.dataset.handle && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(t.dataset.handle as WriterProvider, e.key === 'ArrowUp' ? -1 : 1) }
  else if (e.key === 'Enter' && t.id === 's-newfolder') { e.preventDefault(); addFolder() }
}

// Drag a writer by its handle: rows move as the pointer passes them; one save on drop.
let drag: { p: WriterProvider; order: WriterProvider[]; handle: HTMLElement } | null = null
function onDown(e: PointerEvent): void {
  const h = (e.target as Element).closest<HTMLElement>('[data-handle]')
  if (!h || (h as HTMLButtonElement).disabled || e.button !== 0) return
  e.preventDefault()
  drag = { p: h.dataset.handle as WriterProvider, order: [...d().writers], handle: h }
  try { h.setPointerCapture(e.pointerId) } catch { /* a synthetic or ended pointer */ }
  h.closest('.s-wrow')!.classList.add('dragging')
}
function onMove(e: PointerEvent): void {
  if (!drag) return
  const rows = [...document.querySelectorAll<HTMLElement>('#s-page .s-wrow')]
  const me = rows.find((r) => r.dataset.writer === drag!.p)!
  const over = rows.find((r) => { const b = r.getBoundingClientRect(); return e.clientY >= b.top && e.clientY < b.bottom })
  if (!over || over === me) return
  const below = rows.indexOf(over) > rows.indexOf(me)
  over.parentElement!.insertBefore(me, below ? over.nextSibling : over)
  drag.order = [...document.querySelectorAll<HTMLElement>('#s-page .s-wrow')].map((r) => r.dataset.writer as WriterProvider)
}
function onUp(): void {
  if (!drag) return
  const { order, p } = drag
  drag = null
  focusAfter = `[data-handle="${p}"]`
  if (order.join() === d().writers.join()) render()
  else void session.change((x) => { x.writers = order })
}

const root = $('settings')
const dialog = root.querySelector<HTMLElement>('.s-dialog')!
// The panel's own click handler (src/panel/app.ts) never sees clicks inside the dialog.
root.addEventListener('click', (e) => { e.stopPropagation(); onClick(e) })
root.addEventListener('change', onChange)
root.addEventListener('input', (e) => { if ((e.target as HTMLElement).id === 's-newfolder') newFolder = (e.target as HTMLInputElement).value })
root.addEventListener('keydown', onKey)
root.addEventListener('pointerdown', onDown)
root.addEventListener('pointermove', onMove)
root.addEventListener('pointerup', onUp)
root.addEventListener('pointercancel', onUp)
// Relative times ("2 min ago") and cooldowns stay current while the dialog is open.
setInterval(() => { if (settingsOpen() && !drag && !['SELECT', 'INPUT'].includes(document.activeElement?.tagName ?? '')) render() }, 30_000)
