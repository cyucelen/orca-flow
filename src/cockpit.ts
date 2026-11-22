// The opened cockpit: memory, heaviest sessions, finished sessions and merged worktrees, plus the
// two actions on them. Loaded only when the person opens the cockpit, because Orca's memory report
// and the GitHub checks take seconds on a busy machine.
import { execFile, execFileSync } from 'node:child_process'
import type { CockpitStats, SessionRef, StartedGroup, WorkspaceRow } from './protocol.ts'
import { finished, workingIn } from './rank.ts'
import { readFootprint, readProcs, startedGroups } from './started.ts'
import { terminalPane } from './coordinator-sessions.ts'

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

type MergeCheck = { ok: boolean; pr?: number; reason?: string; dirty?: string[] }

/** A linked PR can have a different head branch name from the local checkout. Ask GitHub in the
 * checkout's repository and match the commit, so an old link or a reused branch cannot clear it. */
async function mergedPr(path: string, branch: string, linked: WorkspaceRow['pr'], command: typeof sh): Promise<MergeCheck> {
  const unknown = { ok: false, reason: 'PR status unknown' }
  const unmerged = { ok: false, reason: 'PR not merged' }
  const fields = 'number,url,state,headRefOid'
  const args = linked ? ['view', String(linked.number)] : ['list', '--head', branch, '--state', 'all', '--limit', '1']
  const result = await command('gh', ['pr', ...args, '--json', fields], path)
  if (!result.ok) return unknown
  try {
    const json = JSON.parse(result.out)
    if (!linked && !Array.isArray(json)) return unknown
    if (!linked && json.length === 0) return unmerged
    const pr = linked ? json : json[0]
    if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || !pr.headRefOid) return unknown
    if (linked && (pr.number !== linked.number || pr.url !== linked.url)) return unknown
    if (pr.state === 'OPEN' || pr.state === 'CLOSED') return unmerged
    if (pr.state !== 'MERGED') return unknown
    const head = await command('git', ['rev-parse', '--verify', 'HEAD'], path)
    if (!head.ok) return unknown
    return head.out.trim() === pr.headRefOid ? { ok: true, pr: pr.number } : { ok: false, reason: 'PR head differs' }
  } catch {
    return unknown
  }
}

/** Check both PR and dirty files before closing sessions, so one confirmation names both risks. */
export async function checkRemovable(row: WorkspaceRow, command = sh): Promise<MergeCheck> {
  if (row.main || !row.path || !row.branch) return { ok: false, reason: 'main checkout' }
  const status = await command('git', ['status', '--porcelain'], row.path)
  if (!status.ok) return { ok: false, reason: 'not a git checkout' }
  const dirty = status.out.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim())
  const merge = await mergedPr(row.path, row.branch, row.pr, command)
  if (!dirty.length) return merge
  return { ...merge, ok: false, reason: merge.ok ? 'uncommitted changes' : merge.reason, dirty }
}

const WAIVABLE = new Set(['PR not merged', 'PR head differs', 'PR status unknown', 'uncommitted changes'])

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
  for (const t of terminals.terminals ?? []) { const pane = terminalPane(t); if (pane) terminalOf.set(pane, t.handle) }
  return buildCockpit(rows, memory, terminalOf, merged, swapUsage(), started)
}

// ---------- actions ----------

/**
 * Ends sessions by pane. Terminals are looked up now, not taken from an older list, so a session
 * that finished a moment ago can be closed too. With nothing closed it says why: a pane with no open
 * terminal is already asleep, which is no success; an unreadable list is no proof of that.
 */
export async function closeSessions(run: Run, panes: string[]): Promise<{ closed: number; reason?: string }> {
  let listed: any
  try { listed = await run(['terminal', 'list']) }
  catch (e) { return { closed: 0, reason: `Orca could not list its terminals: ${(e as Error).message}` } }
  const terminalOf = new Map<string, string>()
  for (const t of listed?.terminals ?? []) { const pane = terminalPane(t); if (pane) terminalOf.set(pane, t.handle) }
  const terminals = panes.map((p) => terminalOf.get(p)).filter((t): t is string => Boolean(t))
  if (!terminals.length) return { closed: 0, reason: panes.length === 1 ? 'Already asleep: this conversation has no open terminal' : 'Already asleep: none of these conversations has an open terminal' }
  let closed = 0
  let failure = ''
  for (const terminal of terminals) {
    if (await run(['terminal', 'close', '--terminal', terminal]).then(() => true, (e: Error) => { failure = e.message; return false })) closed++
  }
  return closed ? { closed } : { closed, reason: `Orca could not close ${terminals.length === 1 ? 'its terminal' : 'their terminals'}${failure ? `: ${failure}` : ''}` }
}

/**
 * Re-checks right before removing: the worktree may have changed since the cockpit opened. Only an
 * agent mid-turn (Orca's working state) stops it; an idle, asking or blocked one is closed first.
 */
export async function removeWorktree(run: Run, row: WorkspaceRow | undefined, force = false): Promise<{ removed: boolean; reason?: string; branch?: string; dirty?: string[] }> {
  if (!row) return { removed: false, reason: 'workspace not found' }
  if (row.folderOf) return { removed: false, reason: "a coordinator's folder is never removed" }
  // The sidebar hides removal while an agent works; this catches one that started since.
  const busy = workingIn(row)
  if (busy) return { removed: false, reason: `${busy.title} is working in this worktree` }
  const check = await checkRemovable(row)
  // `force` waives a PR that is not merged and uncommitted files, after the person confirmed; a
  // main checkout or anything else still keeps the worktree.
  const canWaive = WAIVABLE.has(check.reason ?? '')
  const waived = !check.ok && force && canWaive
  if (!check.ok && !waived) return {
    removed: false, reason: check.reason,
    ...(canWaive && row.branch ? { branch: row.branch } : {}),
    ...(check.dirty ? { dirty: check.dirty } : {})
  }
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
