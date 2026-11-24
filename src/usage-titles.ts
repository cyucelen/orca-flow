// Orca task titles for the Usage view: the `--task-title` given at dispatch, read from Orca's task
// records (`orca orchestration task-list --run <id>`: id, status, title). Titles are metadata the user
// wrote for the task, not chat or log content. Kept in ~/.orca-flow/usage/titles.json (task id →
// title) so a title survives its run being cleaned up; only ids and titles are stored.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Titles = Record<string, string>
const FILE = 'titles.json'
const MAX_TITLE = 160

/** `task-list --json` result → task id → title (blank titles dropped). */
export function parseTaskTitles(result: unknown): Titles {
  const out: Titles = {}
  const tasks = (result as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(tasks)) return out
  for (const t of tasks) {
    const id = typeof t?.id === 'string' ? t.id : null
    const title = typeof t?.title === 'string' ? t.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : ''
    if (id && title) out[id] = title
  }
  return out
}

export function readTitles(dataDir: string): Titles {
  try {
    const path = join(dataDir, 'usage', FILE)
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; titles?: unknown }
    if (raw?.v !== 1 || !raw.titles || typeof raw.titles !== 'object') return {}
    return parseTaskTitles({ tasks: Object.entries(raw.titles as Record<string, unknown>).map(([id, title]) => ({ id, title })) })
  } catch {
    return {}
  }
}

export function writeTitles(dataDir: string, titles: Titles): void {
  const dir = join(dataDir, 'usage')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, FILE)
  writeFileSync(`${path}.tmp`, JSON.stringify({ v: 1, titles }))
  renameSync(`${path}.tmp`, path)
}

/** The runs whose tasks have no title yet, from the links (task id and run id of every dispatch). */
export function runsMissingTitles(links: { taskId?: string | null; runId?: string | null }[], titles: Titles): string[] {
  const runs = new Set<string>()
  for (const l of links) if (l.taskId && l.runId && !titles[l.taskId]) runs.add(l.runId)
  return [...runs]
}
