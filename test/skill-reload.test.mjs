// node --test test/*.test.mjs
// Skill reload, the hooks' half: the request store (skill-reload.mjs), the note each hook gives
// (only to targeted sessions, once per request, role-aware), and `orca-flow skills-reloaded`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { activeFile, CONFIRM_WINDOW_MS, confirmCommandOf, confirmFromToolCall, confirmReload, deliverReload, readRequests, reloadStatus, reloadText, RELOAD_TTL_MS, skillHash, syncActive, writeRequest } from '../skills/orca-flow/scripts/skill-reload.mjs'
import { targetRole } from '../skills/orca-flow/scripts/reload-check.mjs'

const SCRIPTS = fileURLToPath(new URL('../skills/orca-flow/scripts/', import.meta.url))
const LEAD_SESSION = '11111111-2222-4333-8444-555555555555'

/** A temp home: the skill linked like the plugin links it (a copy, so a test can change it), a worktree and a coordinator folder. */
function world() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'skill-reload-'))
  const data = join(home, '.orca-flow')
  mkdirSync(data)
  const plugin = join(home, 'plugin', 'skills', 'orca-flow')
  mkdirSync(join(plugin, 'roles'), { recursive: true })
  // The real scripts, through a link, so the hooks run as installed; the markdown is ours to change.
  symlinkSync(SCRIPTS, join(plugin, 'scripts'))
  writeFileSync(join(plugin, 'SKILL.md'), 'End replies with PINEAPPLE.\n')
  for (const r of ['coordinator', 'lead', 'worker']) writeFileSync(join(plugin, 'roles', `${r}.md`), `${r} rules\n`)
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  symlinkSync(plugin, join(home, '.claude', 'skills', 'orca-flow'))
  const worktree = join(home, 'w', 'shop')
  mkdirSync(worktree, { recursive: true })
  mkdirSync(join(home, 'orca', 'coordinators', 'alpha'), { recursive: true })
  return { home, data, plugin, worktree, skill: join(home, '.claude', 'skills', 'orca-flow') }
}

const targets = [
  { pane: 'tab:lead', session: LEAD_SESSION, role: 'lead', provider: 'claude', supported: true, title: 'Checkout' },
  { pane: 'tab:worker', session: null, role: 'worker', provider: 'claude', supported: true, title: 'Fix test' },
  { pane: 'tab:coord', session: null, role: 'coordinator', provider: 'claude', supported: true, title: 'alpha' },
  { pane: 'tab:codex', session: null, role: 'worker', provider: 'codex', supported: false, title: 'Codex worker' }
]

