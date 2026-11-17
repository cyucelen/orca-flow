// The panel as pure functions: a snapshot and the UI state in, HTML out. No DOM, so it is tested
// in Node; src/panel/app.ts only wires clicks and redraws.
//
// Layout (agreed in the mockup): a one-row cockpit; Up next as collapsible briefings, the first
// open (what it is about, the ask at a glance, one button to jump); then the coordinators tree.
// Characters carry everything: color = project, shape = role, face = state.
import type { AgentInfo, Capacity, CockpitStats, Coordinator, LookShape, Look, Snapshot, StartedGroup, UpdateState, WorkspaceRow } from './protocol.ts'
import { asksYou, canRemove, claimsAsk, holdsWorkstream, monitoring, needsYou, waitingQueue } from './rank.ts'
import { BEAMS, capGlyph, headLines, rowLines, trunkX, type NodeState } from './lines.ts'

export type UiState = {
  /** Up-next items the person opened, and ones they closed (the first is open by default). */
  opened: Set<string>
  closed: Set<string>
  /** Coordinator groups folded away, and bottom folds (finished, idle) opened. */
  folded: Set<string>
  unfolded: Set<string>
  query: string
  now: number
  /** The opened cockpit: its stats ('loading' while Orca's memory report runs), the action awaiting
   *  Yes/No, and the last action's result. */
  cockpitOpen: boolean
  stats: CockpitStats | null
  statsLoading: boolean
  confirming: string | null
  /** The confirmed action still running. */
  pending: string | null
  /** A row's inline action status: running, done, or failed (keyed like data-menu). */
  status: Map<string, { text: string; tone: 'pending' | 'ok' | 'bad' }>
  notice: { key: string; text: string; ok: boolean } | null
  /** The chart color each memory consumer wears, kept between refreshes (see colorSlots). */
  colors: Map<string, number>
}

export const emptyUi = (): UiState => ({
  opened: new Set(), closed: new Set(), folded: new Set(), unfolded: new Set(), query: '', now: Date.now(),
  cockpitOpen: false, stats: null, statsLoading: false, confirming: null, pending: null, notice: null, status: new Map(), colors: new Map()
})

// ---------- small helpers ----------

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const WORD = { P0: 'now', P1: 'today', P2: 'soon', P3: 'someday' } as const

