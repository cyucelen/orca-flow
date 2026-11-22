// Model routing: which agent, model and effort a coordinator, lead or worker starts with.
// Pure and deterministic: the same settings, request and availability always give the same
// decision and the same one-line reason. Shared by the plugin worker (coordinator launches,
// Settings → Models) and skills/orca-flow/scripts/orca-flow.mjs (`route`, `dispatch`, `plan`).
//
// Honest limits, kept in the words this module writes:
// - `tier` (Light / Standard / Strong) and `cost` (1-5) are the user's own relative ratings, not
//   measured capability, token prices or plan usage. Defaults are editable starting points.
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
/** The user's capability rating of a model: 1 Light, 2 Standard, 3 Strong. */
export type Tier = 1 | 2 | 3
/**
 * How demanding a worker task is, set by whoever splits the work:
 * - trivial: mechanical, one or two files, obvious result (rename, copy change, config value).
 * - standard: a normal bounded change with tests.
 * - complex: cross-cutting design, hard debugging, concurrency, migrations or security.
 */
export type TaskClass = 'trivial' | 'standard' | 'complex'
/** high: a mistake is costly (production data, money, security, release); asks one tier more. */
export type Risk = 'low' | 'high'
/** large: the task must read much code or long documents; asks at least Standard. */
export type ContextSize = 'normal' | 'large'

/** What a launch passes. No `model`: the provider's own default (Orca passes no --model). */
export type ModelChoice = { agent: string; model?: string; effort?: Effort }

/** One model the worker router may pick. `effort` pins it; absent, the task class sets it. */
export type Candidate = { agent: string; model: string; effort?: Effort; tier: Tier; cost: number; enabled: boolean }

export type RoutingSettings = {
  /** null: no model is passed and the provider default applies (Orca Flow 0.2.77 behaviour). */
  coordinator: ModelChoice | null
  lead: ModelChoice | null
  /** auto: route each worker task to the cheapest capable candidate; fixed: always `worker`. */
  workerMode: 'auto' | 'fixed'
  /** fixed mode: the worker model (null: provider default). auto mode: unused. */
  worker: ModelChoice | null
  /** Worker candidates in the user's order; the order breaks ties at the same tier and cost. */
  candidates: Candidate[]
  /** Escalations allowed per task after a demonstrated failure (0-2). Each one asks one tier more. */
  maxEscalations: number
  /** Workers one lead runs at once (1-6), before the memory gate is even asked. */
  maxParallel: number
}

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const TIER_NAMES: Record<Tier, string> = { 1: 'Light', 2: 'Standard', 3: 'Strong' }
export const CLASS_TIER: Record<TaskClass, Tier> = { trivial: 1, standard: 2, complex: 3 }
export const CLASS_EFFORT: Record<TaskClass, Effort> = { trivial: 'low', standard: 'medium', complex: 'high' }
/** Claude Code's model aliases (`claude --help`: "an alias for the latest model"). */
export const CLAUDE_ALIASES: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable']

/**
 * Editable starting points: Claude's three aliases rated Light, Standard and Strong. Coordinator and
 * lead keep the provider default, as before this feature. No Codex candidate is enabled by default:
 * its models carry no capability rating here until the user gives one.
 */
export const DEFAULT_ROUTING: RoutingSettings = {
  coordinator: null,
  lead: null,
  workerMode: 'auto',
  worker: null,
  candidates: [
    { agent: 'claude', model: 'haiku', tier: 1, cost: 1, enabled: true },
    { agent: 'claude', model: 'sonnet', tier: 2, cost: 2, enabled: true },
    { agent: 'claude', model: 'opus', tier: 3, cost: 4, enabled: true }
  ],
  maxEscalations: 1,
  maxParallel: 3
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
  /** Workers; default standard. */
  taskClass?: TaskClass
  risk?: Risk
  context?: ContextSize
  /** 0 on the first try; n after n demonstrated failures of this task. */
  attempt?: number
  /** Explicit per-task choices; they win over every setting and are never swapped silently. */
  agent?: string
  model?: string
  effort?: Effort
}

