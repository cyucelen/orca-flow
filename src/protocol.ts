// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

export type Priority = 'P0' | 'P1' | 'P2' | 'P3'
export type AskType = 'none' | 'decision' | 'approval' | 'review' | 'info' | 'action'

/** What the end-of-turn summarizer (src/summarize.ts) wrote for one agent after its last turn. */
export type AgentSummary = {
  /** Binding only; never used for coordinator membership or provider resume routing. */
  orcaSession?: string
  providerSession?: { provider: string; id: string }
  title: string
  /** One stable sentence on what the workstream is for (summaries before this field lack it). */
  about?: string
  /** The ask in about eight words. */
  glance?: string
  /** What it waits on that is not the user ("E2E run", "CI"); empty when nothing. */
  watching?: string
  goal: string
  since: string
  /** `blocking` false: the agent works on and needs the answer only later ("Working · needs 2 files later"); absent means it waits. */
  needs: { type: AskType; ask: string; options: string[]; blocking?: boolean }
  /** The frame's Reply line, the exact words the agent asks for ("A or B"); only with an ask from a frame. */
  reply?: string
  /** The frame's status line for an ask from a frame ("Needs your pick"); Up next shows it as the ask's label. */
  status?: string
  /** Where the ask came from: a valid message frame, or Haiku reading the message. Older cards lack it. */
  source?: 'frame' | 'summarizer'
  effort: 'quick' | 'deep'
  priority: Priority
  role: 'lead' | 'coordinator' | 'worker' | 'solo'
  updatedAt: number
  /** The SUMMARIZER_VERSION that wrote it; cards from before the field count as 0. */
  summarizer?: number
}

/** What a coordinator wrote for a workstream with `orca-flow set`. */
export type WorkstreamCard = {
  priority?: Priority
  role?: string
  /** Parent worktree identity key. */
  parent?: string
  goal?: string
  fits?: string
}

export type AgentInfo = {
  paneKey: string
  /** Orca's working mode; "monitoring" is the dashed circle in Orca's own sidebar. */
  workingMode: string | null
  /** Which of the user's coordinators it works for: that coordinator's key, or 'you' for chats nobody dispatched. */
  coordinator: string
  /** Pane of the agent that dispatched this one, when that is not one of the user's coordinators. */
  leadPane: string | null
  /** Orca's record of the pane that started this agent (`parentPaneKey` in `orca worktree ps`). */
  parentPane: string | null
  /** Orca's id for its conversation (`orcaSessionId`), kept when the agent is resumed in a new terminal; null when Orca has none. */
  orcaSession: string | null
  /**
   * Its Orca orchestration dispatch: open until it reports worker_done (or is abandoned), then
   * settled; null when it has none or the lineage has not loaded.
   */
  dispatch: 'open' | 'settled' | null
  /** Its terminal handle, so a finished session can be closed; null until known. */
  terminal: string | null
  /** The question it is waiting on, from Orca's record of its pending question tool call. */
  question: string | null
  state: AgentState
  /** Summary title, else conversation name, task title, or agent kind. */
  title: string
  /** The title of the Orca task it was dispatched with (`taskTitle`), when it has one. */
  task?: string | null
  /** Orca’s agent id, never inferred from the model, title or summary. */
  agentType: string | null
  /** Positive per-pane host evidence: a live PTY or an owned structured chat; absent on old snapshots. */
  live?: boolean
  /** The model its dispatch was routed to, from ~/.orca-flow/routes.jsonl: "Claude Sonnet · medium — standard task". */
  route?: string | null
  /**
   * The model shown on its row, never the Settings default: `seen` is its latest reply's model read
   * from its own transcript; `asked` is what dispatch routed it to (no reply yet); `default` is a
   * route with no model (the provider's own default, so the name is unknown). Absent: nothing known.
   */
  model?: { name: string; effort?: string; source: 'seen' | 'asked' | 'default'; /** Provider's display name, for "default". */ provider?: string }
  summary: AgentSummary | null
}

