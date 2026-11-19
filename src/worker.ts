// The plugin's own worker. Orca starts it on the panel's first plugin.request or on an event,
// and transpiles this file when it loads.
//
// The plugin API only reports agent status *changes*, so a fresh panel would show no status.
// `orca worktree ps --json` has the full live snapshot (agents, pinned, unread, last activity),
// so the worker reads that and re-reads it whenever Orca fires an agent or workspace event.
// It is the CLI's JSON, not the plugin API, so it falls back to `workspace.list` if it fails.
//
// Cards (coordinator's goal and priority) come from ~/.orca-flow/cards, written by `orca-flow set`.
// Summaries (end-of-turn status by Haiku) are written to ~/.orca-flow/agents by this worker when
// Orca reports a finished turn (src/summarize.ts). The worker watches that folder.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { costsOf, decide, DEFAULT_CONFIG, diskFreeOf, envSamples, FALLBACK, readEnvMemory, typicalEnv, writeEnvMemory, type Pressure } from './capacity.ts'
import { closeSessions, loadCockpit, removeWorktree } from './cockpit.ts'
import { assignCoordinators, coordinatorSession, COORDINATOR_HOME, deleteFolder, isCoordinatorHome, loadLineage, orcaRunner, readCoordinators, readLinearMemory, readOwners, rememberOwners, scaffoldCoordinator, validateName, updateCoordinatorSessions, writeLinearMemory, writeLinearTeams, writeLook, writeOwners, writeCoordinatorSessions, type CoordinatorInfo, type Lineage } from './coordinators.ts'
import { encodeLinear, linkedIssueOf, linkRows, loadLinear, pruneSent, sendIssue, teamsOf } from './linear.ts'
import { associateSession, chooseSession, deliverCurrent, deliveryBlock, DeliveryUncertainError, exclusive, memberAgent, memberFrom, readMemberHistory, reconcileSessions, resumeExactMember, selectCurrent, sessionChoices, verifyConversation, wakeCoordinator, type ResumeIo } from './coordinator-sessions.ts'
import { askingRows, CHAT_KEYS, chatTargets, FOLDED_KEY, finishedAgents, freeLooks, showable, type ChatTarget } from './view.ts'
import type { AgentInfo, AgentState, AgentSummary, Capacity, Coordinator, LinearData, Priority, Snapshot, WakeOutcome, WorkspaceRow, WorkstreamCard, CoordinatorSessions } from './protocol.ts'
import { claimsAsk, leadAgent, nextTarget } from './rank.ts'
import { createWriter } from './writer.ts'
import { currentSummaryJobs, findTranscript, refreshStale, summaryMatches, summarizePane, summaryProviders, turnSummarizer } from './summarize.ts'
import { ensureOwnLinks, ensureOwnStopHook, ensureSeeds, linksFor, pluginDir, seedsFor, stopHookFor } from './install.ts'
import { latestRelease, newerVersion, startUpdate, updateItem, updater, type UpdateState } from './update.ts'
import { readFootprint, readProcs, startedGroups } from './started.ts'
import { backgroundReader } from './background.ts'

const background = backgroundReader()
/** Workaround for stablyai/orca#26192; remove with src/background.ts once Orca ships stablyai/orca#36164. */
const quietPane = (pane: string) => background.quiet(findTranscript(pane).path)

const ORCA_BIN = ['/Applications/Orca.app/Contents/Resources/bin/orca'].find(existsSync) ?? 'orca'
const DATA_DIR = join(homedir(), '.orca-flow')

/** Most urgent first: what needs the person outranks what is running. */
const URGENCY: AgentState[] = ['blocked', 'waiting', 'working', 'done']

type PsAgent = {
  paneKey?: string
  /** The pane that started this agent (a lead's or coordinator's), when Orca knows it. */
  parentPaneKey?: string | null
  /** Orca's id for the conversation; survives `claude --resume` in a new terminal. */
  orcaSessionId?: string | null
  toolName?: string | null
  toolInput?: string | null
  state?: string
  workingMode?: string | null
  /** The agent's own turn, apart from background work Orca folds into `state`. */
  mainAgent?: { state?: string } | null
  /** What Claude reports on its terminal: `working` while a shell or Monitor of its own still runs. */
  programStatus?: { state?: string } | null
  agentType?: string | null
  hasLivePty?: boolean
  structuredHostOwned?: boolean
  conversationName?: string | null
  taskTitle?: string | null
  displayName?: string | null
}

export type PsWorktree = {
  path?: string
  isMainWorktree?: boolean
  worktreeId?: string
  parentWorktreeId?: string | null
  identity?: { key?: string }
  displayName?: string
  repo?: string
  branch?: string | null
  isArchived?: boolean
  isPinned?: boolean
  unread?: boolean
  isActive?: boolean
  liveTerminalCount?: number
  workspaceStatus?: string | null
  lastActivityAt?: number | null
  sortOrder?: number
  linkedPR?: { number?: number; url?: string; state?: string; title?: string; checksStatus?: string | null; checksSummary?: { state?: string } | null } | null
  /** The Linear issue linked with `--linear-issue`: its identifier. */
  linkedLinearIssue?: string | null
  agents?: PsAgent[]
}

function shortBranch(branch: string | null | undefined): string | null {
  return branch ? branch.replace(/^refs\/heads\//, '') : null
}

/** Files are keyed by the id with anything unsafe for a filename replaced, as orca-flow writes them. */
const fileKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_')

export type Store = { cards: Record<string, WorkstreamCard>; summaries: Record<string, AgentSummary> }

function readFolder<T>(dir: string): Record<string, T> {
  if (!existsSync(dir)) return {}
  const out: Record<string, T> = {}
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      out[file.slice(0, -5)] = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      // A file mid-write or hand-edited badly; the next change reads it again.
    }
  }
  return out
}

export function readStore(dir = DATA_DIR): Store {
  return { cards: readFolder(join(dir, 'cards')), summaries: readFolder(join(dir, 'agents')) }
}

/** Orca's CI checks for a PR, as its worktree card reads them. */
function checksOf(pr: { checksStatus?: string | null; checksSummary?: { state?: string } | null }): 'success' | 'pending' | 'failure' | 'cancelled' | null {
  const s = pr.checksStatus ?? pr.checksSummary?.state ?? null
  return s === 'success' || s === 'pending' || s === 'failure' || s === 'cancelled' ? s : null
}

/** The first question of a pending AskUserQuestion call, from Orca's toolInput (JSON or plain text). */
export function questionOf(a: PsAgent): string | null {
  if (a.state !== 'waiting' || a.toolName !== 'AskUserQuestion' || !a.toolInput) return null
  try {
    const input = JSON.parse(a.toolInput)
    const q = input?.questions?.[0]?.question ?? input?.question
    if (typeof q === 'string' && q.trim()) return q.trim()
  } catch {}
  const m = /"question"\s*:\s*"([^"]+)/.exec(a.toolInput)
  return m ? m[1] : null
}

/**
 * Orca's state, except that an agent whose turn is done and whose only running background work is
 * an artifact watch is done, not monitoring (src/background.ts, until Orca ships stablyai/orca#36164).
 * Both must agree: Claude's terminal status says nothing of its own runs (it reports a shell or a
 * Monitor, of any kind, but not a session cron), and its transcript shows a watch, every shell and
 * Monitor ended, and no cron or scheduled wake-up.
 */
function stateOf(a: PsAgent, quiet: (pane: string) => boolean): { state: AgentState; workingMode: string | null } {
  const idleWatcher = a.state === 'working' && a.workingMode === 'monitoring' && a.mainAgent?.state === 'done'
    && a.programStatus?.state === 'done' && !!a.paneKey && quiet(a.paneKey)
  return idleWatcher ? { state: 'done', workingMode: null } : { state: a.state as AgentState, workingMode: a.workingMode ?? null }
}

