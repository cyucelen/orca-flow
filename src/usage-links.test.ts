// Analytics attribution: link snapshots (pane → session → dispatch, written only on change) and
// resolve (each observation to exactly one dispatch, or Unattributed).
import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendLinks, dispatchInfo, isoTime, outcomeOf, readLinks, resolve, snapshotLinks, workerDoneOutcomes,
  type DispatchInfo, type DispatchLink, type LinkRecord, type RouteLine
} from './usage-links.ts'

const T = (min: number) => new Date(Date.parse('2026-11-23T10:00:00.000Z') + min * 60_000).toISOString()
const claude = (id: string) => ({ provider: 'claude' as const, id })
const dispatch = (id: string, over: Partial<DispatchInfo> = {}): DispatchInfo => ({
  dispatchId: id, taskId: `task_${id}`, runId: 'run_1', paneKey: `pane_${id}`, parentDispatchId: null, retryOf: null,
  workspace: 'repo::/w', dispatchedAt: T(0), completedAt: null, outcome: null, ...over
})
const route = (dispatchId: string, over: Partial<RouteLine> = {}): RouteLine => ({
  at: T(0), role: 'worker', taskId: `task_${dispatchId}`, dispatchId, workspace: 'repo::/w', choice: { agent: 'claude', model: 'sonnet', effort: 'medium' },
  type: null, kind: 'normal', class: 'standard', risk: null, context: null, attempt: 0, ...over
})
const obs = (session: string, min: number, provider = 'claude') => ({ provider, session, at: T(min) })

test('isoTime reads ISO and SQLite UTC times; outcomeOf maps worker_done outcomes', () => {
  assert.equal(isoTime('2026-11-23 14:52:06'), '2026-11-23T14:52:06.000Z')
  assert.equal(isoTime('2026-11-23T14:56:12.647Z'), '2026-11-23T14:56:12.647Z')
  assert.equal(isoTime('soon'), null)
  assert.equal(isoTime(null), null)
  assert.deepEqual([outcomeOf('succeeded'), outcomeOf('failed'), outcomeOf('working'), outcomeOf(undefined)], ['accepted', 'failed', null, null])
})

test('dispatchInfo reads worker-show --full, dispatch-show and the concise view; the reported outcome wins', () => {
  // worker-show --dispatch <id> --json --full (shape seen 2026-11-23)
  const full = {
    dispatch: { id: 'ctx_w', taskId: 'task_w', runId: 'run_1', assigneePaneKey: 'tab:pane', retryOfDispatchId: 'ctx_old', creatorDispatchId: 'ctx_lead', status: 'completed', dispatchedAt: '2026-11-23 14:52:06', completedAt: '2026-11-23T14:56:12.647Z' },
    worker: { state: 'succeeded', worktreeId: 'repo::/w' },
    projection: { outcome: 'succeeded', workspace: { id: 'repo::/w' } }
  }
  assert.deepEqual(dispatchInfo(full), {
    dispatchId: 'ctx_w', taskId: 'task_w', runId: 'run_1', paneKey: 'tab:pane', parentDispatchId: 'ctx_lead', retryOf: 'ctx_old',
    workspace: 'repo::/w', dispatchedAt: '2026-11-23T14:52:06.000Z', completedAt: '2026-11-23T14:56:12.647Z', outcome: 'accepted'
  })
  assert.equal(dispatchInfo(full, 'failed')!.outcome, 'failed', 'the worker_done message is the source of truth')
  // dispatch-show --task <id> --json: snake_case
  const snake = { dispatch: { id: 'ctx_s', task_id: 'task_s', run_id: 'run_2', assignee_pane_key: 'p', creator_dispatch_id: 'ctx_c', retry_of_dispatch_id: null, status: 'dispatched', dispatched_at: '2026-11-23 15:00:42', completed_at: null } }
  const s = dispatchInfo(snake)!
  assert.deepEqual([s.taskId, s.runId, s.paneKey, s.parentDispatchId, s.retryOf, s.completedAt, s.outcome], ['task_s', 'run_2', 'p', 'ctx_c', null, null, null])
  // a dispatch Orca failed without a report
  assert.equal(dispatchInfo({ dispatch: { id: 'ctx_f', status: 'failed' } })!.outcome, 'failed')
  // concise worker-show: no pane, parent or retry
  const concise = dispatchInfo({ dispatchId: 'ctx_c', taskId: 't', runId: 'r', state: 'succeeded', workspace: 'repo::/w' })!
  assert.deepEqual([concise.dispatchId, concise.paneKey, concise.outcome, concise.workspace], ['ctx_c', null, 'accepted', 'repo::/w'])
  assert.equal(dispatchInfo(null), null)
  assert.equal(dispatchInfo({ dispatch: {} }), null)
})

