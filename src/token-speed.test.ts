// The Token speed section: log parsing (Claude Code, Codex), incremental reads, bucket math, nettop
// and networkQuality output, the panel's view and its HTML.
import { assert, test } from 'orca/testing'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addNet, addResponse, agentPids, binRate, claudeLine, codexLine, decodeCursors, decodeHistory, emptyHistory, encodeCursors, encodeHistory,
  flushStale, histogramMedian, isSpeedFile, logRoots, logsToRead, modelLabel, newCursor, parseNettop, parseNetworkQuality, prune, rateBin,
  readAppended, readLogs, readSpeedStore, socketDelta, speedView, writeSpeedStore, type Cursor, type Response
} from './token-speed.ts'
import { ago, bits, chart, niceMax, speedUiOf, tokenSpeedSection } from './token-speed-view.ts'

const T0 = Date.parse('2026-11-22T12:00:00.000Z')
const iso = (ms: number) => new Date(T0 + ms).toISOString()
const MIN = 60_000

const user = (ms: number, text = 'secret prompt') => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: iso(ms) })
const assistant = (ms: number, id: string, out: number, model = 'claude-opus-5-5', text = 'secret answer') =>
  JSON.stringify({ type: 'assistant', message: { model, id, content: [{ type: 'text', text }], usage: { input_tokens: 3, output_tokens: out, cache_read_input_tokens: 1000 } }, timestamp: iso(ms) })

const run = (kind: 'claude' | 'codex', lines: string[], now = T0 + 3_600_000) => {
  const c = newCursor(kind)
  const out: Response[] = []
  for (const l of lines) (kind === 'claude' ? claudeLine : codexLine)(c, l, (r) => out.push(r))
  flushStale(c, now, (r) => out.push(r))
  return { c, out }
}

// ---------- Claude Code ----------

test('a Claude response runs from the user line before it to its last line, with the last output count', () => {
  const { out } = run('claude', [user(0), assistant(1000, 'm1', 10), assistant(4000, 'm1', 300), user(5000), assistant(7000, 'm2', 100)])
  assert.deepEqual(out, [
    { model: 'claude-opus-5-5', out: 300, start: T0, end: T0 + 4000 },
    { model: 'claude-opus-5-5', out: 100, start: T0 + 5000, end: T0 + 7000 }
  ])
})

test('parallel tool results between one response\'s blocks do not split it', () => {
  const { out } = run('claude', [user(0), assistant(1000, 'm1', 50), user(1500), assistant(2000, 'm1', 50), user(2500), assistant(6000, 'm1', 50), user(6500), assistant(9000, 'm2', 80)])
  assert.deepEqual(out.map((r) => [r.out, r.start - T0, r.end - T0]), [[50, 0, 6000], [80, 6500, 9000]])
})

test('back-to-back responses: the next starts where the last ended', () => {
  const { out } = run('claude', [user(0), assistant(2000, 'a', 60), assistant(5000, 'b', 90)])
  assert.deepEqual(out.map((r) => [r.start - T0, r.end - T0]), [[0, 2000], [2000, 5000]])
})

test('skips <synthetic>, responses over 10 minutes, and other line types; keeps no content', () => {
  const { out, c } = run('claude', [
    JSON.stringify({ type: 'summary', summary: 'x' }), 'not json',
    user(0), assistant(1000, 's', 5, '<synthetic>'),
    user(2000), assistant(2000 + 601_000, 'long', 9000),
    user(700_000), assistant(701_000, 'ok', 70)
  ])
  assert.deepEqual(out.map((r) => r.out), [70])
  assert.ok(!JSON.stringify(c).includes('secret'))
})

