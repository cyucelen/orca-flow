// The user's paired Orca hosts, polled in the background so a snapshot never waits on a remote host.
//
// Built on skills/orca-flow/scripts/hosts.mjs (the shared contract: host ids, the read-only probe,
// re-keyed rows, safe reasons). This file adds only the timing, the last-known data and its file.
//
// - `orca environment list` at start and every ENV_EVERY_MS. No paired host (an empty list, or the
//   command failed): nothing is probed and `view()` is null, so the snapshot is what it was without hosts.
// - Each paired host: status and worktrees every PROBE_EVERY_MS, its installed agents every
//   AGENTS_EVERY_MS, its memory every MEMORY_EVERY_MS (a process sweep on the host: slow on purpose).
//   Every command is bounded by `timeoutMs` (PROBE_TIMEOUT_MS). At most MAX_PROBES hosts are probed at
//   once and a host is never probed twice at once. An unreachable host backs off: PROBE_EVERY_MS,
//   doubling, at most BACKOFF_MAX_MS. Probes run on this file's own timer only: a sidebar refresh
//   reads `view()` and never starts one.
// - The last good data of each host (rows, memory, agents, version, capabilities, seenAt) is kept,
//   whatever a later probe says: an unavailable host shows its last rows, stale, with its reason;
//   never "asleep", never empty. It goes to ~/.orca-flow/hosts.json (written atomically) with the
//   host's id, name and environment id, never its endpoints or pairing data; at start that file shows
//   the last rows at once, stale, until a probe answers.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pairedHosts, probeHost, PROBE_TIMEOUT_MS, REMOTE_WORKER_CAPABILITY, safeReason, STALE_AFTER_MS, type HostMemory, type PairedHost } from '../skills/orca-flow/scripts/hosts.mjs'
import type { HostView } from './protocol.ts'
import type { PsWorktree } from './worker.ts'

export const ENV_EVERY_MS = 5 * 60_000
export const PROBE_EVERY_MS = 60_000
export const AGENTS_EVERY_MS = 10 * 60_000
export const MEMORY_EVERY_MS = 5 * 60_000
export const BACKOFF_MAX_MS = 5 * 60_000
export const MAX_PROBES = 2
/** How often the timer looks for due work; each look only starts what is due. */
export const TICK_MS = 5_000

export type HostRun = (args: string[], options?: { timeoutMs?: number }) => Promise<any>

/** What a snapshot takes from the poller: the paired hosts, and each one's last rows (re-keyed to it). */
export type RemoteHosts = { hosts: HostView[]; worktrees: { host: { id: string; name: string; stale: boolean }; worktrees: PsWorktree[] }[] }

type Entry = {
  host: PairedHost
  /** When this session's last probe of it ended; null: not probed yet this session. */
  probedAt: number | null
  reachable: boolean | null
  reason: string | null
  version: string | null
  capabilities: string[] | null
  worktrees: PsWorktree[] | null
  rowsAt: number | null
  /** The rows came from a probe of this session (not from hosts.json). */
  rowsFresh: boolean
  memory: HostMemory | null
  agents: string[] | null
  seenAt: number | null
  due: number
  agentsDue: number
  memoryDue: number
  backoff: number
}

const FILE_VERSION = 1
type Saved = { id: string; name: string; environmentId: string; seenAt: number | null; version: string | null; capabilities: string[] | null; agents: string[] | null; memory: HostMemory | null; rowsAt: number | null; worktrees: PsWorktree[] | null }

/** Pure: hosts.json's text → saved hosts; anything broken reads as none. */
export function parseSaved(text: string): Saved[] {
  try {
    const d = JSON.parse(text)
    if (d?.version !== FILE_VERSION || !Array.isArray(d.hosts)) return []
    return d.hosts.filter((h: any) => typeof h?.id === 'string' && typeof h.environmentId === 'string' && typeof h.name === 'string')
  } catch { return [] }
}

/** Pure: the saved form of an entry: identity (id, name, environment id) and its last good data only. */
const savedOf = (e: Entry): Saved => ({ id: e.host.id, name: e.host.name, environmentId: e.host.environmentId, seenAt: e.seenAt, version: e.version, capabilities: e.capabilities, agents: e.agents, memory: e.memory, rowsAt: e.rowsAt, worktrees: e.worktrees })

