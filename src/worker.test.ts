// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker.ts'
import { canRemove, monitoring, nextTarget, waitingQueue } from './rank.ts'
import { assignCoordinators, COORDINATOR_FILE, deleteFolder, isCoordinatorHome, readCoordinators, readLinearMemory, readOwners, rememberOwners, scaffoldCoordinator, validateName, writeLinearMemory, writeLinearTeams, writeLook, writeOwners } from './coordinators.ts'
import { buildCockpit, removeWorktree } from './cockpit.ts'
import { emptyUi, render } from './view.ts'

const ps: main.PsWorktree[] = [
  {
    identity: { key: 'wt2:local:a' }, displayName: 'live-preview', repo: 'shop',
    branch: 'refs/heads/me/live-preview', liveTerminalCount: 2, lastActivityAt: 5,
    agents: [
      { state: 'done', agentType: 'claude', conversationName: 'Old task' },
      { state: 'waiting', agentType: 'claude', conversationName: 'Live preview design' }
    ]
  },
  { identity: { key: 'wt2:local:b' }, displayName: 'gone', repo: 'shop', isArchived: true },
  { identity: { key: 'wt2:local:c' }, displayName: 'main', repo: 'tools', agents: [] }
]

test('maps the CLI snapshot: ids, most urgent state, archived dropped', () => {
  const rows = main.fromPs(ps)
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.state, r.branch]), [
    ['identity:wt2:local:a', 'live-preview', 'waiting', 'me/live-preview'],
    ['identity:wt2:local:c', 'main', null, null]
  ])
  assert.equal(rows[0].agents.length, 2)
})

test('merges coordinator cards and hook summaries by worktree and pane', () => {
  const withPanes: main.PsWorktree[] = [
    { identity: { key: 'wt2:local:a' }, displayName: 'x', repo: 'shop', agents: [{ paneKey: 'tab:leaf', state: 'done', conversationName: 'Old name' }] },
    { identity: { key: 'wt2:local:b' }, displayName: 'y', repo: 'shop', agents: [{ paneKey: 'tab:other', state: 'done' }] }
  ]
  const store: main.Store = {
    cards: { 'wt2_local_a': { priority: 'P0', goal: 'Stop the outage' } },
    summaries: {
      'tab_leaf': { title: 'Outage fix', goal: '', since: 'Rolled back', needs: { type: 'approval', ask: 'Deploy?', options: [] }, effort: 'quick', priority: 'P2', role: 'solo', updatedAt: 1 },
      'tab_other': { title: 'Docs', goal: '', since: '', needs: { type: 'none', ask: '', options: [] }, effort: 'deep', priority: 'P3', role: 'solo', updatedAt: 1 }
    }
  }
  const [a, b] = main.fromPs(withPanes, store)
  assert.equal(a.priority, 'P0') // the card wins over the summary's guess
  assert.equal(a.agents[0].title, 'Outage fix')
  assert.equal(a.agents[0].summary?.needs.ask, 'Deploy?')
  assert.equal(b.priority, 'P3') // no card: the summary's guess
})

test('falls back to workspace.list when the CLI fails', async () => {
  const workspaces = [{ id: 'x', kind: 'worktree', name: 'main', path: '/u/projects/shop', branch: 'refs/heads/main', hostId: 'local' }]
  const logs: string[] = []
  const orca = { host: { call: async () => ({ workspaces, truncated: false }) }, log: (m: string) => logs.push(m) }
  const answer = await main.snapshot(orca as never, () => Promise.reject(new Error('no cli')))
  assert.equal(answer.source, 'api')
  assert.deepEqual(answer.rows.map((r) => [r.id, r.repo, r.state]), [['x', 'shop', null]])
  assert.equal(logs.length, 1)
})

test('opens a workspace through the host', async () => {
  const host = mockHost({ results: { 'workspace.open': { opened: true } } })
  const worker = await mountWorker(main, { host })
  await worker.request('sidebar.open', { workspaceId: 'identity:wt2:local:a' })
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'identity:wt2:local:a' }])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test("opening an agent shows its own tab, not the worktree's last one", async () => {
  const opened: unknown[] = []
  const logs: string[] = []
  const orca = { host: { call: async (_: string, params: unknown) => (opened.push(params), { opened: true }) }, log: (m: string) => logs.push(m) }
  const ran: string[][] = []
  const run = async (args: string[]) => { ran.push(args); return {} }
  await main.openAgent(orca as never, run, { workspaceId: 'identity:w', terminal: 'term-worker' })
  assert.deepEqual(opened, [{ workspaceId: 'identity:w' }])
  assert.deepEqual(ran, [['terminal', 'switch', '--terminal', 'term-worker']])
  // A session that slept has no terminal: the workspace alone.
  await main.openAgent(orca as never, run, { workspaceId: 'identity:w' })
  assert.equal(ran.length, 1)
  // A failed switch still leaves the workspace open, and says why.
  assert.deepEqual(await main.openAgent(orca as never, () => Promise.reject(new Error('no such terminal')), { workspaceId: 'identity:w', terminal: 'gone' }), { opened: true })
  assert.match(logs[0], /terminal switch failed: no such terminal/)
})

test('jump goes to the top, and pressing again moves past an item just opened', () => {
  const rows = main.fromPs([
    { identity: { key: 'a' }, displayName: 'a', repo: 'r', agents: [{ paneKey: 'pa', state: 'waiting' }], lastActivityAt: 1 },
    { identity: { key: 'b' }, displayName: 'b', repo: 'r', agents: [{ paneKey: 'pb', state: 'blocked' }], lastActivityAt: 2 }
  ])
  const queue = waitingQueue(rows)
  assert.equal(nextTarget(queue, null, 0)?.id, 'identity:a')
  assert.equal(nextTarget(queue, { id: 'identity:a', at: 0 }, 1000)?.id, 'identity:b')
  assert.equal(nextTarget(queue, { id: 'identity:b', at: 0 }, 1000)?.id, 'identity:a', 'wraps around')
  assert.equal(nextTarget(queue, { id: 'identity:a', at: 0 }, 11 * 60_000)?.id, 'identity:a', 'an old jump starts over')
  assert.equal(nextTarget([], null, 0), undefined)
})

test('capacity and the status bar item come from the same rows', () => {
  const rows = main.fromPs([
    { identity: { key: 'a' }, displayName: 'a', repo: 'shop', liveTerminalCount: 1, agents: [{ paneKey: 'pa', state: 'waiting' }, { paneKey: 'pb', state: 'done' }] }
  ])
  const facts = { availableGB: 6.1, totalGB: 16, agentGB: 0.5, envGB: { 'shop': 2.6 }, diskFreeGB: 31 }
  const capacity = main.capacityOf(rows, 'normal', facts, '/nonexistent', () => false)
  assert.deepEqual(capacity, { verdict: 'ok', freeGB: 4.1, marginGB: 2, measuring: false, diskFreeGB: 31, agentGB: 0.5, envGB: 2.6, pressure: 'normal', finishedOpen: 1 })
  const status = main.statusOf({ rows, source: 'cli', capacity, coordinators: [] })
  assert.equal(status.text, '1 waiting')
  assert.match(status.tooltip, /Next: shop\/a/)
  assert.match(status.tooltip, /4\.1 GB free \(after a 2 GB margin\)/)
  const full = main.capacityOf(rows, 'normal', { ...facts, availableGB: 2.3 }, '/nonexistent', () => false)
  assert.equal(full.verdict, 'full')
  assert.equal(main.statusOf({ rows, source: 'cli', capacity: full, coordinators: [] }).text, '1 waiting · memory full')
})

test('your coordinators: their sessions dispatch workers, dispatch chains follow, the rest is yours', () => {
  const rows = main.fromPs([
    { identity: { key: 'home' }, displayName: 'alpha', repo: 'alpha', path: '/c/alpha', agents: [{ paneKey: 'p-home', state: 'working' }] },
    { identity: { key: 'a' }, displayName: 'coord', repo: 'shop', agents: [{ paneKey: 'p-coord', state: 'working' }] },
    { identity: { key: 'b' }, displayName: 'dup', repo: 'shop', agents: [{ paneKey: 'p-dup', state: 'working' }] },
    { identity: { key: 'c' }, displayName: 'mine', repo: 'shop', agents: [{ paneKey: 'p-mine', state: 'working' }] }
  ])
  const coordinators = [{ key: 'alpha', name: 'alpha', repos: ['shop'], about: '', dir: '/c/alpha', workspaceId: null }]
  const lineage = {
    dispatcherOf: new Map([['p-coord', 'term-home'], ['p-dup', 'term-coord']]),
    paneOf: new Map([['term-home', 'p-home'], ['term-coord', 'p-coord']])
  }
  const out = assignCoordinators(rows, coordinators, lineage).slice(1).map((r) => [r.agents[0].coordinator, r.agents[0].leadPane])
  assert.deepEqual(out, [['alpha', null], ['alpha', 'p-coord'], ['you', null]])
})

test("a lead's worker started inside its coordinator's run nests under the lead, which stays at work", async () => {
  const { finishedAgents } = await import('./view.ts')
  // As `orca worktree ps` reports it: the worker's parent is the lead, the lead's is the coordinator.
  const rows = main.fromPs([
    { identity: { key: 'home' }, displayName: 'isola', repo: 'isola', path: '/c/isola', liveTerminalCount: 1, agents: [{ paneKey: 'p-home', state: 'done' }] },
    { identity: { key: 'env' }, displayName: 'env-cleanup', repo: 'isola', path: '/w/env', liveTerminalCount: 2, agents: [
      { paneKey: 'p-worker', parentPaneKey: 'p-lead', state: 'working' },
      { paneKey: 'p-lead', parentPaneKey: 'p-home', state: 'done' }
    ] }
  ])
  const coordinators = [{ key: 'isola', name: 'isola', repos: ['isola'], about: '', dir: '/c/isola', workspaceId: null }]
  // Both dispatches live in the coordinator's run, so the run alone credits both to the coordinator.
  const lineage = {
    dispatcherOf: new Map([['p-lead', 'term-home'], ['p-worker', 'term-home']]),
    paneOf: new Map([['term-home', 'p-home'], ['term-lead', 'p-lead'], ['term-worker', 'p-worker']]),
    dispatchOf: new Map([['p-lead', 'open' as const], ['p-worker', 'open' as const]])
  }
  const [, env] = assignCoordinators(rows, coordinators, lineage)
  const byPane = Object.fromEntries(env.agents.map((a) => [a.paneKey, [a.coordinator, a.leadPane]]))
  assert.deepEqual(byPane, { 'p-worker': ['isola', 'p-lead'], 'p-lead': ['isola', null] })
  assert.deepEqual(finishedAgents([env]).map((a) => a.paneKey), [], 'the lead leads a working worker')
  // An agent without a parent pane still falls back to the run lineage.
  const noParent = main.fromPs([
    { identity: { key: 'home' }, displayName: 'isola', repo: 'isola', path: '/c/isola', agents: [{ paneKey: 'p-home', state: 'done' }] },
    { identity: { key: 'x' }, displayName: 'x', repo: 'isola', agents: [{ paneKey: 'p-worker', state: 'working' }] }
  ])
  assert.deepEqual(assignCoordinators(noParent, coordinators, lineage)[1].agents.map((a) => [a.coordinator, a.leadPane, a.dispatch]), [['isola', null, 'open']])
})

