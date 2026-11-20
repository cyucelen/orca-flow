// The Settings dialog, from the approved design (design/settings-dialog/src.html): four pages, a
// pinned footer with Reset all / unsaved count / Cancel / Save, and a confirm inside the dialog
// before changes are dropped. It reads and saves through the worker (sidebar.settings,
// sidebar.saveSettings), which owns ~/.orca-flow/config.json; the panel never writes files.
import type { SettingsState } from '../protocol.ts'
import { PROVIDER_LOGOS } from '../provider-logos.ts'
import { changedKeys, DEFAULT_DRAFT, fromDraft, same, statusView, toDraft, WRITABLE, type Draft, type DraftKey, type WriterProvider } from '../settings.ts'

const ICON: Record<string, string> = {
  summaries: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 9.5h9M7.5 13h6"/></svg>',
  format: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 5h14v10H9l-4 4z"/><path d="M9 10l2 2 4-4"/></svg>',
  capacity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="6.5" width="17" height="11" rx="2"/><path d="M7.5 10v4M11 10v4M14.5 10v4"/></svg>',
  advanced: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v3.8M8 5v.1"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v4M8 11v.1"/></svg>',
  x: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'
}

// Each provider is one CLI login Orca already knows about. Models: the ones each CLI accepts by name.
const PROVIDERS: Record<WriterProvider, { name: string; via: string; logo: string; models: { id: string; label: string; note: string }[] }> = {
  claude: { name: 'Claude', via: 'Claude CLI, your existing login', logo: PROVIDER_LOGOS.claude, models: [
    { id: 'haiku', label: 'Haiku', note: 'Fast, light on usage' },
    { id: 'sonnet', label: 'Sonnet', note: 'Slower, uses more of your plan' }] },
  codex: { name: 'Codex', via: 'Codex CLI, Orca’s selected Codex account', logo: PROVIDER_LOGOS.codex, models: [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'Fast, light on usage' }] },
  antigravity: { name: 'Antigravity', via: 'Antigravity CLI, your existing Google login', logo: PROVIDER_LOGOS.antigravity, models: [
    { id: 'agy-default', label: 'Its default model', note: 'Uses whatever model the CLI is set to' }] }
}
const MODEL_LABEL: Record<string, string> = { haiku: 'Claude Haiku', sonnet: 'Claude Sonnet', 'gpt-6-luna': 'GPT-6 Luna', 'agy-default': 'Antigravity' }

type PageId = 'summaries' | 'format' | 'capacity' | 'advanced'
const PAGES: { id: PageId; label: string; keys: DraftKey[] }[] = [
  { id: 'summaries', label: 'Titles & summaries', keys: ['writers', 'enabled', 'models'] },
  { id: 'format', label: 'Message check', keys: ['format', 'folders'] },
  { id: 'capacity', label: 'Capacity', keys: ['marginGB', 'warnHeadroomGB'] },
  { id: 'advanced', label: 'Advanced', keys: ['linearDryRun'] }
]

const $ = (id: string) => document.getElementById(id)!
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o))

let state: SettingsState | null = null
let loadError: string | null = null
let saveError: string | null = null
let saved: Draft = clone(DEFAULT_DRAFT)
let draft: Draft = clone(DEFAULT_DRAFT)
let pageId: PageId = 'summaries'
let confirming: 'cancel' | 'reset-all' | null = null
let saving = false
let newFolder = ''
let focusAfter: string | null = null
let opener: HTMLElement | null = null

const pageChanged = (p: (typeof PAGES)[number]) => p.keys.some((k) => changedKeys(draft, saved).includes(k))
const pageIsDefault = (p: (typeof PAGES)[number]) => p.keys.every((k) => same(draft[k], DEFAULT_DRAFT[k]))
const status = (p: WriterProvider) => statusView(state?.writers.find((w) => w.provider === p), p, Date.now())
/** Turned-on writers in the order they are tried. */
const active = () => draft.writers.filter((p) => draft.enabled[p])
/** Saving is refused while the file is broken; the worker would refuse it too. */
const canSave = () => !!state && !state.error && !saving

/** Which writer would produce the next card: the first turned-on writer whose status lets it try. */
function nextWriter() {
  const steps = active().map((p, i) => ({ p, ok: status(p).usable, role: i === 0 ? 'first' : 'backup' }))
  return { steps, used: steps.find((x) => x.ok) }
}

function statusHtml(p: WriterProvider): string {
  const st = status(p)
  return `<span class="s-status ${st.tone}"><i></i>${esc(st.text)}</span>`
}

