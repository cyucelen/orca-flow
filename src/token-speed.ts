// The Token speed section: how fast the agents write, what they send and receive over the network,
// and the internet speed the user last tested.
//
// Speed comes from the agents' own logs, read incrementally: each sample reads only the bytes a log
// gained since the last one (a cursor per file, kept on disk), so a sample costs milliseconds, not the
// ~1 GB a full day of Claude Code logs is. From a log line only its type, timestamp, model, message
// id and output token count are kept; content is parsed past and never stored, sent or logged.
//
// - Claude Code (<profile>/projects/**/*.jsonl): one response is the run of assistant lines with one
//   message.id (a line per content block); it ends at its last line and starts at the line before its
//   first (the prompt or tool_result "user" line, or the previous response's end). Parallel tool calls
//   interleave tool_result lines with one response's blocks: those do not split it.
// - Codex (<home>/sessions/**/*.jsonl): a `token_usage_record` ends a model response and carries its
//   usage; the response started at the input before its first output item (the user message, the
//   task start, the last tool output, or the previous response's end). Rollouts without those records
//   fall back to `token_count`, ending the response at its last output item (the token_count itself
//   comes after the tool ran, so it is no end).
//
// Network: a `nettop` snapshot of the agents' sockets each sample (the agents' processes found by
// their executable name in `ps`), diffed against the last; loopback sockets are not network. Internet: `networkQuality -c`, only when the user presses Test.
//
// History is 1-minute buckets for 24 h (tokens per model, spread over each response's duration;
// responses per model; agent bytes up and down), and response rate histograms (5 % bins) per minute
// for the last hour's medians and per hour for the 24 h ones. Pure functions here; the worker runs the timers and children.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SPEED_FILE = 'token-speed.json'
export const CURSOR_FILE = 'token-speed-cursor.json'
/** Files the worker writes here that must not wake the snapshot watcher (written every sample). */
export const isSpeedFile = (name: string | null | undefined) => !!name && /(?:^|\/)\.?token-speed/.test(name)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A response longer than this is a stall or a wait, not a speed. */
export const MAX_RESPONSE_MS = 600_000
/** Responses this short count, but stay out of the medians: their time is mostly the wait for the first token. */
export const MIN_RATE_TOKENS = 50
/** A Claude response whose last line is this old with nothing after it is complete. */
export const STALE_MS = 60_000
/** Rate histogram bins are 5 % wide. */
const BIN = Math.log(1.05)
/** The read size; a longer line is read in bigger pieces up to MAX_LINE, past that it is skipped. */
const CHUNK = 1 << 20
const MAX_LINE = 64 << 20
/** A cursor for a log not touched in this long is dropped (its data is outside the 24 h anyway). */
const CURSOR_KEEP_MS = DAY + HOUR

export type LogKind = 'claude' | 'codex'
/** One model response: its output tokens and when it started and ended (ms). */
export type Response = { model: string; out: number; start: number; end: number }

/** What a sample keeps of one log between reads: where it stopped and the parse state there. */
export type Cursor = {
  kind: LogKind
  offset: number
  mtime: number
  /** Claude: the last user line, the response being read, the last response done. */
  user?: number | null
  pend?: { id: string; model: string; start: number | null; end: number; out: number } | null
  done?: string | null
  /** Codex: the model in use, the last input, the open response's first and last output. */
  model?: string | null
  lastIn?: number | null
  rStart?: number | null
  rEnd?: number | null
  /** Codex: this rollout writes token_usage_record lines (token_count is then ignored). */
  rec?: boolean
  /** Codex without records: the response an input closed, waiting for its token_count ([start, end]). */
  wait?: [number | null, number] | null
}

export const newCursor = (kind: LogKind, offset = 0, mtime = 0): Cursor => ({ kind, offset, mtime })

const stamp = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

/** A response worth recording: a real start before its end, and not over MAX_RESPONSE_MS. */
const valid = (r: { start: number | null; end: number }) => r.start != null && r.end > r.start && r.end - r.start <= MAX_RESPONSE_MS