export type WorkspaceRow = {
  /** The plugin API's workspace id, accepted by `workspace.open`. */
  id: string
  name: string
  branch: string | null
  repo: string
  /** Checkout path and whether it is the repo's main checkout (never offered for removal). */
  path: string | null
  main: boolean
  agents: AgentInfo[]
  /** Most urgent agent state, or null when no agent is known. */
  state: AgentState | null
  /** The card's level, else the highest level any agent's summary guessed. */
  priority: Priority | null
  card: WorkstreamCard | null
  /** The coordinator's workspace id, from Orca's lineage or the card. */
  parentId: string | null
  liveTerminals: number
  pinned: boolean
  unread: boolean
  active: boolean
  /** Orca's own "in-progress" / "in-review" board column. */
  workspaceStatus: string | null
  lastActivityAt: number | null
  /** When the workstream started (Orca's sortOrder); a stable order that activity never changes. */
  createdAt: number
  /** Orca's linked PR: its state (open, merged, closed, draft), its title and, for an open one, its CI checks. */
  pr: { number: number; url: string; state: string; title?: string; checks: 'success' | 'pending' | 'failure' | 'cancelled' | null } | null
  /** Set on the queue row that stands for a coordinator's own session (see askingRows in view.ts). */
  coordinator?: string
  /**
   * Set on a row that stands for one agent in a coordinator's folder (a lead or worker the
   * coordinator started in a tab there): that coordinator's key. Its id is the folder's workspace,
   * which is never removed.
   */
  queueKey?: string
  coordinatorMember?: string
  historical?: boolean
  folderOf?: string
  /**
   * Set on a folder row that stands for a closed conversation (Asleep): its exact provider session id,
   * read from the summary bound to that conversation; absent when none is verified (no resume).
   */
  resumeId?: string
  /** The Linear issue Orca linked to the worktree (`--linear-issue`), as its identifier (BOU-4179). */
  linearIssue?: string | null
  /** Where its Linear label opens, when the Linear data knows (see issueLink); null or absent: plain text. */
  linearLink?: { url: string; title: string | null } | null
  /**
   * Set on an Orca bot's workspace (`bot` in `orca worktree ps`: the bot's name) and on the Up next
   * row of a bot chat that asks: such rows show in the Bots section, never as ordinary rows.
   */
  bot?: string | null
}

/** A chat of an Orca bot: its agent, and the workspace a click on it opens. */
export type BotChat = { workspaceId: string; agent: AgentInfo }

/**
 * One of the user's Orca bots (`orca bot list`), with what its row shows: its avatar (bot.json
 * `avatar`, like "mascot:B1"), one line on what it is for, the coordinator that adopted it
 * (coordinator.json `bots`; null: Personal), its chats, and its next automation run.
 */
export type Bot = {
  id: string
  name: string
  /** Its folder under ~/.orca/bots, when found. */
  folder: string | null
  avatar: string | null
  /** One line, markdown stripped; '' when nothing says. */
  purpose: string
  paused: boolean
  /** The key of the coordinator that lists it in `bots`, or null for Personal. */
  coordinator: string | null
  /** Its home workspace in Orca (where its Home chat runs): what a click on its row opens. */
  workspaceId: string | null
  chats: BotChat[]
  /** The soonest enabled automation run of this bot (ms), or null. */
  nextRunAt: number | null
}

export type Capacity = {
  /** ok: a new workstream with its environment fits; agents-only: another agent fits, an environment not. */
  verdict: 'ok' | 'agents-only' | 'full' | 'pressure'
  /** Orca's available memory minus the margin; null until Orca's memory report has loaded. */
  freeGB: number | null
  marginGB: number
  /** True until the first memory and disk reading has come in. */
  measuring?: boolean
  /** Free disk on the volume your home is on; worktrees and their installs live there. */
  diskFreeGB: number | null
  /** What another agent costs here (median of open sessions). */
  agentGB: number
  /** What a typical project environment (its dev servers) costs here. */
  envGB: number
  pressure: 'normal' | 'warn' | 'critical' | 'unknown'
  /** Agents whose work is done but whose session still holds memory. */
  finishedOpen: number
}

