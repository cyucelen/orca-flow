// Goals: what the user needs to get done, kept by the user and by agents. One JSON file per goal in
// <ORCA_FLOW_DIR>/goals/<id>.json, so the panel and an agent editing different goals never clobber
// each other. Every change reads the goal's file, changes it and writes it back through a temp file
// and a rename, so a reader never sees half a file. Both the `orca-flow goal` CLI and the plugin
// worker import this module. No dependencies.
//
// A goal: { id, title, note?, next?, doneWhen?, steps: [{ text, done }],
//           links: { linear: ['DES-340'], worktrees: [{ key?, path?, name?, worktreeId? }] },
//           status: 'open' | 'proposed' | 'done', createdAt, updatedAt, doneAt?,
//           lastChange: { by, field, at } }
// `by` is "you" for the user in the panel, else the agent's role or worktree name. Agents only
// propose done; the user confirms (done). Step references are a 1-based number or a piece of text.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const GOALS_DIR = 'goals'
export const STATUSES = ['open', 'proposed', 'done']
const TEXT_FIELDS = ['title', 'note', 'next', 'doneWhen']

const flowDir = (env = process.env) => env.ORCA_FLOW_DIR || join(homedir(), '.orca-flow')
const goalsDir = (data) => join(data ?? flowDir(), GOALS_DIR)
const fileOf = (data, id) => join(goalsDir(data), `${id}.json`)
/**
 * Settings → Features → Goals: on only when config.json says features.goals is exactly true (the plugin reads it
 * the same way, src/settings.ts normalizeFeatures). Absent, broken or anything else: off.
 */
export function goalsEnabled({ data, env = process.env } = {}) {
  try {
    return JSON.parse(readFileSync(join(data ?? flowDir(env), 'config.json'), 'utf8'))?.features?.goals === true
  } catch {
    return false
  }
}
export const GOALS_OFF = 'Goals is off (Orca Flow Settings → Features); nothing changed.'

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const clean = (s) => String(s ?? '').trim()

function valid(g) {
  return isObject(g) && typeof g.id === 'string' && /^[A-Za-z0-9._-]+$/.test(g.id) && typeof g.title === 'string' && STATUSES.includes(g.status)
}

/** Fills the optional parts, so readers can rely on steps and links. */
function normalize(g) {
  return {
    ...g,
    steps: Array.isArray(g.steps) ? g.steps.filter((s) => isObject(s) && typeof s.text === 'string').map((s) => ({ text: s.text, done: !!s.done })) : [],
    links: {
      linear: Array.isArray(g.links?.linear) ? g.links.linear.filter((x) => typeof x === 'string') : [],
      worktrees: Array.isArray(g.links?.worktrees) ? g.links.worktrees.filter(isObject) : []
    }
  }
}

function readGoal(data, id) {
  try {
    const g = JSON.parse(readFileSync(fileOf(data, id), 'utf8'))
    return valid(g) ? normalize(g) : null
  } catch {
    return null
  }
}

