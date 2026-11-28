// Paired Orca hosts: the shared contract between the sidebar (src/hosts.ts polls and shows them) and
// `orca-flow hosts` / `orca-flow dispatch --on <host>` (dispatch.mjs checks the target before a start).
//
// Everything here is pure, except `probeHost`, which runs read-only Orca commands through the
// `orca(args) => Promise<result>` runner it is given (dispatch.mjs's orcaRunner shape: resolves to
// the JSON `result`, rejects with the error). Nothing here pairs, wakes, updates or changes a host.
//
// Identity. A host is named by Orca's own host id: `local` for this machine, `runtime:<environment
// id>` for a paired server (the id `orca worktree ps` names under `hostScope.omittedHostIds`). Rows
// a paired server returns call themselves `hostId: 'local'` (local to *that* server), so every join
// re-keys them with `relabelWorktrees` first: worktree ids and agent pane keys get the host id as a
// prefix, so the same repo, branch, path or pane on two hosts never merges.
//
// Facts checked on Orca 1.4.263 (this machine) and 1.4.232 (caca), read-only:
// - `orca environment list --json` lists paired servers (id, name, runtimeId, endpoints); it has no
//   connection state. Pairing secrets are not in it; endpoints are, and are never copied out.
// - `orca status --environment <name> --json`: runtime.{reachable, connectionState, appVersion,
//   capabilities[]}.
// - `orca worktree ps --environment <name> --json`: the server's worktrees, `hostId: 'local'`.
// - `orca agent installed --environment <name> --json`: agents[{id, name, default}].
// - `orca diagnostics memory --environment <name> --json`: host.{totalMemory, availableMemory}
//   (bytes) and a process sweep: a point-in-time scan, so it is polled slowly.
// - The plugin API's workspace.list does NOT list a paired server's workspaces (checked with a
//   probe plugin on 1.4.263): a remote row has no plugin workspace id, so `workspace.open` cannot
//   open it.

export const LOCAL_HOST = 'local'

/** Orca's host id for a paired server. */
export const hostIdOf = (environmentId) => `runtime:${environmentId}`

/** Capabilities a host's `orca status` must list for `worker-start --on` to that host. */
export const REMOTE_WORKER_CAPABILITY = 'orchestration.federation.v1'

/** Probe budgets: one command's timeout, and how stale a success may be before it shows as stale. */
export const PROBE_TIMEOUT_MS = 8_000
export const STALE_AFTER_MS = 3 * 60_000

/** Pure: `environment list` result → paired hosts, without endpoints or pairing data. */
export function pairedHosts(result) {
  const list = Array.isArray(result?.environments) ? result.environments : []
  return list
    .filter((e) => typeof e?.id === 'string' && e.id)
    .map((e) => ({ id: hostIdOf(e.id), environmentId: e.id, name: typeof e.name === 'string' && e.name ? e.name : e.id, runtimeId: typeof e.runtimeId === 'string' ? e.runtimeId : null }))
}

/** Pure: `status --environment` result → reachability, version and capabilities. */
export function statusOf(result) {
  const rt = result?.runtime ?? {}
  const reachable = rt.reachable === true && (rt.connectionState == null || rt.connectionState === 'connected')
  return {
    reachable,
    connectionState: typeof rt.connectionState === 'string' ? rt.connectionState : null,
    version: typeof rt.appVersion === 'string' ? rt.appVersion : null,
    runtimeId: typeof rt.runtimeId === 'string' ? rt.runtimeId : null,
    capabilities: Array.isArray(rt.capabilities) ? rt.capabilities.filter((c) => typeof c === 'string') : []
  }
}

const GB = 1024 ** 3
const gb = (bytes) => (typeof bytes === 'number' && Number.isFinite(bytes) ? Math.round((bytes / GB) * 10) / 10 : null)

/** Pure: `diagnostics memory --environment` result → the host's RAM in GB, or null when absent. */
export function memoryOf(result) {
  const h = result?.host
  if (!h) return null
  const totalGB = gb(h.totalMemory)
  const availableGB = gb(h.availableMemory ?? h.freeMemory)
  if (totalGB == null || availableGB == null) return null
  return { totalGB, availableGB, at: typeof result.collectedAt === 'number' ? result.collectedAt : null }
}

