import { assert, test } from 'orca/testing'
import { associateSession, askKey, resumeExactMember, bindLaunched, resumeIdFor, withResumeId, chooseSession, currentRecipient, exclusive, launchedAgent, launchOnce, settlePending, terminalPane, wakeCoordinator, wakePlan, type Launch, type WakeIo, deliverCurrent, deliveryReceipt, DeliveryUncertainError, deliveryBlock, memberAgent, memberFrom, readMemberHistory, reconcileSessions, selectCurrent, sessionChoices, sessionKey, validSessions, conversationMissing, conversationSaved, markRefused, parseProcs, programRuns, providerMessage, ResumeRefusedError, type ResumeBinding } from './coordinator-sessions.ts'
import { assignCoordinators, coordinatorSession, readCoordinators, scaffoldCoordinator, updateCoordinatorSessions, writeCoordinatorSessions } from './coordinators.ts'
import { foldCoordinatorFolders, fromPs, livePanes, openAgent, openNthChat, summaryAgents } from './worker.ts'
import { askingRows, emptyUi, render, wakeView } from './view.ts'
import type { Coordinator, CoordinatorSessions } from './protocol.ts'
import { coordinatorHandover } from './handover-providers.ts'
import { firstProvider } from './coordinator-providers.ts'

function fixture(provider = 'codex') {
  const rows = fromPs([{ worktreeId: 'r::/fixture/home', path: '/fixture/home', displayName: 'home', repo: 'home', liveTerminalCount: 5, agents: [
    { paneKey: 'old:1', agentType: 'claude', orcaSessionId: 'old-session', state: 'waiting', conversationName: 'Original coordinator' },
    { paneKey: 'new:1', agentType: provider, orcaSessionId: 'new-session', state: 'working', conversationName: 'Replacement coordinator' },
    { paneKey: 'lead:1', parentPaneKey: 'old:1', agentType: 'claude', orcaSessionId: 'lead-session', state: 'working', taskTitle: 'Genuine folder lead' },
    { paneKey: 'worker:1', parentPaneKey: 'lead:1', agentType: 'codex', orcaSessionId: 'worker-session', state: 'working', taskTitle: 'Nested worker' },
    { paneKey: 'helper:1', parentPaneKey: 'worker:1', agentType: 'claude', orcaSessionId: 'helper-session', state: 'working', taskTitle: 'Deep helper' }
  ] }], { cards: {}, summaries: {} }, new Map([['/fixture/home', 'folder:home']]))
  rows[0].agents.forEach((a) => { a.terminal = `term-${a.paneKey}`; a.live = true })
  const lineage = { paneOf: new Map(rows[0].agents.map((a) => [a.terminal!, a.paneKey])), dispatcherOf: new Map([['lead:1', 'term-old:1'], ['worker:1', 'term-old:1'], ['helper:1', 'term-old:1']]), dispatchOf: new Map<string, 'open' | 'settled'>([['lead:1', 'open'], ['worker:1', 'open'], ['helper:1', 'open']]) }
  const members = rows[0].agents.slice(0, 2).map((a) => memberFrom(rows[0], a))
  const sessions: CoordinatorSessions = { version: 1, current: members[1].id, members }
  const c = { key: 'home', name: 'home', repos: [], workspaceId: null, dir: '/fixture/home', about: '', sessions }
  return { rows, lineage, sessions, c }
}

function inventory(rows: ReturnType<typeof fixture>['rows']) {
  return { worktrees: rows.map((r) => ({ path: r.path, agents: r.agents.map((a) => ({ paneKey: a.paneKey, orcaSessionId: a.orcaSession, agentType: a.agentType, hasLivePty: a.live === true })) })), truncated: false }
}

test('ambiguous roots are never chosen by list order, provider, focus, newest or descendants', () => {
  const { rows, lineage, c } = fixture()
  assert.equal(coordinatorSession(rows[0].agents, (p) => lineage.dispatchOf.has(p)), null)
  assert.equal(coordinatorSession([...rows[0].agents].reverse(), (p) => lineage.dispatchOf.has(p)), null)
  const legacy = { ...c, sessions: undefined }
  const all = assignCoordinators(rows, [legacy], lineage)
  const coordinators: Coordinator[] = [{ ...legacy }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  assert.equal(coordinators[0].session, null)
  assert.match(coordinators[0].sessionNotice!, /explicitly associate/)
  assert.equal(visible.length, 5)
})

test('explicit adoption preserves two same-provider members and cross-provider replacements without absorbing leads', () => {
  for (const provider of ['claude', 'codex', 'antigravity']) {
    const { rows, lineage, c } = fixture(provider)
    let sessions: CoordinatorSessions = { version: 1, current: null, members: [] }
    sessions = associateSession(sessions, rows[0], rows[0].agents[0])
    sessions = associateSession(sessions, rows[0], rows[0].agents[1])
    assert.equal(sessions.current, null, 'association alone does not select a recipient')
    sessions = selectCurrent(sessions, sessions.members[1].id)
    const all = assignCoordinators(rows, [{ ...c, sessions }], lineage)
    const coordinators: Coordinator[] = [{ ...c, sessions }]
    const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
    assert.deepEqual(visible.map((r) => [r.agents[0].paneKey, r.agents[0].leadPane]), [['lead:1', null], ['worker:1', 'lead:1'], ['helper:1', 'worker:1']])
    assert.equal(coordinators[0].session?.paneKey, 'new:1')
    assert.equal(coordinators[0].members?.length, 2)
    let refused = false
    try { associateSession(sessions, rows[0], { ...rows[0].agents[2], dispatch: 'open' }) } catch { refused = true }
    assert.ok(refused, 'genuine dispatch/parent provenance cannot become coordinator membership')
    const switched = assignCoordinators(rows, [{ ...c, sessions: selectCurrent(sessions, sessions.members[0].id) }], lineage)
    assert.deepEqual(switched.map((r) => r.agents.map((a) => [a.coordinator, a.leadPane])), all.map((r) => r.agents.map((a) => [a.coordinator, a.leadPane])), 'current selection never changes ownership')
  }
})

test('explicit history provenance does not classify an unrelated closed folder lead as the coordinator', () => {
  const { rows, lineage, c } = fixture()
  lineage.dispatcherOf.set('worker:1', 'term-unrelated-folder-lead')
  const child = { ...rows[0].agents[3], parentPane: null }
  const all = assignCoordinators([{ ...rows[0], agents: [child] }], [c], { ...lineage, dirOfTerminal: new Map([['term-unrelated-folder-lead', c.dir]]) })
  assert.equal(all[0].agents[0].leadPane, null)
  // Its folder can determine ownership, but must not create a coordinator member or current target.
  assert.equal(memberAgent(c.sessions.members[1], all), null)
})

test('scoped session and ask keys cannot collide across workspaces or delimiters', () => {
  const { rows } = fixture()
  assert.ok(askKey(rows[0], rows[0].agents[0]) !== askKey({ ...rows[0], id: 'folder:other' }, rows[0].agents[0]))
  assert.ok(sessionKey('a:b', 'c', '') !== sessionKey('a', 'b:c', ''))
  assert.ok(sessionKey('a', null, 'same') !== sessionKey('a', 'same', ''))
})

test('an exact session rebinds to its new pane; new same-provider sessions never take that membership', () => {
  const { rows, sessions } = fixture('claude')
  const resumed = { ...rows[0].agents[1], paneKey: 'resumed:1', terminal: 'term-resumed' }
  const nextRows = [{ ...rows[0], agents: [resumed] }]
  const next = reconcileSessions(sessions, nextRows)
  assert.equal(next.current, sessions.current)
  assert.equal(next.members[1].id, sessions.members[1].id)
  assert.deepEqual(next.members[1].terminals, ['term-new:1', 'term-resumed'])
  assert.equal(memberAgent(next.members[1], [{ ...rows[0], agents: [{ ...resumed, orcaSession: 'fresh-session' }] }]), null)
  assert.equal(memberAgent(next.members[1], [{ ...nextRows[0], id: 'folder:other' }]), null)
})

test('current status comes from current once; previous asks stay source-attributed and read-only', () => {
  const { rows, lineage, c } = fixture()
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  const snap = { rows: visible, coordinators, source: 'cli' as const, capacity: null }
  const asks = askingRows(snap)
  assert.equal(asks.length, 1)
  assert.equal(asks[0].coordinatorMember, c.sessions.members[0].id)
  assert.equal(asks[0].historical, true)
  const html = render(snap, emptyUi())
  assert.match(html.attention, /previous session · read-only/)
  assert.match(html.attention, /data-history="home"/)
  assert.ok(!html.attention.includes('data-coordinator="home"'))
  assert.equal((html.main.match(/data-coordinator="home"/g) ?? []).length, 2)
  assert.ok(!html.main.includes('data-menu="agent:new:1"'), 'current member is not also a workstream lead')
  assert.match(html.main, /data-menu="agent:lead:1"[^>]*data-depth="0" style="--node-x:43.105px"/)
  assert.match(html.main, /data-menu="agent:worker:1"[^>]*data-depth="1" style="--node-x:67.105px"/)
  assert.match(html.main, /data-menu="agent:helper:1"[^>]*data-depth="2" style="--node-x:91.105px"/)
  assert.match(html.main, /cx="91.11"/)
  assert.match(html.main, /class="provider"/)
  assert.match(html.main, /class="ch(?: |")/)
})

test('offline historical asks remain visible without becoming the current status', () => {
  const { rows, lineage, c } = fixture()
  rows[0].agents = rows[0].agents.filter((a) => a.paneKey !== 'old:1')
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  assert.equal(askingRows({ rows: visible, coordinators })[0].agents[0].paneKey, 'old:1')
  assert.equal(coordinators[0].session?.state, 'working')
})

test('delivery resolves the current member, validates its exact terminal, and records the actual receipt', async () => {
  const { rows, c } = fixture()
  const calls: string[][] = []
  const recipient = await deliverCurrent(c, rows, 'New task', async (args) => {
    calls.push(args)
    return args[0] === 'worktree' ? inventory(rows) : args[1] === 'show' ? { terminal: { handle: 'term-new:1', tabId: 'new', leafId: '1', writable: true, worktreePath: '/fixture/home' } } : { send: { handle: 'term-new:1', accepted: true, prompt: { requestId: 'request-1', stages: ['input_accepted', 'turn_started'], provider: 'codex', observation: 'observed', processIncarnation: 'inc-1' } } }
  })
  assert.deepEqual(calls.map((a) => a.slice(0, 4)), [['terminal', 'show', '--terminal', 'term-new:1'], ['worktree', 'ps', '--limit', '10000'], ['terminal', 'send', '--terminal', 'term-new:1']])
  assert.equal(recipient.member, c.sessions.current)
  assert.equal(recipient.receipt?.requestId, 'request-1')
  const switched = { ...c, sessions: selectCurrent(c.sessions, c.sessions.members[0].id) }
  assert.equal(currentRecipient(switched, rows).recipient.terminal, 'term-old:1')
  assert.equal(recipient.terminal, 'term-new:1', 'saved receipt never follows a later current change')
})

