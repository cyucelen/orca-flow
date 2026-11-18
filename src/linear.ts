// The Linear section: what the worker reads from `orca linear`, and the rules the panel follows.
// Which issues each filter shows and in what order, the coordinator a send suggests, the message a
// send types into its chat, and the steps of a send. Pure, except loadLinear, which takes the
// `orca` runner (the file it remembers sends in is read in coordinators.ts). Issue text is untrusted: it is cut to one line here and escaped when drawn.
// No Node imports: the panel draws with this file too.
import type { LinearData, LinearIssue, LinearSent } from './protocol.ts'

export type LinearFilter = 'mine' | 'team' | 'cycle'
export const FILTERS: LinearFilter[] = ['mine', 'team', 'cycle']
export const FILTER_NAME: Record<LinearFilter, string> = { mine: 'Mine', team: 'Team', cycle: 'Cycle' }

/** Where the panel keeps the section's fold and filter (plugin storage), so they survive a restart. */
export const LINEAR_UI_KEY = 'linear'
export type LinearUi = { folded: boolean; filter: LinearFilter }
export const DEFAULT_LINEAR_UI: LinearUi = { folded: false, filter: 'mine' }

/** Pure: the stored fold and filter, defaults for anything missing or malformed. */
export function linearUiOf(stored: unknown): LinearUi {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<LinearUi>
  return { folded: s.folded === true, filter: FILTERS.includes(s.filter as LinearFilter) ? (s.filter as LinearFilter) : 'mine' }
}

// ---------- reading issues ----------

/** Linear state types that are still open; completed, canceled and duplicate are not. */
const OPEN_TYPES = ['triage', 'backlog', 'unstarted', 'started']
/** A state named Staging is "started" in Linear, but its work is done: it folds away. */
export const isStaging = (i: LinearIssue) => i.state.name.trim().toLowerCase() === 'staging'
export const isOpen = (i: LinearIssue) => OPEN_TYPES.includes(i.state.type)

