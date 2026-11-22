// Parallel plans: a lead's split of one request into bounded tasks, each owning named files, with
// the dependencies between them. Pure: parsing, the checks `orca-flow plan check` prints, the
// waves (topological layers) and which tasks may start now. The orca-flow script
// (skills/orca-flow/scripts/dispatch.mjs) does the I/O: Orca tasks, routing, the capacity gate.
//
// A plan file:
//   { "title": "...", "tasks": [{ "id": "a", "title": "...", "spec": "..." | "specFile": "...",
//     "class": "standard", "risk"?, "context"?, "files": ["src/x.ts", "src/panel/"], "deps": ["b"],
//     "agent"?, "model"?, "effort"? }] }
import { EFFORTS, type ContextSize, type Effort, type Risk, type TaskClass } from './routing.ts'

export type PlanTask = {
  id: string
  title: string
  spec?: string
  specFile?: string
  class: TaskClass
  risk?: Risk
  context?: ContextSize
  /** Files, directories (a trailing `/`, or any path that is a prefix of another) and globs it owns. */
  files: string[]
  deps: string[]
  agent?: string
  model?: string
  effort?: Effort
}
export type Plan = { title: string; tasks: PlanTask[] }
export type PlanCheck = { ok: boolean; errors: string[]; warnings: string[]; waves: string[][] }
/** A plan task as Orca sees it now. */
/** `failed-start`: Orca refused to start the worker; the task is still startable (`plan next`). */
export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'failed-start'

/** More tasks than this is not a split anyone can review: error. */
export const MAX_TASKS = 8
const CLASSES: readonly TaskClass[] = ['trivial', 'standard', 'complex']

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The plan from parsed JSON, with every problem that makes it unusable. */
export function parsePlan(raw: unknown): { plan: Plan | null; errors: string[] } {
  const errors: string[] = []
  if (!isObject(raw)) return { plan: null, errors: ['the plan is not a JSON object'] }
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) return { plan: null, errors: ['the plan has no "tasks" list'] }
  const tasks: PlanTask[] = []
  raw.tasks.forEach((t, i) => {
    const at = isObject(t) && str(t.id) ? `task "${str(t.id)}"` : `task #${i + 1}`
    if (!isObject(t)) return errors.push(`${at}: not an object`)
    const id = str(t.id)
    if (!id) errors.push(`${at}: needs an "id"`)
    else if (!/^[A-Za-z0-9._-]+$/.test(id)) errors.push(`${at}: id may use letters, digits, ".", "_" and "-" only`)
    const title = str(t.title)
    if (!title) errors.push(`${at}: needs a "title" (one line: the outcome)`)
    const spec = str(t.spec)
    const specFile = str(t.specFile)
    if (!spec === !specFile) errors.push(`${at}: needs exactly one of "spec" or "specFile"`)
    const cls = t.class === undefined ? 'standard' : t.class
    if (!CLASSES.includes(cls as TaskClass)) errors.push(`${at}: "class" is trivial, standard or complex, not ${JSON.stringify(t.class)}`)
    if (t.risk !== undefined && t.risk !== 'low' && t.risk !== 'high') errors.push(`${at}: "risk" is high or low`)
    if (t.context !== undefined && t.context !== 'normal' && t.context !== 'large') errors.push(`${at}: "context" is large or normal`)
    if (t.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(t.effort)) errors.push(`${at}: "effort" is one of ${EFFORTS.join(', ')}`)
    const files = Array.isArray(t.files) ? t.files.map(str).filter((f): f is string => !!f) : []
    if (!files.length) errors.push(`${at}: names no "files" it owns (files, directories or globs)`)
    const deps = Array.isArray(t.deps) ? t.deps.map(str).filter((d): d is string => !!d) : []
    if (t.deps !== undefined && !Array.isArray(t.deps)) errors.push(`${at}: "deps" is a list of task ids`)
    tasks.push({
      id: id ?? `#${i + 1}`,
      title: title ?? '',
      ...(spec ? { spec } : {}),
      ...(specFile ? { specFile } : {}),
      class: (CLASSES.includes(cls as TaskClass) ? cls : 'standard') as TaskClass,
      ...(t.risk === 'high' || t.risk === 'low' ? { risk: t.risk } : {}),
      ...(t.context === 'large' || t.context === 'normal' ? { context: t.context } : {}),
      files: files.map(normalizePath),
      deps,
      ...(str(t.agent) ? { agent: str(t.agent) } : {}),
      ...(str(t.model) ? { model: str(t.model) } : {}),
      ...((EFFORTS as readonly unknown[]).includes(t.effort) ? { effort: t.effort as Effort } : {})
    })
  })
  return { plan: { title: str(raw.title) ?? 'plan', tasks }, errors }
}