/** Pure: an entry as the sidebar shows it at `now`. */
export function viewOf(e: Entry, now: number): HostView {
  const state = e.reachable === null ? 'checking' : e.reachable ? 'reachable' : 'unavailable'
  const stale = state === 'unavailable' || (e.rowsAt !== null && (!e.rowsFresh || now - e.rowsAt > STALE_AFTER_MS))
  return {
    id: e.host.id, name: e.host.name, kind: 'paired', state, stale, checkedAt: e.probedAt, seenAt: e.seenAt, version: e.version,
    reason: e.reason, memory: e.memory, agents: e.agents, remoteWorkers: e.capabilities ? e.capabilities.includes(REMOTE_WORKER_CAPABILITY) : null
  }
}

/** A runner whose every command gives up after `ms`, whatever the runner does. */
export function bounded(run: HostRun, ms: number): (args: string[]) => Promise<any> {
  return (args) => new Promise((resolve, reject) => {
    const command = args.slice(0, 2).filter((a) => !a.startsWith('--')).join(' ')
    const timer = setTimeout(() => reject(new Error(`orca ${command} timed out`)), ms)
    run(args, { timeoutMs: ms }).then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

export function createHostPoller(opts: { run: HostRun; file?: string | null; now?: () => number; timeoutMs?: number; onChange?: () => void; log?: (line: string) => void }) {
  const now = opts.now ?? Date.now
  const run = bounded(opts.run, opts.timeoutMs ?? PROBE_TIMEOUT_MS)
  const log = opts.log ?? (() => {})
  const entries = new Map<string, Entry>()
  /** The hosts `environment list` named last (null: it failed, or has not answered and no file was read). */
  let paired: string[] | null = null
  /** Probes start only once this session's `environment list` named the hosts (never from the file alone). */
  let listed = false
  let envDue = 0
  let envLoading: Promise<void> | null = null
  const inFlight = new Map<string, Promise<void>>()
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let lastWritten = ''
  let lastSignature = ''

  const fresh = (host: PairedHost): Entry => ({ host, probedAt: null, reachable: null, reason: null, version: null, capabilities: null, worktrees: null, rowsAt: null, rowsFresh: false, memory: null, agents: null, seenAt: null, due: 0, agentsDue: 0, memoryDue: 0, backoff: 0 })

  // Last-known hosts first, so their rows show (stale, checking) before anything answers.
  if (opts.file && existsSync(opts.file)) {
    let text = ''
    try { text = readFileSync(opts.file, 'utf8') } catch {}
    for (const s of parseSaved(text)) {
      entries.set(s.id, { ...fresh({ id: s.id, environmentId: s.environmentId, name: s.name, runtimeId: null }), seenAt: s.seenAt ?? null, version: s.version ?? null, capabilities: s.capabilities ?? null, agents: s.agents ?? null, memory: s.memory ?? null, rowsAt: s.rowsAt ?? null, worktrees: Array.isArray(s.worktrees) ? s.worktrees : null })
    }
    if (entries.size) paired = [...entries.keys()]
    lastWritten = JSON.stringify({ version: FILE_VERSION, hosts: [...entries.values()].map(savedOf) })
  }

  const visible = () => (paired ?? []).map((id) => entries.get(id)).filter((e): e is Entry => !!e)

  function persist(): void {
    if (!opts.file) return
    const text = JSON.stringify({ version: FILE_VERSION, hosts: visible().map(savedOf) })
    if (text === lastWritten) return
    try {
      mkdirSync(join(opts.file, '..'), { recursive: true })
      const tmp = `${opts.file}.${process.pid}.tmp`
      writeFileSync(tmp, text, { mode: 0o600 })
      renameSync(tmp, opts.file)
      lastWritten = text
    } catch (e) { log(`saving hosts failed: ${(e as Error).message}`) }
  }

  /** Tells the sidebar when what it shows changed (timestamps alone do not count). */
  function changed(): void {
    const t = now()
    const sig = JSON.stringify(visible().map((e) => { const v = viewOf(e, t); return [v.id, v.name, v.state, v.stale, v.reason, v.version, v.memory?.totalGB, v.memory?.availableGB, v.agents, v.remoteWorkers, e.worktrees] }))
    if (sig === lastSignature) return
    lastSignature = sig
    opts.onChange?.()
  }

  function loadEnvironments(): Promise<void> {
    envDue = now() + ENV_EVERY_MS
    return (envLoading ??= run(['environment', 'list'])
      .then((result) => {
        const hosts = pairedHosts(result)
        for (const h of hosts) {
          const e = entries.get(h.id)
          if (!e) entries.set(h.id, fresh(h))
          else e.host = h
        }
        for (const id of [...entries.keys()]) if (!hosts.some((h) => h.id === id)) entries.delete(id)
        paired = hosts.map((h) => h.id)
        listed = true
        persist()
      })
      .catch((e: Error) => {
        // Treated as no paired host: nothing probes and the sidebar shows what it shows without hosts.
        // The file stays: one failed read does not forget the hosts.
        if (paired?.length) log(`orca environment list failed: ${safeReason(e)}`)
        paired = null
        listed = false
      })
      .finally(() => { envLoading = null; changed(); pump() }))
  }

  async function probe(e: Entry): Promise<void> {
    const t0 = now()
    const want = { worktrees: true, agents: t0 >= e.agentsDue, memory: t0 >= e.memoryDue }
    if (want.agents) e.agentsDue = t0 + AGENTS_EVERY_MS
    if (want.memory) e.memoryDue = t0 + MEMORY_EVERY_MS
    let p: Awaited<ReturnType<typeof probeHost<PsWorktree>>>
    try { p = await probeHost<PsWorktree>(e.host, run, { want, now }) }
    catch (err) { p = { host: e.host, at: t0, reachable: false, status: null, worktrees: null, agents: null, memory: null, errors: { status: safeReason(err) } } }
    if (stopped) return
    const t = now()
    e.probedAt = t
    if (p.reachable && p.status) {
      e.reachable = true
      e.backoff = 0
      e.due = t + PROBE_EVERY_MS
      e.seenAt = p.at
      e.version = p.status.version
      e.capabilities = p.status.capabilities
      // A read that failed keeps the last good one: rows, agents and memory each stand alone.
      if (p.worktrees) { e.worktrees = p.worktrees; e.rowsAt = p.at; e.rowsFresh = true }
      if (p.agents) e.agents = p.agents
      if (p.memory) e.memory = p.memory
      e.reason = p.errors.worktrees ? `worktree list failed: ${p.errors.worktrees}` : null
    } else {
      e.reachable = false
      e.backoff = e.backoff ? Math.min(e.backoff * 2, BACKOFF_MAX_MS) : PROBE_EVERY_MS
      e.due = t + e.backoff
      e.reason = p.errors.status ?? `Orca reports it ${p.status?.connectionState ?? 'unreachable'}`
    }
    persist()
    changed()
  }

  /** Starts the due probes that fit: at most MAX_PROBES at once, one per host, the longest-waiting first. */
  function pump(): void {
    if (stopped || !paired || !listed) return
    const t = now()
    const due = visible().filter((e) => !inFlight.has(e.host.id) && e.due <= t).sort((a, b) => a.due - b.due)
    for (const e of due) {
      if (inFlight.size >= MAX_PROBES) break
      const job = probe(e).catch((err: Error) => log(`probing ${e.host.name} failed: ${safeReason(err)}`)).finally(() => { inFlight.delete(e.host.id); pump() })
      inFlight.set(e.host.id, job)
    }
  }

  /** One look: the environment list when due, then the due probes. */
  function tick(): void {
    if (stopped) return
    if (now() >= envDue && !envLoading) void loadEnvironments()
    pump()
  }

  return {
    tick,
    start(): void {
      if (timer) return
      tick()
      timer = setInterval(tick, TICK_MS)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    },
    stop(): void {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
    },
    /** Resolves when the environment read and every probe in flight have settled (tests). */
    async idle(): Promise<void> {
      while (envLoading || inFlight.size) await Promise.all([envLoading, ...inFlight.values()])
    },
    inFlight: () => [...inFlight.keys()],
    /** The paired hosts and their last rows; null while no host is paired. Never starts a probe. */
    view(): RemoteHosts | null {
      const list = visible()
      if (!list.length) return null
      const t = now()
      const hosts = list.map((e) => viewOf(e, t))
      return {
        hosts,
        worktrees: list.flatMap((e, i) => (e.worktrees?.length ? [{ host: { id: e.host.id, name: e.host.name, stale: hosts[i].stale }, worktrees: e.worktrees }] : []))
      }
    }
  }
}

export type HostPoller = ReturnType<typeof createHostPoller>
