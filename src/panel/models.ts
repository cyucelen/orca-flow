// What Settings → Models lists and shows, from the worker's availability (src/model-discovery.ts).
// Pure: no DOM, so the page (src/panel/settings.ts) and tests share it.
import { addType, applyPreset, CLAUDE_ALIASES, agentProblem, EFFORTS, matchingPreset, MAX_TYPES, modelProblem, presetsOf, removeType, savePreset, SUGGESTED_TYPES, supportedEfforts, TASK_KINDS, updateType, type Availability, type Effort, type KindRoute, type ModelChoice, type Preset, type RoutingSettings, type TaskKind } from '../routing.ts'

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

// ---------- what each control shows and does (pure, so tests cover it without a page) ----------

export type PresetView = { builtIn: Preset[]; saved: Preset[]; /** The matching preset's id; "" is Custom. */ selected: string; /** The selected preset's id when it can be removed. */ removable: string | null }
/** The preset pop-up: built-ins, the user's saved presets, and Custom only while nothing matches. */
export function presetView(routing: RoutingSettings): PresetView {
  const all = presetsOf(routing)
  const now = matchingPreset(routing)
  return { builtIn: all.filter((p) => p.builtIn), saved: all.filter((p) => !p.builtIn), selected: now?.id ?? '', removable: now && !now.builtIn ? now.id : null }
}
/** Picking a preset: its models, the saved presets as they were. */
export const pickPreset = (routing: RoutingSettings, id: string): RoutingSettings => applyPreset(routing, id)
/** Save as…: the settings with the preset saved, or the error to show next to the name field. */
export function saveNamed(routing: RoutingSettings, name: string): { ok: true; routing: RoutingSettings } | { ok: false; error: string } {
  try { return { ok: true, routing: savePreset(routing, name) } } catch (e) { return { ok: false, error: (e as Error).message } }
}

export type EffortView = { efforts: readonly Effort[]; disabled: boolean; tip: string; /** The effort routing will use when the saved one is not accepted. */ shown?: Effort }
/** The effort pop-up: Default plus these; off (with the reason) when the model takes none. */
export function effortView(c: ModelChoice | null, avail: Availability): EffortView {
  if (!c?.model) return { efforts: [], disabled: true, tip: 'Choose a model first: an effort applies only with one.' }
  const efforts = [...effortsFor(c.agent, c.model, avail)]
  if (!efforts.length) return { efforts, disabled: true, tip: `Orca sets no effort for ${modelLabel(c.agent, c.model, avail)}.` }
  const tip = 'How hard the model thinks. Default: the model’s own setting.'
  if (c.effort && !efforts.includes(c.effort)) {
    // A saved effort the model does not accept: show what routing will use (nearest lower, as route() does).
    let used: Effort | undefined
    for (let i = EFFORTS.indexOf(c.effort) - 1; i >= 0 && !used; i--) if (efforts.includes(EFFORTS[i])) used = EFFORTS[i]
    used ??= EFFORTS.find((e) => efforts.includes(e))
    return { efforts, disabled: false, shown: used, tip: `${cap(c.effort)} is saved but ${modelLabel(c.agent, c.model, avail)} does not accept it, so routing uses ${used ?? 'the default effort'}. ${tip}` }
  }
  return { efforts, disabled: false, tip }
}

/** Why a picked model is dimmed, as a tooltip; null when it can run. `fallback`: the row has one. */
export function missingTip(c: ModelChoice | null, fallback: boolean, avail: Availability): string | null {
  const why = c ? unavailable(c.agent, c.model, avail) : null
  return why ? `${why}. ${fallback ? 'The fallback is used.' : 'No fallback is set.'}` : null
}

// ---------- the routing map: one row per task, a model card and a fallback card ----------

export type RoleName = 'coordinator' | 'lead'
/** Which row: a role, one of the user's task types (by id), or a difficulty. */
export type RowRef = { type: 'role'; role: RoleName } | { type: 'type'; id: string } | { type: 'kind'; kind: TaskKind }
export type Slot = 'model' | 'fallback'
export const refKey = (r: RowRef): string => (r.type === 'role' ? `role:${r.role}` : r.type === 'type' ? `type:${r.id}` : `kind:${r.kind}`)
export function refFrom(key: string): RowRef | null {
  const at = key.indexOf(':')
  const t = key.slice(0, at), v = key.slice(at + 1)
  if (t === 'role' && (v === 'coordinator' || v === 'lead')) return { type: 'role', role: v }
  if (t === 'kind' && (TASK_KINDS as readonly string[]).includes(v)) return { type: 'kind', kind: v as TaskKind }
  if (t === 'type' && v) return { type: 'type', id: v }
  return null
}

export type RowSection = 'roles' | 'types' | 'difficulty'
export type RoutingRow = {
  key: string
  ref: RowRef
  section: RowSection
  name: string
  sub: string
  /** Which glyph and tint the row's tile wears: coordinator, lead, a type's icon key, or a difficulty's number. */
  icon: string
  model: ModelChoice | null
  fallback: ModelChoice | null
  /** Roles have no fallback: an unavailable pick uses the provider's default model. */
  hasFallback: boolean
}

