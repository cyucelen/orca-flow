// node --test test/*.test.mjs
// The PreToolUse delegation hook (delegation-check.mjs): coordinators and leads send implementation
// and parallel work to Orca workers; native subagents only for read-only lookups or when the user
// asks. Most tests run the script as Claude Code does: hook JSON on stdin, decision JSON on stdout.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { asksForSubagent, latestPrompt, latestPromptInfo, realPrompt } from '../skills/orca-flow/scripts/delegation-check.mjs'

const SCRIPTS = fileURLToPath(new URL('../skills/orca-flow/scripts/', import.meta.url))
const SESSION = '5b0d6a52-3f0e-4c1e-9d5e-2f6c0c3c9a11'

const PREAMBLE = [
  'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.',
  'Do only this task, yourself: no subagents or helper workers unless the task asks.',
  'Your task ID is: task_1',
  '=== TASK ==='
].join('\n')
const LEAD = `${PREAMBLE}\nYour role: lead. Own the checkout workstream.`
const WORKER = `${PREAMBLE}\nAdd an empty state to the cart panel, with a test.`

const user = (content, extra = {}) => JSON.stringify({ type: 'user', sessionId: SESSION, message: { role: 'user', content }, ...extra })
const said = (text) => JSON.stringify({ type: 'assistant', sessionId: SESSION, message: { role: 'assistant', content: [{ type: 'text', text }] } })

/** A temp home with the skill linked like the plugin links it, a worktree, a coordinator folder and a transcript. */
function world(lines = [user(LEAD), said('On it.')]) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'delegation-'))
  const data = join(home, '.orca-flow')
  mkdirSync(data)
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  symlinkSync(join(SCRIPTS, '..'), join(home, '.claude', 'skills', 'orca-flow'))
  const worktree = join(home, 'w', 'shop', 'checkout')
  mkdirSync(worktree, { recursive: true })
  const coordinator = join(home, 'orca', 'coordinators', 'shop')
  mkdirSync(coordinator, { recursive: true })
  const transcript = join(home, 't.jsonl')
  writeFileSync(transcript, lines.join('\n'))
  return { home, data, worktree, coordinator, transcript, skill: join(home, '.claude', 'skills', 'orca-flow') }
}

