// node --test test/*.test.mjs
// orca-flow plan check|start|next|status through a fake Orca (test/fake-orca.mjs): no real tasks,
// no real workers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeDeps } from './fake-orca.mjs'
import { planCommand, readRoutes } from '../skills/orca-flow/scripts/dispatch.mjs'

/** A fake Orca with a task graph: task-create hands out ids, task-list reports `status`. */
function withTasks(options = {}) {
  const status = {}
  let n = 0
  const deps = fakeDeps({
    ...options,
    orca: async (args) => {
      const [, verb] = args
      await options.orca?.(args) // a test's hook may throw, e.g. to fail a worker-start
      if (verb === 'run-current') return { runId: options.boundRun ?? null }
      if (verb === 'run-create') return { runId: 'run_9' }
      if (verb === 'task-create') {
        const id = `task_${++n}`
        status[id] = args.includes('--deps') ? 'pending' : 'ready'
        return { task: { id, status: status[id], runId: options.joinRun ?? 'run_7' } }
      }
      if (verb === 'task-list') return { tasks: Object.entries(status).map(([id, s]) => ({ id, status: s, title: id })) }
      if (verb === 'worker-start') status[args[args.indexOf('--task') + 1]] = 'dispatched'
      return undefined
    }
  })
  deps.status = status
  return deps
}

function writePlan(deps, tasks, title = 'Totals feature') {
  const file = join(deps.dir, 'plan.json')
  writeFileSync(file, JSON.stringify({ title, tasks }))
  return file
}

const T = (id, files, deps = [], extra = {}) => ({ id, title: `Do ${id}`, spec: `Spec for ${id}`, class: 'standard', files, deps, ...extra })
const verbs = (deps, verb) => deps.calls.filter((c) => c.args[1] === verb)
const after = (argv, flag) => argv[argv.indexOf(flag) + 1]
const run = (deps, ...rest) => {
  const flags = rest.at(-1) && typeof rest.at(-1) === 'object' ? rest.pop() : {}
  return planCommand({ _: ['plan', ...rest], ...flags }, deps)
}

test('plan check prints waves, errors on overlap, cycles and missing deps, and warns on over-splitting; touches no Orca', async () => {
  const ok = withTasks()
  const file = writePlan(ok, [T('api', ['src/api.ts']), T('ui', ['src/panel/']), T('docs', ['README.md'], ['api', 'ui'], { class: 'trivial' })])
  assert.equal(await run(ok, 'check', file), 0)
  assert.equal(ok.output[0], 'Plan "Totals feature": 3 tasks in 2 waves\n  wave 1: api, ui\n  wave 2: docs')

  const bad = withTasks()
  const badFile = writePlan(bad, [T('a', ['src/x.ts'], ['c']), T('b', ['src/']), T('c', ['docs/'], ['a']), T('d', ['e'], ['ghost'])])
  assert.equal(await run(bad, 'check', badFile), 1)
  const out = bad.output.join('\n')
  assert.match(out, /error: task "d" depends on "ghost", which is not in the plan/)
  assert.match(out, /error: dependency cycle: /)

  const overlap = withTasks()
  assert.equal(await run(overlap, 'check', writePlan(overlap, [T('a', ['src/x.ts']), T('b', ['src/'])])), 1)
  assert.match(overlap.output[0], /error: tasks "a" and "b" both own src\/x\.ts \/ src\/ and neither waits for the other: chain them \(deps\) or merge them/)

  const tiny = withTasks()
  assert.equal(await run(tiny, 'check', writePlan(tiny, [T('a', ['a.ts'], [], { class: 'trivial' }), T('b', ['b.ts'], [], { class: 'trivial' })])), 0)
  assert.match(tiny.output[0], /warning: every task is trivial: one worker can do them all; merge them into one task/)
  assert.equal(ok.calls.length + bad.calls.length + overlap.calls.length + tiny.calls.length, 0)
})

test('plan start refuses a failing plan before creating anything', async () => {
  const deps = withTasks()
  assert.equal(await run(deps, 'start', writePlan(deps, [T('a', ['src/x.ts']), T('b', ['src/x.ts'])])), 1)
  assert.equal(deps.calls.length, 0)
})

