// node --test test/*.test.mjs
// orca-flow plan check|start|next|status through a fake Orca (test/fake-orca.mjs): no real tasks,
// no real workers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** The plan's state file (plans/<slug>-<hash of the plan path>.json); there is one per test. */
const stateFileOf = (deps) => {
  const files = readdirSync(join(deps.dir, 'plans')).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 1, files.join(', '))
  return join(deps.dir, 'plans', files[0])
}
const readState = (deps) => JSON.parse(readFileSync(stateFileOf(deps), 'utf8'))

function writePlan(deps, tasks, title = 'Totals feature', name = 'plan.json') {
  const file = join(deps.dir, name)
  writeFileSync(file, JSON.stringify({ title, tasks }))
  return file
}

const T = (id, files, deps = [], extra = {}) => ({ id, title: `Do ${id}`, spec: `Spec for ${id}`, kind: 'normal', files, deps, ...extra })
const verbs = (deps, verb) => deps.calls.filter((c) => c.args[1] === verb)
const after = (argv, flag) => argv[argv.indexOf(flag) + 1]
const run = (deps, ...rest) => {
  const flags = rest.at(-1) && typeof rest.at(-1) === 'object' ? rest.pop() : {}
  return planCommand({ _: ['plan', ...rest], ...flags }, deps)
}

test('plan check prints waves, errors on overlap, cycles and missing deps, and warns on over-splitting; touches no Orca', async () => {
  const ok = withTasks()
  const file = writePlan(ok, [T('api', ['src/api.ts']), T('ui', ['src/panel/']), T('docs', ['README.md'], ['api', 'ui'], { kind: 'simple' })])
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
  assert.equal(await run(tiny, 'check', writePlan(tiny, [T('a', ['a.ts'], [], { kind: 'simple' }), T('b', ['b.ts'], [], { kind: 'simple' })])), 0)
  assert.match(tiny.output[0], /warning: every task is simple: one worker can do them all; merge them into one task/)
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
    T('api', ['src/api.ts'], [], { kind: undefined, class: 'trivial' }), // an older plan's field and name
    T('ui', ['src/panel/']),
    T('wire', ['src/main.ts'], ['api']),
    T('e2e', ['test/'], ['api', 'ui'], { kind: undefined, class: 'complex', risk: 'high' })
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
  assert.equal(deps.capacityCalls.length, 1, 'one capacity scan; each start is priced locally')

  assert.match(stateFileOf(deps), /plans\/totals-feature-[0-9a-f]{8}\.json$/)
  const state = readState(deps)
  assert.deepEqual(state.tasks.e2e.request, { kind: 'hard', risk: 'high', context: null, explicit: null }, 'how each task was judged is kept')
  assert.equal(state.runId, 'run_7', 'read back from the first task')
  assert.deepEqual(Object.fromEntries(Object.entries(state.tasks).map(([id, t]) => [id, [t.taskId, t.state, t.route.choice.model]])), {
    api: ['task_1', 'running', 'haiku'],
    ui: ['task_2', 'running', 'sonnet'],
    wire: ['task_3', 'queued', 'sonnet'],
    e2e: ['task_4', 'queued', 'opus']
  })
  assert.deepEqual(readRoutes(deps.dir).map((r) => [r.taskId, r.dispatchId, r.kind, r.class]), [['task_1', 'ctx_1', 'simple', 'trivial'], ['task_2', 'ctx_2', 'normal', 'standard']])
  assert.match(deps.output.join('\n'), /e2e +queued +Claude Opus · \w+ — hard task, high risk/)

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
  const file = writePlan(deps, [T('api', ['src/api.ts'], [], { kind: 'simple' }), T('ui', ['src/panel/']), T('wire', ['src/main.ts'], ['api'], { kind: 'simple' })])
  await run(deps, 'start', file)
  assert.equal(verbs(deps, 'worker-start').length, 2)

  // The user moves simple tasks to Sonnet; api finishes. wire was routed to Haiku at start and keeps it.
  writeFileSync(join(deps.dir, 'config.json'), JSON.stringify({ routing: { maxParallel: 2, workers: { simple: { model: { agent: 'claude', model: 'sonnet', effort: 'low' }, fallback: null } } } }))
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
  assert.match(status, /ui +running +Claude Sonnet · medium — normal task/)
  assert.match(status, /wire +running +Claude Haiku/)
})