/** A saved logical membership, independent of focus, provider and run ownership. */
export type CoordinatorMember = {
  id: string
  workspaceId: string
  workspacePath?: string | null
  bindings?: { terminal: string; paneKey: string; orcaSession: string | null }[]
  orcaSession: string | null
  agentType: string | null
  title: string
  paneKey: string
  /** Exact historical routes; never reassigned when another member becomes current. */
  terminals: string[]
  /** Provider resume id from agents.list/status, not Orca's conversation id. */
  resumeSessionId?: string
  /**
   * The provider said `sessionId` (this member's resume id when it was refused) has no saved
   * conversation: it is never launched again; a newly recorded resume id makes it stale.
   */
  resumeRefused?: { sessionId: string; reason: string }
  lastAgent?: AgentInfo
}
export type CoordinatorSessions = { version: 1; current: string | null; members: CoordinatorMember[] }
export type CoordinatorMemberView = CoordinatorMember & { agent: AgentInfo | null }
/**
 * What a coordinator click did. `ok` means a session is now shown. `choose` and `restore-failed` are
 * not errors: the first needs an explicit Sessions choice, the second can be retried (`retryable`,
 * only when the cause may be transient) or replaced by a new conversation while the old one stays in
 * history. `busy`: another start, resume or session change for it is still running. `starting`: a new
 * or resumed conversation runs and is shown, but its binding is not verified yet; the next click
 * adopts that same terminal, launching or resuming nothing. `failed` is an actual failed start or open.
 * `error` is the full reason, for the Sessions menu, never the row. `terminal` (with `workspaceId`) is
 * a terminal the attempt left open, for Show terminal.
 */
export type CoordinatorProvider = { id: string; name: string }
export type WakeOutcome = { ok: boolean; kind: 'opened' | 'resumed' | 'started' | 'starting' | 'choose' | 'provider' | 'restore-failed' | 'busy' | 'failed'; providers?: CoordinatorProvider[]; error?: string; retryable?: boolean; agent?: string; workspaceId?: string; terminal?: string }
export type CoordinatorHistory = { title: string; text: string; unavailable?: string; truncated?: boolean }
export type DeliveryRecipient = { member: string; workspaceId: string; orcaSession: string | null; terminal: string; agentType: string | null; receipt?: { requestId?: string; accepted?: boolean; stages?: string[]; provider?: string; observation?: string; processIncarnation?: string } }

/** One of the user's coordinators: a coordinator with its own Orca folder workspace. */
export type Coordinator = {
  key: string
  name: string
  repos: string[]
  sessions?: CoordinatorSessions
  members?: CoordinatorMemberView[]
  sessionNotice?: string
  routing?: string
  handover?: import('./handover.ts').HandoverStatus
  /** Its folder workspace in Orca, once added; clicking the coordinator opens it. */
  workspaceId: string | null
  /** The explicitly current member's live session, never inferred from focus or provider. */
  session?: AgentInfo | null
  /** The character it was given at creation. */
  look?: Look | null
  /** Its workspace is the one focused in Orca (its row is marked only when its session's tab is, see Snapshot.focusedPanes). */
  active?: boolean
  /** Linear team keys it owns (coordinator.json `linearTeams`): their issues suggest it when sent. */
  linearTeams?: string[]
  /** Orca bots it adopted (coordinator.json `bots`, bot names): the Bots section groups them under it. */
  bots?: string[]
}

export type LookShape = 'pentagon' | 'hex' | 'shield'
export type Look = { color: string; shape: LookShape }

