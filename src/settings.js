// The user's settings as ~/.orca-flow/config.json holds them, and as the Settings dialog edits them.
// Pure: the worker reads and writes the file (src/config.ts), the panel draws and edits (src/panel/settings.ts).
// Existing keys keep their names and meaning; their readers are src/worker.ts, src/capacity.ts,
// skills/orca-flow/scripts/stop-check.mjs and skills/orca-flow/scripts/orca-flow.mjs.

import { DEFAULT_ROUTING, normalizeRouting,                      } from './routing.js'


/** One writer in `writers`, tried in list order. `model` is absent for a writer without a choice. */

/** Absent or "off": no check; "all": every coordinator and lead; a list: agents working under those folders. */

/** Parts of Orca Flow that show only when switched on (Settings → Features). Display only: a switch never touches Orca's own data. */




export const WRITER_PROVIDERS                            = ['claude', 'codex', 'antigravity']
/** The models each CLI accepts by name, the default first. */
export const WRITER_MODELS                                            = { claude: ['haiku', 'sonnet'], codex: ['gpt-6-luna'], antigravity: ['gemini-3.8-flash-low', 'gemini-4-carbon-low', 'gemini-4-neon-low', 'gemini-4-hydrogen-low', 'gemini-4-argon-low'] }
/**
 * Writers Orca Flow can run. Antigravity runs in an isolated temporary workspace with a `tools: []`
 * custom agent, `inheritCustomizations: false`, `inheritMcp: false`, strict deny rules, and stdin
 * `stream-json` input.
 */
export const WRITABLE                            = ['claude', 'codex', 'antigravity']

/** Today's behaviour: Haiku, then GPT-6 Luna through Codex. Must match DEFAULT_CONFIG in src/capacity.ts. */
export const DEFAULT_SETTINGS               = {
  writers: [
    { provider: 'claude', model: 'haiku', enabled: true },
    { provider: 'codex', model: 'gpt-6-luna', enabled: true },
    { provider: 'antigravity', model: 'gemini-3.8-flash-low', enabled: false }
  ],
  messageFormat: 'off',
  marginGB: 2,
  warnHeadroomGB: 2,
  linearDryRun: false,
  routing: DEFAULT_ROUTING,
  features: { bots: false, goals: false, linear: true, tokenSpeed: true, hosts: false }
}
export const SETTINGS_KEYS                         = ['writers', 'messageFormat', 'marginGB', 'warnHeadroomGB', 'linearDryRun', 'routing', 'features']

export const same = (a         , b         )          => JSON.stringify(a) === JSON.stringify(b)
const clone =    (v   )    => JSON.parse(JSON.stringify(v))
const isObject = (v         )                               => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The writers list, in order, each provider once. A provider the list leaves out is off, and goes last.
 * An unknown model falls back to the provider's default; a writer Orca Flow cannot run is off.
 * Not a list, or no usable entry: today's default, so a typo never stops cards.
 */
export function normalizeWriters(value         )                  {
  if (!Array.isArray(value)) return clone(DEFAULT_SETTINGS.writers)
  const out                  = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const provider = entry.provider
    if (!WRITER_PROVIDERS.includes(provider) || out.some((w) => w.provider === provider)) continue
    out.push(writer(provider, entry.model, entry.enabled !== false))
  }
  if (!out.length) return clone(DEFAULT_SETTINGS.writers)
  for (const provider of WRITER_PROVIDERS) if (!out.some((w) => w.provider === provider)) out.push(writer(provider, undefined, false))
  return out
}

function writer(provider                , model         , enabled         )                {
  const models = WRITER_MODELS[provider]
  const on = enabled && WRITABLE.includes(provider)
  // Key order is fixed (provider, model, enabled): `same` compares by JSON.
  return models.length ? { provider, model: models.includes(model          ) ? (model          ) : models[0], enabled: on } : { provider, enabled: on }
}

export function normalizeFormat(value         )                {
  if (value === 'all') return 'all'
  if (Array.isArray(value)) return value.filter((p)              => typeof p === 'string' && !!p.trim()).map((p) => p.trim())
  return 'off'
}

/** The feature switches. Bots, Goals and Paired hosts are off unless exactly true; Linear and Analytics are shown today, so they are on unless exactly false (Analytics is stored as `tokenSpeed`, its name before 0.2.87, so older files keep working). An older or broken file changes nothing on screen. */
export function normalizeFeatures(value         )                  {
  const f = isObject(value) ? value : {}
  return { bots: f.bots === true, goals: f.goals === true, linear: f.linear !== false, tokenSpeed: f.tokenSpeed !== false, hosts: f.hosts === true }
}

const gb = (value         , fallback        ) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)

/** What a config object means, every key filled in; a missing or unusable value reads as its default. */
export function normalizeSettings(raw         )               {
  const c = isObject(raw) ? raw : {}
  return {
    writers: normalizeWriters(c.writers),
    messageFormat: normalizeFormat(c.messageFormat),
    marginGB: gb(c.marginGB, DEFAULT_SETTINGS.marginGB),
    warnHeadroomGB: gb(c.warnHeadroomGB, DEFAULT_SETTINGS.warnHeadroomGB),
    linearDryRun: c.linearDryRun === true,
    routing: normalizeRouting(c.routing),
    features: normalizeFeatures(c.features)
  }
}

