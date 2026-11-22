// Shared by test/dispatch.test.mjs and test/plan.test.mjs: a fake machine for orca-flow's route,
// dispatch and plan commands. Not a test file itself.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CLAUDE_ONLY = { agents: ['claude'], models: { claude: null } }

/** A fake machine: `calls` records every Orca command with its stdin. */
export function fakeDeps({ routing, avail = CLAUDE_ONLY, verdict = 'ok', stdin = '', orca } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-flow-dispatch-'))
  if (routing) writeFileSync(join(dir, 'config.json'), JSON.stringify({ routing }))
  const calls = []
  const capacityCalls = []
  const output = []
  let n = 0
  const deps = {
    dir,
    cwd: dir,
    orcaBin: 'orca',
    calls,
    capacityCalls,
    output,
    avail,
    verdict,
    orca: async (args, opts = {}) => {
      calls.push({ args, input: opts.input })
      if (orca) {
        const r = await orca(args, opts)
        if (r !== undefined) return r
      }
      if (args[1] === 'worker-start') {
        n++
        const task = args[args.indexOf('--task') + 1]
        return { dispatchId: `ctx_${n}`, taskId: args.includes('--task') ? task : `task_new${n}`, runId: 'run_1', workspace: 'repo1::/work/tree', state: 'ready' }
      }
      throw new Error(`unexpected orca ${args.join(' ')}`)
    },
    discover: async () => deps.avail,
    capacity: async (a) => {
      capacityCalls.push(a)
      return { verdict: deps.verdict, freeGB: deps.verdict === 'ok' ? 9 : 0.3, reclaimable: { idleEnvironments: [{ worktree: 'mono/old', process: 'next dev', gb: 3.1 }], finishedSessions: [] } }
    },
    readStdin: () => stdin,
    out: (s) => output.push(s),
    now: () => new Date('2026-11-22T10:00:00Z')
  }
  return deps
}

