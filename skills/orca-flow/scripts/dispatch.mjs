// orca-flow route | dispatch | plan | types: start leads and workers on the routed model, behind the memory
// gate, and run a lead's parallel plan. orca-flow.mjs wires the real Orca CLI, model discovery and
// capacity in; tests pass fakes (`deps`), so nothing here starts a real worker under test.
//
// The routing decision is src/routing.ts and the plan checks src/plan.ts (Node strips their types).
// Every start appends one line to ~/.orca-flow/routes.jsonl:
//   {at, role, taskId, dispatchId, workspace, choice, source, reason, type, kind, class, risk,
//    context, explicit, attempt}
// `type` is the task type's id (null for a task routed by difficulty).
// `class` repeats `kind` in its old name (trivial, standard, complex) for older readers. `explicit`
// is what the caller chose itself ({agent, model, effort}, or null). The sidebar reads it to show
// the model on each row; `--retry-of` reads it to rebuild the request and escalate.
//
// A worker-start that times out or comes back outcome_unknown may have started the worker. It is
// never started again: dispatch keeps it in pending-starts.json and plan in its state ('unknown').
// The next identical dispatch first asks Orca: running or settled, it is reported (its outcome and
// dispatch id), its record dropped, and nothing starts; only `--restart` starts it again. Still
// unknown, it is replayed with Orca's `--retry-request <id>`, or, with no id to replay it by,
// refused (exit 4) until the user checks it or passes `--restart`. Records older than 24 hours are
// dropped with a note. `plan next` replays and settles its own unknown starts the same way.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const routing = await import(new URL('../../../src/routing.ts', import.meta.url).href)
const planLib = await import(new URL('../../../src/plan.ts', import.meta.url).href)
const { codexHomeFromAccounts } = await import(new URL('../../../src/writer.ts', import.meta.url).href)

/** worker-start flags `dispatch` passes through unchanged. Routing flags are not among them. */
const PASSTHROUGH = ['worktree', 'task', 'task-title', 'spec', 'spec-file', 'repo', 'name', 'base-branch', 'display-name', 'comment', 'setup', 'deps', 'parent', 'run', 'retry-of', 'retry-request']
const BOOLEAN_PASSTHROUGH = ['keep-open']
const NEW_WORKTREE = ['new-top-level', 'new-child']

export class UsageError extends Error {}
/** An error with the exit code main() uses: 2 capacity said no, 3 routing found no model, 4 the start's outcome is unknown. */
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
        e.code = parsed?.error?.code
        // A failed outcome (worker-start outcome_unknown) is ok:false with the receipt as `result`.
        e.result = parsed?.result
        // Killed by our own timeout: Orca may still have applied it.
        e.timedOut = !!err?.killed
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

const MODELS_CACHE = (dir) => join(dir, 'models-cache.json')
export const MODELS_CACHE_MS = 10 * 60_000

/**
 * Model discovery through a 10-minute cache in `dir` (models-cache.json): discovery starts a whole
 * `claude -p` process. `refresh` (--refresh-models) bypasses the cache. A discovery that could not
 * read the installed agents is not cached. `key` is what the answer depends on (the Codex home): a
 * cache written under another key is not used. A cache from before keys counts as key null.
 */
export async function cachedDiscover(dir, discover, { refresh = false, now = Date.now(), key = null } = {}) {
  if (!refresh) {
    const c = readJson(MODELS_CACHE(dir), null)
    if (c && typeof c.at === 'number' && now >= c.at && now - c.at < MODELS_CACHE_MS && c.avail && (c.key ?? null) === key) return c.avail
  }
  const avail = await discover()
  if (Array.isArray(avail?.agents)) {
    try {
      writeJson(MODELS_CACHE(dir), { at: now, key, avail })
    } catch {}
  }
  return avail
}

/**
 * The Codex home of Orca's selected Codex account, resolved as the plugin resolves it (src/writer.ts
 * codexHomeFromAccounts, as src/worker.ts discoverHere uses it), or null when Orca cannot say.
 * `orca` resolves to the command's `result`.
 */
export async function codexHome(orca) {
  try {
    return codexHomeFromAccounts({ ok: true, result: await orca(['account', 'list', '--agent', 'codex']) })
  } catch {
    return null
  }
}

/**
 * Discovery as Settings sees it: Codex lists its models from the selected account's home. The home
 * keys the cache, so switching accounts looks again. `discover(opts)` gets `{ env: { CODEX_HOME } }`
 * when the home is known, `{}` otherwise.
 */
export function accountDiscovery(dir, { orca, discover, refresh = false }) {
  return async () => {
    const home = await codexHome(orca)
    return cachedDiscover(dir, () => discover(home ? { env: { CODEX_HOME: home } } : {}), { refresh, key: home })
  }
}

/**
 * The repo name capacity prices a new worktree by (envCost keys on the name `worktree ps` shows):
 * `name:x` is x; `id:` and `path:` selectors are looked up with `orca repo show`; otherwise, or when
 * the lookup fails, the value as given.
 */
export async function repoName(selector, deps) {
  if (typeof selector !== 'string' || !selector) return undefined
  if (selector.startsWith('name:')) return selector.slice(5)
  if (!/^(id|path):/.test(selector)) return selector
  try {
    const r = await deps.orca(['repo', 'show', '--repo', selector])
    const repo = r?.repo ?? r
    const name = repo?.displayName ?? repo?.name
    return typeof name === 'string' && name ? name : selector
  } catch {
    return selector
  }
}

