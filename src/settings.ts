// The user's settings as ~/.orca-flow/config.json holds them, and as the Settings dialog edits them.
// Pure: the worker reads and writes the file (src/config.ts), the panel draws and edits (src/panel/settings.ts).
// Existing keys keep their names and meaning; their readers are src/worker.ts, src/capacity.ts,
// skills/orca-flow/scripts/stop-check.mjs and skills/orca-flow/scripts/orca-flow.mjs.

export type WriterProvider = 'claude' | 'codex' | 'antigravity'
/** One writer in `writers`, tried in list order. `model` is absent for a writer without a choice. */
export type WriterSetting = { provider: WriterProvider; model?: string; enabled: boolean }
/** Absent or "off": no check; "all": every coordinator and lead; a list: agents working under those folders. */
export type MessageFormat = 'off' | 'all' | string[]
export type FlowSettings = { writers: WriterSetting[]; messageFormat: MessageFormat; marginGB: number; warnHeadroomGB: number; linearDryRun: boolean }
export type SettingsKey = keyof FlowSettings

export const WRITER_PROVIDERS: readonly WriterProvider[] = ['claude', 'codex', 'antigravity']
/** The models each CLI accepts by name, the default first. */
export const WRITER_MODELS: Record<WriterProvider, readonly string[]> = { claude: ['haiku', 'sonnet'], codex: ['gpt-6-luna'], antigravity: ['gemini-3.8-flash-low'] }
/**
 * Writers Orca Flow can run. Antigravity runs in an isolated temporary workspace with a `tools: []`
 * custom agent, `inheritCustomizations: false`, `inheritMcp: false`, strict deny rules, and stdin
 * `stream-json` input.
 */
export const WRITABLE: readonly WriterProvider[] = ['claude', 'codex', 'antigravity']

/** Today's behaviour: Haiku, then GPT-6 Luna through Codex. Must match DEFAULT_CONFIG in src/capacity.ts. */
export const DEFAULT_SETTINGS: FlowSettings = {
  writers: [
    { provider: 'claude', model: 'haiku', enabled: true },
    { provider: 'codex', model: 'gpt-6-luna', enabled: true },
    { provider: 'antigravity', model: 'gemini-3.8-flash-low', enabled: false }
  ],
  messageFormat: 'off',
  marginGB: 2,
  warnHeadroomGB: 2,
  linearDryRun: false
}
export const SETTINGS_KEYS: readonly SettingsKey[] = ['writers', 'messageFormat', 'marginGB', 'warnHeadroomGB', 'linearDryRun']

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The writers list, in order, each provider once. A provider the list leaves out is off, and goes last.
 * An unknown model falls back to the provider's default; a writer Orca Flow cannot run is off.
 * Not a list, or no usable entry: today's default, so a typo never stops cards.
 */
export function normalizeWriters(value: unknown): WriterSetting[] {
  if (!Array.isArray(value)) return clone(DEFAULT_SETTINGS.writers)
  const out: WriterSetting[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const provider = entry.provider as WriterProvider
    if (!WRITER_PROVIDERS.includes(provider) || out.some((w) => w.provider === provider)) continue
    out.push(writer(provider, entry.model, entry.enabled !== false))
  }
  if (!out.length) return clone(DEFAULT_SETTINGS.writers)
  for (const provider of WRITER_PROVIDERS) if (!out.some((w) => w.provider === provider)) out.push(writer(provider, undefined, false))
  return out
}

function writer(provider: WriterProvider, model: unknown, enabled: boolean): WriterSetting {
  const models = WRITER_MODELS[provider]
  const on = enabled && WRITABLE.includes(provider)
  // Key order is fixed (provider, model, enabled): `same` compares by JSON.
  return models.length ? { provider, model: models.includes(model as string) ? (model as string) : models[0], enabled: on } : { provider, enabled: on }
}