test('plan next routes again when the recorded model is gone, and says so; an explicit one is never swapped', async () => {
  const codex = { agents: ['claude', 'codex'], models: { claude: null, codex: [{ id: 'gpt-mini', efforts: ['low', 'medium'] }] } }
  const routing = { maxParallel: 1, workers: { simple: { model: { agent: 'codex', model: 'gpt-mini', effort: 'low' }, fallback: { agent: 'claude', model: 'haiku' } } } }
  const deps = withTasks({ routing, avail: codex })
  const file = writePlan(deps, [
    T('a', ['a'], [], { kind: 'simple' }),
    T('b', ['b'], ['a'], { kind: 'simple' }),
    T('c', ['c'], ['b'], { kind: 'simple', agent: 'codex', model: 'gpt-mini' })
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
  const state = readState(deps)
  assert.deepEqual([state.tasks.a.state, state.tasks.a.error, state.tasks.b.state, state.tasks.c.state], ['failed-start', 'worktree is busy', 'running', 'queued'])

  // The task is still ready in Orca; plan next keeps it failed-start, retries it, and succeeds.
  fail = false
  deps.output.length = 0
  assert.equal(await run(deps, 'next', file), 0)
  assert.equal(verbs(deps, 'worker-start').filter((c) => after(c.args, '--task') === 'task_1').length, 2)
  assert.match(deps.output.join('\n'), /a +running/)
  assert.equal(readState(deps).tasks.a.error, undefined)
})

test('a failed start does not bypass the capacity gate for the tasks after it', async () => {
  const deps = withTasks({ routing: { maxParallel: 3 }, verdict: 'full', orca: async (args) => { if (args[1] === 'worker-start' && args.includes('task_1')) throw new Error('nope') } })
  assert.equal(await run(deps, 'start', writePlan(deps, [T('a', ['a']), T('b', ['b'])])), 0)
  assert.equal(verbs(deps, 'worker-start').length, 0, 'the gate holds every task')
})

test('capacity is scanned once per plan start or next, and each started agent is priced locally for the next', async () => {
  // 1.2 GB free, 0.5 GB an agent: two fit (1.2 → 0.7 → 0.2), the third waits.
  const deps = withTasks({ routing: { maxParallel: 4 }, freeGB: 1.2, agentGB: 0.5, orca: async (args) => { if (args[1] === 'worker-start' && args.includes('task_2')) throw new Error('nope') } })
  await run(deps, 'start', writePlan(deps, [T('a', ['a']), T('b', ['b']), T('c', ['c']), T('d', ['d'])]))
  assert.equal(deps.capacityCalls.length, 1)
  assert.deepEqual(verbs(deps, 'worker-start').map((c) => after(c.args, '--task')), ['task_1', 'task_2', 'task_3'], 'a refused start costs nothing')
  assert.match(deps.output.join('\n'), /d: queued: capacity says full \(0\.2 GB free\)/)
  deps.output.length = 0
  await run(deps, 'next', writePlan(deps, [T('a', ['a']), T('b', ['b']), T('c', ['c']), T('d', ['d'])]))
  assert.equal(deps.capacityCalls.length, 2, 'plan next scans once')
  // Nothing to start: no scan at all.
  const idle = withTasks({ routing: { maxParallel: 1 } })
  const file = writePlan(idle, [T('a', ['a']), T('b', ['b'], ['a'])])
  await run(idle, 'start', file)
  const scans = idle.capacityCalls.length
  await run(idle, 'next', file)
  assert.ok(idle.capacityCalls.length <= scans + 1)
})

test('two plans with the same title keep separate state', async () => {
  const deps = withTasks()
  const one = writePlan(deps, [T('a', ['a'])], 'Same', 'one.json')
  const two = writePlan(deps, [T('a', ['a'])], 'Same', 'two.json')
  assert.equal(await run(deps, 'start', one), 0)
  assert.equal(await run(deps, 'start', two), 0, 'not "already started"')
  assert.equal(verbs(deps, 'task-create').length, 2)
  assert.equal(readdirSync(join(deps.dir, 'plans')).filter((f) => f.endsWith('.json')).length, 2)
})

test('a state file from before the path hash is moved to the new name when it belongs to this plan', async () => {
  const deps = withTasks()
  const file = writePlan(deps, [T('a', ['a'])])
  mkdirSync(join(deps.dir, 'plans'), { recursive: true })
  writeFileSync(join(deps.dir, 'plans', 'totals-feature.json'), JSON.stringify({ title: 'Totals feature', plan: file, runId: 'run_7', worktree: 'current', tasks: { a: { taskId: 'task_9', route: { choice: { agent: 'claude', model: 'sonnet' }, source: 'kind', reason: 'r' }, dispatchId: 'ctx_9', state: 'running' } } }))
  await run(deps, 'status', file)
  assert.match(stateFileOf(deps), /totals-feature-[0-9a-f]{8}\.json$/)
  assert.match(deps.output.join('\n'), /a +running .*\[task_9 ctx_9\]/)
})

test('plan next and status never crash on a task missing from the state, and plan start finishes a partial start', async () => {
  let failCreate = true
  const deps = withTasks({ orca: async (args) => { if (args[1] === 'task-create' && failCreate && args.includes('Do b')) throw new Error('Orca timed out') } })
  const file = writePlan(deps, [T('a', ['a']), T('b', ['b'], ['a']), T('c', ['c'])])
  await assert.rejects(run(deps, 'start', file), /Orca timed out/)
  assert.deepEqual(Object.keys(readState(deps).tasks), ['a', 'c'], 'wave 1 was created before b failed')

  deps.output.length = 0
  assert.equal(await run(deps, 'status', file), 0)
  assert.match(deps.output.join('\n'), /b +missing +no Orca task/)
  deps.output.length = 0
  assert.equal(await run(deps, 'next', file), 0)
  assert.match(deps.output.join('\n'), /b: in the plan but has no Orca task .*plan start/)

  // plan start creates only what is missing, then starts what is ready.
  failCreate = false
  deps.output.length = 0
  const before = verbs(deps, 'task-create').length
  assert.equal(await run(deps, 'start', file), 0)
  const created = verbs(deps, 'task-create').slice(before)
  assert.deepEqual(created.map((c) => after(c.args, '--task-title')), ['Do b'])
  assert.equal(after(created[0].args, '--deps'), '["task_1"]')
  assert.match(deps.output.join('\n'), /Finishing the partial start .*: creating b\./)
  assert.deepEqual(Object.keys(readState(deps).tasks).sort(), ['a', 'b', 'c'])
  await assert.rejects(run(deps, 'start', file), /already started/)

  // A task added to the plan file after start: reported, then created by plan start.
  const grown = writePlan(deps, [T('a', ['a']), T('b', ['b'], ['a']), T('c', ['c']), T('d', ['d'])])
  deps.output.length = 0
  assert.equal(await run(deps, 'status', grown), 0)
  assert.match(deps.output.join('\n'), /d +missing/)
  assert.equal(await run(deps, 'start', grown), 0)
  assert.equal(readState(deps).tasks.d.taskId, 'task_4')
})

const REQ = '0b8f3c1e-2d4a-4e6f-8a9b-1c2d3e4f5a6b'

test('a start with an unknown outcome is marked unknown, holds its slot, and plan next replays it by request id instead of starting it again', async () => {
  let unknown = true
  const deps = withTasks({
    routing: { maxParallel: 2 },
    orca: async (args) => {
      if (args[1] === 'worker-start' && args.includes('task_1') && unknown) throw Object.assign(new Error('start: timed out\nmore'), { result: { state: 'outcome_unknown', dispatchId: 'ctx_u' }, data: { orchestrationRequestId: REQ } })
    }
  })
  const file = writePlan(deps, [T('a', ['a']), T('b', ['b']), T('c', ['c'])])
  assert.equal(await run(deps, 'start', file), 1)
  const out = deps.output.join('\n')
  assert.match(out, new RegExp(`a: start outcome unknown on Claude Sonnet · medium: start: timed out\\. Not started again: \`orca-flow plan next\` replays request ${REQ}`))
  assert.match(out, /a +unknown /)
  assert.match(out, /1 start with an unknown outcome/)
  assert.deepEqual(verbs(deps, 'worker-start').map((c) => after(c.args, '--task')), ['task_1', 'task_2'], 'c waits: a may be running and holds its slot')
  const state = readState(deps)
  assert.deepEqual([state.tasks.a.state, state.tasks.a.requestId, state.tasks.a.dispatchId], ['unknown', REQ, 'ctx_u'])

  // plan next: Orca still says ready. a is replayed (not started fresh), with the same command.
  unknown = false
  deps.output.length = 0
  assert.equal(await run(deps, 'next', file), 0)
  const aStarts = verbs(deps, 'worker-start').filter((c) => c.args.includes('task_1'))
  assert.equal(aStarts.length, 2)
  assert.deepEqual(aStarts[1].args, [...aStarts[0].args, '--retry-request', REQ])
  assert.match(deps.output.join('\n'), new RegExp(`a: replayed request ${REQ}: started ctx_\\d+`))
  assert.equal(readState(deps).tasks.a.state, 'running')
  assert.equal(readState(deps).tasks.a.requestId, undefined)
})

test('an unknown start with no request id is held, never restarted, until --restart', async () => {
  let unknown = true
  const deps = withTasks({ orca: async (args) => { if (args[1] === 'worker-start' && unknown) throw Object.assign(new Error('orca timed out'), { timedOut: true }) } })
  const file = writePlan(deps, [T('a', ['a'])])
  assert.equal(await run(deps, 'start', file), 1)
  unknown = false
  deps.output.length = 0
  await run(deps, 'next', file)
  assert.equal(verbs(deps, 'worker-start').length, 1, 'not started a second time')
  assert.match(deps.output.join('\n'), /a: start outcome unknown and no request id to replay.*--restart a/)
  // Orca shows the worker started after all: it follows Orca.
  deps.status.task_1 = 'dispatched'
  deps.output.length = 0
  await run(deps, 'status', file)
  assert.match(deps.output.join('\n'), /a +running/)

  const held = withTasks({ orca: async (args) => { if (args[1] === 'worker-start' && unknown) throw Object.assign(new Error('orca timed out'), { timedOut: true }) } })
  unknown = true
  const f2 = writePlan(held, [T('a', ['a'])])
  await run(held, 'start', f2)
  unknown = false
  assert.equal(await run(held, 'next', f2, { restart: 'a' }), 0)
  assert.equal(verbs(held, 'worker-start').length, 2)
  assert.equal(readState(held).tasks.a.state, 'running')
})

test('plan next re-routes a failed-start task whose recorded model is gone, and says so', async () => {
  const codex = { agents: ['claude', 'codex'], models: { claude: null, codex: [{ id: 'gpt-mini', efforts: ['low', 'medium'] }] } }
  const routing = { maxParallel: 1, workers: { simple: { model: { agent: 'codex', model: 'gpt-mini', effort: 'low' }, fallback: { agent: 'claude', model: 'haiku' } } } }
  let fail = true
  const deps = withTasks({ routing, avail: codex, orca: async (args) => { if (args[1] === 'worker-start' && fail) throw new Error('codex would not launch') } })
  const file = writePlan(deps, [T('a', ['a'], [], { kind: 'simple' })])
  assert.equal(await run(deps, 'start', file), 1)
  fail = false
  deps.avail = { agents: ['claude'], models: { claude: null, codex: null } }
  deps.output.length = 0
  assert.equal(await run(deps, 'next', file), 0)
  assert.match(deps.output[0], /^a: Codex gpt-mini · low is no longer available; routed again to Claude Haiku/)
  assert.equal(after(verbs(deps, 'worker-start').at(-1).args, '--model'), 'haiku')
})
