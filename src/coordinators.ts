// Who each agent works for. The user's coordinators are folders under COORDINATOR_HOME, each with
// a COORDINATOR_FILE, added to Orca as folder workspaces; a coordinator's session is the agent
// running in its workspace. Orca's orchestration records, for every worker dispatch, the run it
// belongs to, and every run records the terminal that dispatched it. So: worker pane -> dispatch ->
// run -> dispatching terminal -> one of the user's coordinators, or another agent whose own
// coordinator we look up the same way. Anything nobody dispatched belongs to 'you'.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Coordinator, CoordinatorSessions, LinearSent, Look, WorkspaceRow } from './protocol.ts'

import { memberAgent, terminalPane, unambiguousSession, validSessions } from './coordinator-sessions.ts'
import { bootstrapCoordinator } from './coordinator-bootstrap.ts'

export const COORDINATOR_HOME = join(homedir(), 'orca', 'coordinators')
export const COORDINATOR_FILE = 'coordinator.json'
/** Who each agent worked for, remembered so an agent resumed in a new terminal keeps its place. */
export const OWNERS_FILE = join(homedir(), '.orca-flow', 'owners.json')

export type CoordinatorInfo = Coordinator & { dir: string; about: string }

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * A coordinator's home: a folder under the coordinator home or one holding a coordinator file. It
 * has no code checkout, install or dev server, so it never counts against the worktree limit.
 */
export function isCoordinatorHome(path: string | null | undefined, root = COORDINATOR_HOME): boolean {
  if (!path) return false
  return path === root || path.startsWith(`${root}/`) || existsSync(join(path, COORDINATOR_FILE))
}

/** The user's coordinators on disk: one folder each under the coordinator home. */
export function readCoordinators(root = COORDINATOR_HOME): CoordinatorInfo[] {
  if (!existsSync(root)) return []
  const out: CoordinatorInfo[] = []
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name)
    const c = readJson<{ name?: string; repos?: string[]; about?: string; look?: Look; linearTeams?: unknown; sessions?: unknown }>(join(dir, COORDINATOR_FILE))
    const linearTeams = Array.isArray(c?.linearTeams) ? c.linearTeams.filter((t): t is string => typeof t === 'string') : []
    if (!c?.name) continue
    const sessions = validSessions(c.sessions)
    out.push({ key: c.name, name: c.name, repos: c.repos ?? [], about: c.about ?? '', dir, workspaceId: null, look: c.look ?? null, linearTeams,
      ...(c.sessions !== undefined ? { sessions: sessions ?? { version: 1, current: null, members: [] }, ...(!sessions ? { sessionNotice: 'Invalid session configuration. Repair coordinator.json before associating a session.' } : {}) } : {}) })
  }
  return out
}

/** Names become folder names and appear in the panel: short, lowercase, no surprises. */
export function validateName(name: string, existing: string[]): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(name)) return 'Use lowercase letters, digits and dashes'
  if (existing.includes(name)) return `${name} already exists`
  return null
}

/**
 * Writes a new coordinator's folder. It starts owning every project; it narrows its own scope in
 * its COORDINATOR_FILE as the user tells it what it is for.
 */
export function scaffoldCoordinator(root: string, input: { name: string; look: Look | null }): string {
  const dir = join(root, input.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, COORDINATOR_FILE), JSON.stringify({ name: input.name, repos: [], about: '', look: input.look }, null, 2) + '\n')
  bootstrapCoordinator(dir)
  return dir
}

/** What the orchestration records say: which terminal dispatched each worker pane. */
export type Lineage = {
  /** worker pane -> terminal handle of the agent that dispatched it (Orca's run coordinator) */
  dispatcherOf: Map<string, string>
  /** terminal handle -> pane */
  paneOf: Map<string, string>
  /** closed terminal handle -> the folder it ran in */
  dirOfTerminal?: Map<string, string>
  /** Run routes remain independent of current-session selection. */
  runs?: { id: string; terminal: string }[]
  /** worker pane -> whether its dispatch is still open or has settled (worker_done, abandoned) */
  dispatchOf?: Map<string, 'open' | 'settled'>
}

