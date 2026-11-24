// The Analytics section (Token Speed's glance, kept, and the usage line) as a pure function: the worker's TokenSpeedWire and the section's UI state
// in, HTML out (no DOM, no Node), so it is tested in Node and the panel imports it as is.
//
// Top to bottom: Usage of the last 7 days, 30 days or all (analytics.view, asked by the panel): four
// figures (today's tokens and estimate, the window's tokens and estimate), then one column per day,
// in tokens or the estimate at API list prices, with a per-day table behind Details, and the model
// share, cache and priciest-task cells (src/analytics-view.ts sidebarUsage). Then, under a rule,
// Speed & traffic: the 1 h / 24 h range, all agents' output tok/s over the last minute and their
// traffic, the last internet test, two small charts on one time axis (output tok/s per model; agent
// traffic as a share of the tested connection, or in kbit/s before any test: never two scales on
// one chart), then one row per model with its median speed over the last hour and the last 24 h.
// No separate page.
import { dayName, ESTIMATE_NOTE, sidebarUsage, tok, usageLine, usageMetric, usd, type UsageMetric } from './analytics-view.ts'
import type { AnalyticsView, AnalyticsWindow } from './protocol.ts'
import type { SpeedRange, SpeedSeries, TokenSpeedWire } from './token-speed.ts'

/** Where the panel keeps the section's fold and range (plugin storage). */
export const SPEED_UI_KEY = 'speed-ui'
/** The usage block: the view the panel last got for its window (null: asked, not answered), and its toggles. */
export type SpeedUsage = { view: AnalyticsView | null; window: AnalyticsWindow; metric: UsageMetric; details: boolean; error?: string | null }
export type SpeedUi = { speedFolded: boolean; speedRange: SpeedRange; now: number; /** The usage block; absent: none. */ usage?: SpeedUsage; /** Settings → Features → Analytics is off: no section. */ speedOff?: boolean }
export function speedUiOf(stored: unknown): { folded: boolean; range: SpeedRange; metric: UsageMetric; window: AnalyticsWindow } {
  const s = (stored ?? {}) as { folded?: unknown; range?: unknown; metric?: unknown; window?: unknown }
  return { folded: s.folded === true, range: s.range === '24h' ? '24h' : '1h', metric: usageMetric(s.metric), window: s.window === '30d' || s.window === 'all' ? s.window : '7d' }
}


const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const CHEV = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2l3 3-3 3"/></svg>'
/** Series colors: the panel's categorical slots, in a fixed order; a model keeps its slot (first seen). */
export const SLOTS = 6
const slotClass = (slot: number) => (slot < SLOTS ? `s${slot}` : 'sx')

/** A whole number, or one decimal under 10: "412", "8.5", "0". */
export function round(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0'
  return v < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v))
}
/** bit/s as kbit/s, or Mbit/s from 10 Mbit/s up. */
export function bits(bps: number): { value: string; unit: string } {
  if (bps >= 10_000_000) return { value: round(bps / 1e6), unit: 'Mbit/s' }
  return { value: round(bps / 1000), unit: 'kbit/s' }
}
/** Mbit/s with one decimal under 100: "35.7", "940". */
export const mbit = (bps: number) => (bps >= 100e6 ? String(Math.round(bps / 1e6)) : String(Math.round(bps / 1e5) / 10))

/** "just now", "4m ago", "3h ago", "2d ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const clock = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The y scale's top: the first round number at or above the highest value whose half is round too
 * (1, 2, 3, 4, 5, 6, 8 or 10 times a power of ten): 350 → 400, 623 → 800, 2127 → 3000.
 */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const top = ([1, 2, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v * (1 - 1e-9)) ?? 10) * p
  return Number(top.toPrecision(6))
}

const W = 300
const H = 64
/** Minutes of traffic samples before the traffic chart draws a line. */
export const NET_READY_SECS = 300

