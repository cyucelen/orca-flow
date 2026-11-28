// The paired-host poller over a fake Orca runner: never the real Orca, never a real host.
import { assert, test } from 'orca/testing'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS_EVERY_MS, BACKOFF_MAX_MS, createHostPoller, endedTurns, MEMORY_EVERY_MS, PROBE_EVERY_MS, turnKey, turnTracker, type HostRun } from './hosts.ts'
import type { PsWorktree } from './worker.ts'
import { STALE_AFTER_MS } from '../skills/orca-flow/scripts/hosts.mjs'

const GB = 1024 ** 3
const CACA = { id: 'env-caca', name: 'caca', runtimeId: 'rt-1', endpoints: [{ url: 'ws://10.0.0.5:6768', token: 'secret' }] }
const status = (over: Record<string, unknown> = {}) => ({ runtime: { reachable: true, connectionState: 'connected', appVersion: '1.4.232', capabilities: ['orchestration.federation.v1'], ...over } })
const ps = (path = '/Users/me/reputation') => ({ worktrees: [{ hostId: 'local', worktreeId: `repo1::${path}`, identity: { key: 'wt:a' }, path, repo: 'reputation', branch: 'refs/heads/main', displayName: 'reputation', agents: [{ paneKey: 'tab1:leaf1', state: 'working', agentType: 'claude' }] }] })
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'orca-flow-hosts-')), 'hosts.json')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A fake `orca` runner: `answers[cmd]` per environment (or for all), a function of the call count; records every call. */
function fakeOrca(answers: Record<string, (env: string, n: number) => unknown>) {
  const calls: { cmd: string; env: string | null; at: number }[] = []
  const counts = new Map<string, number>()
  // Hosts with a command running (a probe runs several of one host at once), and status calls of one host at once.
  const runningOf = new Map<string, number>()
  const statusOf = new Map<string, number>()
  let maxHosts = 0
  let maxSameHost = 0
  const run: HostRun = async (args) => {
    const cmd = args.slice(0, 2).join(' ').replace(/ --.*$/, '')
    const i = args.indexOf('--environment')
    const env = i >= 0 ? args[i + 1] : null
    calls.push({ cmd, env, at: Date.now() })
    const key = `${cmd}@${env}`
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    const answer = answers[cmd]
    if (!answer) throw new Error(`unexpected orca ${args.join(' ')}`)
    if (env) {
      runningOf.set(env, (runningOf.get(env) ?? 0) + 1)
      maxHosts = Math.max(maxHosts, [...runningOf.values()].filter((x) => x > 0).length)
      if (cmd === 'status') { statusOf.set(env, (statusOf.get(env) ?? 0) + 1); maxSameHost = Math.max(maxSameHost, statusOf.get(env)!) }
    }
    try {
      const v = answer(env ?? '', n)
      return await (v instanceof Promise ? v : Promise.resolve(v)).then((x) => { if (x instanceof Error) throw x; return x })
    } finally {
      if (env) runningOf.set(env, runningOf.get(env)! - 1)
      if (env && cmd === 'status') statusOf.set(env, statusOf.get(env)! - 1)
    }
  }
  return { run, calls, max: () => maxHosts, maxSameHost: () => maxSameHost, probes: (cmd = 'status') => calls.filter((c) => c.cmd === cmd) }
}

const healthy = (over: Record<string, (env: string, n: number) => unknown> = {}) => fakeOrca({
  'environment list': () => ({ environments: [CACA] }),
  status: () => status(),
  'worktree ps': () => ps(),
  'agent installed': () => ({ agents: [{ id: 'claude', default: true }, { id: 'codex' }] }),
  'diagnostics memory': () => ({ host: { totalMemory: 128 * GB, availableMemory: 96 * GB }, collectedAt: 42 }),
  ...over
})