/** Where an Orca Flow update stands; the status bar item and the panel's update button show it. */
export type UpdateState =
  | { kind: 'none' }
  | { kind: 'available'; version: string }
  /** The status bar item's first click, waiting for the second; the panel shows it as available. */
  | { kind: 'confirm'; version: string }
  | { kind: 'updating'; version: string }
  | { kind: 'updated'; version: string }
  | { kind: 'approval'; version: string; command: string; reason: string }
  | { kind: 'failed'; version: string; reason: string }

export type Snapshot = {
  /** Enabled local host launchers for coordinator handover; null/absent means discovery failed. */
  handoverProviders?: import('./handover.ts').HandoverProvider[] | null
  coordinatorProviders?: CoordinatorProvider[] | null
  rows: WorkspaceRow[]
  source: 'cli' | 'api'
  capacity: Capacity | null
  /** The user's coordinators, from COORDINATOR_HOME; 'you' is implied. */
  coordinators: Coordinator[]
  /** False until the worker knows which coordinator each agent works for. */
  ready?: boolean
  /** The update the worker knows of; absent or 'none' hides the panel's update button. */
  update?: UpdateState
  /**
   * The panes Orca shows in the focused workspace (`<tabId>:<leafId>`, the front tab and pane of
   * each tab group), from `orca terminal list --include-visual-layouts`; only an agent here wears
   * the current border. Empty: no terminal is shown there. Absent or null: Orca told only which
   * workspace is focused, so only that worktree's lead is marked.
   */
  focusedPanes?: string[] | null
  /** The user's Orca bots; absent or null until `orca bot list` (or a bot workspace) has told. */
  bots?: Bot[] | null
  /** Settings → Features: Linear and Token Speed. Absent reads as on; false hides the section and its entry points. */
  features?: { linear: boolean; tokenSpeed: boolean }
}

/** What the opened cockpit shows; loaded on demand because Orca's memory report is slow. */
export type SessionRef = { paneKey: string; terminal: string | null; workspaceId: string; title: string; repo: string; memMB: number }
/** Processes an agent started that run outside its session (a dev server), so Orca does not count them. */
export type StartedGroup = {
  /** "<worktree path>|<pane>" */
  key: string
  path: string
  /** The pane that started them; it may have gone to sleep since. */
  paneKey: string | null
  workspaceId: string
  worktreeName: string
  repo: string
  /** The heaviest process's name, like next-server. */
  name: string
  count: number
  memMB: number
}
export type CockpitStats = {
  swap: { usedGB: number; totalGB: number } | null
  /** Orca's own figures: used is total minus what macOS reports as available. */
  ram: { usedGB: number; totalGB: number } | null
  started: StartedGroup[]
  heaviest: SessionRef[]
  finished: SessionRef[]
  merged: { workspaceId: string; name: string; repo: string; pr: number }[]
}

/** A Linear issue as the panel shows it; every text field is untrusted and escaped when drawn. */
export type LinearIssue = {
  /** Its identifier, like BOU-4179. */
  id: string
  title: string
  url: string
  /** Linear's workflow state: its name, its type (triage, backlog, unstarted, started, completed, canceled) and color. */
  state: { name: string; type: string; color: string }
  /** Its team's key. */
  team: string
  project: string | null
  /** Its project's Linear color, '' when none or unknown. */
  projectColor: string
  assignee: { id: string; name: string } | null
  /** Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number
  /** Its cycle's id, when it is in one. */
  cycle: string | null
  /** When it last changed (ms), 0 when unknown. */
  updatedAt: number
}

/** An issue sent to a coordinator that no worktree links yet. */
export type LinearSent = { coordinator: string; at: number; recipient?: DeliveryRecipient; delivery?: 'unknown' }

/** What the Linear section shows; null when Linear is not connected. */
export type LinearData = {
  /** The user's Linear id: "Mine" is what is assigned to it. */
  me: string | null
  /** The user's teams (keys), the ones Team and Cycle show. */
  teams: string[]
  /** Every connected team's key, for a coordinator's "Linear teams" chips. */
  connectedTeams: string[]
  /** Open issues (and Staging) of "Mine" and of the user's teams, each once. */
  issues: LinearIssue[]
  /** The active cycle of each of the user's teams (cycle ids). */
  cycles: string[]
  /** Issues sent to a coordinator and not linked yet. */
  sent: Record<string, LinearSent>
  /** Team key -> the coordinator it was last sent to; suggests it when no coordinator owns the team. */
  lastSent: Record<string, string>
  /** When it was read. */
  at: number
}

