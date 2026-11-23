// "Reload skills": which running agents a click asks to re-read their skill files, and what the
// sidebar says about it afterwards. Pure (no Node), so the panel draws the scope confirmation from
// its snapshot and the worker checks the same targets again when it writes the request.
// The delivery (Claude Code hooks) and the request store live in skills/orca-flow/scripts/skill-reload.mjs.
import type { AgentInfo, Snapshot, SkillReloadEntry } from './protocol.ts'
import { providerOf } from './providers.ts'

export type ReloadRole = 'coordinator' | 'lead' | 'worker' | 'chat'
/** One coordinator's team (its key), or every running agent. */
export type ReloadScope = 'all' | { coordinator: string }
export type PlannedTarget = { pane: string; session: string | null; role: ReloadRole; provider: string | null; supported: boolean; title: string; coordinator: string }
export type ReloadPlan = {
  /** Live Claude Code sessions: they get the note at their next turn or tool call. */
  targets: PlannedTarget[]
  /** Live sessions of a provider with no live reload (Codex, Antigravity, unknown): restart to reload. */
  unsupported: PlannedTarget[]
  /** Left out and why: finished (reported worker_done or settled) or asleep/closed (no live session). */
  skipped: { finished: number; asleep: number }
}

/** Only Claude Code takes the note: its hooks are ours (src/install.ts). Others are reported, never typed into. */
export const reloadSupported = (agentType: string | null) => providerOf(agentType) === 'claude'

/** The role the note names, by the sidebar's own reading (view.ts shapeOf): a coordinator's session, a lead, a worker, or a chat you started. */
function roleOf(a: AgentInfo, all: AgentInfo[], coordinator: string): ReloadRole {
  const role = a.summary?.role
  if (role === 'lead' || role === 'coordinator' || all.some((b) => b.leadPane === a.paneKey)) return 'lead'
  if (a.leadPane || role === 'worker') return 'worker'
  return coordinator === 'you' ? 'chat' : 'worker'
}

/** Claude's session id, as the summarizer bound it; null when unknown (the hook then matches by pane). */
const sessionOf = (a: AgentInfo) => (a.summary?.providerSession?.provider === 'claude' ? a.summary.providerSession.id : null)

/**
 * The agents one click reaches: for a coordinator, its own live session and every lead and worker
 * that works for it; for 'all', every coordinator's team and the chats you started. Only live,
 * Orca-managed sessions: a finished one (settled dispatch) or a closed or asleep one is skipped and
 * counted, never woken. Each pane once.
 */
export function reloadPlan(snap: Pick<Snapshot, 'rows' | 'coordinators'>, scope: ReloadScope): ReloadPlan {
  const plan: ReloadPlan = { targets: [], unsupported: [], skipped: { finished: 0, asleep: 0 } }
  const inScope = (key: string) => scope === 'all' || key === scope.coordinator
  const all = snap.rows.flatMap((r) => r.agents)
  const seen = new Set<string>()
  const add = (a: AgentInfo, role: ReloadRole, coordinator: string) => {
    if (!a.paneKey || seen.has(a.paneKey)) return
    seen.add(a.paneKey)
    if (a.live !== true) { plan.skipped.asleep++; return }
    if (a.dispatch === 'settled') { plan.skipped.finished++; return }
    const supported = reloadSupported(a.agentType)
    const target: PlannedTarget = { pane: a.paneKey, session: sessionOf(a), role, provider: providerOf(a.agentType) ?? a.agentType, supported, title: a.title, coordinator }
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

/** The scope confirmation: its title, its text, and whether there is anyone to ask. */
export function confirmText(plan: ReloadPlan, where: string): { title: string; text: string; ok: boolean } {
  const n = plan.targets.length
  const parts: string[] = []
  if (n) parts.push(`${rolesText(plan.targets)} re-read their skill files at their next turn (a busy one after its next tool call) and confirm. Nothing is typed into their terminals; their tasks, open asks and runs stay as they are.`)
  else parts.push('No running Claude Code session here can take a reload.')
  if (plan.unsupported.length) parts.push(`${unsupportedText(plan.unsupported)} ${plan.unsupported.length === 1 ? 'session has' : 'sessions have'} no live reload: restart to reload.`)
  const skipped = [plan.skipped.finished ? `${plan.skipped.finished} finished` : '', plan.skipped.asleep ? `${plan.skipped.asleep} asleep or closed` : ''].filter(Boolean)
  if (skipped.length) parts.push(`Skipped: ${skipped.join(', ')}.`)
  return { title: n ? `Reload skills in ${plural(n, 'agent')} ${where}?` : `Nothing to reload ${where}`, text: parts.join(' '), ok: n > 0 }
}

/** How long a reloaded or unsupported mark stays on its row and in the summary. */
export const DONE_SHOWN_MS = 10 * 60_000

/** The entries still worth showing: waiting and reading until they expire, done ones for a while. */
export function visibleReload(entries: SkillReloadEntry[] | undefined, now: number): SkillReloadEntry[] {
  return (entries ?? []).filter((e) => e.expiresAt > now && (e.state === 'waiting' || e.state === 'reading' || now - (e.doneAt ?? e.at) < DONE_SHOWN_MS))
}

/** "Skills: 3 reloaded · 1 reading · 2 waiting for next turn · 1 unsupported"; '' when nothing shows. */
export function reloadSummary(entries: SkillReloadEntry[]): string {
  const n = (s: SkillReloadEntry['state']) => entries.filter((e) => e.state === s).length
  const parts = [
    n('reloaded') ? `${n('reloaded')} reloaded` : '',
    n('reading') ? `${n('reading')} reading` : '',
    n('waiting') ? `${n('waiting')} waiting for next turn` : '',
    n('unsupported') ? `${n('unsupported')} unsupported` : ''
  ].filter(Boolean)
  return parts.length ? `Skills: ${parts.join(' · ')}` : ''
}

/** A row's tooltip for its reload state: short, like the characters' own. */
export const RELOAD_TIP: Record<SkillReloadEntry['state'], string> = {
  waiting: 'Reload waits for next turn',
  reading: 'Reloading skills',
  reloaded: 'Skills reloaded',
  unsupported: 'Restart to reload skills'
}
