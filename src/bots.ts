// The user's Orca bots, for the Bots section. `orca bot list` is the source of truth for which bots
// exist; each bot's folder (~/.orca/bots/<folder>) gives its avatar and, when Orca gives no
// specialty, its purpose; `orca automations list` gives its next run. Its chats are the agents in its
// workspaces (`bot` in `orca worktree ps`), which leave the ordinary rows: a bot shows once, here.
//
// Grouping is explicit: a coordinator adopts a bot by naming it in its coordinator.json `bots`.
// Everything else is Personal. Pure functions, so it is tested in Node; the worker does the reads.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Bot, BotChat, WorkspaceRow } from './protocol.ts'

export const BOT_HOME = join(homedir(), '.orca', 'bots')

/** A bot as `orca bot list --json` lists it. */
export type ListedBot = { id?: string; name?: string; paused?: boolean; specialty?: string | null }
/** A folder under BOT_HOME: its bot.json and the first lines of its SOUL.md. */
export type BotFolder = { folder: string; path: string; id: string | null; name: string | null; avatar: string | null; soul: string }
/** An automation as `orca automations list --json` lists it (only what the row needs). */
export type BotAutomation = { bot?: { botId?: string } | null; enabled?: boolean; nextRunAt?: number | null }

/** How long a purpose crosses to the panel; the row cuts it to one line anyway. */
const PURPOSE_MAX = 160

/** Markdown as one plain line: no emphasis, code ticks, links' targets, headings or list marks. */
export function plainText(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`+)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** The first line of SOUL.md that is not a heading (nor blank): what the bot says it is for. */
export function soulLine(soul: string): string {
  const line = soul.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !/^(?:---|===)/.test(l))
  return line ? plainText(line) : ''
}

/** One line on what the bot is for: Orca's specialty, else its SOUL.md. */
export function purposeOf(specialty: string | null | undefined, soul: string): string {
  return clip(plainText(specialty ?? '') || soulLine(soul), PURPOSE_MAX)
}

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** Every folder under `root` with a bot.json; unreadable ones are skipped. */
export function readBotFolders(root = BOT_HOME): BotFolder[] {
  if (!existsSync(root)) return []
  let names: string[] = []
  try { names = readdirSync(root).sort() } catch { return [] }
  return names.flatMap((folder) => {
    const path = join(root, folder)
    const json = readJson(join(path, 'bot.json'))
    if (!json) return []
    let soul = ''
    try { soul = readFileSync(join(path, 'SOUL.md'), 'utf8').slice(0, 4000) } catch {}
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
    return [{ folder, path, id: str(json.id), name: str(json.name), avatar: str(json.avatar), soul }]
  })
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/** A listed bot's folder: the one whose bot.json has its id, else the one named after it. */
export function folderOf(bot: { id?: string | null; name: string }, folders: BotFolder[]): BotFolder | undefined {
  return folders.find((f) => bot.id && f.id === bot.id) ?? folders.find((f) => same(f.name, bot.name) || same(f.folder, bot.name))
}

/** The soonest run, still ahead, of this bot's enabled automations. */
export function nextRunOf(botId: string, automations: BotAutomation[], now: number): number | null {
  const next = automations
    .filter((a) => a.enabled !== false && a.bot?.botId === botId && typeof a.nextRunAt === 'number' && a.nextRunAt > now)
    .map((a) => a.nextRunAt as number)
  return next.length ? Math.min(...next) : null
}

/**
 * Which coordinator adopted each bot: the first (in `coordinators` order) whose `bots` names it, by
 * its name or its folder name, case-insensitive. `duplicates` says which bots more than one listed.
 * Coordinators' `repos` play no part.
 */
export function groupBots(bots: { name: string; folder: string | null }[], coordinators: { key: string; bots?: string[] }[]): { owner: Map<string, string | null>; duplicates: { bot: string; kept: string; also: string[] }[] } {
  const owner = new Map<string, string | null>()
  const duplicates: { bot: string; kept: string; also: string[] }[] = []
  for (const b of bots) {
    const listing = coordinators.filter((c) => (c.bots ?? []).some((entry) => same(entry, b.name) || same(entry, b.folder)))
    owner.set(b.name, listing[0]?.key ?? null)
    if (listing.length > 1) duplicates.push({ bot: b.name, kept: listing[0].key, also: listing.slice(1).map((c) => c.key) })
  }
  return { owner, duplicates }
}

/** A workspace of an Orca bot: Orca marks it (`bot`), or it is a folder under BOT_HOME. */
export const isBotRow = (row: Pick<WorkspaceRow, 'bot' | 'path'>, root = BOT_HOME) =>
  Boolean(row.bot) || (!!row.path && (row.path === root || row.path.startsWith(`${root}/`)))

/** Which bot a bot workspace belongs to: by Orca's `bot` name, else by its folder. */
function rowBelongs(row: WorkspaceRow, bot: { name: string; folder: BotFolder | undefined }): boolean {
  if (row.bot) return same(row.bot, bot.name) || same(row.bot, bot.folder?.folder) || same(row.bot, bot.folder?.name)
  return !!bot.folder && !!row.path && (row.path === bot.folder.path || row.path.startsWith(`${bot.folder.path}/`))
}

/**
 * Pure: the Bots section's bots. `listed` is `orca bot list` (null when it could not be read): only
 * listed bots show, plus a bot workspace no listed bot claims (so its asks never vanish); a folder
 * with no listed bot and no workspace does not. Each bot gets its folder, purpose, group, chats,
 * home workspace and next run.
 */
export function buildBots(input: {
  listed: ListedBot[] | null
  folders: BotFolder[]
  automations: BotAutomation[]
  botRows: WorkspaceRow[]
  coordinators: { key: string; bots?: string[] }[]
  now: number
}): { bots: Bot[]; duplicates: { bot: string; kept: string; also: string[] }[] } {
  const { folders, automations, botRows, now } = input
  const base = (input.listed ?? [])
    .filter((b): b is ListedBot & { name: string } => typeof b.name === 'string' && b.name.length > 0)
    .map((b) => ({ id: b.id ?? `name:${b.name}`, name: b.name, paused: b.paused === true, specialty: b.specialty ?? null, folder: folderOf({ id: b.id, name: b.name }, folders) }))
  // A bot workspace no listed bot claims still shows, named as Orca names it.
  for (const row of botRows) {
    if (base.some((b) => rowBelongs(row, b))) continue
    const name = row.bot || row.name
    const folder = folderOf({ name }, folders) ?? folders.find((f) => row.path === f.path)
    if (!base.some((b) => same(b.name, name))) base.push({ id: folder?.id ?? `name:${name}`, name, paused: false, specialty: null, folder })
  }
  const { owner, duplicates } = groupBots(base.map((b) => ({ name: b.name, folder: b.folder?.folder ?? null })), input.coordinators)
  const bots = base.map((b): Bot => {
    const rows = botRows.filter((r) => rowBelongs(r, b))
    const home = rows.find((r) => b.folder && r.path === b.folder.path) ?? rows[0]
    const chats: BotChat[] = rows.flatMap((r) => r.agents.map((agent) => ({ workspaceId: r.id, agent })))
    return {
      id: b.id,
      name: b.name,
      folder: b.folder?.folder ?? null,
      avatar: b.folder?.avatar ?? null,
      purpose: purposeOf(b.specialty, b.folder?.soul ?? ''),
      paused: b.paused,
      coordinator: owner.get(b.name) ?? null,
      workspaceId: home?.id ?? null,
      chats,
      nextRunAt: nextRunOf(b.id, automations, now)
    }
  })
  return { bots, duplicates }
}
