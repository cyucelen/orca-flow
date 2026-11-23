// Orca Flow's hooks for Codex: what lets a running Codex session take the sidebar's "Reload skills"
// note (skills/orca-flow/scripts/skill-reload.mjs), as Claude Code sessions do through settings.json.
//
// Orca starts each Codex session with CODEX_HOME = an Orca-managed account home
// (<Orca data>/codex-accounts/<id>/home, marked by .orca-managed-home). Codex 0.171 reads that home's
// hooks.json, whose events Orca fills with its own status hooks. We add three of ours to the same file,
// next to Orca's (Orca's rewrite keeps entries that are not its own): UserPromptSubmit
// (prompt-check.mjs), SessionStart (session-start.mjs) and PostToolUse (reload-check.mjs, gated by the
// skill-reload `active` file). We never touch config.toml, auth.json or any trust state.
//
// Codex runs a hook only once the user trusted it: config.toml [hooks.state."<hooks.json>:<event>:<group>:<handler>"]
// trusted_hash = "sha256:…". Orca pre-trusts its own; ours are trusted by the user, once, when Codex
// starts and shows "Hooks need review" (or with /hooks). codexReloadReadiness reads that state
// (read-only), with Codex's own key and hash, so the sidebar says exactly what is missing.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureStopHook, type HookEvent, type StopHook } from './install.ts'

/** Orca's data folder (codex-accounts lives in it). */
export const ORCA_DATA = join(homedir(), 'Library', 'Application Support', 'orca')

/** Our three Codex hooks: event, Codex's event label, script. */
export const CODEX_HOOKS = [
  { event: 'UserPromptSubmit', label: 'user_prompt_submit', script: 'prompt-check.mjs' },
  { event: 'SessionStart', label: 'session_start', script: 'session-start.mjs' },
  { event: 'PostToolUse', label: 'post_tool_use', script: 'reload-check.mjs' }
] as const

/** What Codex calls our hooks in its review and while one runs. Part of the trust hash: changing it asks the user again. */
export const CODEX_HOOK_NAME = 'Orca Flow: Reload skills'

/** Orca gives Codex panes ORCA_PANE_KEY (its own Codex hooks gate on it); Claude Code panes ORCA_AGENT_PANE. */
const PANE = '${ORCA_AGENT_PANE:-${ORCA_PANE_KEY-}}'

/**
 * Our hook entries for one Codex home, run through the Codex user skill link (~/.agents/skills/orca-flow,
 * src/install.ts linksFor), so they follow the installed plugin across updates without changing (a
 * changed command would need the user's trust again). The PostToolUse one starts node only while a
 * reload waits.
 */
export function codexHooksFor(codexHome: string, skill = join(homedir(), '.agents', 'skills', 'orca-flow')): StopHook[] {
  return CODEX_HOOKS.map(({ event, script }) => {
    const gate = event === 'PostToolUse' ? ' && [ -e "${ORCA_FLOW_DIR:-$HOME/.orca-flow}/skill-reload/active" ]' : ''
    const command = `if [ -n "${PANE}" ]${gate}; then node "${join(skill, 'scripts', script)}"; fi`
    // The name Codex shows for it in "Hooks need review" and /hooks (without one it reads "Unnamed hook").
    return { path: join(codexHome, 'hooks.json'), event: event as HookEvent, mark: `skills/orca-flow/scripts/${script}`, entry: { hooks: [{ type: 'command', command, timeout: 10, statusMessage: CODEX_HOOK_NAME }] } }
  })
}

/** Every Orca-managed Codex home: <Orca data>/codex-accounts/<id>/home with Orca's marker. */
export function managedCodexHomes(data = ORCA_DATA): string[] {
  const root = join(data, 'codex-accounts')
  let ids: string[] = []
  try { ids = readdirSync(root) } catch { return [] }
  return ids.filter((id) => /^[A-Za-z0-9-]+$/.test(id)).map((id) => join(root, id, 'home')).filter((h) => existsSync(join(h, '.orca-managed-home')))
}

/**
 * Adds our hooks to a Codex home's hooks.json (each once, updated in place, Orca's and every other
 * entry kept: ensureStopHook). A home without hooks.json is left alone: Orca has not set it up yet,
 * and the file is Orca's to create. Returns what it did, for the log.
 */
export function ensureCodexHooks(codexHome: string, skill?: string): string[] {
  if (!existsSync(join(codexHome, 'hooks.json'))) return [`left ${codexHome}: no hooks.json yet (Orca creates it)`]
  return codexHooksFor(codexHome, skill).flatMap((h) => ensureStopHook(h))
}

/** Like ensureOwnStopHook: only the installed copy writes, never a development folder. */
export function ensureOwnCodexHooks(homes: string[], installed: boolean, skill?: string): string[] {
  if (!installed) return homes.length ? [`left the Codex hooks in ${homes.length} Codex home(s) to the installed copy: this is a development folder`] : []
  return homes.flatMap((h) => ensureCodexHooks(h, skill))
}