export function ago(ms: number | null, now: number): string {
  if (!ms) return ''
  const m = Math.max(0, Math.round((now - ms) / 60_000))
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

// ---------- characters ----------

export type Face = 'working' | 'monitoring' | 'asks' | 'done' | 'failed' | 'idle' | 'queued'
export type Shape = 'solo' | 'lead' | 'worker' | LookShape

const PALETTE = ['#5b8def', '#e0a04a', '#4cb782', '#b07cf0', '#e06c8a', '#4fbfc8', '#c9b458', '#7c8cff', '#e07b4f', '#8fbf5a']
/** A stable color per project name. */
export function colorOf(project: string): string {
  let h = 0
  for (const ch of project) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
const NEUTRAL = '#a6a6b0'

/**
 * An SVG character. An asking one wears the badge of what it asks (`ask`, a question by default).
 * Without `spinner`, a working or monitoring one leaves out its spinning badge (the tree's ring
 * shows it instead) but keeps the badge's frame, so the body stays the same size.
 */
export function character(color: string, shape: Shape, face: Face, size = 16, badge = true, ask: AskKind = 'question', spinner = true): string {
  const s = size, ink = '#141416', sw = Math.max(1, s * 0.07)
  const queued = face === 'queued'
  const paint = queued ? `fill="none" stroke="${color}" stroke-width="${Math.max(1, s * 0.06)}" stroke-dasharray="${s * 0.12} ${s * 0.09}"` : `fill="${color}"`
  const body =
    shape === 'lead'
      ? `<rect x="${s * 0.06}" y="${s * 0.14}" width="${s * 0.88}" height="${s * 0.8}" rx="${s * 0.2}" ${paint}/>${queued ? '' : `<path d="M${s * 0.3} ${s * 0.16} l${s * 0.1} -${s * 0.12} l${s * 0.1} ${s * 0.1} l${s * 0.1} -${s * 0.1} l${s * 0.1} ${s * 0.12}" fill="${color}"/>`}`
      : shape === 'worker'
        ? `<circle cx="${s / 2}" cy="${s * 0.55}" r="${s * 0.38}" ${paint}/>`
        : shape === 'pentagon'
          ? `<path d="M${s / 2} ${s * 0.04} L${s * 0.95} ${s * 0.4} L${s * 0.78} ${s * 0.95} L${s * 0.22} ${s * 0.95} L${s * 0.05} ${s * 0.4} Z" ${paint}/>`
          : shape === 'hex'
            ? `<path d="M${s * 0.27} ${s * 0.08} H${s * 0.73} L${s * 0.96} ${s * 0.5} L${s * 0.73} ${s * 0.92} H${s * 0.27} L${s * 0.04} ${s * 0.5} Z" ${paint}/>`
            : shape === 'shield'
              ? `<path d="M${s * 0.1} ${s * 0.12} Q${s / 2} ${s * 0.02} ${s * 0.9} ${s * 0.12} V${s * 0.5} Q${s * 0.9} ${s * 0.82} ${s / 2} ${s * 0.97} Q${s * 0.1} ${s * 0.82} ${s * 0.1} ${s * 0.5} Z" ${paint}/>`
          : `<rect x="${s * 0.08}" y="${s * 0.1}" width="${s * 0.84}" height="${s * 0.84}" rx="${s * 0.42}" ${paint}/>`
  const eye = (x: number, y: number, r = 0.07) => `<circle cx="${s * x}" cy="${s * y}" r="${s * r}" fill="${queued ? color : ink}"/>`
  const line = (d: string) => `<path d="${d}" stroke="${ink}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`
  const faces: Record<Face, string> = {
    working: eye(0.4, 0.52) + eye(0.64, 0.52) + line(`M${s * 0.44} ${s * 0.7} h${s * 0.14}`),
    monitoring: eye(0.42, 0.4) + eye(0.66, 0.4) + line(`M${s * 0.42} ${s * 0.66} h${s * 0.14}`),
    asks: eye(0.37, 0.46, 0.09) + eye(0.61, 0.46, 0.09) + `<circle cx="${s * 0.49}" cy="${s * 0.68}" r="${s * 0.06}" fill="${ink}"/>`,
    done:
      line(`M${s * 0.3} ${s * 0.5} q${s * 0.07} -${s * 0.09} ${s * 0.14} 0`) +
      line(`M${s * 0.55} ${s * 0.5} q${s * 0.07} -${s * 0.09} ${s * 0.14} 0`) +
      line(`M${s * 0.38} ${s * 0.64} q${s * 0.12} ${s * 0.1} ${s * 0.24} 0`),
    failed:
      line(`M${s * 0.31} ${s * 0.41} l${s * 0.12} ${s * 0.12} M${s * 0.43} ${s * 0.41} l-${s * 0.12} ${s * 0.12}`) +
      line(`M${s * 0.56} ${s * 0.41} l${s * 0.12} ${s * 0.12} M${s * 0.68} ${s * 0.41} l-${s * 0.12} ${s * 0.12}`) +
      line(`M${s * 0.4} ${s * 0.7} h${s * 0.2}`),
    idle: line(`M${s * 0.31} ${s * 0.5} h${s * 0.12}`) + line(`M${s * 0.56} ${s * 0.5} h${s * 0.12}`),
    queued: eye(0.38, 0.5, 0.055) + eye(0.62, 0.5, 0.055)
  }
  // The raised hand reaches outside the body, so the drawing gets room on the right and top.
  const hand = face === 'asks' ? `<path d="M${s * 0.84} ${s * 0.52} L${s * 1.02} ${s * 0.14}" stroke="${color}" stroke-width="${s * 0.11}" stroke-linecap="round"/><circle cx="${s * 1.03}" cy="${s * 0.1}" r="${s * 0.1}" fill="${color}"/>` : ''
  // Status badge at the bottom-right, like Orca's own status icons, ringed in the panel color.
  const bx = s * 0.86, by = s * 0.86, br = s * 0.25, r2 = br * 0.72
  const rim = `<circle cx="${bx}" cy="${by}" r="${br + s * 0.06}" class="rim"/>`
  const spin = (cls: string, inner: string) => `${rim}<g class="${cls}" style="transform-origin:${bx}px ${by}px">${inner}</g>`
  const badges: Partial<Record<Face, string>> = {
    working: spin('spin', `<circle cx="${bx}" cy="${by}" r="${r2}" fill="none" class="track" stroke-width="${s * 0.09}"/><path d="M${bx} ${by - r2} a${r2} ${r2} 0 0 1 ${r2} ${r2}" fill="none" stroke="#e8b64c" stroke-width="${s * 0.09}" stroke-linecap="round"/>`),
    monitoring: spin('spin slow', `<circle cx="${bx}" cy="${by}" r="${r2}" fill="none" stroke="#e8b64c" stroke-width="${s * 0.08}" stroke-dasharray="${s * 0.07} ${s * 0.07}"/>`),
    done: `${rim}<circle cx="${bx}" cy="${by}" r="${br}" fill="#5fbf8a"/><path d="M${bx - br * 0.45} ${by} l${br * 0.32} ${br * 0.32} l${br * 0.6} -${br * 0.62}" fill="none" stroke="#161618" stroke-width="${s * 0.07}" stroke-linecap="round" stroke-linejoin="round"/>`,
    asks: ASK_BADGE[ask](rim, bx, by, br, s),
    failed: `${rim}<circle cx="${bx}" cy="${by}" r="${br}" fill="#ec6a52"/><path d="M${bx - br * 0.4} ${by - br * 0.4} l${br * 0.8} ${br * 0.8} M${bx + br * 0.4} ${by - br * 0.4} l-${br * 0.8} ${br * 0.8}" stroke="#161618" stroke-width="${s * 0.07}" stroke-linecap="round"/>`
  }
  // The hand and the badge reach past the body to the top-right; only then does the frame make room
  // there. Without them (the New coordinator preview, the loader) the body sits centered.
  const pad = s * 0.16
  const reaches = face === 'asks' || (badge && Boolean(badges[face]))
  // The review badge is larger and reaches further to the bottom-right: grow the frame and the svg
  // there, at the frame's own scale so the body keeps its size, and take the growth back with negative
  // margins so the character still lays out as s by s, aligned with its neighbours.
  const room = badge && face === 'asks' && ask === 'review' ? s * REVIEW_ROOM : 0
  const grow = Math.round((room * s) / (s + pad * 1.5) * 100) / 100
  const box = reaches ? `${-pad / 2} ${-pad} ${s + pad * 1.5 + room} ${s + pad * 1.5 + room}` : `0 0 ${s} ${s}`
  const svg = `<svg class="ch${face === 'idle' ? ' faded' : ''}" width="${s + grow}" height="${s + grow}"${grow ? ` style="margin:0 -${grow}px -${grow}px 0"` : ''} viewBox="${box}" aria-hidden="true">${body}${faces[face]}${hand}${badge && (spinner || (face !== 'working' && face !== 'monitoring')) ? (badges[face] ?? '') : ''}</svg>`
  return svg
}

/** The name a row shows: the agent's title, unless it leaks an id; then the workspace name. */
// An agent with no title of its own is named after its worktree, not its agent type ("claude").
const nameOf = (a: AgentInfo, row: WorkspaceRow) => (showable(a.title) && a.title !== a.agentType ? a.title : row.name)

/** A character with a one- or two-word status tooltip (the panel's own tooltip, not the OS one). */
function tipped(svg: string, tip: string, tone = ''): string {
  return `<span class="who" data-tip="${esc(tip)}"${tone ? ` data-tone="${tone}"` : ''}>${svg}</span>`
}

const STATUS: Record<Face, string> = { working: 'Working', monitoring: 'Monitoring', asks: 'Waiting on you', done: 'Done', failed: 'Failed', idle: 'Idle', queued: 'Queued' }

/**
 * What an asking agent wants, at a glance: a review (look at a PR, diff or result), a yes/no
 * (Orca's permission prompt, or an approval), an action (something only the user can do outside
 * the chat: a setting, a login, a command), or a question (Orca's pending question, a decision,
 * a fact). Ranking and counting still treat all four as one "asks" face.
 */
export type AskKind = 'review' | 'approval' | 'action' | 'question'
export function askKindOf(a: AgentInfo): AskKind {
  if (a.state === 'blocked') return 'approval'
  if (a.state === 'waiting') return 'question'
  const t = a.summary?.needs.type
  return t === 'review' || t === 'approval' || t === 'action' ? t : 'question'
}
const ASK_TIP: Record<AskKind, string> = { review: 'Wants a review', approval: 'Needs a yes/no', action: 'Asks you to do something', question: 'Asks a question' }
/** Tooltip tone (src/panel/panel.css .tip.<tone>), matching the badge's color. */
const ASK_TONE: Record<AskKind, string> = { review: 'review', approval: 'warn', action: 'action', question: 'ask' }
/** How much (a share of the size) the frame grows for the larger review badge. */
const REVIEW_ROOM = 0.12
const ASK_BADGE: Record<AskKind, (rim: string, bx: number, by: number, br: number, s: number) => string> = {
  question: (rim, bx, by, br) =>
    `${rim}<circle cx="${bx}" cy="${by}" r="${br}" class="ask-badge"/><text x="${bx}" y="${by + br * 0.42}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="${br * 1.3}" font-weight="800" fill="#161618">?</text>`,
  // A white eye: look at something. Its badge is 1.2x the others so the eye reads at 20 px; it
  // brings its own rim, and character() gives the frame REVIEW_ROOM so the larger badge is not clipped.
  review: (_rim, bx, by, br, s) => {
    const R = br * 1.2, w = R * 0.78, h = R * 0.8
    return `<circle cx="${bx}" cy="${by}" r="${R + s * 0.06}" class="rim"/><circle cx="${bx}" cy="${by}" r="${R}" class="review-badge"/><path d="M${bx - w} ${by} Q${bx} ${by - h} ${bx + w} ${by} Q${bx} ${by + h} ${bx - w} ${by} Z" fill="#fff" stroke="#161618" stroke-width="${s * 0.045}" stroke-linejoin="round"/><circle cx="${bx}" cy="${by}" r="${R * 0.3}" fill="#161618"/>`
  },
  // A check on amber: a quick yes/no (green with a check stays "done").
  approval: (rim, bx, by, br, s) =>
    `${rim}<circle cx="${bx}" cy="${by}" r="${br}" class="approval-badge"/><path d="M${bx - br * 0.45} ${by} l${br * 0.32} ${br * 0.32} l${br * 0.6} -${br * 0.62}" fill="none" stroke="#161618" stroke-width="${s * 0.07}" stroke-linecap="round" stroke-linejoin="round"/>`,
  // An arrow on teal: go and do something outside the chat.
  action: (rim, bx, by, br, s) =>
    `${rim}<circle cx="${bx}" cy="${by}" r="${br}" class="action-badge"/><path d="M${bx - br * 0.5} ${by} h${br}m-${br * 0.42} -${br * 0.42} l${br * 0.42} ${br * 0.42} l-${br * 0.42} ${br * 0.42}" fill="none" stroke="#161618" stroke-width="${s * 0.07}" stroke-linecap="round" stroke-linejoin="round"/>`
}

/** An agent's character with its status: what Orca shows, in at most two words. */
function agentCharacter(a: AgentInfo, row: WorkspaceRow, all: AgentInfo[], size = 20, spinner = true): string {
  const face = faceOf(a)
  const ask = askKindOf(a)
  const tip = face === 'asks' ? ASK_TIP[ask] : face === 'done' && inFlight(a, row, all) ? 'Available' : STATUS[face]
  return tipped(character(colorOf(row.repo), shapeOf(a, all), face, size, true, ask, spinner), tip, face === 'asks' ? ASK_TONE[ask] : '')
}

// ---------- reading the model ----------

/**
 * Only summaries written under the current rules (they carry `glance`) may claim an ask; older ones
 * produced junk like terminal ids. Orca's own blocked/waiting states always count.
 */
const trusted = (a: AgentInfo) => a.summary !== null && typeof a.summary.glance === 'string'

/** Text that leaks ids, hashes or paths is never shown. */
const LEAK = /term_[0-9a-f]|[_-][0-9a-f]{10,}\b|[0-9a-f]{8}-[0-9a-f]{4}|\b[0-9a-f]{12,}\b|(?:^|\s)(?:~|\.)?\/[\w.-]+\//i
export const showable = (text: string | undefined): text is string => Boolean(text) && !LEAK.test(text!)

/** The face shows what Orca shows: its monitoring mode, otherwise its state. */
export function faceOf(a: AgentInfo): Face {
  if (asksYou(a)) return 'asks'
  if (monitoring(a)) return 'monitoring'
  return a.state === 'working' ? 'working' : 'done'
}

/** Agents that dispatched someone wear the coordinator shape; workers were dispatched; everyone else works alone. */
export function shapeOf(a: AgentInfo, all: AgentInfo[]): Shape {
  // A lead (told so at spawn) or any agent with workers under it wears the crowned square.
  if (a.summary?.role === 'lead' || a.summary?.role === 'coordinator' || all.some((b) => b.leadPane === a.paneKey)) return 'lead'
  if (a.leadPane || a.summary?.role === 'worker') return 'worker'
  return 'solo'
}

type Placed = { a: AgentInfo; row: WorkspaceRow }

function coordinatorName(key: string, coordinators: Coordinator[]): string {
  return key === 'you' ? 'You' : (coordinators.find((c) => c.key === key)?.name ?? key)
}

/** What the briefing says the workstream is about; older summaries fall back to their goal. */
const aboutOf = ({ a, row }: Placed) => [a.summary?.about, row.card?.goal, a.summary?.goal].find(showable) ?? ''

/** The ask in about eight words, or why the agent is waiting when no summary says. */
export function glanceOf({ a }: Placed): string {
  if (a.state === 'waiting' && a.question) return clip(a.question, 90)
  if (claimsAsk(a) && showable(a.summary?.glance)) return a.summary!.glance!
  if (trusted(a) && a.summary!.needs.type !== 'none' && showable(a.summary!.needs.ask)) return clip(a.summary!.needs.ask, 60)
  return a.state === 'blocked' ? 'Approve a permission prompt.' : a.state === 'waiting' ? 'Answer its question.' : 'Waiting for your input.'
}

const askType = ({ a }: Placed) =>
  a.state === 'waiting' ? 'question' : a.state === 'blocked' ? 'approval' : a.summary && a.summary.needs.type !== 'none' ? a.summary.needs.type : 'info'

// ---------- cockpit ----------

type Gauge = { key: string; icon: string; text: string; tone: '' | 'warn' | 'danger'; tip: string; loading?: boolean }

/** Gauge tooltips stay within five words. */
export function gaugesOf(c: Capacity): Gauge[] {
  const out: Gauge[] = []
  if (c.measuring) {
    out.push({ key: 'memory', icon: 'chip', text: '', tone: '', tip: 'Measuring memory', loading: true })
    out.push({ key: 'disk', icon: 'disk', text: '', tone: '', tip: 'Measuring disk', loading: true })
  }
  if (!c.measuring && (c.freeGB !== null || c.verdict === 'pressure')) {
    const free = Math.max(0, c.freeGB ?? 0)
    const tip = {
      ok: `Memory, after ${c.marginGB} GB margin`,
      'agents-only': 'Room for agents, not environments',
      full: 'Full: new work queues',
      pressure: 'Memory pressure: only P0 starts'
    }[c.verdict]
    out.push({ key: 'memory', icon: 'chip', text: `${free} GB free`, tone: c.verdict === 'ok' ? '' : c.verdict === 'agents-only' ? 'warn' : 'danger', tip })
  }
  if (!c.measuring && c.diskFreeGB != null) {
    const d = c.diskFreeGB
    out.push({ key: 'disk', icon: 'disk', text: `${d >= 100 ? Math.round(d) : d} GB free`, tone: d < 10 ? 'danger' : d < 25 ? 'warn' : '',
      tip: d < 10 ? 'Disk nearly full' : d < 25 ? 'Disk low: worktrees need space' : 'Disk free on this Mac' })
  }
  if (c.finishedOpen > 0) {
    out.push({ key: 'idle', icon: 'pause', text: String(c.finishedOpen), tone: '',
      tip: `${c.finishedOpen} finished ${c.finishedOpen === 1 ? 'session' : 'sessions'} still open` })
  }
  return out
}

const ICON: Record<string, string> = {
  chip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1.5"/><rect x="6.5" y="6.5" width="3" height="3" rx=".5"/><path d="M6.5 1.5V4M9.5 1.5V4M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5"/></svg>',
  disk: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="12" height="8" rx="2"/><path d="M5 9.5h3"/><circle cx="11" cy="9.5" r=".6" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4v8M10 4v8"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
  chev: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2l3 3-3 3"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3.5v9M3.5 8h9"/></svg>'
}

const size = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`)

/** Something in progress, inline: a small spinner and a verb. The one inline loading style. */
export const busy = (text: string) => `<span class="rstatus pending"><span class="refreshing"></span>${esc(text)}</span>`

/** A row's inline status, shown where its time or count normally sits; null when it has none. */
function rowStatus(ui: UiState, key: string): string | null {
  const st = ui.status.get(key)
  if (!st) return null
  return st.tone === 'pending' ? busy(st.text) : `<span class="rstatus ${st.tone}">${esc(st.text)}</span>`
}

type ActOpts = { ask?: boolean; tip?: string; cls?: string; icon?: string; aria?: string }

/** An action that asks "Yes · No" in place (unless `ask` is false), then shows its result. */
function action(key: string, label: string, question: string, ui: UiState, o: ActOpts = {}): string {
  if (ui.pending === key) return busy(key.startsWith('remove:') ? 'Removing…' : 'Sleeping…')
  if (ui.notice?.key === key) return `<span class="rstatus ${ui.notice.ok ? 'ok' : 'bad'}">${esc(ui.notice.text)}</span>`
  if (ui.confirming === key) return `<span class="confirm"><span class="q">${esc(question)}</span> <button class="yes" data-yes="${esc(key)}">Yes</button> <button class="no" data-no>No</button></span>`
  const attrs = `${o.ask === false ? 'data-yes' : 'data-act'}="${esc(key)}"${o.tip ? ` data-tip="${esc(o.tip)}"` : ''}${o.aria ? ` aria-label="${esc(o.aria)}"` : ''}`
  return `<button class="act${o.cls ? ` ${o.cls}` : ''}" ${attrs}>${o.icon ?? ''}${esc(label)}</button>`
}

/** While Orca's memory report runs the first time: three characters hop in turn over a quiet line. */
export function crew(text: string): string {
  const faces = [character(PALETTE[0], 'solo', 'done', 18, false), character(PALETTE[1], 'lead', 'done', 18, false), character(PALETTE[2], 'worker', 'done', 18, false)]
  return `<div class="loader" aria-busy="true" aria-label="${esc(text)}"><div class="crew">${faces.map((c) => `<span class="hop">${c}</span>`).join('')}</div><span class="shimmer-text">${esc(text)}</span></div>`
}

/** While Orca's memory report runs the first time. */
function loader(): string {
  return `<div class="copen">${crew('Checking what’s running…')}</div><div class="hair"></div>`
}

/** Chart colors for the heaviest consumers (panel.css --c0..--c2): three, the most a treemap's touching tiles tell apart for every reader. */
const SERIES = 3
/** Consumers that may get a tile of their own; the rest fold into the sliver. */
const TILES = 6
/** The treemap's box: laid out at the narrowest it is drawn, 236 px (a 260 px panel less its padding),
 *  and drawn in percentages, so a wider panel only gives labels more room. */
const TM = { w: 236, h: 136 }
/** How much wider than tall tiles aim to be. */
const WIDE = 1.5

/** What a consumer's tile shows; its legend pill shows the rest. */
type Shows = { name: boolean; size: boolean; sleep: boolean }

/** Text width in the panel's font, per character as measured in SF at the weights tiles use, rounded up. */
export function textWidth(s: string, px: number): number {
  let em = 0
  for (const ch of s) {
    em += /[0-9+]/.test(ch) ? 0.67 : /[.,:·]/.test(ch) ? 0.34 : ch === ' ' ? 0.27 : ch === '-' ? 0.48
      : /[MW]/.test(ch) ? 0.92 : /[A-Z]/.test(ch) ? 0.76 : /[mw]/.test(ch) ? 0.9 : /[ijl|!']/.test(ch) ? 0.28 : /[frt()]/.test(ch) ? 0.44 : 0.62
  }
  return em * px + 1
}

/** A tile's label: its size in one of three type sizes, its character beside or above, its name below or after. */
export type Fit = { value: 'md' | 'sm' | 'xs' | null; avatar: 'row' | 'stack' | null; name: 'below' | 'inline' | null; room: boolean }
/** Type sizes with the padding around them (panel.css .tile, .fit-sm, .fit-xs). */
const TYPE = { md: { px: 12, line: 16, side: 6, pad: 11 }, sm: { px: 10.5, line: 13, side: 4, pad: 3 }, xs: { px: 9.5, line: 12, side: 3, pad: 3 } }

/**
 * How a tile w×h px (its 2 px surface gap included) labels itself. The size is never cut: the name
 * gives way first (shown whole, or at least its first 12 characters, never a stub), then the
 * character, then the type gets smaller; a tile with no room for its size shows nothing. `room`
 * says whether a 20 px button still fits above the label.
 */
export function fitLabel(w: number, h: number, value: string, name: string, avatar: boolean): Fit {
  const AV = 16, NAME = 13
  const options: { fit: Omit<Fit, 'room'>; width: number; height: number }[] = []
  for (const kind of ['md', 'sm', 'xs'] as const) {
    const t = TYPE[kind], v = textWidth(value, t.px)
    const add = (av: Fit['avatar'], nm: Fit['name'], width: number, height: number) => options.push({ fit: { value: kind, avatar: av, name: nm }, width, height: height + t.pad })
    if (kind === 'md' && name) {
      if (avatar) add('row', 'below', AV + 4 + v, AV + 2 + NAME)
      if (avatar) add('stack', 'below', Math.max(AV, v), AV + 3 + t.line + NAME)
      add(null, 'below', v, t.line + NAME)
    }
    if (name) add(null, 'inline', v + textWidth(` · ${name}`, 10.5), t.line)
    if (kind === 'md' && avatar) {
      add('row', null, AV + 4 + v, AV)
      add('stack', null, Math.max(AV, v), AV + 3 + t.line)
    }
    add(null, null, v, t.line)
  }
  for (const o of options) {
    const cw = w - 2 - 2 * TYPE[o.fit.value!].side, spare = h - 2 - o.height
    if (spare < 0 || o.width > cw) continue
    if (o.fit.name === 'below' && textWidth(name, 10.5) > cw && textWidth(`${name.slice(0, 12)}…`, 10.5) > cw) continue
    return { ...o.fit, room: o.fit.value === 'md' && spare >= 29 && cw >= 24 }
  }
  return { value: null, avatar: null, name: null, room: false }
}

/** What uses memory: a session with what it started, or what a sleeping agent left running. */
type Consumer = { key: string; ch: string; name: string; mb: number; tip: string; pane: string | null }
type Box = { x: number; y: number; w: number; h: number }

const hashOf = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0)

/**
 * Stable chart colors. A consumer keeps its slot while it is among the colored ones, gets it back when
 * it returns if the slot is free, and a new one starts from a slot picked by its key. `memo` lives in
 * the UI state, so colors never jump when the order changes between refreshes.
 */
export function colorSlots(keys: string[], memo: Map<string, number>, n = SERIES): Map<string, number> {
  const out = new Map<string, number>()
  const taken = new Set<number>()
  for (const k of keys) {
    const s = memo.get(k)
    if (s !== undefined && s < n && !taken.has(s)) { out.set(k, s); taken.add(s) }
  }
  for (const k of keys) {
    if (out.has(k)) continue
    const s = Array.from({ length: n }, (_, i) => (hashOf(k) + i) % n).find((slot) => !taken.has(slot))
    if (s === undefined) break
    out.set(k, s)
    taken.add(s)
  }
  for (const [k, s] of out) { memo.delete(k); memo.set(k, s) }
  for (const k of [...memo.keys()].slice(0, Math.max(0, memo.size - 64))) memo.delete(k)
  return out
}

/** Squarified treemap: the values (largest first) as boxes filling `box`, each as square as it can be. */
export function squarify(values: number[], box: Box): Box[] {
  const total = values.reduce((a, v) => a + v, 0)
  if (total <= 0) return values.map(() => ({ ...box, w: 0, h: 0 }))
  const scale = (box.w * box.h) / total
  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, v) => a + v, 0) * scale
    return Math.max(...row.map((v) => Math.max((side * side * v * scale) / (s * s), (s * s) / (side * side * v * scale))))
  }
  const out: Box[] = []
  let b = { ...box }
  for (let i = 0; i < values.length;) {
    const side = Math.min(b.w, b.h)
    const row = [values[i]]
    while (i + row.length < values.length && worst([...row, values[i + row.length]], side) <= worst(row, side)) row.push(values[i + row.length])
    const area = row.reduce((a, v) => a + v, 0) * scale
    if (b.w >= b.h) {
      const w = area / b.h
      let y = b.y
      for (const v of row) { const h = (v * scale) / w; out.push({ x: b.x, y, w, h }); y += h }
      b = { x: b.x + w, y: b.y, w: b.w - w, h: b.h }
    } else {
      const h = area / b.w
      let x = b.x
      for (const v of row) { const w = (v * scale) / h; out.push({ x, y: b.y, w, h }); x += w }
      b = { x: b.x, y: b.y + h, w: b.w, h: b.h - h }
    }
    i += row.length
  }
  return out
}

const MOON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 9.6A5.4 5.4 0 0 1 6.4 2.8a5.4 5.4 0 1 0 6.8 6.8Z"/></svg>'
const TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.4a1 1 0 0 0 1 .85h4.3a1 1 0 0 0 1-.85l.6-8.4M6.75 7v4M9.25 7v4"/></svg>'

/** A tile's place in the treemap, in percentages with a 2 px surface gap, so it fits any panel width. */
const place = (b: Box) => {
  const pct = (v: number, of: number) => Math.round((v / of) * 10000) / 100
  return `left:calc(${pct(b.x, TM.w)}% + 1px);top:calc(${pct(b.y, TM.h)}% + 1px);width:calc(${pct(b.w, TM.w)}% - 2px);height:calc(${pct(b.h, TM.h)}% - 2px)`
}

/**
 * All of RAM as tiles: each consumer sized by its memory, the ones too small to label folded into one
 * sliver, everything else, and free. Says what each consumer's tile shows (its name, its size, its
 * sleep button) and which color it wears; its legend pill carries whatever the tile cannot.
 */
function treemap(cs: Consumer[], ram: { usedGB: number; totalGB: number }, ui: UiState): { html: string; slots: Map<string, number>; shows: Map<string, Shows>; folded: Set<string> } {
  const totalMb = ram.totalGB * 1024
  const usedMb = Math.min(ram.usedGB * 1024, totalMb)
  const usedW = totalMb > 0 ? (TM.w * usedMb) / totalMb : 0
  // Footprints can count swapped memory, so together they may exceed what RAM reports as used.
  const allMb = cs.reduce((n, c) => n + c.mb, 0)
  const scale = allMb > usedMb ? usedMb / allMb : 1
  const restMb = Math.max(0, usedMb - allMb * scale)
  type Part = { kind: 'own'; c: Consumer; mb: number } | { kind: 'sliver' | 'rest'; mb: number }
  // The parts largest first, as squarify wants them. A sliver is drawn at least 2% of what is used, so
  // it stays visible; the rest gives that room.
  const layout = (own: Consumer[], folded: Consumer[]) => {
    const foldedMb = folded.reduce((n, c) => n + c.mb, 0) * scale
    const sliver = folded.length ? Math.max(foldedMb, usedMb * 0.02) : 0
    const rest = Math.max(0, restMb - (sliver - foldedMb))
    const parts: Part[] = [...own.map((c) => ({ kind: 'own' as const, c, mb: c.mb * scale })), ...(folded.length ? [{ kind: 'sliver' as const, mb: sliver }] : []), ...(rest >= 1 ? [{ kind: 'rest' as const, mb: rest }] : [])]
      .sort((x, y) => y.mb - x.mb)
    // Laid out squarified in a box squeezed by WIDE, then stretched back: tiles come out wider than
    // tall, which is the shape a one-line label needs.
    const boxes = squarify(parts.map((p) => p.mb), { x: 0, y: 0, w: usedW / WIDE, h: TM.h })
    return parts.map((p, i) => ({ ...p, b: { x: boxes[i].x * WIDE, y: boxes[i].y, w: boxes[i].w * WIDE, h: boxes[i].h } }))
  }
  // A consumer whose tile cannot show even its size folds into the sliver; repeat until the rest fit.
  let own = cs.slice(0, TILES)
  let folded = cs.slice(TILES)
  let laid = layout(own, folded)
  for (;;) {
    const failing = laid.flatMap((p) => (p.kind === 'own' && !fitLabel(p.b.w, p.b.h, size(p.c.mb), p.c.name, true).value ? [p.c] : []))
    if (!failing.length) break
    own = own.filter((c) => !failing.includes(c))
    folded = [...failing, ...folded].sort((x, y) => y.mb - x.mb)
    laid = layout(own, folded)
  }
  const slots = colorSlots(own.slice(0, SERIES).map((c) => c.key), ui.colors)
  const shows = new Map<string, Shows>()
  const label = (fit: Fit, value: string, name: string, ch = '') => {
    if (!fit.value) return ''
    const v = `<span class="t-v">${value}</span>`
    if (fit.name === 'inline') return `<span class="t-line">${v}<span class="t-n">· ${esc(name)}</span></span>`
    const n = fit.name === 'below' ? `<span class="t-n">${esc(name)}</span>` : ''
    return fit.avatar === 'row' ? `<span class="t-row">${ch}${v}</span>${n}` : fit.avatar === 'stack' ? `<span class="t-av">${ch}</span>${v}${n}` : `${v}${n}`
  }
  const fitClass = (fit: Fit) => (fit.value === 'md' ? '' : fit.value ? ` fit-${fit.value}` : ' bare')
  const foldedMb = folded.reduce((n, c) => n + c.mb, 0)
  const free = +(ram.totalGB - ram.usedGB).toFixed(1)
  const tiles = laid.map((p) => {
    if (p.kind === 'own') {
      const c = p.c
      const fit = fitLabel(p.b.w, p.b.h, size(c.mb), c.name, true)
      // A session sleeps from its tile when the tile shows its name and has room above it, else from its pill.
      const sleep = Boolean(c.pane && fit.name && fit.room)
      shows.set(c.key, { name: Boolean(fit.name), size: true, sleep })
      const slot = slots.get(c.key)
      const act = sleep ? `<span class="t-act">${action(`close:${c.pane}`, '', '', ui, { ask: false, icon: MOON, cls: 't-sleep', aria: `Sleep ${c.name}`, tip: 'Sleep' })}</span>` : ''
      return `<div class="tile ${slot === undefined ? 'plain' : `c${slot}`}${fitClass(fit)}" style="${place(p.b)}" data-use="${esc(c.key)}" data-tip="${esc(c.tip)}">${act}${label(fit, size(c.mb), c.name, c.ch)}</div>`
    }
    if (p.kind === 'sliver') {
      const fit = fitLabel(p.b.w, p.b.h, size(foldedMb), `${folded.length} small`, false)
      const tip = `${folded.length} small · ${size(foldedMb)}\n${folded.map((c) => `${c.name}: ${size(c.mb)}`).join('\n')}`
      return `<div class="tile plain folded${fitClass(fit)}" style="${place(p.b)}" data-use="small" data-tip="${esc(tip)}">${label(fit, size(foldedMb), `${folded.length} small`)}</div>`
    }
    const fit = fitLabel(p.b.w, p.b.h, size(Math.round(restMb)), 'other', false)
    return `<div class="tile rest${fitClass(fit)}" style="${place(p.b)}" data-tip="${esc(`Everything else · ${size(Math.round(restMb))}\nOther apps and sessions`)}">${label(fit, size(Math.round(restMb)), 'other')}</div>`
  })
  if (TM.w - usedW >= 1) {
    const b = { x: usedW, y: 0, w: TM.w - usedW, h: TM.h }
    const fit = fitLabel(b.w, b.h, `${free} GB`, 'free', false)
    tiles.push(`<div class="tile free${fitClass(fit)}" style="${place(b)}" data-tip="${free} GB free of ${ram.totalGB} GB">${label(fit, `${free} GB`, 'free')}</div>`)
  }
  return { slots, shows, folded: new Set(folded.map((c) => c.key)), html: `<div class="tm" style="height:${TM.h}px" role="img" aria-label="${esc(`RAM: ${ram.usedGB} of ${ram.totalGB} GB used, ${free} GB free`)}">${tiles.join('')}</div>` }
}

/** A small round gauge in a chip: swap used of total, warning when nearly full. */
function swapChip(swap: { usedGB: number; totalGB: number }): string {
  const r = 5.25, c = 2 * Math.PI * r
  const warn = swap.usedGB / swap.totalGB >= 0.85
  const arc = Math.min(1, swap.usedGB / swap.totalGB) * c
  return `<span class="chip${warn ? ' warn' : ''}" data-tip="Swap: ${swap.usedGB} of ${swap.totalGB} GB used"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="${r}" class="g-track"/><circle cx="7" cy="7" r="${r}" class="g-arc" stroke-dasharray="${arc.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 7 7)"/></svg>Swap ${swap.usedGB} / ${swap.totalGB} GB</span>`
}

/** Overlapping characters, at most `max`, then how many more. */
function avatarStack(placed: Placed[], all: AgentInfo[], max = 6): string {
  const faces = placed.slice(0, max).map((p) => `<span class="sav">${character(colorOf(p.row.repo), shapeOf(p.a, all), faceOf(p.a), 14, false)}</span>`).join('')
  return `<span class="stack">${faces}${placed.length > max ? `<span class="sav more">+${placed.length - max}</span>` : ''}</span>`
}

function cockpitOpen(snap: Snapshot, ui: UiState): string {
  if (!ui.stats && ui.notice?.key === 'load') return `<div class="copen"><div class="empty">Could not check what’s running: ${esc(ui.notice.text)}</div></div><div class="hair"></div>`
  if (!ui.stats) return loader()
  const st = ui.stats
  const placedAll = snap.rows.flatMap((row) => row.agents.map((a) => ({ a, row })))
  const all = placedAll.map((p) => p.a)
  const placed = (pane: string) => placedAll.find((p) => p.a.paneKey === pane)
  // What a session started outside itself (a dev server) counts toward it; Orca does not count it.
  const startedName = (g: StartedGroup) => (g.count > 1 ? `${g.name} +${g.count - 1}` : g.name)
  const started = st.started ?? []
  const live = new Set(all.map((a) => a.paneKey))
  const consumers: Consumer[] = [
    ...st.heaviest.map((h) => {
      const p = placed(h.paneKey)
      const groups = started.filter((g) => g.paneKey === h.paneKey)
      const mb = h.memMB + groups.reduce((n, g) => n + g.memMB, 0)
            return {
        key: `pane:${h.paneKey}`, ch: p ? character(colorOf(p.row.repo), shapeOf(p.a, all), faceOf(p.a), 16) : character(colorOf(h.repo), 'solo', 'done', 16), name: h.title, mb, pane: h.paneKey,
        tip: [`${h.title} · ${size(mb)}`, `Session: ${size(h.memMB)}`, ...groups.map((g) => `${startedName(g)}: ${size(g.memMB)}`)].join('\n')
      }
    }),
    // Started by an agent that is not open any more (it slept): still running, still costing memory.
    ...started.filter((g) => !g.paneKey || !live.has(g.paneKey)).map((g) => ({
      key: `started:${g.key}`, ch: character(colorOf(g.repo), 'solo', 'idle', 16),
      name: `${startedName(g)} · ${g.worktreeName}`, mb: g.memMB, pane: null,
      tip: `${startedName(g)} · ${size(g.memMB)}\nLeft running in ${g.worktreeName}`
    }))
  ].sort((x, y) => y.mb - x.mb)
  const ram = st.ram && st.ram.totalGB > 0 ? st.ram : null
  const swap = st.swap && st.swap.totalGB > 0 ? st.swap : null
  const map = ram ? treemap(consumers, ram, ui) : null
  const free = ram ? +(ram.totalGB - ram.usedGB).toFixed(1) : 0
  const head = ram || swap
    ? `<div class="mhead">${ram ? `<span class="mused${ram.usedGB / ram.totalGB >= 0.85 ? ' warn' : ''}" data-tip="RAM: ${ram.usedGB} of ${ram.totalGB} GB used, ${free} GB free"><b>${ram.usedGB}</b> / ${ram.totalGB} GB used</span>` : '<span></span>'}${swap ? swapChip(swap) : ''}</div>`
    : ''
  // A pill carries what its consumer's tile cannot: the name, the size, the sleep button. Pills of the
  // ones folded into the sliver light up with it. Without RAM figures there is no treemap, only pills.
  const legend = consumers.map((c) => {
    const shows = map?.shows.get(c.key) ?? { name: false, size: false, sleep: false }
    if (shows.name && (shows.sleep || !c.pane)) return ''
    const slot = map?.slots.get(c.key)
    const sleep = c.pane && !shows.sleep ? action(`close:${c.pane}`, '', '', ui, { ask: false, icon: MOON, cls: 'lg-sleep', aria: `Sleep ${c.name}`, tip: 'Sleep' }) : ''
    return `<span class="lg ${slot === undefined ? 'plain' : `c${slot}`}" data-use="${esc(c.key)}"${map?.folded.has(c.key) ? ' data-in="small"' : ''} data-tip="${esc(c.tip)}"><i class="key"></i><span class="lg-n">${esc(c.name)}</span>${shows.size ? '' : `<span class="lg-v">${size(c.mb)}</span>`}${sleep}</span>`
  }).join('')
  const memory = `<div class="cgroup mem"><span class="label">Memory${ui.statsLoading ? ' <span class="refreshing" aria-label="Refreshing"></span>' : ''}</span>${head}${map?.html ?? ''}${legend ? `<div class="legend">${legend}</div>` : ''}</div>`
  // What agents are doing right now, as small crowds.
  const doing = (['asks', 'working', 'monitoring'] as const).map((face) => {
    const these = placedAll.filter((p) => faceOf(p.a) === face)
    const word = { asks: 'asking', working: 'working', monitoring: 'monitoring' }[face]
    return these.length ? `<span class="tally${face === 'asks' ? ' ask' : ''}">${avatarStack(these, all, 4)}<span><b>${these.length}</b> ${word}</span></span>` : ''
  }).join('')
  // Sleeping every finished session is offered only when memory is tight; otherwise they cost nothing
  // you need, and each one sleeps from its own menu. The same set the footer's Sleep all used.
  const finished = finishedOf(placedAll)
  const n = finished.length
  const freedMb = finished.reduce((m, p) => m + (st.finished.find((f) => f.paneKey === p.a.paneKey)?.memMB ?? 0), 0)
  const tight = (snap.capacity?.verdict ?? 'ok') !== 'ok'
  const sessions = n === 1 ? 'session' : 'sessions'
  const sleepAll = tight && n > 0
    ? action('closeall', freedMb ? `Sleep all · ${size(freedMb)}` : 'Sleep all', `Sleep ${n} ${sessions}?`, ui, { icon: MOON, cls: 'pill', tip: `Sleep ${n} finished ${sessions}${freedMb ? ` to free ${size(freedMb)}` : ''}` })
    : ''
  const finishedRow = n ? `<div class="fin">${avatarStack(finished, all)}<span class="fin-n"><b>${n}</b> finished</span>${sleepAll}</div>` : ''
  // A merged, clean worktree: a card with its PR, removed with the trash button after a Yes.
  const merged = st.merged.map((m) =>
    `<div class="wt" data-tip="${esc(`${m.name}\nPR #${m.pr} merged · clean`)}"><span class="prb pr-merged">${MERGED_ICON}</span><span class="wt-main"><span class="wt-name">${esc(m.name)}</span><span class="wt-sub">#${m.pr} · merged · clean</span></span>${action(`remove:${m.workspaceId}`, '', 'Remove?', ui, { icon: TRASH, cls: 'ibtn danger', aria: `Remove ${m.name}`, tip: 'Remove worktree' })}</div>`
  ).join('')
  return `<div class="copen">
    ${memory}
    ${doing ? `<div class="cgroup"><span class="label">Agents</span><div class="tallies">${doing}</div></div>` : ''}
    ${finishedRow || merged ? `<div class="cgroup"><span class="label">Clean up</span>${finishedRow}${merged}</div>` : ''}
  </div><div class="hair"></div>`
}