/**
 * LinearData as it crosses to the panel. Orca drops a post over 256 KiB, and a team's open issues
 * repeat the same states, projects, people and cycles hundreds of times, so each issue is a tuple
 * pointing into small tables (see encodeLinear in linear.ts):
 * [id, title, priority, state, project, assignee, cycle, updated (s), url?, team?], -1 for none,
 * the URL only when it is not `urlBase + id` (0: none), the team only when it is not the ID's prefix.
 */
export type LinearWire = Omit<LinearData, 'issues'> & {
  wire: 1
  urlBase: string
  states: [name: string, type: string, color: string][]
  projects: [name: string, color: string][]
  people: [id: string, name: string][]
  cycleIds: string[]
  issues: (string | number)[][]
}

/** What the Settings dialog shows: the saved settings, whether the file can be used, and each writer's status. */
export type SettingsState = {
  settings: import('./settings.ts').FlowSettings
  /** Why ~/.orca-flow/config.json cannot be used (its settings read as defaults); saving is refused while set. */
  error: string | null
  /** Orca Flow's version, for the dialog's title; null when unknown. */
  version: string | null
  writers: import('./settings.ts').WriterStatus[]
  /** What this machine can run, for Settings → Models (installed agents, the Codex catalog); absent until the first lookup lands (then sidebar.settingsChanged brings it). */
  availability?: import('./routing.ts').Availability
  /** The update in progress or offered (the status bar item and the panel's update button show the same). */
  update?: UpdateState
  /** The last check for updates (timer or Check for Updates); null before the first one. */
  updateCheck?: import('./update.ts').UpdateCheck | null
}

// ---------- Analytics (src/analytics.ts computes these; docs/analytics-brief.md is the spec) ----------

/** The Usage view's window: activity in it, and which finished tasks and workstreams it lists (brief §5). */
export type AnalyticsWindow = '7d' | '30d' | 'all'

/**
 * Tokens in the four categories (cache write split by TTL) and their estimate. `total` is the sum of
 * the five counts. `cost` is the estimate of the priced tokens only, in $ at API list prices;
 * `unpriced` is the tokens with no price (left out of `cost`, shown as "no estimate").
 */
export type Spend = { in: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; out: number; total: number; cost: number; unpriced: number }

/** accepted / failed: the worker_done outcome; unknown: settled with no (or an unknown) outcome; running: not settled. */
export type TaskResult = 'accepted' | 'failed' | 'unknown' | 'running'

/** One dispatch: a worker attempt (a retry is its own), or a lead. Tokens are its whole-run total. */
export type AnalyticsTask = {
  dispatchId: string
  taskId: string | null
  workstream: { id: string; title: string }
  role: 'lead' | 'worker'
  /** The Settings → Models row it ran on (kind id, type id, lead, other, unrouted). */
  row: string
  /** What it was dispatched as: "normal, high risk, retry 1", a type's name, "explicit model", "not routed". */
  dispatchedAs: string
  attempt: number
  retryOf: string | null
  /** A later dispatch retried it. */
  retried: boolean
  /** The row's fallback ran (routes.jsonl source "fallback"). */
  fallback: boolean
  /** The routed choice ("Claude Sonnet · medium"), null when not routed. */
  routed: string | null
  /** The logged model that spent most of its tokens; null when none or unknown. */
  model: string | null
  result: TaskResult
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  spend: Spend
}

