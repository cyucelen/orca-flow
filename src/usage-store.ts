// The usage store: every model response's token usage, per provider session, kept 90 days. It is the
// data Analytics is built on (docs/analytics-brief.md §3, §4 "Duplicates", §6).
//
// - Records come from the Token speed reader (token-speed.ts), which reads the agents' logs once for
//   both: a usage observation per completed response. Only ids, model, times and token counts are
//   stored; no content.
// - Files: ~/.orca-flow/usage/YYYY-MM.jsonl, append-only, one compact JSON array per response:
//   [provider, session, id, model, start, end, in, cacheRead, cacheWrite5m, cacheWrite1h, out]
//   (times in ms; the month is the UTC month of `end`). Appends happen once per log sample.
// - Dedupe: provider + session + id. Each month's keys are held as 53-bit hashes, the current month's
//   always (loaded from its file on start) and an older month's only while records for it arrive (a
//   resumed session replaying old lines, the backfill), so a replay is dropped before it is written.
//   readUsage dedupes again by the full key, so a duplicate that slipped in (a crash between append
//   and cursor save) still counts once.
// - Retention: records older than 90 days are dropped on the way in, and pruneUsage removes them from
//   disk (whole month files, and the lines of the month the cut falls in).
// - Coverage: usage/coverage.json holds, per provider session, the time span of the responses read
//   from its logs ([first start, last end]), so Analytics can tell a run whose logs were never read
//   (rotated, deleted, older than the backfill) from one that spent nothing.
// - Backfill: once, on the first launch with the feature on, every log still on disk that changed in
//   the last 90 days is read from its start (in time slices, by the worker), its records going
//   through the same dedupe. usage/backfill.json records its progress (the logs done) and then that
//   it is done, so it never reruns.
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushStale, listLogs, newCursor, readAppended, usageFor, type Cursor, type LogKind, type LogRoot, type Usage, type UsageSink } from './token-speed.ts'

export type { Usage } from './token-speed.ts'

export const USAGE_DIR = 'usage'
export const COVERAGE_FILE = 'coverage.json'
export const BACKFILL_FILE = 'backfill.json'
const DAY = 86_400_000
export const RETENTION_MS = 90 * DAY
/** An older month's key index is let go when no record for it came in this long. */
const INDEX_IDLE_MS = 10 * 60_000

const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/

/** The UTC month of a time: "2026-11". */
export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7)
const monthStart = (month: string) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
const monthEnd = (month: string) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)

export const usageKey = (u: Pick<Usage, 'provider' | 'session' | 'id'>) => `${u.provider}\u0000${u.session}\u0000${u.id}`

/** A 53-bit hash of a key (cyrb53): a month's keys stay a few MB, with collisions near one in 10^10 per pair. */
export function hashKey(s: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

// ---------- lines ----------

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

export function encodeUsage(u: Usage): string {
  return JSON.stringify([u.provider, u.session, u.id, u.model, Math.round(u.start), Math.round(u.end), int(u.in), int(u.cacheRead), int(u.cacheWrite5m), int(u.cacheWrite1h), int(u.out)])
}

export function decodeUsage(line: string): Usage | null {
  let a: unknown
  try { a = JSON.parse(line) } catch { return null }
  if (!Array.isArray(a) || a.length < 11) return null
  const [provider, session, id, model, start, end] = a
  if ((provider !== 'claude' && provider !== 'codex') || typeof session !== 'string' || typeof id !== 'string' || typeof model !== 'string') return null
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(end)) return null
  return { provider, session, id, model, start, end, in: int(a[6]), cacheRead: int(a[7]), cacheWrite5m: int(a[8]), cacheWrite1h: int(a[9]), out: int(a[10]) }
}