test('selection/send race and stale or unwritable exact terminal fail without fallback or send', async () => {
  for (const condition of ['changed-current', 'wrong-pane', 'wrong-workspace', 'unwritable']) {
    const { rows, c } = fixture()
    const calls: string[][] = []
    let failed = false
    try {
      await deliverCurrent(c, rows, 'Do not misroute', async (args) => {
        calls.push(args)
        if (args[0] === 'worktree') return inventory(rows)
        return { terminal: { handle: 'term-new:1', tabId: condition === 'wrong-pane' ? 'other' : 'new', leafId: '1', writable: condition !== 'unwritable', worktreePath: condition === 'wrong-workspace' ? '/fixture/other' : '/fixture/home' } }
      }, () => condition !== 'changed-current')
    } catch { failed = true }
    assert.ok(failed)
    assert.equal(calls.length, condition === 'changed-current' ? 2 : 1)
    assert.equal(calls[0][1], 'show')
    assert.ok(!calls.some((a) => a[1] === 'send'))
  }
})

test('a missing current exact session never falls back to another member or a folder lead', () => {
  const { rows, c } = fixture()
  rows[0].agents = rows[0].agents.filter((a) => a.paneKey !== 'new:1')
  let failed = false
  try { currentRecipient(c, rows) } catch { failed = true }
  assert.ok(failed)
})

test('read-only history checks conversation identity around exact reads, preserves selection and reports truncation', async () => {
  const { sessions, rows } = fixture()
  const before = JSON.stringify(sessions)
  const calls: string[][] = []
  const result = await readMemberHistory(sessions.members[0], async (args) => { calls.push(args); return args[0] === 'worktree' ? inventory(rows) : args[1] === 'show' ? { terminal: { handle: 'term-old:1', tabId: 'old', leafId: '1', worktreePath: '/fixture/home' } } : { terminal: { handle: 'term-old:1', tail: ['<script>not markup</script>', 'Previous approval'], truncated: true } } })
  assert.deepEqual(calls.map((a) => a.slice(0, 2)), [['terminal', 'show'], ['worktree', 'ps'], ['terminal', 'read'], ['worktree', 'ps']])
  assert.equal(calls[2][3], 'term-old:1')
  assert.equal(result.text, '<script>not markup</script>\nPrevious approval')
  assert.equal(result.truncated, true)
  assert.equal(JSON.stringify(sessions), before)
  const unavailable = await readMemberHistory(sessions.members[0], async () => { throw new Error('closed') })
  assert.match(unavailable.unavailable!, /no saved transcript read API/)
  assert.equal(unavailable.text, '')
})

test('an exact open failure cannot report success or open an arbitrary workspace conversation', async () => {
  const calls: string[] = []
  const result = await openAgent({ host: { call: async () => { calls.push('open'); return { opened: true } } }, log: () => {} } as never, async () => { throw new Error('missing terminal') }, { workspaceId: 'folder:home', terminal: 'old-terminal' })
  assert.equal(result.opened, false)
  assert.deepEqual(calls, [])
})