function toAgent(a: PsAgent, store: Store, quiet: (pane: string) => boolean): AgentInfo | null {
  if (!URGENCY.includes(a.state as AgentState)) return null
  const { state, workingMode } = stateOf(a, quiet)
  const saved = (a.paneKey && store.summaries[fileKey(a.paneKey)]) || null
  const summary = saved && summaryMatches(saved, { orcaSession: a.orcaSessionId, provider: a.agentType }) ? saved : null
  return {
    paneKey: a.paneKey ?? '',
    workingMode,
    coordinator: 'you',
    leadPane: null,
    parentPane: a.parentPaneKey ?? null,
    orcaSession: a.orcaSessionId ?? null,
    dispatch: null,
    terminal: null,
    question: questionOf(a),
    state,
    // Orca names a worker's conversation after its task id (worker-task_…); skip names that are ids.
    title: [summary?.title, a.conversationName, a.taskTitle, a.displayName].find((t) => showable(t ?? undefined)) || a.agentType || 'Agent',
    task: a.taskTitle ?? a.displayName ?? null,
    agentType: a.agentType ?? null,
    live: a.hasLivePty === true || a.structuredHostOwned === true,
    summary
  }
}

const highest = (levels: (Priority | undefined)[]) =>
  (levels.filter(Boolean) as Priority[]).sort()[0] ?? null

/** A workspace's plugin id: its identity key, or (folder workspaces have none) the id the plugin API lists for its path. */
const workspaceId = (w: PsWorktree, idByPath: Map<string, string>) =>
  w.identity?.key ? `identity:${w.identity.key}` : (w.path && idByPath.get(w.path)) || null

/** `quiet(pane)`: the pane's only running background work is an artifact watch (see `stateOf`). */
export function fromPs(worktrees: PsWorktree[], store: Store = { cards: {}, summaries: {} }, idByPath = new Map<string, string>(), quiet: (pane: string) => boolean = () => false): WorkspaceRow[] {
  const idOf = new Map(worktrees.map((w) => [w.worktreeId, workspaceId(w, idByPath)]))
  return worktrees
    .filter((w) => !w.isArchived && workspaceId(w, idByPath))
    .map((w) => {
      const agents = (w.agents ?? []).map((a) => toAgent(a, store, quiet)).filter((a): a is AgentInfo => a !== null)
      const state = URGENCY.find((s) => agents.some((a) => a.state === s)) ?? null
      const card = w.identity?.key ? (store.cards[fileKey(w.identity.key)] ?? null) : null
      return {
        id: workspaceId(w, idByPath)!,
        name: w.displayName ?? '',
        branch: shortBranch(w.branch),
        repo: w.repo ?? '',
        path: w.path ?? null,
        main: Boolean(w.isMainWorktree),
        agents,
        state,
        priority: card?.priority ?? highest(agents.map((a) => a.summary?.priority)),
        card,
        parentId: (w.parentWorktreeId && idOf.get(w.parentWorktreeId)) || (card?.parent ? `identity:${card.parent}` : null),
        liveTerminals: w.liveTerminalCount ?? 0,
        pinned: !!w.isPinned,
        unread: !!w.unread,
        active: !!w.isActive,
        workspaceStatus: w.workspaceStatus ?? null,
        lastActivityAt: w.lastActivityAt ?? null,
        createdAt: w.sortOrder ?? 0,
        pr: w.linkedPR?.number && w.linkedPR.url ? { number: w.linkedPR.number, url: w.linkedPR.url, state: w.linkedPR.state ?? '', title: w.linkedPR.title ?? '', checks: checksOf(w.linkedPR) } : null,
        linearIssue: linkedIssueOf(w.linkedLinearIssue)
      }
    })
}

/**
 * Shows an agent's session: its workspace, then its own tab. `workspace.open` alone lands on
 * whichever tab was last active there, so every agent of a worktree would open its lead's tab. The
 * host API has no call to focus a tab, so the CLI switches to it. With no terminal (a session that
 * slept) or when the switch fails, the workspace alone is shown.
 */
export async function openAgent(
  orca: Pick<OrcaWorkerApi, 'host' | 'log'>,
  run: (args: string[]) => Promise<unknown>,
  input: { workspaceId: string; terminal?: string }
): Promise<{ opened: boolean }> {
  if (input.terminal) {
    try { await run(['terminal', 'switch', '--terminal', input.terminal]) }
    catch (e) { orca.log(`terminal switch failed: ${(e as Error).message}`); return { opened: false } }
  }
  await orca.host.call('workspace.open', { workspaceId: input.workspaceId })
  return { opened: true }
}

/**
 * Option+N: opens the nth chat through the path a click on its row takes (a coordinator wakes or
 * shows its session; an agent shows its workspace and its own tab). Says why when nothing opened.
 */
export async function openNthChat(
  targets: ChatTarget[],
  n: number,
  open: { coordinator: (key: string) => Promise<{ ok: boolean; error?: string }>; chat: (input: { workspaceId: string; terminal?: string }) => Promise<unknown> }
): Promise<string | undefined> {
  const t = targets[n - 1]
  if (!t) return `Orca Flow has no chat ${n}`
  if ('coordinator' in t) {
    const r = await open.coordinator(t.coordinator)
    return r.ok ? undefined : r.error
  }
  await open.chat(t.terminal ? { workspaceId: t.workspaceId, terminal: t.terminal } : { workspaceId: t.workspaceId })
}

function runPs(): Promise<PsWorktree[]> {
  return new Promise((resolve, reject) => {
    execFile(ORCA_BIN, ['worktree', 'ps', '--json'], { maxBuffer: 32 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        const parsed = JSON.parse(stdout)
        if (!parsed.ok) return reject(new Error(parsed.error?.message ?? 'orca worktree ps failed'))
        resolve(parsed.result.worktrees)
      } catch (e) {
        reject(e)
      }
    })
  })
}

async function fromApi(orca: OrcaWorkerApi): Promise<WorkspaceRow[]> {
  const { workspaces } = await orca.host.call('workspace.list')
  return workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    branch: shortBranch(w.branch),
    repo: w.path.split('/').filter(Boolean).at(-1) ?? w.path,
    path: w.path,
    main: false,
    agents: [],
    state: null,
    priority: null,
    card: null,
    parentId: null,
    liveTerminals: 0,
    pinned: false,
    unread: false,
    active: false,
    workspaceStatus: null,
    lastActivityAt: null,
    createdAt: 0,
    pr: null
  }))
}

function pressureLevel(): Pressure {
  try {
    const level = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' }).trim())
    return level >= 4 ? 'critical' : level >= 2 ? 'warn' : 'normal'
  } catch {
    return 'unknown'
  }
}

/** What capacity is computed from; refreshed in the background so a snapshot never waits on it. */
export type MemoryFacts = { availableGB: number | null; totalGB: number | null; agentGB: number; envGB: Record<string, number>; diskFreeGB?: number | null }
let memory: MemoryFacts = { availableGB: null, totalGB: null, agentGB: FALLBACK.agentGB, envGB: {} }
let memoryAt = 0
let envAt = 0
let memoryLoading = false

