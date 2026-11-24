// The Usage view as pure functions: the worker's analytics.view / analytics.workstream answers and
// the view's UI state in, HTML out (no DOM, no Node), so it is tested in Node, previewed outside Orca
// and used as is by the Usage editor (src/editor/). Layout and wording follow the approved draft
// (docs/analytics-draft/index.html); the rules behind the numbers are docs/analytics-brief.md §3-§8.
//
// One question per screen: Usage (curiosity strip, By task kind, Lead overhead, Policy comparison,
// Biggest workstreams) → a row's tasks → a workstream; and a comparison. Details sit behind a toggle.
import { modelLabel } from './model-label.ts'
import type { AnalyticsTask, AnalyticsView, AnalyticsWindow, Comparison, KindRow, Spend, TaskResult, UsageDay, WorkstreamDetail, WorkstreamLine, WorkstreamRow } from './protocol.ts'

export const WINDOWS: { id: AnalyticsWindow; label: string }[] = [{ id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: 'all', label: 'All' }]
/** What the usage of sessions with no Orca binding is called: coordinators and plain terminals are not workstreams. */
export const UNATTRIBUTED = 'Coordinators and plain terminals'
/** The estimate's label wherever it stands (also the sidebar line's tooltip). */
export const ESTIMATE_NOTE = 'at API list prices · not your bill'

export type Screen = { view: 'usage' } | { view: 'kind'; id: string } | { view: 'ws'; id: string } | { view: 'cmp'; id: string }
/** What the per-day charts measure: tokens, or the estimate at API list prices. Never both on one axis. */
export type UsageMetric = 'tokens' | 'cost'
export const usageMetric = (v: unknown): UsageMetric => (v === 'cost' ? 'cost' : 'tokens')
export type UsageUi = {
  window: AnalyticsWindow
  metric: UsageMetric
  /** The screens opened so far, the one shown last; the first is Usage. */
  stack: Screen[]
  details: boolean
}
export type UsageData = {
  view: AnalyticsView | null
  /** Workstream details fetched so far; null = asked, not known. */
  ws: Record<string, WorkstreamDetail | null>
  /** The last request failed. */
  error?: string | null
}
export const usageUi = (): UsageUi => ({ window: '7d', metric: 'tokens', stack: [{ view: 'usage' }], details: false })

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const CHEV = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2l3 3-3 3"/></svg>'

// ---------- formatting ----------

/** 52_400_000 → "52.4M", 8_300 → "8.3K", 412 → "412". */
export function tok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n))
}
export const full = (n: number) => Math.round(n).toLocaleString('en-US')
/** "$48", "$4.82", "<$0.01", "$1,240". */
export function usd(n: number): string {
  if (!(n > 0)) return '$0'
  if (n < 0.005) return '<$0.01'
  return `$${n >= 10 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`
}
export const pct = (share: number) => `${Math.round(share * 100)} %`
/** A duration: "45 s", "12 min", "2 h 05 min". */
export function dur(ms: number | null): string {
  if (ms == null) return '–'
  const m = ms / 60_000
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : `${Math.round(m)} min`
}
const dateOf = (t: number | null) => (t == null ? '–' : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))

/** The sidebar's line text: "52.4M tokens · ≈ $48" (no estimate when nothing is priced). */
export function usageLine(u: { tokens: number; cost: number; unpriced: number }): { tokens: string; cost: string } {
  const none = u.unpriced > 0 && u.cost === 0 && u.tokens > 0
  return { tokens: tok(u.tokens), cost: none ? 'no estimate' : u.tokens === 0 ? '≈ $0' : `≈ ${usd(u.cost)}${u.unpriced > 0 ? '+' : ''}` }
}

/** The estimate of a spend: "$4.82", "$4.82+" when some tokens have no price, "no estimate" when none has, "–" when empty. */
function costTxt(s: Spend): string {
  if (s.total === 0) return '<span class="ne">–</span>'
  if (s.unpriced > 0 && s.cost === 0) return '<span class="ne" data-tip="No price for this model in the price table">no estimate</span>'
  if (s.unpriced > 0) return `<span data-tip="${esc(`${tok(s.unpriced)} tokens have no price and are not in this estimate`)}">${usd(s.cost)}+</span>`
  return usd(s.cost)
}

// ---------- model badges ----------

/** A model keeps one chart color per view: in the order of its share, "other" and unknown in grey. */
function slots(v: AnalyticsView): (id: string | null) => string {
  const order = v.strip.models.map((m) => m.model).filter((m): m is string => !!m)
  return (id) => {
    if (!id) return 'sx'
    let k = order.indexOf(id)
    if (k < 0) { order.push(id); k = order.length - 1 }
    return k < 6 ? `s${k}` : 'sx'
  }
}
const badge = (slot: (id: string | null) => string, id: string | null) => `<span class="mbadge"><i class="dot ${slot(id)}"></i>${esc(id ? modelLabel(id) : 'unknown')}</span>`

const chipPartial = (coverage: number) =>
  coverage < 1 ? `<span class="chip warn" data-tip="${esc(`${Math.round(coverage * 100)} % of this run's active time was recorded: logs before Analytics, or rotated away, are missing. Its numbers are a floor, never extrapolated.`)}">Partial ${Math.round(coverage * 100)} %</span>` : ''
const chipResult = (r: TaskResult) => (r === 'failed' ? '<span class="chip bad">failed</span>' : r === 'running' ? '<span class="chip">running</span>' : '')

// ---------- chrome ----------

const winSeg = (ui: UsageUi) =>
  `<span class="seg" role="group" aria-label="Time window" data-tip="The window sets the totals (usage recorded inside it) and which finished tasks and workstreams are counted (by finish date, at their whole-run totals).">${WINDOWS.map((w) => `<button data-win="${w.id}" aria-pressed="${w.id === ui.window}">${w.label}</button>`).join('')}</span>`