test('the last response is kept open until a minute passes with nothing after it', () => {
  const lines = [user(0), assistant(1000, 'm', 120)]
  assert.equal(run('claude', lines, T0 + 30_000).out.length, 0)
  assert.equal(run('claude', lines, T0 + 62_000).out.length, 1)
  // Its late lines after a stale flush are ignored, not counted twice.
  const c = newCursor('claude')
  const out: Response[] = []
  for (const l of lines) claudeLine(c, l, (r) => out.push(r))
  flushStale(c, T0 + 62_000, (r) => out.push(r))
  claudeLine(c, assistant(63_000, 'm', 200), (r) => out.push(r))
  flushStale(c, T0 + 200_000, (r) => out.push(r))
  assert.equal(out.length, 1)
})

// ---------- Codex ----------

const cx = (ms: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: iso(ms), type, payload })
const ev = (ms: number, payload: Record<string, unknown>) => cx(ms, 'event_msg', payload)
const item = (ms: number, payload: Record<string, unknown>) => cx(ms, 'response_item', payload)
const usage = (out: number) => ({ input_tokens: 9000, cached_input_tokens: 8000, output_tokens: out })

test('Codex: a token_usage_record ends a response that started at the input before it (not at the token_count)', () => {
  const { out } = run('codex', [
    cx(0, 'turn_context', { model: 'gpt-6.2-astra', cwd: '/secret' }),
    ev(0, { type: 'task_started' }),
    item(100, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'secret' }] }),
    item(4000, { type: 'reasoning' }),
    item(9100, { type: 'custom_tool_call', input: 'secret' }),
    cx(9200, 'token_usage_record', { usage: usage(270) }),
    ev(9300, { type: 'item_completed' }),
    item(9900, { type: 'custom_tool_call_output', output: 'secret' }),
    ev(9901, { type: 'token_count', info: { last_token_usage: usage(270) } }),
    item(15_000, { type: 'function_call' }),
    cx(15_100, 'token_usage_record', { usage: usage(52) })
  ])
  assert.deepEqual(out, [
    { model: 'gpt-6.2-astra', out: 270, start: T0 + 100, end: T0 + 9200 },
    { model: 'gpt-6.2-astra', out: 52, start: T0 + 9900, end: T0 + 15_100 }
  ])
})

test('Codex without token_usage_record: the token_count after a tool output ends the response at its last output item', () => {
  const { out } = run('codex', [
    cx(0, 'turn_context', { model: 'gpt-6-astra' }),
    ev(0, { type: 'user_message', message: 'secret' }),
    item(3000, { type: 'reasoning' }),
    item(5000, { type: 'function_call' }),
    item(8000, { type: 'function_call_output' }),
    ev(8001, { type: 'token_count', info: { last_token_usage: usage(100) } }),
    ev(8002, { type: 'token_count', info: null })
  ])
  assert.deepEqual(out, [{ model: 'gpt-6-astra', out: 100, start: T0, end: T0 + 5000 }])
})

// ---------- incremental reads ----------

const tmp = () => mkdtempSync(join(tmpdir(), 'token-speed-'))