function cockpit(snap: Snapshot, ui: UiState): string {
  const gauges = snap.capacity ? gaugesOf(snap.capacity) : []
  return `<div class="cockpit" data-cockpit role="button" tabindex="0" aria-expanded="${ui.cockpitOpen}">${gauges
    .map((g) => `<span class="gauge ${g.tone}" data-tip="${esc(g.tip)}" data-tone="${g.tone}" aria-label="${esc(g.tip)}">${ICON[g.icon]}${g.loading ? '<span class="refreshing"></span>' : `<span>${esc(g.text)}</span>`}</span>`)
    .join('')}<span class="spacer"></span><span class="chev">${ICON.chev}</span></div>`
}

// ---------- update button (top bar, left of search) ----------

const UPDATE_ICON = {
  download: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.25h10"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  warning: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 14 13H2Z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.2" r=".4" fill="currentColor"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M8 5v3.5"/><circle cx="8" cy="10.9" r=".4" fill="currentColor"/></svg>'
}

/**
 * The top bar's update button, just left of search; empty when there is nothing to update. A new
 * release shows a download arrow with an accent dot; the rest say how the update went.
 */
export function updateButton(state: UpdateState | undefined): string {
  if (!state || state.kind === 'none') return ''
  const v = state.version
  const button = (cls: string, tip: string, inner: string, tone = '') =>
    `<button class="icon update ${cls}" data-update="${cls}" data-tip="${esc(tip)}"${tone ? ` data-tone="${tone}"` : ''} aria-label="${esc(tip.replace(/\n/g, ' '))}">${inner}</button>`
  switch (state.kind) {
    case 'available':
    case 'confirm':
      return button('available', `Update Orca Flow to ${v}`, `${UPDATE_ICON.download}<span class="dot"></span>`, 'ask')
    case 'updating':
      return button('updating', `Updating Orca Flow to ${v}…`, '<span class="refreshing"></span>')
    case 'updated':
      return button('updated', `Orca Flow updated to ${v}`, UPDATE_ICON.check)
    case 'approval':
      return button('approval', `Orca Flow ${v} needs your approval: ${state.reason}\nTo approve and update, run:\n${state.command}`, UPDATE_ICON.warning, 'warn')
    case 'failed':
      return button('failed', `Update to ${v} failed: ${state.reason}\nClick to try again`, UPDATE_ICON.error, 'danger')
  }
}