const back = (label: string) => `<button class="back" data-back>${CHEV}<span>${esc(label)}</span></button>`
const detailsBtn = (ui: UsageUi) => `<button class="dtoggle" data-act="details" aria-expanded="${ui.details}">${CHEV}Details</button>`

/** The window's word: "in the last 7 days". */
const windowSay = (w: AnalyticsWindow) => (w === '7d' ? 'in the last 7 days' : w === '30d' ? 'in the last 30 days' : 'since recording began')

// ---------- empty and partial states ----------

/** "Analytics starts recording now; backfill reading 12 of 340 logs" and its other states. */
export function backfillText(b: AnalyticsView['backfill']): string {
  if (b.state === 'running') return `Analytics starts recording now; backfill reading ${b.read.toLocaleString('en-US')} of ${b.total.toLocaleString('en-US')} logs`
  if (b.state === 'pending') return 'Analytics starts recording now; the backfill from the agents’ logs on disk begins after the first read'
  return 'Analytics records every response from now on; the backfill from older logs is done'
}

function emptyState(v: AnalyticsView): string {
  return `<div class="empty-state"><h2>No usage recorded yet</h2><p>${esc(backfillText(v.backfill))}.</p>`
    + '<p class="note">Orca Flow reads token counts from the Claude Code and Codex logs on this Mac (never messages) and keeps them for 90 days.</p></div>'
}

// ---------- usage per day: one column chart, the Usage tab's and the sidebar's ----------

/** One column: its day, its height (the metric's total) and its stacked parts, bottom first. */
export type DayColumn = { start: number; total: number; parts: { cls: string; value: number }[]; tip: string; label: string }

/**
 * The y scale's top: the first of 1, 2, 3, 4, 5, 6, 8, 10 × a power of ten at or above v, so the
 * half line is round too (same rule as the speed charts).
 */
export function niceTop(v: number): number {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return Number((([1, 2, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v * (1 - 1e-9)) ?? 10) * p).toPrecision(6))
}

const weekday = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'short' })
const monthDay = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
/** "Mon, Nov 17". */
export const dayName = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

/**
 * The axis label under each column: every day up to 7 ("Mon", today "Today"); above that every k-th
 * day counted back from today ("Nov 17"), so today always has one and labels never touch.
 */
export function axisLabels(starts: number[], wide: boolean): string[] {
  const n = starts.length
  const every = n <= 7 ? 1 : Math.ceil(n / (wide ? 10 : 5))
  return starts.map((t, i) => {
    const back = n - 1 - i
    if (back % every) return ''
    if (back === 0) return 'Today'
    return n <= 7 ? (wide ? `${weekday(t)} ${new Date(t).getDate()}` : weekday(t)) : monthDay(t)
  })
}

/** A metric value as an axis or cap label: "8.2M" tokens, "$4.82". */
export const metricText = (metric: UsageMetric, v: number) => (metric === 'cost' ? usd(v) : tok(v))

/**
 * Daily columns on one baseline: gridlines at 0, half and the top with their values, columns of at
 * most 24 px with a 4 px rounded top and 2 px gaps between stacked parts, the busiest day's value on
 * its cap, an axis label per day (thinned when many), and a hover target per day, as tall as the
 * plot, whose tooltip gives the day in full.
 */
export function dayColumns(cols: DayColumn[], o: { metric: UsageMetric; compact?: boolean; size?: 'side' }): string {
  const top = niceTop(Math.max(0, ...cols.map((c) => c.total)))
  let peak = -1
  cols.forEach((c, i) => { if (c.total > 0 && (peak < 0 || c.total > cols[peak].total)) peak = i })
  // Ticks are round by construction: "20M", not "20.0M".
  const tick = (v: number) => metricText(o.metric, v).replace(/\.0+(?=[KMB]?$)/, '')
  const grid = [[0, tick(top)], [50, tick(top / 2)], [100, o.metric === 'cost' ? '$0' : '0']]
    .map(([y, t]) => `<span class="ucg${y === 100 ? ' base' : ''}" style="top:${y}%"><b>${esc(t)}</b></span>`).join('')
  const bars = cols.map((c, i) => {
    const h = c.total > 0 ? Math.max(1.5, (c.total / top) * 100) : 0
    const parts = c.parts.filter((p) => p.value > 0).map((p) => `<i class="${p.cls}" style="flex-grow:${p.value}"></i>`).join('')
    const cap = i === peak ? `<span class="uccap" style="bottom:${h.toFixed(2)}%">${esc(metricText(o.metric, c.total))}</span>` : ''
    return `<div class="uccol" tabindex="0" role="img" aria-label="${esc(c.tip.replace(/\n/g, '; '))}" data-tip="${esc(c.tip)}">`
      + (h ? `<span class="ucbar" style="height:${h.toFixed(2)}%">${parts}</span>` : '') + cap + '</div>'
  }).join('')
  const axis = cols.map((c) => `<span>${esc(c.label)}</span>`).join('')
  return `<div class="uchart${o.compact ? ' compact' : ''}${o.size ? ` ${o.size}` : ''}" style="--n:${cols.length}"><div class="ucplot">${grid}<div class="uccols">${bars}</div></div><div class="ucaxis">${axis}</div></div>`
}

/** A spend's estimate in a tooltip: "≈ $4.82", "≈ $4.82 + 1.2M tokens with no price", "no estimate". */
const costSay = (cost: number, unpriced: number, tokens: number) =>
  tokens === 0 ? '≈ $0' : unpriced > 0 && cost === 0 ? 'no estimate' : `≈ ${usd(cost)}${unpriced > 0 ? ` + ${tok(unpriced)} tokens with no price` : ''}`

