// Restart, resume and power-loss reconciliation. Orca keeps an agent row for a pane from before a
// restart or resume (no live PTY, Orca's "listed, clearable" activity) beside the pane the same
// conversation runs in now: two rows, one Orca conversation. These fixtures mimic `orca worktree ps`
// for the shapes seen on a real machine after a reboot.
import { assert, test } from 'orca/testing'
import { associateSession, chooseSession, conversationRows, memberAgent, memberFrom, memberRows, reconcileSessions, sessionChoices, wakeCoordinator, wakePlan, type WakeIo } from './coordinator-sessions.ts'
import { assignCoordinators, coordinatorSession } from './coordinators.ts'
import { foldCoordinatorFolders, fromPs, type PsAgent } from './worker.ts'
import type { Coordinator, CoordinatorSessions } from './protocol.ts'

const DIR = '/fixture/orca-flow'
const WS = 'ws::/fixture/orca-flow'
const SESSION = '6595cd51-313b-44c8-81f7-735fcec424ef'

/** `ps` rows for the coordinator folder; `terminals` maps live panes to their current terminal handle. */
function rowsOf(agents: PsAgent[], terminals: Record<string, string>, liveTerminalCount = Object.keys(terminals).length) {
  const rows = fromPs([{ worktreeId: WS, path: DIR, displayName: 'orca-flow', repo: 'orca-flow', liveTerminalCount, agents }], { cards: {}, summaries: {} }, new Map([[DIR, WS]]))
  for (const a of rows[0].agents) a.terminal = terminals[a.paneKey] ?? null
  return rows
}

const stale: PsAgent = { paneKey: 'old-tab:old-leaf', orcaSessionId: SESSION, agentType: 'codex', state: 'done', conversationName: 'Resume status message clipping' }
const resumed: PsAgent = { ...stale, paneKey: 'new-tab:new-leaf', state: 'working', hasLivePty: true }

/** The member as coordinator.json had it before the restart: bound to both panes, current, with a provider resume id. */
function member(): CoordinatorSessions {
  const id = JSON.stringify([WS, 'session', SESSION])
  return { version: 1, current: id, members: [{
    id, workspaceId: WS, workspacePath: DIR, orcaSession: SESSION, agentType: 'codex', title: 'Resume status message clipping', paneKey: 'new-tab:new-leaf', resumeSessionId: 'codex-native-id',
    bindings: [{ terminal: 'term-old', paneKey: 'old-tab:old-leaf', orcaSession: SESSION }, { terminal: 'term-new', paneKey: 'new-tab:new-leaf', orcaSession: SESSION }],
    terminals: ['term-old', 'term-new']
  }] }
}

const coordinator = (sessions: CoordinatorSessions | undefined) => ({ key: 'orca-flow', name: 'orca-flow', repos: [], workspaceId: null, dir: DIR, about: '', sessions })
/** Orca's terminal list, as the lineage reads it: live terminal handle -> its pane. */
const lineageOf = (rows: ReturnType<typeof rowsOf>) => ({ paneOf: new Map(rows.flatMap((r) => r.agents.flatMap((a) => a.terminal ? [[a.terminal, a.paneKey] as [string, string]] : []))), dispatcherOf: new Map<string, string>() })

function fold(rows: ReturnType<typeof rowsOf>, sessions: CoordinatorSessions | undefined) {
  const c = coordinator(sessions)
  const all = assignCoordinators(rows, [c], lineageOf(rows))
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [DIR])
  return { all, c, coordinator: coordinators[0], visible }
}

function wakeIo() {
  const calls = { open: [] as string[][], resume: 0, fresh: 0, save: 0 }
  const io: WakeIo = {
    open: async (ws, t) => { calls.open.push([ws, t]); return true },
    save: () => { calls.save++ },
    fresh: async () => { calls.fresh++; return { ok: true } },
    resume: async () => { calls.resume++; return { terminalId: 'term-second' } },
    binding: async () => ({ status: 'running', terminal: 'term-second' })
  }
  return { io, calls }
}

test('a stale pre-restart pane beside the live resumed pane: the coordinator is that live conversation, not Sleeping', () => {
  const rows = rowsOf([stale, resumed], { 'new-tab:new-leaf': 'term-new' })
  const sessions = member()
  const m = sessions.members[0]
  assert.equal(memberAgent(m, rows)?.paneKey, 'new-tab:new-leaf', 'two rows of one conversation resolve to the live one')
  assert.deepEqual(memberRows(m, rows).map((a) => a.paneKey), ['old-tab:old-leaf', 'new-tab:new-leaf'], 'both rows are this member')
  const { all, coordinator: view, visible } = fold(rows, sessions)
  assert.equal(view.session?.paneKey, 'new-tab:new-leaf')
  assert.equal(view.session?.state, 'working', 'the row shows the live state, never Sleeping')
  assert.equal(view.members?.[0].agent?.paneKey, 'new-tab:new-leaf')
  assert.equal(visible.length, 0, 'the dead pane is not a separate duplicate row under the coordinator')
  assert.deepEqual(all[0].agents.map((a) => [a.coordinator, a.leadPane]), [['you', null], ['you', null]], 'both rows classify as the coordinator itself, neither as a folder child')
  // A lead started from the pre-restart pane still nests under this coordinator.
  const lead = rowsOf([stale, resumed, { paneKey: 'lead:1', parentPaneKey: 'old-tab:old-leaf', orcaSessionId: 'lead', agentType: 'claude', state: 'working', hasLivePty: true }], { 'new-tab:new-leaf': 'term-new', 'lead:1': 'term-lead' })
  const withLead = fold(lead, member())
  assert.deepEqual(withLead.visible.map((r) => [r.agents[0].paneKey, r.agents[0].coordinator, r.agents[0].leadPane]), [['lead:1', 'orca-flow', null]])
})

