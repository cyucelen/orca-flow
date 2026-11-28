import { coordinatorHandover } from './handover-providers.js'
import { askKey } from './coordinator-sessions.js'
// The panel as pure functions: a snapshot and the UI state in, HTML out. No DOM, so it is tested
// in Node; src/panel/app.ts only wires clicks and redraws.
//
// Layout (agreed in the mockup): a one-row cockpit; Up next as collapsible briefings, the first
// open (what it is about, the ask at a glance, one button to jump); then the coordinators tree.
// Characters carry everything: color = project, shape = role, face = state.
import { approvalSummary } from './approval.js'

import { AGY_WAITING_TIP, CODEX_WAITING_TIP, RELOAD_TIP, visibleReload } from './skill-reload.js'
import { mixedProviders, providerBadge, providerMark, providerOf } from './providers.js'
import { PROVIDER_LOGOS } from './provider-logos.js'
import { asksYou, byUrgency, canRemove, claimsAsk, holdsWorkstream, laterAsk, monitoring, waitingQueue, worktreeLead } from './rank.js'
import { BEAMS, capGlyph, headLines, nodeX, rowLines, trunkX,                } from './lines.js'
import { goalsHead, goalsRows, nextButton,               } from './goals-view.js'
import { ARROW } from './icons.js'
import { DEFAULT_DISPLAY, FILTER_NAME, FILTERS, isDefaultDisplay, issueLink, LINEAR_MARK, linkRows, priorityIcon, rowsByIssue, STATE_NAME, statusIcon, teamsOf, viewOf,                                                   } from './linear.js'


































                                                                                                 







export const emptyUi = ()          => ({
  opened: new Set(), closed: new Set(), folded: new Set(), unfolded: new Set(), query: '', now: Date.now(),
  cockpitOpen: false, stats: null, statsLoading: false, confirming: null, pending: null, notice: null, status: new Map(), colors: new Map(),
  linearFolded: false, linearFilter: 'mine', linearDisplay: DEFAULT_DISPLAY, linearGroupFolds: new Set(), botsFolded: false, goalsFolded: false, goalOpen: null, goalAssigning: new Set(), goalGone: new Set()
})

// ---------- small helpers ----------

export const esc = (s         ) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] )
const clip = (s        , n        ) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const WORD = { P0: 'now', P1: 'today', P2: 'soon', P3: 'someday' }

