// Shared by test/dispatch.test.mjs and test/plan.test.mjs: a fake machine for orca-flow's route,
// dispatch and plan commands. Not a test file itself.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CLAUDE_ONLY = { agents: ['claude'], models: { claude: null } }

/**
 * A fake machine: `calls` records every Orca command with its stdin. `repos` answers `repo show`
 * ({ 'id:r1': 'mono' }); `freeGB` and `agentGB` shape the capacity answer. `dispatches`
 * ({ ctx_u: 'dispatched' }) answers `worker-show --full` and `tasks` ({ task_u: 'completed' })
 * `task-list`; both can change during a test (deps.dispatches, deps.tasks).
 */
export function fakeDeps({ routing, avail = CLAUDE_ONLY, verdict = 'ok', stdin = '', orca, repos = {}, freeGB, agentGB = 0.5, dispatches = {}, tasks = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-flow-dispatch-'))
  if (routing) writeFileSync(join(dir, 'config.json'), JSON.stringify({ routing }))
  const calls = []
  const capacityCalls = []
  const output = []
  let n = 0
  let discoveries = 0
  const deps = {
    dir,
    cwd: dir,
    orcaBin: 'orca',
    calls,
    capacityCalls,
    output,
    avail,
    verdict,
    dispatches,
    tasks,
    orca: async (args, opts = {}) => {
      calls.push({ args, input: opts.input })
      if (orca) {
        const r = await orca(args, opts)
        if (r !== undefined) return r
      }
      if (args[0] === 'repo' && args[1] === 'show') {
        const sel = args[args.indexOf('--repo') + 1]
        if (!repos[sel]) throw new Error(`no repo ${sel}`)
        return { repo: { id: sel.slice(3), displayName: repos[sel] } }
      }
      if (args[1] === 'worker-show') {
        const id = args[args.indexOf('--dispatch') + 1]
        const status = deps.dispatches[id]
        if (!status) throw new Error(`no dispatch ${id}`)
        return { dispatch: { id, taskId: `task_of_${id}`, status, completedAt: ['completed', 'failed'].includes(status) ? '2026-11-22 10:30:00' : null }, worker: { dispatchId: id, worktreeId: 'repo1::/work/tree' } }
      }
      if (args[1] === 'task-list') return { tasks: Object.entries(deps.tasks).map(([id, status]) => ({ id, status, title: id })) }
      if (args[1] === 'worker-start') {
        n++
        const task = args[args.indexOf('--task') + 1]
        return { dispatchId: `ctx_${n}`, taskId: args.includes('--task') ? task : `task_new${n}`, runId: 'run_1', workspace: 'repo1::/work/tree', state: 'ready' }
      }
      throw new Error(`unexpected orca ${args.join(' ')}`)
    },
    discover: async () => {
      discoveries++
      deps.discoveries = discoveries
      return deps.avail
    },
    discoveries,
    capacity: async (a) => {
      capacityCalls.push(a)
      return { verdict: deps.verdict, freeGB: freeGB ?? (deps.verdict === 'ok' ? 9 : 0.3), costs: { agentGB }, reclaimable: { idleEnvironments: [{ worktree: 'mono/old', process: 'next dev', gb: 3.1 }], finishedSessions: [] } }
    },
    readStdin: () => stdin,
    out: (s) => output.push(s),
    now: () => new Date('2026-11-22T10:00:00Z')
  }
  return deps
}

const GiB = 1024 ** 3
const CAPS = ['runtime.status.compat.v1', 'orchestration.federation.v1']

/**
 * A fake paired host for `fakeDeps({ orca: pairedOrca(...) })`: answers `environment list` and every
 * read with `--environment <id>` (status, agent installed, diagnostics memory, worktree ps/show,
 * repo show), plus this machine's own reads for `orca-flow hosts`; anything else falls through to
 * fakeDeps (worker-start). `hosts` lists the paired hosts ([] for none); per environment id,
 * `fail` ({ status: 'x' }) makes a read throw that message, `unreachable` lists hosts whose status
 * says not reachable. Endpoints are in the list, as Orca returns them, so tests can check they are
 * never copied out.
 */
export function pairedOrca({
  hosts = [{ id: 'env-caca', name: 'caca' }],
  version = '1.4.232',
  capabilities = CAPS,
  agents = ['claude', 'codex'],
  availableGB = 12,
  totalGB = 16,
  sessionsGB = [0.6, 0.4],
  repos = { 'name:mono': 'mono', 'id:r-mono': 'mono' },
  worktrees = ['name:feature', 'branch:feature'],
  fail = {},
  unreachable = [],
  listFails = null,
  local = { version: '1.4.263', availableGB: 30, totalGB: 64, agents: ['claude', 'codex'], worktrees: 3 }
} = {}) {
  const panes = sessionsGB.map((_, i) => `pane-${i}`)
  return async (args) => {
    if (args[0] === 'environment' && args[1] === 'list') {
      if (listFails) throw new Error(listFails)
      return { environments: hosts.map((h) => ({ id: h.id, name: h.name, runtimeId: `rt-${h.id}`, endpoints: [{ id: 'e1', url: 'ws://10.0.0.9:7777' }], pairedDeviceId: 'device-secret' })) }
    }
    const at = args.indexOf('--environment')
    const what = `${args[0]} ${args[1]}`
    if (at === -1) {
      // This machine's own reads (orca-flow hosts).
      if (what.startsWith('status')) return { runtime: { reachable: true, connectionState: 'connected', appVersion: local.version, capabilities: [...CAPS, 'orchestration.peer-mail.v1'] } }
      if (what === 'worktree ps') return { worktrees: Array.from({ length: local.worktrees }, (_, i) => ({ worktreeId: `r::/l/${i}`, hostId: 'local', agents: [] })) }
      if (what === 'agent installed') return { agents: local.agents.map((id) => ({ id, name: id, default: false })) }
      if (what === 'diagnostics memory') return { host: { totalMemory: local.totalGB * GiB, availableMemory: local.availableGB * GiB }, worktrees: [] }
      return undefined
    }
    const env = args[at + 1]
    if (!hosts.some((h) => h.id === env)) throw new Error(`Unknown environment: ${env}`)
    const key = { status: 'status', 'agent installed': 'agents', 'diagnostics memory': 'memory', 'worktree ps': 'worktrees', 'worktree show': 'worktree', 'repo show': 'repo' }[args[0] === 'status' ? 'status' : what]
    const f = fail[env]?.[key]
    if (f) throw Object.assign(new Error(f), f.endsWith('_not_found') ? { code: f } : {})
    if (args[0] === 'status') return { runtime: { reachable: !unreachable.includes(env), connectionState: unreachable.includes(env) ? 'disconnected' : 'connected', appVersion: version, capabilities } }
    if (what === 'agent installed') return { agents: agents.map((id) => ({ id, name: id, default: id === 'claude' })) }
    if (what === 'diagnostics memory') return { host: { totalMemory: totalGB * GiB, availableMemory: availableGB * GiB }, worktrees: [{ worktreeId: 'x', sessions: [...sessionsGB.map((gb, i) => ({ paneKey: panes[i], memory: gb * GiB })), { paneKey: 'shell', memory: 3 * GiB }] }], collectedAt: 1 }
    if (what === 'worktree ps') return { worktrees: [{ worktreeId: 'r::/home/x', hostId: 'local', agents: panes.map((paneKey) => ({ paneKey })) }, { worktreeId: 'r::/home/y', hostId: 'local', agents: [] }] }
    if (what === 'worktree show') {
      const sel = args[args.indexOf('--worktree') + 1]
      if (!worktrees.includes(sel)) throw Object.assign(new Error('selector_not_found'), { code: 'selector_not_found' })
      return { worktree: { id: `r::/home/${sel}`, displayName: sel } }
    }
    if (what === 'repo show') {
      const sel = args[args.indexOf('--repo') + 1]
      if (!repos[sel]) throw Object.assign(new Error('repo_not_found'), { code: 'repo_not_found' })
      return { repo: { id: sel, displayName: repos[sel] } }
    }
    throw new Error(`unexpected orca ${args.join(' ')}`)
  }
}
