import type { CoordinatorProvider, WakeOutcome } from './protocol.ts'

// Host agent.resume's session-id providers after its pluginResumeKey refinement (Pi and Prime
// Agent require transcript files and are rejected). agent.launch alone accepts additional CLIs
// without this tracking/resume contract. See docs/coordinator-first-session.md for host evidence.
const TRACKED = new Set(['claude', 'codebuddy', 'codex', 'qoder', 'qoder-cn', 'qwen-code', 'gemini', 'antigravity', 'opencode', 'opencode2', 'mimo-code', 'droid', 'grok', 'devin', 'omp', 'copilot', 'cursor', 'kimi', 'muse', 'zcode', 'dsh', 'jcode', 'kiro', 'hermes'])

export async function readInstalledProviders(run: (args: string[]) => Promise<any>): Promise<CoordinatorProvider[] | null> {
  try {
    const result = await run(['agent', 'installed'])
    if (!Array.isArray(result?.agents)) return null
    const seen = new Set<string>()
    return result.agents.flatMap((a: any) => {
      if (typeof a?.id !== 'string' || !a.id || seen.has(a.id)) return []
      seen.add(a.id)
      return [{ id: a.id, name: typeof a.name === 'string' && a.name.trim() ? a.name : a.id }]
    })
  } catch { return null }
}

export const coordinatorProviders = (installed: CoordinatorProvider[] | null): CoordinatorProvider[] | null => installed?.filter((a) => TRACKED.has(a.id)) ?? null

/** A stale explicit choice never silently falls back to a newly sole/default harness. */
export function firstProvider(providers: CoordinatorProvider[] | null, chosen?: string): { kind: 'start'; agent: string } | WakeOutcome {
  if (chosen && providers?.some((p) => p.id === chosen)) return { kind: 'start', agent: chosen }
  if (!chosen && providers?.length === 1) return { kind: 'start', agent: providers[0].id }
  return { ok: false, kind: 'provider', providers: providers ?? [], error: chosen
    ? 'That provider is no longer available. Choose an enabled provider or check Orca Settings → Agents.'
    : providers === null ? 'Could not check agent availability. Retry, or check Orca Settings → Agents.'
    : !providers.length ? 'No supported provider is enabled. Install or enable an agent with coordinator session tracking in Orca Settings → Agents, then Retry.'
    : 'Choose a provider for the first conversation.' }
}