test('opening that coordinator shows its live pane and starts no second resume', async () => {
  const rows = rowsOf([stale, resumed], { 'new-tab:new-leaf': 'term-new' })
  const c = coordinator(member())
  assert.deepEqual(wakePlan(c, rows, 1), { kind: 'open', member: c.sessions!.members[0], workspaceId: WS, terminal: 'term-new' })
  const { io, calls } = wakeIo()
  assert.deepEqual(await wakeCoordinator(c, rows, 1, io), { ok: true, kind: 'opened' })
  assert.deepEqual(calls.open, [[WS, 'term-new']])
  assert.equal(calls.resume + calls.fresh + calls.save, 0)
})

test('reconcile keeps membership, history bindings and current; the dead pane never becomes the binding', () => {
  const rows = rowsOf([stale, resumed], { 'new-tab:new-leaf': 'term-new' })
  const sessions = member()
  const next = reconcileSessions(sessions, rows)
  assert.equal(next.current, sessions.current)
  assert.equal(next.members.length, 1)
  assert.equal(next.members[0].paneKey, 'new-tab:new-leaf')
  assert.deepEqual(next.members[0].bindings, sessions.members[0].bindings)
  assert.deepEqual(next.members[0].terminals, ['term-old', 'term-new'])
  assert.equal(next.members[0].resumeSessionId, 'codex-native-id')
  // The same order reversed (Orca lists either first) resolves the same.
  assert.equal(reconcileSessions(sessions, rowsOf([resumed, stale], { 'new-tab:new-leaf': 'term-new' })).members[0].lastAgent?.paneKey, 'new-tab:new-leaf')
})

test('Sessions offers the live conversation once; choosing or associating either row keeps one member', () => {
  const rows = rowsOf([stale, resumed], { 'new-tab:new-leaf': 'term-new' })
  const sessions = member()
  const { coordinator: view, visible } = fold(rows, sessions)
  const choices = sessionChoices(view, visible)
  assert.deepEqual(choices.map((ch) => ch.paneKey), ['new-tab:new-leaf'])
  assert.equal(choices[0].current, true)
  const chosen = chooseSession(sessions, rows[0], choices[0])
  assert.equal(chosen.members.length, 1)
  assert.equal(chosen.current, sessions.current)
  // Associating the stale row is the same conversation: no duplicate member id, the config stays valid.
  const associated = associateSession(sessions, rows[0], rows[0].agents[0])
  assert.equal(associated.members.length, 1)
  assert.equal(associated.members[0].paneKey, 'new-tab:new-leaf')
  const fresh = associateSession({ version: 1, current: null, members: [] }, rows[0], rows[0].agents[1])
  assert.equal(associateSession(fresh, rows[0], rows[0].agents[0]).members.length, 1)
})

test('two live panes of one conversation stay ambiguous: no pane is picked by order or age', async () => {
  const rows = rowsOf([{ ...stale, hasLivePty: true }, resumed], { 'old-tab:old-leaf': 'term-old', 'new-tab:new-leaf': 'term-new' })
  const sessions = member()
  delete sessions.members[0].resumeSessionId
  assert.equal(memberAgent(sessions.members[0], rows), null)
  const c = coordinator(sessions)
  assert.equal(wakePlan(c, rows, 2).kind, 'choose')
  const { visible } = fold(rows, sessions)
  assert.equal(visible.length, 0, 'neither pane shows as a separate workstream row')
})

test('all panes dead after a reboot: Sleeping, one exact resume of that member, no duplicate rows', async () => {
  const rows = rowsOf([stale, { ...resumed, hasLivePty: undefined, state: 'done' }], {}, 0)
  const sessions = member()
  assert.equal(memberAgent(sessions.members[0], rows), null)
  const { coordinator: view, visible } = fold(rows, sessions)
  assert.equal(view.session, null)
  assert.equal(visible.length, 0, 'neither dead pane becomes a duplicate row')
  assert.equal(JSON.stringify(reconcileSessions(sessions, rows)), JSON.stringify(sessions), 'nothing about the member changes')
  const c = coordinator(sessions)
  assert.deepEqual(wakePlan(c, rows, 0), { kind: 'resume', member: sessions.members[0] })
  const { io, calls } = wakeIo()
  await wakeCoordinator(c, rows, 0, io)
  assert.equal(calls.resume, 1, 'resumes that exact member once')
  assert.equal(calls.fresh, 0)
  // Without a provider id, dead duplicate rows are a closed conversation, not an ambiguous one.
  const noId = member()
  delete noId.members[0].resumeSessionId
  assert.deepEqual(wakePlan(coordinator(noId), rows, 0), { kind: 'fresh', agent: 'codex' })
})