test('paired discovery: environment list names caca, a probe reads it, its rows are re-keyed to it', async () => {
  let clock = 1_000_000
  const orca = healthy()
  const file = tmpFile()
  let changes = 0
  const p = createHostPoller({ run: orca.run, file, now: () => clock, onChange: () => changes++ })
  assert.equal(p.view(), null) // nothing known yet: the snapshot is as without hosts
  p.tick()
  await p.idle()
  const v = p.view()!
  assert.deepEqual(v.hosts, [{
    id: 'runtime:env-caca', name: 'caca', kind: 'paired', state: 'reachable', stale: false, checkedAt: clock, seenAt: clock, version: '1.4.232',
    reason: null, memory: { totalGB: 128, availableGB: 96, at: 42 }, agents: ['claude', 'codex'], remoteWorkers: true
  }])
  assert.equal(v.worktrees.length, 1)
  assert.deepEqual(v.worktrees[0].host, { id: 'runtime:env-caca', name: 'caca', stale: false })
  const [w] = v.worktrees[0].worktrees
  assert.equal(w.hostId, 'runtime:env-caca')
  assert.equal(w.worktreeId, 'runtime:env-caca|repo1::/Users/me/reputation')
  assert.equal(w.agents![0].paneKey, 'runtime:env-caca|tab1:leaf1')
  // Every host command names the host by its environment id, never by its name.
  assert.ok(orca.calls.filter((c) => c.cmd !== 'environment list').every((c) => c.env === 'env-caca'))
  assert.ok(changes >= 1)
  // hosts.json: the host's id, name and environment id, never its endpoints, runtime id or pairing data.
  const text = readFileSync(file, 'utf8')
  const saved = JSON.parse(text).hosts[0]
  assert.deepEqual([saved.id, saved.name, saved.environmentId], ['runtime:env-caca', 'caca', 'env-caca'])
  assert.ok(!/ws:\/\/|endpoints|secret|rt-1/.test(text))
  // An older caca without the remote-worker capability: a host-version limit, said as such.
  clock += PROBE_EVERY_MS
  const older = healthy({ status: () => status({ capabilities: [] }) })
  const q = createHostPoller({ run: older.run, now: () => clock })
  q.tick()
  await q.idle()
  assert.equal(q.view()!.hosts[0].remoteWorkers, false)
})

test('no paired host (an empty or failing environment list): nothing is probed and the view is null', async () => {
  for (const answer of [() => ({ environments: [] }), () => new Error('orca is not running')]) {
    const orca = fakeOrca({ 'environment list': answer })
    const file = tmpFile()
    const p = createHostPoller({ run: orca.run, file, now: () => 1 })
    p.tick()
    await p.idle()
    assert.equal(p.view(), null)
    assert.deepEqual(orca.calls.map((c) => c.cmd), ['environment list'])
    assert.equal(existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).hosts.length > 0, false)
  }
})

test('reachability: a failed status is unavailable with a safe reason, and the host backs off', async () => {
  let clock = 0
  const orca = healthy({ status: () => new Error('connect ECONNREFUSED ws://10.0.0.5:6768/rpc token=abc') })
  const p = createHostPoller({ run: orca.run, now: () => clock })
  p.tick()
  await p.idle()
  const h = p.view()!.hosts[0]
  assert.equal(h.state, 'unavailable')
  assert.equal(h.stale, true)
  assert.ok(!/ws:\/\/|10\.0\.0\.5|abc/.test(h.reason!))
  assert.match(h.reason!, /ECONNREFUSED <endpoint>/)
  assert.equal(orca.probes('worktree ps').length, 0) // an unreachable host is asked nothing more
  // Backoff: 60 s, then 120 s, ... never sooner, at most 5 min.
  const probeAt = async (t: number) => { clock = t; p.tick(); await p.idle(); return orca.probes().length }
  assert.equal(await probeAt(PROBE_EVERY_MS - 1), 1)
  assert.equal(await probeAt(PROBE_EVERY_MS), 2)
  assert.equal(await probeAt(PROBE_EVERY_MS + 2 * PROBE_EVERY_MS - 1), 2)
  assert.equal(await probeAt(3 * PROBE_EVERY_MS), 3)
  // 240 s, then capped at 300 s.
  assert.equal(await probeAt(3 * PROBE_EVERY_MS + 4 * PROBE_EVERY_MS), 4)
  let t = 7 * PROBE_EVERY_MS
  for (let i = 0; i < 3; i++) {
    assert.equal(await probeAt(t + BACKOFF_MAX_MS - 1), 4 + i)
    t += BACKOFF_MAX_MS
    assert.equal(await probeAt(t), 5 + i)
  }
  // A host Orca lists but reports disconnected is unavailable too, with Orca's word for it.
  const off = healthy({ status: () => status({ reachable: false, connectionState: 'disconnected' }) })
  const q = createHostPoller({ run: off.run, now: () => 0 })
  q.tick()
  await q.idle()
  assert.deepEqual([q.view()!.hosts[0].state, q.view()!.hosts[0].reason], ['unavailable', 'Orca reports it disconnected'])
})

