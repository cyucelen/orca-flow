import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverTranscript, readTranscript, sourceCurrent } from './transcripts.ts'
import { currentSummaryJobs, digest, lastTurnEnd, summarizePane, summaryMatches, summaryProviders, turnSummarizer } from './summarize.ts'
import { createWriter, WriterError } from './writer.ts'
import { foldCoordinatorFolders, fromPs, summaryAgents } from './worker.ts'
import { currentRecipient, memberFrom, selectCurrent } from './coordinator-sessions.ts'
import type { Coordinator } from './protocol.ts'

const at = (n: number) => `2026-11-19T12:00:${String(n).padStart(2, '0')}.000Z`
const line = (r: unknown) => JSON.stringify(r)
const message = (role: string, value: string, n: number, channel?: string) => ({ type: 'response_item', timestamp: at(n), payload: { type: 'message', role, channel, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }] } })
const rollout = (id = 'native-one') => [
  { type: 'session_meta', payload: { id, cwd: '/synthetic/project' } },
  message('developer', 'Private system instructions', 0),
  message('user', '# AGENTS.md instructions for /synthetic\nBoilerplate', 1),
  message('user', '<environment_context>machine context</environment_context>', 2),
  message('user', 'You are a dispatched worker.\nYour task ID is: task_synthetic\nReport instructions\n=== TASK ===\nEnable guest checkout.', 3),
  { type: 'event_msg', timestamp: at(3), payload: { type: 'user_message', message: 'Duplicate echo' } },
  message('assistant', 'Private reasoning', 4, 'analysis'),
  message('assistant', 'Should we change unrelated settings?', 5, 'commentary'),
  { type: 'response_item', timestamp: at(6), payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'orca orchestration send --type worker_done --body synthetic' }) } },
  { type: 'response_item', timestamp: at(7), payload: { type: 'function_call_output', output: 'Private tool result' } },
  message('assistant', 'Checkout tests pass.', 8, 'final'),
  message('user', 'You have 1 orchestration message. Run `orca orchestration check`.', 9),
  { type: 'event_msg', timestamp: at(10), payload: { type: 'task_complete', turn_id: 'turn-one' } }
]
const card = { title: 'Guest checkout', about: 'Allow guests to buy.', goal: 'Enable guest checkout.', since: 'Checkout tests pass.', needs: { type: 'none', ask: '', options: [] }, glance: '', watching: '', effort: 'quick', priority: 'P1' }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'flow-transcripts-'))
  const path = join(dir, 'rollout.jsonl')
  writeFileSync(path, rollout().map(line).join('\n'))
  const files = { db: join(dir, 'hooks.db'), json: join(dir, 'hooks.json'), journal: join(dir, 'domain.db'), identities: join(dir, 'agent-identities.db') }
  const { DatabaseSync } = process.getBuiltinModule!('node:sqlite')
  const authority = new DatabaseSync(files.identities)
  authority.exec(`CREATE TABLE identities(orca_session_id TEXT PRIMARY KEY, agent TEXT, created_at INTEGER);
    CREATE TABLE provider_links(execution_host TEXT, wsl_distro TEXT, agent TEXT, provider_session_id TEXT, locator TEXT, orca_session_id TEXT);
    INSERT INTO identities VALUES ('orca-one', 'codex', 1);
    INSERT INTO provider_links VALUES ('local', '', 'codex', 'native-one', '', 'orca-one');`)
  authority.close()
  const bind = (id = 'native-one', orcaSessionId = 'orca-one') => writeFileSync(files.json, line({ entries: { pane: { paneKey: 'pane', orcaSessionId, payload: { agentType: 'codex' }, providerSession: { id, transcriptPath: path } } } }))
  bind()
  const identity = { orcaSession: 'orca-one', provider: 'codex', sessionId: 'native-one' }
  return { dir, path, files, bind, identity, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

function journal(f: ReturnType<typeof fixture>) {
  const { DatabaseSync } = process.getBuiltinModule!('node:sqlite')
  const db = new DatabaseSync(f.files.journal)
  db.exec(`CREATE TABLE agent_session_records(session_id TEXT PRIMARY KEY, record_json TEXT);
    CREATE TABLE journal_chat_state(session_id TEXT PRIMARY KEY, epoch TEXT);
    CREATE TABLE journal_items(session_id TEXT, epoch TEXT, hidden INTEGER, root INTEGER, subagent_row INTEGER, ordinal INTEGER, sequence INTEGER, sequence_index INTEGER, payload_json TEXT);`)
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('orca-chat', line({ sessionId: 'orca-chat', provider: 'codex', location: { executionHostId: 'local' }, providerHandleChain: [{ handle: { provider: 'codex', threadId: 'native-chat' } }] }))
  db.prepare('INSERT INTO journal_chat_state VALUES (?, ?)').run('orca-chat', 'current-epoch')
  const put = (body: unknown, n: number, opts: { session?: string; epoch?: string; hidden?: number; root?: number; child?: number } = {}) => db.prepare('INSERT INTO journal_items VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)').run(opts.session ?? 'orca-chat', opts.epoch ?? 'current-epoch', opts.hidden ?? 0, opts.root ?? 1, opts.child ?? 0, n, n, line({ itemId: `item-${n}`, revision: 1, observedAt: Date.parse(at(n)), body }))
  put({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Enable guest checkout.' }] }, 3)
  for (const [i, opts] of [{ hidden: 1 }, { root: 0 }, { child: 1 }, { session: 'other-chat' }, { epoch: 'old-epoch' }].entries()) put({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Wrong session or hidden text' }] }, i + 11, opts)
  put({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Checkout tests pass.' }], completedAt: Date.parse(at(8)) }, 8)
  put({ kind: 'turn', completedAt: Date.parse(at(10)), state: 'completed' }, 10)
  return db
}

test('Codex normalization keeps real task/final/turn end and excludes instructions, echoes, tool output and notices', () => {
  const d = digest(rollout().map(line))!
  assert.equal(d.firstPrompt, 'Enable guest checkout.')
  assert.equal(d.role, 'worker')
  assert.equal(d.lastMessage, 'Checkout tests pass.')
  assert.equal(d.turnAt, at(10))
  assert.equal(d.reported, true)
  assert.ok(!JSON.stringify(d).includes('Private'))
  assert.ok(!JSON.stringify(d).includes('Duplicate echo'))
  assert.ok(!d.turn.includes('Report instructions'))
  const commentary = digest(rollout().filter((r: any) => r.payload?.channel !== 'final').map(line))!
  assert.equal(commentary.lastMessage, '', 'commentary questions do not become final asks')
  const phases = rollout().map((r: any) => r.payload?.channel ? { ...r, payload: { ...r.payload, channel: undefined, phase: r.payload.channel === 'final' ? 'final_answer' : r.payload.channel } } : r)
  assert.equal(digest(phases.map(line))!.lastMessage, 'Checkout tests pass.')
})

test('older Codex event-only rollouts and Claude transcripts retain their latest turn', () => {
  const older = digest([
    { type: 'event_msg', timestamp: at(1), payload: { type: 'user_message', message: 'Fix checkout' } },
    { type: 'event_msg', timestamp: at(2), payload: { type: 'agent_message', message: 'Fixed it.' } },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'turn_complete' } }
  ].map(line))!
  assert.equal(older.firstPrompt, 'Fix checkout'); assert.equal(older.lastMessage, 'Fixed it.')
  const claude = digest([
    { type: 'user', timestamp: at(1), message: { content: 'Fix checkout' } },
    { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'text', text: 'Fixed it.' }] } },
    { type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', content: 'not a prompt' }] } }
  ].map(line))!
  assert.equal(claude.firstPrompt, older.firstPrompt); assert.equal(claude.lastMessage, older.lastMessage)
})

test('terminal binding requires native ID, Orca ID and provider independently; session switches invalidate in-flight work', async () => {
  const f = fixture()
  try {
    const found = discoverTranscript('pane', f.files, f.identity)
    assert.equal(found.path, f.path)
    if (!found.path) throw Error('missing fixture')
    assert.equal(lastTurnEnd(found.path), Date.parse(at(10)))
    for (const identity of [{ ...f.identity, sessionId: 'orca-one' }, { ...f.identity, orcaSession: 'other-orca' }, { ...f.identity, provider: 'claude' }]) assert.equal(discoverTranscript('pane', f.files, identity).path, null)
    const before = readFileSync(f.path, 'utf8')
    assert.equal(await summarizePane({ pane: 'pane', transcript: found.path, transcriptSource: found.source, dir: f.dir, writer: async () => { f.bind('native-two', 'orca-two'); return card } }), 'skipped')
    assert.equal(readFileSync(f.path, 'utf8'), before)
    assert.equal(sourceCurrent(found.source!), false)
  } finally { f.dispose() }
})

test('structured Codex chats use exact Orca record/native handle/current epoch and visible root items', () => {
  const f = fixture(), db = journal(f)
  try {
    const identity = { orcaSession: 'orca-chat', provider: 'codex', sessionId: 'native-chat' }
    const found = discoverTranscript('chat-pane', f.files, identity)
    assert.equal(found.path, f.files.journal)
    if (!found.path) throw Error('missing fixture')
    const d = digest(readTranscript(found.path, found.source))!
    assert.equal(d.firstPrompt, 'Enable guest checkout.'); assert.equal(d.lastMessage, 'Checkout tests pass.')
    assert.ok(!JSON.stringify(d).includes('Wrong session'))
    assert.equal(lastTurnEnd(found.path, undefined, found.source), Date.parse(at(10)))
    assert.equal(discoverTranscript('chat-pane', f.files, { ...identity, sessionId: 'orca-chat' }).path, null)
    assert.equal(discoverTranscript('chat-pane', f.files, { ...identity, provider: 'claude' }).path, null)
    db.prepare('UPDATE journal_chat_state SET epoch = ?').run('replacement')
    assert.equal(sourceCurrent(found.source!), false)
    assert.throws(() => readTranscript(found.path, found.source))
  } finally { db.close(); f.dispose() }
})

test('both Codex sources publish validated fallback cards, preserve on failure and recover primary', async () => {
  for (const kind of ['terminal', 'chat']) {
    const f = fixture(), db = kind === 'chat' ? journal(f) : null
    const identity = kind === 'chat' ? { orcaSession: 'orca-chat', provider: 'codex', sessionId: 'native-chat' } : f.identity
    const pane = kind === 'chat' ? 'chat-pane' : 'pane'
    let healthy = false, now = 1
    const writer = createWriter({ now: () => now, ...summaryProviders({ haiku: async () => { if (!healthy) throw new WriterError('haiku', 'quota'); return { ...card, title: 'Recovered title' } }, luna: async () => card }) })
    const found = discoverTranscript(pane, f.files, identity)
    if (!found.path) throw Error('missing fixture')
    const input = { pane, transcript: found.path, transcriptSource: found.source, dir: f.dir, writer }
    const queue = turnSummarizer({ run: (job) => summarizePane({ ...job, dir: f.dir, writer }) })
    try {
      await queue.enqueue(input)
      const path = join(f.dir, `${pane}.json`), saved = readFileSync(path, 'utf8')
      const value = JSON.parse(saved)
      assert.equal(value.title, card.title); assert.equal(value.providerSession.id, identity.sessionId); assert.equal(value.orcaSession, identity.orcaSession)
      assert.equal(await summarizePane(input), 'skipped')
      await assert.rejects(summarizePane({ ...input, force: true, writer: async () => ({ title: 'Invalid' }) }))
      assert.equal(readFileSync(path, 'utf8'), saved)
      healthy = true; now += 300_001
      assert.equal(await summarizePane({ ...input, force: true }), 'written')
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).title, 'Recovered title')
    } finally { queue.dispose(); db?.close(); f.dispose() }
  }
})

test('idle missing Codex cards bootstrap; current discovery replaces cached paths and rejects old session cards in sidebar', () => {
  const f = fixture()
  try {
    const find = (pane: string, identity: any) => discoverTranscript(pane, f.files, identity)
    const agent = { pane: 'pane', state: 'done', identity: f.identity }
    const absent = currentSummaryJobs({}, [agent, agent], find)
    assert.equal(absent.length, 1); assert.equal(absent[0].transcript, f.path)
    assert.equal(currentSummaryJobs({}, [{ ...agent, state: 'working' }], find).length, 0)
    const old = { ...card, role: 'solo' as const, updatedAt: Date.now(), summarizer: 8, orcaSession: 'other-orca', providerSession: { provider: 'codex', id: 'other-native' }, transcript: '/old-session' }
    assert.equal(currentSummaryJobs({ pane: old }, [agent], find)[0].transcript, f.path)
    assert.equal(summaryMatches(old, f.identity), false)
    const rows = fromPs([{ identity: { key: 'workspace' }, agents: [{ paneKey: 'pane', state: 'done', agentType: 'codex', orcaSessionId: 'orca-one' }] }], { cards: {}, summaries: { pane: old as any } })
    assert.equal(rows[0].agents[0].summary, null)
    assert.equal(summaryMatches({ updatedAt: 1 }, { provider: 'claude' }), true)
  } finally { f.dispose() }
})

test('chat metadata loss or provider replacement fails closed instead of falling back to a terminal in the same pane', () => {
  const f = fixture(), db = journal(f)
  try {
    const identity = { orcaSession: 'orca-chat', provider: 'codex', sessionId: 'native-chat' }
    const found = discoverTranscript('pane', f.files, identity)
    assert.ok(found.path && found.source)
    db.prepare('UPDATE agent_session_records SET record_json = ? WHERE session_id = ?').run(line({ sessionId: 'orca-chat', provider: 'codex', location: { executionHostId: 'local' }, providerHandleChain: [{ handle: { provider: 'codex', threadId: 'replacement-native' } }] }), 'orca-chat')
    assert.equal(discoverTranscript('pane', f.files, identity).path, null)
    if (found.path) assert.equal(sourceCurrent(found.source!), false)
    db.exec('DELETE FROM journal_chat_state')
    assert.equal(discoverTranscript('pane', f.files, { orcaSession: 'orca-chat', provider: 'codex' }).path, null)
    assert.equal(discoverTranscript('pane', { ...f.files, journal: join(f.dir, 'none') }, { provider: 'claude' }).path, null)
  } finally { db.close(); f.dispose() }
})

test('status native IDs participate in deduplication and a resumed working turn cancels its pending summary', async () => {
  const sessions: (string | undefined)[] = [], runs: string[] = []
  const queue = turnSummarizer({ delayMs: 5, retryMs: [], findTranscript: (pane, identity) => { sessions.push(identity?.sessionId); return { path: pane } }, run: async (job) => { runs.push(job.pane) } })
  try {
    const end = { paneKey: 'pane', workspaceId: 'workspace', state: 'done', mainAgent: { state: 'done', stateStartedAt: 10 } }
    queue.onStatus({ ...end, sessionId: 'one' })
    queue.onStatus({ ...end, state: 'working', mainAgent: { state: 'working', stateStartedAt: 11 }, sessionId: 'one' })
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(runs.length, 0)
    queue.onStatus({ ...end, sessionId: 'two' })
    await new Promise((r) => setTimeout(r, 15))
    assert.deepEqual(sessions, ['two'])
    assert.deepEqual(runs, ['pane'])
  } finally { queue.dispose() }
})

test('a replaced chat epoch supersedes an old card even when retained history has earlier timestamps', async () => {
  const f = fixture(), db = journal(f)
  try {
    const identity = { orcaSession: 'orca-chat', provider: 'codex', sessionId: 'native-chat' }
    const found = discoverTranscript('chat-pane', f.files, identity)
    if (!found.path) throw Error('missing fixture')
    const path = join(f.dir, 'chat-pane.json')
    writeFileSync(path, line({ ...card, transcript: found.path, transcriptSource: { ...found.source, epoch: 'old-epoch' }, orcaSession: identity.orcaSession, providerSession: found.source?.providerSession, turnAt: at(59), updatedAt: Date.now(), summarizer: 8 }))
    const jobs = currentSummaryJobs({ 'chat-pane': JSON.parse(readFileSync(path, 'utf8')) }, [{ pane: 'chat-pane', state: 'done', identity }], (pane, id) => discoverTranscript(pane, f.files, id))
    assert.equal(jobs.length, 1)
    assert.equal(await summarizePane({ ...jobs[0], dir: f.dir, writer: async () => card }), 'written')
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).transcriptSource.epoch, 'current-epoch')
  } finally { db.close(); f.dispose() }
})

