// Reads and writes ~/.orca-flow/config.json for the Settings dialog and the card writer.
// Only the plugin worker writes it; the panel asks the worker (sidebar.settings, sidebar.saveSettings).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applySettings, normalizeSettings, same, type FlowSettings } from './settings.ts'

export const CONFIG_DIR = join(homedir(), '.orca-flow')
export const configFile = (dir = CONFIG_DIR) => join(dir, 'config.json')

export type ConfigRead = {
  settings: FlowSettings
  /** The file's object as written, unknown keys included; {} when there is no file. */
  raw: Record<string, unknown>
  /** Why the file could not be used; its settings then read as defaults, and saving is refused. */
  error: string | null
}

export function readSettings(dir = CONFIG_DIR): ConfigRead {
  let text: string
  try {
    text = readFileSync(configFile(dir), 'utf8')
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return { settings: normalizeSettings({}), raw: {}, error: null }
    return { settings: normalizeSettings({}), raw: {}, error: `~/.orca-flow/config.json can’t be read (${(e as { code?: string }).code ?? 'error'}).` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { settings: normalizeSettings({}), raw: {}, error: `~/.orca-flow/config.json isn’t valid JSON (${(e as Error).message.replace(/\.$/, '')}).` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings: normalizeSettings({}), raw: {}, error: '~/.orca-flow/config.json must hold one JSON object, like {"marginGB": 3}.' }
  }
  return { settings: normalizeSettings(raw), raw: raw as Record<string, unknown>, error: null }
}

/** The writers to try, in order. A broken file reads as defaults, today's Haiku then Luna. */
export const configuredWriters = (dir = CONFIG_DIR) => readSettings(dir).settings.writers

/**
 * Saves `next` over what the file holds now: only changed keys are touched, a key back at its default
 * is removed, unknown keys stay. Atomic (a temp file renamed over it). A file that cannot be read is
 * never overwritten: this throws instead. No file and nothing to save: no file is created.
 */
export function writeSettings(next: FlowSettings, dir = CONFIG_DIR): ConfigRead {
  const current = readSettings(dir)
  if (current.error) throw new Error(`${current.error} Fix or remove the file; Orca Flow won’t overwrite it.`)
  const raw = applySettings(current.raw, next)
  if (same(raw, current.raw)) return current
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`)
    renameSync(tmp, configFile(dir))
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  return readSettings(dir)
}