export function normalizeFormat(value: unknown): MessageFormat {
  if (value === 'all') return 'all'
  if (Array.isArray(value)) return value.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim())
  return 'off'
}

const gb = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)

/** What a config object means, every key filled in; a missing or unusable value reads as its default. */
export function normalizeSettings(raw: unknown): FlowSettings {
  const c = isObject(raw) ? raw : {}
  return {
    writers: normalizeWriters(c.writers),
    messageFormat: normalizeFormat(c.messageFormat),
    marginGB: gb(c.marginGB, DEFAULT_SETTINGS.marginGB),
    warnHeadroomGB: gb(c.warnHeadroomGB, DEFAULT_SETTINGS.warnHeadroomGB),
    linearDryRun: c.linearDryRun === true
  }
}

/**
 * The config object after saving `next`: only the keys whose meaning changed are touched. A key set
 * back to its default is removed; a key never changed stays as written; unknown keys are kept.
 */
export function applySettings(raw: Record<string, unknown>, next: FlowSettings): Record<string, unknown> {
  const now = normalizeSettings(raw)
  const want = normalizeSettings(next)
  const out: Record<string, unknown> = { ...raw }
  for (const key of SETTINGS_KEYS) {
    if (same(now[key], want[key])) continue
    if (same(want[key], DEFAULT_SETTINGS[key])) delete out[key]
    else out[key] = clone(want[key])
  }
  return out
}

// ---------- the dialog's draft ----------

export type FormatChoice = 'off' | 'all' | 'folders'
/** The dialog's working copy, one field per control, so each page can count and reset its own changes. */
export type Draft = {
  writers: WriterProvider[]
  enabled: Record<WriterProvider, boolean>
  models: Record<WriterProvider, string>
  format: FormatChoice
  folders: string[]
  marginGB: number
  warnHeadroomGB: number
  linearDryRun: boolean
}
export type DraftKey = keyof Draft
export const DEFAULT_FOLDERS = ['~/orca/coordinators']
/** Antigravity has no model choice; the dialog shows the CLI's own. */
export const AGY_DEFAULT_MODEL = 'agy-default'

export function toDraft(s: FlowSettings): Draft {
  const writers = normalizeWriters(s.writers)
  const enabled = {} as Record<WriterProvider, boolean>
  const models = {} as Record<WriterProvider, string>
  for (const w of writers) {
    enabled[w.provider] = w.enabled
    models[w.provider] = w.model ?? AGY_DEFAULT_MODEL
  }
  const format = normalizeFormat(s.messageFormat)
  return {
    writers: writers.map((w) => w.provider), enabled, models,
    format: Array.isArray(format) ? 'folders' : format,
    folders: Array.isArray(format) ? format : [...DEFAULT_FOLDERS],
    marginGB: s.marginGB, warnHeadroomGB: s.warnHeadroomGB, linearDryRun: s.linearDryRun
  }
}

export function fromDraft(d: Draft): FlowSettings {
  return normalizeSettings({
    writers: d.writers.map((provider) => ({ provider, ...(WRITER_MODELS[provider].length ? { model: d.models[provider] } : {}), enabled: d.enabled[provider] })),
    messageFormat: d.format === 'folders' ? d.folders : d.format,
    marginGB: d.marginGB, warnHeadroomGB: d.warnHeadroomGB, linearDryRun: d.linearDryRun
  })
}

export const DEFAULT_DRAFT: Draft = toDraft(DEFAULT_SETTINGS)
export const DRAFT_KEYS = Object.keys(DEFAULT_DRAFT) as DraftKey[]


// ---------- writer status ----------

/** What the worker knows of one writer: what it last saw, and whether Orca lists its CLI. No test calls. */
export type WriterStatus = {
  provider: WriterProvider
  /** When it last wrote a card in this worker, ms; null when it has not since the worker started. */
  lastSuccessAt: number | null
  /** Its last failure and when its cooldown ends (may be past: it is tried again at the next card). */
  failure: { kind: string; until: number } | null
  /** Whether `orca agent installed` lists its CLI; null when unknown. */
  installed: boolean | null
}