test('a host never probed this session is checking; data older than STALE_AFTER_MS is stale', async () => {
  let clock = 0
  let psFails = false
  const orca = healthy({ 'worktree ps': () => (psFails ? new Error('orca worktree ps timed out') : ps()) })
  const p = createHostPoller({ run: orca.run, now: () => clock })
  // Listed, not probed yet.
  const listing = createHostPoller({ run: fakeOrca({ 'environment list': () => ({ environments: [CACA] }), status: () => new Promise(() => {}) }).run, now: () => 0, timeoutMs: 5_000 })
  listing.tick()
  await sleep(10)
  assert.deepEqual([listing.view()!.hosts[0].state, listing.view()!.hosts[0].stale, listing.view()!.hosts[0].checkedAt], ['checking', false, null])
  listing.stop()
  p.tick()
  await p.idle()
  assert.equal(p.view()!.hosts[0].stale, false)
  // From now on its worktree list fails while its status answers: the last rows stay, then go stale.
  psFails = true
  for (clock = PROBE_EVERY_MS; clock <= STALE_AFTER_MS + PROBE_EVERY_MS; clock += PROBE_EVERY_MS) { p.tick(); await p.idle() }
  const v = p.view()!
  assert.equal(v.hosts[0].state, 'reachable')
  assert.equal(v.hosts[0].stale, true)
  assert.match(v.hosts[0].reason!, /^worktree list failed: orca worktree ps timed out/)
  assert.equal(v.worktrees[0].worktrees.length, 1)
  assert.equal(v.worktrees[0].host.stale, true)
})

test('last known kept: a host that goes unreachable after a good probe keeps its rows, stale; a restart shows them from hosts.json', async () => {
  let clock = 0
  let down = false
  const file = tmpFile()
  const orca = healthy({ status: () => (down ? new Error('host unreachable') : status()) })
  const p = createHostPoller({ run: orca.run, file, now: () => clock })
  p.tick()
  await p.idle()
  down = true
  clock = PROBE_EVERY_MS
  p.tick()
  await p.idle()
  const v = p.view()!
  assert.deepEqual([v.hosts[0].state, v.hosts[0].stale, v.hosts[0].reason, v.hosts[0].seenAt], ['unavailable', true, 'host unreachable', 0])
  assert.equal(v.worktrees[0].worktrees[0].worktreeId, 'runtime:env-caca|repo1::/Users/me/reputation')
  assert.deepEqual(v.hosts[0].memory, { totalGB: 128, availableGB: 96, at: 42 }) // the last good memory too
  p.stop()

  // Orca restarts: before anything answers, the last rows show at once, stale, checking; nothing is probed from the file alone.
  const again = fakeOrca({ 'environment list': () => new Promise(() => {}) })
  const q = createHostPoller({ run: again.run, file, now: () => clock + 1, timeoutMs: 50 })
  const shown = q.view()!
  assert.deepEqual([shown.hosts[0].state, shown.hosts[0].stale, shown.hosts[0].name, shown.hosts[0].checkedAt], ['checking', true, 'caca', null])
  assert.equal(shown.worktrees[0].worktrees[0].agents![0].paneKey, 'runtime:env-caca|tab1:leaf1')
  q.tick()
  await sleep(5)
  assert.deepEqual(again.calls.map((c) => c.cmd), ['environment list'])
  // The listing fails (times out): treated as no paired host; the file stays for next time.
  await q.idle()
  assert.equal(q.view(), null)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hosts.length, 1)
  // A host unpaired since is dropped from the file.
  const gone = createHostPoller({ run: fakeOrca({ 'environment list': () => ({ environments: [] }) }).run, file, now: () => clock })
  gone.tick()
  await gone.idle()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hosts.length, 0)
})