test('a resumed agent keeps its remembered coordinator; live lineage wins and updates the memory', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const coordinators = [
    { key: 'alpha', name: 'alpha', repos: [], about: '', dir: '/c/alpha', workspaceId: null },
    { key: 'beta', name: 'beta', repos: [], about: '', dir: '/c/beta', workspaceId: null }
  ]
  const noLineage = { dispatcherOf: new Map(), paneOf: new Map() }
  // After a resume: new panes, no parent pane, no open dispatch, same Orca sessions.
  const resumed = main.fromPs([
    { identity: { key: 'home' }, displayName: 'alpha', repo: 'alpha', path: '/c/alpha', agents: [{ paneKey: 'p-home', orcaSessionId: 's-home', state: 'working' }] },
    { identity: { key: 'w' }, displayName: 'store', repo: 'shop', agents: [
      { paneKey: 'p-lead2', orcaSessionId: 's-lead', state: 'working' },
      { paneKey: 'p-work2', orcaSessionId: 's-work', state: 'working' },
      { paneKey: 'p-codex', orcaSessionId: null, state: 'working' },
      { paneKey: 'p-new', orcaSessionId: 's-new', state: 'working' }
    ] }
  ])
  const owners = {
    's-lead': { coordinator: 'alpha', leadSession: null },
    's-work': { coordinator: 'alpha', leadSession: 's-lead' },
    'p-codex': { coordinator: 'beta', leadSession: null },
    // A pane-key entry is used only when the agent has no Orca session.
    'p-new': { coordinator: 'beta', leadSession: null },
    // A coordinator that no longer exists is ignored.
    's-gone': { coordinator: 'gamma', leadSession: null }
  }
  const byPane = (rows: ReturnType<typeof assignCoordinators>) => Object.fromEntries(rows.flatMap((r) => r.agents).map((a) => [a.paneKey, [a.coordinator, a.leadPane]]))
  assert.deepEqual(byPane(assignCoordinators(resumed, coordinators, noLineage))['p-lead2'], ['you', null], 'without memory it falls to you')
  const restored = assignCoordinators(resumed, coordinators, noLineage, owners)
  assert.deepEqual(byPane(restored), {
    'p-home': ['you', null],
    'p-lead2': ['alpha', null],
    'p-work2': ['alpha', 'p-lead2'],
    'p-codex': ['beta', null],
    'p-new': ['you', null]
  }, 'memory restores the coordinator and nests the worker under its lead again')

  // A worker the resumed lead dispatches inherits the lead's remembered coordinator through the run.
  const dispatched = main.fromPs([
    { identity: { key: 'w' }, displayName: 'store', repo: 'shop', agents: [
      { paneKey: 'p-lead2', orcaSessionId: 's-lead', state: 'working' },
      { paneKey: 'p-fresh', orcaSessionId: 's-fresh', state: 'working' }
    ] }
  ])
  const viaLead = { dispatcherOf: new Map([['p-fresh', 'term-lead2']]), paneOf: new Map([['term-lead2', 'p-lead2']]) }
  assert.deepEqual(byPane(assignCoordinators(dispatched, coordinators, viaLead, owners))['p-fresh'], ['alpha', 'p-lead2'])

  // Live lineage wins: the lead is now dispatched by beta's coordinator.
  const live = main.fromPs([
    { identity: { key: 'home' }, displayName: 'beta', repo: 'beta', path: '/c/beta', agents: [{ paneKey: 'p-beta', orcaSessionId: 's-beta', state: 'working' }] },
    { identity: { key: 'w' }, displayName: 'store', repo: 'shop', agents: [{ paneKey: 'p-lead2', orcaSessionId: 's-lead', parentPaneKey: 'p-beta', state: 'working' }] }
  ])
  const won = assignCoordinators(live, coordinators, noLineage, owners)
  assert.deepEqual(byPane(won)['p-lead2'], ['beta', null])

  // Remembering: written only on change, keyed by session, else by pane, with the lead's session.
  const next = rememberOwners(restored, {}, '2026-11-17')
  assert.deepEqual(next, {
    's-lead': { coordinator: 'alpha', leadSession: null, seen: '2026-11-17' },
    's-work': { coordinator: 'alpha', leadSession: 's-lead', seen: '2026-11-17' },
    'p-codex': { coordinator: 'beta', leadSession: null, seen: '2026-11-17' }
  })
  assert.equal(rememberOwners(restored, next, '2026-11-17'), null, 'nothing changed, nothing to write')
  assert.deepEqual(rememberOwners(won, next!, '2026-11-17')?.['s-lead'], { coordinator: 'beta', leadSession: null, seen: '2026-11-17' }, 'live lineage updates the memory')
  // An agent that falls to you keeps its entry; entries not seen for a month are dropped.
  const later = rememberOwners(main.fromPs([]), { ...next!, old: { coordinator: 'alpha', leadSession: null, seen: '2026-09-01' } }, '2026-11-17')
  assert.deepEqual(Object.keys(later ?? {}).sort(), ['p-codex', 's-lead', 's-work'])

  const dir = mkdtempSync(join(tmpdir(), 'owners-'))
  writeOwners(next!, join(dir, 'owners.json'))
  assert.deepEqual(readOwners(join(dir, 'owners.json')), next)
  assert.deepEqual(readOwners(join(dir, 'missing.json')), {})
  rmSync(dir, { recursive: true, force: true })
})

test('your coordinators are folders under the coordinator home; new ones are validated and scaffolded', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'coordinators-'))
  scaffoldCoordinator(root, { name: 'main', look: null })
  scaffoldCoordinator(root, { name: 'alpha', look: { color: '#5b8def', shape: 'hex' } })
  assert.deepEqual(readCoordinators(root).map((c) => [c.name, c.repos, c.look?.shape ?? null]), [['alpha', [], 'hex'], ['main', [], null]])
  assert.match(readFileSync(join(root, 'alpha', 'CLAUDE.md'), 'utf8'), new RegExp(`scope is not set yet[\\s\\S]*${COORDINATOR_FILE}`))
  assert.equal(validateName('alpha', ['alpha']), 'alpha already exists')
  assert.equal(validateName('Bad Name', []), 'Use lowercase letters, digits and dashes')
  assert.equal(validateName('ops-2', []), null)
})

test('cockpit stats: heaviest by memory, finished sessions with their terminals', () => {
  const rows = main.fromPs([
    { identity: { key: 'a' }, displayName: 'a', repo: 'shop', agents: [{ paneKey: 'p1', state: 'working', conversationName: 'Busy' }] },
    { identity: { key: 'b' }, displayName: 'b', repo: 'shop', agents: [{ paneKey: 'p2', state: 'done', conversationName: 'Idle one' }] }
  ])
  const stats = buildCockpit(
    rows,
    { sessions: [{ paneKey: 'p1', bytes: 1.5 * 1024 ** 3 }, { paneKey: 'p2', bytes: 400 * 1024 ** 2 }], host: { totalBytes: 16 * 1024 ** 3, usedBytes: 8.1 * 1024 ** 3 } },
    new Map([['p1', 'term-1'], ['p2', 'term-2']]),
    [],
    { usedGB: 20, totalGB: 21 },
    [{ key: '/w/b|p2', path: '/w/b', paneKey: 'p2', workspaceId: 'b', worktreeName: 'b', repo: 'shop', name: 'next-server', count: 3, memMB: 1400 }]
  )
  // The idle session started a 1.4 GB dev server, so in all it outweighs the busy one.
  assert.deepEqual(stats.heaviest.map((h) => [h.title, h.memMB]), [['Idle one', 400], ['Busy', 1536]])
  assert.deepEqual(stats.ram, { usedGB: 8.1, totalGB: 16 })
  assert.deepEqual(stats.finished.map((f) => f.terminal), ['term-2'])
})

test('remove refuses what it cannot verify, before running any command', async () => {
  const [row] = main.fromPs([{ identity: { key: 'gone' }, displayName: 'gone', repo: 'shop', agents: [] }])
  assert.deepEqual(await removeWorktree(async () => ({}), row), { removed: false, reason: 'main checkout' })
  assert.deepEqual(await removeWorktree(async () => ({}), undefined), { removed: false, reason: 'workspace not found' })
})

test('a row carries the PR Orca linked to its worktree: number, state, title, checks; none without one', () => {
  const linkedPR = { number: 6080, state: 'merged', title: 'feat(documents): add private PDF storage pilot', url: 'https://github.com/o/mono/pull/6080', checksStatus: 'success', checksSummary: { state: 'success' } }
  const [withPr, without, noUrl] = main.fromPs([
    { identity: { key: 'a' }, displayName: 'a', repo: 'mono', linkedPR, agents: [{ paneKey: 'p', state: 'working' }] },
    { identity: { key: 'b' }, displayName: 'b', repo: 'mono', linkedPR: null, agents: [] },
    { identity: { key: 'c' }, displayName: 'c', repo: 'mono', linkedPR: { number: 1, state: 'open' }, agents: [] }
  ])
  assert.deepEqual(withPr.pr, { number: 6080, url: 'https://github.com/o/mono/pull/6080', state: 'merged', title: 'feat(documents): add private PDF storage pilot', checks: 'success' })
  assert.equal(without.pr, null)
  assert.equal(noUrl.pr, null, 'no link to open: no PR')
})

test('Orca\'s monitoring mode is carried through', () => {
  const [row] = main.fromPs([{ identity: { key: 'v' }, displayName: 'main', repo: 'shop', agents: [{ paneKey: 'p', state: 'working', workingMode: 'monitoring' }] }])
  assert.equal(row.agents[0].workingMode, 'monitoring')
})

test('a finished turn kept monitoring only by an artifact watch is done, everywhere the panel looks', async () => {
  const { faceOf } = await import('./view.ts')
  const agent = (paneKey: string, main: string, program = 'done') => ({ paneKey, state: 'working', workingMode: 'monitoring', mainAgent: { state: main }, programStatus: { state: program } })
  const asked: string[] = []
  const quiet = (pane: string) => (asked.push(pane), pane !== 'shell')
  const [row] = main.fromPs([{ identity: { key: 'v' }, displayName: 'main', repo: 'shop', agents: [agent('watch', 'done'), agent('turn', 'working'), agent('shell', 'done'), agent('running', 'done', 'working'), { paneKey: 'plain', state: 'done' }] }], undefined, undefined, quiet)
  const [watch, turn, shell, running] = row.agents
  assert.equal(watch.state, 'done')
  assert.equal(watch.workingMode, null)
  assert.equal(faceOf(watch), 'done', 'no ring')
  assert.equal(monitoring(watch), false)
  assert.equal(faceOf(turn), 'monitoring', 'a turn still running is not second-guessed')
  assert.equal(faceOf(shell), 'monitoring', 'other background work in the transcript keeps the ring')
  assert.equal(faceOf(running), 'monitoring', 'so does Claude reporting "1 shell still running", whatever the transcript says')
  assert.deepEqual(asked, ['watch', 'shell'], 'transcripts are read only for a finished turn that Orca calls monitoring and Claude calls done')
  const [alone] = main.fromPs([{ identity: { key: 'w' }, displayName: 'side', repo: 'shop', agents: [agent('watch', 'done')] }], undefined, undefined, quiet)
  assert.equal(alone.state, 'done', 'the row agrees')
  assert.equal(canRemove(alone), true, 'nothing works in the worktree')
  const [kept] = main.fromPs([{ identity: { key: 'w' }, displayName: 'side', repo: 'shop', agents: [agent('watch', 'done')] }])
  assert.equal(faceOf(kept.agents[0]), 'monitoring', "without a transcript check, Orca's monitoring stands")
})

test('folder workspaces without an identity key are kept, with the id the plugin API lists', () => {
  const rows = main.fromPs(
    [{ worktreeId: 'r::/c/alpha', path: '/c/alpha', displayName: 'alpha', repo: 'alpha', liveTerminalCount: 3, agents: [{ paneKey: 'p', state: 'done' }] }],
    undefined,
    new Map([['/c/alpha', 'folder:abc']])
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'folder:abc')
  assert.equal(main.fromPs([{ worktreeId: 'r::/x', path: '/x', displayName: 'x', agents: [] }]).length, 0, 'no id at all: skipped')
})

test('the pending question comes from Orca\'s toolInput', () => {
  assert.equal(main.questionOf({ state: 'waiting', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Pick one?' }] }) }), 'Pick one?')
  assert.equal(main.questionOf({ state: 'working', toolName: 'AskUserQuestion', toolInput: '{}' }), null)
  assert.equal(main.questionOf({ state: 'waiting', toolName: 'Bash', toolInput: 'ls' }), null)
})

test('a new look keeps the rest of the coordinator file; delete only removes a coordinator folder', async () => {
  const { mkdtempSync, existsSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'coords-'))
  const dir = scaffoldCoordinator(root, { name: 'ops', look: null })
  writeLook(dir, { color: '#4fbfc8', shape: 'shield' })
  const [ops] = readCoordinators(root)
  assert.deepEqual([ops.name, ops.look], ['ops', { color: '#4fbfc8', shape: 'shield' }])
  assert.throws(() => deleteFolder(root, root), /refusing/)
  mkdirSync(join(root, 'stray'))
  assert.throws(() => deleteFolder(join(root, 'stray'), root), /refusing/) // no coordinator file: not ours
  deleteFolder(dir, root)
  assert.equal(existsSync(dir), false)
})

test('waking a coordinator adds --continue only to the launch the plugin marked', () => {
  const pending = new Set(['ws-1'])
  assert.equal(main.resumeCommand({ agent: 'claude', workspaceId: 'ws-2', command: 'claude' }, pending), null, 'other launches untouched')
  assert.equal(main.resumeCommand({ agent: 'claude', workspaceId: 'ws-1', command: 'claude --plugin-dir x' }, pending), 'claude --plugin-dir x --continue')
  assert.equal(main.resumeCommand({ agent: 'claude', workspaceId: 'ws-1', command: 'claude' }, pending), null, 'a mark is used once')
})

test('a folder has history when Claude kept a transcript for it', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'projects-'))
  mkdirSync(join(root, '-c-alpha'))
  writeFileSync(join(root, '-c-alpha', 'abc.jsonl'), '{}')
  assert.equal(main.hasHistory('/c/alpha', [root]), true)
  assert.equal(main.hasHistory('/c/main', [root]), false)
})

test('a coordinator is live while its workspace has an open terminal with an agent', () => {
  const rows = main.fromPs(
    [
      { worktreeId: 'a::/c/fv', path: '/c/fv', displayName: 'fv', liveTerminalCount: 1, agents: [{ paneKey: 'p', state: 'done' }] },
      { worktreeId: 'b::/c/mk', path: '/c/mk', displayName: 'mk', liveTerminalCount: 0, agents: [{ paneKey: 'q', state: 'done' }] }
    ],
    undefined,
    new Map([['/c/fv', 'ws-fv'], ['/c/mk', 'ws-mk']])
  )
  assert.equal(main.isLive('/c/fv', rows), true, 'open terminal: just open it')
  assert.equal(main.isLive('/c/mk', rows), false, 'no open terminal: wake it')
  assert.equal(main.isLive('/c/none', rows), false)
})