test('explicit membership persists with scope and appearance intact; malformed configs fail closed', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'flow-sessions-test-'))
  try {
    const dir = scaffoldCoordinator(root, { name: 'example', look: { shape: 'hex', color: 'green' } })
    const { sessions } = fixture()
    writeCoordinatorSessions(dir, sessions)
    const read = readCoordinators(root)[0]
    assert.deepEqual(read.sessions, sessions)
    assert.equal(read.look?.shape, 'hex')
    assert.equal(JSON.parse(readFileSync(join(dir, 'coordinator.json'), 'utf8')).name, 'example')
    assert.equal(validSessions({ version: 1, current: null, members: [{ id: 'fake' }] }), undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a stale snapshot cannot overwrite a newer current selection on disk', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'flow-selection-race-'))
  try {
    const dir = scaffoldCoordinator(root, { name: 'race', look: null })
    const { sessions } = fixture()
    writeCoordinatorSessions(dir, sessions)
    const changed = selectCurrent(sessions, sessions.members[0].id)
    writeCoordinatorSessions(dir, changed, { sessions })
    let refused = false
    try { writeCoordinatorSessions(dir, sessions, { sessions }) } catch { refused = true }
    assert.ok(refused)
    assert.equal(readCoordinators(root)[0].sessions?.current, changed.current)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('exact resume uses only a verified provider id, updates binding, and never resumes history', async () => {
  const { rows, sessions } = fixture()
  sessions.members[1].resumeSessionId = 'native-codex-id'
  const calls: unknown[] = []
  const io = {
    resume: async (input: unknown) => { calls.push(input); return { terminalId: 'resumed-host-id' } },
    binding: async () => ({ status: 'bound' as const, workspaceId: rows[0].id, agent: { ...rows[0].agents[1], paneKey: 'resumed:1', orcaSession: 'new-orca-binding', terminal: 'term-resumed' } })
  }
  const next = await resumeExactMember(sessions, sessions.current!, io)
  assert.deepEqual(calls, [{ workspaceId: 'folder:home', agent: 'codex', sessionId: 'native-codex-id' }])
  assert.equal(next.current, sessions.current)
  assert.equal(next.members[1].orcaSession, 'new-orca-binding')
  assert.equal(next.members[1].id, sessions.members[1].id)
  assert.equal(next.members[0].terminals[0], 'term-old:1')
  let refused = false
  try { await resumeExactMember(sessions, sessions.members[0].id, io) } catch { refused = true }
  assert.ok(refused)
  assert.equal(calls.length, 1)
  delete sessions.members[1].resumeSessionId
  refused = false
  try { await resumeExactMember(sessions, sessions.current!, io) } catch { refused = true }
  assert.ok(refused)
  assert.equal(calls.length, 1, 'never substitute the Orca conversation id for a missing provider id')
})

test('pending asks in the same coordinator workspace have independent jump identities', async () => {
  const { nextTarget } = await import('./rank.ts')
  const { rows, lineage, c } = fixture()
  rows[0].agents[1].state = 'waiting'
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  const queue = askingRows({ rows: visible, coordinators })
  assert.equal(queue.length, 2)
  assert.equal(queue[0].id, queue[1].id)
  assert.ok(queue[0].queueKey !== queue[1].queueKey)
  assert.equal(nextTarget(queue, { id: queue[0].queueKey!, at: 1 }, 2), queue[1])
})

test('a saved Linear recipient opens its source history after current changes', () => {
  const { rows, lineage, c } = fixture()
  const recipient = currentRecipient(c, rows).recipient
  c.sessions = selectCurrent(c.sessions, c.sessions.members[0].id)
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  const issue = { id: 'TEST-1', title: 'Example task', url: '', state: { name: 'Todo', type: 'unstarted', color: '' }, team: 'TEST', project: null, projectColor: '', assignee: { id: 'me', name: 'Me' }, priority: 2, cycle: null, updatedAt: 1 }
  const html = render({ rows: visible, coordinators, source: 'cli', capacity: null }, emptyUi(), { me: 'me', teams: ['TEST'], connectedTeams: ['TEST'], issues: [issue], cycles: [], sent: { 'TEST-1': { coordinator: 'home', at: 1, recipient } }, lastSent: {}, at: 1 }).linear
  assert.match(html, /data-history="home"/)
  assert.match(html, /data-history-terminal="term-new:1"/)
  assert.ok(html.includes('session-new') || html.includes('new-session'))
  assert.ok(!html.includes('data-coordinator="home"'))
})

test('a non-live member remaining in ps never becomes a duplicate workstream row', () => {
  const { rows, lineage, c } = fixture()
  rows[0].agents[0].live = false
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(assignCoordinators(rows, [c], lineage), coordinators, [c.dir])
  assert.ok(!visible.some((r) => r.agents.some((a) => a.paneKey === 'old:1')))
  assert.equal(coordinators[0].members?.[0].agent, null)
  assert.equal(askingRows({ rows: visible, coordinators })[0].historical, true)
})

test('provider mixing includes live associated history members without replacing coordinator avatars', async () => {
  const { mixedProviders } = await import('./providers.ts')
  const { rows, c } = fixture()
  const coordinators: Coordinator[] = [{ ...c }]
  foldCoordinatorFolders(rows, coordinators, [c.dir])
  assert.equal(mixedProviders({ rows: [], coordinators }), true)
  coordinators[0].members![0].agent = null
  assert.equal(mixedProviders({ rows: [], coordinators }), false, 'cached history is not live evidence')
})

test('documented CLI receipts distinguish refusal, confirmed turn, and durable unconfirmed attempts', () => {
  const { c, rows } = fixture()
  const recipient = currentRecipient(c, rows).recipient
  const confirmed = { send: { handle: recipient.terminal, accepted: true, prompt: { requestId: 'durable-1', provider: 'codex', stages: ['input_accepted', 'turn_started'], observation: 'observed', processIncarnation: 'process-1' } } }
  assert.deepEqual(deliveryReceipt(confirmed, recipient).receipt?.stages, ['input_accepted', 'turn_started'])
  for (const reply of [{}, null, { accepted: true }, { send: { accepted: true, handle: recipient.terminal } }, { send: { ...confirmed.send, prompt: { ...confirmed.send.prompt, stages: ['input_accepted'] } } }, { send: { ...confirmed.send, handle: 'wrong-terminal' } }]) {
    let uncertain: DeliveryUncertainError | null = null
    try { deliveryReceipt(reply, recipient) } catch (e) { if (e instanceof DeliveryUncertainError) uncertain = e }
    assert.ok(uncertain)
    assert.equal(uncertain!.recipient.terminal, recipient.terminal)
    assert.match(uncertain!.message, /do not send again blindly/)
  }
  let refused: unknown
  try { deliveryReceipt({ send: { accepted: false, handle: recipient.terminal } }, recipient) } catch (e) { refused = e }
  assert.ok(refused instanceof Error && !(refused instanceof DeliveryUncertainError))
})

test('fresh live inventory rejects same-pane conversation/provider reuse before any send', async () => {
  for (const change of ['session', 'provider', 'unknown-live']) {
    const { c, rows } = fixture()
    if (change === 'unknown-live') rows[0].agents[1].live = undefined
    const live = inventory(rows)
    if (change === 'session') live.worktrees[0].agents[1].orcaSessionId = 'different-session'
    if (change === 'provider') live.worktrees[0].agents[1].agentType = 'claude'
    const calls: string[][] = []
    let refused = false
    try { await deliverCurrent(c, rows, 'No misdelivery', async (args) => {
      calls.push(args)
      return args[0] === 'worktree' ? live : { terminal: { handle: 'term-new:1', tabId: 'new', leafId: '1', worktreePath: '/fixture/home', writable: true } }
    }) } catch { refused = true }
    assert.ok(refused)
    assert.ok(!calls.some((a) => a[1] === 'send'))
  }
})

test('history discards output if its terminal changed conversations while the read was in flight', async () => {
  const { sessions, rows } = fixture()
  let reads = 0
  const history = await readMemberHistory(sessions.members[0], async (args) => {
    if (args[0] === 'worktree') {
      const live = inventory(rows)
      if (reads) live.worktrees[0].agents[0].orcaSessionId = 'later-conversation'
      return live
    }
    if (args[1] === 'show') return { terminal: { handle: 'term-old:1', tabId: 'old', leafId: '1', worktreePath: '/fixture/home' } }
    reads++
    return { terminal: { handle: 'term-old:1', tail: ['must not expose later conversation'] } }
  })
  assert.equal(reads, 1)
  assert.equal(history.text, '')
  assert.match(history.unavailable!, /identity cannot be verified/)
})

test('unknown delivery survives disk reload and age pruning and blocks ordinary resend', async () => {
  const { readLinearMemory, writeLinearMemory } = await import('./coordinators.ts')
  const { pruneSent } = await import('./linear.ts')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'flow-unknown-delivery-'))
  try {
    const { c, rows } = fixture()
    const recipient = { ...currentRecipient(c, rows).recipient, receipt: { requestId: 'durable-unconfirmed', accepted: true, stages: ['input_accepted'] } }
    const sent = { 'TEST-1': { coordinator: c.key, at: 1, delivery: 'unknown' as const, recipient } }
    writeLinearMemory({ lastSent: {}, sent }, join(dir, 'linear.json'))
    const reloaded = readLinearMemory(join(dir, 'linear.json'))
    assert.deepEqual(reloaded.sent, sent)
    assert.match(deliveryBlock(reloaded.sent['TEST-1'])!, /durable-unconfirmed/)
    assert.equal(pruneSent(reloaded.sent, new Set(), Date.now()), null, 'age does not authorize a retry')
    assert.equal(pruneSent(reloaded.sent, new Set(['TEST-1']), Date.now()), null, 'a worktree link alone does not reconcile an unknown delivery')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an ambiguous transport failure retains its durable request id without retrying', async () => {
  const { c, rows } = fixture()
  let sends = 0
  let failure: DeliveryUncertainError | null = null
  try { await deliverCurrent(c, rows, 'Exact task', async (args) => {
    if (args[0] === 'worktree') return inventory(rows)
    if (args[1] === 'show') return { terminal: { handle: 'term-new:1', tabId: 'new', leafId: '1', writable: true, worktreePath: '/fixture/home' } }
    sends++
    throw Object.assign(new Error('Transport lost after submission'), { data: { orchestrationRequestId: 'retry-only-this-id' } })
  }) } catch (e) { if (e instanceof DeliveryUncertainError) failure = e }
  assert.equal(sends, 1)
  assert.equal(failure?.recipient.receipt?.requestId, 'retry-only-this-id')
  assert.equal(failure?.recipient.orcaSession, 'new-session')
})

test('history refuses a reused pane before reading a different conversation or provider', async () => {
  for (const changed of ['session', 'provider']) {
    const { sessions, rows } = fixture()
    const live = inventory(rows)
    if (changed === 'session') live.worktrees[0].agents[0].orcaSessionId = 'other-conversation'
    else live.worktrees[0].agents[0].agentType = 'codex'
    const calls: string[][] = []
    const result = await readMemberHistory(sessions.members[0], async (args) => {
      calls.push(args)
      return args[0] === 'worktree' ? live : { terminal: { handle: 'term-old:1', tabId: 'old', leafId: '1', worktreePath: '/fixture/home' } }
    })
    assert.equal(result.text, '')
    assert.ok(result.unavailable)
    assert.ok(!calls.some((a) => a[1] === 'read'))
  }
})

test('remembered ancestry through an explicitly associated member normalizes to the logical coordinator', () => {
  const { c, rows, lineage } = fixture()
  const lead = rows[0].agents[2]
  lead.parentPane = null
  lineage.dispatcherOf.delete(lead.paneKey)
  lineage.dispatchOf.delete(lead.paneKey)
  const owners = { 'lead-session': { coordinator: c.key, leadSession: 'old-session' } }
  for (const current of c.sessions.members) {
    const all = assignCoordinators(rows, [{ ...c, sessions: selectCurrent(c.sessions, current.id) }], lineage, owners)
    assert.equal(all[0].agents[2].leadPane, null)
    assert.equal(all[0].agents[3].leadPane, lead.paneKey)
  }
})

test('main-session dropdown is populated before membership; excludes dispatched and offline conversations', () => {
  const { rows, lineage, c } = fixture('claude')
  // A parentless folder lead is still a lead, never a coordinator candidate.
  rows[0].agents[2].parentPane = null
  const unconfigured = { ...c, sessions: undefined }
  const all = assignCoordinators(rows, [unconfigured], lineage)
  const coordinators: Coordinator[] = [{ ...unconfigured }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  const choices = sessionChoices(coordinators[0], visible)
  assert.deepEqual(choices.map((a) => a.orcaSession), ['old-session', 'new-session'])
  assert.ok(choices.every((a) => !a.current), 'ambiguity never picks by order or provider')
  all[0].agents[1].live = false
  const offline = foldCoordinatorFolders(all, coordinators, [c.dir])
  assert.deepEqual(sessionChoices(coordinators[0], offline).map((a) => a.orcaSession), ['old-session'])
})

test('one main-session choice atomically associates and selects, keeping history and routing provenance', () => {
  for (const provider of ['claude', 'codex', 'antigravity']) {
    const { rows, lineage, c } = fixture(provider)
    const old = { version: 1 as const, current: c.sessions.members[0].id, members: [c.sessions.members[0]] }
    const before = JSON.stringify(old)
    const a = rows[0].agents[1]
    const choice = { workspaceId: rows[0].id, paneKey: a.paneKey, orcaSession: a.orcaSession!, agentType: a.agentType }
    const next = chooseSession(old, rows[0], choice)
    assert.equal(JSON.stringify(old), before)
    assert.equal(next.members.length, 2)
    assert.equal(next.current, next.members[1].id)
    assert.deepEqual(next.members[0], old.members[0])
    assert.equal(chooseSession(next, rows[0], choice).members.length, 2, 'repeat selection never creates a duplicate')
    const coordinator = { ...c, sessions: next }
    const all = assignCoordinators(rows, [coordinator], lineage)
    const coordinators: Coordinator[] = [coordinator]
    const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
    assert.equal(coordinators[0].session?.paneKey, a.paneKey)
    assert.equal(currentRecipient(coordinator, all).recipient.terminal, a.terminal)
    assert.deepEqual(sessionChoices(coordinators[0], visible).map((a) => a.current), [false, true])
    assert.equal(all[0].agents.find((a) => a.paneKey === 'worker:1')?.leadPane, 'lead:1')
    assert.equal(askingRows({ rows: visible, coordinators })[0].agents[0].paneKey, 'old:1')
  }
})

test('stale dropdown choices cannot select a replacement pane, workspace, provider or task lead', () => {
  const { rows, sessions } = fixture()
  const a = rows[0].agents[1]
  const choice = { workspaceId: rows[0].id, paneKey: a.paneKey, orcaSession: a.orcaSession!, agentType: a.agentType }
  const before = JSON.stringify(sessions)
  for (const patch of [{ orcaSession: 'reused-pane' }, { workspaceId: 'elsewhere' }, { agentType: 'claude' }]) {
    assert.throws(() => chooseSession(sessions, rows[0], { ...choice, ...patch }), /no longer available/)
  }
  a.dispatch = 'open'
  assert.throws(() => chooseSession(sessions, rows[0], choice), /belongs to a task/)
  a.dispatch = null
  a.live = false
  assert.throws(() => chooseSession(sessions, rows[0], choice), /no longer available/)
  a.live = true // fixture's lastAgent shares this object
  assert.equal(JSON.stringify(sessions), before)
})

test('coordinator header puts the main-session dropdown beside its name without management onboarding', () => {
  const { rows, lineage, c } = fixture()
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c, sessionNotice: 'No verified unambiguous membership', routing: 'Run routing unverified.' }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  const html = render({ rows: visible, coordinators, source: 'cli', capacity: null }, emptyUi()).main
  assert.match(html, /class="coord-open"[^]*<\/button><button class="session-trigger"[^]*<\/button><button class="coord-name"[^]*class="coord-label"/)
  assert.match(html, /aria-label="Main session for home" aria-haspopup="menu"/)
  assert.ok(!html.includes('sessions⌄'))
  assert.ok(!html.includes('unambiguous membership'))
  assert.ok(!html.includes('Run routing'))
  assert.ok(!html.includes('Associate'))
})

test('dropdown appears only for two eligible conversations, not for genuine folder leads or offline history', () => {
  for (const count of [0, 1, 2]) {
    const { rows, lineage, c } = fixture()
    // Keep current for one; keep genuine leads/workers in every case.
    rows[0].agents = rows[0].agents.filter((a) => count === 2 || (a.paneKey !== 'old:1' && (count === 1 || a.paneKey !== 'new:1')))
    rows[0].agents.find((a) => a.paneKey === 'lead:1')!.parentPane = null
    const before = JSON.stringify(c.sessions)
    const all = assignCoordinators(rows, [c], lineage)
    const coordinators: Coordinator[] = [{ ...c }]
    const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
    assert.equal(sessionChoices(coordinators[0], visible).length, count)
    const html = render({ rows: visible, coordinators, source: 'cli', capacity: null }, emptyUi()).main
    assert.equal(html.includes('class="session-trigger"'), count > 1)
    assert.match(html, /data-coordinator="home"/, 'header remains available without a switcher')
    assert.equal(JSON.stringify(c.sessions), before, 'visibility never changes membership/current')
    if (count > 0) assert.equal(currentRecipient(c, all).recipient.orcaSession, 'new-session')
  }
})

test('one selected conversation exposes the badge menu for eligible handover and recorded retry', () => {
  for (const source of ['claude', 'codex'] as const) {
    const { rows, sessions, c, lineage } = fixture(source)
    sessions.members = sessions.members.slice(1)
    rows[0].agents = rows[0].agents.filter(a => a.paneKey === 'new:1')
    const all = assignCoordinators(rows, [c], lineage)
    const coordinator: Coordinator = { ...c }
    const visible = foldCoordinatorFolders(all, [coordinator], [c.dir])
    const other = source === 'claude' ? 'codex' : 'claude'
    const name = other === 'codex' ? 'Codex' : 'Claude'
    const badge = (available: ('claude' | 'codex')[]) => render({
      rows: visible, coordinators: [coordinator], source: 'cli', capacity: null, handoverProviders: available
    }, emptyUi()).main.includes('class="session-trigger"')
    assert.equal(sessionChoices(coordinator, visible).length, 1)
    assert.equal(badge([source]), false)
    assert.equal(badge([other]), true)
    assert.deepEqual(coordinatorHandover(coordinator, [source, other], false).choices, [
      { provider: other, retry: false, label: `Handover to ${name}` }
    ])
    coordinator.handover = { phase: 'launching', provider: other }
    assert.deepEqual(coordinatorHandover(coordinator, [source, other], true), { choices: [], note: 'Handing over…' })
    assert.deepEqual(coordinatorHandover(coordinator, [source, other], false).choices, [
      { provider: other, retry: true, label: `Retry handover to ${name}` }
    ])
    assert.equal(badge([source]), true)
    assert.deepEqual(coordinatorHandover(coordinator, [source], false).choices, [])
    coordinator.handover = { phase: 'invalid' }
    assert.deepEqual(coordinatorHandover(coordinator, [other], false).choices, [])
  }
})

test('one remaining conversation does not replace an offline current or silently claim an unset main', () => {
  const { rows, lineage, c } = fixture()
  rows[0].agents = rows[0].agents.filter((a) => a.paneKey !== 'new:1')
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  assert.equal(sessionChoices(coordinators[0], visible).length, 1)
  assert.equal(coordinators[0].session, null)
  assert.throws(() => currentRecipient(c, all), /offline/)
  const unset = { ...c, sessions: { ...c.sessions, current: null } }
  assert.throws(() => currentRecipient(unset, all), /No main conversation is selected/)
  assert.equal(c.sessions.current, c.sessions.members[1].id)
})

test('multiple same-provider conversations use one logo trigger between avatar and clean text column', () => {
  const { rows, lineage, c } = fixture('claude')
  rows[0].agents = rows[0].agents.slice(0, 2)
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  const html = render({ rows: visible, coordinators, source: 'cli', capacity: null }, emptyUi()).main
  const trigger = /<button class="session-trigger"[^]*?<\/button>/.exec(html)![0]
  assert.match(trigger, /aria-label="Main session for home"/)
  assert.match(trigger, /aria-expanded="false"/)
  assert.match(trigger, /data-tip="Switch coordinator session · Replacement coordinator"/)
  assert.match(trigger, /<span class="provider" aria-hidden="true"><svg/)
  assert.match(trigger, /fill="#D97757"/, 'current Claude mark remains visible even without mixed providers')
  assert.ok(!trigger.includes('>Claude') && !trigger.includes('>Choose session'))
  assert.match(html, /class="coord-open"[^]*class="ch(?: |")/)
  assert.match(html, /<\/button><button class="session-trigger"[^]*?<\/button><button class="coord-name"/)
  assert.deepEqual(sessionChoices(coordinators[0], visible).map((x) => x.title), ['Original coordinator', 'Replacement coordinator'])
})

test('unselected alternatives use a neutral logo trigger; a single session keeps normal provider visibility', () => {
  const { rows, lineage, c } = fixture()
  c.sessions.current = null
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  const html = render({ rows: visible, coordinators, source: 'cli', capacity: null }, emptyUi()).main
  const trigger = /<button class="session-trigger"[^]*?<\/button>/.exec(html)![0]
  assert.match(trigger, /aria-label="Main session for home"/)
  assert.match(trigger, /Switch coordinator session/)
  assert.match(trigger, /<rect x="3" y="3"/)
  assert.equal(c.sessions.current, null)

  c.sessions.current = c.sessions.members[1].id
  rows[0].agents = rows[0].agents.filter((a) => a.paneKey === 'new:1')
  const one = assignCoordinators(rows, [c], lineage)
  const single: Coordinator[] = [{ ...c }]
  const singleRows = foldCoordinatorFolders(one, single, [c.dir])
  const alone = render({ rows: singleRows, coordinators: single, source: 'cli', capacity: null }, emptyUi()).main
  assert.ok(!alone.includes('class="session-trigger"'))
  assert.ok(!alone.includes('class="provider"'), 'single provider follows normal mixed-provider badge rule')
  const other = { ...rows[0], id: 'another-workspace', path: '/elsewhere', agents: [{ ...rows[0].agents[0], paneKey: 'another:1', agentType: 'claude', coordinator: 'you' }] }
  const mixed = render({ rows: [...singleRows, other], coordinators: single, source: 'cli', capacity: null }, emptyUi()).main
  assert.ok(!mixed.includes('class="session-trigger"'))
  assert.match(mixed, /class="provider" role="img" aria-label="Codex"/)
})

test('summary inventory includes all live coordinator members without changing selected recipients or nesting', () => {
  const { rows, lineage, c } = fixture()
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  const before = JSON.stringify(c.sessions)
  const snap = { rows: visible, coordinators }
  assert.deepEqual(summaryAgents(snap).map(({ agent }) => agent.paneKey).sort(), ['helper:1', 'lead:1', 'new:1', 'old:1', 'worker:1'])
  assert.deepEqual(livePanes(snap, true), ['old:1'], 'an idle non-current member is still a refresh target')
  assert.equal(currentRecipient(coordinators[0], all).agent.paneKey, 'new:1')
  assert.equal(JSON.stringify(c.sessions), before)
  const hierarchy = visible.map((r) => [r.agents[0].paneKey, r.agents[0].leadPane])
  coordinators[0].sessions = selectCurrent(c.sessions, c.sessions.members[0].id)
  const switched = foldCoordinatorFolders(all, coordinators, [c.dir])
  assert.deepEqual(summaryAgents({ rows: switched, coordinators }).map(({ agent }) => agent.paneKey).sort(), livePanes(snap).sort())
  assert.equal(currentRecipient(coordinators[0], all).agent.paneKey, 'old:1')
  assert.deepEqual(switched.map((r) => [r.agents[0].paneKey, r.agents[0].leadPane]), hierarchy)
})

test('summary inventory deduplicates cross-workspace members and excludes archives or ambiguous identities', () => {
  const { rows, c } = fixture()
  const other = { ...rows[0], id: 'folder:other', agents: [{ ...rows[0].agents[1], paneKey: 'other:1' }] }
  const member = memberFrom(other, other.agents[0])
  const coordinators: Coordinator[] = [{ ...c, workspaceId: rows[0].id, members: [
    { ...c.sessions.members[0], agent: null }, // lastAgent must never be read as live history
    { ...member, agent: other.agents[0] }
  ] }]
  const targets = summaryAgents({ rows: [other], coordinators })
  assert.equal(targets.length, 1)
  assert.equal(targets[0].worktreeId, 'folder:other', 'member workspace, not coordinator home')
  assert.equal(targets[0].agent.orcaSession, member.orcaSession)
  const contradiction = { ...other, agents: [{ ...other.agents[0], orcaSession: 'replacement-session' }] }
  assert.deepEqual(summaryAgents({ rows: [contradiction], coordinators }), [], 'do not choose the first or selected duplicate pane')
  other.agents[0].live = false
  assert.deepEqual(summaryAgents({ rows: [other], coordinators }), [], 'offline rows and members are not refreshed')
  coordinators[0].members = []
  coordinators[0].session = rows[0].agents[0]
  assert.deepEqual(summaryAgents({ rows: [], coordinators }), [], 'explicit empty membership cannot fall back to a stale current pointer')
})

test('owned structured Codex chats remain summary targets without a PTY', () => {
  const rows = fromPs([{ identity: { key: 'chat-workspace' }, agents: [
    { paneKey: 'chat-pane', orcaSessionId: 'orca-chat', agentType: 'codex', state: 'done', hasLivePty: false, structuredHostOwned: true },
    { paneKey: 'closed-pane', orcaSessionId: 'orca-closed', agentType: 'codex', state: 'done', hasLivePty: false }
  ] }])
  assert.deepEqual(summaryAgents({ rows, coordinators: [] }).map(({ agent }) => [agent.paneKey, agent.orcaSession]), [['chat-pane', 'orca-chat']])
})

// ---------- waking a coordinator: opening is not delivery ----------

/** Records every launch, resume, write and open a wake makes. */
function wakeIo(over: Partial<WakeIo> = {}) {
  const calls: { fresh: string[]; resume: unknown[]; save: CoordinatorSessions[]; open: [string, string][] } = { fresh: [], resume: [], save: [], open: [] }
  const io: WakeIo = {
    first: async () => firstProvider([{ id: 'claude', name: 'Claude' }]),
    fresh: async (agent) => { calls.fresh.push(agent); return { ok: true } },
    resume: async (input) => { calls.resume.push(input); return { terminalId: 'resumed-host-id' } },
    binding: async () => ({ status: 'running', terminal: 'term-resumed' }),
    save: (next) => { calls.save.push(next) },
    open: async (workspaceId, terminal) => { calls.open.push([workspaceId, terminal]); return true },
    ...over
  }
  return { io, calls }
}

test('a never-started coordinator starts the sole usable harness instead of the delivery error', async () => {
  const { rows, c } = fixture()
  // The reported orca-flow: coordinator.json has no sessions field and nothing of it is running.
  const empty = rows.map((r) => ({ ...r, agents: [] }))
  for (const sessions of [undefined, { version: 1 as const, current: null, members: [] }]) {
    const sleeping = { ...c, sessions }
    assert.deepEqual(wakePlan(sleeping, empty, 0), { kind: 'fresh', agent: null })
    const { io, calls } = wakeIo()
    const r = await wakeCoordinator(sleeping, empty, 0, io)
    assert.deepEqual(r, { ok: true, kind: 'started' })
    assert.deepEqual(calls.fresh, ['claude'])
    assert.equal(calls.resume.length + calls.open.length + calls.save.length, 0)
    assert.notEqual(r.error, 'No main conversation is selected.')
  }
  // Delivery stays strict for the same coordinator.
  let refused = ''
  try { currentRecipient({ ...c, sessions: undefined }, empty) } catch (e) { refused = (e as Error).message }
  assert.equal(refused, 'No main conversation is selected.')
})

test('a closed current member with a provider id resumes exactly that member, never a live other one', async () => {
  const { rows, sessions, c } = fixture()
  const current = sessions.members[1]
  current.resumeSessionId = 'native-codex-id'
  // The current conversation's terminal is gone; the other member (old:1) is still live.
  rows[0].agents = rows[0].agents.filter((a) => a.paneKey !== 'new:1')
  const plan = wakePlan(c, rows, 1)
  assert.equal(plan.kind, 'resume')
  assert.equal(plan.kind === 'resume' && plan.member.id, current.id)
  const { io, calls } = wakeIo({ binding: async () => ({ status: 'bound', workspaceId: rows[0].id, agent: { ...rows[0].agents[0], paneKey: 'resumed:1', orcaSession: 'resumed-orca', agentType: 'codex', title: 'Replacement coordinator', terminal: 'term-resumed' } }) })
  const r = await wakeCoordinator(c, rows, 1, io)
  assert.deepEqual(r, { ok: true, kind: 'resumed' })
  assert.deepEqual(calls.resume, [{ workspaceId: 'folder:home', agent: 'codex', sessionId: 'native-codex-id' }])
  assert.equal(calls.fresh.length, 0)
  const saved = calls.save[0]
  assert.equal(saved.current, current.id, 'the same member stays current')
  assert.deepEqual(saved.members.map((m) => m.id), sessions.members.map((m) => m.id), 'no member is added or replaced')
  assert.equal(saved.members[1].orcaSession, 'resumed-orca')
  assert.deepEqual(saved.members[0], sessions.members[0], 'the live other member is untouched')
  assert.deepEqual(calls.open, [['folder:home', 'term-resumed']])
})

test('normal first click never launches for zero, unknown or multiple providers; choosing starts exactly that provider', async () => {
  const c = { sessions: { version: 1 as const, current: null, members: [] } }
  const options = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }, { id: 'hermes', name: 'Hermes' }]
  for (const providers of [null, [], options]) {
    const { io, calls } = wakeIo({ first: async () => firstProvider(providers) })
    assert.equal((await wakeCoordinator(c, [], 0, io)).kind, 'provider')
    assert.equal(calls.fresh.length + calls.resume.length + calls.open.length + calls.save.length, 0)
  }
  for (const chosen of ['claude', 'codex', 'hermes']) {
    const { io, calls } = wakeIo({ first: async () => firstProvider(options, chosen) })
    assert.equal((await wakeCoordinator(c, [], 0, io)).kind, 'started')
    assert.deepEqual(calls.fresh, [chosen])
  }
  const stale = wakeIo({ first: async () => firstProvider([options[0]], 'hermes') })
  assert.equal((await wakeCoordinator(c, [], 0, stale.io)).kind, 'provider')
  assert.equal(stale.calls.fresh.length, 0)
  const missing = wakeIo(); delete missing.io.first
  assert.equal((await wakeCoordinator(c, [], 0, missing.io)).kind, 'provider')
  assert.equal(missing.calls.fresh.length, 0, 'shortcuts cannot restore an implicit Claude default')
  const shortcut = wakeIo({ first: async () => firstProvider(options) })
  assert.equal(await openNthChat([{ key: 'first', coordinator: 'first' }], 1, { coordinator: () => wakeCoordinator(c, [], 0, shortcut.io), chat: async () => {} }), 'Choose a provider for the first conversation.')
  assert.equal(shortcut.calls.fresh.length, 0)
})

