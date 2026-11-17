// The opened cockpit: memory, heaviest sessions, finished sessions and merged worktrees, plus the
// two actions on them. Loaded only when the person opens the cockpit, because Orca's memory report
// and the GitHub checks take seconds on a busy machine.
import { execFile, execFileSync } from 'node:child_process'
import type { CockpitStats, SessionRef, StartedGroup, WorkspaceRow } from './protocol.ts'
import { finished } from './rank.ts'
import { readFootprint, readProcs, startedGroups } from './started.ts'

type Run = (args: string[], options?: { timeoutMs?: number }) => Promise<any>

export type MemoryReport = {
  sessions: { paneKey: string; bytes: number; pid?: number }[]
  host?: { totalBytes: number; usedBytes: number } | null
}

/** Pure: the cockpit from rows, Orca's memory report, pane -> terminal, and merged worktrees. */
export function buildCockpit(
  rows: WorkspaceRow[],
  memory: MemoryReport,
  terminalOf: Map<string, string>,
  merged: CockpitStats['merged'],
  swap: CockpitStats['swap'],
  started: StartedGroup[] = []
): CockpitStats {
  const bytesOf = new Map(memory.sessions.map((s) => [s.paneKey, s.bytes]))
  const ref = (row: WorkspaceRow, a: WorkspaceRow['agents'][number]): SessionRef => ({
    paneKey: a.paneKey,
    terminal: terminalOf.get(a.paneKey) ?? null,
    workspaceId: row.id,
    title: a.title,
    repo: row.repo,
    memMB: Math.round((bytesOf.get(a.paneKey) ?? 0) / 1024 ** 2)
  })
  const agents = rows.flatMap((row) => row.agents.map((a) => ({ row, a })))
  const gb = (b: number) => +(b / 1024 ** 3).toFixed(1)
  const startedMB = (pane: string) => started.filter((g) => g.paneKey === pane).reduce((n, g) => n + g.memMB, 0)
  const host = memory.host
  return {
    swap,
    ram: host ? { usedGB: gb(host.usedBytes), totalGB: gb(host.totalBytes) } : null,
    started,
    // Heaviest by what each session costs in all: itself plus what it started.
    heaviest: agents.map(({ row, a }) => ref(row, a)).filter((s) => s.memMB > 0).sort((x, y) => y.memMB + startedMB(y.paneKey) - x.memMB - startedMB(x.paneKey)).slice(0, 3),
    finished: agents.filter(({ row, a }) => finished(a, row.pr)).map(({ row, a }) => ref(row, a)).filter((s) => s.terminal),
    merged
  }
}

// ---------- loading ----------

function sh(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') }))
  })
}

export function swapUsage(): CockpitStats['swap'] {
  try {
    const s = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' })
    const gb = (name: string) => Number(new RegExp(`${name} = ([\\d.]+)M`).exec(s)?.[1] ?? 0) / 1024
    return { usedGB: +gb('used').toFixed(1), totalGB: +gb('total').toFixed(1) }
  } catch {
    return null
  }
}

/**
 * A worktree is offered for removal only when its checkout is clean and its PR merged on GitHub.
 * Both refusals carry the uncommitted files, so the person can waive them in one confirm.
 */
export async function checkRemovable(row: WorkspaceRow): Promise<{ ok: boolean; pr?: number; reason?: string; dirty?: string[] }> {
  if (row.main || !row.path || !row.branch) return { ok: false, reason: 'main checkout' }
  const status = await sh('git', ['status', '--porcelain'], row.path)
  if (!status.ok) return { ok: false, reason: 'not a git checkout' }
  const dirty = status.out.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim())
  // Squash merges never make the branch an ancestor of main, so ask GitHub instead of git.
  const pr = await sh('gh', ['pr', 'list', '--head', row.branch, '--state', 'merged', '--json', 'number', '--limit', '1'], row.path)
  const number = pr.ok ? (JSON.parse(pr.out || '[]')[0]?.number as number | undefined) : undefined
  if (!number) return { ok: false, reason: 'PR not merged', ...(dirty.length ? { dirty } : {}) }
  if (dirty.length) return { ok: false, pr: number, reason: 'uncommitted changes', dirty }
  return { ok: true, pr: number }
}

/** What the person may waive (Remove anyway): the branch and its commits are kept either way. */
const WAIVABLE = new Set(['PR not merged', 'uncommitted changes'])

/** Merge checks are slow (network); remember them for ten minutes. */
const mergedCache = new Map<string, { at: number; result: Awaited<ReturnType<typeof checkRemovable>> }>()