test('workerDoneOutcomes reads type and payload only, latest report per dispatch', () => {
  const inbox = { messages: [
    { type: 'worker_done', sequence: 3, subject: 'secret', body: 'secret', payload: { taskId: 't1', dispatchId: 'ctx_1', outcome: 'succeeded' } },
    { type: 'worker_done', sequence: 1, payload: JSON.stringify({ dispatchId: 'ctx_1', outcome: 'failed' }) },
    { type: 'worker_done', sequence: 2, payload: { dispatchId: 'ctx_2', outcome: 'failed' } },
    { type: 'status', payload: { dispatchId: 'ctx_3', outcome: 'succeeded' } },
    { type: 'worker_done', payload: 'not json' }
  ] }
  const out = workerDoneOutcomes(inbox)
  assert.deepEqual([...out.entries()].sort(), [['ctx_1', 'accepted'], ['ctx_2', 'failed']])
  assert.equal(workerDoneOutcomes(null).size, 0)
})

test('snapshotLinks joins dispatch, pane binding and route; writes only on change', () => {
  const d = dispatch('ctx_w', { parentDispatchId: 'ctx_lead', retryOf: null })
  const routes = [route('ctx_w', { kind: undefined, class: 'complex', risk: 'high', attempt: 1, retryOf: 'ctx_old', arm: 'variant', pair: 'p1' }), route('ctx_other')]
  const first = snapshotLinks({ at: T(1), dispatches: [d], bindings: { pane_ctx_w: claude('s1') }, routes, previous: [] })
  assert.equal(first.length, 1)
  assert.deepEqual(first[0], {
    type: 'dispatch', at: T(1), paneKey: 'pane_ctx_w', providerSession: claude('s1'), dispatchId: 'ctx_w', taskId: 'task_ctx_w', runId: 'run_1',
    parentDispatchId: 'ctx_lead', retryOf: 'ctx_old', role: 'worker', workspace: 'repo::/w', kind: 'hard', taskType: null, risk: 'high', context: null,
    attempt: 1, model: { agent: 'claude', model: 'sonnet', effort: 'medium' }, arm: 'variant', pair: 'p1', dispatchedAt: T(0), completedAt: null, outcome: null
  })
  // the same sample later: nothing new
  assert.deepEqual(snapshotLinks({ at: T(2), dispatches: [d], bindings: { pane_ctx_w: claude('s1') }, routes, previous: first }), [])
  // the pane's session changed (e.g. /clear): a new record; the old one stays in the file
  const second = snapshotLinks({ at: T(3), dispatches: [d], bindings: { pane_ctx_w: claude('s2') }, routes, previous: first })
  assert.equal(second.length, 1)
  assert.deepEqual(second[0].type === 'dispatch' && second[0].providerSession, claude('s2'))
  // pane not sampled this time (missing from bindings): the last session is kept, nothing new
  assert.deepEqual(snapshotLinks({ at: T(4), dispatches: [d], bindings: {}, routes, previous: [...first, ...second] }), [])
  // completed: outcome recorded; the pane now holds other work, which is ignored
  const done = { ...d, completedAt: T(5), outcome: 'accepted' as const }
  const third = snapshotLinks({ at: T(6), dispatches: [done], bindings: { pane_ctx_w: claude('someone-else') }, routes, previous: [...first, ...second] }) as DispatchLink[]
  assert.equal(third.length, 1)
  assert.deepEqual([third[0].providerSession, third[0].completedAt, third[0].outcome], [claude('s2'), T(5), 'accepted'])
  assert.deepEqual(snapshotLinks({ at: T(7), dispatches: [done], bindings: {}, routes, previous: [...first, ...second, ...third] }), [])
})

test('snapshotLinks: no route line keeps what was seen; handovers are recorded once', () => {
  const d = dispatch('ctx_x')
  const [a] = snapshotLinks({ at: T(1), dispatches: [d], bindings: { pane_ctx_x: null }, routes: [route('ctx_x', { type: 'images', kind: null, class: null })], previous: [] }) as DispatchLink[]
  assert.deepEqual([a.providerSession, a.taskType, a.kind], [null, 'images', null])
  // the route line is gone (pruned): fields stay
  const later = snapshotLinks({ at: T(2), dispatches: [d], bindings: { pane_ctx_x: null }, routes: [], previous: [a] })
  assert.deepEqual(later, [])
  const h = { from: claude('old'), to: claude('new') }
  const hs = snapshotLinks({ at: T(3), dispatches: [], bindings: {}, routes: [], previous: [], handovers: [h, { from: claude('x'), to: claude('x') }] })
  assert.deepEqual(hs, [{ type: 'handover', at: T(3), from: claude('old'), to: claude('new') }])
  assert.deepEqual(snapshotLinks({ at: T(4), dispatches: [], bindings: {}, routes: [], previous: hs, handovers: [h] }), [])
})