test('creating a coordinator seeds instructions and empty membership without needing a launcher', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'first-coordinator-'))
  try {
    const dir = scaffoldCoordinator(root, { name: 'brand-new', look: null })
    const disk = JSON.parse(readFileSync(join(dir, 'coordinator.json'), 'utf8'))
    assert.deepEqual(disk.sessions, { version: 1, current: null, members: [] })
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /Your role: coordinator/)
    assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /roles\/coordinator.md/)
    const { io, calls } = wakeIo({ first: async () => firstProvider([{ id: 'claude', name: 'Claude' }, { id: 'hermes', name: 'Hermes' }]) })
    assert.equal((await wakeCoordinator(disk, [], 0, io)).kind, 'provider')
    assert.equal(calls.fresh.length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('provider discovery never intercepts live, sleeping, history, eligible or pending conversations', async () => {
  const f = fixture()
  const io = () => wakeIo({ first: async () => { throw Error('must not inspect first-start providers') } }).io
  assert.equal((await wakeCoordinator(f.c, f.rows, 1, io())).kind, 'opened')
  const current = f.sessions.members.find(m => m.id === f.sessions.current)!
  current.resumeSessionId = 'provider-resume'
  assert.equal((await wakeCoordinator(f.c, [], 0, io())).kind, 'starting')
  assert.equal((await wakeCoordinator({ sessions: { ...f.sessions, current: null } }, [], 0, io())).kind, 'choose')
  assert.equal((await wakeCoordinator({ sessions: undefined }, f.rows, 1, io())).kind, 'choose')
  assert.equal((await wakeCoordinator({ sessions: undefined }, [], 0, io(), true)).kind, 'started')
})

test('Hermes uses exact host terminal/session binding and preserves its provider resume id', () => {
  const { row, terminal, launch, agent } = launched()
  const hermes = { ...agent, agentType: 'hermes' }
  const r = { ...row, agents: [hermes] }
  const found = launchedAgent({ ...launch, agent: 'hermes' }, [terminal], r)!
  assert.equal(found.agentType, 'hermes')
  const bound = bindLaunched({ version: 1, current: null, members: [] }, r, found, 'hermes-native-id')
  assert.equal(bound.members[0].agentType, 'hermes')
  assert.equal(bound.members[0].resumeSessionId, 'hermes-native-id')
  assert.equal(wakePlan({ sessions: bound }, [], 0).kind, 'resume')
})

test('a running current member opens its exact terminal and launches nothing', async () => {
  const { rows, c } = fixture()
  const { io, calls } = wakeIo()
  const r = await wakeCoordinator(c, rows, 2, io)
  assert.deepEqual(r, { ok: true, kind: 'opened' })
  assert.deepEqual(calls.open, [['folder:home', 'term-new:1']])
  assert.equal(calls.fresh.length + calls.resume.length + calls.save.length, 0)
  const failed = await wakeCoordinator(c, rows, 2, wakeIo({ open: async () => false }).io)
  assert.equal(failed.kind, 'failed')
  assert.equal(failed.ok, false)
})

test('a failed restore is retryable and neutral, keeps the old member, and an unverified resume is never retried', async () => {
  const { rows, sessions, c } = fixture()
  sessions.members[1].resumeSessionId = 'native-codex-id'
  rows[0].agents = rows[0].agents.filter((a) => a.paneKey !== 'new:1')
  const before = JSON.stringify(sessions)
  const { io, calls } = wakeIo({ resume: async () => { throw new Error('session not found') } })
  const r = await wakeCoordinator(c, rows, 1, io)
  assert.equal(r.kind, 'restore-failed')
  assert.equal(r.retryable, true)
  assert.equal(r.agent, 'codex')
  assert.equal(calls.save.length + calls.fresh.length + calls.open.length, 0, 'nothing written, launched or opened')
  assert.equal(JSON.stringify(sessions), before, 'the old member and its history are preserved')
  // Not red, nothing on the row: the Sessions menu opens with the full reason, Retry and Start new (codex).
  assert.deepEqual(wakeView(r), { row: null, menu: { header: "Couldn't restore the last conversation", reason: r.error, agent: 'codex', sessions: false, retry: true } })
  assert.equal(wakeView({ ...r, retryable: false }).menu?.retry, false, 'no Retry unless retryable')
  // Launched and still running, unbound: starting, never a clipped "could not be verified" failure.
  let resumes = 0
  const running = await wakeCoordinator(c, rows, 1, wakeIo({ resume: async () => { resumes++; return { terminalId: 'x' } } }).io)
  assert.equal(running.kind, 'starting')
  assert.equal(running.ok, true)
  assert.equal(resumes, 1)
  assert.deepEqual(wakeView(running), { row: { text: 'Starting', tone: 'ok' }, menu: null })
  // A real failure: a short red label on the row, the full reason in the menu.
  const failed = { ok: false, kind: 'failed' as const, error: 'The exact session could not be opened.', retryable: true }
  assert.deepEqual(wakeView(failed), { row: { text: "Couldn't open", tone: 'bad' }, menu: { header: "Couldn't open the coordinator", reason: failed.error, sessions: false, retry: true } })
})

test('ambiguous history asks for an explicit choice and never picks a member', async () => {
  const { rows, sessions, c } = fixture()
  // Several members, none current.
  const none = { ...c, sessions: { ...sessions, current: null } }
  assert.equal(wakePlan(none, rows, 2).kind, 'choose')
  // Current is closed, has no provider id, and other conversations are open.
  const closed = fixture()
  closed.rows[0].agents = closed.rows[0].agents.filter((a) => a.paneKey !== 'new:1')
  assert.equal(wakePlan(closed.c, closed.rows, 1).kind, 'choose')
  // The recorded conversation matches two panes.
  const twice = fixture()
  twice.rows[0].agents.push({ ...twice.rows[0].agents[1], paneKey: 'dup:1', terminal: 'term-dup:1' })
  assert.equal(wakePlan(twice.c, twice.rows, 1).kind, 'choose')
  for (const [cc, rr] of [[none, rows], [closed.c, closed.rows], [twice.c, twice.rows]] as const) {
    const { io, calls } = wakeIo()
    const r = await wakeCoordinator(cc, rr, 1, io)
    assert.equal(r.kind, 'choose')
    assert.equal(calls.fresh.length + calls.resume.length + calls.save.length + calls.open.length, 0)
    const view = wakeView(r)
    assert.equal(view.row, null, 'the row keeps Sleeping')
    assert.equal(view.menu?.header, 'Pick the main conversation')
    assert.equal(view.menu?.reason, r.error)
    assert.equal(view.menu?.sessions, true)
    assert.equal(view.menu?.retry, false)
  }
  // A closed current with nothing else open has nothing to continue: a new conversation of its provider.
  const alone = fixture()
  alone.rows[0].agents = []
  assert.deepEqual(wakePlan(alone.c, alone.rows, 0), { kind: 'fresh', agent: 'codex' })
})

test('a second click while a start or resume is in flight launches nothing', async () => {
  const { rows, c } = fixture()
  const empty = rows.map((r) => ({ ...r, agents: [] }))
  const busy = new Set<string>()
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { io, calls } = wakeIo({ fresh: async (agent) => { calls.fresh.push(agent); await gate; return { ok: true } } })
  const click = () => exclusive(busy, 'home', () => wakeCoordinator({ sessions: undefined }, empty, 0, io), () => ({ ok: false, kind: 'busy' as const }))
  const first = click()
  const second = await click()
  assert.equal(second.kind, 'busy')
  assert.deepEqual(wakeView(second), { row: { text: 'Opening…', tone: 'pending' }, menu: null }, 'keeps the Opening… spinner')
  release()
  assert.equal((await first).kind, 'started')
  assert.deepEqual(calls.fresh, ['claude'], 'one launch')
  assert.equal(busy.size, 0)
  const third = await click()
  assert.equal(third.kind, 'started', 'the guard is released after the first finishes')
})

test('overlapping refreshes reconcile what is on disk instead of failing the membership swap', async () => {
  const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'flow-refresh-race-'))
  try {
    const dir = scaffoldCoordinator(root, { name: 'race', look: null })
    const { rows, sessions } = fixture()
    writeCoordinatorSessions(dir, sessions)
    // Refresh B read the sessions, then awaited ps while refresh A (or a selection) wrote newer ones.
    const staleB = readCoordinators(root)[0].sessions!
    const newer = selectCurrent(sessions, sessions.members[0].id)
    writeCoordinatorSessions(dir, newer, { sessions })
    rows[0].agents[1].title = 'Renamed meanwhile'
    // The old path compared against B's stale read and always lost the swap.
    let refused = false
    try { writeCoordinatorSessions(dir, reconcileSessions(staleB, rows), { sessions: staleB }) } catch { refused = true }
    assert.ok(refused, 'documents the logged "Session configuration changed" failure')
    const saved = updateCoordinatorSessions(dir, (disk) => disk && reconcileSessions(disk, rows))
    const onDisk = readCoordinators(root)[0].sessions!
    assert.deepEqual(saved, onDisk)
    assert.equal(onDisk.current, newer.current, 'the newer selection is preserved')
    assert.equal(onDisk.members[1].title, 'Renamed meanwhile', 'and the refresh is saved')
    // Two refreshes both migrating a legacy file: the second reconciles the first's record, no second election.
    const legacy = scaffoldCoordinator(root, { name: 'legacy', look: null })
    const oldRecord = JSON.parse(readFileSync(join(legacy, 'coordinator.json'), 'utf8'))
    delete oldRecord.sessions // Existing legacy files predate explicit empty membership on creation.
    writeFileSync(join(legacy, 'coordinator.json'), JSON.stringify(oldRecord))
    const migrated = { version: 1 as const, current: sessions.members[1].id, members: [sessions.members[1]] }
    updateCoordinatorSessions(legacy, (disk) => disk ?? migrated)
    const other = { ...migrated, current: sessions.members[0].id, members: [sessions.members[0]] }
    updateCoordinatorSessions(legacy, (disk) => { const base = disk ?? other; return reconcileSessions(base, rows) })
    assert.equal(readCoordinators(root).find((x) => x.key === 'legacy')!.sessions?.current, sessions.members[1].id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

/** Every own property, at any depth, that is undefined; Orca's panel bridge refuses such a result. */
function undefinedPaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => undefinedPaths(v, `${path}.${k}`))
}

test('every wake outcome is plain JSON with no undefined property, so the panel bridge accepts it', async () => {
  const outcomes = new Map<string, unknown>()
  const record = (r: { kind: string }) => { outcomes.set(r.kind, r); return r }
  const { rows, c } = fixture()
  record(await wakeCoordinator(c, rows, 2, wakeIo().io))
  const empty = rows.map((r) => ({ ...r, agents: [] }))
  record(await wakeCoordinator({ sessions: undefined }, empty, 0, wakeIo().io))
  const pick = await wakeCoordinator({ sessions: undefined }, empty, 0, wakeIo({ first: async () => firstProvider(null) }).io)
  record(pick)
  assert.deepEqual(wakeView(pick), { row: null, menu: null }, 'provider choice is not a failed wake or a history picker')
  record(await wakeCoordinator({ sessions: undefined }, empty, 0, wakeIo({ fresh: async () => ({ ok: false }) }).io))
  // The reported orca-flow: no sessions field and two open conversations in its folder.
  record(await wakeCoordinator({ sessions: undefined }, rows, 2, wakeIo().io))
  // Several members, none current: no current agent to carry.
  const none = fixture()
  const noneChoose = await wakeCoordinator({ sessions: { ...none.sessions, current: null } }, none.rows, 2, wakeIo().io)
  assert.equal(noneChoose.kind, 'choose')
  assert.deepEqual(undefinedPaths(noneChoose), [])
  // A resumable member without an agent type is never resumed; a codex one restores or fails.
  const closed = fixture()
  closed.sessions.members[1].resumeSessionId = 'native-codex-id'
  closed.rows[0].agents = closed.rows[0].agents.filter((a) => a.paneKey !== 'new:1')
  record(await wakeCoordinator(closed.c, closed.rows, 1, wakeIo({ binding: async () => ({ status: 'bound', workspaceId: closed.rows[0].id, agent: { ...closed.rows[0].agents[0], paneKey: 'resumed:1', orcaSession: 'resumed-orca', agentType: 'codex', terminal: 'term-resumed' } }) }).io))
  record(await wakeCoordinator(closed.c, closed.rows, 1, wakeIo({ resume: async () => { throw new Error('gone') } }).io))
  const busy = new Set(['home'])
  record(await exclusive(busy, 'home', () => wakeCoordinator(c, rows, 2, wakeIo().io), () => ({ ok: false, kind: 'busy' as const, error: 'A session change is already in progress.' })))
  assert.deepEqual([...outcomes.keys()].sort(), ['busy', 'choose', 'failed', 'opened', 'provider', 'restore-failed', 'resumed', 'started'])
  for (const [kind, r] of outcomes) {
    assert.deepEqual(undefinedPaths(r), [], `${kind} has no undefined property`)
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r, `${kind} round-trips through JSON unchanged`)
  }
})