/** One row of "By task kind": a Settings → Models row, Lead, or the visible leftovers (other, unrouted). */
export type KindRow = {
  id: string
  name: string
  kind: 'kind' | 'type' | 'lead' | 'other' | 'unrouted'
  /** Settings → Models: the row's model and effort ("Claude Sonnet · medium"); Lead: its pick or "provider default". */
  model: string | null
  fallback: string | null
  /** The logged model most of the row's finished tasks ran on. */
  loggedModel: string | null
  /** Tasks finished in the window (by finish date). */
  n: number
  running: number
  /** n < 3: no medians are given. */
  few: boolean
  medianTokens: number | null
  /** Over the row's fully priced tasks; null when none is. */
  medianCost: number | null
  /** Finished tasks with tokens that have no price. */
  unpricedTasks: number
  failed: number
  retried: number
  /** Share of finished tasks that failed or were retried, 0..1; null when n is 0. */
  failedOrRetried: number | null
  medianMs: number | null
  /** Finished tasks on which the row's fallback ran. */
  fallbackRan: number
  /** Finished tasks that are retries (attempt > 0). */
  retries: number
  /** Its finished tasks, most tokens first. */
  tasks: AnalyticsTask[]
}

/** A workstream as one line: whole-run tokens; partial when its logs cover less than all of its active time. */
export type WorkstreamLine = {
  id: string
  title: string
  result: TaskResult
  finishedAt: number | null
  /** Whole run. */
  spend: Spend
  /** The part of its tokens recorded inside the window (brief §5: "In window" vs "Whole run"). */
  inWindow: number
  /** Share of its dispatches' active time their logs cover, 0..1. */
  coverage: number
  partial: boolean
}

export type ArmStats = {
  /** Finished runs of the arm (whole history), and how many passed or failed. */
  runs: number
  accepted: number
  failed: number
  running: number
  /** All tokens of its finished runs, failed runs and retries included. */
  spend: Spend
  tokensPerAccepted: number | null
  costPerAccepted: number | null
  /** Median wall time (first dispatch → last completion) of accepted runs. */
  medianWallMs: number | null
  /** The lowest coverage of its runs. */
  coverage: number
  /** The routed models (per role and row) the arm ran on. */
  models: string[]
}

export type Comparison = {
  pair: string
  baseline: ArmStats
  variant: ArmStats
  comparable: boolean
  /** Why it is not comparable. */
  why: ('models-differ' | 'arm-missing')[]
  /** Caveats of a comparable pair. */
  notes: ('small-sample' | 'partial')[]
  /** One sentence for an incomparable pair ("Not comparable: model changed."), else null. */
  sentence: string | null
  /** variant − baseline; null when not comparable (or a side has nothing to compare). */
  delta: { tokensPerAccepted: number | null; costPerAccepted: number | null; wallMs: number | null; passed: number } | null
  runs: { workstream: string; title: string; arm: 'baseline' | 'variant'; result: TaskResult; finishedAt: number | null; wallMs: number | null; spend: Spend; coverage: number }[]
}

export type AnalyticsView = {
  now: number
  window: AnalyticsWindow
  /** The window's start; null for all. */
  from: number | null
  prices: { version: string; dated: string; label: string; tip: string }
  /** 0. The curiosity strip: activity in the window (clipped), plus two finished-in-window facts. */
  strip: {
    tokens: Spend
    /** Part of `tokens`: sessions with no Orca binding. */
    unattributed: Spend
    /** Part of `tokens`: responses whose log named no model. */
    unknownModel: number
    biggest: { id: string; title: string; tokens: number } | null
    /** Model share of the window's tokens, largest first; model null = unknown. */
    models: { model: string | null; label: string; tokens: number; share: number }[]
    /** Cache reads ÷ all input (uncached + cache read + cache write); null with no input. */
    cacheShare: number | null
    priciest: { dispatchId: string; name: string; workstream: { id: string; title: string }; cost: number } | null
  }
  /** 1. By task kind: the Settings → Models rows in their order, then Lead, then other and unrouted when they have tasks. */
  rows: KindRow[]
  /** 2. Lead overhead over finished workstreams with workers. */
  leadOverhead: { median: number | null; n: number; heaviest: { id: string; title: string; share: number; leadTokens: number; tokens: number }[] }
  /** 3. Labelled pairs with a run finished in the window or running; comparable first. */
  comparisons: Comparison[]
  /** 4. Biggest workstreams finished in the window (top 5, whole-run tokens), and what runs now. */
  workstreams: { top: WorkstreamLine[]; finished: number; running: { count: number; spend: Spend } }
}