test('a background bootstrap queued behind an event publication does not regenerate the same turn', async () => {
  const f = fixture()
  try {
    const [job] = currentSummaryJobs({}, [{ pane: 'pane', state: 'done', identity: f.identity }], (pane, id) => discoverTranscript(pane, f.files, id))
    let calls = 0
    const writer = async () => { calls++; return card }
    assert.equal(await summarizePane({ ...job, refresh: false, dir: f.dir, writer }), 'written')
    assert.equal(await summarizePane({ ...job, dir: f.dir, writer }), 'skipped')
    assert.equal(calls, 1)
  } finally { f.dispose() }
})

// Actual terminal hooks omit orcaSessionId; the independent identity authority must supply it.
function withoutHookOrcaId(f: ReturnType<typeof fixture>) {
  const hooks = JSON.parse(readFileSync(f.files.json, 'utf8'))
  delete hooks.entries.pane.orcaSessionId
  writeFileSync(f.files.json, line(hooks))
}

test('a reused pane cannot relabel a stale unbound hook with the new live Orca session', async () => {
  const f = fixture()
  try {
    withoutHookOrcaId(f)
    const current = discoverTranscript('pane', f.files, { orcaSession: 'orca-one', provider: 'codex' })
    if (!current.path) throw Error('missing fixture')
    assert.equal(current.source?.orcaSession, 'orca-one', 'authority verifies the binding without a hook Orca id or caller native id')
    const replacement = { orcaSession: 'orca-two', provider: 'codex' }
    assert.equal(discoverTranscript('pane', f.files, replacement).path, null)
    assert.equal(discoverTranscript('pane', f.files, { ...replacement, sessionId: 'native-one' }).path, null, 'even a stale status native ID cannot override the authority')
    assert.equal(currentSummaryJobs({}, [{ pane: 'pane', state: 'done', identity: replacement }], (pane, id) => discoverTranscript(pane, f.files, id)).length, 0)
    // A previously persisted source from the vulnerable code must also fail the publication gate.
    const mislabeled = { ...current.source!, orcaSession: 'orca-two' }
    assert.equal(sourceCurrent(mislabeled), false)
    const saved = line({ ...card, orcaSession: 'orca-one', providerSession: { provider: 'codex', id: 'native-one' } })
    writeFileSync(join(f.dir, 'pane.json'), saved)
    let calls = 0
    await assert.rejects(summarizePane({ pane: 'pane', transcript: f.path, transcriptSource: mislabeled, dir: f.dir, writer: async () => { calls++; return card } }))
    assert.equal(calls, 0)
    assert.equal(readFileSync(join(f.dir, 'pane.json'), 'utf8'), saved)
  } finally { f.dispose() }
})

