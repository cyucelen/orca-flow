// node --test test/*.test.mjs
// orca-flow route / dispatch through injected fakes: a recording Orca, fixed availability and a
// fixed capacity verdict. Nothing here starts a real worker or creates a real Orca task.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeDeps } from './fake-orca.mjs'
import { dispatchCommand, readRoutes, Refused, routeCommand, UsageError } from '../skills/orca-flow/scripts/dispatch.mjs'

const argsOf = (flags, ...positional) => ({ _: positional, ...flags })
const starts = (deps) => deps.calls.filter((c) => c.args[1] === 'worker-start')
const after = (argv, flag) => argv[argv.indexOf(flag) + 1]

test('route prints the label, the reason and, with --explain, what it passed over; launches nothing', async () => {
  const deps = fakeDeps()
  assert.equal(await routeCommand(argsOf({ role: 'worker', class: 'trivial', explain: true }, 'route'), deps), 0)
  const out = deps.output.join('\n')
  assert.match(out, /^Claude Haiku \(auto\)\n {2}why: trivial task → Claude Haiku/)
  assert.match(out, /flags: --agent claude --model haiku\n/)
  assert.match(out, /passed over:\n {4}claude sonnet: costs more/)
  assert.equal(deps.calls.length, 0)
  const json = fakeDeps()
  await routeCommand(argsOf({ role: 'worker', class: 'complex', json: true }, 'route'), json)
  assert.deepEqual(JSON.parse(json.output[0]).choice, { agent: 'claude', model: 'opus', effort: 'high' })
  await assert.rejects(routeCommand(argsOf({ role: 'boss' }, 'route'), fakeDeps()), UsageError)
  await assert.rejects(routeCommand(argsOf({ role: 'worker', class: 'huge' }, 'route'), fakeDeps()), /--class is trivial, standard or complex/)
})

test('dispatch starts the worker on the routed agent, model and effort, passes the rest through, and logs the route', async () => {
  const deps = fakeDeps({ stdin: 'Fix the button\nmore spec' })
  const code = await dispatchCommand(argsOf({ role: 'worker', class: 'trivial', worktree: 'current', 'task-title': 'Fix the button', 'spec-file': '-', 'keep-open': true }, 'dispatch'), deps)
  assert.equal(code, 0)
  const [start] = starts(deps)
  assert.deepEqual(start.args, ['orchestration', 'worker-start', '--worktree', 'current', '--task-title', 'Fix the button', '--spec-file', '-', '--keep-open', '--agent', 'claude', '--model', 'haiku'])
  assert.equal(start.input, 'Fix the button\nmore spec', 'stdin passes through for --spec-file -')
  assert.deepEqual(deps.capacityCalls, [{}], 'no new worktree: the general gate')
  assert.match(deps.output[0], /^Started ctx_1 on Claude Haiku — trivial task → /)
  assert.match(deps.output[0], /task task_new1 · run run_1 · state ready · workspace repo1::\/work\/tree/)
  const [entry] = readRoutes(deps.dir)
  assert.deepEqual(Object.keys(entry), ['at', 'role', 'taskId', 'dispatchId', 'workspace', 'choice', 'source', 'reason', 'class', 'risk', 'attempt'])
  assert.deepEqual(entry, {
    at: '2026-11-22T10:00:00.000Z',
    role: 'worker',
    taskId: 'task_new1',
    dispatchId: 'ctx_1',
    workspace: 'repo1::/work/tree',
    choice: { agent: 'claude', model: 'haiku' },
    source: 'auto',
    reason: entry.reason,
    class: 'trivial',
    risk: null,
    attempt: 0
  })
})

test("dispatch passes the user's explicit agent, model and effort straight through", async () => {
  const avail = { agents: ['claude', 'codex'], models: { claude: null, codex: [{ id: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] }] } }
  const deps = fakeDeps({ avail })
  await dispatchCommand(argsOf({ role: 'worker', class: 'trivial', agent: 'codex', model: 'gpt-6-luna', effort: 'high', worktree: 'current', spec: 'do it' }, 'dispatch'), deps)
  const argv = starts(deps)[0].args
  assert.deepEqual(argv.slice(-6), ['--agent', 'codex', '--model', 'gpt-6-luna', '--effort', 'high'])
  assert.equal(argv.filter((a) => a === '--agent').length, 1, 'never passed twice')
  assert.equal(readRoutes(deps.dir)[0].source, 'override')

  const lead = fakeDeps({ routing: { lead: { agent: 'claude', model: 'opus', effort: 'max' } } })
  await dispatchCommand(argsOf({ role: 'lead', worktree: 'new-top-level', repo: 'id:r1', name: 'checkout', 'keep-open': true, spec: 'lead it' }, 'dispatch'), lead)
  assert.deepEqual(starts(lead)[0].args.slice(-6), ['--agent', 'claude', '--model', 'opus', '--effort', 'max'])
  assert.deepEqual(lead.capacityCalls, [{ repo: 'id:r1' }], 'a new worktree is priced for its project')
})