function writeGoal(data, goal) {
  const dir = goalsDir(data)
  mkdirSync(dir, { recursive: true })
  const path = fileOf(data, goal.id)
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(goal, null, 2)}\n`)
  try {
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

function ids(data) {
  try {
    return readdirSync(goalsDir(data)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
  } catch {
    return []
  }
}

/** Open first (oldest first), then proposed, then done (newest first). Broken files are skipped. */
export function list({ data, status } = {}) {
  const all = ids(data).map((id) => readGoal(data, id)).filter(Boolean)
  const rank = { open: 0, proposed: 1, done: 2 }
  all.sort((a, b) => rank[a.status] - rank[b.status] || (a.status === 'done' ? (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt) || b.createdAt - a.createdAt : a.createdAt - b.createdAt))
  return status ? all.filter((g) => g.status === status) : all
}

/** A goal by its id, or by an unambiguous start of it; null when there is none. */
export function get(id, { data } = {}) {
  const want = clean(id)
  if (!want) return null
  const exact = readGoal(data, want)
  if (exact) return exact
  const hits = ids(data).filter((i) => i.startsWith(want) || i.startsWith(`g_${want}`))
  if (hits.length > 1) throw new Error(`"${want}" matches ${hits.length} goals (${hits.join(', ')}); use the whole id`)
  return hits.length ? readGoal(data, hits[0]) : null
}

function need(id, data) {
  const g = get(id, { data })
  if (!g) throw new Error(`no goal "${id}" (orca-flow goal list --all shows them)`)
  return g
}

const slug = (title) => clean(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 3).join('-').slice(0, 24).replace(/-+$/, '')

function newId(title, data) {
  for (;;) {
    const id = `g_${slug(title) || 'goal'}-${randomBytes(2).toString('hex')}`
    if (!existsSync(fileOf(data, id))) return id
  }
}

const stamp = (goal, by, field, at = Date.now()) => ({ ...goal, updatedAt: at, lastChange: { by: clean(by) || 'an agent', field, at } })

const textOf = (v) => {
  const t = clean(v)
  return t || undefined
}

/**
 * Adds a goal. Only the title is required. fields: note, next, doneWhen, steps (strings or
 * { text, done }), linear (ids), worktrees (link objects).
 */
export function add(title, fields = {}, { data, by = 'you', now = Date.now() } = {}) {
  const t = clean(title)
  if (!t) throw new Error('a goal needs a title')
  const steps = (fields.steps ?? []).map((s) => (typeof s === 'string' ? { text: clean(s), done: false } : { text: clean(s.text), done: !!s.done })).filter((s) => s.text)
  const goal = stamp(
    {
      id: newId(t, data),
      title: t,
      ...(textOf(fields.note) && { note: textOf(fields.note) }),
      ...(textOf(fields.next) && { next: textOf(fields.next) }),
      ...(textOf(fields.doneWhen) && { doneWhen: textOf(fields.doneWhen) }),
      steps,
      links: { linear: [...new Set((fields.linear ?? []).map((x) => clean(x).toUpperCase()).filter(Boolean))], worktrees: (fields.worktrees ?? []).filter(isObject) },
      status: 'open',
      createdAt: now
    },
    by,
    'created',
    now
  )
  writeGoal(data, goal)
  return goal
}

/** Changes title, note, next or doneWhen ('' clears note, next, doneWhen). */
export function update(id, patch, by, { data } = {}) {
  const g = need(id, data)
  const changed = []
  const next = { ...g }
  for (const f of TEXT_FIELDS) {
    if (patch[f] === undefined) continue
    const v = clean(patch[f])
    if (f === 'title' && !v) throw new Error('a goal needs a title')
    if (v === (g[f] ?? '')) continue
    if (v) next[f] = v
    else delete next[f]
    changed.push(f)
  }
  if (!changed.length) return g
  const out = stamp(next, by, changed.join(','))
  writeGoal(data, out)
  return out
}

/** The index of a step: a 1-based number, or text that matches one step (exact, else a piece of it). */
function stepIndex(g, ref) {
  const n = typeof ref === 'number' ? ref : /^\d+$/.test(String(ref).trim()) ? Number(ref) : null
  if (n !== null) {
    if (n < 1 || n > g.steps.length) throw new Error(`goal ${g.id} has ${g.steps.length} step${g.steps.length === 1 ? '' : 's'}; no step ${n}`)
    return n - 1
  }
  const q = clean(ref).toLowerCase()
  const exact = g.steps.map((s, i) => (s.text.toLowerCase() === q ? i : -1)).filter((i) => i >= 0)
  const hits = exact.length ? exact : g.steps.map((s, i) => (s.text.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0)
  if (!q || !hits.length) throw new Error(`no step matches "${ref}" in goal ${g.id}`)
  if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} steps in goal ${g.id}; use its number`)
  return hits[0]
}

