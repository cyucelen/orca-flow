import { providerOf } from './providers.ts'
import type { AgentInfo, Coordinator, CoordinatorHistory, CoordinatorMember, CoordinatorSessions, DeliveryRecipient, LinearSent, WakeOutcome, WorkspaceRow } from './protocol.ts'

/** JSON tuples preserve delimiters and scope identical pane/session ids to their workspace. */
export const sessionKey = (workspaceId: string, session: string | null, pane: string) => JSON.stringify([workspaceId, session ? 'session' : 'pane', session || pane])
export const askKey = (row: WorkspaceRow, a: AgentInfo) => sessionKey(row.id, a.orcaSession, a.paneKey)

export function validSessions(value: unknown): CoordinatorSessions | undefined {
  const s = value as CoordinatorSessions | undefined
  if (!s || s.version !== 1 || !Array.isArray(s.members) || !(s.current === null || typeof s.current === 'string')) return undefined
  const valid = s.members.every((m) => m && typeof m.id === 'string' && typeof m.workspaceId === 'string' && typeof m.paneKey === 'string' && (m.orcaSession === null || typeof m.orcaSession === 'string') && (m.agentType === null || typeof m.agentType === 'string') && typeof m.title === 'string' && (m.resumeSessionId === undefined || typeof m.resumeSessionId === 'string') && (m.workspacePath === undefined || m.workspacePath === null || typeof m.workspacePath === 'string') && (m.bindings === undefined || (Array.isArray(m.bindings) && m.bindings.every((b) => b && typeof b.terminal === 'string' && typeof b.paneKey === 'string' && (b.orcaSession === null || typeof b.orcaSession === 'string')))) && Array.isArray(m.terminals) && m.terminals.every((t) => typeof t === 'string'))
  if (!valid || new Set(s.members.map((m) => m.id)).size !== s.members.length) return undefined
  return s
}

export function memberAgent(m: CoordinatorMember, rows: WorkspaceRow[]): AgentInfo | null {
  const matches = rows.filter((r) => r.id === m.workspaceId).flatMap((r) => r.agents).filter((a) =>
    m.orcaSession ? a.orcaSession === m.orcaSession && a.agentType === m.agentType : a.paneKey === m.paneKey && a.agentType === m.agentType && (!a.orcaSession))
  return matches.length === 1 ? matches[0] : null
}

export function memberFrom(row: WorkspaceRow, a: AgentInfo): CoordinatorMember {
  return { id: sessionKey(row.id, a.orcaSession, a.paneKey), workspaceId: row.id, workspacePath: row.path, bindings: a.terminal ? [{ terminal: a.terminal, paneKey: a.paneKey, orcaSession: a.orcaSession }] : [], orcaSession: a.orcaSession, agentType: a.agentType, title: a.title, paneKey: a.paneKey, terminals: a.terminal ? [a.terminal] : [], lastAgent: a }
}

/** A migration is allowed only for a single undispatched root. No ranking or first-root tie break. */
export function unambiguousSession<A extends { paneKey: string; parentPane: string | null }>(agents: A[], dispatched: (pane: string) => boolean = () => false): A | null {
  const roots = agents.filter((a) => !a.parentPane && !dispatched(a.paneKey))
  return roots.length === 1 ? roots[0] : null
}

export function reconcileSessions(s: CoordinatorSessions, rows: WorkspaceRow[]): CoordinatorSessions {
  return { ...s, members: s.members.map((m) => {
    const a = memberAgent(m, rows)
    if (!a) return m
    return { ...m, workspacePath: rows.find((r) => r.id === m.workspaceId)?.path ?? m.workspacePath, bindings: rememberBinding(m, a), paneKey: a.paneKey, title: a.title, lastAgent: a, terminals: [...new Set([...m.terminals, ...(a.terminal ? [a.terminal] : [])])] }
  }) }
}

export function associateSession(s: CoordinatorSessions, row: WorkspaceRow, a: AgentInfo): CoordinatorSessions {
  if (a.dispatch !== null || a.parentPane) throw new Error('This agent has dispatch or parent provenance. Associate an independent coordinator session instead.')
  if (!a.paneKey || !a.orcaSession) throw new Error('Orca has not exposed a stable conversation identity for this session yet. Association is unavailable until it does.')
  const member = memberFrom(row, a)
  if (s.members.some((m) => memberAgent(m, [row]) === a)) return reconcileSessions(s, [row])
  return { ...s, members: [...s.members, member] }
}

export function selectCurrent(s: CoordinatorSessions, id: string): CoordinatorSessions {
  if (!s.members.some((m) => m.id === id)) throw new Error('This session is not associated with the coordinator.')
  return { ...s, current: id }
}

export type SessionChoice = { workspaceId: string; paneKey: string; orcaSession: string; agentType: string | null; title: string; current: boolean; agent: AgentInfo }

