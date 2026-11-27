// orca-flow sweep: which of a coordinator's worktrees are finished (safe to remove), which hold an
// interrupted lead's open work, and which the facts cannot settle. Decided from facts (Orca's
// worktree list and dispatch records, git, the PR), never from whether a lead reported.
//
//   orca-flow sweep [--coordinator <name>] [--json]       Read-only preview: four buckets and one batch
//   orca-flow sweep asked --batch <id> [--coordinator ..]   Record that the batch was offered to the user
//   orca-flow sweep declined --batch <id> [--coordinator ..] The user said no: do not ask again until HEAD moves
//   orca-flow sweep remove --batch <id> [--coordinator ..]   Only after the user's yes to that exact batch:
//                                         re-derive, recheck each item, `orca worktree rm --run-hooks` one at a time
//
// Pure classification (classify, batchIdOf, dailyStatus, formatPreview) plus a thin live layer
// (gather, liveSweepDeps). The preview writes nothing. `asked` and `declined` write only
// <ORCA_FLOW_DIR>/sweep/<coordinator>.json. `remove` writes nothing of ours: it only calls Orca's rm.
// No git fetch anywhere: base and upstream refs are the local ones and may be stale, which can only
// make a worktree look less finished, never more. No dependencies.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { orcaRunner, readRoutes, UsageError } from './dispatch.mjs'

export const COORDINATOR_ROOT = join(homedir(), 'orca', 'coordinators')
const COORDINATOR_FILE = 'coordinator.json'
/** Asks older than this do not count for the daily review. */
export const DAY_MS = 24 * 60 * 60_000
/** Dispatch states after which the agent no longer holds its task (src/coordinators.ts SETTLED). */
const SETTLED = new Set(['succeeded', 'failed', 'abandoned', 'cancelled', 'canceled', 'stopped', 'completed'])

// ---------- small helpers ----------

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write via a temp file and rename, so no reader sees half a file (orca-flow.mjs writeJson). */
function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

