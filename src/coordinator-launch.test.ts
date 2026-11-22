// A new coordinator starts with Settings → Models' coordinator model; at defaults it starts exactly as before.
import { assert, test } from 'orca/testing'
import { coordinatorLaunchArgs, coordinatorLaunchPlan, startCoordinator, type CoordinatorLaunchIo } from './coordinator-launch.ts'
import { resumeExact, type ResumeIo } from './coordinator-sessions.ts'
import { DEFAULT_ROUTING, type Availability, type RoutingSettings } from './routing.ts'

const avail: Availability = { agents: ['claude', 'codex'], models: { claude: null, codex: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'medium'] }] } }
const withCoordinator = (coordinator: RoutingSettings['coordinator']): RoutingSettings => ({ ...structuredClone(DEFAULT_ROUTING), coordinator })
const input = { workspaceId: 'ws-1', agent: 'claude', dir: '/Users/me/orca/coordinators/shop', prompt: 'Read the skill.' }

function fakeIo(receipt: unknown = { outcome: { kind: 'terminal', handle: 'term_abc' }, prompt: { outcome: 'handed-to-terminal' } }) {
  const calls: { host: unknown[]; run: string[][]; log: string[] } = { host: [], run: [], log: [] }
  const io: CoordinatorLaunchIo = {
    host: async (x) => { calls.host.push(x); return { terminalId: 'pty-host' } },
    run: async (args) => { calls.run.push(args); return receipt },
    terminals: async () => [{ handle: 'term_abc', ptyId: 'pty-9' }],
    log: (line) => calls.log.push(line)
  }
  return { io, calls }
}

test('at defaults a coordinator starts through the host agent.launch, unchanged, and no CLI runs', async () => {
  const plan = coordinatorLaunchPlan(structuredClone(DEFAULT_ROUTING), 'claude', avail)
  assert.deepEqual(plan, { kind: 'host' })
  const { io, calls } = fakeIo()
  assert.deepEqual(await startCoordinator(plan, input, io), { terminalId: 'pty-host' })
  assert.deepEqual(calls.host, [{ workspaceId: 'ws-1', agent: 'claude', prompt: 'Read the skill.' }])
  assert.deepEqual(calls.run, [])
  assert.deepEqual(calls.log, [])
  // An agent default with no model also keeps the host path: nothing would differ.
  assert.deepEqual(coordinatorLaunchPlan(withCoordinator({ agent: 'claude' }), 'claude', avail), { kind: 'host' })
})

test('a coordinator model set in Settings launches with --model and --effort as a terminal, mapped to its host id', async () => {
  const plan = coordinatorLaunchPlan(withCoordinator({ agent: 'claude', model: 'opus', effort: 'high' }), 'claude', avail)
  assert.equal(plan.kind, 'cli')
  const { io, calls } = fakeIo()
  assert.deepEqual(await startCoordinator(plan, input, io), { terminalId: 'pty-9' })
  assert.deepEqual(calls.run, [['agent', 'launch', '--agent', 'claude', '--model', 'opus', '--effort', 'high', '--surface', 'terminal', '--worktree', 'path:/Users/me/orca/coordinators/shop', '--prompt', 'Read the skill.']])
  assert.deepEqual(calls.host, [])
  // Codex: the effort is clamped to what the catalog says the model takes.
  const codex = coordinatorLaunchPlan(withCoordinator({ agent: 'codex', model: 'gpt-6-luna', effort: 'xhigh' }), 'codex', avail)
  assert.ok(codex.kind === 'cli' && codex.choice.effort === 'medium')
  assert.deepEqual(coordinatorLaunchArgs({ agent: 'codex', model: 'gpt-6-luna' }, '/d', 'p'), ['agent', 'launch', '--agent', 'codex', '--model', 'gpt-6-luna', '--surface', 'terminal', '--worktree', 'path:/d', '--prompt', 'p'])
})

test('a pick for another provider, or one this machine cannot run, starts with the provider default the host way', async () => {
  assert.deepEqual(coordinatorLaunchPlan(withCoordinator({ agent: 'codex', model: 'gpt-6-luna' }), 'claude', avail), { kind: 'host' })
  const gone = coordinatorLaunchPlan(withCoordinator({ agent: 'codex', model: 'gpt-retired' }), 'codex', avail)
  assert.equal(gone.kind, 'host')
  assert.ok(gone.kind === 'host' && /unavailable/.test(gone.note ?? ''))
  const { io, calls } = fakeIo()
  await startCoordinator(gone, { ...input, agent: 'codex' }, io)
  assert.deepEqual(calls.host, [{ workspaceId: 'ws-1', agent: 'codex', prompt: 'Read the skill.' }])
  assert.equal(calls.log.length, 1)
  assert.equal(coordinatorLaunchPlan(withCoordinator({ agent: 'antigravity', model: 'x' }), 'antigravity', avail).kind, 'host')
})

test('a lost CLI reply is replayed once with its operation id; a receipt without a terminal fails closed', async () => {
  const plan = coordinatorLaunchPlan(withCoordinator({ agent: 'claude', model: 'sonnet' }), 'claude', avail)
  const runs: string[][] = []
  const io: CoordinatorLaunchIo = {
    host: async () => { throw new Error('host must not run') },
    run: async (args) => {
      runs.push(args)
      if (runs.length === 1) throw Object.assign(new Error('reply lost'), { data: { operationId: 'op-7' } })
      return { outcome: { kind: 'terminal', handle: 'term_x' }, prompt: { outcome: 'journaled' } }
    },
    terminals: async () => []
  }
  assert.deepEqual(await startCoordinator(plan, input, io), { terminalId: 'term_x' })
  assert.deepEqual(runs[1].slice(-2), ['--retry-launch', 'op-7'])
  const { io: chat } = fakeIo({ outcome: { kind: 'structured', handle: 'orca_session_id:1' } })
  await assert.rejects(startCoordinator(plan, input, chat), /terminal/)
})

test('resume never passes a model, whatever Settings sets for coordinators', async () => {
  const seen: unknown[] = []
  const io: ResumeIo = {
    resume: async (x) => { seen.push(x); return { terminalId: 'pty-r' } },
    binding: async () => ({ status: 'bound', workspaceId: 'ws-1', terminal: { handle: 'term_r' }, agent: { paneKey: 'tab:1', agentType: 'claude', terminal: 'term_r', orcaSession: 'o-1' } as never, resumeSessionId: 's-1' } as never)
  }
  await resumeExact({ workspaceId: 'ws-1', agent: 'claude', sessionId: 's-1', member: 'm-1' }, io)
  assert.deepEqual(seen, [{ workspaceId: 'ws-1', agent: 'claude', sessionId: 's-1' }])
})
