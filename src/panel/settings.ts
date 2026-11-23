// The Settings dialog, laid out like macOS System Settings: a sidebar of pages, a page title, rows in
// rounded groups with the label left and the control right, and every explanation in a tooltip
// (the panel's [data-tip]). Changes apply at once: each one is saved through the worker
// (sidebar.saveSettings), which owns ~/.orca-flow/config.json; a failed save puts the control back.
import type { SettingsState, UpdateState } from '../protocol.ts'
import type { UpdateCheck } from '../update.ts'
import { PROVIDER_LOGOS } from '../provider-logos.ts'
import { addTaskType, cardName, cardProblem, canAddType, choiceText, editTaskType, effortBar, effortsFor, fallbackText, pickEffort, pickModel, pickNone, pickPreset, popoverView, presetView, refFrom, removeTaskType, routingRows, saveNamed, suggestedTypes, UNKNOWN, type RoutingRow, type Slot } from './models.ts'
import { deletePreset, MAX_TYPE_DESCRIPTION, MAX_TYPE_NAME, MAX_TYPES, resetRouting, type Effort, type ModelChoice, type Preset, type RoutingSettings } from '../routing.ts'
import { ago, same, settingsSession, statusView, WRITABLE, type Draft, type DraftKey, type WriterProvider } from '../settings.ts'