export function ago(ms               , now        )         {
  if (!ms) return ''
  const m = Math.max(0, Math.round((now - ms) / 60_000))
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

// ---------- characters ----------




const PALETTE = ['#5b8def', '#e0a04a', '#4cb782', '#b07cf0', '#e06c8a', '#4fbfc8', '#c9b458', '#7c8cff', '#e07b4f', '#8fbf5a']
/** A stable color per project name. */
export function colorOf(project        )         {
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
export function character(color        , shape       , face      , size = 16, badge = true, ask          = 'question', spinner = true)         {
  const s = size, ink = '#141416', sw = Math.max(1, s * 0.07)
  const queued = face === 'queued'
  const paint = queued ? `fill="none" stroke="${color}" stroke-width="${Math.max(1, s * 0.06)}" stroke-dasharray="${s * 0.12} ${s * 0.09}"` : `fill="${color}"`
  const body =
    shape === 'lead'
      ? `<rect x="${s * 0.06}" y="${s * 0.14}" width="${s * 0.88}" height="${s * 0.8}" rx="${s * 0.2}" ${paint}/>${queued ? '' : `<path d="M${s * 0.3} ${s * 0.16} l${s * 0.1} -${s * 0.12} l${s * 0.1} ${s * 0.1} l${s * 0.1} -${s * 0.1} l${s * 0.1} ${s * 0.12}" fill="${color}"/>`}`
      : shape === 'bot'
        // An Orca bot: a rounded head with an antenna.
        ? `<rect x="${s * 0.08}" y="${s * 0.26}" width="${s * 0.84}" height="${s * 0.68}" rx="${s * 0.22}" ${paint}/>${queued ? '' : `<path d="M${s / 2} ${s * 0.27} V${s * 0.1}" stroke="${color}" stroke-width="${s * 0.08}" stroke-linecap="round"/><circle cx="${s / 2}" cy="${s * 0.09}" r="${s * 0.08}" fill="${color}"/>`}`
      : shape === 'worker'
        ? `<circle cx="${s / 2}" cy="${s * 0.55}" r="${s * 0.38}" ${paint}/>`
        : shape === 'pentagon'
          ? `<path d="M${s / 2} ${s * 0.04} L${s * 0.95} ${s * 0.4} L${s * 0.78} ${s * 0.95} L${s * 0.22} ${s * 0.95} L${s * 0.05} ${s * 0.4} Z" ${paint}/>`
          : shape === 'hex'
            ? `<path d="M${s * 0.27} ${s * 0.08} H${s * 0.73} L${s * 0.96} ${s * 0.5} L${s * 0.73} ${s * 0.92} H${s * 0.27} L${s * 0.04} ${s * 0.5} Z" ${paint}/>`
            : shape === 'shield'
              ? `<path d="M${s * 0.1} ${s * 0.12} Q${s / 2} ${s * 0.02} ${s * 0.9} ${s * 0.12} V${s * 0.5} Q${s * 0.9} ${s * 0.82} ${s / 2} ${s * 0.97} Q${s * 0.1} ${s * 0.82} ${s * 0.1} ${s * 0.5} Z" ${paint}/>`
          : `<rect x="${s * 0.08}" y="${s * 0.1}" width="${s * 0.84}" height="${s * 0.84}" rx="${s * 0.42}" ${paint}/>`
  const eye = (x        , y        , r = 0.07) => `<circle cx="${s * x}" cy="${s * y}" r="${s * r}" fill="${queued ? color : ink}"/>`
  const line = (d        ) => `<path d="${d}" stroke="${ink}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`
  const faces                       = {
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
  const spin = (cls        , inner        ) => `${rim}<g class="${cls}" style="transform-origin:${bx}px ${by}px">${inner}</g>`
  const badges                                = {
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
const nameOf = (a           , row              ) => (showable(a.title) && a.title !== a.agentType ? a.title : row.name)

/** A character with a one- or two-word status tooltip (the panel's own tooltip, not the OS one). */
function tipped(svg        , tip        , tone = '')         {
  return `<span class="who" data-tip="${esc(tip)}"${tone ? ` data-tone="${tone}"` : ''}>${svg}</span>`
}

const STATUS                       = { working: 'Working', monitoring: 'Monitoring', asks: 'Waiting on you', done: 'Done', failed: 'Failed', idle: 'Idle', queued: 'Queued' }

/**
 * What an asking agent wants, at a glance: a review (look at a PR, diff or result), a yes/no
 * (Orca's permission prompt, or an approval), an action (something only the user can do outside
 * the chat: a setting, a login, a command), or a question (Orca's pending question, a decision,
 * a fact). Ranking and counting still treat all four as one "asks" face.
 */

export function askKindOf(a           )          {
  if (a.state === 'blocked') return 'approval'
  if (a.state === 'waiting') return 'question'
  const t = a.summary?.needs.type
  return t === 'review' || t === 'approval' || t === 'action' ? t : 'question'
}
const ASK_TIP                          = { review: 'Wants a review', approval: 'Needs a yes/no', action: 'Asks you to do something', question: 'Asks a question' }
/** Tooltip tone (src/panel/panel.css .tip.<tone>), matching the badge's color. */
const ASK_TONE                          = { review: 'review', approval: 'warn', action: 'action', question: 'ask' }
/** How much (a share of the size) the frame grows for the larger review badge. */
const REVIEW_ROOM = 0.12
const ASK_BADGE                                                                                          = {
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
function agentCharacter(a           , row              , all             , size = 20, spinner = true)         {
  const face       = asleep(row) ? 'idle' : faceOf(a)
  const ask = askKindOf(a)
  const state = asleep(row) ? 'Asleep' : face === 'asks' ? ASK_TIP[ask] : face === 'done' && inFlight(a, row, all) ? 'Available' : STATUS[face]
  return tipped(character(colorOf(row.repo), shapeOf(a, all), face, size, true, ask, spinner), state, face === 'asks' ? ASK_TONE[ask] : '')
}

/**
 * The agent's model in the Linear chip's box and type (panel.css .mbadge): its provider's mark, then
 * the model's name, on the row's left between the avatar and the title. Only the name is shown while
 * it is asked for or the provider's default (`pending`, italic and dimmer). Without a model, it is
 * the provider mark as before.
 */
export function modelBadge(a                              , mixed         )         {
  const m = a?.model
  if (!a || !m) return providerBadge(a, mixed)
  const { name, mark } = providerMark(a)
  return `<span class="mbadge${m.source === 'seen' ? '' : ' pending'}" aria-label="${esc(`${name} · ${m.name}`)}">${mark}<span class="mn">${esc(m.name)}</span></span>`
}

/** The coordinator's model on its row's right: the same chip without the mark, since its picker shows the provider. */
export function modelChip(a                              )         {
  const m = a?.model
  if (!a || !m) return ''
  return `<span class="mbadge model-only${m.source === 'seen' ? '' : ' pending'}"><span class="mn">${esc(m.name)}</span></span>`
}

// ---------- reading the model ----------

/**
 * Only summaries written under the current rules (they carry `glance`) may claim an ask; older ones
 * produced junk like terminal ids. Orca's own blocked/waiting states always count.
 */
const trusted = (a           ) => a.summary !== null && typeof a.summary.glance === 'string'

/** Text that leaks ids, hashes or paths is never shown. */
const LEAK = /term_[0-9a-f]|[_-][0-9a-f]{10,}\b|[0-9a-f]{8}-[0-9a-f]{4}|\b[0-9a-f]{12,}\b|(?:^|\s)(?:~|\.)?\/[\w.-]+\//i
export const showable = (text                    )                 => Boolean(text) && !LEAK.test(text )

/** The face shows what Orca shows: its monitoring mode, otherwise its state. */
export function faceOf(a           )       {
  if (asksYou(a)) return 'asks'
  if (monitoring(a)) return 'monitoring'
  return a.state === 'working' ? 'working' : 'done'
}

/** Agents that dispatched someone wear the coordinator shape; workers were dispatched; everyone else works alone. */
export function shapeOf(a           , all             )        {
  // A lead (told so at spawn) or any agent with workers under it wears the crowned square.
  if (a.summary?.role === 'lead' || a.summary?.role === 'coordinator' || all.some((b) => b.leadPane === a.paneKey)) return 'lead'
  if (a.leadPane || a.summary?.role === 'worker') return 'worker'
  return 'solo'
}



/** This machine's rows: a paired host's rows (`host`) open, close and resume nothing here. */
export const localRows =                                       (rows     )      => (rows.some((r) => r.host) ? rows.filter((r) => !r.host) : rows)

/**
 * The snapshot without paired hosts' rows: what the panel draws until the agreed host UI lands, and
 * what Up next, the status bar and the chat shortcuts read. Unchanged (the same object) without them.
 */
export const localView =                                   (snap   )    => (snap.rows.some((r) => r.host) ? { ...snap, rows: localRows(snap.rows) } : snap)

/** Why a paired host's row opens nothing here. */
export const remoteTip = (row                            ) => `${row.host?.name ?? 'That host'}'s worktrees open from Orca's own sidebar`

/**
 * A closed conversation in a coordinator's folder (folderRows in worker.ts): no open terminal of its
 * own, whatever else runs in the folder. The tree, Up next and every count leave it out like any
 * sleeping lead (the tree keeps it, drawn asleep, only while agents it leads are open); where it
 * still shows, a click resumes it by its exact provider id (`resumeId`), and nothing offers to put
 * it to sleep.
 */
export const asleep = (row              )          => Boolean(row.folderOf) && !row.historical && row.liveTerminals === 0

function coordinatorName(key        , coordinators               )         {
  return key === 'you' ? 'You' : (coordinators.find((c) => c.key === key)?.name ?? key)
}

/** What the briefing says the workstream is about; older summaries fall back to their goal. */
const aboutOf = ({ a, row }        ) => [a.summary?.about, row.card?.goal, a.summary?.goal].find(showable) ?? ''

/** The ask in about eight words, or why the agent is waiting when no summary says. */
export function glanceOf({ a }        )         {
  if (a.state === 'waiting' && a.question) return clip(a.question, 90)
  if (claimsAsk(a) && showable(a.summary?.glance)) return a.summary .glance
  if (trusted(a) && a.summary .needs.type !== 'none' && showable(a.summary .needs.ask)) return clip(a.summary .needs.ask, 60)
  return a.state === 'blocked' ? 'Approve a permission prompt.' : a.state === 'waiting' ? 'Answer its question.' : 'Waiting for your input.'
}

/**
 * The words a framed ask wants back ("Reply: A or B"), under the ask it belongs to: only when the
 * ask shown is the summary's, not Orca's own question or permission prompt.
 */
export function replyOf({ a }        )         {
  if (a.state === 'waiting' || a.state === 'blocked' || !claimsAsk(a)) return ''
  return showable(a.summary?.reply) ? clip(a.summary .reply , 60) : ''
}

/** Each kind of ask in plain words: the user never sees the kind's name. */
const NEEDS_WORDS                         = {
  decision: 'Needs your pick', approval: 'Needs your yes', review: 'Needs your review', info: 'Needs info from you', action: 'Needs you to act'
}

/**
 * What the ask needs, as Up next labels it: the frame's own status line ("Needs 2 files from you")
 * when the ask came from a frame, else the kind in plain words. Orca's own question and permission
 * prompt need an answer and a yes.
 */
export function needsLabel({ a }        )         {
  if (a.state === 'waiting') return 'Needs your answer'
  if (a.state === 'blocked') return NEEDS_WORDS.approval
  const s = a.summary
  if (s?.source === 'frame' && claimsAsk(a) && showable(s.status)) return s.status
  return NEEDS_WORDS[s && s.needs.type !== 'none' ? s.needs.type : 'info']
}

// ---------- cockpit ----------



/** Gauge tooltips stay within five words. */
export function gaugesOf(c          )          {
  const out          = []
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

const ICON                         = {
  chip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1.5"/><rect x="6.5" y="6.5" width="3" height="3" rx=".5"/><path d="M6.5 1.5V4M9.5 1.5V4M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5"/></svg>',
  disk: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="12" height="8" rx="2"/><path d="M5 9.5h3"/><circle cx="11" cy="9.5" r=".6" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4v8M10 4v8"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
  chev: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2l3 3-3 3"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3.5v9M3.5 8h9"/></svg>'
}

const size = (mb        ) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`)

/** Something in progress, inline: a small spinner and a verb. The one inline loading style. */
export const busy = (text        ) => `<span class="rstatus pending"><span class="refreshing"></span>${esc(text)}</span>`

/**
 * A row's inline status: running, done, failed (red is only for what actually failed), or `warn`
 * when the step stopped without failing (refused by a guard, or not confirmed yet). `text` is a short
 * label; `detail` is the full readable reason with its recovery, reachable by hover, focus and click.
 */


/** Starts every ownership refusal of handover.ts (transferPlan, requirePlannedOwnership); the panel shows it as "Handover blocked". */
export const OWNERSHIP_REFUSAL = 'Handover is blocked: this coordinator still owns'

/** A run with live work, as a refusal names it: what keeps it live, in plain words. */


/**
 * The refusal in plain words, with what the person can do today. Orca's only transfer, run-use, is
 * run by the new conversation itself and binds one run per terminal: one live run moves, settled runs
 * (no open dispatch, no unhandled coordinator mail, no pending gate) stay and never block. A number
 * is the older count-only wording, kept for messages recorded before runs were named.
 */
export function ownershipRefusal(live                    , planned                )         {
  if (typeof live === 'number') return `${OWNERSHIP_REFUSAL} ${live === 1 ? 'an orchestration run' : `${live} orchestration runs`} with live work, and Orca can move only one live run to another conversation. Nothing was changed.\n` +
    'To keep working now, stay in the current conversation.\n' +
    'Choose Handover again to see which runs are live and what keeps each one live. Settled runs no longer block Handover.'
  const list = live.map((r) => `• ${r.id}${r.objective ? ` (${r.objective.replace(/\s+/g, ' ').slice(0, 80)})` : ''}: ${r.why.join('; ') || 'live'}`).join('\n')
  const midflight = planned !== undefined
  return `${OWNERSHIP_REFUSAL} ${live.length === 1 ? 'a run' : `${live.length} runs`} with live work${midflight ? ` that this handover was not prepared to move${planned ? ` (it moves only ${planned})` : ''}` : ''}, and Orca can move only one live run to a new conversation (run-use binds one run per terminal). ${midflight ? 'The handover stopped before moving any run.' : 'Nothing was changed.'}\n` +
    `${list}\n` +
    (midflight
      ? 'Keep working in the original conversation. Retry once the extra live work has settled.'
      : 'To switch now, open a fresh coordinator terminal per run you want to move. In each, confirm orca orchestration run-current shows no run, then run orca orchestration run-use --id <its run ID>. Confirm with run-current and inspect mail with orca orchestration check --peek. Keep the source open for any run left there or refused by Orca.\n' +
        'For a single replacement, stay in the current conversation until all but one run has settled, then choose Handover again.')
}

/** Shown, with Retry, when the target is current but its run-use for `run` was not seen in time. */
export function adoptionWarning(provider        , run        )         {
  return `${provider} is open; run ${run} still routes to the old conversation. Its workers' reports and questions still go there, and the old conversation stays open with it.\n` +
    `To finish, ask ${provider} to run \`orca orchestration run-use --id ${run}\` in its own terminal (it releases any other run that terminal holds), then Retry handover. Never run it from another terminal.`
}

/** A raw host, provider or guard message as the sidebar shows it: a short row label, the full text. */


/**
 * Known messages in plain words with what to do next; anything else keeps its full text as the
 * detail, under `fallback` on the row when it is too long to read there. Display only: it never
 * changes what happened.
 */
export function explainError(raw        , fallback = 'Failed')            {
  const text = raw.trim()
  return knownError(text) ?? { short: text.length <= 24 && !text.includes('\n') ? text : fallback, tone: 'bad', detail: text }
}

function knownError(text        )                   {
  // Orca's terminal list refuses while a new terminal is still being attached to its pane: the agent
  // usually did start. Opening the coordinator again adopts a pending launch instead of launching twice.
  if (/terminal_surface_ownership_unavailable/.test(text)) return {
    short: 'Still starting', tone: 'warn',
    detail: 'Orca was still attaching a new terminal when Orca Flow checked it, so this step could not be confirmed. An agent that already started keeps running.\nTry again in a few seconds: opening the coordinator adopts a conversation that already started instead of launching another, and Retry handover reuses its launch.\n(Orca: terminal_surface_ownership_unavailable)'
  }
  // Codex keeps its state in one SQLite file; a second Codex process migrating or holding it locks out the resume.
  if (/database is locked/i.test(text) && /codex|state_\d+\.sqlite/i.test(text)) {
    const db = text.match(/(\/[^\s:]*?\.codex\/state_\d+\.sqlite)/)?.[1]?.replace(/^\/Users\/[^/]+/, '~') ?? '~/.codex/state_*.sqlite'
    const migration = text.match(/migration (\d+)/)?.[1]
    return {
      short: 'Codex database locked', tone: 'bad',
      detail: `Codex could not open its local database (${db}${migration ? `, migration ${migration}` : ''}): another Codex process is using it. Nothing was resumed and the conversation is kept.\nClose or restart the other Codex session (or wait until it has finished starting), then Retry.`
    }
  }
  const owned = text.match(/^Handover is unavailable while this coordinator owns (a run|(\d+) runs)/)
  if (owned) return { short: 'Handover blocked', tone: 'warn', detail: ownershipRefusal(owned[2] ? Number(owned[2]) : 1) }
  if (text.startsWith(OWNERSHIP_REFUSAL)) return { short: 'Handover blocked', tone: 'warn', detail: text }
  // The target is current but its run-use was not seen (handover.ts adopt): honest, with Retry.
  if (/^(Claude|Codex) is open; run \S+ still routes to the old conversation/.test(text)) return { short: / while (Claude|Codex) takes it over/.test(text) ? 'Moving run…' : 'Run not moved', tone: 'warn', detail: text }
  // An attempt whose first-turn window passed (handover.ts settleExpired): set aside, or kept with what to close.
  if (/ran out of time before it finished, so it can never complete/.test(text)) return { short: /set aside as/.test(text) ? 'Handover set aside' : 'Handover expired', tone: 'warn', detail: text }
  if (/^The handover bootstrap window expired|predates the first-turn bootstrap barrier/.test(text)) return {
    short: 'Handover expired', tone: 'warn',
    detail: 'This handover ran out of time before it finished (its two-minute start window passed, for example across a restart or power loss), so it can never complete. Nothing more will be transferred and the current selection is kept.\nRetry handover to clear it: Retry sets it aside when its new conversation is closed, or names the terminal to close first.'
  }
  return null
}

/** A failed row status from a raw reason: a short label that fits, the full readable reason behind it. */
export function failedStatus(raw        , fallback = 'Failed')            {
  const v = explainError(raw, fallback)
  return { text: v.short, tone: v.tone, detail: v.detail }
}

/**
 * What the panel shows for a coordinator click (wakeView), with known reasons in plain words: a start
 * Orca could not confirm yet is "Still starting" with Retry, not a red failure.
 */
export function wakeDisplay(r             )                                                   {
  const { row, menu } = wakeView(r)
  if (!menu?.reason) return { row, menu }
  const known = knownError(menu.reason.trim())
  const detail = known?.detail ?? menu.reason
  const next = { ...menu, reason: detail, ...(known?.tone === 'warn' ? { header: known.short, retry: true } : {}) }
  if (!row || row.tone !== 'bad') return { row, menu: next }
  return { row: known ? { text: known.short, tone: known.tone, detail } : { ...row, detail }, menu: next }
}

/**
 * The Sessions menu a coordinator click opens when it needs the person: a short header, the full
 * `reason` under it, Retry (`retry`), Show terminal when the attempt left one open (`terminal`), the
 * open conversations to pick from (`sessions`), then Start new conversation of `agent`'s provider.
 */


/**
 * What a coordinator click's outcome shows: a short row status, and the Sessions menu with the full
 * reason when the person has a choice to make. Never buttons or raw reasons on the row; a coordinator
 * whose restore failed stays a neutral Sleeping row.
 */
export function wakeView(r             )                                                   {
  if (r.kind === 'provider') return { row: null, menu: null } // The first-start provider picker is separate from session history.
  const extra = { ...(r.error ? { reason: r.error } : {}), ...(r.agent ? { agent: r.agent } : {}), ...(r.terminal && r.workspaceId ? { terminal: { workspaceId: r.workspaceId, terminal: r.terminal } } : {}) }
  if (r.ok) return { row: { text: r.kind === 'resumed' ? 'Resumed' : r.kind === 'started' ? 'Started' : r.kind === 'starting' ? 'Starting' : 'Open', tone: 'ok' }, menu: null }
  if (r.kind === 'busy') return { row: { text: 'Opening…', tone: 'pending' }, menu: null }
  if (r.kind === 'choose') return { row: null, menu: { header: 'Pick the main conversation', sessions: true, retry: false, ...extra } }
  if (r.kind === 'restore-failed') return { row: null, menu: { header: "Couldn't restore the last conversation", sessions: false, retry: r.retryable === true, ...extra } }
  return { row: { text: "Couldn't open", tone: 'bad' }, menu: { header: "Couldn't open the coordinator", sessions: false, retry: r.retryable === true, ...extra } }
}

/** A row's inline status, shown where its time or count normally sits; null when it has none. */
function rowStatus(ui         , key        , own = false)                {
  const st = ui.status.get(key)
  if (!st) return null
  if (st.tone === 'pending') return busy(st.text)
  if (st.tone === 'ok') return `<span class="rstatus ok">${esc(st.text)}</span>`
  // A failure never puts a clipped sentence on a row. `own`: the status sits in no other control (a
  // coordinator's row), so it is a compact icon button of its own: hover and keyboard focus show the
  // label and full reason as its tooltip, its accessible name carries both, and a click opens the
  // reason with the ways on. Inside a row button it stays a short label whose reason joins that
  // button's name and shows on hover.
  const detail = st.detail ?? st.text
  const full = detail === st.text ? st.text : `${st.text}\n${detail}`
  const tone = `data-tone="${st.tone === 'bad' ? 'danger' : 'warn'}" data-tip="${esc(full)}"`
  if (own) return `<button class="rstatus ${st.tone} status-icon" data-status="${esc(key)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(full.replace('\n', ': '))}" ${tone}>${STATUS_ICON[st.tone]}</button>`
  return `<span class="rstatus ${st.tone}" ${tone}>${esc(st.text)}${detail === st.text ? '' : `<span class="sr-only">: ${esc(detail)}</span>`}</span>`
}

/** A failed row's mark: a circled exclamation; a stopped one (refused, not confirmed yet): a triangle. */
const STATUS_ICON = {
  bad: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v3.75"/><circle cx="8" cy="11.1" r=".55" fill="currentColor" stroke="none"/></svg>',
  warn: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M8 2.25 14.25 13.25H1.75Z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.35" r=".55" fill="currentColor" stroke="none"/></svg>'
}



/** An action that asks "Yes · No" in place (unless `ask` is false), then shows its result. */
function action(key        , label        , question        , ui         , o          = {})         {
  if (ui.pending === key) return busy(key.startsWith('remove:') ? 'Removing…' : 'Sleeping…')
  if (ui.notice?.key === key) return `<span class="rstatus ${ui.notice.ok ? 'ok' : 'bad'}">${esc(ui.notice.text)}</span>`
  if (ui.confirming === key) return `<span class="confirm"><span class="q">${esc(question)}</span> <button class="yes" data-yes="${esc(key)}">Yes</button> <button class="no" data-no>No</button></span>`
  const attrs = `${o.ask === false ? 'data-yes' : 'data-act'}="${esc(key)}"${o.tip ? ` data-tip="${esc(o.tip)}"` : ''}${o.aria ? ` aria-label="${esc(o.aria)}"` : ''}`
  return `<button class="act${o.cls ? ` ${o.cls}` : ''}" ${attrs}>${o.icon ?? ''}${esc(label)}</button>`
}

/** While Orca's memory report runs the first time: three characters hop in turn over a quiet line. */
export function crew(text        )         {
  const faces = [character(PALETTE[0], 'solo', 'done', 18, false), character(PALETTE[1], 'lead', 'done', 18, false), character(PALETTE[2], 'worker', 'done', 18, false)]
  return `<div class="loader" aria-busy="true" aria-label="${esc(text)}"><div class="crew">${faces.map((c) => `<span class="hop">${c}</span>`).join('')}</div><span class="shimmer-text">${esc(text)}</span></div>`
}

/** While Orca's memory report runs the first time. */
function loader()         {
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


/** Text width in the panel's font, per character as measured in SF at the weights tiles use, rounded up. */
export function textWidth(s        , px        )         {
  let em = 0
  for (const ch of s) {
    em += /[0-9+]/.test(ch) ? 0.67 : /[.,:·]/.test(ch) ? 0.34 : ch === ' ' ? 0.27 : ch === '-' ? 0.48
      : /[MW]/.test(ch) ? 0.92 : /[A-Z]/.test(ch) ? 0.76 : /[mw]/.test(ch) ? 0.9 : /[ijl|!']/.test(ch) ? 0.28 : /[frt()]/.test(ch) ? 0.44 : 0.62
  }
  return em * px + 1
}

/** A tile's label: its size in one of three type sizes, its character beside or above, its name below or after. */

/** Type sizes with the padding around them (panel.css .tile, .fit-sm, .fit-xs). */
const TYPE = { md: { px: 12, line: 16, side: 6, pad: 11 }, sm: { px: 10.5, line: 13, side: 4, pad: 3 }, xs: { px: 9.5, line: 12, side: 3, pad: 3 } }

/**
 * How a tile w×h px (its 2 px surface gap included) labels itself. The size is never cut: the name
 * gives way first (shown whole, or at least its first 12 characters, never a stub), then the
 * character, then the type gets smaller; a tile with no room for its size shows nothing. `room`
 * says whether a 20 px button still fits above the label.
 */
export function fitLabel(w        , h        , value        , name        , avatar         )      {
  const AV = 16, NAME = 13
  const options                                                              = []
  for (const kind of ['md', 'sm', 'xs']         ) {
    const t = TYPE[kind], v = textWidth(value, t.px)
    const add = (av               , nm             , width        , height        ) => options.push({ fit: { value: kind, avatar: av, name: nm }, width, height: height + t.pad })
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
    const cw = w - 2 - 2 * TYPE[o.fit.value ].side, spare = h - 2 - o.height
    if (spare < 0 || o.width > cw) continue
    if (o.fit.name === 'below' && textWidth(name, 10.5) > cw && textWidth(`${name.slice(0, 12)}…`, 10.5) > cw) continue
    return { ...o.fit, room: o.fit.value === 'md' && spare >= 29 && cw >= 24 }
  }
  return { value: null, avatar: null, name: null, room: false }
}

/** What uses memory: a session with what it started, or what a sleeping agent left running. */



const hashOf = (s        ) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0)

/**
 * Stable chart colors. A consumer keeps its slot while it is among the colored ones, gets it back when
 * it returns if the slot is free, and a new one starts from a slot picked by its key. `memo` lives in
 * the UI state, so colors never jump when the order changes between refreshes.
 */
export function colorSlots(keys          , memo                     , n = SERIES)                      {
  const out = new Map                ()
  const taken = new Set        ()
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
export function squarify(values          , box     )        {
  const total = values.reduce((a, v) => a + v, 0)
  if (total <= 0) return values.map(() => ({ ...box, w: 0, h: 0 }))
  const scale = (box.w * box.h) / total
  const worst = (row          , side        ) => {
    const s = row.reduce((a, v) => a + v, 0) * scale
    return Math.max(...row.map((v) => Math.max((side * side * v * scale) / (s * s), (s * s) / (side * side * v * scale))))
  }
  const out        = []
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
const place = (b     ) => {
  const pct = (v        , of        ) => Math.round((v / of) * 10000) / 100
  return `left:calc(${pct(b.x, TM.w)}% + 1px);top:calc(${pct(b.y, TM.h)}% + 1px);width:calc(${pct(b.w, TM.w)}% - 2px);height:calc(${pct(b.h, TM.h)}% - 2px)`
}

/**
 * All of RAM as tiles: each consumer sized by its memory, the ones too small to label folded into one
 * sliver, everything else, and free. Says what each consumer's tile shows (its name, its size, its
 * sleep button) and which color it wears; its legend pill carries whatever the tile cannot.
 */
function treemap(cs            , ram                                     , ui         )                                                                                               {
  const totalMb = ram.totalGB * 1024
  const usedMb = Math.min(ram.usedGB * 1024, totalMb)
  const usedW = totalMb > 0 ? (TM.w * usedMb) / totalMb : 0
  // Footprints can count swapped memory, so together they may exceed what RAM reports as used.
  const allMb = cs.reduce((n, c) => n + c.mb, 0)
  const scale = allMb > usedMb ? usedMb / allMb : 1
  const restMb = Math.max(0, usedMb - allMb * scale)

  // The parts largest first, as squarify wants them. A sliver is drawn at least 2% of what is used, so
  // it stays visible; the rest gives that room.
  const layout = (own            , folded            ) => {
    const foldedMb = folded.reduce((n, c) => n + c.mb, 0) * scale
    const sliver = folded.length ? Math.max(foldedMb, usedMb * 0.02) : 0
    const rest = Math.max(0, restMb - (sliver - foldedMb))
    const parts         = [...own.map((c) => ({ kind: 'own'         , c, mb: c.mb * scale })), ...(folded.length ? [{ kind: 'sliver'         , mb: sliver }] : []), ...(rest >= 1 ? [{ kind: 'rest'         , mb: rest }] : [])]
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
  const shows = new Map               ()
  const label = (fit     , value        , name        , ch = '') => {
    if (!fit.value) return ''
    const v = `<span class="t-v">${value}</span>`
    if (fit.name === 'inline') return `<span class="t-line">${v}<span class="t-n">· ${esc(name)}</span></span>`
    const n = fit.name === 'below' ? `<span class="t-n">${esc(name)}</span>` : ''
    return fit.avatar === 'row' ? `<span class="t-row">${ch}${v}</span>${n}` : fit.avatar === 'stack' ? `<span class="t-av">${ch}</span>${v}${n}` : `${v}${n}`
  }
  const fitClass = (fit     ) => (fit.value === 'md' ? '' : fit.value ? ` fit-${fit.value}` : ' bare')
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
function swapChip(swap                                     )         {
  const r = 5.25, c = 2 * Math.PI * r
  const warn = swap.usedGB / swap.totalGB >= 0.85
  const arc = Math.min(1, swap.usedGB / swap.totalGB) * c
  return `<span class="chip${warn ? ' warn' : ''}" data-tip="Swap: ${swap.usedGB} of ${swap.totalGB} GB used"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="${r}" class="g-track"/><circle cx="7" cy="7" r="${r}" class="g-arc" stroke-dasharray="${arc.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 7 7)"/></svg>Swap ${swap.usedGB} / ${swap.totalGB} GB</span>`
}

/** Overlapping characters, at most `max`, then how many more. */
function avatarStack(placed          , all             , max = 6)         {
  const faces = placed.slice(0, max).map((p) => `<span class="sav">${character(colorOf(p.row.repo), shapeOf(p.a, all), faceOf(p.a), 14, false)}</span>`).join('')
  return `<span class="stack">${faces}${placed.length > max ? `<span class="sav more">+${placed.length - max}</span>` : ''}</span>`
}

function cockpitOpen(snap          , ui         )         {
  if (!ui.stats && ui.notice?.key === 'load') return `<div class="copen"><div class="empty">Could not check what’s running: ${esc(ui.notice.text)}</div></div><div class="hair"></div>`
  if (!ui.stats) return loader()
  const st = ui.stats
  const placedAll = snap.rows.flatMap((row) => row.agents.map((a) => ({ a, row })))
  const all = placedAll.map((p) => p.a)
  const placed = (pane        ) => placedAll.find((p) => p.a.paneKey === pane)
  // What a session started outside itself (a dev server) counts toward it; Orca does not count it.
  const startedName = (g              ) => (g.count > 1 ? `${g.name} +${g.count - 1}` : g.name)
  const started = st.started ?? []
  const live = new Set(all.map((a) => a.paneKey))
  const consumers             = [
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
  const doing = (['asks', 'working', 'monitoring']         ).map((face) => {
    // A slept folder lead does nothing, whatever its last state said.
    const these = placedAll.filter((p) => !asleep(p.row) && faceOf(p.a) === face)
    const word = { asks: 'asking', working: 'working', monitoring: 'monitoring' }[face]
    return these.length ? `<span class="tally${face === 'asks' ? ' ask' : ''}">${avatarStack(these, all, 4)}<span><b>${these.length}</b> ${word}</span></span>` : ''
  }).join('')
  // Sleeping every finished session is offered only when memory is tight; otherwise they cost nothing
  // you need, and each one sleeps from its own menu. The same set "Sleep all" puts to sleep.
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

function cockpit(snap          , ui         )         {
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
const approvalAccess = (s                                                      ) => { const a = approvalSummary(s).access; return a ? `: ${a}` : '' }
export function updateButton(state                         )         {
  if (!state || state.kind === 'none') return ''
  const v = state.version
  const button = (cls        , tip        , inner        , tone = '') =>
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
      return button('approval', `Orca Flow ${v} needs your approval${approvalAccess(state)}. Click for details.`, UPDATE_ICON.warning, 'warn')
    case 'failed':
      return button('failed', `Update to ${v} failed: ${state.reason}\nClick to try again`, UPDATE_ICON.error, 'danger')
  }
}

// ---------- up next ----------

/**
 * Everything asking you, most urgent first: the worktrees whose agents ask, plus a row for each
 * coordinator whose own session asks (coordinators live outside the worktree rows). The tree's
 * badges, Up next, the status bar and jump-to-next all read this one list. A slept folder lead
 * (asleep) is in none of them, whatever ask its last summary or state claimed: like the tree, they
 * leave it out.
 */
export function askingRows(snap          )                 {
  const own = snap.coordinators.flatMap((c) => {
    // A member is answerable only while its chat is open (agent present): the current one wakes the
    // coordinator when it is closed (asleep), and a still-open other one is jumped to. A closed
    // non-current member's ask is past history and never queues (its history stays in Sessions).
    const sources = c.members ? c.members.flatMap((m) => m.agent || m.id === c.sessions?.current ? [{ a: m.agent ?? m.lastAgent, id: m.id, workspaceId: m.workspaceId, asleep: !m.agent }] : []) : c.session ? [{ a: c.session, id: undefined, workspaceId: c.workspaceId, asleep: false }] : []
    return sources.filter((m) => m.a && asksYou(m.a)).map((m)               => ({
      id: m.workspaceId ?? `coordinator:${c.key}`, name: c.name, branch: null, repo: c.repos.length === 1 ? c.repos[0] : c.name, path: null,
      main: true, agents: [m.a ], state: m.a .state, priority: m.a .summary?.priority ?? null, card: null, parentId: null,
      liveTerminals: m.asleep ? 0 : 1, pinned: false, unread: false, active: !m.asleep && m.id === c.sessions?.current && Boolean(c.active), workspaceStatus: null,
      lastActivityAt: m.a .summary?.updatedAt ?? null, createdAt: 0, pr: null, coordinator: c.key, queueKey: askKey({ id: m.workspaceId ?? `coordinator:${c.key}` }                , m.a ), coordinatorMember: m.id
    }))
  })
  return waitingQueue([...localRows(snap.rows).filter((r) => !asleep(r)), ...own, ...botChatRows(snap)])
}

/** What the queue reads: the rows, the coordinators and, when known, the bots. */


/**
 * A bot chat needs you only while Orca says its turn is stopped on you: a permission prompt
 * (blocked) or its pending question tool (waiting). A bot whose turn ended is idle, waiting for its
 * next message or run, even when its last reply ends in a question: nothing to do there.
 */
export const botNeedsYou = (a           ) => a.state === 'blocked' || a.state === 'waiting'

/** The summarizer's ask never counts for a bot chat (see botNeedsYou): only Orca's own state does. */
const withoutSummaryAsk = (a           )            =>
  a.summary ? { ...a, summary: { ...a.summary, needs: { type: 'none', ask: '', options: [] }, glance: undefined, reply: undefined, status: undefined } } : a

/**
 * A row for each bot chat that needs you (botNeedsYou), standing for that chat in the queue: named
 * after the bot, opening the chat's workspace. Bot workspaces are not among the ordinary rows (the
 * Bots section shows them), so this is how such a chat reaches Up next, the status bar and jump-to-next.
 */
export function botChatRows(snap                                 )                 {
  return (snap.bots ?? []).flatMap((b) => b.chats.filter((c) => botNeedsYou(c.agent)).map(({ agent, workspaceId })               => {
    const a = withoutSummaryAsk(agent)
    return {
      id: workspaceId, name: b.name, branch: null, repo: 'Bots', path: null, main: false, agents: [a], state: a.state,
      priority: a.summary?.priority ?? null, card: null, parentId: null, liveTerminals: a.live === false ? 0 : 1, pinned: false, unread: false,
      active: false, workspaceStatus: null, lastActivityAt: a.summary?.updatedAt ?? null, createdAt: 0, pr: null, bot: b.name,
      queueKey: askKey({ id: workspaceId }                , a)
    }
  }))
}

/**
 * Up next's order: every ask that stops work, most urgent first, then the asks needed only later
 * (laterAsk), from finished turns and from working agents alike.
 */
export function upNextOrder(snap          )           {
  const queued = askingRows(snap).flatMap((row) => row.agents.filter(asksYou).map((a) => ({ a, row })))
  const working = localRows(snap.rows).filter((r) => !asleep(r)).sort(byUrgency).flatMap((row) => row.agents.filter((a) => a.state === 'working' && laterAsk(a)).map((a) => ({ a, row })))
  const later = [...queued.filter((p) => laterAsk(p.a)), ...working].sort((x, y) => byUrgency(x.row, y.row))
  return [...queued.filter((p) => !laterAsk(p.a)), ...later]
}

function upNext(placed          , all             , coordinators               , ui         , bots        = [])         {
  if (placed.length === 0) return ''
  const items = placed.map((p, i) => {
    const key = askKey(p.row, p.a)
    const open = (i === 0 && !ui.closed.has(key)) || ui.opened.has(key)
    // A bot's chat wears the bot's avatar, its name and its group; it opens the chat's workspace.
    const bot = p.row.bot ? bots.find((b) => b.name === p.row.bot) : undefined
    if (bot) {
      const kind = askKindOf(p.a)
      const head = `<button class="item" data-brief="${esc(key)}" aria-expanded="${open}">${tipped(botCharacter(bot, 'asks', kind), ASK_TIP[kind], ASK_TONE[kind])}<span class="t${open ? ' strong' : ''}">${esc(bot.name)}</span><span class="r">${esc(botGroupName(bot, coordinators))}${p.row.priority ? ` · ${p.row.priority}` : ''}</span></button>`
      if (!open) return head
      const about = aboutOf(p)
      return `${head}<div class="brief">${about ? `<div class="about">${esc(about)}</div>` : ''}<div class="glance"><span class="kicker">${esc(needsLabel(p))}</span><span>${esc(glanceOf(p))}</span>${replyOf(p) ? `<span class="reply">Reply: ${esc(replyOf(p))}</span>` : ''}</div><div class="jumps"><button class="jump" ${openAttrs(p)}>Jump to session</button></div></div>`
    }
    // A coordinator's own ask wears its character and opens like its row in the tree.
    const c = p.row.coordinator ? coordinators.find((x) => x.key === p.row.coordinator) : undefined
    const who = c
      ? tipped(character(c.look?.color ?? (c.repos.length === 1 ? colorOf(c.repos[0]) : NEUTRAL), c.look?.shape ?? 'pentagon', 'asks', 20, true, askKindOf(p.a)), ASK_TIP[askKindOf(p.a)], ASK_TONE[askKindOf(p.a)])
      : agentCharacter(p.a, p.row, all)
    const menu = c ? `coordinator:${c.key}` : `agent:${p.a.paneKey}`
    const where = c ? !p.row.coordinatorMember ? 'coordinator' : `${p.a.agentType ?? 'Unknown provider'} · ${p.row.coordinatorMember === c.sessions?.current ? 'current session' : 'other session'}` : coordinatorName(p.a.coordinator, coordinators)
    const head = `<button class="item" data-brief="${esc(key)}" data-menu="${esc(menu)}" aria-expanded="${open}">${who}<span class="t${open ? ' strong' : ''}">${esc(c ? c.name : nameOf(p.a, p.row))}</span><span class="r">${rowStatus(ui, menu) ?? `${esc(where)}${p.row.priority ? ` · ${p.row.priority}` : ''}`}</span></button>`
    if (!open) return head
    const about = aboutOf(p)
    return `${head}<div class="brief">${about ? `<div class="about">${esc(about)}</div>` : ''}<div class="glance"><span class="kicker">${esc(needsLabel(p))}</span><span>${esc(glanceOf(p))}</span>${replyOf(p) ? `<span class="reply">Reply: ${esc(replyOf(p))}</span>` : ''}</div><div class="jumps"><button class="jump" ${openAttrs(p)}>Jump to session</button>${reviewPr(p)}</div></div>`
  })
  return `<section class="upnext"><div class="label">Up next · ${placed.length}</div><div class="group">${items.join('')}</div></section>`
}

// ---------- your coordinators ----------

/**
 * The worktree's PR as its number, colored the way Orca's own workspace card colors it: an open PR
 * by its checks (failed red, pending yellow, passed green), anything else by its state (merged
 * purple, closed and draft grey). The tooltip says the state and the title; a click opens the PR.
 */
export function prBadge(pr                    )         {
  if (!pr) return ''
  const state = pr.state === 'merged' || pr.state === 'closed' || pr.state === 'draft' ? pr.state : 'open'
  const tone = state === 'open' ? { failure: 'fail', pending: 'pending', success: 'ok', cancelled: 'closed' }[pr.checks ?? 'success'] ?? 'ok' : state
  const word = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : state === 'draft' ? 'draft' : pr.checks === 'failure' ? 'checks failed' : pr.checks === 'pending' ? 'checks pending' : 'open'
  const tip = `PR #${pr.number} ${word}${pr.title ? `\n${pr.title}` : ''}`
  return `<span class="pr pr-${tone}" role="link" data-pr="${esc(pr.url)}" data-tip="${esc(tip)}" aria-label="${esc(`PR #${pr.number} ${word}`)}">#${pr.number}</span>`
}

/**
 * How many branch colors there are (panel.css --c0..--c2). Any two branches can sit in neighboring
 * lanes, so the palette was validated all-pairs (the dataviz validator, both modes): three is the
 * most that pass.
 */
export const BRANCH_COLORS = 3
/** A branch's color slot: stable for the same repo and branch, so rows on one branch share it. */
export const branchColor = (repo        , branch        ) => hashOf(`${repo}\n${branch}`) % BRANCH_COLORS

/** A long-lived branch (a main checkout's main or dev) draws neutral lines, not a color. */
const BASE_BRANCH = /^(main|master|dev|develop|development|trunk|staging)$/

/** The color a row's tree lines wear: its branch's, or none (neutral) without one or on a long-lived one. */
export const laneColor = (row                                       )                =>
  row.branch && !BASE_BRANCH.test(row.branch) ? branchColor(row.repo, row.branch) : null
const branchAttr = (row                                       ) => {
  const c = laneColor(row)
  return c === null ? '' : ` data-branch="${c}"`
}

/** A merged PR's icon, on the cockpit's clean-up cards. */
const MERGED_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>'

/**
 * Whether an agent's row wears the current border: its pane is in front in the focused workspace,
 * so its lead, its workers and other agents in that worktree are not. When Orca told only which
 * workspace is focused (focused is null), the worktree's lead stands for it.
 */
export function isCurrent(a           , row              , focused                             )          {
  if (!row.active) return false
  if (focused) return focused.includes(a.paneKey)
  return worktreeLead(row)?.paneKey === a.paneKey
}

/** The agent no other agent in its worktree dispatched (rank.ts; goals-view.ts uses it too). */
export { worktreeLead }

/** A coordinator's row is current when its own session's tab is in front (or, focus known only by workspace, its folder is focused). */
const coordinatorCurrent = (c             , focused                             ) =>
  Boolean(c.active) && (focused ? !!c.session && focused.includes(c.session.paneKey) : true)

/**
 * What a chat's node in the tree says (src/lines.ts): asking, working, monitoring, done while its
 * work is still in flight, or finished.
 */
export function nodeOf(a           , row              , all             )            {
  if (asleep(row)) return 'sleeping'
  const face = faceOf(a)
  return face === 'asks' ? 'asking' : face === 'working' ? 'working' : face === 'monitoring' ? 'monitoring' : inFlight(a, row, all) ? 'done' : 'finished'
}

/**
 * A working (or monitoring) chat's ring carries a shimmer that travels around it, in place of the
 * character's spinning badge (panel.css .beam, still under prefers-reduced-motion).
 */
const beam = (node           ) => (BEAMS.includes(node) ? `<i class="beam b-${node}" aria-hidden="true"></i>` : '')

/** The focused row's mark: a slim bar on its left edge, in its branch's color (panel.css .fb). */
const FOCUS = '<i class="fb" aria-hidden="true"></i>'

function agentLine(p        , all             , coordinators               , soft         , lead                    , ui         , done = false, current = false, deco = '', mixed = false, depth = lead ? 1 : 0)         {
  const status = rowStatus(ui, `agent:${p.a.paneKey}`)
  const indent = Boolean(lead)
  // The worktree's Linear issue, on the right of the row that stands for the worktree.
  const own = !lead || lead.row.id !== p.row.id
  const chip = p.row.linearIssue && own ? idChip(p.row.linearIssue, p.row.linearLink) : ''
  // The title gets the room: on the right only the Linear issue, the PR's number, the project and
  // the age. A worker nested under its lead in the same worktree shows none of them (its lead's row
  // does; the branch's color on the lines groups them); one in a worktree of its own shows that
  // worktree's issue and PR.
  const right = status ?? (asleep(p.row) ? '<span class="rstatus sleeping">Asleep</span>' : reloadMark(ui, p.a.paneKey) + (lead
    ? `${own ? `${chip}${prBadge(p.row.pr)}` : ''}`
    : `${chip}${prBadge(p.row.pr)}${soft ? `<span class="soft">${esc(p.row.repo)}</span>` : ''}<span class="age">${ago(p.row.lastActivityAt, ui.now)}</span>`))
  const cls = `item${indent ? ' indent' : ''}${done ? ' finished' : ''}${current ? ' current' : ''}`
  // A row on a feature branch draws its connector and ring in the branch's color (panel.css, tree lines).
  const menu = `data-menu="agent:${esc(p.a.paneKey)}"${current ? ' aria-current="true"' : ''}${branchAttr(p.row)} data-node="${nodeOf(p.a, p.row, all)}" data-depth="${depth}" style="--node-x:${nodeX(depth)}px"`
  // Its lines and focus bar; its character leaves out the spinning badge, the ring's shimmer shows it working.
  const lines = `${deco}${current ? FOCUS : ''}`
  // A lead that reported worker_done leaves its worktree ready for cleanup: offer remove on the row.
  // A button cannot hold a button, so this row is a div whose name opens the session.
  if (removable(p, all) && !status) {
    return `<div class="${cls}" ${menu}>${lines}${agentCharacter(p.a, p.row, all, 20, false)}${modelBadge(p.a, mixed)}<span class="t" ${openAttrs(p)} role="button" tabindex="0">${esc(nameOf(p.a, p.row))}</span><span class="r">${right}</span><button class="act" data-remove="${esc(p.row.id)}" data-target="agent:${esc(p.a.paneKey)}">remove</button></div>`
  }
  return `<button class="${cls}" ${openAttrs(p)} ${menu}>${lines}${agentCharacter(p.a, p.row, all, 20, false)}${modelBadge(p.a, mixed)}<span class="t">${esc(nameOf(p.a, p.row))}</span><span class="r">${right}</span></button>`
}

/**
 * A lead whose dispatch settled (worker_done, failed or abandoned), or whose worktree's PR merged
 * (nothing wakes a lead to report worker_done then), with nothing of its own still running: its
 * worktree can go. The remove flow still refuses a dirty checkout or an unmerged PR.
 */
export const removable = ({ a, row }        , all             ) =>
  !row.host && a.summary?.role === 'lead' && (a.dispatch === 'settled' || row.pr?.state === 'merged') &&
  canRemove(row) && faceOf(a) === 'done' && !leadsOpenWork(a, all)

/** A review of a worktree with an open PR: the PR is what to look at, one click away. */
const reviewPr = ({ a, row }        ) =>
  askKindOf(a) === 'review' && row.pr && (row.pr.state === 'open' || row.pr.state === 'draft') ? `<button class="jump" data-pr="${esc(row.pr.url)}">Open PR</button>` : ''

/** No saved conversation id: why an Asleep row cannot be clicked (resumeIdOf in worker.ts). */
export const NO_RESUME_ID = 'Asleep: no saved conversation id was recorded for it, so it cannot be resumed'

/**
 * What a click on an agent opens: its workspace and, when its terminal is known, its own tab. An
 * Asleep row resumes its exact conversation, or is disabled with the reason when no id is verified.
 * A coordinator's own ask, or its current session's ask once that chat is closed, opens the
 * coordinator as its tree row does (waking it).
 */
const openAttrs = (p        ) =>
  p.row.host ? `disabled data-tip="${esc(remoteTip(p.row))}"`
  : asleep(p.row) ? (p.row.resumeId ? `data-resume="${esc(p.a.paneKey)}" data-workspace="${esc(p.row.id)}" data-tip="Asleep: click to resume this conversation"` : `disabled data-tip="${esc(NO_RESUME_ID)}"`)
  : p.row.coordinator && p.row.coordinatorMember && p.row.liveTerminals === 0 ? `data-coordinator="${esc(p.row.coordinator)}"`
  : !p.a.terminal && (p.row.coordinatorMember || p.row.folderOf) ? 'disabled data-tip="Exact session unavailable"' : p.row.coordinator && !p.row.coordinatorMember ? `data-coordinator="${esc(p.row.coordinator)}"` : `data-open="${esc(p.row.id)}"${p.a.terminal ? ` data-terminal="${esc(p.a.terminal)}"` : ''}`

/** Finished sessions that still hold a terminal: what the cockpit counts. */
const leadsOpenWork = (a           , all             ) => all.some((b) => b.leadPane === a.paneKey && faceOf(b) !== 'done')

/**
 * A done agent that still has work in flight is available, not finished: it is a lead that has not
 * reported worker_done and whose PR has not merged, it leads agents that are still open, or it owns its worktree's open (or draft) PR, which is steered over several rounds
 * until it merges. The owner is the agent no one else in that worktree dispatched (a lead, or a chat
 * you started); its own workers are tasks and finish as usual.
 */
function inFlight(a           , row              , all             )          {
  if (holdsWorkstream(a, row.pr) || leadsOpenWork(a, all)) return true
  const prOpen = row.pr?.state === 'open' || row.pr?.state === 'draft'
  const worker = a.leadPane !== null && row.agents.some((b) => b.paneKey === a.leadPane)
  return prOpen && !worker
}

/** Finished sessions that still hold a terminal: what "Sleep all" puts to sleep. */
export function finishedAgents(rows                )              {
  rows = localRows(rows)
  const all = rows.flatMap((r) => r.agents)
  return rows.filter((r) => r.liveTerminals > 0 && !asleep(r)).flatMap((r) => r.agents.filter((a) => faceOf(a) === 'done' && !inFlight(a, r, all)))
}
const finishedOf = (placed          ) => {
  const all = placed.map((p) => p.a)
  return placed.filter((p) => !p.row.host && faceOf(p.a) === 'done' && p.row.liveTerminals > 0 && !asleep(p.row) && !inFlight(p.a, p.row, all))
}

/** Rows keep the order their workstreams started in; agent activity never moves them. */
const byStart = (x        , y        ) => x.row.createdAt - y.row.createdAt || x.a.paneKey.localeCompare(y.a.paneKey)

/** A coordinator's color: its look's, else its one project's, else neutral. */
const coordinatorColor = (c             ) => c.look?.color ?? (c.repos.length === 1 ? colorOf(c.repos[0]) : NEUTRAL)

/** The activity to display across open panes, in the same priority order as the You group. */
function activityAgent(panes             )                        {
  return panes.find(asksYou) ?? panes.find((a) => faceOf(a) === 'working') ?? panes.find(monitoring) ?? panes[0]
}

function coordinatorActivity(c             ) {
  return c.session ?? activityAgent(c.sessionPanes ?? [])
}

/** A coordinator's character in its own state, for menus and the Linear section. */
export function coordinatorCharacter(c             , size = 16, face       )         {
  const activity = coordinatorActivity(c)
  return character(coordinatorColor(c), c.look?.shape ?? 'pentagon', face ?? (activity ? faceOf(activity) : 'idle'), size, true, activity ? askKindOf(activity) : 'question')
}

function coordinatorBlock({ c, mine, lines, auxiliary }           , all             , snap          , ui         , mixed         )         {
  const { coordinators, focusedPanes: focused } = snap
  const single = c.repos.length === 1 ? c.repos[0] : null
  const color = coordinatorColor(c)
  const shape        = c.you ? 'solo' : (c.look?.shape ?? 'pentagon')
  const runs = auxiliary?.runs ?? c.split?.mainRuns
  const runNames = runs?.map(r => r.objective).join(' · ')
  const sub = runNames ? (auxiliary ? runNames : 'Main · ' + runNames) : single ?? (c.you ? 'chats you started' : c.repos.length ? c.repos.join(', ') : 'all projects')
  // A coordinator shows its own state only; its workers show theirs below it. You has no session of
  // its own, so it shows the busiest of your chats.
  const activity = c.you ? activityAgent(mine.map((p) => p.a)) : auxiliary?.p.a ?? coordinatorActivity(c)
  const face       = activity ? faceOf(activity) : c.you ? 'done' : 'idle'
  const ask = activity ? askKindOf(activity) : 'question'
  const tip = face === 'idle' ? 'Sleeping' : face === 'asks' ? ASK_TIP[ask] : face === 'done' && !c.you ? 'Available' : STATUS[face]
  const done = (p        ) => asleep(p.row) || (faceOf(p.a) === 'done' && !inFlight(p.a, p.row, all))
  // Each lead (or chat) and the workers under it form a lane: one stretch of the tree's lines, in the
  // lead's branch color, lit together on hover and while one of them is current.
  const trunk = trunkX(face === 'idle')
  const lanes                                               = []
  for (const line of lines) {
    if (line.lead && lanes.length) lanes[lanes.length - 1].rows.push(line)
    else lanes.push({ root: line.p, rows: [line] })
  }
  const body = lanes.map(({ root, rows }) => {
    // The lead wears its PR as a bead on its ring.
    const cap = capGlyph(root.row.pr)
    const html = rows.map(({ p, lead, depth }) => {
      const node = nodeOf(p.a, p.row, all)
      const role = { nested: Boolean(lead), depth, trunk, node, ask: faceOf(p.a) === 'asks' ? askKindOf(p.a) : undefined, cap: lead ? null : cap }
      const deco = `${treeRails(lines, lines.findIndex((line) => line.p === p), trunk)}${rowLines(role)}${beam(node)}`
      return agentLine(p, all, coordinators, !single, lead, ui, done(p), isCurrent(p.a, p.row, focused), deco, mixed, depth)
    }).join('')
    return `<div class="lane"${branchAttr(root.row)}>${html}</div>`
  }).join('')
  const current = auxiliary ? auxiliary.p.row.active && focused?.includes(auxiliary.p.a.paneKey) : !c.you && coordinatorCurrent(c, focused)
  const foldKey = auxiliary ? auxiliaryKey(auxiliary.p) : c.key
  const folded = ui.folded.has(foldKey)
  const node            = face === 'idle' ? 'sleeping' : face === 'asks' ? 'asking' : face === 'done' ? 'done' : face === 'monitoring' ? 'monitoring' : 'working'
  const ringed = !folded && mine.length > 0
  const mark = `${ringed ? headLines(trunk, node, face === 'asks' ? ask : undefined) + beam(node) : ''}${current ? FOCUS : ''}`
  const head = `${tipped(character(color, shape, face, 28, true, ask, !ringed), tip, face === 'asks' ? ASK_TONE[ask] : '')}${providerBadge(c.session, mixed)}<span class="grow"><span class="name">${esc(c.name)}</span><span class="sub">${esc(sub)}</span></span><span class="r">${rowStatus(ui, `coordinator:${c.key}`) ?? ''}</span>`
  const sessionStatus = c.session ? reloadMark(ui, c.session.paneKey) + modelChip(c.session)
    : activity ? `<span class="rstatus">${esc(tip)}</span>`
    : `<span class="rstatus sleeping">${c.sessions?.members.length === 0 ? 'Not started' : 'Sleeping'}</span>`
  // A coordinator's row opens its session; the chevron folds its team. You only folds.
  const fold = mine.length ? `<button class="coord-fold" data-fold="${esc(foldKey)}" aria-expanded="${!folded}" aria-label="Fold ${esc(auxiliary ? 'auxiliary coordinator' : c.name)}">${ICON.chev}</button>` : ''
  const runTip = runs ? ` data-tip="${esc([...(auxiliary ? [auxiliary.p.a.title] : []), ...runs.map(r => r.objective + ' · ' + r.id)].join('\n'))}"` : ''
  const row = auxiliary
    ? `<div class="item coord${current ? ' current' : ''}" data-menu="agent:${esc(auxiliary.p.a.paneKey)}"${current ? ' aria-current="true"' : ''}>${mark}<button class="coord-open" ${openAttrs(auxiliary.p)} aria-label="Open auxiliary coordinator">${tipped(character(color, shape, face, 28, true, ask, !ringed), tip, face === 'asks' ? ASK_TONE[ask] : '')}</button>${providerBadge(auxiliary.p.a, mixed)}<button class="coord-name" ${openAttrs(auxiliary.p)}${runTip}><span class="coord-label"><span class="name">${esc(c.name)} · Auxiliary coordinator</span><span class="sub">${esc(sub)}</span></span></button><span class="r">${modelChip(auxiliary.p.a)}</span>${fold}</div>`
    : c.you
    ? `<button class="item coord" data-fold="${esc(c.key)}" aria-expanded="${!folded}">${mark}${head}</button>`
    : `<div class="item coord${current ? ' current' : ''}" data-menu="coordinator:${esc(c.key)}"${current ? ' aria-current="true"' : ''}>${mark}<button class="coord-open" data-coordinator="${esc(c.key)}" aria-label="Open ${esc(c.name)}">${tipped(character(color, shape, face, 28, true, ask, !ringed), tip, face === 'asks' ? ASK_TONE[ask] : '')}</button>${handoverBadge(c, snap, mixed, ui.status.get(`coordinator:${c.key}`))}<button class="coord-name" data-coordinator="${esc(c.key)}" aria-label="Open ${esc(c.name)}"${runTip}><span class="coord-label"><span class="name">${esc(c.name)}</span><span class="sub">${esc(sub)}</span></span></button><span class="r">${rowStatus(ui, `coordinator:${c.key}`, true) ?? sessionStatus}</span>${fold}</div>`
  return `<section class="coordinator">${row}${folded || !body ? '' : `<div class="group">${body}</div>`}</section>`
}

// ---------- the tree's order, and the Option+1..9 chat shortcuts ----------

/** Compact selector; the coordinator's avatar and current status stay separate. */
function handoverBadge(c             , snap          , mixed         , status            )         {
  const pending = status?.tone === 'pending' && status.text === 'Handing over…'
  const recorded = c.handover && c.handover.phase !== 'complete'
  if (!pending && !recorded && !coordinatorHandover(c, snap.handoverProviders, false).choices.length) return providerBadge(c.session, mixed)
  const member = c.members?.find((m) => m.id === c.sessions?.current)
  const provider = providerOf(member?.agentType ?? c.session?.agentType ?? null)
  const mark = provider ? PROVIDER_LOGOS[provider] : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="13" height="13" rx="3"/><path d="M9 20h9a3 3 0 0 0 3-3V9"/></svg>'
  return `<button class="session-trigger" data-handover="${esc(c.key)}" aria-controls="ctx" aria-label="Handover for ${esc(c.name)}" aria-haspopup="menu" aria-expanded="false" data-tip="${esc(`Handover for ${c.name}`)}"><span class="provider" aria-hidden="true">${mark}</span><span class="session-chevron" aria-hidden="true">${ICON.chev}</span></button>`
}

/** One coordinator (or You) in the tree: its team in start order, each lead followed by its workers. */
const auxiliaryKey = (p        ) => `auxiliary:${p.row.id}:${p.a.orcaSession}`


/** Vertical rails follow actual ancestors and end at their last direct child connector. */
function treeRails(lines                    , index        , trunk        )         {
  const line = lines[index]
  const rail = (x        , kind        , top = '0', bottom = '-1px') => `<i class="tree-rail ${kind}" aria-hidden="true" style="left:${x}px;top:${top};bottom:${bottom}"></i>`
  const end = 'calc(50% - var(--dy) + var(--fork))'
  const laterRoot = lines.slice(index + 1).some((l) => !l.lead)
  let html = laterRoot ? rail(trunk, 'trunk') : !line.lead ? rail(trunk, 'trunk', '0', end) : ''
  if (lines.some((l) => l.lead === line.p)) html += rail(nodeX(line.depth), 'branch', 'calc(50% + var(--dy) + 12px)')
  let parent = line.lead
  const seen = new Set        ()
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const parentLine = lines.find((l) => l.p === parent)
    if (!parentLine) break
    const laterChild = lines.slice(index + 1).some((l) => l.lead === parent)
    if (laterChild || line.lead === parent) html += rail(nodeX(parentLine.depth), 'branch', '0', laterChild ? '-1px' : end)
    parent = parentLine.lead
  }
  return html
}

/**
 * The coordinators tree top to bottom: active coordinators (a session or a team), then You when you
 * have chats, then sleeping ones. Each group keeps a stable order, so nothing moves until a
 * coordinator wakes up or goes to sleep. The tree holds every open session in its place: what runs,
 * done agents with work in flight, and finished ones (dimmed) that still hold a terminal.
 */
function treeBlocks(snap                                         )              {
  const all = snap.rows.flatMap((r) => r.agents)
  const placed           = snap.rows.flatMap((row) => row.agents.map((a) => ({ a, row })))
  // A closed folder conversation (folderRows: live === false) leaves the tree like every sleeping
  // lead, whatever state its last summary claimed, except while agents it leads are still open: it
  // stays drawn asleep at the head of their lane until they finish. Unknown liveness is not asleep.
  const live = placed.filter((p) => asleep(p.row) ? leadsOpenWork(p.a, all) : p.a.live === true || faceOf(p.a) !== 'done' || inFlight(p.a, p.row, all) || p.row.liveTerminals > 0)
  // A current run route can place a worker whose original dispatcher closed or left the recent-run cache.
  const routedTeam = new Map(snap.coordinators.flatMap(c => Object.keys(c.split?.parents ?? {}).map(pane => [pane, c.key]         )))
  const teamOf = (key        ) => live.filter(p => (routedTeam.get(p.a.paneKey) ?? p.a.coordinator) === key)
  // Grouped by the coordinator row's own status: a live selected conversation first, then You,
  // then Sleeping and Not started, however busy their teams
  // are. Each group keeps the snapshot's order, so a refresh never reshuffles rows; a coordinator
  // moves only when it wakes, starts or sleeps. Its whole team moves with it.
  const awake = (c             ) => Boolean(c.session || c.sessionPanes?.length)
  const you                 = { key: 'you', name: 'You', repos: [], workspaceId: null, you: true }
  return [...snap.coordinators.filter(awake), you, ...snap.coordinators.filter((c) => !awake(c))].flatMap((c) => {
    const mine = teamOf(c.key).sort(byStart)
    // You only shows when you have chats; a coordinator always shows, so you can open it.
    if ('you' in c && mine.length === 0) return []
    const panes = new Set(mine.map((p) => p.a.paneKey))
    const parent = (p        ) => c.split?.parents[p.a.paneKey] ?? p.a.leadPane
    const auxiliaries = (c.split?.auxiliary ?? []).flatMap(root => {
      const p = mine.find(p => p.a.paneKey === root.pane)
      return p ? [{ p, runs: root.runs }] : []
    })
    const roots = mine.filter(p => !panes.has(parent(p) ?? ''))
    const children = new Map                  ()
    for (const p of mine) {
      const key = parent(p)
      if (!key) continue
      const siblings = children.get(key) ?? []
      siblings.push(p)
      children.set(key, siblings)
    }
    const seen = new Set        (auxiliaries.map(a => a.p))
    // Walk every descendant, not just a root's immediate children. Keep sibling start order and
    // the actual parent; a continuation row above a lead must not swallow that lead's workers.
    const visit = (root        , lines                    ) => {
      const stack                     = [{ p: root, depth: 0 }]
      while (stack.length) {
        const line = stack.pop()
        if (seen.has(line.p)) continue
        seen.add(line.p)
        lines.push(line)
        for (const p of [...(children.get(line.p.a.paneKey) ?? [])].reverse()) stack.push({ p, lead: line.p, depth: line.depth + 1 })
      }
    }
    const separate = auxiliaries.map(auxiliary => {
      const lines                     = []
      for (const child of children.get(auxiliary.p.a.paneKey) ?? []) visit(child, lines)
      return { c, auxiliary, mine: lines.map(l => l.p), lines }
    })
    const lines                     = []
    for (const p of roots) visit(p, lines)
    // Missing parents become roots above; cycles have none. Still show each pane once, safely.
    for (const p of mine) visit(p, lines)
    return [{ c, mine: lines.map(l => l.p), lines }, ...separate]
  })
}

/** The coordinators in the order the tree shows them (with a live session first, then Sleeping and Not started): the send menu lists them so. */
export function coordinatorOrder(snap                                         )                {
  return treeBlocks(snap).flatMap(({ c, auxiliary }) => (c.you || auxiliary ? [] : [c]))
}

/** How many chats get a shortcut: Option+1 to Option+9. */
export const CHAT_KEYS = 9
/** Where the panel keeps its folded groups (plugin storage), so the worker's numbers skip them too. */
export const FOLDED_KEY = 'folded'

/** What a chat shortcut opens, the way a click on its row does; `key` is the row's data-menu. */


/**
 * The chats Option+1..9 open, in the order the tree shows them: each coordinator with a live
 * session, then its leads with their workers, then the chats you started, then Sleeping and Not
 * started coordinators, each with its team. A folded group's team
 * is hidden, so it takes no numbers. The panel's key handler and the worker's commands both read this.
 */
export function chatTargets(snap                                         , folded                      = new Set())               {
  return treeBlocks(localView(snap)).flatMap(({ c, lines, auxiliary })               => [
    ...(auxiliary ? [{ key: `agent:${auxiliary.p.a.paneKey}`, workspaceId: auxiliary.p.row.id, terminal: auxiliary.p.a.terminal  }] : c.you ? [] : [{ key: `coordinator:${c.key}`, coordinator: c.key }]),
    // A slept lead heading its open workers takes no number: a key press never resumes it unseen.
    ...(folded.has(auxiliary ? auxiliaryKey(auxiliary.p) : c.key) ? [] : lines.filter(({ p }) => !asleep(p.row)).map(({ p })             => p.row.coordinator
      ? { key: `agent:${p.a.paneKey}`, coordinator: p.row.coordinator }
      : { key: `agent:${p.a.paneKey}`, workspaceId: p.row.id, ...(p.a.terminal ? { terminal: p.a.terminal } : {}) }))
  ]).slice(0, CHAT_KEYS)
}

/** The chat number of an Option+digit press (by physical key: on a Mac, Option+1 types "¡"), or null. */
export function chatDigit(e                                                                                          )                {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null
  const m = /^Digit([1-9])$/.exec(e.code)
  return m && Number(m[1]) <= CHAT_KEYS ? Number(m[1]) : null
}

// ---------- the panel ----------

/**
 * The parts the page places separately: the cockpit row (beside the static search control in the top
 * bar), its opened stats below the bar, the scrolling middle (the tree), what asks you (Up next),
 * pinned below it, and the Linear section below that. Up next sits at the bottom of the tree so the tree
 * never moves when an ask comes or goes: it starts at the top of its own scroll area, which only gets shorter.
 */
/** Settings → Features: a section shows unless its switch is off (an older snapshot has no switches). */
export const linearOn = (snap                            )          => snap.features?.linear !== false
/** Goals is off unless Settings → Features says so: an absent switch reads as off. */
export const goalsOn = (snap                            )          => snap.features?.goals === true
export const tokenSpeedOn = (snap                            )          => snap.features?.tokenSpeed !== false

// ---------- Reload skills ----------

/** Circular arrows: the Reload skills action and its marks. */
export const RELOAD_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5"/><path d="M11.8 1.8v2.8H9M4.2 14.2v-2.8H7"/></svg>'
const RELOAD_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>'
const RELOAD_NONE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5"/><path d="M4.6 11.4l6.8-6.8"/></svg>'

/** The key of the "all running agents" action's inline status (ui.status). */
export const RELOAD_ALL = 'reload:all'

/** A row's small skill-reload mark (waiting, reading, reloaded, unsupported), or '' when it has none. */
export function reloadMark(ui                          , pane        )         {
  const e = ui.reloads?.get(pane)
  if (!e) return ''
  const glyph = e.state === 'reloaded' ? RELOAD_CHECK : e.state === 'unsupported' ? RELOAD_NONE : RELOAD_ICON
  // An unsupported row says why, with the one action to take ("Codex: approve Orca Flow's hooks once; …").
  const tip = e.state === 'unsupported' && e.reason ? e.reason
    : e.state === 'waiting' && e.provider === 'codex' ? CODEX_WAITING_TIP
    : e.state === 'waiting' && e.provider === 'antigravity' ? AGY_WAITING_TIP : RELOAD_TIP[e.state]
  return `<span class="srl srl-${e.state}" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}">${glyph}</span>`
}

/** The Coordinators heading with its one compact action, Reload skills in every running agent. */
export function treeLabel(ui         )         {
  // While a click on the action runs or was refused, its status takes the action's place.
  const status = rowStatus(ui, RELOAD_ALL)
  if (status) return `<div class="label tlabel"><span>Coordinators</span>${status}</div>`
  return `<div class="label tlabel"><span>Coordinators</span><button class="icon lact" data-reload-skills="all" aria-label="Reload skills in all running agents" data-tip="Reload skills">${RELOAD_ICON}</button></div>`
}

/** A visible warning, above the tree, while the summary writer is failing; gone after the next successful summary. */
export function summaryNotice(failure                            )         {
  if (!failure) return ''
  // The text wraps (no ellipsis) in the narrow sidebar; the full diagnostics sit in the panel's tooltip (data-tip, like every other row).
  const tip = `${failure.detail ? `${failure.detail}\n` : ''}Agent cards keep their last summary until a writer works again.`
  return `<div class="sumfail" role="status" data-tone="warn" data-tip="${esc(tip)}">${STATUS_ICON.warn}<span class="sumtext">Summaries failing: ${esc(failure.reason)}</span></div>`
}

export function render(given          , state         , linearData                    = null, goals                    = null)                                                                                                                                          {
  const reloading = visibleReload(given.skillReload, state.now)
  const ui          = { ...state, reloads: new Map(reloading.map((e) => [e.pane, e])) }
  // Linear off: no Linear data reaches the section or the rows' labels.
  const linear = linearOn(given) ? linearData : null
  // A worktree created without --linear-issue is linked by the issue in its branch name, in the tree and the section alike.
  // Its label opens the issue in Linear when the data gives its page.
  const snap = linear ? { ...given, rows: linkRows(given.rows, teamsOf(linear)).map((r) => (r.linearIssue ? { ...r, linearLink: issueLink(r.linearIssue, linear) } : r)) } : given
  const copen = ui.cockpitOpen && !ui.query ? cockpitOpen(snap, ui) : ''
  // Goals, at the top above the tree; hidden while searching, like the other sections.
  const goalsData = goalsOn(given) ? goals : null
  const gs = { folded: ui.goalsFolded, open: ui.goalOpen, now: ui.now }
  const placed = snap.rows.flatMap((row) => row.agents.map((a) => ({ a, row })))
  const all = placed.map((p) => p.a)
  const byPane = new Map(placed.map((p) => [p.a.paneKey, p]))
  // The live agents on the goal (goalAgents, the rule Jump → uses), whatever their state: each face shows it.
  const avatars = (g          )         => {
    const on = g.livePanes.flatMap((key) => byPane.get(key) ?? []).filter(({ a }) => !a.terminal || !ui.goalGone?.has(a.terminal))
    if (!on.length) return ''
    const names = on.map(({ a, row }) => nameOf(a, row)).join(', ')
    const label = esc(`Agents on this goal: ${names}`)
    return `<span class="who" role="img" aria-label="${label}">${avatarStack(on, all, 3)}</span>`
  }
  const button = (g          ) => nextButton(g, given, { assigning: ui.goalAssigning, gone: ui.goalGone })
  const goalsOut = { goalsHead: goalsHead(goalsData ?? [], gs, !!ui.query || !goalsData), goalsRows: goalsRows(goalsData ?? [], gs, !!ui.query || !goalsData, avatars, button) }
  // One briefing per asking agent, workspaces in urgency order; several agents in one workspace each
  // get one; a coordinator asking itself gets one too.
  const asking = upNextOrder(snap)
  const mixed = mixedProviders(snap)

  if (ui.query) {
    const q = ui.query.toLowerCase()
    const found = snap.rows.filter((r) => [r.name, r.repo, r.branch, ...r.agents.map((a) => a.title)].some((f) => f?.toLowerCase().includes(q)))
    return { cockpit: cockpit(snap, ui), copen, main: `<div class="group found">${
      found.length
        ? found.map((r) => `<button class="item" ${r.folderOf && r.agents[0] ? openAttrs({ a: r.agents[0], row: r }) : `data-open="${esc(r.id)}"`}>${asleep(r) ? tipped(character(colorOf(r.repo), 'solo', 'idle', 20), 'Asleep') : character(colorOf(r.repo), 'solo', r.agents.length ? faceOf(r.agents[0]) : 'idle', 20)}${providerBadge(r.agents[0], mixed)}<span class="t">${esc(r.agents[0]?.title ?? r.name)}</span><span class="r soft">${esc(r.repo)}</span></button>`).join('')
        : '<div class="empty">No matching workspaces</div>'
    }</div>`, ...goalsOut, attention: '', bots: '', linear: '' }
  }

  // Sleep and remove are in the rows' menus.
  const tree = treeBlocks(snap).map((b) => coordinatorBlock(b, all, snap, ui, mixed)).join('')

  return {
    cockpit: cockpit(snap, ui),
    copen,
    ...goalsOut,
    main: `${summaryNotice(snap.summaryFailure)}<div class="tree">${treeLabel(ui)}${tree || '<div class="empty">No agents running</div>'}<button class="newcoord" data-new-coordinator>${ICON.plus}New coordinator</button></div>`,
    attention: upNext(asking, all, snap.coordinators, ui, snap.bots ?? []),
    bots: botsSection(snap, ui),
    linear: linearSection(snap, ui, linear)
  }
}

// ---------- Bots ----------

/** Where the panel keeps the Bots section's fold (plugin storage). */
export const BOTS_UI_KEY = 'bots-ui'
/** The group of bots no coordinator adopted. */
export const PERSONAL = 'Personal'

/** The name of a bot's group: the coordinator that adopted it, else Personal. */
export const botGroupName = (b     , coordinators               ) =>
  (b.coordinator && coordinators.find((c) => c.key === b.coordinator)?.name) || PERSONAL

/**
 * A bot's avatar. Orca draws its own mascots (bot.json `avatar`, like "mascot:B1") from art the panel
 * cannot load, so a bot wears a character of its own shape (a head with an antenna), colored by its
 * avatar so it keeps one color, with the face of what it does now.
 */
export function botCharacter(b                              , face      , ask          = 'question', size = 20)         {
  return character(colorOf(b.avatar ?? b.name), 'bot', face, size, face !== 'done', ask)
}

/** What a bot does now, as its row shows it: the chat that asks first, then one that works, then paused, then its next run. */
export function botState(b     , now        )                                                                             {
  const asking = b.chats.find((c) => botNeedsYou(c.agent))
  if (asking) { const ask = askKindOf(asking.agent); return { face: 'asks', ask, text: 'Waiting on you', tip: ASK_TIP[ask], tone: 'ask' } }
  if (b.chats.some((c) => c.agent.state === 'working')) return { face: 'working', text: 'Working', tip: 'Working', tone: '' }
  if (b.paused) return { face: 'idle', text: 'Paused', tip: 'Paused', tone: '' }
  if (b.nextRunAt && b.nextRunAt > now) return { face: 'done', text: `in ${until(b.nextRunAt, now)}`, tip: `Next run ${new Date(b.nextRunAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`, tone: '' }
  return { face: 'done', text: '', tip: 'Bot', tone: '' }
}

/** How long until `at`, like ago(): "12m", "3h", "2d". */
export function until(at        , now        )         {
  const m = Math.max(1, Math.round((at - now) / 60_000))
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

/** One bot on one line: its avatar, name and purpose; on the right what it does now. A click opens its Home chat's workspace. */
function botRow(b     , ui         )         {
  const st = botState(b, ui.now)
  const who = tipped(botCharacter(b, st.face, st.ask), st.tip, st.tone)
  const right = st.text ? (st.face === 'done' ? `<span class="age" data-tip="${esc(st.tip)}">${esc(st.text)}</span>` : `<span class="rstatus${st.tone ? ` ${st.tone}` : ''}">${esc(st.text)}</span>`) : ''
  const open = b.workspaceId ? `data-open="${esc(b.workspaceId)}"` : 'disabled data-tip="Its Home chat is not open in Orca"'
  return `<button class="item brow" ${open} data-bot="${esc(b.id)}">${who}<span class="t"><span class="bname">${esc(b.name)}</span>${b.purpose ? `<span class="bpurpose">${esc(b.purpose)}</span>` : ''}</span><span class="r">${right}</span></button>`
}

/**
 * The Bots section, between Up next and Linear: a header with the count that folds it, then one line
 * per bot, grouped under the coordinator that adopted it (in the Coordinators section's order) and
 * then Personal. Empty while Orca has not said which bots there are.
 */
export function botsSection(snap          , ui         )         {
  const bots = snap.bots
  if (!bots) return ''
  const folded = ui.botsFolded
  const head = `<div class="sechead"><button class="label lfold" data-bfold aria-expanded="${!folded}">${ICON.chev}<span>Bots</span><span class="fc">${bots.length}</span></button></div>`
  if (folded) return head
  if (!bots.length) return `${head}<div class="empty bempty">No bots yet. Ask a coordinator to adopt one, or create one in Orca.</div>`
  const order = coordinatorOrder(snap).filter((c) => bots.some((b) => b.coordinator === c.key))
  const groups = [
    ...order.map((c) => ({ name: c.name, bots: bots.filter((b) => b.coordinator === c.key) })),
    { name: PERSONAL, bots: bots.filter((b) => !b.coordinator || !snap.coordinators.some((c) => c.key === b.coordinator)) }
  ].filter((g) => g.bots.length)
  return `${head}<div class="group">${groups.map((g) => `<div class="bgroup">${esc(g.name)}</div>${g.bots.map((b) => botRow(b, ui)).join('')}`).join('')}</div>`
}

// ---------- Linear ----------

/** A worktree's Linear issue, as a small chip before its row's title. */
/**
 * A row's Linear label. With the issue's page known it is a link like the PR chip (role link, the
 * URL in data-url, the issue in its tooltip): a click opens Linear, not the row. Else plain text.
 */
export const idChip = (id        , link                                               ) =>
  link
    ? `<span class="idchip" role="link" data-url="${esc(link.url)}" data-tip="${esc(link.title ? `${id} · ${link.title}` : `Open ${id} in Linear`)}" aria-label="${esc(`Open ${id} in Linear`)}">${LINEAR_MARK}${esc(id)}</span>`
    : `<span class="idchip">${LINEAR_MARK}${esc(id)}</span>`


/** Rows a filter shows before "N more", so a big team list stays quick to draw. */
export const LINEAR_ROWS = 50

/** The state a sent issue shows until Linear's own catches up. */
const STARTED = { name: 'In Progress', type: 'started', color: '' }

/**
 * One issue on one line: Linear's status and priority icons, its ID and title. On the right: the
 * lead and coordinator of the worktree that links it; else the coordinator it was sent to, starting;
 * else (Team and Cycle) its assignee when that is not you, and on hover "Send".
 */
function linearRow(i             , snap          , ui         , data            , linked                           )         {
  const status = rowStatus(ui, `linear:${i.id}`)
  const row = linked.get(i.id)
  const sent = data.sent[i.id]?.delivery === 'unknown' ? data.sent[i.id] : row ? undefined : data.sent[i.id]
  const coordinator = sent && snap.coordinators.find((c) => c.key === sent.coordinator)
  const glyphs = `${statusIcon(sent && sent.delivery !== 'unknown' ? STARTED : i.state)}${priorityIcon(i.priority)}<span class="lid">${esc(i.id)}</span><span class="t">${esc(i.title)}</span>`
  if (row && sent?.delivery !== 'unknown') {
    const all = snap.rows.flatMap((r) => r.agents)
    const lead = worktreeLead(row)
    const right = lead
      ? `${agentCharacter(lead, row, all, 14)}<span>${esc(coordinatorName(lead.coordinator, snap.coordinators))}</span>`
      : `${character(colorOf(row.repo), 'lead', 'idle', 14, false)}<span>${esc(row.name)}</span>`
    const open = lead ? openAttrs({ a: lead, row }) : `data-open="${esc(row.id)}"`
    return `<button class="item lrow linked" ${open}>${glyphs}<span class="r">${status ?? right}</span></button>`
  }
  if (sent) {
    const name = coordinator?.name ?? sent.coordinator
    const who = coordinator ? coordinatorCharacter(coordinator, 14, sent.delivery === 'unknown' ? 'idle' : 'working') : ''
    return `<button class="item lrow" ${sent.recipient ? `data-history="${esc(sent.coordinator)}" data-member="${esc(sent.recipient.member)}" data-history-terminal="${esc(sent.recipient.terminal)}" data-history-session="${esc(sent.recipient.orcaSession ?? '')}"` : `data-sessions="${esc(sent.coordinator)}"`} data-menu="linear:${esc(i.id)}">${glyphs}<span class="r">${status ?? `${who}<span class="rstatus pending">${esc(name)}${sent.recipient?.agentType ? ` · ${esc(sent.recipient.agentType)}` : ' · recipient unrecorded'} · ${sent.delivery === 'unknown' ? 'delivery unconfirmed · inspect source' : 'starting'}</span>`}</span></button>`
  }
  const who = ui.linearFilter === 'mine' || (i.assignee && i.assignee.id === data.me) ? '' : i.assignee ? i.assignee.name : 'unassigned'
  const right = status ?? `${who ? `<span class="rest">${esc(who)}</span>` : ''}<span class="act pill send">Send ${ARROW}</span>`
  return `<button class="item lrow" data-lsend="${esc(i.id)}" data-menu="linear:${esc(i.id)}" aria-haspopup="menu">${glyphs}<span class="r">${right}</span></button>`
}

const SLIDERS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5h6.5M13 4.5h.5M2.5 11.5h.5M7 11.5h6.5"/><circle cx="11" cy="4.5" r="1.75"/><circle cx="5" cy="11.5" r="1.75"/></svg>'
const CROSS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6"/></svg>'

/** A project's color dot; the color is checked to be a hex color when read. */
export const projectDot = (color        ) => `<i class="pdot"${/^#[0-9a-f]{3,8}$/i.test(color) ? ` style="background:${color}"` : ''} aria-hidden="true"></i>`

/** A group's glyph: its status icon, project dot or priority icon (assignee groups go by name alone). */
function groupGlyph(g             , by                  )         {
  const first = g.issues[0]
  if (!first) return ''
  if (by === 'status') return statusIcon(first.state)
  if (by === 'priority') return priorityIcon(first.priority)
  if (by === 'project') return projectDot(g.key ? first.projectColor : '')
  return ''
}

/**
 * The Linear section, pinned under Up next: a header that folds it (Linear · team, with the count
 * and filter while folded), the Display button and the Mine / Team / Cycle switch, a chip that
 * clears a project filter, then the filter's issues in groups that fold; states the display leaves
 * out fold away at the end. Empty when Linear is not connected.
 */
export function linearSection(snap          , ui         , data                   )         {
  if (!data) return ''
  const linked = rowsByIssue(snap.rows)
  const ids = new Set(linked.keys())
  const display = ui.linearDisplay
  const views = Object.fromEntries(FILTERS.map((f) => [f, viewOf(data, f, ids, display)]))
  const f = ui.linearFilter
  const view = views[f]
  const team = data.teams.length > 1 ? `${data.teams[0]} +${data.teams.length - 1}` : (data.teams[0] ?? '')
  const folded = ui.linearFolded
  const starting = Object.keys(data.sent).filter((id) => !linked.has(id) && data.sent[id].delivery !== 'unknown')
  const startingCoord = starting.length ? snap.coordinators.find((c) => c.key === data.sent[starting[0]].coordinator) : undefined
  const fold = `<button class="label lfold" data-lfold aria-expanded="${!folded}"${data.teams.length > 1 ? ` data-tip="${esc(data.teams.join(', '))}"` : ''}>${ICON.chev}${LINEAR_MARK}<span>Linear${team ? ` · ${esc(team)}` : ''}</span>${folded ? `<span class="fc">${view.count}</span>` : ''}</button>`
  const changed = !isDefaultDisplay(display)
  const displayButton = `<button class="icon ldisplay" data-ldisplay aria-haspopup="menu" aria-label="Display options${changed ? ' (changed)' : ''}" data-tip="Display">${SLIDERS}${changed ? '<span class="dot"></span>' : ''}</button>`
  const right = folded
    ? `<span class="foldsum">${starting.length ? `${startingCoord ? coordinatorCharacter(startingCoord, 13, 'working') : ''}<span>${starting.length} starting</span><span class="sepd">${FILTER_NAME[f]}</span>` : FILTER_NAME[f]}</span>`
    : `${displayButton}<span class="seg" role="group" aria-label="Filter">${FILTERS.map((k) => `<button data-lfilter="${k}" aria-pressed="${k === f}">${FILTER_NAME[k]} ${views[k].count}</button>`).join('')}</span>`
  const head = `<div class="sechead">${fold}${right}</div>`
  if (folded) return head
  // A project filter shows as one chip that clears it.
  const picked = display.projects
  const projectName = (key        ) => view.projects.find((p) => p.key === key)?.name ?? (key || 'No project')
  const chip = picked.length
    ? `<div class="pchips"><button class="pchip" data-lprojects-clear aria-label="Show all projects">${picked.length === 1 ? `${projectDot(view.projects.find((p) => p.key === picked[0])?.color ?? '')}${esc(projectName(picked[0]))}` : `${picked.length} projects`}${CROSS}</button></div>`
    : ''
  const rowsOf = (issues               , moreKey        ) => {
    const all = ui.unfolded.has(moreKey)
    const rows = (all ? issues : issues.slice(0, LINEAR_ROWS)).map((i) => linearRow(i, snap, ui, data, linked)).join('')
    return issues.length > LINEAR_ROWS && !all ? `${rows}<button class="fold" data-lmore="${esc(moreKey)}" aria-expanded="false">${ICON.chev}${issues.length - LINEAR_ROWS} more</button>` : rows
  }
  const body = view.groups.map((g) => {
    if (display.group === 'none') return rowsOf(g.issues, 'linear-all')
    const key = `${display.group}:${g.key}`
    const open = !ui.linearGroupFolds.has(key)
    return `<button class="lgroup" data-lgroup="${esc(key)}" aria-expanded="${open}">${ICON.chev}${groupGlyph(g, display.group)}<span class="gl">${esc(g.label)}</span><span class="gc">${g.issues.length}</span></button>${open ? rowsOf(g.issues, `linear-all:${key}`) : ''}`
  }).join('')
  // A state the display leaves out folds away at the end and opens in place, so nothing is out of reach.
  const hidden = view.hidden.map(({ state, issues }) => {
    const key = `linear-hidden:${state}`
    const open = ui.unfolded.has(key)
    return `<button class="fold" data-lmore="${key}" aria-expanded="${open}">${ICON.chev}${issues.length} ${state === 'staging' ? 'on' : 'in'} ${STATE_NAME[state]}</button>${open ? rowsOf(issues, `linear-all:${key}`) : ''}`
  }).join('')
  const empty = view.count || view.hidden.length ? '' : `<div class="empty">Nothing open${picked.length ? ' in these projects' : f === 'cycle' && !data.cycles.length ? ': no active cycle found' : ''}</div>`
  return `${head}${chip}<div class="group">${body}${empty}${hidden}</div>`
}

// ---------- looks for new coordinators ----------

export const LOOK_SHAPES              = ['pentagon', 'hex', 'shield']

/** Every color and shape no coordinator uses yet; new coordinators are offered one of these. */
export function freeLooks(coordinators               )         {
  const taken = new Set(coordinators.map((c) => (c.look ? `${c.look.color}/${c.look.shape}` : '')))
  return PALETTE.flatMap((color) => LOOK_SHAPES.map((shape) => ({ color, shape }))).filter((l) => !taken.has(`${l.color}/${l.shape}`))
}
// Generated by scripts/build-frames.mjs from the .ts file of the same name. Do not edit.