/** One line of text, without control characters, so it cannot break a row or the chat message. */
const oneLine = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
const color = (s: unknown) => (typeof s === 'string' && /^#[0-9a-f]{3,8}$/i.test(s) ? s : '')
const ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/

/** Pure: an issue from `orca linear list` / `list-issues` JSON, or null when it is not one. */
export function toIssue(raw: any): LinearIssue | null {
  const id = typeof raw?.identifier === 'string' ? raw.identifier.trim().toUpperCase() : ''
  if (!ISSUE_ID.test(id)) return null
  const priority = Number(raw.priority)
  return {
    id,
    title: oneLine(raw.title),
    url: typeof raw.url === 'string' && /^https:\/\//.test(raw.url) ? raw.url : '',
    state: { name: oneLine(raw.state?.name), type: oneLine(raw.state?.type).toLowerCase(), color: color(raw.state?.color) },
    team: oneLine(raw.team?.key) || id.split('-')[0],
    project: raw.project?.name ? oneLine(raw.project.name) : null,
    assignee: typeof raw.assignee?.id === 'string' ? { id: raw.assignee.id, name: oneLine(raw.assignee.displayName ?? raw.assignee.name) } : null,
    priority: [0, 1, 2, 3, 4].includes(priority) ? priority : 0,
    cycle: typeof raw.cycle?.id === 'string' ? raw.cycle.id : null
  }
}

/** Pure: a worktree's linked issue as an identifier (Orca may hold the identifier or the issue's URL). */
export function linkedIssueOf(linked: unknown): string | null {
  if (typeof linked !== 'string') return null
  const m = /(?:^|\/)([A-Za-z][A-Za-z0-9]*-\d+)(?:$|[/?#])/.exec(linked.trim())
  return m ? m[1].toUpperCase() : null
}

/**
 * Pure: a team's active cycle, from its open issues. The CLI names a cycle only by id and says
 * nothing of dates, so the active one is the cycle most of the team's started issues are in (Linear
 * moves unfinished issues on to the next cycle, so open work gathers in the current one).
 */
export function activeCycle(issues: LinearIssue[]): string | null {
  const counts = new Map<string, number>()
  for (const i of issues) if (i.cycle && i.state.type === 'started') counts.set(i.cycle, (counts.get(i.cycle) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
}

// ---------- what each filter shows, in what order ----------

/** Urgent first, then high, medium, low; no priority last. */
const PRIORITY_RANK = [4, 0, 1, 2, 3]
/** Work under way first, then what is ready, then what waits for triage or the backlog. */
const STATE_RANK = ['in progress', 'in review', 'todo', 'analyzed', 'triage', 'backlog']
const TYPE_RANK = ['started', 'unstarted', 'triage', 'backlog']
const stateRank = (i: LinearIssue) => {
  const named = STATE_RANK.indexOf(i.state.name.toLowerCase())
  return named >= 0 ? named : STATE_RANK.length + Math.max(0, TYPE_RANK.indexOf(i.state.type))
}
const number = (i: LinearIssue) => Number(i.id.split('-').pop())

/** Pure: issues linked to a worktree last; the rest by priority, then state, then newest first. */
export function sortIssues(issues: LinearIssue[], linked: ReadonlySet<string> = new Set()): LinearIssue[] {
  return [...issues].sort((a, b) =>
    Number(linked.has(a.id)) - Number(linked.has(b.id)) ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    stateRank(a) - stateRank(b) ||
    number(b) - number(a) ||
    a.id.localeCompare(b.id))
}

/** Pure: whether an issue belongs to a filter (open or not). */
export function inFilter(i: LinearIssue, data: Pick<LinearData, 'me' | 'teams' | 'cycles'>, filter: LinearFilter): boolean {
  if (filter === 'mine') return data.me !== null && i.assignee?.id === data.me
  if (filter === 'team') return data.teams.includes(i.team)
  return i.cycle !== null && data.cycles.includes(i.cycle) && data.teams.includes(i.team)
}

/** What one filter shows: its open issues in order, and those on Staging (folded away at the end). */
export type LinearView = { shown: LinearIssue[]; staging: LinearIssue[] }

export function viewOf(data: Pick<LinearData, 'me' | 'teams' | 'cycles' | 'issues'>, filter: LinearFilter, linked: ReadonlySet<string> = new Set()): LinearView {
  const these = data.issues.filter((i) => isOpen(i) && inFilter(i, data, filter))
  return { shown: sortIssues(these.filter((i) => !isStaging(i)), linked), staging: sortIssues(these.filter(isStaging), linked) }
}

// ---------- priority words and the message ----------

const PRIORITY_NAME = ['No priority', 'Urgent', 'High', 'Medium', 'Low']
const PRIORITY_WORD = ['someday', 'now', 'today', 'soon', 'someday']
export const priorityName = (p: number) => PRIORITY_NAME[p] ?? PRIORITY_NAME[0]
/** The orca-flow word for Linear's priority; only the message uses it, Linear's priority never changes. */
export const priorityWord = (p: number) => PRIORITY_WORD[p] ?? 'someday'

/** Pure: what a send types into the coordinator's chat. */
export function linearMessage(i: LinearIssue): string {
  const meta = [`Priority: ${priorityWord(i.priority)} (${priorityName(i.priority)} in Linear)`, ...(i.project ? [`Project: ${i.project}`] : [])].join(' · ')
  return [`Start ${i.id}: ${i.title}`, meta, ...(i.url ? [i.url] : []), `Link the worktree with --linear-issue ${i.id}.`].join('\n')
}

// ---------- which coordinator ----------

export type SendTarget = { key: string; suggested: string | null }

/**
 * Pure: the coordinators a send offers, the suggested one first: the one whose `linearTeams` owns the
 * issue's team, else the one this team was last sent to; with neither, the tree's order alone.
 */
export function sendTargets(team: string, coordinators: { key: string; linearTeams?: string[] }[], lastSent: Record<string, string> = {}): SendTarget[] {
  const owner = coordinators.find((c) => c.linearTeams?.includes(team))
  const last = owner ? undefined : coordinators.find((c) => c.key === lastSent[team])
  const pick = owner ?? last
  if (!pick) return coordinators.map((c) => ({ key: c.key, suggested: null }))
  const reason = owner ? `Suggested · owns ${team}` : `Suggested · last sent ${team}`
  return [{ key: pick.key, suggested: reason }, ...coordinators.filter((c) => c !== pick).map((c) => ({ key: c.key, suggested: null }))]
}

// ---------- remembered sends ----------

/** A send no worktree has linked within this long stops showing as starting. */
export const SENT_FOR_MS = 24 * 3_600_000

/** Pure: the sends still starting: not linked by a worktree yet, and recent. Null when nothing changed. */
export function pruneSent(sent: Record<string, LinearSent>, linked: ReadonlySet<string>, now = Date.now()): Record<string, LinearSent> | null {
  const next = Object.fromEntries(Object.entries(sent).filter(([id, s]) => !linked.has(id) && now - s.at < SENT_FOR_MS))
  return Object.keys(next).length === Object.keys(sent).length ? null : next
}

// ---------- a send ----------

type Run = (args: string[], options?: { timeoutMs?: number }) => Promise<any>

/**
 * Sends an issue: `deliver` types the message into the coordinator's chat; only when that worked is
 * the issue moved to In Progress, and assigned to the user if nobody has it. Linear failures come back
 * as warnings: the coordinator already has the work. A dry run only lists the commands.
 */
export async function sendIssue(
  issue: LinearIssue,
  io: { run: Run; deliver: (message: string) => Promise<void>; dryRun?: boolean; log?: (line: string) => void }
): Promise<{ ok: boolean; error?: string; warnings: string[] }> {
  const message = linearMessage(issue)
  const steps: string[][] = [['linear', 'status', 'set', issue.id, '--to', 'In Progress']]
  if (!issue.assignee) steps.push(['linear', 'assignee', 'set', issue.id, '--me'])
  if (io.dryRun) {
    io.log?.(`linear dry run: would send to the chat:\n${message}`)
    for (const s of steps) io.log?.(`linear dry run: orca ${s.join(' ')}`)
    return { ok: true, warnings: [] }
  }
  try {
    await io.deliver(message)
  } catch (e) {
    return { ok: false, error: (e as Error).message, warnings: [] }
  }
  const warnings: string[] = []
  for (const s of steps) await io.run(s).catch((e: Error) => warnings.push(`${s[1] === 'status' ? 'Moving it to In Progress' : 'Assigning it'} failed: ${e.message}`))
  return { ok: true, warnings }
}

// ---------- loading ----------

/** Who is a member of which team changes rarely: read again after an hour. */
const MEMBERS_FOR_MS = 3_600_000
const membersCache = new Map<string, { ids: string[]; at: number }>()

/**
 * Reads the section's data with the `orca` CLI: the connected teams, the user's assigned issues, and
 * the open issues of the user's teams (one call per open state type, since the full list holds every
 * closed issue too). Throws when Linear is not connected or a read fails; the caller keeps the last
 * good data.
 */
export async function loadLinear(run: Run, now = Date.now()): Promise<LinearData> {
  const [teamList, assigned] = await Promise.all([run(['linear', 'team', 'list']), run(['linear', 'list', '--filter', 'assigned', '--limit', '250'])])
  const connectedTeams: string[] = [...new Set<string>((teamList?.teams ?? []).map((t: any) => String(t?.key ?? '')).filter(Boolean))]
  const mine = (assigned?.issues ?? []).map(toIssue).filter((i: LinearIssue | null): i is LinearIssue => i !== null)
  let me: string | null = mine.find((i: LinearIssue) => i.assignee)?.assignee?.id ?? null
  if (!me) {
    const any = await run(['linear', 'list-issues', '--assignee', 'me', '--limit', '1', '--include-archived']).catch(() => null)
    me = toIssue(any?.issues?.[0])?.assignee?.id ?? null
  }
  // The user's teams: the ones it is a member of (every connected team when it is not known who the user is).
  const memberOf = async (team: string) => {
    const cached = membersCache.get(team)
    if (cached && now - cached.at < MEMBERS_FOR_MS) return cached.ids
    const listed = await run(['linear', 'team', 'members', '--team', team])
    const ids = (listed?.members ?? []).map((m: any) => String(m?.id ?? ''))
    membersCache.set(team, { ids, at: now })
    return ids
  }
  const teams = me ? (await Promise.all(connectedTeams.map(async (t) => ((await memberOf(t).catch(() => [])).includes(me!) ? t : null)))).filter((t): t is string => t !== null) : connectedTeams
  const byTeam = await Promise.all(teams.map(async (team) => {
    const lists = await Promise.all(OPEN_TYPES.map((type) => run(['linear', 'list-issues', '--team', team, '--state', type])))
    return lists.flatMap((l) => (l?.issues ?? []).map(toIssue)).filter((i): i is LinearIssue => i !== null)
  }))
  // Each issue once; the team's read carries its cycle, the assigned list does not.
  const issues = new Map<string, LinearIssue>()
  for (const i of [...mine, ...byTeam.flat()]) issues.set(i.id, { ...issues.get(i.id), ...i, cycle: i.cycle ?? issues.get(i.id)?.cycle ?? null })
  const cycles = byTeam.map(activeCycle).filter((c): c is string => c !== null)
  // A team key shown in the header: the user's teams, the one with most of its own issues first.
  const ownCount = (t: string) => mine.filter((i: LinearIssue) => i.team === t).length
  return { me, teams: [...teams].sort((a, b) => ownCount(b) - ownCount(a) || a.localeCompare(b)), connectedTeams, issues: [...issues.values()], cycles, sent: {}, lastSent: {}, at: now }
}

// ---------- Linear's glyphs ----------

/** A state's icon, drawn as Linear draws it: a ring, filled as far as the work has come. */
const FILL: Record<string, number> = { analyzed: 0.25, 'in progress': 0.5, 'in review': 0.75, staging: 0.75 }
const STATE_COLOR: Record<string, string> = { triage: '#e8823b', backlog: '#95959f', unstarted: '#9a9aa3', started: '#e2b53a', completed: '#6b74e0', canceled: '#95959f' }

export function statusIcon(state: LinearIssue['state']): string {
  const c = state.color || STATE_COLOR[state.type] || '#95959f'
  const ring = (extra = '') => `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"${extra}/>`
  const tip = state.name.replace(/[&<>"']/g, '')
  let inner: string
  if (state.type === 'backlog') inner = ring(' stroke-dasharray="2.2 1.8"')
  else if (state.type === 'triage') inner = `${ring()}<path d="M4.5 7h5M7.5 5l2 2-2 2" fill="none" stroke="${c}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`
  else if (state.type === 'completed') inner = `<circle cx="7" cy="7" r="6" fill="${c}"/><path d="M4.4 7.1l1.8 1.8 3.5-3.6" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`
  else {
    const f = FILL[state.name.toLowerCase()] ?? (state.type === 'started' ? 0.5 : 0)
    const a = 2 * Math.PI * f, x = (7 + 3 * Math.sin(a)).toFixed(2), y = (7 - 3 * Math.cos(a)).toFixed(2)
    inner = `${ring()}${f > 0 ? `<path d="M7 7 L7 4 A3 3 0 ${f > 0.5 ? 1 : 0} 1 ${x} ${y} Z" fill="${c}"/>` : ''}`
  }
  return `<span class="lic" data-tip="${tip}"><svg viewBox="0 0 14 14" aria-hidden="true">${inner}</svg></span>`
}

/** Linear's priority icon: the urgent square, three bars filled by level, or dashes for none. */
export function priorityIcon(p: number): string {
  const tip = priorityName(p)
  if (p === 1) return `<span class="lic" data-tip="${tip}"><svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="#e8823b"/><path d="M7 4v3.6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="9.8" r=".9" fill="#fff"/></svg></span>`
  if (p < 1 || p > 4) return `<span class="lic none" data-tip="${tip}"><svg viewBox="0 0 14 14" aria-hidden="true"><g fill="currentColor" opacity=".45"><rect x="2" y="6.3" width="2.4" height="1.4" rx=".6"/><rect x="5.8" y="6.3" width="2.4" height="1.4" rx=".6"/><rect x="9.6" y="6.3" width="2.4" height="1.4" rx=".6"/></g></svg></span>`
  const n = { 2: 3, 3: 2, 4: 1 }[p as 2 | 3 | 4]
  const bar = (i: number, h: number) => `<rect x="${2 + i * 3.8}" y="${12 - h}" width="2.4" height="${h}" rx=".6" fill="currentColor" opacity="${i < n ? 0.9 : 0.25}"/>`
  return `<span class="lic" data-tip="${tip}"><svg viewBox="0 0 14 14" aria-hidden="true">${bar(0, 4)}${bar(1, 7)}${bar(2, 10)}</svg></span>`
}

/** Linear's mark, in the text color. */
export const LINEAR_MARK = '<svg class="lmark" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.2 9.6l5.2 5.2A7 7 0 0 1 1.2 9.6zm-.2-2.3l7.7 7.7a7 7 0 0 0 1.7-.4L1.4 5.6a7 7 0 0 0-.4 1.7zm1.2-3L11.7 13.8a7 7 0 0 0 1.2-1L3.2 3.1a7 7 0 0 0-1 1.2zM4.4 2.2A7 7 0 1 1 13.8 11.6z"/></svg>'