// ---------- up next ----------

/**
 * Everything asking you, most urgent first: the worktrees whose agents ask, plus a row for each
 * coordinator whose own session asks (coordinators live outside the worktree rows). The tree's
 * badges, Up next, the status bar and jump-to-next all read this one list.
 */
export function askingRows(snap: Pick<Snapshot, 'rows' | 'coordinators'>): WorkspaceRow[] {
  const own = snap.coordinators.filter((c) => c.session && asksYou(c.session)).map((c): WorkspaceRow => ({
    id: c.workspaceId ?? `coordinator:${c.key}`, name: c.name, branch: null, repo: c.repos.length === 1 ? c.repos[0] : c.name, path: null,
    main: true, agents: [c.session!], state: c.session!.state, priority: c.session!.summary?.priority ?? null, card: null, parentId: null,
    liveTerminals: 1, pinned: false, unread: false, active: Boolean(c.active), workspaceStatus: null,
    lastActivityAt: c.session!.summary?.updatedAt ?? null, createdAt: 0, pr: null, coordinator: c.key
  }))
  return waitingQueue([...snap.rows, ...own])
}

function upNext(placed: Placed[], all: AgentInfo[], coordinators: Coordinator[], ui: UiState): string {
  if (placed.length === 0) return ''
  const items = placed.map((p, i) => {
    const key = p.a.paneKey || p.row.id
    const open = (i === 0 && !ui.closed.has(key)) || ui.opened.has(key)
    // A coordinator's own ask wears its character and opens like its row in the tree.
    const c = p.row.coordinator ? coordinators.find((x) => x.key === p.row.coordinator) : undefined
    const who = c
      ? tipped(character(c.look?.color ?? (c.repos.length === 1 ? colorOf(c.repos[0]) : NEUTRAL), c.look?.shape ?? 'pentagon', 'asks', 20, true, askKindOf(p.a)), ASK_TIP[askKindOf(p.a)], ASK_TONE[askKindOf(p.a)])
      : agentCharacter(p.a, p.row, all)
    const menu = c ? `coordinator:${c.key}` : `agent:${p.a.paneKey}`
    const where = c ? 'coordinator' : coordinatorName(p.a.coordinator, coordinators)
    const head = `<button class="item" data-brief="${esc(key)}" data-menu="${esc(menu)}" aria-expanded="${open}">${who}<span class="t${open ? ' strong' : ''}">${esc(c ? c.name : nameOf(p.a, p.row))}</span><span class="r">${rowStatus(ui, menu) ?? `${esc(where)}${p.row.priority ? ` · ${p.row.priority}` : ''}`}</span></button>`
    if (!open) return head
    const about = aboutOf(p)
    return `${head}<div class="brief">${about ? `<div class="about">${esc(about)}</div>` : ''}<div class="glance"><span class="kicker">Asks · ${esc(askType(p))}</span><span>${esc(glanceOf(p))}</span></div><div class="jumps"><button class="jump" ${openAttrs(p)}>Jump to session</button>${reviewPr(p)}</div></div>`
  })
  return `<section class="upnext"><div class="label">Up next · ${placed.length}</div><div class="group">${items.join('')}</div></section>`
}