function writerRow(p: WriterProvider, i: number): string {
  const prov = PROVIDERS[p]
  const st = status(p)
  const on = draft.enabled[p]
  const act = active()
  const rank = on ? act.indexOf(p) + 1 : null
  const writable = WRITABLE.includes(p)
  const onlyOne = on && act.length === 1
  const defaultModel = DEFAULT_DRAFT.models[p]
  const opts = prov.models.map((m) => `<option value="${m.id}" ${draft.models[p] === m.id ? 'selected' : ''}>${esc(m.label)}${prov.models.length > 1 && m.id === defaultModel ? ' (default)' : ''}</option>`).join('')
  const model = prov.models.find((m) => m.id === draft.models[p]) ?? prov.models[0]
  const role = !on ? 'Off' : rank === 1 ? 'First choice' : `Backup ${act.length > 2 ? (rank ?? 1) - 1 : ''}`.trim()
  const last = draft.writers.length - 1
  const switchTitle = !writable ? 'Not available yet' : onlyOne ? 'At least one writer stays on' : on ? 'Turn off' : 'Turn on'
  return `<div class="s-wrow ${on ? '' : 'off'}">
    <span class="s-rank" aria-hidden="true">${rank ?? '–'}</span>
    <span class="s-logo">${prov.logo}</span>
    <div class="s-wmain">
      <div class="s-wtitle"><strong>${esc(prov.name)}</strong><span class="s-role">${role}</span></div>
      <div class="s-wsub">${esc(prov.via)}. ${esc(model.note)}.</div>
      <div class="s-wsub">${statusHtml(p)} <span class="s-faint">· ${esc(on || !writable ? st.sub : 'Turned off: never used for cards')}</span></div>
    </div>
    <div class="s-wside">
      <label for="s-model-${p}" class="s-sr">${esc(prov.name)} model</label>
      <select class="s-model" id="s-model-${p}" data-model="${p}" ${prov.models.length < 2 ? 'disabled title="Only option for this writer so far"' : ''}>${opts}</select>
      <span class="s-move">
        <button class="s-icon-btn sm" type="button" data-move="${p}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(prov.name)} up">${ICON.up}</button>
        <button class="s-icon-btn sm" type="button" data-move="${p}" data-d="1" ${i === last ? 'disabled' : ''} aria-label="Move ${esc(prov.name)} down">${ICON.down}</button>
      </span>
      <label class="s-switch" title="${switchTitle}"><input type="checkbox" data-enable="${p}" ${on ? 'checked' : ''} ${onlyOne || !writable ? 'disabled' : ''} aria-label="Use ${esc(prov.name)} for cards"><span></span></label>
    </div>
  </div>`
}

function orderSentence(): string {
  const names = active().map((p) => PROVIDERS[p].name)
  const off = draft.writers.filter((p) => !draft.enabled[p]).map((p) => PROVIDERS[p].name)
  const tries = names.length === 0 ? 'No writer is on: cards keep their last title and summary.' : names.length === 1 ? `Only ${names[0]} writes cards; if it can’t, the card waits.` : `Tries ${names.join(', then ')}.`
  return tries + (off.length ? ` ${off.join(' and ')} ${off.length > 1 ? 'are' : 'is'} off.` : '')
}

function errorBanner(): string {
  const msg = state?.error ? `${state.error} Orca Flow uses the defaults until it’s fixed, and Save stays off so the file isn’t overwritten.` : saveError ? `Couldn’t save: ${saveError}` : loadError ? `Couldn’t load settings: ${loadError}` : ''
  return msg ? `<div class="s-error" role="alert">${ICON.error}<span>${esc(msg)}</span></div>` : ''
}

function pageHead(p: PageId, title: string, text: string): string {
  const page = PAGES.find((x) => x.id === p)!
  return `${errorBanner()}<div class="s-phead">
    <div><h3>${title}</h3><p>${text}</p></div>
    <button class="s-link" data-reset="${p}" type="button" ${pageIsDefault(page) ? 'disabled' : ''}>Reset to defaults</button>
  </div>`
}