/** The dedupe key of a stored line, without parsing all of it (the line starts with provider, session, id). */
function lineKey(line: string): string | null {
  const m = /^\["(claude|codex)","([^"\\]*)","([^"\\]*)",/.exec(line)
  if (m) return `${m[1]}\u0000${m[2]}\u0000${m[3]}`
  const u = decodeUsage(line)
  return u && usageKey(u)
}

const readText = (path: string): string => {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** Written whole to a temp file, then renamed over: a reader never sees half a file. */
function writeJson(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** The month files in `dir`, oldest first. */
function monthFiles(dir: string): string[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names.filter((n) => MONTH_FILE.test(n)).sort()
}

// ---------- the store ----------

type MonthIndex = { keys: Set<number>; used: number }

export type UsageStore = {
  dir: string
  /** Records accepted since the last flush, written by flushUsage. */
  pending: Usage[]
  /** Month → hashed keys already stored (loaded lazily from the month's file). */
  index: Map<string, MonthIndex>
  /** "provider/session" → [first start, last end] of what was read of its logs. */
  coverage: Map<string, [number, number]>
  coverageDirty: boolean
}

/** Opens the store under `dataDir` (~/.orca-flow): the coverage index, and the current month's keys. */
export function openUsageStore(dataDir: string, now: number): UsageStore {
  const dir = join(dataDir, USAGE_DIR)
  const store: UsageStore = { dir, pending: [], index: new Map(), coverage: decodeCoverage(readJson(join(dir, COVERAGE_FILE))), coverageDirty: false }
  monthIndex(store, monthOf(now), now)
  return store
}

function monthIndex(store: UsageStore, month: string, now: number): MonthIndex {
  let idx = store.index.get(month)
  if (!idx) {
    const keys = new Set<number>()
    for (const line of readText(join(store.dir, `${month}.jsonl`)).split('\n')) {
      const key = line && lineKey(line)
      if (key) keys.add(hashKey(key))
    }
    store.index.set(month, (idx = { keys, used: now }))
  }
  idx.used = now
  return idx
}

/**
 * Takes one record: false when it is a duplicate (its key is stored or pending) or older than the 90
 * days. Accepted records wait in `pending` for flushUsage.
 */
export function recordUsage(store: UsageStore, u: Usage, now: number): boolean {
  if (!(u.end >= now - RETENTION_MS) || !u.session || !u.id) return false
  const month = monthOf(u.end)
  const idx = monthIndex(store, month, now)
  const h = hashKey(usageKey(u))
  if (idx.keys.has(h)) return false
  idx.keys.add(h)
  store.pending.push(u)
  const ck = `${u.provider}/${u.session}`
  const span = store.coverage.get(ck)
  const start = Math.min(u.start, u.end)
  if (!span) store.coverage.set(ck, [start, u.end])
  else if (start < span[0] || u.end > span[1]) store.coverage.set(ck, [Math.min(span[0], start), Math.max(span[1], u.end)])
  else return true
  store.coverageDirty = true
  return true
}

/** True when `path` ends in a newline (or is empty): an append after a crash's half line starts a new line. */
function endsWithNewline(path: string): boolean {
  let fd: number, size: number
  try {
    size = statSync(path).size
    if (!size) return true
    fd = openSync(path, 'r')
  } catch {
    return true
  }
  try {
    const b = new Uint8Array(1)
    readSync(fd, b, 0, 1, size - 1)
    return b[0] === 10
  } finally {
    closeSync(fd)
  }
}

/** Appends the pending records to their months' files and saves the coverage index when it changed. */
export function flushUsage(store: UsageStore, now: number): void {
  if (store.pending.length || store.coverageDirty) mkdirSync(store.dir, { recursive: true })
  if (store.pending.length) {
    const byMonth = new Map<string, string[]>()
    for (const u of store.pending) {
      const m = monthOf(u.end)
      let lines = byMonth.get(m)
      if (!lines) byMonth.set(m, (lines = []))
      lines.push(encodeUsage(u))
    }
    for (const [m, lines] of byMonth) {
      const path = join(store.dir, `${m}.jsonl`)
      appendFileSync(path, `${endsWithNewline(path) ? '' : '\n'}${lines.join('\n')}\n`)
    }
    store.pending = []
  }
  if (store.coverageDirty) {
    writeJson(join(store.dir, COVERAGE_FILE), encodeCoverage(store.coverage))
    store.coverageDirty = false
  }
  // Older months' keys are let go once their records stop coming (the current month's stay).
  const current = monthOf(now)
  for (const [m, idx] of store.index) if (m !== current && idx.used < now - INDEX_IDLE_MS) store.index.delete(m)
}

/**
 * Drops what is past the 90 days: month files that ended before the cut, the lines of the month the
 * cut falls in, and coverage spans that ended before it. Meant for once a day.
 */
export function pruneUsage(store: UsageStore, now: number): void {
  const cut = now - RETENTION_MS
  for (const name of monthFiles(store.dir)) {
    const month = name.slice(0, 7)
    const path = join(store.dir, name)
    if (monthEnd(month) <= cut) {
      rmSync(path, { force: true })
      store.index.delete(month)
    } else if (monthStart(month) < cut) {
      const lines = readText(path).split('\n').filter(Boolean)
      const keep = lines.filter((l) => {
        const u = decodeUsage(l)
        return u != null && u.end >= cut
      })
      if (keep.length < lines.length) {
        const tmp = `${path}.${process.pid}.tmp`
        writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '')
        renameSync(tmp, path)
      }
    }
  }
  for (const [k, [, to]] of store.coverage) {
    if (to < cut) {
      store.coverage.delete(k)
      store.coverageDirty = true
    }
  }
}

// ---------- reading ----------

/**
 * The stored records whose end is in [from, to), oldest first, each key once (the first stored).
 * Reads only the months the range touches; records still pending in a running store are not on disk yet.
 */
export function readUsage(dataDir: string, from: number, to: number): Usage[] {
  const dir = join(dataDir, USAGE_DIR)
  const seen = new Set<string>()
  const out: Usage[] = []
  for (const name of monthFiles(dir)) {
    const month = name.slice(0, 7)
    if (monthEnd(month) <= from || monthStart(month) >= to) continue
    for (const line of readText(join(dir, name)).split('\n')) {
      if (!line) continue
      const u = decodeUsage(line)
      if (!u || u.end < from || u.end >= to) continue
      const key = usageKey(u)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(u)
    }
  }
  return out.sort((a, b) => a.end - b.end)
}

export type Coverage = Map<string, [number, number]>

function encodeCoverage(c: Coverage): { v: 1; sessions: Record<string, [number, number]> } {
  return { v: 1, sessions: Object.fromEntries([...c].map(([k, [a, b]]) => [k, [Math.round(a), Math.round(b)]])) }
}

function decodeCoverage(raw: unknown): Coverage {
  const out: Coverage = new Map()
  const f = raw as { v?: number; sessions?: Record<string, unknown> } | null
  if (!f || typeof f !== 'object' || f.v !== 1 || !f.sessions || typeof f.sessions !== 'object') return out
  for (const [k, span] of Object.entries(f.sessions)) {
    if (Array.isArray(span) && typeof span[0] === 'number' && typeof span[1] === 'number') out.set(k, [span[0], span[1]])
  }
  return out
}

/** Per provider session ("claude/<id>", "codex/<id>"), the span of its responses that were read. */
export const readCoverage = (dataDir: string): Coverage => decodeCoverage(readJson(join(dataDir, USAGE_DIR, COVERAGE_FILE)))

// ---------- backfill ----------

export type BackfillState = {
  v: 1
  /** When it began, and the oldest time it looks back to (began − 90 days). */
  started: number
  horizon: number
  done: boolean
  finished?: number
  /** While running: the logs read to their end (a restart goes on with the rest). Empty once done. */
  read: string[]
}

export function readBackfill(dataDir: string): BackfillState | null {
  const f = readJson(join(dataDir, USAGE_DIR, BACKFILL_FILE)) as Partial<BackfillState> | null
  if (!f || typeof f !== 'object' || f.v !== 1 || typeof f.started !== 'number' || typeof f.horizon !== 'number') return null
  return { v: 1, started: f.started, horizon: f.horizon, done: f.done === true, ...(typeof f.finished === 'number' ? { finished: f.finished } : {}), read: Array.isArray(f.read) ? f.read.filter((p): p is string => typeof p === 'string') : [] }
}

export function writeBackfill(dataDir: string, state: BackfillState): void {
  const dir = join(dataDir, USAGE_DIR)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, BACKFILL_FILE), state)
}

