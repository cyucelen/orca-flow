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
  /** The Linear issue Orca linked to the worktree (`--linear-issue`), as its identifier (BOU-4179). */
  linearIssue?: string | null
  /** Where its Linear label opens, when the Linear data knows (see issueLink); null or absent: plain text. */
  linearLink?: { url: string; title: string | null } | null
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
export type WakeOutcome = { ok: boolean; kind: 'opened' | 'resumed' | 'started' | 'starting' | 'choose' | 'restore-failed' | 'busy' | 'failed'; error?: string; retryable?: boolean; agent?: string; workspaceId?: string; terminal?: string }
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

declare module 'orca' {
  interface PluginRequests {
    /** Every workspace with its live agent status. */
    'sidebar.list': { output: Snapshot }
    /** Memory, heaviest sessions, finished sessions and merged worktrees, for the opened cockpit. */
    'sidebar.cockpit': { output: CockpitStats }
    /** Ends agent sessions by pane; the worker looks up their terminals at that moment. Transcripts stay resumable. */
    'sidebar.closeSessions': { input: { panes: string[] }; output: { closed: number } }
    /** Removes a worktree after re-checking that it is clean and its PR merged. */
    'sidebar.removeWorktree': { input: { workspaceId: string; force?: boolean }; output: { removed: boolean; reason?: string; dirty?: string[] } }
    /** Creates a coordinator with a name and a look, starts its session and opens it. */
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
     */
    'sidebar.openCoordinator': { input: { key: string }; output: WakeOutcome }
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
    /** Sets the Linear teams a coordinator owns, in its coordinator.json. */
    'sidebar.setLinearTeams': { input: { key: string; teams: string[] }; output: { ok: boolean; error?: string } }
  }
  interface PluginPanelEvents {
    /** Posted to open panels when a workspace or agent status changes. */
    'sidebar.changed': Snapshot
    /** Posted when the Linear section's data changed (a new read, a send). */
    'sidebar.linearChanged': LinearWire | null
  }
}