/** Existing conversations, including unassociated roots; genuine leads never become choices. */
export function sessionChoices(c: Coordinator, rows: WorkspaceRow[]): SessionChoice[] {
  const current = c.sessions?.members.find((m) => m.id === c.sessions?.current)
  const candidates = [
    ...(c.members ?? []).flatMap((m) => m.agent ? [{ workspaceId: m.workspaceId, a: m.agent }] : []),
    ...rows.filter((r) => r.folderOf === c.key && r.id === c.workspaceId).flatMap((r) => r.agents.map((a) => ({ workspaceId: r.id, a })))
  ]
  const seen = new Set<string>()
  return candidates.flatMap(({ workspaceId, a }) => {
    const key = sessionKey(workspaceId, a.orcaSession, a.paneKey)
    if (seen.has(key) || !a.orcaSession || !a.terminal || a.live !== true || a.parentPane || a.dispatch !== null) return []
    seen.add(key)
    return [{ workspaceId, paneKey: a.paneKey, orcaSession: a.orcaSession, agentType: a.agentType, title: a.title, current: current?.workspaceId === workspaceId && current.orcaSession === a.orcaSession && current.agentType === a.agentType, agent: a }]
  })
}

/** One explicit user choice creates membership and selects it in the same persisted update. */
export function chooseSession(s: CoordinatorSessions, row: WorkspaceRow, choice: Pick<SessionChoice, 'workspaceId' | 'paneKey' | 'orcaSession' | 'agentType'>): CoordinatorSessions {
  const matches = row.agents.filter((a) => a.paneKey === choice.paneKey && a.orcaSession === choice.orcaSession && a.agentType === choice.agentType)
  const a = matches.length === 1 ? matches[0] : null
  if (row.id !== choice.workspaceId || !a?.orcaSession || !a.terminal || a.live !== true) throw new Error('That conversation is no longer available. Choose another session.')
  if (a.parentPane || a.dispatch !== null) throw new Error('That conversation belongs to a task and cannot be the main session.')
  const associated = associateSession(s, row, a)
  return selectCurrent(associated, associated.members.find((m) => memberAgent(m, [row]) === a)!.id)
}

export function currentRecipient(c: Coordinator, rows: WorkspaceRow[]): { member: CoordinatorMember; agent: AgentInfo; recipient: DeliveryRecipient } {
  const member = c.sessions?.members.find((m) => m.id === c.sessions?.current)
  if (!member) throw new Error('No main conversation is selected.')
  if (!member.orcaSession) throw new Error('The current member has no stable Orca conversation identity. No message was sent.')
  const agent = memberAgent(member, rows)
  if (!agent?.terminal || agent.live !== true) throw new Error('The selected conversation is offline. Choose an open session first.')
  return { member, agent, recipient: { member: member.id, workspaceId: member.workspaceId, orcaSession: member.orcaSession, terminal: agent.terminal, agentType: member.agentType } }
}

type Run = (args: string[], options?: { timeoutMs?: number }) => Promise<any>

function rememberBinding(m: CoordinatorMember, a: AgentInfo): NonNullable<CoordinatorMember['bindings']> {
  const bindings = m.bindings ?? []
  if (!a.terminal || bindings.some((b) => b.terminal === a.terminal && b.orcaSession === a.orcaSession && b.paneKey === a.paneKey)) return bindings
  return [...bindings, { terminal: a.terminal, paneKey: a.paneKey, orcaSession: a.orcaSession }]
}

/** terminal.show lacks conversation identity; a fresh complete ps inventory supplies it. */
export async function verifyConversation(member: CoordinatorMember, run: Run): Promise<void> {
  if (!member.workspacePath || !member.orcaSession) throw new Error('No stable workspace/conversation binding is available.')
  const inventory = await run(['worktree', 'ps', '--limit', '10000'])
  if (inventory?.truncated || !Array.isArray(inventory?.worktrees)) throw new Error('The live conversation inventory is incomplete.')
  const workspaces = inventory.worktrees.filter((w: any) => w.path === member.workspacePath)
  if (workspaces.length !== 1) throw new Error('The exact conversation workspace is unavailable or ambiguous.')
  const agents = (workspaces[0].agents ?? []).filter((a: any) => a.paneKey === member.paneKey)
  const a = agents.length === 1 ? agents[0] : null
  if (!a || a.orcaSessionId !== member.orcaSession || a.agentType !== member.agentType || !(a.hasLivePty === true || a.structuredHostOwned === true)) throw new Error('This terminal no longer has a verified binding to the recorded conversation.')
}

