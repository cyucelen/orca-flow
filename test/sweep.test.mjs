// node --test test/*.test.mjs
// orca-flow sweep against a fake Orca and real temporary git repos (a bare "origin", a clone, and
// worktrees in every state). Nothing here touches the user's Orca, worktrees or ~/.orca-flow:
// every `orca worktree rm` goes to the fake, which records it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { batchIdOf, classify, dailyStatus, gather, githubRepo, liveSweepDeps, readCoordinatorFiles, statePath, sweepCommand } from '../skills/orca-flow/scripts/sweep.mjs'

const ORIGIN_URL = 'git@github.com:acme/mono.git'

// ---------- real git ----------

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A bare origin, a clone of it on main (origin/HEAD set), and a helper to add worktrees. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'orca-flow-sweep-'))
  const origin = join(root, 'origin.git')
  const main = join(root, 'main')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' })
  g(main, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(main, 'a.txt'), 'one\n')
  g(main, 'add', '.')
  g(main, 'commit', '-q', '-m', 'init')
  g(main, 'push', '-q', '-u', 'origin', 'main')
  g(main, 'remote', 'set-head', 'origin', 'main')
  // The PR's repo is matched against origin's URL: point it at a GitHub name, keep pushing to the bare repo.
  g(main, 'config', 'remote.origin.url', ORIGIN_URL)
  g(main, 'config', 'remote.origin.pushurl', origin)
  const worktree = (name, setup = () => {}) => {
    const path = join(root, name)
    g(main, 'worktree', 'add', '-q', '-b', name, path, 'main')
    setup(path)
    return path
  }
  const commit = (path, file, text) => {
    writeFileSync(join(path, file), text)
    g(path, 'add', file)
    g(path, 'commit', '-q', '-m', `${file}: ${text.trim()}`)
    return g(path, 'rev-parse', 'HEAD')
  }
  const push = (path) => g(path, 'push', '-q', '-u', 'origin', 'HEAD')
  /** Squash-merges a branch into main on origin, and updates the local origin/main (as a fetch would). */
  const squashMerge = (branch) => {
    g(main, 'merge', '-q', '--squash', branch)
    g(main, 'commit', '-q', '-m', `squash ${branch}`)
    g(main, 'push', '-q', 'origin', 'main')
  }
  return { root, main, worktree, commit, push, squashMerge }
}

// ---------- fake Orca ----------

let rowN = 0
/** One `orca worktree ps` row, idle and local unless overridden. */
function row(path, over = {}) {
  rowN++
  return {
    worktreeId: `repo1::${path}`,
    worktreeInstanceId: `inst-${rowN}`,
    hostId: 'local',
    workspaceKind: 'git',
    repo: 'web-app',
    path,
    displayName: path.split('/').pop(),
    branch: `refs/heads/${path.split('/').pop()}`,
    isMainWorktree: false,
    isPinned: false,
    isArchived: false,
    defaultBranch: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    linkedPR: null,
    liveTerminalCount: 0,
    unverifiableTerminalCount: 0,
    hasAttachedPty: false,
    agents: [],
    ...over
  }
}

const pr = (number, state, url = `https://github.com/acme/mono/pull/${number}`) => ({ number, state, url })

/** A dispatch record as `worker-list --full` gives it. */
function dispatch(id, worktreeId, { run = 'run_gtm', task = `task_${id}`, worker = 'ready', status = 'dispatched', terminal = 'released', liveness = 'exited', next = { kind: 'none', argv: [] }, handle = `term_${id}` } = {}) {
  return {
    dispatchId: id,
    taskId: task,
    runId: run,
    workerState: worker,
    dispatchStatus: status,
    agentTerminalHandle: handle,
    terminalState: terminal,
    resource: { worktreeId },
    projection: { role: 'worker', workspace: { id: worktreeId }, liveness: { verdict: liveness }, outcome: worker === 'succeeded' ? 'succeeded' : worker === 'failed' ? 'failed' : 'in_progress', nextAction: next }
  }
}

/**
 * The fake machine. `world` holds the mutable Orca state (rows, dispatches, runs, cleanup, prs,
 * truncated); `onRm` runs on each `worktree rm` (it may throw an Orca error or change the world).
 */