/** What the strip and the per-day block read of the UI: the window, the measure, Details open. */
export type UsageOpts = Pick<UsageUi, 'window' | 'metric' | 'details'>
/**
 * The controls' attributes: the Usage tab's (data-win, data-metric, data-act), or the sidebar's
 * (data-uwin, data-umetric, data-udetails: the panel already uses data-act for its own buttons).
 */
const attrs = (side: boolean) => (side ? { win: 'data-uwin', metric: 'data-umetric', details: 'data-udetails' } : { win: 'data-win', metric: 'data-metric', details: 'data-act="details"' })

/**
 * Usage per day: stacked by model (the strip's colors), tokens or estimate, a per-day table behind
 * Details. In the sidebar (`side`) the chart is shorter and the table keeps Day, Total, Output and
 * Est. cost, the four categories in each row's tooltip.
 */
function perDay(v: AnalyticsView, ui: UsageOpts, slot: ReturnType<typeof slots>, side = false): string {
  const days = v.daily ?? []
  if (!days.length) return ''
  const cost = ui.metric === 'cost'
  const today = days[days.length - 1].start
  const labels = axisLabels(days.map((d) => d.start), !side)
  // Parts per color: the top models keep their strip color; the rest share "Other".
  const nameOf = (cls: string, model: string | null) => (cls === 'sx' ? 'Other' : model ? modelLabel(model) : 'Unknown model')
  const shown = new Map<string, string>()
  const cols: DayColumn[] = days.map((d, i) => {
    const by = new Map<string, number>()
    for (const m of d.models) {
      const cls = slot(m.model)
      const value = cost ? m.cost : m.tokens
      if (value > 0 && !shown.has(cls)) shown.set(cls, nameOf(cls, m.model))
      by.set(cls, (by.get(cls) ?? 0) + value)
    }
    const s = d.spend
    const lines = [
      `${dayName(d.start)}${d.start === today ? ' · today so far' : ''}`,
      s.total ? `${tok(s.total)} tokens · ${costSay(s.cost, s.unpriced, s.total)}` : 'no usage recorded',
      ...d.models.filter((m) => m.tokens > 0).slice(0, 5).map((m) => `${m.model ? modelLabel(m.model) : 'Unknown model'}: ${tok(m.tokens)} · ${m.unpriced && !m.cost ? 'no estimate' : usd(m.cost)}`),
      s.total ? `input ${tok(s.in)} · cache read ${tok(s.cacheRead)} · cache write ${tok(s.cacheWrite5m + s.cacheWrite1h)} · output ${tok(s.out)}` : ''
    ].filter(Boolean)
    return {
      start: d.start, label: labels[i], tip: lines.join('\n'),
      total: cost ? s.cost : s.total,
      parts: [...by].map(([cls, value]) => ({ cls, value })).sort((a, b) => order(a.cls) - order(b.cls))
    }
  })
  const sum = days.reduce((a, d) => a + (cost ? d.spend.cost : d.spend.total), 0)
  const unpriced = days.reduce((a, d) => a + d.spend.unpriced, 0)
  const busiest = cols.reduce<DayColumn | null>((b, c) => (c.total > 0 && (!b || c.total > b.total) ? c : b), null)
  const a = attrs(side)
  const seg = `<span class="seg${side ? ' sm' : ''}" role="group" aria-label="Measure">${(['tokens', 'cost'] as const).map((m) => `<button ${a.metric}="${m}" aria-pressed="${m === ui.metric}">${m === 'tokens' ? 'Tokens' : side ? '$' : 'Est. cost'}</button>`).join('')}</span>`
  // The sidebar's four figures above the chart already say the window's total: its line keeps average and busiest day.
  const figs = `<div class="figline">${side ? '' : `<span><b>${esc(metricText(ui.metric, sum))}</b> over ${days.length} days</span>`}`
    + `<span>avg ${esc(metricText(ui.metric, sum / days.length))}${side ? '/day' : ' per day'}</span>`
    + (busiest ? `<span>busiest ${esc(monthDay(busiest.start))}, ${esc(metricText(ui.metric, busiest.total))}</span>` : '') + '</div>'
  const legend = [...shown].sort((a, b) => order(a[0]) - order(b[0])).map(([cls, name]) => `<span><i class="dot ${cls}"></i>${esc(name)}</span>`).join('')
  const note = cost && unpriced > 0 ? `<div class="note">${tok(unpriced)} tokens of models with no price (Codex, unknown) are not in the estimate.</div>` : ''
  const dayCell = (d: UsageDay) => `<td>${esc(dayName(d.start))}${d.start === today ? ' (so far)' : ''}</td>`
  const sideTip = (d: UsageDay) => `input ${full(d.spend.in)} · cache read ${full(d.spend.cacheRead)}\ncache write ${full(d.spend.cacheWrite5m + d.spend.cacheWrite1h)} · output ${full(d.spend.out)}`
  const table = side
    ? '<table class="u"><thead><tr><th>Day</th><th>Total</th><th>Output</th><th>Est. cost</th></tr></thead><tbody>'
      + [...days].reverse().map((d) => `<tr data-tip="${esc(sideTip(d))}">${dayCell(d)}<td>${tok(d.spend.total)}</td><td>${tok(d.spend.out)}</td><td>${costTxt(d.spend)}</td></tr>`).join('')
    : '<table class="u"><thead><tr><th>Day</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Total</th><th>Est. cost</th></tr></thead><tbody>'
      + [...days].reverse().map((d) => `<tr>${dayCell(d)}${cats(d.spend)}<td>${costTxt(d.spend)}</td></tr>`).join('')
  const details = ui.details
    ? `<div class="details"><div class="tw">${table}</tbody></table></div><div class="note">Calendar days on this Mac’s clock. Every recorded response counts, coordinators and plain terminals included.</div></div>`
    : ''
  const toggle = `<button class="dtoggle" ${a.details} aria-expanded="${ui.details}">${CHEV}Details</button>`
  // In the sidebar the measure toggle stands on the Usage header (sidebarUsage), with the window's.
  const title = side
    ? ''
    : `<div class="vhead"><div class="label">Usage per day <span class="lab2">· ${cost ? `estimated ${ESTIMATE_NOTE}` : 'all four token categories'}</span></div><span class="grow"></span>${seg}</div>`
  return `<div class="block">${title}`
    + figs + dayColumns(cols, { metric: ui.metric, size: side ? 'side' : undefined })
    + (legend ? `<div class="uclegend">${legend}</div>` : '') + note + toggle + details + '</div>'
}
/** Stack order: the strip's slots bottom up, Other on top. */
const order = (cls: string) => (cls === 'sx' ? 99 : Number(cls.slice(1)) || 0)

