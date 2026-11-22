// Model routing: which agent, model and effort a coordinator, lead or worker starts with.
// Pure and deterministic: the same settings, request and availability always give the same
// decision and the same one-line reason. Shared by the plugin worker (coordinator launches,
// Settings → Models) and skills/orca-flow/scripts/orca-flow.mjs (`route`, `dispatch`, `plan`).
//
// Honest limits, kept in the words this module writes:
// - `tier` (Light / Standard / Strong) and `cost` (1-5) are the user's own relative ratings, not
//   measured capability, token prices or plan usage. Defaults are editable starting points.
// - Availability is what this machine can verify: `orca agent installed` for agents, and the Codex
//   CLI's own catalog (`codex debug models`) for Codex model ids. Claude Code lists no models, so a
//   Claude alias (haiku, sonnet, opus, fable) or a full `claude-*` id is accepted unverified.
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

/** Settings as stored under `routing` in ~/.orca-flow/config.json, every field filled and clamped. */
export function normalizeRouting(raw: unknown): RoutingSettings {
  throw new Error('not implemented')
}

/** The tier a request needs, after class, risk, context and escalation, with the plain why. */
export function requiredTier(req: RouteRequest): { tier: Tier; effortBoost: number; why: string } {
  throw new Error('not implemented')
}

/** The decision for one launch. Pure: no I/O. */
export function route(settings: RoutingSettings, req: RouteRequest, avail: Availability): RouteDecision {
  throw new Error('not implemented')
}

/** The flags `orca orchestration worker-start` and `orca agent launch` take for a choice. */
export function launchArgs(choice: ModelChoice): string[] {
  throw new Error('not implemented')
}

/** A short label for people: "Claude Sonnet · medium", "Codex gpt-6-luna · low", "Claude (default model)". */
export function choiceLabel(choice: ModelChoice): string {
  throw new Error('not implemented')
}
