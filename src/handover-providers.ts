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
