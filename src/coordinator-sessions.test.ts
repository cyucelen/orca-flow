import { assert, test } from 'orca/testing'
import { associateSession, askKey, chooseSession, currentRecipient, deliverCurrent, deliveryReceipt, DeliveryUncertainError, deliveryBlock, memberAgent, memberFrom, readMemberHistory, reconcileSessions, selectCurrent, sessionChoices, sessionKey, validSessions } from './coordinator-sessions.ts'
import { assignCoordinators, coordinatorSession, readCoordinators, scaffoldCoordinator, writeCoordinatorSessions } from './coordinators.ts'
import { foldCoordinatorFolders, fromPs, openAgent } from './worker.ts'
import { askingRows, emptyUi, render } from './view.ts'
import type { Coordinator, CoordinatorSessions } from './protocol.ts'

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
  for (const provider of ['claude', 'codex']) {
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
  const { resumeExactMember } = await import('./coordinator-sessions.ts')
  const { rows, sessions } = fixture()
  sessions.members[1].resumeSessionId = 'native-codex-id'
  const calls: unknown[] = []
  const io = {
    resume: async (input: unknown) => { calls.push(input); return { terminalId: 'resumed-host-id' } },
    binding: async () => ({ workspaceId: rows[0].id, agent: { ...rows[0].agents[1], paneKey: 'resumed:1', orcaSession: 'new-orca-binding', terminal: 'term-resumed' } })
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
  for (const provider of ['claude', 'codex']) {
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
  assert.match(trigger, /Choose the main conversation/)
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