const glyph = (d: string) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const ICON = {
  summaries: glyph('<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M5 6.5h6M5 9.5h4"/>'),
  format: glyph('<path d="M3 3.5h10v7H6.5L3 13.5z"/><path d="M6 7l1.5 1.5L10.5 5.5"/>'),
  capacity: glyph('<rect x="2" y="4.5" width="12" height="7" rx="1.5"/><path d="M5 7v2M8 7v2M11 7v2"/>'),
  models: glyph('<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2"/>'),
  features: glyph('<rect x="3" y="5" width="10" height="7" rx="2"/><path d="M8 5V3M6 8.2v.1M10 8.2v.1"/>'),
  about: glyph('<circle cx="8" cy="8" r="5.6"/><path d="M8 7.2v3.6M8 5.1v.1"/>'),
  advanced: glyph('<path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/>'),
  grip: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></svg>',
  minus: glyph('<path d="M4.5 8h7"/>'),
  plus: glyph('<path d="M8 4.5v7M4.5 8h7"/>'),
  edit: glyph('<path d="M10.5 3.5l2 2L6 12l-2.8.8L4 10z"/>'),
  close: glyph('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  tick: glyph('<path d="M3.5 8.5l3 3 6-7"/>'),
  warn: glyph('<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.1"/>')
}

const PROVIDERS: Record<WriterProvider, { name: string; logo: string; tip: string; models: { id: string; label: string }[] }> = {
  claude: { name: 'Claude', logo: PROVIDER_LOGOS.claude, tip: 'Claude CLI with your existing login. Haiku is fast and light on usage; Sonnet is slower and uses more of your plan.',
    models: [{ id: 'haiku', label: 'Haiku' }, { id: 'sonnet', label: 'Sonnet' }] },
  codex: { name: 'Codex', logo: PROVIDER_LOGOS.codex, tip: 'Codex CLI with Orca’s selected Codex account. GPT-6 Luna is fast and light on usage.',
    models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }] },
  antigravity: { name: 'Antigravity', logo: PROVIDER_LOGOS.antigravity, tip: 'Antigravity CLI with your existing Google sign-in. Runs in an isolated no-tools workspace; Gemini 3.8 Flash is fast and light on usage.',
    models: [{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash' }, { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon' }, { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon' }, { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen' }, { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon' }] }
}
const MODEL_LABEL: Record<string, string> = { haiku: 'Claude Haiku', sonnet: 'Claude Sonnet', 'gpt-6-luna': 'GPT-6 Luna', 'gemini-3.8-flash-low': 'Gemini 3.8 Flash', 'gemini-4-carbon-low': 'Gemini 4 Carbon', 'gemini-4-neon-low': 'Gemini 4 Neon', 'gemini-4-hydrogen-low': 'Gemini 4 Hydrogen', 'gemini-4-argon-low': 'Gemini 4 Argon', 'agy-default': 'Antigravity' }

type PageId = 'summaries' | 'models' | 'format' | 'capacity' | 'features' | 'advanced' | 'about'
const PAGES: { id: PageId; label: string; tint: string; keys: DraftKey[]; tip: string }[] = [
  { id: 'summaries', label: 'Titles & Summaries', tint: '#0a84ff', keys: ['writers', 'enabled', 'models'],
    tip: 'After each agent turn, one request writes the title, summary and ask on its Orca Flow card. Only Orca Flow’s sidebar cards change: Orca names its own tabs and chats.' },
  { id: 'models', label: 'Models', tint: '#5e5ce6', keys: ['routing'],
    tip: 'The model each coordinator, lead and worker starts with. Applies to new launches only: running and resumed sessions keep their model.' },
  { id: 'format', label: 'Message Check', tint: '#30b158', keys: ['format', 'folders'],
    tip: 'Checks that coordinators and leads end each message with the status line and ask the sidebar reads. A miss stops the turn once so the agent can fix it. Your own chats and workers are never checked.' },
  { id: 'capacity', label: 'Memory', tint: '#f08c00', keys: ['marginGB', 'warnHeadroomGB'],
    tip: 'Before a coordinator or lead starts more work, Orca Flow checks free memory. Each agent costs about 0.5 GB, plus any dev servers its project runs.' },
  { id: 'features', label: 'Features', tint: '#bf5af2', keys: ['bots', 'linear', 'tokenSpeed'], tip: 'Choose which sections Orca Flow shows in the sidebar. A section that is off is hidden and stops reading its data.' },
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
  const choice = `<select class="s-pop" id="s-format" ${off()} ${described('Check messages', PAGES.find((p) => p.id === 'format')!.tip)}>${([['off', 'Off'], ['all', 'All agents'], ['folders', 'Some folders']] as const).map(([v, t]) => `<option value="${v}" ${d().format === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`
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

function pageFeatures(): string {
  const bots = 'Show the Bots section in the sidebar'
  const linear = 'Show the Linear section in the sidebar, and read your Linear issues. Off: nothing is read from Linear.'
  const speed = 'Show the Token Speed section in the sidebar, and sample the agents’ logs and network traffic. Off: nothing is sampled; the history is kept.'
  return group([
    row(label('Bots', bots), toggle('s-bots', d().bots, 'Bots', bots)),
    row(label('Linear', linear), toggle('s-linear-on', d().linear, 'Linear', linear)),
    row(label('Token Speed', speed), toggle('s-speed', d().tokenSpeed, 'Token Speed', speed))
  ])
}

function pageAdvanced(): string {
  return group([
    row(label('Linear test mode', 'Log the Linear comments and status changes Orca Flow would send, and send nothing.'), toggle('s-linear', d().linearDryRun, 'Linear test mode', 'Log the Linear comments and status changes Orca Flow would send, and send nothing.')),
    row(label('Settings file', 'Saved in ~/.orca-flow/config.json. Settings you never change stay out of the file.'), '<button type="button" class="s-push" id="s-reveal">Show in Finder</button>')
  ])
}

// ---------- Models: the routing map ----------

const avail = () => state?.availability ?? UNKNOWN
/** No lookup has landed yet (the worker pushes it): the cards say so instead. */
const lookingUp = () => !state?.availability
const CHECKING = '<span class="s-value s-checking m-checking">Checking installed models…</span>'
const r = () => d().routing
const ROLE_TIP = 'Applies to new conversations only; running and resumed ones keep their model.'
const KIND_NOTE = 'A task’s own model choice always wins.'
const TYPES_TIP = 'A task of one of these types runs on the type’s model, whatever its difficulty. The lead names the type when it splits the work.'
const DIFFICULTY_TIP = `Every other task goes by the difficulty its lead marked. ${KIND_NOTE} A failed task moves one row up, never past Hard.`
const PRESET_TIP = 'Sets the coordinator, lead and difficulty rows at once. Your task types stay as they are.'
let naming = false
let presetName = ''
let presetError: string | null = null
/** The add / edit form of a task type, open at most one at a time. */
let typeForm: { mode: 'add' | 'edit'; id?: string; name: string; description: string; error: string | null } | null = null
/** The open model popover: the card it hangs from. */
let popover: { key: string; slot: Slot } | null = null

const TILE_ICON: Record<string, string> = {
  coordinator: glyph('<circle cx="8" cy="5" r="2.5"/><path d="M3 14c.5-3 2.6-4.5 5-4.5s4.5 1.5 5 4.5"/>'),
  lead: glyph('<path d="M3 12l2-6 3 3 3-5 2 8z"/>'),
  globe: glyph('<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c2 2 2 9.2 0 11.2M8 2.4c-2 2-2 9.2 0 11.2"/>'),
  image: glyph('<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="7" r="1.2"/><path d="M3 12l3.5-3 2.5 2 2-1.5 2 2"/>'),
  doc: glyph('<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3M6 8.5h4M6 11h3"/>'),
  search: glyph('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>'),
  check: glyph('<circle cx="8" cy="8" r="5.6"/><path d="M5.6 8.2l1.7 1.7 3.2-3.4"/>'),
  tag: glyph('<path d="M2.5 8.2V3.5h4.7l6 6-4.7 4.7z"/><circle cx="5.2" cy="6.2" r=".8"/>')
}
const TILE_TINT: Record<string, string> = { coordinator: 'violet', lead: 'violet', globe: 'blue', image: 'pink', doc: 'teal', search: 'amber', check: 'green', tag: 'gray', '1': 'green', '2': 'amber', '3': 'red' }

/** The provider's own mark, or a generic chip for an agent without one. */
const providerMark = (agent: string): string => `<span class="m-logo">${(PROVIDER_LOGOS as Record<string, string>)[agent] ?? ICON.models}</span>`
const BAR_TIP = 'How hard the model thinks'

function effortBarHtml(c: ModelChoice | null): string {
  const bar = effortBar(c)
  if (!c?.model) return ''
  if (!bar) return '<span class="m-eff-default">default</span>'
  return `<span class="m-eff" role="img" aria-label="effort ${bar.label}" data-tip="${esc(`${BAR_TIP}: ${bar.label}`)}">${Array.from({ length: bar.total }, (_, i) => `<i class="${i < bar.on ? 'on' : ''}"></i>`).join('')}</span>`
}

function cardHtml(row: RoutingRow, slot: Slot): string {
  const a = avail()
  const c = slot === 'model' ? row.model : row.fallback
  const open = popover?.key === row.key && popover.slot === slot
  const why = cardProblem(c, slot, !!row.fallback, a)
  const name = slot === 'model' ? cardName(c, a) : fallbackText(c, a)
  const label = slot === 'model'
    ? `${row.name} model: ${choiceText(c, a)}${c?.effort ? '' : c?.model ? ', default effort' : ''}. Change`
    : `${row.name} fallback: ${c?.model ? choiceText(c, a) : 'none'}. Change`
  const empty = slot === 'model' ? !c : !c?.model
  const cls = `m-card m-${slot} ${empty ? 'empty' : ''} ${why ? 'dim' : ''} ${open ? 'open' : ''}`
  const body = slot === 'model'
    ? `${c ? providerMark(c.agent) : '<span class="m-logo m-nologo">·</span>'}<span class="m-cname">${esc(name)}</span>${effortBarHtml(c)}`
    : `${c?.model ? providerMark(c.agent) : ''}<span class="m-cname">${esc(name)}</span>`
  const tip = why ?? (slot === 'model' && !c ? 'Orca passes no model: the provider’s own default applies.' : '')
  return `<button type="button" class="${cls}" data-card="${esc(row.key)}" data-slot="${slot}" aria-haspopup="menu" aria-expanded="${open}" aria-label="${esc(label)}" ${tip ? `data-tip="${esc(tip)}"` : ''} ${off()}>${body}</button>`
}

function rowHtml(row: RoutingRow): string {
  const tint = TILE_TINT[row.icon] ?? 'gray'
  const tile = TILE_ICON[row.icon] ?? row.icon
  const edit = row.section === 'types' ? `<button type="button" class="m-edit" data-edit="${esc(row.ref.type === 'type' ? row.ref.id : '')}" aria-label="Edit ${esc(row.name)}" data-tip="Rename, edit the description or remove" ${off()}>${ICON.edit}</button>` : ''
  const sub = row.sub ? `<span class="m-sub" ${row.sub.length > 28 ? `data-tip="${esc(row.sub)}"` : ''}>${esc(row.sub)}</span>` : ''
  const task = `<div class="m-task"><span class="m-tile t-${tint}" aria-hidden="true">${tile}</span><span class="m-tt"><span class="m-name">${esc(row.name)}</span>${sub}</span>${edit}</div>`
  const fb = row.hasFallback ? cardHtml(row, 'fallback') : `<span class="m-card m-fallback m-na" data-tip="A role has no fallback: if its pick is unavailable the provider’s default model runs.">–</span>`
  const cells = lookingUp() ? CHECKING : `${cardHtml(row, 'model')}${fb}`
  const form = typeForm?.mode === 'edit' && row.ref.type === 'type' && typeForm.id === row.ref.id ? typeFormHtml() : ''
  return `<div class="m-row" data-row="${esc(row.key)}"><div class="m-line">${task}<span class="m-wire" aria-hidden="true"></span>${cells}</div>${form}</div>`
}

function typeFormHtml(): string {
  const f = typeForm!
  const picks = f.mode === 'add' ? suggestedTypes(r()).map((t, i) => `<button type="button" class="m-chip" data-suggest="${i}" data-tip="${esc(t.description)}" ${off()}>${esc(t.name)}</button>`).join('') : ''
  const err = f.error ? `<div class="s-err" role="alert">${ICON.warn}<span class="s-wrap">${esc(f.error)}</span></div>` : ''
  const remove = f.mode === 'edit' ? `<button type="button" class="s-push m-danger" data-rmtype="${esc(f.id!)}" ${off()}>Remove type</button>` : ''
  return `<div class="m-form" data-form="${f.mode}">
    ${picks ? `<div class="m-picks" role="group" aria-label="Suggested task types">${picks}</div>` : ''}
    <input class="m-in" id="m-type-name" placeholder="Name, e.g. Browser checks" maxlength="${MAX_TYPE_NAME}" value="${esc(f.name)}" autocomplete="off" spellcheck="false" ${off()} ${described('Task type name', 'A short name; tasks name it when the lead splits the work')}>
    <input class="m-in" id="m-type-desc" placeholder="When is a task of this type? (for the lead)" maxlength="${MAX_TYPE_DESCRIPTION}" value="${esc(f.description)}" autocomplete="off" spellcheck="false" ${off()} ${described('Task type description', 'Tells whoever splits the work when a task is of this type')}>
    ${err}
    <div class="m-form-actions">${remove}<span class="m-spacer"></span><button type="button" class="s-push" id="m-type-cancel">Cancel</button><button type="button" class="s-push primary" id="m-type-save" ${off()}>${f.mode === 'add' ? 'Add' : 'Save'}</button></div>
  </div>`
}

function addTypeRow(): string {
  if (typeForm?.mode === 'add') return `<div class="m-row">${typeFormHtml()}</div>`
  if (!canAddType(r())) return `<div class="m-row m-addrow"><span class="m-faint">At most ${MAX_TYPES} task types: remove one first.</span></div>`
  const hint = suggestedTypes(r()).slice(0, 3).map((t) => t.name).join(' · ')
  return `<div class="m-row m-addrow"><button type="button" class="m-add" id="m-addtype" ${off()}>+ Add task type</button>${hint ? `<span class="m-faint">${esc(hint)}</span>` : ''}</div>`
}

function presetStrip(): string {
  const v = presetView(r())
  const pill = (p: Preset) => {
    const on = v.selected === p.id
    const rm = on && v.removable === p.id ? `<button type="button" class="m-pill-x" data-rmpreset="${esc(p.id)}" ${off()} aria-label="Remove preset ${esc(p.name)}" data-tip="Remove this preset">${ICON.close}</button>` : ''
    return `<span class="m-pill ${on ? 'sel' : ''} ${rm ? 'has-x' : ''}"><button type="button" class="m-pill-b" data-preset="${esc(p.id)}" aria-pressed="${on}" ${off()}>${esc(p.name)}</button>${rm}</span>`
  }
  const custom = v.selected ? '' : '<span class="m-pill sel" aria-current="true" data-tip="No preset matches the current setup"><span class="m-pill-b">Custom</span></span>'
  const save = naming
    ? `<span class="m-naming"><input class="m-in m-name-in" id="s-presetname" placeholder="Preset name" value="${esc(presetName)}" maxlength="40" autocomplete="off" spellcheck="false" ${off()} ${described('Preset name', 'A name for the current setup')}><button type="button" class="s-push primary" id="s-presetsave" ${off()}>Save</button><button type="button" class="s-push" id="s-presetcancel">Cancel</button></span>`
    : `<button type="button" class="m-pill m-pill-save" id="s-saveas" ${off()} data-tip="Save the current setup as a preset">+ Save current</button>`
  const err = naming && presetError ? `<div class="s-err" role="alert">${ICON.warn}<span class="s-wrap">${esc(presetError)}</span></div>` : ''
  return `<div class="m-presets" role="group" aria-label="Presets" aria-description="${esc(PRESET_TIP)}">${v.builtIn.map(pill).join('')}${v.saved.map(pill).join('')}${custom}${save}</div>${err}`
}

function section(title: string, tip: string, rows: string[], note = '', inside = ''): string {
  return `<section class="s-group"><h4 class="s-gh">${label(title, tip)}${note ? ` <span class="m-gh-note">· ${esc(note)}</span>` : ''}</h4><div class="s-card m-card-box ${inside ? 'm-diff' : ''}">${inside}${rows.join('')}</div></section>`
}

function pageModels(): string {
  const rows = routingRows(r())
  const by = (s: RoutingRow['section']) => rows.filter((x) => x.section === s).map(rowHtml)
  const head = '<div class="m-line m-head" aria-hidden="true"><span class="m-task">Task</span><span class="m-wire"></span><span class="m-hmodel">Model · effort</span><span class="m-hfb">If unavailable</span></div>'
  const step = '<span class="m-step" data-tip="A task that fails is retried one row up (Simple → Normal → Hard), never past Hard."><svg viewBox="0 0 14 120" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 116V6M2 12l5-6 5 6"/></svg><span>failed? one step up</span></span>'
  return presetStrip() + head
    + section('Roles', ROLE_TIP, by('roles'))
    + section('Task types', TYPES_TIP, [...by('types'), addTypeRow()], 'matched first')
    + section('Everything else, by difficulty', DIFFICULTY_TIP, by('difficulty'), '', step)
    + `<p class="m-stepnote">A failed task moves one row up: Simple → Normal → Hard.</p>`
}

/** Reset: Balanced's coordinator, lead and rows; the task types and saved presets stay. */
const modelsAtDefault = () => same(r(), resetRouting(r()))
function resetModels(): void {
  naming = false
  presetError = null
  typeForm = null
  popover = null
  void session.change((x) => { x.routing = resetRouting(x.routing) })
}

function startNaming(): void {
  naming = true
  presetName = ''
  presetError = null
  focusAfter = '#s-presetname'
  render()
}
function stopNaming(): void {
  naming = false
  presetError = null
  focusAfter = '#s-saveas'
  render()
}
/** Saves the current setup under the typed name; a built-in or empty name shows its error and keeps the field. */
function saveNamedPreset(): void {
  const res = saveNamed(r(), presetName)
  if (!res.ok) {
    presetError = res.error
    focusAfter = '#s-presetname'
    render()
    return
  }
  naming = false
  presetError = null
  focusAfter = `[data-preset="${res.routing.presets.find((p) => p.name === presetName.trim())?.id ?? ''}"]`
  void session.change((x) => { x.routing = res.routing })
}

// ----- task types -----

function openTypeForm(mode: 'add' | 'edit', id?: string): void {
  const t = id ? r().types.find((x) => x.id === id) : undefined
  typeForm = { mode, id, name: t?.name ?? '', description: t?.description ?? '', error: null }
  popover = null
  focusAfter = '#m-type-name'
  render()
}
function closeTypeForm(): void {
  const from = typeForm
  typeForm = null
  focusAfter = from?.mode === 'edit' ? `[data-edit="${from.id}"]` : '#m-addtype'
  render()
}
function submitTypeForm(): void {
  const f = typeForm
  if (!f) return
  const res = f.mode === 'add' ? addTaskType(r(), f.name, f.description) : editTaskType(r(), f.id!, f.name, f.description)
  if (!res.ok) { f.error = res.error; focusAfter = '#m-type-name'; render(); return }
  typeForm = null
  focusAfter = f.mode === 'edit' ? `[data-edit="${f.id}"]` : '#m-addtype'
  void session.change((x) => { x.routing = res.routing })
}
function removeTypeNow(id: string): void {
  typeForm = null
  popover = null
  focusAfter = '#m-addtype'
  void session.change((x) => { x.routing = removeTaskType(x.routing, id) })
}

// ----- the model popover -----

/** One floating menu for every card, outside the page so its scrolling and containment never clip it. */
const pop = document.createElement('div')
pop.id = 's-pop'
pop.className = 'm-pop'
pop.hidden = true
pop.tabIndex = -1
$('settings').appendChild(pop)

const cardSelector = (p: { key: string; slot: Slot }) => `[data-card="${p.key}"][data-slot="${p.slot}"]`
function popItems(): HTMLElement[] { return [...pop.querySelectorAll<HTMLElement>('[data-pick],[data-pnone]')].filter((x) => !(x as HTMLButtonElement).disabled) }

function renderPopover(refocus = false): void {
  const anchor = popover ? document.querySelector<HTMLElement>(`#s-page ${cardSelector(popover)}`) : null
  const ref = popover ? refFrom(popover.key) : null
  if (!popover || !anchor || !ref || locked() || lookingUp()) { popover = null; pop.hidden = true; pop.innerHTML = ''; return }
  const v = popoverView(r(), ref, popover.slot, avail())
  const keep = pop.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : null
  const item = (pick: string, text: string, selected: boolean, dim: string | null, mark = '') =>
    `<button type="button" class="m-opt ${selected ? 'sel' : ''} ${dim ? 'dim' : ''}" role="menuitemradio" aria-checked="${selected}" data-pick="${esc(pick)}" ${dim ? `data-tip="${esc(dim)}" aria-description="${esc(dim)}"` : ''}>${mark}<span class="m-oname">${esc(text)}</span>${selected ? `<span class="m-check" aria-hidden="true">${ICON.tick}</span>` : ''}</button>`
  const none = v.none ? `<button type="button" class="m-opt ${v.none.selected ? 'sel' : ''}" role="menuitemradio" aria-checked="${v.none.selected}" data-pnone="1"><span class="m-oname">${esc(v.none.label)}</span>${v.none.selected ? `<span class="m-check" aria-hidden="true">${ICON.tick}</span>` : ''}</button>` : ''
  const groups = v.groups.map((g) => `<div class="m-pgh">${providerMark(g.agent)}<span>${esc(g.name)}</span></div>${g.models.map((m) => item(`${g.agent}|${m.id}`, m.label, m.selected, m.dim)).join('')}`).join('')
  const seg = `<div class="m-seg" role="radiogroup" aria-label="Effort">${v.efforts.options.map((o) => `<button type="button" class="${o.selected ? 'sel' : ''}" role="radio" aria-checked="${o.selected}" data-peffort="${o.value}" ${v.efforts.disabled ? 'disabled' : ''}>${esc(o.label)}</button>`).join('')}</div>`
  pop.innerHTML = `<div class="m-ptitle" id="s-pop-title">${esc(v.title)}</div><div class="m-plist" role="none">${none}${groups}</div><div class="m-peff"><span class="m-pgh m-pgh-eff">Effort</span>${v.efforts.disabled || v.efforts.adjusted ? `<span class="s-tipwrap" data-tip="${esc(v.efforts.tip)}">${seg}</span>` : seg}</div>`
  pop.setAttribute('role', 'menu')
  pop.setAttribute('aria-labelledby', 's-pop-title')
  pop.hidden = false
  placePopover(anchor)
  if (refocus || keep) {
    const again = keep?.pick ? pop.querySelector<HTMLElement>(`[data-pick="${CSS.escape(keep.pick)}"]`) : keep?.peffort !== undefined ? pop.querySelector<HTMLElement>(`[data-peffort="${CSS.escape(keep.peffort)}"]`) : null
    ;(again ?? pop.querySelector<HTMLElement>('.m-opt.sel') ?? popItems()[0] ?? pop).focus()
  }
}

/** Under the card, or above it when there is no room below; kept inside the window. */
function placePopover(anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect()
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight
  const w = Math.min(280, vw - 16)
  pop.style.width = `${w}px`
  pop.style.maxHeight = `${Math.max(180, Math.min(420, vh - 16))}px`
  const h = pop.offsetHeight
  const below = vh - a.bottom - 8, above = a.top - 8
  const top = h <= below || below >= above ? Math.min(a.bottom + 4, Math.max(8, vh - h - 8)) : Math.max(8, a.top - h - 4)
  pop.style.left = `${Math.max(8, Math.min(a.left, vw - w - 8))}px`
  pop.style.top = `${top}px`
}

function openPopover(key: string, slot: Slot): void {
  popover = { key, slot }
  typeForm = typeForm?.mode === 'add' ? typeForm : null
  render()
  renderPopover(true)
}
function closePopover(restore: boolean): void {
  const was = popover
  popover = null
  if (restore && was) focusAfter = cardSelector(was)
  render()
  pop.hidden = true
}
/** After a pick the page shows the new setup; the popover stays for an effort, closes otherwise. */
function applyPick(change: (x: RoutingSettings) => RoutingSettings, close: boolean): void {
  const was = popover
  if (close) { popover = null; if (was) focusAfter = cardSelector(was) }
  void session.change((x) => { x.routing = change(x.routing) })
}

/** A selector that finds the same control after a redraw, so keyboard focus stays where it was. */
function focusKey(el: Element | null): string | null {
  if (!el || !$('s-page').contains(el)) return null
  if (el.id) return `#${el.id}`
  const ds = (el as HTMLElement).dataset
  if (ds.card) return `[data-card="${ds.card}"][data-slot="${ds.slot}"]`
  for (const k of ['handle', 'model', 'enable', 'rmfolder', 'reset', 'preset', 'edit', 'rmpreset']) if (ds[k]) return `[data-${k}="${ds[k]}"]`
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
  const body = !state && !loadError ? '<p class="s-loading">Loading…</p>' : { summaries: pageSummaries, models: pageModels, format: pageFormat, capacity: pageCapacity, features: pageFeatures, advanced: pageAdvanced, about: pageAbout }[pageId]()
  const atDefault = page.id === 'models' ? modelsAtDefault() : session.isDefault(page.keys)
  const reset = state && !locked() && !atDefault ? `<div class="s-foot"><button type="button" class="s-push" data-reset="${page.id}">Reset to Defaults</button></div>` : ''
  $('s-page').innerHTML = `<h3 class="s-ptitle">${label(page.label, page.tip)}</h3>${errorLine()}${body}${reset}`
  if (focusAfter) {
    const el = document.querySelector<HTMLElement>(`#s-page ${focusAfter}`)
    // A control that is now disabled (the last writer on, the stepper's end) hands focus to the page.
    ;(el && !(el as HTMLButtonElement).disabled ? el : dialog).focus()
    focusAfter = null
  }
  renderPopover()
}

export const settingsOpen = (): boolean => !$('settings').hidden

// A model lookup that landed after the dialog opened: fresh availability and writer status, never
// the draft (an edit in flight stays as it is).
orca.plugin.on('sidebar.settingsChanged', (s) => {
  if (!settingsOpen() || !state) return
  const next = s as SettingsState
  state = { ...state, availability: next.availability, writers: next.writers }
  render()
})

export function openSettings(): void {
  opener = document.activeElement as HTMLElement | null
  state = null
  loadError = null
  newFolder = ''
  naming = false
  presetError = null
  typeForm = null
  popover = null
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
  popover = null
  pop.hidden = true
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
  // A click outside an open popover closes it; a click on its own card is the toggle.
  if (popover && !pop.contains(e.target as Node)) {
    const same = t?.dataset.card === popover.key && t.dataset.slot === popover.slot
    popover = null
    if (same) { focusAfter = focusKey(t); render(); return }
    render()
  }
  if (!t || (t as HTMLButtonElement).disabled) return
  const ds = t.dataset
  if (ds.card) { openPopover(ds.card, ds.slot as Slot); return }
  if (ds.pick !== undefined || ds.pnone !== undefined || ds.peffort !== undefined) { onPick(ds); return }
  if (ds.preset) { const id = ds.preset; focusAfter = `[data-preset="${id}"]`; void session.change((x) => { x.routing = pickPreset(x.routing, id) }); return }
  if (ds.edit) { openTypeForm('edit', ds.edit); return }
  if (ds.suggest !== undefined) { const pick = suggestedTypes(r())[Number(ds.suggest)]; if (pick && typeForm) { typeForm.name = pick.name; typeForm.description = pick.description; typeForm.error = null; focusAfter = '#m-type-save'; render() } return }
  if (ds.rmtype) { removeTypeNow(ds.rmtype); return }
  if (ds.page) { pageId = ds.page as PageId; popover = null; typeForm = null; render(); return }
  if (ds.reset === 'models') { resetModels(); return }
  if (ds.reset) { void session.reset(PAGES.find((p) => p.id === ds.reset)!.keys); return }
  if (ds.rmpreset) { const id = ds.rmpreset; focusAfter = '#s-saveas'; void session.change((x) => { x.routing = deletePreset(x.routing, id) }); return }
  if (ds.step) { const k = ds.step as 'marginGB' | 'warnHeadroomGB'; void session.change((x) => { x[k] = Math.min(16, Math.max(0, x[k] + Number(ds.d))) }); return }
  if (ds.rmfolder) { void session.change((x) => { x.folders.splice(Number(ds.rmfolder), 1) }); return }
  switch (t.id) {
    case 's-x': close(); break
    case 's-addfolder': addFolder(); break
    case 's-saveas': startNaming(); break
    case 'm-addtype': openTypeForm('add'); break
    case 'm-type-save': submitTypeForm(); break
    case 'm-type-cancel': closeTypeForm(); break
    case 's-presetsave': saveNamedPreset(); break
    case 's-presetcancel': stopNaming(); break
    case 's-check': void checkUpdates(); break
    case 's-update': settingsHooks.update(updateState && updateState.kind !== 'none' ? updateState : { kind: 'available', version: t.dataset.version! }); break
    case 's-reveal': void orca.plugin.request('sidebar.revealSettings').catch(() => null); break
  }
}

/** A pick inside the popover: a model (stays open for its effort), None / Provider default, or an effort. */
function onPick(ds: DOMStringMap): void {
  const ref = popover ? refFrom(popover.key) : null
  if (!popover || !ref) return
  const slot = popover.slot
  if (ds.peffort !== undefined) { const e = ds.peffort as Effort | ''; applyPick((x) => pickEffort(x, ref, slot, e), true); return }
  if (ds.pnone !== undefined) { applyPick((x) => pickNone(x, ref, slot), true); return }
  const [agent, model] = (ds.pick ?? '').split('|')
  if (!agent || !model) return
  // The effort control follows the pick, so the popover stays while there is an effort to choose.
  applyPick((x) => pickModel(x, ref, slot, agent, model, avail()), effortsFor(agent, model, avail()).length === 0)
}

function onChange(e: Event): void {
  const t = e.target as HTMLInputElement
  if (t.dataset.model) { const p = t.dataset.model as WriterProvider; void session.change((x) => { x.models[p] = t.value }) }
  else if (t.dataset.enable) { const p = t.dataset.enable as WriterProvider; void session.change((x) => { x.enabled[p] = t.checked }) }
  else if (t.id === 's-format') void session.change((x) => { x.format = t.value as Draft['format'] })
  else if (t.id === 's-bots') void session.change((x) => { x.bots = t.checked })
  else if (t.id === 's-linear-on') void session.change((x) => { x.linear = t.checked })
  else if (t.id === 's-speed') void session.change((x) => { x.tokenSpeed = t.checked })
  else if (t.id === 's-linear') void session.change((x) => { x.linearDryRun = t.checked })
}

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement
  if (popover && pop.contains(t)) return onPopKey(e, t)
  if (e.key === 'Escape') {
    e.preventDefault()
    if (naming && t.id === 's-presetname') stopNaming()
    else if (typeForm && t.closest('.m-form')) closeTypeForm()
    else close()
  }
  else if (t.dataset.handle && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(t.dataset.handle as WriterProvider, e.key === 'ArrowUp' ? -1 : 1) }
  else if (e.key === 'Enter' && t.id === 's-newfolder') { e.preventDefault(); addFolder() }
  else if (e.key === 'Enter' && t.id === 's-presetname') { e.preventDefault(); saveNamedPreset() }
  else if (e.key === 'Enter' && (t.id === 'm-type-name' || t.id === 'm-type-desc')) { e.preventDefault(); submitTypeForm() }
}

/** Esc closes the popover only; arrows move through the models, and left and right through the efforts. */
function onPopKey(e: KeyboardEvent, t: HTMLElement): void {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(true); return }
  const move = (list: HTMLElement[], by: number | 'start' | 'end') => {
    if (!list.length) return
    const at = list.indexOf(t)
    const next = by === 'start' ? 0 : by === 'end' ? list.length - 1 : (at + by + list.length) % list.length
    e.preventDefault()
    list[next].focus()
  }
  const efforts = [...pop.querySelectorAll<HTMLElement>('[data-peffort]')].filter((x) => !(x as HTMLButtonElement).disabled)
  if (t.dataset.peffort !== undefined) {
    if (e.key === 'ArrowRight') move(efforts, 1)
    else if (e.key === 'ArrowLeft') move(efforts, -1)
    else if (e.key === 'ArrowUp') move(popItems(), 'end')
    return
  }
  const items = popItems()
  if (e.key === 'ArrowDown') { if (t === items[items.length - 1] && efforts.length) { e.preventDefault(); (efforts.find((x) => x.classList.contains('sel')) ?? efforts[0]).focus() } else move(items, 1) }
  else if (e.key === 'ArrowUp') move(items, -1)
  else if (e.key === 'Home') move(items, 'start')
  else if (e.key === 'End') move(items, 'end')
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
root.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement
  if (t.id === 's-newfolder') newFolder = t.value
  else if (t.id === 's-presetname') presetName = t.value
  else if (typeForm && t.id === 'm-type-name') typeForm.name = t.value
  else if (typeForm && t.id === 'm-type-desc') typeForm.description = t.value
})
// A scrolled page moves the card the popover hangs from: it follows, or closes when the card is out of view. A resize closes it.
$('s-page').addEventListener('scroll', () => {
  if (!popover) return
  const anchor = document.querySelector<HTMLElement>(`#s-page ${cardSelector(popover)}`)
  const page = $('s-page').getBoundingClientRect(), a = anchor?.getBoundingClientRect()
  // The popover follows its card while the card is in view, and closes once the card scrolls away.
  if (anchor && a && a.bottom > page.top && a.top < page.bottom) placePopover(anchor)
  else closePopover(false)
}, { passive: true })
window.addEventListener('resize', () => { if (popover) closePopover(false) })
root.addEventListener('keydown', onKey)
root.addEventListener('pointerdown', onDown)
root.addEventListener('pointermove', onMove)
root.addEventListener('pointerup', onUp)
root.addEventListener('pointercancel', onUp)
// Relative times ("2 min ago") and cooldowns stay current while the dialog is open.
setInterval(() => { if (settingsOpen() && !drag && !popover && !['SELECT', 'INPUT'].includes(document.activeElement?.tagName ?? '')) render() }, 30_000)