function fakeSweep(world, { cwd, gh, onRm } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-flow-sweep-data-'))
  const live = liveSweepDeps({ dir, orcaBin: '/nonexistent/orca' })
  const calls = []
  const output = []
  const deps = {
    dir,
    cwd: cwd ?? dir,
    coordinatorRoot: world.coordinatorRoot,
    calls,
    output,
    orca: async (args) => {
      calls.push(args)
      const [a, b] = args
      if (a === 'worktree' && b === 'ps') return structuredClone({ worktrees: world.rows, hostScope: { hostIds: ['local'], omittedHostIds: world.omitted ?? [] }, totalCount: world.totalCount ?? world.rows.length, truncated: !!world.truncated })
      if (b === 'worker-list') return structuredClone({ workers: world.dispatches ?? [], page: { hasMore: false, nextCursor: null } })
      if (b === 'run-list') return structuredClone({ runs: world.runs ?? [], nextCursor: null })
      if (a === 'workspace' && b === 'cleanup') {
        if (!world.cleanup) throw new Error('unknown command')
        return structuredClone({ rows: world.cleanup })
      }
      if (a === 'terminal' && b === 'show') throw new Error('no such terminal')
      if (a === 'worktree' && b === 'rm') {
        const id = args[args.indexOf('--worktree') + 1].replace(/^id:/, '')
        await onRm?.(id, args)
        world.rows = world.rows.filter((r) => r.worktreeId !== id)
        return { removed: true }
      }
      throw new Error(`unexpected orca ${args.join(' ')}`)
    },
    git: live.git,
    gh: gh ?? (async (args) => {
      const url = args[2]
      const p = world.prs?.[url]
      if (!p) throw new Error(`no PR ${url}`)
      return JSON.stringify(p)
    }),
    coordinators: () => readCoordinatorFiles(world.coordinatorRoot),
    routes: () => world.routes ?? [],
    owners: () => world.owners ?? {},
    out: (s) => output.push(s),
    now: () => world.now ?? new Date('2026-11-27T10:00:00Z')
  }
  return deps
}

/** Two coordinators that share web-app (firstview and firstview-gtm), with their home rows. */
function coordinators(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-flow-sweep-coords-'))
  const make = (name, repos, terminals) => {
    const dir = join(root, name)
    mkdirSync(dir)
    const members = [{ id: `m-${name}`, workspaceId: `home::${dir}`, paneKey: `p-${name}`, orcaSession: null, agentType: 'claude', title: name, terminals, bindings: terminals.map((terminal) => ({ terminal, paneKey: `p-${name}`, orcaSession: null })) }]
    writeFileSync(join(dir, 'coordinator.json'), JSON.stringify({ name, repos, sessions: { version: 1, current: null, members } }))
    return dir
  }
  const fv = make('firstview', ['web-app'], ['term_fv'])
  const gtm = make('firstview-gtm', ['web-app'], ['term_gtm'])
  const all = make('everything', [], ['term_all'])
  const homes = [fv, gtm, all].map((dir) => row(dir, { worktreeId: `home::${dir}`, repo: dir.split('/').pop(), branch: '', isMainWorktree: true, liveTerminalCount: 1, hasAttachedPty: true }))
  return { root, fv, gtm, all, homes, runs: [{ id: 'run_gtm', coordinator_handle: 'term_gtm' }, { id: 'run_fv', coordinator_handle: 'term_fv' }, { id: 'run_all', coordinator_handle: 'term_all' }], ...extra }
}

const ownedBy = (home) => ({ parentWorktreeId: `home::${home}` })
const byName = (p, name) => Object.entries(p.buckets).flatMap(([bucket, list]) => list.filter((i) => i.name === `web-app/${name}`).map((i) => ({ bucket, ...i })))[0]
async function preview(world, coordinator = 'firstview-gtm', opts) {
  const deps = fakeSweep(world, opts)
  const facts = await gather(deps, coordinator)
  return { deps, facts, p: classify(facts) }
}

// ---------- tests ----------