/** Reading history never switches or resumes a chat; unverifiable archives remain unavailable. */
export async function readMemberHistory(member: CoordinatorMember, run: Run): Promise<CoordinatorHistory> {
  const terminal = member.terminals.at(-1)
  if (!terminal) return { title: member.title, text: '', unavailable: 'No exact terminal history route was recorded for this session. Orca exposes history metadata but no saved transcript read API.' }
  try {
    const shown = await run(['terminal', 'show', '--terminal', terminal])
    const t = shown?.terminal
    if (t?.handle !== terminal || `${t.tabId}:${t.leafId}` !== member.paneKey || !member.workspacePath || t.worktreePath !== member.workspacePath) throw new Error('The recorded terminal binding is unavailable.')
    await verifyConversation(member, run)
    const result = await run(['terminal', 'read', '--terminal', terminal, '--limit', '500'])
    const read = result?.terminal
    if (read?.handle !== terminal || !Array.isArray(read.tail) || !read.tail.every((line: unknown) => typeof line === 'string')) throw new Error('Orca did not return readable output for the exact historical terminal.')
    // Discard text if the pane changed conversations while it was being read.
    await verifyConversation(member, run)
    const text = read.tail.join('\n')
    return { title: member.title, text: text.slice(-60_000), truncated: Boolean(read.truncated || read.limited || text.length > 60_000) }
  } catch {
    return { title: member.title, text: '', unavailable: 'The recorded conversation identity cannot be verified for this terminal. Orca exposes no saved transcript read API for an unavailable archive; the conversation stays preserved and nothing was opened or resumed.' }
  }
}

export class DeliveryUncertainError extends Error {
  readonly recipient: DeliveryRecipient
  constructor(recipient: DeliveryRecipient, detail: string) {
    super(`Delivery is unconfirmed: ${detail}. Inspect the exact recipient before taking further action; do not send again blindly.`)
    this.recipient = recipient
  }
}

/** Accept only the documented durable CLI receipt for this exact terminal and an observed turn. */
export function deliveryReceipt(result: any, recipient: DeliveryRecipient): DeliveryRecipient {
  const sent = result?.send
  const prompt = sent?.prompt
  const receipt: NonNullable<DeliveryRecipient['receipt']> = {
    ...(typeof sent?.accepted === 'boolean' ? { accepted: sent.accepted } : {}),
    ...(typeof prompt?.requestId === 'string' ? { requestId: prompt.requestId } : {}),
    ...(Array.isArray(prompt?.stages) && prompt.stages.every((s: unknown) => typeof s === 'string') ? { stages: prompt.stages } : {}),
    ...(typeof prompt?.provider === 'string' ? { provider: prompt.provider } : {}),
    ...(typeof prompt?.observation === 'string' ? { observation: prompt.observation } : {}),
    ...(typeof prompt?.processIncarnation === 'string' ? { processIncarnation: prompt.processIncarnation } : {})
  }
  const recorded = { ...recipient, receipt }
  if (sent?.accepted === false) throw new Error('Orca refused delivery to the current session.')
  const sameProvider = recipient.agentType && (receipt.provider === recipient.agentType || (providerOf(recipient.agentType) !== null && providerOf(receipt.provider ?? null) === providerOf(recipient.agentType)))
  if (!sameProvider || sent?.accepted !== true || sent?.handle !== recipient.terminal || !receipt.requestId || !receipt.stages?.includes('turn_started') || ['permission', 'incarnation_replaced', 'unsupported'].includes(receipt.observation ?? '')) throw new DeliveryUncertainError(recorded, 'Orca did not confirm a turn for this exact recipient')
  return recorded
}

/** Revalidate conversation identity at send time; never replace an unavailable recipient. */
export async function deliverCurrent(c: Coordinator, rows: WorkspaceRow[], message: string, run: Run, stillCurrent: () => boolean = () => true): Promise<DeliveryRecipient> {
  const { member, agent, recipient } = currentRecipient(c, rows)
  const shown = await run(['terminal', 'show', '--terminal', recipient.terminal])
  const t = shown?.terminal
  if (t?.handle !== recipient.terminal || `${t.tabId}:${t.leafId}` !== agent.paneKey || t.writable !== true) throw new Error('The exact current terminal is unavailable or changed. Nothing was sent.')
  const workspace = rows.find((r) => r.id === recipient.workspaceId)
  if (!workspace?.path || t.worktreePath !== workspace.path) throw new Error('The exact terminal workspace could not be verified. Nothing was sent.')
  await verifyConversation({ ...member, paneKey: agent.paneKey, workspacePath: workspace.path }, run)
  if (!stillCurrent()) throw new Error('The current recipient changed while delivery was being checked. Nothing was sent; review the recipient and send again.')
  let result: any
  try { result = await run(['terminal', 'send', '--terminal', recipient.terminal, '--text', message, '--enter', '--wait-submit', '5'], { timeoutMs: 20_000 }) }
  catch (e) {
    const error = e as Error & { data?: { orchestrationRequestId?: string } }
    const requestId = error.data?.orchestrationRequestId
    throw new DeliveryUncertainError(typeof requestId === 'string' ? { ...recipient, receipt: { requestId } } : recipient, error.message)
  }
  return deliveryReceipt(result, recipient)
}

