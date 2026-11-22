// Model routing: which agent, model and effort a coordinator, lead or worker starts with.
// Pure and deterministic: the same settings, request and availability always give the same
// decision and the same one-line reason. Shared by the plugin worker (coordinator launches,
// Settings → Models) and skills/orca-flow/scripts/orca-flow.mjs (`route`, `dispatch`, `plan`).
//
// The model: whoever splits the work says what kind each worker task is (simple, normal, hard);
// the user picks a model, an effort and one fallback per kind in Settings → Models. Presets set
// the coordinator, lead and all three kinds in one step. Honest limits, kept in the words this
// module writes:
// - The built-in presets are editable starting points, not claims of quality or price.
// - Availability is what this machine can verify: `orca agent installed` for agents, the Codex
//   CLI's own catalog (`codex debug models`) and Claude Code's `list_models` control request for
//   model ids. When a catalog cannot be read, a Claude alias (haiku, sonnet, opus, fable) or a full
//   `claude-*` id is accepted unverified.
// - Efforts: only an effort the provider reports AND Orca accepts at launch (ORCA_LAUNCH_EFFORTS)
//   is ever passed. When none is left (Claude Haiku), the launch carries no --effort.
// - A decision only applies to a new launch. Running sessions and resumed conversations keep
//   their model; nothing here relaunches anything.
//
// CONTRACT: the exported names and types below are the interface other modules build against.
// Change a signature only together with its callers.

export type Role = 'coordinator' | 'lead' | 'worker'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/**
 * How demanding a worker task is, set by whoever splits the work:
 * - simple: mechanical, one or two files, obvious result (rename, copy change, config value).
 * - normal: a bounded change with tests.
 * - hard: cross-cutting design, hard debugging, concurrency, migrations or security.
 */
export type TaskKind = 'simple' | 'normal' | 'hard'
/** high: a mistake is costly (production data, money, security, release); one kind up. */
export type Risk = 'low' | 'high'
/** large: the task must read much code or long documents; at least normal. */
export type ContextSize = 'normal' | 'large'

/** What a launch passes. No `model`: the provider's own default (Orca passes no --model). */
export type ModelChoice = { agent: string; model?: string; effort?: Effort }

/** One kind's row: the model it starts on (always with a model id) and the one model used when that is unavailable. */
export type KindRoute = { model: ModelChoice; fallback: ModelChoice | null }
export type Workers = Record<TaskKind, KindRoute>

/** A named Models configuration. Built-ins are fixed starting points; saved ones are the user's. */
export type Preset = { id: string; name: string; builtIn: boolean; coordinator: ModelChoice | null; lead: ModelChoice | null; workers: Workers }

export type RoutingSettings = {
  /** null: no model is passed and the provider default applies (Orca Flow 0.2.77 behaviour). */
  coordinator: ModelChoice | null
  lead: ModelChoice | null
  /** The model each kind of worker task starts on. */
  workers: Workers
  /** Workers one lead runs at once (1-6), before the memory gate is even asked. */
  maxParallel: number
  /** How many times a failed task may move up one kind (0-2). */
  maxEscalations: number
  /** The user's saved presets only (builtIn false), at most MAX_SAVED_PRESETS. */
  presets: Preset[]
}

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const TASK_KINDS: readonly TaskKind[] = ['simple', 'normal', 'hard']
/** The names an older plan file or command line used for the kinds (`class`, `--class`). */
export const KIND_ALIASES: Record<string, TaskKind> = { trivial: 'simple', standard: 'normal', complex: 'hard' }
/** A kind from its name or an old class name; undefined for anything else. */
export const taskKind = (v: unknown): TaskKind | undefined =>
  typeof v !== 'string' ? undefined : (TASK_KINDS as readonly string[]).includes(v) ? (v as TaskKind) : KIND_ALIASES[v]
/** Claude Code's model aliases (`claude --help`: "an alias for the latest model"). */
export const CLAUDE_ALIASES: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable']
export const MAX_SAVED_PRESETS = 10

