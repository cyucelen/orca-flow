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
import { antigravityTurnRecorded, launchAntigravityCoordinator, requireAntigravity } from './antigravity.ts'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { costsOf, decide, DEFAULT_CONFIG, diskFreeOf, envSamples, FALLBACK, readEnvMemory, typicalEnv, writeEnvMemory, type Pressure } from './capacity.ts'
import { closeSessions, loadCockpit, removeWorktree } from './cockpit.ts'
import { assignCoordinators, coordinatorSession, COORDINATOR_HOME, deleteFolder, isCoordinatorHome, loadLineage, orcaRunner, readCoordinators, readLinearMemory, readOwners, rememberOwners, scaffoldCoordinator, validateName, updateCoordinatorSessions, writeLinearMemory, writeLinearTeams, writeLook, writeOwners, writeCoordinatorSessions, type CoordinatorInfo, type Lineage } from './coordinators.ts'
import { encodeLinear, linkedIssueOf, linkRows, loadLinear, pruneSent, sendIssue, teamsOf } from './linear.ts'
import { associateSession, chooseSession, conversationRows, deliverCurrent, deliveryBlock, DeliveryUncertainError, exclusive, memberAgent, memberFrom, memberOf, memberRows, readMemberHistory, reconcileSessions, resumeExactMember, selectCurrent, sessionChoices, verifyConversation, wakeCoordinator, bindLaunched, launchedAgent, launchedTerminal, launchOnce, settlePending, terminalPane, resumeIdFor, withResumeId, conversationSaved, parseProcs, programRuns, providerMessage, askKey, resumeExact, ResumeRefusedError, ResumeRunningError, ResumeUnverifiedError, type Launch, type ListedAgent, type ResumeIo, type TerminalRecord } from './coordinator-sessions.ts'
import { askingRows, asleep, CHAT_KEYS, chatTargets, FOLDED_KEY, finishedAgents, freeLooks, NO_RESUME_ID, showable, type ChatTarget } from './view.ts'
import type { AgentInfo, AgentState, AgentSummary, Bot, Capacity, Coordinator, LinearData, Priority, SettingsState, Snapshot, WakeOutcome, WorkspaceRow, WorkstreamCard, CoordinatorSessions } from './protocol.ts'
import { claimsAsk, leadAgent, nextTarget } from './rank.ts'
import { createWriter } from './writer.ts'
import { configFile, configuredWriters, readSettings, writeSettings } from './config.ts'
import { normalizeSettings, WRITER_PROVIDERS, type WriterStatus } from './settings.ts'
import { currentSummaryJobs, findTranscript, refreshStale, summaryMatches, summarizePane, summaryProviders, turnSummarizer } from './summarize.ts'
import { ensureOwnLinks, ensureOwnStopHook, ensureSeeds, linksFor, pluginDir, seedsFor, stopHookFor } from './install.ts'
import { bootstrapCoordinator, coordinatorPrompt } from './coordinator-bootstrap.ts'
import { coordinatorLaunchPlan, startCoordinator } from './coordinator-launch.ts'
import { choiceLabel, taskKind, type Availability, type ModelChoice } from './routing.ts'
import { discover, type Exec } from './model-discovery.ts'
import { codexHomeFromAccounts, resolveCli } from './writer.ts'
import { completeSelection, continueHandover, handoverPrompt, handoverStatus, readHandover, readHandoverContext, readOwnership, requireCoordinatorNavigation, saveHandover, transferPlan, type Handover } from './handover.ts'
import { readHandoverProviders } from './handover-providers.ts'
import { coordinatorProviders, firstProvider, readInstalledProviders } from './coordinator-providers.ts'
import { checkForUpdates, readReleases, startUpdate, updateItem, updater, type InstalledPlugin, type UpdateCheck, type UpdateState } from './update.ts'
import { readFootprint, readProcs, startedGroups } from './started.ts'
import { backgroundReader } from './background.ts'
import { conversationOpener, ORCA_PROMPT, seenModel, type Opener, type SeenModel } from './transcripts.ts'
import { agentName, modelLabel, UNKNOWN } from './panel/models.ts'
import { buildBots, isBotRow, readBotFolders, type BotAutomation, type ListedBot } from './bots.ts'
import { modelLabel as tsModelLabel, addNet, agentPids, isSpeedFile, logRoots, logsToRead, parseNettop, parseNetworkQuality, prune, readLogs, readSpeedStore, socketDelta, speedView, writeSpeedStore, type LogKind, type LogRoot, type SocketSnapshot, type TokenSpeedWire } from './token-speed.ts'

const background = backgroundReader()
/** Workaround for stablyai/orca#26192; remove with src/background.ts once Orca ships stablyai/orca#36164. */
const quietPane = (pane: string) => background.quiet(findTranscript(pane).path)
/** Who opened the agent's conversation, from its transcript's first prompt (see `titleOf`). */
const openedBy = (a: PsAgent): Opener | null => a.paneKey
  ? conversationOpener(findTranscript(a.paneKey, undefined, { orcaSession: a.orcaSessionId, provider: a.agentType }))
  : null

const ORCA_BIN = ['/Applications/Orca.app/Contents/Resources/bin/orca'].find(existsSync) ?? 'orca'
const DATA_DIR = join(homedir(), '.orca-flow')

/** Most urgent first: what needs the person outranks what is running. */
const URGENCY: AgentState[] = ['blocked', 'waiting', 'working', 'done']

export type PsAgent = {
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
  /** Set on an Orca bot's workspace: the bot's name (`botHome` on its home folder). */
  bot?: string | null
  botHome?: boolean
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

/**
 * ~/.orca-flow/routes.jsonl (written by `orca-flow dispatch`, one routed launch per line) as what a
 * row shows: dispatch id -> the logged reason ("normal task → Claude Sonnet · medium"), or for older lines "Claude Sonnet · medium — normal task" (or "— images task" for a typed one). Older lines name the kind `class`. The last line of a dispatch
 * wins (a retry or an escalation); a garbled line is skipped.
 */
export function routeLabels(text: string): Map<string, string> { return parseRoutes(text).labels }

/** routeLabels plus each dispatch's structured choice (the model it asked for), same last-line-wins rule. */
export function parseRoutes(text: string): { labels: Map<string, string>; choices: Map<string, ModelChoice> } {
  const out = new Map<string, string>(), choices = new Map<string, ModelChoice>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    const c = r?.choice as ModelChoice | undefined
    if (typeof r?.dispatchId !== 'string' || !r.dispatchId || typeof c?.agent !== 'string' || !c.agent) continue
    choices.set(r.dispatchId, c)
    const kind = taskKind(r.kind ?? r.class)
    // The logged reason, as written, on one line; older lines without one are rebuilt.
    const logged = typeof r.reason === 'string' ? r.reason.replace(/\s+/g, ' ').trim() : ''
    if (logged) { out.set(r.dispatchId, logged.length > 100 ? `${logged.slice(0, 99)}…` : logged); continue }
    const why = typeof r.type === 'string' && r.type ? `${r.type} task${r.attempt > 0 ? ', retried' : ''}`
      : kind ? `${kind} task${r.risk === 'high' ? ', high risk' : ''}${r.attempt > 0 ? ', escalated' : ''}` : ''
    out.set(r.dispatchId, `${choiceLabel(c)}${why ? ` — ${why}` : ''}`)
  }
  return { labels: out, choices }
}

let routesSeen: { key: string; labels: Map<string, string>; choices: Map<string, ModelChoice> } = { key: '', labels: new Map(), choices: new Map() }
/** routeLabels of the file, read again only when its size or time changes; missing reads as empty. */
export function readRoutes(dir = DATA_DIR): Map<string, string> {
  const file = join(dir, 'routes.jsonl')
  let key = ''
  try { const st = statSync(file); key = `${st.size}:${st.mtimeMs}` } catch { return new Map() }
  if (key !== routesSeen.key) {
    try { routesSeen = { key, ...parseRoutes(readFileSync(file, 'utf8')) } } catch { return routesSeen.labels }
  }
  return routesSeen.labels
}
/** The structured choices of the file readRoutes last read (call it first); the same dispatch ids. */
export const readRouteChoices = (): Map<string, ModelChoice> => routesSeen.choices