// ---------- file ownership ----------

const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
const isGlob = (p: string) => /[*?[{]/.test(p)
const bare = (p: string) => p.replace(/\/+$/, '')
/** The directory part before the first wildcard: `src/panel/*.ts` → `src/panel/`. */
const staticDir = (g: string) => {
  const head = g.slice(0, g.search(/[*?[{]/))
  return head.slice(0, head.lastIndexOf('/') + 1)
}

function globRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` matches zero or more directories; a bare `**` anything.
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') { const end = glob.indexOf('}', i); if (end < 0) re += '\\{'; else { re += `(?:${glob.slice(i + 1, end).split(',').map(escape).join('|')})`; i = end } }
    else re += escape(c)
  }
  return new RegExp(`^${re}(?:/.*)?$`)
}
const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

/**
 * Whether two ownership entries can name the same file. A plain path owns itself and, as a
 * directory, everything under it. A glob owns what it matches. Two globs are compared by their
 * static directories only, conservatively: `src/*.ts` and `src/*.css` count as overlapping.
 */
export function overlaps(a: string, b: string): boolean {
  const [x, y] = [normalizePath(a), normalizePath(b)]
  const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)
  if (!isGlob(x) && !isGlob(y)) return under(bare(x), bare(y)) || under(bare(y), bare(x))
  if (isGlob(x) && isGlob(y)) {
    const [dx, dy] = [staticDir(x), staticDir(y)]
    return dx.startsWith(dy) || dy.startsWith(dx)
  }
  const [glob, path] = isGlob(x) ? [x, bare(y)] : [y, bare(x)]
  if (globRegex(glob).test(path)) return true
  const dir = staticDir(glob)
  // The glob lies inside the path's directory, or the path's directory inside a `**` glob.
  if (path === '' || dir.startsWith(`${path}/`)) return true
  return glob.includes('**') && (dir === '' || path.startsWith(dir))
}

/** The first entry of `a` that overlaps one of `b`, as a readable pair, or null. */
function sharedPath(a: string[], b: string[]): string | null {
  for (const x of a) for (const y of b) if (overlaps(x, y)) return x === y ? x : `${x} / ${y}`
  return null
}

// ---------- dependencies ----------

/** Topological layers: wave 1 needs nothing, wave n needs only earlier waves. Null on a cycle. */
export function waves(tasks: Pick<PlanTask, 'id' | 'deps'>[]): string[][] | null {
  const left = new Map(tasks.map((t) => [t.id, new Set(t.deps.filter((d) => tasks.some((o) => o.id === d)))]))
  const out: string[][] = []
  while (left.size) {
    const layer = [...left].filter(([, deps]) => deps.size === 0).map(([id]) => id)
    if (!layer.length) return null
    for (const id of layer) left.delete(id)
    for (const deps of left.values()) for (const id of layer) deps.delete(id)
    out.push(layer)
  }
  return out
}

/** The tasks in one cycle, for the error message. */
function cycleOf(tasks: PlanTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const start of tasks) {
    const path: string[] = []
    const walk = (id: string): string[] | null => {
      const at = path.indexOf(id)
      if (at >= 0) return [...path.slice(at), id]
      path.push(id)
      for (const d of byId.get(id)?.deps ?? []) {
        const found = byId.has(d) ? walk(d) : null
        if (found) return found
      }
      path.pop()
      return null
    }
    const found = walk(start.id)
    if (found) return found
  }
  return []
}

/** Every task `id` waits on, directly or through others. */
function ancestors(tasks: PlanTask[], id: string): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const stack = [...(byId.get(id)?.deps ?? [])]
  while (stack.length) {
    const d = stack.pop() as string
    if (seen.has(d)) continue
    seen.add(d)
    stack.push(...(byId.get(d)?.deps ?? []))
  }
  return seen
}

// ---------- check ----------

/**
 * Everything `plan check` reports. Errors: duplicate ids, unknown deps, cycles, more than
 * MAX_TASKS tasks, and two tasks that can touch the same file without one waiting for the other.
 * Warnings: likely over-splitting (all trivial; a trivial task inside another task's files).
 */
export function checkPlan(plan: Plan): PlanCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const { tasks } = plan
  if (tasks.length > MAX_TASKS) errors.push(`${tasks.length} tasks: at most ${MAX_TASKS}. Merge small tasks, or plan the rest after this round.`)
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`task id "${t.id}" is used twice`)
    ids.add(t.id)
  }
  for (const t of tasks) {
    for (const d of t.deps) {
      if (d === t.id) errors.push(`task "${t.id}" depends on itself`)
      else if (!ids.has(d)) errors.push(`task "${t.id}" depends on "${d}", which is not in the plan`)
    }
  }
  const layers = waves(tasks)
  if (!layers) errors.push(`dependency cycle: ${cycleOf(tasks).join(' → ')}`)
  else {
    const before = new Map(tasks.map((t) => [t.id, ancestors(tasks, t.id)]))
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const [a, b] = [tasks[i], tasks[j]]
        const shared = sharedPath(a.files, b.files)
        if (!shared || before.get(a.id)?.has(b.id) || before.get(b.id)?.has(a.id)) continue
        errors.push(`tasks "${a.id}" and "${b.id}" both own ${shared} and neither waits for the other: chain them (deps) or merge them`)
      }
    }
  }
  if (tasks.length > 1 && tasks.every((t) => t.class === 'trivial')) {
    warnings.push(`every task is trivial: one worker can do them all; merge them into one task`)
  }
  for (const t of tasks) {
    if (t.class !== 'trivial') continue
    const host = tasks.find((o) => o !== t && t.files.every((f) => o.files.some((g) => covers(g, f))))
    if (host) warnings.push(`trivial task "${t.id}" only touches files "${host.id}" owns: merge it into "${host.id}"`)
  }
  return { ok: errors.length === 0, errors, warnings, waves: layers ?? [] }
}