// ---------- your coordinators ----------

/**
 * The worktree's PR as its number, colored the way Orca's own workspace card colors it: an open PR
 * by its checks (failed red, pending yellow, passed green), anything else by its state (merged
 * purple, closed and draft grey). The tooltip says the state and the title; a click opens the PR.
 */
export function prBadge(pr: WorkspaceRow['pr']): string {
  if (!pr) return ''
  const state = pr.state === 'merged' || pr.state === 'closed' || pr.state === 'draft' ? pr.state : 'open'
  const tone = state === 'open' ? { failure: 'fail', pending: 'pending', success: 'ok', cancelled: 'closed' }[pr.checks ?? 'success'] ?? 'ok' : state
  const word = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : state === 'draft' ? 'draft' : pr.checks === 'failure' ? 'checks failed' : pr.checks === 'pending' ? 'checks pending' : 'open'
  const tip = `PR #${pr.number} ${word}${pr.title ? `\n${pr.title}` : ''}`
  return `<span class="pr pr-${tone}" role="link" data-pr="${esc(pr.url)}" data-tip="${esc(tip)}" aria-label="${esc(`PR #${pr.number} ${word}`)}">#${pr.number}</span>`
}

/** GitHub's mark (Octicons mark-github, MIT), in the row's muted text color. */
const GH_MARK = '<svg class="gh" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>'