test('reads only what a log gained, waits for a half-written line, and starts over after a truncation', () => {
  const dir = tmp()
  try {
    const file = join(dir, 's.jsonl')
    const out: Response[] = []
    const emit = (r: Response) => out.push(r)
    const c = newCursor('claude')
    const size = (text: string) => new TextEncoder().encode(text).length
    let text = `${user(0)}\n${assistant(1000, 'm1', 70)}\n`
    writeFileSync(file, text)
    assert.equal(readAppended(file, c, size(text), emit), true)
    assert.equal(c.offset, size(text))
    assert.equal(out.length, 0) // still open
    const half = user(2000).slice(0, 20)
    appendFileSync(file, half)
    text += half
    readAppended(file, c, size(text), emit)
    assert.equal(c.offset, size(text) - size(half)) // the partial line waits
    appendFileSync(file, `${user(2000).slice(20)}\n${assistant(3000, 'm2', 90)}\n`)
    text += `${user(2000).slice(20)}\n${assistant(3000, 'm2', 90)}\n`
    readAppended(file, c, size(text), emit)
    assert.deepEqual(out.map((r) => r.out), [70]) // m1 closed by m2
    assert.equal(c.offset, size(text))
    // Replaced by a shorter file: read again from its start, with a fresh parse state.
    const again = `${user(10_000)}\n${assistant(12_000, 'n1', 55)}\n${user(13_000)}\n`
    writeFileSync(file, again)
    readAppended(file, c, size(again), emit)
    flushStale(c, T0 + 200_000, emit)
    assert.equal(c.offset, size(again))
    assert.deepEqual(out.map((r) => r.out), [70, 55])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLogs: a new log is read from its start, one untouched for a day from its end; a deadline stops and resumes', () => {
  const dir = tmp()
  try {
    const root = join(dir, '.claude', 'projects')
    mkdirSync(join(root, 'p', 'sess', 'subagents'), { recursive: true })
    const now = Date.now()
    const line = (ms: number, id: string) => `${JSON.stringify({ type: 'user', timestamp: new Date(now - 120_000 + ms).toISOString() })}\n${JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', id, usage: { output_tokens: 80 } }, timestamp: new Date(now - 118_000 + ms).toISOString() })}\n`
    writeFileSync(join(root, 'p', 'a.jsonl'), line(0, 'a'))
    writeFileSync(join(root, 'p', 'sess', 'subagents', 'agent-1.jsonl'), line(5000, 'b'))
    writeFileSync(join(root, 'p', 'notes.txt'), 'x')
    const roots = logRoots([join(dir, '.claude'), join(dir, '.claude'), join(dir, 'missing')], [join(dir, '.codex')])
    assert.equal(roots.length, 1)
    const cursors = new Map<string, Cursor>()
    const h = emptyHistory()
    const paths = logsToRead(roots, cursors, now, true)
    assert.equal(paths.length, 2)
    const first = readLogs({ paths, cursors, history: h, now, deadline: 0 })
    assert.equal(first.next, 1) // stopped after one file
    const rest = readLogs({ paths, from: first.next, cursors, history: h, now })
    assert.equal(rest.next, 2)
    assert.equal(first.responses + rest.responses, 2)
    // A day later nothing new: the fast path only looks at logs touched in the last hour.
    assert.equal(logsToRead(roots, cursors, now + 2 * 3_600_000, false).length, 0)
    // A log seen first when it was last touched over 24 h ago starts at its end.
    const later = new Map<string, Cursor>()
    const late = readLogs({ paths, cursors: later, history: emptyHistory(), now: now + 24.5 * 3_600_000 })
    assert.equal(late.responses, 0)
    assert.equal(late.readBytes, 0)
    assert.equal(later.size, 2)
    for (const c of later.values()) assert.ok(c.offset > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- buckets ----------

test('a response\'s tokens spread over the minutes it ran; it counts once, in the minute it ended', () => {
  const h = emptyHistory()
  const now = T0 + 10 * MIN
  // 90 s from 12:00:30 to 12:02:00: a third in each of 12:00, 12:01 (two thirds), none in 12:02.
  addResponse(h, { model: 'claude-opus-5-5', out: 900, start: T0 + 30_000, end: T0 + 120_000 }, now)
  assert.equal(Math.round(h.minutes.get(T0)!.tok[0]), 300)
  assert.equal(Math.round(h.minutes.get(T0 + MIN)!.tok[0]), 600)
  assert.equal(h.minutes.get(T0 + 2 * MIN)?.n[0], 1)
  assert.equal(h.minutes.get(T0)?.n[0] ?? 0, 0)
  // Its rate (10 tok/s) is in the last hour's and its hour's histograms.
  assert.equal(Math.round(binRate(rateBin(10))), 10)
  assert.ok(Math.abs(histogramMedian(h.hours.get(T0)!.get(0)!)! - 10) < 0.3)
  // Short responses count but stay out of the medians; old ones are not kept.
  addResponse(h, { model: 'claude-opus-5-5', out: 5, start: T0 + 200_000, end: T0 + 201_000 }, now)
  addResponse(h, { model: 'claude-opus-5-5', out: 500, start: T0 - 26 * 3_600_000, end: T0 - 25 * 3_600_000 + 1000 }, now)
  assert.equal([...h.hours.values()].reduce((s, m) => s + [...(m.get(0)?.values() ?? [])].reduce((a, b) => a + b, 0), 0), 1)
})

test('the histogram median is within 2.5 % of the exact one', () => {
  const bins = new Map<number, number>()
  const rates = [12, 40, 77, 80, 81, 200, 900]
  for (const r of rates) bins.set(rateBin(r), (bins.get(rateBin(r)) ?? 0) + 1)
  const m = histogramMedian(bins)!
  assert.ok(Math.abs(m - 80) / 80 < 0.025, String(m))
  assert.equal(histogramMedian(new Map()), null)
})

test('the view: tok/s over the last minute, medians, counts, series, traffic', () => {
  const h = emptyHistory()
  const now = T0 + 30 * MIN + 30_000 // halfway through the minute
  // 1200 tokens in the previous minute, 600 in this one: 600 * 1 + 1200 * 0.5 = 1200 tokens over 60 s.
  addResponse(h, { model: 'claude-opus-5-5', out: 1200, start: T0 + 29 * MIN, end: T0 + 30 * MIN }, now)
  addResponse(h, { model: 'claude-sonnet-5-5', out: 600, start: T0 + 30 * MIN + 1000, end: T0 + 30 * MIN + 11_000 }, now)
  addNet(h, { at: T0 + 29 * MIN + 50_000, up: 30_000, down: 15_000, secs: 30, procs: 4 })
  const v = speedView(h, now, { ready: true, testing: false, testError: null })
  assert.equal(v.tokPerSec, 20)
  assert.deepEqual(v.net, { at: T0 + 29 * MIN + 50_000, up: 8000, down: 4000, procs: 4 })
  assert.deepEqual(v.models.map((m) => [m.label, m.slot, m.median1h, m.count1h, m.count24h]), [['Opus 5.5', 0, 20, 1, 1], ['Sonnet 5.5', 1, 60, 1, 1]])
  assert.equal(v.series['1h'].up.length, 60)
  assert.equal(v.series['24h'].up.length, 96)
  assert.equal(v.series['1h'].tok['claude-opus-5-5'].reduce((a, b) => a + b, 0) * 60, 1200)
  assert.equal(v.series['1h'].up.filter((x) => x != null).length, 1)
  assert.ok(JSON.stringify(v).length < 16_000)
  // An hour on, the last-hour median and counts are empty; the 24 h ones stay.
  const later = speedView(h, now + 61 * MIN, { ready: true, testing: false, testError: null })
  assert.deepEqual(later.models.map((m) => [m.median1h, m.count1h, m.count24h]), [[null, 0, 1], [null, 0, 1]])
})

test('history and cursors survive a write and a read, compactly, and prune drops what is past 24 h', () => {
  const dir = tmp()
  try {
    const h = emptyHistory()
    const now = T0 + 2 * 3_600_000
    addResponse(h, { model: 'claude-opus-5-5', out: 800, start: T0, end: T0 + 10_000 }, now)
    addResponse(h, { model: 'gpt-6.2-astra', out: 300, start: T0 + 3_600_000, end: T0 + 3_610_000 }, now)
    addNet(h, { at: T0 + MIN, up: 1000, down: 500, secs: 30, procs: 2 })
    h.internet = { at: T0, down: 35_673_104, up: 20_522_772, rtt: 178, rpm: 58 }
    const cursors = new Map<string, Cursor>([['/x/p/a.jsonl', { kind: 'claude', offset: 99, mtime: now, user: T0, pend: null, done: 'm1' }], ['/x/old.jsonl', { kind: 'codex', offset: 5, mtime: T0 - 30 * 3_600_000 }]])
    writeSpeedStore(dir, { history: h, cursors }, now)
    const back = readSpeedStore(dir)
    assert.deepEqual(encodeHistory(back.history), encodeHistory(h))
    assert.deepEqual([...back.cursors!.keys()], ['/x/p/a.jsonl'])
    assert.deepEqual(back.cursors!.get('/x/p/a.jsonl'), { kind: 'claude', offset: 99, mtime: now, user: T0, done: 'm1' })
    assert.deepEqual(decodeCursors(encodeCursors(back.cursors!, now)), back.cursors)
    prune(h, T0 + 25 * 3_600_000)
    assert.deepEqual(h.models, ['claude-opus-5-5', 'gpt-6.2-astra']) // slots stay
    assert.deepEqual([...h.minutes.keys()], [T0 + 3_600_000])
    assert.equal(h.recent.size, 0)
    assert.equal(decodeHistory({ v: 2 }).models.length, 0)
    assert.equal(readSpeedStore(join(dir, 'none')).cursors, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the snapshot watcher ignores the speed files', () => {
  assert.ok(isSpeedFile('token-speed.json'))
  assert.ok(isSpeedFile('.token-speed-cursor.json.123.tmp'))
  assert.ok(!isSpeedFile('cards/x.json'))
  assert.ok(!isSpeedFile(null))
})

// ---------- network ----------

test('agent pids are the claude and codex executables', () => {
  const ps = '  1 /sbin/launchd\n 8339 /Users/u/.local/bin/claude\n 8400 claude\n 9001 /opt/codex\n 9002 /Applications/Claude.app/Contents/MacOS/Claude\n 9003 /x/chrome-native-host\n'
  assert.deepEqual([...agentPids(ps)], [8339, 8400, 9001])
})

test('nettop: the agents\' sockets past this machine, diffed between snapshots', () => {
  const csv = (claude: number, gone: boolean, fresh: boolean) => [
    ',bytes_in,bytes_out,',
    'launchd.1,0,0,',
    `2.1.330.8339,${claude},${claude},`,
    `tcp4 192.168.1.5:56077<->160.79.104.10:443,${1000 + claude},${2000 + claude},`,
    'tcp4 127.0.0.1:50843<->127.0.0.1:52879,900000,900000,',
    'tcp4 127.0.0.1:8770<->*:*,,,',
    ...(gone ? [] : ['tcp6 fe80::1.50000<->2a00::1.443,500,700,']),
    ...(fresh ? ['udp4 192.168.1.5:5353<->34.1.1.1:443,40,60,'] : []),
    'node.12,5,5,',
    'tcp4 192.168.1.5:1<->1.1.1.1:443,99,99,'
  ].join('\n')
  const pids = new Set([8339])
  const a = parseNettop(csv(0, false, false), pids, T0)
  assert.deepEqual([...a.sockets.keys()], ['8339 tcp4 192.168.1.5:56077<->160.79.104.10:443', '8339 tcp6 fe80::1.50000<->2a00::1.443'])
  // 30 s on: the first socket grew by 300 each way, the second closed, a third opened with 40 in, 60 out.
  const b = parseNettop(csv(300, true, true), pids, T0 + 30_000)
  assert.deepEqual(socketDelta(a, b), { up: 360, down: 340, procs: 1, secs: 30 })
  assert.equal(parseNettop('garbage', pids, T0).sockets.size, 0)
})

test('networkQuality -c: throughput in bit/s, base RTT and responsiveness', () => {
  const json = JSON.stringify({ base_rtt: 177.99, dl_throughput: 35673104, ul_throughput: 20522772, responsiveness: 57.66, end_date: '2026-11-22 18:13:15.783', il_h2_req_resp: [1, 2] })
  assert.deepEqual(parseNetworkQuality(json, T0), { at: T0, down: 35673104, up: 20522772, rtt: 177.99, rpm: 57.66 })
  assert.equal(parseNetworkQuality('{"dl_throughput":0}', T0), null)
  assert.equal(parseNetworkQuality('nope', T0), null)
})

// ---------- the section ----------

test('model labels', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5')
  assert.equal(modelLabel('claude-haiku-5'), 'Haiku 5')
  assert.equal(modelLabel('gpt-6.2-astra'), 'gpt-6.2-astra')
})

test('formatting helpers', () => {
  assert.deepEqual(bits(8000), { value: '8', unit: 'kbit/s' })
  assert.deepEqual(bits(931_000 * 8 / 60), { value: '124', unit: 'kbit/s' })
  assert.deepEqual(bits(35_700_000), { value: '36', unit: 'Mbit/s' })
  assert.equal(ago(T0 - 3 * 3_600_000, T0), '3h ago')
  assert.equal(ago(T0 - 10_000, T0), 'just now')
  // The y top: just above the highest value, with a round half.
  assert.deepEqual([350, 412, 623, 2127, 400, 0.035, 9].map(niceMax), [400, 500, 800, 3000, 400, 0.04, 10])
  assert.equal(niceMax(0), 1)
  assert.deepEqual(speedUiOf({ folded: true, range: '24h' }), { folded: true, range: '24h' })
  assert.deepEqual(speedUiOf(null), { folded: false, range: '1h' })
})

const wire = (over: Partial<ReturnType<typeof speedView>> = {}, netMinutes = 1) => {
  const h = emptyHistory()
  const now = T0 + 30 * MIN
  addResponse(h, { model: 'claude-opus-5-5', out: 1200, start: T0 + 29 * MIN, end: T0 + 30 * MIN }, now)
  addResponse(h, { model: '<b>odd</b>', out: 600, start: T0 + 20 * MIN, end: T0 + 20 * MIN + 5000 }, now)
  for (let m = 0; m < netMinutes; m++) {
    addNet(h, { at: T0 + (29 - m) * MIN, up: 3000, down: 1500, secs: 30, procs: 3 })
    addNet(h, { at: T0 + (29 - m) * MIN - 30_000, up: 3000, down: 1500, secs: 30, procs: 3 })
  }
  return { ...speedView(h, now, { ready: true, testing: false, testError: null }), ...over }
}
const ui = { speedFolded: false, speedRange: '1h' as const, now: T0 + 30 * MIN }

test('the section: headline, internet line with Test, the tokens chart read at a glance, model rows; names escaped', () => {
  const html = tokenSpeedSection(wire(), ui)
  assert.match(html, /data-tfold aria-expanded="true"/)
  assert.match(html, /data-trange="1h" aria-pressed="true"/)
  assert.match(html, /<b>20<\/b><span>tok\/s/) // 1200 tokens over the last minute
  assert.match(html, /↑0\.8 ↓0\.4/)
  assert.match(html, /Internet not tested yet/)
  assert.match(html, /data-ttest/)
  // A plain title, labeled gridlines (the top with its unit), the time axis at start, middle and now.
  assert.match(html, /<div class="thead">Tokens per second, all agents<\/div>/)
  assert.match(html, /<span class="ty" style="top:0%">20 tok\/s<\/span><span class="ty" style="top:50%">10<\/span><span class="ty" style="top:100%">0<\/span>/)
  assert.match(html, /<span>1 h ago<\/span><span>30 min ago<\/span><span>now<\/span>/)
  // With two models, an "all agents" line carries the latest value at the right end (here also its peak, so no peak label).
  assert.match(html, /<span class="tendv tall" style="top:0\.00%">20<\/span>/)
  assert.ok(!html.includes('class="tpeak'))
  assert.match(html, /all agents<\/span>/)
  // Hover: each bucket's time and every line's value.
  assert.match(html, /data-tip="\d\d:\d\d · all agents 20 tok\/s\nOpus 5\.5 20"/)
  assert.match(html, /Speed per response<br>\(median tok\/s\)/)
  assert.match(html, /<td class="tm"><i class="tdot s0"><\/i><span>Opus 5\.5/)
  assert.ok(!html.includes('<b>odd</b>'))
  assert.match(html, /&lt;b&gt;odd&lt;\/b&gt;/)
  assert.match(tokenSpeedSection(wire(), { ...ui, speedRange: '24h' }), /<span>24 h ago<\/span><span>12 h ago<\/span><span>now<\/span>/)
})

test('traffic: collecting until five minutes of samples, then a kbit/s chart with both latest values', () => {
  const early = tokenSpeedSection(wire(), ui)
  assert.match(early, /Agent network traffic \(kbit\/s\)/)
  assert.match(early, /Collecting traffic, ready in 4 min/) // one minute of samples so far
  assert.equal((early.match(/<div class="tcols">/g) ?? []).length, 1)
  const html = tokenSpeedSection(wire({}, 6), ui)
  assert.ok(!html.includes('Collecting traffic'))
  assert.equal((html.match(/<div class="tcols">/g) ?? []).length, 2)
  assert.match(html, /class="tendv tdown"[^>]*>↓0\.4</)
  assert.match(html, /class="tendv tup"[^>]*>↑0\.8</)
  assert.match(html, /<span class="ty" style="top:0%">0\.8 kbit\/s<\/span>/)
  assert.match(html, /Test to see a share/)
  assert.match(html, /data-tip="\d\d:\d\d · ↓0\.4 ↑0\.8 kbit\/s"/)
})

test('a chart labels its peak where it is, not when the peak is the latest point', () => {
  const s = { start: T0, step: MIN, tok: {}, up: [1, 2, 3, 4], down: [1, 2, 3, 4], netSecs: 600 }
  const line = (values: number[]) => ({ key: 'x', cls: 'tall', values, end: true })
  const html = chart({ title: 'T', unit: 'tok/s', lines: [line([10, 350, 40, 60])], s, tips: ['a', 'b', 'c', 'd'], range: '1h', fmt: (v) => String(v) })
  assert.match(html, /<span class="tpeak" style="left:33\.33%;top:12\.50%">peak 350<\/span>/)
  assert.match(html, />400 tok\/s</)
  assert.match(html, /class="tendv tall" style="top:85\.00%">60</)
  assert.ok(!chart({ title: 'T', unit: 'u', lines: [line([1, 2, 3, 9])], s, tips: [], range: '1h', fmt: String }).includes('tpeak'))
})

test('the section with a test: Mbit/s, latency, age, traffic as % of the connection; testing and failure', () => {
  const tested = wire({ internet: { at: T0 + 30 * MIN - 3 * 3_600_000, down: 35_673_104, up: 20_522_772, rtt: 178, rpm: 58 } }, 6)
  const html = tokenSpeedSection(tested, ui)
  assert.match(html, /Internet ↓35\.7 ↑20\.5 Mbit\/s · 178 ms/)
  assert.match(html, /tested 3h ago/)
  assert.match(html, /Agent network traffic \(% of your connection\)/)
  assert.match(html, /<span class="ty" style="top:0%">0\.004 %<\/span>/)
  assert.match(tokenSpeedSection({ ...tested, testing: true }, ui), /testing…/)
  assert.ok(!tokenSpeedSection({ ...tested, testing: true }, ui).includes('data-ttest'))
  assert.match(tokenSpeedSection({ ...tested, testError: 'The speed test failed: offline' }, ui), /class="terr"[^>]*>The speed test failed: offline/)
})

test('the section folded, still reading, and absent', () => {
  const folded = tokenSpeedSection(wire(), { ...ui, speedFolded: true })
  assert.match(folded, /aria-expanded="false"/)
  assert.match(folded, /20 tok\/s/)
  assert.ok(!folded.includes('tchart'))
  assert.match(tokenSpeedSection(wire({ ready: false }), ui), /Reading the last 24 h/)
  assert.equal(tokenSpeedSection(null, ui), '')
})

test('Settings → Features → Token Speed: off renders no section, folded or open; on is unchanged', () => {
  const on = tokenSpeedSection(wire(), ui)
  assert.equal(tokenSpeedSection(wire(), { ...ui, speedOff: false }), on)
  assert.equal(tokenSpeedSection(wire(), { ...ui, speedOff: true }), '')
  assert.equal(tokenSpeedSection(wire(), { ...ui, speedFolded: true, speedOff: true }), '')
})