/** Orca's memory report every 15 s; what each project's environment costs every 5 min (a process scan). */
function refreshMemory(rows: WorkspaceRow[], onLoaded: () => void): void {
  const now = Date.now()
  if (memoryLoading || now - memoryAt < 15_000) return
  memoryLoading = true
  const run = orcaRunner(ORCA_BIN)
  ;(async () => {
    const mem = await run(['diagnostics', 'memory'])
    const sessions: { paneKey: string; memory: number; pid?: number }[] = (mem?.worktrees ?? []).flatMap((w: any) => w.sessions ?? [])
    const agentPanes = new Set(rows.flatMap((r) => r.agents.map((a) => a.paneKey)))
    const gb = (b: number) => b / 1024 ** 3
    let envGB = memory.envGB
    if (now - envAt >= 5 * 60_000) {
      const [procs, footprint] = await Promise.all([readProcs(), readFootprint()])
      const pids = sessions.map((s) => s.pid).filter((p): p is number => typeof p === 'number')
      const started = startedGroups(procs, footprint, pids, rows).map((g) => ({ path: g.path, repo: g.repo, gb: g.memMB / 1024 }))
      const checkouts = rows.filter((r) => r.path && r.agents.length > 0 && !isCoordinatorHome(r.path)).map((r) => ({ path: r.path!, repo: r.repo }))
      envGB = costsOf([], envSamples(started, checkouts), readEnvMemory(DATA_DIR)).envGB
      writeEnvMemory(DATA_DIR, envGB)
      envAt = now
    }
    const df = await new Promise<string>((resolve) => execFile('df', ['-k', '-P', homedir()], { timeout: 5000 }, (_e, out) => resolve(String(out ?? ''))))
    memory = {
      diskFreeGB: diskFreeOf(df),
      availableGB: mem?.host?.availableMemory ? gb(mem.host.availableMemory) : null,
      totalGB: mem?.host?.totalMemory ? gb(mem.host.totalMemory) : null,
      agentGB: costsOf(sessions.filter((s) => agentPanes.has(s.paneKey)).map((s) => gb(s.memory)), []).agentGB,
      envGB
    }
    memoryAt = now
    onLoaded()
  })()
    .catch(() => {})
    .finally(() => (memoryLoading = false))
}

/** ~/.orca-flow/config.json, the user's settings; empty when it is missing or broken. */
function readConfig(dir = DATA_DIR): Record<string, unknown> {
  try {
    const c = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    return c && typeof c === 'object' ? c : {}
  } catch {
    return {}
  }
}

/** The same decision `orca-flow capacity` makes, from facts the worker keeps. */
export function capacityOf(rows: WorkspaceRow[], pressure: Pressure, facts: MemoryFacts = memory, dir = DATA_DIR, isHome: (path: string | null) => boolean = isCoordinatorHome): Capacity {
  const config = { ...DEFAULT_CONFIG, ...readConfig(dir) }
  // In general, "can a new workstream start?" prices the typical environment of the projects here.
  const envGB = typicalEnv(facts.envGB)
  const { verdict, freeGB } = decide({ availableGB: facts.availableGB, pressure, config, agentGB: facts.agentGB, envGB })
  const checkouts = rows.filter((r) => r.liveTerminals > 0 && !isHome(r.path))
  return {
    verdict,
    freeGB,
    marginGB: config.marginGB,
    measuring: facts === memory && memoryAt === 0,
    diskFreeGB: facts.diskFreeGB ?? null,
    agentGB: facts.agentGB,
    envGB,
    pressure,
    // The same finished sessions the panel's footer lists (an open PR's owner is still at work).
    finishedOpen: finishedAgents(checkouts).length
  }
}

/**
 * Pure: the coordinator's own session among the agents of its folder's row (see coordinatorSession):
 * what its row's face shows, what a click on it brings to the front, and where a message to it is typed.
 */
export const sessionIn = (row: WorkspaceRow): AgentInfo | null =>
  coordinatorSession(row.agents, (pane) => row.agents.some((a) => a.paneKey === pane && a.dispatch !== null))

/**
 * A coordinator's own workspace is its row in the panel, not a worktree in the tree: its session
 * (see coordinatorSession) drives the coordinator's face and ask, and each other agent there becomes
 * a row of its own (folderRows). Fills each coordinator's workspace, focus and session in place;
 * `dirs[i]` is `coordinators[i]`'s folder. Returns the rows the panel shows.
 */
export function foldCoordinatorFolders(all: WorkspaceRow[], coordinators: Coordinator[], dirs: string[]): WorkspaceRow[] {
  const index = new Map(dirs.map((d, i) => [d, i]))
  return all.flatMap((row) => {
    const i = row.path ? index.get(row.path) : undefined
    if (i === undefined) return [row]
    const c = coordinators[i]
    const members = c.sessions?.members.map((m) => { const a = memberAgent(m, all); return { ...m, agent: a?.live === false ? null : a } })
    const session = members ? members.find((m) => m.id === c.sessions?.current)?.agent ?? null : sessionIn(row)
    c.members = members
    if (!session && !c.sessions) c.sessionNotice = 'No unambiguous coordinator session. Use Sessions to explicitly associate a member and make it current.'
    c.workspaceId = row.id
    c.active = row.active
    // Its session counts only while a terminal is open with an agent in it.
    c.session = row.liveTerminals > 0 ? session : null
    const memberPanes = new Set(c.sessions ? c.sessions.members.flatMap((m) => { const a = memberAgent(m, [row]); return a ? [a.paneKey] : [] }) : session ? [session.paneKey] : [])
    return folderRows({ ...row, agents: row.agents.filter((a) => !memberPanes.has(a.paneKey)) }, null, c.key)
  })
}

/**
 * Pure: a row for each agent in a coordinator's folder other than its session (a lead or worker the
 * coordinator started in a tab there), so it shows under the coordinator like a worktree's lead and
 * its ask reaches Up next. No branch or PR: the folder is no worktree, and it is never removed.
 */
export function folderRows(row: WorkspaceRow, session: AgentInfo | null, coordinator: string): WorkspaceRow[] {
  return row.agents.filter((a) => a !== session).map((a) => ({
    ...row,
    agents: [a],
    state: a.state,
    priority: row.card?.priority ?? a.summary?.priority ?? null,
    branch: null,
    pr: null,
    folderOf: coordinator
  }))
}

/** Every row of the last snapshot, coordinator workspaces included (the panel's rows leave them out). */
let allRows: WorkspaceRow[] = []

/** Summary targets include every live member, independently of which member receives messages.
 * Never read persisted lastAgent history as live inventory. A contradictory pane is unavailable,
 * not an invitation to choose the first member, current recipient, or provider.
 */
export function summaryAgents(snap: Pick<Snapshot, 'rows' | 'coordinators'>): { agent: AgentInfo; worktreeId?: string }[] {
  const candidates = [
    ...snap.rows.flatMap((r) => r.agents.map((agent) => ({ agent, worktreeId: r.id }))),
    ...(snap.coordinators ?? []).flatMap((c) => c.members !== undefined
      ? c.members.flatMap((m) => m.agent && m.agent.orcaSession === m.orcaSession && m.agent.agentType === m.agentType
        ? [{ agent: m.agent, worktreeId: m.workspaceId }] : [])
      : c.session ? [{ agent: c.session, worktreeId: c.workspaceId ?? undefined }] : [])
  ]
  const panes = new Map<string, { agent: AgentInfo; worktreeId?: string } | null>()
  for (const target of candidates) {
    const a = target.agent
    if (!a.paneKey || a.live === false) continue
    if (!panes.has(a.paneKey)) { panes.set(a.paneKey, target); continue }
    const previous = panes.get(a.paneKey)
    if (previous && (previous.worktreeId !== target.worktreeId || previous.agent.orcaSession !== a.orcaSession
      || previous.agent.agentType !== a.agentType || previous.agent.state !== a.state)) panes.set(a.paneKey, null)
  }
  return [...panes.values()].filter((target): target is { agent: AgentInfo; worktreeId?: string } => target !== null)
}

/** With `idle`, only panes whose own turn is not running. */
export function livePanes(snap: Pick<Snapshot, 'rows' | 'coordinators'>, idle = false): string[] {
  return summaryAgents(snap).filter(({ agent }) => !idle || agent.state === 'done' || agent.state === 'waiting').map(({ agent }) => agent.paneKey)
}

/** A coordinator's workspace has a live session: an open terminal with an agent in it. */
export function isLive(dir: string, rows = allRows): boolean {
  return rows.some((r) => r.path === dir && r.liveTerminals > 0 && r.agents.length > 0)
}

/** The last lineage loaded; refreshed in the background so a snapshot never waits on it. */
let lineage: Lineage = { dispatcherOf: new Map(), paneOf: new Map() }
let lineageAt = 0
let lineageLoading = false