/** Rows with each dispatched agent's routed model, by its dispatch id. */
export function withRoutes(rows: WorkspaceRow[], dispatchIdOf: Map<string, string> | undefined, labels: Map<string, string>): WorkspaceRow[] {
  if (!dispatchIdOf?.size || !labels.size) return rows
  return rows.map((row) => row.agents.some((a) => labels.has(dispatchIdOf.get(a.paneKey) ?? ''))
    ? { ...row, agents: row.agents.map((a) => { const r = labels.get(dispatchIdOf.get(a.paneKey) ?? ''); return r ? { ...a, route: r } : a }) }
    : row)
}

/** The model catalog Settings → Models last discovered, so a row names a model as Settings does. */
let catalog: Availability | undefined
const PROVIDERS = ['claude', 'codex']
const sameModel = (c: ModelChoice, id: string) => Boolean(c.model) && (c.model === id || (c.agent === 'claude' && id.includes(c.model!)))
/** A model id as Settings names it ("GPT-6 Luna", "Sonnet"), else as the sidebar does ("Opus 5.5", "GPT-5.6 Sol"). */
export function modelName(agent: string, id: string, avail: Availability | undefined = catalog): string {
  const named = modelLabel(agent, id, avail ?? UNKNOWN)
  return named !== id ? named : tsModelLabel(id)
}

/**
 * Each agent's row model, never the Settings default: the model of its latest reply (`seen`), else the
 * model its dispatch asked for (`asked`), else "default" when the route named no model, else nothing.
 * Claude logs no effort, so it comes from the route, and only when the route's model is the one seen.
 */
export function withModels(rows: WorkspaceRow[], dispatchIdOf: Map<string, string> | undefined, choices: Map<string, ModelChoice>, seenOf: (a: AgentInfo) => SeenModel | null, nameOf = modelName): WorkspaceRow[] {
  const modelOf = (a: AgentInfo): AgentInfo['model'] => {
    const provider = a.agentType
    const asked = choices.get(dispatchIdOf?.get(a.paneKey) ?? '')
    const seen = provider && PROVIDERS.includes(provider) ? seenOf(a) : null
    if (seen) {
      const effort = seen.effort ?? (asked && sameModel(asked, seen.model) ? asked.effort : undefined)
      return { name: nameOf(provider!, seen.model), ...(effort ? { effort } : {}), source: 'seen' }
    }
    if (!asked || (provider && asked.agent !== provider)) return undefined
    return asked.model
      ? { name: nameOf(asked.agent, asked.model), ...(asked.effort ? { effort: asked.effort } : {}), source: 'asked' }
      : { name: 'default', source: 'default', provider: agentName(asked.agent) }
  }
  return rows.map((row) => row.agents.length ? { ...row, agents: row.agents.map((a) => { const model = modelOf(a); return model ? { ...a, model } : a }) } : row)
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
  const idleWatcher = a.agentType !== 'antigravity' && a.state === 'working' && a.workingMode === 'monitoring' && a.mainAgent?.state === 'done'
    && a.programStatus?.state === 'done' && !!a.paneKey && quiet(a.paneKey)
  return idleWatcher ? { state: 'done', workingMode: null } : { state: a.state as AgentState, workingMode: a.workingMode ?? null }
}

/** A title candidate: shows no ids, hashes or paths, and is not Orca's prompt text (ORCA_PROMPT). */
const titleOk = (t: string | null | undefined): t is string => !!t && showable(t) && !ORCA_PROMPT.test(t)

/**
 * The summary's title, then for a conversation Orca opened (its first prompt is Orca's dispatch
 * preamble or a lead/coordinator start prompt) the task title: the provider names a conversation from
 * its first prompt, and from Orca's preamble it makes generic names ("Generate concise task title").
 * A conversation the user opened keeps its own name even when later handed a task. Skip ids
 * (worker-task_…) and Orca's raw prompt text. Who opened it is read only when the names differ; with
 * no transcript, a summary's lead or worker role says Orca did.
 */
function titleOf(a: PsAgent, summary: AgentSummary | null, opened: (a: PsAgent) => Opener | null): string {
  if (titleOk(summary?.title)) return summary.title
  const task = [a.taskTitle, a.displayName].find(titleOk)
  if (task && titleOk(a.conversationName) && a.conversationName !== task) {
    const opener = opened(a) ?? (summary?.role === 'lead' || summary?.role === 'worker' ? 'orca' : null)
    if (opener === 'orca') return task
  }
  return [a.conversationName, a.taskTitle, a.displayName].find(titleOk) || a.agentType || 'Agent'
}

function toAgent(a: PsAgent, store: Store, quiet: (pane: string) => boolean, opened: (a: PsAgent) => Opener | null): AgentInfo | null {
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
    title: titleOf(a, summary, opened),
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

/**
 * `quiet(pane)`: the pane's only running background work is an artifact watch (see `stateOf`).
 * `opened(agent)`: who opened the agent's conversation, Orca or the user, or null if unknown (see `titleOf`).
 */
export function fromPs(worktrees: PsWorktree[], store: Store = { cards: {}, summaries: {} }, idByPath = new Map<string, string>(), quiet: (pane: string) => boolean = () => false, opened: (a: PsAgent) => Opener | null = () => null): WorkspaceRow[] {
  const idOf = new Map(worktrees.map((w) => [w.worktreeId, workspaceId(w, idByPath)]))
  return worktrees
    .filter((w) => !w.isArchived && workspaceId(w, idByPath))
    .map((w) => {
      const agents = (w.agents ?? []).map((a) => toAgent(a, store, quiet, opened)).filter((a): a is AgentInfo => a !== null)
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
        linearIssue: linkedIssueOf(w.linkedLinearIssue),
        ...(w.bot ? { bot: w.bot } : {})
      }
    })
}

/** Orca's code while a terminal it just started is still attaching to its surface: transient, not a failure. */
export const TERMINAL_ATTACHING = 'terminal_surface_ownership_unavailable'
const attaching = (e: unknown) => (e as { code?: unknown } | null)?.code === TERMINAL_ATTACHING || new RegExp(TERMINAL_ATTACHING).test(String((e as Error | null)?.message ?? ''))

/**
 * `orca terminal list`. While a launched terminal is still attaching, Orca refuses the whole list
 * with TERMINAL_ATTACHING; that one code is retried for about `budgetMs` with backoff (250 ms,
 * doubling, at most 1 s), then thrown as before. Any other error is thrown at once. It only reads.
 */
export async function listTerminals(run: (args: string[]) => Promise<any>, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), budgetMs = 5_000): Promise<TerminalRecord[]> {
  for (let waited = 0, delay = 250; ; delay = Math.min(delay * 2, 1_000)) {
    try { return (await run(['terminal', 'list']))?.terminals ?? [] }
    catch (e) {
      if (!attaching(e) || waited >= budgetMs) throw e
      const step = Math.min(delay, budgetMs - waited)
      await wait(step)
      waited += step
    }
  }
}

/**
 * Waits for the agent of the exact launched terminal (launchedAgent) for up to `timeoutMs`: never the
 * newest pane, never a second launch. Null when Orca has not listed it yet.
 */
export async function awaitLaunched(launch: Launch, io: { terminals: () => Promise<TerminalRecord[]>; row: () => Promise<WorkspaceRow | undefined>; wait?: (ms: number) => Promise<void>; now?: () => number }, timeoutMs = 15_000): Promise<{ row: WorkspaceRow; agent: AgentInfo } | null> {
  const now = io.now ?? Date.now
  const wait = io.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + timeoutMs
  for (;;) {
    const terminals = await io.terminals()
    const row = await io.row()
    const agent = launchedAgent(launch, terminals, row)
    if (row && agent) return { row, agent }
    if (now() > deadline) return null
    await wait(1000)
  }
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
    // Every row of a member's conversation, so a pane left from before a restart is no duplicate row.
    const memberPanes = new Set((c.sessions ? c.sessions.members.flatMap((m) => memberRows(m, [row])) : session ? conversationRows(row.agents, session) : []).map((a) => a.paneKey))
    return folderRows({ ...row, agents: row.agents.filter((a) => !memberPanes.has(a.paneKey)) }, null, c.key)
  })
}

/**
 * Pure: a row for each agent in a coordinator's folder other than its session (a lead or worker the
 * coordinator started in a tab there), so it shows under the coordinator like a worktree's lead and
 * its ask reaches Up next. No branch or PR: the folder is no worktree, and it is never removed.
 *
 * The folder's open terminals belong to whichever conversations run there, so each row is open only
 * when Orca says its own pane is (`live`). A closed conversation is one row however many panes Orca
 * kept of it (closedRows), and none while the same conversation runs in another pane here.
 */