/** A branch as a row shows it: without its leading user/ prefix (berkantay/bou-4186 → bou-4186). */
export const branchName = (branch: string) => branch.replace(/^[^/]+\/(?=[^/])/, '')

/**
 * How many branch colors there are (panel.css --c0..--c2). Any two branches can sit in neighboring
 * lanes, so the palette was validated all-pairs (the dataviz validator, both modes): three is the
 * most that pass, and the branch's name beside the mark is the second channel.
 */
export const BRANCH_COLORS = 3
/** A branch's color slot: stable for the same repo and branch, so rows on one branch share it. */
export const branchColor = (repo: string, branch: string) => hashOf(`${repo}\n${branch}`) % BRANCH_COLORS

/** A long-lived branch (a main checkout's main or dev) shows quieter than feature work. */
const BASE_BRANCH = /^(main|master|dev|develop|development|trunk|staging)$/

/** The color a row's tree lines wear: its branch's, or none (neutral) without one or on a long-lived one. */
export const laneColor = (row: Pick<WorkspaceRow, 'repo' | 'branch'>): number | null =>
  row.branch && !BASE_BRANCH.test(row.branch) ? branchColor(row.repo, row.branch) : null
const branchAttr = (row: Pick<WorkspaceRow, 'repo' | 'branch'>) => {
  const c = laneColor(row)
  return c === null ? '' : ` data-branch="${c}"`
}

/**
 * The worktree a chat runs in, minimal: GitHub's mark, the branch without its user/ prefix (the
 * whole branch and the project on hover), then the PR's number when there is one. Nothing without a
 * branch.
 */
export function branchChip(row: Pick<WorkspaceRow, 'repo' | 'branch' | 'pr'>): string {
  if (!row.branch) return prBadge(row.pr)
  const quiet = BASE_BRANCH.test(row.branch)
  return `<span class="br${quiet ? ' quiet' : ''}"><span class="br-b" data-tip="${esc(`${row.branch}${row.repo ? ` · ${row.repo}` : ''}`)}">${GH_MARK}<span class="br-n">${esc(branchName(row.branch))}</span></span>${prBadge(row.pr)}</span>`
}

/** A merged PR's icon, on the cockpit's clean-up cards. */
const MERGED_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>'

/**
 * Whether an agent's row wears the current border: its pane is in front in the focused workspace,
 * so its lead, its workers and other agents in that worktree are not. When Orca told only which
 * workspace is focused (focused is null), the worktree's lead stands for it.
 */
export function isCurrent(a: AgentInfo, row: WorkspaceRow, focused: string[] | null | undefined): boolean {
  if (!row.active) return false
  if (focused) return focused.includes(a.paneKey)
  return worktreeLead(row)?.paneKey === a.paneKey
}

/** The agent no other agent in its worktree dispatched (the first, when several were started by hand). */
export const worktreeLead = (row: WorkspaceRow): AgentInfo | undefined =>
  row.agents.find((a) => ![a.leadPane, a.parentPane].some((p) => p && row.agents.some((b) => b.paneKey === p)))

