// What models this machine can verify, for routing (src/routing.ts). Parsing is pure; `discover`
// runs the two read-only commands through the caller's exec, so the plugin worker and the
// orca-flow script share it:
//   orca agent installed --json   → installed agent ids (host- and account-independent)
//   codex debug models            → the Codex CLI's model catalog: slug, display_name, visibility,
//                                   supported_reasoning_levels[].effort (hidden models left out)
// Claude Code has no list command: its models stay null (aliases accepted unverified).
//
// CONTRACT: other modules build against these names and types.
import { EFFORTS, type Availability, type Effort, type ModelInfo } from './routing.ts'

/** Runs a command and returns stdout; rejects on a non-zero exit or a timeout. */
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<string>

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseJson(stdout: string): unknown {
  const t = stdout.trim()
  try { return JSON.parse(t) } catch { /* maybe text before the JSON */ }
  const at = t.indexOf('{')
  if (at < 0) return undefined
  try { return JSON.parse(t.slice(at)) } catch { return undefined }
}

/** Agent ids from `orca agent installed --json` output (either the `{ok,result}` envelope or the bare result); null when unreadable. */
export function parseInstalled(stdout: string): string[] | null {
  const root = parseJson(stdout)
  if (!isObject(root) || root.ok === false) return null
  const body = isObject(root.result) ? root.result : root
  if (!Array.isArray(body.agents)) return null
  const ids: string[] = []
  for (const a of body.agents) {
    const id = typeof a === 'string' ? a : isObject(a) ? a.id : undefined
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Listed (not hidden) Codex models with their efforts, in catalog order; null when unreadable. */
export function parseCodexCatalog(stdout: string): ModelInfo[] | null {
  const root = parseJson(stdout)
  if (!isObject(root) || !Array.isArray(root.models)) return null
  const out: ModelInfo[] = []
  for (const m of root.models) {
    if (!isObject(m) || typeof m.slug !== 'string' || !m.slug || m.visibility === 'hide' || out.some((o) => o.id === m.slug)) continue
    const efforts: Effort[] = []
    if (Array.isArray(m.supported_reasoning_levels)) {
      for (const l of m.supported_reasoning_levels) {
        const e = isObject(l) ? l.effort : l
        if ((EFFORTS as readonly unknown[]).includes(e) && !efforts.includes(e as Effort)) efforts.push(e as Effort)
      }
    }
    out.push({ id: m.slug, ...(typeof m.display_name === 'string' && m.display_name ? { label: m.display_name } : {}), ...(efforts.length ? { efforts } : {}) })
  }
  return out.length ? out : null
}

/**
 * Both lookups, each with its own timeout; a failed lookup reads as unknown (null), never as
 * "nothing installed". `orcaBin` defaults to `orca`, `codexBin` to `codex`.
 */
export async function discover(exec: Exec, opts?: { orcaBin?: string; codexBin?: string; env?: Record<string, string> }): Promise<Availability> {
  const o = { timeoutMs: 10_000, ...(opts?.env ? { env: opts.env } : {}) }
  const run = async <T>(cmd: string, args: string[], parse: (s: string) => T | null): Promise<T | null> => {
    try { return parse(await exec(cmd, args, o)) } catch { return null }
  }
  const [agents, codex] = await Promise.all([
    run(opts?.orcaBin ?? 'orca', ['agent', 'installed', '--json'], parseInstalled),
    run(opts?.codexBin ?? 'codex', ['debug', 'models'], parseCodexCatalog)
  ])
  return { agents, models: { claude: null, codex } }
}