/** Where value v of bucket k sits in the plot, in % of its width and height (0 % is the top). */
const at = (k: number, n: number, v: number, top: number) => ({
  x: n > 1 ? (k / (n - 1)) * 100 : 50,
  y: 100 - (Math.min(Math.max(v, 0), top) / top) * 100
})

/** Polylines of one series (a gap where a value is null), on a 0..top scale. */
function path(values: (number | null)[], top: number): string {
  const n = values.length
  const runs: string[] = []
  let run: string[] = []
  values.forEach((v, k) => {
    if (v == null) { if (run.length) runs.push(run.join(' ')); run = []; return }
    const p = at(k, n, v, top)
    run.push(`${((p.x / 100) * W).toFixed(1)},${((p.y / 100) * H).toFixed(1)}`)
  })
  if (run.length) runs.push(run.join(' '))
  return runs.map((points) => (points.includes(' ') ? `M${points.replace(/ /g, 'L')}` : `M${points}h0.1`)).join('')
}

/** One line of a chart; `end` puts its latest value as a number at the right end (`mark` before it, e.g. "↓"). */
export type Line = { key: string; cls: string; values: (number | null)[]; dashed?: boolean; end?: boolean; mark?: string }

/** The index and value of the latest non-null point. */
const last = (values: (number | null)[]) => {
  for (let k = values.length - 1; k >= 0; k--) if (values[k] != null) return { k, v: values[k]! }
  return null
}

const pos = (p: { x: number; y: number }) => `left:${p.x.toFixed(2)}%;top:${p.y.toFixed(2)}%`

/**
 * One chart, read at a glance: a plain title, gridlines at 0, half and the top labeled with their
 * values (the top with its unit), the lines, a dot on each line's latest point with the value of the
 * main ones beside the right end, the peak labeled where it is, the time axis at its start, middle
 * and now, and a hover column per bucket whose tooltip gives the time and every line's value.
 */