/** The capacity verdict after one more agent started here, priced locally instead of a new scan. */
export function afterStart(cap) {
  const agentGB = cap?.costs?.agentGB
  if (cap?.freeGB === null || cap?.freeGB === undefined || typeof agentGB !== 'number') return cap
  const freeGB = Math.round((cap.freeGB - agentGB) * 10) / 10
  return { ...cap, freeGB, verdict: cap.verdict === 'pressure' ? 'pressure' : freeGB < agentGB ? 'full' : cap.verdict }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNKNOWN_CODES = ['start_outcome_unknown', 'runtime_timeout', 'runtime_unavailable', 'remote_runtime_unavailable', 'invalid_runtime_response', 'operation_unknown']

/**
 * Whether a rejected worker-start may still have started the worker, and the request id Orca
 * replays it by. Nothing sent (`not_sent`) and plain refusals are definite failures.
 */
export function startOutcome(e) {
  const data = e?.data && typeof e.data === 'object' ? e.data : {}
  const result = e?.result && typeof e.result === 'object' ? e.result : {}
  if (data.recovery?.disposition === 'not_sent') return { unknown: false }
  const unknown = result.state === 'outcome_unknown' || data.recovery?.disposition === 'outcome_unknown' || UNKNOWN_CODES.includes(e?.code) || e?.timedOut === true
  if (!unknown) return { unknown: false }
  const texts = [...(Array.isArray(result.nextCommands) ? result.nextCommands : []), ...(Array.isArray(data.nextSteps) ? data.nextSteps : []), ...(Array.isArray(data.recovery?.retryCommand) ? [data.recovery.retryCommand.join(' ')] : []), String(e?.message ?? '')]
  const fromText = texts.map((t) => /--retry-request\s+([0-9a-f-]{36})/i.exec(String(t))?.[1]).find(Boolean)
  const requestId = [data.orchestrationRequestId, data.recovery?.orchestrationRequestId, result.mutation?.requestId, result.requestId, fromText].find((v) => typeof v === 'string' && UUID.test(v)) ?? null
  const dispatchId = [result.dispatchId, data.dispatchId, data.recovery?.dispatchId].find((v) => typeof v === 'string' && v) ?? null
  const taskId = [result.taskId, data.taskId, data.recovery?.taskId].find((v) => typeof v === 'string' && v) ?? null
  return { unknown: true, requestId, dispatchId, taskId }
}

const firstLine = (e) => String(e?.message ?? e).split('\n')[0]

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

/** What the caller chose itself: the agent, model and effort it named, or null. */
const explicitOf = (req) => {
  const e = { ...(req.agent && { agent: req.agent }), ...(req.model && { model: req.model }), ...(req.effort && { effort: req.effort }) }
  return Object.keys(e).length ? e : null
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
    type: req.type ?? null,
    kind: req.kind ?? null,
    class: req.kind ? OLD_CLASS[req.kind] : null,
    risk: req.risk ?? null,
    context: req.context ?? null,
    explicit: explicitOf(req),
    attempt: req.attempt ?? 0
  }
}

const ROLES = ['coordinator', 'lead', 'worker']
const OLD_CLASS = { simple: 'trivial', normal: 'standard', hard: 'complex' }

