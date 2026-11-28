// What Settings → Models lists and shows, from the worker's availability (src/model-discovery.ts).
// Pure: no DOM, so the page (src/panel/settings.ts) and tests share it.
import { addType, applyPreset, CLAUDE_ALIASES, agentProblem, EFFORTS, matchingPreset, MAX_TYPES, modelProblem, presetsOf, removeType, savePreset, SUGGESTED_TYPES, supportedEfforts, TASK_KINDS, updateType,                                                                                                                    } from '../routing.js'

export const UNKNOWN               = { agents: null, models: {} }
const cap = (s        ) => s.charAt(0).toUpperCase() + s.slice(1)
export const agentName = (agent        )         => ({ claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }                          )[agent] ?? cap(agent)

/** Installed agents in a stable order (Claude, Codex, then the rest); unknown: Claude and Codex. */
export function agentsShown(avail              )           {
  const list = avail.agents ?? ['claude', 'codex']
  const first = ['claude', 'codex'].filter((a) => list.includes(a))
  return [...first, ...list.filter((a) => !first.includes(a)).sort()]
}


const rank = (id        ) => { const i = CLAUDE_ALIASES.indexOf(id); return i < 0 ? CLAUDE_ALIASES.length : i }
/**
 * The models one agent offers, with display names: Claude's from discovery (aliases first), or the
 * four aliases when discovery could not read them; Codex's from its catalog; none for an agent that lists none.
 */
export function modelOptions(agent        , avail              )                {
  const catalog = avail.models[agent]
  if (agent === 'claude') {
    if (!catalog?.length) return CLAUDE_ALIASES.map((id) => ({ id, label: cap(id) }))
    return catalog.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.id) - rank(b.m.id) || a.i - b.i)
      .map(({ m }) => ({ id: m.id, label: m.label ?? (CLAUDE_ALIASES.includes(m.id) ? cap(m.id) : m.id) }))
  }
  return (catalog ?? []).map((m) => ({ id: m.id, label: m.label ?? m.id }))
}

/** "Sonnet", "GPT-6 Luna", or the id itself when the catalog does not name it. */
export function modelLabel(agent        , model        , avail              )         {
  return modelOptions(agent, avail).find((m) => m.id === model)?.label ?? (agent === 'claude' && CLAUDE_ALIASES.includes(model) ? cap(model) : model)
}

/** "Claude Sonnet · medium", "Codex (default model)": for people, with the catalog's display names. */
export function choiceText(c                    , avail              )         {
  if (!c) return 'Provider default'
  if (!c.model) return `${agentName(c.agent)} (default model)`
  return `${agentName(c.agent)} ${modelLabel(c.agent, c.model, avail)}${c.effort ? ` · ${c.effort}` : ''}`
}

/** The efforts a model takes at launch (the routing rule); empty: none (Claude Haiku). */
export const effortsFor = supportedEfforts

/** Why a model cannot run on this machine, in plain words; null when it can (or cannot be checked). */
export function unavailable(agent        , model                    , avail              )                {
  if (agentProblem(agent, avail)) return `${agentName(agent)} isn’t installed in Orca`
  if (model && modelProblem(agent, model, avail)) return `${agentName(agent)} doesn’t list this model`
  return null
}

// ---------- what each control shows and does (pure, so tests cover it without a page) ----------


/** The preset pop-up: built-ins, the user's saved presets, and Custom only while nothing matches. */
export function presetView(routing                 )             {
  const all = presetsOf(routing)
  const now = matchingPreset(routing)
  return { builtIn: all.filter((p) => p.builtIn), saved: all.filter((p) => !p.builtIn), selected: now?.id ?? '', removable: now && !now.builtIn ? now.id : null }
}
/** Picking a preset: its models, the saved presets as they were. */
export const pickPreset = (routing                 , id        )                  => applyPreset(routing, id)
/** Save as…: the settings with the preset saved, or the error to show next to the name field. */
export function saveNamed(routing                 , name        )                                                                        {
  try { return { ok: true, routing: savePreset(routing, name) } } catch (e) { return { ok: false, error: (e         ).message } }
}


/** The effort pop-up: Default plus these; off (with the reason) when the model takes none. */
export function effortView(c                    , avail              )             {
  if (!c?.model) return { efforts: [], disabled: true, tip: 'Choose a model first: an effort applies only with one.' }
  const efforts = [...effortsFor(c.agent, c.model, avail)]
  if (!efforts.length) return { efforts, disabled: true, tip: `Orca sets no effort for ${modelLabel(c.agent, c.model, avail)}.` }
  const tip = 'How hard the model thinks. Default: the model’s own setting.'
  if (c.effort && !efforts.includes(c.effort)) {
    // A saved effort the model does not accept: show what routing will use (nearest lower, as route() does).
    let used
    for (let i = EFFORTS.indexOf(c.effort) - 1; i >= 0 && !used; i--) if (efforts.includes(EFFORTS[i])) used = EFFORTS[i]
    used ??= EFFORTS.find((e) => efforts.includes(e))
    return { efforts, disabled: false, shown: used, tip: `${cap(c.effort)} is saved but ${modelLabel(c.agent, c.model, avail)} does not accept it, so routing uses ${used ?? 'the default effort'}. ${tip}` }
  }
  return { efforts, disabled: false, tip }
}