/** Dispatch states after which the agent no longer holds its task: it reported, or was ended. */
const SETTLED = new Set(['succeeded', 'failed', 'abandoned', 'cancelled', 'canceled', 'stopped'])

/**
 * Pure: the user's coordinator each agent works for and, when some other agent dispatched it, that
 * agent's pane (so the tree can nest it). Chains are followed a few levels deep.
 *
 * Orca's own parent pane comes first: a lead can start its worker inside its coordinator's run, so
 * the run's coordinator terminal says nothing about which agent started it. The run lineage is
 * the fallback for an agent with no known parent pane.
 *
 * An agent resumed in a new terminal has neither (Orca gives the new pane no parent, and its old
 * dispatch failed when the old terminal closed). For it, the remembered owner (`owners`, see
 * `rememberOwners`) applies: live lineage wins, memory only replaces 'you'.
 */
/**
 * Legacy migration candidate only: a single independent, undispatched root. Multiple roots
 * require explicit association; their provider, focus, age, title and child count do not decide.
 */
export function coordinatorSession<A extends { paneKey: string; parentPane: string | null }>(agents: A[], dispatched: (pane: string) => boolean = () => false): A | null {
  return unambiguousSession(agents, dispatched)
}

export function assignCoordinators(rows: WorkspaceRow[], coordinators: CoordinatorInfo[], lineage: Lineage, owners: Owners = {}): WorkspaceRow[] {
  // A coordinator's session is its own agent in its folder workspace; other agents there (a lead or
  // worker it started in a tab of its folder) work for it.
  const coordinatorByPane = new Map<string, string>()
  const folderOf = new Map<string, string>()
  for (const c of coordinators) for (const row of rows) if (row.path === c.dir) {
    const members = c.sessions ? c.sessions.members.map((m) => memberAgent(m, [row])).filter(Boolean) : [coordinatorSession(row.agents, (pane) => lineage.dispatchOf?.has(pane) ?? false)]
    for (const a of row.agents) members.includes(a) ? coordinatorByPane.set(a.paneKey, c.key) : folderOf.set(a.paneKey, c.key)
  }
  const coordinatorByTerminal = new Map([...lineage.paneOf].filter(([, pane]) => coordinatorByPane.has(pane)).map(([handle, pane]) => [handle, coordinatorByPane.get(pane)!]))
  for (const c of coordinators) for (const m of c.sessions?.members ?? []) for (const terminal of m.terminals) coordinatorByTerminal.set(terminal, c.key)
  // Legacy provenance is kept only until explicit membership exists.
  for (const [handle, dir] of lineage.dirOfTerminal ?? []) {
    const c = coordinators.find((c) => c.dir === dir)
    if (c && !c.sessions) coordinatorByTerminal.set(handle, c.key)
  }
  const agentPanes = new Set(rows.flatMap((r) => r.agents.map((a) => a.paneKey)))
  const parentOf = new Map(rows.flatMap((r) => r.agents.filter((a) => a.parentPane).map((a) => [a.paneKey, a.parentPane!])))
  const known = new Set(coordinators.map((c) => c.key))
  const agents = rows.flatMap((r) => r.agents)
  const sessionOf = new Map(agents.filter((a) => a.orcaSession).map((a) => [a.paneKey, a.orcaSession!]))
  const paneOfSession = new Map([...sessionOf].map(([pane, session]) => [session, pane]))
  // The remembered owner: by the agent's Orca session, or by its pane when Orca gave it no session.
  const remembered = (pane: string): { coordinator: string; leadPane: string | null } | null => {
    const owner = owners[sessionOf.get(pane) ?? pane]
    if (!owner || !known.has(owner.coordinator)) return null
    const lead = owner.leadSession ? (paneOfSession.get(owner.leadSession) ?? (agentPanes.has(owner.leadSession) ? owner.leadSession : null)) : null
    return { coordinator: owner.coordinator, leadPane: lead && lead !== pane && coordinatorByPane.get(lead) !== owner.coordinator ? lead : null }
  }
  const coordinatorOfPane = (pane: string, depth = 0): { coordinator: string; leadPane: string | null } => {
    const live = liveCoordinatorOfPane(pane, depth)
    const found = live.coordinator === 'you' ? (remembered(pane) ?? live) : live
    // An agent in a coordinator's folder works for that coordinator, nested under a lead of its own if it has one.
    const folder = folderOf.get(pane)
    return folder && found.coordinator !== folder ? { coordinator: folder, leadPane: null } : found
  }
  const liveCoordinatorOfPane = (pane: string, depth: number): { coordinator: string; leadPane: string | null } => {
    const parent = parentOf.get(pane)
    // A parent pane that is no longer open (a coordinator that slept) says nothing; use the runs.
    if (parent && agentPanes.has(parent) && depth <= 4) {
      const coordinator = coordinatorByPane.get(parent)
      if (coordinator) return { coordinator, leadPane: null }
      return { coordinator: coordinatorOfPane(parent, depth + 1).coordinator, leadPane: parent }
    }
    const dispatcher = lineage.dispatcherOf.get(pane)
    if (!dispatcher || depth > 4) return { coordinator: 'you', leadPane: null }
    const coordinator = coordinatorByTerminal.get(dispatcher)
    if (coordinator) return { coordinator, leadPane: null }
    const leadPane = lineage.paneOf.get(dispatcher) ?? null
    return { coordinator: leadPane ? coordinatorOfPane(leadPane, depth + 1).coordinator : 'you', leadPane }
  }
  const terminalOf = new Map([...lineage.paneOf].map(([handle, pane]) => [pane, handle]))
  return rows.map((row) => ({
    ...row,
    // Titles stay as Orca and the summary give them (summary, then Orca's conversation name, then its
    // task title): a worker the user talks to directly drifts from the last task it was handed.
    agents: row.agents.map((a) => ({ ...a, ...coordinatorOfPane(a.paneKey), terminal: terminalOf.get(a.paneKey) ?? null, dispatch: lineage.dispatchOf?.get(a.paneKey) ?? null }))
  }))
}