test('missing, ambiguous, foreign-namespace or contradictory native links fail closed', () => {
  const changes = [
    'DELETE FROM provider_links',
    "UPDATE provider_links SET orca_session_id = 'other-orca'",
    "UPDATE provider_links SET provider_session_id = 'other-native'",
    "UPDATE provider_links SET agent = 'claude'",
    "UPDATE provider_links SET execution_host = 'remote'",
    "UPDATE provider_links SET wsl_distro = 'Ubuntu'",
    "UPDATE provider_links SET locator = '/unrelated-transcript'",
    "UPDATE identities SET agent = 'claude'",
    'DELETE FROM identities',
    "INSERT INTO provider_links VALUES ('local', '', 'codex', 'native-one', '', 'other-orca')",
    'DROP TABLE provider_links'
  ]
  for (const change of changes) {
    const f = fixture()
    try {
      withoutHookOrcaId(f)
      const found = discoverTranscript('pane', f.files, f.identity)
      if (!found.path) throw Error('missing fixture')
      const db = new (process.getBuiltinModule!('node:sqlite').DatabaseSync)(f.files.identities)
      db.exec(change); db.close()
      assert.equal(discoverTranscript('pane', f.files, { orcaSession: 'orca-one', provider: 'codex' }).path, null, change)
      assert.equal(sourceCurrent(found.source!), false, change)
    } finally { f.dispose() }
  }
  const f = fixture()
  try {
    const found = discoverTranscript('pane', f.files, f.identity)
    if (!found.path) throw Error('missing fixture')
    rmSync(f.files.identities)
    assert.equal(discoverTranscript('pane', f.files, f.identity).path, null, 'an explicit hook Orca id is not a substitute for the authority')
    assert.equal(sourceCurrent(found.source!), false)
    assert.equal(sourceCurrent({ ...found.source!, binding: undefined }), false)
  } finally { f.dispose() }
})