/** A coordinator's row is current when its own session's tab is in front (or, focus known only by workspace, its folder is focused). */
const coordinatorCurrent = (c: Coordinator, focused: string[] | null | undefined) =>
  Boolean(c.active) && (focused ? !!c.session && focused.includes(c.session.paneKey) : true)

/**
 * What a chat's node in the tree says (src/lines.ts): asking, working, monitoring, done while its
 * work is still in flight, or finished.
 */
export function nodeOf(a: AgentInfo, row: WorkspaceRow, all: AgentInfo[]): NodeState {
  const face = faceOf(a)
  return face === 'asks' ? 'asking' : face === 'working' ? 'working' : face === 'monitoring' ? 'monitoring' : inFlight(a, row, all) ? 'done' : 'finished'
}

/**
 * A working (or monitoring) chat's ring carries a shimmer that travels around it, in place of the
 * character's spinning badge (panel.css .beam, still under prefers-reduced-motion).
 */
const beam = (node: NodeState) => (BEAMS.includes(node) ? `<i class="beam b-${node}" aria-hidden="true"></i>` : '')

/** The focused row's mark: a slim bar on its left edge, in its branch's color (panel.css .fb). */
const FOCUS = '<i class="fb" aria-hidden="true"></i>'

function agentLine(p: Placed, all: AgentInfo[], coordinators: Coordinator[], soft: boolean, lead: Placed | undefined, ui: UiState, done = false, current = false, deco = ''): string {
  const status = rowStatus(ui, `agent:${p.a.paneKey}`)
  const indent = Boolean(lead)
  // A worker nested under its lead in the same worktree: the lead's row already shows project,
  // branch, PR and age; the branch's color alone groups it with its lead. One working in a worktree
  // of its own shows that worktree's branch.
  const right = status ?? (lead
    ? (lead.row.id === p.row.id ? '' : branchChip(p.row))
    : `${soft ? `<span class="soft">${esc(p.row.repo)}</span>` : ''}${branchChip(p.row)}<span class="age">${ago(p.row.lastActivityAt, ui.now)}</span>`)
  const cls = `item${indent ? ' indent' : ''}${done ? ' finished' : ''}${current ? ' current' : ''}`
  // A row on a feature branch draws its connector and ring in the branch's color (panel.css, tree lines).
  const menu = `data-menu="agent:${esc(p.a.paneKey)}"${current ? ' aria-current="true"' : ''}${branchAttr(p.row)} data-node="${nodeOf(p.a, p.row, all)}"`
  // Its lines and focus bar; its character leaves out the spinning badge, the ring's shimmer shows it working.
  const lines = `${deco}${current ? FOCUS : ''}`
  // A lead that reported worker_done leaves its worktree ready for cleanup: offer remove on the row.
  // A button cannot hold a button, so this row is a div whose name opens the session.
  if (removable(p, all) && !status) {
    return `<div class="${cls}" ${menu}>${lines}${agentCharacter(p.a, p.row, all, 20, false)}<span class="t" ${openAttrs(p)} role="button" tabindex="0">${esc(nameOf(p.a, p.row))}</span><span class="r">${right}</span><button class="act" data-remove="${esc(p.row.id)}" data-target="agent:${esc(p.a.paneKey)}">remove</button></div>`
  }
  return `<button class="${cls}" ${openAttrs(p)} ${menu}>${lines}${agentCharacter(p.a, p.row, all, 20, false)}<span class="t">${esc(nameOf(p.a, p.row))}</span><span class="r">${right}</span></button>`
}

/**
 * A lead whose dispatch settled (worker_done, failed or abandoned), or whose worktree's PR merged
 * (nothing wakes a lead to report worker_done then), with nothing of its own still running: its
 * worktree can go. The remove flow still refuses a dirty checkout or an unmerged PR.
 */
export const removable = ({ a, row }: Placed, all: AgentInfo[]) =>
  a.summary?.role === 'lead' && (a.dispatch === 'settled' || row.pr?.state === 'merged') &&
  canRemove(row) && faceOf(a) === 'done' && !leadsOpenWork(a, all)

/** A review of a worktree with an open PR: the PR is what to look at, one click away. */
const reviewPr = ({ a, row }: Placed) =>
  askKindOf(a) === 'review' && row.pr && (row.pr.state === 'open' || row.pr.state === 'draft') ? `<button class="jump" data-pr="${esc(row.pr.url)}">Open PR</button>` : ''

/** What a click on an agent opens: its workspace and, when its terminal is known, its own tab. */
const openAttrs = (p: Placed) =>
  p.row.coordinator ? `data-coordinator="${esc(p.row.coordinator)}"` : `data-open="${esc(p.row.id)}"${p.a.terminal ? ` data-terminal="${esc(p.a.terminal)}"` : ''}`

/** Finished sessions that still hold a terminal: what the footer lists and the cockpit counts. */
const leadsOpenWork = (a: AgentInfo, all: AgentInfo[]) => all.some((b) => b.leadPane === a.paneKey && faceOf(b) !== 'done')

/**
 * A done agent that still has work in flight is available, not finished: it is a lead that has not
 * reported worker_done and whose PR has not merged, it leads agents that are still open, or it owns its worktree's open (or draft) PR, which is steered over several rounds
 * until it merges. The owner is the agent no one else in that worktree dispatched (a lead, or a chat
 * you started); its own workers are tasks and finish as usual.
 */
function inFlight(a: AgentInfo, row: WorkspaceRow, all: AgentInfo[]): boolean {
  if (holdsWorkstream(a, row.pr) || leadsOpenWork(a, all)) return true
  const prOpen = row.pr?.state === 'open' || row.pr?.state === 'draft'
  const worker = a.leadPane !== null && row.agents.some((b) => b.paneKey === a.leadPane)
  return prOpen && !worker
}

/** Finished sessions that still hold a terminal: what the footer lists and "Sleep all" puts to sleep. */
export function finishedAgents(rows: WorkspaceRow[]): AgentInfo[] {
  const all = rows.flatMap((r) => r.agents)
  return rows.filter((r) => r.liveTerminals > 0).flatMap((r) => r.agents.filter((a) => faceOf(a) === 'done' && !inFlight(a, r, all)))
}
const finishedOf = (placed: Placed[]) => {
  const all = placed.map((p) => p.a)
  return placed.filter((p) => faceOf(p.a) === 'done' && p.row.liveTerminals > 0 && !inFlight(p.a, p.row, all))
}

/** Rows keep the order their workstreams started in; agent activity never moves them. */
const byStart = (x: Placed, y: Placed) => x.row.createdAt - y.row.createdAt || x.a.paneKey.localeCompare(y.a.paneKey)

function coordinatorBlock({ c, mine, lines }: TreeBlock, all: AgentInfo[], coordinators: Coordinator[], ui: UiState, focused: string[] | null | undefined): string {
  const single = c.repos.length === 1 ? c.repos[0] : null
  const color = c.look?.color ?? (single ? colorOf(single) : NEUTRAL)
  const shape: Shape = c.you ? 'solo' : (c.look?.shape ?? 'pentagon')
  const sub = single ?? (c.you ? 'chats you started' : c.repos.length ? c.repos.join(', ') : 'all projects')
  // A coordinator shows its own state only; its workers show theirs below it. You has no session of
  // its own, so it shows the busiest of your chats.
  const face: Face = c.you
    ? ((['asks', 'working', 'monitoring'] as Face[]).find((f) => mine.some((p) => faceOf(p.a) === f)) ?? 'done')
    : c.session ? faceOf(c.session) : 'idle'
  // The badge of the ask it shows: its own session's, or for You the first of your chats that asks.
  const asking = c.you ? mine.find((p) => faceOf(p.a) === 'asks')?.a : c.session
  const ask = asking ? askKindOf(asking) : 'question'
  const tip = face === 'idle' ? 'Sleeping' : face === 'asks' ? ASK_TIP[ask] : face === 'done' && !c.you ? 'Available' : STATUS[face]
  const done = (p: Placed) => faceOf(p.a) === 'done' && !inFlight(p.a, p.row, all)
  // Each lead (or chat) and the workers under it form a lane: one stretch of the tree's lines, in the
  // lead's branch color, lit together on hover and while one of them is current.
  const trunk = trunkX(face === 'idle')
  const lanes: { root: Placed; rows: { p: Placed; lead?: Placed }[] }[] = []
  for (const line of lines) {
    if (line.lead && lanes.length) lanes[lanes.length - 1].rows.push(line)
    else lanes.push({ root: line.p, rows: [line] })
  }
  const body = lanes.map(({ root, rows }) => {
    // The lead wears its PR as a bead on its ring.
    const cap = capGlyph(root.row.pr)
    const html = rows.map(({ p, lead }) => {
      const node = nodeOf(p.a, p.row, all)
      const role = { nested: Boolean(lead), trunk, node, ask: faceOf(p.a) === 'asks' ? askKindOf(p.a) : undefined, cap: lead ? null : cap }
      const deco = `<i class="tl" aria-hidden="true"></i>${rowLines(role)}${beam(node)}`
      return agentLine(p, all, coordinators, !single, lead, ui, done(p), isCurrent(p.a, p.row, focused), deco)
    }).join('')
    return `<div class="lane"${branchAttr(root.row)}>${html}</div>`
  }).join('')
  const current = !c.you && coordinatorCurrent(c, focused)
  const folded = ui.folded.has(c.key)
  const node: NodeState = face === 'idle' ? 'sleeping' : face === 'asks' ? 'asking' : face === 'done' ? 'done' : face === 'monitoring' ? 'monitoring' : 'working'
  const ringed = !folded && mine.length > 0
  const mark = `${ringed ? headLines(trunk, node, face === 'asks' ? ask : undefined) + beam(node) : ''}${current ? FOCUS : ''}`
  const head = `${tipped(character(color, shape, face, 28, true, ask, !ringed), tip, face === 'asks' ? ASK_TONE[ask] : '')}<span class="grow"><span class="name">${esc(c.name)}</span><span class="sub">${esc(sub)}</span></span><span class="r">${rowStatus(ui, `coordinator:${c.key}`) ?? ''}</span>`
  // A coordinator's row opens its session; the chevron folds its team. You only folds.
  const row = c.you
    ? `<button class="item coord" data-fold="${esc(c.key)}" aria-expanded="${!folded}">${mark}${head}</button>`
    : `<div class="item coord${current ? ' current' : ''}" data-menu="coordinator:${esc(c.key)}"${current ? ' aria-current="true"' : ''}>${mark}<button class="coord-open" data-coordinator="${esc(c.key)}" aria-label="Open ${esc(c.name)}">${head}</button>${mine.length ? `<button class="coord-fold" data-fold="${esc(c.key)}" aria-expanded="${!folded}" aria-label="Fold ${esc(c.name)}">${ICON.chev}</button>` : ''}</div>`
  return `<section class="coordinator">${row}${folded || !body ? '' : `<div class="group">${body}</div>`}</section>`
}