/**
 * What became of the terminal a resume returned. `bound`: an agent of that exact terminal's pane
 * reports a conversation (`resumeSessionId` is the provider id read again from it: Claude may fork a
 * new one). `exited`: the terminal is gone or nothing but its shell runs in it any more; `detail` is
 * what the provider printed. `running`: its program still runs but no conversation is bound yet.
 */
export type ResumeBinding =
  | { status: 'bound'; workspaceId: string; agent: AgentInfo; resumeSessionId?: string }
  | { status: 'exited'; detail: string | null; terminal?: string }
  | { status: 'running'; terminal: string }

export type ResumeIo = {
  /** agent.resume. `started: false`: Orca handed back a terminal it says already runs that session. */
  resume: (input: { workspaceId: string; agent: string; sessionId: string }) => Promise<{ terminalId: string; started?: boolean }>
  binding: (terminalId: string, sessionId: string) => Promise<ResumeBinding>
  /**
   * Whether the provider saved the conversation `sessionId`: false only when it provably did not
   * (no transcript anywhere Orca keeps them), null when it cannot be checked. Optional preflight.
   */
  saved?: (agent: string, sessionId: string, workspaceId: string) => Promise<boolean | null>
}

/** The provider refused the resume or exited: nothing runs. `missing`: it has no such conversation, so Retry would fail the same way. */
export class ResumeRefusedError extends Error {
  readonly missing: boolean
  readonly terminal?: string
  constructor(message: string, missing: boolean, terminal?: string) {
    super(message)
    this.missing = missing
    if (terminal) this.terminal = terminal
  }
}

/** The resumed program still runs, unbound: it is remembered and adopted by the next click, never resumed again. */
export class ResumeRunningError extends Error {
  readonly launch: Launch
  constructor(launch: Launch) {
    super('The conversation is still resuming in its terminal, which is shown. Click the coordinator again once it is ready; that adopts this same terminal and resumes nothing again.')
    this.launch = launch
  }
}

/** A resume bound to an agent that is not this member's (another provider or workspace in that pane). */
export class ResumeUnverifiedError extends Error {}

/** Provider text that says the conversation does not exist (Claude: "No conversation found with session ID: …"). */
export function conversationMissing(text: string | null | undefined): boolean {
  return !!text && /no (conversation|session)s? (was |were )?found|no such (conversation|session)|unknown (conversation|session)|could ?n[o']t find (the |a |any )?(conversation|session)|(conversation|session)\b[^\n]{0,80}\b(not found|does ?n[o']t exist|no longer exists)/i.test(text)
}

/**
 * What the provider printed after the resume command, from a terminal's rendered lines: the lines
 * after the command line naming `sessionId`, without the shell prompt that follows (prompt lines
 * repeat, extend or start lines drawn before the command). Null when the command is not on screen.
 */
export function providerMessage(lines: string[], sessionId: string): string | null {
  const said = (l: string) => l.includes(sessionId) && !conversationMissing(l) && !/error/i.test(l)
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) if (said(lines[i])) { at = i; break }
  if (at < 0) return null
  const before = lines.slice(0, at + 1).map((l) => l.trim()).filter(Boolean)
  const after = lines.slice(at + 1).map((l) => l.trim()).filter(Boolean)
  // A prompt drawn again may add a segment (`… took 2.2s`) or show only its start (`λ`).
  const prompt = (l: string) => before.some((b) => b.startsWith(l) || l.startsWith(b))
  while (after.length && prompt(after[after.length - 1])) after.pop()
  const text = after.slice(0, 4).join(' ').slice(0, 400)
  return text || null
}

/** A shell or login process: what an idle terminal runs, never an agent. */
const SHELL = /^(login|zsh|bash|sh|dash|fish|tcsh|csh|ksh|mksh|nu|pwsh|xonsh|elvish)$/

/**
 * Whether a program other than its shell still runs in a terminal whose root process is `root`
 * (`ps -A -o pid=,ppid=,comm=`): null when the root is not running. The agent CLI a resume starts is
 * the shell's child; an idle shell has only shell children (prompt helpers).
 */
export function programRuns(root: number, procs: { pid: number; ppid: number; name: string }[]): boolean | null {
  if (!procs.some((p) => p.pid === root)) return null
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const child of procs) {
      if (child.ppid !== pid) continue
      const base = (child.name.trim().split('/').pop() ?? '').replace(/^-/, '')
      if (!SHELL.test(base)) return true
      stack.push(child.pid)
    }
  }
  return false
}

/** `ps -A -o pid=,ppid=,comm=` lines. */
export function parseProcs(out: string): { pid: number; ppid: number; name: string }[] {
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] }] : []
  })
}

