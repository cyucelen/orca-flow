// What the plugin needs outside its own folder, set up each time the worker starts. The orca-flow
// skill (with its script) is linked into the Claude profile Orca's agents use, and the link follows
// the installed plugin wherever Orca put it; a development folder never takes it. The CLAUDE.md every coordinator folder inherits is copied
// once from a template and then belongs to the user: coordinators keep project notes in it. The
// profile's settings.json gets one Stop hook that checks coordinators' and leads' messages against
// the message frame (skills/orca-flow/scripts/stop-check.mjs) and one UserPromptSubmit hook that
// passes its quiet reminders to the agent (prompt-check.mjs); both do nothing until the user opts in.
// A SessionStart hook (session-start.mjs) gives a lead its role instructions back when its session
// resumes or compacts; it needs no opt-in and gives everyone else nothing. A PreToolUse hook on the
// Agent tool (delegation-check.mjs) denies a coordinator's or lead's native subagent for anything
// but a read-only lookup and points it at `orca-flow dispatch`; on by default, off with
// "delegationCheck": "off" in ~/.orca-flow/config.json. A PostToolUse hook (reload-check.mjs) hands a
// busy agent the sidebar's "Reload skills" note after a tool call; its command starts node only while
// ~/.orca-flow/skill-reload/active exists, so it costs other tool calls a file test.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { COORDINATOR_HOME } from './coordinators.ts'
import { claudeConfigDir } from './summarize.ts'

export type Link = { from: string; to: string; preserveUserLinks?: boolean }

/** Orca's selected host profile wins; an explicit profile is the fallback outside profile management. */
export function claudeDiscoveryDir(home: string, selected: string | null, explicit?: string): string {
  return selected || explicit || join(home, '.claude')
}

/** The plugin folder: this file lives in <plugin>/src. */
export function pluginDir(moduleUrl: string): string | null {
  const dir = decodeURIComponent(new URL('..', moduleUrl).pathname).replace(/\/$/, '')
  return existsSync(join(dir, 'orca-plugin.json')) ? dir : null
}

export function linksFor(dir: string, home = homedir(), claudeDir = claudeDiscoveryDir(home, claudeConfigDir(), process.env.CLAUDE_CONFIG_DIR)): Link[] {
  return [
    { from: join(claudeDir, 'skills', 'orca-flow'), to: join(dir, 'skills', 'orca-flow') },
    // USER discovery is HOME, not CODEX_HOME: Orca's selected account changes CODEX_HOME,
    // but shares the user's .agents skills. Never modify account credentials/configuration.
    { from: join(home, '.agents', 'skills', 'orca-flow'), to: join(dir, 'skills', 'orca-flow') },
    { from: join(home, '.gemini', 'config', 'skills', 'orca-flow'), to: join(dir, 'skills', 'orca-flow'), preserveUserLinks: true }
  ]
}

/** Files copied once from a template, then left to the user. */
export function seedsFor(dir: string, home = COORDINATOR_HOME): Link[] {
  return [{ from: join(home, 'CLAUDE.md'), to: join(dir, 'skills', 'orca-flow', 'templates', 'coordinators-CLAUDE.md') }]
}

/** Writes each missing file from its template; a link left by an older version becomes a real copy. */
export function ensureSeeds(seeds: Link[]): string[] {
  const done: string[] = []
  for (const { from, to } of seeds) {
    try {
      let link = false
      try {
        link = lstatSync(from).isSymbolicLink()
      } catch {
        // missing: written below
      }
      if (existsSync(from) && !link) continue
      // Only the exact legacy template link may be converted. Other plugins/user links belong
      // to their owner, even when dangling.
      if (link && resolve(from, '..', readlinkSync(from)) !== resolve(to)) continue
      if (link) unlinkSync(from)
      mkdirSync(join(from, '..'), { recursive: true })
      copyFileSync(to, from)
      done.push(`wrote ${from}`)
    } catch (e) {
      done.push(`could not write ${from}: ${(e as Error).message}`)
    }
  }
  return done
}

/**
 * Creates each missing link and repoints one of ours (a symlink) that points elsewhere, such as at
 * an older install. With `repairOnly`, a link whose target still exists is kept: only a missing or
 * dangling one is fixed. Returns what it did, one line each, for the log.
 */
export function ensureLinks(links: Link[], { repairOnly = false } = {}): string[] {
  const done: string[] = []
  for (const { from, to, preserveUserLinks } of links) {
    let stat: { isSymbolicLink(): boolean } | null = null
    try {
      stat = lstatSync(from)
    } catch {}
    try {
      if (stat && !stat.isSymbolicLink()) {
        if (!repairOnly) done.push(`kept ${from}: not a link`)
        continue
      }
      const previous = stat ? readlinkSync(from) : null
      if (previous === to) continue
      if (previous && preserveUserLinks) {
        // Installed releases live under the same plugin key in content-addressed directories.
        const release = /^(.*\/plugins\/[^/]+)\/(?:[a-f0-9]{64}|current)\/skills\/orca-flow$/
        const owner = release.exec(to)?.[1]
        if (!owner || release.exec(previous)?.[1] !== owner) continue
      }
      if (stat && repairOnly && existsSync(from)) continue
      if (stat) unlinkSync(from)
      mkdirSync(join(from, '..'), { recursive: true })
      symlinkSync(to, from)
      done.push(`linked ${from}`)
    } catch (e) {
      done.push(`could not link ${from}: ${(e as Error).message}`)
    }
  }
  return done
}