/** Agent panes that existed when the lineage last loaded: a new one may be a freshly started worker. */
let lineagePanes = new Set<string>()

function refreshLineage(orca: OrcaWorkerApi, onLoaded: () => void, panes: string[] = []): void {
  const unseen = panes.some((p) => !lineagePanes.has(p))
  if (lineageLoading || Date.now() - lineageAt < (unseen ? 10_000 : 60_000)) return
  lineageLoading = true
  const seen = new Set(panes)
  loadLineage(orcaRunner(ORCA_BIN))
    .then((next) => {
      lineagePanes = seen
      lineage = next
      lineageAt = Date.now()
      onLoaded()
    })
    .catch((e: Error) => orca.log(`coordinator lineage failed: ${e.message}`))
    .finally(() => (lineageLoading = false))
}

export async function snapshot(
  orca: OrcaWorkerApi,
  ps: () => Promise<PsWorktree[]> = runPs,
  onLineage: () => void = () => {}
): Promise<Snapshot> {
  const onDisk = readCoordinators()
  const coordinators: Coordinator[] = onDisk.map(({ key, name, repos, look, linearTeams, sessions, sessionNotice }) => ({ key, name, repos, look, linearTeams, sessions, sessionNotice, members: sessions?.members.map((m) => ({ ...m, agent: null })), workspaceId: null as string | null, session: null as AgentInfo | null, active: false }))
  try {
    refreshLineage(orca, onLineage, allRows.flatMap((r) => r.agents.map((a) => a.paneKey)))
    refreshMemory(allRows, onLineage)
    const worktrees = await ps()
    // Folder workspaces (your coordinators live in them) have no identity key; ask the plugin API for their ids.
    const idByPath = new Map<string, string>()
    if (worktrees.some((w) => !w.identity?.key)) {
      const listed = await orca.host.call('workspace.list').catch(() => null)
      for (const w of listed?.workspaces ?? []) idByPath.set(w.path, w.id)
    }
    const owners = readOwners()
    const all = assignCoordinators(fromPs(worktrees, readStore(), idByPath, quietPane), onDisk, lineage, owners)
    // Remember who each agent works for, so it keeps its coordinator if resumed in a new terminal.
    const remembered = rememberOwners(all, owners)
    if (remembered) try { writeOwners(remembered) } catch (e) { orca.log(`saving owners failed: ${(e as Error).message}`) }
    allRows = all
    for (let i = 0; i < onDisk.length; i++) {
      const c = onDisk[i]
      const folder = all.filter((r) => r.path === c.dir)
      let saved = c.sessions
      let migrated: CoordinatorSessions | undefined
      if (!saved && lineageAt > 0 && folder.length === 1) {
        const a = sessionIn(folder[0])
        // Record once from established unambiguous membership, never elect a replacement.
        if (a?.orcaSession && a.terminal && a.live && lineagePanes.has(a.paneKey)) {
          const member = memberFrom(folder[0], a)
          saved = migrated = { version: 1, current: member.id, members: [member] }
        }
      }
      if (saved) {
        saved = reconcileSessions(saved, all)
        if (JSON.stringify(saved) !== JSON.stringify(c.sessions)) {
          // Refreshes overlap, and c.sessions was read before this one awaited ps: reconcile what is
          // on disk now, so a refresh or selection that wrote meanwhile is kept, not a swap failure.
          try { saved = updateCoordinatorSessions(c.dir, (disk) => { const base = disk ?? migrated; return base && reconcileSessions(base, all) }) } catch (e) {
            orca.log(`saving coordinator membership failed: ${(e as Error).message}`)
            saved = readCoordinators().find((other) => other.key === c.key)?.sessions
            coordinators[i].sessionNotice = 'Membership could not be saved or changed during refresh. The saved selection is preserved.'
          }
        }
        c.sessions = saved
        coordinators[i].sessions = saved
      }
      if (!saved) {
        coordinators[i].sessions = { version: 1, current: null, members: [] }
        coordinators[i].sessionNotice = 'No verified unambiguous membership. Explicitly associate a session in Sessions, then make it current.'
      }
      const routes = (lineage.runs ?? []).filter((r) => saved?.members.some((m) => m.terminals.includes(r.terminal)))
      const current = saved?.members.find((m) => m.id === saved.current)
      const currentAgent = current ? memberAgent(current, all) : null
      coordinators[i].routing = !lineageAt ? 'Run routing unverified.' : !routes.length ? 'No verified run route. Selecting current does not claim a run.' : routes.some((r) => r.terminal !== currentAgent?.terminal) ? 'Some runs still route to a previous member. Pending asks keep their source; changing current does not rebind runs.' : 'Existing runs route to the current terminal.'
    }
    const rows = foldCoordinatorFolders(all, coordinators, onDisk.map((c) => c.dir))
    return { rows, source: 'cli', capacity: capacityOf(all, pressureLevel()), coordinators, ready: lineageAt > 0 }
  } catch (e) {
    orca.log(`orca worktree ps failed, using workspace.list: ${(e as Error).message}`)
    return { rows: await fromApi(orca), source: 'api', capacity: null, coordinators }
  }
}

/**
 * Pure: the snapshot with focus moved to the workspace Orca just reported, so the panel's border
 * follows at once instead of after the next CLI read. A workspace matches by one of its agents'
 * terminals, else by name and branch.
 */
