// node --test test/*.test.mjs
// The paired-hosts contract (skills/orca-flow/scripts/hosts.mjs) and the CLI side that reads it:
// `orca-flow hosts` and `orca-flow capacity --on <host>`. Fakes only: no real Orca, no real host.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeDeps, pairedOrca } from './fake-orca.mjs'
import { findHost, hostIdOf, hostKey, LOCAL_HOST, pairedHosts, probeHost, relabelWorktrees, REMOTE_WORKER_CAPABILITY, safeReason, statusOf } from '../skills/orca-flow/scripts/hosts.mjs'
import { capacityOnCommand, hostCapacity, hostsCommand, Refused } from '../skills/orca-flow/scripts/dispatch.mjs'

const GiB = 1024 ** 3

test('pairedHosts keeps id, name and runtime id, drops endpoints and pairing data, and skips rows with no id', () => {
  const listed = { environments: [
    { id: 'e1', name: 'caca', runtimeId: 'rt1', endpoints: [{ url: 'ws://10.0.0.9:7777' }], preferredEndpointId: 'p', pairedDeviceId: 'dev', pairingRevision: 3 },
    { id: 'e2', name: '', runtimeId: 7 },
    { name: 'no id' },
    null
  ] }
  assert.deepEqual(pairedHosts(listed), [
    { id: 'runtime:e1', environmentId: 'e1', name: 'caca', runtimeId: 'rt1' },
    { id: 'runtime:e2', environmentId: 'e2', name: 'e2', runtimeId: null }
  ])
  assert.doesNotMatch(JSON.stringify(pairedHosts(listed)), /ws:|dev|endpoint/i)
  assert.deepEqual(pairedHosts(null), [])
  assert.deepEqual(pairedHosts({ environments: 'x' }), [])
  assert.equal(hostIdOf('e1'), 'runtime:e1')
})

test('statusOf: reachable only when Orca says so and the connection is connected; missing fields read as unknown', () => {
  const up = statusOf({ runtime: { reachable: true, connectionState: 'connected', appVersion: '1.4.232', runtimeId: 'rt', capabilities: [REMOTE_WORKER_CAPABILITY, 3] } })
  assert.deepEqual(up, { reachable: true, connectionState: 'connected', version: '1.4.232', runtimeId: 'rt', capabilities: [REMOTE_WORKER_CAPABILITY] })
  assert.equal(statusOf({ runtime: { reachable: true } }).reachable, true, 'no connection state: reachable is enough')
  assert.equal(statusOf({ runtime: { reachable: true, connectionState: 'reconnecting' } }).reachable, false)
  assert.equal(statusOf({ runtime: { reachable: false, connectionState: 'connected' } }).reachable, false)
  assert.deepEqual(statusOf({}), { reachable: false, connectionState: null, version: null, runtimeId: null, capabilities: [] })
  assert.deepEqual(statusOf(undefined).capabilities, [])
})

test('relabelWorktrees keys the same repo, path and pane on two hosts apart; local ids stay as they are', () => {
  const row = () => ({ worktreeId: 'r::/home/x', parentWorktreeId: 'r::/home/p', hostId: 'local', identity: { key: 'k1' }, repo: 'mono', branch: 'main', agents: [{ paneKey: 'pane', parentPaneKey: 'parent' }] })
  const a = relabelWorktrees([row()], { id: 'runtime:a', name: 'caca' })[0]
  const b = relabelWorktrees([row()], { id: 'runtime:b', name: 'caca' })[0]
  assert.equal(a.hostId, 'runtime:a')
  assert.equal(a.hostName, 'caca')
  assert.equal(a.worktreeId, 'runtime:a|r::/home/x')
  assert.equal(a.parentWorktreeId, 'runtime:a|r::/home/p')
  assert.equal(a.identity.key, 'runtime:a|k1')
  assert.deepEqual(a.agents[0], { paneKey: 'runtime:a|pane', parentPaneKey: 'runtime:a|parent' })
  for (const k of ['worktreeId', 'parentWorktreeId']) assert.notEqual(a[k], b[k], `${k}: same name, two hosts, two keys`)
  assert.notEqual(a.agents[0].paneKey, b.agents[0].paneKey)
  assert.equal(a.repo, 'mono', 'nothing else changes')
  assert.equal(relabelWorktrees([{ worktreeId: 'w', parentWorktreeId: null, agents: [] }], { id: 'runtime:a', name: 'c' })[0].parentWorktreeId, null)
  assert.deepEqual(relabelWorktrees(undefined, { id: 'runtime:a', name: 'c' }), [])
  assert.equal(hostKey(LOCAL_HOST, 'w'), 'w', 'local keys unchanged')
})