test('coordinator homes are never finished work', () => {
  const rows = main.fromPs(
    [
      { worktreeId: 'a::/code/shop', path: '/code/shop', displayName: 'main', repo: 'shop', liveTerminalCount: 1, agents: [{ paneKey: 'p1', state: 'working' }] },
      { worktreeId: 'b::/c/alpha', path: '/c/alpha', displayName: 'alpha', liveTerminalCount: 1, agents: [{ paneKey: 'p2', state: 'done' }] },
      { worktreeId: 'c::/c/main', path: '/c/main', displayName: 'main', liveTerminalCount: 1, agents: [{ paneKey: 'p3', state: 'done' }] }
    ],
    undefined,
    new Map([['/code/shop', 'w1'], ['/c/alpha', 'w2'], ['/c/main', 'w3']])
  )
  const c = main.capacityOf(rows, 'normal', undefined, '/nonexistent', (p) => Boolean(p?.startsWith('/c/')))
  assert.equal(c.finishedOpen, 0)
})

test('a coordinator home is any folder under the home or one with a coordinator file', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const elsewhere = mkdtempSync(join(tmpdir(), 'home-'))
  writeFileSync(join(elsewhere, COORDINATOR_FILE), '{}')
  assert.equal(isCoordinatorHome('/h/coordinators/alpha', '/h/coordinators'), true)
  assert.equal(isCoordinatorHome(elsewhere, '/h/coordinators'), true)
  assert.equal(isCoordinatorHome('/code/shop', '/h/coordinators'), false)
  assert.equal(isCoordinatorHome(null, '/h/coordinators'), false)
})