// ---------- the sidebar's usage block ----------

/** The window toggle's short labels, for 340 px. */
const SHORT: Record<AnalyticsWindow, string> = { '7d': '7d', '30d': '30d', all: 'All' }

/**
 * The Analytics section's usage, in place of a Usage tab: the window and measure toggles, four
 * figures (`today`, the caller's two stats for today, then the window's tokens and estimate from the
 * strip), usage per day with its Details table, then the strip's other four cells (biggest
 * workstream, model share, input from cache, most expensive task). Null view: still reading; the
 * today figures stand under the header in every state.
 */
export function sidebarUsage(v: AnalyticsView | null, ui: UsageOpts, error?: string | null, today = ''): string {
  const win = `<span class="seg sm" role="group" aria-label="Time window" data-tip="Totals are what was recorded in the window; the biggest workstream and most expensive task are those finished in it.">${WINDOWS.map((w) => `<button data-uwin="${w.id}" aria-pressed="${w.id === ui.window}">${SHORT[w.id]}</button>`).join('')}</span>`
  const measure = `<span class="seg sm" role="group" aria-label="Measure" data-tip="Tokens, or the estimate ${ESTIMATE_NOTE}">${(['tokens', 'cost'] as const).map((m) => `<button data-umetric="${m}" aria-pressed="${m === ui.metric}">${m === 'tokens' ? 'Tokens' : '$'}</button>`).join('')}</span>`
  // The part's header: its name, then the two toggles that set everything under it.
  const head = `<div class="tsub first"><span class="thead">Usage</span><span class="tctl">${win}${measure}</span></div>`
  const stats = (window = '') => (today || window ? `<div class="tstats">${today}${window}</div>` : '')
  if (!v) return `<div class="usb">${head}${stats()}<div class="empty">${error ? `Could not read usage: ${esc(error)}` : 'Reading usage…'}</div></div>`
  const none = v.strip.tokens.total === 0 && (v.daily ?? []).every((d) => d.spend.total === 0)
  if (none) return `<div class="usb">${head}${stats()}<div class="empty">${esc(backfillText(v.backfill))}.</div></div>`
  const slot = slots(v)
  const filling = v.backfill.state === 'running' ? `<div class="terr" role="note">Still filling in: ${esc(backfillText(v.backfill))}.</div>` : ''
  return `<div class="usb">${head}${stats(windowStats(v, ui))}${filling}${perDay(v, ui, slot, true)}${strip(v, ui, slot, true)}</div>`
}

/** The estimate's tooltip: how it is priced, the table's version and what has no price. */
const priceTip = (v: AnalyticsView) => `${esc(v.prices.tip)}\nPrice table ${v.prices.version}, dated ${v.prices.dated}.${v.strip.tokens.unpriced ? ` Excludes ${tok(v.strip.tokens.unpriced)} tokens with no price.` : ''}`

/** The window's tokens and estimate as two headline stats (beside today's): "38.1M tokens, last 7 days", "≈ $34+, est. cost, 7 days". */
function windowStats(v: AnalyticsView, ui: Pick<UsageUi, 'window'>): string {
  const t = v.strip.tokens
  const w = WINDOW_SAY[ui.window]
  const price = priceTip(v)
  return `<div class="tstat" data-tip="${esc(`Recorded ${windowSay(ui.window)}. Includes ${UNATTRIBUTED.toLowerCase()} ${tok(v.strip.unattributed.total)}.`)}"><b>${esc(tok(t.total))}</b><span>tokens</span><small>${w.tokens}</small></div>`
    + `<div class="tstat" data-tip="${price}"><b>${esc(usageLine({ tokens: t.total, cost: t.cost, unpriced: t.unpriced }).cost)}</b><span></span><small>est. cost, ${w.cost}</small></div>`
}
/** The window's words under the sidebar's figures. */
const WINDOW_SAY: Record<AnalyticsWindow, { tokens: string; cost: string }> = { '7d': { tokens: 'last 7 days', cost: '7 days' }, '30d': { tokens: 'last 30 days', cost: '30 days' }, all: { tokens: 'all time', cost: 'all time' } }

// ---------- Usage ----------

