#!/usr/bin/env node
// orca-flow: the coordinator skill's script. Workstream cards, the queue, capacity checks and
// resuming runs, from the same data and code as the Orca Flow sidebar.
//
//   orca-flow queue [--json] [--all]         What needs the user, in order (scoped to your coordinator)
//   orca-flow capacity [--repo <name>] [--json]   Does another agent or a new worktree fit in memory?
//   orca-flow set --worktree <sel> [...]      Write a workstream card (coordinator, at spawn)
//   orca-flow get [--worktree <sel>]          Print a card (default: current worktree)
//   orca-flow resume                          Coordinator, after waking: take back the runs it coordinated
//   orca-flow summarize-run --pane <key> [--force]   Re-summarize an agent's latest turn now
//   orca-flow bots [--repo <name>] [--json]   Orca bots you can hand work to, with the command for each
//   orca-flow role lead|clear                 Record (or clear) that the user made this session a lead
//   orca-flow skills-reloaded [--request <id>]   After re-reading the skill files a "Reload skills"
//                                             note asked for: records this session and the files' hash
// Goals is a Settings → Features switch, off by default: while off every goal command prints one line and changes nothing.
//   orca-flow goal add "<title>" [--note ..] [--next ..] [--done-when ..] [--step ..]... [--linear ID]...
//       [--worktree <sel>]                    A goal: what the user needs to get done (title only is fine)
//   orca-flow goal list [--worktree <sel>] [--all] [--json]   Open and proposed goals (--all: done too);
//                                             --worktree current: goals linked to this worktree
//   orca-flow goal show <id> [--json]         One goal with its steps, links and who changed it last
//   orca-flow goal set <id> [--title ..] [--note ..] [--next ..] [--done-when ..]
//   orca-flow goal step <id> add "<text>" | tick <n|text> | untick <n|text>   (n counts from 1)
//   orca-flow goal link|unlink <id> --worktree <sel> | --linear <ID>
//   orca-flow goal propose-done <id>          Agents: say the goal looks done; the user confirms
//   orca-flow goal done <id> | reopen <id>    Only on the user's word
//                                             Every goal command takes --by <name>; default is your
//                                             role or worktree name, else "an agent"
//   orca-flow types [--json]                  The user's task types (Settings → Models): id, name,
//                                             description, model. None: every task goes by difficulty
//   orca-flow route --role worker|lead|coordinator [--type <id>] [--kind simple|normal|hard] [--risk high]
//       [--context large] [--attempt n] [--agent a] [--model m] [--effort e] [--json] [--explain]
//                                             Which model a start would use, and why. Launches nothing.
//                                             --type: that type's row; kind, risk and context then do not count
//   orca-flow dispatch --role worker|lead [routing flags] [worker-start flags: --worktree --task
//       --task-title --spec --spec-file --keep-open --repo --name --base-branch --display-name
//       --comment --setup --deps --parent --run --retry-of --retry-request] [--attempt n, only with
//       --retry-of] [--restart] [--dry-run] [--json]
//                                             Capacity gate, route, then `orca orchestration worker-start`
//                                             on the routed model. Exit 2: capacity said no; 3: no model;
//                                             4: start outcome unknown. The same command asks Orca first:
//                                             running, nothing starts; unknown, it replays the request,
//                                             or with no request id refuses (exit 4) until --restart
//   orca-flow plan check|start|next|status <plan.json> [--worktree <sel>] [--run <id>] [--dry-run]
//       [--restart <id>]                      A lead's parallel plan: checked file ownership and deps,
//                                             one Orca task each, started in waves, each behind the memory check
//   route, dispatch and plan cache model discovery for 10 minutes (models-cache.json);
//   --refresh-models looks again.
//
// Data lives in ~/.orca-flow (ORCA_FLOW_DIR overrides): cards/<worktree>.json written by
// coordinators, agents/<pane>.json written by the summarizer (the plugin worker), config.json for
// limits and `routing` (Settings → Models), roles.json for leads the user named (roles.mjs),
// goals/<id>.json (goals.mjs, one file per goal), routes.jsonl (one line per routed start), plans/<slug>-<path hash>.json (plan state),
// pending-starts.json (dispatches whose outcome is unknown), models-cache.json. The Orca plugin reads
// them too. No dependencies.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = process.env.ORCA_FLOW_DIR || join(homedir(), '.orca-flow')
const CARDS = join(DIR, 'cards')
const AGENTS = join(DIR, 'agents')
const ORCA_BIN = [
  process.env.ORCA_CLI_BIN_DIR && join(process.env.ORCA_CLI_BIN_DIR, 'orca'),
  '/Applications/Orca.app/Contents/Resources/bin/orca'
].find((p) => p && existsSync(p)) ?? 'orca'