test("transcripts come from Orca's SQLite hook store, newest entry per pane, else the old JSON file", async () => {
  const { findTranscript, transcriptOf } = await import('./summarize.ts')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'))
  const t = (name: string) => (writeFileSync(join(dir, name), ''), join(dir, name))
  const [current, older, legacy] = [t('current.jsonl'), t('older.jsonl'), t('legacy.jsonl')]
  const files = { db: join(dir, 'last-status.db'), json: join(dir, 'last-status.json') }

  // A fixture shaped like Orca's agent-hooks/last-status.db (schema_version 202), written in WAL mode.
  const { DatabaseSync } = process.getBuiltinModule!('node:sqlite')
  const db = new DatabaseSync(files.db)
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE rows(key TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '202');`)
  const put = db.prepare('INSERT INTO rows VALUES (?, ?, ?)')
  const entry = (pane: string, transcriptPath: string) => JSON.stringify({ paneKey: pane, source: 'claude', hookEventName: 'Stop', providerSession: { transcriptPath } })
  put.run('entry\0tab-a:leaf-1', 42, entry('tab-a:leaf-1', current))
  put.run('entry', 7, entry('tab-a:leaf-1', older))
  put.run('commitment\0tab-a:leaf-1', 159, JSON.stringify({ paneKey: 'tab-a:leaf-1', launchTokenHash: 'x' }))
  put.run('entry\0tab-b:leaf-2', 43, entry('tab-b:leaf-2', '/missing.jsonl'))
  put.run('commitment\0tab-c:leaf-3', 160, JSON.stringify({ paneKey: 'tab-c:leaf-3' }))

  // Read while Orca still holds the database open for writing.
  assert.equal(transcriptOf('tab-a:leaf-1', files), current, 'the newest entry row by seq')
  assert.equal(transcriptOf('tab-b:leaf-2', files), null, 'a transcript that is gone')
  const commitmentOnly = findTranscript('tab-c:leaf-3', files)
  assert.equal(commitmentOnly.path, null, 'a commitment row has no transcript')
  assert.match(commitmentOnly.path === null ? commitmentOnly.why : '', /No exact pane transcript binding/)
  db.close()

  writeFileSync(files.json, JSON.stringify({ entries: { 'tab-d:leaf-4': { providerSession: { transcriptPath: legacy } } } }))
  assert.equal(transcriptOf('tab-d:leaf-4', files), legacy, 'older Orca: the JSON file')
  assert.equal(transcriptOf('tab-d:leaf-4', { db: join(dir, 'none.db'), json: files.json }), legacy, 'no database at all')
})

test("a coordinator's card does not repeat its lead's question; a lead's still asks", async () => {
  const { COORDINATOR_ASKS, digest, promptFor } = await import('./summarize.ts')
  const line = (type: string, content: unknown) => JSON.stringify({ type, timestamp: '2026-11-16T12:00:00Z', message: { content } })
  const relay = 'The plugin lead is staying open: try 0.2.4 in the sidebar and tell it if anything is off.'
  const coordinator = digest([
    line('user', 'Fix the sidebar summaries'),
    line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'orca orchestration worker-start --worktree path:/w --agent claude' } }]),
    line('user', 'status from the lead'),
    line('assistant', [{ type: 'text', text: relay }])
  ])!
  assert.equal(coordinator.role, 'coordinator')
  const prompt = promptFor(coordinator, { title: 'Orca Flow fixes' })
  assert.ok(prompt.startsWith(COORDINATOR_ASKS), 'the coordinator rule comes first')
  assert.match(COORDINATOR_ASKS, /relays[\s\S]*NOT its ask: set needs\.type "none"/)
  assert.match(prompt, /AGENT'S FINAL MESSAGE THIS TURN:\nThe plugin lead is staying open/)
  const lead = digest([line('user', 'Your role: lead. Fix the summaries'), line('assistant', [{ type: 'text', text: 'Does 0.2.4 look right?' }])])!
  assert.equal(lead.role, 'lead')
  assert.ok(!promptFor(lead, null).includes(COORDINATOR_ASKS), 'a lead keeps its own asks')
})

test('a worker that sent worker_done asks the user nothing: its report is for its lead', async () => {
  const { SUMMARIZER_VERSION, WORKER_ASKS, WORKER_REPORTED, digest, promptFor, withFacts } = await import('./summarize.ts')
  // firstview's "PR 1778 code-smells sweep" sent worker_done, then ended "Decision for you: ...";
  // its card said "ASKS · DECISION — Send analytics events even without consent?".
  const line = (type: string, content: unknown) => JSON.stringify({ type, timestamp: '2026-11-16T20:55:23Z', message: { content } })
  const brief = 'You are a dispatched worker. Your task ID is task_1, Dispatch ID ctx_e2.\n=== TASK ===\nPR 1778 code-smells sweep'
  const done = "orca orchestration send --from term_b9 --type worker_done --subject 'Non-blocking analytics' --task-id task_1 --dispatch-id ctx_e2 --outcome succeeded --files-modified '" + 'apps/api/src/lib/posthog.ts,'.repeat(10) + "'"
  const report = 'Four commits, not pushed.\n\nDecision for you: like `user_approved`, the server sends `signup_completed` even for visitors who declined analytics in the browser.\n\nLeft for you: the PR body and the tracking-plan entry.'
  const turn = [
    line('user', brief),
    line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: done } }]),
    line('user', [{ type: 'tool_result', content: 'Next: Recorded. End your turn.' }]),
    line('assistant', [{ type: 'text', text: report }])
  ]
  const d = digest(turn)!
  assert.equal(d.role, 'worker')
  assert.equal(d.reported, true, 'the worker_done send in the latest turn is the fact')
  const prompt = promptFor(d, null)
  assert.ok(prompt.startsWith(`${WORKER_ASKS}\n\n${WORKER_REPORTED}`), 'the worker rule and the finished fact come first')
  assert.match(WORKER_ASKS, /"Decision for you: …"[\s\S]*addressed to its lead[\s\S]*needs\.type "none" and glance ""/)
  assert.match(WORKER_REPORTED, /sent worker_done[\s\S]*needs\.type is "none" and glance is ""/)
  assert.match(prompt, /AGENT'S FINAL MESSAGE THIS TURN:\nFour commits[\s\S]*Decision for you/)
  const haiku = { title: 'PR 1778 code-smells sweep', glance: 'Send analytics events even without consent?', needs: { type: 'decision', ask: 'Send them?', options: ['Send both'] } }
  assert.deepEqual(withFacts(d, haiku), { ...haiku, glance: '', needs: { type: 'none', ask: '', options: [] } }, 'the fact wins over the model')
  assert.ok(SUMMARIZER_VERSION >= 6, 'worker cards written under the old rules refresh')

  // Still working its task: the worker rule applies, but nothing says it is finished.
  const working = digest([line('user', brief), line('assistant', [{ type: 'text', text: 'Which schema should I use, v1 or v2?' }])])!
  assert.equal(working.reported, false)
  assert.ok(promptFor(working, null).startsWith(WORKER_ASKS) && !promptFor(working, null).includes(WORKER_REPORTED))
  assert.equal(withFacts(working, haiku), haiku, 'the model decides while the worker is not finished')
  // Mentioning worker_done (a grep, a heredoc) is not sending it; chained it still counts.
  const mention = digest([line('user', brief), line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -n "--type worker_done" SKILL.md' } }])])!
  assert.equal(mention.reported, false)
  const chained = digest([line('user', brief), line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'cd /w && orca orchestration send --type=worker_done --subject x' } }])])!
  assert.equal(chained.reported, true)
  // Only a worker: a lead reports worker_done too, and keeps its own asks.
  const lead = digest([line('user', 'Your role: lead. Ship it'), line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: done } }])])!
  assert.equal(lead.reported, false)
  assert.ok(!promptFor(lead, null).includes(WORKER_ASKS))
})

test("a lead's PR review relayed by its coordinator stays on the lead's card", async () => {
  const { COORDINATOR_ASKS, SUMMARIZER_VERSION } = await import('./summarize.ts')
  // The coordinator relayed a lead's "is PR #3 good to merge?" as its own review ask.
  assert.match(COORDINATOR_ASKS, /Every decision about a workstream a lead owns \(reviewing or merging its PR[\s\S]*is the lead's ask, on the lead's card/)
  assert.match(COORDINATOR_ASKS, /a lead's status note, a "stopped without reporting" notice or the queue[\s\S]*NOT its ask/)
  assert.match(COORDINATOR_ASKS, /a conflict between two workstreams/, 'conflicts between workstreams stay the coordinator\'s own ask')
  assert.ok(SUMMARIZER_VERSION >= 4, 'coordinator cards written under the old rule refresh')
})

test('a heads-up about a later go-ahead is not an ask, for every role', async () => {
  const { SYSTEM_PROMPT } = await import('./summarize.ts')
  // The isola coordinator's "Releasing and telling the mono lead both wait for your go-ahead",
  // said while its lead was still building, was filed as a yes/no.
  assert.match(SYSTEM_PROMPT, /question the user can answer RIGHT NOW/)
  assert.match(SYSTEM_PROMPT, /"releasing waits for your go-ahead"[\s\S]*?needs\.type "none"[\s\S]*?"watching"/)
})

test('an ask the user already took on ("ok reviewing") is not an ask while the agent only waits', async () => {
  const { SYSTEM_PROMPT, SUMMARIZER_VERSION } = await import('./summarize.ts')
  // The mono lead asked for a review of #6227; the user said "ok reviewing" and the lead answered
  // "I'll wait for your comments", yet Up next still showed "ASKS · REVIEW".
  assert.match(SYSTEM_PROMPT, /"ok reviewing", "on it", "will look", "checking now", "give me a minute"/)
  assert.match(SYSTEM_PROMPT, /only acknowledges and waits, the ask is acknowledged: needs\.type "none" and glance ""/)
  assert.match(SYSTEM_PROMPT, /"watching" \("your review of the PR"\)/)
  assert.match(SYSTEM_PROMPT, /an ask again only when the agent asks something new/)
  assert.ok(SUMMARIZER_VERSION >= 2, 'the version went up, so cards written under the old rules refresh')
})

test('a to-do for the user is an "action" kept as an imperative, never rephrased as a question', async () => {
  const { SYSTEM_PROMPT, SUMMARY_SCHEMA, COORDINATOR_ASKS, SUMMARIZER_VERSION } = await import('./summarize.ts')
  // "Your part: rename the project to katos in Orca's project settings. Tell me when it's done."
  // was filed as "info" and shown as "Rename cacasports to katos in Orca?".
  assert.ok(SUMMARY_SCHEMA.properties.needs.properties.type.enum.includes('action'))
  assert.match(SUMMARY_SCHEMA.properties.glance.description, /imperative \(never a question\)/)
  assert.match(SYSTEM_PROMPT, /"action" = something only the user can do outside the chat/)
  assert.match(SYSTEM_PROMPT, /An "action" is not a question: never rephrase it as one/)
  assert.match(SYSTEM_PROMPT, /Its options are \["Done"\] or empty/)
  assert.match(SYSTEM_PROMPT, /rules below apply to actions too/)
  assert.match(COORDINATOR_ASKS, /an "action" the user must do for the coordinator itself/)
  assert.ok(SUMMARIZER_VERSION >= 3, 'cards written before actions existed refresh')
})

test("an earlier turn's action is context only; asks come from the latest turn's final message", async () => {
  const { SYSTEM_PROMPT, SUMMARIZER_VERSION, digest, promptFor } = await import('./summarize.ts')
  // The iori coordinator's card showed "ASKS · ACTION — Rename cacasports to katos in Orca." after
  // the user said "ok" and it answered with something else: the rename was the turn before's.
  const line = (type: string, content: unknown) => JSON.stringify({ type, timestamp: '2026-11-16T12:00:00Z', message: { content } })
  const rename = 'Still on your side: rename the project to katos in Orca settings, then tell me'
  const opened = 'I opened the Katos store setup chat, where the release lead is waiting for your approval on the Taiwan tax info.'
  const d = digest([
    line('user', 'Set up the Katos store'),
    line('assistant', [{ type: 'text', text: 'Store created.' }]),
    line('user', 'what is left?'),
    line('assistant', [{ type: 'text', text: rename }]),
    line('user', 'ok'),
    line('assistant', [{ type: 'text', text: opened }])
  ])!
  assert.match(d.context, /AGENT: Still on your side: rename the project/)
  assert.equal(d.turn, 'USER: ok')
  assert.equal(d.lastAssistant, opened)
  const prompt = promptFor(d, null)
  const earlier = prompt.indexOf('EARLIER TURN (context only; its asks are not current):\n')
  const latest = prompt.indexOf('LATEST TURN:\n')
  const final = prompt.indexOf("AGENT'S FINAL MESSAGE THIS TURN:\n")
  assert.ok(earlier >= 0 && earlier < latest && latest < final, 'earlier turn, then the latest, then its final message')
  assert.ok(prompt.slice(earlier, latest).includes(rename), 'the rename sits in the earlier turn')
  assert.ok(!prompt.slice(latest).includes('rename'), 'and nowhere in the latest turn or its final message')
  assert.match(SYSTEM_PROMPT, /"needs" and "glance" come ONLY from the agent's final message of the latest turn/)
  assert.match(SYSTEM_PROMPT, /from the earlier turn, or from earlier in the latest turn, that the final message does not repeat is not current: needs\.type "none" and glance ""/)
  assert.ok(SUMMARIZER_VERSION >= 5, 'cards that carried an old ask forward refresh')
})

test('an only turn has no earlier-turn section, and its final message is its own', async () => {
  const { digest, promptFor } = await import('./summarize.ts')
  const line = (type: string, content: unknown) => JSON.stringify({ type, timestamp: '2026-11-16T12:00:00Z', message: { content } })
  const d = digest([line('user', 'Fix it'), line('assistant', [{ type: 'text', text: 'Merge PR #3?' }])])!
  assert.equal(d.context, '')
  assert.ok(!promptFor(d, null).includes('EARLIER TURN'))
  const toolsOnly = digest([line('user', 'Fix it'), line('assistant', [{ type: 'text', text: 'Merge PR #3?' }]), line('user', 'yes'), line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr merge 3' } }])])!
  assert.equal(toolsOnly.lastAssistant, '', "the earlier turn's message is not this turn's final message")
})

test('an optional invitation ("tell me how") is not an ask', async () => {
  const { SYSTEM_PROMPT, SUMMARIZER_VERSION } = await import('./summarize.ts')
  // "OK, I won't start it. If you'd rather handle this another way, tell me how." became
  // "ASKS · INFO — How to handle skill reloads after updates?".
  assert.match(SYSTEM_PROMPT, /An optional invitation or offer is not an ask/)
  assert.match(SYSTEM_PROMPT, /"let me know if…", "tell me how", "if you'd rather…, tell me", "say the word if…", "happy to … if you want" means needs\.type "none" and glance ""/)
  assert.match(SYSTEM_PROMPT, /Only a question or to-do the agent actually waits on counts/)
  assert.ok(SUMMARIZER_VERSION >= 5, 'cards that read an invitation as an ask refresh')
})

/**
 * Waits until `cond` holds, checking every millisecond, and fails after `ms`. Use it, not a fixed
 * sleep, to wait on the summarizer's timers: under load a fixed sleep ends before a retry chain does.
 */
async function until(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out after ${ms} ms waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 1))
  }
}

test("a transcript Claude creates a moment after the turn's status is found on a retry, without a warning", async () => {
  const { turnSummarizer } = await import('./summarize.ts')
  const runs: string[] = []
  const logs: string[] = []
  let lookups = 0
  const s = turnSummarizer({
    delayMs: 5,
    retryMs: [5, 5],
    log: (m) => logs.push(m),
    findTranscript: () => (++lookups < 3 ? { path: null, why: 'names /t/new.jsonl, which does not exist' } : { path: '/t/new.jsonl' }),
    run: async (job) => void runs.push(job.transcript)
  })
  s.onStatus({ paneKey: 'p-new', workspaceId: null, state: 'done' })
  // The run starts in the same timer callback as the lookup that found it, so once it is in, no
  // lookup or warning is still to come.
  await until(() => runs.length > 0, 'the run after the third lookup')
  assert.equal(lookups, 3)
  assert.deepEqual(runs, ['/t/new.jsonl'])
  assert.deepEqual(logs, [])
  s.dispose()
})

test('turns are summarized once per burst, one run per pane, newest job after a running one', async () => {
  const { turnSummarizer } = await import('./summarize.ts')
  const runs: string[] = []
  const logs: string[] = []
  const lookups: string[] = []
  let release = () => {}
  const s = turnSummarizer({
    delayMs: 5,
    retryMs: [5],
    log: (m) => logs.push(m),
    findTranscript: (pane) => {
      lookups.push(pane)
      return pane.startsWith('none') ? { path: null, why: 'no entry' } : { path: `/t/${pane}` }
    },
    run: (job) => {
      runs.push(`${job.pane}@${job.worktreeId}`)
      return new Promise<void>((r) => (release = r))
    }
  })
  // A lookup and what follows from it (the run, or the warning) happen in one timer callback, so
  // counting lookups tells when a timer has fired and done all it will.
  const looked = (pane: string) => lookups.filter((p) => p === pane).length
  s.onStatus({ paneKey: 'p1', workspaceId: 'w1', state: 'working' })
  s.onStatus({ paneKey: 'none', workspaceId: null, state: 'done' })
  s.onStatus({ paneKey: 'p1', workspaceId: 'w1', state: 'waiting' })
  s.onStatus({ paneKey: 'p1', workspaceId: 'w1', state: 'done' })
  await until(() => looked('p1') === 1 && looked('none') === 2, "p1's lookup and none's lookup and retry")
  assert.deepEqual(runs, ['p1@w1'])
  s.onStatus({ paneKey: 'p1', workspaceId: 'w2', state: 'done' })
  await until(() => looked('p1') === 2, "p1's second lookup")
  assert.deepEqual(runs, ['p1@w1'], 'no second run while the first is running')
  release()
  await until(() => runs.length === 2, 'the queued run after the first ends')
  assert.deepEqual(runs, ['p1@w1', 'p1@w2'])
  assert.equal(looked('p1'), 2, 'the waiting and done of one burst are looked up once')
  s.onStatus({ paneKey: 'none-2', workspaceId: null, state: 'done' })
  await until(() => looked('none-2') === 2, "none-2's lookup and retry")
  assert.equal(logs.length, 1, 'a missing transcript is logged once, not every turn')
  assert.match(logs[0], /SUMMARIES OFF: no supported transcript found for pane none\b.*no entry/)
  release()
  s.dispose()
})

test('a card is stale when an older summarizer wrote it, and only for a pane Orca lists now', async () => {
  const { SUMMARIZER_VERSION, staleCards } = await import('./summarize.ts')
  const cards = {
    'tab_old': { pane: 'tab:old', transcript: '/t/old.jsonl', worktreeId: 'w1' },
    'tab_same': { pane: 'tab:same', transcript: '/t/same.jsonl', summarizer: SUMMARIZER_VERSION },
    'tab_lower': { pane: 'tab:lower', summarizer: SUMMARIZER_VERSION - 1 },
    'tab_closed': { pane: 'tab:closed', transcript: '/t/closed.jsonl' }
  }
  assert.deepEqual(staleCards(cards, ['tab:old', 'tab:same', 'tab:lower', 'tab:new', 'tab:old', '']), [
    { pane: 'tab:old', transcript: '/t/old.jsonl', worktreeId: 'w1' },
    { pane: 'tab:lower', transcript: undefined, worktreeId: undefined }
  ], 'no field = stale, equal = fresh, a live pane with no card and a closed pane are left alone')
  assert.deepEqual(staleCards(cards, ['tab:same'], SUMMARIZER_VERSION + 1).map((c) => c.pane), ['tab:same'], 'a bump makes current cards stale')
})

test('live panes are the rows\' agents and the coordinators\' sessions', () => {
  const agent = (paneKey: string) => ({ paneKey }) as any
  const panes = main.livePanes({
    rows: [{ agents: [agent('a'), agent('b')] }, { agents: [agent('a'), agent('')] }] as any,
    coordinators: [{ session: agent('c') }, { session: null }] as any
  })
  assert.deepEqual(panes, ['a', 'b', 'c'])
})

test('stale cards are re-summarized forced, through the shared queue, two at a time with a gap, failures logged and skipped', async () => {
  const { refreshStale, turnSummarizer } = await import('./summarize.ts')
  const logs: string[] = []
  const started: string[] = []
  let inFlight = 0
  let most = 0
  const s = turnSummarizer({
    log: (m) => logs.push(m),
    run: async (job) => {
      started.push(`${job.pane}${job.force ? '!' : ''}`)
      most = Math.max(most, ++inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      if (job.pane === 'p3') throw new Error('Haiku timed out')
    }
  })
  const gaps: number[] = []
  const jobs = ['p1', 'p2', 'p3', 'p4', 'p5'].map((pane) => ({ pane, transcript: `/t/${pane}` }))
  // A turn finishing meanwhile shares the same two slots.
  const turn = s.enqueue({ pane: 'p9', transcript: '/t/p9' })
  await refreshStale({ jobs, enqueue: s.enqueue, gapMs: 1000, wait: async (ms) => void gaps.push(ms) })
  await turn
  assert.deepEqual([...started].sort(), ['p1!', 'p2!', 'p3!', 'p4!', 'p5!', 'p9'])
  assert.equal(most, 2, 'never more than two Haiku calls at once')
  assert.ok(gaps.length >= 3 && gaps.every((g) => g === 1000), 'a pause between refreshes')
  assert.deepEqual(logs, ['summary for p3 failed: writer failed unexpectedly; check the writer integration (existing card preserved)'])
  s.dispose()
})

test('a refresh stops when the worker is deactivated', async () => {
  const { refreshStale } = await import('./summarize.ts')
  const ran: string[] = []
  let stopped = false
  await refreshStale({
    jobs: ['p1', 'p2', 'p3'].map((pane) => ({ pane, transcript: `/t/${pane}` })),
    parallel: 1,
    enqueue: async (job) => { ran.push(job.pane); stopped = true },
    wait: async () => {},
    stopped: () => stopped
  })
  assert.deepEqual(ran, ['p1'])
})

test('a turn that ends while Orca stays working/monitoring is summarized; a running turn is not', async () => {
  const { endsTurn, turnSummarizer } = await import('./summarize.ts')
  assert.equal(endsTurn({ state: 'working', mainAgent: { state: 'done' } }), true, 'an artifact watch, a job or a cron keeps Orca working')
  assert.equal(endsTurn({ state: 'working', mainAgent: { state: 'waiting' } }), true)
  assert.equal(endsTurn({ state: 'working', mainAgent: { state: 'working' } }), false, 'mid-turn')
  assert.equal(endsTurn({ state: 'working' }), false, 'mid-turn, no mainAgent')
  assert.equal(endsTurn({ state: 'blocked', mainAgent: { state: 'done' } }), false)
  assert.equal(endsTurn({ state: 'done' }), true)

  const runs: string[] = []
  const lookups: string[] = []
  const s = turnSummarizer({
    delayMs: 5,
    findTranscript: (pane) => (lookups.push(pane), { path: `/t/${pane}` }),
    run: async (job) => void runs.push(job.pane)
  })
  const monitoring = (paneKey: string, main: string, at: number) => ({ paneKey, workspaceId: 'w', state: 'working', mainAgent: { state: main, stateStartedAt: at } })
  s.onStatus(monitoring('running', 'working', 1))
  s.onStatus({ paneKey: 'old-orca', workspaceId: 'w', state: 'working' })
  s.onStatus(monitoring('watch', 'done', 1))
  // Timers fire in the order they were set, so once the watch pane has run, the others had their turn.
  await until(() => runs.length === 1, 'the finished turn')
  assert.deepEqual(runs, ['watch'])
  assert.deepEqual(lookups, ['watch'], 'a running turn is not even looked up')

  s.onStatus(monitoring('watch', 'done', 1))
  s.onStatus(monitoring('watch', 'working', 2))
  s.onStatus(monitoring('watch', 'done', 3))
  await until(() => runs.length === 2, 'the next turn end')
  s.onStatus(monitoring('watch', 'done', 3))
  s.onStatus(monitoring('marker', 'done', 1))
  await until(() => runs.includes('marker'), 'a later pane')
  assert.deepEqual(runs, ['watch', 'watch', 'marker'], 'each turn end once, however often Orca repeats it')
  s.dispose()
})

test('a turn that ended after its card was written is caught up, for idle panes, from the transcript tail', async () => {
  const { lastTurnEnd, missedTurns, refreshStale } = await import('./summarize.ts')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'missed-'))
  const ended = (iso: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 2000, timestamp: iso })
  const said = (iso: string) => JSON.stringify({ type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: 'Keep 8 h?' }] } })
  const t = join(dir, 's.jsonl')
  writeFileSync(t, [said('2026-11-18T09:58:22Z'), ended('2026-11-18T09:58:23Z'), 'x'.repeat(5000), said('2026-11-19T09:22:10Z'), ended('2026-11-19T09:22:15Z'), said('2026-11-19T09:25:00Z')].join('\n') + '\n')
  assert.equal(lastTurnEnd(t), Date.parse('2026-11-19T09:22:15Z'), 'the last turn end, not the line after it')
  assert.equal(lastTurnEnd(t, 200), null, 'only the tail is read')
  assert.equal(lastTurnEnd(join(dir, 'none.jsonl')), null)

  const card = (updatedAt: number, transcript = t) => ({ pane: 'p', transcript, worktreeId: 'w', updatedAt })
  const cards = {
    'tab_stale': card(Date.parse('2026-11-18T09:58:29Z')),
    'tab_fresh': card(Date.parse('2026-11-19T09:22:25Z')),
    'tab_busy': card(Date.parse('2026-11-18T09:58:29Z')),
    'tab_none': card(Date.parse('2026-11-18T09:58:29Z'), join(dir, 'none.jsonl'))
  }
  assert.deepEqual(missedTurns(cards, ['tab:stale', 'tab:fresh', 'tab:none', 'tab:nocard', 'tab:stale']), [{ pane: 'tab:stale', transcript: t, worktreeId: 'w' }])
  assert.deepEqual(missedTurns(cards, []), [], 'a busy pane is not passed in, so it is never summarized mid-turn')
  rmSync(dir, { recursive: true, force: true })

  const forced: boolean[] = []
  await refreshStale({ jobs: [{ pane: 'a', transcript: '/a' }, { pane: 'b', transcript: '/b', force: false }], parallel: 1, enqueue: async (job) => void forced.push(!!job.force), wait: async () => {} })
  assert.deepEqual(forced, [true, false], 'a caught-up turn is not forced: an unchanged turn is skipped')
})

test('idle live panes leave out agents whose turn is running', () => {
  const agent = (paneKey: string, state: string) => ({ paneKey, state }) as any
  const snap = {
    rows: [{ agents: [agent('a', 'done'), agent('b', 'working'), agent('c', 'waiting')] }] as any,
    coordinators: [{ session: agent('d', 'done') }, { session: agent('e', 'working') }, { session: null }] as any
  }
  assert.deepEqual(main.livePanes(snap, true), ['a', 'c', 'd'])
  assert.deepEqual(main.livePanes(snap), ['a', 'b', 'c', 'd', 'e'])
})

test('setup links the CLI, skill and coordinator CLAUDE.md, repoints old links, keeps real files', async () => {
  const { ensureLinks } = await import('./install.ts')
  const { mkdtempSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const t = mkdtempSync(join(tmpdir(), 'links-'))
  mkdirSync(join(t, 'bin'))
  symlinkSync('/old/install/bin/tool.mjs', join(t, 'bin', 'tool'))
  writeFileSync(join(t, 'CLAUDE.md'), 'mine')
  const links = [
    { from: join(t, 'bin', 'tool'), to: '/new/bin/tool.mjs' },
    { from: join(t, 'skills', 'orca-flow'), to: '/new/skills/orca-flow' },
    { from: join(t, 'CLAUDE.md'), to: '/new/templates/CLAUDE.md' }
  ]
  const log = ensureLinks(links)
  assert.equal(readlinkSync(join(t, 'bin', 'tool')), '/new/bin/tool.mjs')
  assert.equal(readlinkSync(join(t, 'skills', 'orca-flow')), '/new/skills/orca-flow')
  assert.equal(readFileSync(join(t, 'CLAUDE.md'), 'utf8'), 'mine')
  assert.equal(log.length, 3)
  assert.deepEqual(ensureLinks(links), [`kept ${join(t, 'CLAUDE.md')}: not a link`])
})

test('a coordinator keeps its workers while it sleeps: its closed terminal ran in its folder', async () => {
  const { dirOfTerminalRecord, loadLineage } = await import('./coordinators.ts')
  const coordinators = [{ key: 'alpha', name: 'alpha', repos: [], about: '', dir: '/c/alpha', workspaceId: null }]
  const rows = main.fromPs([
    { identity: { key: 'home' }, displayName: 'alpha', repo: 'alpha', path: '/c/alpha', agents: [] },
    { identity: { key: 'w' }, displayName: 'checkout', repo: 'shop', agents: [{ paneKey: 'p:worker', state: 'working' }] }
  ])
  // Orca's CLI: one run coordinated from the old, closed terminal; a second run with no live workers.
  const calls: string[] = []
  const run = async (args: string[]) => {
    calls.push(args.slice(0, 2).join(' '))
    if (args[0] === 'terminal' && args[1] === 'list') return { terminals: [{ handle: 'term-worker', tabId: 'p', leafId: 'worker' }] }
    if (args[1] === 'run-list') return { runs: [{ id: 'run-a', coordinator_handle: 'term-old' }, { id: 'run-b', coordinator_handle: 'term-x' }, { id: 'run_unbound', coordinator_handle: null }] }
    if (args[1] === 'worker-list') return { workers: args[3] === 'run-a' ? [{ terminal: 'term-worker', terminalState: 'retained', taskId: 't1' }] : [{ terminal: 'term-gone', terminalState: 'released' }] }
    if (args[0] === 'terminal' && args[1] === 'show') return { terminal: { worktreeId: 'repo1::/c/alpha', worktreePath: '' } }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  const lineage = await loadLineage(run, 1_000_000)
  assert.equal(calls.filter((c) => c === 'terminal show').length, 1)
  const worker = assignCoordinators(rows, coordinators, lineage)[1].agents[0]
  assert.equal(worker.coordinator, 'alpha')
  assert.equal(dirOfTerminalRecord({ worktreePath: '/a', worktreeId: 'r::/b' }), '/a')
  assert.equal(dirOfTerminalRecord(null), null)
})

test('processes an agent started outside its session are found by the tags they inherit', async () => {
  const { parsePs, parseTop, startedGroups } = await import('./started.ts')
  const tag = (pane: string) => `ORCA_WORKTREE_ID=repo1::/w/checkout ORCA_PANE_KEY=${pane} HOME=/h`
  const ps = [
    `  100     1 /usr/bin/login -flpq me ${tag('p1')}`,
    `  101   100 -/bin/zsh -l ${tag('p1')}`,
    `  102   101 claude --continue ${tag('p1')}`,
    `  200     1 node /h/.nvm/bin/pnpm dev ${tag('p1')}`,
    `  201   200 node /w/checkout/node_modules/.bin/next dev --turbopack ${tag('p1')}`,
    '  202   201 next-server (v16.4.5)',
    `  300     1 node /w/other/server.js ORCA_WORKTREE_ID=repo1::/w/unknown ORCA_PANE_KEY=p9`,
    `  400     1 python3 - echo ORCA_WORKTREE_ID=(x) looks like a tag`,
    '  500     1 /usr/sbin/cfprefsd agent'
  ].join('\n')
  const procs = parsePs(ps)
  assert.deepEqual(procs.find((p) => p.pid === 201), { pid: 201, ppid: 200, name: 'next', worktree: '/w/checkout', pane: 'p1' })
  const top = parseTop('PID    MEM\n202    972M+\n201    42M\n200    40M-\n102    300M\n')
  assert.equal(top.get(202), 972 * 1024 ** 2)
  const rows = main.fromPs([{ identity: { key: 'w' }, displayName: 'checkout', repo: 'shop', path: '/w/checkout', agents: [{ paneKey: 'p1', state: 'working' }] }])
  // Orca counts the session (login -> zsh -> claude); the detached pnpm tree is what it misses.
  const groups = startedGroups(procs, top, [100], rows)
  assert.deepEqual(groups.map((g) => [g.key, g.name, g.count, g.memMB]), [['/w/checkout|p1', 'next-server', 3, 1054]])
})

test('capacity is one memory budget: free memory after the margin against what a start costs', async () => {
  const { costsOf, decide, DEFAULT_CONFIG, diskFreeOf, envCost } = await import('./capacity.ts')
  assert.equal(diskFreeOf('Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s5   482797652 409147004  32401648    93%    /System/Volumes/Data\n'), 30.9)
  assert.equal(diskFreeOf(''), null)
  // Agent sessions: shells with no agent (a few MB) do not count; a project's environment is what its worktrees started.
  const costs = costsOf([0.012, 0.32, 0.39, 0.53, 1.9], [{ repo: 'shop', gb: 2.6 }, { repo: 'shop', gb: 1.8 }, { repo: 'shop', gb: 0 }])
  assert.deepEqual(costs, { agentGB: 0.5, envGB: { 'shop': 2.2 } }, 'a shop checkout with its dev server stopped does not pull the price down')
  assert.equal(envCost(costs.envGB, 'docs'), 1.5, 'a project never seen at work here is priced at the fallback')
  const at = (availableGB: number | null, pressure: 'normal' | 'warn' | 'critical' = 'normal') =>
    decide({ availableGB, pressure, config: DEFAULT_CONFIG, agentGB: 0.5, envGB: 2.2 })
  assert.deepEqual(at(6), { verdict: 'ok', freeGB: 4 })
  assert.deepEqual(at(4), { verdict: 'agents-only', freeGB: 2 })
  assert.deepEqual(at(2.3), { verdict: 'full', freeGB: 0.3 })
  assert.equal(at(9, 'critical').verdict, 'pressure')
  assert.deepEqual(at(null), { verdict: 'ok', freeGB: null }, 'before Orca reports memory, nothing is blocked on a guess')
})

test('under warn pressure a new worktree starts when it fits with headroom (2 GB or half its environment); critical still blocks', async () => {
  const { decide, DEFAULT_CONFIG } = await import('./capacity.ts')
  assert.equal(DEFAULT_CONFIG.warnHeadroomGB, 2)
  const at = (availableGB: number | null, envGB: number, pressure: 'normal' | 'warn' | 'critical' = 'warn') =>
    decide({ availableGB, pressure, config: DEFAULT_CONFIG, agentGB: 0.5, envGB }).verdict
  // The case that started this: 8.9 GB free after the margin, warn.
  assert.equal(at(10.9, 0), 'ok', 'orca-flow runs no environment: 0.5 + 0 + 2 fits in 8.9')
  assert.equal(at(10.9, 6.6), 'agents-only', 'mono: 0.5 + 6.6 + 3.3 = 10.4 does not fit in 8.9')
  assert.equal(at(2 + 10.4, 6.6), 'ok', 'mono fits once 10.4 GB is free')
  assert.equal(at(2 + 10.3, 6.6), 'agents-only')
  assert.equal(at(10.9, 6.6, 'normal'), 'ok', 'with no pressure mono fits without the headroom')
  // The edge for a small environment: the 2 GB floor applies (half of 1.5 is less).
  assert.equal(at(2 + 0.5 + 1.5 + 2, 1.5), 'ok')
  assert.equal(at(2 + 0.5 + 1.5 + 1.9, 1.5), 'agents-only')
  assert.equal(at(2.4, 0), 'full', 'not even an agent fits')
  assert.equal(at(null, 0), 'agents-only', 'warn with no memory reading: no new worktrees on a guess')
  assert.equal(at(40, 0, 'critical'), 'pressure', 'critical blocks everything, however much is free')
  // A config.json written before the headroom setting existed still gets it.
  assert.equal(decide({ availableGB: 4.4, pressure: 'warn', config: { marginGB: 2 } as never, agentGB: 0.5, envGB: 0 }).verdict, 'agents-only')
})

test('a project seen at work that started nothing costs 0; a stopped project keeps its measured cost', async () => {
  const { costsOf, envSamples, envCost, readEnvMemory, typicalEnv, writeEnvMemory } = await import('./capacity.ts')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  // A shop checkout runs next (two panes), a second shop checkout and the orca-flow checkout have agents but started nothing.
  const samples = envSamples(
    [{ path: '/w/shop-a', repo: 'shop', gb: 4 }, { path: '/w/shop-a', repo: 'shop', gb: 2.6 }],
    [{ path: '/w/shop-a', repo: 'shop' }, { path: '/w/shop-b', repo: 'shop' }, { path: '/w/flow', repo: 'orca-flow' }]
  )
  assert.deepEqual(samples, [{ repo: 'shop', gb: 6.6 }, { repo: 'shop', gb: 0 }, { repo: 'orca-flow', gb: 0 }])
  const now = costsOf([], samples).envGB
  assert.deepEqual(now, { shop: 6.6, 'orca-flow': 0 })
  assert.equal(envCost(now, 'orca-flow'), 0, 'measured, not the 1.5 GB fallback')
  assert.equal(typicalEnv(now), 6.6, 'the typical environment counts only projects that run one')
  assert.equal(typicalEnv({ 'orca-flow': 0 }), 1.5)
  // Later every shop dev server is stopped: shop keeps 6.6 instead of dropping to 0.
  const later = costsOf([], [{ repo: 'shop', gb: 0 }, { repo: 'orca-flow', gb: 0 }], now).envGB
  assert.deepEqual(later, { shop: 6.6, 'orca-flow': 0 })
  // A new measurement replaces the remembered one; a project not seen now keeps its memory.
  assert.deepEqual(costsOf([], [{ repo: 'shop', gb: 5 }], later).envGB, { shop: 5, 'orca-flow': 0 })
  // The memory survives restarts, shared by the plugin and the CLI.
  const dir = mkdtempSync(join(tmpdir(), 'env-'))
  assert.deepEqual(readEnvMemory(dir), {})
  writeEnvMemory(dir, later)
  assert.deepEqual(readEnvMemory(dir), later)
})

test('a worker keeps the title of what it is doing, not the last task it was handed', () => {
  // Orca: conversation "Guest checkout with saved cards", last dispatched task "Settings page (3 UI fixes)".
  const ps = (summary: boolean) => main.fromPs([{ identity: { key: 'w' }, displayName: 'checkout', repo: 'shop', agents: [
    { paneKey: 'p1', state: 'working', conversationName: 'Guest checkout with saved cards', taskTitle: 'Settings page (3 UI fixes)' }
  ] }], summary ? { cards: {}, summaries: { p1: { title: 'Guest checkout' } as never } } : { cards: {}, summaries: {} })
  const lineage = { dispatcherOf: new Map([['p1', 'term-c']]), paneOf: new Map() }
  assert.equal(assignCoordinators(ps(true), [], lineage)[0].agents[0].title, 'Guest checkout')
  assert.equal(assignCoordinators(ps(false), [], lineage)[0].agents[0].title, 'Guest checkout with saved cards')
})

test('the coordinator CLAUDE.md is copied once, replaces an old link, then stays the user\'s', async () => {
  const { ensureSeeds } = await import('./install.ts')
  const { mkdtempSync, readFileSync, symlinkSync, writeFileSync, lstatSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const t = mkdtempSync(join(tmpdir(), 'seed-'))
  writeFileSync(join(t, 'template.md'), 'template')
  const seed = [{ from: join(t, 'home', 'CLAUDE.md'), to: join(t, 'template.md') }]
  assert.deepEqual(ensureSeeds(seed), [`wrote ${join(t, 'home', 'CLAUDE.md')}`])
  writeFileSync(join(t, 'home', 'CLAUDE.md'), 'template\n- my notes')
  assert.deepEqual(ensureSeeds(seed), [], 'a file the user has is never overwritten')
  assert.equal(readFileSync(join(t, 'home', 'CLAUDE.md'), 'utf8'), 'template\n- my notes')
  const old = [{ from: join(t, 'linked.md'), to: join(t, 'template.md') }]
  symlinkSync(join(t, 'template.md'), join(t, 'linked.md'))
  ensureSeeds(old)
  assert.equal(lstatSync(join(t, 'linked.md')).isSymbolicLink(), false, 'an old link becomes a real copy')
})

test('a worker named after its task id shows its task title instead', () => {
  const [row] = main.fromPs([{ identity: { key: 'w' }, displayName: 'onboarding', repo: 'shop', agents: [
    { paneKey: 'p', state: 'working', conversationName: 'worker-task_77145d6691b3', taskTitle: 'Review PR #1770' }
  ] }])
  assert.equal(row.agents[0].title, 'Review PR #1770')
})

test('focus moves at once from the workspace.changed event, by terminal or by name and branch', () => {
  const rows = main.fromPs([
    { identity: { key: 'a' }, displayName: 'checkout', repo: 'shop', branch: 'refs/heads/checkout', isActive: true, agents: [{ paneKey: 'pa', state: 'working' }] },
    { identity: { key: 'b' }, displayName: 'search', repo: 'shop', branch: 'refs/heads/search', agents: [{ paneKey: 'pb', state: 'working' }] }
  ]).map((r) => ({ ...r, agents: r.agents.map((a) => ({ ...a, terminal: a.paneKey === 'pb' ? 'term-b' : null })) }))
  const snap = { rows, source: 'cli' as const, capacity: null, coordinators: [{ key: 'alpha', name: 'alpha', repos: [], workspaceId: 'w', session: null }] }
  const byTerminal = main.withFocus(snap, { branch: 'x', displayName: 'x', terminals: [{ id: 'term-b' }] })
  assert.deepEqual(byTerminal.rows.map((r) => r.active), [false, true])
  const byName = main.withFocus(snap, { branch: 'checkout', displayName: 'checkout', terminals: [] })
  assert.deepEqual(byName.rows.map((r) => r.active), [true, false])
  const coordinator = main.withFocus(snap, { branch: '', displayName: 'alpha', terminals: [] })
  assert.deepEqual([coordinator.rows.some((r) => r.active), coordinator.coordinators[0].active], [false, true])
})

test('the focused tab: each tab group\'s front tab and that tab\'s front pane, as a paneKey', async () => {
  const term = (tabId: string, leafId: string) => ({ type: 'terminal', handle: `term-${leafId}`, tabId, leafId, title: leafId, connected: true, active: false })
  // Two tab groups side by side; the left one's front tab is split in two panes.
  const layouts = [{
    worktreeId: 'repo::/w/isola',
    root: {
      type: 'split', direction: 'horizontal',
      first: {
        type: 'group', groupId: 'g1', activeTabId: 'tab-b',
        tabs: [
          { tabId: 'tab-a', title: 'lead', activeLeafId: 'lead', panes: term('tab-a', 'lead') },
          { tabId: 'tab-b', title: 'worker', activeLeafId: 'right', panes: { type: 'pane-split', direction: 'vertical', first: term('tab-b', 'left'), second: term('tab-b', 'right') } }
        ]
      },
      second: { type: 'group', groupId: 'g2', activeTabId: 'tab-c', tabs: [{ tabId: 'tab-c', title: 'shell', activeLeafId: 'shell', panes: term('tab-c', 'shell') }] }
    }
  }]
  assert.deepEqual(main.focusedPanes(layouts), ['tab-b:right', 'tab-c:shell'])
  // One group, its front tab named: only that tab, not the workspace's other agent tabs.
  const one = [{ root: { ...layouts[0].root.first, activeTabId: 'tab-a' } }]
  assert.deepEqual(main.focusedPanes(one), ['tab-a:lead'])
  assert.deepEqual(main.focusedPanes([]), [], 'no terminal shown in the focused workspace')
  assert.deepEqual(main.focusedPanes(undefined), [])

  const calls: string[][] = []
  const front = await main.readFocus(async (args) => { calls.push(args); return { terminals: [], visualLayouts: one } })
  assert.deepEqual(front, ['tab-a:lead'])
  assert.deepEqual(calls, [['terminal', 'list', '--include-visual-layouts']])
  assert.equal(await main.readFocus(async () => { throw new Error('orca terminal list timed out') }), null, 'unknown: the panel falls back to the lead')
})

test('clicking a worker nested under its lead in one worktree marks the worker, not the lead', async () => {
  // As Orca lays it out after the click: release-stores is focused with its worker's tab in front;
  // another worktree has its own tab in front.
  const tab = (tabId: string) => ({ tabId, title: tabId, activeLeafId: 'leaf', panes: { type: 'terminal', handle: `term-${tabId}`, tabId, leafId: 'leaf', connected: true, active: true } })
  const layouts = [
    { worktreeId: 'r::/w/release-stores', worktreePath: '/w/release-stores', root: { type: 'group', groupId: 'g1', activeTabId: 'worker', tabs: [tab('lead'), tab('worker')] } },
    { worktreeId: 'r::/w/other', worktreePath: '/w/other', root: { type: 'group', groupId: 'g2', activeTabId: 'other', tabs: [tab('other')] } }
  ]
  // The worker runs in `/`, where Orca's `--worktree active` (resolved from the current directory) finds no worktree.
  const run = async (args: string[]) => {
    if (args.includes('active')) throw new Error('No Orca-managed worktree contains the current directory: /')
    return { terminals: [], visualLayouts: layouts }
  }
  const rows = main.fromPs([
    { identity: { key: 'stores' }, displayName: 'release-stores', repo: 'katos', path: '/w/release-stores', isActive: true, liveTerminalCount: 2, agents: [
      { paneKey: 'lead:leaf', state: 'working', conversationName: 'Katos store release' },
      { paneKey: 'worker:leaf', parentPaneKey: 'lead:leaf', state: 'done', conversationName: 'Play Console Data safety' }
    ] },
    { identity: { key: 'other' }, displayName: 'other', repo: 'katos', path: '/w/other', liveTerminalCount: 1, agents: [{ paneKey: 'other:leaf', state: 'working', conversationName: 'Other' }] }
  ])
  const nested = assignCoordinators(rows, [], { dispatcherOf: new Map(), paneOf: new Map() })
  assert.equal(nested[0].agents.find((a) => a.paneKey === 'worker:leaf')?.leadPane, 'lead:leaf', 'the worker nests under its lead')
  const focusedPanes = await main.readFocus(run)
  const { main: html } = render({ rows: nested, source: 'cli', capacity: null, coordinators: [], focusedPanes }, emptyUi())
  const current = [...html.matchAll(/class="item[^"]*current"[^>]*data-menu="agent:([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(current, ['worker:leaf'])
})

test('remove anyway waives uncommitted files only, after the person confirmed', async () => {
  const { removeWorktree } = await import('./cockpit.ts')
  const calls: string[][] = []
  const run = async (args: string[]) => { calls.push(args); return {} }
  // A main checkout is refused whatever force says, before any command runs.
  const main_ = main.fromPs([{ identity: { key: 'm' }, displayName: 'main', repo: 'shop', isMainWorktree: true, agents: [] }])[0]
  assert.deepEqual(await removeWorktree(run, main_, true), { removed: false, reason: 'main checkout' })
  assert.equal(calls.length, 0)
})

/** A real, empty git checkout with no remote: no PR can be merged, so only `force` removes it. */
async function scratchCheckout(dirty: boolean): Promise<string> {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'rm-'))
  execFileSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  if (dirty) writeFileSync(join(dir, 'notes.md'), 'draft')
  return dir
}

/** Records the commands removal runs; `terminal list` shows one terminal per pane. */
function removalRun(panes: string[]) {
  const calls: string[] = []
  const run = async (args: string[]) => {
    calls.push(args.slice(0, 2).join(' ') + (args.includes('--terminal') ? ` ${args[args.indexOf('--terminal') + 1]}` : '') + (args.includes('--force') ? ' --force' : ''))
    if (args[0] === 'terminal' && args[1] === 'list') return { terminals: panes.map((p) => ({ tabId: p.split(':')[0], leafId: p.split(':')[1], handle: `term-${p}` })) }
    return {}
  }
  return { calls, run }
}

test('an idle, asking or blocked agent does not stop a confirmed removal; its terminal closes first', async () => {
  const { removeWorktree } = await import('./cockpit.ts')
  const path = await scratchCheckout(false)
  const asking = { summary: { title: 'Release', glance: 'Ship it?', goal: '', since: '', needs: { type: 'decision', ask: 'Ship it?', options: [] }, effort: 'quick', priority: 'P1', role: 'lead', updatedAt: 1 } }
  for (const [label, a] of [
    ['idle', { paneKey: 't:1', state: 'done' }],
    ['asking', { paneKey: 't:1', state: 'done', ...asking }],
    ['waiting', { paneKey: 't:1', state: 'waiting' }],
    ['blocked', { paneKey: 't:1', state: 'blocked' }],
    ['monitoring', { paneKey: 't:1', state: 'done', workingMode: 'monitoring' }]
  ] as const) {
    const [row] = main.fromPs([{ identity: { key: 'rel' }, displayName: 'prod-release-prep', repo: 'web-app', path, branch: 'refs/heads/me/rel', agents: [a as never] }])
    const { calls, run } = removalRun(['t:1'])
    assert.deepEqual(await removeWorktree(run, row, true), { removed: true }, label)
    assert.deepEqual(calls, ['terminal list', 'terminal close term-t:1', 'worktree rm --force'], `${label}: closed, then removed`)
  }
})

test('a working agent stops removal, force or not, before any command runs', async () => {
  const { removeWorktree } = await import('./cockpit.ts')
  const path = await scratchCheckout(false)
  const [row] = main.fromPs([{ identity: { key: 'w' }, displayName: 'w', repo: 'shop', path, branch: 'refs/heads/me/w', agents: [{ paneKey: 't:1', state: 'done' }, { paneKey: 't:2', state: 'working' }] }])
  const { calls, run } = removalRun(['t:1', 't:2'])
  assert.deepEqual(await removeWorktree(run, row, true), { removed: false, reason: 'Agent is working in this worktree' })
  assert.deepEqual(calls, [])
})

test('no merged PR is refused with the uncommitted files, and removed when the person waives it', async () => {
  const { removeWorktree } = await import('./cockpit.ts')
  const path = await scratchCheckout(true)
  const [row] = main.fromPs([{ identity: { key: 'n' }, displayName: 'n', repo: 'shop', path, branch: 'refs/heads/me/n', agents: [{ paneKey: 't:1', state: 'done' }] }])
  const refused = removalRun(['t:1'])
  assert.deepEqual(await removeWorktree(refused.run, row), { removed: false, reason: 'PR not merged', dirty: ['notes.md'] })
  assert.deepEqual(refused.calls, [], 'nothing closed or removed')
  const forced = removalRun(['t:1'])
  assert.deepEqual(await removeWorktree(forced.run, row, true), { removed: true })
  assert.deepEqual(forced.calls, ['terminal list', 'terminal close term-t:1', 'worktree rm --force'])
})

test('a development folder never links the skill; the installed copy repairs a dangling link only', async () => {
  const { ensureOwnLinks } = await import('./install.ts')
  const { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const t = mkdtempSync(join(tmpdir(), 'own-links-'))
  const own = join(t, 'installed', 'skills', 'orca-flow')
  const other = join(t, 'other', 'skills', 'orca-flow')
  mkdirSync(own, { recursive: true })
  mkdirSync(other, { recursive: true })
  const from = join(t, 'profile', 'skills', 'orca-flow')
  const links = [{ from, to: own }]

  assert.equal(ensureOwnLinks(links, false).length, 1, 'a dev folder says once that it leaves the link')
  assert.equal(existsSync(join(t, 'profile')), false, 'and creates nothing')
  mkdirSync(join(t, 'profile', 'skills'), { recursive: true })
  symlinkSync(other, from)
  assert.deepEqual(ensureOwnLinks(links, false, { repairOnly: true }), [], 'nor repairs, quietly')
  assert.equal(readlinkSync(from), other)

  assert.deepEqual(ensureOwnLinks(links, true, { repairOnly: true }), [], 'a link into another existing folder is kept by later checks')
  assert.equal(readlinkSync(from), other)
  rmSync(join(t, 'other'), { recursive: true })
  assert.deepEqual(ensureOwnLinks(links, true, { repairOnly: true }), [`linked ${from}`], 'its folder was removed: repaired')
  assert.equal(readlinkSync(from), own)
  assert.deepEqual(ensureOwnLinks(links, true, { repairOnly: true }), [], 'then left alone')
  rmSync(from)
  assert.deepEqual(ensureOwnLinks(links, true, { repairOnly: true }), [`linked ${from}`], 'a missing link is created')
  assert.ok(lstatSync(from).isSymbolicLink())
  rmSync(t, { recursive: true })
})

test('update check: release tags, version order, the newest above the running one', async () => {
  const { compareVersions, newerVersion, versionsFromTags } = await import('./update.ts')
  const tags = ['abc\trefs/tags/v0.2.9', 'def\trefs/tags/v0.2.10', 'ghi\trefs/tags/v0.2.11-rc1', 'jkl\trefs/tags/latest', 'mno\trefs/tags/v0.3.0'].join('\n')
  assert.deepEqual(versionsFromTags(tags), ['0.2.9', '0.2.10', '0.3.0'], 'only vX.Y.Z releases')
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0, 'numeric, not text, order')
  assert.equal(newerVersion('0.2.10', versionsFromTags(tags)), '0.3.0')
  assert.equal(newerVersion('0.3.0', versionsFromTags(tags)), null)
  assert.equal(newerVersion('0.3.1', ['0.3.0']), null, 'a newer local build is not offered an older release')
  assert.equal(main.installedKey(`/Users/me/Library/Application Support/orca/plugins/cyucelen.flow/${'0a'.repeat(32)}`), 'cyucelen.flow', 'where Orca runs an installed copy')
  assert.equal(main.installedKey('/Users/me/Library/Application Support/orca/plugins/cyucelen.flow/current'), 'cyucelen.flow')
  assert.equal(main.installedKey('/Users/me/code/orca-flow'), null, 'a development folder never updates itself')
})

test('update item: hidden, available, confirm on the first click, update on the second, never approve for you', async () => {
  const { onClick, resultOf, updateItem } = await import('./update.ts')
  assert.deepEqual(updateItem({ kind: 'none' }), { id: 'update', visible: false })
  assert.equal(updateItem({ kind: 'available', version: '0.2.12' }).text, 'Orca Flow 0.2.12 available')
  const first = onClick({ kind: 'available', version: '0.2.12' })
  assert.deepEqual([first.next.kind, first.start], ['confirm', false])
  assert.match(first.message, /Update Orca Flow to 0\.2\.12\?/)
  assert.equal(updateItem(first.next).text, 'Update to 0.2.12? Click again')
  const second = onClick(first.next)
  assert.deepEqual([second.next.kind, second.start], ['updating', true])
  assert.deepEqual(onClick(second.next).start, false, 'a click while updating starts nothing')

  assert.deepEqual(resultOf(0, JSON.stringify({ ok: true, result: { version: '0.2.12' } }), 'cyucelen.flow', '0.2.12'), { kind: 'updated', version: '0.2.12' })
  const approval = resultOf(3, JSON.stringify({ ok: false, error: { code: 'approval_required', message: 'It asks for a new command.', data: { approvalFingerprint: 'ap1-xyz' } } }), 'cyucelen.flow', '0.2.12')
  assert.deepEqual(approval, { kind: 'approval', version: '0.2.12', reason: 'It asks for a new command.', command: 'orca plugin update cyucelen.flow --approve ap1-xyz' })
  const click = onClick(approval)
  assert.deepEqual([click.next.kind, click.start], ['approval', false], 'approval is the person\'s to give')
  assert.match(click.message, /run: orca plugin update cyucelen\.flow --approve ap1-xyz/)
  assert.match(updateItem(approval).tooltip!, /It asks for a new command\.\nTo approve and update, run:\norca plugin update/)
  const failed = resultOf(1, JSON.stringify({ ok: false, error: { code: 'git_auth_failed', message: 'Could not read github.com' } }), 'cyucelen.flow', '0.2.12')
  assert.deepEqual(failed, { kind: 'failed', version: '0.2.12', reason: 'Could not read github.com' })
  assert.equal(onClick(failed).next.kind, 'confirm', 'a failed update can be tried again')
})

test('the panel and the status bar start the update through one path, only from available or failed', async () => {
  const { updater } = await import('./update.ts')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  type S = import('./protocol.ts').UpdateState
  const make = (key: string | null = 'cyucelen.flow') => {
    const started: string[] = []
    const shown: S[] = []
    const u = updater({ key, current: '0.2.15', dir: join(mkdtempSync(join(tmpdir(), 'upd-')), 'update'), show: (s) => shown.push(s), start: (v) => started.push(v), later: () => {}, log: () => {} })
    return { u, started, shown }
  }
  const approval: S = { kind: 'approval', version: '0.2.16', reason: 'New access', command: 'orca plugin update cyucelen.flow --approve ap1-1' }
  for (const [from, starts] of [
    [{ kind: 'available', version: '0.2.16' }, true],
    [{ kind: 'failed', version: '0.2.16', reason: 'offline' }, true],
    [{ kind: 'none' }, false],
    [{ kind: 'updating', version: '0.2.16' }, false],
    [{ kind: 'updated', version: '0.2.16' }, false],
    [approval, false]
  ] as [S, boolean][]) {
    const { u, started, shown } = make()
    u.show(from)
    const r = u.now()
    assert.equal(r.started, starts, `sidebar.update from ${from.kind}`)
    assert.deepEqual(started, starts ? ['0.2.16'] : [], `startUpdate from ${from.kind}`)
    if (starts) assert.deepEqual(shown.at(-1), { kind: 'updating', version: '0.2.16' }, 'the panel and status bar show it updating')
  }
  // Approval: never started, the message names the command (without approving it here).
  const a = make()
  a.u.show(approval)
  assert.match(a.u.now().message, /run: orca plugin update cyucelen\.flow --approve ap1-1/)

  // The status bar keeps its two clicks, through the same start.
  const bar = make()
  bar.u.found('0.2.16')
  bar.u.click()
  assert.deepEqual(bar.started, [], 'the first click only asks')
  bar.u.click()
  assert.deepEqual(bar.started, ['0.2.16'])

  // A development folder never updates itself, from either place.
  const dev = make(null)
  dev.u.show({ kind: 'available', version: '0.2.16' })
  assert.deepEqual([dev.u.now().started, dev.started], [false, []])
})

test('the panel gets the update state in its snapshots and can ask the worker to update', async () => {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'statusBar.update': {}, 'workspace.list': { workspaces: [], truncated: false } } }) })
  const snap = (await worker.request('sidebar.list')) as import('./protocol.ts').Snapshot
  assert.deepEqual(snap.update, { kind: 'none' })
  // This test runs from a development folder: the handler is there, and it updates nothing.
  assert.deepEqual(await worker.request('sidebar.update'), { started: false, message: 'Updates apply to an installed Orca Flow, not a development folder.' })
  await worker.deactivate()
})

test('the update runs outside the worker and leaves its result for the next one', async () => {
  const { readUpdateResult, startUpdate } = await import('./update.ts')
  const { chmodSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const t = mkdtempSync(join(tmpdir(), 'update-'))
  // A stand-in for `orca plugin update` that asks for approval (exit 3).
  const fake = join(t, 'orca')
  writeFileSync(fake, `#!/bin/sh\necho "$@" > "${join(t, 'args')}"\necho '{"ok":false,"error":{"code":"approval_required","message":"New access","data":{"approvalFingerprint":"ap1-1"}}}'\nexit 3\n`)
  chmodSync(fake, 0o755)
  const dir = join(t, 'update')
  startUpdate(fake, 'cyucelen.flow', '0.2.12', dir)
  assert.equal(readUpdateResult(dir, '0.2.11'), 'pending')
  for (let i = 0; i < 200 && readUpdateResult(dir, '0.2.11') === 'pending'; i++) await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(readUpdateResult(dir, '0.2.11'), { kind: 'approval', version: '0.2.12', reason: 'New access', command: 'orca plugin update cyucelen.flow --approve ap1-1' })
  const { readFileSync } = await import('node:fs')
  assert.equal(readFileSync(join(t, 'args'), 'utf8').trim(), 'plugin update cyucelen.flow --json', 'never --approve')
  assert.deepEqual(readUpdateResult(dir, '0.2.12'), { kind: 'updated', version: '0.2.12' }, 'the new version running is the proof')
  assert.equal(readUpdateResult(join(t, 'none'), '0.2.11'), null)
})

