// "Reload skills": which running agents a click asks to re-read their skill files, and what the
// sidebar says about it afterwards. Pure (no Node), so the panel draws the scope confirmation from
// its snapshot and the worker checks the same targets again when it writes the request.
// The delivery (Claude Code and Codex hooks) and the request store live in skills/orca-flow/scripts/skill-reload.mjs.
import type { AgentInfo, Snapshot, SkillReloadEntry } from './protocol.ts'
import { providerOf } from './providers.ts'

export type ReloadRole = 'coordinator' | 'lead' | 'worker' | 'chat'
/** One coordinator's team (its key), or every running agent. */
export type ReloadScope = 'all' | { coordinator: string }
export type PlannedTarget = { pane: string; session: string | null; role: ReloadRole; provider: string | null; supported: boolean; title: string; coordinator: string; /** Why it cannot reload now, with the one action to take (unsupported only). */ reason?: string; /** The user's approval (in Codex) is what is missing. */ approval?: boolean }
export type ReloadPlan = {
  /** Live Claude Code sessions, and Codex ones once its hooks are installed and trusted: they get the note at their next turn or tool call. */
  targets: PlannedTarget[]
  /** Live sessions that cannot take it now (Codex before its hooks are trusted, Antigravity, unknown), each with its reason. */
  unsupported: PlannedTarget[]
  /** Left out and why: finished (reported worker_done or settled) or asleep/closed (no live session). */
  skipped: { finished: number; asleep: number }
}

/** Codex's reason when the snapshot does not say (an old worker, or readiness not read yet). */
export const CODEX_UNKNOWN = 'Codex: Orca Flow could not check its hooks in this Codex account; restart to reload'
/** Antigravity's reason when the snapshot does not say. */
export const AGY_UNKNOWN = 'Antigravity: Orca Flow could not check its hooks; restart to reload'
/** A Codex row that waits: Codex reads its hooks only when a session starts, and Orca merges ours into the account only when it starts Codex (verified live). */
export const CODEX_WAITING_TIP = 'Reload waits for next turn; a Codex session started before Orca added and you approved the hooks needs a restart'
/** An Antigravity row that waits: whether agy reloads hooks.json mid-session is not documented. */
export const AGY_WAITING_TIP = 'Reload waits for next turn; an Antigravity session started before Orca Flow\'s hooks were added may need a restart'
/** Every other provider: no hooks of ours. */
export const NO_LIVE_RELOAD = 'it has no live reload; restart to reload'

/**
 * Who takes the note: Claude Code always (our hooks are in its settings.json, src/install.ts); Codex
 * only while Orca Flow's hooks from ~/.codex/hooks.json are merged into its account's hooks.json (Orca
 * does that when it starts Codex) and trusted by the user (src/codex-hooks.ts, the snapshot's
 * codexReload); Antigravity while our definition is in agy's
 * hooks.json and on (src/antigravity-hooks.ts, antigravityReload). Others are reported with a reason,
 * never typed into.
 */
export function reloadSupport(agentType: string | null, hooks: Pick<Partial<Snapshot>, 'codexReload' | 'antigravityReload'> = {}): { supported: boolean; reason?: string; approval?: boolean } {
  const p = providerOf(agentType)
  if (p === 'claude') return { supported: true }
  const ready = p === 'codex' ? hooks.codexReload : p === 'antigravity' ? hooks.antigravityReload : undefined
  if (p === 'codex' || p === 'antigravity') {
    if (ready?.ready) return { supported: true }
    return { supported: false, reason: ready?.reason || (p === 'codex' ? CODEX_UNKNOWN : AGY_UNKNOWN), ...(ready?.approval ? { approval: true } : {}) }
  }
  return { supported: false, reason: NO_LIVE_RELOAD }
}

/** The role the note names, by the sidebar's own reading (view.ts shapeOf): a coordinator's session, a lead, a worker, or a chat you started. */
function roleOf(a: AgentInfo, all: AgentInfo[], coordinator: string): ReloadRole {
  const role = a.summary?.role
  if (role === 'lead' || role === 'coordinator' || all.some((b) => b.leadPane === a.paneKey)) return 'lead'
  if (a.leadPane || role === 'worker') return 'worker'
  return coordinator === 'you' ? 'chat' : 'worker'
}

/** The provider's session id (Claude's session, Codex's thread, Antigravity's conversation), as the summarizer bound it; null when unknown (the hook then matches by pane). */
const sessionOf = (a: AgentInfo) => {
  const s = a.summary?.providerSession
  return s && ['claude', 'codex', 'antigravity'].includes(s.provider) && s.provider === providerOf(a.agentType) ? s.id : null
}

/**
 * The agents one click reaches: for a coordinator, its own live session and every lead and worker
 * that works for it; for 'all', every coordinator's team and the chats you started. Only live,
 * Orca-managed sessions: a finished one (settled dispatch) or a closed or asleep one is skipped and
 * counted, never woken. Each pane once.
 */