test('plan start creates one Orca task per plan task with deps, routes each once, and starts ready tasks within maxParallel and capacity', async () => {
  const deps = withTasks({ routing: { maxParallel: 2 } })
  const file = writePlan(deps, [
    T('api', ['src/api.ts'], [], { class: 'trivial' }),
    T('ui', ['src/panel/']),
    T('wire', ['src/main.ts'], ['api']),
    T('e2e', ['test/'], ['api', 'ui'], { class: 'complex', risk: 'high' })
  ])
  assert.equal(await run(deps, 'start', file), 0)
  // No Run is created as a side effect; tasks go in wave order, deps as Orca ids.
  assert.equal(verbs(deps, 'run-create').length, 0)
  const creates = verbs(deps, 'task-create')
  assert.deepEqual(creates.map((c) => after(c.args, '--task-title')), ['Do api', 'Do ui', 'Do wire', 'Do e2e'])
  assert.equal(after(creates[2].args, '--deps'), '["task_1"]')
  assert.equal(after(creates[3].args, '--deps'), '["task_1","task_2"]')
  assert.ok(!creates[0].args.includes('--run'), 'no Run is bound: the first task joins the caller\'s own')
  assert.ok(creates.slice(1).every((c) => after(c.args, '--run') === 'run_7'), 'the rest follow it into the Run read back')
  assert.match(creates[0].input, /^Spec for api\n\nPlan "Totals feature", task api\. Files you own \(edit only these\): src\/api\.ts\./)

  // Only the two ready tasks start, each on its own routed model, behind the gate.
  const startsNow = verbs(deps, 'worker-start')
  assert.deepEqual(startsNow.map((c) => after(c.args, '--task')), ['task_1', 'task_2'])
  assert.deepEqual(startsNow[0].args.slice(-4), ['--agent', 'claude', '--model', 'haiku'], 'Haiku takes no effort flag')
  assert.deepEqual(startsNow[1].args.slice(-6), ['--agent', 'claude', '--model', 'sonnet', '--effort', 'medium'])
  assert.equal(after(startsNow[0].args, '--worktree'), 'current')
  assert.equal(after(startsNow[0].args, '--run'), 'run_7', 'the Run read back from the first task is passed on')
  assert.equal(deps.capacityCalls.length, 2)

  const state = JSON.parse(readFileSync(join(deps.dir, 'plans', 'totals-feature.json'), 'utf8'))
  assert.equal(state.runId, 'run_7', 'read back from the first task')
  assert.deepEqual(Object.fromEntries(Object.entries(state.tasks).map(([id, t]) => [id, [t.taskId, t.state, t.route.choice.model]])), {
    api: ['task_1', 'running', 'haiku'],
    ui: ['task_2', 'running', 'sonnet'],
    wire: ['task_3', 'queued', 'sonnet'],
    e2e: ['task_4', 'queued', 'opus']
  })
  assert.deepEqual(readRoutes(deps.dir).map((r) => [r.taskId, r.dispatchId, r.class]), [['task_1', 'ctx_1', 'trivial'], ['task_2', 'ctx_2', 'standard']])
  assert.match(deps.output.join('\n'), /e2e +queued +Claude Opus · \w+ — complex task, high risk/)

  // Starting the same plan again would duplicate its tasks.
  await assert.rejects(run(deps, 'start', file), /already started.*plan next/)
})

test('plan start honours maxParallel and stops at a capacity refusal', async () => {
  const one = withTasks({ routing: { maxParallel: 1 } })
  await run(one, 'start', writePlan(one, [T('a', ['a']), T('b', ['b']), T('c', ['c'])]))
  assert.equal(verbs(one, 'worker-start').length, 1)

  const full = withTasks({ verdict: 'full' })
  await run(full, 'start', writePlan(full, [T('a', ['a']), T('b', ['b'])]))
  assert.equal(verbs(full, 'task-create').length, 2, 'the tasks are queued in Orca')
  assert.equal(verbs(full, 'worker-start').length, 0)
  assert.match(full.output.join('\n'), /a: queued: capacity says full/)
})