export type StatusView = { tone: 'ok' | 'warn' | 'bad' | 'idle'; text: string; sub: string; usable: boolean }

const FAILURE: Record<string, { tone: StatusView['tone']; text: string }> = {
  quota: { tone: 'warn', text: 'Usage limit' },
  auth: { tone: 'bad', text: 'Not signed in' },
  unavailable: { tone: 'bad', text: 'Unavailable' },
  timeout: { tone: 'warn', text: 'Timed out' },
  transient: { tone: 'warn', text: 'Temporary error' }
}
const NAME: Record<WriterProvider, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }

export function ago(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  return h < 48 ? 'yesterday' : `${Math.floor(h / 24)} days ago`
}

/** How the dialog shows a writer's status. `usable` says whether the next card would try it. */
export function statusView(s: WriterStatus | undefined, provider: WriterProvider, now: number): StatusView {
  if (!WRITABLE.includes(provider)) return { tone: 'idle', text: 'Not available yet', sub: `Orca Flow can’t write cards with the ${NAME[provider]} CLI yet`, usable: false }
  if (s?.failure) {
    const f = FAILURE[s.failure.kind] ?? { tone: 'bad' as const, text: 'Failed' }
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
export type SaveReply = { ok: boolean; error?: string; settings?: FlowSettings }

/**
 * The dialog's state with changes applied at once, as System Settings does: each change shows
 * immediately and is saved; while a save is in flight, later changes wait and go in one more save.
 * A failed save puts every control back to what the file holds and keeps the error.
 */
export function settingsSession(save: (settings: FlowSettings) => Promise<SaveReply>, onUpdate: () => void = () => {}) {
  const s = { saved: clone(DEFAULT_DRAFT), shown: clone(DEFAULT_DRAFT), error: null as string | null }
  let saving: Promise<void> | null = null
  let again = false
  /** The folder list is kept while another choice is on, though only "Some folders" saves it. */
  const keepFolders = (d: Draft, from: Draft) => (d.format === 'folders' ? d : { ...d, folders: [...from.folders] })
  const run = async () => {
    do {
      again = false
      const want = fromDraft(s.shown)
      if (same(want, fromDraft(s.saved))) break
      let reply: SaveReply
      try { reply = await save(want) } catch (e) { reply = { ok: false, error: (e as Error).message } }
      if (reply.ok && reply.settings) {
        s.saved = keepFolders(toDraft(reply.settings), s.shown)
        s.error = null
        if (!again) s.shown = clone(s.saved)
      } else {
        s.shown = clone(s.saved)
        s.error = reply.error ?? 'The settings could not be saved.'
        again = false
      }
      onUpdate()
    } while (again)
  }
  const flush = (): Promise<void> => {
    if (saving) { again = true; return saving }
    saving = run().finally(() => { saving = null })
    return saving
  }
  return {
    get saved() { return s.saved },
    get shown() { return s.shown },
    get error() { return s.error },
    /** The file's settings, as the dialog opens. */
    load(settings: FlowSettings) { s.saved = toDraft(settings); s.shown = clone(s.saved); s.error = null },
    /** Applies a change to the controls and saves it. */
    change(mutate: (d: Draft) => void): Promise<void> {
      mutate(s.shown)
      s.error = null
      onUpdate()
      return flush()
    },
    /** Puts some controls back to their defaults, in one save. */
    reset(keys: readonly DraftKey[]): Promise<void> {
      return this.change((d) => { for (const k of keys) (d as Record<string, unknown>)[k] = clone(DEFAULT_DRAFT[k]) })
    },
    isDefault: (keys: readonly DraftKey[]) => keys.every((k) => same(s.shown[k], DEFAULT_DRAFT[k]))
  }
}