test('partial host: status answers but ps times out keeps the last rows; a failed memory read is null and the rows stay fresh', async () => {
  let clock = 0
  let psHangs = false
  const orca = healthy({ 'worktree ps': () => (psHangs ? new Promise(() => {}) : ps()), 'diagnostics memory': () => new Error('sweep failed') })
  const p = createHostPoller({ run: orca.run, now: () => clock, timeoutMs: 40 })
  p.tick()
  await p.idle()
  let h = p.view()!.hosts[0]
  assert.deepEqual([h.state, h.stale, h.memory, h.reason], ['reachable', false, null, null])
  assert.deepEqual(h.agents, ['claude', 'codex'])
  psHangs = true
  clock = PROBE_EVERY_MS
  p.tick()
  await p.idle()
  h = p.view()!.hosts[0]
  assert.equal(h.state, 'reachable')
  assert.match(h.reason!, /worktree list failed: orca worktree ps timed out/)
  assert.equal(p.view()!.worktrees[0].worktrees.length, 1)
})

test('agents are read every 10 min and memory every 5 min; status and worktrees every minute', async () => {
  let clock = 0
  const orca = healthy()
  const p = createHostPoller({ run: orca.run, now: () => clock })
  for (clock = 0; clock <= 20 * 60_000; clock += PROBE_EVERY_MS) { p.tick(); await p.idle() }
  assert.equal(orca.probes('status').length, 21)
  assert.equal(orca.probes('worktree ps').length, 21)
  assert.equal(orca.probes('agent installed').length, 20 * 60_000 / AGENTS_EVERY_MS + 1)
  assert.equal(orca.probes('diagnostics memory').length, 20 * 60_000 / MEMORY_EVERY_MS + 1)
  // The environment list again every 5 minutes.
  assert.equal(orca.probes('environment list').length, 5)
  // Reading the view (what every sidebar refresh does) never probes.
  const before = orca.calls.length
  for (let i = 0; i < 50; i++) p.view()
  assert.equal(orca.calls.length, before)
})

test('bounded: 5 paired hosts, one hanging: at most 2 probes in flight, the others not held past the timeout, never two of one host', async () => {
  let clock = 0
  const envs = ['h1', 'h2', 'h3', 'h4', 'h5'].map((id) => ({ id, name: id }))
  const orca = healthy({
    'environment list': () => ({ environments: envs }),
    status: (env) => (env === 'h1' ? new Promise(() => {}) : new Promise((r) => setTimeout(() => r(status()), 5)))
  })
  const p = createHostPoller({ run: orca.run, now: () => clock, timeoutMs: 400 })
  p.tick()
  await sleep(120)
  // h1 still hangs; h2..h5 were all probed meanwhile, two at a time.
  assert.deepEqual(p.inFlight(), ['runtime:h1'])
  assert.deepEqual(new Set(orca.probes().map((c) => c.env)), new Set(envs.map((e) => e.id)))
  assert.ok(orca.max() <= 2, `max in flight ${orca.max()}`)
  // Ticks while h1 hangs, even with it due again, never start a second probe of it.
  clock = 10 * PROBE_EVERY_MS
  for (let i = 0; i < 5; i++) { p.tick(); await sleep(5) }
  assert.equal(orca.probes().filter((c) => c.env === 'h1').length, 1)
  assert.equal(orca.maxSameHost(), 1)
  await p.idle()
  // The hang ended at the timeout: unavailable, with why.
  const h1 = p.view()!.hosts.find((h) => h.id === 'runtime:h1')!
  assert.deepEqual([h1.state, h1.reason], ['unavailable', 'orca status timed out'])
  assert.ok(orca.max() <= 2)
  p.stop()
})

// ---------- remote turn summaries: when a paired host's turn ended ----------

const agentRow = (agent: Record<string, unknown>): PsWorktree[] => [{ hostId: 'runtime:env-caca', worktreeId: 'runtime:env-caca|repo1::/Users/me/reputation', agents: [{ paneKey: 'runtime:env-caca|tab1:leaf1', orcaSessionId: 's1', agentType: 'claude', prompt: 'whats statuss', ...agent }] }]