/** Pure: `agent installed --environment` result → the agent ids `--agent` takes there. */
export function agentsOf(result) {
  return (Array.isArray(result?.agents) ? result.agents : []).map((a) => a?.id).filter((id) => typeof id === 'string' && id)
}

/** Pure: a host-scoped key: `<hostId>|<id>`; local ids stay as they are, so local behaviour is unchanged. */
export const hostKey = (hostId, id) => (hostId === LOCAL_HOST || id == null ? id : `${hostId}|${id}`)

/**
 * Pure: a paired server's `worktree ps` rows, re-keyed to that host. Every id a join could use
 * (worktreeId, parentWorktreeId, identity.key, agent paneKey and parentPaneKey) gets the host
 * prefix, `hostId` becomes the host's id and `hostName` its name. Nothing else changes.
 */
export function relabelWorktrees(worktrees, host) {
  return (Array.isArray(worktrees) ? worktrees : []).map((w) => ({
    ...w,
    hostId: host.id,
    hostName: host.name,
    worktreeId: hostKey(host.id, w.worktreeId),
    parentWorktreeId: w.parentWorktreeId ? hostKey(host.id, w.parentWorktreeId) : (w.parentWorktreeId ?? null),
    ...(w.identity?.key ? { identity: { ...w.identity, key: hostKey(host.id, w.identity.key) } } : {}),
    agents: (w.agents ?? []).map((a) => ({
      ...a,
      ...(a.paneKey ? { paneKey: hostKey(host.id, a.paneKey) } : {}),
      ...(a.parentPaneKey ? { parentPaneKey: hostKey(host.id, a.parentPaneKey) } : {})
    }))
  }))
}

/** Pure: an error's message, without pairing codes, tokens or endpoints, cut to one short line. */
export function safeReason(e) {
  const raw = String(e?.message ?? e ?? 'unknown error')
  return raw
    .replace(/orca:\/\/pair\?\S+/g, '<pairing code>')
    .replace(/\b(wss?|https?):\/\/\S+/g, '<endpoint>')
    .replace(/\b(token|secret|key|code)=\S+/gi, '$1=<hidden>')
    .split('\n')[0]
    .slice(0, 160)
}

/**
 * Probes one paired host, read-only: status first; only a reachable host is asked for more.
 * `want` picks the extra reads: { worktrees, agents, memory } (each true to read it). Each read is
 * its own try: a slow or failing one leaves that field null and names it in `errors`, never the
 * others. Returns { host, at, reachable, status, worktrees, agents, memory, errors }.
 */
export async function probeHost(host, orca, { want = {}, now = Date.now } = {}) {
  // By environment id: two paired servers may share a name.
  const env = ['--environment', host.environmentId]
  const errors = {}
  const read = async (field, args) => {
    try {
      return await orca([...args, ...env])
    } catch (e) {
      errors[field] = safeReason(e)
      return null
    }
  }
  const at = now()
  const st = await read('status', ['status'])
  const status = st ? statusOf(st) : null
  const out = { host, at, reachable: !!status?.reachable, status, worktrees: null, agents: null, memory: null, errors }
  if (!out.reachable) return out
  const [ps, ag, mem] = await Promise.all([
    want.worktrees ? read('worktrees', ['worktree', 'ps']) : null,
    want.agents ? read('agents', ['agent', 'installed']) : null,
    want.memory ? read('memory', ['diagnostics', 'memory']) : null
  ])
  if (ps) out.worktrees = relabelWorktrees(ps.worktrees, host)
  if (ag) out.agents = agentsOf(ag)
  if (mem) out.memory = memoryOf(mem)
  return out
}

/**
 * Pure: finds a paired host by what a person or agent typed: its name (case-insensitive), its
 * environment id, or its host id. null when none or more than one matches.
 */
export function findHost(hosts, query) {
  if (typeof query !== 'string' || !query) return null
  const q = query.toLowerCase()
  const hits = hosts.filter((h) => h.name.toLowerCase() === q || h.environmentId === query || h.id === query)
  return hits.length === 1 ? hits[0] : null
}