/**
 * Only the installed copy owns the links. A development folder (`scripts/dev.sh load` in a
 * worktree) leaves them alone: a link into a worktree breaks every agent's skill once it is removed.
 */
export function ensureOwnLinks(links: Link[], installed: boolean, options: { repairOnly?: boolean } = {}): string[] {
  if (installed) return links.flatMap((link) => {
    try {
      const stat = lstatSync(link.from)
      if (stat.isSymbolicLink()) {
        if (options.repairOnly && existsSync(link.from)) return []
        const target = resolve(link.from, '..', readlinkSync(link.from))
        if (target !== resolve(link.to)) {
          const install = /^(.*\/plugins\/cyucelen\.flow)\/(?:[a-f0-9]{64}|current)\/skills\/orca-flow$/
          const oldInstall = install.exec(target), newInstall = install.exec(resolve(link.to))
          // Known installed release paths retain ownership even after Orca removes an old hash.
          if (oldInstall && newInstall && oldInstall[1] === newInstall[1]) return ensureLinks([link], options)
          // A symlink alone is not proof of ownership. Only our installed plugin's skill can
          // be replaced; unknown/dangling destinations are preserved for the user.
          const manifest = JSON.parse(readFileSync(join(target, '..', '..', 'orca-plugin.json'), 'utf8'))
          if (manifest.id !== 'flow' || manifest.name !== 'Orca Flow') return [`kept ${link.from}: belongs to another source`]
        }
      }
    } catch (e) {
      try { lstatSync(link.from); return [`kept ${link.from}: ownership is unverified`] } catch {}
    }
    return ensureLinks([link], options)
  })
  return options.repairOnly ? [] : [`left ${links.map((l) => l.from).join(', ')} to the installed copy: this is a development folder`]
}

/** Finds our Stop hook among the others in settings.json. */
export const STOP_HOOK_MARK = 'skills/orca-flow/scripts/stop-check.mjs'
/** Finds our UserPromptSubmit hook, which gives the agent the Stop hook's quiet reminders. */
export const PROMPT_HOOK_MARK = 'skills/orca-flow/scripts/prompt-check.mjs'
/** Finds our SessionStart hook, which gives a lead its role back after a resume or a compaction. */
export const SESSION_HOOK_MARK = 'skills/orca-flow/scripts/session-start.mjs'
/** Finds our PreToolUse hook, which sends a coordinator's or lead's work to Orca workers. */
export const DELEGATION_HOOK_MARK = 'skills/orca-flow/scripts/delegation-check.mjs'
/** Finds our PostToolUse hook, which gives a busy agent the sidebar's skill-reload note. */
export const RELOAD_HOOK_MARK = 'skills/orca-flow/scripts/reload-check.mjs'
/** The Agent tool, under its current name and the one it had before. */
export const AGENT_TOOL_MATCHER = 'Agent|Task'

export type HookEvent = 'Stop' | 'UserPromptSubmit' | 'SessionStart' | 'PreToolUse' | 'PostToolUse'
export type StopHook = { path: string; event?: HookEvent; mark?: string; entry: { matcher?: string; hooks: { type: 'command'; command: string; timeout: number }[] } }

/** One of our hook entries: it runs the script through the skill link, only in an Orca agent pane. */
function hookFor(claudeDir: string, event: HookEvent, mark: string, matcher?: string, gate = ''): StopHook {
  const script = join(claudeDir, mark)
  const hooks: StopHook['entry']['hooks'] = [{ type: 'command', command: `if [ -n "\${ORCA_AGENT_PANE-}" ]${gate}; then node "${script}"; fi`, timeout: 10 }]
  return { path: join(claudeDir, 'settings.json'), event, mark, entry: matcher === undefined ? { hooks } : { matcher, hooks } }
}

/** The profile's settings.json and our Stop hook entry. */
export function stopHookFor(home = homedir(), claudeDir = claudeDiscoveryDir(home, claudeConfigDir(), process.env.CLAUDE_CONFIG_DIR)): StopHook {
  return hookFor(claudeDir, 'Stop', STOP_HOOK_MARK)
}

/** The profile's settings.json and our UserPromptSubmit hook entry. */
export function promptHookFor(home = homedir(), claudeDir = claudeDiscoveryDir(home, claudeConfigDir(), process.env.CLAUDE_CONFIG_DIR)): StopHook {
  return hookFor(claudeDir, 'UserPromptSubmit', PROMPT_HOOK_MARK)
}

/**
 * The profile's settings.json and our SessionStart hook entry. No matcher: it runs on every source
 * and the script decides (resume and compact, startup only for a recorded lead).
 */
