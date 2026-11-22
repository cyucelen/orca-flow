// orca-flow route | dispatch | plan: start leads and workers on the routed model, behind the memory
// gate, and run a lead's parallel plan. orca-flow.mjs wires the real Orca CLI, model discovery and
// capacity in; tests pass fakes (`deps`), so nothing here starts a real worker under test.
//
// The routing decision is src/routing.ts and the plan checks src/plan.ts (Node strips their types).
// Every start appends one line to ~/.orca-flow/routes.jsonl:
//   {at, role, taskId, dispatchId, workspace, choice, source, reason, class, risk, attempt}
// The sidebar reads it to show the model on each row; `--retry-of` reads it to escalate.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const routing = await import(new URL('../../../src/routing.ts', import.meta.url).href)
const planLib = await import(new URL('../../../src/plan.ts', import.meta.url).href)

/** worker-start flags `dispatch` passes through unchanged. Routing flags are not among them. */
const PASSTHROUGH = ['worktree', 'task', 'task-title', 'spec', 'spec-file', 'repo', 'name', 'base-branch', 'display-name', 'comment', 'setup', 'deps', 'parent', 'run', 'retry-of']
const BOOLEAN_PASSTHROUGH = ['keep-open']
const NEW_WORKTREE = ['new-top-level', 'new-child']

export class UsageError extends Error {}
/** An error with the exit code main() uses: 2 capacity said no, 3 routing found no model. */
export class Refused extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

// ---------- real I/O (orca-flow.mjs builds deps from these) ----------

/** `orca <args> --json`, resolving to `result`; `input` goes to stdin (for `--spec-file -`). */
export function orcaRunner(bin, { timeoutMs = 300_000 } = {}) {
  return (args, { input } = {}) =>
    new Promise((res, rej) => {
      const child = execFile(bin, [...args, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
        let parsed
        try {
          parsed = JSON.parse(stdout)
        } catch {}
        if (parsed?.ok) return res(parsed.result)
        const e = new Error(parsed?.error?.message ?? (String(stderr).trim() || err?.message || `orca ${args.join(' ')} failed`))
        e.data = parsed?.error?.data
        rej(e)
      })
      child.stdin?.end(input ?? '')
    })
}

/** The Exec src/model-discovery.ts takes: stdout, or a rejection on failure. */
export function execCommand(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: opts.timeoutMs ?? 10_000, env: opts.env ? { ...process.env, ...opts.env } : process.env }, (err, stdout) =>
      err ? rej(err) : res(stdout)
    )
  })
}

// ---------- shared ----------

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

export const readRouting = (dir) => routing.normalizeRouting(readJson(join(dir, 'config.json'), {})?.routing)

const ROUTES = (dir) => join(dir, 'routes.jsonl')