/**
 * The config object after saving `next`: only the keys whose meaning changed are touched. A key set
 * back to its default is removed; a key never changed stays as written; unknown keys are kept.
 */
export function applySettings(raw                         , next              )                          {
  const now = normalizeSettings(raw)
  const want = normalizeSettings(next)
  const out                          = { ...raw }
  for (const key of SETTINGS_KEYS) {
    if (same(now[key], want[key])) continue
    if (same(want[key], DEFAULT_SETTINGS[key])) delete out[key]
    else out[key] = clone(want[key])
  }
  return out
}

// ---------- saving from a dialog opened before another change ----------

/** `want` where the dialog changed it (it differs from `base`), else what the file holds now. */
const pick =    (current   , base   , want   )    => (same(want, base) ? current : clone(want))

/** Entries by id: only those the dialog added, edited or removed (against `base`) are applied over `current`. */
function mergeById                          (current     , base     , want     )      {
  if (same(want, base)) return current
  const was = new Map(base.map((x) => [x.id, x]))
  const keep = new Set(want.map((x) => x.id))
  const out = current.filter((x) => !(was.has(x.id) && !keep.has(x.id)))
  for (const w of want) {
    const b = was.get(w.id)
    if (b && same(w, b)) continue
    const at = out.findIndex((x) => x.id === w.id)
    if (at >= 0) out[at] = clone(w)
    else out.push(clone(w))
  }
  return out
}

/** Routing three ways: the coordinator, the lead, each worker row, each task type and each saved preset are separate. */
function mergeRouting(current                 , base                 , want                 )                  {
  const workers = { ...current.workers }
  for (const kind of Object.keys(workers)                                        ) workers[kind] = pick(current.workers[kind], base.workers[kind], want.workers[kind])
  return {
    coordinator: pick(current.coordinator, base.coordinator, want.coordinator),
    lead: pick(current.lead, base.lead, want.lead),
    workers,
    types: mergeById(current.types, base.types, want.types),
    presets: mergeById(current.presets, base.presets, want.presets)
  }
}

/**
 * What a dialog's save should leave in the file when the dialog was opened (or last saved) with
 * `base` and the file holds `current` now, because another window or a hand edit changed it since:
 * only what the user changed in the dialog (`want` against `base`) is applied; every other setting
 * keeps the file's value. A setting both changed is the dialog's (last writer wins).
 */
export function mergeSettings(current              , base              , want              )               {
  const [c, b, w] = [current, base, want].map(normalizeSettings)
  const features = { ...c.features }
  for (const k of Object.keys(features)                             ) features[k] = pick(c.features[k], b.features[k], w.features[k])
  return normalizeSettings({
    writers: pick(c.writers, b.writers, w.writers),
    messageFormat: pick(c.messageFormat, b.messageFormat, w.messageFormat),
    marginGB: pick(c.marginGB, b.marginGB, w.marginGB),
    warnHeadroomGB: pick(c.warnHeadroomGB, b.warnHeadroomGB, w.warnHeadroomGB),
    linearDryRun: pick(c.linearDryRun, b.linearDryRun, w.linearDryRun),
    routing: mergeRouting(c.routing, b.routing, w.routing),
    features
  })
}

/** The settings to write for one save: merged over the file when the dialog says what it started from, else exactly `want`. */
export const settingsToSave = (current              , base                          , want              )               =>
  base ? mergeSettings(current, base, want) : normalizeSettings(want)

// ---------- the dialog's draft ----------


/** The dialog's working copy, one field per control, so each page can count and reset its own changes. */

















export const DEFAULT_FOLDERS = ['~/orca/coordinators']
/** What the dialog shows for a writer without a model choice. */
export const AGY_DEFAULT_MODEL = 'agy-default'

export function toDraft(s              )        {
  const writers = normalizeWriters(s.writers)
  const enabled = {}
  const models = {}
  for (const w of writers) {
    enabled[w.provider] = w.enabled
    models[w.provider] = w.model ?? AGY_DEFAULT_MODEL
  }
  const format = normalizeFormat(s.messageFormat)
  return {
    writers: writers.map((w) => w.provider), enabled, models,
    format: Array.isArray(format) ? 'folders' : format,
    folders: Array.isArray(format) ? format : [...DEFAULT_FOLDERS],
    marginGB: s.marginGB, warnHeadroomGB: s.warnHeadroomGB, linearDryRun: s.linearDryRun, routing: clone(normalizeRouting(s.routing)), ...normalizeFeatures(s.features)
  }
}

export function fromDraft(d       )               {
  return normalizeSettings({
    writers: d.writers.map((provider) => ({ provider, ...(WRITER_MODELS[provider].length ? { model: d.models[provider] } : {}), enabled: d.enabled[provider] })),
    messageFormat: d.format === 'folders' ? d.folders : d.format,
    marginGB: d.marginGB, warnHeadroomGB: d.warnHeadroomGB, linearDryRun: d.linearDryRun, routing: d.routing, features: { bots: d.bots, goals: d.goals, linear: d.linear, tokenSpeed: d.tokenSpeed, hosts: d.hosts }
  })
}

