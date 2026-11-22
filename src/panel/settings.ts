// The Settings dialog, laid out like macOS System Settings: a sidebar of pages, a page title, rows in
// rounded groups with the label left and the control right, and every explanation in a tooltip
// (the panel's [data-tip]). Changes apply at once: each one is saved through the worker
// (sidebar.saveSettings), which owns ~/.orca-flow/config.json; a failed save puts the control back.
import type { SettingsState, UpdateState } from '../protocol.ts'
import type { UpdateCheck } from '../update.ts'
import { PROVIDER_LOGOS } from '../provider-logos.ts'
import { addable, agentName, agentsShown, choiceFrom, choiceValue, effortsFor, examples, modelLabel, modelOptions, newCandidate, UNKNOWN, unavailable } from './models.ts'
import { TIER_NAMES, type Effort, type ModelChoice, type Tier } from '../routing.ts'
import { ago, DEFAULT_DRAFT, settingsSession, statusView, WRITABLE, type Draft, type DraftKey, type WriterProvider } from '../settings.ts'

const glyph = (d: string) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const ICON = {
  summaries: glyph('<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M5 6.5h6M5 9.5h4"/>'),
  format: glyph('<path d="M3 3.5h10v7H6.5L3 13.5z"/><path d="M6 7l1.5 1.5L10.5 5.5"/>'),
  capacity: glyph('<rect x="2" y="4.5" width="12" height="7" rx="1.5"/><path d="M5 7v2M8 7v2M11 7v2"/>'),
  models: glyph('<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2"/>'),
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
    models: [{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash' }, { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon' }, { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon' }, { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen' }, { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon' }] }
}
const MODEL_LABEL: Record<string, string> = { haiku: 'Claude Haiku', sonnet: 'Claude Sonnet', 'gpt-6-luna': 'GPT-6 Luna', 'gemini-3.8-flash-low': 'Gemini 3.8 Flash', 'gemini-4-carbon-low': 'Gemini 4 Carbon', 'gemini-4-neon-low': 'Gemini 4 Neon', 'gemini-4-hydrogen-low': 'Gemini 4 Hydrogen', 'gemini-4-argon-low': 'Gemini 4 Argon', 'agy-default': 'Antigravity' }

type PageId = 'summaries' | 'models' | 'format' | 'capacity' | 'advanced' | 'about'
const PAGES: { id: PageId; label: string; tint: string; keys: DraftKey[]; tip: string }[] = [
  { id: 'summaries', label: 'Titles & Summaries', tint: '#0a84ff', keys: ['writers', 'enabled', 'models'],
    tip: 'After each agent turn, one request writes the title, summary and ask on its Orca Flow card. Only Orca Flow’s sidebar cards change: Orca names its own tabs and chats.' },
  { id: 'models', label: 'Models', tint: '#5e5ce6', keys: ['routing'],
    tip: 'The model each coordinator, lead and worker starts with. Applies to new launches only: running and resumed sessions keep their model.' },
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

function pageAdvanced(): string {
  return group([
    row(label('Linear test mode', 'Log the Linear comments and status changes Orca Flow would send, and send nothing.'), toggle('s-linear', d().linearDryRun, 'Linear test mode', 'Log the Linear comments and status changes Orca Flow would send, and send nothing.')),
    row(label('Settings file', 'Saved in ~/.orca-flow/config.json. Settings you never change stay out of the file.'), '<button type="button" class="s-push" id="s-reveal">Show in Finder</button>')
  ])
}

// ---------- Models ----------

const avail = () => state?.availability ?? UNKNOWN
const r = () => d().routing
const NEW_ONLY = 'Applies to new launches only: running and resumed sessions keep their model.'
const ROLE_TIP: Record<'coordinator' | 'lead', string> = {
  coordinator: `The model a new coordinator conversation starts with. Provider default: whatever Claude or Codex picks by itself. A model for one provider applies when the coordinator runs that provider. ${NEW_ONLY}`,
  lead: `The model a coordinator starts a workstream lead with. ${NEW_ONLY}`
}

/** A model pop-up: the provider default, then each installed agent's models (agents that list none offer their default). */
function modelSelect(attr: string, current: ModelChoice | null, name: string, tip: string, withProviderDefault = true): string {
  const a = avail()
  const groups = agentsShown(a)
  // A saved pick this machine does not list stays shown, so the pop-up never silently changes it.
  if (current && !groups.includes(current.agent)) groups.push(current.agent)
  const opt = (value: string, text: string) => `<option value="${esc(value)}" ${choiceValue(current) === value ? 'selected' : ''}>${esc(text)}</option>`
  const body = groups.map((agent) => {
    const models = modelOptions(agent, a)
    if (current?.agent === agent && current.model && !models.some((m) => m.id === current.model)) models.push({ id: current.model, label: current.model })
    return `<optgroup label="${esc(agentName(agent))}">${opt(`${agent}:`, models.length ? `${agentName(agent)} default` : 'Default model')}${models.map((m) => opt(`${agent}:${m.id}`, m.label)).join('')}</optgroup>`
  }).join('')
  return `<select class="s-pop s-model" ${attr} ${off()} ${described(name, tip)}>${withProviderDefault ? opt('', 'Provider default') : ''}${body}</select>`
}

/** Effort pop-up: Default, then what the model takes. Off without a model (Orca takes an effort only with one). */
function effortSelect(attr: string, c: ModelChoice | null, name: string): string {
  const efforts = c?.model ? effortsFor(c.agent, c.model, avail()) : []
  const tip = c?.model ? 'How hard the model thinks. Default: the model’s own setting.' : 'Choose a model first: an effort applies only with one.'
  return `<span class="s-tipwrap" ${c?.model ? '' : `data-tip="${esc(tip)}"`}><select class="s-pop s-effort" ${attr} ${off(!c?.model)} ${described(name, tip)}><option value="">Default</option>${efforts.map((e) => `<option value="${e}" ${c?.effort === e ? 'selected' : ''}>${e}</option>`).join('')}</select></span>`
}

function roleRow(role: 'coordinator' | 'lead'): string {
  const c = r()[role]
  const title = role === 'coordinator' ? 'Coordinator' : 'Lead'
  const why = c ? unavailable(c.agent, c.model, avail()) : null
  return row(`${label(title, ROLE_TIP[role])}${why ? `<span class="s-warn" tabindex="0" data-tip="${esc(`${why}. New ${role}s start with the provider default until it is back.`)}" aria-label="${esc(why)}">${ICON.warn}</span>` : ''}`,
    modelSelect(`data-rmodel="${role}"`, c, `${title} model`, ROLE_TIP[role]) + effortSelect(`data-reffort="${role}"`, c, `${title} effort`), 's-mrow')
}

function rstep(key: 'maxParallel' | 'maxEscalations', min: number, max: number, name: string): string {
  const v = r()[key]
  return `<span class="s-value" aria-hidden="true">${v}</span><span class="s-seg" role="group" aria-label="${esc(name)}: ${v}">
    <button type="button" data-rstep="${key}" data-d="-1" ${off(v <= min)} aria-label="${esc(name)}: less">${ICON.minus}</button><button type="button" data-rstep="${key}" data-d="1" ${off(v >= max)} aria-label="${esc(name)}: more">${ICON.plus}</button></span>`
}

function candidateRow(i: number): string {
  const c = r().candidates[i]
  const a = avail()
  const why = unavailable(c.agent, c.model, a)
  const name = `${agentName(c.agent)} ${modelLabel(c.agent, c.model, a)}`
  const logo = (PROVIDER_LOGOS as Record<string, string>)[c.agent] ?? `<span class="s-mono">${esc(agentName(c.agent).slice(0, 1))}</span>`
  const tier = `<select class="s-pop s-tier" data-ctier="${i}" ${off()} ${described(`${name} capability`, 'Your rating of what this model handles well. Light: mechanical edits. Standard: normal changes with tests. Strong: design, hard bugs, migrations.')}>${([1, 2, 3] as Tier[]).map((t) => `<option value="${t}" ${c.tier === t ? 'selected' : ''}>${TIER_NAMES[t]}</option>`).join('')}</select>`
  const cost = `<span class="s-value s-cost" aria-hidden="true" data-tip="Relative cost ${c.cost} of 5">${'●'.repeat(c.cost)}<span class="s-faint">${'●'.repeat(5 - c.cost)}</span></span><span class="s-seg" role="group" aria-label="${esc(name)} relative cost: ${c.cost} of 5">
    <button type="button" data-ccost="${i}" data-d="-1" ${off(c.cost <= 1)} aria-label="${esc(name)}: cheaper">${ICON.minus}</button><button type="button" data-ccost="${i}" data-d="1" ${off(c.cost >= 5)} aria-label="${esc(name)}: costlier">${ICON.plus}</button></span>`
  return `<div class="s-row s-crow ${why ? 'dim' : ''}" data-cand="${i}"${why ? ` data-tip="${esc(`${why}, so workers are not routed to it.`)}"` : ''}>
    <span class="s-logo">${logo}</span>
    <span class="s-label" title="${esc(c.model)}">${esc(modelLabel(c.agent, c.model, a))}</span>
    <div class="s-ctl">${tier}${cost}${toggle(`s-cand-${i}`, c.enabled, `Route workers to ${name}`, '', false, `data-cen="${i}"`)}<button type="button" class="s-round" data-crm="${i}" ${off()} aria-label="Remove ${esc(name)}">${ICON.minus}</button></div>
  </div>`
}

function pageModels(): string {
  const rt = r()
  const roles = group([roleRow('coordinator'), roleRow('lead')], { text: 'Roles', tip: `Coordinators and leads plan and steer, so they usually get a strong model. ${NEW_ONLY}` })
  const mode = row(label('Choose model', 'Auto: each worker task gets the cheapest model you rated capable enough for it (trivial tasks need Light, standard need Standard, complex need Strong; high-risk tasks one more). Fixed: every worker gets the same model.'),
    `<select class="s-pop" id="s-wmode" ${off()} ${described('Worker model', 'Auto or fixed')}><option value="auto" ${rt.workerMode === 'auto' ? 'selected' : ''}>Auto (cheapest capable)</option><option value="fixed" ${rt.workerMode === 'fixed' ? 'selected' : ''}>Fixed</option></select>`)
  const rows = [mode]
  if (rt.workerMode === 'fixed') {
    rows.push(row(label('Model', `The model every worker starts with. ${NEW_ONLY}`), modelSelect('data-rmodel="worker"', rt.worker, 'Worker model', 'The model every worker starts with') + effortSelect('data-reffort="worker"', rt.worker, 'Worker effort'), 's-mrow'))
  } else {
    rt.candidates.forEach((_, i) => rows.push(candidateRow(i)))
    const add = addable(rt.candidates, avail())
    if (add.length) rows.push(row(`<select class="s-pop s-addmodel" id="s-addmodel" ${off()} ${described('Add model', 'Adds a model workers can be routed to, rated Standard at cost 3 until you change it.')}><option value="" selected>Add model…</option>${add.map((g) => `<optgroup label="${esc(agentName(g.agent))}">${g.models.map((m) => `<option value="${esc(`${g.agent}:${m.id}`)}">${esc(m.label)}</option>`).join('')}</optgroup>`).join('')}</select>`, '', 's-add'))
  }
  const workers = group(rows, { text: 'Workers', tip: `How each worker task picks its model. ${NEW_ONLY}` })
    + (rt.workerMode === 'auto' ? '<p class="s-note">Tier and cost are your own ratings, not prices or measured quality.</p>' : '')
  const limits = group([
    row(label('Workers at once', 'How many workers one lead runs at the same time. Free memory can still hold new ones back.'), rstep('maxParallel', 1, 6, 'Workers at once')),
    row(label('Retries with a stronger model', 'When a worker fails, how many times its task may be tried again, each time with a model one tier stronger. 0: never; the lead asks you instead.'), rstep('maxEscalations', 0, 2, 'Retries with a stronger model'))
  ])
  const ex = examples(rt, avail()).map((e) => row(label(`${e.taskClass[0].toUpperCase()}${e.taskClass.slice(1)} task`, { trivial: 'Mechanical, one or two files, obvious result.', standard: 'A normal bounded change with tests.', complex: 'Cross-cutting design, hard debugging, concurrency, migrations or security.' }[e.taskClass]),
    `<span class="s-value${e.ok ? '' : ' s-bad'}" tabindex="0" data-tip="${esc(e.tip)}" aria-description="${esc(e.tip)}">${esc(e.text)}</span>`))
  return roles + workers + limits + group(ex, { text: 'Example routing', tip: 'What a new worker task of each kind would start with right now, given these settings and what is installed.' })
}

/** A selector that finds the same control after a redraw, so keyboard focus stays where it was. */
function focusKey(el: Element | null): string | null {
  if (!el || !$('s-page').contains(el)) return null
  if (el.id) return `#${el.id}`
  const ds = (el as HTMLElement).dataset
  for (const k of ['handle', 'model', 'enable', 'rmfolder', 'reset', 'rmodel', 'reffort', 'ctier', 'cen', 'crm']) if (ds[k]) return `[data-${k}="${ds[k]}"]`
  if (ds.step) return `[data-step="${ds.step}"][data-d="${ds.d}"]`
  if (ds.rstep) return `[data-rstep="${ds.rstep}"][data-d="${ds.d}"]`
  if (ds.ccost) return `[data-ccost="${ds.ccost}"][data-d="${ds.d}"]`
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
  const body = !state && !loadError ? '<p class="s-loading">Loading…</p>' : { summaries: pageSummaries, models: pageModels, format: pageFormat, capacity: pageCapacity, advanced: pageAdvanced, about: pageAbout }[pageId]()
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
  if (ds.rstep) { const k = ds.rstep as 'maxParallel' | 'maxEscalations'; const [lo, hi] = k === 'maxParallel' ? [1, 6] : [0, 2]; void session.change((x) => { x.routing[k] = Math.min(hi, Math.max(lo, x.routing[k] + Number(ds.d))) }); return }
  if (ds.ccost) { const i = Number(ds.ccost); void session.change((x) => { const c = x.routing.candidates[i]; if (c) c.cost = Math.min(5, Math.max(1, c.cost + Number(ds.d))) }); return }
  if (ds.crm) { const i = Number(ds.crm); focusAfter = '#s-addmodel'; void session.change((x) => { x.routing.candidates.splice(i, 1) }); return }
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
  else if (t.dataset.rmodel) {
    const role = t.dataset.rmodel as 'coordinator' | 'lead' | 'worker'
    void session.change((x) => {
      const before = x.routing[role]
      const next = choiceFrom(t.value)
      // The effort stays when the new model takes it.
      if (next?.model && before?.effort && effortsFor(next.agent, next.model, avail()).includes(before.effort)) next.effort = before.effort
      x.routing[role] = next
    })
  }
  else if (t.dataset.reffort) {
    const role = t.dataset.reffort as 'coordinator' | 'lead' | 'worker'
    void session.change((x) => { const c = x.routing[role]; if (c?.model) x.routing[role] = choiceFrom(choiceValue(c), (t.value || undefined) as Effort | undefined) })
  }
  else if (t.id === 's-wmode') void session.change((x) => { x.routing.workerMode = t.value === 'fixed' ? 'fixed' : 'auto' })
  else if (t.dataset.ctier) { const i = Number(t.dataset.ctier); void session.change((x) => { const c = x.routing.candidates[i]; if (c) c.tier = Number(t.value) as Tier }) }
  else if (t.dataset.cen) { const i = Number(t.dataset.cen); void session.change((x) => { const c = x.routing.candidates[i]; if (c) c.enabled = t.checked }) }
  else if (t.id === 's-addmodel' && t.value) {
    const [agent, ...rest] = t.value.split(':')
    focusAfter = '#s-addmodel'
    void session.change((x) => { x.routing.candidates.push(newCandidate(agent, rest.join(':'))) })
  }
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