export function readRoutes(dir) {
  try {
    return readFileSync(ROUTES(dir), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

function appendRoute(dir, entry) {
  mkdirSync(dir, { recursive: true })
  appendFileSync(ROUTES(dir), `${JSON.stringify(entry)}\n`)
}

/** The routes.jsonl line for one start; the settings UI reads these exact field names. */
function routeEntry({ at, role, receipt, decision, req }) {
  return {
    at,
    role,
    taskId: receipt?.taskId ?? null,
    dispatchId: receipt?.dispatchId ?? null,
    workspace: receipt?.workspace ?? null,
    choice: decision.choice,
    source: decision.source,
    reason: decision.reason,
    class: req.taskClass ?? null,
    risk: req.risk ?? null,
    attempt: req.attempt ?? 0
  }
}

const ROLES = ['coordinator', 'lead', 'worker']
const CLASSES = ['trivial', 'standard', 'complex']

/** The RouteRequest from command-line flags; refuses values routing would not understand. */
export function routeRequest(args, roles = ROLES) {
  const role = args.role
  if (!roles.includes(role)) throw new UsageError(`--role is ${roles.join(' or ')}`)
  const req = { role }
  if (args.class !== undefined) {
    if (!CLASSES.includes(args.class)) throw new UsageError('--class is trivial, standard or complex')
    req.taskClass = args.class
  }
  if (args.risk !== undefined) {
    if (args.risk !== 'high' && args.risk !== 'low') throw new UsageError('--risk is high (or low)')
    req.risk = args.risk
  }
  if (args.context !== undefined) {
    if (args.context !== 'large' && args.context !== 'normal') throw new UsageError('--context is large (or normal)')
    req.context = args.context
  }
  if (args.attempt !== undefined) {
    const n = Number(args.attempt)
    if (!Number.isInteger(n) || n < 0) throw new UsageError('--attempt is a whole number: 0 first try, n after n failures')
    req.attempt = n
  }
  for (const k of ['agent', 'model']) {
    if (args[k] === true) throw new UsageError(`--${k} needs a value`)
    if (args[k] !== undefined) req[k] = args[k]
  }
  if (args.effort !== undefined) {
    if (!routing.EFFORTS.includes(args.effort)) throw new UsageError(`--effort is one of ${routing.EFFORTS.join(', ')}`)
    req.effort = args.effort
  }
  return req
}

const label = (decision) => routing.choiceLabel(decision.choice)

export function formatDecision(decision, { explain = false } = {}) {
  const lines = decision.ok
    ? [`${label(decision)} (${decision.source})`, `  why: ${decision.reason}`, `  flags: ${routing.launchArgs(decision.choice).join(' ')}`]
    : [`no model: ${decision.error}`]
  if (explain) {
    lines.push(decision.skipped.length ? '  passed over:' : '  passed over: none')
    for (const s of decision.skipped) lines.push(`    ${s.candidate}: ${s.why}`)
  }
  return lines.join('\n')
}

/** A shell-safe rendering of a command line, for --dry-run. */
export const shellLine = (argv) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' ')

/** Whether the gate lets this start through: `ok`, or `agents-only` when no new worktree is made. */
export function capacityAllows(verdict, newWorktree) {
  return verdict === 'ok' || (verdict === 'agents-only' && !newWorktree)
}

const VERDICT_WORDS = {
  'agents-only': 'another agent fits in an existing worktree, a new worktree does not',
  full: 'not even another agent fits in memory',
  pressure: 'macOS reports critical memory pressure'
}

function refusal(cap, { newWorktree, taskId, title }) {
  const why = VERDICT_WORDS[cap.verdict] ?? cap.verdict
  const free = cap.freeGB === null || cap.freeGB === undefined ? '' : ` (${cap.freeGB} GB free after the margin)`
  const lines = [`Not started: capacity says ${cap.verdict}${free}: ${why}.`]
  if (newWorktree && cap.verdict === 'agents-only') lines.push('An existing worktree has room: start it there (--worktree <selector>), or queue it.')
  if (taskId) lines.push(`It stays queued as ${taskId}; start it with the same command when \`orca-flow capacity\` allows.`)
  else
    lines.push(
      `Queue it: orca orchestration task-create --task-title ${shellLine([title ?? '<outcome>'])} --spec-file -`,
      'It shows in `orca orchestration task-list --ready`; start it with `orca-flow dispatch --task <id> ...` when a slot frees.'
    )
  const top = cap.reclaimable?.idleEnvironments?.[0] ?? cap.reclaimable?.finishedSessions?.[0]
  if (top) lines.push(`Biggest thing to free (ask the user first): ${top.worktree} ${top.process ?? top.title ?? ''} ${top.gb} GB`.replace(/\s+/g, ' '))
  return lines.join('\n')
}

/** The previous attempt of the task a dispatch ran, from routes.jsonl. */
function previousAttempt(dir, dispatchId) {
  const routes = readRoutes(dir)
  const hit = routes.find((r) => r.dispatchId === dispatchId)
  if (!hit) return null
  const same = routes.filter((r) => hit.taskId && r.taskId === hit.taskId)
  const attempt = Math.max(hit.attempt ?? 0, ...same.map((r) => r.attempt ?? 0))
  return { ...hit, attempt }
}

// ---------- route ----------

/** `orca-flow route`: the decision only, nothing launched. Returns the exit code. */
export async function routeCommand(args, deps) {
  const req = routeRequest(args)
  const decision = routing.route(readRouting(deps.dir), req, await deps.discover())
  deps.out(args.json ? JSON.stringify(decision, null, 2) : formatDecision(decision, { explain: !!args.explain }))
  return decision.ok ? 0 : 3
}

// ---------- dispatch ----------

/**
 * `orca-flow dispatch`: capacity gate, route, `orca orchestration worker-start` with the routed
 * flags, one routes.jsonl line. Exit 2 when capacity says no, 3 when no model fits; neither
 * launches anything. `--dry-run` stops before worker-start and the log line.
 */
export async function dispatchCommand(args, deps) {
  const req = routeRequest(args, ['worker', 'lead'])
  const flags = { ...args }
  if (flags['retry-of'] === true) throw new UsageError('--retry-of needs the failed dispatch id')
  if (flags['retry-of']) {
    const prev = previousAttempt(deps.dir, flags['retry-of'])
    if (req.attempt === undefined) {
      if (!prev) throw new UsageError(`no route recorded for ${flags['retry-of']} in ${ROUTES(deps.dir)}: pass --attempt <n>`)
      req.attempt = prev.attempt + 1
    }
    // The same task, judged the same way, unless this call says otherwise.
    if (prev) {
      if (!flags.task && prev.taskId) flags.task = prev.taskId
      if (req.taskClass === undefined && prev.class) req.taskClass = prev.class
      if (req.risk === undefined && prev.risk) req.risk = prev.risk
    }
    if (!flags.task) throw new UsageError('--retry-of needs --task <the failed task id>')
  }
  if (!flags.task && !flags.spec && !flags['spec-file']) throw new UsageError('dispatch needs --task <id>, --spec <text> or --spec-file <path|->')
  const newWorktree = NEW_WORKTREE.includes(flags.worktree)

  const cap = await deps.capacity(newWorktree && typeof flags.repo === 'string' ? { repo: flags.repo } : {})
  if (!capacityAllows(cap.verdict, newWorktree)) throw new Refused(refusal(cap, { newWorktree, taskId: flags.task, title: flags['task-title'] }), 2)

  const decision = routing.route(readRouting(deps.dir), req, await deps.discover())
  if (!decision.ok) throw new Refused(formatDecision(decision, { explain: true }), 3)

  const argv = ['orchestration', 'worker-start']
  for (const k of PASSTHROUGH) if (flags[k] !== undefined && flags[k] !== true) argv.push(`--${k}`, String(flags[k]))
  for (const k of BOOLEAN_PASSTHROUGH) if (flags[k]) argv.push(`--${k}`)
  argv.push(...routing.launchArgs(decision.choice))
  const capacityView = { verdict: cap.verdict, freeGB: cap.freeGB ?? null }

  if (args['dry-run']) {
    const command = shellLine([deps.orcaBin ?? 'orca', ...argv, '--json'])
    if (args.json) deps.out(JSON.stringify({ route: decision, capacity: capacityView, command }, null, 2))
    else deps.out([`Would start on ${label(decision)} — ${decision.reason}`, `capacity: ${cap.verdict}`, command].join('\n'))
    return 0
  }

  const input = flags['spec-file'] === '-' ? deps.readStdin() : undefined
  const receipt = await deps.orca(argv, { input })
  appendRoute(deps.dir, routeEntry({ at: deps.now().toISOString(), role: req.role, receipt, decision, req }))
  if (args.json) deps.out(JSON.stringify({ route: decision, capacity: capacityView, receipt }, null, 2))
  else deps.out(formatStart(receipt, decision))
  return 0
}

function formatStart(receipt, decision) {
  const id = receipt?.dispatchId ?? receipt?.taskId ?? '(no dispatch id)'
  const lines = [`Started ${id} on ${label(decision)} — ${decision.reason}`]
  const facts = [receipt?.taskId && `task ${receipt.taskId}`, receipt?.runId && `run ${receipt.runId}`, receipt?.state && `state ${receipt.state}`, receipt?.workspace && `workspace ${receipt.workspace}`].filter(Boolean)
  if (facts.length) lines.push(`  ${facts.join(' · ')}`)
  if (receipt?.warning) lines.push(`  warning: ${receipt.warning}`)
  if (receipt?.next) lines.push(`  next: ${typeof receipt.next === 'string' ? receipt.next : JSON.stringify(receipt.next)}`)
  return lines.join('\n')
}

// ---------- plan ----------

const PLANS = (dir) => join(dir, 'plans')

/** The plan file, parsed, checked, and with each task's spec read. */
function loadPlan(file, cwd) {
  if (!file || file === true) throw new UsageError('usage: orca-flow plan check|start|next|status <plan.json>')
  const path = isAbsolute(file) ? file : resolve(cwd, file)
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new UsageError(`cannot read the plan ${path}: ${e.message}`)
  }
  const { plan, errors } = planLib.parsePlan(raw)
  const check = plan ? planLib.checkPlan(plan) : { ok: false, errors: [], warnings: [], waves: [] }
  const all = [...errors, ...check.errors]
  if (plan) {
    for (const t of plan.tasks) {
      if (!t.specFile) continue
      const specPath = isAbsolute(t.specFile) ? t.specFile : resolve(dirname(path), t.specFile)
      if (!existsSync(specPath)) all.push(`task "${t.id}": specFile ${t.specFile} does not exist`)
      else t.spec = readFileSync(specPath, 'utf8')
    }
  }
  return { path, plan, check: { ...check, ok: all.length === 0, errors: all } }
}

function formatCheck(plan, check) {
  const lines = []
  for (const e of check.errors) lines.push(`error: ${e}`)
  for (const w of check.warnings) lines.push(`warning: ${w}`)
  if (check.ok) {
    lines.unshift(`Plan "${plan.title}": ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'} in ${check.waves.length} wave${check.waves.length === 1 ? '' : 's'}`)
    check.waves.forEach((w, i) => lines.push(`  wave ${i + 1}: ${w.join(', ')}`))
  }
  return lines.join('\n')
}

const statePath = (dir, plan) => join(PLANS(dir), `${planLib.planSlug(plan.title)}.json`)

const taskRequest = (t) => ({
  role: 'worker',
  taskClass: t.class,
  ...(t.risk && { risk: t.risk }),
  ...(t.context && { context: t.context }),
  ...(t.agent && { agent: t.agent }),
  ...(t.model && { model: t.model }),
  ...(t.effort && { effort: t.effort })
})

/** Orca's task status as a plan state. A dispatched task that Orca put back to ready is queued again. */
function stateOf(status) {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'dispatched' || status === 'blocked') return 'running'
  return 'queued'
}