test('a dead member conversation never adopts another live conversation of the same provider', async () => {
  const other: PsAgent = { paneKey: 'other-tab:other-leaf', orcaSessionId: 'another-conversation', agentType: 'codex', state: 'working', hasLivePty: true }
  const rows = rowsOf([stale, { ...resumed, hasLivePty: undefined }, other], { 'other-tab:other-leaf': 'term-other' })
  const sessions = member()
  assert.equal(memberAgent(sessions.members[0], rows), null)
  const { coordinator: view, visible } = fold(rows, sessions)
  assert.equal(view.session, null)
  assert.deepEqual(visible.map((r) => r.agents[0].paneKey), ['other-tab:other-leaf'])
  const c = coordinator(sessions)
  assert.equal(wakePlan(c, rows, 1).kind, 'resume')
  const next = reconcileSessions(sessions, rows)
  assert.ok(!next.members[0].terminals.includes('term-other'))
})

test('a restored pane with a new terminal handle rebinds the same member and keeps the old handle', async () => {
  const rows = rowsOf([resumed], { 'new-tab:new-leaf': 'term-after-reboot' })
  const sessions = member()
  const next = reconcileSessions(sessions, rows)
  assert.equal(next.members[0].id, sessions.members[0].id)
  assert.deepEqual(next.members[0].terminals, ['term-old', 'term-new', 'term-after-reboot'], 'run routes on older handles still resolve to this member')
  assert.deepEqual(next.members[0].bindings?.at(-1), { terminal: 'term-after-reboot', paneKey: 'new-tab:new-leaf', orcaSession: SESSION })
  const { io, calls } = wakeIo()
  assert.deepEqual(await wakeCoordinator(coordinator(next), rows, 1, io), { ok: true, kind: 'opened' })
  assert.deepEqual(calls.open, [[WS, 'term-after-reboot']])
  // A worker elsewhere, dispatched from the pre-reboot handle, still belongs to this coordinator.
  const worker = fromPs([{ worktreeId: 'wt::/fixture/repo', path: '/fixture/repo', identity: { key: 'repo' }, agents: [{ paneKey: 'worker:1', orcaSessionId: 'w', agentType: 'claude', state: 'working', hasLivePty: true }] }])
  const all = assignCoordinators([...rows, ...worker], [coordinator(next)], { ...lineageOf(rows), dispatcherOf: new Map([['worker:1', 'term-old']]) })
  assert.equal(all[1].agents[0].coordinator, 'orca-flow')
})

test('legacy coordinator (no sessions): a stale and a live row of one conversation are one unambiguous session', () => {
  const rows = rowsOf([stale, resumed], { 'new-tab:new-leaf': 'term-new' })
  assert.equal(coordinatorSession(rows[0].agents)?.paneKey, 'new-tab:new-leaf')
  assert.deepEqual(conversationRows(rows[0].agents, rows[0].agents[1]).map((a) => a.paneKey), ['old-tab:old-leaf', 'new-tab:new-leaf'])
  const { coordinator: view, visible } = fold(rows, undefined)
  assert.equal(view.session?.paneKey, 'new-tab:new-leaf')
  assert.equal(visible.length, 0)
})

test('legacy ayn-odin shape: two dead rows of one conversation plus another live root stay ambiguous', () => {
  const dead: PsAgent = { paneKey: 'a:1', orcaSessionId: 'claude_5f9da3ea', agentType: 'claude', state: 'done', conversationName: 'CocoonFE on AYN Odin' }
  const rows = rowsOf([dead, { ...dead, paneKey: 'b:1' }, { paneKey: 'c:1', orcaSessionId: 'cddbb1d9', agentType: 'claude', state: 'done', hasLivePty: true }], { 'c:1': 'term-c' })
  assert.equal(coordinatorSession(rows[0].agents), null, 'two conversations: never elected by liveness')
  const { coordinator: view } = fold(rows, undefined)
  assert.equal(view.session, null)
  assert.match(view.sessionNotice!, /No unambiguous coordinator session/)
})

test('memberFrom of the live row keys the member by conversation, so either pane maps to the same id', () => {
  const rows = rowsOf([stale, resumed], { 'new-tab:new-leaf': 'term-new' })
  assert.equal(memberFrom(rows[0], rows[0].agents[0]).id, memberFrom(rows[0], rows[0].agents[1]).id)
})
