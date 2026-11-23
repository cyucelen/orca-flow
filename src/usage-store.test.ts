// The usage store: dedupe (replays, reopen, read-time), retention and pruning, coverage, the
// one-time backfill and its marker.
import { assert, test } from 'orca/testing'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyHistory, logRoots, logsToRead, readLogs, type Cursor, type Usage } from './token-speed.ts'
import {
  backfillSlice, decodeUsage, encodeUsage, flushUsage, hashKey, monthOf, openUsageStore, pruneUsage, readBackfill, readCoverage, readUsage,
  recordUsage, RETENTION_MS, startBackfill, writeBackfill
} from './usage-store.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-23T12:00:00.000Z')
const tmp = () => mkdtempSync(join(tmpdir(), 'usage-store-'))

const obs = (id: string, end: number, extra: Partial<Usage> = {}): Usage => ({
  provider: 'claude', session: 's1', id, model: 'claude-opus-5-5', start: end - 5000, end, in: 3, cacheRead: 20_000, cacheWrite5m: 100, cacheWrite1h: 50, out: 400, ...extra
})

test('a record survives the file form; bad lines are no records', () => {
  const u = obs('m1', NOW, { provider: 'codex', session: 'th', model: 'gpt-6.2-astra' })
  assert.deepEqual(decodeUsage(encodeUsage(u)), u)
  assert.ok(encodeUsage(u).length < 140)
  assert.equal(decodeUsage('not json'), null)
  assert.equal(decodeUsage('["other","s","i","m",1,2,0,0,0,0,0]'), null)
  assert.equal(monthOf(Date.parse('2026-11-30T23:59:59Z')), '2026-11')
  assert.notEqual(hashKey('claude\u0000s\u0000a'), hashKey('claude\u0000s\u0000b'))
  assert.ok(Number.isSafeInteger(hashKey('x')))
})