async function mergedWorktrees(rows: WorkspaceRow[]): Promise<CockpitStats['merged']> {
  // Only quiet worktrees: nothing working, asking or watching in them.
  const candidates = rows.filter((r) => !r.main && r.path && r.branch && r.agents.every((a) => finished(a, r.pr)))
  const out: CockpitStats['merged'] = []
  for (const row of candidates) {
    const cached = mergedCache.get(row.id)
    const result = cached && Date.now() - cached.at < 10 * 60_000 ? cached.result : await checkRemovable(row)
    mergedCache.set(row.id, { at: Date.now(), result })
    if (result.ok && result.pr) out.push({ workspaceId: row.id, name: row.name, repo: row.repo, pr: result.pr })
  }
  return out
}

export async function loadCockpit(run: Run, rows: WorkspaceRow[]): Promise<CockpitStats> {
  const [mem, terminals, merged, procs, footprint] = await Promise.all([
    run(['diagnostics', 'memory']).catch(() => null),
    run(['terminal', 'list']).catch(() => ({ terminals: [] })),
    mergedWorktrees(rows),
    readProcs(),
    readFootprint()
  ])
  const memory: MemoryReport = {
    sessions: (mem?.worktrees ?? []).flatMap((w: any) => (w.sessions ?? []).map((s: any) => ({ paneKey: s.paneKey, bytes: s.memory ?? 0, pid: s.pid }))),
    host: mem?.host?.totalMemory ? { totalBytes: mem.host.totalMemory, usedBytes: mem.host.usedMemory ?? 0 } : null
  }
  const sessionPids = memory.sessions.map((s) => s.pid).filter((p): p is number => typeof p === 'number')
  // Without Orca's session pids every process in a session would look detached; count none then.
  const started = mem ? startedGroups(procs, footprint, sessionPids, rows) : []
  const terminalOf = new Map<string, string>()
  for (const t of terminals.terminals ?? []) if (t.tabId && t.leafId) terminalOf.set(`${t.tabId}:${t.leafId}`, t.handle)
  return buildCockpit(rows, memory, terminalOf, merged, swapUsage(), started)
}

// ---------- actions ----------

/**
 * Ends sessions by pane. Terminals are looked up now, not taken from an older list, so a session
 * that finished a moment ago can be closed too.
 */
export async function closeSessions(run: Run, panes: string[]): Promise<{ closed: number }> {
  const listed = await run(['terminal', 'list']).catch(() => ({ terminals: [] }))
  const terminalOf = new Map<string, string>()
  for (const t of listed.terminals ?? []) if (t.tabId && t.leafId) terminalOf.set(`${t.tabId}:${t.leafId}`, t.handle)
  const terminals = panes.map((p) => terminalOf.get(p)).filter((t): t is string => Boolean(t))
  let closed = 0
  for (const terminal of terminals) {
    if (await run(['terminal', 'close', '--terminal', terminal]).then(() => true, () => false)) closed++
  }
  return { closed }
}

/**
 * Re-checks right before removing: the worktree may have changed since the cockpit opened. Only an
 * agent mid-turn (Orca's working state) stops it; an idle, asking or blocked one is closed first.
 */
export async function removeWorktree(run: Run, row: WorkspaceRow | undefined, force = false): Promise<{ removed: boolean; reason?: string; dirty?: string[] }> {
  if (!row) return { removed: false, reason: 'workspace not found' }
  if (row.agents.some((a) => a.state === 'working')) return { removed: false, reason: 'an agent is working' }
  const check = await checkRemovable(row)
  // `force` waives a PR that is not merged and uncommitted files, after the person confirmed; a
  // main checkout or anything else still keeps the worktree.
  const waived = !check.ok && force && WAIVABLE.has(check.reason ?? '')
  if (!check.ok && !waived) return { removed: false, reason: check.reason, ...(check.dirty ? { dirty: check.dirty } : {}) }
  mergedCache.delete(row.id)
  await closeSessions(run, row.agents.map((a) => a.paneKey))
  // Removal runs the repo's orca.yaml archive hook (which can stop the worktree's services and
  // clean up what setup created) and deletes the checkout; the branch is kept. A failing hook
  // blocks the removal. It all takes well over the usual timeout.
  return run(['worktree', 'rm', '--worktree', row.id, '--run-hooks', ...(waived ? ['--force'] : [])], { timeoutMs: 180_000 }).then(
    () => ({ removed: true }),
    async (e: Error) => {
      // Trust what Orca shows over how the command ended: it may have finished anyway.
      const listed = await run(['worktree', 'list']).catch(() => null)
      const stillThere = listed?.worktrees?.some((w: any) => `identity:${w.identity?.key}` === row.id)
      return stillThere === false ? { removed: true } : { removed: false, reason: e.message }
    }
  )
}