test("a session in a coordinator's folder is a coordinator, even before it starts any worker", async () => {
  const { digest } = await import('./summarize.ts')
  const line = (type: string, content: unknown, cwd: string) => JSON.stringify({ type, cwd, timestamp: '2026-11-16T12:51:00Z', message: { content } })
  const home = '/h/orca/coordinators'
  const at = (cwd: string) => digest([line('user', 'You have 1 orchestration message.', cwd), line('assistant', [{ type: 'text', text: 'Still waiting on you: 1. the lead asks X, answer in its chat. 2. Unblock the worktree?' }], cwd)], home)!.role
  assert.equal(at(`${home}/bounti`), 'coordinator')
  assert.equal(at('/w/shop'), 'solo', 'elsewhere it takes a worker-start to coordinate')
  const status = main.statusOf({ rows: [], source: 'cli', capacity: null, coordinators: [{ key: 'b', name: 'bounti', repos: [], workspaceId: 'ws-b',
    session: { paneKey: 'p', workingMode: null, coordinator: 'you', leadPane: null, parentPane: null, orcaSession: null, dispatch: null, terminal: 't', question: null, state: 'done', title: 'Bounti', agentType: 'claude',
      summary: { title: 'Bounti', glance: 'Unblock?', goal: '', since: '', needs: { type: 'decision', ask: 'Unblock?', options: [] }, effort: 'quick', priority: 'P2', role: 'coordinator', updatedAt: 1 } } }] })
  assert.equal(status.text, '1 waiting', 'the status bar counts a coordinator asking you')
})