test('replayed lines count once: in one run, after a reopen, and across providers and sessions apart', () => {
  const dir = tmp()
  try {
    const store = openUsageStore(dir, NOW)
    assert.equal(recordUsage(store, obs('m1', NOW - 60_000), NOW), true)
    assert.equal(recordUsage(store, obs('m1', NOW - 60_000), NOW), false) // the same response again before a flush
    assert.equal(recordUsage(store, obs('m1', NOW - 60_000, { session: 's2' }), NOW), true) // another session
    assert.equal(recordUsage(store, obs('m1', NOW - 60_000, { provider: 'codex' }), NOW), true)
    flushUsage(store, NOW)
    // A new worker: the month's keys are loaded, a resumed session's replayed lines are dropped.
    const again = openUsageStore(dir, NOW + 1000)
    assert.equal(recordUsage(again, obs('m1', NOW - 60_000), NOW + 1000), false)
    // An old month (a replay of a session from October) loads that month's keys when needed.
    assert.equal(recordUsage(again, obs('old', NOW - 40 * DAY), NOW + 1000), true)
    flushUsage(again, NOW + 1000)
    const third = openUsageStore(dir, NOW + 2000)
    assert.equal(third.index.has(monthOf(NOW - 40 * DAY)), false)
    assert.equal(recordUsage(third, obs('old', NOW - 40 * DAY), NOW + 2000), false)
    assert.deepEqual(readUsage(dir, NOW - 90 * DAY, NOW + DAY).map((u) => [u.provider, u.session, u.id]), [
      ['claude', 's1', 'old'], ['claude', 's1', 'm1'], ['claude', 's2', 'm1'], ['codex', 's1', 'm1']
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reading: a time range, oldest first, a duplicate that slipped onto disk once, and a crash\'s half line', () => {
  const dir = tmp()
  try {
    const store = openUsageStore(dir, NOW)
    recordUsage(store, obs('a', NOW - 3 * DAY), NOW)
    recordUsage(store, obs('b', NOW - 2 * DAY), NOW)
    flushUsage(store, NOW)
    const file = join(dir, 'usage', `${monthOf(NOW)}.jsonl`)
    // A duplicate written by a run that stopped before its cursors were saved, then a half line.
    appendFileSync(file, `${encodeUsage(obs('a', NOW - 3 * DAY, { out: 999 }))}\n["claude","s1","c`)
    const later = openUsageStore(dir, NOW)
    recordUsage(later, obs('d', NOW - DAY), NOW)
    flushUsage(later, NOW)
    assert.deepEqual(readUsage(dir, NOW - 10 * DAY, NOW).map((u) => [u.id, u.out]), [['a', 400], ['b', 400], ['d', 400]])
    assert.deepEqual(readUsage(dir, NOW - 2 * DAY, NOW - DAY).map((u) => u.id), ['b'])
    assert.deepEqual(readUsage(join(dir, 'none'), 0, NOW), [])
    assert.ok(!readFileSync(file, 'utf8').includes('secret'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retention: records past 90 days are not taken, and pruning drops old months, old lines and old coverage', () => {
  const dir = tmp()
  try {
    const t0 = NOW - 100 * DAY
    const store = openUsageStore(dir, t0)
    recordUsage(store, obs('ancient', NOW - 140 * DAY, { session: 'gone' }), t0) // July: its whole month goes
    recordUsage(store, obs('edge-old', NOW - 95 * DAY), t0) // in the month the cut falls in, before it
    recordUsage(store, obs('edge-new', NOW - 85 * DAY), t0) // the same month, after the cut
    flushUsage(store, t0)
    assert.equal(recordUsage(store, obs('late', NOW - 91 * DAY), NOW), false)
    assert.equal(readUsage(dir, 0, NOW).length, 3)
    pruneUsage(store, NOW)
    flushUsage(store, NOW)
    assert.deepEqual(readUsage(dir, 0, NOW).map((u) => u.id), ['edge-new'])
    assert.deepEqual([...readCoverage(dir).keys()], ['claude/s1'])
    assert.ok(NOW - 85 * DAY >= NOW - RETENTION_MS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('coverage: per provider session, the span of the responses read', () => {
  const dir = tmp()
  try {
    const store = openUsageStore(dir, NOW)
    recordUsage(store, obs('a', NOW - 10_000), NOW)
    recordUsage(store, obs('b', NOW - 50_000), NOW)
    recordUsage(store, obs('c', NOW - 20_000, { provider: 'codex', session: 'th' }), NOW)
    flushUsage(store, NOW)
    assert.deepEqual([...readCoverage(dir)], [['claude/s1', [NOW - 55_000, NOW - 10_000]], ['codex/th', [NOW - 25_000, NOW - 20_000]]])
    assert.equal(store.coverageDirty, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the live reader and the store: a log read again from its start records nothing twice', () => {
  const dir = tmp()
  try {
    const root = join(dir, '.claude', 'projects', 'p')
    mkdirSync(root, { recursive: true })
    const now = Date.now()
    const at = (ms: number) => new Date(now - 300_000 + ms).toISOString()
    const log = join(root, 'sess.jsonl')
    writeFileSync(log, [
      JSON.stringify({ type: 'user', timestamp: at(0) }),
      JSON.stringify({ type: 'assistant', sessionId: 'sess', message: { model: 'claude-opus-5-5', id: 'm1', usage: { input_tokens: 2, cache_read_input_tokens: 9000, output_tokens: 300 } }, timestamp: at(4000) }),
      JSON.stringify({ type: 'user', timestamp: at(5000) }),
      JSON.stringify({ type: 'assistant', sessionId: 'sess', message: { model: 'claude-opus-5-5', id: 'm2', usage: { input_tokens: 1, cache_read_input_tokens: 9400, output_tokens: 90 } }, timestamp: at(8000) }),
      ''
    ].join('\n'))
    const roots = logRoots([join(dir, '.claude')], [])
    const read = (store: ReturnType<typeof openUsageStore>) => {
      const cursors = new Map<string, Cursor>() // lost cursors: the log is read from its start again
      readLogs({ paths: logsToRead(roots, cursors, now, true), cursors, history: emptyHistory(), now, usage: (u) => recordUsage(store, u, now) })
      flushUsage(store, now)
    }
    const data = join(dir, 'data')
    read(openUsageStore(data, now))
    read(openUsageStore(data, now))
    assert.deepEqual(readUsage(data, 0, now + 1).map((u) => [u.session, u.id, u.in, u.cacheRead, u.out]), [['sess', 'm1', 2, 9000, 300], ['sess', 'm2', 1, 9400, 90]])
    const lines = readFileSync(join(data, 'usage', `${monthOf(now)}.jsonl`), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backfill: reads the logs of the last 90 days in slices, goes on after a restart, then never again', () => {
  const dir = tmp()
  try {
    const now = Date.now()
    const claude = join(dir, '.claude', 'projects', 'p')
    const codex = join(dir, '.codex', 'sessions', '2026', '10', '01')
    mkdirSync(claude, { recursive: true })
    mkdirSync(codex, { recursive: true })
    const at = (ago: number) => new Date(now - ago).toISOString()
    const claudeLog = (name: string, ago: number, ids: string[]) => {
      const path = join(claude, name)
      writeFileSync(path, ids.flatMap((id, k) => [
        JSON.stringify({ type: 'user', timestamp: at(ago - k * 10_000) }),
        JSON.stringify({ type: 'assistant', sessionId: name.replace('.jsonl', ''), message: { model: 'claude-opus-5-5', id, usage: { input_tokens: 5, output_tokens: 100 } }, timestamp: at(ago - k * 10_000 - 3000) })
      ]).join('\n') + '\n')
      const t = (now - ago) / 1000 + 60
      utimesSync(path, t, t)
    }
    claudeLog('a.jsonl', 30 * DAY, ['a1', 'a2'])
    claudeLog('b.jsonl', 10 * DAY, ['b1'])
    claudeLog('old.jsonl', 120 * DAY, ['x1']) // changed before the 90 days: not read
    const rollout = join(codex, 'rollout-2026-10-01T17-27-51-01a0f814-3e5d-75c1-8227-f84e3d64e09b.jsonl')
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: at(50 * DAY), type: 'turn_context', payload: { model: 'gpt-6.2-astra' } }),
      JSON.stringify({ timestamp: at(50 * DAY - 1000), type: 'token_usage_record', payload: { response_id: 'r1', usage: { input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 70 } } }),
      ''
    ].join('\n'))
    utimesSync(rollout, (now - 50 * DAY) / 1000, (now - 50 * DAY) / 1000)
    const roots = logRoots([join(dir, '.claude')], [join(dir, '.codex')])
    const data = join(dir, 'data')

    // A first worker reads one log and stops (a deadline already past ends each slice after a log).
    const store = openUsageStore(data, now)
    const record = (u: Usage) => recordUsage(store, u, now)
    const run = startBackfill(roots, readBackfill(data), now)!
    assert.equal(run.paths.length, 4)
    assert.equal(backfillSlice(run, record, now, 0), false)
    assert.equal(run.state.read.length, 1)
    flushUsage(store, now)
    writeBackfill(data, run.state)

    // The next goes on with the rest, and marks it done.
    const back = readBackfill(data)!
    assert.equal(back.done, false)
    assert.equal(back.horizon, now - RETENTION_MS)
    const store2 = openUsageStore(data, now)
    const run2 = startBackfill(roots, back, now)!
    assert.equal(run2.paths.length, 3)
    assert.equal(backfillSlice(run2, (u) => recordUsage(store2, u, now), now, Infinity), true)
    flushUsage(store2, now)
    writeBackfill(data, run2.state)
    assert.deepEqual(readUsage(data, 0, now).map((u) => [u.provider, u.session, u.id, u.in, u.cacheRead]).sort(), [
      ['claude', 'a', 'a1', 5, 0], ['claude', 'a', 'a2', 5, 0], ['claude', 'b', 'b1', 5, 0],
      ['codex', '01a0f814-3e5d-75c1-8227-f84e3d64e09b', 'r1', 1000, 8000]
    ])
    const done = readBackfill(data)!
    assert.equal(done.done, true)
    assert.deepEqual(done.read, [])
    assert.equal(startBackfill(roots, done, now + DAY), null) // the marker: never again
    assert.equal(readBackfill(join(dir, 'none')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
