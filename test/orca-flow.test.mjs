// node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { botDirectory, briefOf, decide, digest, formatBots, formatQueue, normalizePriority, roleOf, runsToResume } from '../skills/orca-flow/scripts/orca-flow.mjs'

test('priority accepts levels and words, refuses anything else', () => {
  assert.equal(normalizePriority('now'), 'P0')
  assert.equal(normalizePriority('Someday'), 'P3')
  assert.equal(normalizePriority('p1'), 'P1')
  assert.throws(() => normalizePriority('urgent'), /now\/today\/soon\/someday/)
})

test('capacity: the shared memory decision, critical pressure overrides, warn adds headroom', () => {
  const at = (availableGB, pressure = 'normal') => decide({ availableGB, pressure, config: { marginGB: 2 }, agentGB: 0.5, envGB: 2 }).verdict
  assert.equal(at(8), 'ok')
  assert.equal(at(4), 'agents-only')
  assert.equal(at(2.2), 'full')
  assert.equal(at(8, 'critical'), 'pressure')
  assert.equal(at(8, 'warn'), 'ok', 'warn: 6 GB free covers 0.5 + 2 + 2 GB headroom')
  assert.equal(at(6, 'warn'), 'agents-only', 'warn: 4 GB free does not')
})

const line = (type, content, extra = {}) => JSON.stringify({ type, message: { content }, timestamp: extra.at ?? 't', ...extra })

test('digest keeps the latest turn apart from the earlier one, skips tool results and sidechains, and finds the role', () => {
  const lines = [
    line('user', 'Task T1, Dispatch ID d-9: fix the login bug', { at: '1' }),
    line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }]),
    line('user', [{ type: 'tool_result', content: 'ok' }]),
    line('assistant', [{ type: 'text', text: 'side' }], { isSidechain: true }),
    line('user', 'now ship it', { at: '2' }),
    line('assistant', [{ type: 'text', text: 'PR #12 opened. Merge it?' }], { at: '3' })
  ]
  const d = digest(lines)
  assert.equal(d.role, 'worker')
  assert.match(d.firstPrompt, /fix the login bug/)
  assert.match(d.context, /→ Bash: pnpm test/, 'the earlier turn is context')
  assert.doesNotMatch(d.turn, /pnpm test/, 'and not part of the latest turn')
  assert.match(d.turn, /^USER: now ship it$/)
  assert.doesNotMatch(d.context + d.turn, /side/)
  assert.equal(d.lastAssistant, 'PR #12 opened. Merge it?')
  assert.equal(d.turnAt, '3')
})

test('an agent that starts workers is a coordinator', () => {
  const d = digest([
    line('user', 'split this up'),
    line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'orca orchestration worker-start --spec x --agent claude' } }])
  ])
  assert.equal(d.role, 'coordinator')
})

test('mentioning worker-start in a file or heredoc does not make a coordinator', () => {
  const d = digest([
    line('user', 'write tests'),
    line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: "cat > t.mjs <<'EOF'\n orca orchestration worker-start --spec x\nEOF" } }]),
    line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -n "orchestration worker-start" SKILL.md' } }])
  ])
  assert.equal(d.role, 'solo')
})

test('a chained worker-start still counts', () => {
  const d = digest([
    line('user', 'go'),
    line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'cd /repo && orca orchestration worker-start --spec x' } }])
  ])
  assert.equal(d.role, 'coordinator')
})

test('plain Node can load the plugin code orca-flow queue uses', async () => {
  // orca-flow imports the plugin's TypeScript directly; extensionless imports break it.
  const worker = await import('../src/worker.ts')
  const view = await import('../src/view.ts')
  assert.equal(typeof worker.fromPs, 'function')
  assert.equal(typeof view.render, 'function')
})

test('a dispatched worker is summarized from its brief, not the Orca preamble', () => {
  const preamble = 'You are a dispatched worker. Your Dispatch ID is ctx_1. ' + 'Report with worker_done. '.repeat(80) + '\n---\n\n=== TASK ===\nEnd your turn asking: Should I merge the test branch now?\n</pasted_content>'
  assert.equal(briefOf(preamble), 'End your turn asking: Should I merge the test branch now?')
  const d = digest([line('user', preamble), line('assistant', [{ type: 'text', text: 'Should I merge the test branch now? Yes or no.' }])])
  assert.equal(d.role, 'worker', 'the Dispatch id in the preamble still marks it a worker')
  assert.match(d.firstPrompt, /^End your turn asking/)
  assert.doesNotMatch(d.turn, /worker_done/)
})

test('resume takes back only runs whose closed terminal ran in this folder and still have workers', () => {
  const runs = [
    { id: 'mine', coordinator_handle: 'old-here' },
    { id: 'done', coordinator_handle: 'old-here-2' },
    { id: 'other', coordinator_handle: 'old-there' },
    { id: 'live', coordinator_handle: 'open' },
    { id: 'bound', coordinator_handle: 'me' },
    { id: 'unbound', coordinator_handle: null }
  ]
  const dirs = { 'old-here': '/c/alpha', 'old-here-2': '/c/alpha', 'old-there': '/c/main', open: '/c/alpha' }
  const out = runsToResume({
    runs, me: 'me', here: '/c/alpha', live: new Set(['open']),
    dirOf: (h) => dirs[h], activeWorkers: (id) => (id === 'done' ? 0 : 1)
  })
  assert.deepEqual(out.map((r) => r.id), ['mine'])
})

