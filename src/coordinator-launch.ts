// How a new coordinator conversation starts, with the model Settings → Models sets for coordinators.
// With no coordinator model set (the default) it starts exactly as before: the host's agent.launch,
// which takes no model. With one set, `orca agent launch --model` starts it, since the host call
// cannot pass a model. Only new launches: a resumed or woken member keeps its own model (agent.resume
// takes none, and nothing here is called for it).
import { launchedTerminal, type TerminalRecord } from './coordinator-sessions.ts'
import { launchArgs, route, type Availability, type ModelChoice, type RoutingSettings } from './routing.ts'

export type CoordinatorLaunchPlan =
  /** The host's agent.launch, exactly as before routing existed. `note`: why a set pick was not used. */
  | { kind: 'host'; note?: string }
  /** `orca agent launch` with this choice (it has a model). */
  | { kind: 'cli'; choice: ModelChoice; reason: string }

/**
 * Which way a new coordinator of `agent` starts. Only a Settings pick for coordinators with a model
 * (source `role`) goes through the CLI; the provider default, a pick for another provider, and an
 * unavailable pick all start the host's way (the last with a note saying why).
 */
export function coordinatorLaunchPlan(routing: RoutingSettings, agent: string, avail: Availability | null): CoordinatorLaunchPlan {
  if (!routing.coordinator?.model || agent === 'antigravity') return { kind: 'host' }
  const pick = routing.coordinator
  // A pick for another provider is not launched: the provider stays, on its default model, and says so.
  if (pick.agent !== agent) {
    const name = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)
    return { kind: 'host', note: `Coordinator pick is ${name(pick.agent)}; launched ${name(agent)} with its default model` }
  }
  const a = avail ?? { agents: null, models: {} }
  const d = route(routing, { role: 'coordinator', agent }, a)
  if (!d.ok) return { kind: 'host', note: d.error }
  if (d.source !== 'role' || !d.choice.model) return d.source === 'default' ? { kind: 'host', note: d.reason } : { kind: 'host' }
  return { kind: 'cli', choice: d.choice, reason: d.reason }
}

/** The `orca agent launch` arguments: always a terminal, as the host's agent.launch starts one. */
export function coordinatorLaunchArgs(choice: ModelChoice, dir: string, prompt: string, retry?: string): string[] {
  return ['agent', 'launch', ...launchArgs(choice), '--surface', 'terminal', '--worktree', `path:${dir}`, '--prompt', prompt, ...(retry ? ['--retry-launch', retry] : [])]
}

export type CoordinatorLaunchIo = {
  /** orca.host.call('agent.launch', ...). */
  host: (input: { workspaceId: string; agent: string; prompt: string }) => Promise<{ terminalId: string }>
  /** The orca CLI (orcaRunner): resolves the `result` of its JSON reply, rejects with its error. */
  run: (args: string[], options?: { timeoutMs?: number; cwd?: string }) => Promise<any>
  terminals: () => Promise<TerminalRecord[]>
  log?: (line: string) => void
  /** Appends one line to ~/.orca-flow/routes.jsonl (the shape `orca-flow dispatch` writes). */
  record?: (entry: Record<string, unknown>) => void
  now?: () => Date
}

/** The routes.jsonl line for a coordinator launch, in dispatch.mjs's shape with role 'coordinator'. */
function routeEntry(io: CoordinatorLaunchIo, input: { agent: string; dir: string }, choice: ModelChoice, source: string, reason: string): Record<string, unknown> {
  return {
    at: (io.now?.() ?? new Date()).toISOString(), role: 'coordinator', taskId: null, dispatchId: null, workspace: input.dir,
    choice, source, reason, type: null, kind: null, class: null, risk: null, context: null, explicit: null, attempt: 0
  }
}
function record(io: CoordinatorLaunchIo, entry: Record<string, unknown>): void {
  try { io.record?.(entry) } catch (e) { io.log?.(`coordinator route not recorded: ${(e as Error).message}`) }
}

/**
 * Starts one coordinator conversation and returns its terminal id, as agent.launch does. The CLI's
 * receipt names a terminal handle; it is mapped to the host terminal id (ptyId) when Orca lists it,
 * so terminal.focus, launchedTerminal and awaitLaunched see the same terminal either way. A reply
 * lost after Orca started it is replayed once with its operation id, never launched again fresh.
 */
export async function startCoordinator(plan: CoordinatorLaunchPlan, input: { workspaceId: string; agent: string; dir: string; prompt: string }, io: CoordinatorLaunchIo): Promise<{ terminalId: string }> {
  if (plan.kind === 'host') {
    if (plan.note) io.log?.(`coordinator model not used: ${plan.note}`)
    const started = await io.host({ workspaceId: input.workspaceId, agent: input.agent, prompt: input.prompt })
    record(io, routeEntry(io, input, { agent: input.agent }, 'default', plan.note ?? `Coordinator launched ${input.agent.charAt(0).toUpperCase() + input.agent.slice(1)} with its default model`))
    return started
  }
  const opts = { timeoutMs: 90_000, cwd: input.dir }
  let receipt: any
  try {
    receipt = await io.run(coordinatorLaunchArgs(plan.choice, input.dir, input.prompt), opts)
  } catch (e) {
    const data = (e as { data?: { operationId?: unknown; effectsApplied?: unknown } }).data
    if (typeof data?.operationId !== 'string' || data.effectsApplied === false) throw e
    receipt = await io.run(coordinatorLaunchArgs(plan.choice, input.dir, input.prompt, data.operationId), opts)
  }
  const out = receipt?.outcome
  if (out?.kind !== 'terminal' || typeof out.handle !== 'string') throw new Error('Orca did not return the new coordinator’s terminal. Inspect the folder before starting another conversation.')
  if (!['journaled', 'handed-to-terminal'].includes(receipt?.prompt?.outcome)) io.log?.(`coordinator launch: Orca did not confirm the prompt (${receipt?.prompt?.outcome ?? 'no prompt outcome'})`)
  const t = await io.terminals().then((ts) => launchedTerminal(ts, out.handle)).catch(() => null)
  record(io, routeEntry(io, input, plan.choice, 'role', plan.reason))
  return { terminalId: t?.ptyId ?? out.handle }
}