export const DEFAULT_DRAFT        = toDraft(DEFAULT_SETTINGS)
export const DRAFT_KEYS = Object.keys(DEFAULT_DRAFT)


// ---------- writer status ----------

/** What the worker knows of one writer: what it last saw, and whether Orca lists its CLI. No test calls. */












const FAILURE                                                             = {
  quota: { tone: 'warn', text: 'Usage limit' },
  auth: { tone: 'bad', text: 'Not signed in' },
  unavailable: { tone: 'bad', text: 'Unavailable' },
  timeout: { tone: 'warn', text: 'Timed out' },
  transient: { tone: 'warn', text: 'Temporary error' }
}
const NAME                                 = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }

export function ago(ms        )         {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  return h < 48 ? 'yesterday' : `${Math.floor(h / 24)} days ago`
}

/** How the dialog shows a writer's status. `usable` says whether the next card would try it. */
export function statusView(s                          , provider                , now        )             {
  if (!WRITABLE.includes(provider)) return { tone: 'idle', text: 'Not available yet', sub: `Orca Flow can’t write cards with the ${NAME[provider]} CLI yet`, usable: false }
  if (s?.failure) {
    const f = FAILURE[s.failure.kind] ?? { tone: 'bad'         , text: 'Failed' }
    const left = s.failure.until - now
    if (left > 0) {
      const wait = left >= 60_000 ? `${Math.ceil(left / 60_000)} more min` : `${Math.ceil(left / 1000)} more s`
      return { ...f, sub: `Skipped for ${wait}, then tried again`, usable: false }
    }
    return { ...f, sub: 'Tried again at the next card', usable: true }
  }
  if (s?.lastSuccessAt) return { tone: 'ok', text: 'Ready', sub: `Last card ${ago(now - s.lastSuccessAt)}`, usable: true }
  if (s?.installed === false) return { tone: 'bad', text: 'Not installed', sub: `Orca doesn’t see the ${NAME[provider]} CLI`, usable: false }
  if (s?.installed === true) return { tone: 'ok', text: 'Installed', sub: 'No cards from it since Orca Flow started', usable: true }
  return { tone: 'idle', text: 'Not used yet', sub: 'No cards from it since Orca Flow started', usable: true }
}

// ---------- instant save ----------

/** What one save answered: the settings now in the file, or why nothing was written. */


/**
 * The dialog's state with changes applied at once, as System Settings does: each change shows
 * immediately and is saved; while a save is in flight, later changes wait and go in one more save.
 * A failed save puts every control back to what the file holds and keeps the error. Each save also
 * says what the dialog started from (`base`), so the worker applies only what changed here.
 */
export function settingsSession(save                                                                    , onUpdate             = () => {}) {
  const s = { saved: clone(DEFAULT_DRAFT), shown: clone(DEFAULT_DRAFT), error: null                  }
  let saving                       = null
  let again = false
  /** The folder list is kept while another choice is on, though only "Some folders" saves it. */
  const keepFolders = (d       , from       ) => (d.format === 'folders' ? d : { ...d, folders: [...from.folders] })
  const run = async () => {
    do {
      again = false
      const want = fromDraft(s.shown)
      const base = fromDraft(s.saved)
      if (same(want, base)) break
      let reply
      try { reply = await save(want, base) } catch (e) { reply = { ok: false, error: (e         ).message } }
      if (reply.ok && reply.settings) {
        s.saved = keepFolders(toDraft(reply.settings), s.shown)
        s.error = null
        // Changes made while this save ran go on top of what the file holds now, which may include another window's.
        s.shown = again ? keepFolders(toDraft(mergeSettings(reply.settings, want, fromDraft(s.shown))), s.shown) : clone(s.saved)
      } else {
        s.shown = clone(s.saved)
        s.error = reply.error ?? 'The settings could not be saved.'
        again = false
      }
      onUpdate()
    } while (again)
  }
  const flush = ()                => {
    if (saving) { again = true; return saving }
    saving = run().finally(() => { saving = null })
    return saving
  }
  return {
    get saved() { return s.saved },
    get shown() { return s.shown },
    get error() { return s.error },
    /** The file's settings, as the dialog opens. */
    load(settings              ) { s.saved = toDraft(settings); s.shown = clone(s.saved); s.error = null },
    /** Applies a change to the controls and saves it. */
    change(mutate                    )                {
      mutate(s.shown)
      s.error = null
      onUpdate()
      return flush()
    },
    /** Puts some controls back to their defaults, in one save. */
    reset(keys                     )                {
      return this.change((d) => { for (const k of keys) (d                           )[k] = clone(DEFAULT_DRAFT[k]) })
    },
    isDefault: (keys                     ) => keys.every((k) => same(s.shown[k], DEFAULT_DRAFT[k]))
  }
}
// Generated by scripts/build-frames.mjs from the .ts file of the same name. Do not edit.