function flushClaude(c: Cursor, emit: (r: Response) => void): void {
  const p = c.pend
  if (!p) return
  if (valid(p)) emit({ model: p.model, out: p.out, start: p.start!, end: p.end })
  c.done = p.id
  c.user = Math.max(c.user ?? 0, p.end)
  c.pend = null
}

/** One Claude Code log line. Only user and assistant lines matter; the rest are skipped unparsed. */
export function claudeLine(c: Cursor, line: string, emit: (r: Response) => void): void {
  const assistant = line.includes('"type":"assistant"')
  if (!assistant && !line.includes('"type":"user"')) return
  let r: any
  try { r = JSON.parse(line) } catch { return }
  const at = stamp(r?.timestamp)
  if (at == null) return
  // A user line does not end the response: parallel tool calls write their results between its blocks.
  // The next response (another id) does, and starts at the latest user line.
  if (r.type === 'user') {
    c.user = at
    return
  }
  if (r.type !== 'assistant') return
  const m = r.message
  const model = m?.model, id = m?.id
  if (typeof model !== 'string' || model === '<synthetic>' || typeof id !== 'string') return
  const out = Number(m.usage?.output_tokens) || 0
  if (c.pend?.id === id) {
    c.pend.end = at
    c.pend.out = out
    return
  }
  if (c.done === id) return // a late line of a response already recorded as stale
  flushClaude(c, emit)
  c.pend = { id, model, start: c.user ?? null, end: at, out }
}

/** A Claude response with nothing after it for STALE_MS is complete (the session waits on its user). */
export function flushStale(c: Cursor, now: number, emit: (r: Response) => void): void {
  if (c.kind === 'claude' && c.pend && now - c.pend.end > STALE_MS) flushClaude(c, emit)
}

const CODEX_OUT = new Set(['reasoning', 'function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call', 'image_generation_call'])
const CODEX_IN = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'tool_search_output'])

/** One Codex rollout line. */
export function codexLine(c: Cursor, line: string, emit: (r: Response) => void): void {
  if (line.includes('"item_completed"')) return // progress events: nothing to read
  let r: any
  try { r = JSON.parse(line) } catch { return }
  const at = stamp(r?.timestamp)
  if (at == null) return
  const p = r.payload && typeof r.payload === 'object' ? r.payload : {}
  const type = r.type, pt = p.type
  if (type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) c.model = p.model
    return
  }
  const input = () => {
    // Without records the token_count comes after the tool ran: the response it counts waits for it.
    if (!c.rec && c.rEnd != null) c.wait = [c.rStart ?? null, c.rEnd]
    c.lastIn = at
    c.rStart = null
    c.rEnd = null
  }
  if (type === 'event_msg' && (pt === 'task_started' || pt === 'user_message')) return input()
  if (type === 'response_item') {
    if (CODEX_IN.has(pt) || (pt === 'message' && p.role === 'user')) return input()
    if (CODEX_OUT.has(pt) || (pt === 'message' && p.role === 'assistant')) {
      if (c.rStart == null) c.rStart = c.lastIn ?? null
      c.rEnd = at
    }
    return
  }
  if (type === 'token_usage_record') {
    c.rec = true
    c.wait = null
    const start = c.rStart ?? c.lastIn ?? null
    const out = Number(p.usage?.output_tokens) || 0
    if (valid({ start, end: at })) emit({ model: c.model ?? 'codex', out, start: start!, end: at })
    c.rStart = null
    c.rEnd = null
    c.lastIn = at
    return
  }
  if (type === 'event_msg' && pt === 'token_count' && !c.rec) {
    const [start, end] = c.wait ?? [c.rStart ?? null, c.rEnd ?? null]
    const usage = p.info?.last_token_usage
    if (end != null && usage && valid({ start, end })) emit({ model: c.model ?? 'codex', out: Number(usage.output_tokens) || 0, start: start!, end })
    if (end != null) c.lastIn = Math.max(c.lastIn ?? 0, end)
    c.wait = null
    if (c.rEnd === end) { c.rStart = null; c.rEnd = null }
  }
}

