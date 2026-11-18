// WORKAROUND for stablyai/orca#26192 (Orca 1.4.261 and earlier). Remove this file, and its one
// call in src/worker.ts (`quietPane`), once Orca ships stablyai/orca#36164 ("don't count Claude's
// artifact live-updates watch as running work"), i.e. in the first Orca release after 1.4.261
// that has it.
//
// Claude Code keeps a live watch on every artifact a session publishes or updates. It reports that
// watch to Orca as a running background task, so Orca shows the agent as `working` in its
// `monitoring` mode (the dashed ring) for the rest of the session, even after the turn ends.
// `orca worktree ps` does not say what kind of task keeps it there, so this reads the agent's
// Claude transcript (and its subagents' transcripts). An agent counts as quiet (not monitoring)
// only when all of these hold:
//   - the transcript shows an artifact watch: an Artifact result with `liveSubscription`;
//   - every background shell (Bash `backgroundTaskId`, which covers commands moved to the
//     background on timeout) and every Monitor (`taskId`) it started has ended: a
//     <task-notification> with a final <status>, a Monitor's "[Monitor expired" event, or TaskStop;
//   - it never called a tool that schedules a later wake-up or runs a workflow (CronCreate,
//     ScheduleWakeup, Workflow, RemoteTrigger). A session cron really wakes the agent later, so it
//     stays monitoring, as Orca shows it.
// Anything else (no transcript, an unreadable line, a start with no end) leaves Orca's monitoring
// as it is. The caller (stateOf in src/worker.ts) also requires `programStatus.state` "done" in
// `orca worktree ps`: Claude reports "1 shell still running" or "1 monitor still running" there,
// whatever kind of task it is, but reports "done" for a watch or a session cron alone, so the
// transcript is what tells a cron apart.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** What one transcript shows about background work. */
export type Tally = {
  /** Background shells and Monitors started, by task id. */
  started: Set<string>
  /** Task ids that ended. */
  ended: Set<string>
  /** Artifact results that armed or kept a live watch. */
  watches: number
  /** Calls that schedule a later wake-up or run a workflow. */
  wakers: number
}

export const emptyTally = (): Tally => ({ started: new Set(), ended: new Set(), watches: 0, wakers: 0 })

const WAKERS = new Set(['CronCreate', 'ScheduleWakeup', 'Workflow', 'RemoteTrigger'])
const WAKER_USE = /"name":"(CronCreate|ScheduleWakeup|Workflow|RemoteTrigger)"/
const FINAL = /<status>(completed|failed|stopped|killed)<\/status>|<event>\[Monitor expired/

/** Ends named by one notification block: each of its task ids, when the block is final. */
function endsIn(text: string, ended: Set<string>): void {
  for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    if (!FINAL.test(block)) continue
    for (const m of block.matchAll(/<task-id>([^<]+)<\/task-id>/g)) ended.add(m[1])
  }
}

/** Notifications reach a transcript as a user message, a queued-command attachment or a queue entry; never from quoted tool output. */
function notificationText(r: any): string {
  if (r.type === 'user') {
    const c = r.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.filter((x: any) => x?.type === 'text' && typeof x.text === 'string').map((x: any) => x.text).join('\n')
    return ''
  }
  if (r.type === 'attachment' && typeof r.attachment?.prompt === 'string') return r.attachment.prompt
  if (r.type === 'queue-operation' && typeof r.content === 'string') return r.content
  return ''
}

/** Adds one transcript line to the tally. Lines that cannot matter are skipped before parsing. */
export function tallyLine(line: string, t: Tally): void {
  const notice = line.includes('<task-notification>')
  const result = line.includes('"toolUseResult"') && /"(backgroundTaskId|liveSubscription|taskId|task_id)"/.test(line)
  const waker = WAKER_USE.test(line)
  if (!notice && !result && !waker) return
  let r: any
  try {
    r = JSON.parse(line)
  } catch {
    return
  }
  if (waker && r.type === 'assistant' && Array.isArray(r.message?.content)) {
    for (const c of r.message.content) if (c?.type === 'tool_use' && WAKERS.has(c.name)) t.wakers++
  }
  const u = r.toolUseResult
  if (u && typeof u === 'object') {
    if (typeof u.backgroundTaskId === 'string') t.started.add(u.backgroundTaskId)
    else if (typeof u.taskId === 'string' && 'timeoutMs' in u) t.started.add(u.taskId)
    else if (typeof u.task_id === 'string' && typeof u.task_type === 'string') t.ended.add(u.task_id)
    if (u.liveSubscription === 'arming' || u.liveSubscription === 'connected') t.watches++
  }
  if (notice) endsIn(notificationText(r), t.ended)
}

/** True when the tallies show an artifact watch and no other background work still running. */
export function onlyArtifactWatches(tallies: Tally[]): boolean {
  const ended = new Set(tallies.flatMap((t) => [...t.ended]))
  return tallies.some((t) => t.watches > 0)
    && tallies.every((t) => t.wakers === 0)
    && tallies.every((t) => [...t.started].every((id) => ended.has(id)))
}

type Cached = { offset: number; rest: string; decoder: StringDecoder; tally: Tally }

/**
 * Reads transcripts incrementally: each file is parsed once, then only the bytes appended since.
 * A file that shrank (rewritten) is read again from the start.
 */
export function backgroundReader() {
  const cache = new Map<string, Cached>()
  const CHUNK = 1 << 20

  const tallyOf = (file: string): Tally => {
    const size = statSync(file).size
    let c = cache.get(file)
    if (!c || size < c.offset) c = { offset: 0, rest: '', decoder: new StringDecoder('utf8'), tally: emptyTally() }
    if (size > c.offset) {
      const fd = openSync(file, 'r')
      try {
        const buf = new Uint8Array(Math.min(CHUNK, size - c.offset))
        while (c.offset < size) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, size - c.offset), c.offset)
          if (n <= 0) break
          c.offset += n
          // The decoder holds a character split across two reads until its last bytes arrive.
          const lines = (c.rest + c.decoder.write(buf.subarray(0, n))).split('\n')
          c.rest = lines.pop() ?? ''
          for (const line of lines) tallyLine(line, c.tally)
        }
      } finally {
        closeSync(fd)
      }
    }
    cache.set(file, c)
    return c.tally
  }

  /** The session's own transcript and its subagents' (`<session>/subagents/*.jsonl`). */
  const filesOf = (transcript: string): string[] => {
    const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents')
    const subs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)) : []
    return [transcript, ...subs]
  }

  return {
    /** True when the transcript shows only artifact watches still running; false when unsure. */
    quiet(transcript: string | null): boolean {
      if (!transcript) return false
      try {
        return onlyArtifactWatches(filesOf(transcript).map(tallyOf))
      } catch {
        return false
      }
    }
  }
}