export function chart(input: { title: string; unit: string; lines: Line[]; s: SpeedSeries; tips: string[]; range: SpeedRange; fmt: (v: number) => string; peak?: Line[] }): string {
  const n = input.s.up.length
  const values = input.lines.flatMap((l) => l.values.filter((v): v is number => v != null))
  const top = niceMax(Math.max(0, ...values))
  const svg = `<svg class="tsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
    + `<path class="tgrid" d="M0 0.5H${W}M0 ${H / 2}H${W}"/><path class="tbase" d="M0 ${H - 0.5}H${W}"/>`
    + input.lines.map((l) => `<path class="tline ${l.cls}${l.dashed ? ' dashed' : ''}" d="${path(l.values, top)}"/>`).join('')
    + '</svg>'
  const yLabels = [[0, `${input.fmt(top)} ${input.unit}`], [50, input.fmt(top / 2)], [100, '0']]
    .map(([y, text]) => `<span class="ty" style="top:${y}%">${esc(text)}</span>`).join('')
  // The latest point of every line gets a dot; the main lines' values stand beside the right end,
  // pushed apart when they would overlap.
  const ends = input.lines.map((l) => ({ l, p: last(l.values) })).filter((e): e is { l: Line; p: { k: number; v: number } } => e.p != null)
  const dots = ends.filter((e) => e.l.end || e.p.v > 0).map(({ l, p }) => `<i class="tend ${l.cls}" style="${pos(at(p.k, n, p.v, top))}"></i>`).join('')
  const labels = ends.filter((e) => e.l.end).map(({ l, p }) => ({ l, v: p.v, y: at(p.k, n, p.v, top).y })).sort((a, b) => a.y - b.y)
  const GAP = 20
  for (let k = 1; k < labels.length; k++) labels[k].y = Math.max(labels[k].y, labels[k - 1].y + GAP)
  const over = labels.length ? labels[labels.length - 1].y - 100 : 0
  if (over > 0) for (const lab of labels) lab.y -= over
  const endLabels = labels.map(({ l, v, y }) => `<span class="tendv ${l.cls}" style="top:${y.toFixed(2)}%">${esc(`${l.mark ?? ''}${input.fmt(v)}`)}</span>`).join('')
  // The peak, where it is; not when it is the latest point (its value already stands at the end) or zero.
  let peak = ''
  let best: { k: number; v: number } | null = null
  for (const l of input.peak ?? input.lines) l.values.forEach((v, k) => { if (v != null && (!best || v > best.v)) best = { k, v } })
  const b = best as { k: number; v: number } | null
  if (b && b.v > 0 && !ends.some((e) => e.l.end && e.p.k === b.k)) {
    const p = at(b.k, n, b.v, top)
    // Beside the point, not above it, where it would cover the top gridline's label (top left) or leave the plot.
    const side = p.x < 30 && p.y < 35 ? ' beside' : p.x > 75 ? ' r' : p.x < 25 ? ' l' : ''
    peak = `<i class="tpk" style="${pos(p)}"></i><span class="tpeak${side}" style="${pos(p)}">peak ${esc(input.fmt(b.v))}</span>`
  }
  const cols = `<div class="tcols">${input.tips.map((t) => `<i data-tip="${esc(t)}"></i>`).join('')}</div>`
  const axis = input.range === '1h' ? ['1 h ago', '30 min ago', 'now'] : ['24 h ago', '12 h ago', 'now']
  return `<div class="tchart"><div class="thead">${esc(input.title)}</div>`
    + `<div class="tframe"><div class="tplot">${svg}${yLabels}${dots}${peak}${endLabels}${cols}</div>`
    + `<div class="taxis">${axis.map((t) => `<span>${esc(t)}</span>`).join('')}</div></div></div>`
}

/** The time a bucket covers, for its tooltip: "14:05" for a minute, "14:00–14:15" for a quarter hour. */
const bucketTime = (s: SpeedSeries, k: number) => {
  const t = s.start + k * s.step
  return s.step > 60_000 ? `${clock(t)}–${clock(t + s.step)}` : clock(t)
}

export function tokenSpeedSection(d: TokenSpeedWire | null, ui: SpeedUi): string {
  if (!d || ui.speedOff) return ''
  const folded = ui.speedFolded
  const net = d.net ? { up: bits(d.net.up), down: bits(d.net.down) } : null
  const netText = net ? `↑${net.up.value} ↓${net.down.value} ${net.down.unit === net.up.unit ? net.up.unit : `${net.up.unit}/${net.down.unit}`}` : ''
  const fold = `<button class="label lfold" data-tfold aria-expanded="${!folded}">${CHEV}<span>Analytics</span></button>`
  // Folded, the usage leads like the section does: "12.8M today · ≈ $11+"; the speed stands in until there is any.
  const today = d.usage?.daily?.[d.usage.daily.length - 1] ?? null
  const todayCost = !today ? '' : today.tokens === 0 ? '≈ $0' : today.unpriced > 0 && today.cost === 0 ? 'no estimate' : `≈ ${usd(today.cost)}${today.unpriced > 0 ? '+' : ''}`
  // The section's header only folds it: each part below has its own header with its own controls.
  const right = folded
    ? `<span class="foldsum">${today ? `${esc(tok(today.tokens))} today<span class="sepd">${esc(todayCost)}</span>` : `${esc(round(d.tokPerSec))} tok/s${netText ? `<span class="sepd">${esc(netText)}</span>` : ''}`}</span>`
    : ''
  const head = `<div class="sechead">${fold}${right}</div>`
  if (folded) return head
  // Speed & traffic: the 1 h / 24 h range sets its two charts and nothing else, so it stands on its header.
  const speedHead = `<div class="tsub"><span class="thead">Speed &amp; traffic</span><span class="seg sm" role="group" aria-label="Range of the speed and traffic charts">${(['1h', '24h'] as const).map((r) => `<button data-trange="${r}" aria-pressed="${r === ui.speedRange}">${r}</button>`).join('')}</span></div>`

  // Today's tokens and estimate (the usage store, today's calendar day so far): the first two of the Usage block's four figures.
  const todayStats = today
    ? `<div class="tstat" data-tip="${esc(`Tokens recorded today so far (${dayName(today.start)}), all four categories, every agent`)}"><b>${esc(tok(today.tokens))}</b><span>tokens</span><small>today so far</small></div>`
      + `<div class="tstat" data-tip="${esc(`Today's tokens ${ESTIMATE_NOTE}\n${d.usage!.prices}${today.unpriced > 0 ? `\n${tok(today.unpriced)} tokens have no price and are not in it` : ''}`)}"><b>${esc(todayCost)}</b><span></span><small>est. cost today</small></div>`
    : ''
  // Usage, first: today's and the window's figures, one column per day (an estimate, not a bill).
  const usage = ui.usage ? sidebarUsage(ui.usage.view, ui.usage, ui.usage.error, todayStats) : ''
  // Speed & traffic's figures, last: the agents' output tok/s and traffic right now.
  const stats = '<div class="tstats">'
    + `<div class="tstat" data-tip="Output tokens per second over the last minute, summed over every agent; a response counts once it is written to its log"><b>${esc(round(d.tokPerSec))}</b><span>tok/s</span><small>agents, last min</small></div>`
    + `<div class="tstat" data-tip="${esc(d.net ? `Network traffic of ${d.net.procs} agent ${d.net.procs === 1 ? 'process' : 'processes'} over the last 30 s sample (nettop)` : 'The first 30 s traffic sample is still running')}">${net ? `<b>↑${esc(net.up.value)} ↓${esc(net.down.value)}</b><span>${esc(net.down.unit)}</span>` : '<b>…</b>'}<small>agent traffic</small></div>`
    + '</div>'
  const i = d.internet
  const internet = `<div class="tnet">${i
    ? `<span class="tnetv" data-tip="${esc(`Internet, tested ${new Date(i.at).toLocaleString()}${i.rpm != null ? ` · responsiveness ${Math.round(i.rpm)} RPM` : ''}`)}">Internet ↓${esc(mbit(i.down))} ↑${esc(mbit(i.up))} Mbit/s${i.rtt != null ? ` · ${esc(Math.round(i.rtt))} ms` : ''}</span><span class="tago">tested ${esc(ago(i.at, ui.now))}</span>`
    : '<span class="tnetv muted">Internet not tested yet</span>'}</div>`

  if (!d.ready) return `${head}${usage}${speedHead}${stats}${internet}<div class="empty">Reading the last 24 h of agent logs…</div>`

  const s = d.series[ui.speedRange]
  const slotOf = new Map(d.models.map((m) => [m.id, m]))
  const ids = Object.keys(s.tok).sort((a, b) => (slotOf.get(a)?.slot ?? 99) - (slotOf.get(b)?.slot ?? 99))
  const n = s.up.length
  const labelOf = (id: string) => slotOf.get(id)?.label ?? id
  // One line per model and, with more than one, their sum: the chart is all agents' tokens per second.
  const modelLines: Line[] = ids.map((id) => ({ key: id, cls: slotClass(slotOf.get(id)?.slot ?? SLOTS), values: s.tok[id] }))
  const total = Array.from({ length: n }, (_, k) => Math.round(ids.reduce((sum, id) => sum + (s.tok[id][k] ?? 0), 0) * 10) / 10)
  const tokLines: Line[] = ids.length > 1 ? [...modelLines, { key: 'all', cls: 'tall', values: total, end: true }] : modelLines.map((l) => ({ ...l, end: true }))
  const tokTips = Array.from({ length: n }, (_, k) => {
    const parts = ids.map((id) => [labelOf(id), s.tok[id][k] ?? 0] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    if (!parts.length) return `${bucketTime(s, k)} · no output`
    return `${bucketTime(s, k)} · ${ids.length > 1 ? `all agents ${round(total[k])} tok/s\n` : ''}${parts.map(([l, v]) => `${l} ${round(v)}`).join(' · ')}${ids.length > 1 ? '' : ' tok/s'}`
  })
  const tokChart = ids.length
    ? chart({ title: 'Tokens per second, all agents', unit: 'tok/s', lines: tokLines, peak: [tokLines[tokLines.length - 1]], s, tips: tokTips, range: ui.speedRange, fmt: round })
      + `<div class="tlegend">${ids.length > 1 ? '<span><i class="tdash tall"></i>all agents</span>' : ''}${ids.map((id) => `<span><i class="tdot ${slotClass(slotOf.get(id)?.slot ?? SLOTS)}"></i>${esc(labelOf(id))}</span>`).join('')}</div>`
    : `<div class="empty">No agent output in the last ${ui.speedRange === '1h' ? 'hour' : '24 h'}</div>`

  // Traffic: a share of the tested connection when there is a test, else kbit/s. Under a few minutes
  // of samples there is no line yet: say when there will be.
  const share = (v: number | null, cap: number) => (v == null ? null : Math.round((v / cap) * 100 * 1000) / 1000)
  const down = i ? s.down.map((v) => share(v, i.down)) : s.down.map((v) => (v == null ? null : v / 1000))
  const up = i ? s.up.map((v) => share(v, i.up)) : s.up.map((v) => (v == null ? null : v / 1000))
  const pct = (v: number) => (v >= 1 ? round(v) : v > 0 ? String(Number(v.toPrecision(2))) : '0')
  const fmt = i ? pct : round
  const netTips = Array.from({ length: n }, (_, k) => s.down[k] == null
    ? `${bucketTime(s, k)} · not sampled`
    : `${bucketTime(s, k)} · ↓${round(s.down[k]! / 1000)} ↑${round((s.up[k] ?? 0) / 1000)} kbit/s${i ? `\n${pct(down[k] ?? 0)} % down, ${pct(up[k] ?? 0)} % up of your connection` : ''}`)
  const netLines: Line[] = [{ key: 'down', cls: 'tdown', values: down, end: true, mark: '↓' }, { key: 'up', cls: 'tup', values: up, dashed: true, end: true, mark: '↑' }]
  const netTitle = `Agent network traffic (${i ? '% of your connection' : 'kbit/s'})`
  const netChart = s.netSecs < NET_READY_SECS
    ? `<div class="tchart"><div class="thead">${esc(netTitle)}</div><div class="empty tcollect">Collecting traffic, ready in ${Math.max(1, Math.ceil((NET_READY_SECS - s.netSecs) / 60))} min</div></div>`
    : chart({ title: netTitle, unit: i ? '%' : 'kbit/s', lines: netLines, s, tips: netTips, range: ui.speedRange, fmt })
      + `<div class="tlegend"><span><i class="tdash tdown"></i>down</span><span><i class="tdash tup dashed"></i>up</span></div>`

  const value = (v: number | null) => (v == null ? '<span class="muted">–</span>' : esc(round(v)))
  const rows = d.models.map((m) => `<tr data-tip="${esc(`${m.id} · ${m.count1h} responses in the last hour, ${m.count24h} in 24 h · ${Math.round(m.tokens24h).toLocaleString('en-US')} output tokens in 24 h`)}"><td class="tm"><i class="tdot ${slotClass(m.slot)}"></i><span>${esc(m.label)}</span></td><td>${value(m.median1h)}</td><td>${value(m.median24h)}</td><td class="muted">${esc(m.count24h.toLocaleString('en-US'))}</td></tr>`).join('')
  // The medians are one response's speed, unlike the chart's sum over agents: the header says so.
  const table = d.models.length
    ? `<table class="tmodels"><thead><tr><th></th><th colspan="2" class="tgrp" data-tip="Output tokens per second of one response, from its prompt or tool result to its last block; half the responses were faster">Speed per response<br>(median tok/s)</th><th></th></tr>`
      + `<tr><th>Model</th><th>1 h</th><th>24 h</th><th data-tip="Responses in the last 24 h">Resp. 24 h</th></tr></thead><tbody>${rows}</tbody></table>`
    : ''
  // Usage first, then Speed & traffic at the bottom.
  return `${head}${usage}${speedHead}${stats}${internet}${tokChart}${netChart}${table}`
}
