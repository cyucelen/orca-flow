// What the plugin needs outside its own folder, set up each time the worker starts. The orca-flow
// skill (with its script) is linked into the Claude profile Orca's agents use, and the link follows
// the installed plugin wherever Orca put it; a development folder never takes it. The CLAUDE.md every coordinator folder inherits is copied
// once from a template and then belongs to the user: coordinators keep project notes in it.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
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
    { from: join(claudeDir, 'skills', 'orca-flow'), to: join(dir, 'skills', 'orca-flow') }
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
