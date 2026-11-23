// Orca Flow's hooks for the Antigravity CLI (agy): what lets a running Antigravity session take the
// sidebar's "Reload skills" note, as Claude Code (settings.json) and Codex (src/codex-hooks.ts) do.
//
// Google documents agy hooks at https://antigravity.google/docs/hooks/: global ones live in
// ~/.gemini/config/hooks.json, an object of named hook definitions, each mapping events to handlers.
// SessionStart, PreInvocation, PostInvocation and Stop take a list of handlers; PreToolUse and
// PostToolUse take [{ matcher, hooks: [handlers] }]; a handler is { type: "command", command, timeout };
// a definition may carry `enabled` (default true). PreInvocation fires before each model call and can
// answer { injectSteps: [{ ephemeralMessage }] }; PostToolUse cannot inject.
//
// Orca already keeps its own definition there ("orca-status", for status) and rewrites only that key.
// We add one more, "orca-flow-reload": PreInvocation gives the note (at the next prompt, and after a
// tool call inside a turn), PostToolUse on run_command records the confirmation. Both run
// scripts/agy-hook.mjs through the Antigravity skill link (~/.gemini/config/skills/orca-flow), and
// start node only while a reload waits, like Orca's own commands wrapped in /bin/sh -c.
// The docs describe no trust step for hooks; we never touch settings.json, trust or credentials.
// Fixture-tested only: agy was not installed where this was written.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Our definition's name in hooks.json (Orca's is "orca-status"). */
export const AGY_HOOK_NAME = 'orca-flow-reload'

/** agy's global hooks file. */
export const agyHooksFile = (home = homedir()) => join(home, '.gemini', 'config', 'hooks.json')

/** The Antigravity skill link the installed plugin keeps (src/install.ts linksFor). */
export const agySkillLink = (home = homedir()) => join(home, '.gemini', 'config', 'skills', 'orca-flow')

/**
 * One handler's command: /bin/sh -c '<gate>' as Orca writes its own, so it runs the same whether agy
 * passes it through a shell or splits it. Starts node only while ~/.orca-flow/skill-reload/active
 * exists; otherwise answers {} at once.
 */
export function agyCommand(skill: string, event: 'PreInvocation' | 'PostToolUse'): string {
  if (skill.includes("'")) throw new Error(`cannot quote ${skill}`)
  const script = `if [ -e "\${ORCA_FLOW_DIR:-$HOME/.orca-flow}/skill-reload/active" ]; then exec node "${join(skill, 'scripts', 'agy-hook.mjs')}" ${event}; else echo "{}"; fi`
  return `/bin/sh -c '${script}'`
}

/** Our hook definition, in the documented shapes. */
export function agyDefinition(skill = agySkillLink()): Record<string, unknown> {
  return {
    PreInvocation: [{ type: 'command', command: agyCommand(skill, 'PreInvocation'), timeout: 10 }],
    PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: agyCommand(skill, 'PostToolUse'), timeout: 10 }] }]
  }
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Puts our definition in agy's hooks.json: added when missing, updated in place when it differs, a
 * user's `enabled: false` kept. Orca's "orca-status" and every other key stay as they are. A missing
 * file is left alone (Orca creates it when it sets up Antigravity's status hooks), as is one that is
 * not a JSON object. Written atomically, 2-space JSON. Returns what it did, for the log.
 */
export function ensureAntigravityHooks(file = agyHooksFile(), skill = agySkillLink()): string[] {
  if (!existsSync(file)) return [`left ${file}: no Antigravity hooks file yet (Orca creates it)`]
  let data: unknown
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return [`left ${file}: not valid JSON (${(e as Error).message})`] }
  if (!isObject(data)) return [`left ${file}: not a JSON object`]
  const old = data[AGY_HOOK_NAME]
  const want: Record<string, unknown> = { ...agyDefinition(skill), ...(isObject(old) && old.enabled === false ? { enabled: false } : {}) }
  if (JSON.stringify(old) === JSON.stringify(want)) return []
  data[AGY_HOOK_NAME] = want
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const temp = `${file}.orca-flow-${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(temp, file)
  } catch (e) {
    return [`could not write ${file}: ${(e as Error).message}`]
  }
  return [`${old === undefined ? 'added' : 'updated'} the ${AGY_HOOK_NAME} hooks in ${file}`]
}

/** Like ensureOwnStopHook: only the installed copy writes, never a development folder. */
export function ensureOwnAntigravityHooks(installed: boolean, file = agyHooksFile(), skill = agySkillLink()): string[] {
  if (!installed) return existsSync(file) ? [`left the Antigravity hooks in ${file} to the installed copy: this is a development folder`] : []
  return ensureAntigravityHooks(file, skill)
}

export type AgyReadiness = { state: 'ready' | 'not-installed' | 'disabled' | 'unreadable'; reason: string }

/** The short reason the sidebar shows for each state, with the one action to take. */
export const AGY_REASON: Record<AgyReadiness['state'], string> = {
  'ready': '',
  'not-installed': 'Antigravity: Orca Flow\'s hooks are not installed yet; update Orca Flow (it adds them once Orca has set up Antigravity)',
  'disabled': 'Antigravity: Orca Flow\'s hooks are turned off; turn orca-flow-reload on with /hooks in agy',
  'unreadable': 'Antigravity: ~/.gemini/config/hooks.json cannot be read; restart to reload'
}

/**
 * Whether Antigravity sessions can take the note: our definition in agy's hooks.json with both
 * events and not turned off. Reads only. agy documents no trust step for hooks, so there is none to read.
 */
export function antigravityReloadReadiness(file = agyHooksFile()): AgyReadiness {
  const r = (state: AgyReadiness['state']): AgyReadiness => ({ state, reason: AGY_REASON[state] })
  let data: unknown
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return r((e as { code?: string }).code === 'ENOENT' ? 'not-installed' : 'unreadable') }
  if (!isObject(data)) return r('unreadable')
  const ours = data[AGY_HOOK_NAME]
  if (!isObject(ours)) return r('not-installed')
  const runs = (handlers: unknown) => Array.isArray(handlers) && handlers.some((h) => typeof h?.command === 'string' && h.command.includes('scripts/agy-hook.mjs'))
  const post = Array.isArray(ours.PostToolUse) && ours.PostToolUse.some((g: any) => runs(g?.hooks))
  if (!runs(ours.PreInvocation) || !post) return r('not-installed')
  return r(ours.enabled === false ? 'disabled' : 'ready')
}