export const ROLE_SUB: Record<RoleName, string> = { coordinator: 'routes your requests', lead: 'splits and reviews work' }
export const KIND_SUB: Record<TaskKind, string> = { simple: 'rename, config, typo', normal: 'a change with tests', hard: 'design, debugging, data' }

/** The icon key for a type name: the suggested types have their own, any other name the generic tag. */
export function typeIcon(name: string): string {
  const n = name.trim().toLowerCase()
  const at = SUGGESTED_TYPES.findIndex((t) => t.name.toLowerCase() === n)
  return at < 0 ? 'tag' : ['globe', 'image', 'doc', 'search', 'check'][at] ?? 'tag'
}

/** Every row of the map in routing order: roles, then the user's task types (matched first), then difficulty. */
export function routingRows(routing: RoutingSettings): RoutingRow[] {
  const roles = (['coordinator', 'lead'] as const).map((role): RoutingRow => ({
    key: `role:${role}`, ref: { type: 'role', role }, section: 'roles', name: role === 'coordinator' ? 'Coordinator' : 'Lead', sub: ROLE_SUB[role], icon: role,
    model: routing[role], fallback: null, hasFallback: false
  }))
  const types = routing.types.map((t): RoutingRow => ({
    key: `type:${t.id}`, ref: { type: 'type', id: t.id }, section: 'types', name: t.name, sub: t.description, icon: typeIcon(t.name),
    model: t.route.model, fallback: t.route.fallback, hasFallback: true
  }))
  const kinds = TASK_KINDS.map((kind, i): RoutingRow => ({
    key: `kind:${kind}`, ref: { type: 'kind', kind }, section: 'difficulty', name: kind.charAt(0).toUpperCase() + kind.slice(1), sub: KIND_SUB[kind], icon: String(i + 1),
    model: routing.workers[kind].model, fallback: routing.workers[kind].fallback, hasFallback: true
  }))
  return [...roles, ...types, ...kinds]
}

/** The choice a card shows. */
export function slotChoice(routing: RoutingSettings, ref: RowRef, slot: Slot): ModelChoice | null {
  const row = routingRows(routing).find((r) => r.key === refKey(ref))
  return !row ? null : slot === 'model' ? row.model : row.fallback
}

/**
 * The settings with one card changed. A task's model is never empty (only a role's can be the provider
 * default) and a role has no fallback, so those writes change nothing.
 */
export function setSlot(routing: RoutingSettings, ref: RowRef, slot: Slot, choice: ModelChoice | null): RoutingSettings {
  if (ref.type === 'role') return slot === 'model' ? { ...routing, [ref.role]: choice } : routing
  const old = ref.type === 'kind' ? routing.workers[ref.kind] : routing.types.find((t) => t.id === ref.id)?.route
  if (!old || (slot === 'model' && !choice?.model)) return routing
  const next: KindRoute = slot === 'model' ? { model: choice as ModelChoice, fallback: old.fallback } : { model: old.model, fallback: choice?.model ? choice : null }
  return ref.type === 'kind' ? { ...routing, workers: { ...routing.workers, [ref.kind]: next } } : updateType(routing, ref.id, { route: next })
}

/** A short name for the card: "Sonnet", "GPT-6 Luna", "Codex default", "Provider default". */
export function cardName(c: ModelChoice | null, avail: Availability): string {
  if (!c) return 'Provider default'
  return c.model ? modelLabel(c.agent, c.model, avail) : `${agentName(c.agent)} default`
}
const SHORT_EFFORT: Record<Effort, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' }
/** The fallback card's text, short so it fits: "Sonnet · low", "Opus · med", or "None". */
export const fallbackText = (c: ModelChoice | null, avail: Availability): string => (c?.model ? `${cardName(c, avail)}${c.effort ? ` · ${SHORT_EFFORT[c.effort]}` : ''}` : 'None')

/** The effort as a small bar: `on` of `total` segments lit; null (the word "default") when no effort is set. */
export function effortBar(c: ModelChoice | null): { on: number; total: number; label: string } | null {
  if (!c?.model || !c.effort) return null
  return { on: EFFORTS.indexOf(c.effort) + 1, total: EFFORTS.length, label: c.effort }
}

/** Why a card is dimmed (tooltip); null when it can run. The fallback's own wording differs. */
export function cardProblem(c: ModelChoice | null, slot: Slot, hasFallback: boolean, avail: Availability): string | null {
  if (slot === 'model') return missingTip(c, hasFallback, avail)
  const why = c?.model ? unavailable(c.agent, c.model, avail) : null
  return why ? `${why}. This fallback can’t be used.` : null
}