export type WorkstreamRow = {
  who: 'lead' | 'worker' | 'retry'
  label: string
  dispatchId: string
  taskId: string | null
  /** "claude:<id>"; null for a dispatch whose session was never seen. */
  session: string | null
  /** The session that continued this one (a handover); nothing is moved to it. */
  continuedIn: string | null
  model: string | null
  row: string | null
  rowName: string | null
  dispatchedAs: string | null
  fallback: boolean
  result: TaskResult
  durationMs: number | null
  spend: Spend
}

export type WorkstreamDetail = {
  id: string
  title: string
  workspace: string | null
  runId: string | null
  result: TaskResult
  startedAt: number | null
  finishedAt: number | null
  wallMs: number | null
  coverage: number
  partial: boolean
  pair: { id: string; arm: 'baseline' | 'variant' } | null
  /** Whole run. Equals the sum of `rows`, and of `byModel`. */
  spend: Spend
  /** Lead sessions first (one row per session), then workers and retries. */
  rows: WorkstreamRow[]
  byModel: { model: string | null; label: string; spend: Spend }[]
}

/** The sidebar's usage line: the last 7 days, "52.4M tokens · ≈ $48". */
export type UsageSummaryWire = { days: number; tokens: number; cost: number; unpriced: number; prices: string; tip: string }