/** The curiosity strip; in the sidebar (`side`) without its tokens and estimate cell: the section's four figures already carry them. */
function strip(v: AnalyticsView, ui: Pick<UsageUi, 'window'>, slot: ReturnType<typeof slots>, side = false): string {
  const s = v.strip
  const t = s.tokens
  const w = WINDOWS.find((x) => x.id === ui.window)!
  const top = s.models.slice(0, 2)
  const rest = s.models.slice(2).reduce((a, m) => a + m.tokens, 0)
  const total = t.total || 1
  const bar = `<div class="mbar">${top.map((m) => `<i class="${slot(m.model)}" style="flex:${m.tokens / total}"></i>`).join('')}${rest ? `<i class="sx" style="flex:${rest / total}"></i>` : ''}</div>`
  const share = top.map((m) => `<span class="nw">${esc(m.label)} ${pct(m.share)}</span>`).join(' · ') + (rest ? ` · <span class="nw">other ${pct(rest / total)}</span>` : '')
  const price = priceTip(v)
  const est = t.unpriced > 0 && t.cost === 0 && t.total > 0 ? 'no estimate' : `≈ ${usd(t.cost)}${t.unpriced ? '+' : ''}`
  // A finished workstream that spent nothing is no "biggest": it would read "0" beside a title.
  const big = s.biggest && s.biggest.tokens > 0 ? s.biggest : null
  const first = side ? '' : `<div class="cell"><span class="k">Tokens · ${esc(w.label)}</span><span class="v" data-tip="${esc(`Recorded ${windowSay(ui.window)}. Includes ${UNATTRIBUTED.toLowerCase()} ${tok(s.unattributed.total)}.`)}">${tok(t.total)}</span><span class="s" data-tip="${price}">${est} ${ESTIMATE_NOTE}</span></div>`
  return `<div class="strip">${first}`
    + `<div class="cell"><span class="k">Biggest workstream</span><span class="v sm">${big ? tok(big.tokens) : '–'}</span><span class="s ell"${big ? ` data-tip="${esc(big.title)}"` : ''}>${big ? esc(big.title) : s.biggest ? 'none finished with usage' : 'none finished'}</span></div>`
    + `<div class="cell"><span class="k">Model share</span>${t.total ? bar : ''}<span class="s">${t.total ? share : '–'}</span></div>`
    + `<div class="cell"><span class="k">Input from cache</span><span class="v sm">${s.cacheShare == null ? '–' : pct(s.cacheShare)}</span><span class="s">cache reads of all input tokens</span></div>`
    + `<div class="cell"><span class="k">Most expensive task</span><span class="v sm">${s.priciest ? usd(s.priciest.cost) : '–'}</span><span class="s ell">${s.priciest ? `${esc(s.priciest.name)} · ${esc(s.priciest.workstream.title)}` : ''}</span></div>`
    + '</div>'
}

function rowModel(r: KindRow, slot: ReturnType<typeof slots>): string {
  const effort = r.model?.includes(' · ') ? r.model.split(' · ').slice(1).join(' · ') : ''
  if (r.loggedModel) return `${badge(slot, r.loggedModel)}${effort ? `<span class="eff">${esc(effort)}</span>` : ''}`
  return r.model ? `<span class="eff">${esc(r.model)}</span>` : '<span class="ne">not routed</span>'
}

function kinds(v: AnalyticsView, slot: ReturnType<typeof slots>): string {
  const body = v.rows.map((r) => {
    const sub = r.kind === 'lead' ? '<span class="rsub">per workstream</span>' : ''
    const fb = r.fallback && r.fallbackRan ? `<span class="rsub">fallback ${esc(r.fallback)} ran for ${r.fallbackRan} of ${r.n}</span>` : ''
    const running = r.running ? ` data-tip="${r.running} more running"` : ''
    const cells = !r.n
      ? `<td colspan="5" class="ne">${r.running ? `${r.running} running, none finished` : 'no finished tasks'}</td>`
      : r.few
        ? `<td${running}>${r.n}</td><td colspan="4" class="ne">few tasks</td>`
        : `<td data-tip="${esc(`${r.n} finished${r.retries ? `, ${r.retries} of them retries` : ''}${r.running ? `; ${r.running} running` : ''}`)}">${r.n}</td>`
          + `<td>${tok(r.medianTokens ?? 0)}</td>`
          + `<td${r.unpricedTasks ? ` data-tip="${esc(`${r.unpricedTasks} finished task${r.unpricedTasks === 1 ? '' : 's'} with no price left out`)}"` : ''}>${r.medianCost == null ? '<span class="ne">no estimate</span>' : usd(r.medianCost)}</td>`
          + `<td${r.failed || r.retried ? ` data-tip="${esc(`${r.failed} failed its checks, ${r.retried} were retried`)}"` : ''}>${r.failedOrRetried == null ? '—' : pct(r.failedOrRetried)}</td>`
          + `<td>${dur(r.medianMs)}</td>`
    const narrow = r.model ? `<span class="rsub narrow">${esc(r.model)}</span>` : ''
    return `<tr class="go" data-go="kind:${esc(r.id)}" tabindex="0"><td><span class="rn">${esc(r.name)}</span>${narrow}${sub}${fb}</td><td>${rowModel(r, slot)}</td>${cells}</tr>`
  }).join('')
  const u = v.strip.unattributed.total, unk = v.strip.unknownModel
  const left = [
    u > 0 ? `<span data-tip="Sessions with no Orca dispatch: a coordinator, a plain terminal, or one older than any dispatch. Counted in the totals, in no row.">${UNATTRIBUTED}: ${tok(u)} tokens</span>` : '',
    unk > 0 ? `<span data-tip="Responses whose log named no model: counted, with no price.">Unknown model: ${tok(unk)} tokens</span>` : ''
  ].filter(Boolean)
  return `<div class="block"><div class="label">By task kind <span class="lab2">· Settings → Models · medians per finished task</span></div>`
    + `<div class="tw"><table class="kinds"><thead><tr><th>Row</th><th>Model</th><th>Tasks</th><th>Tokens</th><th>Cost</th><th data-tip="Share of finished tasks that failed their checks or were retried">Failed</th><th>Time</th></tr></thead><tbody>${body}</tbody></table></div>`
    + (left.length ? `<div class="foot">${left.join('')}</div>` : '') + '</div>'
}

