// What the plugin needs outside its own folder, set up each time the worker starts. The orca-flow
// skill (with its script) is linked into the Claude profile Orca's agents use, and the link follows
// the installed plugin wherever Orca put it; a development folder never takes it. The CLAUDE.md every coordinator folder inherits is copied
// once from a template and then belongs to the user: coordinators keep project notes in it. The
// profile's settings.json gets one Stop hook that checks coordinators' and leads' messages against
// the message frame (skills/orca-flow/scripts/stop-check.mjs) and one UserPromptSubmit hook that
// passes its quiet reminders to the agent (prompt-check.mjs); both do nothing until the user opts in.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { COORDINATOR_HOME } from './coordinators.ts'
import { claudeConfigDir } from './summarize.ts'

export type Link = { from: string; to: string }

/** The plugin folder: this file lives in <plugin>/src. */
export function pluginDir(moduleUrl: string): string | null {
  const dir = decodeURIComponent(new URL('..', moduleUrl).pathname).replace(/\/$/, '')
  return existsSync(join(dir, 'orca-plugin.json')) ? dir : null
}

export function linksFor(dir: string, home = homedir(), claudeDir = claudeConfigDir() ?? join(home, '.claude')): Link[] {
  return [
    { from: join(claudeDir, 'skills', 'orca-flow'), to: join(dir, 'skills', 'orca-flow') },
    { from: join(home, '.gemini', 'skills', 'orca-flow'), to: join(dir, 'skills', 'orca-flow') }
  ]
}

/** Files copied once from a template, then left to the user. */
export function seedsFor(dir: string, home = COORDINATOR_HOME): Link[] {
  const template = join(dir, 'skills', 'orca-flow', 'templates', 'coordinators-CLAUDE.md')
  return [
    { from: join(home, 'CLAUDE.md'), to: template },
    { from: join(home, 'AGENTS.md'), to: template }
  ]
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
  for (const { from, to } of links) {
    let stat: { isSymbolicLink(): boolean } | null = null
    try {
      stat = lstatSync(from)
    } catch {}
    try {
      if (stat && !stat.isSymbolicLink()) {
        if (!repairOnly) done.push(`kept ${from}: not a link`)
        continue
      }
      if (stat && readlinkSync(from) === to) continue
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
  if (installed) return ensureLinks(links, options)
  return options.repairOnly ? [] : [`left ${links.map((l) => l.from).join(', ')} to the installed copy: this is a development folder`]
}

/** Finds our Stop hook among the others in settings.json. */
export const STOP_HOOK_MARK = 'skills/orca-flow/scripts/stop-check.mjs'
/** Finds our UserPromptSubmit hook, which gives the agent the Stop hook's quiet reminders. */
export const PROMPT_HOOK_MARK = 'skills/orca-flow/scripts/prompt-check.mjs'

export type HookEvent = 'Stop' | 'UserPromptSubmit'
export type StopHook = { path: string; event?: HookEvent; mark?: string; entry: { hooks: { type: 'command'; command: string; timeout: number }[] } }

/** One of our hook entries: it runs the script through the skill link, only in an Orca agent pane. */
function hookFor(claudeDir: string, event: HookEvent, mark: string): StopHook {
  const script = join(claudeDir, mark)
  return {
    path: join(claudeDir, 'settings.json'),
    event,
    mark,
    entry: { hooks: [{ type: 'command', command: `if [ -n "\${ORCA_AGENT_PANE-}" ]; then node "${script}"; fi`, timeout: 10 }] }
  }
}

/** The profile's settings.json and our Stop hook entry. */
export function stopHookFor(home = homedir(), claudeDir = claudeConfigDir() ?? join(home, '.claude')): StopHook {
  return hookFor(claudeDir, 'Stop', STOP_HOOK_MARK)
}

/** The profile's settings.json and our UserPromptSubmit hook entry. */
export function promptHookFor(home = homedir(), claudeDir = claudeConfigDir() ?? join(home, '.claude')): StopHook {
  return hookFor(claudeDir, 'UserPromptSubmit', PROMPT_HOOK_MARK)
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Makes settings.json hold one of our hooks exactly once under its event (Stop unless the hook
 * names another): added when missing, updated in place when it differs, a second copy removed.
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
  let found = false
  let changed = false
  const groups: any[] = []
  for (const group of list) {
    if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(ours)) {
      groups.push(group)
      continue
    }
    const kept: any[] = []
    for (const hook of group.hooks) {
      if (!ours(hook)) kept.push(hook)
      else if (found) changed = true // a second copy
      else {
        found = true
        if (JSON.stringify(hook) !== JSON.stringify(want)) changed = true
        kept.push(want)
      }
    }
    if (kept.length) groups.push({ ...group, hooks: kept })
  }
  if (found && !changed) return []
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
  return [`${found ? 'updated' : 'added'} the ${event} hook in ${path}`]
}

/**
 * Like ensureOwnLinks: only the installed copy writes our hooks, never a development folder. With
 * the Stop hook goes its UserPromptSubmit partner, in the same settings.json.
 */
export function ensureOwnStopHook(hook: StopHook, installed: boolean): string[] {
  if (!installed) return [`left the Stop and UserPromptSubmit hooks in ${hook.path} to the installed copy: this is a development folder`]
  const claudeDir = join(hook.path, '..')
  return [...ensureStopHook(hook), ...ensureStopHook(promptHookFor(undefined, claudeDir))]
}