test('a coordinator row never shows wake buttons or a reason: muted Sleeping, red only for a real failure', () => {
  const { rows, lineage, c } = fixture()
  rows[0].agents = rows[0].agents.filter((a) => a.paneKey !== 'new:1' && a.paneKey !== 'old:1')
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [c.dir])
  const snap = { rows: visible, coordinators, source: 'cli' as const, capacity: null }
  const rowOf = (html: string) => html.match(/<div class="item coord[^]*?<\/div>/)![0]
  const sleeping = rowOf(render(snap, emptyUi()).main)
  assert.match(sleeping, /<span class="r"><span class="rstatus sleeping">Sleeping<\/span><\/span>/)
  const outcomes = [
    { ok: false, kind: 'choose' as const, error: 'Its open conversations are not associated yet. Choose one in Sessions or start a new conversation.' },
    { ok: false, kind: 'restore-failed' as const, retryable: true, agent: 'codex', error: 'The previous conversation could not be restored: gone' },
    { ok: false, kind: 'failed' as const, error: 'The new conversation could not be started.' },
    { ok: false, kind: 'busy' as const },
    { ok: true, kind: 'started' as const }
  ]
  for (const r of outcomes) {
    const ui = emptyUi()
    const { row } = wakeView(r)
    if (row) ui.status.set('coordinator:home', row)
    const html = rowOf(render(snap, ui).main)
    assert.ok(!/data-wake|rstatus-act|<button[^>]*>(Retry|Start new|Sessions)</.test(html), `${r.kind}: no buttons on the row`)
    assert.ok(!html.includes('could not be restored') && !html.includes('not associated'), `${r.kind}: no reason on the row`)
    assert.equal(html.includes('rstatus bad'), r.kind === 'failed', `${r.kind}: red only for a real failure`)
    if (r.kind === 'choose' || r.kind === 'restore-failed') assert.match(html, />Sleeping</)
  }
})