function leadOverhead(v: AnalyticsView): string {
  const o = v.leadOverhead
  if (o.median == null) return '<div class="block"><div class="label">Lead overhead</div><div class="note">No finished workstream with workers in this window.</div></div>'
  const rows = o.heaviest.map((h) => `<button class="row" data-go="ws:${esc(h.id)}"><span class="nm"><span class="t">${esc(h.title)}</span></span><span class="tk">${pct(h.share)}</span><span class="cs">${tok(h.leadTokens)}</span></button>`).join('')
  return `<div class="block"><div class="label">Lead overhead</div>`
    + `<div class="figline"><span><b>${pct(o.median)}</b> of a workstream’s tokens go to its lead (median of ${o.n} with workers)</span></div>`
    + `<div class="rows">${rows}</div>`
    + '<div class="note" data-tip="Runs where the lead works alone are 100 % lead by definition and are left out.">High = coordination costs more than the work itself.</div></div>'
}

/** Change of a variant against its baseline, as a share of the baseline: "−42 %", "+8 %" or "same". Lower is better; the colour, the sign and the word carry it. */
function change(b: number | null, delta: number | null): string {
  if (b == null || delta == null || b === 0) return '<td class="d flat">–</td>'
  const r = (delta / b) * 100
  if (Math.abs(r) < 1) return '<td class="d flat">same</td>'
  return `<td class="d ${r < 0 ? 'good' : 'bad'}">${r < 0 ? '−' : '+'}${Math.round(Math.abs(r))} %</td>`
}

function comparisonTable(c: Comparison): string {
  const b = c.baseline, v = c.variant
  const runs = (a: typeof b) => `${a.runs} run${a.runs === 1 ? '' : 's'}`
  const head = `<thead><tr><th></th><th>Baseline<small>${runs(b)}</small></th><th>Variant<small>${runs(v)}</small></th>${c.comparable ? '<th>Change</th>' : ''}</tr></thead>`
  if (!c.comparable) return `<div class="tw"><table class="cmp">${head}</table></div><div class="note"><b class="wn">Not comparable:</b> ${esc((c.sentence ?? 'the arms differ').replace(/^Not comparable:\s*/i, ''))} No change is shown.</div>`
  const d = c.delta
  const passD = d?.passed ?? 0
  const rows = `<tr><td>Tokens per accepted run</td><td>${b.tokensPerAccepted == null ? '–' : tok(b.tokensPerAccepted)}</td><td>${v.tokensPerAccepted == null ? '–' : tok(v.tokensPerAccepted)}</td>${change(b.tokensPerAccepted, d?.tokensPerAccepted ?? null)}</tr>`
    + `<tr><td>Est. cost per accepted run</td><td>${b.costPerAccepted == null ? '–' : usd(b.costPerAccepted)}</td><td>${v.costPerAccepted == null ? '–' : usd(v.costPerAccepted)}</td>${change(b.costPerAccepted, d?.costPerAccepted ?? null)}</tr>`
    + `<tr><td>Time per run</td><td>${dur(b.medianWallMs)}</td><td>${dur(v.medianWallMs)}</td>${change(b.medianWallMs, d?.wallMs ?? null)}</tr>`
    + `<tr><td>Runs that passed</td><td>${b.accepted} of ${b.runs}</td><td>${v.accepted} of ${v.runs}</td><td class="d ${passD > 0 ? 'good' : passD < 0 ? 'bad' : 'flat'}">${passD === 0 ? 'same' : `${passD > 0 ? '+' : '−'}${Math.abs(passD)}`}</td></tr>`
  const notes = [c.notes.includes('small-sample') ? 'small sample' : '', c.notes.includes('partial') ? 'some runs only partly recorded' : ''].filter(Boolean)
  return `<div class="tw"><table class="cmp">${head}<tbody>${rows}</tbody></table></div><div class="note">${b.runs} vs ${v.runs} runs, same models${notes.length ? `: ${notes.join(', ')}` : ''}. Change = variant − baseline.</div>`
}

function policy(v: AnalyticsView): string {
  const [main, ...others] = v.comparisons
  if (!main) {
    return '<div class="block"><div class="label">Policy comparison</div><div class="note">No labelled pair yet. Start the two arms with <span class="mono">orca-flow dispatch --arm baseline|variant --pair &lt;id&gt;</span> to compare a delegation policy.</div></div>'
  }
  return `<div class="block"><div class="label">Policy comparison <span class="lab2">· ${esc(main.pair)}</span></div>${comparisonTable(main)}`
    + `<div class="links"><button class="cta" data-go="cmp:${esc(main.pair)}">Open with runs ›</button>${others.map((c) => `<button class="cta quiet" data-go="cmp:${esc(c.pair)}">${esc(c.pair)} ›</button>`).join('')}</div></div>`
}

function biggest(v: AnalyticsView): string {
  const line = (w: WorkstreamLine) =>
    `<button class="row" data-go="ws:${esc(w.id)}"><span class="nm"><span class="t">${esc(w.title)}</span>${chipPartial(w.coverage)}${chipResult(w.result)}</span><span class="tk" data-tip="${esc(`Whole run. ${tok(w.inWindow)} of it was recorded inside the window.`)}">${tok(w.spend.total)}</span><span class="cs">${costTxt(w.spend)}</span></button>`
  const run = v.workstreams.running
  return `<div class="block"><div class="label">Biggest workstreams <span class="lab2">· finished ${windowSay(v.window)}, whole run</span></div>`
    + `<div class="rows">${v.workstreams.top.map(line).join('') || '<div class="note">No workstream finished in this window.</div>'}</div>`
    + (run.count ? `<div class="tail">${run.count} running · ${tok(run.spend.total)} so far</div>` : '') + '</div>'
}