// ---------- trust (read-only) ----------

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v
/** Tool events carry their group's matcher in the hash; the others never do (as Codex hashes them). */
const MATCHED = new Set(['pre_tool_use', 'permission_request', 'post_tool_use', 'pre_compact', 'post_compact', 'session_start', 'subagent_start', 'subagent_stop'])

/**
 * Codex's trust hash of one hook handler: sha256 of the key-sorted JSON of {event_name, hooks: [the
 * handler with timeout (default 600) and async (default false)], matcher (tool events only)}. Checked
 * against every Orca-trusted entry of a real account (all nine match).
 */
export function codexTrustHash(label: string, handler: { command: string; timeout?: number; async?: boolean; statusMessage?: string }, matcher?: string): string {
  const hook: Record<string, unknown> = { type: 'command', command: handler.command, timeout: Math.max(1, handler.timeout ?? 600), async: handler.async ?? false }
  if (handler.statusMessage !== undefined) hook.statusMessage = handler.statusMessage
  const node: Record<string, unknown> = { event_name: label, hooks: [hook] }
  if (MATCHED.has(label) && matcher !== undefined) node.matcher = matcher
  return `sha256:${createHash('sha256').update(JSON.stringify(sortKeys(node))).digest('hex')}`
}

/** The [hooks.state."<key>"] tables of a config.toml: trusted_hash and enabled per key. Only what we read. */
export function readHookState(toml: string): Map<string, { trustedHash: string | null; enabled: boolean }> {
  const out = new Map<string, { trustedHash: string | null; enabled: boolean }>()
  let current: { trustedHash: string | null; enabled: boolean } | null = null
  for (const line of toml.split('\n')) {
    const head = /^\s*\[\s*hooks\.state\."((?:[^"\\]|\\.)*)"\s*\]\s*(?:#.*)?$/.exec(line)
    if (head) {
      current = { trustedHash: null, enabled: true }
      out.set(head[1].replace(/\\(["\\])/g, '$1'), current)
      continue
    }
    if (/^\s*\[/.test(line)) { current = null; continue }
    if (!current) continue
    const hash = /^\s*trusted_hash\s*=\s*"([^"]*)"/.exec(line)
    if (hash) current.trustedHash = hash[1]
    const enabled = /^\s*enabled\s*=\s*(true|false)\b/.exec(line)
    if (enabled) current.enabled = enabled[1] === 'true'
  }
  return out
}

export type CodexReadiness = { state: 'ready' | 'not-installed' | 'needs-approval' | 'disabled' | 'unreadable' | 'unmanaged'; reason: string }

/** The short reason the sidebar shows for each state, with the one action to take. */
export const CODEX_REASON: Record<CodexReadiness['state'], string> = {
  'ready': '',
  'not-installed': 'Codex: Orca Flow\'s hooks are not installed in this Codex account yet; update Orca Flow',
  'needs-approval': 'Codex: approve Orca Flow\'s hooks once; start Codex, choose Trust all and continue (or /hooks)',
  'disabled': 'Codex: Orca Flow\'s hooks are turned off; turn them on in Codex with /hooks',
  'unreadable': 'Codex: its hooks.json cannot be read; restart to reload',
  'unmanaged': 'Codex: the selected Codex login is not an Orca-managed account, where Orca Flow installs its hooks; restart to reload'
}

/**
 * Whether a Codex home's sessions can take the reload note: our three hooks in its hooks.json, each
 * trusted in its config.toml with the hash of the command as it is there and enabled. Reads only.
 */
export function codexReloadReadiness(codexHome: string): CodexReadiness {
  const r = (state: CodexReadiness['state']): CodexReadiness => ({ state, reason: CODEX_REASON[state] })
  if (!existsSync(join(codexHome, '.orca-managed-home'))) return r('unmanaged')
  let hooks: Record<string, unknown>
  try {
    hooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))?.hooks ?? {}
  } catch (e) {
    return r((e as { code?: string }).code === 'ENOENT' ? 'not-installed' : 'unreadable')
  }
  let toml = ''
  try { toml = readFileSync(join(codexHome, 'config.toml'), 'utf8') } catch {}
  const state = readHookState(toml)
  let source: string
  try { source = join(realpathSync(codexHome), 'hooks.json') } catch { source = join(codexHome, 'hooks.json') }
  let disabled = false
  for (const { event, label, script } of CODEX_HOOKS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as any[]) : []
    let found: { key: string; hash: string } | null = null
    groups.forEach((g, gi) => (Array.isArray(g?.hooks) ? g.hooks : []).forEach((h: any, hi: number) => {
      if (!found && typeof h?.command === 'string' && h.command.includes(`skills/orca-flow/scripts/${script}`)) found = { key: `${source}:${label}:${gi}:${hi}`, hash: codexTrustHash(label, h, g.matcher) }
    }))
    if (!found) return r('not-installed')
    const { key, hash } = found as { key: string; hash: string }
    const trust = state.get(key)
    if (!trust || trust.trustedHash !== hash) return r('needs-approval')
    if (!trust.enabled) disabled = true
  }
  return r(disabled ? 'disabled' : 'ready')
}
