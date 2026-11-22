// node --test test/*.test.mjs
// orca-flow route / dispatch through injected fakes: a recording Orca, fixed availability and a
// fixed capacity verdict. Nothing here starts a real worker or creates a real Orca task.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_ONLY, fakeDeps } from './fake-orca.mjs'
import { cachedDiscover, dispatchCommand, MODELS_CACHE_MS, readRoutes, Refused, routeCommand, startOutcome, typesCommand, UsageError } from '../skills/orca-flow/scripts/dispatch.mjs'

const argsOf = (flags, ...positional) => ({ _: positional, ...flags })
const starts = (deps) => deps.calls.filter((c) => c.args[1] === 'worker-start')
const after = (argv, flag) => argv[argv.indexOf(flag) + 1]

test('route prints the label, the reason and, with --explain, what it passed over; launches nothing', async () => {
  const deps = fakeDeps()
  assert.equal(await routeCommand(argsOf({ role: 'worker', kind: 'simple', explain: true }, 'route'), deps), 0)
  assert.equal(deps.output.join('\n'), [
    'Claude Haiku (kind)',
    '  why: simple task → Claude Haiku',
    '  flags: --agent claude --model haiku',
    '  row: simple → Claude Haiku, fallback Claude Sonnet · low (Settings → Models)',
    '  passed over: none'
  ].join('\n'))
  assert.equal(deps.calls.length, 0)
  // the row's model is gone: the fallback, and what was passed over
  // (Claude aliases stay valid even when Claude's list omits them, so the row names an agent that is not installed.)
  const fb = fakeDeps({ routing: { workers: { simple: { model: { agent: 'codex', model: 'gpt-mini', effort: 'low' }, fallback: { agent: 'claude', model: 'sonnet', effort: 'low' } } } } })
  await routeCommand(argsOf({ role: 'worker', kind: 'simple', explain: true }, 'route'), fb)
  assert.match(fb.output[0], /^Claude Sonnet · low \(fallback\)\n {2}why: simple task → Claude Sonnet · low: .*gpt-mini unavailable \(codex not installed\)/)
  assert.match(fb.output[0], /passed over:\n {4}Codex gpt-mini · low: codex not installed$/)
  // --class and the old names still work
  const json = fakeDeps()
  await routeCommand(argsOf({ role: 'worker', class: 'complex', json: true }, 'route'), json)
  assert.deepEqual(JSON.parse(json.output[0]).choice, { agent: 'claude', model: 'opus', effort: 'high' })
  const old = fakeDeps()
  await routeCommand(argsOf({ role: 'worker', kind: 'trivial' }, 'route'), old)
  assert.match(old.output[0], /why: simple task/)
  await assert.rejects(routeCommand(argsOf({ role: 'boss' }, 'route'), fakeDeps()), UsageError)
  await assert.rejects(routeCommand(argsOf({ role: 'worker', class: 'huge' }, 'route'), fakeDeps()), /--class is simple, normal or hard/)
  await assert.rejects(routeCommand(argsOf({ role: 'worker', kind: 'huge' }, 'route'), fakeDeps()), /--kind is simple, normal or hard/)
})