// ---------- a background-launched coordinator conversation ----------

/** The 3d-print report: agent.launch returned a terminal with no tab (pty: placeholders, a recorded pane). */
function launched() {
  const { rows } = fixture()
  const row = { ...rows[0], agents: [] as typeof rows[0]['agents'] }
  const ptyId = 'folder:home@@79869e3a'
  const terminal = { handle: 'term_launched', ptyId, tabId: `pty:${ptyId}`, leafId: `pty:${ptyId}`, recordedPaneKey: 'tab-l:leaf-l', worktreePath: '/fixture/home' }
  const launch: Launch = { workspaceId: row.id, terminalId: ptyId, agent: 'claude' }
  const agent = { ...rows[0].agents[0], paneKey: 'tab-l:leaf-l', orcaSession: 'launched-session', agentType: 'claude', terminal: null, title: 'Coordinator', parentPane: null, dispatch: null }
  return { row, terminal, launch, agent }
}

test('a background-launched terminal is bound by its recorded pane once its agent appears', () => {
  const { row, terminal, launch, agent } = launched()
  assert.equal(terminalPane(terminal), 'tab-l:leaf-l', 'pty: placeholders are not a pane; the recorded pane is')
  assert.equal(terminalPane({ handle: 't', tabId: 'tab', leafId: 'leaf', recordedPaneKey: 'old:pane' }), 'tab:leaf', 'a terminal in a tab is its tab and leaf')
  // Starting: Orca does not list the agent yet, or lists it before its conversation id.
  assert.equal(launchedAgent(launch, [terminal], row), null)
  assert.equal(launchedAgent(launch, [terminal], { ...row, agents: [{ ...agent, orcaSession: null }] }), null)
  const appeared = { ...row, agents: [agent] }
  const a = launchedAgent(launch, [terminal], appeared)
  assert.equal(a?.paneKey, 'tab-l:leaf-l')
  assert.equal(a?.terminal, 'term_launched')
  const sessions = bindLaunched({ version: 1, current: null, members: [] }, appeared, a!, 'native-claude-id')
  assert.equal(sessions.members.length, 1)
  assert.equal(sessions.current, sessions.members[0].id)
  assert.equal(sessions.members[0].orcaSession, 'launched-session')
  assert.deepEqual(sessions.members[0].terminals, ['term_launched'])
  assert.equal(sessions.members[0].resumeSessionId, 'native-claude-id')
  // Binding it again (a refresh recorded it meanwhile) keeps one member.
  assert.equal(bindLaunched(sessions, appeared, a!).members.length, 1)
})

test('a launched terminal never binds a different, newer agent in the same folder', () => {
  const { row, terminal, launch, agent } = launched()
  const newer = { ...agent, paneKey: 'tab-n:leaf-n', orcaSession: 'newer-session', title: 'Someone else' }
  assert.equal(launchedAgent(launch, [terminal], { ...row, agents: [newer] }), null, 'the only agent there is not the launched one')
  const other = { ...terminal, handle: 'term_newer', ptyId: 'other-pty', recordedPaneKey: 'tab-n:leaf-n' }
  assert.equal(launchedAgent(launch, [other], { ...row, agents: [newer] }), null, 'the launched terminal is gone: nothing else is taken')
  assert.equal(launchedAgent(launch, [terminal, other], { ...row, agents: [newer, agent] })?.orcaSession, 'launched-session')
  assert.equal(launchedAgent({ ...launch, agent: 'codex' }, [terminal], { ...row, agents: [agent] }), null, 'a different provider in that pane is not it')
  assert.equal(launchedAgent(launch, [terminal], { ...row, agents: [{ ...agent, dispatch: 'open' }] }), null, 'a dispatched agent is never the coordinator')
})