test('safeReason hides pairing codes, endpoints and tokens, and keeps one short line', () => {
  assert.equal(safeReason(new Error('pair with orca://pair?code=XYZ&host=1 now')), 'pair with <pairing code> now')
  assert.equal(safeReason(new Error('connect ws://10.0.0.9:7777/rpc failed')), 'connect <endpoint> failed')
  assert.equal(safeReason(new Error('wss://h.example/x and https://h/y')), '<endpoint> and <endpoint>')
  assert.equal(safeReason('bad token=abc123 secret=s'), 'bad token=<hidden> secret=<hidden>')
  assert.equal(safeReason(new Error('first\nsecond')), 'first')
  assert.equal(safeReason(new Error('x'.repeat(300))).length, 160)
  assert.equal(safeReason(undefined), 'unknown error')
})

test('probeHost: by environment id; status first and nothing else when unreachable; a failed read leaves only its field null', async () => {
  const host = pairedHosts({ environments: [{ id: 'env-caca', name: 'caca' }] })[0]
  const calls = []
  const paired = pairedOrca({ fail: { 'env-caca': { agents: 'agents timed out ws://10.0.0.9:1' } } })
  const run = async (args) => {
    calls.push(args)
    return paired(args)
  }
  const p = await probeHost(host, run, { want: { worktrees: true, agents: true, memory: true }, now: () => 42 })
  assert.equal(p.at, 42)
  assert.equal(p.reachable, true)
  assert.equal(p.status.version, '1.4.232')
  assert.equal(p.agents, null)
  assert.deepEqual(p.errors, { agents: 'agents timed out <endpoint>' })
  assert.deepEqual(p.memory, { totalGB: 16, availableGB: 12, at: 1 })
  assert.equal(p.worktrees[0].worktreeId, 'runtime:env-caca|r::/home/x', 'worktrees come back re-keyed')
  assert.ok(calls.every((a) => a.at(-2) === '--environment' && a.at(-1) === 'env-caca'), 'every read by environment id, never by name')
  // Reads not asked for are not made.
  calls.length = 0
  await probeHost(host, run)
  assert.deepEqual(calls.map((a) => a[0]), ['status'])
  // Unreachable: status only.
  const down = []
  const r = await probeHost(host, async (args) => (down.push(args), pairedOrca({ unreachable: ['env-caca'] })(args)), { want: { worktrees: true, agents: true, memory: true } })
  assert.equal(r.reachable, false)
  assert.deepEqual(down.map((a) => a[0]), ['status'])
  assert.deepEqual([r.worktrees, r.agents, r.memory], [null, null, null])
  // Status throws: unreachable, with the reason.
  const t = await probeHost(host, async () => { throw new Error('remote_runtime_unavailable') })
  assert.equal(t.reachable, false)
  assert.equal(t.errors.status, 'remote_runtime_unavailable')
})

test('findHost matches a name in any case, an environment id or a host id; none or several is null', () => {
  const hosts = pairedHosts({ environments: [{ id: 'e1', name: 'caca' }, { id: 'e2', name: 'big' }, { id: 'e3', name: 'BIG' }] })
  assert.equal(findHost(hosts, 'CACA').environmentId, 'e1')
  assert.equal(findHost(hosts, 'e2').environmentId, 'e2')
  assert.equal(findHost(hosts, 'runtime:e3').environmentId, 'e3')
  assert.equal(findHost(hosts, 'big'), null, 'two hosts share the name')
  assert.equal(findHost(hosts, 'nope'), null)
  assert.equal(findHost(hosts, ''), null)
})