export function withFocus(snap: Snapshot, context: { branch: string; displayName: string; terminals: { id: string }[] } | null): Snapshot {
  const ids = new Set((context?.terminals ?? []).map((t) => t.id))
  const branchOf = (b: string) => b.replace(/^refs\/heads\//, '')
  const focused = (name: string, branch: string | null, agents: AgentInfo[]) =>
    !!context && (agents.some((a) => a.terminal !== null && ids.has(a.terminal)) || (name === context.displayName && branchOf(branch ?? '') === branchOf(context.branch)))
  return {
    ...snap,
    rows: snap.rows.map((r) => ({ ...r, active: focused(r.name, r.branch, r.agents) })),
    coordinators: snap.coordinators.map((c) => ({ ...c, active: focused(c.name, null, c.session ? [c.session] : []) || (!!context && c.name === context.displayName) }))
  }
}

/** A pane tree inside one tab, and tab groups split side by side, as `orca terminal list --include-visual-layouts` gives them. */
type LayoutPane = { type?: string; tabId?: string; leafId?: string; first?: LayoutPane; second?: LayoutPane }
type LayoutNode = { type?: string; activeTabId?: string | null; tabs?: { tabId?: string; activeLeafId?: string | null; panes?: LayoutPane }[]; first?: LayoutNode; second?: LayoutNode }
export type VisualLayout = { worktreeId?: string; root?: LayoutNode }

/**
 * Pure: the pane in front in each tab group: the group's active tab, and that tab's active pane, as
 * `<tabId>:<leafId>` (the agents' paneKey). No Orca event or host call names the focused tab, and
 * Orca does not say which of several side-by-side groups has focus, so each group's front pane counts.
 */
export function focusedPanes(layouts: VisualLayout[] | undefined): string[] {
  const leaves = (p?: LayoutPane): LayoutPane[] =>
    !p ? [] : p.type === 'pane-split' ? [...leaves(p.first), ...leaves(p.second)] : p.type === 'terminal' ? [p] : []
  const front = (n?: LayoutNode): string[] => {
    if (!n) return []
    if (n.type === 'split') return [...front(n.first), ...front(n.second)]
    const tab = n.tabs?.find((t) => t.tabId === n.activeTabId)
    const pane = leaves(tab?.panes).find((l) => l.leafId === tab?.activeLeafId)
    return pane?.tabId && pane.leafId ? [`${pane.tabId}:${pane.leafId}`] : []
  }
  return (layouts ?? []).flatMap((l) => front(l.root))
}

/**
 * Every workspace's front panes, or null when Orca could not say (then only the focused workspace's
 * lead is marked). Which workspace is focused comes from Orca's own flag on the rows, so the panel
 * marks only that one's. Not `--worktree active`: the CLI resolves it from the current directory,
 * and this worker runs in `/`, so it always failed and every worktree marked its lead.
 */
export async function readFocus(run: (args: string[], options?: { timeoutMs?: number }) => Promise<any>): Promise<string[] | null> {
  try {
    const listed = await run(['terminal', 'list', '--include-visual-layouts'], { timeoutMs: 5000 })
    return focusedPanes(listed?.visualLayouts)
  } catch {
    return null
  }
}

const samePanes = (a: string[] | null, b: string[] | null) => (a === null || b === null ? a === b : a.length === b.length && a.every((p) => b.includes(p)))

const LEVEL_WORD: Record<Priority, string> = { P0: 'now', P1: 'today', P2: 'soon', P3: 'someday' }

/** The status bar item: how much is waiting, how urgent the top is, and whether there is room. */
export function statusOf(snap: Snapshot) {
  const { capacity } = snap
  const queue = askingRows(snap)
  const top = queue[0]
  const full = capacity && (capacity.verdict === 'full' || capacity.verdict === 'pressure')
  const ask = top?.agents.find(claimsAsk)?.summary?.glance
  const lines = [
    top ? `Next: ${top.repo}/${top.name}${top.priority ? ` (${top.priority} ${LEVEL_WORD[top.priority]})` : ''}` : 'Nothing is waiting on you',
    ask,
    capacity?.freeGB != null && `${capacity.freeGB} GB free (after a ${capacity.marginGB} GB margin)${capacity.pressure === 'warn' || capacity.pressure === 'critical' ? ` · memory pressure ${capacity.pressure}` : ''}`
  ]
  return {
    id: 'queue',
    text: `${queue.length ? `${queue.length} waiting` : 'clear'}${full ? ' · memory full' : ''}`,
    tone: (top?.priority === 'P0' ? 'danger' : top?.priority === 'P1' || full ? 'warning' : 'neutral') as 'danger' | 'warning' | 'neutral',
    tooltip: lines.filter(Boolean).join('\n')
  }
}

/**
 * An installed copy lives at <plugins>/<key>/<content hash> (`current` there is a file naming the
 * active one); a development folder has no key and no updates.
 */
export function installedKey(dir: string | null): string | null {
  return dir ? (/\/plugins\/([^/]+)\/(?:current|[0-9a-f]{64})$/.exec(dir)?.[1] ?? null) : null
}

const UPDATE_DIR = join(DATA_DIR, 'update')
const UPDATE_CHECK_MS = 15 * 60_000

/**
 * The update item and the panel's update button: hidden until a newer release exists. The status
 * bar item asks for a second click; the panel asks with its own confirm and calls sidebar.update.
 * Both start `orca plugin update` outside this worker through one path (updater in update.ts).
 * When the new version starts, it finds the result left behind and says how it went.
 */
function updates(orca: OrcaWorkerApi, dir: string | null, changed: (state: UpdateState) => void, onCheck: () => void = () => {}): void {
  const key = installedKey(dir)
  let current = ''
  try {
    current = JSON.parse(readFileSync(join(dir ?? '', 'orca-plugin.json'), 'utf8')).version ?? ''
  } catch {}
  const timers: ReturnType<typeof setTimeout>[] = []
  disposers.push(() => timers.forEach(clearTimeout))
  const update = updater({
    key,
    current,
    dir: UPDATE_DIR,
    show: (state) => {
      changed(state)
      void orca.host.call('statusBar.update', updateItem(state)).catch((e: Error) => orca.log(`statusBar.update failed: ${e.message}`))
    },
    start: (version) => startUpdate(ORCA_BIN, key!, version, UPDATE_DIR),
    later: (fn, ms) => void timers.push(setTimeout(fn, ms)),
    log: (m) => orca.log(m)
  })
  update.show({ kind: 'none' })

  orca.commands.register('flow.update', () => update.click())
  orca.panels.handle('sidebar.update', async () => update.now())
  if (!key || !current) return void orca.log(`update checks off: ${key ? 'no version in the manifest' : `not an installed copy (${dir})`}`)
  update.settle()

  let warned = false
  const check = () => {
    onCheck()
    latestRelease()
      .then((versions) => update.found(newerVersion(current, versions)))
      // Offline or no git: one line, never a nag.
      .catch((e: Error) => { if (!warned) orca.log(`update check failed: ${e.message}`); warned = true })
      .finally(() => void timers.push(setTimeout(check, UPDATE_CHECK_MS)))
  }
  timers.push(setTimeout(check, 10_000))
}

/** Things that keep the process alive; deactivate ends them so Orca (and tests) can stop it. */
const disposers: (() => void)[] = []

export default function activate(orca: OrcaWorkerApi): void {
  const dir = pluginDir(import.meta.url)
  const installed = installedKey(dir) !== null
  // Later checks only repair a missing or dangling link (say its worktree was removed).
  // The message-format Stop hook goes in with the first link, under the same rule; a hook the user
  // removed comes back only at the next start.
  const linkSkill = (repairOnly: boolean) => {
    if (!dir) return
    for (const line of ensureOwnLinks(linksFor(dir), installed, { repairOnly })) orca.log(line)
    if (!repairOnly) for (const line of ensureOwnStopHook(stopHookFor(), installed)) orca.log(line)
  }
  if (!dir) orca.log(`plugin folder not found from ${import.meta.url}; skill and coordinator CLAUDE.md not set up`)
  else {
    linkSkill(false)
    for (const line of ensureSeeds(seedsFor(dir))) orca.log(line)
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  disposers.push(() => timer && clearTimeout(timer))
  // Agent events arrive in bursts; one snapshot per burst is enough.
  let latest: Snapshot | null = null
  // The panel's update button reads the update state from every snapshot it gets.
  let updateState: UpdateState = { kind: 'none' }
  // The panes in front in every workspace; only the focused workspace's agents among them wear the current border.
  let focus: string[] | null = null
  const shared = (snap: Snapshot): Snapshot => ({ ...snap, update: updateState, focusedPanes: focus })
  const run = orcaRunner(ORCA_BIN)
  // Full snapshots also catch missing/stale summaries, with bounded retries below.
  const refresh = async (): Promise<Snapshot> => {
    // When the coordinator lineage finishes loading, draw again with it.
    const [snap, front] = await Promise.all([snapshot(orca, runPs, () => void refresh()), readFocus(run)])
    latest = snap
    focus = front
    if (latest.source === 'cli') refreshOldSummaries(latest)
    orca.panels.post('sidebar.changed', shared(latest))
    void orca.host.call('statusBar.update', statusOf(latest)).catch((e: Error) => orca.log(`statusBar.update failed: ${e.message}`))
    return shared(latest)
  }
  const refreshSoon = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, 300)
  }

  orca.panels.handle('sidebar.list', () => refresh())

  // ⌘⇧N and the status bar item: open the next workspace waiting on the person.
  let lastJump: { id: string; at: number } | null = null
  orca.commands.register('sidebar.next', async () => {
    const target = nextTarget(askingRows(latest ?? (await refresh())), lastJump, Date.now())
    if (!target) return 'Nothing is waiting on you.'
    lastJump = { id: target.queueKey ?? target.id, at: Date.now() }
    if (target.historical) return 'This ask belongs to a previous session. View its read-only source in Up next.'
    const terminal = leadAgent(target)?.terminal
    if (target.coordinator && !terminal) return 'The exact asking session is unavailable.'
    const opened = await openChat(terminal ? { workspaceId: target.id, terminal } : { workspaceId: target.id })
    if (!opened.opened) return 'The exact source session is unavailable or is now read-only history.'
    return `${target.repo}/${target.name}`
  })
  // The status bar item keeps this worker running, so it can fill the item in right away.
  void refresh()
  updates(orca, dir, (state) => {
    updateState = state
    if (latest) orca.panels.post('sidebar.changed', shared(latest))
  }, () => linkSkill(true))

  // No Orca event reports a tab switch inside a workspace, so the panel asks every few seconds while
  // it is visible; the border moves only when the front pane changed.
  let focusReading: Promise<{ changed: boolean }> | null = null
  const rereadFocus = () =>
    (focusReading ??= readFocus(run)
      .then((front) => {
        if (samePanes(front, focus)) return { changed: false }
        focus = front
        if (latest) orca.panels.post('sidebar.changed', shared(latest))
        return { changed: true }
      })
      .finally(() => (focusReading = null)))
  orca.panels.handle('sidebar.focus', () => rereadFocus())

  // The opened cockpit and its two actions. Each action redraws the panel afterwards.
  orca.panels.handle('sidebar.cockpit', async () => {
    const stats = await loadCockpit(run, (latest ?? (await refresh())).rows)
    // The top bar and the opened details read the same Orca report, so they show the same numbers.
    if (stats.ram) {
      memory = { ...memory, availableGB: stats.ram.totalGB - stats.ram.usedGB }
      memoryAt = Date.now()
      refreshSoon()
    }
    return stats
  })
  orca.panels.handle('sidebar.closeSessions', async ({ panes }) => {
    const result = await closeSessions(run, panes)
    refreshSoon()
    return result
  })
  orca.panels.handle('sidebar.removeWorktree', async ({ workspaceId, force }) => {
    const { rows } = await refresh()
    const result = await removeWorktree(run, rows.find((r) => r.id === workspaceId), force === true)
    refreshSoon()
    return result
  })

  // ---------- coordinators: create and open ----------
  /** The coordinator's workspace id, adding its folder to Orca first if it is not there yet. */
  async function workspaceFor(dir: string): Promise<string | null> {
    const find = async () => (await orca.host.call('workspace.list')).workspaces.find((w) => w.path === dir)?.id ?? null
    let id = await find()
    if (!id) {
      await run(['repo', 'add', '--path', dir, '--kind', 'folder'])
      for (let i = 0; i < 10 && !id; i++) {
        id = await find()
        if (!id) await new Promise((r) => setTimeout(r, 500))
      }
    }
    return id
  }

  /** Fresh means a new explicitly associated member; it never closes an older member. */
  async function freshSession(c: CoordinatorInfo, agent: string): Promise<{ ok: boolean; error?: string }> {
    const workspaceId = await workspaceFor(c.dir)
    if (!workspaceId) return { ok: false, error: 'Orca did not add the folder' }
    const launched = await orca.host.call('agent.launch', { workspaceId, agent, prompt: 'Start your coordinator session.' })
    // Correlate the launch's returned terminal id, never the first/newest pane in the folder.
    for (let i = 0; i < 8; i++) {
      const listed = await run(['terminal', 'list'])
      const t = (listed?.terminals ?? []).find((t: any) => t.ptyId === launched.terminalId || t.handle === launched.terminalId)
      await refresh()
      const row = allRows.find((r) => r.id === workspaceId)
      const a = t && row?.agents.find((a) => a.paneKey === `${t.tabId}:${t.leafId}`)
      if (row && a?.orcaSession) {
        a.terminal = t.handle
        const disk = readCoordinators().find((x) => x.key === c.key)!
        let sessions = associateSession(disk.sessions ?? { version: 1, current: null, members: [] }, row, a)
        const member = sessions.members.find((m) => memberAgent(m, [row]) === a)!
        await captureResumeId(member, launched.terminalId)
        sessions = selectCurrent(sessions, member.id)
        writeCoordinatorSessions(c.dir, sessions, { sessions: disk.sessions })
        refreshSoon()
        return { ok: true }
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return { ok: false, error: 'The new session started, but its exact binding is not available yet. Associate it in Sessions when it appears; do not launch again.' }
  }

  async function captureResumeId(member: import('./protocol.ts').CoordinatorMember, terminalId: string): Promise<void> {
    const listed = await orca.host.call('agents.list', { workspaceId: member.workspaceId }).catch(() => null)
    const agent = listed?.agents.find((a) => a.terminalId === terminalId && a.agent === member.agentType)
    if (agent?.sessionId) member.resumeSessionId = agent.sessionId
  }

  orca.panels.handle('sidebar.createCoordinator', async ({ name, look }) => {
    const invalid = validateName(name.trim(), readCoordinators().map((c) => c.name))
    if (invalid) return { ok: false, error: invalid }
    scaffoldCoordinator(COORDINATOR_HOME, { name: name.trim(), look })
    const c = readCoordinators().find((c) => c.name === name.trim())!
    writeCoordinatorSessions(c.dir, { version: 1, current: null, members: [] })
    return freshSession(c, 'claude').catch((e: Error) => ({ ok: false, error: e.message }))
  })

  /** Resumes by provider id and finds the exact terminal the resume returned. */
  const resumeIo: ResumeIo = {
    resume: (input) => {
      type ResumeAgent = Parameters<typeof orca.host.call<'agent.resume'>>[1]['agent']
      return orca.host.call('agent.resume', { ...input, agent: input.agent as ResumeAgent })
    },
    binding: async (terminalId) => {
      const listed = await run(['terminal', 'list'])
      const t = (listed?.terminals ?? []).find((t: any) => t.ptyId === terminalId || t.handle === terminalId)
      if (!t) return null
      await refresh()
      const row = allRows.find((r) => r.agents.some((a) => a.paneKey === `${t.tabId}:${t.leafId}`))
      const a = row?.agents.find((a) => a.paneKey === `${t.tabId}:${t.leafId}`)
      return row && a ? { workspaceId: row.id, agent: { ...a, terminal: t.handle } } : null
    }
  }

  // Coordinators with a start, resume or session change in flight: open, fresh and resume share it.
  const changing = new Set<string>()
  const busy = (): WakeOutcome => ({ ok: false, kind: 'busy', error: 'A session change is already in progress.' })

  /** Opening is not delivery: a sleeping coordinator resumes its exact conversation or starts one (wakePlan). */
  const openCoordinator = (key: string): Promise<WakeOutcome> => exclusive(changing, key, async () => {
    try {
      const snap = await refresh()
      const c = readCoordinators().find((x) => x.key === key)
      if (!c) return { ok: false, kind: 'failed', error: `No coordinator ${key}` }
      const view = snap.coordinators.find((x) => x.key === key)
      return await wakeCoordinator(c, allRows, view ? sessionChoices(view, snap.rows).length : 0, {
        ...resumeIo,
        open: async (workspaceId, terminal) => (await openChat({ workspaceId, terminal })).opened,
        // The resume refreshed while binding, which may have saved other members: put the resumed
        // member into what is on disk now, only while it is still the current one.
        save: (next) => {
          const resumed = next.members.find((m) => m.id === next.current)!
          updateCoordinatorSessions(c.dir, (disk) => {
            if (disk?.current !== resumed.id || !disk.members.some((m) => m.id === resumed.id)) throw new Error('the main conversation changed while it was resuming')
            return { ...disk, members: disk.members.map((m) => m.id === resumed.id ? resumed : m) }
          })
          refreshSoon()
        },
        fresh: (agent) => freshSession(c, agent)
      })
    } catch (e) { return { ok: false, kind: 'failed', error: (e as Error).message } }
  }, busy)
  orca.panels.handle('sidebar.openCoordinator', ({ key }) => openCoordinator(key))

  orca.panels.handle('sidebar.coordinatorHistory', async ({ key, member: id, terminal, orcaSession }) => {
    const c = readCoordinators().find((c) => c.key === key)
    const member = c?.sessions?.members.find((m) => m.id === id)
    if (!member) return { title: 'Session unavailable', text: '', unavailable: 'This exact session is no longer associated.' }
    if (terminal && !member.terminals.includes(terminal)) return { title: member.title, text: '', unavailable: 'That delivery terminal is not recorded for this exact member.' }
    if (terminal) {
      const binding = (member.bindings ?? []).find((b) => b.terminal === terminal && b.orcaSession === (orcaSession ?? member.orcaSession))
      if (!binding) return { title: member.title, text: '', unavailable: 'The original delivery conversation binding is unavailable; no later conversation was opened.' }
      return readMemberHistory({ ...member, paneKey: binding.paneKey, orcaSession: binding.orcaSession, terminals: [terminal] }, run)
    }
    return readMemberHistory(member, run)
  })

  orca.panels.handle('sidebar.coordinatorSessions', ({ key, action, member: id, workspaceId, paneKey, orcaSession, agent }) => exclusive(changing, key, async () => {
    try {
      await refresh()
      const c = readCoordinators().find((c) => c.key === key)
      if (!c) throw new Error('Coordinator no longer exists.')
      if (action === 'fresh') return await freshSession(c, agent || 'claude')
      let sessions = c.sessions ?? { version: 1 as const, current: null, members: [] }
      if (action === 'select') {
        const row = allRows.find((r) => r.id === workspaceId && r.path === c.dir)
        if (!row || !paneKey || !orcaSession) throw new Error('That conversation is no longer available. Choose another session.')
        const verified = await loadLineage(run, Date.now(), true)
        if (verified.dispatchOf?.has(paneKey) || verified.dispatcherOf.has(paneKey)) throw new Error('That conversation belongs to a task and cannot be the main session.')
        sessions = chooseSession(sessions, row, { workspaceId: row.id, paneKey, orcaSession, agentType: agent ?? null })
        const member = sessions.members.find((m) => m.id === sessions.current)!
        try { await verifyConversation(member, run) } catch { throw new Error('That conversation changed. Open the dropdown and try again.') }
      } else if (action === 'associate') {
        const row = allRows.find((r) => r.id === workspaceId && r.path === c.dir)
        const a = row?.agents.find((a) => a.paneKey === paneKey)
        if (!row || !a) throw new Error('That exact session is no longer in this coordinator workspace.')
        const verifiedLineage = await loadLineage(run, Date.now(), true)
        if (verifiedLineage.dispatchOf?.has(a.paneKey) || verifiedLineage.dispatcherOf.has(a.paneKey)) throw new Error('This exact agent has dispatch provenance and remains a workstream lead or worker.')
        sessions = associateSession(sessions, row, a)
        const member = sessions.members.find((m) => memberAgent(m, [row]) === a)!
        if (a.terminal) {
          const shown = await run(['terminal', 'show', '--terminal', a.terminal])
          if (shown?.terminal?.worktreePath !== c.dir) throw new Error('The exact terminal no longer belongs to this coordinator workspace.')
          if (shown?.terminal?.ptyId) await captureResumeId(member, shown.terminal.ptyId)
        }
      } else if (action === 'current') sessions = selectCurrent(sessions, id ?? '')
      else if (action === 'resume') sessions = await resumeExactMember(sessions, id ?? '', resumeIo)
      writeCoordinatorSessions(c.dir, sessions, { sessions: c.sessions })
      refreshSoon()
      return { ok: true }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }, busy))

  // ---------- context menu actions ----------
  orca.panels.handle('sidebar.setPriority', async ({ workspaceId, priority }) => {
    if (!workspaceId.startsWith('identity:')) return { ok: false, error: 'Only worktrees have a priority card' }
    const key = workspaceId.slice('identity:'.length)
    const path = join(DATA_DIR, 'cards', `${fileKey(key)}.json`)
    let card: Record<string, unknown> = {}
    try {
      card = JSON.parse(readFileSync(path, 'utf8'))
    } catch {}
    const next: Record<string, unknown> = { ...card, worktree: key, updatedAt: Date.now() }
    if (priority) next.priority = priority
    else delete next.priority
    mkdirSync(join(DATA_DIR, 'cards'), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2))
    refreshSoon()
    return { ok: true }
  })

  orca.panels.handle('sidebar.coordinatorAction', async ({ key, action }) => {
    const c = readCoordinators().find((x) => x.key === key)
    if (!c) return { ok: false, error: `No coordinator ${key}` }
    const current = c.sessions?.members.find((m) => m.id === c.sessions?.current)
    const currentAgent = current ? memberAgent(current, allRows) : null
    const panes = currentAgent ? [currentAgent.paneKey] : []
    try {
      if (action === 'look') {
        const others = readCoordinators().filter((x) => x.key !== key)
        const free = freeLooks(others).filter((l) => !c.look || l.color !== c.look.color || l.shape !== c.look.shape)
        if (free.length) writeLook(c.dir, free[Math.floor(Math.random() * free.length)])
      } else if (action === 'end') {
        await closeSessions(run, panes)
      } else if (action === 'restart') {
        return await exclusive(changing, key, () => freshSession(c, current?.agentType || 'claude'), busy)
      } else if (action === 'delete') {
        await closeSessions(run, panes)
        // Close every terminal it still has (Orca refuses to remove a project with open ones), then
        // forget its project. Orca always keeps saved details for a used workspace, so removal needs
        // --force; the person already confirmed the delete. Only then is the folder deleted.
        await run(['terminal', 'close', '--worktree', `path:${c.dir}`, '--all']).catch(() => null)
        const setups = await run(['project', 'setups']).catch(() => null)
        const list: any[] = setups?.setups ?? setups ?? []
        const setup = list.find((x) => x.path === c.dir)
        if (setup) await run(['project', 'setup-delete', '--setup', setup.id, '--force'])
        deleteFolder(c.dir)
      }
      refreshSoon()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // The clicked agent's tab is in front now: move the border at once, not at the panel's next look.
  const openChat = async (input: { workspaceId: string; terminal?: string }) => {
    if (input.terminal) {
      const historical = readCoordinators().some((c) => c.sessions?.members.some((m) => m.id !== c.sessions?.current && m.workspaceId === input.workspaceId && m.terminals.includes(input.terminal!)))
      if (historical) return { opened: false }
    }
    const opened = await openAgent(orca, run, input)
    // A read already in flight predates the switch; read again after it.
    void (focusReading ?? Promise.resolve()).then(rereadFocus)
    return opened
  }
  orca.panels.handle('sidebar.open', (input) => openChat(input))

  // Option+1..9 (contributes.keybindings): open the nth chat of the tree, as a click on its row does.
  // The panel stores its folded groups, so the numbers skip what it hides, as its own key handler does.
  for (let n = 1; n <= CHAT_KEYS; n++)
    orca.commands.register(`chat.${n}`, async () => {
      const folded = await orca.storage.get(FOLDED_KEY).catch(() => null)
      const targets = chatTargets(latest ?? (await refresh()), new Set(Array.isArray(folded) ? folded.map(String) : []))
      return openNthChat(targets, n, { coordinator: openCoordinator, chat: openChat })
    })

  // ---------- Linear ----------
  // The panel asks every minute while it shows; a read older than LINEAR_FRESH_MS is read again,
  // and a failed read keeps the last good data (none at all hides the section).
  let linear: LinearData | null = null
  let linearAt = 0
  let linearReading: Promise<LinearData | null> | null = null
  const LINEAR_FRESH_MS = 55_000
  /** The data with the sends still starting: a send a worktree now links (or an old one) is forgotten. */
  const withSends = (data: LinearData): LinearData => {
    const memory = readLinearMemory()
    const pruned = pruneSent(memory.sent, new Set(linkRows(allRows, teamsOf(data)).map((r) => r.linearIssue ?? '').filter(Boolean)))
    if (pruned) {
      memory.sent = pruned
      try { writeLinearMemory(memory) } catch (e) { orca.log(`saving Linear sends failed: ${(e as Error).message}`) }
    }
    return { ...data, sent: memory.sent, lastSent: memory.lastSent }
  }
  const readLinear = () =>
    (linearReading ??= loadLinear(run)
      .then((next) => {
        linear = withSends(next)
        linearAt = Date.now()
        orca.panels.post('sidebar.linearChanged', encodeLinear(linear))
        return linear
      })
      .catch((e: Error) => {
        orca.log(`linear read failed: ${e.message}`)
        return linear
      })
      .finally(() => (linearReading = null)))
  // The panel gets the compact copy (encodeLinear): Orca drops anything over 256 KiB.
  orca.panels.handle('sidebar.linear', async (input) => {
    const data = !input?.force && linear && Date.now() - linearAt < LINEAR_FRESH_MS ? withSends(linear) : await readLinear()
    return data ? encodeLinear(data) : null
  })

  orca.panels.handle('sidebar.linearSend', async ({ issue: id, coordinator: key }) => {
    const previous = readLinearMemory().sent[id]
    const blocked = deliveryBlock(previous)
    if (blocked) return { ok: false, error: blocked, recipient: previous.recipient, warnings: [] }
    const issue = linear?.issues.find((i) => i.id === id)
    if (!issue) return { ok: false, error: `${id} is not in the Linear list`, warnings: [] }
    const c = readCoordinators().find((x) => x.key === key)
    if (!c) return { ok: false, error: `No coordinator ${key}`, warnings: [] }
    // `"linearDryRun": true` in config.json logs what a send would do and sends nothing.
    const dryRun = readConfig().linearDryRun === true
    let recipient: import('./protocol.ts').DeliveryRecipient | undefined
    let uncertain = false
    const result = await sendIssue(issue, { run, deliver: async (message) => {
      await refresh()
      const current = readCoordinators().find((x) => x.key === key)
      if (!current) throw new Error('Coordinator no longer exists.')
      try { recipient = await deliverCurrent(current, allRows, message, run, () => {
        const now = readCoordinators().find((x) => x.key === key)?.sessions
        const before = current.sessions?.members.find((m) => m.id === current.sessions?.current)
        const after = now?.members.find((m) => m.id === now.current)
        return Boolean(before && after && before.id === after.id && before.orcaSession === after.orcaSession && before.paneKey === after.paneKey)
      }) } catch (e) {
        if (e instanceof DeliveryUncertainError) { recipient = e.recipient; uncertain = true }
        throw e
      }
    }, dryRun, log: (m) => orca.log(m) })
    for (const w of result.warnings) orca.log(`linear send ${id}: ${w}`)
    if ((!result.ok && !uncertain) || dryRun) return result
    const memory = readLinearMemory()
    if (result.ok) memory.lastSent[issue.team] = key
    memory.sent[id] = { coordinator: key, at: Date.now(), recipient, ...(uncertain ? { delivery: 'unknown' as const } : {}) }
    try { writeLinearMemory(memory) } catch (e) {
      orca.log(`saving Linear sends failed: ${(e as Error).message}`)
      result.warnings.push(uncertain ? 'The unconfirmed attempt could not be saved; inspect the recipient and do not resend blindly.' : 'The task was sent, but its exact delivery receipt could not be saved.')
    }
    if (linear) {
      linear = { ...linear, sent: memory.sent, lastSent: memory.lastSent }
      orca.panels.post('sidebar.linearChanged', encodeLinear(linear))
    }
    // Read again once Linear has the new state; a read in flight predates it.
    void (linearReading ?? Promise.resolve()).then(readLinear)
    refreshSoon()
    return { ...result, recipient }
  })

  orca.panels.handle('sidebar.setLinearTeams', async ({ key, teams }) => {
    const c = readCoordinators().find((x) => x.key === key)
    if (!c) return { ok: false, error: `No coordinator ${key}` }
    try {
      writeLinearTeams(c.dir, teams)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    refreshSoon()
    return { ok: true }
  })

  const currentAgent = (pane: string) => latest && summaryAgents(latest).find(({ agent }) => agent.paneKey === pane)?.agent
  const identityFor = (pane: string) => {
    const a = currentAgent(pane)
    return { orcaSession: a?.orcaSession, provider: a?.agentType }
  }
  const writer = createWriter({ ...summaryProviders(), log: (message) => orca.log(message) })
  const summarizer = turnSummarizer({
    findTranscript: (pane, identity) => currentAgent(pane)
      ? findTranscript(pane, undefined, { ...identityFor(pane), ...identity })
      : { path: null, why: 'No unambiguous live summary target; waiting for current inventory' },
    run: (job) => summarizePane({ ...job, writer, isCurrent: () => !job.transcriptSource?.orcaSession || (currentAgent(job.pane)?.orcaSession === job.transcriptSource.orcaSession && currentAgent(job.pane)?.agentType === job.transcriptSource.providerSession?.provider), goal: job.worktreeId ? readStore().cards[fileKey(job.worktreeId)]?.goal : undefined }),
    log: (m) => orca.log(m)
  })
  let disposed = false
  disposers.push(() => {
    disposed = true
    summarizer.dispose()
  })

  /**
   * A fixed prompt or role rule should show at once, not at each agent's next turn: re-summarize
   * the live agents whose card an older summarizer wrote, in the background, through the same
   * queue (two writer calls at most) with a pause between them, so a restart costs no burst.
   */
  const refreshAttempts = new Map<string, number>()
  let checkedAt = 0
  function refreshOldSummaries(snap: Snapshot): void {
    if (Date.now() - checkedAt < 15_000) return
    checkedAt = Date.now()
    const agents = summaryAgents(snap).map(({ agent: a, worktreeId }) => ({ pane: a.paneKey, state: a.state, identity: { orcaSession: a.orcaSession, provider: a.agentType }, worktreeId }))
    const jobs = currentSummaryJobs(readStore().summaries, agents).filter((job) => {
      const key = `${job.pane}:${job.transcriptSource?.orcaSession ?? ''}:${job.transcriptSource?.providerSession?.id ?? job.transcript}`
      if ((refreshAttempts.get(key) ?? 0) + 5 * 60_000 > Date.now()) return false
      refreshAttempts.set(key, Date.now())
      return true
    })
    if (jobs.length) void refreshStale({ jobs, enqueue: summarizer.enqueue, stopped: () => disposed })
  }
  // Structured chats are not covered by every host's terminal status event. While this worker is
  // active, refresh their inventory and catch completed turns/missing cards without a hot loop.
  const summaryRefresh = setInterval(refreshSoon, 60_000)
  ;(summaryRefresh as unknown as { unref?: () => void }).unref?.()
  disposers.push(() => clearInterval(summaryRefresh))

  // The summarizer and `orca-flow set` write here; a new summary should show without an event.
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const watcher = watch(DATA_DIR, { recursive: true }, refreshSoon)
    disposers.push(() => watcher.close())
  } catch (e) {
    orca.log(`not watching ${DATA_DIR}: ${(e as Error).message}`)
  }

  // Orca may stop an idle worker, and the watcher with it. An agent's summary lands ~10 s after
  // its turn ends, so look again then.
  orca.events.on('agent.status.changed', (event) => {
    summarizer.onStatus(event)
    refreshSoon()
    const later = setTimeout(refreshSoon, 15_000)
    disposers.push(() => clearTimeout(later))
  })
  orca.events.on('workspace.created', refreshSoon)
  orca.events.on('workspace.removed', () => {
    linkSkill(true)
    refreshSoon()
  })
  // Focus moved to another workspace: move the border at once, read which tab is in front there,
  // then refresh the rest.
  orca.events.on('workspace.changed', (event) => {
    if (latest) {
      latest = withFocus(latest, event.context)
      orca.panels.post('sidebar.changed', shared(latest))
    }
    // A read already in flight may predate the switch; read again after it.
    void (focusReading ?? Promise.resolve()).then(rereadFocus)
    refreshSoon()
  })
}

export function deactivate(): void {
  for (const dispose of disposers.splice(0)) dispose()
}