export type Skip = { candidate: string; why: string }
export type RouteDecision =
  | {
      ok: true
      choice: ModelChoice
      /** override: the task's own flags; role: Settings' coordinator or lead pick; fixed: the fixed worker
       *  model; auto: routed among candidates; default: provider default (nothing set, or a pick unavailable). */
      source: 'override' | 'role' | 'fixed' | 'auto' | 'default'
      requiredTier?: Tier
      tier?: Tier
      /** One plain line for people: "standard task → Claude Sonnet · medium: cheapest enabled Standard model". */
      reason: string
      /** Candidates passed over and why, for `route --explain`. */
      skipped: Skip[]
    }
  | { ok: false; error: string; skipped: Skip[] }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
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

function normalizeCandidate(v: unknown): Candidate | null {
  if (!isObject(v)) return null
  const agent = text(v.agent)
  const model = text(v.model)
  if (!agent || !model) return null
  if (typeof v.tier !== 'number' || !Number.isFinite(v.tier) || typeof v.cost !== 'number' || !Number.isFinite(v.cost)) return null
  return {
    agent, model, ...(isEffort(v.effort) ? { effort: v.effort } : {}),
    tier: clampInt(v.tier, 1, 3, 2) as Tier, cost: clampInt(v.cost, 1, 5, 3), enabled: v.enabled !== false
  }
}

/**
 * Every field filled and clamped, in a fixed key order (settings `same` compares JSON). Unknown
 * agent ids are allowed. Malformed candidates are dropped and duplicates (agent + model) keep the
 * first. Not an object, or nothing usable in it: DEFAULT_ROUTING (a copy).
 */
export function normalizeRouting(raw: unknown): RoutingSettings {
  if (!isObject(raw)) return clone(DEFAULT_ROUTING)
  const known = ['coordinator', 'lead', 'workerMode', 'worker', 'candidates', 'maxEscalations', 'maxParallel']
  if (!known.some((k) => k in raw)) return clone(DEFAULT_ROUTING)
  let candidates: Candidate[] = clone(DEFAULT_ROUTING.candidates)
  if (Array.isArray(raw.candidates)) {
    const out: Candidate[] = []
    for (const entry of raw.candidates) {
      const c = normalizeCandidate(entry)
      if (c && !out.some((o) => o.agent === c.agent && o.model === c.model)) out.push(c)
    }
    if (out.length || raw.candidates.length === 0) candidates = out
  }
  return {
    coordinator: normalizeChoice(raw.coordinator),
    lead: normalizeChoice(raw.lead),
    workerMode: raw.workerMode === 'fixed' ? 'fixed' : 'auto',
    worker: normalizeChoice(raw.worker),
    candidates,
    maxEscalations: clampInt(raw.maxEscalations, 0, 2, DEFAULT_ROUTING.maxEscalations),
    maxParallel: clampInt(raw.maxParallel, 1, 6, DEFAULT_ROUTING.maxParallel)
  }
}

const TIMES = ['', 'once', 'twice']
/**
 * The tier a request needs: the class's tier, +1 for high risk, at least Standard for large context,
 * then +1 per escalation. Past Strong the tier stays 3 and the rest becomes `effortBoost`.
 */
