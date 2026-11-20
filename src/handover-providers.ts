import type { Coordinator } from './protocol.ts'
import type { HandoverProvider } from './handover.ts'

const SUPPORTED = ['claude', 'codex'] as const

/** Enabled, launchable host CLIs; never infer availability from existing conversations. */
export async function readHandoverProviders(run: (args: string[]) => Promise<any>): Promise<HandoverProvider[] | null> {
  try {
    const result = await run(['agent', 'installed'])
    if (!Array.isArray(result?.agents)) return null
    return SUPPORTED.filter((id) => result.agents.some((agent: { id?: unknown } | null) => agent?.id === id))
  } catch { return null }
}

export function handoverTargets(available: readonly string[] | null | undefined, current: string | null | undefined): HandoverProvider[] {
  return SUPPORTED.filter((id) => id !== current && available?.includes(id))
}

type HandoverOptions = {
  choices: { provider: HandoverProvider; label: string; retry: boolean }[]
  note?: string
  tip?: string
}

/** Both coordinator menus offer the same launch or retry for the recorded source. */
export function coordinatorHandover(c: Coordinator, available: readonly string[] | null | undefined, pending: boolean): HandoverOptions {
  if (pending) return { choices: [], note: 'Handing over…' }
  const attempt = c.handover
  if (attempt?.phase === 'invalid') return { choices: [], note: 'Unavailable', tip: attempt.error }
  const retry = attempt?.provider && attempt.phase !== 'complete' ? attempt.provider : null
  const current = c.sessions?.members.find(m => m.id === c.sessions?.current)
  const targets = retry ? (available?.includes(retry) ? [retry] : []) : current ? handoverTargets(available, current.agentType) : []
  if (!targets.length) {
    const tip = retry ? `Retry handover to ${retry === 'codex' ? 'Codex' : 'Claude'} when that provider is available. The original attempt is preserved.`
      : !current ? 'Select a main conversation before handover.'
      : available ? 'No other supported provider is available. Enable Claude or Codex in Orca Settings → Agents.' : 'Agent availability could not be verified. Reopen the menu after refreshing.'
    return { choices: [], note: 'Unavailable', tip }
  }
  return { choices: targets.map(provider => ({
    provider, retry: !!retry, label: `${retry ? 'Retry handover' : 'Handover'} to ${provider === 'codex' ? 'Codex' : 'Claude'}`
  })), ...(retry ? { note: 'Retry' } : {}) }
}