export function folderRows(row: WorkspaceRow, session: AgentInfo | null, coordinator: string): WorkspaceRow[] {
  const agents = row.agents.filter((a) => a !== session)
  const base = { ...row, branch: null, pr: null, folderOf: coordinator }
  const open = agents.filter((a) => a.live !== false).map((a) => ({
    ...base,
    agents: [a],
    state: a.state,
    priority: row.card?.priority ?? a.summary?.priority ?? null,
    liveTerminals: 1
  }))
  return [...open, ...closedRows(base, row.agents, agents.filter((a) => a.live === false))]
}

/**
 * Pure: one row per closed conversation (its Orca conversation id and agent; a pane without one is
 * its own), standing for its newest pane, with `resumeId` only when exactly one provider id is bound
 * to it (resumeIdOf). Nothing for a conversation that still runs in another pane among `all`.
 */
function closedRows(base: WorkspaceRow, all: AgentInfo[], closed: AgentInfo[]): WorkspaceRow[] {
  const groups = new Map<string, AgentInfo[]>()
  for (const a of closed) {
    if (conversationRows(all, a).some((x) => x.live !== false)) continue
    const key = a.orcaSession ? JSON.stringify([a.orcaSession, a.agentType]) : JSON.stringify([a.paneKey])
    groups.set(key, [...(groups.get(key) ?? []), a])
  }
  return [...groups.values()].map((panes) => {
    // Its newest summary carries the latest title; this picks what the row shows, never the resume id.
    const a = panes.reduce((x, y) => ((y.summary?.updatedAt ?? 0) > (x.summary?.updatedAt ?? 0) ? y : x))
    const resumeId = resumeIdOf(panes)
    return { ...base, agents: [a], state: a.state, priority: base.card?.priority ?? a.summary?.priority ?? null, liveTerminals: 0, ...(resumeId ? { resumeId } : {}) }
  })
}

/**
 * Pure: the provider id to resume a closed conversation by, from the summaries of its panes: each
 * must be bound to the pane's own Orca conversation and agent (its orcaSession and providerSession,
 * as the summarizer read them from that conversation's transcript). Several different ids, or none,
 * give nothing: never the newest, the only file or Orca's own conversation id.
 */
export function resumeIdOf(panes: AgentInfo[]): string | undefined {
  const ids = new Set(panes.flatMap((a) => {
    const s = a.summary
    return a.orcaSession && a.agentType && s?.orcaSession === a.orcaSession && s.providerSession?.provider === a.agentType && s.providerSession.id
      ? [s.providerSession.id] : []
  }))
  const [id] = ids
  return ids.size === 1 && id !== panes[0].orcaSession ? id : undefined
}

/**
 * Resumes a closed conversation of a coordinator's folder (its Asleep row, found again in `rows`) by
 * its exact provider id, and shows the exact terminal the resume returned. It reads and writes no
 * coordinator membership, current member or run routing, and closes or switches no other session.
 * `pending`, per conversation: the terminal a click resumed it in; while that terminal lives, a click
 * adopts it and resumes nothing again.
 */
export async function resumeFolderConversation(rows: WorkspaceRow[], target: { workspaceId: string; pane: string }, io: ResumeIo & { open: (workspaceId: string, terminal: string) => Promise<boolean>; terminals: () => Promise<TerminalRecord[]> }, pending: Map<string, Launch>): Promise<{ ok: boolean; error?: string; starting?: boolean }> {
  const row = rows.find((r) => r.id === target.workspaceId && r.folderOf && r.agents[0]?.paneKey === target.pane)
  const a = row?.agents[0]
  if (!row || !a) return { ok: false, error: 'That conversation is no longer in this coordinator folder. Nothing was launched.' }
  if (!asleep(row)) return a.terminal && await io.open(row.id, a.terminal) ? { ok: true } : { ok: false, error: 'This conversation is open again; nothing was launched.' }
  if (!row.resumeId || !a.agentType) return { ok: false, error: `${NO_RESUME_ID}. Nothing was launched.` }
  const key = askKey(row, a)
  const known = pending.get(key)
  if (known && (known.sessionId !== row.resumeId || !launchedTerminal(await io.terminals(), known.terminalId))) pending.delete(key)
  let bound: Awaited<ReturnType<typeof resumeExact>>
  try { bound = await resumeExact({ workspaceId: row.id, agent: a.agentType, sessionId: row.resumeId }, io, pending.get(key)) }
  catch (e) {
    if (e instanceof ResumeRunningError) { pending.set(key, e.launch); return { ok: true, starting: true, error: e.message } }
    pending.delete(key)
    if (e instanceof ResumeRefusedError || e instanceof ResumeUnverifiedError) return { ok: false, error: e.message }
    return { ok: false, error: `The conversation could not be resumed: ${(e as Error).message}` }
  }
  const terminal = bound.agent.terminal!
  pending.set(key, { workspaceId: row.id, terminalId: terminal, agent: a.agentType, sessionId: row.resumeId })
  return await io.open(row.id, terminal) ? { ok: true } : { ok: false, error: 'The conversation resumed, but its terminal could not be shown.' }
}

/** Every row of the last snapshot, coordinator workspaces included (the panel's rows leave them out). */
let allRows: WorkspaceRow[] = []

/** Summary targets include every live member, independently of which member receives messages.
 * Never read persisted lastAgent history as live inventory. A contradictory pane is unavailable,
 * not an invitation to choose the first member, current recipient, or provider.
 */