function pageSummaries(): string {
  const nw = nextWriter()
  const usedLabel = nw.used ? MODEL_LABEL[draft.models[nw.used.p]] : null
  const flow = nw.steps.map((x) => {
    const name = MODEL_LABEL[draft.models[x.p]]
    if (x === nw.used) return `<li class="now">${esc(name)} writes it.</li>`
    if (!x.ok && (!nw.used || nw.steps.indexOf(x) < nw.steps.indexOf(nw.used))) return `<li class="skip">${esc(name)}: ${esc(status(x.p).text.toLowerCase())}, skipped.</li>`
    return `<li>${esc(name)} is not needed.</li>`
  }).join('') + (nw.used ? '' : '<li class="now">Nothing can write, so the card keeps its last title and summary.</li>')
  return `${pageHead('summaries', 'Titles &amp; summaries', 'After each agent turn, Orca Flow writes the title, one-line summary and ask on its sidebar card. One request writes all three, so they always come from the same model.')}
  <div class="s-group">
    <div class="s-glabel">Who writes the card</div>
    <div class="s-writers">
      ${draft.writers.map((p, i) => writerRow(p, i)).join('<div class="s-sep"></div>')}
      <div class="s-swapbar"><span>${esc(orderSentence())}</span></div>
    </div>
    <p class="s-hint">Turn on the writers you want and put them in order. A writer that hits a usage limit or sign-in problem is skipped for 5 minutes, then tried again. Status comes from the last card each one wrote; this page sends no test requests. Turning a writer on doesn’t sign you in or change your plan.</p>
  </div>
  <div class="s-group">
    <div class="s-glabel">Example card <span class="s-tag">SAMPLE TEXT</span></div>
    <div class="s-preview">
      <div class="s-card ${nw.used ? '' : 'stale'}">
        <div class="t"><b>Settings dialog draft</b></div>
        <div class="about">Drafting an Orca Flow settings dialog with model choices for summaries.</div>
        <span class="ask">Needs your review</span>
        <div class="by">${nw.used ? `<span class="mini">${PROVIDERS[nw.used.p].logo}</span> Written by ${esc(usedLabel)}${nw.used.role === 'backup' ? ' (backup)' : ''}` : 'Kept from the last turn: no writer available'}</div>
      </div>
      <div class="s-flow"><span>For the next turn:</span><ol>${flow}</ol></div>
    </div>
  </div>
  <div class="s-note">${ICON.info}<span>This changes Orca Flow’s sidebar cards only. Orca names its own tabs and chats; this setting doesn’t touch those names. Cards are made from Claude and Codex conversations. Antigravity sessions keep the title Orca gives them, whichever writer you pick.</span></div>`
}

function pageFormat(): string {
  const opt = (v: Draft['format'], t: string, s: string) => `<label class="s-opt ${draft.format === v ? 'sel' : ''}"><input type="radio" name="s-format" value="${v}" ${draft.format === v ? 'checked' : ''}><span><span class="ot">${t}${v === DEFAULT_DRAFT.format ? ' <span class="s-tag">DEFAULT</span>' : ''}</span><br><span class="os">${s}</span></span></label>`
  const folders = draft.format === 'folders' ? `<div class="s-folders">
    ${draft.folders.map((f, i) => `<div class="s-folder"><span title="${esc(f)}">${esc(f)}</span><button class="s-icon-btn" data-rmfolder="${i}" type="button" aria-label="Remove ${esc(f)}">${ICON.x}</button></div>`).join('') || '<p class="s-hint">No folders yet: nothing is checked.</p>'}
    <div class="s-addrow"><label for="s-newfolder" class="s-sr">Folder path</label><input id="s-newfolder" placeholder="~/orca/workspaces/my-project" value="${esc(newFolder)}" autocomplete="off" spellcheck="false"><button class="s-btn ghost sm" id="s-addfolder" type="button">Add folder</button></div>
    <p class="s-hint">A folder includes everything under it.</p></div>` : ''
  return `${pageHead('format', 'Message check', 'Checks that coordinators and leads end each message with the status line and ask the sidebar reads. A missing status stops the turn once so the agent can fix it. Your own chats and workers are never checked.')}
  <div class="s-group">
    ${opt('off', 'Off', 'Agents write messages however they like.')}
    ${opt('all', 'All coordinators and leads', 'Every coordinator and lead in Orca is checked.')}
    <div>${opt('folders', 'Only in some folders', 'Check agents working in the folders you list.')}${folders}</div>
  </div>`
}

function stepper(key: 'marginGB' | 'warnHeadroomGB', label: string, sub: string): string {
  const changed = !same(draft[key], saved[key])
  return `<div class="s-setrow"><div><div class="st">${label}${changed ? '<span class="s-changed" title="Changed"></span>' : ''}</div><div class="ss">${sub}</div></div>
    <div class="s-stepper" role="group" aria-label="${label}"><button type="button" data-step="${key}" data-d="-0.5" aria-label="Less">−</button><output>${draft[key].toFixed(1)} GB</output><button type="button" data-step="${key}" data-d="0.5" aria-label="More">+</button></div></div>`
}

