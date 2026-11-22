// What Settings → Models lists and shows, from the worker's availability (src/model-discovery.ts).
// Pure: no DOM, so the page (src/panel/settings.ts) and tests share it.
import { applyPreset, CLAUDE_ALIASES, agentProblem, matchingPreset, modelProblem, presetsOf, savePreset, supportedEfforts, type Availability, type Effort, type ModelChoice, type Preset, type RoutingSettings } from '../routing.ts'

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
const rank = (id: string) => { const i = CLAUDE_ALIASES.indexOf(id); return i < 0 ? CLAUDE_ALIASES.length : i }
/**
 * The models one agent offers, with display names: Claude's from discovery (aliases first), or the
 * four aliases when discovery could not read them; Codex's from its catalog; none for an agent that lists none.
 */
export function modelOptions(agent: string, avail: Availability): ModelOption[] {
  const catalog = avail.models[agent]
  if (agent === 'claude') {
    if (!catalog?.length) return CLAUDE_ALIASES.map((id) => ({ id, label: cap(id) }))
    return catalog.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.id) - rank(b.m.id) || a.i - b.i)
      .map(({ m }) => ({ id: m.id, label: m.label ?? (CLAUDE_ALIASES.includes(m.id) ? cap(m.id) : m.id) }))
  }
  return (catalog ?? []).map((m) => ({ id: m.id, label: m.label ?? m.id }))
}

/** "Sonnet", "GPT-6 Luna", or the id itself when the catalog does not name it. */
export function modelLabel(agent: string, model: string, avail: Availability): string {
  return modelOptions(agent, avail).find((m) => m.id === model)?.label ?? (agent === 'claude' && CLAUDE_ALIASES.includes(model) ? cap(model) : model)
}

/** "Claude Sonnet · medium", "Codex (default model)": for people, with the catalog's display names. */
export function choiceText(c: ModelChoice | null, avail: Availability): string {
  if (!c) return 'Provider default'
  if (!c.model) return `${agentName(c.agent)} (default model)`
  return `${agentName(c.agent)} ${modelLabel(c.agent, c.model, avail)}${c.effort ? ` · ${c.effort}` : ''}`
}

/** The efforts a model takes at launch (the routing rule); empty: none (Claude Haiku). */
export const effortsFor = supportedEfforts

/** Why a model cannot run on this machine, in plain words; null when it can (or cannot be checked). */
export function unavailable(agent: string, model: string | undefined, avail: Availability): string | null {
  if (agentProblem(agent, avail)) return `${agentName(agent)} isn’t installed in Orca`
  if (model && modelProblem(agent, model, avail)) return `${agentName(agent)} doesn’t list this model`
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

/** The fallback select's value for a model and effort ("" is None), and back. */
export const pairValue = (c: ModelChoice | null): string => (c?.model ? `${c.agent}|${c.model}|${c.effort ?? ''}` : '')
export function pairFrom(value: string): ModelChoice | null {
  const [agent, model, effort] = value.split('|')
  return agent && model ? { agent, model, ...(effort ? { effort: effort as Effort } : {}) } : null
}

/** The efforts the fallback select offers per model, besides Default. */
const FALLBACK_EFFORTS: readonly Effort[] = ['low', 'medium', 'high']
export type PairGroup = { agent: string; pairs: { choice: ModelChoice; label: string }[] }
/**
 * Every model and effort pair a fallback can be: each available model at Default, low, medium and
 * high, where the model takes that effort ("Sonnet", "Sonnet · low"). Grouped by agent.
 */
export function fallbackPairs(avail: Availability): PairGroup[] {
  return agentsShown(avail).map((agent) => ({
    agent,
    pairs: modelOptions(agent, avail).flatMap((m) => {
      const takes = effortsFor(agent, m.id, avail)
      return [undefined, ...FALLBACK_EFFORTS.filter((e) => takes.includes(e))].map((effort) => ({
        choice: { agent, model: m.id, ...(effort ? { effort } : {}) } as ModelChoice,
        label: effort ? `${m.label} · ${effort}` : m.label
      }))
    })
  })).filter((g) => g.pairs.length)
}

// ---------- what each control shows and does (pure, so tests cover it without a page) ----------

export type PresetView = { builtIn: Preset[]; saved: Preset[]; /** The matching preset's id; "" is Custom. */ selected: string; /** The selected preset's id when it can be removed. */ removable: string | null }
/** The preset pop-up: built-ins, the user's saved presets, and Custom only while nothing matches. */
export function presetView(routing: RoutingSettings): PresetView {
  const all = presetsOf(routing)
  const now = matchingPreset(routing)
  return { builtIn: all.filter((p) => p.builtIn), saved: all.filter((p) => !p.builtIn), selected: now?.id ?? '', removable: now && !now.builtIn ? now.id : null }
}
/** Picking a preset: its models, the limits and saved presets as they were. */
export const pickPreset = (routing: RoutingSettings, id: string): RoutingSettings => applyPreset(routing, id)
/** Save as…: the settings with the preset saved, or the error to show next to the name field. */
export function saveNamed(routing: RoutingSettings, name: string): { ok: true; routing: RoutingSettings } | { ok: false; error: string } {
  try { return { ok: true, routing: savePreset(routing, name) } } catch (e) { return { ok: false, error: (e as Error).message } }
}

export type EffortView = { efforts: readonly Effort[]; disabled: boolean; tip: string }
/** The effort pop-up: Default plus these; off (with the reason) when the model takes none. */
export function effortView(c: ModelChoice | null, avail: Availability): EffortView {
  if (!c?.model) return { efforts: [], disabled: true, tip: 'Choose a model first: an effort applies only with one.' }
  const efforts = [...effortsFor(c.agent, c.model, avail)]
  if (!efforts.length) return { efforts, disabled: true, tip: `Orca sets no effort for ${modelLabel(c.agent, c.model, avail)}.` }
  // A saved effort the model no longer takes stays listed, so the pop-up never silently changes it.
  if (c.effort && !efforts.includes(c.effort)) efforts.push(c.effort)
  return { efforts, disabled: false, tip: 'How hard the model thinks. Default: the model’s own setting.' }
}

/** Why a picked model is dimmed, as a tooltip; null when it can run. `fallback`: the row has one. */
export function missingTip(c: ModelChoice | null, fallback: boolean, avail: Availability): string | null {
  const why = c ? unavailable(c.agent, c.model, avail) : null
  return why ? `${why}. ${fallback ? 'The fallback is used.' : 'No fallback is set.'}` : null
}