/** Runs the hook as Claude Code does. Its parsed output, or null when it printed nothing (allowed). */
function hook(w, toolInput = { description: 'Build the cart', prompt: '...', subagent_type: 'general-purpose' }, { input = {}, env = { ORCA_AGENT_PANE: 'tab:1' }, raw } = {}) {
  const stdin = raw ?? JSON.stringify({
    session_id: SESSION, transcript_path: w.transcript, cwd: w.worktree, hook_event_name: 'PreToolUse',
    permission_mode: 'bypassPermissions', tool_name: 'Agent', tool_input: toolInput, ...input
  })
  const r = spawnSync(process.execPath, [join(w.skill, 'scripts', 'delegation-check.mjs')], {
    input: stdin,
    env: { PATH: process.env.PATH, HOME: w.home, ...env },
    encoding: 'utf8'
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  return r.stdout ? JSON.parse(r.stdout) : null
}

const log = (w) => (existsSync(join(w.data, 'delegation.jsonl')) ? readFileSync(join(w.data, 'delegation.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])

/** A deny in Claude Code's PreToolUse format, pointing at dispatch and plan through the skill link. */
function assertDeny(w, out, role = 'lead') {
  assert.ok(out, 'a decision')
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput'])
  const { hookEventName, permissionDecision, permissionDecisionReason: reason } = out.hookSpecificOutput
  assert.equal(hookEventName, 'PreToolUse')
  assert.equal(permissionDecision, 'deny')
  const cli = join(w.skill, 'scripts', 'orca-flow.mjs')
  assert.ok(reason.includes(`node "${cli}" dispatch --role worker --kind simple|normal|hard --worktree current --task-title "<outcome>" --spec-file -`), reason)
  assert.ok(reason.includes(`node "${cli}" plan start <plan.json>`), reason)
  assert.match(reason, /queue the task or tell the user the blocker/)
  assert.match(reason, /Do not run it as a native subagent/)
  assert.ok(reason.includes(`you are a ${role}`), reason)
}

test('a lead is denied general-purpose (also unnamed) and fork, under both tool names; Explore is allowed', () => {
  const w = world()
  assertDeny(w, hook(w))
  assertDeny(w, hook(w, { description: 'Refactor totals', prompt: '...' }))
  assertDeny(w, hook(w, { description: 'Split the work', prompt: '...', subagent_type: 'fork' }))
  assertDeny(w, hook(w, { description: 'Old name', prompt: '...', subagent_type: 'general-purpose' }, { input: { tool_name: 'Task' } }))
  for (const type of ['Explore', 'Plan', 'claude-code-guide', 'web-fetch', 'statusline-setup']) {
    assert.equal(hook(w, { description: 'Find the cart code', prompt: '...', subagent_type: type }), null, type)
  }
  const entries = log(w)
  assert.equal(entries.length, 4, 'one log line per deny, none for allowed calls')
  assert.deepEqual(Object.keys(entries[0]), ['at', 'session', 'role', 'subagentType', 'description'])
  assert.deepEqual(entries.map((e) => [e.session, e.role, e.subagentType, e.description]), [
    [SESSION, 'lead', 'general-purpose', 'Build the cart'],
    [SESSION, 'lead', 'general-purpose', 'Refactor totals'],
    [SESSION, 'lead', 'fork', 'Split the work'],
    [SESSION, 'lead', 'general-purpose', 'Old name']
  ])
})

test('a coordinator (by its folder) and a recorded lead are denied too', () => {
  const w = world([user('what is next?')])
  assertDeny(w, hook(w, undefined, { input: { cwd: w.coordinator } }), 'coordinator')
  assert.equal(hook(w), null, 'a chat the user started in a worktree, before any record')
  writeFileSync(join(w.data, 'roles.json'), JSON.stringify({ [SESSION]: { role: 'lead', at: '2026-11-22T10:00:00Z', by: 'user' } }))
  assertDeny(w, hook(w))
})

test('a worker, a solo chat outside Orca and every other tool are left alone', () => {
  const worker = world([user(WORKER), said('On it.')])
  assert.equal(hook(worker), null, 'a dispatched worker')
  const lead = world()
  assert.equal(hook(lead, undefined, { env: {} }), null, 'no Orca pane')
  assert.equal(hook(lead, { command: 'rm -rf build' }, { input: { tool_name: 'Bash' } }), null, 'another tool')
  assert.deepEqual([...log(worker), ...log(lead)], [])
})

test('the user\'s latest real prompt asking for a subagent allows any type; Orca\'s preamble and older asks do not', () => {
  const ask = world([user(LEAD), said('On it.'), user('Use a subagent to draft the migration.'), said('Starting.')])
  assert.equal(hook(ask), null, 'explicit ask')
  assert.equal(hook(ask, { description: 'Fork it', prompt: '...', subagent_type: 'fork' }), null)

  for (const text of ['spin up sub-agents for both pages', 'use the Agent tool for this', 'a native agent is fine here', 'two sub agents please']) {
    const w = world([user(LEAD), user(text)])
    assert.equal(hook(w), null, text)
  }

  // A newer prompt without the ask, after the agent answered it: denied again.
  const older = world([user(LEAD), user('Use a subagent to draft it.'), said('Done.'), user('now fix the totals')])
  assertDeny(older, hook(older))
  // Negated, Orca's preamble alone, a skill body or a task notification that names the Agent tool: denied.
  for (const lines of [
    [user(LEAD), user("don't use subagents, just get it done")],
    [user(LEAD)],
    [user(LEAD), user([{ type: 'text', text: 'Base directory for this skill: ...\n- **Claude subagent (Agent tool):** only read-only lookups' }], { isMeta: true })],
    [user(LEAD), user('<task-notification>\nsubagent finished</task-notification>', { origin: { kind: 'task-notification' }, promptSource: 'system' })],
    [user(LEAD), user('\nYou have 1 orchestration message. Run `orca orchestration check`.')]
  ]) {
    const w = world(lines)
    assertDeny(w, hook(w))
  }
})

const COMMAND = (name, args = '') => `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`

test('a slash command or skill the user ran allows any subagent type, the way a plain ask does', () => {
  // Claude Code records /review as a <command-name> tag, not as the words "subagent".
  const review = world([user(LEAD), said('On it.'), user(COMMAND('/review', 'the cart panel')), said('Starting.')])
  assert.equal(hook(review), null, '/review, a recorded command')
  assert.equal(hook(review, { description: 'Review a file', prompt: '...', subagent_type: 'fork' }), null, 'fork under /review')

  // A typed "/code-review" prompt, with no tag, counts too.
  const typed = world([user(LEAD), user('/code-review --max-findings 5')])
  assert.equal(hook(typed), null, 'a prompt that starts with "/"')

  // A dispatch whose TASK text starts with "/" is still the coordinator's word, not the user's command.
  const dispatched = world([user(`${PREAMBLE}\nYour role: lead. Own the checkout workstream.\n=== TASK ===\n/review the cart`)])
  assertDeny(dispatched, hook(dispatched))

  // Plain text after the command is what counts: the latest prompt decides, not an older one.
  const after = world([user(LEAD), user(COMMAND('/review')), said('Done.'), user('now fix the totals')])
  assertDeny(after, hook(after))
  // A plain prompt is denied even when it names the review.
  const plain = world([user(LEAD), user('review the cart code and split it up')])
  assertDeny(plain, hook(plain))
})

test('a path typed first is not a slash command; a command word is, with or without arguments', () => {
  const path = world([user(LEAD), user('/Users/x/y.ts fix this')])
  assertDeny(path, hook(path), 'lead')
  const review = world([user(LEAD), user('/review')])
  assert.equal(hook(review), null, '/review')
  const withArgs = world([user(LEAD), user('/code-review high')])
  assert.equal(hook(withArgs), null, '/code-review high')
})

test('an unreadable transcript allows the call, even for a lead or a coordinator', () => {
  const lead = world()
  writeFileSync(join(lead.data, 'roles.json'), JSON.stringify({ [SESSION]: { role: 'lead', at: '2026-11-22T10:00:00Z', by: 'user' } }))
  assert.equal(hook(lead, undefined, { input: { transcript_path: join(lead.home, 'missing.jsonl') } }), null, 'lead, missing transcript')
  assert.equal(hook(lead, undefined, { input: { transcript_path: lead.home } }), null, 'lead, transcript is a directory')
  const coordinator = world()
  assert.equal(hook(coordinator, undefined, { input: { cwd: coordinator.coordinator, transcript_path: join(coordinator.home, 'missing.jsonl') } }), null, 'coordinator, missing transcript')
  assert.deepEqual([...log(lead), ...log(coordinator)], [], 'no deny is logged')
})

test('"delegationCheck": "off" turns it off; any other value keeps it on', () => {
  const w = world()
  writeFileSync(join(w.data, 'config.json'), JSON.stringify({ delegationCheck: 'off', messageFormat: 'all' }))
  assert.equal(hook(w), null)
  writeFileSync(join(w.data, 'config.json'), JSON.stringify({ delegationCheck: 'on' }))
  assertDeny(w, hook(w))
  writeFileSync(join(w.data, 'config.json'), '{ broken')
  assertDeny(w, hook(w), 'lead')
})

test('garbage input, a missing transcript or a broken tool_input allows the call, silently', () => {
  const w = world()
  for (const raw of ['', 'not json', 'null', '[]', '42', '{"tool_name":"Agent"}']) assert.equal(hook(w, undefined, { raw }), null, raw)
  assert.equal(hook(w, undefined, { input: { transcript_path: join(w.home, 'missing.jsonl') } }), null, 'no transcript: no role, allowed')
  // A broken tool_input still names no read-only type: a lead is denied, nothing crashes.
  assertDeny(w, hook(w, 'garbage'))
})

test('realPrompt and latestPrompt read only what the user typed, the TASK block of a dispatch prompt', () => {
  assert.equal(realPrompt(JSON.parse(user(LEAD))), 'Your role: lead. Own the checkout workstream.')
  assert.equal(realPrompt(JSON.parse(user([{ type: 'tool_result', content: 'use a subagent' }]))), null)
  assert.equal(realPrompt(JSON.parse(user('summary', { isCompactSummary: true }))), null)
  assert.equal(realPrompt(JSON.parse(user('<system-reminder>x</system-reminder>'))), null)
  assert.equal(latestPrompt([user('first'), said('ok'), user('second'), said('ok'), 'garbage'].join('\n')), 'second')
  assert.equal(latestPrompt(''), '')
  assert.deepEqual(latestPromptInfo(''), { text: '', command: false })
  assert.deepEqual(latestPromptInfo([user(LEAD), user(COMMAND('/review', 'x'))].join('\n')), { text: COMMAND('/review', 'x'), command: true })
  assert.deepEqual(latestPromptInfo([user(LEAD), user('plain ask')].join('\n')), { text: 'plain ask', command: false })
  assert.equal(asksForSubagent('Do only this task, yourself: no subagents or helper workers unless the task asks.'), false)
  assert.equal(asksForSubagent('please use a subagent'), true)
  assert.equal(asksForSubagent('never use subagents. Use a subagent for the docs though.'), true, 'the second sentence asks')
  assert.equal(asksForSubagent(null), false)
})