export function summaryAgents(snap: Pick<Snapshot, 'rows' | 'coordinators'> & Pick<Partial<Snapshot>, 'bots'>): { agent: AgentInfo; worktreeId?: string }[] {
  const candidates = [
    ...snap.rows.flatMap((r) => r.agents.map((agent) => ({ agent, worktreeId: r.id }))),
    // A bot's chats are summarized like any agent's, so a bot that asks reaches Up next the same way.
    ...(snap.bots ?? []).flatMap((b) => b.chats.map(({ agent, workspaceId }) => ({ agent, worktreeId: workspaceId }))),
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
export function livePanes(snap: Pick<Snapshot, 'rows' | 'coordinators'> & Pick<Partial<Snapshot>, 'bots'>, idle = false): string[] {
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

/**
 * What Orca said about bots at the last read: `orca bot list` (null until it answered once) and
 * `orca automations list`. Both are slow-ish CLI calls, so they are read in the background at most
 * once a minute and a snapshot never waits on them; a failed read keeps the last good one.
 */
let botData: { listed: ListedBot[] | null; automations: BotAutomation[] } = { listed: null, automations: [] }
let botDataAt = 0
let botDataLoading = false
let botsWereOn = true
/** The last duplicate adoptions logged, so each is logged once, not at every snapshot. */
let botDuplicatesLogged = ''

function refreshBotData(orca: OrcaWorkerApi, onLoaded: () => void): void {
  if (botDataLoading || Date.now() - botDataAt < 60_000) return
  botDataLoading = true
  const run = orcaRunner(ORCA_BIN)
  Promise.all([
    run(['bot', 'list'], { timeoutMs: 10_000 }).then((r) => (Array.isArray(r?.bots) ? (r.bots as ListedBot[]) : null)).catch((e: Error) => { orca.log(`orca bot list failed: ${e.message}`); return undefined }),
    run(['automations', 'list'], { timeoutMs: 10_000 }).then((r) => (Array.isArray(r?.automations) ? (r.automations as BotAutomation[]) : [])).catch(() => undefined)
  ])
    .then(([listed, automations]) => {
      const next = { listed: listed === undefined ? botData.listed : listed, automations: automations ?? botData.automations }
      const changed = JSON.stringify(next) !== JSON.stringify(botData)
      botData = next
      botDataAt = Date.now()
      if (changed) onLoaded()
    })
    .finally(() => (botDataLoading = false))
}

/** Pure: the snapshot's bots from the bot workspaces and what Orca said; logs a bot two coordinators adopted. */
export function botsOf(botRows: WorkspaceRow[], coordinators: Coordinator[], data: { listed: ListedBot[] | null; automations: BotAutomation[] }, log: (line: string) => void = () => {}, folders = readBotFolders(), now = Date.now()): Bot[] | null {
  if (data.listed === null && botRows.length === 0) return null
  const { bots, duplicates } = buildBots({ listed: data.listed, folders, automations: data.automations, botRows, coordinators, now })
  const said = duplicates.map((d) => `bot ${d.bot} is listed by ${[d.kept, ...d.also].join(', ')}; it shows under ${d.kept}`).join('\n')
  if (said && said !== botDuplicatesLogged) log(said)
  botDuplicatesLogged = said
  return bots
}

export async function snapshot(
  orca: OrcaWorkerApi,
  ps: () => Promise<PsWorktree[]> = runPs,
  onLineage: () => void = () => {},
  /** Settings → Features → Bots. Off: `orca bot list` is not read and the snapshot carries no bots. */
  botsOn = true
): Promise<Snapshot> {
  const onDisk = readCoordinators()
  const coordinators: Coordinator[] = onDisk.map(({ key, name, repos, look, linearTeams, bots, sessions, sessionNotice, dir }) => ({ key, name, repos, look, linearTeams, bots, sessions, sessionNotice, handover: handoverStatus(dir), members: sessions?.members.map((m) => ({ ...m, agent: null })), workspaceId: null as string | null, session: null as AgentInfo | null, active: false }))
  try {
    refreshLineage(orca, onLineage, allRows.flatMap((r) => r.agents.map((a) => a.paneKey)))
    refreshMemory(allRows, onLineage)
    // Switching Bots on reads at once, not at the next minute; the cached read may be old by then.
    if (botsOn) {
      if (!botsWereOn) botDataAt = 0
      refreshBotData(orca, onLineage)
    }
    botsWereOn = botsOn
    const worktrees = await ps()
    // Folder workspaces (your coordinators live in them) have no identity key; ask the plugin API for their ids.
    const idByPath = new Map<string, string>()
    if (worktrees.some((w) => !w.identity?.key)) {
      const listed = await orca.host.call('workspace.list').catch(() => null)
      for (const w of listed?.workspaces ?? []) idByPath.set(w.path, w.id)
    }
    const owners = readOwners()
    const routed = withRoutes(assignCoordinators(fromPs(worktrees, readStore(), idByPath, quietPane, openedBy), onDisk, lineage, owners), lineage.dispatchIdOf, readRoutes())
    const all = withModels(routed, lineage.dispatchIdOf, readRouteChoices(), (a) => a.paneKey ? seenModel(findTranscript(a.paneKey, undefined, { orcaSession: a.orcaSession, provider: a.agentType })) : null)
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
    // A bot's workspaces show in the Bots section only: not in the tree, Idle or search.
    const botRows = all.filter((r) => isBotRow(r))
    const rows = foldCoordinatorFolders(all.filter((r) => !isBotRow(r)), coordinators, onDisk.map((c) => c.dir))
    // Off: no bots at all, so the section, bot chats in Up next, the counts and summaries see none (bot rows stay out of `rows`).
    const bots = botsOn ? botsOf(botRows, coordinators, botData, (line) => orca.log(line)) : undefined
    return { rows, source: 'cli', capacity: capacityOf(all, pressureLevel()), coordinators, ready: lineageAt > 0, ...(bots !== undefined ? { bots } : {}) }
  } catch (e) {
    orca.log(`orca worktree ps failed, using workspace.list: ${(e as Error).message}`)
    return { rows: (await fromApi(orca)).filter((r) => !isBotRow(r)), source: 'api', capacity: null, coordinators }
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
function updates(orca: OrcaWorkerApi, dir: string | null, changed: (state: UpdateState) => void, onCheck: () => void = () => {}): { check: () => Promise<UpdateCheck>; last: () => UpdateCheck | null } {
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

  // One check for the timer and Settings' Check for Updates. Where Orca installed this copy from
  // (`orca plugin list`) decides whether it can update to a release at all (cannotUpdate).
  const run = orcaRunner(ORCA_BIN)
  let plugin: InstalledPlugin | undefined
  const installed = async (): Promise<InstalledPlugin> => {
    if (plugin !== undefined) return plugin
    const list = await run(['plugin', 'list']).catch(() => null)
    const found = (list?.plugins as { pluginKey?: string }[] | undefined)?.find((p) => p.pluginKey === key) as InstalledPlugin | undefined
    if (found) plugin = found
    return found ?? null
  }
  let last: UpdateCheck | null = null
  let checking: Promise<UpdateCheck> | null = null
  const check = (): Promise<UpdateCheck> => (checking ??= checkForUpdates({ key, current, releases: () => readReleases(), plugin: installed })
    .then((result) => {
      last = result
      // The status bar item and the panel's update button follow the same answer.
      update.found(result.kind === 'available' ? result.version : null)
      if (result.kind === 'failed') orca.log(`update check failed: ${result.reason}`)
      return result
    })
    .finally(() => { checking = null }))
  orca.panels.handle('sidebar.checkUpdates', () => check())
  const api = { check, last: () => last }
  if (!key || !current) {
    orca.log(`update checks off: ${key ? 'no version in the manifest' : `not an installed copy (${dir})`}`)
    void check()
    return api
  }
  update.settle()

  const periodic = () => {
    onCheck()
    // Offline or no git: logged once per check, never a nag.
    void check().finally(() => void timers.push(setTimeout(periodic, UPDATE_CHECK_MS)))
  }
  timers.push(setTimeout(periodic, 10_000))
  return api
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
    if (installed) {
      for (const line of ensureSeeds(seedsFor(dir))) orca.log(line)
      for (const c of readCoordinators()) for (const line of bootstrapCoordinator(c.dir)) orca.log(line)
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  disposers.push(() => timer && clearTimeout(timer))
  // Agent events arrive in bursts; one snapshot per burst is enough.
  let latest: Snapshot | null = null
  // The panel's update button reads the update state from every snapshot it gets.
  let updateState: UpdateState = { kind: 'none' }
  // The panes in front in every workspace; only the focused workspace's agents among them wear the current border.
  let focus: string[] | null = null
  let handoverProviders: Snapshot['handoverProviders'] = null
  /** Agent ids `orca agent installed` listed at the last refresh; the Settings dialog shows a never-used writer's CLI by it. */
  let installedAgents: string[] | null = null
  let firstProviders: Snapshot['coordinatorProviders'] = null
  const shared = (snap: Snapshot): Snapshot => ({ ...snap, update: updateState, focusedPanes: focus, handoverProviders, coordinatorProviders: firstProviders })
  const run = orcaRunner(ORCA_BIN)
  // Full snapshots also catch missing/stale summaries, with bounded retries below.
  const refresh = async (): Promise<Snapshot> => {
    // When the coordinator lineage finishes loading, draw again with it.
    const features = readSettings(DATA_DIR).settings.features
    const [snap, front, installed] = await Promise.all([snapshot(orca, runPs, () => void refresh(), features.bots), readFocus(run), readInstalledProviders(run)])
    snap.features = { linear: features.linear, tokenSpeed: features.tokenSpeed }
    handoverProviders = installed ? installed.filter((a) => a.id === 'claude' || a.id === 'codex').map((a) => a.id as 'claude' | 'codex') : null
    installedAgents = installed ? installed.map((a) => a.id) : null
    firstProviders = coordinatorProviders(installed)
    latest = snap
    focus = front
    if (latest.source === 'cli') refreshOldSummaries(latest)
    orca.panels.post('sidebar.changed', shared(latest))
    void orca.host.call('statusBar.update', statusOf(latest)).catch((e: Error) => orca.log(`statusBar.update failed: ${e.message}`))
    // Members bound without a resume id (a migrated one, a picked one) get it from their exact terminal.
    if (latest.source === 'cli') void captureResumeIds()
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
  const upd = updates(orca, dir, (state) => {
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

  // Launched conversations whose binding is not verified yet, per coordinator: adopted, never relaunched.
  const launches = new Map<string, Launch>()
  // A terminal still attaching makes Orca refuse the list for a moment: retried briefly (listTerminals).
  const terminalsNow = (): Promise<TerminalRecord[]> => listTerminals(run)

  // What this machine can run, for Settings → Models and coordinator models. Settings never waits
  // for it: the dialog gets what is cached, and a fresh lookup is pushed as sidebar.settingsChanged.
  const models = availabilityCache(() => discovery.run(run), (fresh) => {
    catalog = fresh
    void settingsState().then((s) => orca.panels.post('sidebar.settingsChanged', s)).catch((e: Error) => orca.log(`settings refresh failed: ${e.message}`))
  })
  const availability = (maxAgeMs = AVAIL_MAX_MS) => models.get(maxAgeMs)

  /**
   * Fresh means a new explicitly associated member; it never closes an older member. agent.launch
   * starts it in the background, with no tab: it is shown, then bound by that exact terminal's pane
   * once Orca lists its agent. Until then it stays pending and a later start adopts it.
   */
  async function freshSession(c: CoordinatorInfo, agent?: string): Promise<{ ok: boolean; error?: string; bound?: boolean }> {
    settlePending(launches, c.key, await terminalsNow(), readCoordinators().find((x) => x.key === c.key)?.sessions)
    // Shared guard for normal clicks, explicit fresh/restart and any shortcut. An unbound launch
    // is always adopted, even if that harness has since been disabled in Settings.
    const view = latest?.coordinators.find((x) => x.key === c.key)
    if (!c.sessions?.members.length && !launches.has(c.key) && !(view && sessionChoices(view, allRows).length)) {
      const verified = await refresh()
      const choice = firstProvider(verified.coordinatorProviders ?? null, agent)
      if (choice.kind !== 'start') return { ok: false, error: choice.error }
      const latestView = verified.coordinators.find((x) => x.key === c.key)
      const disk = readCoordinators().find((x) => x.key === c.key)
      if (!disk || disk.sessions?.members.length || (latestView && sessionChoices(latestView, allRows).length)) return { ok: false, error: 'The coordinator changed while choosing a provider. Open it again to select its conversation.' }
      agent = choice.agent
    }
    agent ??= 'claude'
    const skill = join(dir!, 'skills/orca-flow')
    bootstrapCoordinator(c.dir)
    const workspaceId = await workspaceFor(c.dir)
    if (!workspaceId) return { ok: false, error: 'Orca did not add the folder' }
    const { launch } = await launchOnce(launches, c.key, workspaceId, agent, async () => {
      if (agent === 'antigravity') {
        return launchAntigravityCoordinator(workspaceId, c.dir, dir, run, (input) => orca.host.call('agent.launch', input))
      }
      // Settings → Models' coordinator model, for this new conversation only; none set: as before.
      const routing = readSettings(DATA_DIR).settings.routing
      const plan = coordinatorLaunchPlan(routing, agent!, routing.coordinator?.model ? await availability() : null)
      return startCoordinator(plan, { workspaceId, agent: agent!, dir: c.dir, prompt: coordinatorPrompt(skill) }, {
        host: (input) => orca.host.call('agent.launch', input), run, terminals: terminalsNow, log: (line) => orca.log(line),
        record: (entry) => { mkdirSync(DATA_DIR, { recursive: true }); appendFileSync(join(DATA_DIR, 'routes.jsonl'), `${JSON.stringify(entry)}\n`) }
      })
    })
    await orca.host.call('terminal.focus', { terminalId: launch.terminalId }).catch(async (e: Error) => {
      // A CLI launch's terminal Orca did not list yet is known by its handle: switch to it by that.
      if (launch.terminalId.startsWith('term_')) { if (await run(['terminal', 'switch', '--terminal', launch.terminalId]).then(() => true, () => false)) return }
      orca.log(`showing the launched terminal failed: ${e.message}`)
    })
    // Agents take seconds to start and report a conversation id; wait for it, not for the newest pane.
    // A list refused while the terminal attaches is retried; if it still fails, the launch stays
    // pending and the next click adopts it.
    const found = await awaitLaunched(launch, { terminals: terminalsNow, row: async () => { await refresh(); return allRows.find((r) => r.id === workspaceId) } })
    if (found) {
      const { row, agent: a } = found
      const resumeSessionId = await resumeIdOf(workspaceId, [launch.terminalId, a.terminal ?? undefined], a.agentType)
      if (launch.agent === 'antigravity') {
        const history = await orca.host.call('agent.listSessions', { workspaceId, limit: 200 }).catch(() => null)
        if (!a.live || resumeSessionId === a.orcaSession || !antigravityTurnRecorded(history?.sessions ?? [], workspaceId, resumeSessionId)) {
          return { ok: false, bound: false, error: 'Antigravity opened. Check its terminal for sign-in or workspace trust. After its first response, select the conversation in Sessions.' }
        }
        await verifyConversation(memberFrom(row, a), run)
      }
      updateCoordinatorSessions(c.dir, (disk) => {
        if (launch.agent === 'antigravity' && (disk?.current ?? null) !== (c.sessions?.current ?? null)) throw new Error('The main conversation changed during Antigravity startup. Select the new conversation in Sessions.')
        return bindLaunched(disk ?? { version: 1, current: null, members: [] }, row, a, resumeSessionId)
      })
      launches.delete(c.key)
      refreshSoon()
      return { ok: true }
    }
    return { ok: true, bound: false, error: 'The new conversation is running and shown; it becomes the main conversation once Orca lists it. Clicking the coordinator again adopts it; nothing is launched again.' }
  }

  // Lookups per member and terminal: done once found, given up after a few misses (an agent still
  // starting has no id yet; a provider without resume ids never will), unless it was just bound.
  const resumeChecked = new Map<string, number>()
  let capturing: Promise<void> | null = null

  /**
   * Records the provider resume id of each live member that lacks one, read from agents.list for the
   * exact terminal it is bound to, so a coordinator that sleeps resumes that same conversation.
   * `just`: a member just bound or resumed, whose id is read again and may replace the old one.
   */
  function captureResumeIds(just?: { key: string; member: string }): Promise<void> {
    const job = (capturing ?? Promise.resolve()).then(async () => {
      let terminals: TerminalRecord[] | null = null
      const listed = new Map<string, ListedAgent[]>()
      for (const c of readCoordinators()) {
        if (just && c.key !== just.key) continue
        for (const m of c.sessions?.members ?? []) {
          const forced = just?.member === m.id
          if (m.resumeSessionId && !forced) continue
          const a = memberAgent(m, allRows)
          if (!a?.terminal || a.live !== true) continue
          const tag = JSON.stringify([m.id, a.terminal])
          if ((resumeChecked.get(tag) ?? 0) >= 5 && !forced) continue
          terminals ??= await terminalsNow()
          if (!listed.has(m.workspaceId)) listed.set(m.workspaceId, (await orca.host.call('agents.list', { workspaceId: m.workspaceId }).catch(() => null))?.agents ?? [])
          const id = resumeIdFor(m, a.terminal, terminals, listed.get(m.workspaceId)!)
          resumeChecked.set(tag, id ? Infinity : (resumeChecked.get(tag) ?? 0) + 1)
          if (id) updateCoordinatorSessions(c.dir, (disk) => withResumeId(disk, m.id, a.terminal!, id, forced))
        }
      }
    }).catch((e: Error) => orca.log(`recording a resume id failed: ${e.message}`))
    capturing = job
    return job
  }

  async function resumeIdOf(workspaceId: string, terminalId: string | (string | undefined)[], agentType: string | null): Promise<string | undefined> {
    const ids = new Set([terminalId].flat().filter(Boolean))
    const listed = await orca.host.call('agents.list', { workspaceId }).catch(() => null)
    const matches = listed?.agents.filter((a) => a.terminalId && ids.has(a.terminalId) && a.agent === agentType && a.sessionId)
    return matches?.length === 1 ? matches[0].sessionId ?? undefined : undefined
  }

  async function captureResumeId(member: import('./protocol.ts').CoordinatorMember, terminalId: string): Promise<void> {
    const id = await resumeIdOf(member.workspaceId, terminalId, member.agentType)
    if (id) member.resumeSessionId = id
  }

  orca.panels.handle('sidebar.createCoordinator', async ({ name, look }) => {
    const invalid = validateName(name.trim(), readCoordinators().map((c) => c.name))
    if (invalid) return { ok: false, error: invalid }
    scaffoldCoordinator(COORDINATOR_HOME, { name: name.trim(), look })
    refreshSoon()
    return { ok: true }
  })

  /**
   * Whether a program other than the shell still runs in a terminal: Orca's memory report names the
   * process of each terminal (by its pty id), and the agent a resume starts is that shell's child.
   * Null when Orca or ps could not say.
   */
  async function programRunsIn(t: TerminalRecord): Promise<boolean | null> {
    try {
      const mem = await run(['diagnostics', 'memory'])
      const session = (mem?.worktrees ?? []).flatMap((w: any) => w.sessions ?? []).find((x: any) => x.sessionId === t.ptyId)
      if (typeof session?.pid !== 'number') return null
      const out = await new Promise<string>((resolve, reject) => execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => e ? reject(e) : resolve(String(stdout))))
      return programRuns(session.pid, parseProcs(out))
    } catch { return null }
  }

  /** A terminal's rendered screen: its lines, and whether Orca reports it exited. */
  async function screenOf(handle: string): Promise<{ lines: string[]; exited: boolean }> {
    const read = await run(['terminal', 'read', '--terminal', handle, '--screen']).catch(() => null)
    const tail = read?.terminal?.tail
    return { lines: Array.isArray(tail) ? tail.filter((l: unknown): l is string => typeof l === 'string') : [], exited: read?.terminal?.status === 'exited' }
  }

  /** Every config dir Orca runs `agent` with on this computer, where its saved conversations live. */
  function providerHomes(agent: string): string[] {
    const data = join(homedir(), 'Library', 'Application Support', 'orca')
    const sub = (dir: string) => { try { return readdirSync(dir).map((x) => join(dir, x, 'home')) } catch { return [] } }
    if (agent === 'claude') {
      let observed: string[] = []
      try { observed = JSON.parse(readFileSync(join(data, 'claude-observed-config-dirs.json'), 'utf8')).filter((x: unknown) => typeof x === 'string') } catch {}
      return [process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude'), ...observed, ...sub(join(data, 'claude-profiles'))].filter((x): x is string => !!x)
    }
    if (agent === 'codex') return [process.env.CODEX_HOME, join(homedir(), '.codex'), ...sub(join(data, 'codex-accounts'))].filter((x): x is string => !!x)
    return []
  }
  const listDir = (dir: string) => { try { return readdirSync(dir) } catch { return null } }
  startTokenSpeed(orca, () => logRoots(providerHomes('claude'), providerHomes('codex')), () => readSettings(DATA_DIR).settings.features.tokenSpeed)

  /** Resumes by provider id and finds the exact terminal the resume returned, or that the provider exited. */
  const resumeIo: ResumeIo = {
    resume: async (input) => {
      if (input.agent === 'antigravity') {
        const workspace = (await orca.host.call('workspace.list')).workspaces.find((w) => w.id === input.workspaceId)
        if (!workspace?.path) throw new Error('The Antigravity workspace is unavailable.')
        await requireAntigravity(workspace.path, run)
      }
      type ResumeAgent = Parameters<typeof orca.host.call<'agent.resume'>>[1]['agent']
      return orca.host.call('agent.resume', { ...input, agent: input.agent as ResumeAgent })
    },
    // Exact where it is cheap: the provider's own transcript store. Orca's session history listing it
    // with messages overrules a store this worker does not know about.
    saved: async (agent, sessionId, workspaceId) => {
      const verdict = conversationSaved(agent, sessionId, providerHomes(agent), listDir)
      if (verdict !== false) return verdict
      const history = await orca.host.call('agent.listSessions', { workspaceId, limit: 200 }).catch(() => null)
      return history?.sessions.some((x) => x.sessionId === sessionId && x.messageCount > 0) ? true : false
    },
    // agent.resume also starts in the background: show it, then wait for that exact terminal's pane,
    // telling a program still starting from one that already exited (nothing but its shell runs).
    binding: async (terminalId, sessionId) => {
      await orca.host.call('terminal.focus', { terminalId }).catch(() => null)
      const deadline = Date.now() + 15_000
      let seen = false
      let ran = false
      let idle = 0
      for (;;) {
        const t = launchedTerminal(await terminalsNow(), terminalId)
        const pane = terminalPane(t)
        await refresh()
        const row = pane ? allRows.find((r) => r.agents.some((a) => a.paneKey === pane)) : undefined
        const a = row?.agents.find((a) => a.paneKey === pane)
        if (t && row && a?.orcaSession) {
          // Read the provider id again from this exact terminal: a resume may fork a new one.
          const id = await resumeIdOf(row.id, [terminalId, t.handle, t.ptyId], a.agentType)
          return { status: 'bound', workspaceId: row.id, agent: { ...a, terminal: t.handle }, ...(id ? { resumeSessionId: id } : {}) }
        }
        const late = Date.now() > deadline
        if (!t) {
          if (seen || late) return { status: 'exited', detail: null }
        } else {
          seen = true
          const runs = await programRunsIn(t)
          if (runs) ran = true
          idle = runs === false ? idle + 1 : 0
          // Two looks a second apart with only the shell left: the program ended (or, once the
          // command is on screen, never stayed). Before the command is typed it is still starting.
          if (idle >= 2) {
            const screen = await screenOf(t.handle)
            const typed = screen.lines.some((l) => l.includes(sessionId))
            if (ran || typed || late || screen.exited) return { status: 'exited', detail: providerMessage(screen.lines, sessionId), terminal: t.handle }
          }
          if (late) return { status: 'running', terminal: t.handle }
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  // Coordinators with a start, resume or session change in flight: open, fresh and resume share it.
  const changing = new Set<string>()
  const busy = (): WakeOutcome => ({ ok: false, kind: 'busy', error: 'A session change is already in progress.' })

  orca.panels.handle('sidebar.handover', ({ key, provider, retry }) => exclusive(changing, key, async (): Promise<{ ok: boolean; error?: string }> => {
    const started = Date.now()
    try {
      if (!['claude', 'codex'].includes(provider) || !dir) throw new Error('Unsupported handover provider or missing coordinator skill.')
      await refresh()
      const c = readCoordinators().find((c) => c.key === key)
      if (!c?.sessions?.current) throw new Error('Select a main conversation before handover.')
      const previous = readHandover(c.dir)
      let attempt = previous
      if (previous?.phase === 'complete') {
        // A repeated UI request after completion is idempotent. A deliberate next handover
        // must target a different provider (same-provider fresh starts have their own action).
        if (previous.provider === provider && c.sessions.current === previous.target?.id) return { ok: true }
        attempt = null
      }
      if (attempt && (!retry || attempt.provider !== provider)) throw new Error(`A handover to ${attempt.provider === 'codex' ? 'Codex' : 'Claude'} is already recorded. Use Retry for that attempt.`)
      if (!attempt) {
        const source = c.sessions.members.find((m) => m.id === c.sessions!.current)!
        if (source.agentType === provider) throw new Error('Choose the other provider for handover, or Start new conversation for a fresh start.')
        const available = await readHandoverProviders(run)
        if (!available?.includes(provider)) throw new Error(`${provider === 'codex' ? 'Codex' : 'Claude'} is not currently available for handover. Check the agent installation and Orca Settings → Agents.`)
        const workspaceId = await workspaceFor(c.dir)
        if (!workspaceId) throw new Error('The coordinator workspace is unavailable.')
        // At most one live run moves (by the target's own run-use); settled runs stay. Refuses otherwise.
        const plan = transferPlan(await readOwnership(run, c.sessions))
        const history = await readHandoverContext(source, run)
        const skill = join(dir, 'skills/orca-flow')
        bootstrapCoordinator(c.dir)
        const runs = { takeOver: plan.adopt, settledStayWithSource: plan.settled, switchCommand: 'orca orchestration run-use --id <id>', switchWarning: 'run-use releases the run this terminal currently holds: one run per terminal.' }
        const context = { capturedAt: new Date().toISOString(), scope: { name: c.name, repos: c.repos, about: c.about, linearTeams: c.linearTeams }, source, runs, workstreams: allRows.filter((r) => r.agents.some((a) => a.coordinator === key)), history }
        const contextPath = join(c.dir, `.orca-flow-handover-context-${Date.now()}.json`)
        writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n', { mode: 0o600 })
        attempt = { version: 1, source: source.id, provider, workspaceId, dir: c.dir, phase: 'prepared', runs: plan.adopt ? [plan.adopt] : [], prompt: handoverPrompt(skill, contextPath, context, plan), bootstrap: { context: contextPath, deadline: Date.now() + 120_000 } }
        saveHandover(attempt)
      }
      await continueHandover(attempt, {
        // The panel gives this request 150 seconds; stop waiting for run-use before it gives up.
        run, save: (s) => { saveHandover(s); refreshSoon() }, waitUntil: started + 140_000,
        current: () => readCoordinators().find((x) => x.key === key)?.sessions ?? { version: 1, current: null, members: [] },
        register: (target) => { updateCoordinatorSessions(c.dir, (disk) => {
          if (!disk) throw new Error('Coordinator sessions disappeared during handover.')
          return disk.members.some((m) => m.id === target.id) ? disk : { ...disk, members: [...disk.members, target] }
        }) },
        canComplete: requireCoordinatorNavigation,
        reveal: async (target) => {
          if (!(await openAgent(orca, run, { workspaceId: target.workspaceId, terminal: target.terminals.at(-1) })).opened) throw new Error('The target could not be opened. The original remains current; Retry reuses this same target.')
        },
        bind: async (s: Handover) => {
          const deadline = Date.now() + 15_000
          for (;;) {
            await refresh()
            const row = allRows.find((r) => r.id === s.workspaceId && r.path === s.dir)
            let a: AgentInfo | null = null
            if (row && s.launch?.kind === 'terminal') a = launchedAgent({ workspaceId: s.workspaceId, terminalId: s.launch.handle, agent: s.provider }, await terminalsNow(), row)
            if (row && s.launch?.kind === 'structured') {
              const id = s.launch.handle.replace(/^orca_session_id:/, '')
              const matches = row.agents.filter((a) => a.orcaSession === id)
              if (matches.length === 1) a = { ...matches[0], terminal: s.launch.handle }
            }
            if (row && a) {
              const provenance = await loadLineage(run, Date.now(), true)
              if (provenance.dispatchOf?.has(a.paneKey) || provenance.dispatcherOf.has(a.paneKey)) throw new Error('The launched session has worker provenance; it cannot become coordinator.')
              return { row, agent: a }
            }
            if (Date.now() > deadline) throw new Error('The target is starting but its identity is not verified yet. Retry adopts this same launch.')
            await new Promise((r) => setTimeout(r, 1000))
          }
        },
        commit: (source, target) => {
          updateCoordinatorSessions(c.dir, (disk) => completeSelection(disk ?? { version: 1, current: null, members: [] }, source, target))
        }
      })
      void captureResumeIds({ key, member: attempt.target!.id })
      refreshSoon()
      return { ok: true }
    } catch (e) { refreshSoon(); return { ok: false, error: (e as Error).message } }
  }, busy))

  /** Opening is not delivery: a sleeping coordinator resumes its exact conversation or starts one (wakePlan). */
  const openCoordinator = (key: string, provider?: string): Promise<WakeOutcome> => exclusive(changing, key, async () => {
    try {
      const snap = await refresh()
      const c = readCoordinators().find((x) => x.key === key)
      if (!c) return { ok: false, kind: 'failed', error: `No coordinator ${key}` }
      const view = snap.coordinators.find((x) => x.key === key)
      settlePending(launches, key, await terminalsNow(), c.sessions)
      return await wakeCoordinator(c, allRows, view ? sessionChoices(view, snap.rows).length : 0, {
        ...resumeIo,
        first: async () => firstProvider(coordinatorProviders(await readInstalledProviders(run)), provider),
        open: async (workspaceId, terminal) => (await openChat({ workspaceId, terminal })).opened,
        // The resume refreshed while binding, which may have saved other members: put the resumed
        // member into what is on disk now, only while it is still the current one.
        save: (next) => {
          const resumed = next.members.find((m) => m.id === next.current)!
          updateCoordinatorSessions(c.dir, (disk) => {
            if (disk?.current !== resumed.id || !disk.members.some((m) => m.id === resumed.id)) throw new Error('the main conversation changed while it was resuming')
            return { ...disk, members: disk.members.map((m) => m.id === resumed.id ? resumed : m) }
          })
          void captureResumeIds({ key, member: resumed.id })
          refreshSoon()
        },
        fresh: (agent) => freshSession(c, agent),
        pend: (launch) => { if (launch) launches.set(key, launch); else if (launches.get(key)?.member) launches.delete(key) }
      }, launches.get(key) ?? false)
    } catch (e) { return { ok: false, kind: 'failed', error: (e as Error).message } }
  }, busy)
  orca.panels.handle('sidebar.openCoordinator', ({ key, provider }) => openCoordinator(key, provider))

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
      if (action === 'fresh') return await freshSession(c, agent)
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
        const member = memberOf(sessions, row, a)!
        if (a.terminal) {
          const shown = await run(['terminal', 'show', '--terminal', a.terminal])
          if (shown?.terminal?.worktreePath !== c.dir) throw new Error('The exact terminal no longer belongs to this coordinator workspace.')
          if (shown?.terminal?.ptyId) await captureResumeId(member, shown.terminal.ptyId)
        }
      } else if (action === 'current') sessions = selectCurrent(sessions, id ?? '')
      else if (action === 'resume') {
        try { sessions = await resumeExactMember(sessions, id ?? '', resumeIo) }
        catch (e) { if (e instanceof ResumeRunningError) launches.set(key, e.launch); throw e }
      }
      writeCoordinatorSessions(c.dir, sessions, { sessions: c.sessions })
      if ((action === 'select' || action === 'resume') && sessions.current) void captureResumeIds({ key, member: sessions.current })
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
        return await exclusive(changing, key, () => freshSession(c, current?.agentType ?? undefined), busy)
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

  // An Asleep row of a coordinator's folder: one resume at a time per conversation, adopted, never repeated.
  const folderResumes = new Map<string, Launch>()
  const resumingFolder = new Set<string>()
  orca.panels.handle('sidebar.resumeConversation', ({ workspaceId, pane }) => exclusive(resumingFolder, JSON.stringify([workspaceId, pane]), async () => {
    try {
      const { rows } = await refresh()
      const outcome = await resumeFolderConversation(rows, { workspaceId, pane }, { ...resumeIo, open: async (w, terminal) => (await openChat({ workspaceId: w, terminal })).opened, terminals: terminalsNow }, folderResumes)
      refreshSoon()
      return outcome
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }, () => ({ ok: false, error: 'This conversation is already being resumed.' })))

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
  // Settings → Features → Linear, read from the file each time so a save applies at once. Off: no read, no send,
  // and the cache goes, so switching on reads fresh.
  const linearOn = () => readSettings(DATA_DIR).settings.features.linear
  const readLinear = () =>
    !linearOn() ? Promise.resolve(null) : (linearReading ??= loadLinear(run)
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
    if (!linearOn()) { linear = null; linearAt = 0; return null }
    const data = !input?.force && linear && Date.now() - linearAt < LINEAR_FRESH_MS ? withSends(linear) : await readLinear()
    return data ? encodeLinear(data) : null
  })

  orca.panels.handle('sidebar.linearSend', async ({ issue: id, coordinator: key }) => {
    if (!linearOn()) return { ok: false, error: 'Linear is off in Settings → Features', warnings: [] }
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
  // The writers and their order come from config.json, read again for every card, so Save applies at once.
  const writer = createWriter({ ...summaryProviders(), writers: () => configuredWriters(DATA_DIR), log: (message) => orca.log(message) })

  // ---------- Settings dialog ----------
  let version: string | null = null
  try { version = JSON.parse(readFileSync(join(dir ?? '', 'orca-plugin.json'), 'utf8')).version ?? null } catch {}
  async function settingsState(fresh = false): Promise<SettingsState> {
    const read = readSettings(DATA_DIR)
    models.refresh(fresh ? AVAIL_OPEN_MS : AVAIL_MAX_MS)
    const avail = models.cached()
    if (!installedAgents) installedAgents = (await readInstalledProviders(run))?.map((a) => a.id) ?? null
    const health = writer.health()
    const writers: WriterStatus[] = WRITER_PROVIDERS.map((provider) => {
      const h = health.find((x) => x.provider === provider)
      return { provider, lastSuccessAt: h?.lastSuccessAt ?? null, failure: h?.failure ?? null, installed: installedAgents ? installedAgents.includes(provider) : null }
    })
    return { settings: read.settings, error: read.error, version, writers, ...(avail ? { availability: avail } : {}), update: updateState, updateCheck: upd.last() }
  }
  orca.panels.handle('sidebar.settings', () => settingsState(true))
  orca.panels.handle('sidebar.saveSettings', async ({ settings }) => {
    try {
      writeSettings(normalizeSettings(settings), DATA_DIR)
    } catch (e) {
      return { ok: false, error: (e as Error).message, state: await settingsState() }
    }
    refreshSoon()
    return { ok: true, state: await settingsState() }
  })
  orca.panels.handle('sidebar.revealSettings', () => new Promise((resolve) => {
    const file = configFile(DATA_DIR)
    execFile('/usr/bin/open', existsSync(file) ? ['-R', file] : [DATA_DIR], { timeout: 5000 }, (error) => resolve({ ok: !error }))
  }))
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
    // The Token speed files change every 30 s and are no part of the snapshot.
    const watcher = watch(DATA_DIR, { recursive: true }, (_event: string, name: string | null) => { if (!isSpeedFile(name)) refreshSoon() })
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

// ---------- model availability ----------

const AVAIL_MAX_MS = 5 * 60_000
const AVAIL_OPEN_MS = 60_000

/**
 * discover() through this worker's processes. Codex lists its models from the Codex home of Orca's
 * selected Codex account, as the card writer resolves it (codexHomeFromAccounts); unresolvable: the
 * default home. Each lookup that fails reads as unknown.
 */
export async function discoverHere(run: (args: string[], options?: { timeoutMs?: number }) => Promise<any>, execImpl: Exec = execCmd, resolve: (name: string) => Promise<string> = resolveCli): Promise<Availability> {
  let codexHome: string | undefined
  try { codexHome = codexHomeFromAccounts({ ok: true, result: await run(['account', 'list', '--agent', 'codex'], { timeoutMs: 10_000 }) }) } catch { codexHome = undefined }
  return discover(execImpl, { orcaBin: ORCA_BIN, codexBin: await resolve('codex'), claudeBin: await resolve('claude'), ...(codexHome ? { env: { CODEX_HOME: codexHome } } : {}) })
}

/** The discovery the worker runs; tests swap it for a stub. */
export const discovery = { run: (run: Parameters<typeof discoverHere>[0]) => discoverHere(run) }

/**
 * The last availability and when it was read. `refresh` starts a lookup in the background when the
 * cached one is older than `maxAgeMs` (one at a time) and calls `onFresh` when it lands; `get`
 * waits for a fresh one (coordinator launches); `cached` never waits.
 */
export function availabilityCache(discoverFn: () => Promise<Availability>, onFresh: (a: Availability) => void = () => {}, now = Date.now) {
  let last: { at: number; value: Availability } | null = null
  let running: Promise<Availability> | null = null
  const start = () => (running ??= discoverFn()
    .then((value) => { last = { at: now(), value }; onFresh(value); return value })
    .finally(() => { running = null }))
  const stale = (maxAgeMs: number) => !last || now() - last.at >= maxAgeMs
  return {
    cached: (): Availability | undefined => last?.value,
    refresh(maxAgeMs: number): void { if (stale(maxAgeMs)) start().catch(() => null) },
    get: (maxAgeMs: number): Promise<Availability> => (stale(maxAgeMs) ? start() : Promise.resolve(last!.value))
  }
}

const execCmd: Exec = (cmd, args, opts) => new Promise((resolve, reject) => {
  const env = opts?.env ? { ...process.env, ...opts.env } : undefined
  execFile(cmd, args, { timeout: opts?.timeoutMs ?? 10_000, maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) }, (e, stdout) => (e ? reject(e) : resolve(String(stdout))))
})

// ---------- Token speed ----------

/** How often the logs are sampled, and how many samples between full listings (which find new logs). */
const SPEED_SAMPLE_MS = 30_000
const SPEED_FULL_EVERY = 4
/** One slice of log reading; the slices of a long read (the first 24 h) yield to the event loop between them. */
const SPEED_SLICE_MS = 40

type Child = { kill?: (signal?: string) => void }
const exec = (file: string, args: string[], timeout: number, keep?: (child: Child) => void) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve(String(stdout)))) as Child
    keep?.(child)
  })

/**
 * The Token speed section's sampling, while the worker runs: the agents' logs every 30 s (only what
 * they gained, in slices of at most SPEED_SLICE_MS so a big first read never blocks the worker), and
 * a nettop snapshot of their sockets every 30 s for their traffic. The internet test runs only on the panel's Test.
 * Settings → Features → Token Speed off: none of that runs (the timers idle) and the history file stays as it is.
 * History and cursors live in ~/.orca-flow/token-speed*.json; the panel gets speedView (a few KB).
 */
function startTokenSpeed(orca: OrcaWorkerApi, roots: () => LogRoot[], on: () => boolean = () => true): void {
  let stopped = false
  const timers: ReturnType<typeof setTimeout>[] = []
  let nettop: Child | null = null
  disposers.push(() => {
    stopped = true
    timers.forEach(clearTimeout)
    nettop?.kill?.('SIGTERM')
  })
  const store = readSpeedStore(DATA_DIR)
  const history = store.history
  const cursors = store.cursors ?? new Map()
  // No cursors yet: the first sample reads the last 24 h of logs, and the section says so until then.
  let ready = store.cursors != null
  let testing = false
  let testError: string | null = null
  let samples = 0
  let reading: { paths: [string, LogKind][]; next: number; now: number } | null = null

  const view = (): TokenSpeedWire => speedView(history, Date.now(), { ready, testing, testError })
  const post = () => orca.panels.post('sidebar.tokenSpeedChanged', view())
  const save = () => {
    try { writeSpeedStore(DATA_DIR, { history, cursors }, Date.now()) } catch (e) { orca.log(`saving token speed failed: ${(e as Error).message}`) }
  }

  const slice = () => {
    if (stopped || !reading) return
    try {
      const r = readLogs({ paths: reading.paths, from: reading.next, cursors, history, now: reading.now, deadline: Date.now() + SPEED_SLICE_MS })
      reading.next = r.next
    } catch (e) {
      orca.log(`token speed read failed: ${(e as Error).message}`)
      reading.next = reading.paths.length
    }
    if (reading.next < reading.paths.length) { timers.push(setTimeout(slice, 0)); return }
    reading = null
    ready = true
    prune(history, Date.now())
    save()
    post()
  }
  const sampleLogs = () => {
    if (stopped || reading || !on()) return
    const now = Date.now()
    try {
      reading = { paths: logsToRead(roots(), cursors, now, !ready || samples++ % SPEED_FULL_EVERY === 0), next: 0, now }
    } catch (e) {
      orca.log(`token speed listing failed: ${(e as Error).message}`)
      return
    }
    slice()
  }
  const logTimer = setInterval(sampleLogs, SPEED_SAMPLE_MS)
  disposers.push(() => clearInterval(logTimer))
  timers.push(setTimeout(sampleLogs, 3000))

  // A nettop snapshot of the agents' sockets each sample, diffed against the last one.
  let lastSockets: SocketSnapshot | null = null
  const sampleNet = async () => {
    if (stopped) return
    if (!on()) {
      lastSockets = null
      timers.push(setTimeout(() => void sampleNet(), SPEED_SAMPLE_MS))
      return
    }
    try {
      const ps = await exec('/bin/ps', ['-A', '-o', 'pid=,comm='], 5000)
      const csv = await exec('/usr/bin/nettop', ['-L', '1', '-x', '-J', 'bytes_in,bytes_out'], 30_000, (c) => (nettop = c))
      nettop = null
      const snap = parseNettop(csv, agentPids(ps), Date.now())
      const prev = lastSockets
      lastSockets = snap
      if (prev && !stopped) {
        const d = socketDelta(prev, snap)
        // A gap much longer than a sample (the Mac slept) is not one sample's traffic.
        if (d.secs > 0 && d.secs < 3 * SPEED_SAMPLE_MS / 1000) {
          addNet(history, { at: snap.at, ...d })
          post()
        }
      }
    } catch (e) {
      nettop = null
      if (!stopped) orca.log(`nettop sample failed: ${(e as Error).message}`)
    }
    if (!stopped) timers.push(setTimeout(() => void sampleNet(), SPEED_SAMPLE_MS))
  }
  timers.push(setTimeout(() => void sampleNet(), 5000))

  // Switched on again: the panel's ask samples the logs now, so the section is not 30 s behind.
  let wasOn = true
  orca.panels.handle('sidebar.tokenSpeed', () => {
    const now = on()
    if (now && !wasOn) sampleLogs()
    wasOn = now
    return view()
  })
  // One test at a time, only on the user's Test; its result is kept with the history.
  orca.panels.handle('sidebar.tokenSpeedTest', () => {
    if (testing || !on()) return { started: false }
    testing = true
    testError = null
    post()
    exec('/usr/bin/networkQuality', ['-c'], 120_000)
      .then((out) => {
        const result = parseNetworkQuality(out, Date.now())
        if (result) {
          history.internet = result
          save()
        } else testError = 'The speed test gave no result.'
      })
      .catch((e: Error) => {
        testError = `The speed test failed: ${e.message.split('\n')[0]}`
        orca.log(`networkQuality failed: ${e.message}`)
      })
      .finally(() => {
        testing = false
        if (!stopped) post()
      })
    return { started: true }
  })
}