test('remote turns: one per finished turn, none while working, none for repeated polls or after a restart', () => {
  const file = tmpFile().replace('hosts.json', 'remote-turns.json')
  const t = turnTracker({ file })
  const host = 'runtime:env-caca'
  assert.deepEqual(t.take(host, agentRow({ state: 'working', lastAssistantMessage: 'Looking…' }), 1), [], 'none while working')
  assert.deepEqual(t.take(host, agentRow({ state: 'done', lastAssistantMessage: '' }), 2), [], 'none without a final message')
  const [turn, ...more] = t.take(host, agentRow({ state: 'done', lastAssistantMessage: 'All green: 3 PRs merged.', updatedAt: 50 }), 3)
  assert.equal(more.length, 0)
  assert.deepEqual(turn, { pane: 'runtime:env-caca|tab1:leaf1', hostId: host, worktreeId: 'remote:runtime:env-caca|repo1::/Users/me/reputation', prompt: 'whats statuss', lastAssistant: 'All green: 3 PRs merged.', at: 50, key: turnKey('All green: 3 PRs merged.'), orcaSession: 's1', agentType: 'claude' })
  for (let i = 0; i < 3; i++) assert.deepEqual(t.take(host, agentRow({ state: 'done', lastAssistantMessage: 'All green: 3 PRs merged.' }), 4 + i), [], 'the same turn polled again')
  // Waiting on the user after a new message: that is a turn end too, once.
  assert.equal(t.take(host, agentRow({ state: 'waiting', lastAssistantMessage: 'Ship it?' }), 10).length, 1)
  assert.equal(t.take(host, agentRow({ state: 'blocked', lastAssistantMessage: 'Ship it?' }), 11).length, 0)
  // Working only on background work while its own turn is done counts as done (as for local agents).
  assert.equal(t.take(host, agentRow({ state: 'working', mainAgent: { state: 'done' }, lastAssistantMessage: 'Watching CI.' }), 12).length, 1)
  // Orca restarts: the file remembers, so nothing runs again.
  const again = turnTracker({ file })
  assert.deepEqual(again.take(host, agentRow({ state: 'working', mainAgent: { state: 'done' }, lastAssistantMessage: 'Watching CI.' }), 13), [])
  assert.ok(!/whats statuss|Watching CI/.test(readFileSync(file, 'utf8')), 'only hashes are kept')
  // A pane the host no longer lists is forgotten; other hosts' panes are kept.
  const other = endedTurns('runtime:h2', [{ worktreeId: 'runtime:h2|w', agents: [{ paneKey: 'runtime:h2|p', state: 'done', lastAssistantMessage: 'ok' }] }], {}, 1)
  assert.equal(other.length, 1)
  again.take('runtime:h2', [{ worktreeId: 'runtime:h2|w', agents: [{ paneKey: 'runtime:h2|p', state: 'done', lastAssistantMessage: 'ok' }] }], 14)
  again.take(host, [], 15)
  assert.deepEqual(Object.keys(again.seen()), ['runtime:h2|p'])
})

test('the poller hands over only fresh rows from a host that answered: never an unavailable host, a failed ps or rows from hosts.json', async () => {
  let clock = 0
  let down = false
  let psFails = false
  const file = tmpFile()
  const handed: { host: string; at: number; n: number }[] = []
  const onRows = (host: { id: string }, worktrees: PsWorktree[], at: number) => handed.push({ host: host.id, at, n: worktrees.length })
  const orca = healthy({ status: () => (down ? new Error('unreachable') : status()), 'worktree ps': () => (psFails ? new Error('ps failed') : ps()) })
  const p = createHostPoller({ run: orca.run, file, now: () => clock, onRows })
  p.tick()
  await p.idle()
  assert.deepEqual(handed, [{ host: 'runtime:env-caca', at: 0, n: 1 }])
  assert.equal(handed.length, 1)
  psFails = true
  clock = PROBE_EVERY_MS
  p.tick()
  await p.idle()
  psFails = false
  down = true
  clock = 2 * PROBE_EVERY_MS
  p.tick()
  await p.idle()
  assert.equal(handed.length, 1, 'neither a failed ps nor an unavailable host')
  p.stop()
  // Restarted: the last rows show from the file, stale, and are not handed over.
  const q = createHostPoller({ run: fakeOrca({}).run, file, now: () => clock, onRows })
  assert.ok(q.view())
  assert.equal(handed.length, 1)
})
