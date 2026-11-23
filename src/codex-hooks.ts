// Orca Flow's hooks for Codex: what lets a running Codex session take the sidebar's "Reload skills"
// note (skills/orca-flow/scripts/skill-reload.mjs), as Claude Code sessions do through settings.json.
//
// Orca starts each Codex session with CODEX_HOME = an Orca-managed account home
// (<Orca data>/codex-accounts/<id>/home, marked by .orca-managed-home), and Codex 0.171 reads that
// home's hooks.json. Orca rebuilds that file every time it starts a Codex agent (Orca 1.4.265, the
// hookPass worker's install in codex-project-trust-worker-entry.js, verified live): its own status hook
// first in each event, then the groups of the system Codex home's ~/.codex/hooks.json. It drops every
// other entry, along with its trust state. So our three hooks live in ~/.codex/hooks.json, next to
// whatever the user keeps there, and reach every account through Orca's merge: UserPromptSubmit
// (prompt-check.mjs), SessionStart (session-start.mjs) and PostToolUse (reload-check.mjs, gated by the
// skill-reload `active` file). Their commands run the scripts through the Codex user skill link
// (~/.agents/skills/orca-flow), so they stay the same across plugin updates and keep the user's trust.
// Orca drops commands that contain ${PLUGIN_ROOT}-style variables from the merge; ours have none.
//
// Codex runs a hook only once the user trusted it: config.toml [hooks.state."<hooks.json>:<event>:<group>:<handler>"]
// trusted_hash = "sha256:…". Orca pre-trusts its own. Ours are trusted by the user, once: the first
// Codex agent Orca starts afterwards shows "Hooks need review", and "Trust all and continue" writes
// the trust into that account's config.toml. When Orca next starts Codex it copies that approval
// into ~/.codex/config.toml (keyed by ~/.codex/hooks.json) and from then on carries it into every
// account, matched by hash. codexReloadReadiness reads both (read-only), with Codex's own key and
// hash. We never write config.toml, auth.json or any trust state.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureStopHook, type HookEvent, type StopHook } from './install.ts'

/** The system Codex home: Orca merges its hooks.json into every Orca-managed account. */
export const SYSTEM_CODEX_HOME = join(homedir(), '.codex')

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
 * Our hook entries for the system Codex home's hooks.json, run through the Codex user skill link
 * (~/.agents/skills/orca-flow, src/install.ts linksFor), so they follow the installed plugin across
 * updates without changing (a changed command would need the user's trust again). The PostToolUse
 * one starts node only while a reload waits. Outside Orca's panes they do nothing.
 */
export function codexHooksFor(system = SYSTEM_CODEX_HOME, skill = join(homedir(), '.agents', 'skills', 'orca-flow')): StopHook[] {
  return CODEX_HOOKS.map(({ event, script }) => {
    const gate = event === 'PostToolUse' ? ' && [ -e "${ORCA_FLOW_DIR:-$HOME/.orca-flow}/skill-reload/active" ]' : ''
    const command = `if [ -n "${PANE}" ]${gate}; then node "${join(skill, 'scripts', script)}"; fi`
    // The name Codex shows for it in "Hooks need review" and /hooks (without one it reads "Unnamed hook").
    return { path: join(system, 'hooks.json'), event: event as HookEvent, mark: `skills/orca-flow/scripts/${script}`, entry: { hooks: [{ type: 'command', command, timeout: 10, statusMessage: CODEX_HOOK_NAME }] } }
  })
}

/**
 * Adds our hooks to the system Codex home's hooks.json, creating the file when it is missing (each
 * hook once, updated in place, every other entry and key kept: ensureStopHook). Without a ~/.codex
 * folder Codex has never run here, and nothing is written. Returns what it did, for the log.
 */
export function ensureCodexHooks(system = SYSTEM_CODEX_HOME, skill?: string): string[] {
  if (!existsSync(system)) return [`left the Codex hooks: no ${system} (Codex has not run here)`]
  return codexHooksFor(system, skill).flatMap((h) => ensureStopHook(h))
}

/** Like ensureOwnStopHook: only the installed copy writes, never a development folder. */
export function ensureOwnCodexHooks(installed: boolean, system = SYSTEM_CODEX_HOME, skill?: string): string[] {
  if (!installed) return existsSync(system) ? [`left the Codex hooks in ${join(system, 'hooks.json')} to the installed copy: this is a development folder`] : []
  return ensureCodexHooks(system, skill)
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

export type CodexReadiness = { state: 'ready' | 'not-installed' | 'not-merged' | 'needs-approval' | 'disabled' | 'unreadable' | 'unmanaged'; reason: string }

/** The short reason the sidebar shows for each state, with the one action to take. */
export const CODEX_REASON: Record<CodexReadiness['state'], string> = {
  'ready': '',
  'not-installed': 'Codex: Orca Flow has not added its hooks to ~/.codex/hooks.json yet; update Orca Flow',
  'not-merged': 'Codex: Orca adds Orca Flow\'s hooks when it next starts Codex; start a Codex agent in Orca (choose Trust all and continue if asked), then restart older Codex sessions',
  'needs-approval': 'Codex: approve Orca Flow\'s hooks once; start a Codex agent in Orca and choose Trust all and continue (or /hooks), then restart older Codex sessions',
  'disabled': 'Codex: Orca Flow\'s hooks are turned off; turn them on in Codex with /hooks',
  'unreadable': 'Codex: a hooks.json Orca Flow reads (~/.codex or this Codex account) is not valid JSON; fix it, then start a Codex agent in Orca',
  'unmanaged': 'Codex: the selected Codex login is neither ~/.codex nor an Orca-managed account, so Orca Flow\'s hooks do not reach it; restart to reload'
}

type Found = { group: number; handler: number; hook: Record<string, unknown>; matcher?: string }

/** Our handler for one script in a parsed hooks.json's event: its position and itself; null when absent. */
function findOurs(hooks: Record<string, unknown>, event: string, script: string): Found | null {
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as any[]) : []
  for (let g = 0; g < groups.length; g++) {
    const list = Array.isArray(groups[g]?.hooks) ? groups[g].hooks : []
    for (let h = 0; h < list.length; h++) {
      if (typeof list[h]?.command === 'string' && list[h].command.includes(`skills/orca-flow/scripts/${script}`)) return { group: g, handler: h, hook: list[h], ...(typeof groups[g].matcher === 'string' ? { matcher: groups[g].matcher } : {}) }
    }
  }
  return null
}

/** A home's hooks.json `hooks` object, 'missing', or 'unreadable'. */
function readHooks(home: string): Record<string, unknown> | 'missing' | 'unreadable' {
  try {
    const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'))?.hooks ?? {}
    return hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? hooks : 'unreadable'
  } catch (e) {
    return (e as { code?: string }).code === 'ENOENT' ? 'missing' : 'unreadable'
  }
}

const realHooksJson = (home: string) => { try { return join(realpathSync(home), 'hooks.json') } catch { return join(home, 'hooks.json') } }
const stateOf = (home: string) => { try { return readHookState(readFileSync(join(home, 'config.toml'), 'utf8')) } catch { return new Map() } }
const same = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))

