// What Settings → Models lists and shows, from the worker's availability (src/model-discovery.ts).
// Pure: no DOM, so the page (src/panel/settings.ts) and tests share it.
import { CLAUDE_ALIASES, EFFORTS, route, TASK_KINDS, type Availability, type Effort, type ModelChoice, type RoutingSettings, type TaskKind } from '../routing.ts'

export const UNKNOWN: Availability = { agents: null, models: {} }
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
export const agentName = (agent: string): string => ({ claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' } as Record<string, string>)[agent] ?? cap(agent)

/** Installed agents in a stable order (Claude, Codex, then the rest); unknown: Claude and Codex. */
export function agentsShown(avail: Availability): string[] {
  const list = avail.agents ?? ['claude', 'codex']
  const first = ['claude', 'codex'].filter((a) => list.includes(a))
  return [...first, ...list.filter((a) => !first.includes(a)).sort()]
}

export type ModelOption = { id: string; label: string }
/** The models one agent offers: Claude's aliases, Codex's catalog; none for an agent that lists none. */
export function modelOptions(agent: string, avail: Availability): ModelOption[] {
  if (agent === 'claude') return CLAUDE_ALIASES.map((id) => ({ id, label: cap(id) }))
  return (avail.models[agent] ?? []).map((m) => ({ id: m.id, label: m.label ?? m.id }))
}

/** "Sonnet", "GPT-6 Luna", or the id itself when the catalog does not name it. */
export function modelLabel(agent: string, model: string, avail: Availability): string {
  return modelOptions(agent, avail).find((m) => m.id === model)?.label ?? model
}

/** "Claude Sonnet · medium", "Codex (default model)": for people, with the catalog's display names. */
export function choiceText(c: ModelChoice | null, avail: Availability): string {
  if (!c) return 'Provider default'
  if (!c.model) return `${agentName(c.agent)} (default model)`
  return `${agentName(c.agent)} ${modelLabel(c.agent, c.model, avail)}${c.effort ? ` · ${c.effort}` : ''}`
}

/** The efforts a model takes, when its provider says; otherwise all of them. */
export function effortsFor(agent: string, model: string | undefined, avail: Availability): readonly Effort[] {
  const info = model ? avail.models[agent]?.find((m) => m.id === model) : undefined
  return info?.efforts?.length ? info.efforts : EFFORTS
}

/** Why a model cannot run on this machine, in plain words; null when it can (or cannot be checked). */
export function unavailable(agent: string, model: string | undefined, avail: Availability): string | null {
  if (avail.agents && !avail.agents.includes(agent)) return `${agentName(agent)} isn’t installed in Orca`
  const catalog = avail.models[agent]
  if (model && catalog && !catalog.some((m) => m.id === model)) return `${agentName(agent)} doesn’t list this model`
  return null
}

/** A select's value for a choice: "" provider default, "agent:" its default model, "agent:model". */
export const choiceValue = (c: ModelChoice | null): string => (c ? `${c.agent}:${c.model ?? ''}` : '')
export function choiceFrom(value: string, effort?: Effort): ModelChoice | null {
  if (!value) return null
  const at = value.indexOf(':')
  const agent = value.slice(0, at), model = value.slice(at + 1)
  return model ? { agent, model, ...(effort ? { effort } : {}) } : { agent }
}

export type Example = { kind: TaskKind; row: string; text: string; tip: string; ok: boolean }
/** Each kind's row as set, and what a new worker task of that kind would start with right now. */
export function examples(routing: RoutingSettings, avail: Availability): Example[] {
  return TASK_KINDS.map((kind) => {
    const r = routing.workers[kind]
    const row = `${choiceText(r.model, avail)}, fallback ${r.fallback ? choiceText(r.fallback, avail) : 'none'}`
    const d = route(routing, { role: 'worker', kind }, avail)
    return d.ok
      ? { kind, row, text: choiceText(d.choice, avail), tip: cap(d.reason), ok: true }
      : { kind, row, text: 'No model available', tip: d.error, ok: false }
  })
}