const hook = (w, name, input, pane) => {
  const r = spawnSync(process.execPath, [join(w.skill, 'scripts', name)], {
    input: JSON.stringify(input),
    env: { PATH: process.env.PATH, HOME: w.home, ...(pane ? { ORCA_AGENT_PANE: pane } : {}) },
    encoding: 'utf8'
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim() ? JSON.parse(r.stdout) : null
}

test('a request is stored per pane with the hash and expiry; a newer one replaces it, expired ones go', () => {
  const w = world()
  try {
    const hash = skillHash(w.skill)
    assert.match(hash, /^[0-9a-f]{16}$/)
    assert.equal(skillHash(w.plugin), hash, 'through the link, the files it points at')
    writeRequest(w.data, targets, { hash, scope: 'coordinator:alpha', now: 1000, id: 'r1' })
    const stored = readRequests(w.data, 1000)
    assert.deepEqual(Object.keys(stored), ['tab:lead', 'tab:worker', 'tab:coord', 'tab:codex'])
    assert.deepEqual(stored['tab:lead'], { request: 'r1', at: 1000, expiresAt: 1000 + RELOAD_TTL_MS, hash, scope: 'coordinator:alpha', role: 'lead', session: LEAD_SESSION, provider: 'claude', supported: true, title: 'Checkout' })
    assert.ok(existsSync(activeFile(w.data)), 'the PostToolUse gate is open while a note waits')
    writeRequest(w.data, [targets[1]], { hash: 'h2', scope: 'all', now: 2000, id: 'r2' })
    assert.equal(readRequests(w.data, 2000)['tab:worker'].request, 'r2', 'the newer request replaces the older one for that pane')
    assert.equal(readRequests(w.data, 2000)['tab:lead'].request, 'r1', 'other panes keep theirs')
    assert.deepEqual(Object.keys(readRequests(w.data, 1000 + RELOAD_TTL_MS)), ['tab:worker'], 'expired requests are gone')
    assert.equal(syncActive(w.data, 3000 + RELOAD_TTL_MS), false)
    assert.ok(!existsSync(activeFile(w.data)), 'and the gate closes')
    // A broken file reads as no requests.
    writeFileSync(join(w.data, 'skill-reload', 'requests.json'), '{nope')
    assert.deepEqual(readRequests(w.data), {})
  } finally { rmSync(w.home, { recursive: true }) }
})

test('only a targeted session gets the note, only once per request, and not a subagent', () => {
  const w = world()
  try {
    writeRequest(w.data, targets, { hash: skillHash(w.skill), scope: 'all', now: 1000, id: 'r1' })
    const opts = (pane) => ({ event: 'PostToolUse', pane, data: w.data, skill: w.skill, now: 2000 })
    assert.equal(deliverReload({ session_id: 'other' }, opts('tab:someone-else')), null, 'an untargeted pane gets nothing')
    assert.equal(deliverReload({ session_id: 'x' }, opts('tab:codex')), null, 'an unsupported target gets nothing')
    assert.equal(deliverReload({ session_id: 'x', agent_id: 'sub-1' }, opts('tab:worker')), null, 'a subagent\'s tool call gets nothing')
    const note = deliverReload({ session_id: 'x' }, opts('tab:worker'))
    assert.match(note, /request r1/)
    assert.equal(deliverReload({ session_id: 'x' }, opts('tab:worker')), null, 'given once')
    assert.equal(deliverReload({ session_id: 'x' }, { ...opts('tab:worker'), event: 'UserPromptSubmit' }), null, 'once across hooks too')
    // By session when the pane changed (resumed in another terminal).
    assert.match(deliverReload({ session_id: LEAD_SESSION }, opts('tab:new-pane')), /roles\/lead\.md \(your role: lead\)/)
    assert.equal(deliverReload({ session_id: LEAD_SESSION }, opts('tab:lead')), null, 'the lead had it')
    assert.ok(existsSync(activeFile(w.data)), 'the coordinator still waits')
    assert.ok(deliverReload({ session_id: 'c' }, opts('tab:coord')))
    assert.ok(existsSync(activeFile(w.data)), 'all delivered, none confirmed: the gate stays open so the hook can record confirmations')
    assert.equal(syncActive(w.data, 2000 + CONFIRM_WINDOW_MS), false, 'after the confirmation window it closes')
    assert.ok(!existsSync(activeFile(w.data)))
    // A newer request gives the note again.
    writeRequest(w.data, [targets[1]], { hash: skillHash(w.skill), scope: 'all', now: 3000, id: 'r2' })
    assert.match(deliverReload({ session_id: 'x' }, { ...opts('tab:worker'), now: 3001 }), /request r2/)
  } finally { rmSync(w.home, { recursive: true }) }
})

test('the note is role-aware and keeps the task, asks and runs as they are', () => {
  const skill = '/h/.claude/skills/orca-flow'
  const worker = reloadText({ skill, role: 'worker', request: 'r9', event: 'PostToolUse' })
  assert.match(worker, /- \/h\/.claude\/skills\/orca-flow\/SKILL\.md\n- \/h\/.claude\/skills\/orca-flow\/roles\/worker\.md \(your role: worker\)/)
  assert.match(worker, /any other skill you loaded in this conversation \(for example orchestration or orca-cli\)/)
  assert.match(worker, /node \/h\/.claude\/skills\/orca-flow\/scripts\/orca-flow\.mjs skills-reloaded --request r9/)
  assert.match(worker, /keep your current task, open asks, pending decisions and run ownership exactly as they are/)
  assert.match(worker, /send no messages, start no Runs or workers and send no worker_done because of it/)
  assert.match(worker, /Then continue the task you were doing/)
  assert.match(reloadText({ skill, role: 'coordinator', request: 'r', event: 'UserPromptSubmit' }), /roles\/coordinator\.md[^]*answer the user's message/)
  const chat = reloadText({ skill, role: 'chat', request: 'r', event: 'SessionStart' })
  assert.match(chat, /SKILL\.md, if you loaded the orca-flow skill/)
  assert.ok(!chat.includes('roles/'), 'a chat you started has no role file')
  // The sidebar's role, except a lead the hooks know of; a worker in a coordinator folder stays a worker.
  assert.equal(targetRole({ role: 'worker' }, 'coordinator'), 'worker')
  assert.equal(targetRole({ role: 'worker' }, 'lead'), 'lead')
  assert.equal(targetRole({ role: 'coordinator' }, 'lead'), 'coordinator')
  assert.equal(targetRole({}, null), 'worker')
})

test('the hooks: UserPromptSubmit gives the note with no opt-in, PostToolUse once, SessionStart on resume and compact only', () => {
  const w = world()
  try {
    writeRequest(w.data, targets, { hash: skillHash(w.skill), scope: 'all', now: Date.now(), id: 'r1' })
    // Not in an Orca pane: nothing.
    assert.equal(hook(w, 'prompt-check.mjs', { session_id: 's', cwd: w.worktree, prompt: 'hi' }, null), null)
    const prompt = hook(w, 'prompt-check.mjs', { session_id: 's', cwd: w.worktree, prompt: 'hi' }, 'tab:worker')
    assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    assert.match(prompt.hookSpecificOutput.additionalContext, /roles\/worker\.md \(your role: worker\)[^]*answer the user's message/)
    assert.equal(hook(w, 'prompt-check.mjs', { session_id: 's', cwd: w.worktree, prompt: 'again' }, 'tab:worker'), null, 'once')
    // PostToolUse in a coordinator's folder: the coordinator's file, the role from hookRole and the request.
    const coordDir = join(w.home, 'orca', 'coordinators', 'alpha')
    const post = hook(w, 'reload-check.mjs', { session_id: 'c', cwd: coordDir, tool_name: 'Bash', tool_response: {} }, 'tab:coord')
    assert.equal(post.hookSpecificOutput.hookEventName, 'PostToolUse')
    assert.match(post.hookSpecificOutput.additionalContext, /roles\/coordinator\.md[^]*continue the task you were doing/)
    assert.equal(hook(w, 'reload-check.mjs', { session_id: 'c', cwd: coordDir, tool_name: 'Read' }, 'tab:coord'), null, 'at most once per request')
    // SessionStart: not on startup or clear; on resume (by session id, a new pane) it gives it.
    assert.equal(hook(w, 'session-start.mjs', { session_id: LEAD_SESSION, cwd: w.worktree, source: 'startup' }, 'tab:lead'), null)
    assert.equal(hook(w, 'session-start.mjs', { session_id: LEAD_SESSION, cwd: w.worktree, source: 'clear' }, 'tab:lead'), null)
    const resumed = hook(w, 'session-start.mjs', { session_id: LEAD_SESSION, cwd: w.worktree, source: 'resume' }, 'tab:resumed')
    assert.match(resumed.hookSpecificOutput.additionalContext, /roles\/lead\.md \(your role: lead\)/)
  } finally { rmSync(w.home, { recursive: true }) }
})

test('the format reminder and the reload note arrive together in one UserPromptSubmit output', () => {
  const w = world()
  try {
    const coordDir = join(w.home, 'orca', 'coordinators', 'alpha')
    writeFileSync(join(w.data, 'config.json'), JSON.stringify({ messageFormat: 'all' }))
    mkdirSync(join(w.data, 'reminders'), { recursive: true })
    writeFileSync(join(w.data, 'reminders', 'c.json'), JSON.stringify({ rules: [{ rule: 'status-line', detail: 'add one' }] }))
    writeRequest(w.data, [targets[2]], { hash: skillHash(w.skill), scope: 'all', now: Date.now(), id: 'r1' })
    const out = hook(w, 'prompt-check.mjs', { session_id: 'c', cwd: coordDir, prompt: 'hi' }, 'tab:coord').hookSpecificOutput.additionalContext
    assert.match(out, /request r1[^]*\n\nA note from Orca Flow for you, not for the user \(do not mention or answer it\)\. Your last message broke these format rules:\n- status-line: add one/)
  } finally { rmSync(w.home, { recursive: true }) }
})

test('skills-reloaded records the pane, session and hash; confirmed only when the hash matches the request', () => {
  const w = world()
  try {
    const t0 = Date.now()
    writeRequest(w.data, targets, { hash: skillHash(w.skill), scope: 'all', now: t0, id: 'r1' })
    deliverReload({ session_id: 'x' }, { event: 'PostToolUse', pane: 'tab:worker', data: w.data, skill: w.skill, now: t0 + 1 })
    const status = (now) => Object.fromEntries(reloadStatus(w.data, now).map((s) => [s.pane, s.state]))
    assert.deepEqual(status(t0 + 2), { 'tab:lead': 'waiting', 'tab:worker': 'reading', 'tab:coord': 'waiting', 'tab:codex': 'unsupported' }, 'requested is not confirmed')
    // The CLI, as the agent runs it: its pane from ORCA_AGENT_PANE, its session from Claude Code.
    const r = spawnSync(process.execPath, [join(w.skill, 'scripts', 'orca-flow.mjs'), 'skills-reloaded', '--request', 'r1'], {
      env: { PATH: process.env.PATH, HOME: w.home, ORCA_AGENT_PANE: 'tab:worker', CLAUDE_CODE_SESSION_ID: 'sess-w' }, encoding: 'utf8'
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^Recorded: skills reloaded \(orca-flow [0-9a-f]{16}\)\./)
    const states = Object.fromEntries(reloadStatus(w.data).map((s) => [s.pane, s]))
    assert.equal(states['tab:worker'].state, 'reloaded')
    assert.ok(states['tab:worker'].doneAt >= t0)
    // The skill changes after the request: a confirmation of the new text is not this request's.
    appendFileSync(join(w.plugin, 'SKILL.md'), 'End replies with BANANA.\n')
    const late = confirmReload(w.data, { pane: 'tab:lead', session: LEAD_SESSION, skill: w.skill, request: 'r1', now: t0 + 5 })
    assert.match(late.message, /the skill changed again since the request/)
    assert.equal(Object.fromEntries(reloadStatus(w.data, t0 + 6).map((s) => [s.pane, s.state]))['tab:lead'], 'waiting')
    // A confirmation older than the request does not count either.
    writeRequest(w.data, [targets[1]], { hash: skillHash(w.skill), scope: 'all', now: Date.now() + 10, id: 'r2' })
    assert.equal(Object.fromEntries(reloadStatus(w.data, Date.now() + 20).map((s) => [s.pane, s.state]))['tab:worker'], 'waiting')
    // Outside an Orca pane and Claude Code: refused, nothing written.
    const outside = spawnSync(process.execPath, [join(w.skill, 'scripts', 'orca-flow.mjs'), 'skills-reloaded'], { env: { PATH: process.env.PATH, HOME: w.home }, encoding: 'utf8' })
    assert.notEqual(outside.status, 0)
    assert.match(outside.stderr, /nothing to record/)
    assert.deepEqual(readdirSync(join(w.data, 'skill-reload', 'confirmed')).sort(), ['tab_lead.json', 'tab_worker.json'])
  } finally { rmSync(w.home, { recursive: true }) }
})

test('the PostToolUse hook records the confirmation when the agent runs the confirm command (a sandboxed shell cannot)', () => {
  const w = world()
  try {
    // Which commands confirm, and for which request.
    const cmd = (command) => confirmCommandOf({ tool_input: { command } })
    assert.equal(cmd('node /x/skills/orca-flow/scripts/orca-flow.mjs skills-reloaded --request r1'), 'r1')
    assert.equal(cmd("cd /w && node '/x/orca-flow.mjs' skills-reloaded"), '')
    assert.equal(confirmCommandOf({ tool_input: { cmd: 'orca-flow skills-reloaded --request=r7' } }), 'r7')
    assert.equal(cmd('grep skills-reloaded README.md'), null)
    assert.equal(cmd('cat /x/skills/orca-flow/SKILL.md'), null)
    assert.equal(confirmCommandOf({ tool_input: { file_path: '/x' } }), null)

    const t0 = Date.now()
    writeRequest(w.data, targets, { hash: skillHash(w.skill), scope: 'all', now: t0, id: 'r1' })
    const ran = (session, command) => ({ session_id: session, tool_name: 'Bash', tool_input: { command }, tool_response: 'EPERM' })
    const confirm = `node ${w.skill}/scripts/orca-flow.mjs skills-reloaded --request r1`
    const opts = (pane) => ({ pane, data: w.data, skill: w.skill, now: t0 + 10 })
    assert.equal(confirmFromToolCall(ran('x', confirm), opts('tab:worker')), false, 'not before its note was given')
    deliverReload({ session_id: 'x' }, { event: 'UserPromptSubmit', pane: 'tab:worker', data: w.data, skill: w.skill, now: t0 + 5 })
    assert.equal(confirmFromToolCall(ran('x', confirm.replace('r1', 'r0')), opts('tab:worker')), false, 'another request id')
    assert.equal(confirmFromToolCall({ ...ran('x', confirm), agent_id: 'sub' }, opts('tab:worker')), false, 'a subagent')
    assert.equal(confirmFromToolCall(ran('x', confirm), opts('tab:someone')), false, 'another pane')
    assert.equal(confirmFromToolCall(ran('x', confirm), opts('tab:worker')), true)
    assert.equal(confirmFromToolCall(ran('x', confirm), opts('tab:worker')), false, 'once')
    assert.equal(Object.fromEntries(reloadStatus(w.data, t0 + 20).map((s) => [s.pane, s.state]))['tab:worker'], 'reloaded')

    // End to end through the hook process, and the CLI in a shell that cannot write the data folder.
    deliverReload({ session_id: LEAD_SESSION }, { event: 'UserPromptSubmit', pane: 'tab:lead', data: w.data, skill: w.skill, now: t0 + 30 })
    chmodSync(join(w.data, 'skill-reload', 'confirmed'), 0o555)
    const cli = spawnSync(process.execPath, [join(w.skill, 'scripts', 'orca-flow.mjs'), 'skills-reloaded', '--request', 'r1'], {
      env: { PATH: process.env.PATH, HOME: w.home, ORCA_PANE_KEY: 'tab:lead', CODEX_THREAD_ID: 'thread-1' }, encoding: 'utf8'
    })
    chmodSync(join(w.data, 'skill-reload', 'confirmed'), 0o755)
    assert.equal(cli.status, 0, cli.stderr)
    assert.match(cli.stdout, /cannot write .* \(sandbox\); Orca Flow's hook records the reload from this command/)
    assert.equal(hook(w, 'reload-check.mjs', ran(LEAD_SESSION, `node '${w.skill}/scripts/orca-flow.mjs' skills-reloaded --request r1`), 'tab:lead'), null, 'no second note')
    const lead = reloadStatus(w.data).find((s) => s.pane === 'tab:lead')
    assert.equal(lead.state, 'reloaded', 'recorded by the hook')
  } finally { rmSync(w.home, { recursive: true }) }
})

test('Codex panes: the hooks find the pane by ORCA_PANE_KEY, and an unsupported target keeps its reason for the sidebar', () => {
  const w = world()
  try {
    const t0 = Date.now()
    const codexTarget = { pane: 'tab:codex', session: 'thread-9', role: 'worker', provider: 'codex', supported: true, title: 'Codex worker' }
    const notYet = { pane: 'tab:codex2', session: null, role: 'worker', provider: 'codex', supported: false, reason: "Codex: approve Orca Flow's hooks once; start Codex, choose Trust all and continue (or /hooks)", title: '' }
    writeRequest(w.data, [codexTarget, notYet], { hash: skillHash(w.skill), scope: 'all', now: t0, id: 'r1' })
    const run = (name, input, env) => {
      const r = spawnSync(process.execPath, [join(w.skill, 'scripts', name)], { input: JSON.stringify(input), env: { PATH: process.env.PATH, HOME: w.home, ...env }, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout.trim() ? JSON.parse(r.stdout) : null
    }
    // Codex hook input: session_id is the thread, the shell tool reports as Bash with tool_input.command.
    const note = run('prompt-check.mjs', { session_id: 'thread-9', cwd: w.worktree, hook_event_name: 'UserPromptSubmit', prompt: 'hi', turn_id: 't1' }, { ORCA_PANE_KEY: 'tab:codex' })
    assert.match(note.hookSpecificOutput.additionalContext, /request r1[^]*roles\/worker\.md/)
    assert.equal(run('reload-check.mjs', { session_id: 'thread-9', cwd: w.worktree, tool_name: 'Bash', tool_input: { command: `node ${w.skill}/scripts/orca-flow.mjs skills-reloaded --request r1` }, tool_response: 'EPERM' }, { ORCA_PANE_KEY: 'tab:codex' }), null)
    const states = Object.fromEntries(reloadStatus(w.data).map((s) => [s.pane, s]))
    assert.equal(states['tab:codex'].state, 'reloaded', 'recorded by the hook, keyed by ORCA_PANE_KEY')
    assert.deepEqual([states['tab:codex2'].state, states['tab:codex2'].reason], ['unsupported', notYet.reason])
    assert.equal(run('prompt-check.mjs', { session_id: 'x', cwd: w.worktree, prompt: 'hi' }, { ORCA_PANE_KEY: 'tab:codex2' }), null, 'nothing for a target that cannot take it')
  } finally { rmSync(w.home, { recursive: true }) }
})