/**
 * Whether the provider saved conversation `id` in any of its `homes` (config dirs Orca runs it with):
 * Claude keeps <home>/projects/<project>/<id>.jsonl, Codex <home>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl
 * (or archived_sessions). False only when at least one home was readable and none has it; null for
 * other providers, an unsafe id or no readable home. `list` returns a folder's names, null if unreadable.
 */
export function conversationSaved(agent: string, id: string, homes: string[], list: (dir: string) => string[] | null): boolean | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null
  const provider = providerOf(agent)
  let readable = false
  for (const home of new Set(homes)) {
    if (provider === 'claude') {
      const projects = list(`${home}/projects`)
      if (!projects) continue
      readable = true
      if (projects.some((p) => list(`${home}/projects/${p}`)?.includes(`${id}.jsonl`))) return true
    } else if (provider === 'codex') {
      const named = (names: string[] | null) => names?.some((f) => f.startsWith('rollout-') && f.endsWith(`-${id}.jsonl`)) ?? false
      const sessions = list(`${home}/sessions`)
      const archived = list(`${home}/archived_sessions`)
      if (!sessions && !archived) continue
      readable = true
      if (named(archived)) return true
      for (const y of sessions ?? []) for (const m of list(`${home}/sessions/${y}`) ?? []) for (const d of list(`${home}/sessions/${y}/${m}`) ?? []) {
        if (named(list(`${home}/sessions/${y}/${m}/${d}`))) return true
      }
    } else return null
  }
  return readable ? false : null
}

const providerName = (agent: string | null) => {
  const p = providerOf(agent)
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : agent ?? 'The agent'
}

/** The member's resume id was refused before as having no saved conversation. */
export const resumeRefused = (m: CoordinatorMember) => !!m.resumeSessionId && m.resumeRefused?.sessionId === m.resumeSessionId

/** The member, marked as refused for its resume id with the provider's reason. */
export function markRefused(s: CoordinatorSessions, id: string, reason: string): CoordinatorSessions {
  return { ...s, members: s.members.map((m) => m.id === id && m.resumeSessionId ? { ...m, resumeRefused: { sessionId: m.resumeSessionId, reason } } : m) }
}

/**
 * Resume is an explicit current-member action. Provider ids and Orca ids stay distinct. `adopt`: a
 * resume of this member still running from an earlier click, bound now instead of resuming again.
 */
export async function resumeExactMember(s: CoordinatorSessions, id: string, io: ResumeIo, adopt?: Launch): Promise<CoordinatorSessions> {
  const m = s.members.find((m) => m.id === id)
  if (!m || s.current !== id) throw new Error('Only the explicitly current member can be resumed. History stays read-only.')
  if (!m.resumeSessionId || !m.agentType) throw new Error('No verified provider resume id was recorded. Orca conversation ids cannot be used as resume ids; nothing was launched.')
  const name = providerName(m.agentType)
  if (resumeRefused(m)) throw new ResumeRefusedError(m.resumeRefused!.reason, true)
  let terminalId: string
  let started: boolean | undefined
  if (adopt?.member === id && adopt.sessionId === m.resumeSessionId && adopt.workspaceId === m.workspaceId) terminalId = adopt.terminalId
  else {
    const saved = io.saved ? await io.saved(m.agentType, m.resumeSessionId, m.workspaceId).catch(() => null) : null
    if (saved === false) throw new ResumeRefusedError(`${name} saved no conversation ${m.resumeSessionId}: the previous session ended before its first message, so there is nothing to resume. Nothing was launched; start a new conversation.`, true)
    ;({ terminalId, started } = await io.resume({ workspaceId: m.workspaceId, agent: m.agentType, sessionId: m.resumeSessionId }))
  }
  const b = await io.binding(terminalId, m.resumeSessionId)
  if (b.status === 'exited') {
    const missing = conversationMissing(b.detail)
    const reused = started === false ? ' Orca handed back the terminal of an earlier attempt, where it had already exited; nothing new was launched.' : ''
    const said = b.detail ? `${name} said: “${b.detail}”` : `${name} exited before the conversation resumed.`
    throw new ResumeRefusedError(`${said}${reused}${missing ? ' That conversation cannot be resumed; start a new one.' : ''}`, missing, b.terminal)
  }
  if (b.status === 'running') throw new ResumeRunningError({ workspaceId: m.workspaceId, terminalId, agent: m.agentType, member: id, sessionId: m.resumeSessionId })
  if (b.workspaceId !== m.workspaceId || b.agent.agentType !== m.agentType || !b.agent.terminal || !b.agent.orcaSession) throw new ResumeUnverifiedError(`The resumed terminal now runs ${b.agent.agentType ?? 'another agent'} in another conversation, not this member's ${name} one. No fallback was selected; inspect it before retrying.`)
  if (m.agentType === 'antigravity' && (!b.agent.live || b.resumeSessionId !== m.resumeSessionId)) throw new ResumeUnverifiedError('Orca could not confirm the original Antigravity conversation in the resumed terminal. Check its sign-in and conversation before selecting it.')
  const a = b.agent
  const fresh = b.resumeSessionId && b.resumeSessionId !== a.orcaSession ? b.resumeSessionId : m.resumeSessionId
  return { ...s, members: s.members.map((member) => {
    if (member.id !== id) return member
    const { resumeRefused: _, ...rest } = member
    return { ...rest, resumeSessionId: fresh, bindings: rememberBinding(member, a), orcaSession: a.orcaSession, paneKey: a.paneKey, terminals: [...new Set([...member.terminals, a.terminal!])], lastAgent: a }
  }) }
}