export function reloadPlan(snap: Pick<Snapshot, 'rows' | 'coordinators'> & Pick<Partial<Snapshot>, 'codexReload' | 'antigravityReload'>, scope: ReloadScope): ReloadPlan {
  const plan: ReloadPlan = { targets: [], unsupported: [], skipped: { finished: 0, asleep: 0 } }
  const inScope = (key: string) => scope === 'all' || key === scope.coordinator
  const all = snap.rows.flatMap((r) => r.agents)
  const seen = new Set<string>()
  const add = (a: AgentInfo, role: ReloadRole, coordinator: string) => {
    if (!a.paneKey || seen.has(a.paneKey)) return
    seen.add(a.paneKey)
    if (a.live !== true) { plan.skipped.asleep++; return }
    if (a.dispatch === 'settled') { plan.skipped.finished++; return }
    const { supported, reason, approval } = reloadSupport(a.agentType, snap)
    const target: PlannedTarget = { pane: a.paneKey, session: sessionOf(a), role, provider: providerOf(a.agentType) ?? a.agentType, supported, title: a.title, coordinator, ...(reason ? { reason } : {}), ...(approval ? { approval } : {}) }
    ;(supported ? plan.targets : plan.unsupported).push(target)
  }
  for (const c of snap.coordinators) if (inScope(c.key) && c.session) add(c.session, 'coordinator', c.key)
  for (const a of all) if (inScope(a.coordinator)) add(a, roleOf(a, all, a.coordinator), a.coordinator)
  return plan
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const ORDER: ReloadRole[] = ['coordinator', 'lead', 'worker', 'chat']

/** "1 coordinator, 2 leads, 3 workers": the targets by role, in the tree's order. */
export function rolesText(targets: { role: ReloadRole }[]): string {
  return ORDER.map((r) => [r, targets.filter((t) => t.role === r).length] as const).filter(([, n]) => n).map(([r, n]) => plural(n, r)).join(', ')
}

const PROVIDER_NAME: Record<string, string> = { codex: 'Codex', antigravity: 'Antigravity', gemini: 'Gemini', cursor: 'Cursor', copilot: 'GitHub Copilot', opencode: 'OpenCode' }
/** "1 Codex, 1 unknown agent" for sessions that cannot reload live. */
export function unsupportedText(unsupported: { provider: string | null }[]): string {
  const by = new Map<string, number>()
  for (const t of unsupported) {
    const name = (t.provider && PROVIDER_NAME[t.provider]) || (t.provider ? t.provider : 'unknown agent')
    by.set(name, (by.get(name) ?? 0) + 1)
  }
  return [...by].map(([name, n]) => `${n} ${name}`).join(', ')
}

/**
 * The scope confirmation, short: the counts by role, then at most one line per problem (needs
 * approval, cannot reload, skipped). Why each one cannot, and what to do, is on its row's tooltip.
 * Lines are separated by newlines (the dialog keeps them).
 */
export function confirmText(plan: ReloadPlan, where: string): { title: string; text: string; ok: boolean } {
  const n = plan.targets.length
  const lines = [n ? `${rolesText(plan.targets)} re-read their skills at their next turn.` : 'No running session here can take a reload.']
  const approval = plan.unsupported.filter((t) => t.approval)
  const cannot = plan.unsupported.filter((t) => !t.approval)
  if (approval.length) lines.push(`Needs approval: ${unsupportedText(approval)} (see the row).`)
  if (cannot.length) lines.push(`Cannot reload: ${unsupportedText(cannot)} (see the row).`)
  const skipped = [plan.skipped.finished ? `${plan.skipped.finished} finished` : '', plan.skipped.asleep ? `${plan.skipped.asleep} asleep` : ''].filter(Boolean)
  if (skipped.length) lines.push(`Skipped: ${skipped.join(', ')}.`)
  return { title: n ? `Reload skills in ${plural(n, 'agent')} ${where}?` : `Nothing to reload ${where}`, text: lines.join('\n'), ok: n > 0 }
}

/** How long a reloaded or unsupported mark stays on its row. */
export const DONE_SHOWN_MS = 10 * 60_000

/** The entries still worth showing: waiting and reading until they expire, done ones for a while. */
export function visibleReload(entries: SkillReloadEntry[] | undefined, now: number): SkillReloadEntry[] {
  return (entries ?? []).filter((e) => e.expiresAt > now && (e.state === 'waiting' || e.state === 'reading' || now - (e.doneAt ?? e.at) < DONE_SHOWN_MS))
}

/** A row's tooltip for its reload state: short, like the characters' own. */
export const RELOAD_TIP: Record<SkillReloadEntry['state'], string> = {
  waiting: 'Reload waits for next turn',
  reading: 'Reloading skills',
  reloaded: 'Skills reloaded',
  unsupported: 'Restart to reload skills'
}