/** Whether ownership entry `outer` includes all of `inner` (same path, inside its directory, or matched). */
function covers(outer: string, inner: string): boolean {
  const [o, i] = [normalizePath(outer), normalizePath(inner)]
  if (isGlob(i)) return isGlob(o) ? o === i : i.startsWith(`${bare(o)}/`)
  if (isGlob(o)) return globRegex(o).test(bare(i))
  return bare(i) === bare(o) || bare(i).startsWith(`${bare(o)}/`)
}

// ---------- scheduling ----------

/**
 * The tasks to start now, in wave order: queued, every dependency done, and no more than
 * `maxParallel` of this plan running at once. Failed dependencies hold their dependents back.
 */
export function startable(plan: Plan, states: Record<string, TaskState>, maxParallel: number): string[] {
  const running = plan.tasks.filter((t) => states[t.id] === 'running').length
  const slots = Math.max(0, maxParallel - running)
  const order = (waves(plan.tasks) ?? []).flat()
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  return order
    .filter((id) => ['queued', 'failed-start'].includes(states[id] ?? 'queued') && (byId.get(id)?.deps ?? []).every((d) => states[d] === 'done'))
    .slice(0, slots)
}

/** A file-name-safe slug for the plan's state file. */
export function planSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan'
}

/** What the worker is told beyond its spec: the files it owns and what the others own. */
export function ownershipNote(plan: Plan, id: string): string {
  const me = plan.tasks.find((t) => t.id === id)
  if (!me) return ''
  const others = plan.tasks.filter((t) => t.id !== id)
  const lines = [`Plan "${plan.title}", task ${id}. Files you own (edit only these): ${me.files.join(', ')}.`]
  if (others.length) lines.push(`Other tasks own: ${others.map((t) => `${t.files.join(', ')} (${t.id})`).join('; ')}. Ask before touching those.`)
  return lines.join('\n')
}