function usageScreen(v: AnalyticsView, ui: UsageUi): string {
  const slot = slots(v)
  const head = `<div class="vhead"><h1>Usage</h1><span class="grow"></span>${winSeg(ui)}</div>`
  const none = v.strip.tokens.total === 0 && v.rows.every((r) => r.n === 0 && r.running === 0) && v.workstreams.finished === 0
  if (none) return `${head}${emptyState(v)}`
  const filling = v.backfill.state === 'running' ? `<div class="banner" role="note"><b>Still filling in.</b><span>${esc(backfillText(v.backfill))}. Older numbers will grow.</span></div>` : ''
  return `${head}${filling}${strip(v, ui, slot)}${perDay(v, ui, slot)}${kinds(v, slot)}${leadOverhead(v)}${policy(v)}${biggest(v)}`
}

// ---------- one row's tasks ----------

function taskRow(t: AnalyticsTask): string {
  const retry = t.attempt > 0 || t.retryOf ? `<span class="chip">retry${t.attempt ? ` ${t.attempt}` : ''}</span>` : ''
  return `<button class="row" data-go="ws:${esc(t.workstream.id)}"><span class="nm"><span class="t">${esc(t.title)}</span><span class="wsn">${esc(t.workstream.title)}</span>${retry}${chipResult(t.result)}</span><span class="tk">${tok(t.spend.total)}</span><span class="cs">${costTxt(t.spend)}</span></button>`
}

