// What models this machine can verify, for routing (src/routing.ts). Parsing is pure; `discover`
// runs the three read-only commands through the caller's exec, so the plugin worker and the
// orca-flow script share it:
//   orca agent installed --json   → installed agent ids (host- and account-independent)
//   codex debug models            → the Codex CLI's model catalog: slug, display_name, visibility,
//                                   supported_reasoning_levels[].effort (hidden models left out)
//   claude -p --input-format stream-json … (a `list_models` control request on stdin, no API turn;
//                                   Orca lists Claude models the same way) → control_response with
//                                   models[]: value, displayName, disabled, supportedEffortLevels
// A Claude lookup that fails stays null: aliases and `claude-*` ids are then accepted unverified.
// The efforts Claude reports are not what Orca accepts at launch; routing intersects them with
// ORCA_LAUNCH_EFFORTS.
//
// CONTRACT: other modules build against these names and types.
import { CLAUDE_ALIASES, EFFORTS, type Availability, type Effort, type ModelInfo } from './routing.ts'

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
 * Claude Code's models from the `list_models` control_response line of its stream-json output:
 * enabled entries only, without the "default" entry, aliases (haiku, sonnet, opus, fable) first,
 * then the rest in catalog order. `efforts` is what Claude reports ([] when it takes none);
 * null when no models can be read.
 */
export function parseClaudeModels(stdout: string): ModelInfo[] | null {
  let models: unknown
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{') || !t.includes('control_response')) continue
    let root: unknown
    try { root = JSON.parse(t) } catch { continue }
    const outer = isObject(root) && root.type === 'control_response' && isObject(root.response) ? root.response : undefined
    const inner = outer && isObject(outer.response) ? outer.response : undefined
    if (inner && Array.isArray(inner.models)) { models = inner.models; break }
  }
  if (!Array.isArray(models)) return null
  const out: ModelInfo[] = []
  for (const m of models) {
    if (!isObject(m) || typeof m.value !== 'string' || !m.value || m.value === 'default' || m.disabled === true || out.some((o) => o.id === m.value)) continue
    const efforts: Effort[] = []
    if (Array.isArray(m.supportedEffortLevels)) {
      for (const e of m.supportedEffortLevels) if ((EFFORTS as readonly unknown[]).includes(e) && !efforts.includes(e as Effort)) efforts.push(e as Effort)
    }
    const takes = m.supportsEffort === true || (m.supportsEffort === undefined && efforts.length > 0)
    out.push({
      id: m.value,
      ...(typeof m.displayName === 'string' && m.displayName ? { label: m.displayName } : {}),
      ...(takes && efforts.length ? { efforts } : m.supportsEffort === false ? { efforts: [] } : {})
    })
  }
  if (!out.length) return null
  const rank = (id: string) => { const i = CLAUDE_ALIASES.indexOf(id); return i < 0 ? CLAUDE_ALIASES.length : i }
  return out.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.id) - rank(b.m.id) || a.i - b.i).map((x) => x.m)
}

const CLAUDE_LIST_SCRIPT = [
  'd=$(mktemp -d) || exit 1',
  'cd "$d" || exit 1',
  `echo '{"type":"control_request","request_id":"orca-flow","request":{"subtype":"list_models"}}' | "$1" -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config`,
  'rc=$?; cd /; rm -rf "$d"; exit $rc'
].join('\n')

/**
 * The three lookups, each with its own timeout (Claude's 20 s); a failed lookup reads as unknown
 * (null), never as "nothing installed". `orcaBin` defaults to `orca`, `codexBin` to `codex`,
 * `claudeBin` to `claude`. Claude runs through `sh` so it starts in an empty temp cwd.
 */
export async function discoverClaudeModels(exec: Exec, opts?: { claudeBin?: string; env?: Record<string, string> }): Promise<ModelInfo[] | null> {
  try {
    const stdout = await exec('sh', ['-c', CLAUDE_LIST_SCRIPT, 'sh', opts?.claudeBin ?? 'claude'], { timeoutMs: 20_000, ...(opts?.env ? { env: opts.env } : {}) })
    return parseClaudeModels(stdout)
  } catch { return null }
}

/**
 * All lookups, each with its own timeout; a failed lookup reads as unknown (null), never as
 * "nothing installed". Options name the binaries (defaults `orca`, `codex`, `claude`).
 */
export async function discover(exec: Exec, opts?: { orcaBin?: string; codexBin?: string; claudeBin?: string; env?: Record<string, string> }): Promise<Availability> {
  const o = { timeoutMs: 10_000, ...(opts?.env ? { env: opts.env } : {}) }
  const run = async <T>(cmd: string, args: string[], parse: (s: string) => T | null): Promise<T | null> => {
    try { return parse(await exec(cmd, args, o)) } catch { return null }
  }
  const [agents, codex, claude] = await Promise.all([
    run(opts?.orcaBin ?? 'orca', ['agent', 'installed', '--json'], parseInstalled),
    run(opts?.codexBin ?? 'codex', ['debug', 'models'], parseCodexCatalog),
    discoverClaudeModels(exec, opts)
  ])
  return { agents, models: { claude, codex } }
}
