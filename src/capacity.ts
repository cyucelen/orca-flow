// The capacity decision, shared by the plugin worker and `orca-flow capacity` so they never
// disagree. What slows the machine is memory, not how many worktrees or agents exist, so capacity
// is one budget: the memory Orca reports as available, minus a safety margin. A start fits when its
// cost does. Costs are measured on this machine: a typical agent session, and per project the
// processes its worktrees started (dev servers). Critical memory pressure overrides the numbers;
// under "warn" a new worktree still starts when it fits with extra headroom.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Pressure = 'normal' | 'warn' | 'critical' | 'unknown'
/** ok: a new worktree with its environment fits. agents-only: another agent fits, an environment does not. */
export type Verdict = 'ok' | 'agents-only' | 'full' | 'pressure'
/**
 * marginGB is kept free always. While macOS reports "warn" pressure, a new worktree also keeps
 * headroom free on top of its cost: the larger of warnHeadroomGB and half its environment, since
 * available memory shrinks fast under compression and a big environment's estimate errs by more.
 */
export type CapacityConfig = { marginGB: number; warnHeadroomGB: number }

export const DEFAULT_CONFIG: CapacityConfig = { marginGB: 2, warnHeadroomGB: 2 }
/** Used until there is something to measure; envGB prices a project never seen at work here. */
export const FALLBACK = { agentGB: 0.5, envGB: 1.5 }

const round = (n: number) => Math.round(n * 10) / 10
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/**
 * Pure: what starting things costs here. An agent: the median of open agent sessions (a terminal
 * with no agent in it is a few MB and does not count). A project's environment: the median of what
 * its worktrees' agents started outside their sessions. A project whose dev servers are all stopped
 * keeps the cost remembered from an earlier scan. A project seen at work that started nothing, and
 * has never been seen running anything, costs 0: that is a measurement, not a guess.
 */
export function costsOf(
  agentSessionsGB: number[],
  startedByWorktree: { repo: string; gb: number }[],
  remembered: Record<string, number> = {}
): { agentGB: number; envGB: Record<string, number> } {
  const byRepo = new Map<string, number[]>()
  for (const w of startedByWorktree) byRepo.set(w.repo, [...(byRepo.get(w.repo) ?? []), w.gb])
  const envGB: Record<string, number> = { ...remembered }
  for (const [repo, gbs] of byRepo) {
    const running = gbs.filter((g) => g > 0)
    if (running.length) envGB[repo] = round(median(running)!)
    else envGB[repo] ??= 0
  }
  return { agentGB: round(median(agentSessionsGB.filter((g) => g >= 0.1)) ?? FALLBACK.agentGB), envGB }
}

/**
 * Pure: one sample per checkout where agents work, with what it started (0 for nothing). `started`
 * may hold several entries per path (one per pane); they add up.
 */
export function envSamples(started: { path: string; repo: string; gb: number }[], checkouts: { path: string; repo: string }[]): { repo: string; gb: number }[] {
  const byPath = new Map<string, { repo: string; gb: number }>()
  for (const c of checkouts) byPath.set(c.path, { repo: c.repo, gb: 0 })
  for (const s of started) {
    const w = byPath.get(s.path) ?? { repo: s.repo, gb: 0 }
    w.gb += s.gb
    byPath.set(s.path, w)
  }
  return [...byPath.values()]
}

/** Pure: the typical environment, for "can a new workstream start?" with no project named: the median of those that run one. */
export function typicalEnv(envGB: Record<string, number>): number {
  const running = Object.values(envGB).filter((g) => g > 0).sort((a, b) => a - b)
  return running.length ? running[Math.floor((running.length - 1) / 2)] : FALLBACK.envGB
}

/** ~/.orca-flow/env-costs.json: each project's last measured environment, kept while its dev servers are stopped. */
export function readEnvMemory(dir: string): Record<string, number> {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'env-costs.json'), 'utf8'))
    return Object.fromEntries(Object.entries(m ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] >= 0))
  } catch {
    return {}
  }
}

export function writeEnvMemory(dir: string, envGB: Record<string, number>): void {
  try {
    writeFileSync(join(dir, 'env-costs.json'), JSON.stringify(envGB, null, 2) + '\n')
  } catch {}
}

/** Pure: free disk in GB from `df -k -P <dir>` (the Available column of its one data line). */
export function diskFreeOf(df: string): number | null {
  const fields = df.trim().split('\n')[1]?.trim().split(/\s+/)
  const kb = Number(fields?.[3])
  return Number.isFinite(kb) ? round(kb / 1024 ** 2) : null
}

/** A project's environment cost; a project never seen at work here costs the fallback, to be safe. */
export const envCost = (envGB: Record<string, number>, repo?: string) => (repo && envGB[repo] !== undefined ? envGB[repo] : FALLBACK.envGB)

export function decide({ availableGB, pressure, config, agentGB, envGB }: {
  availableGB: number | null
  pressure: Pressure
  config: CapacityConfig
  agentGB: number
  /** The environment the start would bring, or the typical one when asking in general. */
  envGB: number
}): { verdict: Verdict; freeGB: number | null } {
  const freeGB = availableGB === null ? null : round(availableGB - config.marginGB)
  if (pressure === 'critical') return { verdict: 'pressure', freeGB }
  if (freeGB === null) return { verdict: pressure === 'warn' ? 'agents-only' : 'ok', freeGB }
  if (freeGB < agentGB) return { verdict: 'full', freeGB }
  // Under "warn", a cheap environment still fits (orca-flow, none: 0.5 + 0 + 2 = 2.5 GB); a heavy
  // one waits for room (mono, 6.6 GB: 0.5 + 6.6 + 3.3 = 10.4 GB).
  const headroomGB = pressure === 'warn' ? Math.max(config.warnHeadroomGB ?? DEFAULT_CONFIG.warnHeadroomGB, envGB / 2) : 0
  if (freeGB < agentGB + envGB + headroomGB) return { verdict: 'agents-only', freeGB }
  return { verdict: 'ok', freeGB }
}