export const lineReader = (kind: LogKind) => (kind === 'claude' ? claudeLine : codexLine)

const decoder = new TextDecoder()

/**
 * Reads what `path` gained since the cursor, line by line, up to `size` (the size a stat just saw)
 * and until `deadline` (ms, Date.now()). Only whole lines are read: a line still being written waits
 * for the next sample. A file shorter than the cursor was replaced or truncated: it is read from 0.
 * Returns true when it reached `size`, false when the deadline stopped it (call again to go on).
 */
export function readAppended(path: string, c: Cursor, size: number, emit: (r: Response) => void, deadline = Infinity): boolean {
  if (size < c.offset) Object.assign(c, newCursor(c.kind, 0, c.mtime), { pend: null, user: null, done: null, model: null, lastIn: null, rStart: null, rEnd: null, rec: false, wait: null })
  if (size === c.offset) return true
  const handle = lineReader(c.kind)
  let fd: number
  try { fd = openSync(path, 'r') } catch { return true }
  try {
    while (c.offset < size) {
      let len = Math.min(CHUNK, size - c.offset)
      let buf = new Uint8Array(len)
      readSync(fd, buf, 0, len, c.offset)
      let nl = buf.lastIndexOf(10)
      // One line longer than a chunk: read it in bigger pieces.
      while (nl < 0 && c.offset + len < size && len < MAX_LINE) {
        len = Math.min(len * 4, size - c.offset, MAX_LINE)
        buf = new Uint8Array(len)
        readSync(fd, buf, 0, len, c.offset)
        nl = buf.lastIndexOf(10)
      }
      if (nl < 0) {
        if (len >= MAX_LINE) c.offset += len // too long to be a log line worth reading: skip it
        break // the last line is still being written
      }
      const text = decoder.decode(buf.subarray(0, nl))
      let from = 0
      while (from < text.length) {
        let to = text.indexOf('\n', from)
        if (to < 0) to = text.length
        if (to > from) handle(c, text.slice(from, to), emit)
        from = to + 1
      }
      c.offset += nl + 1
      if (Date.now() > deadline) return c.offset >= size
    }
  } finally {
    closeSync(fd)
  }
  return true
}

// ---------- which logs ----------

export type LogRoot = { kind: LogKind; dir: string }

/**
 * The log folders under each provider home: Claude profiles' projects, Codex homes' sessions. A
 * folder is listed once by its real path (Orca's Claude profiles link `projects` to ~/.claude's), and
 * a missing one not at all.
 */
export function logRoots(claudeHomes: string[], codexHomes: string[], real: (path: string) => string | null = realPath): LogRoot[] {
  const seen = new Set<string>()
  const out: LogRoot[] = []
  for (const [kind, homes, sub] of [['claude', claudeHomes, 'projects'], ['codex', codexHomes, 'sessions']] as const) {
    for (const home of homes) {
      const dir = real(join(home, sub))
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      out.push({ kind, dir })
    }
  }
  return out
}

const realPath = (path: string): string | null => {
  try { return realpathSync(path) } catch { return null }
}