function kindScreen(v: AnalyticsView, id: string, ui: UsageUi, backTo: string): string {
  const r = v.rows.find((x) => x.id === id)
  const slot = slots(v)
  if (!r) return `<div class="vhead">${back(backTo)}</div><div class="note">This row is not in the current Settings → Models.</div>`
  const figs = !r.n
    ? '<span>No finished tasks in this window.</span>'
    : r.few
      ? `<span><b>${r.n}</b> finished</span><span>few tasks: no medians yet</span>`
      : `<span><b>${r.n}</b> finished</span><span>median ${tok(r.medianTokens ?? 0)} tokens</span><span>${r.medianCost == null ? 'no estimate' : `≈ ${usd(r.medianCost)}`}</span>${r.failedOrRetried != null ? `<span>${pct(r.failedOrRetried)} failed or retried</span>` : ''}`
  const details = ui.details && r.tasks.length
    ? `<div class="details"><div class="tw"><table class="u"><thead><tr><th>Task</th><th>Dispatched as</th><th>Ran on</th><th>Time</th></tr></thead><tbody>${r.tasks.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.dispatchedAs)}</td><td>${t.model ? esc(modelLabel(t.model)) : '<span class="ne">unknown</span>'}${t.fallback ? ' (fallback)' : ''}</td><td>${dur(t.durationMs)}</td></tr>`).join('')}</tbody></table></div>`
      + '<div class="note">The row is the one Orca Flow’s routing picked from what routes.jsonl records: kind or type, one row up for high risk, at least normal for large context, one more per retry.</div></div>'
    : ''
  return `<div class="vhead">${back(backTo)}<span class="grow"></span>${winSeg(ui)}</div>`
    + `<div class="block"><div class="vhead"><h1>${esc(r.name)}</h1>${rowModel(r, slot)}${r.fallback ? `<span class="note">fallback ${esc(r.fallback)}</span>` : ''}</div><div class="figline">${figs}</div></div>`
    + `<div class="block"><div class="rows">${r.tasks.map(taskRow).join('')}</div>${r.running ? `<div class="tail">${r.running} running</div>` : ''}${r.tasks.length ? detailsBtn(ui) + details : ''}</div>`
}

// ---------- one workstream ----------

const cats = (s: Spend) => `<td>${full(s.in)}</td><td>${full(s.cacheRead)}</td><td>${full(s.cacheWrite5m + s.cacheWrite1h)}</td><td>${full(s.out)}</td><td>${full(s.total)}</td>`

function wsScreen(w: WorkstreamDetail | null | undefined, v: AnalyticsView | null, ui: UsageUi, backTo: string): string {
  if (w === undefined) return `<div class="vhead">${back(backTo)}</div><div class="note">Reading the workstream…</div>`
  if (!w) return `<div class="vhead">${back(backTo)}</div><div class="note">This workstream is not known any more.</div>`
  const slot = v ? slots(v) : (id: string | null) => (id ? 's0' : 'sx')
  const tip = (r: WorkstreamRow) => [r.session ? `Session ${r.session}` : 'Its session was never seen: no usage recorded for it.', r.continuedIn ? `Continued in ${r.continuedIn}: each session keeps the usage it spent.` : '', r.result === 'failed' ? 'Failed its checks.' : '', r.fallback ? 'The row’s fallback ran.' : '', r.spend.total && !r.model ? 'The log had no model id: counted, no price.' : ''].filter(Boolean).join('\n')
  const rows = w.rows.map((r) => {
    const name = r.who === 'lead' ? r.label : r.title
    const kb = r.rowName ? `<span class="kb" data-tip="Task kind as dispatched → the Settings → Models row it ran on">${esc(`${r.dispatchedAs ?? ''}${r.rowName && r.dispatchedAs !== r.rowName ? ` → ${r.rowName}` : ''}`.replace(/^ → /, ''))}</span>` : ''
    return `<div class="row" data-tip="${esc(tip(r))}"><span class="nm">${badge(slot, r.model)}<span class="t">${esc(name)}</span>${r.who === 'retry' ? '<span class="chip">retry</span>' : ''}${kb}${r.result === 'failed' ? '<span class="chip bad">failed</span>' : ''}</span><span class="tk">${tok(r.spend.total)}</span><span class="cs">${costTxt(r.spend)}</span></div>`
  }).join('')
  const result = w.result === 'accepted' ? '<span class="ok">accepted</span>' : w.result === 'failed' ? '<span class="ko">failed</span>' : w.result === 'running' ? '<span>running</span>' : '<span>finished, no result reported</span>'
  const hand = w.rows.find((r) => r.continuedIn && r.who === 'lead')
  const details = ui.details
    ? `<div class="details"><div class="tw"><table class="u"><thead><tr><th>Who</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Total</th></tr></thead><tbody>${w.rows.map((r) => `<tr><td>${esc(r.who === 'lead' ? r.label : r.title)}</td>${cats(r.spend)}</tr>`).join('')}<tr class="sum"><td>Whole run</td>${cats(w.spend)}</tr></tbody></table></div>`
      + `<div class="note">Each provider session is counted once (deduped by session and message id); worker usage rolls up here, never into the lead row.${hand ? ' The lead continued in a new session; each keeps what it spent.' : ''}${w.partial ? ` Only ${Math.round(w.coverage * 100)} % of this run was recorded.` : ''}</div>`
      + `<div class="tw"><table class="u"><thead><tr><th>Model</th><th>Total</th><th>Est. cost</th></tr></thead><tbody>${w.byModel.map((m) => `<tr><td>${esc(m.label)}</td><td>${full(m.spend.total)}</td><td>${costTxt(m.spend)}</td></tr>`).join('')}</tbody></table></div></div>`
    : ''
  return `<div class="vhead">${back(backTo)}</div>`
    + `<div class="block"><div class="vhead"><h1>${esc(w.title)}</h1>${chipPartial(w.coverage)}</div>`
    + `<div class="figline"><span><b>${tok(w.spend.total)}</b> tokens</span><span>${w.spend.total === 0 ? '–' : `≈ ${costTxt(w.spend)}`}</span>${w.wallMs ? `<span>${dur(w.wallMs)}</span>` : ''}${result}</div></div>`
    + `<div class="block"><div class="rows">${rows}</div>${detailsBtn(ui)}${details}</div>`
    + (w.pair ? `<div><button class="cta" data-go="cmp:${esc(w.pair.id)}">Compare ${esc(w.pair.arm)} with the other arm ›</button></div>` : '')
}

// ---------- one comparison ----------

function cmpScreen(v: AnalyticsView, pair: string, ui: UsageUi, backTo: string): string {
  const c = v.comparisons.find((x) => x.pair === pair)
  if (!c) return `<div class="vhead">${back(backTo)}</div><div class="note">This pair has no run in the current window. Try a longer window.</div>`
  const rows = c.runs.map((r) => `<tr><td><button class="linkish" data-go="ws:${esc(r.workstream)}">${esc(r.arm)} · ${esc(r.title)} · ${dateOf(r.finishedAt)}</button></td><td>${full(r.spend.total)}</td><td>${costTxt(r.spend)}</td><td>${dur(r.wallMs)}</td><td>${r.result === 'accepted' ? 'passed' : r.result === 'failed' ? 'failed' : r.result}</td><td>${Math.round(r.coverage * 100)} %</td></tr>`).join('')
  const details = ui.details
    ? `<div class="details"><div class="tw"><table class="u"><thead><tr><th>Run</th><th>Tokens</th><th>Est. cost</th><th>Time</th><th>Checks</th><th>Recorded</th></tr></thead><tbody>${rows}</tbody></table></div>`
      + '<div class="note">Per accepted run = all tokens of the arm, failed runs and retries included, ÷ runs that passed. Time = median of runs that passed. Change = variant − baseline: negative means cheaper or faster.</div></div>'
    : ''
  return `<div class="vhead">${back(backTo)}</div>`
    + `<div class="block"><div class="label">Did the delegation change help?</div><h1 class="h1s">${esc(c.pair)}</h1></div>`
    + `<div class="block">${comparisonTable(c)}${detailsBtn(ui)}${details}</div>`
}

// ---------- the page ----------

const screenName = (s: Screen, d: UsageData) =>
  s.view === 'usage' ? 'Usage' : s.view === 'kind' ? (d.view?.rows.find((r) => r.id === s.id)?.name ?? 'Task kind') : s.view === 'ws' ? (d.ws[s.id]?.title ?? 'Workstream') : 'Comparison'

/** The whole Usage tab for the current screen. */
export function usagePage(d: UsageData, ui: UsageUi): string {
  const cur = ui.stack[ui.stack.length - 1] ?? { view: 'usage' as const }
  const backTo = ui.stack.length > 1 ? screenName(ui.stack[ui.stack.length - 2], d) : 'Usage'
  const foot = d.view
    ? `<div class="foot"><span data-tip="${esc(d.view.prices.tip)}">Estimated ${ESTIMATE_NOTE}; prices ${esc(d.view.prices.version)}, ${esc(d.view.prices.dated)}</span><span>Recorded from the agents’ logs, kept 90 days</span></div>`
    : ''
  const err = d.error ? `<div class="banner" role="alert"><b>Could not read usage.</b><span>${esc(d.error)}</span></div>` : ''
  if (!d.view) return `${err}${d.error ? '' : '<div class="note">Reading usage…</div>'}`
  const body = cur.view === 'kind' ? kindScreen(d.view, cur.id, ui, backTo)
    : cur.view === 'ws' ? wsScreen(d.ws[cur.id], d.view, ui, backTo)
      : cur.view === 'cmp' ? cmpScreen(d.view, cur.id, ui, backTo)
        : usageScreen(d.view, ui)
  return `${err}${body}${foot}`
}