// A coordinator's scope file (same name as in src/coordinators.ts).
const COORDINATOR_FILE = 'coordinator.json'
const LEVELS = { P0: 'now', P1: 'today', P2: 'soon', P3: 'someday' }

// ---------- small helpers ----------

// Flags that may repeat (goal add --step a --step b): their value is an array.
const REPEATABLE = new Set(['step', 'linear'])

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) out._.push(a)
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) out[a.slice(2)] = true
    else if (REPEATABLE.has(a.slice(2))) out[a.slice(2)] = [...(out[a.slice(2)] ?? []), argv[++i]]
    else out[a.slice(2)] = argv[++i]
  }
  return out
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write via a temp file and rename, so the plugin never reads half a file. */
function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

const fileKey = (key) => key.replace(/[^A-Za-z0-9._-]/g, '_')

function log(message) {
  try {
    mkdirSync(DIR, { recursive: true })
    appendFileSync(join(DIR, 'log.txt'), `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

function orca(args) {
  const out = execFileSync(ORCA_BIN, [...args, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 })
  const parsed = JSON.parse(out)
  if (!parsed.ok) throw new Error(parsed.error?.message ?? `orca ${args.join(' ')} failed`)
  return parsed.result
}

export function normalizePriority(value) {
  if (!value) return undefined
  const v = String(value).trim().toLowerCase()
  const byWord = Object.entries(LEVELS).find(([, word]) => word === v)
  if (byWord) return byWord[0]
  if (/^p[0-3]$/.test(v)) return v.toUpperCase()
  throw new Error(`unknown priority "${value}"; use P0-P3 or now/today/soon/someday`)
}

function resolveWorktree(selector) {
  const w = orca(['worktree', 'show', '--worktree', selector || 'current'])
  const wt = w.worktree ?? w
  return { key: wt.identity?.key, worktreeId: wt.id, name: wt.displayName, path: wt.path }
}

// ---------- capacity ----------

function pressureLevel() {
  try {
    const level = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' }).trim())
    return level >= 4 ? 'critical' : level >= 2 ? 'warn' : 'normal'
  } catch {
    return 'unknown'
  }
}

/**
 * Swap in use, shown for information only: the verdict never reads it. macOS keeps old pages in swap
 * until a process touches them, so swap stays near full long after a pressure peak while RAM is free.
 */
function swap() {
  try {
    const s = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' })
    const num = (name) => Number(new RegExp(`${name} = ([\\d.]+)M`).exec(s)?.[1] ?? 0) / 1024
    return { usedGB: +num('used').toFixed(1), totalGB: +num('total').toFixed(1) }
  } catch {
    return null
  }
}

/** The decision lives in src/capacity.ts, shared with the plugin; Node strips its types. */
const { costsOf, decide, envCost, envSamples, readEnvMemory, typicalEnv, writeEnvMemory, DEFAULT_CONFIG } = await import(new URL('../../../src/capacity.ts', import.meta.url).href)
/** Shared with the plugin: coordinator homes are no code checkouts. */
const { isCoordinatorHome } = await import(new URL('../../../src/coordinators.ts', import.meta.url).href)
/** Shared with the plugin: what agents started outside their sessions (dev servers). */
const { readProcs, readFootprint, startedGroups } = await import(new URL('../../../src/started.ts', import.meta.url).href)
export { decide }

/**
 * One memory budget: Orca's available memory minus the margin, against what a start costs here.
 * With --repo, prices a new worktree of that project; without, the typical project environment.
 */
async function capacity(args = {}) {
  const config = { ...DEFAULT_CONFIG, ...readJson(join(DIR, 'config.json'), {}) }
  const { fromPs, readStore } = await import(new URL('../../../src/worker.ts', import.meta.url).href)
  // The same lineage the sidebar uses: who started whom, and which dispatches have reported.
  const { assignCoordinators, loadLineage, orcaRunner, readCoordinators } = await import(new URL('../../../src/coordinators.ts', import.meta.url).href)
  const lineage = await loadLineage(orcaRunner(ORCA_BIN)).catch(() => ({ dispatcherOf: new Map(), paneOf: new Map() }))
  const rows = assignCoordinators(fromPs(orca(['worktree', 'ps']).worktrees ?? [], readStore()), readCoordinators(), lineage)
  const mem = orca(['diagnostics', 'memory'])
  const sessions = (mem.worktrees ?? []).flatMap((w) => w.sessions ?? [])
  const gb = (b) => Math.round((b / 1024 ** 3) * 10) / 10
  const [procs, footprint] = await Promise.all([readProcs(), readFootprint()])
  const groups = startedGroups(procs, footprint, sessions.map((x) => x.pid).filter(Number.isFinite), rows)

  const agentPanes = new Set(rows.flatMap((r) => r.agents.map((a) => a.paneKey)))
  const perWorktree = new Map()
  for (const g of groups) {
    const w = perWorktree.get(g.path) ?? { repo: g.repo, name: g.worktreeName, path: g.path, gb: 0, top: g.name }
    w.gb += g.memMB / 1024
    perWorktree.set(g.path, w)
  }
  // Every checkout where agents work is a sample, 0 when it started nothing; the plugin keeps the same memory.
  const atWork = rows.filter((r) => r.path && r.agents.length > 0 && !isCoordinatorHome(r.path)).map((r) => ({ path: r.path, repo: r.repo }))
  const costs = costsOf(sessions.filter((x) => agentPanes.has(x.paneKey)).map((x) => x.memory / 1024 ** 3), envSamples([...perWorktree.values()], atWork), readEnvMemory(DIR))
  writeEnvMemory(DIR, costs.envGB)
  const envGB = args.repo ? envCost(costs.envGB, args.repo) : typicalEnv(costs.envGB)
  const pressure = pressureLevel()
  const { verdict, freeGB } = decide({ availableGB: mem.host?.availableMemory ? mem.host.availableMemory / 1024 ** 3 : null, pressure, config, agentGB: costs.agentGB, envGB })

  // What would free the most: environments where no agent is working, then finished sessions.
  const working = new Set(rows.filter((r) => r.agents.some((a) => a.state === 'working')).map((r) => r.path))
  const idleEnvironments = [...perWorktree.values()]
    .filter((w) => !working.has(w.path) && w.gb >= 0.1)
    .sort((x, y) => y.gb - x.gb)
    .map((w) => ({ worktree: `${w.repo}/${w.name}`, process: w.top, gb: gb(w.gb * 1024 ** 3) }))
  const memByPane = Object.fromEntries(sessions.map((x) => [x.paneKey, x.memory]))
  // The sessions the sidebar lists as finished: an open PR's owner, a lead with open workers or one
  // that has not reported worker_done, is still at work.
  const { finishedAgents } = await import(new URL('../../../src/view.ts', import.meta.url).href)
  const checkouts = rows.filter((r) => !isCoordinatorHome(r.path))
  const done = new Set(finishedAgents(checkouts).map((a) => a.paneKey))
  const finishedSessions = checkouts
    .flatMap((r) => r.agents.filter((a) => done.has(a.paneKey)).map((a) => ({ worktree: `${r.repo}/${r.name}`, title: a.title, gb: gb(memByPane[a.paneKey] ?? 0) })))
    .filter((x) => x.gb > 0)
  return {
    verdict,
    freeGB,
    marginGB: config.marginGB,
    pressure,
    // Not part of the decision: an agent must not hold back work or warn the user because of it.
    info: { swap: swap(), note: 'Information only: the verdict ignores swap. macOS keeps old pages in swap long after RAM is free again.' },
    costs: { agentGB: costs.agentGB, envGB: costs.envGB, priced: args.repo ? { repo: args.repo, envGB } : { typicalEnvGB: envGB } },
    reclaimable: { idleEnvironments, finishedSessions }
  }
}

function printCapacity(c) {
  const env = c.costs.priced.repo ? `a new ${c.costs.priced.repo} worktree ~${Math.round((c.costs.agentGB + c.costs.priced.envGB) * 10) / 10} GB` : `a new workstream ~${Math.round((c.costs.agentGB + c.costs.priced.typicalEnvGB) * 10) / 10} GB`
  const lines = [
    `verdict: ${c.verdict}`,
    `free: ${c.freeGB ?? '?'} GB (after a ${c.marginGB} GB margin)  memory pressure: ${c.pressure}${c.info?.swap?.usedGB ? `  swap: ${c.info.swap.usedGB} GB (information only)` : ''}`,
    `costs here: an agent ~${c.costs.agentGB} GB, ${env}`
  ]
  const { idleEnvironments, finishedSessions } = c.reclaimable
  if (idleEnvironments.length) lines.push('environments with no agent working:', ...idleEnvironments.map((e) => `  ${e.worktree}: ${e.process} ${e.gb} GB`))
  if (finishedSessions.length) lines.push('finished but open:', ...finishedSessions.map((x) => `  ${x.worktree}: ${x.title} ${x.gb} GB`))
  console.log(lines.join('\n'))
}

// ---------- queue ----------

/**
 * Everything waiting on the user, ranked the way the sidebar panel ranks it. Reuses the plugin's
 * own TypeScript (Node strips the types), so the two can never disagree.
 */
/** The coordinator file in the working folder or a parent; its repos scope the queue (empty = all). */
function coordinatorScope() {
  let dir = process.cwd()
  while (dir !== '/') {
    const c = readJson(join(dir, COORDINATOR_FILE), null)
    if (c) return c.repos?.length ? c.repos : null
    dir = join(dir, '..')
  }
  return null
}

async function queue({ all = false } = {}) {
  const { fromPs, readStore } = await import(new URL('../../../src/worker.ts', import.meta.url).href)
  const { needsYou, byUrgency, leadAgent } = await import(new URL('../../../src/rank.ts', import.meta.url).href)
  const scope = all ? null : coordinatorScope()
  const rows = fromPs(orca(['worktree', 'ps']).worktrees, readStore(DIR)).filter((r) => !scope || scope.includes(r.repo))
  const item = (row) => {
    const lead = leadAgent(row)
    const s = lead?.summary
    return {
      worktree: row.id,
      name: `${row.repo}/${row.name}`,
      priority: row.priority,
      state: lead?.state ?? row.state,
      title: lead?.title ?? row.name,
      needs: s && s.needs.type !== 'none' ? s.needs : null,
      // Whose ask it is: a lead's or worker's is answered in that agent's chat, not the coordinator's.
      asker: s?.role ?? null,
      effort: s?.effort ?? null,
      since: s?.since ?? null,
      goal: row.card?.goal ?? s?.goal ?? null
    }
  }
  return {
    scope: scope ?? 'all',
    waiting: rows.filter(needsYou).sort(byUrgency).map(item),
    working: rows.filter((r) => r.state === 'working').map(item)
  }
}

const NEED_WORD = { decision: 'pick', approval: 'approval', review: 'review', info: 'answer', action: 'action' }

/** The queue as text; a lead's or worker's ask is attributed to it and answered in its own chat. */
export function formatQueue(q) {
  const word = (p) => (p ? `${p} ${LEVELS[p]}` : 'unrated')
  const lines = [q.waiting.length ? `Waiting on you (${q.waiting.length}), in order:` : 'Nothing is waiting on you.']
  q.waiting.forEach((w, i) => {
    lines.push(`${i + 1}. [${word(w.priority)}] ${w.name}: ${w.title}`)
    const effort = w.effort ? ` (${w.effort})` : ''
    // A lead's or worker's ask is answered in its own chat: name only who waits and on what kind
    // of need, never the question or its options, so a coordinator has nothing to restate.
    const relayed = w.asker === 'lead' || w.asker === 'worker'
    if (w.needs && relayed) lines.push(`   the ${w.asker} waits on your ${NEED_WORD[w.needs.type] ?? w.needs.type}${effort} · answer in its chat (or Up next)`)
    else if (w.needs) lines.push(`   ${w.needs.type}${effort}: ${w.needs.ask}`)
    if (!relayed && w.needs?.options.length) lines.push(`   options: ${w.needs.options.join(' | ')}`)
    else if (w.since) lines.push(`   since: ${w.since}`)
    lines.push(`   open: ${w.worktree}`)
  })
  if (q.working.length) lines.push('', `Working (${q.working.length}): ${q.working.map((w) => w.name).join(', ')}`)
  return lines.join('\n')
}

// ---------- cards ----------

function setCard(args) {
  const wt = resolveWorktree(args.worktree)
  if (!wt.key) throw new Error(`could not resolve worktree "${args.worktree}"`)
  const path = join(CARDS, `${fileKey(wt.key)}.json`)
  const card = readJson(path, {})
  const parent = args.parent ? resolveWorktree(args.parent).key : undefined
  const next = {
    ...card,
    worktree: wt.key,
    worktreeId: wt.worktreeId,
    name: wt.name,
    ...(args.priority && { priority: normalizePriority(args.priority) }),
    ...(args.role && { role: args.role }),
    ...(parent && { parent }),
    ...(args.goal && { goal: args.goal }),
    ...(args.fits && { fits: args.fits }),
    updatedAt: Date.now()
  }
  writeJson(path, next)
  return next
}

function getCard(args) {
  const wt = resolveWorktree(args.worktree)
  return readJson(join(CARDS, `${fileKey(wt.key)}.json`), null)
}

// ---------- resume ----------

/**
 * Pure: of Orca's runs, the ones this coordinator should take back. A run is coordinated from a
 * terminal; when the coordinator slept, that terminal closed. Orca still records the folder a
 * closed terminal ran in, so a run whose closed terminal ran in this folder, and that still has
 * workers, is this coordinator's. Exported for tests.
 */
export function runsToResume({ runs, me, here, live, dirOf, activeWorkers }) {
  return runs.filter((r) => {
    const h = r.coordinator_handle
    return h && h !== me && !live.has(h) && dirOf(h) === here && activeWorkers(r.id) > 0
  })
}

/** Takes back the runs this coordinator's earlier sessions coordinated (Orca only lets a terminal claim a run itself). */
function resume() {
  const me = process.env.ORCA_TERMINAL_HANDLE
  if (!me) throw new Error('run this from your coordinator session in Orca')
  const here = realpathSync(process.cwd())
  const tryOrca = (args) => {
    try {
      return orca(args)
    } catch {
      return null
    }
  }
  const live = new Set((orca(['terminal', 'list']).terminals ?? []).map((t) => t.handle))
  const workers = new Map()
  const activeWorkers = (run) => {
    if (!workers.has(run)) workers.set(run, (tryOrca(['orchestration', 'worker-list', '--run', run])?.workers ?? []).filter((w) => w.terminal && w.terminalState !== 'released').length)
    return workers.get(run)
  }
  const dirOf = (handle) => {
    const t = tryOrca(['terminal', 'show', '--terminal', handle])?.terminal
    const dir = t?.worktreePath || t?.worktreeId?.split('::')[1]
    return dir && existsSync(dir) ? realpathSync(dir) : dir
  }
  // run-list is newest first. `run-use` keeps only the Run it names, so a terminal takes back one:
  // the newest that still has workers. Any others are listed so you can switch to them.
  const [take, ...others] = runsToResume({ runs: orca(['orchestration', 'run-list', '--limit', '30', '--full']).runs ?? [], me, here, live, dirOf, activeWorkers })
  if (!take) return console.log('Nothing to resume.')
  orca(['orchestration', 'run-use', '--id', take.id])
  const line = (r) => `  ${r.id}  ${r.objective} (${activeWorkers(r.id)} worker${activeWorkers(r.id) > 1 ? 's' : ''})`
  console.log(`Resumed coordinating:\n${line(take)}`)
  if (others.length) console.log(`Also from your earlier session (a terminal holds one Run; \`orca orchestration run-use --id <id>\` switches):\n${others.map(line).join('\n')}`)
}

// ---------- summarizer ----------

// The plugin worker summarizes every finished turn; this is the same code, for a manual re-run.
const summarize = await import(new URL('../../../src/summarize.ts', import.meta.url).href)
export const { briefOf, digest, roleOf } = summarize

async function summarizeRun(args) {
  const pane = args.pane
  if (!pane) throw new Error('summarize-run needs --pane <paneKey>')
  const live = args.transcript ? null : orca(['worktree', 'ps']).worktrees.flatMap((w) => w.agents ?? []).find((a) => a.paneKey === pane)
  const found = args.transcript ? { path: args.transcript } : summarize.findTranscript(pane, undefined, { orcaSession: live?.orcaSessionId, provider: live?.agentType })
  if (!found.path) throw new Error(`no transcript known for ${pane}: ${found.why}`)
  const transcript = found.path
  const worktreeId = args.worktreeId || ''
  const card = Object.values(readCardsByWorktreeId()).find((c) => c.worktreeId === worktreeId)
  const started = Date.now()
  const result = await summarize.summarizePane({ pane, transcript, transcriptSource: found.source, worktreeId, goal: card?.goal, force: !!args.force, dir: AGENTS })
  console.log(`${pane}: ${result} in ${Date.now() - started}ms (summarizer v${summarize.SUMMARIZER_VERSION})`)
}

function readCardsByWorktreeId() {
  if (!existsSync(CARDS)) return {}
  return Object.fromEntries(readdirSync(CARDS).filter((f) => f.endsWith('.json')).map((f) => [f, readJson(join(CARDS, f), {})]))
}

// ---------- bots ----------

// The sidebar's own grouping (src/bots.ts): `orca bot list` decides which bots exist, a
// coordinator.json `bots` adopts one (by name or folder, any case), the rest are Personal.
const { botDirectory, readBotFolders } = await import(new URL('../../../src/bots.ts', import.meta.url).href)
const { readCoordinators } = await import(new URL('../../../src/coordinators.ts', import.meta.url).href)
export { botDirectory }

function bots(args = {}) {
  const listed = orca(['bot', 'list']).bots ?? []
  const repo = typeof args.repo === 'string' ? args.repo : null
  return { repo, bots: botDirectory({ listed, folders: readBotFolders(), coordinators: readCoordinators(), repo }) }
}

/** The bots as text: one block per bot under its coordinator (or Personal), with its commands. */
export function formatBots({ repo, bots }) {
  if (!bots.length) return repo ? `No bots for ${repo}. Do the work yourself, or ask your coordinator.` : 'No bots on this computer.'
  const out = [repo ? `Bots for ${repo}:` : 'Bots:']
  let group
  for (const b of bots) {
    const g = b.coordinator ?? 'Personal (cross-project)'
    if (g !== group) out.push('', `${g}:`)
    group = g
    out.push(`  ${b.name}${b.paused ? ' (paused)' : ''}${b.purpose ? `: ${b.purpose}` : ''}`)
    out.push(`    delegate: ${b.delegate}`)
    out.push(`    ask:      ${b.ask}`)
  }
  return out.join('\n')
}

// ---------- role ----------

const { clearRole, currentSession, recordLead, recordedRole } = await import('./roles.mjs')

/**
 * `role lead` records that the user made this Claude session the lead of its workstream, so the
 * SessionStart hook gives the role back on every resume and compaction, and the Stop hook and the
 * sidebar treat it as a lead. `role clear` removes the record. The session is Claude Code's
 * (roles.mjs currentSession); a coordinator folder is always its coordinator, never recorded.
 */
export function role(args, { env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  const [, what] = args._
  if (what !== 'lead' && what !== 'clear') throw new Error('usage: orca-flow role lead|clear')
  const coordinators = join(home, 'orca', 'coordinators')
  if (what === 'lead' && (cwd === coordinators || cwd.startsWith(`${coordinators}/`))) {
    throw new Error(`${cwd} is a coordinator folder: the session here is its coordinator, not a lead; nothing recorded`)
  }
  const session = currentSession({ env, cwd, home })
  if (!session) throw new Error('no Claude Code session found (CLAUDE_CODE_SESSION_ID is not set): role records work in Claude Code only')
  if (what === 'lead') {
    recordLead(DIR, session.id, { by: 'user', cwd })
    return `Recorded session ${session.id} as the lead of this workstream (from ${session.from}). The lead instructions come back on every resume and compaction; \`orca-flow role clear\` removes it.`
  }
  return clearRole(DIR, session.id) ? `Cleared the lead record of session ${session.id}.` : `Session ${session.id} had no role record.`
}

// ---------- goals ----------

const goals = await import('./goals.mjs')

/** Who a goal change is recorded for: --by, else the recorded lead / coordinator folder / worktree name, else "an agent". */
function goalBy(args, { env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  if (typeof args.by === 'string' && args.by.trim()) return args.by.trim()
  const coordinators = join(home, 'orca', 'coordinators')
  if (cwd === coordinators || cwd.startsWith(`${coordinators}/`)) return `coordinator ${cwd.slice(coordinators.length + 1).split('/')[0]}`.trim()
  let name
  try {
    name = resolveWorktree('current').name
  } catch {}
  const session = currentSession({ env, cwd, home })
  const lead = session && recordedRole(DIR, session.id) === 'lead'
  return name ? `${lead ? 'lead' : 'agent'} ${name}` : lead ? 'lead' : 'an agent'
}

/** A worktree selector as the link a goal stores. */
function worktreeLink(selector) {
  const wt = resolveWorktree(selector)
  if (!wt.key && !wt.path) throw new Error(`could not resolve worktree "${selector}"`)
  return { key: wt.key, path: wt.path, name: wt.name, worktreeId: wt.worktreeId }
}

const many = (v) => (v === undefined ? [] : [].concat(v)).filter((x) => typeof x === 'string')
const WHEN = (at) => {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000))
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`
}

/** One goal as plain text. */
export function formatGoal(g) {
  const done = g.steps.filter((s) => s.done).length
  const out = [`${g.id}  ${g.title}${g.status === 'open' ? '' : `  [${g.status}]`}${g.steps.length ? `  ${done}/${g.steps.length}` : ''}`]
  if (g.next) out.push(`  next: ${g.next}`)
  if (g.doneWhen) out.push(`  done when: ${g.doneWhen}`)
  g.steps.forEach((s, i) => out.push(`  ${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}`))
  if (g.note) out.push(`  note: ${g.note}`)
  const links = [...g.links.linear, ...g.links.worktrees.map((w) => w.name || w.path || w.key)]
  if (links.length) out.push(`  linked: ${links.join(', ')}`)
  out.push(`  last change: ${g.lastChange.by}, ${g.lastChange.field}, ${WHEN(g.lastChange.at)}`)
  return out.join('\n')
}

/** The list: one line per goal, then its next step. */
export function formatGoals(list) {
  if (!list.length) return 'No goals.'
  return list
    .map((g) => {
      const done = g.steps.filter((s) => s.done).length
      return `${g.id}  ${g.title}${g.status === 'open' ? '' : `  [${g.status}]`}${g.steps.length ? `  ${done}/${g.steps.length}` : ''}${g.next ? `\n    next: ${g.next}` : ''}`
    })
    .join('\n')
}

/** `orca-flow goal ...`: returns the text to print (or the JSON value with --json). */
export function goalCommand(args, ctx = {}) {
  const [, sub, id, ...rest] = args._
  const data = ctx.data ?? DIR
  // Off in Settings → Features: say so, and read and write nothing.
  if (!goals.goalsEnabled({ data })) return goals.GOALS_OFF
  const by = () => goalBy(args, ctx)
  const shown = (g) => (args.json ? g : formatGoal(g))
  const id1 = () => {
    if (!id) throw new Error(`usage: orca-flow goal ${sub} <id> (orca-flow goal list shows the ids)`)
    return id
  }
  switch (sub) {
    case 'add': {
      const title = args._.slice(2).join(' ')
      const worktrees = args.worktree ? [worktreeLink(args.worktree)] : []
      const g = goals.add(title, { note: args.note, next: args.next, doneWhen: args['done-when'], steps: many(args.step), linear: many(args.linear), worktrees }, { data, by: by() })
      return args.json ? g : `Added.\n${formatGoal(g)}`
    }
    case 'list': {
      let list = goals.list({ data })
      if (args.worktree) list = goals.forWorktree(worktreeLink(args.worktree), { data, all: !!args.all })
      else if (!args.all) list = list.filter((g) => g.status !== 'done')
      return args.json ? list : formatGoals(list)
    }
    case 'show': {
      const g = goals.get(id1(), { data })
      if (!g) throw new Error(`no goal "${id}"`)
      return shown(g)
    }
    case 'set':
      return shown(goals.update(id1(), { title: args.title, note: args.note, next: args.next, doneWhen: args['done-when'] }, by(), { data }))
    case 'step': {
      const [action, ...words] = rest
      const text = words.join(' ')
      if (action === 'add') return shown(goals.addStep(id1(), text, by(), { data }))
      if (action === 'tick' || action === 'untick') return shown(goals.setStep(id1(), text, action === 'tick', by(), { data }))
      throw new Error('usage: orca-flow goal step <id> add "<text>" | tick <n|text> | untick <n|text>')
    }
    case 'link':
    case 'unlink': {
      const target = args.linear ? { linear: String([].concat(args.linear)[0]) } : args.worktree ? { worktree: worktreeLink(args.worktree) } : null
      if (!target) throw new Error(`usage: orca-flow goal ${sub} <id> --worktree <sel> | --linear <ID>`)
      return shown(goals[sub](id1(), target, by(), { data }))
    }
    case 'propose-done':
      return shown(goals.propose(id1(), by(), { data }))
    case 'done':
      return shown(goals.done(id1(), by(), { data }))
    case 'reopen':
      return shown(goals.reopen(id1(), by(), { data }))
    default:
      throw new Error('usage: orca-flow goal add|list|show|set|step|link|unlink|propose-done|done|reopen (see the header of scripts/orca-flow.mjs)')
  }
}

// ---------- skills-reloaded ----------

const reload = await import('./skill-reload.mjs')

/**
 * `skills-reloaded`: the agent re-read its skill files after the sidebar's note (skill-reload.mjs)
 * and records it, keyed by its Orca pane (else its Claude session), with the hash of the files as
 * they are now. The sidebar counts it as reloaded when that hash is the one the request asked for.
 */
export function skillsReloaded(args, { env = process.env, cwd = process.cwd(), home = homedir(), script = process.argv[1]?.endsWith('orca-flow.mjs') ? process.argv[1] : fileURLToPath(import.meta.url), now = Date.now() } = {}) {
  // The skill as the agent reached it (through the skill link, like the hooks' skillOf), not where the link points.
  // Orca gives Claude Code's shell ORCA_AGENT_PANE and Codex's ORCA_PANE_KEY (shell_environment_policy.set).
  const pane = env.ORCA_AGENT_PANE || env.ORCA_PANE_KEY || null
  // Claude Code's session, else the Codex thread this command runs in.
  const session = currentSession({ env, cwd, home })?.id ?? env.CODEX_THREAD_ID ?? null
  const skill = join(script, '..', '..')
  const data = env.ORCA_FLOW_DIR || join(home, '.orca-flow')
  try {
    return reload.confirmReload(data, { pane, session, skill, request: typeof args.request === 'string' ? args.request : null, now }).message
  } catch (e) {
    // A sandboxed shell (Codex workspace-write) cannot write ~/.orca-flow; the PostToolUse hook, which
    // runs outside the sandbox, records this command instead. Not an error for the agent to act on.
    if (['EPERM', 'EACCES', 'EROFS'].includes(e?.code) && pane) return `This shell cannot write ${data} (sandbox); Orca Flow's hook records the reload from this command. Nothing else to do.`
    throw e
  }
}

// ---------- route, dispatch, plan ----------

const flow = await import('./dispatch.mjs')
const { discover } = await import(new URL('../../../src/model-discovery.ts', import.meta.url).href)

/** The real machine: Orca's CLI, model discovery and the memory gate. Tests pass fakes instead. */
function liveDeps(args = {}) {
  return {
    dir: DIR,
    cwd: process.cwd(),
    orcaBin: ORCA_BIN,
    orca: flow.orcaRunner(ORCA_BIN),
    // Codex lists models from the selected Codex account's home, as in Settings (src/worker.ts
    // discoverHere). Cached 10 minutes per home in models-cache.json; --refresh-models looks again.
    discover: flow.accountDiscovery(DIR, { orca: flow.orcaRunner(ORCA_BIN, { timeoutMs: 10_000 }), discover: (opts) => discover(flow.execCommand, { orcaBin: ORCA_BIN, ...opts }), refresh: !!args['refresh-models'] }),
    capacity,
    readStdin: () => readFileSync(0, 'utf8'),
    out: (s) => console.log(s),
    now: () => new Date()
  }
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const [command] = args._
  switch (command) {
    case 'queue': {
      const q = await queue({ all: !!args.all })
      console.log(args.json ? JSON.stringify(q, null, 2) : formatQueue(q))
      break
    }
    case 'capacity': {
      const c = await capacity(args)
      args.json ? console.log(JSON.stringify(c, null, 2)) : printCapacity(c)
      break
    }
    case 'set':
      console.log(JSON.stringify(setCard(args), null, 2))
      break
    case 'get':
      console.log(JSON.stringify(getCard(args), null, 2))
      break
    case 'summarize-run':
      await summarizeRun(args)
      break
    case 'resume':
      resume()
      break
    case 'role':
      console.log(role(args))
      break
    case 'goal': {
      const out = goalCommand(args)
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
      break
    }
    case 'skills-reloaded':
      console.log(skillsReloaded(args))
      break
    case 'bots': {
      const b = bots(args)
      console.log(args.json ? JSON.stringify(b, null, 2) : formatBots(b))
      break
    }
    case 'types':
    case 'route':
    case 'dispatch':
    case 'plan': {
      const run = { types: flow.typesCommand, route: flow.routeCommand, dispatch: flow.dispatchCommand, plan: flow.planCommand }[command]
      try {
        process.exitCode = await run(args, liveDeps(args))
      } catch (e) {
        if (!(e instanceof flow.Refused || e instanceof flow.UsageError)) throw e
        console.error(e.message)
        process.exitCode = e instanceof flow.Refused ? e.code : 1
      }
      break
    }
    default:
      console.log('usage: orca-flow <queue|capacity|set|get|goal|resume|summarize-run|bots|role|skills-reloaded|types|route|dispatch|plan> [options]  (see the header of scripts/orca-flow.mjs)')
      process.exit(command ? 1 : 0)
  }
}

// Run only as a command (also through a symlink on PATH), not when a test imports this file.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.error(`orca-flow: ${e.message}`)
    process.exit(1)
  })
}