/** Unknown attempts survive restart and cannot be retried by the ordinary Send action. */
export function deliveryBlock(previous: LinearSent | undefined): string | null {
  return previous?.delivery === 'unknown' ? `A prior delivery to the recorded recipient is unconfirmed${previous.recipient?.receipt?.requestId ? ` (request ${previous.recipient.receipt.requestId})` : ''}. Inspect its source; this action will not resend it.` : null
}

/**
 * What clicking a coordinator does. Opening is not delivery: an absent or closed main conversation
 * is a sleeping coordinator, not an error. It opens the exact live current member, resumes that same
 * member by its provider id, or starts a new member only when there is nothing to continue. Anything
 * it cannot tie to one conversation is left to an explicit choice; it never picks another member.
 * `liveChoices` is how many open conversations the Sessions picker offers (sessionChoices).
 */
export type WakePlan =
  | { kind: 'open'; member: CoordinatorMember; workspaceId: string; terminal: string }
  | { kind: 'resume'; member: CoordinatorMember; adopt?: Launch }
  | { kind: 'fresh'; agent: string | null }
  | { kind: 'adopt'; agent: string | null }
  | { kind: 'choose'; reason: string }

/**
 * `launching`: a conversation this coordinator launched (or the Launch itself) is still unbound; it is
 * adopted, never launched again. A pending resume of the current member is bound, never resumed again.
 */
export function wakePlan(c: Pick<Coordinator, 'sessions'>, rows: WorkspaceRow[], liveChoices: number, launching: boolean | Launch = false): WakePlan {
  const s = c.sessions
  const current = s?.members.find((m) => m.id === s.current)
  const live = current ? memberAgent(current, rows) : null
  if (current && live?.terminal && live.live === true) return { kind: 'open', member: current, workspaceId: current.workspaceId, terminal: live.terminal }
  if (typeof launching === 'object' && launching.member) {
    if (current?.id === launching.member && current.resumeSessionId === launching.sessionId) return { kind: 'resume', member: current, adopt: launching }
  } else if (launching) return { kind: 'adopt', agent: typeof launching === 'object' ? launching.agent : current?.agentType ?? null }
  if (current) {
    if (current.resumeSessionId && current.agentType) return { kind: 'resume', member: current }
    if (!live && memberMatches(current, rows) > 1) return { kind: 'choose', reason: 'The main conversation matches more than one session. Choose one in Sessions or start a new conversation.' }
    if (liveChoices > 0) return { kind: 'choose', reason: 'The main conversation is closed and cannot be resumed. Choose an open conversation or start a new one.' }
    return { kind: 'fresh', agent: current.agentType }
  }
  if (s?.members.length) return { kind: 'choose', reason: 'No main conversation is selected among its previous ones. Choose one in Sessions or start a new conversation.' }
  if (liveChoices > 0) return { kind: 'choose', reason: 'Its open conversations are not associated yet. Choose one in Sessions or start a new conversation.' }
  return { kind: 'fresh', agent: null }
}

function memberMatches(m: CoordinatorMember, rows: WorkspaceRow[]): number {
  return rows.filter((r) => r.id === m.workspaceId).flatMap((r) => r.agents).filter((a) =>
    m.orcaSession ? a.orcaSession === m.orcaSession && a.agentType === m.agentType : a.paneKey === m.paneKey && a.agentType === m.agentType && !a.orcaSession).length
}

export type WakeIo = ResumeIo & {
  /** Shows the exact terminal; false when it could not. */
  open: (workspaceId: string, terminal: string) => Promise<boolean>
  /** Compare-and-swap write of the coordinator's sessions against the ones the plan was made from. */
  save: (next: CoordinatorSessions) => void
  /**
   * Starts a new explicitly associated member, or adopts the one still binding (freshSession).
   * `bound: false`: it runs and is shown, but its binding is not verified yet; a later click adopts it.
   */
  fresh: (agent: string) => Promise<{ ok: boolean; error?: string; bound?: boolean }>
  /** Remembers a resume still running unbound (adopted by the next click), or forgets it (null). */
  pend?: (launch: Launch | null) => void
}

