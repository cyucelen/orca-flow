// The Usage view's HTML over the shared fixture: every section, the states that must be visible
// (empty with backfill progress, partial, Unattributed, no estimate), navigation screens, escaping.
import { assert, test } from 'orca/testing'
import { analyticsView, buildModel, workstreamView } from './analytics.ts'
import { fixtureInputs, fixtureModel } from './analytics-fixture.ts'
import { axisLabels, backfillText, dayColumns, dur, niceTop, tok, UNATTRIBUTED, usageLine, usagePage, usageUi, usd, type UsageData, type UsageUi } from './analytics-view.ts'
import { normalizeRouting } from './routing.ts'
import { tokenSpeedSection, type SpeedUi, type SpeedUsage } from './token-speed-view.ts'
import type { AnalyticsWindow } from './protocol.ts'
import type { TokenSpeedWire } from './token-speed.ts'

const model = fixtureModel()
const view = (w: AnalyticsWindow = '7d') => analyticsView(model, w, { state: 'done', read: 0, total: 0 })
const ui = (over: Partial<UsageUi> = {}): UsageUi => ({ ...usageUi(), ...over })
const page = (w: AnalyticsWindow = '7d', over: Partial<UsageUi> = {}, ws: UsageData['ws'] = {}) => usagePage({ view: view(w), ws }, ui({ window: w, ...over }))
const clean = (html: string) => {
  assert.ok(!/undefined|NaN|Infinity|\[object/.test(html), 'no stray values')
  // Balanced tags: every opened div, table and button is closed.
  for (const tag of ['div', 'table', 'button', 'tr']) assert.equal((html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length, (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length, `${tag} balanced`)
}

test('formatting: tokens, dollars and durations', () => {
  assert.equal(tok(52_400_000), '52.4M')
  assert.equal(tok(8_300), '8.3K')
  assert.equal(tok(412), '412')
  assert.equal(tok(0), '0')
  assert.equal(usd(48.2), '$48')
  assert.equal(usd(4.821), '$4.82')
  assert.equal(usd(0.001), '<$0.01')
  assert.equal(usd(1240), '$1,240')
  assert.equal(dur(45_000), '45 s')
  assert.equal(dur(125 * 60_000), '2 h 05 min')
  assert.equal(dur(null), '–')
  assert.deepEqual(usageLine({ tokens: 52_400_000, cost: 48.2, unpriced: 0 }), { tokens: '52.4M', cost: '≈ $48' })
  assert.equal(usageLine({ tokens: 1000, cost: 0, unpriced: 1000 }).cost, 'no estimate')
  assert.equal(usageLine({ tokens: 1000, cost: 2, unpriced: 10 }).cost, '≈ $2.00+')
})

test('the Usage screen has every block of the draft, in the order of the goal', () => {
  const html = page('7d')
  clean(html)
  const at = ['Tokens · 7 days', 'By task kind', 'Lead overhead', 'Policy comparison', 'Biggest workstreams'].map((t) => html.indexOf(t))
  assert.ok(at.every((i) => i >= 0), `all blocks present: ${at}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'strip, kinds, lead overhead, comparison, biggest')
  assert.match(html, /Estimated at API list prices · not your bill/)
  assert.match(html, /aria-pressed="true">7 days/)
  for (const w of ['7 days', '30 days', 'All']) assert.ok(html.includes(`>${w}</button>`), w)
  // a row per Settings → Models row, Lead, and the visible leftovers
  for (const id of ['simple', 'normal', 'hard', 'browser-checks', 'lead', 'other', 'unrouted']) assert.ok(html.includes(`data-go="kind:${id}"`), id)
  assert.match(html, /few tasks/)
  assert.match(html, /fallback Claude Sonnet · low ran for 1 of 1/)
  // task titles, not ids, name the workstreams
  assert.match(html, /Permission prompts: ask once per session/)
  assert.ok(!html.includes('ctx_'))
})

test('states: partial, Unattributed, unknown model, no estimate, comparison and its gaps', () => {
  const html = page('30d')
  const billing = usagePage({ view: view('30d'), ws: { BL: workstreamView(model, 'BL') } }, ui({ window: '30d', stack: [{ view: 'usage' }, { view: 'ws', id: 'BL' }] }))
  assert.match(billing, /Partial \d+ %/, 'a partly recorded run says so')
  assert.match(billing, /Billing: invoices page, export and filters/)
  assert.ok(html.includes(`${UNATTRIBUTED}:`), 'the Unattributed bucket is visible')
  assert.equal(UNATTRIBUTED, 'Coordinators and plain terminals')
  assert.match(html, /Unknown model:/)
  assert.match(usagePage({ view: view('7d'), ws: { L: workstreamView(model, 'L') } }, ui({ stack: [{ view: 'usage' }, { view: 'ws', id: 'L' }] })), /no estimate/, 'a Codex task has no price')
  assert.match(usagePage({ view: view('30d'), ws: {} }, ui({ window: '30d', stack: [{ view: 'usage' }, { view: 'cmp', id: 'p2' }] })), /Not comparable:.*model/s, 'p2: the models changed')
  assert.match(html, /data-go="cmp:p2"/, 'the other pair is a link')
  assert.match(html, /same models/)
  // no price anywhere: the strip says no estimate, not $0
  const codexOnly = buildModel({ ...fixtureInputs(), usage: fixtureInputs().usage.filter((u) => u.provider === 'codex' || u.model === 'gpt-6.2-astra') })
  const only = usagePage({ view: analyticsView(codexOnly, 'all', { state: 'done', read: 0, total: 0 }), ws: {} }, ui({ window: 'all' }))
  assert.match(only, /no estimate API list prices|no estimate at API list prices/)
  clean(only)
})

test('empty: no records yet says so, with the backfill progress', () => {
  const empty = buildModel({ now: Date.now(), usage: [], coverage: new Map(), links: [], routes: [], routing: normalizeRouting(undefined) })
  const running = usagePage({ view: analyticsView(empty, '7d', { state: 'running', read: 12, total: 340 }), ws: {} }, ui())
  clean(running)
  assert.match(running, /Analytics starts recording now; backfill reading 12 of 340 logs/)
  assert.match(running, /never messages/)
  assert.ok(!running.includes('By task kind'), 'no empty tables')
  assert.match(backfillText({ state: 'pending', read: 0, total: 0 }), /begins after the first read/)
  assert.match(backfillText({ state: 'done', read: 0, total: 0 }), /from now on/)
  // a view with data while the backfill still runs says older numbers will grow
  const filling = usagePage({ view: analyticsView(model, '7d', { state: 'running', read: 3, total: 10 }), ws: {} }, ui())
  assert.match(filling, /Still filling in/)
  assert.match(filling, /backfill reading 3 of 10 logs/)
})

test('loading and failure: a quiet line, or the error, never a half page', () => {
  assert.match(usagePage({ view: null, ws: {} }, ui()), /Reading usage/)
  const failed = usagePage({ view: null, ws: {}, error: 'worker stopped' }, ui())
  assert.match(failed, /Could not read usage/)
  assert.match(failed, /worker stopped/)
})

test('a row opens its tasks, a task its workstream, back goes up one; Details are behind a toggle', () => {
  const kind = usagePage({ view: view('7d'), ws: {} }, ui({ stack: [{ view: 'usage' }, { view: 'kind', id: 'hard' }] }))
  clean(kind)
  assert.match(kind, /<h1>Hard<\/h1>/)
  assert.match(kind, /data-back><svg[^>]*>.*?<span>Usage<\/span>/)
  assert.match(kind, /Escalate high-risk edits to Opus/)
  assert.match(kind, /data-go="ws:L"/)
  assert.ok(!kind.includes('Dispatched as'), 'details closed')
  const open = usagePage({ view: view('7d'), ws: {} }, ui({ details: true, stack: [{ view: 'usage' }, { view: 'kind', id: 'hard' }] }))
  assert.match(open, /Dispatched as/)
  assert.match(open, /normal, high risk/)

  const ws = workstreamView(model, 'L')!
  const html = usagePage({ view: view('7d'), ws: { L: ws } }, ui({ stack: [{ view: 'usage' }, { view: 'kind', id: 'hard' }, { view: 'ws', id: 'L' }] }))
  clean(html)
  assert.match(html, /<span>Hard<\/span>/, 'back is labelled with the screen it returns to')
  assert.match(html, /<h1>Permission prompts: ask once per session<\/h1>/)
  assert.match(html, /Lead, after handover/)
  assert.match(html, /retry/)
  assert.match(html, /Compare variant with the other arm/)
  const withDetails = usagePage({ view: view('7d'), ws: { L: ws } }, ui({ details: true, stack: [{ view: 'usage' }, { view: 'ws', id: 'L' }] }))
  clean(withDetails)
  assert.match(withDetails, /Cache read/)
  assert.match(withDetails, /Whole run/)
  // not known, and not fetched yet
  assert.match(usagePage({ view: view(), ws: { X: null } }, ui({ stack: [{ view: 'usage' }, { view: 'ws', id: 'X' }] })), /not known any more/)
  assert.match(usagePage({ view: view(), ws: {} }, ui({ stack: [{ view: 'usage' }, { view: 'ws', id: 'X' }] })), /Reading the workstream/)
})

test('a comparison screen: the four rows with their change, the runs behind Details', () => {
  const html = usagePage({ view: view('30d'), ws: {} }, ui({ window: '30d', stack: [{ view: 'usage' }, { view: 'cmp', id: 'p1' }] }))
  clean(html)
  assert.match(html, /Tokens per accepted run/)
  assert.match(html, /Runs that passed/)
  assert.ok(!html.includes('<th>Run</th>'))
  const open = usagePage({ view: view('30d'), ws: {} }, ui({ window: '30d', details: true, stack: [{ view: 'usage' }, { view: 'cmp', id: 'p1' }] }))
  assert.match(open, /<th>Run<\/th>/)
  assert.match(usagePage({ view: view('7d'), ws: {} }, ui({ stack: [{ view: 'usage' }, { view: 'cmp', id: 'nope' }] })), /no run in the current window/)
})

test('task titles are escaped', () => {
  const m = buildModel({ ...fixtureInputs(), titles: { 'task-L': '<img src=x onerror=1> & "co"' } })
  const html = usagePage({ view: analyticsView(m, '7d', { state: 'done', read: 0, total: 0 }), ws: {} }, ui())
  assert.ok(!html.includes('<img'))
  assert.match(html, /&lt;img src=x onerror=1&gt; &amp; &quot;co&quot;/)
})

// ---------- the sidebar section ----------

/** Seven days ending 2026-11-23, the busiest on the 19th, today with a Codex share (no price). */
const WEEK = [3, 5, 4, 9, 6, 0, 2].map((m, k) => ({ start: new Date(2026, 10, 17 + k).getTime(), tokens: m * 1e6, cost: m * 0.9, unpriced: k === 6 ? 500_000 : 0 }))
/** The section with its usage block for the fixture's 7 days. */
const side = (over: Partial<SpeedUi> = {}, usage: Partial<SpeedUsage> = {}): SpeedUi => ({ speedFolded: false, speedRange: '1h', now: 0, usage: { view: view('7d'), window: '7d', metric: 'tokens', details: false, ...usage }, ...over })
const wire = (over: Partial<TokenSpeedWire> = {}): TokenSpeedWire => ({
  now: 0, ready: true, tokPerSec: 85, net: null, internet: null, models: [],
  series: { '1h': { start: 0, step: 60_000, up: [], down: [], netSecs: 0, tok: {}, count: {} } as never, '24h': { start: 0, step: 60_000, up: [], down: [], netSecs: 0, tok: {}, count: {} } as never },
  usage: { days: 7, tokens: 52_400_000, cost: 48.2, unpriced: 0, prices: 'prices v1, 2026-11-03', tip: 'x', daily: WEEK }, ...over
})

test('the sidebar section is Analytics: the speed glance kept, usage in the section itself, no Usage page link', () => {
  const html = tokenSpeedSection(wire(), side())
  assert.match(html, /<span>Analytics<\/span>/)
  assert.ok(!html.includes('Token speed'))
  assert.match(html, /tok\/s/)
  assert.match(html, /Internet not tested yet/)
  assert.ok(!html.includes('data-usage-open') && !html.includes('Usage ›'), 'no link to a separate page')
  // folded: the glance and this week's tokens, no usage block
  const folded = tokenSpeedSection(wire(), side({ speedFolded: true }))
  assert.match(folded, /85 tok\/s<span class="sepd">52.4M this week/)
  assert.ok(!folded.includes('class="usb"'))
  // not ready (speed): usage is still there
  assert.match(tokenSpeedSection(wire({ ready: false }), side()), /class="usb"/)
  // no usage block asked: the rest as before
  assert.ok(!tokenSpeedSection(wire(), { speedFolded: false, speedRange: '1h', now: 0 }).includes('class="usb"'))
})

// ---------- usage per day ----------

const cols = (html: string) => (html.match(/class="uccol"/g) ?? []).length

test('Usage tab: a per-day chart under the strip, one column per day, stacked in the strip\'s model colors', () => {
  for (const w of ['7d', '30d', 'all'] as const) {
    const html = page(w)
    clean(html)
    assert.ok(html.includes('Usage per day'))
    assert.equal(cols(html), view(w).daily.length, `${w}: a column per day`)
    assert.ok(html.indexOf('Usage per day') > html.indexOf('class="strip"') && html.indexOf('Usage per day') < html.indexOf('By task kind'), 'between the strip and the routing table')
  }
  const html = page('7d')
  assert.ok(/data-metric="tokens" aria-pressed="true"/.test(html), 'tokens by default')
  assert.ok(html.includes('Today'), 'today is labeled')
  assert.ok(html.includes('today so far'), 'and its tooltip says it is still filling')
  assert.equal((html.match(/class="uccap"/g) ?? []).length, 1, 'only the busiest day carries its value')
  assert.ok(/class="uclegend"><span><i class="dot s0">/.test(html), 'a legend in the strip\'s order')
})

test('Usage tab: Est. cost measures the estimate on its own axis, says what has no price, and Details gives a table', () => {
  const html = page('7d', { metric: 'cost' })
  clean(html)
  assert.ok(/data-metric="cost" aria-pressed="true"/.test(html))
  assert.ok(html.includes('estimated at API list prices'))
  assert.ok(/<span class="ucg" style="top:0%"><b>\$/.test(html), 'the axis is in dollars')
  assert.ok(html.includes('not in the estimate'), 'the Codex tokens with no price are named')
  const details = page('7d', { details: true })
  clean(details)
  assert.ok(details.includes('<th>Est. cost</th>'))
  assert.ok(details.includes('(so far)'), 'today first, still filling')
})

test('day columns: nice tops, thinned axis labels with today always labeled, empty days draw no bar', () => {
  assert.equal(niceTop(8.2e6), 1e7)
  assert.equal(niceTop(623), 800)
  assert.equal(niceTop(0), 1)
  const days = Array.from({ length: 30 }, (_, k) => new Date(2026, 9, 25 + k).getTime())
  const labels = axisLabels(days, true)
  assert.equal(labels[29], 'Today')
  assert.ok(labels.filter(Boolean).length <= 11 && labels.filter(Boolean).length >= 8)
  assert.deepEqual(axisLabels(days.slice(-3), false), ['Sat', 'Sun', 'Today'])
  const html = dayColumns([{ start: 0, total: 0, parts: [], tip: 'a', label: '' }, { start: 1, total: 5, parts: [{ cls: 's0', value: 5 }], tip: 'b', label: 'Today' }], { metric: 'tokens' })
  assert.equal((html.match(/class="ucbar"/g) ?? []).length, 1)
})

test('sidebar usage: the window toggle, the strip, per day with tokens or $, and a narrow Details table', () => {
  for (const w of ['7d', '30d', 'all'] as const) {
    const html = tokenSpeedSection(wire(), side({}, { view: view(w), window: w }))
    clean(html)
    assert.ok(new RegExp(`data-uwin="${w}" aria-pressed="true"`).test(html), `${w} pressed`)
    assert.equal(cols(html), view(w).daily.length, `${w}: a column per day`)
    assert.ok(html.includes('class="strip"') && html.includes('Model share') && html.includes('Input from cache') && html.includes('Most expensive task'))
  }
  const html = tokenSpeedSection(wire(), side())
  assert.ok(html.indexOf('class="usb"') > html.indexOf('class="tnet"'), 'speed & traffic first, usage at the bottom')
  assert.ok(/data-umetric="tokens" aria-pressed="true"/.test(html) && html.includes(' tokens over 7 days'))
  // Each part's controls stand on its own header; the section's header only folds.
  const sechead = html.slice(0, html.indexOf('</div>'))
  assert.ok(!sechead.includes('data-trange') && !sechead.includes('data-uwin'), 'no controls on the section header')
  const usageHead = html.indexOf('<span class="thead">Usage</span>'), speedHead = html.indexOf('Speed &amp; traffic')
  assert.ok(usageHead > 0 && usageHead < html.indexOf('data-uwin') && html.indexOf('data-umetric') < html.indexOf('class="uchart'), 'window and measure on the Usage header, above the chart')
  assert.ok(speedHead < usageHead && speedHead < html.indexOf('data-trange') && html.indexOf('data-trange') < html.indexOf('class="tnet"'), '1h / 24h on the Speed & traffic header, above the internet line and the speed charts')
  // One headline for the section: today's tokens and estimate beside tok/s and traffic, above both parts.
  const stats = html.slice(html.indexOf('class="tstats"'), html.indexOf('class="tsub'))
  assert.ok(html.indexOf('class="tstats"') < speedHead, 'the headline comes first')
  assert.match(stats, /<b>2.00M<\/b><span>tokens<\/span><small>today so far<\/small>/)
  assert.match(stats, /<b>≈ \$1.80\+<\/b><span><\/span><small>est. cost today<\/small>/)
  assert.ok(stats.indexOf('today so far') < stats.indexOf('tok/s') && stats.indexOf('tok/s') < stats.indexOf('agent traffic'), 'today, then tok/s and traffic')
  assert.ok(!/data-act=|data-win=|data-metric=/.test(html), 'the panel\'s own attributes only')
  assert.ok(/class="uchart side"/.test(html))
  const cost = tokenSpeedSection(wire(), side({}, { metric: 'cost' }))
  assert.ok(cost.includes(' est. over 7 days') && /data-umetric="cost" aria-pressed="true"/.test(cost))
  assert.ok(cost.includes('not in the estimate'))
  const details = tokenSpeedSection(wire(), side({}, { details: true }))
  clean(details)
  assert.ok(/data-udetails aria-expanded="true"/.test(details))
  assert.ok(details.includes('<th>Day</th><th>Total</th><th>Output</th><th>Est. cost</th>'), 'four columns fit 340 px')
  assert.ok(details.includes('(so far)') && /<tr data-tip="input [\d,]+ · cache read/.test(details), 'all four categories in each row\'s tooltip')
  // states: still reading, a failed read, nothing recorded yet
  assert.ok(tokenSpeedSection(wire(), side({}, { view: null })).includes('Reading usage…'))
  assert.ok(tokenSpeedSection(wire(), side({}, { view: null, error: 'boom' })).includes('Could not read usage: boom'))
  const empty = analyticsView(buildModel({ now: Date.now(), usage: [], coverage: new Map(), links: [], routes: [], routing: normalizeRouting(undefined) }), '7d', { state: 'running', read: 3, total: 9 })
  assert.ok(tokenSpeedSection(wire(), side({}, { view: empty })).includes('backfill reading 3 of 9 logs'))
})