declare module 'orca' {
  interface PluginRequests {
    /** The Usage view for a window (computed on request from the usage store, links and routes). */
    'analytics.view': { input: { window?: AnalyticsWindow }; output: AnalyticsView }
    /** One workstream's breakdown; null when it is not known. */
    'analytics.workstream': { input: { id: string }; output: WorkstreamDetail | null }
    /** Every workspace with its live agent status. */
    'sidebar.list': { output: Snapshot }
    /** Memory, heaviest sessions, finished sessions and merged worktrees, for the opened cockpit. */
    'sidebar.cockpit': { output: CockpitStats }
    /** Ends agent sessions by pane; the worker looks up their terminals at that moment. Transcripts stay resumable. */
    /** `reason`: why nothing was closed (`closed` 0), shown in place of a success. */
    'sidebar.closeSessions': { input: { panes: string[] }; output: { closed: number; reason?: string } }
    /** Resumes a closed folder conversation (an Asleep row) by its exact provider id; `starting`: it still starts, shown. */
    'sidebar.resumeConversation': { input: { workspaceId: string; pane: string }; output: { ok: boolean; error?: string; starting?: boolean } }
    /** Removes a worktree after re-checking that it is clean and its PR merged. */
    'sidebar.removeWorktree': { input: { workspaceId: string; force?: boolean }; output: { removed: boolean; reason?: string; branch?: string; dirty?: string[] } }
    /** Creates its folder, instructions and empty membership; first click chooses/starts a provider. */
    'sidebar.createCoordinator': { input: { name: string; look: Look }; output: { ok: boolean; error?: string } }
    /** Sets a workstream's priority on its card (null clears it); Up next re-ranks. */
    'sidebar.setPriority': { input: { workspaceId: string; priority: Priority | null }; output: { ok: boolean; error?: string } }
    /** A coordinator's menu actions: a new look, a fresh session, ending its session, or deleting it. */
    'sidebar.coordinatorAction': { input: { key: string; action: 'look' | 'restart' | 'end' | 'delete' }; output: { ok: boolean; error?: string } }
    'sidebar.handover': { input: { key: string; provider: 'claude' | 'codex'; retry?: boolean }; output: { ok: boolean; error?: string } }
    'sidebar.coordinatorSessions': { input: { key: string; action: 'select' | 'associate' | 'current' | 'resume' | 'fresh'; member?: string; workspaceId?: string; paneKey?: string; orcaSession?: string; agent?: string }; output: { ok: boolean; error?: string } }
    'sidebar.coordinatorHistory': { input: { key: string; member: string; terminal?: string; orcaSession?: string | null }; output: CoordinatorHistory }
    /**
     * Wakes a coordinator (wakePlan): opens the exact live current member, resumes that same member
     * by its provider id, or starts a new member when there is no previous conversation. Never
     * delivers, and never switches to another member; an ambiguous history answers `choose`.
     * A never-started coordinator answers `provider` when a harness choice or availability retry is needed.
     */
    'sidebar.openCoordinator': { input: { key: string; provider?: string }; output: WakeOutcome }
    /**
     * Updates Orca Flow now, as the status bar item's second click does: only from available or
     * failed. An update that needs approval is never approved here; the message names the command.
     */
    'sidebar.update': { output: { started: boolean; message: string } }
    /** Shows a workspace in Orca and, given an agent's terminal, that agent's tab in it. */
    'sidebar.open': { input: { workspaceId: string; terminal?: string }; output: { opened: boolean } }
    /**
     * Re-reads which tab is in front in the focused workspace (no Orca event reports a tab switch);
     * the panel asks every few seconds while it is visible. A change is posted as sidebar.changed.
     */
    'sidebar.focus': { output: { changed: boolean } }
    /** The Linear section's data, read again when older than a minute; null when Linear is not connected. */
    'sidebar.linear': { input: { force?: boolean }; output: LinearWire | null }
    /**
     * Sends a Linear issue to the exact current live member and records that recipient;
     * moves the issue to In Progress, and assigns it to the user
     * when it has no assignee.
     */
    'sidebar.linearSend': { input: { issue: string; coordinator: string }; output: { ok: boolean; error?: string; warnings?: string[]; recipient?: DeliveryRecipient } }
    /** The Settings dialog's data. Status comes from what the writer last saw and `orca agent installed`; no test calls. */
    'sidebar.settings': { output: SettingsState }
    /** Saves the dialog's settings to ~/.orca-flow/config.json (changed keys only; unknown keys kept; a broken file is never overwritten). */
    'sidebar.saveSettings': { input: { settings: import('./settings.ts').FlowSettings }; output: { ok: boolean; error?: string; state: SettingsState } }
    /** Checks for a newer Orca Flow release now, as the 15-minute timer does; an offered update shows everywhere. */
    'sidebar.checkUpdates': { output: import('./update.ts').UpdateCheck }
    /** Shows ~/.orca-flow/config.json (or its folder, while there is no file) in Finder. */
    'sidebar.revealSettings': { output: { ok: boolean } }
    /** Sets the Linear teams a coordinator owns, in its coordinator.json. */
    'sidebar.setLinearTeams': { input: { key: string; teams: string[] }; output: { ok: boolean; error?: string } }
    /** The Token speed section's data: agent output and traffic over time, and the last internet test. */
    'sidebar.tokenSpeed': { output: import('./token-speed.ts').TokenSpeedWire }
    /** Starts `networkQuality -c` unless one is running; its result (or failure) is posted as sidebar.tokenSpeedChanged. */
    'sidebar.tokenSpeedTest': { output: { started: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted to open panels when a workspace or agent status changes. */
    'sidebar.changed': Snapshot
    /** Posted when the Linear section's data changed (a new read, a send). */
    'sidebar.linearChanged': LinearWire | null
    /** Posted after each log and network sample, and when a speed test starts or ends. */
    'sidebar.tokenSpeedChanged': import('./token-speed.ts').TokenSpeedWire
    /** Posted when a model lookup lands after the Settings dialog opened: the same state with fresh availability. */
    'sidebar.settingsChanged': SettingsState
  }
}
