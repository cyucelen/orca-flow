import type { AgentInfo, Snapshot } from './protocol.ts'
import { PROVIDER_LOGOS } from './provider-logos.ts'

const NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', cursor: 'Cursor', copilot: 'GitHub Copilot', opencode: 'OpenCode' } as const
type Provider = keyof typeof NAMES

/** Only host agent ids and explicit aliases; model names and conversation text are not evidence. */
export function providerOf(agentType: string | null): Provider | null {
  const id = agentType?.trim().toLowerCase()
  if (id === 'claude-agent-teams') return 'claude'
  if (id === 'opencode2') return 'opencode'
  if (id === 'agy') return 'antigravity'
  return id && Object.hasOwn(NAMES, id) ? id as Provider : null
}

/** A completed turn is still present. A settled dispatch or a pane without live host evidence is not. */
export const providerSessionLive = (a: AgentInfo): boolean => a.live === true && a.dispatch !== 'settled'

/** Computed before search/folding, across individual panes (including mixed worktrees and folders). */
export function mixedProviders(snap: Pick<Snapshot, 'rows' | 'coordinators'>): boolean {
  const agents = [...snap.rows.flatMap((r) => r.agents), ...snap.coordinators.flatMap((c) => c.members ? c.members.flatMap((m) => m.agent ? [m.agent] : []) : c.session ? [c.session] : [])]
  const providers = new Set(agents.filter(providerSessionLive).map((a) => providerOf(a.agentType)).filter((p) => p !== null))
  return providers.size > 1
}

/** Non-interactive, accessible and tooltip-enabled: clicks keep opening the enclosing agent row. */
export function providerBadge(a: AgentInfo | null | undefined, mixed: boolean): string {
  if (!mixed || !a || !providerSessionLive(a)) return ''
  const provider = providerOf(a.agentType)
  const name = provider ? NAMES[provider] : 'Unknown provider'
  const mark = provider ? PROVIDER_LOGOS[provider] : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="4" y="6" width="16" height="14" rx="3"/><path d="M12 2v4M8 11v3m8-3v3M9 17h6"/></svg>'
  return `<span class="provider" role="img" aria-label="${name}" data-tip="${name}">${mark}</span>`
}
