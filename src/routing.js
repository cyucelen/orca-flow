// Model routing: which agent, model and effort a coordinator, lead or worker starts with.
// Pure and deterministic: the same settings, request and availability always give the same
// decision and the same one-line reason. Shared by the plugin worker (coordinator launches,
// Settings → Models) and skills/orca-flow/scripts/orca-flow.mjs (`route`, `dispatch`, `plan`).
//
// The model: whoever splits the work says what each worker task is. A task of one of the user's own
// types (Browser checks, Images ...) runs on that type's row; every other task goes by its kind
// (simple, normal, hard). The user picks a model, an effort and one fallback per type and per kind
// in Settings → Models. Presets set the coordinator, lead, the three kinds and the types in one step. Honest limits, kept in the words this
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



/**
 * How demanding a worker task is, set by whoever splits the work:
 * - simple: mechanical, one or two files, obvious result (rename, copy change, config value).
 * - normal: a bounded change with tests.
 * - hard: cross-cutting design, hard debugging, concurrency, migrations or security.
 */

/** high: a mistake is costly (production data, money, security, release); one kind up. */

/** large: the task must read much code or long documents; at least normal. */


/** What a launch passes. No `model`: the provider's own default (Orca passes no --model). */


/** One kind's row: the model it starts on (always with a model id) and the one model used when that is unavailable. */



/**
 * A kind of work the user routes to its own model, whatever its difficulty (browser checks, images).
 * `id`: a lowercase slug, unique among the types and never a kind's name; it never changes on rename.
 * `description`: when a task is of this type, for whoever splits the work (at most MAX_TYPE_DESCRIPTION characters).
 */


/** A named Models configuration. Built-ins are fixed starting points; saved ones are the user's. */














export const EFFORTS                    = ['low', 'medium', 'high', 'xhigh', 'max']
export const TASK_KINDS                      = ['simple', 'normal', 'hard']
/** The names an older plan file or command line used for the kinds (`class`, `--class`). */
export const KIND_ALIASES                           = { trivial: 'simple', standard: 'normal', complex: 'hard' }
/** A kind from its name or an old class name; undefined for anything else. */
export const taskKind = (v         )                       =>
  typeof v !== 'string' ? undefined : (TASK_KINDS                     ).includes(v) ? (v            ) : KIND_ALIASES[v]
/** Claude Code's model aliases (`claude --help`: "an alias for the latest model"). */
export const CLAUDE_ALIASES                    = ['haiku', 'sonnet', 'opus', 'fable']
export const MAX_SAVED_PRESETS = 10
export const MAX_TYPES = 12
export const MAX_TYPE_NAME = 40
export const MAX_TYPE_DESCRIPTION = 120
/**
 * Types the Models page may offer as starting points. Suggestions only: no model is attached, and
 * nothing here claims a model is good at them.
 */
export const SUGGESTED_TYPES                                          = [
  { name: 'Browser checks', description: 'Open pages, click through flows, take screenshots' },
  { name: 'Images', description: 'Make or edit images, icons and illustrations' },
  { name: 'Docs & copy', description: 'Write or edit docs, README text and UI copy' },
  { name: 'Research', description: 'Read code or the web and answer a question, no edits' },
  { name: 'Code review', description: 'Review a diff and report findings' }
]

const claude = (model        , effort         )              => ({ agent: 'claude', model, ...(effort ? { effort } : {}) })
const builtIn = (id        , name        , workers         )         => ({ id, name, builtIn: true, coordinator: null, lead: null, workers, types: [] })

/**
 * Editable starting points; coordinator and lead keep the provider default in all three. Haiku
 * carries no effort: Orca refuses --effort for the haiku alias. Each fallback is a different model.
 */
