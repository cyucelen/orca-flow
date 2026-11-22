// The Token speed section as a pure function: the worker's TokenSpeedWire and the section's UI state
// in, HTML out (no DOM, no Node), so it is tested in Node and the panel imports it as is.
//
// A headline (all agents' output tok/s over the last minute, their traffic, the last internet test
// with its Test button), two small charts on one time axis (output tok/s per model; agent traffic as
// a share of the tested connection, or in kbit/s before any test: never two scales on one chart),
// then one row per model with its median speed over the last hour and the last 24 h.
import type { SpeedRange, SpeedSeries, TokenSpeedWire } from './token-speed.ts'

/** Where the panel keeps the section's fold and range (plugin storage). */
export const SPEED_UI_KEY = 'speed-ui'
export type SpeedUi = { speedFolded: boolean; speedRange: SpeedRange; now: number }
export function speedUiOf(stored: unknown): { folded: boolean; range: SpeedRange } {
  const s = (stored ?? {}) as { folded?: unknown; range?: unknown }
  return { folded: s.folded === true, range: s.range === '24h' ? '24h' : '1h' }
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

/** A round top for the y scale: 1, 2 or 5 times a power of ten, at or above `v`. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p
}

const W = 300
const H = 48
const PAD = 2

/** Polylines of one series (a gap where a value is null), on a 0..max scale. */
function path(values: (number | null)[], max: number): string {
  const n = values.length
  const runs: string[] = []
  let run: string[] = []
  values.forEach((v, k) => {
    if (v == null) { if (run.length) runs.push(run.join(' ')); run = []; return }
    const x = n > 1 ? (k / (n - 1)) * W : W / 2
    const y = H - PAD - (Math.min(v, max) / max) * (H - 2 * PAD)
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (run.length) runs.push(run.join(' '))
  return runs.map((points) => (points.includes(' ') ? `M${points.replace(/ /g, 'L')}` : `M${points}h0.1`)).join('')
}

type Line = { key: string; cls: string; values: (number | null)[]; dashed?: boolean }

/** One chart: a quiet baseline and midline, the lines, the y top and the ends of the time axis, and a hover column per bucket. */
function chart(input: { title: string; unit: string; lines: Line[]; s: SpeedSeries; tips: string[]; range: SpeedRange; fmt: (v: number) => string }): string {
  const top = niceMax(Math.max(0, ...input.lines.flatMap((l) => l.values.filter((v): v is number => v != null))))
  const svg = `<svg class="tsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
    + `<path class="tgrid" d="M0 ${H / 2}H${W}"/><path class="tbase" d="M0 ${H - 0.5}H${W}"/>`
    + input.lines.map((l) => `<path class="tline ${l.cls}${l.dashed ? ' dashed' : ''}" d="${path(l.values, top)}"/>`).join('')
    + '</svg>'
  const cols = `<div class="tcols">${input.tips.map((t) => `<i data-tip="${esc(t)}"></i>`).join('')}</div>`
  return `<div class="tchart"><div class="thead"><span>${esc(input.title)}</span><span class="tmax">${esc(input.fmt(top))} ${esc(input.unit)}</span></div>`
    + `<div class="tplot">${svg}${cols}</div>`
    + `<div class="taxis"><span>${input.range === '1h' ? '1 h ago' : '24 h ago'}</span><span>now</span></div></div>`
}

/** The time a bucket covers, for its tooltip: "14:05" for a minute, "14:00–14:15" for a quarter hour. */
const bucketTime = (s: SpeedSeries, k: number) => {
  const t = s.start + k * s.step
  return s.step > 60_000 ? `${clock(t)}–${clock(t + s.step)}` : clock(t)
}

export function tokenSpeedSection(d: TokenSpeedWire | null, ui: SpeedUi): string {
  if (!d) return ''
  const folded = ui.speedFolded
  const net = d.net ? { up: bits(d.net.up), down: bits(d.net.down) } : null
  const netText = net ? `↑${net.up.value} ↓${net.down.value} ${net.down.unit === net.up.unit ? net.up.unit : `${net.up.unit}/${net.down.unit}`}` : ''
  const fold = `<button class="label lfold" data-tfold aria-expanded="${!folded}">${CHEV}<span>Token speed</span></button>`
  const right = folded
    ? `<span class="foldsum">${esc(round(d.tokPerSec))} tok/s${netText ? `<span class="sepd">${esc(netText)}</span>` : ''}</span>`
    : `<span class="seg" role="group" aria-label="Range">${(['1h', '24h'] as const).map((r) => `<button data-trange="${r}" aria-pressed="${r === ui.speedRange}">${r}</button>`).join('')}</span>`
  const head = `<div class="sechead">${fold}${right}</div>`
  if (folded) return head

  const stats = `<div class="tstats">`
    + `<div class="tstat" data-tip="Output tokens per second over the last minute, summed over every agent; a response counts once it is written to its log"><b>${esc(round(d.tokPerSec))}</b><span>tok/s</span><small>agents, last min</small></div>`
    + `<div class="tstat" data-tip="${esc(d.net ? `Network traffic of ${d.net.procs} agent ${d.net.procs === 1 ? 'process' : 'processes'} over the last 30 s sample (nettop)` : 'The first 30 s traffic sample is still running')}">${net ? `<b>↑${esc(net.up.value)} ↓${esc(net.down.value)}</b><span>${esc(net.down.unit)}</span>` : '<b>…</b>'}<small>agent traffic</small></div>`
    + '</div>'

  const i = d.internet
  const test = d.testing
    ? '<span class="rstatus pending"><span class="refreshing"></span>testing…</span>'
    : `<button class="act pill ttest" data-ttest data-tip="Runs networkQuality (about 25 s and 100+ MB of traffic)">Test</button>`
  const internet = `<div class="tnet">${i
    ? `<span class="tnetv" data-tip="${esc(`Internet, tested ${new Date(i.at).toLocaleString()}${i.rpm != null ? ` · responsiveness ${Math.round(i.rpm)} RPM` : ''}`)}">Internet ↓${esc(mbit(i.down))} ↑${esc(mbit(i.up))} Mbit/s${i.rtt != null ? ` · ${esc(Math.round(i.rtt))} ms` : ''}</span><span class="tago">tested ${esc(ago(i.at, ui.now))}</span>`
    : '<span class="tnetv muted">Internet not tested yet</span>'}${test}</div>${d.testError && !d.testing ? `<div class="terr" role="alert">${esc(d.testError)}</div>` : ''}`

  if (!d.ready) return `${head}${stats}${internet}<div class="empty">Reading the last 24 h of agent logs…</div>`

  const s = d.series[ui.speedRange]
  const slotOf = new Map(d.models.map((m) => [m.id, m]))
  const ids = Object.keys(s.tok).sort((a, b) => (slotOf.get(a)?.slot ?? 99) - (slotOf.get(b)?.slot ?? 99))
  const n = s.up.length
  const labelOf = (id: string) => slotOf.get(id)?.label ?? id
  const tokLines: Line[] = ids.map((id) => ({ key: id, cls: slotClass(slotOf.get(id)?.slot ?? SLOTS), values: s.tok[id] }))
  const tokTips = Array.from({ length: n }, (_, k) => {
    const parts = ids.map((id) => [labelOf(id), s.tok[id][k] ?? 0] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    return `${bucketTime(s, k)} · ${parts.length ? parts.map(([l, v]) => `${l} ${round(v)}`).join(' · ') + ' tok/s' : 'no output'}`
  })
  const tokChart = ids.length
    ? chart({ title: 'Output tok/s', unit: 'tok/s', lines: tokLines, s, tips: tokTips, range: ui.speedRange, fmt: round })
      + `<div class="tlegend">${ids.map((id) => `<span><i class="tdot ${slotClass(slotOf.get(id)?.slot ?? SLOTS)}"></i>${esc(labelOf(id))}</span>`).join('')}</div>`
    : `<div class="empty">No agent output in the last ${ui.speedRange === '1h' ? 'hour' : '24 h'}</div>`

  // Traffic: a share of the tested connection when there is a test, else kbit/s.
  const share = (v: number | null, cap: number) => (v == null ? null : Math.round((v / cap) * 100 * 1000) / 1000)
  const down = i ? s.down.map((v) => share(v, i.down)) : s.down.map((v) => (v == null ? null : v / 1000))
  const up = i ? s.up.map((v) => share(v, i.up)) : s.up.map((v) => (v == null ? null : v / 1000))
  const pct = (v: number) => (v >= 1 ? round(v) : v >= 0.01 ? String(Math.round(v * 100) / 100) : v > 0 ? '<0.01' : '0')
  const fmt = i ? pct : round
  const unit = i ? '%' : 'kbit/s'
  const netTips = Array.from({ length: n }, (_, k) => s.down[k] == null
    ? `${bucketTime(s, k)} · not sampled`
    : `${bucketTime(s, k)} · ↓${bits(s.down[k]!).value} ↑${bits(s.up[k] ?? 0).value} ${bits(s.down[k]!).unit}${i ? ` · ${pct(down[k] ?? 0)} % / ${pct(up[k] ?? 0)} % of the connection` : ''}`)
  const netChart = s.down.some((v) => v != null)
    ? chart({ title: i ? 'Agent traffic, % of internet' : 'Agent traffic', unit, lines: [{ key: 'down', cls: 'tdown', values: down }, { key: 'up', cls: 'tup', values: up, dashed: true }], s, tips: netTips, range: ui.speedRange, fmt })
      + `<div class="tlegend"><span><i class="tdash tdown"></i>down</span><span><i class="tdash tup dashed"></i>up</span>${i ? '' : '<span class="muted">Test to see a share of your connection</span>'}</div>`
    : ''

  const value = (v: number | null) => (v == null ? '<span class="muted">–</span>' : esc(round(v)))
  const rows = d.models.map((m) => `<tr data-tip="${esc(`${m.id} · ${m.count1h} responses in the last hour, ${m.count24h} in 24 h · ${Math.round(m.tokens24h).toLocaleString('en-US')} output tokens in 24 h`)}"><td class="tm"><i class="tdot ${slotClass(m.slot)}"></i><span>${esc(m.label)}</span></td><td>${value(m.median1h)}</td><td>${value(m.median24h)}</td><td class="muted">${esc(m.count24h.toLocaleString('en-US'))}</td></tr>`).join('')
  const table = d.models.length
    ? `<table class="tmodels"><thead><tr><th>Model</th><th data-tip="Median tok/s of one response over the last hour">1 h</th><th data-tip="Median tok/s of one response over the last 24 h">24 h</th><th data-tip="Responses in the last 24 h">resp.</th></tr></thead><tbody>${rows}</tbody></table>`
    : ''
  return `${head}${stats}${internet}${tokChart}${netChart}${table}`
}