// ---------- the tree's order, and the Option+1..9 chat shortcuts ----------

/** One coordinator (or You) in the tree: its team in start order, each lead followed by its workers. */
type TreeBlock = { c: Coordinator & { you?: boolean }; mine: Placed[]; lines: { p: Placed; lead?: Placed }[] }

/**
 * The coordinators tree top to bottom: active coordinators (a session or a team), then You when you
 * have chats, then sleeping ones. Each group keeps a stable order, so nothing moves until a
 * coordinator wakes up or goes to sleep. The tree holds every open session in its place: what runs,
 * done agents with work in flight, and finished ones (dimmed) that still hold a terminal.
 */
function treeBlocks(snap: Pick<Snapshot, 'rows' | 'coordinators'>): TreeBlock[] {
  const all = snap.rows.flatMap((r) => r.agents)
  const placed: Placed[] = snap.rows.flatMap((row) => row.agents.map((a) => ({ a, row })))
  const live = placed.filter((p) => faceOf(p.a) !== 'done' || inFlight(p.a, p.row, all) || p.row.liveTerminals > 0)
  const teamOf = (key: string) => live.filter((p) => p.a.coordinator === key)
  const awake = (c: Coordinator) => Boolean(c.session) || teamOf(c.key).length > 0
  const you = { key: 'you', name: 'You', repos: [], workspaceId: null, you: true }
  return [...snap.coordinators.filter(awake), you, ...snap.coordinators.filter((c) => !awake(c))].flatMap((c) => {
    const mine = teamOf(c.key).sort(byStart)
    // You only shows when you have chats; a coordinator always shows, so you can open it.
    if ('you' in c && mine.length === 0) return []
    const panes = new Set(mine.map((p) => p.a.paneKey))
    const roots = mine.filter((p) => !p.a.leadPane || !panes.has(p.a.leadPane))
    const lines = roots.flatMap((p) => [{ p }, ...mine.filter((w) => w.a.leadPane === p.a.paneKey).map((w) => ({ p: w, lead: p }))])
    return [{ c, mine, lines }]
  })
}

/** How many chats get a shortcut: Option+1 to Option+9. */
export const CHAT_KEYS = 9
/** Where the panel keeps its folded groups (plugin storage), so the worker's numbers skip them too. */
export const FOLDED_KEY = 'folded'

/** What a chat shortcut opens, the way a click on its row does; `key` is the row's data-menu. */
export type ChatTarget = { key: string } & ({ coordinator: string } | { workspaceId: string; terminal?: string })

/**
 * The chats Option+1..9 open, in the order the tree shows them: each coordinator, then its leads
 * with their workers, then the chats you started, then sleeping coordinators. A folded group's team
 * is hidden, so it takes no numbers. The panel's key handler and the worker's commands both read this.
 */
export function chatTargets(snap: Pick<Snapshot, 'rows' | 'coordinators'>, folded: ReadonlySet<string> = new Set()): ChatTarget[] {
  return treeBlocks(snap).flatMap(({ c, lines }): ChatTarget[] => [
    ...('you' in c ? [] : [{ key: `coordinator:${c.key}`, coordinator: c.key }]),
    ...(folded.has(c.key) ? [] : lines.map(({ p }): ChatTarget => p.row.coordinator
      ? { key: `agent:${p.a.paneKey}`, coordinator: p.row.coordinator }
      : { key: `agent:${p.a.paneKey}`, workspaceId: p.row.id, ...(p.a.terminal ? { terminal: p.a.terminal } : {}) }))
  ]).slice(0, CHAT_KEYS)
}

/** The chat number of an Option+digit press (by physical key: on a Mac, Option+1 types "¡"), or null. */
export function chatDigit(e: { code: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): number | null {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null
  const m = /^Digit([1-9])$/.exec(e.code)
  return m && Number(m[1]) <= CHAT_KEYS ? Number(m[1]) : null
}

function foldList(key: string, title: string, rows: string[], ui: UiState, count = rows.length): string {
  if (count === 0) return ''
  const open = ui.unfolded.has(key)
  return `<button class="fold" data-unfold="${key}" aria-expanded="${open}">${ICON.chev}${esc(title)} · ${count}</button>${open ? `<div class="group fold-list">${rows.join('')}</div>` : ''}`
}

// ---------- the panel ----------

/**
 * The parts the page places separately: the cockpit row (beside the static search control in the top
 * bar), its opened stats below the bar, the scrolling middle (the tree), what asks you (Up next),
 * pinned below it, and the pinned footer. Up next sits at the bottom so the tree never moves when an
 * ask comes or goes: it starts at the top of its own scroll area, which only gets shorter.
 */
export function render(snap: Snapshot, ui: UiState): { cockpit: string; copen: string; main: string; attention: string; footer: string } {
  const copen = ui.cockpitOpen && !ui.query ? cockpitOpen(snap, ui) : ''
  const all = snap.rows.flatMap((r) => r.agents)
  // One briefing per asking agent, workspaces in urgency order; several agents in one workspace each
  // get one; a coordinator asking itself gets one too.
  const asking = askingRows(snap).flatMap((row) => row.agents.filter(asksYou).map((a) => ({ a, row })))

  if (ui.query) {
    const q = ui.query.toLowerCase()
    const found = snap.rows.filter((r) => [r.name, r.repo, r.branch, ...r.agents.map((a) => a.title)].some((f) => f?.toLowerCase().includes(q)))
    return { cockpit: cockpit(snap, ui), copen, main: `<div class="group found">${
      found.length
        ? found.map((r) => `<button class="item" data-open="${esc(r.id)}">${character(colorOf(r.repo), 'solo', r.agents.length ? faceOf(r.agents[0]) : 'idle', 20)}<span class="t">${esc(r.agents[0]?.title ?? r.name)}</span><span class="r soft">${esc(r.repo)}</span></button>`).join('')
        : '<div class="empty">No matching workspaces</div>'
    }</div>`, attention: '', footer: '' }
  }

  // Sleep and remove are in the rows' menus.
  const idleRows = snap.rows.filter((r) => r.agents.length === 0 && !needsYou(r)).sort((x, y) => x.createdAt - y.createdAt)
  const tree = treeBlocks(snap).map((b) => coordinatorBlock(b, all, snap.coordinators, ui, snap.focusedPanes)).join('')

  const idle = idleRows.map((r) => `<button class="item" data-open="${esc(r.id)}">${tipped(character(colorOf(r.repo), 'solo', 'idle', 20), 'Idle')}<span class="t muted">${esc(r.name)}</span><span class="r soft">${esc(r.repo)}</span></button>`)

  return {
    cockpit: cockpit(snap, ui),
    copen,
    main: `<div class="tree"><div class="label">Coordinators</div>${tree || '<div class="empty">No agents running</div>'}<button class="newcoord" data-new-coordinator>${ICON.plus}New coordinator</button></div>`,
    attention: upNext(asking, all, snap.coordinators, ui),
    footer: idle.length ? `<div class="folds">${foldList('idle', 'Idle', idle, ui)}</div>` : ''
  }
}

// ---------- looks for new coordinators ----------

export const LOOK_SHAPES: LookShape[] = ['pentagon', 'hex', 'shield']

/** Every color and shape no coordinator uses yet; new coordinators are offered one of these. */
export function freeLooks(coordinators: Coordinator[]): Look[] {
  const taken = new Set(coordinators.map((c) => (c.look ? `${c.look.color}/${c.look.shape}` : '')))
  return PALETTE.flatMap((color) => LOOK_SHAPES.map((shape) => ({ color, shape }))).filter((l) => !taken.has(`${l.color}/${l.shape}`))
}