/** Why a picked model is dimmed, as a tooltip; null when it can run. `fallback`: the row has one. */
export function missingTip(c                    , fallback         , avail              )                {
  const why = c ? unavailable(c.agent, c.model, avail) : null
  return why ? `${why}. ${fallback ? 'The fallback is used.' : 'No fallback is set.'}` : null
}

// ---------- the routing map: one row per task, a model card and a fallback card ----------


/** Which row: a role, one of the user's task types (by id), or a difficulty. */


export const refKey = (r        )         => (r.type === 'role' ? `role:${r.role}` : r.type === 'type' ? `type:${r.id}` : `kind:${r.kind}`)
export function refFrom(key        )                {
  const at = key.indexOf(':')
  const t = key.slice(0, at), v = key.slice(at + 1)
  if (t === 'role' && (v === 'coordinator' || v === 'lead')) return { type: 'role', role: v }
  if (t === 'kind' && (TASK_KINDS                     ).includes(v)) return { type: 'kind', kind: v             }
  if (t === 'type' && v) return { type: 'type', id: v }
  return null
}
















export const ROLE_SUB                           = { coordinator: 'routes your requests', lead: 'splits and reviews work' }
export const KIND_SUB                           = { simple: 'rename, config, typo', normal: 'a change with tests', hard: 'design, debugging, data' }

/** The icon key for a type name: the suggested types have their own, any other name the generic tag. */
export function typeIcon(name        )         {
  const n = name.trim().toLowerCase()
  const at = SUGGESTED_TYPES.findIndex((t) => t.name.toLowerCase() === n)
  return at < 0 ? 'tag' : ['globe', 'image', 'doc', 'search', 'check'][at] ?? 'tag'
}

/** Every row of the map in routing order: roles, then the user's task types (matched first), then difficulty. */
export function routingRows(routing                 )               {
  const roles = (['coordinator', 'lead']         ).map((role)             => ({
    key: `role:${role}`, ref: { type: 'role', role }, section: 'roles', name: role === 'coordinator' ? 'Coordinator' : 'Lead', sub: ROLE_SUB[role], icon: role,
    model: routing[role], fallback: null, hasFallback: false
  }))
  const types = routing.types.map((t)             => ({
    key: `type:${t.id}`, ref: { type: 'type', id: t.id }, section: 'types', name: t.name, sub: t.description, icon: typeIcon(t.name),
    model: t.route.model, fallback: t.route.fallback, hasFallback: true
  }))
  const kinds = TASK_KINDS.map((kind, i)             => ({
    key: `kind:${kind}`, ref: { type: 'kind', kind }, section: 'difficulty', name: kind.charAt(0).toUpperCase() + kind.slice(1), sub: KIND_SUB[kind], icon: String(i + 1),
    model: routing.workers[kind].model, fallback: routing.workers[kind].fallback, hasFallback: true
  }))
  return [...roles, ...types, ...kinds]
}

/** The choice a card shows. */
export function slotChoice(routing                 , ref        , slot      )                     {
  const row = routingRows(routing).find((r) => r.key === refKey(ref))
  return !row ? null : slot === 'model' ? row.model : row.fallback
}

/**
 * The settings with one card changed. A task's model is never empty (only a role's can be the provider
 * default) and a role has no fallback, so those writes change nothing.
 */
export function setSlot(routing                 , ref        , slot      , choice                    )                  {
  if (ref.type === 'role') return slot === 'model' ? { ...routing, [ref.role]: choice } : routing
  const old = ref.type === 'kind' ? routing.workers[ref.kind] : routing.types.find((t) => t.id === ref.id)?.route
  if (!old || (slot === 'model' && !choice?.model)) return routing
  const next            = slot === 'model' ? { model: choice               , fallback: old.fallback } : { model: old.model, fallback: choice?.model ? choice : null }
  return ref.type === 'kind' ? { ...routing, workers: { ...routing.workers, [ref.kind]: next } } : updateType(routing, ref.id, { route: next })
}

/** A short name for the card: "Sonnet", "GPT-6 Luna", "Codex default", "Provider default". */
export function cardName(c                    , avail              )         {
  if (!c) return 'Provider default'
  return c.model ? modelLabel(c.agent, c.model, avail) : `${agentName(c.agent)} default`
}
const SHORT_EFFORT                         = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' }
/** The fallback card's text, short so it fits: "Sonnet · low", "Opus · med", or "None". */
export const fallbackText = (c                    , avail              )         => (c?.model ? `${cardName(c, avail)}${c.effort ? ` · ${SHORT_EFFORT[c.effort]}` : ''}` : 'None')

