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
      if (verb === 'run-current') return { runId: null }
      if (verb === 'run-create') return { runId: 'run_9' }
      if (verb === 'task-create') {
        const id = `task_${++n}`
        status[id] = args.includes('--deps') ? 'pending' : 'ready'
        return { task: { id, status: status[id] } }
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
  // A Run first (none is bound), then tasks in wave order, deps as Orca ids.
  assert.deepEqual(verbs(deps, 'run-create')[0].args, ['orchestration', 'run-create', '--objective', 'Totals feature'])
  const creates = verbs(deps, 'task-create')
  assert.deepEqual(creates.map((c) => after(c.args, '--task-title')), ['Do api', 'Do ui', 'Do wire', 'Do e2e'])
  assert.equal(after(creates[2].args, '--deps'), '["task_1"]')
  assert.equal(after(creates[3].args, '--deps'), '["task_1","task_2"]')
  assert.ok(creates.every((c) => after(c.args, '--run') === 'run_9'))
  assert.match(creates[0].input, /^Spec for api\n\nPlan "Totals feature", task api\. Files you own \(edit only these\): src\/api\.ts\./)

  // Only the two ready tasks start, each on its own routed model, behind the gate.
  const startsNow = verbs(deps, 'worker-start')
  assert.deepEqual(startsNow.map((c) => after(c.args, '--task')), ['task_1', 'task_2'])
  assert.deepEqual(startsNow[0].args.slice(-6), ['--agent', 'claude', '--model', 'haiku', '--effort', 'low'])
  assert.deepEqual(startsNow[1].args.slice(-6), ['--agent', 'claude', '--model', 'sonnet', '--effort', 'medium'])
  assert.equal(after(startsNow[0].args, '--worktree'), 'current')
  assert.equal(deps.capacityCalls.length, 2)

  const state = JSON.parse(readFileSync(join(deps.dir, 'plans', 'totals-feature.json'), 'utf8'))
  assert.equal(state.runId, 'run_9')
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
  assert.equal(after(wire.args, '--run'), 'run_9')

  deps.output.length = 0
  await run(deps, 'status', file)
  const status = deps.output.join('\n')
  assert.match(status, /api +done +Claude Haiku · low/)
  assert.match(status, /ui +running +Claude Sonnet · medium — standard task/)
  assert.match(status, /wire +running +Claude Haiku · low/)
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
  assert.match(deps.output[0], /^b: Codex gpt-mini · low is no longer available; routed again to Claude Haiku · low/)
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