test('while a launch is unbound, the next click adopts that same terminal and launches nothing', async () => {
  const { row, terminal, launch } = launched()
  const pending = new Map<string, Launch>()
  let launches = 0
  const start = () => launchOnce(pending, 'home', row.id, 'claude', async () => { launches++; return { terminalId: launch.terminalId } })
  const first = await start()
  assert.deepEqual([first.adopted, launches], [false, 1])
  // Binding unverified: the plan adopts instead of launching or asking, even with the agent now pickable.
  assert.deepEqual(wakePlan({ sessions: undefined }, [row], 1, pending.has('home')), { kind: 'adopt', agent: null })
  const fresh: string[] = []
  const r = await wakeCoordinator({ sessions: undefined }, [row], 1, wakeIo({ fresh: async (agent) => { fresh.push(agent); const again = await start(); return { ok: true, bound: !again.adopted } } }).io, true)
  assert.deepEqual(r, { ok: true, kind: 'starting' }, 'neutral, not red')
  assert.deepEqual(wakeView(r).row?.tone, 'ok')
  assert.equal(launches, 1, 'the second click launched nothing')
  assert.equal(pending.get('home')?.terminalId, launch.terminalId)
  // Settled once it is a member, or once its terminal is gone; only then may a later start launch.
  settlePending(pending, 'home', [terminal], { version: 1, current: null, members: [] })
  assert.ok(pending.has('home'), 'still running and unbound: kept')
  settlePending(pending, 'home', [terminal], { version: 1, current: 'm', members: [{ ...fixture().sessions.members[0], id: 'm', terminals: ['term_launched'] }] })
  assert.ok(!pending.has('home'), 'bound by membership: settled')
  await start()
  settlePending(pending, 'home', [], undefined)
  assert.ok(!pending.has('home'), 'terminal gone: settled')
  // A live current member still opens first; a pending launch never displaces it.
  const { rows, c } = fixture()
  assert.equal(wakePlan(c, rows, 2, true).kind, 'open')
})

test('a migrated live member gets its resume id from its exact terminal, then resumes that member once offline', () => {
  const { rows } = fixture()
  // Recorded by the single-unambiguous-root migration: memberFrom, no provider resume id.
  const a = rows[0].agents[0]
  const member = memberFrom(rows[0], a)
  let sessions: CoordinatorSessions | undefined = { version: 1, current: member.id, members: [member] }
  assert.equal(member.resumeSessionId, undefined)
  const terminals = [
    { handle: 'term-old:1', ptyId: 'pty-old', tabId: 'old', leafId: '1' },
    { handle: 'term-new:1', ptyId: 'pty-new', tabId: 'new', leafId: '1' }
  ]
  const listed = [
    { terminalId: 'pty-new', agent: 'claude', sessionId: 'someone-elses-id' },
    { terminalId: 'pty-old', agent: 'claude', sessionId: 'provider-claude-id' }
  ]
  const id = resumeIdFor(member, a.terminal, terminals, listed)
  assert.equal(id, 'provider-claude-id', 'read from the exact terminal, not another one in the folder')
  assert.notEqual(id, member.orcaSession, "Orca's conversation id is never the resume id")
  // Never guessed: another provider, a terminal now in another pane, an ambiguous listing, or Orca's own id.
  assert.equal(resumeIdFor(member, a.terminal, terminals, [{ terminalId: 'pty-old', agent: 'codex', sessionId: 'x' }]), undefined)
  assert.equal(resumeIdFor(member, a.terminal, [{ ...terminals[0], tabId: 'moved' }], listed), undefined)
  assert.equal(resumeIdFor(member, a.terminal, terminals, [...listed, { terminalId: 'pty-old', agent: 'claude', sessionId: 'other' }]), undefined)
  assert.equal(resumeIdFor(member, a.terminal, terminals, [{ terminalId: 'pty-old', agent: 'claude', sessionId: member.orcaSession }]), undefined)
  sessions = withResumeId(sessions, member.id, a.terminal!, id!)
  assert.equal(sessions?.members[0].resumeSessionId, 'provider-claude-id')
  assert.equal(sessions?.members[0].orcaSession, 'old-session', 'orcaSession is kept distinct')
  // Filled once: a later read does not replace it unless the member was just bound or resumed.
  assert.equal(withResumeId(sessions, member.id, a.terminal!, 'later')?.members[0].resumeSessionId, 'provider-claude-id')
  assert.equal(withResumeId(sessions, member.id, a.terminal!, 'later', true)?.members[0].resumeSessionId, 'later')
  assert.equal(withResumeId(sessions, member.id, 'term-other', 'x', true)?.members[0].resumeSessionId, 'provider-claude-id', 'only while bound to the terminal it was read from')
  // The coordinator sleeps: its terminal is gone. The click resumes exactly that member.
  const offline = rows.map((r) => ({ ...r, agents: r.agents.filter((x) => x.paneKey !== a.paneKey) }))
  const plan = wakePlan({ sessions }, offline, 1)
  assert.equal(plan.kind, 'resume')
  assert.equal(plan.kind === 'resume' && plan.member.id, member.id)
  assert.equal(plan.kind === 'resume' && plan.member.resumeSessionId, 'provider-claude-id')
})

// ---------- a resume the provider refused, exited from, or is still starting ----------

/** The reported orca-flow: its current Claude member's provider id was never saved (the session exited with no message). */
function sleepingClaude() {
  const { rows, sessions, c } = fixture('claude')
  sessions.members[1].resumeSessionId = 'f826b397-eb36-45be-95e4-c7166d5b828c'
  rows[0].agents = rows[0].agents.filter((a) => a.paneKey !== 'new:1')
  return { rows, sessions, c, id: sessions.members[1].resumeSessionId }
}

/** The dead resume terminal's rendered screen: the command, Claude's refusal, the shell prompt again. */
const refusedScreen = (id: string) => [
  'cagatayyucelen in orca/coordinators/orca-flow',
  "λ claude --plugin-dir '/Users/x/Library/Application Support/orca/claude-agent-view/4af4/orca-agent-view' --dangerously-skip-permissions",
  `'--resume' '${id}'`,
  `No conversation found with session ID: ${id}`,
  'cagatayyucelen in orca/coordinators/orca-flow took 2.2s',
  'λ',
  ''
]

test('the provider message is what it printed after the resume command, without the shell prompt', () => {
  const id = 'f826b397-eb36-45be-95e4-c7166d5b828c'
  const said = providerMessage(refusedScreen(id), id)
  assert.equal(said, `No conversation found with session ID: ${id}`)
  assert.ok(conversationMissing(said))
  assert.equal(providerMessage(['λ', 'λ ls'], id), null, 'the command is not on screen')
  assert.equal(providerMessage([`λ codex resume ${id}`, 'Error: rate limited, try again later', 'λ'], id), 'Error: rate limited, try again later')
  assert.ok(!conversationMissing('Error: rate limited, try again later'), 'a transient failure is not a missing conversation')
  for (const text of ['No conversation found with session ID: x', 'Error: session abc not found', 'No such session: x', 'Conversation x does not exist']) assert.ok(conversationMissing(text), text)
})

test('only the shell left in a terminal means its program exited; an agent child means it still runs', () => {
  // Orca's memory report gives the terminal's root (/usr/bin/login); the agent is the shell's child.
  const procs = parseProcs([
    '81444  1198 /usr/bin/login', '81445 81444 -/bin/zsh', '82059 81445 -/bin/zsh',
    '83478  1198 /usr/bin/login', '83479 83478 -/bin/zsh', '83835 83479 -/bin/zsh', '83884 83479 claude',
    '76503  1198 /usr/bin/login', '76504 76503 -/bin/zsh', '76943 76504 /Users/x/.nvm/versions/node/v24/lib/node_modules/@openai/codex/vendor/bin/codex'
  ].join('\n'))
  assert.equal(programRuns(81444, procs), false, 'the dead resume pane: login, zsh and a zsh prompt helper only')
  assert.equal(programRuns(83478, procs), true, 'claude runs')
  assert.equal(programRuns(76503, procs), true, 'codex runs')
  assert.equal(programRuns(99999, procs), null, 'unknown root: cannot say')
})

test('preflight: a Claude conversation with no transcript in any of Orca\'s config dirs is provably missing', () => {
  const id = 'f826b397-eb36-45be-95e4-c7166d5b828c'
  const fs: Record<string, string[]> = {
    '/p/home/projects': ['-Users-x-orca-coordinators-orca-flow'],
    '/p/home/projects/-Users-x-orca-coordinators-orca-flow': ['660f6dac.jsonl', '60e4c6a9.jsonl'],
    '/c/sessions': ['2026'], '/c/sessions/2026': ['11'], '/c/sessions/2026/11': ['19'], '/c/sessions/2026/11/19': [`rollout-2026-11-19T10-00-00-${id}.jsonl`]
  }
  const list = (dir: string) => fs[dir] ?? null
  assert.equal(conversationSaved('claude', id, ['/missing', '/p/home'], list), false)
  assert.equal(conversationSaved('claude', '660f6dac', ['/p/home'], list), true)
  assert.equal(conversationSaved('claude', id, ['/missing'], list), null, 'no readable store: cannot say')
  assert.equal(conversationSaved('codex', id, ['/c'], list), true)
  assert.equal(conversationSaved('codex', 'other', ['/c'], list), false)
  assert.equal(conversationSaved('gemini', id, ['/c'], list), null, 'a provider whose store is not known is never refused')
  assert.equal(conversationSaved('claude', '../x', ['/p/home'], list), null)
})

test('no transcript: restore-failed with Start new and no Retry, nothing launched, and the next click launches nothing either', async () => {
  const { rows, sessions, c, id } = sleepingClaude()
  const saves: CoordinatorSessions[] = []
  const { io, calls } = wakeIo({ saved: async () => false, save: (next) => { saves.push(next) } })
  const r = await wakeCoordinator(c, rows, 1, io)
  assert.equal(r.kind, 'restore-failed')
  assert.equal(r.retryable, false, 'Retry would fail the same way')
  assert.equal(r.agent, 'claude')
  assert.match(r.error!, /saved no conversation f826b397.*nothing to resume/)
  assert.equal(calls.resume.length + calls.fresh.length + calls.open.length, 0, 'agent.resume was never called')
  const view = wakeView(r)
  assert.equal(view.row, null, 'the row stays a neutral Sleeping')
  assert.deepEqual(view.menu, { header: "Couldn't restore the last conversation", reason: r.error, agent: 'claude', sessions: false, retry: false })
  // The refusal is remembered on the member (its provider id kept distinct from Orca's conversation id).
  assert.equal(saves.length, 1)
  const marked = saves[0].members[1]
  assert.deepEqual(marked.resumeRefused?.sessionId, id)
  assert.equal(marked.resumeSessionId, id)
  assert.equal(marked.orcaSession, sessions.members[1].orcaSession)
  // Second click: no preflight answer needed, nothing launched, the same reason.
  const second = wakeIo({ saved: async () => { throw new Error('not asked') } })
  const again = await wakeCoordinator({ sessions: saves[0] }, rows, 1, second.io)
  assert.equal(again.kind, 'restore-failed')
  assert.equal(again.retryable, false)
  assert.equal(second.calls.resume.length + second.calls.fresh.length, 0)
  // A newly recorded resume id makes the refusal stale.
  const renewed = { ...saves[0], members: saves[0].members.map((m, i) => i === 1 ? { ...m, resumeSessionId: 'new-provider-id' } : m) }
  assert.equal(wakePlan({ sessions: renewed }, rows, 1).kind, 'resume')
})