// ---------- remembered owners ----------

/**
 * Agent -> the coordinator it worked for and the lead it nested under. Keyed by the agent's Orca
 * session (`orcaSessionId`, which survives a resume); an agent Orca gave no session is keyed by its
 * pane. `leadSession` is the lead's Orca session (its pane when it has none). `seen` is the day the
 * agent was last open, so entries for long-gone agents can be dropped.
 */
export type Owner = { coordinator: string; leadSession: string | null; seen?: string }
export type Owners = Record<string, Owner>

/** Entries for agents not open for this long are dropped. */
const FORGET_AFTER_DAYS = 30

/**
 * Pure: the owners store after these assignments, or null when nothing changed (so it is written
 * only on change). Every open agent with a coordinator is remembered; an agent that resolved to
 * 'you' leaves its entry alone, since that is exactly the case memory is for.
 */
export function rememberOwners(rows: WorkspaceRow[], owners: Owners, today = new Date().toISOString().slice(0, 10)): Owners | null {
  const agents = rows.flatMap((r) => r.agents)
  const sessionOf = new Map(agents.map((a) => [a.paneKey, a.orcaSession]))
  const next: Owners = {}
  const cutoff = new Date(Date.parse(today) - FORGET_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10)
  for (const [key, owner] of Object.entries(owners)) if (!owner.seen || owner.seen >= cutoff) next[key] = owner
  let changed = Object.keys(next).length !== Object.keys(owners).length
  for (const a of agents) {
    if (a.coordinator === 'you' || !a.paneKey) continue
    const key = a.orcaSession ?? a.paneKey
    const leadSession = a.leadPane ? (sessionOf.get(a.leadPane) ?? a.leadPane) : null
    const old = next[key]
    if (old && old.coordinator === a.coordinator && old.leadSession === leadSession && old.seen === today) continue
    next[key] = { coordinator: a.coordinator, leadSession, seen: today }
    changed = true
  }
  return changed ? next : null
}

export function readOwners(path = OWNERS_FILE): Owners {
  const data = readJson<Owners>(path)
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

export function writeOwners(owners: Owners, path = OWNERS_FILE): void {
  writeJsonFile(path, owners)
}

/** Write via a temp file and rename, so a reader never sees half a file. */
function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, path)
}