test('resume preserves an existing binding and refuses an unreadable binding before searching for another run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-resume-'))
  try {
    const cli = fileURLToPath(new URL('../skills/orca-flow/scripts/orca-flow.mjs', import.meta.url))
    writeFileSync(join(dir, 'orca'), '#!/bin/sh\n[ "$*" = "orchestration run-current --json" ] || exit 2\necho "$FIXTURE_CURRENT"\n', { mode: 0o700 })
    for (const result of [{ runId: 'run-held' }, {}]) {
      const proc = spawnSync(process.execPath, [cli, 'resume'], { encoding: 'utf8',
        env: { ...process.env, ORCA_CLI_BIN_DIR: dir, ORCA_TERMINAL_HANDLE: 'fixture', FIXTURE_CURRENT: JSON.stringify({ ok: true, result }) } })
      assert.equal(proc.status, result.runId ? 0 : 1)
      assert.match(proc.stdout + proc.stderr, result.runId ? /Already coordinating run-held/ : /could not verify/)
    }
  } finally { rmSync(dir, { recursive: true }) }
})

test('a lead is known from the role line its coordinator gives it', () => {
  assert.equal(roleOf('Your role: lead. Load the orca-flow skill and follow roles/lead.md.\nShip the checkout', []), 'lead')
  assert.equal(roleOf('=== TASK === Dispatch id ctx_1: fix the button', []), 'worker')
  assert.equal(roleOf('help me with this bug', []), 'solo')
})

test("the queue points to a lead's chat without its question, and shows a coordinator's own ask", () => {
  const ask = (asker, name, ask) => ({ worktree: `wt-${name}`, name: `repo/${name}`, priority: 'P2', state: 'done', title: name, needs: { type: 'decision', ask, options: ['Allow it', 'Block it'] }, asker, effort: 'quick', since: 'ran the tests', goal: null })
  const lead = formatQueue({ scope: 'all', waiting: [ask('lead', 'checkout', 'May a manager save No budget?')], working: [] })
  assert.match(lead, /repo\/checkout: checkout\n   the lead waits on your pick \(quick\) · answer in its chat \(or Up next\)\n   since: ran the tests\n   open: wt-checkout/)
  assert.doesNotMatch(lead, /No budget|Allow it|Block it|options:/, "a lead's question and options are not printed for a coordinator to restate")
  const own = formatQueue({ scope: 'all', waiting: [ask('coordinator', 'home', 'Can I stop the idle dev server?')], working: [] })
  assert.match(own, /repo\/home: home\n   decision \(quick\): Can I stop the idle dev server\?\n   options: Allow it \| Block it/, "a coordinator's own ask is answered here")
})

test('bots: a project sees its coordinator\'s bots and the Personal ones, each with the exact send command', () => {
  const listed = [
    { id: 'q', name: 'super-agent-live-qa', specialty: 'Live **regression** sentinel for `super-core-01`.' },
    { id: 'r', name: 'Replies you owe' },
    { id: 't', name: 'tayfa-qa', paused: true },
    { name: 'stray' }
  ]
  const folders = [{ folder: 'replies-you-owe', path: '/b/replies-you-owe', id: 'r', name: 'Replies you owe', avatar: null, soul: '# Replies you owe\n\nReminds you of replies you still owe.\n' }]
  const coordinators = [
    { key: 'super-agent-coordinator', repos: ['super-agent', 'super-agent-infra'], bots: ['SUPER-AGENT-LIVE-QA'] },
    { key: 'tayfa', repos: ['tayfa'], bots: ['tayfa-qa'] },
    { key: 'lean', repos: ['lean-lab'], bots: ['super-agent-live-qa'] }
  ]
  const forRepo = botDirectory({ listed, folders, coordinators, repo: 'Super-Agent' })
  assert.deepEqual(forRepo.map((b) => [b.name, b.coordinator, b.crossProject]), [
    ['super-agent-live-qa', 'super-agent-coordinator', false],
    ['Replies you owe', null, true],
    ['stray', null, true]
  ], 'the first coordinator keeps a bot two list; another project\'s bot stays out')
  assert.equal(forRepo[0].purpose, 'Live regression sentinel for super-core-01.')
  assert.equal(forRepo[1].purpose, 'Reminds you of replies you still owe.', 'from SOUL.md, its folder found by id')
  assert.equal(forRepo[0].delegate, 'orca orchestration send --to bot:super-agent-live-qa --chat new --type handoff --subject "<outcome>" --body "<spec>"')
  assert.equal(forRepo[0].ask, 'orca orchestration send --to bot:super-agent-live-qa --chat new --type question --subject "<question>" --body "<details>"')
  assert.match(forRepo[1].delegate, /--to 'bot:Replies you owe' --chat new --type handoff/, 'a name with spaces is quoted for the shell')
  const all = botDirectory({ listed, folders, coordinators })
  assert.deepEqual(all.map((b) => [b.name, b.coordinator, b.paused]), [['super-agent-live-qa', 'super-agent-coordinator', false], ['tayfa-qa', 'tayfa', true], ['Replies you owe', null, false], ['stray', null, false]])
  const anyProject = botDirectory({ listed, folders, coordinators: [{ key: 'main', repos: [], bots: ['replies-you-owe'] }], repo: 'shop' })
  assert.equal(anyProject.find((b) => b.name === 'Replies you owe').coordinator, 'main', 'matched by folder; a coordinator with no repos takes every project')
  const text = formatBots({ repo: 'super-agent', bots: forRepo })
  assert.match(text, /^Bots for super-agent:\n\nsuper-agent-coordinator:\n  super-agent-live-qa: Live regression sentinel/)
  assert.match(text, /Personal \(cross-project\):\n  Replies you owe: Reminds you/)
  assert.match(formatBots({ repo: 'shop', bots: [] }), /No bots for shop/)
})
