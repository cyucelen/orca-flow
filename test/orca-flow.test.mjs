// node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { briefOf, decide, digest, formatQueue, normalizePriority, roleOf, runsToResume } from '../skills/orca-flow/scripts/orca-flow.mjs'

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

test('a lead is known from the role line its coordinator gives it', () => {
  assert.equal(roleOf('Your role: lead. Load the orca-flow skill and follow roles/lead.md.\nShip the checkout', []), 'lead')
  assert.equal(roleOf('=== TASK === Dispatch id ctx_1: fix the button', []), 'worker')
  assert.equal(roleOf('help me with this bug', []), 'solo')
})

test("the queue attributes a lead's ask to the lead and points to its chat", () => {
  const ask = (asker, name) => ({ worktree: `wt-${name}`, name: `repo/${name}`, priority: 'P2', state: 'done', title: name, needs: { type: 'review', ask: 'Is PR #3 good to merge?', options: [] }, asker, effort: 'quick', since: null, goal: null })
  const text = formatQueue({ scope: 'all', waiting: [ask('lead', 'checkout'), ask('coordinator', 'home')], working: [] })
  assert.match(text, /repo\/checkout[\s\S]*the lead asks, answer in its chat · review \(quick\): Is PR #3 good to merge\?/)
  assert.match(text, /repo\/home[\s\S]*\n   review \(quick\): Is PR #3/, "a coordinator's own ask is answered here")
})