test('Option+1..9 run chat.1..9, which open the nth chat the way a click on its row does', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(decodeURIComponent(new URL('../orca-plugin.json', import.meta.url).pathname), 'utf8'))
  const ids = new Set(manifest.contributes.commands.map((c: { id: string }) => c.id))
  assert.deepEqual(manifest.contributes.keybindings, Array.from({ length: 9 }, (_, i) => ({ command: `chat.${i + 1}`, key: `Alt+${i + 1}` })))
  for (const k of manifest.contributes.keybindings) assert.ok(ids.has(k.command), `${k.command} is a contributed command`)

  const calls: unknown[] = []
  const open = {
    coordinator: async (key: string) => (calls.push(['coordinator', key]), key === 'gone' ? { ok: false, error: 'No coordinator gone' } : { ok: true }),
    chat: async (input: { workspaceId: string; terminal?: string }) => calls.push(['chat', input])
  }
  const targets = [
    { key: 'coordinator:alpha', coordinator: 'alpha' },
    { key: 'agent:p1', workspaceId: 'identity:w1', terminal: 'term-1' },
    { key: 'agent:p2', workspaceId: 'identity:w2' },
    { key: 'coordinator:gone', coordinator: 'gone' }
  ]
  assert.equal(await main.openNthChat(targets, 1, open), undefined)
  assert.equal(await main.openNthChat(targets, 2, open), undefined)
  assert.equal(await main.openNthChat(targets, 3, open), undefined)
  assert.equal(await main.openNthChat(targets, 4, open), 'No coordinator gone')
  assert.equal(await main.openNthChat(targets, 5, open), 'Orca Flow has no chat 5')
  assert.deepEqual(calls, [
    ['coordinator', 'alpha'],
    ['chat', { workspaceId: 'identity:w1', terminal: 'term-1' }],
    ['chat', { workspaceId: 'identity:w2' }],
    ['coordinator', 'gone']
  ])
})

