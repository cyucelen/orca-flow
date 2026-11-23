// The Usage view's HTML over the shared fixture: every section, the states that must be visible
// (empty with backfill progress, partial, Unattributed, no estimate), navigation screens, escaping.
import { assert, test } from 'orca/testing'
import { analyticsView, buildModel, workstreamView } from './analytics.ts'
import { fixtureInputs, fixtureModel } from './analytics-fixture.ts'
import { backfillText, dur, tok, UNATTRIBUTED, usageLine, usagePage, usageUi, usd, type UsageData, type UsageUi } from './analytics-view.ts'
import { normalizeRouting } from './routing.ts'
import { tokenSpeedSection } from './token-speed-view.ts'
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

const wire = (over: Partial<TokenSpeedWire> = {}): TokenSpeedWire => ({
  now: 0, ready: true, tokPerSec: 85, net: null, internet: null, testing: false, testError: null, models: [],
  series: { '1h': { start: 0, step: 60_000, up: [], down: [], netSecs: 0, tok: {}, count: {} } as never, '24h': { start: 0, step: 60_000, up: [], down: [], netSecs: 0, tok: {}, count: {} } as never },
  usage: { days: 7, tokens: 52_400_000, cost: 48.2, unpriced: 0, prices: 'prices v1, 2026-11-03', tip: 'x' }, ...over
})

test('the sidebar section is Analytics: the speed glance kept, one usage line, a note when nothing opened', () => {
  const html = tokenSpeedSection(wire(), { speedFolded: false, speedRange: '1h', now: 0 })
  assert.match(html, /<span>Analytics<\/span>/)
  assert.ok(!html.includes('Token speed'))
  assert.match(html, /tok\/s/)
  assert.match(html, /Internet not tested yet/)
  assert.match(html, /<button class="uline" data-usage-open data-tip="at API list prices · not your bill\nprices v1, 2026-11-03"><span class="ut">This week <b>52.4M<\/b> tokens · ≈ \$48<\/span><span class="go">Usage ›<\/span><\/button>/)
  assert.ok(!html.includes('terr'), 'no note')
  const noted = tokenSpeedSection(wire(), { speedFolded: false, speedRange: '1h', now: 0, usageNote: 'Focus a workspace first: the Usage tab opens inside it.' })
  assert.match(noted, /role="alert">Focus a workspace first/)
  // folded: the glance and this week's tokens; not ready: the line is still there
  assert.match(tokenSpeedSection(wire(), { speedFolded: true, speedRange: '1h', now: 0 }), /85 tok\/s<span class="sepd">52.4M this week/)
  assert.match(tokenSpeedSection(wire({ ready: false }), { speedFolded: false, speedRange: '1h', now: 0 }), /data-usage-open/)
  // no usage store: no line, the rest as before
  assert.ok(!tokenSpeedSection(wire({ usage: null }), { speedFolded: false, speedRange: '1h', now: 0 }).includes('data-usage-open'))
})