async function refreshStates(state, deps) {
  if (state.dryRun) return
  const listed = await deps.orca(['orchestration', 'task-list', ...runFlag(state)])
  const byId = new Map((listed?.tasks ?? []).map((t) => [t.id, t.status]))
  for (const t of Object.values(state.tasks)) {
    const status = byId.get(t.taskId)
    if (status) {
      t.status = status
      const next = stateOf(status)
      // Orca still has it ready: a start that failed stays failed-start until it starts.
      t.state = t.state === 'failed-start' && next === 'queued' ? 'failed-start' : next
    }
  }
}

/**
 * Starts what may start now: ready tasks (deps done) up to maxParallel minus this plan's running
 * workers, each behind the capacity gate and on its recorded route. A recorded model that is no
 * longer available is routed again and said so; an explicit one is never swapped.
 */
async function startReady({ plan, state, settings, avail, deps, worktree, dryRun, lines }) {
  const failures = []
  const states = Object.fromEntries(Object.entries(state.tasks).map(([id, t]) => [id, t.state]))
  const queued = planLib.startable(plan, states, settings.maxParallel)
  const running = Object.values(state.tasks).filter((t) => t.state === 'running').length
  if (!queued.length) {
    const waiting = plan.tasks.filter((t) => state.tasks[t.id].state === 'queued').length
    if (waiting) lines.push(running >= settings.maxParallel ? `Nothing started: ${running} of this plan's workers run (limit ${settings.maxParallel}).` : `Nothing started: ${waiting} task${waiting === 1 ? ' waits' : 's wait'} on dependencies.`)
    return failures
  }
  for (const id of queued) {
    const t = state.tasks[id]
    const task = plan.tasks.find((x) => x.id === id)
    // Is the recorded choice still usable? Asking route() for exactly it checks availability.
    let decision = t.route
    const gone = unavailable(decision.choice, settings, avail)
    if (gone) {
      if (decision.source === 'override') {
        lines.push(`${id}: not started: ${label(decision)}, which the plan names, is unavailable (${gone}). Change the plan; nothing was substituted.`)
        continue
      }
      const fresh = routing.route(settings, taskRequest(task), avail)
      if (!fresh.ok) {
        lines.push(`${id}: not started: ${label(decision)} is no longer available and no other model fits (${fresh.error})`)
        continue
      }
      lines.push(`${id}: ${label(decision)} is no longer available; routed again to ${label(fresh)} — ${fresh.reason}`)
      decision = fresh
      t.route = pick(fresh)
    }
    const cap = await deps.capacity({})
    if (!capacityAllows(cap.verdict, false)) {
      lines.push(`${id}: queued: capacity says ${cap.verdict}${cap.freeGB == null ? '' : ` (${cap.freeGB} GB free)`}. Run \`orca-flow plan next\` when there is room.`)
      break
    }
    const argv = ['orchestration', 'worker-start', '--task', t.taskId, '--worktree', worktree, ...runFlag(state), ...routing.launchArgs(decision.choice)]
    if (dryRun) {
      lines.push(`${id}: would run ${shellLine([deps.orcaBin ?? 'orca', ...argv, '--json'])}`)
      t.state = 'running'
      continue
    }
    let receipt
    try {
      receipt = await deps.orca(argv)
    } catch (e) {
      // Only this task failed to start; it stays startable (`plan next`) and the others are still tried.
      const message = String(e?.message ?? e).split('\n')[0]
      t.state = 'failed-start'
      t.error = message
      failures.push(`${id}: ${message}`)
      lines.push(`${id}: failed to start on ${label(decision)}: ${message}`)
      continue
    }
    delete t.error
    t.dispatchId = receipt?.dispatchId ?? null
    t.state = 'running'
    t.status = 'dispatched'
    appendRoute(deps.dir, routeEntry({ at: deps.now().toISOString(), role: 'worker', receipt: { ...receipt, taskId: receipt?.taskId ?? t.taskId }, decision, req: taskRequest(task) }))
    lines.push(`${id}: started ${t.dispatchId ?? t.taskId} on ${label(decision)} — ${decision.reason}`)
  }
  return failures
}

