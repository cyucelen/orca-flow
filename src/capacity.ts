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

/** A checkout's environment as measured now: what its agents started outside their sessions, in GB. */
export type EnvMeasure = { path: string; repo: string; gb: number }
/** One remembered measurement: the last one taken in that checkout, and when (ISO time). */
export type EnvSample = EnvMeasure & { at: string }
/**
 * ~/.orca-flow/env-costs.json, read: samples per checkout, and legacy per-project prices (the file's
 * old `{ repo: number }` shape, or prices carried over for projects with no samples left).
 */
export type EnvMemory = { samples: EnvSample[]; legacy: Record<string, number> }

/** How much is remembered: the newest `perRepo` measured environments of each project, none older than `maxAgeDays`. */
export const ENV_MEMORY = { perRepo: 10, maxAgeDays: 30 }
const EMPTY: EnvMemory = { samples: [], legacy: {} }

/**
 * Pure: the remembered samples after a scan at time `at`. A checkout running something replaces its
 * own sample, so one checkout counts once however often it is scanned. A checkout at work that
 * started nothing does not erase what it ran before (its dev server is only stopped); it is
 * remembered as 0 only when nothing is known about it, which tells a project that starts nothing
 * (costs 0) from one never seen (costs the fallback). Samples older than `maxAgeDays` go; per
 * project the newest `perRepo` running samples stay, and as many that started nothing.
 */
export function rememberEnv(memory: EnvMemory, measured: EnvMeasure[], at: number, limits = ENV_MEMORY): EnvMemory {
  const byPath = new Map(memory.samples.map((s) => [s.path, s]))
  const when = new Date(at).toISOString()
  for (const m of measured) {
    const gb = Math.round(m.gb * 100) / 100
    if (gb > 0 || !byPath.has(m.path)) byPath.set(m.path, { path: m.path, repo: m.repo, gb, at: when })
  }
  const oldest = at - limits.maxAgeDays * 24 * 60 * 60 * 1000
  const fresh = [...byPath.values()].filter((s) => Date.parse(s.at) >= oldest).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const kept = new Map<string, number>()
  const samples = fresh.filter((s) => {
    const k = `${s.repo}\0${s.gb > 0}`
    kept.set(k, (kept.get(k) ?? 0) + 1)
    return kept.get(k)! <= limits.perRepo
  })
  return { samples, legacy: memory.legacy }
}

/**
 * Pure: each project's environment price. The median of its remembered running environments, so one
 * heavy checkout (an emulator, a debugging session) does not set the price for every new one. A
 * project whose remembered checkouts all started nothing costs 0: a measurement, not a guess. A
 * project with no samples keeps its legacy price; one never seen has none (see envCost).
 */
export function envPrices(memory: EnvMemory): Record<string, number> {
  const byRepo = new Map<string, number[]>()
  for (const s of memory.samples) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s.gb])
  const envGB: Record<string, number> = { ...memory.legacy }
  for (const [repo, gbs] of byRepo) {
    const running = gbs.filter((g) => g > 0)
    envGB[repo] = running.length ? round(median(running)!) : 0
  }
  return envGB
}

/**
 * Pure: what starting things costs here. An agent: the median of open agent sessions (a terminal
 * with no agent in it is a few MB and does not count). A project's environment: see rememberEnv
 * and envPrices; `measured` is this scan (one entry per checkout at work, see envSamples). Returns
 * the updated memory for writeEnvMemory, so the plugin and the CLI keep the same samples.
 */
export function costsOf(
  agentSessionsGB: number[],
  measured: EnvMeasure[],
  memory: EnvMemory = EMPTY,
  at = Date.now()
): { agentGB: number; envGB: Record<string, number>; memory: EnvMemory } {
  const next = rememberEnv(memory, measured, at)
  return { agentGB: round(median(agentSessionsGB.filter((g) => g >= 0.1)) ?? FALLBACK.agentGB), envGB: envPrices(next), memory: next }
}

/**
 * Pure: one sample per checkout where agents work, with what it started (0 for nothing). `started`
 * may hold several entries per path (one per pane); they add up. Price it by what it keeps hot in
 * RAM (footprint minus compressed pages, StartedGroup.hotMB), not by its footprint.
 */
export function envSamples(started: EnvMeasure[], checkouts: { path: string; repo: string }[]): EnvMeasure[] {
  const byPath = new Map<string, EnvMeasure>()
  for (const c of checkouts) byPath.set(c.path, { path: c.path, repo: c.repo, gb: 0 })
  for (const s of started) {
    const w = byPath.get(s.path) ?? { path: s.path, repo: s.repo, gb: 0 }
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

/**
 * ~/.orca-flow/env-costs.json: `{ "<repo>": <price GB>, …, "samples": [{ path, repo, gb, at }] }`.
 * The top-level numbers are the prices as last written, so an older Orca Flow, which reads only
 * numeric values, still reads current prices. Here they are only a fallback for a project with no
 * samples: a file in the old `{ repo: number }` shape (or one an older Orca Flow rewrote, dropping
 * the samples) prices each project at its old number until its checkouts are measured again.
 */
export function readEnvMemory(dir: string): EnvMemory {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'env-costs.json'), 'utf8')) ?? {}
    const legacy = Object.fromEntries(Object.entries(m).filter((e): e is [string, number] => e[0] !== 'samples' && typeof e[1] === 'number' && e[1] >= 0))
    const samples = (Array.isArray(m.samples) ? m.samples : []).filter(
      (s: any): s is EnvSample => s && typeof s.path === 'string' && typeof s.repo === 'string' && typeof s.gb === 'number' && s.gb >= 0 && !Number.isNaN(Date.parse(s.at))
    )
    return { samples, legacy }
  } catch {
    return { samples: [], legacy: {} }
  }
}

export function writeEnvMemory(dir: string, memory: EnvMemory): void {
  try {
    writeFileSync(join(dir, 'env-costs.json'), JSON.stringify({ ...envPrices(memory), samples: memory.samples }, null, 2) + '\n')
  } catch {}
}

/**
 * The one writer of env-costs.json, shared by the plugin (every 5 minutes) and `orca-flow capacity`
 * (each run) so they never disagree: this scan's checkouts join the remembered samples, the file is
 * rewritten, and each project's price comes back.
 */
export function updateEnvCosts(dir: string, measured: EnvMeasure[], at = Date.now()): Record<string, number> {
  const { envGB, memory } = costsOf([], measured, readEnvMemory(dir), at)
  writeEnvMemory(dir, memory)
  return envGB
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
