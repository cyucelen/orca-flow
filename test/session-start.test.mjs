// node --test test/*.test.mjs
// The lead role survives resume and compaction: the role store (roles.mjs), `orca-flow role`, the
// SessionStart hook (session-start.mjs) and the Stop hook's gate reading the same record.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPTS = fileURLToPath(new URL('../skills/orca-flow/scripts/', import.meta.url))
const SESSION = '84196301-b61d-4e26-959e-3c41bd84fa1f'

const entry = (type, content, extra = {}) => JSON.stringify({ type, sessionId: SESSION, message: { role: type, content }, ...extra })
/** The provider-costs shape: a design worker's preamble, no role line. */
const WORKER_PREAMBLE = [
  'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.',
  'Your task ID is: task_275091af6331',
  '=== TASK ===',
  'Design the admin cost analytics page.'
].join('\n')
const LEAD_PROMPT = 'You are working inside Orca. Your task ID is: task_1\nYour role: lead. Own the cost analytics workstream.'

/** A transcript compacted twice: the summary after each boundary lacks the role line. */
const compacted = (first) => [
  entry('user', first),
  entry('assistant', [{ type: 'text', text: 'On it.' }]),
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: SESSION, compactMetadata: { trigger: 'auto' } }),
  entry('user', 'This session is being continued from a previous conversation. Summary: the user steers the cost page.', { isCompactSummary: true }),
  entry('assistant', [{ type: 'text', text: 'Continuing.' }])
].join('\n')

/** A temp home with the skill linked like the plugin links it, a worktree, a coordinator folder and a transcript. */
function world({ firstPrompt = WORKER_PREAMBLE } = {}) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'session-start-'))
  const data = join(home, '.orca-flow')
  mkdirSync(data)
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  symlinkSync(join(SCRIPTS, '..'), join(home, '.claude', 'skills', 'orca-flow'))
  const worktree = join(home, 'w', 'web-app', 'admin-cost-analytics')
  mkdirSync(worktree, { recursive: true })
  mkdirSync(join(home, 'orca', 'coordinators', 'bounti'), { recursive: true })
  const transcript = join(home, 't.jsonl')
  writeFileSync(transcript, compacted(firstPrompt))
  return { home, data, worktree, transcript, skill: join(home, '.claude', 'skills', 'orca-flow') }
}

const run = (w, name, { input, env = {}, args = [], cwd } = {}) => {
  const r = spawnSync(process.execPath, [join(w.skill, 'scripts', name), ...args], {
    input,
    cwd,
    env: { PATH: process.env.PATH, HOME: w.home, ...env },
    encoding: 'utf8'
  })
  return r
}