test('hostCapacity uses the capacity formula on that host: its agent sessions, the fallback for a project never seen there, the margin', () => {
  const deps = fakeDeps()
  // This machine measured mono at 6.6 GB: that is this machine's checkout, not caca's.
  writeFileSync(join(deps.dir, 'env-costs.json'), JSON.stringify({ mono: 6.6, samples: [{ path: '/Users/me/mono', repo: 'mono', gb: 6.6, at: new Date().toISOString() }] }))
  const host = { id: 'runtime:e1', name: 'caca' }
  const memResult = { host: { totalMemory: 16 * GiB, availableMemory: 4 * GiB }, worktrees: [{ sessions: [{ paneKey: 'a', memory: 0.8 * GiB }, { paneKey: 'b', memory: 0.6 * GiB }, { paneKey: 'shell', memory: 4 * GiB }] }] }
  const worktrees = [{ agents: [{ paneKey: 'runtime:e1|a' }, { paneKey: 'runtime:e1|b' }] }]
  const cap = hostCapacity({ host, memResult, worktrees, repo: 'mono', dir: deps.dir })
  assert.equal(cap.costs.agentGB, 0.7, 'the median of its agent panes, not the shell')
  assert.equal(cap.costs.agentSessions, 2)
  assert.deepEqual(cap.costs.priced, { repo: 'mono', envGB: 1.5, measured: false })
  assert.deepEqual([cap.freeGB, cap.verdict], [2, 'agents-only'], '4 − 2 margin = 2 GB < 0.7 + 1.5')
  assert.equal(hostCapacity({ host, memResult: { ...memResult, host: { totalMemory: 16 * GiB, availableMemory: 6 * GiB } }, worktrees, repo: 'mono', dir: deps.dir }).verdict, 'ok')
  // The worktree read failed: every session counts (the 4 GB shell too).
  assert.equal(hostCapacity({ host, memResult, worktrees: null, dir: deps.dir }).costs.agentGB, 0.8)
  // No agent session there: the fallback agent cost. The margin is the user's.
  writeFileSync(join(deps.dir, 'config.json'), JSON.stringify({ marginGB: 3 }))
  const bare = hostCapacity({ host, memResult: { host: memResult.host }, dir: deps.dir })
  assert.deepEqual([bare.costs.agentGB, bare.costs.agentSessions, bare.marginGB, bare.freeGB, bare.verdict], [0.5, 0, 3, 1, 'agents-only'])
  assert.equal(hostCapacity({ host, memResult: {}, dir: deps.dir }), null, 'no totals: unknown, never guessed')
})

test('capacity --on prints that host\'s verdict; an unknown host or unreadable memory is refused', async () => {
  const deps = fakeDeps({ orca: pairedOrca({ availableGB: 3.5 }) })
  assert.equal(await capacityOnCommand({ _: ['capacity'], on: 'caca', repo: 'name:mono' }, deps), 0)
  assert.equal(deps.output[0], [
    "host: caca (the verdict is caca's; this machine's memory is not part of it)",
    'verdict: agents-only',
    'free: 1.5 GB (after a 2 GB margin; 3.5 of 16 GB available on caca)',
    'costs on caca: an agent ~0.5 GB (median of 2 agent sessions there), a new mono worktree ~2 GB',
    "  mono's environment was never measured on caca: priced at the 1.5 GB fallback"
  ].join('\n'))
  assert.deepEqual(deps.capacityCalls, [], "this machine's scan does not run")
  const json = fakeDeps({ orca: pairedOrca() })
  await capacityOnCommand({ _: ['capacity'], on: 'caca', json: true }, json)
  assert.deepEqual(JSON.parse(json.output[0]).host, { id: 'runtime:env-caca', name: 'caca' })
  assert.equal(JSON.parse(json.output[0]).verdict, 'ok')
  await assert.rejects(capacityOnCommand({ _: ['capacity'], on: 'nope' }, fakeDeps({ orca: pairedOrca() })), (e) => e instanceof Refused && e.code === 3 && e.message === 'no paired host "nope". Paired hosts: caca.')
  await assert.rejects(capacityOnCommand({ _: ['capacity'], on: 'caca' }, fakeDeps({ orca: pairedOrca({ fail: { 'env-caca': { memory: 'timed out' } } }) })), (e) => e.code === 2 && e.message === 'capacity unknown on caca: its memory could not be read (timed out).')
  await assert.rejects(capacityOnCommand({ _: ['capacity'], on: 'caca' }, fakeDeps({ orca: pairedOrca({ unreachable: ['env-caca'] }) })), (e) => e.code === 3 && e.message === 'caca is unavailable: its connection is disconnected.')
  await assert.rejects(capacityOnCommand({ _: ['capacity'], on: 'caca', repo: 'name:web' }, fakeDeps({ orca: pairedOrca() })), (e) => e.code === 3 && /^caca has no project name:web/.test(e.message))
})