test('plan next starts newly ready tasks on their recorded route, even after settings change', async () => {
  const deps = withTasks({ routing: { maxParallel: 2 } })
  const file = writePlan(deps, [T('api', ['src/api.ts'], [], { class: 'trivial' }), T('ui', ['src/panel/']), T('wire', ['src/main.ts'], ['api'], { class: 'trivial' })])
  await run(deps, 'start', file)
  assert.equal(verbs(deps, 'worker-start').length, 2)

  // The user turns Haiku off; api finishes. wire was routed to Haiku at start and keeps it.
  writeFileSync(join(deps.dir, 'config.json'), JSON.stringify({ routing: { maxParallel: 2, candidates: [{ agent: 'claude', model: 'sonnet', tier: 2, cost: 2, enabled: true }] } }))
  deps.status.task_1 = 'completed'
  assert.equal(await run(deps, 'next', file), 0)
  const wire = verbs(deps, 'worker-start')[2]
  assert.equal(after(wire.args, '--task'), 'task_3')
  assert.equal(after(wire.args, '--model'), 'haiku')
  assert.equal(after(wire.args, '--run'), 'run_7')

  deps.output.length = 0
  await run(deps, 'status', file)
  const status = deps.output.join('\n')
  assert.match(status, /api +done +Claude Haiku/)
  assert.match(status, /ui +running +Claude Sonnet · medium — standard task/)
  assert.match(status, /wire +running +Claude Haiku/)
})

test('plan next routes again when the recorded model is gone, and says so; an explicit one is never swapped', async () => {
  const codex = { agents: ['claude', 'codex'], models: { claude: null, codex: [{ id: 'gpt-mini', efforts: ['low', 'medium'] }] } }
  const routing = { maxParallel: 1, candidates: [{ agent: 'codex', model: 'gpt-mini', tier: 1, cost: 1, enabled: true }, { agent: 'claude', model: 'haiku', tier: 1, cost: 2, enabled: true }] }
  const deps = withTasks({ routing, avail: codex })
  const file = writePlan(deps, [
    T('a', ['a'], [], { class: 'trivial' }),
    T('b', ['b'], ['a'], { class: 'trivial' }),
    T('c', ['c'], ['b'], { class: 'trivial', agent: 'codex', model: 'gpt-mini' })
  ])
  await run(deps, 'start', file)
  assert.equal(after(verbs(deps, 'worker-start')[0].args, '--model'), 'gpt-mini')

  deps.avail = { agents: ['claude'], models: { claude: null, codex: null } }
  deps.status.task_1 = 'completed'
  deps.output.length = 0
  await run(deps, 'next', file)
  assert.match(deps.output[0], /^b: Codex gpt-mini · low is no longer available; routed again to Claude Haiku/)
  assert.equal(after(verbs(deps, 'worker-start')[1].args, '--model'), 'haiku')

  deps.status.task_2 = 'completed'
  deps.output.length = 0
  await run(deps, 'next', file)
  assert.match(deps.output[0], /^c: not started: Codex gpt-mini, which the plan names, is unavailable/)
  assert.equal(verbs(deps, 'worker-start').length, 2)
})

test('plan start --dry-run creates nothing and prints the commands', async () => {
  const deps = withTasks()
  const file = writePlan(deps, [T('a', ['a']), T('b', ['b'], ['a'])])
  assert.equal(await run(deps, 'start', file, { 'dry-run': true }), 0)
  assert.equal(deps.calls.length, 0)
  assert.equal(existsSync(join(deps.dir, 'plans')), false)
  const out = deps.output.join('\n')
  assert.match(out, /a: would run orca orchestration task-create --task-title 'Do a' --spec-file - --run '<run>' --json/)
  assert.match(out, /b: would run .* --deps '\["<a>"\]'/)
  assert.match(out, /a: would run orca orchestration worker-start --task '<a>' --worktree current --run '<run>' --agent claude --model sonnet --effort medium --json/)
})