/** One run: a lead with a worker, the worker's failed first attempt and its retry, a handover. */
function scenario(): LinkRecord[] {
  const routes = [route('ctx_lead', { role: 'lead' }), route('ctx_w1'), route('ctx_w2', { attempt: 1, retryOf: 'ctx_w1' })]
  const lead = dispatch('ctx_lead', { dispatchedAt: T(0) })
  const w1 = dispatch('ctx_w1', { parentDispatchId: 'ctx_lead', dispatchedAt: T(10) })
  const w2 = dispatch('ctx_w2', { parentDispatchId: 'ctx_lead', retryOf: 'ctx_w1', taskId: 'task_ctx_w1', dispatchedAt: T(30) })
  const links: LinkRecord[] = []
  const add = (at: number, dispatches: DispatchInfo[], bindings: Record<string, ReturnType<typeof claude> | null>, handovers?: { from: any; to: any }[]) =>
    links.push(...snapshotLinks({ at: T(at), dispatches, bindings, routes, previous: links, handovers }))
  add(1, [lead], { pane_ctx_lead: claude('lead-s') })
  add(11, [lead, w1], { pane_ctx_lead: claude('lead-s'), pane_ctx_w1: claude('w1-s') })
  add(25, [lead, { ...w1, completedAt: T(24), outcome: 'failed' }], {})
  // the retry reuses the same pane and session (a fresh TASK block in the same terminal)
  add(31, [lead, { ...w2, paneKey: 'pane_ctx_w1' }], { pane_ctx_w1: claude('w1-s') })
  add(50, [{ ...lead, completedAt: T(49), outcome: 'accepted' }, { ...w2, paneKey: 'pane_ctx_w1', completedAt: T(45), outcome: 'accepted' }], {}, [{ from: claude('lead-s'), to: claude('lead-s2') }])
  return links
}

test('resolve: lead vs worker vs retry vs unattributed vs handover, each observation exactly once', () => {
  const links = scenario()
  const observations = [
    obs('lead-s', 5),    // lead
    obs('w1-s', 12),     // worker, first attempt
    obs('lead-s', 15),   // lead while its worker runs: still the lead, not the worker
    obs('w1-s', 26),     // after the failed report, before the retry: still the first attempt
    obs('w1-s', 35),     // the retry in the same session
    obs('w1-s', 60),     // after the retry finished: its last dispatch
    obs('lead-s2', 55),  // the handover successor: no dispatch of its own
    obs('plain', 20),    // a plain terminal
    obs('lead-s', 1, 'codex'), // same id, other provider
    obs('w1-s', 9)       // before the session's first dispatch
  ]
  const got = resolve(observations, links)
  assert.equal(got.length, observations.length, 'every observation once')
  assert.deepEqual(got.map((r) => r.to?.dispatchId ?? 'Unattributed'), ['ctx_lead', 'ctx_w1', 'ctx_lead', 'ctx_w1', 'ctx_w2', 'ctx_w2', 'Unattributed', 'Unattributed', 'Unattributed', 'Unattributed'])
  const w1 = got[1].to!, w2 = got[4].to!
  assert.deepEqual([w1.parentDispatchId, w1.outcome, w1.retryOf], ['ctx_lead', 'failed', null])
  assert.deepEqual([w2.parentDispatchId, w2.retryOf, w2.attempt, w2.taskId, w2.outcome], ['ctx_lead', 'ctx_w1', 1, 'task_ctx_w1', 'accepted'])
  assert.equal(got[0].to!.role, 'lead')
  assert.equal(got[0].to!.outcome, 'accepted', 'the latest record of a dispatch is used')
  // handover: the predecessor keeps its usage and gets the successor link; the successor's usage is not moved
  assert.deepEqual(got[0].continuedIn, claude('lead-s2'))
  assert.equal(got[6].continuedIn, null)
  assert.equal(got[1].continuedIn, null)
})

test('resolve without links, and with a dispatch Orca gave no start time (first sample counts)', () => {
  assert.deepEqual(resolve([obs('a', 1)], []).map((r) => r.to), [null])
  const links = snapshotLinks({ at: T(20), dispatches: [dispatch('ctx_n', { dispatchedAt: null })], bindings: { pane_ctx_n: claude('n') }, routes: [], previous: [] })
  assert.deepEqual(resolve([obs('n', 19), obs('n', 20), { provider: 'claude', session: 'n', at: Date.parse(T(21)) }], links).map((r) => r.to?.dispatchId ?? null), [null, 'ctx_n', 'ctx_n'])
})

test('links.jsonl: append only when there is something, read skips junk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-links-'))
  try {
    const file = join(dir, 'usage', 'links.jsonl')
    appendLinks([], file)
    assert.deepEqual(readLinks(file), [])
    const recs = snapshotLinks({ at: T(1), dispatches: [dispatch('ctx_a')], bindings: { pane_ctx_a: claude('a') }, routes: [], previous: [] })
    appendLinks(recs, file)
    writeFileSync(file, readFileSync(file, 'utf8') + 'not json\n{"type":"other"}\n')
    appendLinks(recs, file)
    assert.deepEqual(readLinks(file), [...recs, ...recs])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