test('identity authority is rechecked after inference, including sources saved without the identities path', async () => {
  const f = fixture()
  try {
    withoutHookOrcaId(f)
    const found = discoverTranscript('pane', f.files, { orcaSession: 'orca-one', provider: 'codex' })
    if (!found.path) throw Error('missing fixture')
    const source = { ...found.source!, binding: { ...found.source!.binding!, files: { db: f.files.db, json: f.files.json } } }
    assert.equal(sourceCurrent(source), true, 'older sources locate the authority beside their hook DB')
    const path = join(f.dir, 'pane.json'), saved = line({ ...card, title: 'Keep existing title' })
    writeFileSync(path, saved)
    const result = await summarizePane({ pane: 'pane', transcript: found.path, transcriptSource: source, dir: f.dir, writer: async () => {
      const db = new (process.getBuiltinModule!('node:sqlite').DatabaseSync)(f.files.identities)
      db.exec('DELETE FROM provider_links'); db.close()
      return card
    } })
    assert.equal(result, 'skipped')
    assert.equal(readFileSync(path, 'utf8'), saved)
  } finally { f.dispose() }
})

test('legacy Claude reading remains available without inventing an Orca identity', () => {
  const f = fixture()
  try {
    writeFileSync(f.path, [
      { type: 'user', timestamp: at(1), message: { content: 'Fix checkout' } },
      { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'text', text: 'Fixed.' }] } }
    ].map(line).join('\n'))
    writeFileSync(f.files.json, line({ entries: { pane: { paneKey: 'pane', providerSession: { transcriptPath: f.path } } } }))
    rmSync(f.files.identities)
    const found = discoverTranscript('pane', f.files)
    assert.deepEqual(found, { path: f.path })
    assert.equal(digest(readTranscript(found.path!))?.lastMessage, 'Fixed.')
    assert.equal(discoverTranscript('pane', f.files, { orcaSession: 'orca-new' }).path, null)
    // A native-ID-only legacy record can still be read, but cannot claim a live Orca identity.
    writeFileSync(f.files.json, line({ entries: { pane: { paneKey: 'pane', payload: { agentType: 'claude' }, providerSession: { id: 'native-claude', transcriptPath: f.path } } } }))
    const native = discoverTranscript('pane', f.files, { provider: 'claude', sessionId: 'native-claude' })
    assert.equal(native.path, f.path)
    if (native.path) assert.equal(native.source?.orcaSession, undefined)
    assert.equal(discoverTranscript('pane', f.files, { provider: 'claude', orcaSession: 'orca-new', sessionId: 'native-claude' }).path, null)
  } finally { f.dispose() }
})