/** Orca's panel bridge refuses a result holding an undefined property: an absent agent is an absent key. */
const agentOf = (agent: string | null | undefined): { agent?: string } => agent ? { agent } : {}

/** Carries out a wake plan. Only a failed start or a failed open is a failure; a refused resume is a restore that failed. */
export async function wakeCoordinator(c: Pick<Coordinator, 'sessions'>, rows: WorkspaceRow[], liveChoices: number, io: WakeIo, launching: boolean | Launch = false): Promise<WakeOutcome> {
  const plan = wakePlan(c, rows, liveChoices, launching)
  if (plan.kind === 'open') return await io.open(plan.workspaceId, plan.terminal) ? { ok: true, kind: 'opened' } : { ok: false, kind: 'failed', retryable: true, error: 'The exact session could not be opened.' }
  if (plan.kind === 'choose') return { ok: false, kind: 'choose', error: plan.reason, ...agentOf(c.sessions?.members.find((m) => m.id === c.sessions?.current)?.agentType) }
  if (plan.kind === 'fresh' || plan.kind === 'adopt') {
    const started = await io.fresh(plan.agent || 'claude')
    if (!started.ok) return { ok: false, kind: 'failed', retryable: true, error: started.error ?? 'The new conversation could not be started.' }
    return started.bound === false ? { ok: true, kind: 'starting', ...(started.error ? { error: started.error } : {}) } : { ok: true, kind: 'started' }
  }
  const workspaceId = plan.member.workspaceId
  let next: CoordinatorSessions
  try { next = await resumeExactMember(c.sessions!, plan.member.id, io, plan.adopt) }
  catch (e) {
    if (e instanceof ResumeRunningError) {
      io.pend?.(e.launch)
      return { ok: true, kind: 'starting', error: e.message }
    }
    if (plan.adopt) io.pend?.(null)
    if (e instanceof ResumeRefusedError) {
      // Remember a conversation the provider says does not exist, so no later click launches it again.
      if (e.missing && !resumeRefused(plan.member)) try { io.save(markRefused(c.sessions!, plan.member.id, e.message)) } catch {}
      return { ok: false, kind: 'restore-failed', retryable: !e.missing, ...agentOf(plan.member.agentType), error: e.message, ...(e.terminal ? { workspaceId, terminal: e.terminal } : {}) }
    }
    if (e instanceof ResumeUnverifiedError) return { ok: false, kind: 'failed', ...agentOf(plan.member.agentType), error: e.message }
    // agent.resume itself failed: nothing was bound and nothing was written; it may be transient.
    return { ok: false, kind: 'restore-failed', retryable: true, ...agentOf(plan.member.agentType), error: `The previous conversation could not be restored: ${(e as Error).message}` }
  }
  io.pend?.(null)
  const terminal = next.members.find((m) => m.id === plan.member.id)?.lastAgent?.terminal
  try { io.save(next) }
  catch (e) { return { ok: false, kind: 'failed', ...(terminal ? { workspaceId, terminal } : {}), error: `The conversation resumed, but its new binding could not be saved (${(e as Error).message}). Check Sessions; do not resume it again.` } }
  return terminal && await io.open(workspaceId, terminal) ? { ok: true, kind: 'resumed' } : { ok: false, kind: 'failed', ...(terminal ? { workspaceId, terminal } : {}), error: 'The conversation resumed, but its terminal could not be shown.' }
}

/** One start, resume or session change per coordinator at a time; a second click while one runs launches nothing. */
export async function exclusive<T>(busy: Set<string>, key: string, run: () => Promise<T>, whenBusy: () => T): Promise<T> {
  if (busy.has(key)) return whenBusy()
  busy.add(key)
  try { return await run() }
  finally { busy.delete(key) }
}

/** A terminal as `orca terminal list` reports it. */
export type TerminalRecord = { handle: string; ptyId?: string; tabId?: string; leafId?: string; recordedPaneKey?: string; worktreePath?: string }

/**
 * The pane a terminal runs in (the agents' paneKey): its tab and leaf, or for a terminal started in
 * the background (agent.launch, agent.resume), which has no tab yet and only `pty:` placeholders,
 * the pane Orca recorded for it.
 */
export function terminalPane(t: Partial<TerminalRecord> | null | undefined): string | null {
  if (!t) return null
  if (t.tabId && t.leafId && !t.tabId.startsWith('pty:')) return `${t.tabId}:${t.leafId}`
  return t.recordedPaneKey || null
}

/** The exact terminal a launch or resume returned, by its host id or handle. */
export const launchedTerminal = (terminals: TerminalRecord[], terminalId: string) => terminals.find((t) => t.ptyId === terminalId || t.handle === terminalId) ?? null

