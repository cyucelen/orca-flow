import { assert, test } from 'orca/testing'
import { memberFrom, wakePlan } from './coordinator-sessions.ts'
import { assignCoordinators } from './coordinators.ts'
import type { Coordinator, Snapshot } from './protocol.ts'
import { projectSplit, readSplitEvidence, splitRoots } from './split-coordinators.ts'
import { chatTargets, coordinatorOrder, emptyUi, render } from './view.ts'
import { foldCoordinatorFolders, fromPs, openNthChat } from './worker.ts'

const dir = '/fixture/coordinators/bounti', folder = 'fixture:bounti'
const agent = (pane: string, title: string, parent: string | null = null) => ({
  paneKey: pane, address: 'term_' + pane, orcaSessionId: 'session-' + pane,
  agentType: 'codex', hasLivePty: true, parentPaneKey: parent, state: 'working', conversationName: title
})
const ps = [
  { path: dir, liveTerminalCount: 4, agents: [
    { ...agent('main', 'Bounti coordination'), orcaSessionId: '443e2b6b-4e2d-459b-a723-cd75b16da3ea' },
    { ...agent('aux', 'Bounti coordination'), orcaSessionId: '814f841e-4c6e-4129-b77f-ba310d41c46a' },
    agent('breitner', 'Breitner shift scheduling'), agent('ordinary', 'Bounti coordination')
  ] },
  { path: '/fixture/mono', identity: { key: 'mono' }, liveTerminalCount: 3, agents: [
    agent('adopt', 'Adopt services lead', 'main'), agent('nested', 'Verify service', 'adopt'),
    agent('des', 'Super admin visibility', 'adopt')
  ] }
]
const run = (id: string, owner: string, objective: string) => ({ id, coordinator_handle: 'term_' + owner, objective })
const worker = (pane: string, runId: string, parent?: string) => ({ agentTerminalHandle: 'term_' + pane, runId, dispatchStatus: 'dispatched',
  taskId: 'task-' + pane, terminalState: 'active', projection: { parent: parent ? { taskId: 'task-' + parent } : null } })
const routes = [run('run-des', 'main', 'DES-340'), run('run-adopt', 'aux', 'Adopt isola'), run('run-task', 'breitner', 'Worker-owned run')]
const workers = [worker('adopt', 'run-adopt'), worker('nested', 'run-adopt', 'adopt'), worker('breitner', 'run-des'), worker('des', 'run-des')]
const page = (workers: unknown[], nextCursor: string | null = null) => ({ scope: { source: 'all' }, workers, page: { hasMore: !!nextCursor, nextCursor } })

async function fixture() {
  const roots = splitRoots(ps, [dir])
  const evidence = (await readSplitEvidence(async args => {
    if (args[1] === 'run-list') return { runs: routes }
    assert.equal(args[1], 'worker-list')
    assert.ok(!args.includes('--run'))
    return args.includes('--cursor') ? page(workers.slice(2)) : page(workers.slice(0, 2), 'two')
  }, roots))!
  const rows = fromPs(ps, undefined, new Map([[dir, folder]]))
  const main = memberFrom(rows[0], rows[0].agents[0])
  const sessions = { version: 1 as const, current: main.id, members: [main] }
  const c = { name: 'bounti', key: 'bounti', dir, about: '', workspaceId: folder, repos: [], sessions }
  const lineage = { paneOf: new Map(ps.flatMap(r => r.agents.map(a => [a.address, a.paneKey] as const))),
    dispatcherOf: new Map([['des', 'term_main'], ['adopt', 'term_aux'], ['nested', 'term_adopt']]),
    dispatchOf: new Map<string, 'open'>([['adopt', 'open'], ['nested', 'open'], ['des', 'open']]) }
  // Breitner has no ps parent and no row in the recent-run cache. Its durable dispatch is on page 2.
  const all = assignCoordinators(rows, [c], lineage)
  const projected: Coordinator = { ...c }
  const visible = foldCoordinatorFolders(all, [projected], [dir])
  const before = JSON.stringify({ all, sessions })
  projected.split = projectSplit(projected, all, roots, evidence)
  assert.equal(JSON.stringify({ all, sessions }), before)
  const snap: Snapshot = { rows: visible, coordinators: [projected], source: 'cli', capacity: null }
  return { all, roots, evidence, c: projected, main, snap }
}

