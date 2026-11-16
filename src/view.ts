// The panel as pure functions: a snapshot and the UI state in, HTML out. No DOM, so it is tested
// in Node; src/panel/app.ts only wires clicks and redraws.
//
// Layout (agreed in the mockup): a one-row cockpit; Up next as collapsible briefings, the first
// open (what it is about, the ask at a glance, one button to jump); then the coordinators tree.
// Characters carry everything: color = project, shape = role, face = state.
import type { AgentInfo, Capacity, CockpitStats, Coordinator, LookShape, Look, Snapshot, StartedGroup, UpdateState, WorkspaceRow } from './protocol.ts'
import { asksYou, claimsAsk, holdsWorkstream, monitoring, needsYou, waitingQueue } from './rank.ts'

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
}

export const emptyUi = (): UiState => ({
  opened: new Set(), closed: new Set(), folded: new Set(), unfolded: new Set(), query: '', now: Date.now(),
  cockpitOpen: false, stats: null, statsLoading: false, confirming: null, pending: null, notice: null, status: new Map()
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

/** An SVG character. An asking one wears the badge of what it asks (`ask`, a question by default). */
export function character(color: string, shape: Shape, face: Face, size = 16, badge = true, ask: AskKind = 'question'): string {
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
  const svg = `<svg class="ch${face === 'idle' ? ' faded' : ''}" width="${s + grow}" height="${s + grow}"${grow ? ` style="margin:0 -${grow}px -${grow}px 0"` : ''} viewBox="${box}" aria-hidden="true">${body}${faces[face]}${hand}${badge ? (badges[face] ?? '') : ''}</svg>`
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
function agentCharacter(a: AgentInfo, row: WorkspaceRow, all: AgentInfo[], size = 20): string {
  const face = faceOf(a)
  const ask = askKindOf(a)
  const tip = face === 'asks' ? ASK_TIP[ask] : face === 'done' && inFlight(a, row, all) ? 'Available' : STATUS[face]
  return tipped(character(colorOf(row.repo), shapeOf(a, all), face, size, true, ask), tip, face === 'asks' ? ASK_TONE[ask] : '')
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

/** An action that asks "Yes · No" in place (unless `ask` is false), then shows its result. */
function action(key: string, label: string, question: string, ui: UiState, ask = true): string {
  if (ui.pending === key) return busy(key.startsWith('remove:') ? 'Removing…' : 'Sleeping…')
  if (ui.notice?.key === key) return `<span class="rstatus ${ui.notice.ok ? 'ok' : 'bad'}">${esc(ui.notice.text)}</span>`
  if (ui.confirming === key) return `<span class="confirm">${esc(question)} <button class="yes" data-yes="${esc(key)}">Yes</button> <button class="no" data-no>No</button></span>`
  return ask ? `<button class="act" data-act="${esc(key)}">${esc(label)}</button>` : `<button class="act" data-yes="${esc(key)}">${esc(label)}</button>`
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

function cockpitOpen(snap: Snapshot, ui: UiState): string {
  if (!ui.stats && ui.notice?.key === 'load') return `<div class="copen"><div class="empty">Could not check what’s running: ${esc(ui.notice.text)}</div></div><div class="hair"></div>`
  if (!ui.stats) return loader()
  const st = ui.stats
  const all = snap.rows.flatMap((r) => r.agents)
  const placed = (pane: string) => snap.rows.flatMap((row) => row.agents.map((a) => ({ a, row }))).find((p) => p.a.paneKey === pane)
  const swap = st.swap && st.swap.totalGB > 0 ? st.swap : null
  const pct = swap ? Math.round((swap.usedGB / swap.totalGB) * 100) : 0
  const ram = st.ram ?? null
  const ramPct = ram ? Math.min(100, Math.round((ram.usedGB / ram.totalGB) * 100)) : 0
  // A labelled bar: neutral until it is nearly full.
  const meter = (label: string, pct: number, text: string) =>
    `<div class="swap"><span class="meter-label">${label}</span><span class="bar${pct >= 85 ? ' warn' : ''}"><span style="width:${pct}%"></span></span><span class="${pct >= 85 ? 'warn' : 'muted'}">${text}</span></div>`
  const placedAll = snap.rows.flatMap((row) => row.agents.map((a) => ({ a, row })))
  const stat = (n: number, label: string, cls = '', attrs = '') =>
    n > 0 ? `<${attrs ? 'button' : 'div'} class="stat ${cls}"${attrs}><span class="n">${n}</span><span class="l">${label}</span></${attrs ? 'button' : 'div'}>` : ''
  const counts = [
    stat(all.filter((a) => faceOf(a) === 'asks').length, 'asking', 'ask'),
    stat(all.filter((a) => faceOf(a) === 'working').length, 'working'),
    stat(all.filter((a) => faceOf(a) === 'monitoring').length, 'monitoring'),
    stat(finishedOf(placedAll).length, 'finished')
  ].join('')
  // What a session started outside itself (a dev server) sits under it; Orca does not count it.
  const startedName = (g: StartedGroup) => (g.count > 1 ? `${g.name} +${g.count - 1}` : g.name)
  const startedLine = (g: StartedGroup, ch = '', where = '') =>
    `<div class="item static${ch ? '' : ' started'}">${ch || '<span class="sub-mark">↳</span>'}<span class="t">${esc(startedName(g))}${where ? ` <span class="soft">${esc(where)}</span>` : ''}</span><span class="r">${size(g.memMB)}</span></div>`
  const started = st.started ?? []
  const heavy = st.heaviest.map((h) => {
    const p = placed(h.paneKey)
    const ch = p ? character(colorOf(p.row.repo), shapeOf(p.a, all), faceOf(p.a), 16) : character(colorOf(h.repo), 'solo', 'done', 16)
    return `<div class="item static">${ch}<span class="t">${esc(h.title)}</span><span class="r">${size(h.memMB)}</span>${action(`close:${h.paneKey}`, 'sleep', '', ui, false)}</div>` +
      started.filter((g) => g.paneKey === h.paneKey).map((g) => startedLine(g)).join('')
  }).join('')
  // Started by an agent that is not open any more (it slept): still running, still costing memory.
  const live = new Set(all.map((a) => a.paneKey))
  const orphans = started.filter((g) => !g.paneKey || !live.has(g.paneKey)).map((g) => startedLine(g, character(colorOf(g.repo), 'solo', 'idle', 16), g.worktreeName)).join('')
  // Sleeping every finished session is offered only when memory is tight; otherwise they cost nothing
  // you need, and each one sleeps from its own menu. The same set the footer's Sleep all used.
  const finished = finishedOf(placedAll)
  const freedMb = finished.reduce((n, p) => n + (st.finished.find((f) => f.paneKey === p.a.paneKey)?.memMB ?? 0), 0)
  const tight = (snap.capacity?.verdict ?? 'ok') !== 'ok'
  const n = finished.length
  const sleepAll = tight && n > 0
    ? `<div class="closeall">${action('closeall', `${freedMb ? `Free ${size(freedMb)}: sleep` : 'Sleep'} ${n} finished ${n === 1 ? 'session' : 'sessions'}`, `Sleep ${n} ${n === 1 ? 'session' : 'sessions'}?`, ui)}</div>`
    : ''
  const actions = [
    sleepAll,
    ...st.merged.map((m) => `<div class="merged">${action(`remove:${m.workspaceId}`, `Remove ${m.name}`, `Remove ${m.name}?`, ui)}<span class="soft">PR #${m.pr} merged · clean</span></div>`)
  ].filter(Boolean).join('')
  return `<div class="copen">
    <div class="cgroup"><span class="label">Memory${ui.statsLoading ? ' <span class="refreshing" aria-label="Refreshing"></span>' : ''}</span>
      ${ram ? meter('RAM', ramPct, `${ram.usedGB} of ${ram.totalGB} GB used`) : ''}
      ${swap ? meter('Swap', pct, `${swap.usedGB} of ${swap.totalGB} GB`) : ''}
    </div>
    ${heavy || orphans ? `<div class="cgroup"><span class="label">Heaviest</span>${heavy}${orphans}</div>` : ''}
    ${counts ? `<div class="cgroup"><span class="label">Agents</span><div class="stats">${counts}</div></div>` : ''}
    ${actions ? `<div class="cactions">${actions}</div>` : ''}
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
  return `<section class="upnext"><div class="label">Up next · ${placed.length}</div><div class="group">${items.join('')}</div></section><div class="hair"></div>`
}

// ---------- your coordinators ----------

/**
 * The worktree's PR the way Orca's own workspace card shows it: the icon says the state (open,
 * merged, closed, draft); an open PR is colored by its checks (failed red, pending yellow, passed
 * green), anything else by its state (merged purple, closed and draft grey).
 */
export function prBadge(pr: WorkspaceRow['pr']): string {
  if (!pr) return ''
  const state = pr.state === 'merged' || pr.state === 'closed' || pr.state === 'draft' ? pr.state : 'open'
  const tone = state === 'open' ? { failure: 'fail', pending: 'pending', success: 'ok', cancelled: 'closed' }[pr.checks ?? 'success'] ?? 'ok' : state
  const word = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : state === 'draft' ? 'draft' : pr.checks === 'failure' ? 'checks failed' : pr.checks === 'pending' ? 'checks pending' : 'open'
  return `<span class="pr pr-${tone}" role="link" data-pr="${esc(pr.url)}" data-tip="PR #${pr.number} ${word}">${PR_ICON[state]}</span>`
}

const PR_ICON: Record<string, string> = {
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>',
  merged: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>',
  closed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="m21 3-6 6"/><path d="m21 9-6-6"/><path d="M18 11.5V15"/><circle cx="18" cy="18" r="3"/></svg>',
  draft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 6V5"/><path d="M18 11v-1"/><path d="M6 9v12"/></svg>'
}

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

function agentLine(p: Placed, all: AgentInfo[], coordinators: Coordinator[], soft: boolean, indent: boolean, ui: UiState, done = false, current = false): string {
  const status = rowStatus(ui, `agent:${p.a.paneKey}`)
  // A worker nested under its lead shares its worktree: the lead's row already shows project, PR and age.
  const right = status ?? (indent ? '' : `${soft ? `<span class="soft">${esc(p.row.repo)}</span>` : ''}${prBadge(p.row.pr)}<span>${ago(p.row.lastActivityAt, ui.now)}</span>`)
  const cls = `item${indent ? ' indent' : ''}${done ? ' finished' : ''}${current ? ' current' : ''}`
  const menu = `data-menu="agent:${esc(p.a.paneKey)}"${current ? ' aria-current="true"' : ''}`
  // A lead that reported worker_done leaves its worktree ready for cleanup: offer remove on the row.
  // A button cannot hold a button, so this row is a div whose name opens the session.
  if (removable(p, all) && !status) {
    return `<div class="${cls}" ${menu}>${agentCharacter(p.a, p.row, all)}<span class="t" ${openAttrs(p)} role="button" tabindex="0">${esc(nameOf(p.a, p.row))}</span><span class="r">${right}</span><button class="act" data-remove="${esc(p.row.id)}" data-target="agent:${esc(p.a.paneKey)}">remove</button></div>`
  }
  return `<button class="${cls}" ${openAttrs(p)} ${menu}>${agentCharacter(p.a, p.row, all)}<span class="t">${esc(nameOf(p.a, p.row))}</span><span class="r">${right}</span></button>`
}

/**
 * A lead whose dispatch settled (worker_done, failed or abandoned), or whose worktree's PR merged
 * (nothing wakes a lead to report worker_done then), with nothing of its own still running: its
 * worktree can go. The remove flow still refuses a dirty checkout or an unmerged PR.
 */
export const removable = ({ a, row }: Placed, all: AgentInfo[]) =>
  a.summary?.role === 'lead' && (a.dispatch === 'settled' || row.pr?.state === 'merged') &&
  !row.main && faceOf(a) === 'done' && !leadsOpenWork(a, all)

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

function coordinatorBlock(c: Coordinator & { you?: boolean }, mine: Placed[], all: AgentInfo[], coordinators: Coordinator[], ui: UiState, focused?: string[] | null): string {
  // You only shows when you have chats; a coordinator always shows, so you can open it.
  if (c.you && mine.length === 0) return ''
  mine = [...mine].sort(byStart)
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
  const panes = new Set(mine.map((p) => p.a.paneKey))
  const roots = mine.filter((p) => !p.a.leadPane || !panes.has(p.a.leadPane))
  const done = (p: Placed) => faceOf(p.a) === 'done' && !inFlight(p.a, p.row, all)
  const line = (p: Placed, indent: boolean) => agentLine(p, all, coordinators, !single, indent, ui, done(p), isCurrent(p.a, p.row, focused))
  const body = roots
    .map((p) => line(p, false) + mine.filter((w) => w.a.leadPane === p.a.paneKey).map((w) => line(w, true)).join(''))
    .join('')
  const current = !c.you && coordinatorCurrent(c, focused)
  const folded = ui.folded.has(c.key)
  const head = `${tipped(character(color, shape, face, 28, true, ask), tip, face === 'asks' ? ASK_TONE[ask] : '')}<span class="grow"><span class="name">${esc(c.name)}</span><span class="sub">${esc(sub)}</span></span><span class="r">${rowStatus(ui, `coordinator:${c.key}`) ?? ''}</span>`
  // A coordinator's row opens its session; the chevron folds its team. You only folds.
  const row = c.you
    ? `<button class="item coord" data-fold="${esc(c.key)}" aria-expanded="${!folded}">${head}</button>`
    : `<div class="item coord${current ? ' current' : ''}" data-menu="coordinator:${esc(c.key)}"${current ? ' aria-current="true"' : ''}><button class="coord-open" data-coordinator="${esc(c.key)}" aria-label="Open ${esc(c.name)}">${head}</button>${mine.length ? `<button class="coord-fold" data-fold="${esc(c.key)}" aria-expanded="${!folded}" aria-label="Fold ${esc(c.name)}">${ICON.chev}</button>` : ''}</div>`
  return `<section class="coordinator">${row}${folded || !body ? '' : `<div class="group">${body}</div>`}</section>`
}

function foldList(key: string, title: string, rows: string[], ui: UiState, count = rows.length): string {
  if (count === 0) return ''
  const open = ui.unfolded.has(key)
  return `<button class="fold" data-unfold="${key}" aria-expanded="${open}">${ICON.chev}${esc(title)} · ${count}</button>${open ? `<div class="group fold-list">${rows.join('')}</div>` : ''}`
}

// ---------- the panel ----------

/** The parts the page places separately: the cockpit row (beside the static search control in the
 *  top bar), its opened stats below the bar, the scrolling middle, and the pinned footer. */
export function render(snap: Snapshot, ui: UiState): { cockpit: string; copen: string; main: string; footer: string } {
  const copen = ui.cockpitOpen && !ui.query ? cockpitOpen(snap, ui) : ''
  const all = snap.rows.flatMap((r) => r.agents)
  const placed: Placed[] = snap.rows.flatMap((row) => row.agents.map((a) => ({ a, row })))
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
    }</div>`, footer: '' }
  }

  // The tree holds every open session in its place: what runs, done agents with work in flight, and
  // finished ones (dimmed) that still hold a terminal. Sleep and remove are in their menus.
  const live = placed.filter((p) => faceOf(p.a) !== 'done' || inFlight(p.a, p.row, all) || p.row.liveTerminals > 0)
  const idleRows = snap.rows.filter((r) => r.agents.length === 0 && !needsYou(r)).sort((x, y) => x.createdAt - y.createdAt)
  // Active coordinators (a session or a team) and You lead; sleeping coordinators follow, just above
  // New coordinator. Each group keeps a stable order, so nothing moves until a
  // coordinator wakes up or goes to sleep.
  const teamOf = (key: string) => live.filter((p) => p.a.coordinator === key)
  const awake = (c: Coordinator) => Boolean(c.session) || teamOf(c.key).length > 0
  const active = snap.coordinators.filter(awake)
  const sleeping = snap.coordinators.filter((c) => !awake(c))
  const you = { key: 'you', name: 'You', repos: [], workspaceId: null, you: true }
  // Sleeping coordinators use the same full row; they only come after the active ones.
  const tree = [...active, you, ...sleeping].map((c) => coordinatorBlock(c, teamOf(c.key), all, snap.coordinators, ui, snap.focusedPanes)).join('')

  const idle = idleRows.map((r) => `<button class="item" data-open="${esc(r.id)}">${tipped(character(colorOf(r.repo), 'solo', 'idle', 20), 'Idle')}<span class="t muted">${esc(r.name)}</span><span class="r soft">${esc(r.repo)}</span></button>`)

  return { cockpit: cockpit(snap, ui), copen, main: [
    upNext(asking, all, snap.coordinators, ui),
    `<div class="tree"><div class="label">Coordinators</div>${tree || '<div class="empty">No agents running</div>'}<button class="newcoord" data-new-coordinator>${ICON.plus}New coordinator</button></div>`
  ].join(''), footer: idle.length ? `<div class="folds">${foldList('idle', 'Idle', idle, ui)}</div>` : '' }
}

// ---------- looks for new coordinators ----------

export const LOOK_SHAPES: LookShape[] = ['pentagon', 'hex', 'shield']

/** Every color and shape no coordinator uses yet; new coordinators are offered one of these. */
export function freeLooks(coordinators: Coordinator[]): Look[] {
  const taken = new Set(coordinators.map((c) => (c.look ? `${c.look.color}/${c.look.shape}` : '')))
  return PALETTE.flatMap((color) => LOOK_SHAPES.map((shape) => ({ color, shape }))).filter((l) => !taken.has(`${l.color}/${l.shape}`))
}