test('the worker may register every chat command', async () => {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'statusBar.update': {}, 'workspace.list': { workspaces: [], truncated: false } } }) })
  assert.deepEqual(worker.refusals, [], 'chat.1..9 are declared, so registering them is allowed')
  await worker.deactivate()
})

test("a row carries the Linear issue Orca linked to its worktree, as its identifier", () => {
  const [linked, url, none] = main.fromPs([
    { identity: { key: 'a' }, displayName: 'a', repo: 'mono', linkedLinearIssue: 'BOU-4179', agents: [] },
    { identity: { key: 'b' }, displayName: 'b', repo: 'mono', linkedLinearIssue: 'https://linear.app/x/issue/bou-12/slug', agents: [] },
    { identity: { key: 'c' }, displayName: 'c', repo: 'mono', linkedLinearIssue: null, agents: [] }
  ])
  assert.equal(linked.linearIssue, 'BOU-4179')
  assert.equal(url.linearIssue, 'BOU-12')
  assert.equal(none.linearIssue, null)
})

test("a coordinator's Linear teams live in its coordinator.json; setting them keeps the rest", async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'coordinators-'))
  const dir = scaffoldCoordinator(root, { name: 'bounti', look: { color: '#e07b4f', shape: 'pentagon' } })
  assert.deepEqual(readCoordinators(root)[0].linearTeams, [])
  writeLinearTeams(dir, ['BOU', 'cus', 'BOU', 'not a key'])
  assert.deepEqual(readCoordinators(root)[0].linearTeams, ['BOU', 'CUS'])
  assert.equal(JSON.parse(readFileSync(join(dir, COORDINATOR_FILE), 'utf8')).look.color, '#e07b4f')
  writeLinearTeams(dir, [])
  assert.equal('linearTeams' in JSON.parse(readFileSync(join(dir, COORDINATOR_FILE), 'utf8')), false)
})