test('a provider that exited after agent.resume is restore-failed with its own message, not failed', async () => {
  const { rows, c, id } = sleepingClaude()
  const binding = async (): Promise<ResumeBinding> => ({ status: 'exited', detail: providerMessage(refusedScreen(id), id), terminal: 'term_07308cfa' })
  // agent.resume handed back the earlier idle shell (started: false), as in the report.
  const { io, calls } = wakeIo({ saved: async () => null, resume: async (input) => { calls.resume.push(input); return { terminalId: 'pty-f4c87192', started: false } }, binding })
  const r = await wakeCoordinator(c, rows, 1, io)
  assert.equal(r.kind, 'restore-failed')
  assert.equal(r.retryable, false)
  assert.match(r.error!, /Claude said: “No conversation found with session ID: f826b397-eb36-45be-95e4-c7166d5b828c”/)
  assert.match(r.error!, /handed back the terminal of an earlier attempt/)
  assert.ok(!/could not be verified/.test(r.error!))
  assert.deepEqual([r.workspaceId, r.terminal], ['folder:home', 'term_07308cfa'])
  assert.equal(calls.resume.length, 1)
  assert.equal(calls.fresh.length + calls.open.length, 0, 'nothing launched again, nothing opened')
  assert.equal(calls.save.length, 1, 'remembered as refused')
  assert.deepEqual(wakeView(r).menu?.terminal, { workspaceId: 'folder:home', terminal: 'term_07308cfa' }, 'Show terminal')
  // A transient exit is retryable.
  const transient = await wakeCoordinator(c, rows, 1, wakeIo({ binding: async () => ({ status: 'exited', detail: 'Error: rate limited, try again later', terminal: 't' }) }).io)
  assert.equal(transient.kind, 'restore-failed')
  assert.equal(transient.retryable, true)
  // Exited with nothing said (its terminal closed): retryable too.
  const silent = await wakeCoordinator(c, rows, 1, wakeIo({ binding: async () => ({ status: 'exited', detail: null }) }).io)
  assert.deepEqual([silent.kind, silent.retryable, silent.terminal], ['restore-failed', true, undefined])
  assert.match(silent.error!, /Claude exited before the conversation resumed/)
  // agent.resume itself failed: transient, retryable.
  const threw = await wakeCoordinator(c, rows, 1, wakeIo({ resume: async () => { throw new Error('timeout') } }).io)
  assert.deepEqual([threw.kind, threw.retryable], ['restore-failed', true])
})

test('a resume still running unbound is pending: the next click adopts that terminal with no second agent.resume', async () => {
  const { rows, sessions, c, id } = sleepingClaude()
  const pending = new Map<string, Launch>()
  const pend = (l: Launch | null) => { if (l) pending.set('home', l); else pending.delete('home') }
  const bindings: string[] = []
  const first = wakeIo({ pend, binding: async (terminal) => { bindings.push(terminal); return { status: 'running', terminal: 'term_resumed' } } })
  const r = await wakeCoordinator(c, rows, 1, first.io, pending.get('home') ?? false)
  assert.deepEqual([r.ok, r.kind], [true, 'starting'])
  assert.equal(first.calls.resume.length, 1)
  assert.deepEqual(pending.get('home'), { workspaceId: 'folder:home', terminalId: 'resumed-host-id', agent: 'claude', member: sessions.members[1].id, sessionId: id })
  assert.equal(wakePlan(c, rows, 1, pending.get('home')).kind, 'resume')
  // Start new is not the pending resume: it launches its own conversation.
  let launched = 0
  const startNew = await launchOnce(new Map(pending), 'home', 'folder:home', 'claude', async () => { launched++; return { terminalId: 'new' } })
  assert.deepEqual([startNew.adopted, launched], [false, 1])
  // Next click: the agent has appeared in that terminal; it is bound, not resumed again.
  const bound = { ...rows[0].agents[0], paneKey: 'resumed:1', orcaSession: 'resumed-orca', agentType: 'claude', terminal: 'term_resumed' }
  const second = wakeIo({ pend, binding: async (terminal) => { bindings.push(terminal); return { status: 'bound', workspaceId: 'folder:home', agent: bound, resumeSessionId: 'forked-provider-id' } } })
  const r2 = await wakeCoordinator(c, rows, 1, second.io, pending.get('home') ?? false)
  assert.deepEqual(r2, { ok: true, kind: 'resumed' })
  assert.equal(second.calls.resume.length, 0, 'no second agent.resume')
  assert.deepEqual(bindings, ['resumed-host-id', 'resumed-host-id'], 'the same terminal both times')
  assert.ok(!pending.has('home'), 'settled')
  const saved = second.calls.save[0].members[1]
  assert.equal(saved.id, sessions.members[1].id, 'the same member')
  assert.equal(saved.orcaSession, 'resumed-orca')
  assert.equal(saved.resumeSessionId, 'forked-provider-id', 'the provider id read again after binding')
  // Adopted and found exited: forgotten, so a later Retry may resume again.
  pending.set('home', { workspaceId: 'folder:home', terminalId: 'resumed-host-id', agent: 'claude', member: sessions.members[1].id, sessionId: id })
  const third = wakeIo({ pend, binding: async () => ({ status: 'exited', detail: 'Error: overloaded', terminal: 'term_resumed' }) })
  const r3 = await wakeCoordinator(c, rows, 1, third.io, pending.get('home') ?? false)
  assert.deepEqual([r3.kind, r3.retryable, third.calls.resume.length], ['restore-failed', true, 0])
  assert.ok(!pending.has('home'))
})

test('a refused member is resumed again only after a new provider id is recorded', async () => {
  const { sessions } = sleepingClaude()
  const marked = markRefused(sessions, sessions.current!, 'Claude said: “No conversation found”')
  let resumed = 0
  await assert.rejects(resumeExactMember(marked, marked.current!, { resume: async () => { resumed++; return { terminalId: 'x' } }, binding: async () => ({ status: 'running', terminal: 'x' }) }), (e: unknown) => e instanceof ResumeRefusedError && e.missing)
  assert.equal(resumed, 0)
})

test('Antigravity resume requires the exact live provider conversation before updating the member', async () => {
  const { rows, c, sessions } = fixture('antigravity')
  sessions.members[1].resumeSessionId = 'native-original'
  const agent = { ...rows[0].agents[1], orcaSession: 'resumed-session', terminal: 'term-resumed' }
  for (const id of [undefined, 'other', 'native-original']) {
    const { io, calls } = wakeIo({ binding: async () => ({ status: 'bound', workspaceId: rows[0].id, agent, resumeSessionId: id }) })
    const result = await wakeCoordinator(c, [], 0, io)
    assert.equal(result.ok, id === 'native-original')
    assert.equal(calls.save.length, id === 'native-original' ? 1 : 0)
    assert.deepEqual(calls.fresh, [])
  }
})

test('Antigravity checks the target host and fresh conversation before automatic selection', async () => {
  const { antigravityTurnRecorded, requireAntigravity } = await import('./antigravity.ts')
  for (const reply of [null, { agents: [{ id: 'gemini' }] }, { agents: [{ id: 'antigravity' }] }]) {
    const check = requireAntigravity('/fixture/home', async (args) => {
      assert.deepEqual(args, ['agent', 'installed', '--worktree', 'path:/fixture/home'])
      return reply
    })
    if (reply?.agents[0].id === 'antigravity') await check
    else await assert.rejects(check, /enabled Antigravity CLI/)
  }
  const h = { agent: 'antigravity', workspaceId: 'folder', sessionId: 'native', messageCount: 2, totalTokens: 100 }
  assert.equal(antigravityTurnRecorded([h], 'folder', 'native'), true)
  for (const history of [[], [h, h], [{ ...h, agent: 'gemini' }], [{ ...h, totalTokens: 0 }], [{ ...h, workspaceId: 'other' }], [{ ...h, sessionId: 'other' }]]) {
    assert.equal(antigravityTurnRecorded(history, 'folder', 'native'), false)
  }
})

test('a pending Antigravity terminal keeps its provider across wake and explicit fresh requests', async () => {
  const launch = { workspaceId: 'folder', terminalId: 'pty', agent: 'antigravity' }
  const pending = new Map([['home', launch]])
  assert.deepEqual(wakePlan({}, [], 0, launch), { kind: 'adopt', agent: 'antigravity' })
  const start = async () => { throw new Error('Should reuse the pending terminal') }
  await assert.rejects(launchOnce(pending, 'home', 'folder', 'codex', start), /different provider/)
  assert.deepEqual(await launchOnce(pending, 'home', 'folder', 'antigravity', start), { launch, adopted: true })
})

test('terminal launch supplies the Flow coordinator role and fails before host launch when unavailable', async () => {
  const { launchAntigravityCoordinator } = await import('./antigravity.ts')
  const calls: { workspaceId: string; agent: string; prompt: string }[] = []
  const start = (enabled: boolean, dir: string | null) => launchAntigravityCoordinator('folder', '/fixture/home', dir,
    async () => ({ agents: enabled ? [{ id: 'antigravity' }] : [] }),
    async (input) => { calls.push(input); return { terminalId: 'fixture-terminal' } })
  await assert.rejects(start(false, '/fixture/plugin'), /enabled Antigravity CLI/)
  await assert.rejects(start(true, null), /skill/)
  assert.equal(calls.length, 0)
  assert.deepEqual(await start(true, '/fixture/plugin'), { terminalId: 'fixture-terminal' })
  assert.equal(calls[0].workspaceId, 'folder')
  assert.equal(calls[0].agent, 'antigravity')
  assert.match(calls[0].prompt, /Your role: coordinator/)
  assert.match(calls[0].prompt, /\/fixture\/plugin\/skills\/orca-flow\/roles\/coordinator.md/)
  assert.match(calls[0].prompt, /coordinator.json/)
  assert.match(calls[0].prompt, /AGENTS.md/)
  assert.match(calls[0].prompt, /owned projects and scope/)
})