// ---------- remembered Linear sends ----------

/** Which coordinator each Linear team was last sent to, and sends no worktree links yet. */
export const LINEAR_FILE = join(homedir(), '.orca-flow', 'linear.json')
export type LinearMemory = { lastSent: Record<string, string>; sent: Record<string, LinearSent> }

export function readLinearMemory(path = LINEAR_FILE): LinearMemory {
  const d = readJson<Partial<LinearMemory>>(path)
  const obj = <T>(x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, T>) : {})
  return { lastSent: obj<string>(d?.lastSent), sent: obj<LinearSent>(d?.sent) }
}

export function writeLinearMemory(memory: LinearMemory, path = LINEAR_FILE): void {
  writeJsonFile(path, memory)
}

// ---------- loading the lineage from the orca CLI (slow on a busy machine, so cached) ----------

type Run = (args: string[], options?: { timeoutMs?: number; cwd?: string }) => Promise<any>

/** Runs `orca <args> --json`; a failure carries Orca's own error message, not just the exit code. */
export function orcaRunner(bin: string): Run {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(bin, [...args, '--json'], { maxBuffer: 32 * 1024 * 1024, timeout: options.timeoutMs ?? 20_000, ...(options.cwd ? { cwd: options.cwd } : {}) }, (err, stdout) => {
        let parsed: any = null
        try {
          parsed = JSON.parse(stdout)
        } catch {}
        if (parsed?.ok) return resolve(parsed.result)
        if (parsed?.error?.message) return reject(Object.assign(new Error(parsed.error.message), { code: parsed.error.code, data: parsed.error.data }))
        if (err && (err as Error & { killed?: boolean }).killed) return reject(new Error(`orca ${args[0]} ${args[1] ?? ''} timed out`))
        if (args[0] === 'agent' && args[1] === 'launch') return reject(new Error('Orca did not return a launch receipt. Inspect the saved handover before retrying.'))
        reject(err ?? new Error(`orca ${args.join(' ')} failed`))
      })
    })
}

/** A run whose workers have all ended is checked again only after a while, in case it gets new ones. */
const quietRuns = new Map<string, number>()
const QUIET_RECHECK_MS = 5 * 60_000
/** Where a closed terminal ran never changes, so it is looked up once. */
const dirOfClosed = new Map<string, string | null>()

/** The folder a terminal ran in, from Orca's record of it (kept after the terminal closes). */
export function dirOfTerminalRecord(t: { worktreePath?: string; worktreeId?: string } | null | undefined): string | null {
  return t?.worktreePath || t?.worktreeId?.split('::')[1] || null
}

/**
 * Every recent run with live workers: which terminal coordinates it and which panes it dispatched.
 * `worker-list` alone only shows the caller's own run, so each run is listed by id, one at a time
 * (each call is a process). A coordinator that slept left its runs on its closed terminal; Orca
 * still knows which folder that terminal ran in.
 */
export async function loadLineage(run: Run, now = Date.now(), force = false): Promise<Lineage> {
  const [terminals, runs] = await Promise.all([run(['terminal', 'list']), run(['orchestration', 'run-list', '--limit', '30', '--full'])])
  const paneOf = new Map<string, string>()
  // A background-launched terminal has no tab yet; its recorded pane still names its agent.
  for (const t of terminals.terminals ?? []) { const pane = terminalPane(t); if (pane) paneOf.set(t.handle, pane) }

  const dispatcherOf = new Map<string, string>()
  const dispatchOf = new Map<string, 'open' | 'settled'>()
  const coordinating = new Set<string>()
  for (const r of runs.runs ?? []) {
    const handle: string | null = r.coordinator_handle
    if (!handle || (!force && now - (quietRuns.get(r.id) ?? -Infinity) < QUIET_RECHECK_MS)) continue
    const listed = await run(['orchestration', 'worker-list', '--run', r.id]).catch(() => null)
    if (!listed) continue
    const active = (listed.workers ?? []).filter((w: any) => w.terminal && w.terminalState !== 'released')
    if (active.length === 0) {
      // A new run gets its first worker a moment after it is created; only an older one is quiet.
      if (now - Date.parse(r.created_at ?? '') > 30 * 60_000) quietRuns.set(r.id, now)
      continue
    }
    quietRuns.delete(r.id)
    coordinating.add(handle)
    for (const w of active) {
      const pane = paneOf.get(w.terminal)
      if (!pane) continue
      dispatcherOf.set(pane, handle)
      // A follow-up sent to a settled worker opens a new dispatch on the same terminal: any open one wins.
      if (dispatchOf.get(pane) !== 'open') dispatchOf.set(pane, SETTLED.has(w.state) ? 'settled' : 'open')
    }
  }

  const dirOfTerminal = new Map<string, string>()
  for (const handle of coordinating) {
    if (paneOf.has(handle)) continue
    if (!dirOfClosed.has(handle)) {
      const shown = await run(['terminal', 'show', '--terminal', handle]).catch(() => null)
      dirOfClosed.set(handle, dirOfTerminalRecord(shown?.terminal))
    }
    const dir = dirOfClosed.get(handle)
    if (dir) dirOfTerminal.set(handle, dir)
  }
  return { dispatcherOf, paneOf, dirOfTerminal, dispatchOf, runs: (runs.runs ?? []).filter((r: any) => r.coordinator_handle).map((r: any) => ({ id: r.id, terminal: r.coordinator_handle })) }
}