/**
 * Whether the selected Codex home's sessions can take the reload note, read from what Codex will use
 * (read-only):
 * - our three hooks in ~/.codex/hooks.json (else not installed);
 * - for an Orca-managed home, the same three in that home's hooks.json, where Orca merges them when it
 *   starts Codex (else not merged yet: Orca adds them at its next Codex start);
 * - each trusted with the hash of its command, and enabled: by the home's own config.toml at the
 *   merged position, or by ~/.codex/config.toml for the ~/.codex/hooks.json entry, whose trust Orca
 *   carries into every account (matched by hash within the event, as Orca does).
 * When the selected login is ~/.codex itself, Codex reads ~/.codex/hooks.json and its config.toml directly.
 */
export function codexReloadReadiness(codexHome: string, system = SYSTEM_CODEX_HOME): CodexReadiness {
  const r = (state: CodexReadiness['state']): CodexReadiness => ({ state, reason: CODEX_REASON[state] })
  const sysHooks = readHooks(system)
  if (sysHooks === 'unreadable') return r('unreadable')
  if (sysHooks === 'missing') return r('not-installed')
  const sysSource = realHooksJson(system)
  const isSystem = sysSource === realHooksJson(codexHome)
  if (!isSystem && !existsSync(join(codexHome, '.orca-managed-home'))) return r('unmanaged')
  const homeHooks = isSystem ? sysHooks : readHooks(codexHome)
  if (homeHooks === 'unreadable') return r('unreadable')
  const sysState = stateOf(system)
  const homeState = isSystem ? sysState : stateOf(codexHome)
  const homeSource = realHooksJson(codexHome)
  const sysSources = new Set([sysSource, join(system, 'hooks.json')])
  let disabled = false
  let unmerged = false
  for (const { event, label, script } of CODEX_HOOKS) {
    const mine = findOurs(sysHooks, event, script)
    if (!mine) return r('not-installed')
    const used = homeHooks === 'missing' ? null : findOurs(homeHooks, event, script)
    // Orca has not merged this version into the account yet (it does when it next starts Codex).
    if (!used || !same(used.hook, mine.hook) || used.matcher !== mine.matcher) { unmerged = true; continue }
    const hash = codexTrustHash(label, used.hook as { command: string }, used.matcher)
    // Codex's own key for the copy it runs; else the user's ~/.codex trust for the same hook, which Orca carries over.
    const own = homeState.get(`${homeSource}:${label}:${used.group}:${used.handler}`)
    const carried = isSystem ? undefined : [...sysState].find(([key, t]) => {
      const m = /^(.*):([a-z_]+):(\d+):(\d+)$/.exec(key)
      return m !== null && sysSources.has(m[1]) && m[2] === label && t.trustedHash === hash
    })?.[1]
    const trust = own?.trustedHash === hash ? own : carried
    if (!trust) return r('needs-approval')
    if (!trust.enabled) disabled = true
  }
  if (unmerged) return r('not-merged')
  return r(disabled ? 'disabled' : 'ready')
}