test('integrated non-current Codex member publishes fallback summary without changing the selected Claude recipient', async () => {
  const f = fixture()
  try {
    const rows = fromPs([{ path: '/synthetic/coordinator', liveTerminalCount: 2, agents: [
      { paneKey: 'selected-claude', agentType: 'claude', orcaSessionId: 'orca-claude', state: 'waiting', hasLivePty: true },
      { paneKey: 'pane', agentType: 'codex', orcaSessionId: 'orca-one', state: 'done', hasLivePty: true }
    ] }], { cards: {}, summaries: {} }, new Map([['/synthetic/coordinator', 'folder:synthetic']]))
    rows[0].agents.forEach((a) => { a.terminal = `terminal-${a.paneKey}` })
    const members = rows[0].agents.map((a) => memberFrom(rows[0], a))
    members[1].resumeSessionId = 'native-one'
    const c: Coordinator = { key: 'synthetic', name: 'Synthetic', repos: [], workspaceId: rows[0].id, sessions: { version: 1, current: members[0].id, members } }
    const coordinators = [c]
    const visible = foldCoordinatorFolders(rows, coordinators, ['/synthetic/coordinator'])
    assert.equal(visible.length, 0, 'both coordinator members are removed from ordinary rows')
    const snapshot = { rows: visible, coordinators }
    const before = JSON.stringify(c.sessions)
    const targets = summaryAgents(snapshot).map(({ agent, worktreeId }) => ({ pane: agent.paneKey, state: agent.state, worktreeId, identity: { orcaSession: agent.orcaSession, provider: agent.agentType } }))
    const jobs = currentSummaryJobs({}, targets, (pane, identity) => discoverTranscript(pane, f.files, identity))
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].pane, 'pane')
    assert.equal(jobs[0].transcriptSource?.orcaSession, 'orca-one')
    assert.equal(jobs[0].transcriptSource?.providerSession?.id, 'native-one')
    const writer = createWriter(summaryProviders({ haiku: async () => { throw new WriterError('haiku', 'quota') }, luna: async () => card }))
    const queue = turnSummarizer({ run: (job) => summarizePane({ ...job, dir: f.dir, writer, isCurrent: () => summaryAgents(snapshot).some(({ agent }) => agent.paneKey === job.pane && agent.orcaSession === job.transcriptSource?.orcaSession) }) })
    try { await queue.enqueue(jobs[0]) } finally { queue.dispose() }
    const saved = JSON.parse(readFileSync(join(f.dir, 'pane.json'), 'utf8'))
    assert.equal(saved.title, card.title)
    assert.equal(saved.orcaSession, 'orca-one')
    assert.equal(saved.providerSession.id, 'native-one')
    assert.equal(JSON.stringify(c.sessions), before)
    assert.equal(currentRecipient(c, rows).agent.paneKey, 'selected-claude')
    c.sessions = selectCurrent(c.sessions!, members[1].id)
    foldCoordinatorFolders(rows, coordinators, ['/synthetic/coordinator'])
    assert.equal(currentRecipient(c, rows).agent.paneKey, 'pane')
    assert.equal(summaryAgents(snapshot).length, 2, 'current selection does not govern summary eligibility')
  } finally { f.dispose() }
})