test('hosts: this machine and each paired host with state, version, RAM, agents, remote workers, worktrees and version limits', async () => {
  const deps = fakeDeps({ orca: pairedOrca({ hosts: [{ id: 'env-caca', name: 'caca' }, { id: 'env-off', name: 'offbox' }], unreachable: ['env-off'] }) })
  assert.equal(await hostsCommand({ _: ['hosts'] }, deps), 0)
  assert.equal(deps.output[0], [
    'This machine and 2 paired hosts:',
    'this machine: reachable · Orca 1.4.263 · RAM 30 of 64 GB available · 3 worktrees',
    '  agents: claude, codex',
    'caca: reachable · Orca 1.4.232 · RAM 12 of 16 GB available · 2 worktrees · takes remote workers',
    '  agents: claude, codex',
    '  host-version limits: its Orca does not list orchestration.remote-owned-workers.v1, orchestration.peer-mail.v1, orchestration.worker-auto-release.v1, orchestration.worker-keep-open.v1',
    'offbox: unavailable: its connection is disconnected',
    "Start work on a paired host only when the user or your lead chose it: orca-flow dispatch --on <name> ...; `orca-flow capacity --on <name>` gives that host's verdict."
  ].join('\n'))
  // Read-only: nothing but reads, and the unreachable host was asked for its status only.
  const verbs = new Set(deps.calls.map((c) => `${c.args[0]} ${c.args[1]}`))
  for (const v of verbs) assert.match(v, /^(environment list|status|worktree ps|agent installed|diagnostics memory)/)
  assert.deepEqual(deps.calls.filter((c) => c.args.includes('env-off')).map((c) => c.args[0]), ['status'])
  assert.doesNotMatch(deps.output[0], /ws:|device-secret/)

  const json = fakeDeps({ orca: pairedOrca({ fail: { 'env-caca': { memory: 'diagnostics failed' } } }) })
  await hostsCommand({ _: ['hosts'], json: true }, json)
  const [local, caca] = JSON.parse(json.output[0]).hosts
  assert.equal(local.local, true)
  assert.equal(local.takesRemoteWorkers, null)
  assert.deepEqual({ ...caca, lacks: caca.lacks.length }, { id: 'runtime:env-caca', name: 'caca', environmentId: 'env-caca', state: 'reachable', version: '1.4.232', ram: null, agents: ['claude', 'codex'], takesRemoteWorkers: true, lacks: 4, worktrees: 2, errors: { memory: 'diagnostics failed' } })
  const text = fakeDeps({ orca: pairedOrca({ fail: { 'env-caca': { memory: 'diagnostics failed' } }, capabilities: [] }) })
  await hostsCommand({ _: ['hosts'] }, text)
  assert.match(text.output[0], /caca: reachable · Orca 1\.4\.232 · RAM unknown \(diagnostics failed\) · 2 worktrees · does not take remote workers \(no orchestration\.federation\.v1\)/)
})

test('hosts with no paired host (or none readable) is one line, and reads nothing else', async () => {
  const none = fakeDeps({ orca: pairedOrca({ hosts: [] }) })
  await hostsCommand({ _: ['hosts'] }, none)
  assert.deepEqual(none.output, ['No paired hosts: everything runs on this machine. Pair a server in Orca (Settings, or `orca pair`) to see it here.'])
  assert.equal(none.calls.length, 1)
  const failed = fakeDeps({ orca: pairedOrca({ listFails: 'unknown command ws://x' }) })
  await hostsCommand({ _: ['hosts'] }, failed)
  assert.deepEqual(failed.output, ['No paired hosts known: Orca could not list them (unknown command <endpoint>).'])
})

test('hosts probes at most 2 hosts at once', async () => {
  const hosts = ['a', 'b', 'c', 'd'].map((n) => ({ id: `env-${n}`, name: n }))
  const paired = pairedOrca({ hosts })
  let open = 0
  let most = 0
  const deps = fakeDeps({ orca: async (args) => {
    if (args[0] !== 'status') return paired(args)
    open++
    most = Math.max(most, open)
    await new Promise((r) => setTimeout(r, 5))
    open--
    return paired(args)
  } })
  await hostsCommand({ _: ['hosts'] }, deps)
  assert.equal(most, 2)
  assert.match(deps.output[0], /^This machine and 4 paired hosts:/)
})