/** Every .jsonl under `root`, recursively. */
export function listLogs(root: string, out: string[] = []): string[] {
  let names: { name: string; isDirectory(): boolean; isFile(): boolean }[]
  try { names = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of names) {
    const path = join(root, e.name)
    if (e.isDirectory()) listLogs(path, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

// ---------- history ----------

/** One minute: agent bytes up and down, the seconds nettop covered, and per model index tokens and responses. */
export type Minute = { t: number; up: number; down: number; secs: number; tok: number[]; n: number[] }
export type InternetResult = { at: number; down: number; up: number; rtt: number | null; rpm: number | null }
export type NetSample = { at: number; up: number; down: number; secs: number; procs: number }

export type History = {
  /** Model ids, in the order first seen: a model's index is its color slot, so it keeps its color. */
  models: string[]
  /** By minute start (ms). */
  minutes: Map<number, Minute>
  /** Rate histograms of the last hour by minute, and of the 24 h by hour: start (ms) → model index → bin → responses. */
  recent: Bins
  hours: Bins
  internet: InternetResult | null
  net: NetSample | null
}

export type Bins = Map<number, Map<number, Map<number, number>>>
export const emptyHistory = (): History => ({ models: [], minutes: new Map(), recent: new Map(), hours: new Map(), internet: null, net: null })

function addBin(bins: Bins, t: number, i: number, bin: number): void {
  let byModel = bins.get(t)
  if (!byModel) bins.set(t, (byModel = new Map()))
  let b = byModel.get(i)
  if (!b) byModel.set(i, (b = new Map()))
  b.set(bin, (b.get(bin) ?? 0) + 1)
}

/** Model i's bins over the buckets starting at or after `since`. */
function binsSince(bins: Bins, i: number, since: number): Map<number, number> {
  const out = new Map<number, number>()
  for (const [t, byModel] of bins) {
    if (t < since) continue
    for (const [b, n] of byModel.get(i) ?? []) out.set(b, (out.get(b) ?? 0) + n)
  }
  return out
}

const minuteAt = (h: History, t: number): Minute => {
  const key = Math.floor(t / MINUTE) * MINUTE
  let m = h.minutes.get(key)
  if (!m) h.minutes.set(key, (m = { t: key, up: 0, down: 0, secs: 0, tok: [], n: [] }))
  return m
}

export const modelIndex = (h: History, model: string): number => {
  let i = h.models.indexOf(model)
  if (i < 0) i = h.models.push(model) - 1
  return i
}

export const rateBin = (rate: number) => Math.round(Math.log(rate) / BIN)
export const binRate = (bin: number) => Math.exp(bin * BIN)

/**
 * Adds one response: its tokens spread over the minutes it ran (so a 90 s response counts in the
 * minutes it wrote in), one response in the minute it ended, and its rate in the last hour's list
 * and its hour's histogram. A response that ended over 24 h before `now` is not kept.
 */
export function addResponse(h: History, r: Response, now: number): void {
  const dur = r.end - r.start
  if (!(dur > 0) || dur > MAX_RESPONSE_MS || r.end < now - DAY) return
  const i = modelIndex(h, r.model)
  for (let t = Math.floor(r.start / MINUTE) * MINUTE; t < r.end; t += MINUTE) {
    if (t + MINUTE < now - DAY) continue
    const share = (Math.min(r.end, t + MINUTE) - Math.max(r.start, t)) / dur
    const m = minuteAt(h, t)
    m.tok[i] = (m.tok[i] ?? 0) + r.out * share
  }
  const last = minuteAt(h, r.end)
  last.n[i] = (last.n[i] ?? 0) + 1
  if (r.out < MIN_RATE_TOKENS) return
  const b = rateBin(r.out / (dur / 1000))
  if (r.end >= now - HOUR) addBin(h.recent, Math.floor(r.end / MINUTE) * MINUTE, i, b)
  addBin(h.hours, Math.floor(r.end / HOUR) * HOUR, i, b)
}

/** One nettop sample of the agents' traffic: `secs` seconds ending at `at`, in bytes. */
export function addNet(h: History, s: NetSample): void {
  const m = minuteAt(h, s.at - 1)
  m.up += s.up
  m.down += s.down
  m.secs += s.secs
  h.net = s
}

/** Drops what fell out of the 24 h (and the last hour's rates older than an hour). */
export function prune(h: History, now: number): void {
  for (const t of h.minutes.keys()) if (t + MINUTE < now - DAY) h.minutes.delete(t)
  for (const t of h.recent.keys()) if (t + MINUTE <= now - HOUR) h.recent.delete(t)
  for (const t of h.hours.keys()) if (t + HOUR <= now - DAY) h.hours.delete(t)
}

// ---------- on disk ----------

/** The file form: compact arrays, so 24 h of minutes stay a few tens of KB. */
type HistoryFile = {
  v: 1
  models: string[]
  /** [minute start / 60000, up, down, secs, tok0, n0, tok1, n1, ...], trailing zeros cut. */
  minutes: number[][]
  /** [minute start / 60000, model index, bin, count, bin, count, ...] */
  recent: number[][]
  /** [hour start / 3600000, model index, bin, count, bin, count, ...] */
  hours: number[][]
  internet: InternetResult | null
  net: NetSample | null
}

function encodeBins(bins: Bins, unit: number): number[][] {
  const out: number[][] = []
  for (const [t, byModel] of [...bins].sort((a, b) => a[0] - b[0]))
    for (const [i, b] of byModel) out.push([t / unit, i, ...[...b].flat()])
  return out
}

function decodeBins(rows: unknown, unit: number): Bins {
  const bins: Bins = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length < 2) continue
    const t = num(row[0]) * unit
    let byModel = bins.get(t)
    if (!byModel) bins.set(t, (byModel = new Map()))
    const b = new Map<number, number>()
    for (let k = 2; k + 1 < row.length; k += 2) b.set(num(row[k]), num(row[k + 1]))
    byModel.set(num(row[1]), b)
  }
  return bins
}

export function encodeHistory(h: History): HistoryFile {
  const minutes = [...h.minutes.values()].sort((a, b) => a.t - b.t).map((m) => {
    const row = [m.t / MINUTE, Math.round(m.up), Math.round(m.down), Math.round(m.secs)]
    for (let i = 0; i < h.models.length; i++) row.push(Math.round(m.tok[i] ?? 0), m.n[i] ?? 0)
    while (row.length > 4 && row[row.length - 1] === 0) row.pop()
    return row
  })
  return { v: 1, models: h.models, minutes, recent: encodeBins(h.recent, MINUTE), hours: encodeBins(h.hours, HOUR), internet: h.internet, net: h.net }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function decodeHistory(raw: unknown): History {
  const h = emptyHistory()
  const f = raw as Partial<HistoryFile> | null
  if (!f || typeof f !== 'object' || f.v !== 1) return h
  h.models = Array.isArray(f.models) ? f.models.filter((m): m is string => typeof m === 'string') : []
  for (const row of Array.isArray(f.minutes) ? f.minutes : []) {
    if (!Array.isArray(row) || row.length < 4) continue
    const m: Minute = { t: num(row[0]) * MINUTE, up: num(row[1]), down: num(row[2]), secs: num(row[3]), tok: [], n: [] }
    for (let k = 4, i = 0; k < row.length; k += 2, i++) { m.tok[i] = num(row[k]); m.n[i] = num(row[k + 1]) }
    h.minutes.set(m.t, m)
  }
  h.recent = decodeBins(f.recent, MINUTE)
  h.hours = decodeBins(f.hours, HOUR)
  const i = f.internet as InternetResult | null
  h.internet = i && typeof i === 'object' && num(i.at) && num(i.down) ? { at: num(i.at), down: num(i.down), up: num(i.up), rtt: typeof i.rtt === 'number' ? i.rtt : null, rpm: typeof i.rpm === 'number' ? i.rpm : null } : null
  const n = f.net as NetSample | null
  h.net = n && typeof n === 'object' && num(n.at) ? { at: num(n.at), up: num(n.up), down: num(n.down), secs: num(n.secs), procs: num(n.procs) } : null
  return h
}

/** Cursors by path; on disk grouped by folder (folder → file name → cursor), empty fields left out. */
export type Cursors = Map<string, Cursor>

export function encodeCursors(cursors: Cursors, now: number): Record<string, Record<string, Partial<Cursor>>> {
  const out: Record<string, Record<string, Partial<Cursor>>> = {}
  for (const [path, c] of cursors) {
    if (c.mtime < now - CURSOR_KEEP_MS) continue
    const cut = path.lastIndexOf('/')
    const compact = Object.fromEntries(Object.entries({ ...c, mtime: Math.round(c.mtime) }).filter(([, v]) => v != null && v !== false)) as Partial<Cursor>
    ;(out[path.slice(0, cut)] ??= {})[path.slice(cut + 1)] = compact
  }
  return out
}

export function decodeCursors(raw: unknown): Cursors {
  const out: Cursors = new Map()
  if (!raw || typeof raw !== 'object') return out
  for (const [dir, files] of Object.entries(raw as Record<string, Record<string, Cursor>>)) {
    if (!files || typeof files !== 'object') continue
    for (const [name, c] of Object.entries(files)) {
      if (c && (c.kind === 'claude' || c.kind === 'codex') && typeof c.offset === 'number') out.set(`${dir}/${name}`, { ...c, mtime: num(c.mtime) })
    }
  }
  return out
}

const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** Written whole to a temp file, then renamed over: a reader never sees half a file. */
function writeJson(dir: string, name: string, data: unknown): void {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${name}.${process.pid}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, join(dir, name))
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

export type SpeedStore = { history: History; cursors: Cursors | null }
/** The history and cursors; `cursors` null means none were saved: the first sample reads the last 24 h. */
export function readSpeedStore(dir: string): SpeedStore {
  const raw = readJson(join(dir, CURSOR_FILE))
  return { history: decodeHistory(readJson(join(dir, SPEED_FILE))), cursors: raw ? decodeCursors(raw) : null }
}
export function writeSpeedStore(dir: string, store: { history: History; cursors: Cursors }, now: number): void {
  writeJson(dir, SPEED_FILE, encodeHistory(store.history))
  writeJson(dir, CURSOR_FILE, encodeCursors(store.cursors, now))
}

// ---------- a sample of the logs ----------

export type ScanStats = { files: number; readBytes: number; responses: number; next: number }

/**
 * The logs a sample looks at. `full` lists every log under the roots (new files are found then);
 * otherwise only the logs touched in the last hour, and any with a response still open.
 */
export function logsToRead(roots: LogRoot[], cursors: Cursors, now: number, full: boolean): [string, LogKind][] {
  const paths: [string, LogKind][] = []
  if (full) for (const root of roots) for (const path of listLogs(root.dir)) paths.push([path, root.kind])
  else for (const [path, c] of cursors) if (c.mtime >= now - HOUR || c.pend) paths.push([path, c.kind])
  return paths
}

/**
 * Reads the new lines of `paths` (from index `from`) into the history. A log seen for the first time
 * is read from its start when it changed in the last 24 h (the first sample, or a new session), else
 * from its end. Stops at `deadline`; `next` is where to go on (paths.length when done).
 */
export function readLogs(input: { paths: [string, LogKind][]; from?: number; cursors: Cursors; history: History; now: number; deadline?: number }): ScanStats {
  const { paths, cursors, history, now } = input
  const deadline = input.deadline ?? Infinity
  const stats: ScanStats = { files: 0, readBytes: 0, responses: 0, next: paths.length }
  const emit = (r: Response) => { stats.responses++; addResponse(history, r, now) }
  for (let k = input.from ?? 0; k < paths.length; k++) {
    const [path, kind] = paths[k]
    let st: { size: number; mtimeMs: number }
    try { st = statSync(path) } catch { cursors.delete(path); continue }
    stats.files++
    let c = cursors.get(path)
    if (!c) {
      if (st.mtimeMs < now - CURSOR_KEEP_MS) continue // untouched for a day: nothing to read
      c = newCursor(kind, st.mtimeMs < now - DAY ? st.size : 0)
      cursors.set(path, c)
    }
    c.mtime = st.mtimeMs
    const before = c.offset
    const finished = readAppended(path, c, st.size, emit, deadline)
    stats.readBytes += Math.max(0, c.offset - before)
    if (finished) flushStale(c, now, emit)
    if (Date.now() > deadline) { stats.next = finished ? k + 1 : k; break }
  }
  return stats
}

// ---------- network ----------

/** The agents' process ids, from `ps -A -o pid=,comm=`: executables named claude or codex. */
export function agentPids(ps: string): Set<number> {
  const out = new Set<number>()
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const name = m[2].split('/').pop() ?? ''
    if (name === 'claude' || name === 'codex') out.add(Number(m[1]))
  }
  return out
}

/** A nettop snapshot of the agents' sockets: cumulative bytes per socket ("<pid> <proto> <local><-><remote>"). */
export type SocketSnapshot = { at: number; sockets: Map<string, [number, number]> }

const LOOPBACK = /^(?:127\.|::1\b|\[::1\]|localhost\b)/

/**
 * `nettop -L 1 -x -J bytes_in,bytes_out` (one snapshot: a "<name>.<pid>" row per process, then a
 * row per socket, bytes since the socket opened), keeping the sockets of the agents' pids that reach
 * past this machine: loopback (local MCP servers, Orca's CLI) and listening sockets are left out.
 * nettop's own interval modes (-L 2 and up) busy-wait at about a CPU core, so the worker takes one
 * snapshot per sample and diffs them (socketDelta).
 */
export function parseNettop(csv: string, pids: Set<number>, at: number): SocketSnapshot {
  const sockets = new Map<string, [number, number]>()
  let pid: number | null = null
  for (const line of csv.split('\n')) {
    const cells = line.split(',')
    if (cells.length < 3 || !cells[0]) continue
    const name = cells[0]
    const link = /^(\S+) (\S+)<->(\S+)$/.exec(name)
    if (!link) {
      const p = Number(/\.(\d+)$/.exec(name)?.[1])
      pid = pids.has(p) ? p : null
      continue
    }
    if (pid == null || link[3].startsWith('*') || LOOPBACK.test(link[2]) || LOOPBACK.test(link[3])) continue
    sockets.set(`${pid} ${name}`, [Number(cells[1]) || 0, Number(cells[2]) || 0])
  }
  return { at, sockets }
}

/**
 * The bytes the agents moved between two snapshots: each socket's growth, and all of a socket opened
 * since the first. A socket that closed in between loses what it moved after the first snapshot.
 */
export function socketDelta(prev: SocketSnapshot, cur: SocketSnapshot): { up: number; down: number; procs: number; secs: number } {
  let up = 0, down = 0
  const procs = new Set<string>()
  for (const [key, [inB, outB]] of cur.sockets) {
    const before = prev.sockets.get(key) ?? [0, 0]
    const d = Math.max(0, inB - before[0]), u = Math.max(0, outB - before[1])
    down += d
    up += u
    procs.add(key.slice(0, key.indexOf(' ')))
  }
  return { up, down, procs: procs.size, secs: Math.max(0, (cur.at - prev.at) / 1000) }
}

/** `networkQuality -c` JSON: down and up in bit/s, base RTT in ms, responsiveness in RPM. */
export function parseNetworkQuality(text: string, at: number): InternetResult | null {
  let j: any
  try { j = JSON.parse(text) } catch { return null }
  const down = Number(j?.dl_throughput), up = Number(j?.ul_throughput)
  if (!(down > 0) || !(up > 0)) return null
  const rtt = Number(j.base_rtt), rpm = Number(j.responsiveness)
  return { at, down, up, rtt: Number.isFinite(rtt) ? rtt : null, rpm: Number.isFinite(rpm) ? rpm : null }
}

// ---------- what the panel shows ----------

export type SpeedSeries = {
  start: number
  /** Bucket width in ms. */
  step: number
  /** Output tok/s per model id, one value per bucket. */
  tok: Record<string, number[]>
  /** Agent traffic in bit/s per bucket; null where nettop covered none of it. */
  up: (number | null)[]
  down: (number | null)[]
  /** Seconds of traffic samples in the window: under a few minutes there is no line to draw yet. */
  netSecs: number
}
export type SpeedModel = { id: string; label: string; slot: number; median1h: number | null; median24h: number | null; count1h: number; count24h: number; tokens24h: number }
export type SpeedRange = '1h' | '24h'
export type TokenSpeedWire = {
  now: number
  /** False until the first read of the last 24 h of logs is through. */
  ready: boolean
  /** All agents' output over the last minute, tok/s. */
  tokPerSec: number
  /** The agents' traffic in the last nettop sample, bit/s; null before the first. */
  net: { at: number; up: number; down: number; procs: number } | null
  internet: InternetResult | null
  testing: boolean
  testError: string | null
  models: SpeedModel[]
  series: Record<SpeedRange, SpeedSeries>
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5"; other ids as they are. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return id
}

/** The median of binned rates (each bin's center), so within 2.5 % of the exact one. */
export function histogramMedian(bins: Map<number, number>): number | null {
  const sorted = [...bins].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0])
  const total = sorted.reduce((s, [, n]) => s + n, 0)
  if (!total) return null
  let seen = 0
  for (const [b, n] of sorted) {
    seen += n
    if (seen * 2 >= total) return binRate(b)
  }
  return null
}