/**
 * The agent the exact launched terminal runs, once Orca lists it with a conversation id: matched by
 * that terminal's own pane in the coordinator's workspace, never the newest or only agent there.
 */
export function launchedAgent(launch: Launch, terminals: TerminalRecord[], row: WorkspaceRow | undefined): AgentInfo | null {
  const t = launchedTerminal(terminals, launch.terminalId)
  const pane = terminalPane(t)
  if (!t || !pane || row?.id !== launch.workspaceId) return null
  const matches = row.agents.filter((a) => a.paneKey === pane)
  const a = matches.length === 1 ? matches[0] : null
  return a?.orcaSession && a.agentType === launch.agent && !a.parentPane && a.dispatch === null ? { ...a, terminal: t.handle } : null
}

/** Records the launched agent as a member (or finds it already recorded) and makes it current. */
export function bindLaunched(s: CoordinatorSessions, row: WorkspaceRow, a: AgentInfo, resumeSessionId?: string): CoordinatorSessions {
  const id = sessionKey(row.id, a.orcaSession, a.paneKey)
  const rowWith = { ...row, agents: row.agents.map((x) => x.paneKey === a.paneKey ? a : x) }
  const next = s.members.some((m) => m.id === id) ? reconcileSessions(s, [rowWith]) : associateSession(s, rowWith, a)
  return selectCurrent({ ...next, members: next.members.map((m) => m.id === id && resumeSessionId && !m.resumeSessionId ? { ...m, resumeSessionId } : m) }, id)
}

/**
 * A coordinator's launched conversation whose binding is not verified yet. A resume of a member
 * carries that `member` and the provider `sessionId` it resumed.
 */
export type Launch = { workspaceId: string; terminalId: string; agent: string; member?: string; sessionId?: string }

/** Forgets a pending launch once its terminal is gone or it is already a member: then it is settled. */
export function settlePending(pending: Map<string, Launch>, key: string, terminals: TerminalRecord[], sessions: CoordinatorSessions | undefined): void {
  const known = pending.get(key)
  if (!known) return
  const t = launchedTerminal(terminals, known.terminalId)
  if (!t || sessions?.members.some((m) => m.terminals.includes(t.handle))) pending.delete(key)
}

/**
 * Launches once per coordinator: while a launch is unbound, a second start adopts it and launches
 * nothing. A pending resume is not a new conversation: Start new launches one.
 */
export async function launchOnce(pending: Map<string, Launch>, key: string, workspaceId: string, agent: string, launch: () => Promise<{ terminalId: string }>): Promise<{ launch: Launch; adopted: boolean }> {
  const known = pending.get(key)
  if (known?.workspaceId === workspaceId && !known.member) {
    if (known.agent !== agent) throw new Error('A different provider already has a pending launch. Inspect that terminal before starting another coordinator conversation.')
    return { launch: known, adopted: true }
  }
  const { terminalId } = await launch()
  const next = { workspaceId, terminalId, agent }
  pending.set(key, next)
  return { launch: next, adopted: false }
}

/** One agent as the host's agents.list reports it: `sessionId` is the provider's resume id. */
export type ListedAgent = { terminalId: string | null; agent: string | null; sessionId?: string | null }

/**
 * The provider resume id of the exact live terminal a member is bound to: that terminal must still
 * run the member's pane, and exactly one listed agent of the member's provider must name it. Never
 * another terminal's id, never a guess, and never Orca's own conversation id (they stay distinct).
 */
export function resumeIdFor(member: CoordinatorMember, terminal: string | null | undefined, terminals: TerminalRecord[], listed: ListedAgent[]): string | undefined {
  const t = terminal ? terminals.find((t) => t.handle === terminal) : undefined
  if (!t || terminalPane(t) !== member.paneKey || !member.agentType) return undefined
  const ids = new Set([t.handle, t.ptyId].filter(Boolean))
  const matches = listed.filter((a) => a.terminalId && ids.has(a.terminalId) && a.agent === member.agentType && a.sessionId)
  const id = matches.length === 1 ? matches[0].sessionId! : undefined
  return id && id !== member.orcaSession ? id : undefined
}

/**
 * Records a member's resume id while it is still bound to the terminal it was read from. A missing
 * one is filled; an existing one changes only when `replace` (the member was just bound or resumed).
 */
export function withResumeId(s: CoordinatorSessions | undefined, member: string, terminal: string, id: string, replace = false): CoordinatorSessions | undefined {
  const m = s?.members.find((x) => x.id === member)
  if (!s || !m || !m.terminals.includes(terminal) || m.resumeSessionId === id || (m.resumeSessionId && !replace)) return s
  return { ...s, members: s.members.map((x) => x.id === member ? { ...x, resumeSessionId: id } : x) }
}