export type BackfillRun = {
  state: BackfillState
  paths: [string, LogKind][]
  next: number
  /** The log being read when a slice ran out of time, and the size it is read to. */
  cursor: Cursor | null
  size: number
}

/**
 * The backfill to run: null when one already finished. Lists every log under the roots that changed
 * since the horizon, less those a previous run read to their end.
 */
export function startBackfill(roots: LogRoot[], prev: BackfillState | null, now: number): BackfillRun | null {
  if (prev?.done) return null
  const state: BackfillState = prev ?? { v: 1, started: now, horizon: now - RETENTION_MS, done: false, read: [] }
  const read = new Set(state.read)
  const paths: [string, LogKind][] = []
  for (const root of roots) for (const path of listLogs(root.dir)) if (!read.has(path)) paths.push([path, root.kind])
  return { state, paths, next: 0, cursor: null, size: 0 }
}

/**
 * Reads the backfill's logs into `record` until `deadline` (ms, Date.now()): each log from its start
 * to the size it had when its read began. True when every log is read (state.done is then set).
 * Speed is not touched: the logs of the last 24 h are already in the speed history.
 */
export function backfillSlice(run: BackfillRun, record: UsageSink, now: number, deadline: number): boolean {
  const noSpeed = () => {}
  while (run.next < run.paths.length) {
    const [path, kind] = run.paths[run.next]
    if (!run.cursor) {
      let st: { size: number; mtimeMs: number }
      try { st = statSync(path) } catch { run.next++; continue }
      if (st.mtimeMs < run.state.horizon) { run.next++; continue } // nothing in it is inside the 90 days
      run.cursor = newCursor(kind)
      run.size = st.size
    }
    const usage = usageFor(path, record)
    const finished = readAppended(path, run.cursor, run.size, noSpeed, deadline, usage)
    if (!finished) return false
    // A response still open at the log's end is a live session's: the speed reader records it.
    flushStale(run.cursor, now, noSpeed, usage)
    run.state.read.push(path)
    run.cursor = null
    run.next++
    if (Date.now() > deadline) return run.next >= run.paths.length && finish(run, now)
  }
  return finish(run, now)
}

function finish(run: BackfillRun, now: number): true {
  run.state.done = true
  run.state.finished = now
  run.state.read = []
  return true
}