test('finished vs interrupted vs unclear: merged and pushed is finished, open PR with a dead lead is interrupted, unknown liveness waits', async () => {
  const repo = makeRepo()
  const c = coordinators()
  const merged = repo.worktree('merged', (p) => { const head = repo.commit(p, 'm.txt', 'merged work\n'); repo.push(p); c.mergedHead = head })
  repo.squashMerge('merged')
  const openPr = repo.worktree('open-pr', (p) => { repo.commit(p, 'o.txt', 'wip\n'); repo.push(p) })
  const waiting = repo.worktree('waiting', (p) => { repo.commit(p, 'w.txt', 'wip\n'); repo.push(p) })
  const rows = [
    ...c.homes,
    row(merged, { ...ownedBy(c.gtm), linkedPR: pr(10, 'merged') }),
    row(openPr, { ...ownedBy(c.gtm), linkedPR: pr(11, 'open') }),
    row(waiting, { ...ownedBy(c.gtm), linkedPR: pr(12, 'open') })
  ]
  const world = {
    coordinatorRoot: c.root,
    rows,
    runs: c.runs,
    prs: { [pr(10).url]: { state: 'MERGED', headRefName: 'merged', headRefOid: c.mergedHead, url: pr(10).url, number: 10, baseRefName: 'main' } },
    routes: [
      { role: 'lead', taskId: 'task_open', dispatchId: 'ctx_open', workspace: `repo1::${openPr}` },
      { role: 'lead', taskId: 'task_wait', dispatchId: 'ctx_wait', workspace: `repo1::${waiting}` }
    ],
    dispatches: [
      dispatch('ctx_open', `repo1::${openPr}`, { task: 'task_open', terminal: 'released', liveness: 'exited' }),
      dispatch('ctx_wait', `repo1::${waiting}`, { task: 'task_wait', terminal: 'retained', liveness: 'unverifiable' })
    ]
  }
  const { p, deps } = await preview(world)
  const m = byName(p, 'merged')
  assert.equal(m.bucket, 'finished')
  assert.match(m.reasons[0], /PR #10 merged and HEAD is its head/)
  const o = byName(p, 'open-pr')
  assert.equal(o.bucket, 'interrupted')
  assert.equal(o.lead.taskId, 'task_open')
  assert.equal(o.recovery.kind, 'resume')
  assert.match(o.recovery.command, /^orca orchestration send --to dispatch:ctx_open /)
  assert.ok(o.open.includes('PR #11 is open'))
  const w = byName(p, 'waiting')
  assert.equal(w.bucket, 'unclear')
  assert.equal(w.recovery.kind, 'wait')
  assert.match(w.reasons[0], /liveness unknown/)
  assert.equal(deps.calls.filter((a) => a[0] === 'orchestration' && !['worker-list', 'run-list'].includes(a[1])).length, 0, 'the preview sends and starts nothing')
  assert.deepEqual(p.batch.items.map((i) => i.name), ['web-app/merged'])
  assert.equal(p.batch.id, batchIdOf(p.buckets.finished))
})

test('scope ownership: two coordinators share web-app; only lineage-owned worktrees count, no lineage is never finished, conflicting is skipped', async () => {
  const repo = makeRepo()
  const c = coordinators()
  const gtmOwn = repo.worktree('gtm-own')
  const fvOwn = repo.worktree('fv-own')
  const viaRun = repo.worktree('via-run')
  const nobody = repo.worktree('nobody')
  const both = repo.worktree('both')
  const world = {
    coordinatorRoot: c.root,
    runs: c.runs,
    rows: [...c.homes, row(gtmOwn, ownedBy(c.gtm)), row(fvOwn, ownedBy(c.fv)), row(viaRun), row(nobody), row(both, ownedBy(c.gtm))],
    dispatches: [
      dispatch('ctx_r', `repo1::${viaRun}`, { run: 'run_gtm', worker: 'succeeded', status: 'completed' }),
      dispatch('ctx_b', `repo1::${both}`, { run: 'run_fv', worker: 'succeeded', status: 'completed' })
    ]
  }
  const gtm = (await preview(world, 'firstview-gtm')).p
  assert.equal(byName(gtm, 'gtm-own').bucket, 'finished')
  assert.equal(byName(gtm, 'via-run').bucket, 'finished', 'a dispatch in the coordinator run is lineage')
  assert.deepEqual([byName(gtm, 'fv-own').bucket, byName(gtm, 'fv-own').kind], ['skipped', 'other-owner'])
  assert.equal(byName(gtm, 'nobody').bucket, 'unclear')
  assert.match(byName(gtm, 'nobody').reasons[0], /no owner evidence/)
  assert.deepEqual([byName(gtm, 'both').bucket, byName(gtm, 'both').kind], ['skipped', 'ambiguous'])
  const fv = (await preview(world, 'firstview')).p
  assert.equal(byName(fv, 'fv-own').bucket, 'finished')
  assert.equal(byName(fv, 'gtm-own').bucket, 'skipped')
  assert.equal(byName(fv, 'via-run').bucket, 'skipped')
  // A coordinator whose scope is every repo does not list strangers' worktrees as asks.
  const all = (await preview(world, 'everything')).p
  assert.deepEqual([byName(all, 'nobody').bucket, byName(all, 'nobody').kind], ['skipped', 'unowned'])
  for (const p of [gtm, fv, all]) assert.ok(!p.buckets.finished.some((f) => f.name === 'web-app/nobody'), 'no lineage is never finished')
})

test('active worktrees are skipped: live terminal, unverifiable terminal, attached pty, child worktree, live dispatch', async () => {
  const repo = makeRepo()
  const c = coordinators()
  const paths = ['live', 'unverifiable', 'pty', 'parent', 'dispatched'].map((n) => repo.worktree(n))
  const world = {
    coordinatorRoot: c.root,
    runs: c.runs,
    rows: [
      ...c.homes,
      row(paths[0], { ...ownedBy(c.gtm), liveTerminalCount: 1 }),
      row(paths[1], { ...ownedBy(c.gtm), unverifiableTerminalCount: 1 }),
      row(paths[2], { ...ownedBy(c.gtm), hasAttachedPty: true }),
      row(paths[3], { ...ownedBy(c.gtm), childWorktreeIds: ['repo1::/elsewhere'] }),
      row(paths[4], ownedBy(c.gtm))
    ],
    dispatches: [dispatch('ctx_live', `repo1::${paths[4]}`, { terminal: 'active', liveness: 'live' })]
  }
  const { p } = await preview(world)
  for (const n of ['live', 'unverifiable', 'pty', 'parent', 'dispatched']) assert.deepEqual([byName(p, n).bucket, byName(p, n).kind], ['skipped', 'active'], n)
  assert.equal(p.batch, null)
})

test('never finished with open or unproven work; a squash-merged PR whose head is HEAD is', async () => {
  const repo = makeRepo()
  const c = coordinators()
  const heads = {}
  const wt = {
    dirty: repo.worktree('dirty', (p) => writeFileSync(join(p, 'a.txt'), 'changed\n')),
    untracked: repo.worktree('untracked', (p) => writeFileSync(join(p, 'new.txt'), 'new\n')),
    unpushed: repo.worktree('unpushed', (p) => { repo.commit(p, 'u.txt', 'one\n'); repo.push(p); repo.commit(p, 'u.txt', 'two\n') }),
    noUpstream: repo.worktree('no-upstream', (p) => repo.commit(p, 'n.txt', 'local only\n')),
    newer: repo.worktree('newer', (p) => { heads.newer = repo.commit(p, 'x.txt', 'pr\n'); repo.push(p) }),
    closed: repo.worktree('closed', (p) => { repo.commit(p, 'c.txt', 'rejected\n'); repo.push(p) }),
    mismatch: repo.worktree('mismatch', (p) => { heads.mismatch = repo.commit(p, 'mm.txt', 'x\n'); repo.push(p) }),
    otherRepo: repo.worktree('other-repo', (p) => { heads.otherRepo = repo.commit(p, 'or.txt', 'x\n'); repo.push(p) }),
    noGh: repo.worktree('no-gh', (p) => { heads.noGh = repo.commit(p, 'ng.txt', 'x\n'); repo.push(p) }),
    squash: repo.worktree('squash', (p) => { repo.commit(p, 's1.txt', 'one\n'); heads.squash = repo.commit(p, 's2.txt', 'two\n'); repo.push(p) })
  }
  for (const b of ['newer', 'mismatch', 'other-repo', 'no-gh', 'squash']) repo.squashMerge(b)
  repo.commit(wt.newer, 'x.txt', 'after the merge\n')
  const merged = (n, branch, oid, url = pr(n).url) => ({ state: 'MERGED', headRefName: branch, headRefOid: oid, url, number: n, baseRefName: 'main' })
  const world = {
    coordinatorRoot: c.root,
    runs: c.runs,
    rows: [
      ...c.homes,
      row(wt.dirty, ownedBy(c.gtm)),
      row(wt.untracked, ownedBy(c.gtm)),
      row(wt.unpushed, ownedBy(c.gtm)),
      row(wt.noUpstream, ownedBy(c.gtm)),
      row(wt.newer, { ...ownedBy(c.gtm), linkedPR: pr(20, 'merged') }),
      row(wt.closed, { ...ownedBy(c.gtm), linkedPR: pr(21, 'closed') }),
      row(wt.mismatch, { ...ownedBy(c.gtm), linkedPR: pr(22, 'merged') }),
      row(wt.otherRepo, { ...ownedBy(c.gtm), linkedPR: pr(23, 'merged', 'https://github.com/someone/fork/pull/23') }),
      row(wt.noGh, { ...ownedBy(c.gtm), linkedPR: pr(24, 'merged') }),
      row(wt.squash, { ...ownedBy(c.gtm), linkedPR: pr(25, 'merged') })
    ],
    prs: {
      [pr(20).url]: merged(20, 'newer', heads.newer),
      [pr(22).url]: merged(22, 'some-other-branch', heads.mismatch),
      'https://github.com/someone/fork/pull/23': merged(23, 'other-repo', heads.otherRepo, 'https://github.com/someone/fork/pull/23'),
      [pr(25).url]: merged(25, 'squash', heads.squash)
    }
  }
  const gh = async (args) => {
    if (args[2] === pr(24).url) throw new Error('gh: command not found')
    return JSON.stringify(world.prs[args[2]])
  }
  const { p } = await preview(world, 'firstview-gtm', { gh })
  const expect = {
    dirty: /1 changed file not committed/,
    untracked: /1 untracked file/,
    unpushed: /1 unpushed commit/,
    'no-upstream': /1 commit beyond origin\/main, no PR linked, no upstream/,
    newer: /merged PR #20 with newer local commits/,
    closed: /PR #21 closed unmerged with 1 commit beyond origin\/main/,
    mismatch: /PR head branch some-other-branch is not the local branch mismatch/,
    'other-repo': /PR repo someone\/fork does not match origin acme\/mono/,
    'no-gh': /PR #24 metadata unavailable \(gh: command not found\)/
  }
  for (const [name, why] of Object.entries(expect)) {
    const item = byName(p, name)
    assert.equal(item.bucket, 'unclear', `${name} is not finished`)
    assert.match(item.reasons.join(' '), why, name)
  }
  const squash = byName(p, 'squash')
  assert.equal(squash.bucket, 'finished')
  assert.match(squash.reasons[0], /PR #25 merged and HEAD is its head/)
  assert.throws(() => g(wt.squash, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'), 'its commits are not in main: only the PR proves it')
})

test('main, default branch, pinned, archived, folder, Orca not-removable and remote host are skipped', async () => {
  const repo = makeRepo()
  const c = coordinators()
  const paths = ['pinned', 'archived', 'protected', 'remote', 'folder', 'on-main'].map((n) => repo.worktree(n))
  g(paths[5], 'checkout', '-q', '--detach')
  const world = {
    coordinatorRoot: c.root,
    runs: c.runs,
    rows: [
      ...c.homes,
      row(repo.main, { ...ownedBy(c.gtm), isMainWorktree: true, defaultBranch: true, branch: 'refs/heads/main' }),
      row(paths[0], { ...ownedBy(c.gtm), isPinned: true }),
      row(paths[1], { ...ownedBy(c.gtm), isArchived: true }),
      row(paths[2], ownedBy(c.gtm)),
      row(paths[3], { ...ownedBy(c.gtm), hostId: 'runtime:abc' }),
      row(paths[4], { ...ownedBy(c.gtm), workspaceKind: 'folder' }),
      row(paths[5], { ...ownedBy(c.gtm), branch: 'refs/heads/main' })
    ],
    cleanup: [{ worktreeId: `repo1::${paths[2]}`, evaluation: { action: 'keep', cause: 'not-removable' } }, { worktreeId: `repo1::${paths[0]}`, evaluation: { action: 'keep', cause: 'rules-off' } }]
  }
  const { p } = await preview(world)
  assert.equal(byName(p, 'main').kind, 'main')
  assert.equal(byName(p, 'pinned').kind, 'pinned')
  assert.equal(byName(p, 'archived').kind, 'archived')
  assert.equal(byName(p, 'protected').kind, 'protected')
  assert.match(byName(p, 'protected').reasons[0], /not-removable/)
  assert.equal(byName(p, 'remote').kind, 'remote')
  assert.equal(byName(p, 'folder').kind, 'folder')
  assert.equal(byName(p, 'on-main').kind, 'default-branch', "a worktree on origin's default branch")
  assert.ok(p.buckets.skipped.filter((s) => s.kind === 'home').length === 3)
  assert.equal(p.batch, null)
  // Orca's cleanup preview missing: said so, and only that signal is lost.
  const without = (await preview({ ...world, cleanup: null })).p
  assert.ok(without.notes.some((n) => /cleanup preview unavailable/.test(n)))
  assert.equal(byName(without, 'protected').bucket, 'finished', 'the host signal only ever protects')
})

test('a truncated ps or an omitted host is reported as incomplete', async () => {
  const c = coordinators()
  const { p } = await preview({ coordinatorRoot: c.root, runs: c.runs, rows: c.homes, truncated: true, totalCount: 80, omitted: ['runtime:caca'] })
  assert.match(p.incomplete.join('; '), /Orca listed 3 of 80 worktrees \(truncated\)/)
  assert.match(p.incomplete.join('; '), /host runtime:caca was not covered/)
})

/** Three finished worktrees owned by firstview-gtm, ready for removal tests. */
function removable() {
  const repo = makeRepo()
  const c = coordinators()
  const paths = ['one', 'two', 'three'].map((n) => repo.worktree(n))
  const world = { coordinatorRoot: c.root, runs: c.runs, rows: [...c.homes, ...paths.map((p) => row(p, ownedBy(c.gtm)))] }
  return { repo, c, paths, world }
}
const argsOf = (flags, ...positional) => ({ _: ['sweep', ...positional], ...flags })
const rmCalls = (deps) => deps.calls.filter((a) => a[0] === 'worktree' && a[1] === 'rm')

test('remove refuses a batch id that no longer matches and removes nothing', async () => {
  const { world } = removable()
  const deps = fakeSweep(world)
  assert.equal(await sweepCommand(argsOf({ coordinator: 'firstview-gtm', batch: 'sweep-0000000000' }, 'remove'), deps), 2)
  assert.equal(rmCalls(deps).length, 0)
  assert.match(deps.output.join('\n'), /no longer matches .* now batch sweep-[0-9a-f]{10}.*Nothing removed/)
})

test('remove rechecks each item right before its rm: dirty, moved HEAD or a new terminal is skipped; rm uses --run-hooks and an exact id selector', async () => {
  const { world, paths, repo } = removable()
  const first = fakeSweep(world)
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', json: true }), first)
  const { batch } = JSON.parse(first.output[0])
  assert.equal(batch.items.length, 3)
  // Between the preview and each item's removal, the others change.
  const deps = fakeSweep(world, {
    onRm: (id) => {
      if (id.endsWith('/one')) {
        writeFileSync(join(paths[1], 'a.txt'), 'turned dirty\n')
        repo.commit(paths[2], 'late.txt', 'moved\n')
      }
    }
  })
  assert.equal(await sweepCommand(argsOf({ coordinator: 'firstview-gtm', batch: batch.id }, 'remove'), deps), 0)
  const rms = rmCalls(deps)
  assert.equal(rms.length, 1)
  assert.deepEqual(rms[0], ['worktree', 'rm', '--worktree', `id:repo1::${paths[0]}`, '--run-hooks'])
  const out = deps.output.join('\n')
  assert.match(out, /removed web-app\/one/)
  assert.match(out, /kept web-app\/two: changed since the preview, skipped: now unclear: .*1 changed file not committed/)
  assert.match(out, /kept web-app\/three: changed since the preview, skipped: now unclear: .*1 commit beyond origin\/main/)
  // A dispatch started after the preview is seen even before ps shows its terminal.
  const d = removable()
  const before = fakeSweep(d.world)
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', json: true }), before)
  const dId = JSON.parse(before.output[0]).batch.id
  const d3 = fakeSweep(d.world, { onRm: (wt) => { if (wt.endsWith('/one')) d.world.dispatches = [dispatch('ctx_new', `repo1::${d.paths[1]}`, { terminal: 'active', liveness: 'live' })] } })
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', batch: dId }, 'remove'), d3)
  assert.match(d3.output.join('\n'), /kept web-app\/two: changed since the preview, skipped: now skipped: dispatch ctx_new is live/)
  assert.deepEqual(rmCalls(d3).map((a) => a[3]), [`id:repo1::${d.paths[0]}`, `id:repo1::${d.paths[2]}`])
  assert.equal(d3.calls.filter((a) => a[1] === 'worker-list').length, 1 + 3, 'read once for the batch, then again before each item')
  // A live terminal appearing is caught the same way.
  const t = removable()
  const pre = fakeSweep(t.world)
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', json: true }), pre)
  const id = JSON.parse(pre.output[0]).batch.id
  const d2 = fakeSweep(t.world, { onRm: (wt) => { if (wt.endsWith('/one')) t.world.rows.find((r) => r.path === t.paths[1]).liveTerminalCount = 1 } })
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', batch: id }, 'remove'), d2)
  assert.match(d2.output.join('\n'), /kept web-app\/two: changed since the preview, skipped: now skipped: 1 live terminal/)
  assert.equal(rmCalls(d2).length, 2, 'one and three removed')
})

test('a failed archive hook is reported, never retried or forced, and stops the batch', async () => {
  const { world, paths } = removable()
  const pre = fakeSweep(world)
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', json: true }), pre)
  const id = JSON.parse(pre.output[0]).batch.id
  const deps = fakeSweep(world, {
    onRm: (wt) => {
      if (wt.endsWith('/two')) throw Object.assign(new Error('archive hook exited 1: services still running'), { code: 'worktree_archive_hook_failed' })
    }
  })
  assert.equal(await sweepCommand(argsOf({ coordinator: 'firstview-gtm', batch: id }, 'remove'), deps), 1)
  const rms = rmCalls(deps)
  assert.deepEqual(rms.map((a) => a[3]), [`id:repo1::${paths[0]}`, `id:repo1::${paths[1]}`], 'two attempted once, three not attempted')
  for (const a of rms) {
    assert.ok(a.includes('--run-hooks'))
    assert.ok(!a.includes('--force') && !a.includes('--allow-failed-archive-hook') && !a.includes('--delete-branch'))
  }
  const out = deps.output.join('\n')
  assert.match(out, /kept web-app\/two: archive hook failed, Orca kept it: archive hook exited 1/)
  assert.match(out, /kept web-app\/three: not attempted: the batch stops at the first failed removal \(no retry, no --force\)/)
})

test('cadence: asked makes the daily review done; new candidates make it due; declined keeps an item out until HEAD moves', async () => {
  const { world, paths, repo } = removable()
  const deps = fakeSweep(world)
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', json: true }), deps)
  const p1 = JSON.parse(deps.output.pop())
  assert.equal(p1.daily, 'due')
  assert.equal(existsSync(statePath(deps.dir, 'firstview-gtm')), false, 'the preview writes nothing')
  assert.equal(await sweepCommand(argsOf({ coordinator: 'firstview-gtm', batch: p1.batch.id }, 'asked'), deps), 0)
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', json: true }), deps)
  assert.equal(JSON.parse(deps.output.pop()).daily, 'done today')
  // A day later it is due again.
  assert.equal(dailyStatus(JSON.parse(readFileSync(statePath(deps.dir, 'firstview-gtm'), 'utf8')), p1.batch, Date.parse('2026-11-28T10:00:01Z')), 'due')
  // The user says no: the items move to skipped "user kept it".
  assert.equal(await sweepCommand(argsOf({ coordinator: 'firstview-gtm', batch: p1.batch.id }, 'declined'), deps), 0)
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', json: true }), deps)
  const p2 = JSON.parse(deps.output.pop())
  assert.equal(p2.batch, null)
  assert.equal(p2.buckets.skipped.filter((s) => s.kind === 'user-kept').length, 3)
  assert.equal(p2.daily, 'nothing to ask')
  // HEAD moves on one (and it is integrated again): it comes back as a new candidate, and the review is due.
  repo.commit(paths[0], 'next.txt', 'more\n')
  g(repo.main, 'merge', '-q', '--ff-only', 'one')
  g(repo.main, 'push', '-q', 'origin', 'main')
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm', json: true }), deps)
  const p3 = JSON.parse(deps.output.pop())
  assert.deepEqual(p3.batch.items.map((i) => i.name), ['web-app/one'])
  assert.equal(p3.daily, 'due')
  // asked/declined against a stale batch id record nothing.
  assert.equal(await sweepCommand(argsOf({ coordinator: 'firstview-gtm', batch: p1.batch.id }, 'asked'), deps), 2)
})

test('the coordinator comes from the folder the command runs in, and a text preview names the batch and the one question', async () => {
  const { world, c } = removable()
  const deps = fakeSweep(world, { cwd: join(c.gtm) })
  assert.equal(await sweepCommand(argsOf({}), deps), 0)
  const text = deps.output.join('\n')
  assert.match(text, /^Sweep for firstview-gtm \(scope: web-app\)/)
  assert.match(text, /finished \(3\): removal candidates\n {2}web-app\/one @ [0-9a-f]{7}: no commits beyond origin\/main; clean/)
  const ask = text.split('\n').find((l) => l.startsWith('Ask the user once'))
  assert.equal(ask, 'Ask the user once (Needs your yes): "Remove these 3 finished worktrees: one, two, three? (branches are kept)"  Reply: yes or no')
  assert.doesNotMatch(ask, /sweep-|[0-9a-f]{7,}/, 'the Ask holds no batch id or hash (messages.md internal-id)')
  assert.match(text, /yes: orca-flow sweep remove --batch sweep-/)
  await assert.rejects(sweepCommand(argsOf({}), fakeSweep(world)), /run it in a coordinator folder, or pass --coordinator/)
  await assert.rejects(sweepCommand(argsOf({ coordinator: 'nope' }), fakeSweep(world)), /no coordinator named nope/)
})

test('githubRepo matches ssh, https and PR urls', () => {
  assert.equal(githubRepo('git@github.com:Acme/Mono.git'), 'acme/mono')
  assert.equal(githubRepo('https://github.com/acme/mono'), 'acme/mono')
  assert.equal(githubRepo('https://github.com/acme/mono/pull/12'), 'acme/mono')
  assert.equal(githubRepo('/tmp/origin.git'), null)
})

test("leads decide interrupted vs unclear: a lead that reported success with work open, a lead that never reported on integrated work, an unknown worker, an upstream past the merged PR", async () => {
  const repo = makeRepo()
  const c = coordinators()
  const heads = {}
  const wt = {
    reported: repo.worktree('reported', (p) => repo.commit(p, 'r.txt', 'open\n')),
    silent: repo.worktree('silent'),
    worker: repo.worktree('worker'),
    gone: repo.worktree('gone'),
    past: repo.worktree('past', (p) => { heads.past = repo.commit(p, 'p.txt', 'pr\n'); repo.push(p) })
  }
  repo.squashMerge('past')
  repo.commit(wt.past, 'p.txt', 'pushed after the merge\n')
  repo.push(wt.past)
  g(wt.past, 'reset', '-q', '--hard', heads.past)
  const id = (p) => `repo1::${p}`
  const world = {
    coordinatorRoot: c.root,
    runs: c.runs,
    rows: [...c.homes, ...Object.values(wt).map((p) => row(p, ownedBy(c.gtm)))],
    routes: [
      { role: 'lead', taskId: 'task_rep', dispatchId: 'ctx_rep', workspace: id(wt.reported) },
      { role: 'lead', taskId: 'task_sil', dispatchId: 'ctx_sil', workspace: id(wt.silent) },
      { role: 'lead', taskId: 'task_gone', dispatchId: 'ctx_gone', workspace: id(wt.gone) },
      { role: 'worker', taskId: 'task_w', dispatchId: 'ctx_w', workspace: id(wt.worker) }
    ],
    dispatches: [
      dispatch('ctx_rep', id(wt.reported), { task: 'task_rep', worker: 'succeeded', status: 'completed' }),
      dispatch('ctx_sil', id(wt.silent), { task: 'task_sil' }),
      dispatch('ctx_w', id(wt.worker), { task: 'task_w', terminal: 'retained', liveness: 'unverifiable' })
    ],
    prs: { [pr(30).url]: { state: 'MERGED', headRefName: 'past', headRefOid: heads.past, url: pr(30).url, number: 30 } }
  }
  world.rows.find((r) => r.path === wt.past).linkedPR = pr(30, 'merged')
  const { p } = await preview(world)
  const reported = byName(p, 'reported')
  assert.equal(reported.bucket, 'unclear')
  assert.match(reported.reasons[0], /lead task_rep reported succeeded but work is still open: 1 commit beyond origin\/main/)
  const silent = byName(p, 'silent')
  assert.equal(silent.bucket, 'unclear')
  assert.match(silent.reasons[0], /work looks integrated .* but lead task_sil never reported success/)
  const worker = byName(p, 'worker')
  assert.deepEqual([worker.bucket, worker.recovery?.kind], ['unclear', 'wait'])
  assert.match(worker.reasons[0], /liveness unknown: dispatch ctx_w/)
  assert.match(byName(p, 'gone').reasons[0], /routes.jsonl names lead dispatch ctx_gone .* Orca has no record/)
  const past = byName(p, 'past')
  assert.equal(past.bucket, 'unclear')
  assert.match(past.reasons[0], /origin\/past has 1 commit the merged PR lacks/)
  assert.equal(p.batch, null)
  // A failed lead with open work: resume first, reassign named as the fallback with its capacity gate.
  world.dispatches[0] = dispatch('ctx_rep', id(wt.reported), { task: 'task_rep', worker: 'failed', status: 'failed' })
  const again = byName((await preview(world)).p, 'reported')
  assert.equal(again.bucket, 'interrupted')
  assert.equal(again.recovery.kind, 'resume')
  assert.match(again.recovery.alternative.command, /^orca-flow dispatch --role lead --task task_rep --retry-of ctx_rep /)
  assert.match(again.recovery.alternative.why, /Capacity gate/)
  // After the coordinator resumed it once, a lead that dies again is the user's call, even under a new dispatch of the same task.
  const deps = fakeSweep(world)
  assert.equal(await sweepCommand(argsOf({ coordinator: 'firstview-gtm', dispatch: 'ctx_rep' }, 'resumed'), deps), 0)
  world.dispatches.unshift(dispatch('ctx_rep2', id(wt.reported), { task: 'task_rep', worker: 'failed', status: 'failed' }))
  const died = byName(classify(await gather(deps, 'firstview-gtm')), 'reported')
  assert.equal(died.bucket, 'interrupted')
  assert.equal(died.recovery.kind, 'ask-user')
  assert.match(died.recovery.why, /resumed before at 2026-11-27T10:00:00.000Z and died again: tell the user and ask/)
  deps.output.length = 0
  await sweepCommand(argsOf({ coordinator: 'firstview-gtm' }), deps)
  assert.match(deps.output[0], /recovery \(ask-user\): resumed before/)
  assert.doesNotMatch(deps.output[0], /send --to dispatch:ctx_rep2/, 'no resume command offered a second time')
  await assert.rejects(sweepCommand(argsOf({ coordinator: 'firstview-gtm' }, 'resumed'), deps), /needs --dispatch/)
})

test('a detached HEAD is unclear even when its commit is in base', async () => {
  const repo = makeRepo()
  const c = coordinators()
  const path = repo.worktree('detached', (p) => g(p, 'checkout', '-q', '--detach'))
  const { p } = await preview({ coordinatorRoot: c.root, runs: c.runs, rows: [...c.homes, row(path, { ...ownedBy(c.gtm), branch: '' })] })
  const d = byName(p, 'detached')
  assert.equal(d.bucket, 'unclear')
  assert.match(d.reasons[0], /detached HEAD/)
})