test('capacity refusal launches nothing and logs nothing', async () => {
  for (const [verdict, worktree] of [['full', 'current'], ['pressure', 'current'], ['agents-only', 'new-top-level']]) {
    const deps = fakeDeps({ verdict })
    const run = dispatchCommand(argsOf({ role: 'worker', worktree, repo: 'id:r1', name: 'x', 'task-title': 'Add totals', spec: 's' }, 'dispatch'), deps)
    await assert.rejects(run, (e) => e instanceof Refused && e.code === 2 && new RegExp(`capacity says ${verdict}`).test(e.message) && /Queue it: orca orchestration task-create --task-title 'Add totals'/.test(e.message))
    assert.equal(deps.calls.length, 0, `${verdict}: no Orca call`)
    assert.equal(existsSync(join(deps.dir, 'routes.jsonl')), false)
  }
  const queued = fakeDeps({ verdict: 'full' })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', task: 'task_q', worktree: 'current' }, 'dispatch'), queued), /stays queued as task_q/)
  const fits = fakeDeps({ verdict: 'agents-only' })
  assert.equal(await dispatchCommand(argsOf({ role: 'worker', worktree: 'current', spec: 's' }, 'dispatch'), fits), 0, 'agents-only lets an agent into an existing worktree')
})

test('a route failure launches nothing', async () => {
  const deps = fakeDeps({ routing: { candidates: [{ agent: 'claude', model: 'opus', tier: 3, cost: 4, enabled: false }] } })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', worktree: 'current', spec: 's' }, 'dispatch'), deps), (e) => e instanceof Refused && e.code === 3 && /No enabled Standard model/.test(e.message))
  const unknown = fakeDeps()
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', model: 'gpt-x', worktree: 'current', spec: 's' }, 'dispatch'), unknown), (e) => e.code === 3)
  assert.equal(deps.calls.length + unknown.calls.length, 0)
})

test('--retry-of escalates from the logged attempt, reuses the task and its class, and stops at the limit', async () => {
  const deps = fakeDeps({ routing: { maxEscalations: 1 } })
  writeFileSync(join(deps.dir, 'routes.jsonl'), `${JSON.stringify({ at: 'x', role: 'worker', taskId: 'task_a', dispatchId: 'ctx_old', workspace: 'w', choice: { agent: 'claude', model: 'sonnet', effort: 'medium' }, source: 'auto', reason: 'r', class: 'standard', risk: null, attempt: 0 })}\n`)
  await dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_old', worktree: 'current' }, 'dispatch'), deps)
  const argv = starts(deps)[0].args
  assert.equal(after(argv, '--task'), 'task_a', 'Orca needs --task with --retry-of')
  assert.equal(after(argv, '--retry-of'), 'ctx_old')
  assert.equal(after(argv, '--model'), 'opus', 'standard asks Standard; one escalation asks Strong')
  const logged = readRoutes(deps.dir).at(-1)
  assert.equal(logged.attempt, 1)
  assert.equal(logged.class, 'standard')
  assert.equal(logged.dispatchId, 'ctx_1')

  // The new dispatch failed too: attempt 2 is past maxEscalations 1.
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_1', worktree: 'current' }, 'dispatch'), deps), (e) => e.code === 3 && /Escalation limit reached \(1\)/.test(e.message))
  assert.equal(starts(deps).length, 1, 'nothing more launched')

  const none = fakeDeps()
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_nope', worktree: 'current' }, 'dispatch'), none), /no route recorded for ctx_nope.*pass --attempt/)
})

test('--dry-run runs the gate and the route, prints the exact command, and starts and logs nothing', async () => {
  const deps = fakeDeps()
  await dispatchCommand(argsOf({ role: 'worker', class: 'complex', worktree: 'current', 'task-title': "Fix Bob's race", 'spec-file': '-', 'dry-run': true }, 'dispatch'), deps)
  assert.equal(deps.calls.length, 0)
  assert.equal(deps.capacityCalls.length, 1)
  assert.equal(existsSync(join(deps.dir, 'routes.jsonl')), false)
  assert.match(deps.output[0], /^Would start on Claude Opus · high — complex task/)
  assert.match(deps.output[0], /\norca orchestration worker-start --worktree current --task-title 'Fix Bob'\\''s race' --spec-file - --agent claude --model opus --effort high --json$/)

  const json = fakeDeps()
  await dispatchCommand(argsOf({ role: 'worker', worktree: 'current', spec: 's', json: true }, 'dispatch'), json)
  const out = JSON.parse(json.output[0])
  assert.deepEqual(Object.keys(out), ['route', 'capacity', 'receipt'])
  assert.equal(out.receipt.dispatchId, 'ctx_1')
  assert.equal(out.capacity.verdict, 'ok')
})

test('dispatch refuses a start with no spec or task, and coordinators', async () => {
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', worktree: 'current' }, 'dispatch'), fakeDeps()), /needs --task <id>, --spec/)
  await assert.rejects(dispatchCommand(argsOf({ role: 'coordinator', spec: 's' }, 'dispatch'), fakeDeps()), /--role is worker or lead/)
  assert.ok(readFileSync(new URL('../skills/orca-flow/scripts/orca-flow.mjs', import.meta.url), 'utf8').includes('orca-flow dispatch --role worker|lead'), 'the header documents it')
})