const claude = (model: string, effort?: Effort): ModelChoice => ({ agent: 'claude', model, ...(effort ? { effort } : {}) })
const builtIn = (id: string, name: string, workers: Workers): Preset => ({ id, name, builtIn: true, coordinator: null, lead: null, workers })

/**
 * Editable starting points; coordinator and lead keep the provider default in all three. Haiku
 * carries no effort: Orca refuses --effort for the haiku alias. Each fallback is a different model.
 */
export const BUILT_IN_PRESETS: Preset[] = [
  builtIn('balanced', 'Balanced', {
    simple: { model: claude('haiku'), fallback: claude('sonnet', 'low') },
    normal: { model: claude('sonnet', 'medium'), fallback: claude('opus', 'medium') },
    hard: { model: claude('opus', 'high'), fallback: null }
  }),
  builtIn('economy', 'Economy', {
    simple: { model: claude('haiku'), fallback: claude('sonnet', 'low') },
    normal: { model: claude('sonnet', 'low'), fallback: claude('opus', 'low') },
    hard: { model: claude('sonnet', 'high'), fallback: claude('opus', 'high') }
  }),
  builtIn('best', 'Best quality', {
    simple: { model: claude('sonnet', 'low'), fallback: claude('opus', 'low') },
    normal: { model: claude('opus', 'medium'), fallback: claude('sonnet', 'high') },
    hard: { model: claude('fable', 'high'), fallback: claude('opus', 'xhigh') }
  })
]
const BALANCED = BUILT_IN_PRESETS[0]

/** Balanced, 3 workers at once, one escalation, no saved presets. */
export const DEFAULT_ROUTING: RoutingSettings = {
  coordinator: null,
  lead: null,
  workers: BALANCED.workers,
  maxParallel: 3,
  maxEscalations: 1,
  presets: []
}

/**
 * The efforts Orca accepts at launch (`--effort` of `orca orchestration worker-start` and
 * `orca agent launch`), per agent and model. Orca checks --effort against its OWN static catalog,
 * not what the provider reports, so a provider-reported effort Orca refuses must never be passed.
 * Source: Orca 1.4.263, out/shared/agent-session/options/catalog-providers/
 * agent-session-option-catalog-claude-codex.js (seed models and `unknownModelOptions`), checked by
 * out/shared/agent-launch/choices/agent-launch-model-preferences.js. Re-check on an Orca update.
 * Codex's `minimal` and `ultra` are Orca-valid but outside `Effort`, so they are not listed.
 * An empty list: the model has no effort option, and Orca refuses any --effort for it.
 */
export const ORCA_LAUNCH_EFFORTS: Record<string, { models: Record<string, readonly Effort[]>; unknown: readonly Effort[] }> = {
  claude: {
    models: { fable: EFFORTS, opus: EFFORTS, sonnet: EFFORTS, haiku: [] },
    unknown: EFFORTS // full claude-* ids: unknownModelOptions, low..max
  },
  codex: {
    models: {
      'gpt-5.6-sol': EFFORTS, 'gpt-5.6-terra': EFFORTS, 'gpt-5.6-luna': EFFORTS,
      'gpt-5.5': ['low', 'medium', 'high', 'xhigh'], 'gpt-5.2-codex': ['low', 'medium', 'high', 'xhigh']
    },
    unknown: EFFORTS // unknown ids: minimal..ultra, of which Effort covers low..max
  }
}
/** What Orca accepts for this model, or null for an agent not in the table (not checked). */
export function orcaLaunchEfforts(agent: string, model: string): readonly Effort[] | null {
  const t = ORCA_LAUNCH_EFFORTS[agent]
  return t ? (t.models[model] ?? t.unknown) : null
}