function pageCapacity(): string {
  return `${pageHead('capacity', 'Capacity', 'Before a coordinator or lead starts more work, Orca Flow checks free memory. Each agent costs about 0.5 GB, plus any dev servers its project runs.')}
  <div>
    ${stepper('marginGB', 'Always keep free', 'New work waits when starting it would go below this. Default 2 GB.')}
    ${stepper('warnHeadroomGB', 'Extra room when memory is tight', 'When macOS reports memory pressure, a new worktree also needs this much spare, or half its dev servers’ size if larger. Default 2 GB.')}
  </div>`
}

function pageAdvanced(): string {
  const changed = !same(draft.linearDryRun, saved.linearDryRun)
  return `${pageHead('advanced', 'Advanced', 'Settings mostly used while testing Orca Flow.')}
  <div>
    <div class="s-setrow"><div><div class="st">Linear test mode${changed ? '<span class="s-changed" title="Changed"></span>' : ''}</div><div class="ss">Log the Linear comments and status changes Orca Flow would send, and send nothing.</div></div>
      <label class="s-switch"><input type="checkbox" id="s-linear" ${draft.linearDryRun ? 'checked' : ''} aria-label="Linear test mode"><span></span></label></div>
    <div class="s-setrow"><div><div class="st">Settings file</div><div class="ss">Everything on these pages is saved in <span class="s-path">~/.orca-flow/config.json</span>. Settings you never change stay out of the file.</div></div>
      <button class="s-btn ghost sm" type="button" id="s-reveal">Show in Finder</button></div>
  </div>`
}

function renderNav(): void {
  $('s-nav').innerHTML = PAGES.map((p) => `<button class="s-nav-btn" type="button" data-page="${p.id}" ${p.id === pageId ? 'aria-current="page"' : ''}>${ICON[p.id]}<span>${p.label}</span>${pageChanged(p) ? '<span class="s-dot" title="Unsaved changes"></span>' : ''}</button>`).join('')
}

function renderFoot(): void {
  const n = changedKeys(draft, saved).length
  const allDefault = (Object.keys(DEFAULT_DRAFT) as DraftKey[]).every((k) => same(draft[k], DEFAULT_DRAFT[k]))
  const f = $('s-foot')
  if (confirming === 'cancel') {
    f.innerHTML = `<div class="s-confirm">Discard ${n} unsaved change${n === 1 ? '' : 's'}?</div><button class="s-btn ghost" id="s-keep" type="button">Keep editing</button><button class="s-btn danger" id="s-discard" type="button">Discard</button>`
  } else if (confirming === 'reset-all') {
    f.innerHTML = `<div class="s-confirm">Put every page back to its default? You can still cancel before saving.</div><button class="s-btn ghost" id="s-keep" type="button">Back</button><button class="s-btn primary" id="s-doresetall" type="button">Reset all</button>`
  } else {
    f.innerHTML = `<div class="left"><button class="s-link" id="s-resetall" type="button" ${allDefault ? 'disabled' : ''}>Reset all to defaults</button><span class="count">${n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'No changes'}</span></div>
      <button class="s-btn ghost" id="s-cancel" type="button">Cancel</button><button class="s-btn primary" id="s-save" type="button" ${n && canSave() ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>`
  }
  ;(f.querySelector('#s-keep') as HTMLElement | null)?.focus()
}