/** The effort as a small bar: `on` of `total` segments lit; null (the word "default") when no effort is set. */
export function effortBar(c                    )                                                      {
  if (!c?.model || !c.effort) return null
  return { on: EFFORTS.indexOf(c.effort) + 1, total: EFFORTS.length, label: c.effort }
}

/** Why a card is dimmed (tooltip); null when it can run. The fallback's own wording differs. */
export function cardProblem(c                    , slot      , hasFallback         , avail              )                {
  if (slot === 'model') return missingTip(c, hasFallback, avail)
  const why = c?.model ? unavailable(c.agent, c.model, avail) : null
  return why ? `${why}. This fallback can’t be used.` : null
}












/**
 * What the anchored popover lists for one card: models grouped by installed agent, the current pick
 * kept (and dimmed with its reason) when this machine does not list it, and the effort control for it.
 */
export function popoverView(routing                 , ref        , slot      , avail              )              {
  const row = routingRows(routing).find((r) => r.key === refKey(ref))
  const current = row ? (slot === 'model' ? row.model : row.fallback) : null
  const groups = agentsShown(avail)
  if (current && !groups.includes(current.agent)) groups.push(current.agent)
  const view                 = groups.map((agent) => {
    const models                 = modelOptions(agent, avail).map((m) => ({ id: m.id, label: m.label, selected: current?.agent === agent && current.model === m.id, dim: null }))
    if (current?.agent === agent && current.model && !models.some((m) => m.id === current.model)) {
      models.push({ id: current.model, label: current.model, selected: true, dim: unavailable(agent, current.model, avail) ?? `${agentName(agent)} doesn’t list this model` })
    }
    return { agent, name: agentName(agent), models }
  }).filter((g) => g.models.length)
  // A pick on an agent that is not installed dims every one of its models.
  for (const g of view) { const why = agentProblem(g.agent, avail) ? unavailable(g.agent, undefined, avail) : null; if (why) for (const m of g.models) m.dim ??= why }
  const ev = effortView(current, avail)
  const options                                    = [{ value: '', label: 'Default', selected: !current?.effort }, ...ev.efforts.map((e) => ({ value: e, label: cap(e), selected: (ev.shown ?? current?.effort) === e }))]
  const what = slot === 'model' ? 'model' : 'fallback'
  return {
    title: `${row?.name ?? ''} ${what}`.trim(),
    none: slot === 'model' ? (ref.type === 'role' ? { label: 'Provider default', selected: !current } : null) : { label: 'None', selected: !current?.model },
    groups: view,
    efforts: { options, disabled: ev.disabled, tip: ev.tip, ...(current?.effort && !ev.disabled && !ev.efforts.includes(current.effort) ? { adjusted: true } : {}) }
  }
}

/** The new pick on a model: its effort stays when the new model takes it, else Default. */
export function pickModel(routing                 , ref        , slot      , agent        , model        , avail              )                  {
  const before = slotChoice(routing, ref, slot)
  const keep = before?.effort && effortsFor(agent, model, avail).includes(before.effort) ? before.effort : undefined
  return setSlot(routing, ref, slot, { agent, model, ...(keep ? { effort: keep } : {}) })
}
/** The new effort on the card's model; '' is Default. Nothing changes with no model. */
export function pickEffort(routing                 , ref        , slot      , effort             )                  {
  const c = slotChoice(routing, ref, slot)
  if (!c?.model) return routing
  return setSlot(routing, ref, slot, { agent: c.agent, model: c.model, ...(effort ? { effort } : {}) })
}
/** "Provider default" for a role's model, "None" for a fallback. */
export const pickNone = (routing                 , ref        , slot      )                  => setSlot(routing, ref, slot, null)

// ---------- task types ----------


const attempt = (f                       )       => { try { return { ok: true, routing: f() } } catch (e) { return { ok: false, error: (e         ).message } } }

/** A new type starts on the Normal row's model and fallback: one click on its card changes them. */
export function addTaskType(routing                 , name        , description        )       {
  return attempt(() => addType(routing, name, description, structuredClone(routing.workers.normal)))
}
export const editTaskType = (routing                 , id        , name        , description        )       => attempt(() => updateType(routing, id, { name, description }))
export const removeTaskType = (routing                 , id        )                  => removeType(routing, id)
export const canAddType = (routing                 )          => routing.types.length < MAX_TYPES
/** The quick picks for "Add task type": the suggested ones not already in use. */
export const suggestedTypes = (routing                 )                                          =>
  SUGGESTED_TYPES.filter((s) => !routing.types.some((t) => t.name.trim().toLowerCase() === s.name.toLowerCase()))
// Generated by scripts/build-frames.mjs from the .ts file of the same name. Do not edit.
