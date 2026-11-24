// What agents started that Orca does not count: dev servers and other processes that detached from
// the agent's terminal. Orca's memory report covers each session's own process tree; a detached
// process is reparented to launchd and drops out of it. Every process inherits its parent's
// environment, so it still carries the ORCA_WORKTREE_ID and ORCA_PANE_KEY of the terminal it came
// from. A process whose title hides its environment (next-server renames itself) belongs to its
// nearest tagged parent.
import { execFile } from 'node:child_process'
import type { StartedGroup, WorkspaceRow } from './protocol.ts'

export type Proc = { pid: number; ppid: number; name: string; worktree: string | null; pane: string | null }

/** Pure: `ps -axE -ww -o pid=,ppid=,command=` (command line followed by the environment). */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const text = m[3]
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: nameOf(text.split(/\s[A-Z_][A-Z0-9_]*=/)[0]),
      worktree: / ORCA_WORKTREE_ID=\S*?::(\S+)/.exec(text)?.[1] ?? null,
      pane: / ORCA_PANE_KEY=(\S+)/.exec(text)?.[1] ?? null
    })
  }
  return procs
}

/** "node …/.bin/next dev" -> "next"; "next-server (v16.4.5)" -> "next-server". */
function nameOf(command: string): string {
  const parts = command.trim().split(/\s+/)
  const base = (s = '') => s.split('/').pop() ?? s
  const first = base(parts[0])
  return /^(node|bun|deno|python3?|ruby)$/.test(first) && parts[1] && !parts[1].startsWith('-') ? base(parts[1]) : first
}

/**
 * A process's memory from top: its phys footprint (what Activity Monitor shows as Memory) and how
 * much of that is compressed. The footprint counts compressed pages at their uncompressed size,
 * so a dev server idle for hours can show 7 GB of which 6 GB are cold pages in the compressor or
 * in swap. What it keeps hot in RAM is the rest.
 */
export type Mem = { bytes: number; compressed: number }

/** Hot = footprint − compressed, never below 0 (top samples the two columns at slightly different moments). */
export const hotBytes = (m: Mem | undefined): number => (m ? Math.max(0, m.bytes - m.compressed) : 0)

/**
 * Pure: memory per pid from `top -l 1 -stats pid,mem,cmprs` ("81265  3920M+ 3509M"): sizes in
 * B/K/M/G, each optionally followed by + or - (grew or shrank since the last sample). A line
 * without the compressed column (`-stats pid,mem`) counts nothing as compressed.
 */
export function parseTop(out: string): Map<number, Mem> {
  const unit: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
  const size = (n: string, u: string) => Number(n) * unit[u]
  const mem = new Map<number, Mem>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)([BKMGT])[+-]?(?:\s+([\d.]+)([BKMGT])[+-]?)?\s*$/.exec(line)
    if (m) mem.set(Number(m[1]), { bytes: size(m[2], m[3]), compressed: m[4] ? size(m[4], m[5]) : 0 })
  }
  return mem
}

type Owned = { proc: Proc; key: string; row: WorkspaceRow; pane: string | null }

/**
 * Pure: each process an agent started outside its session, with the worktree and pane that started
 * it. Processes inside a session's tree are left out (Orca already counts them), and a tag only
 * counts for a worktree the panel knows, so text that merely looks like a tag is ignored.
 */
function owned(procs: Proc[], sessionPids: number[], rows: WorkspaceRow[]): Owned[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const children = new Map<number, number[]>()
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid])
  const inSession = new Set<number>()
  const stack = [...sessionPids]
  while (stack.length) {
    const pid = stack.pop()!
    if (inSession.has(pid)) continue
    inSession.add(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  const rowOf = new Map(rows.filter((r) => r.path).map((r) => [r.path!, r]))
  const out: Owned[] = []
  for (const proc of procs) {
    if (inSession.has(proc.pid)) continue
    let p: Proc | undefined = proc
    for (let depth = 0; p && p.pid > 1 && depth < 64 && !(p.worktree && rowOf.has(p.worktree)); depth++) p = byPid.get(p.ppid)
    const row = p?.worktree ? rowOf.get(p.worktree) : undefined
    if (row) out.push({ proc, key: `${row.path}|${p!.pane ?? ''}`, row, pane: p!.pane })
  }
  return out
}

/**
 * Pure: started processes grouped by worktree and pane, heaviest first, named by their heaviest
 * process. memMB is the footprint (what the sidebar shows); hotMB leaves out compressed pages
 * (what the capacity gate prices).
 */
export function startedGroups(procs: Proc[], footprint: Map<number, Mem>, sessionPids: number[], rows: WorkspaceRow[]): StartedGroup[] {
  const groups = new Map<string, StartedGroup & { top: number }>()
  for (const { proc, key, row, pane } of owned(procs, sessionPids, rows)) {
    const m = footprint.get(proc.pid)
    const bytes = m?.bytes ?? 0
    const g = groups.get(key) ?? { key, path: row.path!, paneKey: pane, workspaceId: row.id, worktreeName: row.name, repo: row.repo, name: proc.name, count: 0, memMB: 0, hotMB: 0, top: -1 }
    g.count++
    g.memMB += bytes / 1024 ** 2
    g.hotMB += hotBytes(m) / 1024 ** 2
    if (bytes > g.top) Object.assign(g, { top: bytes, name: proc.name })
    groups.set(key, g)
  }
  return [...groups.values()].map(({ top, ...g }) => ({ ...g, memMB: Math.round(g.memMB), hotMB: Math.round(g.hotMB) })).sort((a, b) => b.memMB - a.memMB)
}

// ---------- reading the machine ----------

function out(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? ''))))
}

export const readProcs = async (): Promise<Proc[]> => parsePs(await out('ps', ['-axE', '-ww', '-o', 'pid=,ppid=,command=']))
export const readFootprint = async (): Promise<Map<number, Mem>> => parseTop(await out('top', ['-l', '1', '-stats', 'pid,mem,cmprs', '-n', '5000']))