/** One discovered model: its id and, when the provider says, the efforts it takes. */
export type ModelInfo = { id: string; label?: string; efforts?: Effort[] }
/**
 * What this machine can verify. `agents`: installed agent ids, null when unknown (then not
 * checked). `models[agent]`: that agent's model catalog; absent or null when it cannot be listed
 * (then any id is accepted unverified, except Claude, which accepts aliases and `claude-*` ids).
 */
export type Availability = { agents: string[] | null; models: Record<string, ModelInfo[] | null> }

export type RouteRequest = {
  role: Role
  /** Workers; default normal. */
  kind?: TaskKind
  risk?: Risk
  context?: ContextSize
  /** 0 on the first try; n after n demonstrated failures of this task. */
  attempt?: number
  /** Explicit per-task choices; they win over every setting and are never swapped silently. */
  agent?: string
  model?: string
  effort?: Effort
}

/** A model passed over, and why (`route --explain`). */
export type Skip = { model: string; why: string }
export type RouteDecision =
  | {
      ok: true
      choice: ModelChoice
      /** override: the task's own flags; role: Settings' coordinator or lead pick; kind: the worker row's
       *  model; fallback: that row's fallback; default: provider default (nothing set, or a pick unavailable). */
      source: 'override' | 'role' | 'kind' | 'fallback' | 'default'
      /** Workers routed by kind: the row used (after risk, context and escalation) and its settings. */
      row?: { kind: TaskKind; route: KindRoute }
      /** One plain line for people: "normal task → Claude Sonnet · medium". */
      reason: string
      skipped: Skip[]
    }
  | { ok: false; error: string; skipped: Skip[] }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback

function normalizeChoice(v: unknown): ModelChoice | null {
  if (!isObject(v)) return null
  const agent = text(v.agent)
  if (!agent) return null
  const model = text(v.model)
  // Key order is fixed (agent, model, effort): `same` compares by JSON. Orca takes an effort only with a model.
  return model ? { agent, model, ...(isEffort(v.effort) ? { effort: v.effort } : {}) } : { agent }
}
/** A choice that names a model, or null. */
const withModel = (v: unknown): ModelChoice | null => {
  const c = normalizeChoice(v)
  return c?.model ? c : null
}

/** A row, or null when its model is unusable. A fallback without a model reads as none. */
function normalizeRow(v: unknown): KindRoute | null {
  if (!isObject(v)) return null
  const model = withModel(v.model)
  return model ? { model, fallback: withModel(v.fallback) } : null
}

