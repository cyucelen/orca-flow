// What models this machine can verify, for routing (src/routing.ts). Parsing is pure; `discover`
// runs the two read-only commands through the caller's exec, so the plugin worker and the
// orca-flow script share it:
//   orca agent installed --json   → installed agent ids (host- and account-independent)
//   codex debug models            → the Codex CLI's model catalog: slug, display_name, visibility,
//                                   supported_reasoning_levels[].effort (hidden models left out)
// Claude Code has no list command: its models stay null (aliases accepted unverified).
//
// CONTRACT: other modules build against these names and types.
import type { Availability, ModelInfo } from './routing.ts'

/** Runs a command and returns stdout; rejects on a non-zero exit or a timeout. */
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<string>

/** Agent ids from `orca agent installed --json` output (either the `{ok,result}` envelope or the bare result); null when unreadable. */
export function parseInstalled(stdout: string): string[] | null {
  throw new Error('not implemented')
}

/** Listed (not hidden) Codex models with their efforts, in catalog order; null when unreadable. */
export function parseCodexCatalog(stdout: string): ModelInfo[] | null {
  throw new Error('not implemented')
}

/**
 * Both lookups, each with its own timeout; a failed lookup reads as unknown (null), never as
 * "nothing installed". `orcaBin` defaults to `orca`, `codexBin` to `codex`.
 */
export async function discover(exec: Exec, opts?: { orcaBin?: string; codexBin?: string; env?: Record<string, string> }): Promise<Availability> {
  throw new Error('not implemented')
}