const fileKey = (key) => key.replace(/[^A-Za-z0-9._-]/g, '_')
const short = (sha) => (sha ? sha.slice(0, 7) : '?')
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const branchName = (ref) => (ref ? ref.replace(/^refs\/heads\//, '') : '')
/** repo/name; a checkout Orca names after its repo (a temporary clone) goes by its folder instead. */
const nameOf = (row) => {
  const folder = row.path?.split('/').pop()
  const name = row.displayName && (row.displayName !== row.repo || row.isMainWorktree) ? row.displayName : folder || row.displayName || row.worktreeId
  return `${row.repo}/${name}`
}

/** owner/repo of a GitHub remote or PR url, lower-cased; null when it is not one. */
export function githubRepo(url) {
  const m = /github\.com[:/]+([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/pull\/\d+.*)?\/?$/i.exec(String(url ?? '').trim())
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

// ---------- coordinators ----------

/**
 * The user's coordinators from their folders (the fields src/coordinators.ts readCoordinators reads):
 * name, folder, repos, and every terminal a session member ever ran in (its own runs' handles).
 */
export function readCoordinatorFiles(root = COORDINATOR_ROOT) {
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry)
    const c = readJson(join(dir, COORDINATOR_FILE), null)
    if (!c?.name) continue
    const members = Array.isArray(c.sessions?.members) ? c.sessions.members : []
    const terminals = members.flatMap((m) => [...(Array.isArray(m.terminals) ? m.terminals : []), ...(Array.isArray(m.bindings) ? m.bindings.map((b) => b?.terminal) : [])]).filter((t) => typeof t === 'string')
    const workspaceIds = members.map((m) => m.workspaceId).filter((w) => typeof w === 'string')
    out.push({ name: c.name, dir, repos: Array.isArray(c.repos) ? c.repos : [], terminals: [...new Set(terminals)], workspaceIds: [...new Set(workspaceIds)] })
  }
  return out
}

/** The coordinator whose coordinator.json is in `cwd` or a parent (like coordinatorScope()), by name. */
export function coordinatorFromCwd(cwd) {
  let dir = cwd
  while (dir && dir !== '/') {
    const c = readJson(join(dir, COORDINATOR_FILE), null)
    if (c?.name) return c.name
    dir = join(dir, '..')
  }
  return null
}

// ---------- dispatch facts ----------

const livenessOf = (d) => {
  const verdict = d.projection?.liveness?.verdict
  if (verdict === 'live') return 'live'
  if (verdict === 'exited' || d.terminalState === 'released') return 'dead'
  return 'unknown'
}
const settledOf = (d) => SETTLED.has(d.workerState) || SETTLED.has(d.dispatchStatus) || ['succeeded', 'failed'].includes(d.projection?.outcome)
const succeededOf = (d) => d.workerState === 'succeeded' || d.projection?.outcome === 'succeeded'
const worktreeOfDispatch = (d) => d.resource?.worktreeId ?? d.projection?.workspace?.id ?? null
const dispatchState = (d) => `${d.workerState ?? '?'}/${d.dispatchStatus ?? '?'}, terminal ${d.terminalState ?? 'unknown'}, liveness ${d.projection?.liveness?.verdict ?? 'unknown'}`

// ---------- classification (pure) ----------

/**
 * The shared context every row is judged against: who owns which terminal and workspace, and the
 * dispatches by worktree. Pure.
 */
function contextOf(facts) {
  const { coordinators, ps, dispatches, runs, routes = [], owners = {}, terminalDirs = {}, cleanup } = facts
  const rows = ps?.worktrees ?? []
  const rowsById = new Map(rows.map((r) => [r.worktreeId, r]))
  const byDir = new Map(coordinators.map((c) => [c.dir, c.name]))
  const homeIdOf = new Map()
  for (const r of rows) if (byDir.has(r.path)) homeIdOf.set(r.worktreeId, byDir.get(r.path))
  for (const c of coordinators) for (const w of c.workspaceIds) homeIdOf.set(w, c.name)
  const coordinatorOfTerminal = new Map()
  for (const [handle, dir] of Object.entries(terminalDirs)) if (byDir.has(dir)) coordinatorOfTerminal.set(handle, byDir.get(dir))
  // Session membership is the stronger record: it wins over the folder a terminal ran in.
  for (const c of coordinators) for (const t of c.terminals) coordinatorOfTerminal.set(t, c.name)
  const runHandle = new Map((runs ?? []).map((r) => [r.id, r.coordinator_handle]))
  const byWorktree = new Map()
  const byTerminal = new Map()
  for (const d of dispatches ?? []) {
    const w = worktreeOfDispatch(d)
    if (w) byWorktree.set(w, [...(byWorktree.get(w) ?? []), d])
    if (d.agentTerminalHandle) byTerminal.set(d.agentTerminalHandle, [...(byTerminal.get(d.agentTerminalHandle) ?? []), d])
  }
  const leadRoutes = new Map()
  for (const r of routes) if (r?.role === 'lead' && r.workspace) leadRoutes.set(r.workspace, [...(leadRoutes.get(r.workspace) ?? []), r])
  const hostEval = cleanup ? new Map((cleanup.rows ?? []).map((r) => [r.worktreeId, r.evaluation ?? {}])) : null
  return { ...facts, rows, rowsById, homeIdOf, coordinatorOfTerminal, runHandle, byWorktree, byTerminal, leadRoutes, owners, hostEval }
}

/** The coordinator a dispatch works for: its run's terminal, or (a lead's run) the lead's own dispatch's. */
function coordinatorOfDispatch(ctx, d, depth = 0) {
  const handle = ctx.runHandle.get(d.runId)
  if (!handle || depth > 4) return null
  const direct = ctx.coordinatorOfTerminal.get(handle)
  if (direct) return direct
  for (const parent of ctx.byTerminal.get(handle) ?? []) {
    if (parent === d) continue
    const c = coordinatorOfDispatch(ctx, parent, depth + 1)
    if (c) return c
  }
  return null
}

/** Every piece of owner evidence for a worktree: [{ coordinator, how }]. Pure. */
export function ownerEvidence(ctx, row, depth = 0) {
  const out = []
  const parent = row.parentWorktreeId
  if (parent && depth <= 4) {
    if (ctx.homeIdOf.has(parent)) out.push({ coordinator: ctx.homeIdOf.get(parent), how: 'Orca parent workspace is its home' })
    else if (ctx.rowsById.has(parent)) for (const e of ownerEvidence(ctx, ctx.rowsById.get(parent), depth + 1)) out.push({ coordinator: e.coordinator, how: `via parent worktree ${nameOf(ctx.rowsById.get(parent))}: ${e.how}` })
  }
  for (const d of ctx.byWorktree.get(row.worktreeId) ?? []) {
    const c = coordinatorOfDispatch(ctx, d)
    if (c) out.push({ coordinator: c, how: `dispatch ${d.dispatchId} in run ${d.runId}` })
  }
  for (const a of row.agents ?? []) {
    const o = ctx.owners[a.orcaSessionId] ?? ctx.owners[a.paneKey]
    if (o?.coordinator && ctx.coordinators.some((c) => c.name === o.coordinator)) out.push({ coordinator: o.coordinator, how: 'remembered owner of its agent (owners.json)' })
  }
  return out
}

/** The lead of this worktree: the routes.jsonl lead start, matched to Orca's dispatch records. */
function leadOf(ctx, row) {
  const routes = ctx.leadRoutes.get(row.worktreeId) ?? []
  if (!routes.length) return null
  const tasks = new Set(routes.map((r) => r.taskId).filter(Boolean))
  const ids = new Set(routes.map((r) => r.dispatchId).filter(Boolean))
  // worker-list is newest first: the first match is the latest attempt (a resume or retry included).
  const records = (ctx.byWorktree.get(row.worktreeId) ?? []).filter((d) => tasks.has(d.taskId) || ids.has(d.dispatchId))
  const latestRoute = routes[routes.length - 1]
  const latest = records[0] ?? null
  if (!latest) return { taskId: latestRoute.taskId, dispatchId: latestRoute.dispatchId, record: null, liveness: 'unknown', settled: false, succeeded: false }
  return { taskId: latest.taskId, dispatchId: latest.dispatchId, record: latest, liveness: livenessOf(latest), settled: settledOf(latest), succeeded: succeededOf(latest) }
}

/** Reasons a worktree is outside the sweep before any git fact: [{ kind, reason }]. Pure. */
function staticSkips(ctx, row, me) {
  const out = []
  const add = (kind, reason) => out.push({ kind, reason })
  if (row.hostId && row.hostId !== 'local') add('remote', `on host ${row.hostId}, not this machine`)
  if (isHome(row.path, ctx)) add('home', 'a coordinator home')
  if (row.workspaceKind !== 'git') add('folder', `a ${row.workspaceKind ?? 'non-git'} workspace, not a git worktree`)
  if (row.isMainWorktree) add('main', 'the main checkout')
  if (row.isPinned) add('pinned', 'pinned')
  if (row.isArchived) add('archived', 'archived')
  if (row.defaultBranch) add('default-branch', 'on the default branch')
  if (me.repos.length && !me.repos.includes(row.repo)) add('scope', `${row.repo} is not in ${me.name}'s repos`)
  const ev = ctx.hostEval?.get(row.worktreeId)
  if (ev && ev.cause && ev.cause !== 'rules-off' && ev.action !== 'remove') add('protected', `Orca's cleanup keeps it (${ev.cause})`)
  return out
}

function isHome(path, ctx) {
  if (!path) return false
  const root = ctx.coordinatorRoot ?? COORDINATOR_ROOT
  return path === root || path.startsWith(`${root}/`) || ctx.coordinators.some((c) => c.dir === path) || existsSync(join(path, COORDINATOR_FILE))
}

/** Why the worktree is in use right now, from Orca's row and its dispatches. Pure. */
function activeReasons(ctx, row) {
  const out = []
  if (row.liveTerminalCount > 0) out.push(`${plural(row.liveTerminalCount, 'live terminal')}`)
  if (row.unverifiableTerminalCount > 0) out.push(`${plural(row.unverifiableTerminalCount, 'terminal')} Orca cannot verify`)
  if (row.hasAttachedPty) out.push('an attached terminal')
  if (row.agents?.length) out.push(`${plural(row.agents.length, 'agent')} listed`)
  if (row.childWorktreeIds?.length) out.push(`${plural(row.childWorktreeIds.length, 'child worktree')}`)
  for (const d of ctx.byWorktree.get(row.worktreeId) ?? []) if (livenessOf(d) === 'live') out.push(`dispatch ${d.dispatchId} is live`)
  return out
}

/** Which rows need git (and maybe PR) facts: owned, local, idle, unprotected. Pure; gather uses it. */
export function needsFacts(facts) {
  const ctx = contextOf(facts)
  const me = ctx.coordinators.find((c) => c.name === facts.coordinator)
  return ctx.rows.filter((row) => !staticSkips(ctx, row, me).length && !activeReasons(ctx, row).length && ownership(ctx, row, me).owned)
}

function ownership(ctx, row, me) {
  const evidence = ownerEvidence(ctx, row)
  const names = [...new Set(evidence.map((e) => e.coordinator))]
  if (names.length === 1 && names[0] === me.name) return { owned: true, evidence }
  if (names.length > 1) return { owned: false, kind: 'ambiguous', reason: `conflicting lineage: ${names.join(' and ')}`, evidence }
  if (names.length === 1) return { owned: false, kind: 'other-owner', reason: `owned by ${names[0]}`, evidence }
  return { owned: false, kind: 'unowned', reason: 'no owner evidence: no Orca parent workspace, no dispatch from a coordinator run, no remembered agent owner', evidence }
}

/**
 * What git and the PR prove about the work: open facts (work still to do), missing facts (what
 * could not be proven) and, when proven, how it is integrated. Pure.
 */
export function workState(row, git, pr) {
  const open = []
  const missing = []
  const linked = row.linkedPR ?? null
  if (!git || git.error) return { open, missing: [`git facts unavailable${git?.error ? `: ${git.error}` : ''}`], integrated: null }
  if (git.dirty > 0) open.push(`${plural(git.dirty, 'changed file')} not committed`)
  if (git.untracked > 0) open.push(`${plural(git.untracked, 'untracked file')}`)
  if (!git.branchRef) missing.push('detached HEAD: no branch to compare')
  if (!git.originUrl) missing.push('no origin remote')
  else if (!githubRepo(git.originUrl) && linked) missing.push(`origin ${git.originUrl} is not a GitHub remote the PR can be matched to`)
  if (!git.baseRef) missing.push('base ref missing (refs/remotes/origin/HEAD not set)')
  if (git.upstream && git.unpushed > 0) open.push(`${plural(git.unpushed, 'unpushed commit')} (ahead of ${git.upstream.replace(/^refs\/remotes\//, '')})`)
  if (linked && (linked.state === 'open' || linked.state === 'draft')) open.push(`PR #${linked.number} is ${linked.state}`)

  let integrated = null
  if (git.branchRef && git.baseRef && git.inBase === true) integrated = { how: `no commits beyond ${git.baseRef.replace(/^refs\/remotes\//, '')}` }
  else if (linked?.state === 'merged') {
    const prMissing = []
    if (!pr || pr.error) prMissing.push(`PR #${linked.number} metadata unavailable${pr?.error ? ` (${pr.error})` : ''}`)
    else {
      if (String(pr.state).toUpperCase() !== 'MERGED') prMissing.push(`gh says PR #${linked.number} is ${String(pr.state).toLowerCase()}, not merged`)
      const prRepo = githubRepo(pr.url ?? linked.url)
      const originRepo = githubRepo(git.originUrl)
      if (!prRepo || !originRepo || prRepo !== originRepo) prMissing.push(`PR repo ${prRepo ?? '?'} does not match origin ${originRepo ?? git.originUrl ?? '?'}`)
      if (pr.headRefName !== branchName(git.branchRef)) prMissing.push(`PR head branch ${pr.headRefName ?? '?'} is not the local branch ${branchName(git.branchRef) || '(detached)'}`)
      if (!pr.headRefOid) prMissing.push('PR head commit unknown')
      else if (git.prHeadPresent === false) prMissing.push(`PR head ${short(pr.headRefOid)} is not in the local repo (not fetched)`)
      else if (git.headInPrHead === false) open.push(`merged PR #${linked.number} with newer local commits (HEAD ${short(git.head)} is not in the PR head ${short(pr.headRefOid)})`)
      else if (git.headInPrHead !== true) prMissing.push('could not compare HEAD with the PR head')
      if (git.upstream && git.upstreamBeyondPr > 0) open.push(`${git.upstream.replace(/^refs\/remotes\//, '')} has ${plural(git.upstreamBeyondPr, 'commit')} the merged PR lacks`)
      else if (git.upstream && git.upstreamBeyondPr == null && git.headInPrHead === true) prMissing.push('could not compare the upstream with the PR head')
    }
    if (!prMissing.length && !open.length) integrated = { how: `PR #${linked.number} merged and HEAD ${git.head === pr.headRefOid ? 'is' : 'is in'} its head ${short(pr.headRefOid)} (squash-safe)` }
    missing.push(...prMissing)
  }
  if (!integrated && git.baseRef && git.inBase === false && git.beyondBase > 0) {
    if (!linked) open.push(`${plural(git.beyondBase, 'commit')} beyond ${git.baseRef.replace(/^refs\/remotes\//, '')}, no PR linked${git.upstream ? '' : ', no upstream'}`)
    else if (linked.state === 'closed') open.push(`PR #${linked.number} closed unmerged with ${plural(git.beyondBase, 'commit')} beyond ${git.baseRef.replace(/^refs\/remotes\//, '')}`)
    else if (linked.state !== 'merged' && !open.some((o) => o.startsWith(`PR #${linked.number}`))) open.push(`${plural(git.beyondBase, 'commit')} beyond base, PR #${linked.number} ${linked.state}`)
  }
  if (!integrated && git.baseRef && git.inBase == null) missing.push(`could not compare HEAD with ${git.baseRef}`)
  return { open, missing, integrated: open.length ? null : integrated }
}

/** One recovery recommendation for an interrupted lead. Never run by the sweep. Pure. */
export function recoveryOf(lead, row) {
  const d = lead.record
  const next = d?.projection?.nextAction
  const resume = `orca orchestration send --to dispatch:${lead.dispatchId} --subject "Resume your workstream" --body "Your session ended before you reported (Orca restarted or your coordinator slept). Check this worktree's state, finish the task, then send worker_done."`
  const out = { kind: 'resume', command: resume, why: 'resume the exact lead: it reopens with its whole conversation' }
  const failed = d && settledOf(d) && !succeededOf(d)
  const orcaAllows = next && next.kind && !['none', 'release'].includes(next.kind)
  if (failed || orcaAllows) {
    out.alternative = {
      kind: 'reassign',
      command: `orca-flow dispatch --role lead --task ${lead.taskId} --retry-of ${lead.dispatchId} --worktree id:${row.worktreeId} --keep-open`,
      why: `${failed ? 'the attempt settled as failed' : `Orca's next action is ${next.kind}`}; only if resuming does not work. Capacity gate: dispatch checks memory first and refuses with exit 2 when there is no room.`
    }
  }
  return out
}

/** Pure: every worktree Orca listed, in exactly one bucket, with reasons. */
export function classify(facts) {
  const ctx = contextOf(facts)
  const me = ctx.coordinators.find((c) => c.name === facts.coordinator)
  if (!me) throw new UsageError(`no coordinator named ${facts.coordinator}`)
  const declined = facts.state?.declined ?? {}
  const buckets = { finished: [], interrupted: [], unclear: [], skipped: [] }
  const incomplete = []
  const notes = [...(facts.notes ?? [])]
  if (facts.ps?.truncated) incomplete.push(`Orca listed ${ctx.rows.length} of ${facts.ps.totalCount ?? '?'} worktrees (truncated)`)
  for (const h of facts.ps?.hostScope?.omittedHostSelectors ?? (facts.ps?.hostScope?.omittedHostIds ?? []).map((hostId) => ({ hostId }))) incomplete.push(`host ${h.hostId}${h.selector ? ` (${h.selector})` : ''} was not covered`)
  if (!facts.dispatches) notes.push('Orca dispatch records unavailable: no worktree can be proven idle or lead-free')
  if (!facts.cleanup) notes.push("Orca's cleanup preview unavailable: its protection signal was not used")

  for (const row of ctx.rows) {
    const base = { worktreeId: row.worktreeId, selector: `id:${row.worktreeId}`, name: nameOf(row), path: row.path, branch: branchName(row.branch) || null, pr: row.linkedPR ? { number: row.linkedPR.number, state: row.linkedPR.state, url: row.linkedPR.url } : null }
    const skip = (kind, reasons, extra = {}) => buckets.skipped.push({ ...base, kind, reasons, ...extra })
    const statics = staticSkips(ctx, row, me)
    const own = ownership(ctx, row, me)
    const owner = { evidence: own.evidence.map((e) => `${e.coordinator}: ${e.how}`) }
    if (statics.length) {
      skip(statics[0].kind, statics.map((s) => s.reason))
      continue
    }
    if (!own.owned && own.kind !== 'unowned') {
      skip(own.kind, [own.reason], { owner })
      continue
    }
    const active = activeReasons(ctx, row)
    if (active.length) {
      skip('active', active, { owner })
      continue
    }
    if (!own.owned) {
      // No lineage at all is unclear only inside an explicit scope; with every repo in scope it is noise.
      if (me.repos.length) buckets.unclear.push({ ...base, reasons: [own.reason], missing: ['owner evidence'], owner })
      else skip('unowned', [own.reason], { owner })
      continue
    }
    const git = facts.gitOf?.[row.worktreeId]
    const pr = row.linkedPR?.url ? facts.prOf?.[row.linkedPR.url] : null
    if (git?.baseBranch && branchName(row.branch) === git.baseBranch) {
      skip('default-branch', [`on ${git.baseBranch}, origin's default branch`], { owner })
      continue
    }
    const item = { ...base, head: git?.head ?? null, owner }
    if (!facts.dispatches) {
      buckets.unclear.push({ ...item, reasons: ['Orca dispatch records unavailable: cannot prove no agent holds it'], missing: ['dispatch records'] })
      continue
    }
    const dispatches = ctx.byWorktree.get(row.worktreeId) ?? []
    const lead = leadOf(ctx, row)
    const leadInfo = lead && { taskId: lead.taskId, dispatchId: lead.dispatchId, state: lead.record ? dispatchState(lead.record) : 'no Orca record found', nextAction: lead.record?.projection?.nextAction ?? null, liveness: lead.liveness, settled: lead.settled, succeeded: lead.succeeded }
    // Liveness Orca cannot verify on an attempt that never settled (or a lead's last attempt): wait.
    const unknown = dispatches.filter((d) => livenessOf(d) === 'unknown' && !settledOf(d))
    if (lead && !lead.record) {
      buckets.unclear.push({ ...item, reasons: [`routes.jsonl names lead dispatch ${lead.dispatchId} (task ${lead.taskId}) but Orca has no record of it`], missing: ["Orca's record of the lead dispatch"], lead: leadInfo })
      continue
    }
    const leadUnknown = lead && !lead.succeeded && lead.liveness === 'unknown'
    if (unknown.length || leadUnknown) {
      const which = leadUnknown ? `lead dispatch ${lead.dispatchId} (${leadInfo.state})` : unknown.map((d) => `dispatch ${d.dispatchId} (${dispatchState(d)})`).join(', ')
      buckets.unclear.push({ ...item, reasons: [`liveness unknown: ${which}`], missing: ['proof the agent is gone'], lead: leadInfo, recovery: { kind: 'wait', why: 'do not launch a duplicate; check again' } })
      continue
    }
    const work = workState(row, git, pr)
    const leadFailed = lead && !lead.succeeded
    if (work.integrated) {
      if (leadFailed) {
        buckets.unclear.push({ ...item, reasons: [`work looks integrated (${work.integrated.how}) but lead ${lead.taskId} never reported success (${leadInfo.state}): confirm it is done, or resume it, before removal`], missing: ["the lead's report"], lead: leadInfo })
        continue
      }
      const kept = declined[row.worktreeId]
      if (kept && kept.head === git.head) {
        skip('user-kept', [`user kept it (said no to batch ${kept.batch} on ${String(kept.at).slice(0, 10)}); asked again when HEAD moves`], { owner, head: git.head })
        continue
      }
      buckets.finished.push({ ...item, reasons: [work.integrated.how, 'clean (no changes, no untracked files)', 'no live agent, terminal or child worktree'], ...(lead ? { lead: leadInfo } : {}) })
      continue
    }
    if (work.open.length) {
      if (lead && !lead.succeeded && lead.liveness === 'dead') {
        buckets.interrupted.push({ ...item, reasons: [`lead ${lead.taskId} died without reporting success (${leadInfo.state})`, ...work.open.map((o) => `open: ${o}`)], open: work.open, missing: work.missing, lead: leadInfo, recovery: recoveryOf(lead, row) })
      } else if (lead?.succeeded) {
        buckets.unclear.push({ ...item, reasons: [`lead ${lead.taskId} reported succeeded but work is still open: ${work.open.join('; ')}`], open: work.open, missing: [...work.missing, 'why the work is still open'], lead: leadInfo })
      } else {
        buckets.unclear.push({ ...item, reasons: [`work still open and no saved lead dispatch: ${work.open.join('; ')}`], open: work.open, missing: [...work.missing, 'a lead to resume (routes.jsonl has none for this worktree)'] })
      }
      continue
    }
    buckets.unclear.push({ ...item, reasons: [`cannot prove it is integrated: ${work.missing.join('; ') || 'no integration fact'}`], missing: work.missing, ...(lead ? { lead: leadInfo } : {}) })
  }
  const skippedSummary = {}
  for (const s of buckets.skipped) skippedSummary[s.kind] = (skippedSummary[s.kind] ?? 0) + 1
  const batch = buckets.finished.length ? { id: batchIdOf(buckets.finished), items: buckets.finished.map((f) => ({ worktreeId: f.worktreeId, name: f.name, head: f.head, pr: f.pr })) } : null
  return { coordinator: me.name, scope: me.repos.length ? me.repos : 'all', incomplete, notes, buckets, skippedSummary, batch }
}

/** A short hash of the finished set: worktree id, HEAD and PR number/state, sorted. */
export function batchIdOf(finished) {
  const lines = finished.map((f) => `${f.worktreeId}|${f.head ?? ''}|${f.pr?.number ?? ''}|${f.pr?.state ?? ''}`).sort()
  return `sweep-${createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 10)}`
}

const itemKey = (i) => `${i.worktreeId}@${i.head}`

/** 'due' | 'done today' | 'nothing to ask': due when nothing was offered in 24 h or new candidates appeared. Pure. */
export function dailyStatus(state, batch, now) {
  if (!batch) return 'nothing to ask'
  const recent = (state?.asked ?? []).filter((a) => now - Date.parse(a.at) < DAY_MS)
  if (!recent.length) return 'due'
  const offered = new Set(recent.flatMap((a) => a.items ?? []))
  return batch.items.every((i) => offered.has(itemKey(i))) ? 'done today' : 'due'
}

// ---------- text ----------

const SKIP_WORDS = { scope: 'not in scope', 'other-owner': "another coordinator's", ambiguous: 'conflicting lineage', unowned: 'no owner evidence', home: 'coordinator homes', main: 'main checkouts', pinned: 'pinned', archived: 'archived', folder: 'folder workspaces', remote: 'other hosts', 'default-branch': 'on the default branch', protected: "kept by Orca's cleanup", active: 'active', 'user-kept': 'user kept' }

export function formatPreview(p) {
  const out = [`Sweep for ${p.coordinator} (scope: ${p.scope === 'all' ? 'all repos' : p.scope.join(', ')}). Git facts from local refs, not fetched: a stale base can only hold a worktree back.`]
  if (p.incomplete.length) out.push(`INCOMPLETE: ${p.incomplete.join('; ')}.`)
  for (const n of p.notes) out.push(`note: ${n}`)
  const { finished, interrupted, unclear, skipped } = p.buckets
  out.push('', `finished (${finished.length}): removal candidates`)
  for (const f of finished) out.push(`  ${f.name} @ ${short(f.head)}${f.pr ? ` · PR #${f.pr.number} ${f.pr.state}` : ''}: ${f.reasons.join('; ')}`)
  out.push('', `interrupted (${interrupted.length}): unfinished leads to recover`)
  for (const i of interrupted) {
    out.push(`  ${i.name}${i.pr ? ` · PR #${i.pr.number} ${i.pr.state}` : ''}: ${i.reasons.join('; ')}`)
    out.push(`    lead: task ${i.lead.taskId} · dispatch ${i.lead.dispatchId} · Orca next action: ${i.lead.nextAction?.kind ?? 'unknown'}`)
    out.push(`    recovery (${i.recovery.kind}): ${i.recovery.command}`)
    if (i.recovery.alternative) out.push(`    or (${i.recovery.alternative.kind}): ${i.recovery.alternative.command} — ${i.recovery.alternative.why}`)
  }
  out.push('', `unclear (${unclear.length}): not enough evidence`)
  for (const u of unclear) out.push(`  ${u.name}: ${u.reasons.join('; ')}${u.recovery?.kind === 'wait' ? ' → wait: do not launch a duplicate; check again' : ''}`)
  const parts = Object.entries(p.skippedSummary).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${SKIP_WORDS[k] ?? k}`)
  out.push('', `skipped (${skipped.length})${parts.length ? `: ${parts.join(', ')}` : ''}`)
  const named = skipped.filter((s) => ['active', 'ambiguous', 'user-kept', 'protected'].includes(s.kind))
  for (const s of named) out.push(`  ${s.name}: ${s.reasons.join('; ')}`)
  out.push('', `daily review: ${p.daily}`)
  if (p.batch) {
    out.push(`Batch ${p.batch.id}: remove ${plural(p.batch.items.length, 'finished worktree')} (${p.batch.items.map((i) => i.name).join(', ')}), local branches kept.`)
    out.push(`Ask the user once: "Remove these ${plural(p.batch.items.length, 'finished worktree')} (batch ${p.batch.id})? yes or no"`)
    out.push(`  after asking: orca-flow sweep asked --batch ${p.batch.id}`)
    out.push(`  yes: orca-flow sweep remove --batch ${p.batch.id}`)
    out.push(`  no:  orca-flow sweep declined --batch ${p.batch.id}`)
  } else out.push('No batch: nothing is proven finished.')
  return out.join('\n')
}

// ---------- state (the only writes: asked, declined) ----------

export const statePath = (dir, coordinator) => join(dir, 'sweep', `${fileKey(coordinator)}.json`)
export function readSweepState(dir, coordinator) {
  const s = readJson(statePath(dir, coordinator), null)
  return { version: 1, coordinator, asked: Array.isArray(s?.asked) ? s.asked : [], declined: s?.declined && typeof s.declined === 'object' ? s.declined : {} }
}

// ---------- live facts ----------

/**
 * Every fact classify needs, read-only: Orca's worktrees, dispatches, runs and cleanup preview,
 * routes.jsonl, owners.json, then git (and gh for merged PRs) only for the rows that can still be
 * finished or interrupted.
 */
export async function gather(deps, coordinator) {
  const notes = []
  const coordinators = deps.coordinators()
  if (!coordinators.some((c) => c.name === coordinator)) throw new UsageError(`no coordinator named ${coordinator} (known: ${coordinators.map((c) => c.name).join(', ') || 'none'})`)
  const ps = await deps.orca(['worktree', 'ps'])
  const dispatches = await pageAll(deps, ['orchestration', 'worker-list', '--full', '--limit', '100'], (r) => r.workers, (r) => (r.page?.hasMore ? r.page.nextCursor : null)).catch((e) => {
    notes.push(`worker-list failed: ${e.message}`)
    return null
  })
  const runs = await pageAll(deps, ['orchestration', 'run-list', '--full', '--limit', '100'], (r) => r.runs, (r) => r.nextCursor ?? null).catch((e) => {
    notes.push(`run-list failed: ${e.message}; dispatch ownership not used`)
    return []
  })
  const cleanup = await deps.orca(['workspace', 'cleanup', 'preview']).catch(() => null)
  const routes = deps.routes()
  const owners = deps.owners()
  const state = readSweepState(deps.dir, coordinator)
  const facts = { coordinator, coordinators, coordinatorRoot: deps.coordinatorRoot, ps, dispatches, runs, cleanup, routes, owners, terminalDirs: {}, state, notes, gitOf: {}, prOf: {} }
  // Legacy lineage: a run's terminal no coordinator lists as a member is matched by the folder it ran in.
  const known = new Set(coordinators.flatMap((c) => c.terminals))
  const handles = [...new Set((runs ?? []).map((r) => r.coordinator_handle).filter((h) => h && !known.has(h)))]
  for (const h of handles) {
    const t = await deps.orca(['terminal', 'show', '--terminal', h]).then((r) => r.terminal).catch(() => null)
    const dir = t?.worktreePath || t?.worktreeId?.split('::')[1]
    if (dir) facts.terminalDirs[h] = dir
  }
  for (const row of needsFacts(facts)) await factsFor(deps, facts, row)
  return facts
}

/** Git facts for one row, and the PR's when its linked PR is merged and HEAD is not already in base. */
async function factsFor(deps, facts, row) {
  let git = await gitFacts(deps.git, row.path)
  const pr = row.linkedPR
  if (pr?.url && pr.state === 'merged' && !git.error && git.inBase !== true) {
    const view = await deps.gh(['pr', 'view', pr.url, '--json', 'state,headRefName,headRefOid,mergedAt,baseRefName,url,number']).then((s) => JSON.parse(s)).catch((e) => ({ error: e.message?.split('\n')[0] || 'gh failed' }))
    facts.prOf[pr.url] = view
    if (view.headRefOid) git = await gitFacts(deps.git, row.path, view.headRefOid)
  }
  facts.gitOf[row.worktreeId] = git
}

async function pageAll(deps, args, items, next) {
  const out = []
  let cursor = null
  for (let i = 0; i < 50; i++) {
    const r = await deps.orca(cursor ? [...args, '--cursor', cursor] : args)
    out.push(...(items(r) ?? []))
    cursor = next(r)
    if (!cursor) return out
  }
  return out
}

/**
 * What git says about a worktree, local refs only. `git(cwd, args)` resolves { code, stdout }.
 * With `prHead`, also whether HEAD and the upstream are inside that commit.
 */
export async function gitFacts(git, path, prHead = null) {
  const run = async (args) => {
    const r = await git(path, args)
    return { code: r.code, out: String(r.stdout ?? '').trim() }
  }
  const head = await run(['rev-parse', '--verify', '-q', 'HEAD'])
  if (head.code !== 0) return { error: `git rev-parse HEAD failed in ${path}` }
  const sym = await run(['symbolic-ref', '-q', 'HEAD'])
  const status = await run(['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.code !== 0) return { error: `git status failed in ${path}` }
  const lines = status.out ? status.out.split('\n') : []
  const origin = await run(['config', '--get', 'remote.origin.url'])
  const baseSym = await run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
  const baseRef = baseSym.code === 0 && baseSym.out ? baseSym.out : null
  const ancestor = async (a, b) => {
    const r = await run(['merge-base', '--is-ancestor', a, b])
    return r.code === 0 ? true : r.code === 1 ? false : null
  }
  const count = async (range) => {
    const r = await run(['rev-list', '--count', range])
    return r.code === 0 ? Number(r.out) : null
  }
  const branchRef = sym.code === 0 && sym.out ? sym.out : null
  let upstream = null
  if (branchRef) {
    const u = await run(['for-each-ref', '--format=%(upstream)', branchRef])
    const ref = u.code === 0 && u.out ? u.out : null
    if (ref && (await run(['rev-parse', '--verify', '-q', ref])).code === 0) upstream = ref
  }
  const facts = {
    head: head.out,
    branchRef,
    dirty: lines.filter((l) => !l.startsWith('??')).length,
    untracked: lines.filter((l) => l.startsWith('??')).length,
    originUrl: origin.code === 0 && origin.out ? origin.out : null,
    baseRef,
    baseBranch: baseRef ? baseRef.replace(/^refs\/remotes\/origin\//, '') : null,
    inBase: baseRef ? await ancestor('HEAD', baseRef) : null,
    beyondBase: baseRef ? await count(`${baseRef}..HEAD`) : null,
    upstream,
    unpushed: upstream ? await count(`${upstream}..HEAD`) : null
  }
  if (prHead) {
    facts.prHeadPresent = (await run(['cat-file', '-e', `${prHead}^{commit}`])).code === 0
    if (facts.prHeadPresent) {
      facts.headInPrHead = await ancestor('HEAD', prHead)
      facts.upstreamBeyondPr = upstream ? await count(`${prHead}..${upstream}`) : null
    }
  }
  return facts
}

// ---------- commands ----------

/** `orca-flow sweep [asked|declined|remove] ...`: returns the exit code. */
export async function sweepCommand(args, deps) {
  const [, sub] = args._
  const coordinator = typeof args.coordinator === 'string' ? args.coordinator : coordinatorFromCwd(deps.cwd)
  if (!coordinator) throw new UsageError('orca-flow sweep: run it in a coordinator folder, or pass --coordinator <name>')
  const preview = async () => {
    const facts = await gather(deps, coordinator)
    const p = classify(facts)
    p.daily = dailyStatus(facts.state, p.batch, deps.now().getTime())
    return { facts, p }
  }
  if (!sub) {
    const { p } = await preview()
    deps.out(args.json ? JSON.stringify(p, null, 2) : formatPreview(p))
    return 0
  }
  if (!['asked', 'declined', 'remove'].includes(sub)) throw new UsageError('usage: orca-flow sweep [asked|declined|remove --batch <id>] [--coordinator <name>] [--json]')
  const want = typeof args.batch === 'string' ? args.batch : null
  if (!want) throw new UsageError(`orca-flow sweep ${sub} needs --batch <id> (the id the preview printed)`)
  const { facts, p } = await preview()
  if (!p.batch || p.batch.id !== want) {
    deps.out(`Batch ${want} no longer matches the finished worktrees${p.batch ? `: they are now batch ${p.batch.id} (${p.batch.items.map((i) => i.name).join(', ')})` : ': none are finished now'}. Nothing ${sub === 'remove' ? 'removed' : 'recorded'}. Run orca-flow sweep and ask about the current batch.`)
    return 2
  }
  if (sub === 'asked' || sub === 'declined') {
    const state = readSweepState(deps.dir, coordinator)
    const at = deps.now().toISOString()
    if (sub === 'asked') state.asked = [...state.asked, { batch: want, at, items: p.batch.items.map(itemKey) }].slice(-30)
    else for (const i of p.batch.items) state.declined[i.worktreeId] = { head: i.head, batch: want, at }
    writeJson(statePath(deps.dir, coordinator), state)
    deps.out(sub === 'asked' ? `Recorded: batch ${want} offered at ${at}.` : `Recorded: the user keeps ${p.batch.items.map((i) => i.name).join(', ')}; not asked again until HEAD changes.`)
    return 0
  }
  return removeBatch(deps, facts, p, want)
}

/**
 * Removes the batch one worktree at a time. Each item is rechecked alone against fresh facts (its
 * ps row, git status and HEAD, PR state) right before its rm, and skipped if anything changed. A
 * failed rm (an archive hook refusal or any error) stops the batch: reported, never retried or forced.
 */
async function removeBatch(deps, facts, p, batch) {
  const removed = []
  const kept = []
  const items = [...p.buckets.finished]
  for (let n = 0; n < items.length; n++) {
    const item = items[n]
    const ps = await deps.orca(['worktree', 'ps'])
    const row = (ps.worktrees ?? []).find((r) => r.worktreeId === item.worktreeId)
    if (!row) {
      kept.push({ name: item.name, reason: 'Orca no longer lists it' })
      continue
    }
    const fresh = { ...facts, ps, gitOf: { ...facts.gitOf }, prOf: { ...facts.prOf } }
    await factsFor(deps, fresh, row)
    const again = classify(fresh).buckets
    const now = again.finished.find((f) => f.worktreeId === item.worktreeId)
    const why = !now
      ? (() => {
          for (const [bucket, list] of Object.entries(again)) {
            const hit = list.find((f) => f.worktreeId === item.worktreeId)
            if (hit) return `now ${bucket}: ${hit.reasons.join('; ')}`
          }
          return 'no longer finished'
        })()
      : now.head !== item.head
        ? `HEAD moved from ${short(item.head)} to ${short(now.head)}`
        : (now.pr?.number ?? null) !== (item.pr?.number ?? null) || (now.pr?.state ?? null) !== (item.pr?.state ?? null)
          ? `PR changed from ${item.pr ? `#${item.pr.number} ${item.pr.state}` : 'none'} to ${now.pr ? `#${now.pr.number} ${now.pr.state}` : 'none'}`
          : null
    if (why) {
      kept.push({ name: item.name, reason: `changed since the preview, skipped: ${why}` })
      continue
    }
    try {
      await deps.orca(['worktree', 'rm', '--worktree', `id:${item.worktreeId}`, '--run-hooks'])
      removed.push(item.name)
    } catch (e) {
      const hook = e.code === 'worktree_archive_hook_failed'
      kept.push({ name: item.name, reason: `${hook ? 'archive hook failed, Orca kept it' : 'orca worktree rm failed'}: ${e.message}` })
      for (const rest of items.slice(n + 1)) kept.push({ name: rest.name, reason: 'not attempted: the batch stops at the first failed removal (no retry, no --force)' })
      break
    }
  }
  const lines = [`Batch ${batch}: removed ${removed.length}, kept ${kept.length}. Local branches kept; Orca tasks, messages and runs untouched.`]
  for (const r of removed) lines.push(`  removed ${r}`)
  for (const k of kept) lines.push(`  kept ${k.name}: ${k.reason}`)
  deps.out(lines.join('\n'))
  return kept.some((k) => /failed/.test(k.reason)) ? 1 : 0
}

/** The real machine: Orca's CLI, git, gh and the files in ~/.orca-flow. Tests pass fakes instead. */
export function liveSweepDeps({ dir, orcaBin }) {
  const exec = (cmd, args, opts = {}) =>
    new Promise((res) => {
      execFile(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: opts.timeoutMs ?? 20_000, cwd: opts.cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) =>
        res({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr: String(stderr ?? '') })
      )
    })
  return {
    dir,
    cwd: process.cwd(),
    coordinatorRoot: COORDINATOR_ROOT,
    orca: orcaRunner(orcaBin, { timeoutMs: 60_000 }),
    // GIT_OPTIONAL_LOCKS=0: `git status` must not even refresh the index of a worktree it only reads.
    git: (path, args) => exec('git', ['-C', path, ...args]),
    gh: async (args) => {
      const r = await exec('gh', args)
      if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exited ${r.code}`)
      return r.stdout
    },
    coordinators: () => readCoordinatorFiles(COORDINATOR_ROOT),
    routes: () => readRoutes(dir),
    owners: () => readJson(join(dir, 'owners.json'), {}),
    out: (s) => console.log(s),
    now: () => new Date()
  }
}