/** The RouteRequest from command-line flags; refuses values routing would not understand. */
export function routeRequest(args, roles = ROLES) {
  const role = args.role
  if (!roles.includes(role)) throw new UsageError(`--role is ${roles.join(' or ')}`)
  const req = { role }
  if (args.type === true) throw new UsageError('--type needs a task type id (`orca-flow types` lists them)')
  if (args.type !== undefined) {
    if (role !== 'worker') throw new UsageError('--type is for workers only')
    req.type = String(args.type)
  }
  // --kind; --class and the old names (trivial, standard, complex) still work.
  const flag = args.kind !== undefined ? 'kind' : 'class'
  if (args[flag] !== undefined) {
    const kind = routing.taskKind(args[flag])
    if (!kind) throw new UsageError(`--${flag} is simple, normal or hard`)
    req.kind = kind
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
    const row = decision.row
    if (row) lines.push(`  row: ${row.kind} → ${routing.choiceLabel(row.route.model)}, fallback ${row.route.fallback ? routing.choiceLabel(row.route.fallback) : 'none'} (Settings → Models)`)
    const type = decision.type
    if (type) lines.push(`  type row: ${type.name} (${type.id}) → ${routing.choiceLabel(type.route.model)}, fallback ${type.route.fallback ? routing.choiceLabel(type.route.fallback) : 'none'} (Settings → Models)`)
    lines.push(decision.skipped.length ? '  passed over:' : '  passed over: none')
    for (const s of decision.skipped) lines.push(`    ${s.model}: ${s.why}`)
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

/** What a logged start's caller chose itself. Lines before `explicit` was logged: an override with a model. */
function explicitOfEntry(entry) {
  if (entry.explicit !== undefined) return entry.explicit
  return entry.source === 'override' && entry.choice?.model ? { agent: entry.choice.agent, model: entry.choice.model, ...(entry.choice.effort && { effort: entry.choice.effort }) } : null
}

const sameChoice = (a, b) => !!a && !!b && a.agent === b.agent && (a.model ?? null) === (b.model ?? null) && (a.effort ?? null) === (b.effort ?? null)

/**
 * A retry of a model the user chose: the same model, one effort step above the one that failed
 * (above medium when it ran on its default effort). Never another model; ok:false when it has no
 * higher effort.
 */
function retrySameModel(settings, req, prevChoice, avail) {
  const name = routing.choiceLabel({ agent: req.agent, model: req.model })
  const from = routing.EFFORTS.indexOf(prevChoice?.effort ?? 'medium')
  const tried = []
  for (const effort of routing.EFFORTS.slice(from + 1)) {
    const d = routing.route(settings, { ...req, effort }, avail)
    if (d.ok) return { ...d, reason: `${name} was chosen explicitly, so the retry keeps it: effort ${prevChoice?.effort ?? 'default'} → ${effort}` }
    tried.push(d.error)
  }
  const why = tried.length ? ` (${tried.at(-1)})` : ''
  return { ok: false, error: `Cannot escalate ${name}: it was chosen explicitly, so the retry keeps it, and it has no effort above ${prevChoice?.effort ?? 'its default'}${why}. Nothing was substituted: retry with --model <another>, or ask the user.`, skipped: [] }
}

/** The request's type as its id, when the settings know it (a name or another case was given). */
function canonicalType(settings, req) {
  if (req.type === undefined) return req
  const t = routing.findType(settings, req.type)
  return t ? { ...req, type: t.id } : req
}

// ---------- types ----------

/** `orca-flow types`: the user's task types (Settings → Models), or that there are none. Returns the exit code. */
export async function typesCommand(args, deps) {
  const types = readRouting(deps.dir).types
  if (args.json) {
    deps.out(JSON.stringify(types.map((t) => ({ id: t.id, name: t.name, description: t.description, model: routing.choiceLabel(t.route.model), fallback: t.route.fallback ? routing.choiceLabel(t.route.fallback) : null, route: t.route })), null, 2))
    return 0
  }
  if (!types.length) {
    deps.out('No task types are set: every worker task goes by difficulty (--kind simple, normal or hard). The user adds types in Settings → Models.')
    return 0
  }
  const lines = [`${types.length} task type${types.length === 1 ? '' : 's'}. Give a task --type <id> only when it clearly fits the description; every other task goes by difficulty (--kind).`]
  for (const t of types) {
    lines.push(`  ${t.id}  ${t.name}: ${t.description || '(no description)'}`)
    lines.push(`    → ${routing.choiceLabel(t.route.model)}${t.route.fallback ? `, fallback ${routing.choiceLabel(t.route.fallback)}` : ', no fallback'}`)
  }
  deps.out(lines.join('\n'))
  return 0
}

// ---------- route ----------

/** `orca-flow route`: the decision only, nothing launched. Returns the exit code. */
export async function routeCommand(args, deps) {
  const settings = readRouting(deps.dir)
  const req = canonicalType(settings, routeRequest(args))
  const decision = routing.route(settings, req, await deps.discover())
  deps.out(args.json ? JSON.stringify(decision, null, 2) : formatDecision(decision, { explain: !!args.explain }))
  return decision.ok ? 0 : 3
}

// ---------- pending starts ----------

const PENDING = (dir) => join(dir, 'pending-starts.json')
export const PENDING_MAX_MS = 24 * 3600_000
const readPending = (dir) => readJson(PENDING(dir), {}) ?? {}
function writePending(dir, pending) {
  if (Object.keys(pending).length || existsSync(PENDING(dir))) writeJson(PENDING(dir), pending)
}

/**
 * pending-starts.json is keyed by Orca's request id. A start Orca gave no id for is keyed by a hash
 * of its command (`unknown-<hash>`) and records `requestId: null`; older records have no
 * `requestId` field, their key is the id.
 */
const requestIdOf = (key, rec) => (rec.requestId !== undefined ? rec.requestId : key)
const pendingKey = (outcome, base, input) => outcome.requestId ?? `unknown-${createHash('sha256').update(JSON.stringify([base, input ?? null])).digest('hex').slice(0, 16)}`

/** Drops records older than 24 hours; returns a note for each. */
function expirePending(pending, now) {
  const notes = []
  for (const [key, rec] of Object.entries(pending)) {
    const at = Date.parse(rec?.at)
    if (Number.isFinite(at) && now.getTime() - at <= PENDING_MAX_MS) continue
    delete pending[key]
    notes.push(`Dropped the unknown start ${rec?.dispatchId ?? requestIdOf(key, rec ?? {}) ?? key} recorded ${rec?.at ?? 'at an unknown time'}: older than 24 hours, it is not replayed. Check it in Orca (orca orchestration task-list) if it matters.`)
  }
  return notes
}

/** Orca's dispatch or task status as a pending start's state: running, settled, or unknown. */
const SETTLED = ['completed', 'failed', 'cancelled', 'canceled', 'abandoned', 'stopped', 'superseded', 'terminated']
const RUNNING = ['dispatched', 'running', 'blocked']
function stateOfStatus(status, completedAt) {
  if (SETTLED.includes(status) || completedAt) return 'settled'
  if (RUNNING.includes(status)) return 'running'
  return 'unknown'
}

/**
 * What Orca says now about a start whose outcome was unknown: its dispatch (worker-show), else its
 * task (task-list). A lookup that fails, or a task Orca still has ready, is unknown, as in plan.
 */
async function pendingState(rec, deps) {
  if (rec.dispatchId) {
    try {
      const r = await deps.orca(['orchestration', 'worker-show', '--dispatch', rec.dispatchId, '--full'])
      const d = r?.dispatch ?? r
      const status = d?.status ?? null
      const state = stateOfStatus(status, d?.completedAt)
      if (state !== 'unknown') return { state, status, dispatchId: rec.dispatchId, taskId: d?.taskId ?? rec.taskId ?? null, workspace: r?.worker?.worktreeId ?? null }
    } catch {}
  }
  if (rec.taskId) {
    try {
      const listed = await deps.orca(['orchestration', 'task-list', ...(rec.run ? ['--run', rec.run] : [])])
      const status = (listed?.tasks ?? []).find((t) => t.id === rec.taskId)?.status ?? null
      const state = stateOfStatus(status)
      if (state !== 'unknown') return { state, status, dispatchId: rec.dispatchId ?? null, taskId: rec.taskId, workspace: null }
    } catch {}
  }
  return { state: 'unknown' }
}

function unknownMessage(outcome, e, replay) {
  const lines = [`Start outcome unknown: Orca could not tell whether the worker started (${firstLine(e)}). Do not start it again.`]
  if (outcome.dispatchId) lines.push(`Check it: orca orchestration worker-show --dispatch ${outcome.dispatchId}`)
  if (outcome.requestId) lines.push(`Run the same command again (or add --retry-request ${outcome.requestId}): it replays request ${outcome.requestId} instead of starting a second worker.`, replay ? `Replay: ${replay}` : '')
  else lines.push('Orca gave no request id to replay it by. Running the same command again asks Orca first and starts nothing while the outcome is still unknown; check `orca orchestration task-list` and worker-show, and add --restart only when no worker runs for it.')
  return lines.filter(Boolean).join('\n')
}

/** The refusal for an identical re-run of a start that is still unknown and has no request id. */
function stillUnknown(rec) {
  const check = [rec.dispatchId && `orca orchestration worker-show --dispatch ${rec.dispatchId}`, rec.taskId && `orca orchestration task-list (task ${rec.taskId})`].filter(Boolean)
  return [
    `Not started: this same command started a worker at ${rec.at} whose outcome is still unknown, and Orca gave no request id to replay it by.`,
    `Check it: ${check.length ? check.join(', or ') : 'orca orchestration task-list and worker-show (Orca named no dispatch or task)'}.`,
    'If no worker runs for it, run the command again with --restart to start fresh on purpose.'
  ].join('\n')
}

// ---------- dispatch ----------

/**
 * `orca-flow dispatch`: capacity gate, route, `orca orchestration worker-start` with the routed
 * flags, one routes.jsonl line. Exit 2 when capacity says no, 3 when no model fits; neither
 * launches anything. Exit 4 when the start's outcome is unknown: the same command replays it.
 * `--dry-run` stops before worker-start and the log line.
 */
export async function dispatchCommand(args, deps) {
  let req = routeRequest(args, ['worker', 'lead'])
  const asked = explicitOf(req)
  const flags = { ...args }
  if (flags['retry-of'] === true) throw new UsageError('--retry-of needs the failed dispatch id')
  if (flags['retry-request'] === true) throw new UsageError('--retry-request needs the request id Orca printed')
  // An escalation needs a recorded failure: --attempt only with --retry-of (route keeps it as a what-if).
  if (req.attempt !== undefined && !flags['retry-of']) throw new UsageError('dispatch --attempt goes with --retry-of <the failed dispatch id>: an escalation starts from a recorded failure. `orca-flow route --attempt n` shows what an attempt would use.')
  let prev = null
  let keepModel = false
  if (flags['retry-of']) {
    prev = previousAttempt(deps.dir, flags['retry-of'])
    if (req.attempt === undefined) {
      if (!prev) throw new UsageError(`no route recorded for ${flags['retry-of']} in ${ROUTES(deps.dir)}: pass --attempt <n>`)
      req.attempt = prev.attempt + 1
    }
    // The same task, the same request, unless this call says otherwise.
    if (prev) {
      if (!flags.task && prev.taskId) flags.task = prev.taskId
      if (req.type === undefined && req.role === 'worker' && typeof prev.type === 'string' && prev.type) req.type = prev.type
      const prevKind = routing.taskKind(prev.kind ?? prev.class)
      if (req.kind === undefined && prevKind) req.kind = prevKind
      if (req.risk === undefined && prev.risk) req.risk = prev.risk
      if (req.context === undefined && prev.context) req.context = prev.context
      const was = explicitOfEntry(prev)
      if (!asked?.agent && !asked?.model) {
        // The user's model is never swapped: it is retried at the next effort.
        if (was?.model) {
          req.agent = was.agent ?? prev.choice?.agent
          req.model = was.model
          keepModel = !asked?.effort
        } else if (was?.agent) req.agent = was.agent
      }
      if (!asked?.effort && !keepModel && was?.effort) req.effort = was.effort
    }
    if (!flags.task) throw new UsageError('--retry-of needs --task <the failed task id>')
  }
  if (!flags.task && !flags.spec && !flags['spec-file']) throw new UsageError('dispatch needs --task <id>, --spec <text> or --spec-file <path|->')
  const newWorktree = NEW_WORKTREE.includes(flags.worktree)

  const base = ['orchestration', 'worker-start']
  for (const k of PASSTHROUGH) if (k !== 'retry-request' && flags[k] !== undefined && flags[k] !== true) base.push(`--${k}`, String(flags[k]))
  for (const k of BOOLEAN_PASSTHROUGH) if (flags[k]) base.push(`--${k}`)
  let input
  const stdin = () => (input ??= flags['spec-file'] === '-' ? deps.readStdin() : undefined)

  // A start whose outcome was unknown: this same command asks Orca first, and never starts a second worker.
  const dryRun = !!args['dry-run']
  const pending = readPending(deps.dir)
  const before = Object.keys(pending).length
  const notes = expirePending(pending, deps.now())
  const given = typeof flags['retry-request'] === 'string' ? flags['retry-request'] : null
  const pendingKeyOf = given && pending[given] ? given : given ? null : Object.keys(pending).find((id) => JSON.stringify(pending[id].base) === JSON.stringify(base) && (pending[id].input ?? null) === (stdin() ?? null))
  const save = () => {
    if (!dryRun && Object.keys(pending).length !== before) writePending(deps.dir, pending)
  }
  if (pendingKeyOf && flags.restart) {
    const rec = pending[pendingKeyOf]
    delete pending[pendingKeyOf]
    notes.push(`--restart: forgot the earlier start of this command (${rec.dispatchId ?? requestIdOf(pendingKeyOf, rec) ?? 'no dispatch id'}, outcome unknown) on your word that no worker runs for it; starting fresh.`)
  } else if (pendingKeyOf) {
    const rec = pending[pendingKeyOf]
    const seen = await pendingState(rec, deps)
    // Orca knows the earlier start: running or settled, it is reported and nothing new starts.
    if (seen.state === 'running' || seen.state === 'settled') {
      delete pending[pendingKeyOf]
      save()
      if (!dryRun) appendRoute(deps.dir, routeEntry({ at: seen.state === 'running' ? deps.now().toISOString() : rec.at, role: rec.role, receipt: seen, decision: rec.decision, req: rec.req }))
      const who = seen.dispatchId ? `dispatch ${seen.dispatchId}${seen.taskId ? ` (task ${seen.taskId})` : ''}` : `task ${seen.taskId}`
      const text =
        seen.state === 'running'
          ? `Already started: the earlier start of this command (outcome unknown at ${rec.at}) runs in Orca as ${who}: ${seen.status}. Nothing new started${dryRun ? '' : '; its pending record is dropped'}.`
          : `Already ran: the earlier start of this command (outcome unknown at ${rec.at}) did start, and Orca has settled it: ${who} ${seen.status}. Nothing new started${dryRun ? '' : '; its pending record is dropped'}. To start it again on purpose, run the same command with --restart.`
      deps.out(args.json ? JSON.stringify({ [seen.state === 'running' ? 'alreadyStarted' : 'alreadySettled']: seen, route: rec.decision, notes }, null, 2) : [...notes, text].join('\n'))
      return 0
    } else if (requestIdOf(pendingKeyOf, rec)) {
      save()
      return replayStart(pendingKeyOf, pending, args, deps, notes)
    } else {
      save()
      throw new Refused([...notes, stillUnknown(rec)].join('\n'), 4)
    }
  }
  save()

  const [cap, avail] = await Promise.all([
    newWorktree && typeof flags.repo === 'string' ? repoName(flags.repo, deps).then((repo) => deps.capacity({ repo })) : deps.capacity({}),
    deps.discover()
  ])
  if (!capacityAllows(cap.verdict, newWorktree)) throw new Refused(refusal(cap, { newWorktree, taskId: flags.task, title: flags['task-title'] }), 2)

  const settings = readRouting(deps.dir)
  req = canonicalType(settings, req)
  const decision = keepModel ? retrySameModel(settings, req, prev.choice, avail) : routing.route(settings, req, avail)
  if (!decision.ok) throw new Refused(formatDecision(decision, { explain: true }), 3)
  if (keepModel) req.effort = decision.choice.effort
  // An escalation must land somewhere else; a worker retried on the model that just failed is not one.
  if (prev && req.role === 'worker' && !asked && sameChoice(decision.choice, prev.choice)) {
    // A typed task never leaves its type: the fallback was what failed, so there is nothing above it.
    if (decision.type) throw new Refused(`${routing.noStrongerModel(decision.type.name)} Attempt ${req.attempt} routes to ${label(decision)} again, the model that failed. Nothing was started.`, 3)
    throw new Refused(`Escalation could not move up: attempt ${req.attempt} routes to ${label(decision)} again, the model that failed (${decision.reason}). Nothing was started. Change the rows in Settings → Models, pass --model, or ask the user.`, 3)
  }

  const argv = [...base, ...(given ? ['--retry-request', given] : []), ...routing.launchArgs(decision.choice)]
  const capacityView = { verdict: cap.verdict, freeGB: cap.freeGB ?? null }

  if (dryRun) {
    const command = shellLine([deps.orcaBin ?? 'orca', ...argv, '--json'])
    if (args.json) deps.out(JSON.stringify({ route: decision, capacity: capacityView, command, ...(notes.length && { notes }) }, null, 2))
    else deps.out([...notes, `Would start on ${label(decision)} — ${decision.reason}`, `capacity: ${cap.verdict}`, command].join('\n'))
    return 0
  }

  let receipt
  try {
    receipt = await deps.orca(argv, { input: stdin() })
  } catch (e) {
    const outcome = startOutcome(e)
    if (!outcome.unknown) throw e
    // Recorded with or without a request id: an identical re-run asks Orca before anything starts.
    const taskId = outcome.taskId ?? (typeof flags.task === 'string' ? flags.task : null)
    pending[pendingKey(outcome, base, stdin())] = { at: deps.now().toISOString(), requestId: outcome.requestId, base, argv, input: stdin() ?? null, role: req.role, req, decision: pick(decision), dispatchId: outcome.dispatchId, taskId, run: typeof flags.run === 'string' ? flags.run : null }
    writePending(deps.dir, pending)
    throw new Refused([...notes, unknownMessage(outcome, e)].join('\n'), 4)
  }
  appendRoute(deps.dir, routeEntry({ at: deps.now().toISOString(), role: req.role, receipt, decision, req }))
  if (args.json) deps.out(JSON.stringify({ route: decision, capacity: capacityView, receipt, ...(notes.length && { notes }) }, null, 2))
  else deps.out([...notes, formatStart(receipt, decision)].join('\n'))
  return 0
}

/**
 * Replays a start whose outcome was unknown, by its request id: the recorded command, no gate, no
 * new route. `key` is its pending-starts.json key.
 */
async function replayStart(key, pending, args, deps, notes = []) {
  const rec = pending[key]
  const id = requestIdOf(key, rec)
  const argv = [...rec.argv, '--retry-request', id]
  if (args['dry-run']) {
    deps.out([...notes, `Would replay request ${id} (its outcome was unknown and Orca does not show it running or settled; nothing new starts):`, shellLine([deps.orcaBin ?? 'orca', ...argv, '--json'])].join('\n'))
    return 0
  }
  let receipt
  try {
    receipt = await deps.orca(argv, { input: rec.input ?? undefined })
  } catch (e) {
    const outcome = startOutcome(e)
    if (outcome.unknown) throw new Refused([...notes, unknownMessage({ ...outcome, requestId: outcome.requestId ?? id }, e)].join('\n'), 4)
    delete pending[key]
    writePending(deps.dir, pending)
    throw e
  }
  delete pending[key]
  writePending(deps.dir, pending)
  const decision = { ...rec.decision, ok: true, skipped: [] }
  appendRoute(deps.dir, routeEntry({ at: deps.now().toISOString(), role: rec.role, receipt, decision, req: rec.req }))
  if (args.json) deps.out(JSON.stringify({ route: decision, replayed: id, receipt, ...(notes.length && { notes }) }, null, 2))
  else deps.out([...notes, `Replayed request ${id} (its outcome was unknown).`, formatStart(receipt, decision)].join('\n'))
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

/**
 * The plan's state file: its title slug plus a hash of the plan file's absolute path, so two plans
 * with the same title never share one. A state file from before the hash (`<slug>.json`) that
 * belongs to this plan file is moved to the new name.
 */
function stateFile(dir, plan, path) {
  const slug = planLib.planSlug(plan.title)
  const where = join(PLANS(dir), `${slug}-${createHash('sha256').update(path).digest('hex').slice(0, 8)}.json`)
  const legacy = join(PLANS(dir), `${slug}.json`)
  if (!existsSync(where) && existsSync(legacy) && readJson(legacy, null)?.plan === path) {
    try {
      renameSync(legacy, where)
    } catch {}
  }
  return where
}

const taskRequest = (t) => ({
  role: 'worker',
  ...(t.type && { type: t.type }),
  kind: t.kind,
  ...(t.risk && { risk: t.risk }),
  ...(t.context && { context: t.context }),
  ...(t.agent && { agent: t.agent }),
  ...(t.model && { model: t.model }),
  ...(t.effort && { effort: t.effort })
})

/** What the plan state keeps of a task's request: how it was judged, and what the plan chose itself. */
const requestRecord = (t) => ({ type: t.type ?? null, kind: t.kind, risk: t.risk ?? null, context: t.context ?? null, explicit: explicitOf(t) })

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
    if (!status) continue
    t.status = status
    const next = stateOf(status)
    if (t.state === 'unknown') {
      // Replayed by its request id (startReady) unless Orca has settled it, or it runs and there is no id to replay.
      if (next === 'done' || next === 'failed' || (next === 'running' && !t.requestId)) {
        t.state = next
        delete t.requestId
        delete t.startArgv
      }
      continue
    }
    // Orca still has it ready: a start that failed stays failed-start until it starts.
    t.state = t.state === 'failed-start' && next === 'queued' ? 'failed-start' : next
  }
}

/** Plan task ids as plan states; a task with no entry in the state file is `missing`. */
const statesOf = (plan, state) => Object.fromEntries(plan.tasks.map((t) => [t.id, state.tasks[t.id]?.state ?? 'missing']))

/**
 * Starts one worker for a plan task. A definite refusal marks it failed-start (startable again); an
 * unknown outcome marks it unknown with the request id to replay, so it is never started twice.
 * Returns 'started', 'failed' or 'unknown'.
 */
async function startTask({ id, t, argv, decision, task, deps, lines, failures, unknowns, replay = null }) {
  let receipt
  try {
    receipt = await deps.orca(replay ? [...argv, '--retry-request', replay] : argv)
  } catch (e) {
    const message = firstLine(e)
    const outcome = startOutcome(e)
    if (outcome.unknown) {
      t.state = 'unknown'
      t.requestId = outcome.requestId ?? replay ?? null
      t.startArgv = argv
      if (outcome.dispatchId) t.dispatchId = outcome.dispatchId
      t.error = message
      const how = t.requestId ? `\`orca-flow plan next\` replays request ${t.requestId}` : 'Orca gave no request id: check `orca orchestration task-list`, then `orca-flow plan next --restart ' + id + '` only if no worker runs'
      unknowns.push(`${id}: ${message} (${how})`)
      lines.push(`${id}: start outcome unknown on ${label(decision)}: ${message}. Not started again: ${how}.`)
      return 'unknown'
    }
    // Only this task failed to start; it stays startable (`plan next`) and the others are still tried.
    t.state = 'failed-start'
    t.error = message
    delete t.requestId
    delete t.startArgv
    failures.push(`${id}: ${message}`)
    lines.push(`${id}: failed to start on ${label(decision)}: ${message}`)
    return 'failed'
  }
  delete t.error
  delete t.requestId
  delete t.startArgv
  t.dispatchId = receipt?.dispatchId ?? null
  t.state = 'running'
  t.status = 'dispatched'
  appendRoute(deps.dir, routeEntry({ at: deps.now().toISOString(), role: 'worker', receipt: { ...receipt, taskId: receipt?.taskId ?? t.taskId }, decision, req: taskRequest(task) }))
  lines.push(`${id}: ${replay ? `replayed request ${replay}: started` : 'started'} ${t.dispatchId ?? t.taskId} on ${label(decision)} — ${decision.reason}`)
  return 'started'
}

/**
 * Replays starts whose outcome was unknown, then starts what may start now: ready tasks (deps
 * done), each behind the memory check and on its recorded route. Capacity is scanned once (`capacity`, a promise) and each start's agent is
 * priced locally for the next. A recorded model that is no longer available is routed again and
 * said so; an explicit one is never swapped.
 */
async function startReady({ plan, state, settings, avail, deps, worktree, dryRun, lines, capacity, restart = [] }) {
  const failures = []
  const unknowns = []
  for (const id of restart) {
    const t = state.tasks[id]
    if (!t) throw new UsageError(`--restart ${id}: the plan state has no task "${id}"`)
    if (t.state !== 'unknown') throw new UsageError(`--restart ${id}: it is ${t.state}, not unknown`)
    lines.push(`${id}: restarted on your word that no worker runs for it (--restart); its earlier start is forgotten.`)
    t.state = 'failed-start'
    delete t.requestId
    delete t.startArgv
  }
  for (const t of plan.tasks) {
    const s = state.tasks[t.id]
    if (!s) lines.push(`${t.id}: in the plan but has no Orca task (a partial start, or the plan was edited): run \`orca-flow plan start\` on this file to create it.`)
    else if (s.state === 'unknown') {
      if (!s.requestId) lines.push(`${t.id}: start outcome unknown and no request id to replay: check \`orca orchestration task-list\`; \`orca-flow plan next --restart ${t.id}\` only if no worker runs.`)
      else if (dryRun) lines.push(`${t.id}: would replay request ${s.requestId}: ${shellLine([deps.orcaBin ?? 'orca', ...s.startArgv, '--retry-request', s.requestId, '--json'])}`)
      else await startTask({ id: t.id, t: s, argv: s.startArgv, decision: s.route, task: t, deps, lines, failures, unknowns, replay: s.requestId })
    }
  }
  for (const id of Object.keys(state.tasks)) if (!plan.tasks.some((t) => t.id === id)) lines.push(`${id}: in the plan state but no longer in the plan file; left as it is.`)

  const states = statesOf(plan, state)
  const queued = planLib.startable(plan, states)
  if (!queued.length) {
    const waiting = plan.tasks.filter((t) => states[t.id] === 'queued').length
    if (waiting) lines.push(`Nothing started: ${waiting} task${waiting === 1 ? ' waits' : 's wait'} on dependencies.`)
    return { failures, unknowns }
  }
  let cap = await capacity()
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
    if (!capacityAllows(cap.verdict, false)) {
      lines.push(`${id}: queued: capacity says ${cap.verdict}${cap.freeGB == null ? '' : ` (${cap.freeGB} GB free)`}. Run \`orca-flow plan next\` when there is room.`)
      break
    }
    const argv = ['orchestration', 'worker-start', '--task', t.taskId, '--worktree', worktree, ...runFlag(state), ...routing.launchArgs(decision.choice)]
    if (dryRun) {
      lines.push(`${id}: would run ${shellLine([deps.orcaBin ?? 'orca', ...argv, '--json'])}`)
      t.state = 'running'
      cap = afterStart(cap)
      continue
    }
    // A worker that may be running costs memory too: only a definite refusal leaves the budget as it was.
    if ((await startTask({ id, t, argv, decision, task, deps, lines, failures, unknowns })) !== 'failed') cap = afterStart(cap)
  }
  return { failures, unknowns }
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

/** A capacity scan started now and awaited only when a start needs it (never an unhandled rejection). */
function lazyCapacity(deps) {
  let p = null
  return () => (p ??= deps.capacity({}))
}

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
  // A type named by name or in another case is kept by its id (plan state, routes.jsonl).
  for (const t of plan.tasks) if (t.type) t.type = canonicalType(settings, { type: t.type }).type
  const where = stateFile(deps.dir, plan, path)
  const lines = []
  const restart = args.restart === undefined ? [] : String(args.restart).split(',').filter(Boolean)
  if (args.restart === true) throw new UsageError('--restart needs the plan task id(s)')

  if (sub === 'start') {
    const dryRun = !!args['dry-run']
    // A partial start (task-create failed part way, or tasks added to the plan since) is finished, not refused.
    const earlier = dryRun ? null : readJson(where, null)
    if (earlier && plan.tasks.every((t) => earlier.tasks?.[t.id])) throw new UsageError(`plan "${plan.title}" was already started (${where}): use \`orca-flow plan next\``)
    for (const w of check.warnings) lines.push(`warning: ${w}`)
    // Discovery and the capacity scan run side by side; capacity is awaited only if something starts.
    const capacity = lazyCapacity(deps)
    const capP = capacity()
    capP.catch(() => {})
    const avail = await deps.discover()
    const toCreate = plan.tasks.filter((t) => !earlier?.tasks?.[t.id])
    // Route every task once, now: later settings changes never switch pending work.
    const routes = {}
    const failed = []
    for (const t of toCreate) {
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
    let runId = typeof args.run === 'string' ? args.run : earlier?.runId && earlier.runId !== UNKNOWN_RUN ? earlier.runId : null
    let runNote = earlier ? `Finishing the partial start of ${where}: creating ${toCreate.map((t) => t.id).join(', ')}.` : null
    if (!runId && !dryRun) {
      runId = idOf(await deps.orca(['orchestration', 'run-current']), 'run')
      if (runId && !earlier) runNote = `Run ${runId}: the one bound to this terminal.`
    }
    if (!runId && !dryRun && args['new-run']) {
      runId = idOf(await deps.orca(['orchestration', 'run-create', '--objective', plan.title]), 'run')
      if (!runId) throw new Error('Orca returned no run id for the plan')
      runNote = `Created Run ${runId} (--new-run) and bound it to this terminal as its coordinator.`
    }
    if (runNote) lines.push(runNote)
    const state = earlier ?? { title: plan.title, plan: path, runId: null, worktree, createdAt: deps.now().toISOString(), dryRun, tasks: {} }
    state.runId = runId ?? (dryRun ? '<run>' : UNKNOWN_RUN)
    for (const id of check.waves.flat()) {
      if (state.tasks[id]) continue
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
      state.tasks[id] = { taskId, route: routes[id], request: requestRecord(t), dispatchId: null, state: 'queued', status: dep(depIds) }
      if (!dryRun) writeJson(where, state)
    }
    const { failures, unknowns } = await startReady({ plan, state, settings, avail, deps, worktree: state.worktree, dryRun, lines, capacity, restart })
    if (!dryRun) writeJson(where, state)
    return finish({ plan, state, lines, failures, unknowns, args, deps })
  }

  const state = readJson(where, null)
  if (!state) throw new UsageError(`plan "${plan.title}" has not started: \`orca-flow plan start ${file}\``)
  state.tasks ??= {}
  let failures = []
  let unknowns = []
  if (sub === 'next') {
    const capacity = lazyCapacity(deps)
    capacity().catch(() => {})
    const [avail] = await Promise.all([deps.discover(), refreshStates(state, deps)])
    ;({ failures, unknowns } = await startReady({ plan, state, settings, avail, deps, worktree: state.worktree, dryRun: !!args['dry-run'], lines, capacity, restart }))
    if (!args['dry-run']) writeJson(where, state)
  } else if (sub === 'status') {
    await refreshStates(state, deps)
    writeJson(where, state)
  } else throw new UsageError('usage: orca-flow plan check|start|next|status <plan.json>')
  return finish({ plan, state, lines, failures, unknowns, args, deps })
}

/** Prints the status table; exits 1 when a start failed or its outcome is unknown, naming each. */
function finish({ plan, state, lines, failures, unknowns = [], args, deps }) {
  lines.push(...statusLines(plan, state))
  if (failures.length) lines.push(`${failures.length} start${failures.length === 1 ? '' : 's'} failed (state failed-start, \`orca-flow plan next\` retries):`, ...failures.map((f) => `  ${f}`))
  if (unknowns.length) lines.push(`${unknowns.length} start${unknowns.length === 1 ? '' : 's'} with an unknown outcome (state unknown, never started twice):`, ...unknowns.map((f) => `  ${f}`))
  deps.out(args.json ? JSON.stringify(state, null, 2) : lines.join('\n'))
  return failures.length || unknowns.length ? 1 : 0
}

const dep = (depIds) => (depIds.length ? 'pending' : 'ready')

function statusLines(plan, state) {
  const width = Math.max(...plan.tasks.map((t) => t.id.length))
  return [
    `Plan "${plan.title}" (run ${state.runId}):`,
    ...plan.tasks.map((t) => {
      const s = state.tasks[t.id]
      if (!s) return `  ${t.id.padEnd(width)}  ${'missing'.padEnd(12)}  no Orca task: \`orca-flow plan start\` creates it`
      const who = s.dispatchId ? ` ${s.dispatchId}` : ''
      const choice = s.route?.choice ? routing.choiceLabel(s.route.choice) : '(no route)'
      const problem = s.error ? (s.state === 'unknown' ? ` start outcome unknown: ${s.error}${s.requestId ? ` (replays ${s.requestId})` : ''}` : ` start failed: ${s.error}`) : ''
      return `  ${t.id.padEnd(width)}  ${String(s.state).padEnd(12)}  ${choice} — ${s.route?.reason ?? ''}  [${s.taskId}${who}]${problem}`
    })
  ]
}