test('Antigravity terminal transcripts discover via deterministic brain path, verify identity authority, normalize steps, and restore sidebar titles', async () => {
  const f = fixture()
  try {
    const agyHome = join(f.dir, 'agy-home')
    const nativeId = '11111111-2222-3333-4444-555555555555'
    const logs = join(agyHome, 'brain', nativeId, '.system_generated', 'logs')
    const compact = join(logs, 'transcript.jsonl')
    const transcript = join(logs, 'transcript_full.jsonl')
    mkdirSync(logs, { recursive: true })
    writeFileSync(compact, line({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: at(2), truncated_fields: ['content'], content: '<USER_REQUEST>\nYou are a dispatched worker.' }))
    writeFileSync(transcript, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: at(1), content: '<CONTEXT_SUMMARY>\nCompacted history\n</CONTEXT_SUMMARY>' },
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', created_at: at(2), content: '<USER_REQUEST>\nYou are a dispatched worker.\nYour task ID is: task_a096a50992e8\n=== TASK ===\nFast-forward clean main checkouts.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(4), thinking: 'Private reasoning', content: '', tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify('orca orchestration send --type worker_done --body done') } }] },
      { step_index: 3, type: 'GENERIC', status: 'DONE', created_at: at(5), content: 'Private tool output' },
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(8), thinking: 'Private final reasoning', content: 'Fast-forwarded main cleanly.', tool_calls: [] }
    ].map(line).join('\n'))
    const db = new (process.getBuiltinModule!('node:sqlite').DatabaseSync)(f.files.identities)
    db.exec(`INSERT INTO identities VALUES ('orca-agy', 'antigravity', 1);
      INSERT INTO provider_links VALUES ('local', '', 'antigravity', '${nativeId}', '', 'orca-agy');`)
    db.close()
    writeFileSync(f.files.json, line({ entries: { 'agy-pane': { paneKey: 'agy-pane', payload: { agentType: 'antigravity' }, providerSession: { key: 'conversation_id', id: nativeId } } } }))
    const files = { ...f.files, antigravityHome: agyHome }
    const identity = { orcaSession: 'orca-agy', provider: 'antigravity', sessionId: nativeId }
    const found = discoverTranscript('agy-pane', files, identity)
    assert.equal(found.path, transcript)
    if (!found.path) throw Error('missing Antigravity transcript')
    assert.equal(sourceCurrent(found.source!), true)
    assert.equal(lastTurnEnd(found.path, undefined, found.source), Date.parse(at(8)))
    const d = digest(readTranscript(found.path, found.source))!
    assert.equal(d.firstPrompt, 'Fast-forward clean main checkouts.')
    assert.equal(d.role, 'worker')
    assert.equal(d.reported, true)
    assert.equal(d.lastMessage, 'Fast-forwarded main cleanly.')
    assert.ok(!JSON.stringify(d).includes('Private'))
    assert.ok(!JSON.stringify(d).includes('Compacted history'))
    // Path traversal IDs fail closed.
    writeFileSync(f.files.json, line({ entries: { 'bad-pane': { paneKey: 'bad-pane', payload: { agentType: 'antigravity' }, providerSession: { id: '../escape' } } } }))
    assert.equal(discoverTranscript('bad-pane', files, { provider: 'antigravity' }).path, null)
    // Restores the hook and publishes a verified card so a settled worker does not fall back to the branch name "main".
    writeFileSync(f.files.json, line({ entries: { 'agy-pane': { paneKey: 'agy-pane', payload: { agentType: 'antigravity' }, providerSession: { key: 'conversation_id', id: nativeId } } } }))
    assert.equal(await summarizePane({ pane: 'agy-pane', transcript: found.path, transcriptSource: found.source, dir: f.dir, writer: async () => ({ ...card, title: 'Main checkout maintenance' }) }), 'written')
    const saved = JSON.parse(readFileSync(join(f.dir, 'agy-pane.json'), 'utf8'))
    assert.equal(summaryMatches(saved, identity), true)
    assert.equal(summaryMatches({ ...saved, providerSession: undefined }, identity), false, 'Antigravity cards require a verified binding')
    const rows = fromPs([{ identity: { key: 'wt-main' }, displayName: 'main', branch: 'refs/heads/main', agents: [{ paneKey: 'agy-pane', state: 'done', agentType: 'antigravity', orcaSessionId: 'orca-agy', conversationName: 'worker-task_a096a50992e8' }] }], { cards: {}, summaries: { 'agy-pane': saved } })
    assert.equal(rows[0].agents[0].title, 'Main checkout maintenance')
  } finally { f.dispose() }
})

