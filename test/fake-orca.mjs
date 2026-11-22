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