export function sessionHookFor(home = homedir(), claudeDir = claudeDiscoveryDir(home, claudeConfigDir(), process.env.CLAUDE_CONFIG_DIR)): StopHook {
  return hookFor(claudeDir, 'SessionStart', SESSION_HOOK_MARK)
}

/** The profile's settings.json and our PreToolUse hook entry, for the Agent tool only. */
export function delegationHookFor(home = homedir(), claudeDir = claudeDiscoveryDir(home, claudeConfigDir(), process.env.CLAUDE_CONFIG_DIR)): StopHook {
  return hookFor(claudeDir, 'PreToolUse', DELEGATION_HOOK_MARK, AGENT_TOOL_MATCHER)
}

/**
 * The profile's settings.json and our PostToolUse hook entry, on every tool (no matcher). The shell
 * starts node only while a reload request waits (skill-reload.mjs keeps the `active` file in step).
 */
export function reloadHookFor(home = homedir(), claudeDir = claudeDiscoveryDir(home, claudeConfigDir(), process.env.CLAUDE_CONFIG_DIR)): StopHook {
  return hookFor(claudeDir, 'PostToolUse', RELOAD_HOOK_MARK, undefined, ' && [ -e "${ORCA_FLOW_DIR:-$HOME/.orca-flow}/skill-reload/active" ]')
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Makes settings.json hold one of our hooks exactly once under its event (Stop unless the hook
 * names another): added when missing, updated in place when it differs, a second copy removed.
 * An entry with a matcher lives in a group with exactly that matcher: found under another one, it
 * leaves that group (the group's other hooks stay) and goes in a group of its own.
 * Every other key and hook stays as it is (Orca keeps its own hooks here). A file it cannot read
 * as a JSON object is left alone; a missing one is created with only our hook. Written atomically,
 * 2-space JSON. Returns what it did, one line each, for the log.
 */
export function ensureStopHook({ path, entry, event = 'Stop', mark = STOP_HOOK_MARK }: StopHook): string[] {
  const ours = (hook: any) => typeof hook?.command === 'string' && hook.command.includes(mark)
  let text: string | null = null
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') return [`left ${path}: ${(e as Error).message}`]
  }
  let settings: Record<string, any>
  if (text === null) settings = {}
  else {
    try {
      settings = JSON.parse(text)
    } catch (e) {
      return [`left ${path}: not valid JSON (${(e as Error).message}); the ${event} hook is not installed`]
    }
    if (!isObject(settings)) return [`left ${path}: not a JSON object; the ${event} hook is not installed`]
  }
  const hooks = settings.hooks ?? {}
  const list = hooks[event] ?? []
  if (!isObject(hooks) || !Array.isArray(list)) return [`left ${path}: hooks.${event} is not a list; the ${event} hook is not installed`]

  const want = entry.hooks[0]
  const matched = (group: Record<string, any>) => entry.matcher === undefined || group.matcher === entry.matcher
  let found = false
  let changed = false
  let moved = false
  const groups: any[] = []
  for (const group of list) {
    if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(ours)) {
      groups.push(group)
      continue
    }
    const kept: any[] = []
    for (const hook of group.hooks) {
      if (!ours(hook)) kept.push(hook)
      else if (!matched(group)) moved = true // under another matcher: it goes in a group of its own
      else if (found) changed = true // a second copy
      else {
        found = true
        if (JSON.stringify(hook) !== JSON.stringify(want)) changed = true
        kept.push(want)
      }
    }
    if (kept.length) groups.push({ ...group, hooks: kept })
  }
  if (found && !changed && !moved) return []
  if (!found) groups.push(entry)
  settings.hooks = { ...hooks, [event]: groups }

  try {
    // Through a link to settings.json, write the file it points at, keeping the link.
    const link = text !== null && lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null
    const target = link ? (link.startsWith('/') ? link : join(path, '..', link)) : path
    mkdirSync(join(target, '..'), { recursive: true })
    const temp = `${target}.orca-flow-${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`)
    renameSync(temp, target)
  } catch (e) {
    return [`could not write ${path}: ${(e as Error).message}`]
  }
  return [`${found || moved ? 'updated' : 'added'} the ${event} hook in ${path}`]
}

/**
 * Like ensureOwnLinks: only the installed copy writes our hooks, never a development folder. With
 * the Stop hook go its UserPromptSubmit partner, the SessionStart hook, the PreToolUse
 * delegation hook and the PostToolUse skill-reload hook, in the same settings.json.
 */
export function ensureOwnStopHook(hook: StopHook, installed: boolean): string[] {
  if (!installed) return [`left the Stop, UserPromptSubmit, SessionStart, PreToolUse and PostToolUse hooks in ${hook.path} to the installed copy: this is a development folder`]
  const claudeDir = join(hook.path, '..')
  return [
    ...ensureStopHook(hook),
    ...ensureStopHook(promptHookFor(undefined, claudeDir)),
    ...ensureStopHook(sessionHookFor(undefined, claudeDir)),
    ...ensureStopHook(delegationHookFor(undefined, claudeDir)),
    ...ensureStopHook(reloadHookFor(undefined, claudeDir))
  ]
}