export type PopoverModel = { id: string; label: string; selected: boolean; /** Why it is dimmed; null when it can run. */ dim: string | null }
export type PopoverGroup = { agent: string; name: string; models: PopoverModel[] }
export type PopoverView = {
  title: string
  /** "Provider default" (a role's model) or "None" (a fallback), first in the list; null for a task's model. */
  none: { label: string; selected: boolean } | null
  groups: PopoverGroup[]
  /** Default, then the efforts the model takes that Orca accepts. Disabled (with the reason) when it takes none. */
  efforts: { options: { value: Effort | ''; label: string; selected: boolean }[]; disabled: boolean; tip: string; /** True when the saved effort is not accepted and the selected one is what routing uses. */ adjusted?: boolean }
}

/**
 * What the anchored popover lists for one card: models grouped by installed agent, the current pick
 * kept (and dimmed with its reason) when this machine does not list it, and the effort control for it.
 */
export function popoverView(routing: RoutingSettings, ref: RowRef, slot: Slot, avail: Availability): PopoverView {
  const row = routingRows(routing).find((r) => r.key === refKey(ref))
  const current = row ? (slot === 'model' ? row.model : row.fallback) : null
  const groups = agentsShown(avail)
  if (current && !groups.includes(current.agent)) groups.push(current.agent)
  const view: PopoverGroup[] = groups.map((agent) => {
    const models: PopoverModel[] = modelOptions(agent, avail).map((m) => ({ id: m.id, label: m.label, selected: current?.agent === agent && current.model === m.id, dim: null }))
    if (current?.agent === agent && current.model && !models.some((m) => m.id === current.model)) {
      models.push({ id: current.model, label: current.model, selected: true, dim: unavailable(agent, current.model, avail) ?? `${agentName(agent)} doesn’t list this model` })
    }
    return { agent, name: agentName(agent), models }
  }).filter((g) => g.models.length)
  // A pick on an agent that is not installed dims every one of its models.
  for (const g of view) { const why = agentProblem(g.agent, avail) ? unavailable(g.agent, undefined, avail) : null; if (why) for (const m of g.models) m.dim ??= why }
  const ev = effortView(current, avail)
  const options: PopoverView['efforts']['options'] = [{ value: '', label: 'Default', selected: !current?.effort }, ...ev.efforts.map((e) => ({ value: e, label: cap(e), selected: (ev.shown ?? current?.effort) === e }))]
  const what = slot === 'model' ? 'model' : 'fallback'
  return {
    title: `${row?.name ?? ''} ${what}`.trim(),
    none: slot === 'model' ? (ref.type === 'role' ? { label: 'Provider default', selected: !current } : null) : { label: 'None', selected: !current?.model },
    groups: view,
    efforts: { options, disabled: ev.disabled, tip: ev.tip, ...(current?.effort && !ev.disabled && !ev.efforts.includes(current.effort) ? { adjusted: true } : {}) }
  }
}

/** The new pick on a model: its effort stays when the new model takes it, else Default. */
export function pickModel(routing: RoutingSettings, ref: RowRef, slot: Slot, agent: string, model: string, avail: Availability): RoutingSettings {
  const before = slotChoice(routing, ref, slot)
  const keep = before?.effort && effortsFor(agent, model, avail).includes(before.effort) ? before.effort : undefined
  return setSlot(routing, ref, slot, { agent, model, ...(keep ? { effort: keep } : {}) })
}
/** The new effort on the card's model; '' is Default. Nothing changes with no model. */
export function pickEffort(routing: RoutingSettings, ref: RowRef, slot: Slot, effort: Effort | ''): RoutingSettings {
  const c = slotChoice(routing, ref, slot)
  if (!c?.model) return routing
  return setSlot(routing, ref, slot, { agent: c.agent, model: c.model, ...(effort ? { effort } : {}) })
}
/** "Provider default" for a role's model, "None" for a fallback. */
export const pickNone = (routing: RoutingSettings, ref: RowRef, slot: Slot): RoutingSettings => setSlot(routing, ref, slot, null)

// ---------- task types ----------

export type Edit = { ok: true; routing: RoutingSettings } | { ok: false; error: string }
const attempt = (f: () => RoutingSettings): Edit => { try { return { ok: true, routing: f() } } catch (e) { return { ok: false, error: (e as Error).message } } }

/** A new type starts on the Normal row's model and fallback: one click on its card changes them. */
export function addTaskType(routing: RoutingSettings, name: string, description: string): Edit {
  return attempt(() => addType(routing, name, description, structuredClone(routing.workers.normal)))
}
export const editTaskType = (routing: RoutingSettings, id: string, name: string, description: string): Edit => attempt(() => updateType(routing, id, { name, description }))
export const removeTaskType = (routing: RoutingSettings, id: string): RoutingSettings => removeType(routing, id)
export const canAddType = (routing: RoutingSettings): boolean => routing.types.length < MAX_TYPES
/** The quick picks for "Add task type": the suggested ones not already in use. */
export const suggestedTypes = (routing: RoutingSettings): { name: string; description: string }[] =>
  SUGGESTED_TYPES.filter((s) => !routing.types.some((t) => t.name.trim().toLowerCase() === s.name.toLowerCase()))