test('Linear sends are remembered next to the owners: the last coordinator per team and what is starting', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = join(mkdtempSync(join(tmpdir(), 'linear-')), 'linear.json')
  assert.deepEqual(readLinearMemory(path), { lastSent: {}, sent: {} })
  writeLinearMemory({ lastSent: { BOU: 'bounti' }, sent: { 'BOU-1': { coordinator: 'bounti', at: 5 } } }, path)
  assert.deepEqual(readLinearMemory(path), { lastSent: { BOU: 'bounti' }, sent: { 'BOU-1': { coordinator: 'bounti', at: 5 } } })
  writeFileSync(path, '{"lastSent": [1], "sent": "x"}')
  assert.deepEqual(readLinearMemory(path), { lastSent: {}, sent: {} })
})

// ---------- agents in a coordinator's folder ----------

/** The bounti coordinator's folder: its own session, a lead it started in a tab there, and a worker that lead started. */
function coordinatorFolder(withTabs = true) {
  const card = (over: Record<string, unknown>) => ({
    title: 'Work', about: 'What this is for.', glance: '', goal: '', since: 'Did a thing', needs: { type: 'none', ask: '', options: [] },
    effort: 'quick', priority: 'P2', role: 'worker', updatedAt: 1, ...over
  })
  const store: main.Store = {
    cards: {},
    summaries: {
      'tab-c_1': card({ title: 'Orca PR coordination', role: 'coordinator' }) as any,
      'tab-l_1': card({ title: 'Leave request two-day limit', glance: 'Which company did Anja use?', needs: { type: 'info', ask: 'Which company and employee did Anja use?', options: [] }, priority: 'P1' }) as any
    }
  }
  const tabs = withTabs
    ? [
        { paneKey: 'tab-w:1', parentPaneKey: 'tab-l:1', state: 'working', agentType: 'claude', conversationName: 'worker-task_b9f03295fa5d', taskTitle: 'Prepare the demo on staging' },
        { paneKey: 'tab-l:1', parentPaneKey: 'tab-c:1', state: 'done', agentType: 'claude', conversationName: 'worker-task_9eab6a1014fe', taskTitle: 'Find why a leave request seems limited to 2 days (BOU-4243)' }
      ]
    : []
  const ps: main.PsWorktree[] = [
    { worktreeId: 'r::/c/bounti', path: '/c/bounti', isMainWorktree: true, displayName: 'bounti', repo: 'bounti', liveTerminalCount: tabs.length + 1, agents: [...tabs, { paneKey: 'tab-c:1', parentPaneKey: null, state: 'done', agentType: 'claude', conversationName: 'Isola on_demand expo support' }] },
    { identity: { key: 'wt-1' }, path: '/w/mono-1', displayName: 'bou-4100', repo: 'mono', branch: 'refs/heads/bou-4100', liveTerminalCount: 1, agents: [{ paneKey: 'tab-x:1', state: 'working', agentType: 'claude' }] }
  ]
  const info = { key: 'bounti', name: 'bounti', repos: ['mono'], workspaceId: null, dir: '/c/bounti', about: '' }
  const lineage = { dispatcherOf: new Map<string, string>(), paneOf: new Map<string, string>([['term_c', 'tab-c:1'], ['term_l', 'tab-l:1'], ['term_w', 'tab-w:1']]), dispatchOf: new Map<string, 'open' | 'settled'>(withTabs ? [['tab-l:1', 'open'], ['tab-w:1', 'open']] : []) }
  const all = assignCoordinators(main.fromPs(ps, store, new Map([['/c/bounti', 'folder:bounti']])), [info], lineage)
  const coordinators = [{ key: 'bounti', name: 'bounti', repos: ['mono'], workspaceId: null as string | null, session: null as any, active: false }]
  const rows = main.foldCoordinatorFolders(all, coordinators, ['/c/bounti'])
  return { all, rows, coordinators, snap: { source: 'cli' as const, capacity: null, coordinators, rows } }
}

test("a coordinator's own session is the one nobody in its folder started, not the first agent listed", async () => {
  const { coordinatorSession } = await import('./coordinators.ts')
  const a = (paneKey: string, parentPane: string | null = null) => ({ paneKey, parentPane })
  assert.equal(coordinatorSession([a('w', 'l'), a('l', 'c'), a('c')])?.paneKey, 'c')
  assert.equal(coordinatorSession([a('w', 'gone'), a('c')], (p) => p === 'w')?.paneKey, 'c', 'a dispatched worker whose starter closed is not it')
  assert.equal(coordinatorSession([a('x'), a('c'), a('l', 'c')])?.paneKey, 'c', 'of two started by hand, the one that started others')
  assert.equal(coordinatorSession([a('x'), a('y')])?.paneKey, 'x', 'else the first')
  assert.equal(coordinatorSession([]), null)
})

test("agents in a coordinator's folder are its child rows; its face and ask stay its own session's", async () => {
  const { faceOf } = await import('./view.ts')
  const { linkRows } = await import('./linear.ts')
  const { rows, coordinators, snap } = coordinatorFolder()
  const session = coordinators[0].session
  assert.equal(session?.paneKey, 'tab-c:1', 'not the worker listed first in the folder')
  assert.equal(coordinators[0].workspaceId, 'folder:bounti')
  assert.equal(faceOf(session), 'done', "the lead's ask is not the coordinator's")

  const folder = rows.filter((r) => r.folderOf === 'bounti')
  assert.deepEqual(folder.map((r) => r.agents.map((a) => a.paneKey)), [['tab-w:1'], ['tab-l:1']], 'one row per agent, the session in none')
  const [worker, lead] = folder.map((r) => r.agents[0])
  assert.equal(lead.coordinator, 'bounti')
  assert.equal(lead.leadPane, null)
  assert.equal(worker.coordinator, 'bounti')
  assert.equal(worker.leadPane, 'tab-l:1', 'the worker nests under the lead that started it')
  assert.ok(folder.every((r) => r.id === 'folder:bounti' && r.branch === null && r.pr === null), 'no worktree, no PR; a click opens the folder at its tab')
  assert.ok(folder.every((r) => !canRemove(r)), 'the folder is never offered for removal')
  assert.equal((await removeWorktree(async () => { throw new Error('must not run') }, folder[0])).reason, "a coordinator's folder is never removed")
  assert.equal(linkRows(folder, new Set(['BOU']))[1].linearIssue, 'BOU-4243', 'its Linear issue from its Orca task title')
  assert.deepEqual(main.livePanes(snap).sort(), ['tab-c:1', 'tab-l:1', 'tab-w:1', 'tab-x:1'], 'their cards are summarized as usual')

  assert.deepEqual(waitingQueue(rows).map((r) => r.agents[0].paneKey), ['tab-l:1'], "the lead's ask is in Up next")
  const { main: tree, attention } = render(snap, emptyUi())
  const section = tree.slice(tree.indexOf('<section class="coordinator">'), tree.indexOf('</section>', tree.indexOf('<section class="coordinator">')))
  assert.match(section, /Leave request two-day limit/, 'the lead shows under bounti')
  assert.match(section, /Prepare the demo on staging/, 'and its worker')
  assert.match(attention, /Up next · 1/)
  assert.match(attention, /Which company did Anja use\?/)
})

test('a coordinator folder with only its own session is unchanged: no child rows', () => {
  const { rows, coordinators } = coordinatorFolder(false)
  assert.equal(coordinators[0].session?.paneKey, 'tab-c:1')
  assert.deepEqual(rows.map((r) => r.id), ['identity:wt-1'], 'the folder itself is no row')
})

test('a lead or worker in a coordinator folder is not the coordinator', async () => {
  const { roleOf } = await import('./summarize.ts')
  const home = '/c'
  const worker = 'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.\nYour task ID is: task_9eab6a1014fe'
  assert.equal(roleOf(worker, [], '/c/bounti', home), 'worker')
  assert.equal(roleOf('Your role: lead. Find why…', [], '/c/bounti', home), 'lead')
  assert.equal(roleOf('where is that lead? mention of worker_done', [], '/c/bounti', home), 'coordinator', "the coordinator's own session, whatever its user says")
})

test("a click on a coordinator brings its own session's tab to the front, and one on a folder agent that agent's tab", async () => {
  const { all, coordinators, snap } = coordinatorFolder()
  // The lead is listed before the coordinator in its folder and may be the tab in front there.
  const folder = all.find((r) => r.path === '/c/bounti')!
  assert.equal(folder.agents[0].paneKey, 'tab-w:1')
  assert.equal(main.sessionIn(folder)?.terminal, 'term_c', "the coordinator's tab is its own session's, not the first agent's")
  assert.equal(coordinators[0].session?.terminal, 'term_c')

  const { main: tree, attention } = render(snap, emptyUi())
  assert.match(tree, /<button class="coord-open" data-coordinator="bounti"/, 'the coordinator row opens through openCoordinator, which switches to term_c')
  assert.match(tree, /data-open="folder:bounti" data-terminal="term_l" data-menu="agent:tab-l:1"/, "the lead's row opens the folder at the lead's tab")
  assert.match(tree, /data-open="folder:bounti" data-terminal="term_w" data-menu="agent:tab-w:1"/, "and the worker's at the worker's")
  assert.match(attention, /<button class="jump" data-open="folder:bounti" data-terminal="term_l">Jump to session<\/button>/, "Up next's jump too")
  const found = render(snap, { ...emptyUi(), query: 'leave request' }).main
  assert.match(found, /data-open="folder:bounti" data-terminal="term_l"/, 'and a search result for it')

  // Both end in openAgent: the workspace, then a switch to that terminal.
  const calls: string[] = []
  const host = { call: async (method: string, params: unknown) => void calls.push(`${method} ${JSON.stringify(params)}`) }
  await main.openAgent({ host, log: () => {} } as never, async (args) => void calls.push(args.join(' ')), { workspaceId: 'folder:bounti', terminal: 'term_c' })
  assert.deepEqual(calls, ['workspace.open {"workspaceId":"folder:bounti"}', 'terminal switch --terminal term_c'])
})