test('dispatch starts the worker on the routed agent, model and effort, passes the rest through, and logs the route', async () => {
  const deps = fakeDeps({ stdin: 'Fix the button\nmore spec' })
  const code = await dispatchCommand(argsOf({ role: 'worker', kind: 'simple', worktree: 'current', 'task-title': 'Fix the button', 'spec-file': '-', 'keep-open': true }, 'dispatch'), deps)
  assert.equal(code, 0)
  const [start] = starts(deps)
  assert.deepEqual(start.args, ['orchestration', 'worker-start', '--worktree', 'current', '--task-title', 'Fix the button', '--spec-file', '-', '--keep-open', '--agent', 'claude', '--model', 'haiku'])
  assert.equal(start.input, 'Fix the button\nmore spec', 'stdin passes through for --spec-file -')
  assert.deepEqual(deps.capacityCalls, [{}], 'no new worktree: the general gate')
  assert.match(deps.output[0], /^Started ctx_1 on Claude Haiku — simple task → Claude Haiku$/m)
  assert.match(deps.output[0], /task task_new1 · run run_1 · state ready · workspace repo1::\/work\/tree/)
  const [entry] = readRoutes(deps.dir)
  assert.deepEqual(Object.keys(entry), ['at', 'role', 'taskId', 'dispatchId', 'workspace', 'choice', 'source', 'reason', 'type', 'kind', 'class', 'risk', 'context', 'explicit', 'attempt'])
  assert.deepEqual(entry, {
    at: '2026-11-22T10:00:00.000Z',
    role: 'worker',
    taskId: 'task_new1',
    dispatchId: 'ctx_1',
    workspace: 'repo1::/work/tree',
    choice: { agent: 'claude', model: 'haiku' },
    source: 'kind',
    reason: 'simple task → Claude Haiku',
    type: null,
    kind: 'simple',
    class: 'trivial',
    risk: null,
    context: null,
    explicit: null,
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
  assert.deepEqual(readRoutes(deps.dir)[0].explicit, { agent: 'codex', model: 'gpt-6-luna', effort: 'high' }, 'what the user chose is logged')

  const lead = fakeDeps({ routing: { lead: { agent: 'claude', model: 'opus', effort: 'max' } } })
  await dispatchCommand(argsOf({ role: 'lead', worktree: 'new-top-level', repo: 'id:r1', name: 'checkout', 'keep-open': true, spec: 'lead it' }, 'dispatch'), lead)
  assert.deepEqual(starts(lead)[0].args.slice(-6), ['--agent', 'claude', '--model', 'opus', '--effort', 'max'])
  assert.deepEqual(lead.capacityCalls, [{ repo: 'id:r1' }], 'an unknown selector is priced as given')
})

test('the capacity gate prices a new worktree by the repo name its --repo selector names', async () => {
  const byId = fakeDeps({ repos: { 'id:r1': 'mono' } })
  await dispatchCommand(argsOf({ role: 'lead', worktree: 'new-top-level', repo: 'id:r1', name: 'x', spec: 's' }, 'dispatch'), byId)
  assert.deepEqual(byId.capacityCalls, [{ repo: 'mono' }], 'id: is looked up with orca repo show')
  assert.equal(after(starts(byId)[0].args, '--repo'), 'id:r1', 'worker-start still gets the selector')
  const byPath = fakeDeps({ repos: { 'path:/src/mono': 'mono' } })
  await dispatchCommand(argsOf({ role: 'lead', worktree: 'new-child', repo: 'path:/src/mono', spec: 's' }, 'dispatch'), byPath)
  assert.deepEqual(byPath.capacityCalls, [{ repo: 'mono' }])
  const byName = fakeDeps()
  await dispatchCommand(argsOf({ role: 'lead', worktree: 'new-top-level', repo: 'name:mono', spec: 's' }, 'dispatch'), byName)
  assert.deepEqual(byName.capacityCalls, [{ repo: 'mono' }], 'name: needs no lookup')
  assert.equal(byName.calls.filter((c) => c.args[0] === 'repo').length, 0)
  const bare = fakeDeps()
  await dispatchCommand(argsOf({ role: 'lead', worktree: 'new-top-level', repo: 'mono', spec: 's' }, 'dispatch'), bare)
  assert.deepEqual(bare.capacityCalls, [{ repo: 'mono' }])
})

test('capacity refusal launches nothing and logs nothing', async () => {
  for (const [verdict, worktree] of [['full', 'current'], ['pressure', 'current'], ['agents-only', 'new-top-level']]) {
    const deps = fakeDeps({ verdict })
    const run = dispatchCommand(argsOf({ role: 'worker', worktree, repo: 'id:r1', name: 'x', 'task-title': 'Add totals', spec: 's' }, 'dispatch'), deps)
    await assert.rejects(run, (e) => e instanceof Refused && e.code === 2 && new RegExp(`capacity says ${verdict}`).test(e.message) && /Queue it: orca orchestration task-create --task-title 'Add totals'/.test(e.message))
    assert.equal(starts(deps).length, 0, `${verdict}: nothing started`)
    assert.equal(existsSync(join(deps.dir, 'routes.jsonl')), false)
  }
  const queued = fakeDeps({ verdict: 'full' })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', task: 'task_q', worktree: 'current' }, 'dispatch'), queued), /stays queued as task_q/)
  const fits = fakeDeps({ verdict: 'agents-only' })
  assert.equal(await dispatchCommand(argsOf({ role: 'worker', worktree: 'current', spec: 's' }, 'dispatch'), fits), 0, 'agents-only lets an agent into an existing worktree')
})

test('a route failure launches nothing', async () => {
  const deps = fakeDeps({ routing: { workers: { normal: { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' }, fallback: null } } } })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', worktree: 'current', spec: 's' }, 'dispatch'), deps), (e) => e instanceof Refused && e.code === 3 && /No model for this normal task: Codex gpt-6-luna · medium is unavailable \(codex not installed\) and the row has no fallback/.test(e.message))
  const unknown = fakeDeps()
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', model: 'gpt-x', worktree: 'current', spec: 's' }, 'dispatch'), unknown), (e) => e.code === 3)
  assert.equal(deps.calls.length + unknown.calls.length, 0)
})

test('--retry-of escalates from the logged attempt, reuses the task and its kind (old lines: class), and stops at the hard row', async () => {
  const deps = fakeDeps()
  writeFileSync(join(deps.dir, 'routes.jsonl'), `${JSON.stringify({ at: 'x', role: 'worker', taskId: 'task_a', dispatchId: 'ctx_old', workspace: 'w', choice: { agent: 'claude', model: 'sonnet', effort: 'medium' }, source: 'auto', reason: 'r', class: 'standard', risk: null, attempt: 0 })}\n`)
  await dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_old', worktree: 'current' }, 'dispatch'), deps)
  const argv = starts(deps)[0].args
  assert.equal(after(argv, '--task'), 'task_a', 'Orca needs --task with --retry-of')
  assert.equal(after(argv, '--retry-of'), 'ctx_old')
  assert.equal(after(argv, '--model'), 'opus', 'normal moves one row up to hard')
  const logged = readRoutes(deps.dir).at(-1)
  assert.equal(logged.attempt, 1)
  assert.deepEqual([logged.kind, logged.class], ['normal', 'standard'])
  assert.equal(logged.reason, 'normal task, escalated once → Claude Opus · high')
  assert.equal(logged.dispatchId, 'ctx_1')

  // The new dispatch (already on the hard row) failed too: there is no row above.
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_1', worktree: 'current' }, 'dispatch'), deps), (e) => e.code === 3 && /Already at the hard level: ask the user before trying again\./.test(e.message))
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
  assert.match(deps.output[0], /^Would start on Claude Opus · high — hard task/)
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

const logLine = (deps, entry) => writeFileSync(join(deps.dir, 'routes.jsonl'), `${JSON.stringify({ at: 'x', role: 'worker', taskId: 'task_a', dispatchId: 'ctx_old', workspace: 'w', risk: null, attempt: 0, ...entry })}\n`)

test('--retry-of keeps the context: a large-context simple task moves up from normal, not onto the row that failed', async () => {
  const deps = fakeDeps()
  await dispatchCommand(argsOf({ role: 'worker', kind: 'simple', context: 'large', worktree: 'current', spec: 's' }, 'dispatch'), deps)
  const first = readRoutes(deps.dir)[0]
  assert.deepEqual([first.choice.model, first.context], ['sonnet', 'large'], 'large context raises simple to normal, and is logged')
  await dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_1', worktree: 'current' }, 'dispatch'), deps)
  const retry = readRoutes(deps.dir).at(-1)
  assert.equal(retry.choice.model, 'opus', 'normal + one escalation = hard')
  assert.equal(retry.context, 'large')
  assert.match(retry.reason, /simple task, large context, escalated once/)
})

test("--retry-of retries the user's explicit model on that same model at the next effort, never another one", async () => {
  const deps = fakeDeps()
  await dispatchCommand(argsOf({ role: 'worker', model: 'opus', effort: 'medium', worktree: 'current', spec: 's' }, 'dispatch'), deps)
  await dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_1', worktree: 'current' }, 'dispatch'), deps)
  let argv = starts(deps)[1].args
  assert.deepEqual(argv.slice(-6), ['--agent', 'claude', '--model', 'opus', '--effort', 'high'])
  const logged = readRoutes(deps.dir).at(-1)
  assert.deepEqual([logged.source, logged.attempt, logged.explicit], ['override', 1, { agent: 'claude', model: 'opus', effort: 'high' }])
  assert.match(logged.reason, /chosen explicitly, so the retry keeps it: effort medium → high/)
  await dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_2', worktree: 'current' }, 'dispatch'), deps)
  argv = starts(deps)[2].args
  assert.equal(after(argv, '--model'), 'opus')
  assert.notEqual(after(argv, '--effort'), 'high', 'one more step up')

  // Already at the top effort: said clearly, nothing substituted, nothing started.
  const top = fakeDeps()
  logLine(top, { choice: { agent: 'claude', model: 'opus', effort: 'max' }, source: 'override', reason: 'r', kind: 'normal', explicit: { agent: 'claude', model: 'opus', effort: 'max' } })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_old', worktree: 'current' }, 'dispatch'), top), (e) => e.code === 3 && /Cannot escalate Claude Opus: it was chosen explicitly.*Nothing was substituted/s.test(e.message))
  assert.equal(starts(top).length, 0)

  // An older line with no `explicit`: an override with a model counts as the user's choice.
  const old = fakeDeps()
  logLine(old, { choice: { agent: 'claude', model: 'sonnet', effort: 'low' }, source: 'override', reason: 'r', class: 'trivial' })
  await dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_old', worktree: 'current' }, 'dispatch'), old)
  assert.deepEqual(starts(old)[0].args.slice(-4), ['--model', 'sonnet', '--effort', 'medium'])

  // A model passed on the retry itself wins.
  const mine = fakeDeps()
  logLine(mine, { choice: { agent: 'claude', model: 'sonnet', effort: 'low' }, source: 'override', reason: 'r', kind: 'normal', explicit: { model: 'sonnet' } })
  await dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_old', model: 'haiku', worktree: 'current' }, 'dispatch'), mine)
  assert.equal(after(starts(mine)[0].args, '--model'), 'haiku')
})

test('--retry-of that would land on the model that just failed says so and starts nothing', async () => {
  const same = { agent: 'claude', model: 'sonnet', effort: 'medium' }
  const deps = fakeDeps({ routing: { workers: { normal: { model: same, fallback: null }, hard: { model: same, fallback: null } } } })
  logLine(deps, { choice: same, source: 'kind', reason: 'r', kind: 'normal' })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_old', worktree: 'current' }, 'dispatch'), deps), (e) => e.code === 3 && /Escalation could not move up: attempt 1 routes to Claude Sonnet · medium again/.test(e.message))
  assert.equal(starts(deps).length, 0)
})

const REQ = '0b8f3c1e-2d4a-4e6f-8a9b-1c2d3e4f5a6b'
const unknownStart = () => Object.assign(new Error('start: timed out waiting for the agent'), { result: { state: 'outcome_unknown', dispatchId: 'ctx_u', taskId: 'task_u' }, data: { orchestrationRequestId: REQ } })

test('a worker-start with an unknown outcome is not a failure: exit 4, and the same command replays it by its request id', async () => {
  let first = true
  const deps = fakeDeps({ stdin: 'the spec', orca: async (args) => {
    if (args[1] === 'worker-start' && first) {
      first = false
      throw unknownStart()
    }
  } })
  const cmd = () => dispatchCommand(argsOf({ role: 'worker', kind: 'simple', worktree: 'current', 'task-title': 'T', 'spec-file': '-' }, 'dispatch'), deps)
  await assert.rejects(cmd(), (e) => e instanceof Refused && e.code === 4 && /Start outcome unknown.*Do not start it again/s.test(e.message) && new RegExp(`--retry-request ${REQ}`).test(e.message) && /worker-show --dispatch ctx_u/.test(e.message))
  assert.equal(readRoutes(deps.dir).length, 0, 'not logged as a start')
  assert.ok(JSON.parse(readFileSync(join(deps.dir, 'pending-starts.json'), 'utf8'))[REQ])

  // Settings change in between: the replay still sends the recorded command, ungated.
  writeFileSync(join(deps.dir, 'config.json'), JSON.stringify({ routing: { workers: { simple: { model: { agent: 'claude', model: 'opus', effort: 'low' }, fallback: null } } } }))
  deps.verdict = 'full'
  assert.equal(await cmd(), 0)
  const [orig, replay] = starts(deps)
  assert.deepEqual(replay.args, [...orig.args, '--retry-request', REQ], 'the same command, replayed by its id: never a second fresh start')
  assert.equal(replay.input, 'the spec')
  assert.equal(deps.capacityCalls.length, 1, 'the replay is not gated again')
  assert.match(deps.output.at(-1), new RegExp(`^Replayed request ${REQ}`))
  assert.equal(readRoutes(deps.dir)[0].choice.model, 'haiku')
  assert.deepEqual(JSON.parse(readFileSync(join(deps.dir, 'pending-starts.json'), 'utf8')), {})
})

test('an unknown start without a request id, and a start Orca never sent, are told apart', async () => {
  const timeout = fakeDeps({ orca: async (args) => { if (args[1] === 'worker-start') throw Object.assign(new Error('orca timed out'), { timedOut: true }) } })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', worktree: 'current', spec: 's' }, 'dispatch'), timeout), (e) => e.code === 4 && /no request id/.test(e.message))
  assert.equal(existsSync(join(timeout.dir, 'pending-starts.json')), false)
  const unsent = fakeDeps({ orca: async (args) => { if (args[1] === 'worker-start') throw Object.assign(new Error('Orca did not answer'), { code: 'runtime_unavailable', data: { orchestrationRequestId: REQ, recovery: { disposition: 'not_sent' } } }) } })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', worktree: 'current', spec: 's' }, 'dispatch'), unsent), (e) => !(e instanceof Refused) && /did not answer/.test(e.message))
  const plain = fakeDeps({ orca: async (args) => { if (args[1] === 'worker-start') throw new Error('worktree is busy') } })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', worktree: 'current', spec: 's' }, 'dispatch'), plain), /worktree is busy/)
})

test('startOutcome reads the request id wherever Orca puts it', () => {
  assert.deepEqual(startOutcome({ result: { state: 'outcome_unknown', nextCommands: [`orca orchestration worker-start --task t --retry-request ${REQ}`] } }), { unknown: true, requestId: REQ, dispatchId: null })
  assert.equal(startOutcome({ code: 'runtime_timeout', data: { recovery: { orchestrationRequestId: REQ, disposition: 'outcome_unknown' } } }).requestId, REQ)
  assert.equal(startOutcome({ result: { state: 'failed' } }).unknown, false)
  assert.equal(startOutcome({ result: { state: 'outcome_unknown' }, data: { orchestrationRequestId: 'not-a-uuid' } }).requestId, null)
})

test('model discovery is cached for 10 minutes; refresh bypasses it; a failed agent lookup is not cached', async () => {
  const deps = fakeDeps()
  let n = 0
  const live = async () => ({ agents: ['claude'], models: { claude: null }, n: ++n })
  const t0 = Date.parse('2026-11-22T10:00:00Z')
  assert.equal((await cachedDiscover(deps.dir, live, { now: t0 })).n, 1)
  assert.equal((await cachedDiscover(deps.dir, live, { now: t0 + MODELS_CACHE_MS - 1 })).n, 1, 'cached')
  assert.equal((await cachedDiscover(deps.dir, live, { now: t0 + 1000, refresh: true })).n, 2, '--refresh-models')
  assert.equal((await cachedDiscover(deps.dir, live, { now: t0 + 1000 + MODELS_CACHE_MS })).n, 3, 'expired')
  assert.ok(existsSync(join(deps.dir, 'models-cache.json')))
  const other = fakeDeps()
  await cachedDiscover(other.dir, async () => ({ agents: null, models: {} }), { now: t0 })
  assert.equal(existsSync(join(other.dir, 'models-cache.json')), false)
  assert.match(readFileSync(new URL('../skills/orca-flow/scripts/orca-flow.mjs', import.meta.url), 'utf8'), /cachedDiscover\(DIR, .*refresh: !!args\['refresh-models'\]/, 'orca-flow wires the cache into ORCA_FLOW_DIR')
})

test('dispatch runs model discovery and the capacity scan side by side', async () => {
  const deps = fakeDeps()
  const events = []
  const capacity = deps.capacity
  deps.capacity = async (a) => {
    events.push('capacity start')
    await new Promise((r) => setTimeout(r, 5))
    events.push('capacity end')
    return capacity(a)
  }
  const discover = deps.discover
  deps.discover = async () => {
    events.push('discover start')
    return discover()
  }
  await dispatchCommand(argsOf({ role: 'worker', worktree: 'current', spec: 's' }, 'dispatch'), deps)
  assert.ok(events.indexOf('discover start') < events.indexOf('capacity end'), events.join(', '))
})

// ---------- task types ----------

const IMAGES = { id: 'images', name: 'Images', description: 'Make or edit images, icons and illustrations', route: { model: { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' }, fallback: { agent: 'claude', model: 'sonnet', effort: 'low' } } }
const BROWSER = { id: 'browser', name: 'Browser checks', description: 'Open pages, click through flows, take screenshots', route: { model: { agent: 'claude', model: 'haiku' }, fallback: null } }
const TYPED_AVAIL = { agents: ['claude', 'codex'], models: { claude: null, codex: [{ id: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] }] } }
const typedDeps = (over = {}) => fakeDeps({ routing: { types: [IMAGES, BROWSER] }, avail: TYPED_AVAIL, ...over })

test('types lists the user types with their models, or says there are none and tasks go by difficulty', async () => {
  const none = fakeDeps()
  assert.equal(await typesCommand(argsOf({}, 'types'), none), 0)
  assert.equal(none.output[0], 'No task types are set: every worker task goes by difficulty (--kind simple, normal or hard). The user adds types in Settings → Models.')
  const noneJson = fakeDeps()
  await typesCommand(argsOf({ json: true }, 'types'), noneJson)
  assert.deepEqual(JSON.parse(noneJson.output[0]), [])
  const deps = typedDeps()
  await typesCommand(argsOf({}, 'types'), deps)
  assert.equal(deps.output[0], [
    '2 task types. Give a task --type <id> only when it clearly fits the description; every other task goes by difficulty (--kind).',
    '  images  Images: Make or edit images, icons and illustrations',
    '    → Codex gpt-6-luna · medium, fallback Claude Sonnet · low',
    '  browser  Browser checks: Open pages, click through flows, take screenshots',
    '    → Claude Haiku, no fallback'
  ].join('\n'))
  const json = typedDeps()
  await typesCommand(argsOf({ json: true }, 'types'), json)
  assert.deepEqual(JSON.parse(json.output[0])[0], { id: 'images', name: 'Images', description: IMAGES.description, model: 'Codex gpt-6-luna · medium', fallback: 'Claude Sonnet · low', route: IMAGES.route })
  assert.equal(deps.calls.length, 0, 'reads the settings only')
})

test('route --type uses the type row and --explain shows it; an unknown type is refused with the known ones', async () => {
  const deps = typedDeps()
  assert.equal(await routeCommand(argsOf({ role: 'worker', type: 'Images', kind: 'hard', explain: true }, 'route'), deps), 0)
  assert.equal(deps.output[0], [
    'Codex gpt-6-luna · medium (type)',
    '  why: Images task → Codex gpt-6-luna · medium',
    '  flags: --agent codex --model gpt-6-luna --effort medium',
    '  type row: Images (images) → Codex gpt-6-luna · medium, fallback Claude Sonnet · low (Settings → Models)',
    '  passed over: none'
  ].join('\n'))
  const unknown = typedDeps()
  assert.equal(await routeCommand(argsOf({ role: 'worker', type: 'video' }, 'route'), unknown), 3)
  assert.equal(unknown.output[0], 'no model: No task type "video". Known types: images (Images), browser (Browser checks). Use one of these, or route by difficulty with --kind.')
  await assert.rejects(routeCommand(argsOf({ role: 'worker', type: true }, 'route'), typedDeps()), /--type needs a task type id/)
  await assert.rejects(routeCommand(argsOf({ role: 'lead', type: 'images' }, 'route'), typedDeps()), /--type is for workers only/)
})

test('dispatch --type starts on the type model and logs the type id; an unknown type starts nothing', async () => {
  const deps = typedDeps()
  await dispatchCommand(argsOf({ role: 'worker', type: 'IMAGES', worktree: 'current', spec: 'Make the icon' }, 'dispatch'), deps)
  assert.deepEqual(starts(deps)[0].args.slice(-6), ['--agent', 'codex', '--model', 'gpt-6-luna', '--effort', 'medium'])
  const [entry] = readRoutes(deps.dir)
  assert.deepEqual([entry.type, entry.kind, entry.source, entry.reason], ['images', null, 'type', 'Images task → Codex gpt-6-luna · medium'])
  const unknown = typedDeps()
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', type: 'video', worktree: 'current', spec: 's' }, 'dispatch'), unknown), (e) => e.code === 3 && /No task type "video"\. Known types: images/.test(e.message))
  assert.equal(starts(unknown).length, 0)
  // an explicit model still wins, and the type is still logged
  const own = typedDeps()
  await dispatchCommand(argsOf({ role: 'worker', type: 'images', model: 'opus', worktree: 'current', spec: 's' }, 'dispatch'), own)
  assert.deepEqual(starts(own)[0].args.slice(-4), ['--agent', 'claude', '--model', 'opus'])
  assert.equal(readRoutes(own.dir)[0].type, 'images')
})

test('--retry-of a typed task runs on its fallback once, then is refused; never the difficulty rows', async () => {
  const deps = typedDeps()
  await dispatchCommand(argsOf({ role: 'worker', type: 'images', worktree: 'current', spec: 's' }, 'dispatch'), deps)
  await dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_1', worktree: 'current' }, 'dispatch'), deps)
  assert.deepEqual(starts(deps)[1].args.slice(-6), ['--agent', 'claude', '--model', 'sonnet', '--effort', 'low'])
  const retried = readRoutes(deps.dir).at(-1)
  assert.deepEqual([retried.type, retried.attempt, retried.reason], ['images', 1, 'Images task, retried → Claude Sonnet · low: fallback after a failure'])
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_2', worktree: 'current' }, 'dispatch'), deps), (e) => e.code === 3 && /^no model: No stronger model for Images: ask the user before trying again\./.test(e.message))
  assert.equal(starts(deps).length, 2)
  // the primary was unavailable, so the fallback ran and failed: the retry would land on it again
  const fbRan = typedDeps({ avail: CLAUDE_ONLY })
  logLine(fbRan, { choice: { agent: 'claude', model: 'sonnet', effort: 'low' }, source: 'fallback', reason: 'r', type: 'images', kind: null })
  await assert.rejects(dispatchCommand(argsOf({ role: 'worker', 'retry-of': 'ctx_old', worktree: 'current' }, 'dispatch'), fbRan), (e) => e.code === 3 && /^No stronger model for Images: ask the user before trying again\. Attempt 1 routes to Claude Sonnet · low again/.test(e.message))
  assert.equal(starts(fbRan).length, 0)
})