export const BUILT_IN_PRESETS           = [
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

/** Balanced, no types, no saved presets. */
export const DEFAULT_ROUTING                  = {
  coordinator: null,
  lead: null,
  workers: BALANCED.workers,
  types: [],
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
export const ORCA_LAUNCH_EFFORTS                                                                                            = {
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
export function orcaLaunchEfforts(agent        , model        )                           {
  const t = ORCA_LAUNCH_EFFORTS[agent]
  return t ? (t.models[model] ?? t.unknown) : null
}

/** One discovered model: its id and, when the provider says, the efforts it takes. */

/**
 * What this machine can verify. `agents`: installed agent ids, null when unknown (then not
 * checked). `models[agent]`: that agent's model catalog; absent or null when it cannot be listed
 * (then any id is accepted unverified, except Claude, which accepts aliases and `claude-*` ids).
 */


















/** A model passed over, and why (`route --explain`). */













                                                                   





const isObject = (v         )                               => !!v && typeof v === 'object' && !Array.isArray(v)
const clone =    (v   )    => JSON.parse(JSON.stringify(v))
const same = (a         , b         )          => JSON.stringify(a) === JSON.stringify(b)
const isEffort = (v         )              => typeof v === 'string' && (EFFORTS                     ).includes(v)
const text = (v         )                => (typeof v === 'string' && v.trim() ? v.trim() : null)

function normalizeChoice(v         )                     {
  if (!isObject(v)) return null
  const agent = text(v.agent)
  if (!agent) return null
  const model = text(v.model)
  // Key order is fixed (agent, model, effort): `same` compares by JSON. Orca takes an effort only with a model.
  return model ? { agent, model, ...(isEffort(v.effort) ? { effort: v.effort } : {}) } : { agent }
}
/** A choice that names a model, or null. */
const withModel = (v         )                     => {
  const c = normalizeChoice(v)
  return c?.model ? c : null
}

/** A row, or null when its model is unusable. A fallback without a model reads as none. */
function normalizeRow(v         )                   {
  if (!isObject(v)) return null
  const model = withModel(v.model)
  return model ? { model, fallback: withModel(v.fallback) } : null
}

/** All three rows; a bad or missing one is Balanced's row of that kind. With `strict`, a bad row gives null. */
function normalizeWorkers(v         , strict = false)                 {
  const raw = isObject(v) ? v : {}
  const out = {}
  for (const kind of TASK_KINDS) {
    const row = normalizeRow(raw[kind])
    if (!row && strict) return null
    out[kind] = row ?? clone(BALANCED.workers[kind])
  }
  return out
}

const slug = (name        ) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
/** A saved-preset id no other preset in `taken` has: the name's slug, then slug-2, slug-3 ... (names with no ASCII letters share "preset"). */
function savedId(name        , taken                   )         {
  const base = `saved:${slug(name) || 'preset'}`
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}
const sameName = (a        , b        ) => a.trim().toLowerCase() === b.trim().toLowerCase()

// ---------- task types ----------

const TYPE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Kind names (and their old names) are never type names or ids: `--type hard` would read as a kind. */
const isKindName = (name        ) => taskKind(name.trim().toLowerCase()) !== undefined
/** A type id no other type in `taken` has, and no kind's name: the name's slug, then slug-2, slug-3 ... */
function typeId(name        , taken                   )         {
  const base = slug(name) || 'type'
  let id = base
  for (let n = 2; taken.includes(id) || isKindName(id); n++) id = `${base}-${n}`
  return id
}
/** Why a type name cannot be used (null when it can); `others` are the other types. */
function typeNameProblem(name        , others                     )                {
  if (!name) return 'A type needs a name.'
  if (name.length > MAX_TYPE_NAME) return `A type name has at most ${MAX_TYPE_NAME} characters.`
  if (isKindName(name)) return `"${name}" is a difficulty (simple, normal, hard), not a type: choose another name.`
  if (others.some((t) => sameName(t.name, name))) return `There is already a type named "${name}".`
  return null
}

/** One type, or null when it has no name or no usable model. Name and description are trimmed and cut to their limits. */
function normalizeType(v         , taken                     )                  {
  if (!isObject(v)) return null
  const name = text(v.name)?.slice(0, MAX_TYPE_NAME).trim()
  const route = normalizeRow(v.route)
  if (!name || !route || typeNameProblem(name, taken)) return null
  const ids = taken.map((t) => t.id)
  const stored = text(v.id)
  const id = stored && TYPE_ID.test(stored) && !ids.includes(stored) && !isKindName(stored) ? stored : typeId(name, ids)
  const description = (text(v.description) ?? '').slice(0, MAX_TYPE_DESCRIPTION).trim()
  return { id, name, description, route }
}
/** The usable types, in order: a bad one, a second with the same name, and any past MAX_TYPES are dropped. */
function normalizeTypes(v         )             {
  const out             = []
  for (const entry of Array.isArray(v) ? v : []) {
    const t = normalizeType(entry, out)
    if (t && out.length < MAX_TYPES) out.push(t)
  }
  return out
}
const isBuiltInName = (name        ) => BUILT_IN_PRESETS.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())

function normalizePreset(v         , taken                   )                {
  if (!isObject(v)) return null
  const name = text(v.name)
  if (!name || isBuiltInName(name)) return null
  const workers = normalizeWorkers(v.workers, true)
  if (!workers) return null
  const stored = text(v.id)
  const id = stored && /^saved:.+/.test(stored) && !taken.includes(stored) ? stored : savedId(name, taken)
  return { id, name, builtIn: false, coordinator: normalizeChoice(v.coordinator), lead: normalizeChoice(v.lead), workers, types: normalizeTypes(v.types) }
}

/**
 * Every field filled and clamped, in a fixed key order (settings `same` compares JSON). Unknown
 * agent ids are allowed. A bad worker row is Balanced's row of that kind; a bad type (no name, a
 * kind's name, a repeated name, no usable model) is dropped and only the first MAX_TYPES are kept;
 * a bad saved preset is dropped, a second one with the same id too, and only the first MAX_SAVED_PRESETS are kept.
 * Not an object: DEFAULT_ROUTING (a copy).
 */
export function normalizeRouting(raw         )                  {
  if (!isObject(raw)) return clone(DEFAULT_ROUTING)
  const presets           = []
  for (const entry of Array.isArray(raw.presets) ? raw.presets : []) {
    const p = normalizePreset(entry, presets.map((o) => o.id))
    if (p && !presets.some((o) => sameName(o.name, p.name)) && presets.length < MAX_SAVED_PRESETS) presets.push(p)
  }
  return {
    coordinator: normalizeChoice(raw.coordinator),
    lead: normalizeChoice(raw.lead),
    workers: normalizeWorkers(raw.workers)           ,
    types: normalizeTypes(raw.types),
    presets
  }
}

// ---------- presets ----------

/** The built-in presets, then the user's saved ones. */
export function presetsOf(s                 )           {
  return [...clone(BUILT_IN_PRESETS), ...clone(normalizeRouting(s).presets)]
}

/**
 * The preset these settings equal; null means "Custom". A built-in has no types and never touches
 * them, so it matches on coordinator, lead and workers whatever the types; a saved preset matches
 * only when its types are equal too.
 * A saved preset wins over a built-in with the same setup (the last saved match if several).
 */
export function matchingPreset(s                 )                {
  const n = normalizeRouting(s)
  const rows = (p        ) => same(p.coordinator, n.coordinator) && same(p.lead, n.lead) && same(p.workers, n.workers)
  const saved = [...clone(n.presets)].reverse().find((p) => rows(p) && same(p.types, n.types))
  return saved ?? clone(BUILT_IN_PRESETS).find(rows) ?? null
}

/**
 * The settings with a preset's coordinator, lead and workers; a saved preset brings its types too,
 * a built-in keeps the user's types. The saved presets stay.
 */
export function applyPreset(s                 , id        )                  {
  const n = normalizeRouting(s)
  const p = presetsOf(n).find((x) => x.id === id)
  if (!p) throw new Error(`No preset ${id}.`)
  return { ...n, coordinator: p.coordinator, lead: p.lead, workers: p.workers, types: p.builtIn ? n.types : p.types }
}

/** Settings → Models' Reset: Balanced's coordinator, lead and workers; the types and saved presets stay. */
export function resetRouting(s                 )                  {
  return applyPreset(s, BALANCED.id)
}

/**
 * Saves the current coordinator, lead, workers and types under `name`. The same name replaces that
 * preset in place. An empty name, a built-in's name, or an 11th preset is refused (throws).
 */
export function savePreset(s                 , name        )                  {
  const n = normalizeRouting(s)
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A preset needs a name.')
  if (isBuiltInName(trimmed)) throw new Error(`"${trimmed}" is a built-in preset: choose another name.`)
  const at = n.presets.findIndex((p) => sameName(p.name, trimmed))
  const id = at < 0 ? savedId(trimmed, n.presets.map((p) => p.id)) : n.presets[at].id
  const preset         = { id, name: trimmed, builtIn: false, coordinator: n.coordinator, lead: n.lead, workers: n.workers, types: n.types }
  if (at < 0 && n.presets.length >= MAX_SAVED_PRESETS) throw new Error(`At most ${MAX_SAVED_PRESETS} saved presets: delete one first.`)
  const presets = at < 0 ? [...n.presets, preset] : n.presets.map((p, i) => (i === at ? preset : p))
  return { ...n, presets: clone(presets) }
}

/** Removes a saved preset; a built-in one cannot be deleted (throws). An unknown id changes nothing. */
export function deletePreset(s                 , id        )                  {
  if (BUILT_IN_PRESETS.some((p) => p.id === id)) throw new Error('Built-in presets cannot be deleted.')
  const n = normalizeRouting(s)
  return { ...n, presets: n.presets.filter((p) => p.id !== id) }
}

// ---------- editing task types ----------

/** The row as normalize keeps it; throws when its model is unusable. */
function typeRoute(route         )            {
  const r = normalizeRow(route)
  if (!r) throw new Error('A type needs a model.')
  return r
}
function typeDescription(description        )         {
  const d = description.trim()
  if (d.length > MAX_TYPE_DESCRIPTION) throw new Error(`A type description has at most ${MAX_TYPE_DESCRIPTION} characters.`)
  return d
}

/** Adds a type at the end. Refused (throws): no name, a kind's name, a name in use, a description over the limit, no model, a 13th type. */
export function addType(s                 , name        , description        , route           )                  {
  const n = normalizeRouting(s)
  const trimmed = name.trim()
  const problem = typeNameProblem(trimmed, n.types)
  if (problem) throw new Error(problem)
  if (n.types.length >= MAX_TYPES) throw new Error(`At most ${MAX_TYPES} task types: remove one first.`)
  const type           = { id: typeId(trimmed, n.types.map((t) => t.id)), name: trimmed, description: typeDescription(description), route: typeRoute(route) }
  return { ...n, types: [...n.types, type] }
}

/** Changes a type's name, description or row; its id stays. Refused (throws) as addType, and for an unknown id. */
export function updateType(s                 , id        , patch                               )                  {
  const n = normalizeRouting(s)
  const at = n.types.findIndex((t) => t.id === id)
  if (at < 0) throw new Error(`No task type ${id}.`)
  const old = n.types[at]
  const name = patch.name === undefined ? old.name : patch.name.trim()
  if (patch.name !== undefined) {
    const problem = typeNameProblem(name, n.types.filter((_, i) => i !== at))
    if (problem) throw new Error(problem)
  }
  const type           = {
    id,
    name,
    description: patch.description === undefined ? old.description : typeDescription(patch.description),
    route: patch.route === undefined ? old.route : typeRoute(patch.route)
  }
  return { ...n, types: n.types.map((t, i) => (i === at ? type : t)) }
}

/** Removes a type; an unknown id changes nothing. */
export function removeType(s                 , id        )                  {
  const n = normalizeRouting(s)
  return { ...n, types: n.types.filter((t) => t.id !== id) }
}

/** The type a task names, by id or name, case-insensitive; undefined when none. */
export function findType(s                 , idOrName        )                       {
  const want = idOrName.trim().toLowerCase()
  if (!want) return undefined
  const types = normalizeRouting(s).types
  return types.find((t) => t.id === want) ?? types.find((t) => sameName(t.name, want))
}

// ---------- labels and launch flags ----------

const cap = (s        ) => s.charAt(0).toUpperCase() + s.slice(1)
const isClaudeModel = (m        ) => CLAUDE_ALIASES.includes(m) || /^claude-/.test(m)

/** A short label for people: "Claude Sonnet · medium", "Codex gpt-6-luna · low", "Claude (default model)". */
export function choiceLabel(choice             )         {
  const agent = cap(choice.agent)
  if (!choice.model) return `${agent} (default model)`
  return `${agent} ${modelName(choice)}${choice.effort ? ` · ${choice.effort}` : ''}`
}
/** "Haiku" for a Claude alias, else the model id. */
const modelName = (c             ) => (c.agent === 'claude' && c.model && CLAUDE_ALIASES.includes(c.model) ? cap(c.model) : c.model ?? 'default model')

/** The flags `orca orchestration worker-start` and `orca agent launch` take for a choice. */
export function launchArgs(choice             )           {
  const args = ['--agent', choice.agent]
  if (choice.model) {
    args.push('--model', choice.model)
    if (choice.effort) args.push('--effort', choice.effort)
  }
  return args
}

// ---------- availability ----------

/** Why a model cannot be used on this machine, or null when it can (verified, or accepted unverified). */
export function modelProblem(agent        , model        , avail              )                {
  const catalog = avail.models[agent]
  if (agent === 'claude') {
    // Orca accepts the aliases and any claude-* id, listed or not.
    if (catalog?.some((m) => m.id === model) || isClaudeModel(model)) return null
    return catalog ? `not in ${cap(agent)}'s model list` : 'not a Claude model name'
  }
  if (catalog) return catalog.some((m) => m.id === model) ? null : `not in ${cap(agent)}'s model list`
  return null
}
export const agentProblem = (agent        , avail              )                =>
  avail.agents && !avail.agents.includes(agent) ? `${agent} not installed` : null
/** Why a choice (agent, optional model) cannot run on this machine, or null. */
export const choiceProblem = (c             , avail              )                =>
  agentProblem(c.agent, avail) ?? (c.model ? modelProblem(c.agent, c.model, avail) : null)
/** The efforts a launch may pass: what the provider reports (when it does) that Orca also accepts. Empty: none. */
export const supportedEfforts = (agent        , model                    , avail              )                    => {
  if (!model) return []
  const info = avail.models[agent]?.find((m) => m.id === model)
  const reported = info?.efforts ?? EFFORTS
  const orca = orcaLaunchEfforts(agent, model)
  return orca ? reported.filter((e) => orca.includes(e)) : reported
}
/** The effort itself when supported, else the nearest lower one, else the lowest supported; none when nothing is supported. */
function clampEffort(effort        , supported                   )                     {
  if (supported.includes(effort)) return effort
  for (let i = EFFORTS.indexOf(effort) - 1; i >= 0; i--) if (supported.includes(EFFORTS[i])) return EFFORTS[i]
  return EFFORTS.find((e) => supported.includes(e))
}
/** The choice with its effort clamped, and a note when the effort changed. */
function clamped(c             , want                    , avail              )                                        {
  if (!c.model || !want) return { choice: c.model ? { agent: c.agent, model: c.model } : { agent: c.agent }, note: '' }
  const effort = clampEffort(want, supportedEfforts(c.agent, c.model, avail))
  const choice              = { agent: c.agent, model: c.model, ...(effort ? { effort } : {}) }
  return { choice, note: effort === want ? '' : `, ${want} not supported so ${effort ?? 'default effort'}` }
}
/** Why an explicit effort cannot be launched with this model, or null. */
function effortProblem(choice             , effort        , avail              )                {
  const supported = supportedEfforts(choice.agent, choice.model, avail)
  if (supported.includes(effort)) return null
  const name = choiceLabel({ agent: choice.agent, model: choice.model })
  return supported.length ? `${name} does not support effort ${effort} (it takes ${supported.join(', ')}).` : `${name} takes no effort setting, so effort ${effort} cannot be passed.`
}
const fail = (error        , skipped         = [])                => ({ ok: false, error, skipped })

// ---------- route ----------

/** A set role pick (coordinator, lead) checked against availability, effort clamped. */
function pickChoice(pick                    , who        , req              , avail              )                {
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
export const ALREADY_HARD = 'Already at the hard level: ask the user before trying again.'

/**
 * The row a worker request starts on: its kind (default normal), one up for high risk, at least
 * normal for large context, and n more for the nth retry (each failure moves it up n rows, never past
 * hard). `spent`: the retry follows a run that was already on the hard row, so there is no row left.
 */
export function rowFor(req              )                                                  {
  const asked = req.kind ?? 'normal'
  let n = TASK_KINDS.indexOf(asked)
  let why = `${asked} task`
  if (req.risk === 'high') { n += 1; why += ', high risk' }
  if (req.context === 'large') { n = Math.max(n, 1); why += ', large context' }
  const attempt = Math.max(0, Math.floor(req.attempt ?? 0))
  const spent = attempt > 0 && n + attempt - 1 >= 2
  if (attempt > 0) { n += attempt; why += `, escalated ${TIMES[attempt] ?? `${attempt} times`}` }
  return { kind: TASK_KINDS[Math.min(2, n)], spent, why }
}

/**
 * The decision for one launch. Pure: no I/O. Precedence, first match wins:
 *  1. Explicit override (req.model / req.agent / req.effort): validated, never substituted; an
 *     invalid one is ok:false. model → source 'override'. agent-only → that agent's default model
 *     unless the routed choice already runs on it. effort-only → routed normally, then that effort.
 *  2. coordinator / lead: the Settings pick (null → provider default; unavailable model → the same
 *     agent's default; agent not installed → error). Effort clamped to what the model supports.
 *  3. worker with a type: that type's row (routeTyped); kind, risk and context do not change it. An
 *     unknown type → error listing the known types, never a silent fall back to difficulty.
 *  4. worker: the row for its kind (rowFor). Its model unavailable → its fallback, said so in the
 *     reason; both unavailable (or no fallback) → error, never a silent provider default. A retry of
 *     a task that already ran on the hard row → error.
 * A worker's type is checked first, so a typo is refused even beside an override.
 */
export function route(settings                 , req              , avail              )                {
  const typed = req.role === 'worker' && req.type !== undefined ? findType(settings, req.type) : undefined
  if (req.role === 'worker' && req.type !== undefined && !typed) return fail(unknownType(settings, req.type))
  if (req.model) return overrideWithModel(req, avail)
  if (req.agent) {
    const bad = agentProblem(req.agent, avail)
    if (bad) return fail(`Cannot use --agent ${req.agent}: ${bad}.`)
  }
  const agentDefault = (agent        )                =>
    req.effort
      ? fail(`Cannot pass --effort ${req.effort}: ${cap(agent)} was chosen without a model, and Orca takes --effort only with --model. Name a model too.`)
      : { ok: true, choice: { agent }, source: 'override', reason: `${cap(agent)} chosen explicitly: its default model`, skipped: [] }
  let d
  if (req.role === 'coordinator' || req.role === 'lead') {
    const pick = req.role === 'coordinator' ? settings.coordinator : settings.lead
    if (req.agent && pick?.agent !== req.agent) return agentDefault(req.agent)
    d = pickChoice(pick, req.role === 'coordinator' ? 'coordinators' : 'leads', req, avail)
  } else if (typed) {
    d = routeTyped(typed, req, avail)
    if (req.agent && !(d.ok && d.choice.agent === req.agent)) return agentDefault(req.agent)
  } else {
    if (rowFor(req).spent) return fail(ALREADY_HARD)
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

function overrideWithModel(req              , avail              )                {
  const model = req.model
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
  const choice              = { agent, model, ...(req.effort ? { effort: req.effort } : {}) }
  return { ok: true, choice, source: 'override', reason: `${choiceLabel(choice)} chosen explicitly`, skipped: [] }
}

/** The refusal for a type the settings do not have: the known ones, or that there are none. */
function unknownType(settings                 , asked        )         {
  const types = normalizeRouting(settings).types
  if (!types.length) return `No task type "${asked}": no types are set, so tasks go by difficulty. Pass --kind simple, normal or hard instead, or add the type in Settings → Models.`
  return `No task type "${asked}". Known types: ${types.map((t) => `${t.id} (${t.name})`).join(', ')}. Use one of these, or route by difficulty with --kind.`
}

/** "No stronger model for Images: ask the user before trying again." */
export const noStrongerModel = (typeName        ) => `No stronger model for ${typeName}: ask the user before trying again.`

/**
 * A typed task: the type's model, or its fallback when the model is unavailable. Escalation never
 * leaves the type: the first retry runs on the fallback (when it is another choice and available),
 * and anything after that is refused.
 */
function routeTyped(type          , req              , avail              )                {
  const row = type.route
  const info = { id: type.id, name: type.name, route: clone(row) }
  const attempt = Math.max(0, Math.floor(req.attempt ?? 0))
  const fb = row.fallback
  const skipped         = []
  if (attempt > 0) {
    const fbGone = fb ? choiceProblem(fb, avail) : null
    if (attempt > 1 || !fb || same(fb, row.model) || fbGone) {
      if (attempt === 1 && fb && fbGone) skipped.push({ model: choiceLabel(fb), why: fbGone })
      return fail(noStrongerModel(type.name), skipped)
    }
    const { choice, note } = clamped(fb, fb.effort, avail)
    return { ok: true, choice, source: 'fallback', type: info, reason: `${type.name} task, retried → ${choiceLabel(choice)}: fallback after a failure${note}`, skipped }
  }
  const gone = choiceProblem(row.model, avail)
  let use = row.model
  let note = ''
  if (gone) {
    skipped.push({ model: choiceLabel(row.model), why: gone })
    const fbGone = fb ? choiceProblem(fb, avail) : null
    if (!fb || fbGone) {
      if (fb && fbGone) skipped.push({ model: choiceLabel(fb), why: fbGone })
      const also = fb ? `its fallback ${choiceLabel(fb)} is unavailable too (${fbGone})` : 'the type has no fallback'
      return fail(`No model for this ${type.name} task: ${choiceLabel(row.model)} is unavailable (${gone}) and ${also}. Change the ${type.name} type in Settings → Models, or pass --model.`, skipped)
    }
    use = fb
    note = `: ${modelName(row.model)} unavailable (${gone}), used the fallback`
  }
  const { choice, note: effortNote } = clamped(use, use.effort, avail)
  return { ok: true, choice, source: gone ? 'fallback' : 'type', type: info, reason: `${type.name} task → ${choiceLabel(choice)}${note}${effortNote}`, skipped }
}

function routeWorker(settings                 , req              , avail              )                {
  const at = rowFor(req)
  const row = settings.workers[at.kind]
  const rowInfo = { kind: at.kind, route: clone(row) }
  const primary = row.model
  const gone = choiceProblem(primary, avail)
  const skipped         = []
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
  const { choice, note: effortNote } = clamped(use, use.effort, avail)
  return { ok: true, choice, source: gone ? 'fallback' : 'kind', row: rowInfo, reason: `${at.why} → ${choiceLabel(choice)}${note}${effortNote}`, skipped }
}
// Generated by scripts/build-frames.mjs from the .ts file of the same name. Do not edit.