test('plan start from a dispatched worker joins its parent Run and never run-creates', async () => {
  const deps = withTasks({ joinRun: 'run_parent' })
  await run(deps, 'start', writePlan(deps, [T('a', ['a']), T('b', ['b'])]))
  assert.equal(verbs(deps, 'run-create').length, 0)
  assert.match(deps.output.join('\n'), /Run run_parent: the caller's own, joined by the first task\. No Run was created\./)
  // The Run read back is used from then on.
  assert.ok(verbs(deps, 'worker-start').every((c) => after(c.args, '--run') === 'run_parent'))
})

test('plan start uses the Run bound here (run-current) and says so', async () => {
  const deps = withTasks({ boundRun: 'run_bound' })
  await run(deps, 'start', writePlan(deps, [T('a', ['a'])]))
  assert.equal(verbs(deps, 'run-create').length, 0)
  assert.ok(verbs(deps, 'task-create').every((c) => after(c.args, '--run') === 'run_bound'))
  assert.match(deps.output.join('\n'), /Run run_bound: the one bound to this terminal\./)
})

test('plan start --new-run is the only way a Run gets created, and the output says so', async () => {
  const deps = withTasks()
  await run(deps, 'start', writePlan(deps, [T('a', ['a'])]), { 'new-run': true })
  assert.deepEqual(verbs(deps, 'run-create')[0].args, ['orchestration', 'run-create', '--objective', 'Totals feature'])
  assert.match(deps.output.join('\n'), /Created Run run_9 \(--new-run\) and bound it to this terminal as its coordinator\./)
  assert.ok(verbs(deps, 'task-create').every((c) => after(c.args, '--run') === 'run_9'))
})

test('a failed worker-start marks only that task failed-start, tries the rest, prints the table and exits 1; plan next retries it', async () => {
  let fail = true
  const deps = withTasks({
    routing: { maxParallel: 3 },
    orca: async (args) => {
      if (args[1] === 'worker-start' && fail && args.includes('task_1')) throw new Error('worktree is busy\nsecond line')
      return undefined
    }
  })
  const file = writePlan(deps, [T('a', ['a']), T('b', ['b']), T('c', ['c'], ['a'])])
  assert.equal(await run(deps, 'start', file), 1)
  assert.equal(verbs(deps, 'worker-start').length, 2, 'b was still tried')
  const out = deps.output.join('\n')
  assert.match(out, /a: failed to start on Claude Sonnet · medium: worktree is busy/)
  assert.match(out, /a +failed-start +Claude Sonnet/)
  assert.match(out, /b +running/)
  assert.match(out, /1 start failed .*plan next.*\n {2}a: worktree is busy/)
  const state = JSON.parse(readFileSync(join(deps.dir, 'plans', 'totals-feature.json'), 'utf8'))
  assert.deepEqual([state.tasks.a.state, state.tasks.a.error, state.tasks.b.state, state.tasks.c.state], ['failed-start', 'worktree is busy', 'running', 'queued'])

  // The task is still ready in Orca; plan next keeps it failed-start, retries it, and succeeds.
  fail = false
  deps.output.length = 0
  assert.equal(await run(deps, 'next', file), 0)
  assert.equal(verbs(deps, 'worker-start').filter((c) => after(c.args, '--task') === 'task_1').length, 2)
  assert.match(deps.output.join('\n'), /a +running/)
  assert.equal(JSON.parse(readFileSync(join(deps.dir, 'plans', 'totals-feature.json'), 'utf8')).tasks.a.error, undefined)
})

test('a failed start does not bypass the capacity gate for the tasks after it', async () => {
  const deps = withTasks({ routing: { maxParallel: 3 }, orca: async (args) => { if (args[1] === 'worker-start' && args.includes('task_1')) throw new Error('nope') } })
  assert.equal(await run(deps, 'start', writePlan(deps, [T('a', ['a']), T('b', ['b'])])), 1)
  assert.equal(deps.capacityCalls.length, 2, 'each start is gated, including the one after the failure')
})

test('plan next re-routes a failed-start task whose recorded model is gone, and says so', async () => {
  const codex = { agents: ['claude', 'codex'], models: { claude: null, codex: [{ id: 'gpt-mini', efforts: ['low', 'medium'] }] } }
  const routing = { maxParallel: 1, candidates: [{ agent: 'codex', model: 'gpt-mini', tier: 1, cost: 1, enabled: true }, { agent: 'claude', model: 'haiku', tier: 1, cost: 2, enabled: true }] }
  let fail = true
  const deps = withTasks({ routing, avail: codex, orca: async (args) => { if (args[1] === 'worker-start' && fail) throw new Error('codex would not launch') } })
  const file = writePlan(deps, [T('a', ['a'], [], { class: 'trivial' })])
  assert.equal(await run(deps, 'start', file), 1)
  fail = false
  deps.avail = { agents: ['claude'], models: { claude: null, codex: null } }
  deps.output.length = 0
  assert.equal(await run(deps, 'next', file), 0)
  assert.match(deps.output[0], /^a: Codex gpt-mini · low is no longer available; routed again to Claude Haiku/)
  assert.equal(after(verbs(deps, 'worker-start').at(-1).args, '--model'), 'haiku')
})