test('structured Antigravity ACP chats resolve via agent/nativeId handles in the journal', () => {
  const f = fixture(), db = journal(f)
  try {
    db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('orca-agy-chat', line({
      sessionId: 'orca-agy-chat',
      provider: 'antigravity',
      location: { executionHostId: 'local' },
      providerHandleChain: [{ handle: { transport: 'acp', agent: 'antigravity', nativeId: 'native-agy-chat' } }]
    }))
    db.prepare('INSERT INTO journal_chat_state VALUES (?, ?)').run('orca-agy-chat', 'agy-epoch')
    db.prepare('INSERT INTO journal_items VALUES (?, ?, 0, 1, 0, 1, 1, 0, ?)').run('orca-agy-chat', 'agy-epoch', line({ itemId: 'i-1', observedAt: Date.parse(at(1)), body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Summarize Antigravity chat.' }] } }))
    db.prepare('INSERT INTO journal_items VALUES (?, ?, 0, 1, 0, 2, 2, 0, ?)').run('orca-agy-chat', 'agy-epoch', line({ itemId: 'i-2', observedAt: Date.parse(at(4)), body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Summary ready.' }], completedAt: Date.parse(at(4)) } }))
    db.prepare('INSERT INTO journal_items VALUES (?, ?, 0, 1, 0, 3, 3, 0, ?)').run('orca-agy-chat', 'agy-epoch', line({ itemId: 'i-3', observedAt: Date.parse(at(5)), body: { kind: 'turn', completedAt: Date.parse(at(5)), state: 'completed' } }))
    const identity = { orcaSession: 'orca-agy-chat', provider: 'antigravity', sessionId: 'native-agy-chat' }
    const found = discoverTranscript('agy-chat-pane', f.files, identity)
    assert.equal(found.path, f.files.journal)
    if (!found.path) throw Error('missing Antigravity journal')
    const d = digest(readTranscript(found.path, found.source))!
    assert.equal(d.firstPrompt, 'Summarize Antigravity chat.')
    assert.equal(d.lastMessage, 'Summary ready.')
    assert.equal(lastTurnEnd(found.path, undefined, found.source), Date.parse(at(5)))
  } finally { db.close(); f.dispose() }
})