/** Ticks (done = true) or unticks a step, by 1-based number or text. */
export function setStep(id, ref, done, by, { data } = {}) {
  const g = need(id, data)
  const i = stepIndex(g, ref)
  if (g.steps[i].done === !!done) return g
  const out = stamp({ ...g, steps: g.steps.map((s, j) => (j === i ? { ...s, done: !!done } : s)) }, by, 'steps')
  writeGoal(data, out)
  return out
}

export const tick = (id, ref, by, opts) => setStep(id, ref, true, by, opts)

export function addStep(id, text, by, { data } = {}) {
  const g = need(id, data)
  const t = clean(text)
  if (!t) throw new Error('a step needs text')
  const out = stamp({ ...g, steps: [...g.steps, { text: t, done: false }] }, by, 'steps')
  writeGoal(data, out)
  return out
}

const sameWorktree = (a, b) => (a.key && b.key && a.key === b.key) || (a.path && b.path && a.path === b.path) || (a.worktreeId && b.worktreeId && a.worktreeId === b.worktreeId)

/** Links a Linear issue (link.linear: 'DES-340') or a worktree (link.worktree: { key, path, name, worktreeId }). */
export function link(id, link, by, { data } = {}) {
  const g = need(id, data)
  const out = { ...g, links: { linear: [...g.links.linear], worktrees: [...g.links.worktrees] } }
  if (link.linear) {
    const l = clean(link.linear).toUpperCase()
    if (g.links.linear.includes(l)) return g
    out.links.linear.push(l)
  } else if (link.worktree) {
    if (g.links.worktrees.some((w) => sameWorktree(w, link.worktree))) return g
    out.links.worktrees.push(link.worktree)
  } else throw new Error('link needs a Linear id or a worktree')
  const done = stamp(out, by, 'links')
  writeGoal(data, done)
  return done
}

export function unlink(id, link, by, { data } = {}) {
  const g = need(id, data)
  const out = { ...g, links: { linear: [...g.links.linear], worktrees: [...g.links.worktrees] } }
  if (link.linear) out.links.linear = g.links.linear.filter((x) => x !== clean(link.linear).toUpperCase())
  else if (link.worktree) out.links.worktrees = g.links.worktrees.filter((w) => !sameWorktree(w, link.worktree))
  else throw new Error('unlink needs a Linear id or a worktree')
  if (out.links.linear.length === g.links.linear.length && out.links.worktrees.length === g.links.worktrees.length) return g
  const done = stamp(out, by, 'links')
  writeGoal(data, done)
  return done
}

/** Goals that are not done and link a worktree, matched by identity key, path or Orca id. */
export function forWorktree(worktree, { data, all = false } = {}) {
  const w = typeof worktree === 'string' ? { path: worktree, key: worktree, worktreeId: worktree } : worktree
  return list({ data }).filter((g) => (all || g.status !== 'done') && g.links.worktrees.some((x) => sameWorktree(x, w)))
}

function setStatus(id, status, by, data, { from, now = Date.now() } = {}) {
  const g = need(id, data)
  if (g.status === status) return g
  if (from && !from.includes(g.status)) throw new Error(`goal ${g.id} is ${g.status}; ${status === 'proposed' ? 'only an open goal can be proposed done' : 'it cannot move to ' + status}`)
  const { doneAt, ...rest } = g
  const out = stamp({ ...rest, status, ...(status === 'done' && { doneAt: now }) }, by, 'status', now)
  writeGoal(data, out)
  return out
}

/** An agent says the goal is done; the user confirms with done(), or sends it back with reopen(). */
export const propose = (id, by, { data } = {}) => setStatus(id, 'proposed', by, data, { from: ['open'] })
/** Only on the user's word. */
export const done = (id, by, { data } = {}) => setStatus(id, 'done', by, data)
export const reopen = (id, by, { data } = {}) => setStatus(id, 'open', by, data)