/** Buckets of `step` over `span`, ending where the current (still partial) bucket starts: responses log when they end, so it would always dip. */
function series(h: History, now: number, span: number, step: number): SpeedSeries {
  const start = Math.floor(now / step) * step - span
  const count = Math.round(span / step)
  const tok: Record<string, number[]> = {}
  const up: (number | null)[] = new Array(count).fill(null)
  const down: (number | null)[] = new Array(count).fill(null)
  const upB = new Array(count).fill(0), downB = new Array(count).fill(0), secs = new Array(count).fill(0)
  const sums = h.models.map(() => new Array(count).fill(0))
  for (const m of h.minutes.values()) {
    const k = Math.floor((m.t - start) / step)
    if (k < 0 || k >= count) continue
    m.tok.forEach((v, i) => { sums[i][k] += v ?? 0 })
    upB[k] += m.up
    downB[k] += m.down
    secs[k] += m.secs
  }
  h.models.forEach((id, i) => {
    if (sums[i].some((v) => v > 0)) tok[id] = sums[i].map((v) => Math.round((v / (step / 1000)) * 10) / 10)
  })
  for (let k = 0; k < count; k++) {
    if (secs[k] > 0) {
      up[k] = Math.round((upB[k] * 8) / secs[k])
      down[k] = Math.round((downB[k] * 8) / secs[k])
    }
  }
  return { start, step, tok, up, down, netSecs: Math.round(secs.reduce((a, b) => a + b, 0)) }
}