/** Changes a coordinator's look in its file, keeping everything else. */
export function writeLook(dir: string, look: Look): void {
  const path = join(dir, COORDINATOR_FILE)
  const data = readJson<Record<string, unknown>>(path) ?? {}
  writeFileSync(path, JSON.stringify({ ...data, look }, null, 2) + '\n')
}

/** Sets the Linear teams a coordinator owns in its file, keeping everything else; none removes the field. */
export function writeLinearTeams(dir: string, teams: string[]): void {
  const path = join(dir, COORDINATOR_FILE)
  const data = readJson<Record<string, unknown>>(path) ?? {}
  const keys = [...new Set(teams.map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z][A-Z0-9]*$/.test(t)))]
  if (keys.length) data.linearTeams = keys
  else delete data.linearTeams
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

/** Deletes a coordinator's folder; refuses anything that is not a direct child of the home. */
export function deleteFolder(dir: string, root = COORDINATOR_HOME): void {
  const parent = join(dir, '..')
  if (parent !== root || dir === root || !existsSync(join(dir, COORDINATOR_FILE))) throw new Error(`refusing to delete ${dir}`)
  rmSync(dir, { recursive: true, force: true })
}


/**
 * Reads, changes and compare-and-swaps a coordinator's sessions in one synchronous step, so
 * overlapping refreshes in this worker cannot interleave between the read and the write. Returns
 * what is on disk afterwards; unreadable files and invalid sessions are never overwritten.
 */
export function updateCoordinatorSessions(dir: string, change: (onDisk: CoordinatorSessions | undefined) => CoordinatorSessions | undefined): CoordinatorSessions | undefined {
  const data = readJson<Record<string, unknown>>(join(dir, COORDINATOR_FILE))
  if (!data) throw new Error('Coordinator configuration could not be read; it was not overwritten.')
  const onDisk = data.sessions === undefined ? undefined : validSessions(data.sessions)
  if (data.sessions !== undefined && !onDisk) throw new Error('Invalid session configuration; it was not overwritten.')
  const next = change(onDisk)
  if (!next || JSON.stringify(next) === JSON.stringify(onDisk)) return onDisk
  writeCoordinatorSessions(dir, next, { sessions: onDisk })
  return next
}

/** Persist explicit membership atomically without changing scope, appearance or other config. */
export function writeCoordinatorSessions(dir: string, sessions: CoordinatorSessions, expected?: { sessions: CoordinatorSessions | undefined }): void {
  const path = join(dir, COORDINATOR_FILE)
  const data = readJson<Record<string, unknown>>(path)
  if (!data) throw new Error('Coordinator configuration could not be read; it was not overwritten.')
  if (expected && JSON.stringify(data.sessions) !== JSON.stringify(expected.sessions)) throw new Error('Session configuration changed. Refresh Sessions and try again; the newer selection was preserved.')
  writeJsonFile(path, { ...data, sessions })
}