function render(): void {
  $('s-ver').textContent = state?.version ?? ''
  renderNav()
  // In a narrow panel the pages are a row of tabs: keep the current one in view.
  $('s-nav').querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  $('s-page').innerHTML = !state && !loadError ? '<p class="s-loading">Loading settings…</p>' : { summaries: pageSummaries, format: pageFormat, capacity: pageCapacity, advanced: pageAdvanced }[pageId]()
  renderFoot()
  if (focusAfter) {
    const b = document.querySelector<HTMLButtonElement>(focusAfter)
    ;(b && !b.disabled ? b : document.querySelector<HTMLButtonElement>('#s-page [data-move]:not([disabled])'))?.focus()
    focusAfter = null
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
function toast(msg: string): void {
  const t = $('s-toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), 2600)
}

function load(next: SettingsState): void {
  state = next
  saved = toDraft(next.settings)
  draft = clone(saved)
}

export const settingsOpen = (): boolean => !$('settings').hidden

export function openSettings(): void {
  opener = document.activeElement as HTMLElement | null
  state = null
  loadError = saveError = null
  confirming = null
  newFolder = ''
  pageId = 'summaries'
  saved = clone(DEFAULT_DRAFT)
  draft = clone(DEFAULT_DRAFT)
  $('settings').hidden = false
  render()
  dialog.focus()
  orca.plugin.request('sidebar.settings')
    .then((s) => { load(s as SettingsState); render() })
    .catch((e: Error) => { loadError = e.message; render() })
}

function close(): void {
  $('settings').hidden = true
  $('s-toast').hidden = true
  opener?.focus()
}

function cancel(): void {
  if (changedKeys(draft, saved).length) { confirming = 'cancel'; renderFoot() } else close()
}

async function save(): Promise<void> {
  if (!canSave()) return
  saving = true
  saveError = null
  renderFoot()
  try {
    const r = await orca.plugin.request('sidebar.saveSettings', { settings: fromDraft(draft) }) as { ok: boolean; error?: string; state: SettingsState }
    if (r.ok) {
      load(r.state)
      toast('Settings saved')
    } else {
      // Keep the draft; show why (a broken file is never overwritten).
      state = r.state
      saveError = r.error ?? 'unknown error'
    }
  } catch (e) {
    saveError = (e as Error).message
  } finally {
    saving = false
    render()
  }
}

function onClick(e: MouseEvent): void {
  const t = (e.target as Element).closest<HTMLElement>('button, [data-page]')
  if (!t || (t as HTMLButtonElement).disabled) return
  const d = t.dataset
  if (d.page) { pageId = d.page as PageId; confirming = null; render(); return }
  if (d.reset) { const p = PAGES.find((x) => x.id === d.reset)!; for (const k of p.keys) (draft as Record<string, unknown>)[k] = clone(DEFAULT_DRAFT[k]); render(); return }
  if (d.step) { const k = d.step as 'marginGB' | 'warnHeadroomGB'; draft[k] = Math.min(16, Math.max(0, draft[k] + Number(d.d))); render(); return }
  if (d.move) {
    const w = draft.writers, i = w.indexOf(d.move as WriterProvider), j = i + Number(d.d)
    if (j >= 0 && j < w.length) { [w[i], w[j]] = [w[j], w[i]]; focusAfter = `#s-page [data-move="${d.move}"][data-d="${d.d}"]`; render() }
    return
  }
  if (d.rmfolder) { draft.folders.splice(Number(d.rmfolder), 1); render(); return }
  switch (t.id) {
    case 's-addfolder': { const v = newFolder.trim(); if (v && !draft.folders.includes(v)) draft.folders.push(v); newFolder = ''; render(); ($('s-newfolder') as HTMLInputElement | null)?.focus(); break }
    case 's-save': void save(); break
    case 's-cancel': case 's-x': cancel(); break
    case 's-keep': confirming = null; renderFoot(); break
    case 's-discard': draft = clone(saved); confirming = null; render(); close(); break
    case 's-resetall': confirming = 'reset-all'; renderFoot(); break
    case 's-doresetall': draft = clone(DEFAULT_DRAFT); confirming = null; render(); toast('All pages reset. Save to keep it.'); break
    case 's-reveal': orca.plugin.request('sidebar.revealSettings').then((r) => { if (!(r as { ok: boolean }).ok) toast('Couldn’t open Finder') }).catch(() => toast('Couldn’t open Finder')); break
  }
}

function onChange(e: Event): void {
  const t = e.target as HTMLInputElement
  if (t.dataset.model) { draft.models[t.dataset.model as WriterProvider] = t.value; render() }
  else if (t.dataset.enable) { draft.enabled[t.dataset.enable as WriterProvider] = t.checked; render() }
  else if (t.name === 's-format') { draft.format = t.value as Draft['format']; render() }
  else if (t.id === 's-linear') { draft.linearDryRun = t.checked; render() }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (confirming) { confirming = null; renderFoot() } else cancel()
  } else if (e.key === 'Enter' && (e.target as HTMLElement).id === 's-newfolder') {
    e.preventDefault()
    $('s-addfolder').click()
  }
}

const root = $('settings')
const dialog = root.querySelector<HTMLElement>('.s-dialog')!
// The panel's own click handler (src/panel/app.ts) never sees clicks inside the dialog.
root.addEventListener('click', (e) => { e.stopPropagation(); onClick(e) })
root.addEventListener('change', onChange)
root.addEventListener('input', (e) => { if ((e.target as HTMLElement).id === 's-newfolder') newFolder = (e.target as HTMLInputElement).value })
root.addEventListener('keydown', onKey)