test('split projects main, auxiliary and dispatched branches with exact click and shortcut targets', async () => {
  const { c, all, main, snap } = await fixture()
  assert.deepEqual(c.split?.mainRuns.map(r => r.id), ['run-des'])
  assert.deepEqual(c.split?.auxiliary.map(r => [r.pane, r.runs.map(run => run.id)]), [['aux', ['run-adopt']]])
  const html = render(snap, emptyUi()).main
  const sections = html.match(/<section class="coordinator">[\s\S]*?<\/section>/g)!
  assert.equal(sections.length, 2)
  assert.match(sections[0], /Main · DES-340/)
  assert.match(sections[0], /data-coordinator="bounti"/)
  assert.match(sections[0], /data-terminal="term_breitner"/)
  assert.match(sections[0], /data-terminal="term_des"/)
  assert.ok(!sections[0].includes('term_adopt'))
  assert.match(sections[1], /Auxiliary coordinator/)
  assert.match(sections[1], /Adopt isola/)
  assert.match(sections[1], /data-open="fixture:bounti" data-terminal="term_aux"/)
  assert.match(sections[1], /data-menu="agent:adopt"[^>]*data-depth="0"/)
  assert.match(sections[1], /data-menu="agent:nested"[^>]*data-depth="1"/)
  assert.ok(!sections[1].includes('term_breitner') && !sections[1].includes('data-coordinator='))
  assert.deepEqual(coordinatorOrder(snap).map(c => c.key), ['bounti'])
  assert.deepEqual(wakePlan(c, all, 0), { kind: 'open', member: main, workspaceId: folder, terminal: 'term_main' })
  const targets = chatTargets(snap)
  const opened: unknown[] = []
  for (let n = 1; n <= targets.length; n++) await openNthChat(targets, n, {
    coordinator: async key => { opened.push(key); return { ok: true } },
    chat: async target => { opened.push(target) }
  })
  assert.deepEqual(opened, ['bounti', { workspaceId: folder, terminal: 'term_breitner' },
    { workspaceId: 'identity:mono', terminal: 'term_des' }, { workspaceId: folder, terminal: 'term_ordinary' },
    { workspaceId: folder, terminal: 'term_aux' }, { workspaceId: 'identity:mono', terminal: 'term_adopt' },
    { workspaceId: 'identity:mono', terminal: 'term_nested' }])
  assert.deepEqual(chatTargets(snap, new Set(['bounti'])).map(t => t.key), ['coordinator:bounti', 'agent:aux', 'agent:adopt', 'agent:nested'])
})

test('run holding, titles and folder alone cannot promote a task, stale, ambiguous or historical conversation', async () => {
  const { c, all, roots, evidence } = await fixture()
  const aux = all[0].agents.find(a => a.paneKey === 'aux')!
  const check = () => projectSplit(c, all, roots, evidence)
  assert.equal(check()?.auxiliary.length, 1)
  for (const overrides of [{ parentPane: 'main' }, { dispatch: 'settled' as const }, { live: false }, { terminal: 'term_reused' }, { orcaSession: 'different' }]) {
    const old = { ...aux }
    Object.assign(aux, overrides)
    assert.equal(check(), undefined)
    Object.assign(aux, old)
  }
  assert.equal(projectSplit(c, all, [...roots, { ...roots[1], pane: 'ambiguous' }], evidence), undefined)
  const changed = evidence.routes.map(r => r.coordinator_handle === 'term_aux' ? { ...r, coordinator_orca_session_id: 'another' } : r)
  assert.equal(projectSplit(c, all, roots, { ...evidence, routes: changed }), undefined)
  const moved = evidence.routes.map(r => r.coordinator_handle === 'term_aux' ? { ...r, coordinator_handle: 'term_main' } : r)
  assert.equal(projectSplit(c, all, roots, { ...evidence, routes: moved }), undefined)
  c.members!.push({ ...memberFrom(all[0], aux), agent: aux })
  assert.equal(check(), undefined)
})

test('partial, bounded and malformed worker inventories cannot verify a split', async () => {
  const roots = splitRoots(ps, [dir])
  assert.deepEqual(splitRoots(ps.map(w => ({ ...w, hostId: 'other-host' })), [dir]), [])
  const legacyOnly = await readSplitEvidence(async args => {
    assert.equal(args[1], 'run-list')
    return { runs: [routes[0], { ...routes[1], legacy: 1 }] }
  }, roots)
  assert.equal(legacyOnly, undefined)
  for (const result of [{ ...page([]), scope: { source: 'bound' } }, { ...page([]), page: { hasMore: true, nextCursor: null } },
    page([], 'repeated'), page([{}])]) {
    const evidence = await readSplitEvidence(async args => args[1] === 'run-list' ? { runs: routes } : result, roots)
    assert.equal(evidence, undefined)
  }
})
