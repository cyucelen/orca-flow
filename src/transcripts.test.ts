import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverTranscript, readTranscript, sourceCurrent } from './transcripts.ts'
import { currentSummaryJobs, digest, lastTurnEnd, summarizePane, summaryMatches, summaryProviders, turnSummarizer } from './summarize.ts'
import { createWriter, WriterError } from './writer.ts'
import { fromPs } from './worker.ts'

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
  const files = { db: join(dir, 'hooks.db'), json: join(dir, 'hooks.json'), journal: join(dir, 'domain.db') }
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
