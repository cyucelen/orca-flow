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

export type ResumeIo = {
  resume: (input: { workspaceId: string; agent: string; sessionId: string }) => Promise<{ terminalId: string }>
  binding: (terminalId: string) => Promise<{ workspaceId: string; agent: AgentInfo } | null>
}

/** A resume was launched but its new terminal could not be tied to the member: never launch again blindly. */
export class ResumeUnverifiedError extends Error {}

/** Resume is an explicit current-member action. Provider ids and Orca ids stay distinct. */
export async function resumeExactMember(s: CoordinatorSessions, id: string, io: ResumeIo): Promise<CoordinatorSessions> {
  const m = s.members.find((m) => m.id === id)
  if (!m || s.current !== id) throw new Error('Only the explicitly current member can be resumed. History stays read-only.')
  if (!m.resumeSessionId || !m.agentType) throw new Error('No verified provider resume id was recorded. Orca conversation ids cannot be used as resume ids; nothing was launched.')
  const result = await io.resume({ workspaceId: m.workspaceId, agent: m.agentType, sessionId: m.resumeSessionId })
  const bound = await io.binding(result.terminalId)
  if (!bound || bound.workspaceId !== m.workspaceId || bound.agent.agentType !== m.agentType || !bound.agent.terminal || !bound.agent.orcaSession) throw new ResumeUnverifiedError('Exact resume started, but its new binding could not be verified. No fallback was selected; inspect Sessions before retrying.')
  const a = bound.agent
  return { ...s, members: s.members.map((member) => member.id !== id ? member : { ...member, bindings: rememberBinding(member, a), orcaSession: a.orcaSession, paneKey: a.paneKey, terminals: [...new Set([...member.terminals, a.terminal!])], lastAgent: a }) }
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
  | { kind: 'resume'; member: CoordinatorMember }
  | { kind: 'fresh'; agent: string | null }
  | { kind: 'choose'; reason: string }

export function wakePlan(c: Pick<Coordinator, 'sessions'>, rows: WorkspaceRow[], liveChoices: number): WakePlan {
  const s = c.sessions
  const current = s?.members.find((m) => m.id === s.current)
  if (current) {
    const a = memberAgent(current, rows)
    if (a?.terminal && a.live === true) return { kind: 'open', member: current, workspaceId: current.workspaceId, terminal: a.terminal }
    if (current.resumeSessionId && current.agentType) return { kind: 'resume', member: current }
    if (!a && memberMatches(current, rows) > 1) return { kind: 'choose', reason: 'The main conversation matches more than one session. Choose one in Sessions or start a new conversation.' }
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
  /** Starts a new explicitly associated member (freshSession). */
  fresh: (agent: string) => Promise<{ ok: boolean; error?: string }>
}

/** Carries out a wake plan. Only a failed start, a failed open or an unverifiable resume is a failure. */
export async function wakeCoordinator(c: Pick<Coordinator, 'sessions'>, rows: WorkspaceRow[], liveChoices: number, io: WakeIo): Promise<WakeOutcome> {
  const plan = wakePlan(c, rows, liveChoices)
  if (plan.kind === 'open') return await io.open(plan.workspaceId, plan.terminal) ? { ok: true, kind: 'opened' } : { ok: false, kind: 'failed', error: 'The exact session could not be opened.' }
  if (plan.kind === 'choose') return { ok: false, kind: 'choose', error: plan.reason, agent: c.sessions?.members.find((m) => m.id === c.sessions?.current)?.agentType ?? undefined }
  if (plan.kind === 'fresh') {
    const started = await io.fresh(plan.agent || 'claude')
    return started.ok ? { ok: true, kind: 'started' } : { ok: false, kind: 'failed', error: started.error ?? 'The new conversation could not be started.' }
  }
  const agent = plan.member.agentType ?? undefined
  let next: CoordinatorSessions
  try { next = await resumeExactMember(c.sessions!, plan.member.id, io) }
  catch (e) {
    if (e instanceof ResumeUnverifiedError) return { ok: false, kind: 'failed', error: e.message }
    // Nothing was bound and nothing was written: the member and its history stay as they were.
    return { ok: false, kind: 'restore-failed', retryable: true, agent, error: `The previous conversation could not be restored: ${(e as Error).message}` }
  }
  try { io.save(next) }
  catch (e) { return { ok: false, kind: 'failed', error: `The conversation resumed, but its new binding could not be saved (${(e as Error).message}). Check Sessions; do not resume it again.` } }
  const terminal = next.members.find((m) => m.id === plan.member.id)?.lastAgent?.terminal
  return terminal && await io.open(plan.member.workspaceId, terminal) ? { ok: true, kind: 'resumed' } : { ok: false, kind: 'failed', error: 'The conversation resumed, but its terminal could not be shown.' }
}

/** One start, resume or session change per coordinator at a time; a second click while one runs launches nothing. */
export async function exclusive<T>(busy: Set<string>, key: string, run: () => Promise<T>, whenBusy: () => T): Promise<T> {
  if (busy.has(key)) return whenBusy()
  busy.add(key)
  try { return await run() }
  finally { busy.delete(key) }
}