export function requiredTier(req: RouteRequest): { tier: Tier; effortBoost: number; why: string } {
  const cls = req.taskClass ?? 'standard'
  let n: number = CLASS_TIER[cls]
  let why = `${cls} task`
  if (req.risk === 'high') { n += 1; why += ', high risk' }
  if (req.context === 'large') { n = Math.max(n, 2); why += ', large context' }
  const attempt = Math.max(0, Math.floor(req.attempt ?? 0))
  if (attempt > 0) {
    n += attempt
    why += `, escalated ${TIMES[attempt] ?? `${attempt} times`} after a failure`
  }
  return { tier: Math.min(3, n) as Tier, effortBoost: Math.max(0, n - 3), why }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const isClaudeModel = (m: string) => CLAUDE_ALIASES.includes(m) || /^claude-/.test(m)

/** A short label for people: "Claude Sonnet · medium", "Codex gpt-6-luna · low", "Claude (default model)". */
export function choiceLabel(choice: ModelChoice): string {
  const agent = cap(choice.agent)
  if (!choice.model) return `${agent} (default model)`
  const model = choice.agent === 'claude' && CLAUDE_ALIASES.includes(choice.model) ? cap(choice.model) : choice.model
  return `${agent} ${model}${choice.effort ? ` · ${choice.effort}` : ''}`
}

/** The flags `orca orchestration worker-start` and `orca agent launch` take for a choice. */
export function launchArgs(choice: ModelChoice): string[] {
  const args = ['--agent', choice.agent]
  if (choice.model) {
    args.push('--model', choice.model)
    if (choice.effort) args.push('--effort', choice.effort)
  }
  return args
}

/** Why a model cannot be used on this machine, or null when it can (verified, or accepted unverified). */
function modelProblem(agent: string, model: string, avail: Availability): string | null {
  const catalog = avail.models[agent]
  if (catalog) return catalog.some((m) => m.id === model) ? null : `not in ${cap(agent)}'s model list`
  if (agent === 'claude' && !isClaudeModel(model)) return 'not a Claude model name'
  return null
}
const agentProblem = (agent: string, avail: Availability): string | null =>
  avail.agents && !avail.agents.includes(agent) ? `${agent} not installed` : null
/** The efforts a launch may pass: what the provider reports (when it does) that Orca also accepts. Empty: none. */
const supportedEfforts = (agent: string, model: string | undefined, avail: Availability): readonly Effort[] => {
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
/** Why an explicit effort cannot be launched with this model, or null. */
function effortProblem(choice: ModelChoice, effort: Effort, avail: Availability): string | null {
  const supported = supportedEfforts(choice.agent, choice.model, avail)
  if (supported.includes(effort)) return null
  const name = choiceLabel({ agent: choice.agent, model: choice.model })
  return supported.length ? `${name} does not support effort ${effort} (it takes ${supported.join(', ')}).` : `${name} takes no effort setting, so effort ${effort} cannot be passed.`
}
/** choiceLabel, plus "(default effort)" when a model is named but no effort is passed. */
const decisionLabel = (c: ModelChoice) => (c.model && !c.effort ? `${choiceLabel(c)} (default effort)` : choiceLabel(c))
const fail = (error: string, skipped: Skip[] = []): RouteDecision => ({ ok: false, error, skipped })

/** A set role pick (coordinator, lead, fixed worker) checked against availability, effort clamped. */
function pickChoice(pick: ModelChoice | null, who: string, source: 'role' | 'fixed', req: RouteRequest, avail: Availability): RouteDecision {
  if (!pick) return { ok: true, choice: { agent: req.agent ?? 'claude' }, source: 'default', reason: `provider default model (none set for ${who})`, skipped: [] }
  const label = choiceLabel(pick)
  const noAgent = agentProblem(pick.agent, avail)
  if (noAgent) return fail(`The ${who} pick ${label} is unavailable (${noAgent}). Change it in Settings → Models.`)
  const noModel = pick.model ? modelProblem(pick.agent, pick.model, avail) : null
  if (noModel) return { ok: true, choice: { agent: pick.agent }, source: 'default', reason: `${label} is unavailable (${noModel}): ${cap(pick.agent)} default model instead`, skipped: [] }
  let choice = pick
  let note = ''
  if (pick.model && pick.effort) {
    const effort = clampEffort(pick.effort, supportedEfforts(pick.agent, pick.model, avail))
    if (effort !== pick.effort) {
      choice = { agent: pick.agent, model: pick.model, ...(effort ? { effort } : {}) }
      note = `, ${pick.effort} not supported so ${effort ?? 'default effort'}`
    }
  }
  return { ok: true, choice, source, reason: `${who} set in Settings → ${decisionLabel(choice)}${note}`, skipped: [] }
}

/**
 * The decision for one launch. Pure: no I/O. Precedence, first match wins:
 *  1. Explicit override (req.model / req.agent / req.effort): validated, never substituted; an
 *     invalid one is ok:false. model → source 'override'. agent-only → that agent (workers in auto
 *     mode: candidates restricted to it). effort-only → routed normally, then that effort.
 *  2. coordinator / lead: the Settings pick (null → provider default; unavailable model → the same
 *     agent's default; agent not installed → error). Effort clamped to what the model supports.
 *  3. worker, fixed mode: settings.worker the same way (source 'fixed').
 *  4. worker, auto mode: cheapest enabled, installed, verified candidate rated at least the required
 *     tier (ties: lower tier, then list order); escalation limit refuses; nothing eligible is an
 *     error, never a silent premium or provider-default fallback.
 */
export function route(settings: RoutingSettings, req: RouteRequest, avail: Availability): RouteDecision {
  if (req.model) return overrideWithModel(req, avail)
  let agentOnly: string | undefined
  if (req.agent) {
    const bad = agentProblem(req.agent, avail)
    if (bad) return fail(`Cannot use --agent ${req.agent}: ${bad}.`)
    const pick = req.role === 'coordinator' ? settings.coordinator : req.role === 'lead' ? settings.lead : settings.workerMode === 'fixed' ? settings.worker : null
    const autoWorker = req.role === 'worker' && settings.workerMode === 'auto'
    if (!autoWorker && pick?.agent !== req.agent) return { ok: true, choice: { agent: req.agent }, source: 'override', reason: `${cap(req.agent)} chosen explicitly: its default model`, skipped: [] }
    agentOnly = autoWorker ? req.agent : undefined
  }
  let d: RouteDecision
  if (req.role === 'coordinator') d = pickChoice(settings.coordinator, 'coordinators', 'role', req, avail)
  else if (req.role === 'lead') d = pickChoice(settings.lead, 'leads', 'role', req, avail)
  else if (settings.workerMode === 'fixed') d = pickChoice(settings.worker, 'the fixed worker', 'fixed', req, avail)
  else d = routeWorker(settings, req, avail, agentOnly)
  if (!d.ok || !req.effort) return d
  if (d.choice.model) {
    const problem = effortProblem(d.choice, req.effort, avail)
    if (problem) return fail(problem, d.skipped)
  }
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

function routeWorker(settings: RoutingSettings, req: RouteRequest, avail: Availability, onlyAgent?: string): RouteDecision {
  const attempt = Math.max(0, Math.floor(req.attempt ?? 0))
  if (attempt > settings.maxEscalations) return fail(`Escalation limit reached (${settings.maxEscalations}): ask the user before trying again`)
  const need = requiredTier(req)
  const skipped: Skip[] = []
  const eligible: { c: Candidate; i: number }[] = []
  settings.candidates.forEach((c, i) => {
    const name = `${c.agent} ${c.model}`
    const why = onlyAgent && c.agent !== onlyAgent ? `not ${onlyAgent}`
      : !c.enabled ? 'off'
      : c.tier < need.tier ? `rated ${TIER_NAMES[c.tier]}, task needs ${TIER_NAMES[need.tier]}`
      : agentProblem(c.agent, avail) ?? modelProblem(c.agent, c.model, avail)
    if (why) skipped.push({ candidate: name, why })
    else eligible.push({ c, i })
  })
  if (!eligible.length) {
    return fail(`No enabled ${TIER_NAMES[need.tier]} model is available for this ${need.why}. Enable or add one in Settings → Models, or pass --model.`, skipped)
  }
  eligible.sort((a, b) => a.c.cost - b.c.cost || a.c.tier - b.c.tier || a.i - b.i)
  const best = eligible[0].c
  for (const { c } of eligible.slice(1)) skipped.push({ candidate: `${c.agent} ${c.model}`, why: `costs more (relative cost ${c.cost}, not ${best.cost})` })
  const base = best.effort ?? CLASS_EFFORT[req.taskClass ?? 'standard']
  const boosted = EFFORTS[Math.min(EFFORTS.length - 1, EFFORTS.indexOf(base) + need.effortBoost)]
  const effort = clampEffort(boosted, supportedEfforts(best.agent, best.model, avail))
  const choice: ModelChoice = { agent: best.agent, model: best.model, ...(effort ? { effort } : {}) }
  const kind = best.tier === need.tier ? `cheapest enabled ${TIER_NAMES[need.tier]} model` : `cheapest capable model (rated ${TIER_NAMES[best.tier]}, task needs ${TIER_NAMES[need.tier]})`
  return { ok: true, choice, source: 'auto', requiredTier: need.tier, tier: best.tier, reason: `${need.why} → ${decisionLabel(choice)}: ${kind} (relative cost ${best.cost})`, skipped }
}