/** All three rows; a bad or missing one is Balanced's row of that kind. With `strict`, a bad row gives null. */
function normalizeWorkers(v: unknown, strict = false): Workers | null {
  const raw = isObject(v) ? v : {}
  const out = {} as Workers
  for (const kind of TASK_KINDS) {
    const row = normalizeRow(raw[kind])
    if (!row && strict) return null
    out[kind] = row ?? clone(BALANCED.workers[kind])
  }
  return out
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
/** A saved-preset id no other preset in `taken` has: the name's slug, then slug-2, slug-3 ... (names with no ASCII letters share "preset"). */
function savedId(name: string, taken: readonly string[]): string {
  const base = `saved:${slug(name) || 'preset'}`
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const isBuiltInName = (name: string) => BUILT_IN_PRESETS.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())

function normalizePreset(v: unknown, taken: readonly string[]): Preset | null {
  if (!isObject(v)) return null
  const name = text(v.name)
  if (!name || isBuiltInName(name)) return null
  const workers = normalizeWorkers(v.workers, true)
  if (!workers) return null
  const stored = text(v.id)
  const id = stored && /^saved:.+/.test(stored) && !taken.includes(stored) ? stored : savedId(name, taken)
  return { id, name, builtIn: false, coordinator: normalizeChoice(v.coordinator), lead: normalizeChoice(v.lead), workers }
}

/**
 * Every field filled and clamped, in a fixed key order (settings `same` compares JSON). Unknown
 * agent ids are allowed. A bad worker row is Balanced's row of that kind; a bad saved preset is
 * dropped, a second one with the same id too, and only the first MAX_SAVED_PRESETS are kept.
 * Not an object: DEFAULT_ROUTING (a copy).
 */
export function normalizeRouting(raw: unknown): RoutingSettings {
  if (!isObject(raw)) return clone(DEFAULT_ROUTING)
  const presets: Preset[] = []
  for (const entry of Array.isArray(raw.presets) ? raw.presets : []) {
    const p = normalizePreset(entry, presets.map((o) => o.id))
    if (p && !presets.some((o) => sameName(o.name, p.name)) && presets.length < MAX_SAVED_PRESETS) presets.push(p)
  }
  return {
    coordinator: normalizeChoice(raw.coordinator),
    lead: normalizeChoice(raw.lead),
    workers: normalizeWorkers(raw.workers) as Workers,
    maxParallel: clampInt(raw.maxParallel, 1, 6, DEFAULT_ROUTING.maxParallel),
    maxEscalations: clampInt(raw.maxEscalations, 0, 2, DEFAULT_ROUTING.maxEscalations),
    presets
  }
}

// ---------- presets ----------

/** The built-in presets, then the user's saved ones. */
export function presetsOf(s: RoutingSettings): Preset[] {
  return [...clone(BUILT_IN_PRESETS), ...clone(normalizeRouting(s).presets)]
}

/** The preset whose coordinator, lead and workers equal these settings; null means "Custom". */
export function matchingPreset(s: RoutingSettings): Preset | null {
  const n = normalizeRouting(s)
  return presetsOf(n).find((p) => same(p.coordinator, n.coordinator) && same(p.lead, n.lead) && same(p.workers, n.workers)) ?? null
}

/** The settings with a preset's coordinator, lead and workers; the limits and saved presets stay. */
export function applyPreset(s: RoutingSettings, id: string): RoutingSettings {
  const n = normalizeRouting(s)
  const p = presetsOf(n).find((x) => x.id === id)
  if (!p) throw new Error(`No preset ${id}.`)
  return { ...n, coordinator: p.coordinator, lead: p.lead, workers: p.workers }
}

/**
 * Saves the current coordinator, lead and workers under `name`. The same name replaces that
 * preset in place. An empty name, a built-in's name, or an 11th preset is refused (throws).
 */
export function savePreset(s: RoutingSettings, name: string): RoutingSettings {
  const n = normalizeRouting(s)
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A preset needs a name.')
  if (isBuiltInName(trimmed)) throw new Error(`"${trimmed}" is a built-in preset: choose another name.`)
  const at = n.presets.findIndex((p) => sameName(p.name, trimmed))
  const id = at < 0 ? savedId(trimmed, n.presets.map((p) => p.id)) : n.presets[at].id
  const preset: Preset = { id, name: trimmed, builtIn: false, coordinator: n.coordinator, lead: n.lead, workers: n.workers }
  if (at < 0 && n.presets.length >= MAX_SAVED_PRESETS) throw new Error(`At most ${MAX_SAVED_PRESETS} saved presets: delete one first.`)
  const presets = at < 0 ? [...n.presets, preset] : n.presets.map((p, i) => (i === at ? preset : p))
  return { ...n, presets: clone(presets) }
}

/** Removes a saved preset; a built-in one cannot be deleted (throws). An unknown id changes nothing. */
export function deletePreset(s: RoutingSettings, id: string): RoutingSettings {
  if (BUILT_IN_PRESETS.some((p) => p.id === id)) throw new Error('Built-in presets cannot be deleted.')
  const n = normalizeRouting(s)
  return { ...n, presets: n.presets.filter((p) => p.id !== id) }
}

// ---------- labels and launch flags ----------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const isClaudeModel = (m: string) => CLAUDE_ALIASES.includes(m) || /^claude-/.test(m)

/** A short label for people: "Claude Sonnet · medium", "Codex gpt-6-luna · low", "Claude (default model)". */
export function choiceLabel(choice: ModelChoice): string {
  const agent = cap(choice.agent)
  if (!choice.model) return `${agent} (default model)`
  return `${agent} ${modelName(choice)}${choice.effort ? ` · ${choice.effort}` : ''}`
}
/** "Haiku" for a Claude alias, else the model id. */
const modelName = (c: ModelChoice) => (c.agent === 'claude' && c.model && CLAUDE_ALIASES.includes(c.model) ? cap(c.model) : c.model ?? 'default model')

/** The flags `orca orchestration worker-start` and `orca agent launch` take for a choice. */
export function launchArgs(choice: ModelChoice): string[] {
  const args = ['--agent', choice.agent]
  if (choice.model) {
    args.push('--model', choice.model)
    if (choice.effort) args.push('--effort', choice.effort)
  }
  return args
}

// ---------- availability ----------

/** Why a model cannot be used on this machine, or null when it can (verified, or accepted unverified). */
export function modelProblem(agent: string, model: string, avail: Availability): string | null {
  const catalog = avail.models[agent]
  if (agent === 'claude') {
    // Orca accepts the aliases and any claude-* id, listed or not.
    if (catalog?.some((m) => m.id === model) || isClaudeModel(model)) return null
    return catalog ? `not in ${cap(agent)}'s model list` : 'not a Claude model name'
  }
  if (catalog) return catalog.some((m) => m.id === model) ? null : `not in ${cap(agent)}'s model list`
  return null
}
export const agentProblem = (agent: string, avail: Availability): string | null =>
  avail.agents && !avail.agents.includes(agent) ? `${agent} not installed` : null
/** Why a choice (agent, optional model) cannot run on this machine, or null. */
export const choiceProblem = (c: ModelChoice, avail: Availability): string | null =>
  agentProblem(c.agent, avail) ?? (c.model ? modelProblem(c.agent, c.model, avail) : null)
/** The efforts a launch may pass: what the provider reports (when it does) that Orca also accepts. Empty: none. */
export const supportedEfforts = (agent: string, model: string | undefined, avail: Availability): readonly Effort[] => {
  if (!model) return []
  const info = avail.models[agent]?.find((m) => m.id === model)
  const reported = info?.efforts ?? EFFORTS
  const orca = orcaLaunchEfforts(agent, model)
  return orca ? reported.filter((e) => orca.includes(e)) : reported
}
/** The effort itself when supported, else the nearest lower one, else the lowest supported; none when nothing is supported. */
function clampEffort(effort: Effort, supported: readonly Effort[]): Effort | undefined {
  if (supported.includes(effort)) return effort
  for (let i = EFFORTS.indexOf(effort) - 1; i >= 0; i--) if (supported.includes(EFFORTS[i])) return EFFORTS[i]
  return EFFORTS.find((e) => supported.includes(e))
}
/** The choice with its effort clamped, and a note when the effort changed. */
function clamped(c: ModelChoice, want: Effort | undefined, avail: Availability): { choice: ModelChoice; note: string } {
  if (!c.model || !want) return { choice: c.model ? { agent: c.agent, model: c.model } : { agent: c.agent }, note: '' }
  const effort = clampEffort(want, supportedEfforts(c.agent, c.model, avail))
  const choice: ModelChoice = { agent: c.agent, model: c.model, ...(effort ? { effort } : {}) }
  return { choice, note: effort === want ? '' : `, ${want} not supported so ${effort ?? 'default effort'}` }
}
/** Why an explicit effort cannot be launched with this model, or null. */
function effortProblem(choice: ModelChoice, effort: Effort, avail: Availability): string | null {
  const supported = supportedEfforts(choice.agent, choice.model, avail)
  if (supported.includes(effort)) return null
  const name = choiceLabel({ agent: choice.agent, model: choice.model })
  return supported.length ? `${name} does not support effort ${effort} (it takes ${supported.join(', ')}).` : `${name} takes no effort setting, so effort ${effort} cannot be passed.`
}
const fail = (error: string, skipped: Skip[] = []): RouteDecision => ({ ok: false, error, skipped })

// ---------- route ----------

/** A set role pick (coordinator, lead) checked against availability, effort clamped. */
function pickChoice(pick: ModelChoice | null, who: string, req: RouteRequest, avail: Availability): RouteDecision {
  if (!pick) return { ok: true, choice: { agent: req.agent ?? 'claude' }, source: 'default', reason: `provider default model (none set for ${who})`, skipped: [] }
  const label = choiceLabel(pick)
  const noAgent = agentProblem(pick.agent, avail)
  if (noAgent) return fail(`The ${who} pick ${label} is unavailable (${noAgent}). Change it in Settings → Models.`)
  const noModel = pick.model ? modelProblem(pick.agent, pick.model, avail) : null
  if (noModel) return { ok: true, choice: { agent: pick.agent }, source: 'default', reason: `${label} is unavailable (${noModel}): ${cap(pick.agent)} default model instead`, skipped: [] }
  const { choice, note } = clamped(pick, pick.effort, avail)
  const shown = choice.model && !choice.effort ? `${choiceLabel(choice)} (default effort)` : choiceLabel(choice)
  return { ok: true, choice, source: 'role', reason: `${who} set in Settings → ${shown}${note}`, skipped: [] }
}

const TIMES = ['', 'once', 'twice']

/**
 * The row a worker request starts on: its kind (default normal), one up for high risk, at least
 * normal for large context, one up per escalation. Past hard it stays hard, and each extra level
 * becomes `effortBoost` (one effort step up).
 */
export function rowFor(req: RouteRequest): { kind: TaskKind; effortBoost: number; why: string } {
  const asked = req.kind ?? 'normal'
  let n = TASK_KINDS.indexOf(asked)
  let why = `${asked} task`
  if (req.risk === 'high') { n += 1; why += ', high risk' }
  if (req.context === 'large') { n = Math.max(n, 1); why += ', large context' }
  const attempt = Math.max(0, Math.floor(req.attempt ?? 0))
  if (attempt > 0) { n += attempt; why += `, escalated ${TIMES[attempt] ?? `${attempt} times`}` }
  return { kind: TASK_KINDS[Math.min(2, n)], effortBoost: Math.max(0, n - 2), why }
}

/**
 * The decision for one launch. Pure: no I/O. Precedence, first match wins:
 *  1. Explicit override (req.model / req.agent / req.effort): validated, never substituted; an
 *     invalid one is ok:false. model → source 'override'. agent-only → that agent's default model
 *     unless the routed choice already runs on it. effort-only → routed normally, then that effort.
 *  2. coordinator / lead: the Settings pick (null → provider default; unavailable model → the same
 *     agent's default; agent not installed → error). Effort clamped to what the model supports.
 *  3. worker: the row for its kind (rowFor). Its model unavailable → its fallback, said so in the
 *     reason; both unavailable (or no fallback) → error, never a silent provider default. Past
 *     maxEscalations → error.
 */
export function route(settings: RoutingSettings, req: RouteRequest, avail: Availability): RouteDecision {
  if (req.model) return overrideWithModel(req, avail)
  if (req.agent) {
    const bad = agentProblem(req.agent, avail)
    if (bad) return fail(`Cannot use --agent ${req.agent}: ${bad}.`)
  }
  const agentDefault = (agent: string): RouteDecision =>
    req.effort
      ? fail(`Cannot pass --effort ${req.effort}: ${cap(agent)} was chosen without a model, and Orca takes --effort only with --model. Name a model too.`)
      : { ok: true, choice: { agent }, source: 'override', reason: `${cap(agent)} chosen explicitly: its default model`, skipped: [] }
  let d: RouteDecision
  if (req.role === 'coordinator' || req.role === 'lead') {
    const pick = req.role === 'coordinator' ? settings.coordinator : settings.lead
    if (req.agent && pick?.agent !== req.agent) return agentDefault(req.agent)
    d = pickChoice(pick, req.role === 'coordinator' ? 'coordinators' : 'leads', req, avail)
  } else {
    const attempt = Math.max(0, Math.floor(req.attempt ?? 0))
    if (attempt > settings.maxEscalations) return fail(`Escalation limit reached (${settings.maxEscalations}): ask the user before trying again`)
    d = routeWorker(settings, req, avail)
    if (req.agent && !(d.ok && d.choice.agent === req.agent)) return agentDefault(req.agent)
  }
  if (!d.ok || !req.effort) return d
  if (!d.choice.model) return fail(`Cannot pass --effort ${req.effort}: ${choiceLabel(d.choice)} has no model set, and Orca takes --effort only with --model. Name a model too.`, d.skipped)
  const problem = effortProblem(d.choice, req.effort, avail)
  if (problem) return fail(problem, d.skipped)
  const choice = { ...d.choice, effort: req.effort }
  return { ...d, choice, reason: `${d.reason}; effort ${req.effort} set explicitly` }
}

function overrideWithModel(req: RouteRequest, avail: Availability): RouteDecision {
  const model = req.model as string
  let agent = req.agent
  if (!agent) {
    if (isClaudeModel(model)) agent = 'claude'
    else agent = Object.keys(avail.models).find((a) => avail.models[a]?.some((m) => m.id === model))
    if (!agent) return fail(`Cannot tell which agent runs model ${model}: pass --agent.`)
  }
  const bad = agentProblem(agent, avail) ?? modelProblem(agent, model, avail)
  if (bad) return fail(`Cannot use ${agent} ${model}: ${bad}. Nothing was substituted.`)
  if (req.effort) {
    const problem = effortProblem({ agent, model }, req.effort, avail)
    if (problem) return fail(`${problem} Nothing was substituted.`)
  }
  const choice: ModelChoice = { agent, model, ...(req.effort ? { effort: req.effort } : {}) }
  return { ok: true, choice, source: 'override', reason: `${choiceLabel(choice)} chosen explicitly`, skipped: [] }
}

/** One effort step up per boost, from the row's own effort; a row without an effort stays without. */
const boosted = (effort: Effort | undefined, boost: number): Effort | undefined =>
  effort && boost ? EFFORTS[Math.min(EFFORTS.length - 1, EFFORTS.indexOf(effort) + boost)] : effort

function routeWorker(settings: RoutingSettings, req: RouteRequest, avail: Availability): RouteDecision {
  const at = rowFor(req)
  const row = settings.workers[at.kind]
  const rowInfo = { kind: at.kind, route: clone(row) }
  const primary = row.model
  const gone = choiceProblem(primary, avail)
  const skipped: Skip[] = []
  let use = primary
  let note = ''
  if (gone) {
    skipped.push({ model: choiceLabel(primary), why: gone })
    const fb = row.fallback
    const fbGone = fb ? choiceProblem(fb, avail) : null
    if (!fb || fbGone) {
      if (fb && fbGone) skipped.push({ model: choiceLabel(fb), why: fbGone })
      const also = fb ? `its fallback ${choiceLabel(fb)} is unavailable too (${fbGone})` : 'the row has no fallback'
      return fail(`No model for this ${at.why}: ${choiceLabel(primary)} is unavailable (${gone}) and ${also}. Change the ${at.kind} row in Settings → Models, or pass --model.`, skipped)
    }
    use = fb
    note = `: ${modelName(primary)} unavailable (${gone}), used the fallback`
  }
  const { choice, note: effortNote } = clamped(use, boosted(use.effort, at.effortBoost), avail)
  return { ok: true, choice, source: gone ? 'fallback' : 'kind', row: rowInfo, reason: `${at.why} → ${choiceLabel(choice)}${note}${effortNote}`, skipped }
}