/** `--run <id>` when the plan knows its run; otherwise Orca uses the caller's own run. */
const runFlag = (state) => (state.runId && state.runId !== UNKNOWN_RUN ? ['--run', state.runId] : [])
const UNKNOWN_RUN = "(the caller's run)"

const pick = (d) => ({ choice: d.choice, source: d.source, reason: d.reason })

/** Why a recorded choice can no longer start here, or null. Asking route() for exactly it checks it. */
function unavailable(choice, settings, avail) {
  if (!choice.model) return avail.agents && !avail.agents.includes(choice.agent) ? `${choice.agent} not installed` : null
  const d = routing.route(settings, { role: 'worker', agent: choice.agent, model: choice.model, ...(choice.effort && { effort: choice.effort }) }, avail)
  return d.ok ? null : d.error
}

/** Ids from Orca receipts, whatever envelope they come in. */
const idOf = (r, kind) => r?.[`${kind}Id`] ?? r?.[kind]?.id ?? r?.id ?? null

/** `orca-flow plan check|start|next|status <file>`. Returns the exit code. */
export async function planCommand(args, deps) {
  const [, sub, file] = args._
  const { plan, check, path } = loadPlan(file, deps.cwd)
  if (sub === 'check' || !check.ok) {
    if (!['check', 'start', 'next', 'status'].includes(sub)) throw new UsageError('usage: orca-flow plan check|start|next|status <plan.json>')
    deps.out(args.json ? JSON.stringify(check, null, 2) : formatCheck(plan ?? { title: '?', tasks: [] }, check))
    return check.ok ? 0 : 1
  }
  const worktree = typeof args.worktree === 'string' ? args.worktree : 'current'
  if (NEW_WORKTREE.includes(worktree)) throw new UsageError('a plan runs in one existing worktree: --worktree current (or a selector); new worktrees are your coordinator\'s')
  const settings = readRouting(deps.dir)
  const where = statePath(deps.dir, plan)
  const lines = []

  if (sub === 'start') {
    const dryRun = !!args['dry-run']
    if (!dryRun && existsSync(where)) throw new UsageError(`plan "${plan.title}" was already started (${where}): use \`orca-flow plan next\``)
    for (const w of check.warnings) lines.push(`warning: ${w}`)
    const avail = await deps.discover()
    // Route every task once, now: later settings changes never switch pending work.
    const routes = {}
    const failed = []
    for (const t of plan.tasks) {
      const d = routing.route(settings, taskRequest(t), avail)
      if (d.ok) routes[t.id] = pick(d)
      else failed.push(`${t.id}: ${d.error}`)
    }
    if (failed.length) throw new Refused(`No model for ${failed.length === 1 ? 'a task' : 'some tasks'}; nothing created:\n${failed.join('\n')}`, 3)

    // Which Run the tasks belong to. Never create one as a side effect: a lead that is itself a
    // dispatched worker already works inside its coordinator's Run, and `run-create` would bind this
    // terminal to a new Run as its coordinator, after which Orca fences ("consumer_fenced") every
    // message to its earlier sub-workers in the first Run. So: --run, else the Run bound here
    // (`run-current`), else none: task-create and worker-start without --run join the caller's own
    // Run, and the Run id is read back from the first task. `--new-run` is the explicit opt-in to
    // `run-create` (a home coordinator with no Run), and the output says it was created.
    let runId = typeof args.run === 'string' ? args.run : null
    let runNote = null
    if (!runId && !dryRun) {
      runId = idOf(await deps.orca(['orchestration', 'run-current']), 'run')
      if (runId) runNote = `Run ${runId}: the one bound to this terminal.`
    }
    if (!runId && !dryRun && args['new-run']) {
      runId = idOf(await deps.orca(['orchestration', 'run-create', '--objective', plan.title]), 'run')
      if (!runId) throw new Error('Orca returned no run id for the plan')
      runNote = `Created Run ${runId} (--new-run) and bound it to this terminal as its coordinator.`
    }
    if (runNote) lines.push(runNote)
    const state = { title: plan.title, plan: path, runId: runId ?? (dryRun ? '<run>' : UNKNOWN_RUN), worktree, createdAt: deps.now().toISOString(), dryRun, tasks: {} }
    for (const id of check.waves.flat()) {
      const t = plan.tasks.find((x) => x.id === id)
      const depIds = t.deps.map((d) => state.tasks[d].taskId)
      const argv = ['orchestration', 'task-create', '--task-title', t.title, '--spec-file', '-', ...runFlag(state), ...(depIds.length ? ['--deps', JSON.stringify(depIds)] : [])]
      let taskId = `<${id}>`
      if (dryRun) lines.push(`${id}: would run ${shellLine([deps.orcaBin ?? 'orca', ...argv, '--json'])}`)
      else {
        const receipt = await deps.orca(argv, { input: `${t.spec.trim()}\n\n${planLib.ownershipNote(plan, id)}\n` })
        taskId = idOf(receipt, 'task')
        // No run was named: the task joined the caller's Run; remember which.
        const joined = receipt?.task?.runId ?? receipt?.runId
        if (state.runId === UNKNOWN_RUN && joined) {
          state.runId = joined
          lines.push(`Run ${joined}: the caller's own, joined by the first task. No Run was created.`)
        }
      }
      if (!taskId) throw new Error(`Orca returned no task id for "${id}"`)
      state.tasks[id] = { taskId, route: routes[id], dispatchId: null, state: 'queued', status: dep(depIds) }
      if (!dryRun) writeJson(where, state)
    }
    const failures = await startReady({ plan, state, settings, avail, deps, worktree: state.worktree, dryRun, lines })
    if (!dryRun) writeJson(where, state)
    return finish({ plan, state, lines, failures, args, deps })
  }

  const state = readJson(where, null)
  if (!state) throw new UsageError(`plan "${plan.title}" has not started: \`orca-flow plan start ${file}\``)
  await refreshStates(state, deps)
  let failures = []
  if (sub === 'next') {
    failures = await startReady({ plan, state, settings, avail: await deps.discover(), deps, worktree: state.worktree, dryRun: !!args['dry-run'], lines })
    if (!args['dry-run']) writeJson(where, state)
  } else if (sub === 'status') writeJson(where, state)
  else throw new UsageError('usage: orca-flow plan check|start|next|status <plan.json>')
  return finish({ plan, state, lines, failures, args, deps })
}

/** Prints the status table; exits 1 when a start failed, naming each failure. */
function finish({ plan, state, lines, failures, args, deps }) {
  lines.push(...statusLines(plan, state))
  if (failures.length) lines.push(`${failures.length} start${failures.length === 1 ? '' : 's'} failed (state failed-start, \`orca-flow plan next\` retries):`, ...failures.map((f) => `  ${f}`))
  deps.out(args.json ? JSON.stringify(state, null, 2) : lines.join('\n'))
  return failures.length ? 1 : 0
}

const dep = (depIds) => (depIds.length ? 'pending' : 'ready')

function statusLines(plan, state) {
  const width = Math.max(...plan.tasks.map((t) => t.id.length))
  return [
    `Plan "${plan.title}" (run ${state.runId}):`,
    ...plan.tasks.map((t) => {
      const s = state.tasks[t.id]
      const who = s.dispatchId ? ` ${s.dispatchId}` : ''
      return `  ${t.id.padEnd(width)}  ${s.state.padEnd(12)}  ${routing.choiceLabel(s.route.choice)} — ${s.route.reason}  [${s.taskId}${who}]${s.error ? ` start failed: ${s.error}` : ''}`
    })
  ]
}