/** Runs the SessionStart hook; its parsed output, or null when it printed nothing. */
function start(w, input = {}, env = { ORCA_AGENT_PANE: 'tab:1' }) {
  const r = run(w, 'session-start.mjs', {
    input: JSON.stringify({ session_id: SESSION, transcript_path: w.transcript, cwd: w.worktree, hook_event_name: 'SessionStart', source: 'resume', ...input }),
    env
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  return r.stdout ? JSON.parse(r.stdout) : null
}

const record = (w, session = SESSION, role = 'lead') =>
  writeFileSync(join(w.data, 'roles.json'), JSON.stringify({ [session]: { role, at: '2026-11-21T21:27:00Z', by: 'user' } }))

/** The bootstrap names the role, both files through the skill link, and the workstream rule. */
function assertBootstrap(w, out) {
  assert.ok(out, 'a bootstrap')
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  const text = out.hookSpecificOutput.additionalContext
  assert.match(text, /^Your role: lead\./m)
  assert.ok(text.includes(join(w.skill, 'SKILL.md')), 'SKILL.md through the skill link')
  assert.ok(text.includes(join(w.skill, 'roles', 'lead.md')), 'roles/lead.md through the skill link')
  assert.match(text, /worker_done .*whole workstream/)
}

// ---------- SessionStart ----------

test('session start: a lead by its role line gets the bootstrap on resume and on compact', () => {
  const w = world({ firstPrompt: LEAD_PROMPT })
  assertBootstrap(w, start(w, { source: 'resume' }))
  const compact = start(w, { source: 'compact' })
  assertBootstrap(w, compact)
  assert.doesNotMatch(readFileSync(w.transcript, 'utf8').split('\n').at(-2), /your role: lead/i, 'the compact summary lacks the role line')
  assert.equal(start(w, { source: 'startup' }), null, 'a fresh start reads its role line in its own prompt')
  rmSync(w.home, { recursive: true })
})

test('session start: a recorded lead whose first prompt is a worker preamble gets the bootstrap; without the record nothing', () => {
  const w = world()
  for (const source of ['resume', 'compact', 'startup']) assert.equal(start(w, { source }), null, `no record: nothing on ${source}`)
  record(w)
  for (const source of ['resume', 'compact', 'startup']) assertBootstrap(w, start(w, { source }))
  assert.equal(start(w, { session_id: 'another-session' }), null, 'another session is not recorded')
  rmSync(w.home, { recursive: true })
})

test('session start: coordinators, plain workers, solo chats and cleared records get nothing', () => {
  const coordinator = world({ firstPrompt: 'hello' })
  record(coordinator)
  assert.equal(start(coordinator, { cwd: join(coordinator.home, 'orca', 'coordinators', 'bounti') }), null, 'a coordinator folder, even recorded')
  assert.equal(start(coordinator, { cwd: join(coordinator.home, 'orca', 'coordinators', 'bounti'), source: 'compact' }), null)
  rmSync(coordinator.home, { recursive: true })

  const worker = world()
  for (const source of ['resume', 'compact']) assert.equal(start(worker, { source }), null, `a plain worker on ${source}`)
  rmSync(worker.home, { recursive: true })

  const solo = world({ firstPrompt: 'fix the flaky checkout test' })
  for (const source of ['resume', 'compact', 'startup']) assert.equal(start(solo, { source }), null, `a solo chat on ${source}`)
  rmSync(solo.home, { recursive: true })

  const cleared = world()
  record(cleared)
  assertBootstrap(cleared, start(cleared))
  const r = run(cleared, 'orca-flow.mjs', { args: ['role', 'clear'], env: { CLAUDE_CODE_SESSION_ID: SESSION }, cwd: cleared.worktree })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(start(cleared), null, 'cleared')
  rmSync(cleared.home, { recursive: true })
})

test('session start: no Orca pane, an unreadable transcript, a /clear, bad input: nothing, exit 0', () => {
  const w = world({ firstPrompt: LEAD_PROMPT })
  assert.equal(start(w, {}, {}), null, 'not in an Orca pane')
  assert.equal(start(w, { transcript_path: join(w.home, 'missing.jsonl') }), null, 'unreadable transcript')
  assert.equal(start(w, { transcript_path: w.home }), null, 'a folder, not a transcript')
  assert.equal(start(w, { source: 'clear' }), null, '/clear starts a new conversation')
  writeFileSync(join(w.data, 'roles.json'), '{broken')
  assertBootstrap(w, start(w), 'a broken store does not hide the role line')
  for (const input of ['not json', '', 'null']) {
    const r = run(w, 'session-start.mjs', { input, env: { ORCA_AGENT_PANE: 'x' } })
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `input ${JSON.stringify(input)}`)
  }
  rmSync(w.home, { recursive: true })
})

// ---------- the Stop hook's gate ----------

test('stop hook gate: a recorded lead is a lead; the same worker without a record is not checked', async () => {
  const { gate } = await import('../skills/orca-flow/scripts/stop-check.mjs')
  const w = world()
  writeFileSync(join(w.data, 'config.json'), JSON.stringify({ messageFormat: 'all' }))
  const input = { session_id: SESSION, transcript_path: w.transcript, cwd: w.worktree }
  const env = { ORCA_AGENT_PANE: 'tab:1', ORCA_FLOW_DIR: w.data }
  assert.equal(gate(input, { env, home: w.home }), null, 'a worker with no record')
  record(w)
  assert.equal(gate(input, { env, home: w.home })?.role, 'lead')
  assert.equal(gate({ ...input, session_id: 'other' }, { env, home: w.home }), null, 'only that session')
  assert.equal(gate({ ...input, cwd: join(w.home, 'orca', 'coordinators', 'bounti') }, { env, home: w.home })?.role, 'coordinator', 'the folder decides')
  // Through the real hook: the recorded lead's unframed message is blocked.
  const r = run(w, 'stop-check.mjs', { input: JSON.stringify({ ...input, stop_hook_active: false, last_assistant_message: 'Done.' }), env })
  assert.equal(JSON.parse(r.stdout).decision, 'block')
  rmSync(w.home, { recursive: true })
})

// ---------- orca-flow role ----------

test('orca-flow role lead records this Claude session; clear removes it', () => {
  const w = world()
  const role = (args, env = { CLAUDE_CODE_SESSION_ID: SESSION }, cwd = w.worktree) => run(w, 'orca-flow.mjs', { args: ['role', ...args], env, cwd })
  const store = () => JSON.parse(readFileSync(join(w.data, 'roles.json'), 'utf8'))

  let r = role(['lead'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /lead/)
  const saved = store()[SESSION]
  assert.deepEqual({ ...saved, at: typeof saved.at }, { role: 'lead', at: 'string', by: 'user', cwd: w.worktree })
  assert.equal(role(['lead']).status, 0, 'again: still one record')
  assert.deepEqual(Object.keys(store()), [SESSION])

  r = role(['clear'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(store(), {})
  assert.equal(role(['clear']).status, 0, 'clearing nothing is fine')

  assert.notEqual(role(['coordinator']).status, 0, 'only lead and clear')
  assert.notEqual(role([]).status, 0)

  r = role(['lead'], { CLAUDE_CODE_SESSION_ID: SESSION }, join(w.home, 'orca', 'coordinators', 'bounti'))
  assert.notEqual(r.status, 0, 'a coordinator folder is the coordinator')
  assert.deepEqual(store(), {})

  r = role(['lead'], {})
  assert.notEqual(r.status, 0, 'outside Claude Code there is no session to record')
  assert.match(r.stderr, /Claude Code/)

  // ORCA_FLOW_DIR moves the store.
  const elsewhere = join(w.home, 'elsewhere')
  assert.equal(role(['lead'], { CLAUDE_CODE_SESSION_ID: 'abc', ORCA_FLOW_DIR: elsewhere }).status, 0)
  assert.equal(JSON.parse(readFileSync(join(elsewhere, 'roles.json'), 'utf8')).abc.role, 'lead')
  rmSync(w.home, { recursive: true })
})

test('orca-flow role lead: inside Claude Code without a session id, the newest transcript for this folder', () => {
  const w = world()
  const config = join(w.home, 'profile')
  const project = join(config, 'projects', w.worktree.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'newest.jsonl'), '')
  writeFileSync(join(project, 'older.jsonl'), '')
  const past = new Date(Date.now() - 60_000)
  utimesSync(join(project, 'older.jsonl'), past, past)
  const r = run(w, 'orca-flow.mjs', { args: ['role', 'lead'], env: { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: config }, cwd: w.worktree })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(w.data, 'roles.json'), 'utf8'))), ['newest'])
  assert.ok(!existsSync(join(w.home, '.claude', 'projects')), 'nothing written into the profile')
  rmSync(w.home, { recursive: true })
})

test('the first prompt is read only as far as it, across chunk boundaries and multi-byte text', async () => {
  const { firstPromptOf } = await import('../skills/orca-flow/scripts/stop-check.mjs')
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'first-prompt-'))
  const file = join(dir, 't.jsonl')
  // Meta lines first, a first prompt longer than one 64 KB chunk with a character split across chunks, then later turns.
  const long = `${'ü'.repeat(40_000)} Your role: lead. Ship it.`
  writeFileSync(file, [JSON.stringify({ type: 'permission-mode' }), entry('user', [{ type: 'tool_result', content: 'x' }]), entry('user', long), entry('user', 'later')].join('\n'))
  assert.equal(firstPromptOf(file), long)
  writeFileSync(file, entry('user', 'only line, no newline'))
  assert.equal(firstPromptOf(file), 'only line, no newline')
  assert.equal(firstPromptOf(join(dir, 'missing')), '')
  assert.equal(firstPromptOf(undefined), '')
  rmSync(dir, { recursive: true })
})