/** The panel's view of the history at `now` (a few KB: 60 one-minute and 96 quarter-hour buckets). */
export function speedView(h: History, now: number, state: { ready: boolean; testing: boolean; testError: string | null }): TokenSpeedWire {
  const cur = Math.floor(now / MINUTE) * MINUTE
  const into = (now - cur) / MINUTE
  const tokIn = (t: number) => (h.minutes.get(t)?.tok ?? []).reduce((s, v) => s + (v ?? 0), 0)
  const tokPerSec = (tokIn(cur) + tokIn(cur - MINUTE) * (1 - into)) / 60
  const models: SpeedModel[] = h.models.map((id, i) => {
    let count1h = 0, count24h = 0, tokens24h = 0
    for (const m of h.minutes.values()) {
      if (m.t < now - DAY) continue
      count24h += m.n[i] ?? 0
      tokens24h += m.tok[i] ?? 0
      if (m.t >= cur - HOUR + MINUTE) count1h += m.n[i] ?? 0
    }
    const m1 = histogramMedian(binsSince(h.recent, i, cur - HOUR + MINUTE))
    const m24 = histogramMedian(binsSince(h.hours, i, Math.floor((now - DAY) / HOUR) * HOUR)) // the oldest hour whole, as the counts include it
    return { id, label: modelLabel(id), slot: i, median1h: m1 == null ? null : Math.round(m1), median24h: m24 == null ? null : Math.round(m24), count1h, count24h, tokens24h: Math.round(tokens24h) }
  }).filter((m) => m.count24h > 0).sort((a, b) => b.tokens24h - a.tokens24h)
  const net = h.net && h.net.secs > 0 ? { at: h.net.at, up: Math.round((h.net.up * 8) / h.net.secs), down: Math.round((h.net.down * 8) / h.net.secs), procs: h.net.procs } : null
  return {
    now,
    ready: state.ready,
    tokPerSec: Math.round(tokPerSec * 10) / 10,
    net,
    internet: h.internet,
    testing: state.testing,
    testError: state.testError,
    models,
    series: { '1h': series(h, now, HOUR, MINUTE), '24h': series(h, now, DAY, 15 * MINUTE) }
  }
}
