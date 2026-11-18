// An idle agent whose only running background work is an artifact watch is not monitoring
// (workaround for stablyai/orca#26192). Fixtures use the exact shapes Claude Code 2.1.327 writes.
import { assert, test } from 'orca/testing'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backgroundReader } from './background.ts'

const line = (r: unknown) => JSON.stringify(r) + '\n'
const result = (toolUseResult: unknown, content = '') =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] }, toolUseResult })
const use = (name: string, input: unknown = {}) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name, input }] } })
const notice = (id: string, status: string | null, event?: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n${status ? `<status>${status}</status>\n` : ''}${event ? `<event>${event}</event>\n` : ''}<summary>done</summary>\n</task-notification>`

const WATCH = result({ url: 'https://claude.ai/artifact/abc', title: 'Day view', liveSubscription: 'arming' }, 'Created a new Artifact…\n\nLive subscription: arming in the background')
const WATCH_AGAIN = result({ url: 'https://claude.ai/artifact/abc', liveSubscription: 'connected' })
const SHELL = result({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bsh1' }, 'Command running in background with ID: bsh1.')
const SHELL_DONE = line({ type: 'user', message: { role: 'user', content: notice('bsh1', 'completed') } })
const MONITOR = result({ taskId: 'mon1', timeoutMs: 900000, persistent: false }, 'Monitor started (task mon1, expires in 15m …)')

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'background-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return { dir, path: (name = 's.jsonl') => join(dir, name), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('an artifact watch alone is not monitoring', () => {
  const f = fixture({ 's.jsonl': WATCH + WATCH_AGAIN })
  assert.equal(backgroundReader().quiet(f.path()), true)
  f.done()
})

test('an artifact watch with a background shell still running is monitoring', () => {
  const f = fixture({ 's.jsonl': WATCH + SHELL })
  assert.equal(backgroundReader().quiet(f.path()), false)
  f.done()
})

test('a background shell that ended leaves only the watch: not monitoring, and an appended end is read', () => {
  const f = fixture({ 's.jsonl': SHELL + WATCH })
  const reader = backgroundReader()
  assert.equal(reader.quiet(f.path()), false, 'the shell runs')
  appendFileSync(f.path(), SHELL_DONE)
  assert.equal(reader.quiet(f.path()), true, 'its completion arrives later in the same file')
  f.done()
})

test('a shell ends however its notification arrives: queued attachment, queue entry or TaskStop', () => {
  const queued = line({ type: 'attachment', attachment: { type: 'queued_command', prompt: notice('bsh1', 'killed') } })
  const queue = line({ type: 'queue-operation', operation: 'enqueue', content: notice('bsh1', 'failed') })
  const stop = result({ message: 'Successfully stopped task: bsh1 (sleep 600)', task_id: 'bsh1', task_type: 'local_bash' })
  for (const end of [queued, queue, stop]) {
    const f = fixture({ 's.jsonl': WATCH + SHELL + end })
    assert.equal(backgroundReader().quiet(f.path()), true)
    f.done()
  }
})

test('a notification quoted in tool output does not end a task', () => {
  const quoted = result({ stdout: notice('bsh1', 'completed'), stderr: '' }, notice('bsh1', 'completed'))
  const f = fixture({ 's.jsonl': WATCH + SHELL + quoted })
  assert.equal(backgroundReader().quiet(f.path()), false)
  f.done()
})

test('a Monitor still running is monitoring; its events do not end it, its expiry does', () => {
  const event = line({ type: 'user', message: { role: 'user', content: notice('mon1', null, '#5912 done: fail=[]') } })
  const expired = line({ type: 'queue-operation', operation: 'enqueue', content: notice('mon1', null, '[Monitor expired after 15m with no events delivered. Re-arm it if you still need the watch.]') })
  const f = fixture({ 's.jsonl': WATCH + MONITOR + event })
  assert.equal(backgroundReader().quiet(f.path()), false, 'an event is not the end')
  appendFileSync(f.path(), expired)
  assert.equal(backgroundReader().quiet(f.path()), true, 'expiry ends it')
  f.done()
})

test('a monitor started in an earlier turn and still running keeps it monitoring', () => {
  const turn = (text: string) => line({ type: 'user', message: { role: 'user', content: text } }) + line({ type: 'system', subtype: 'turn_duration', durationMs: 2000 })
  const f = fixture({ 's.jsonl': turn('watch CI') + MONITOR + turn('publish the canvas') + WATCH + turn('thanks') })
  assert.equal(backgroundReader().quiet(f.path()), false)
  f.done()
})

test('a session cron or scheduled wake-up keeps it monitoring: it really wakes later', () => {
  for (const name of ['CronCreate', 'ScheduleWakeup', 'Workflow']) {
    const f = fixture({ 's.jsonl': WATCH + use(name, { cron: '*/5 * * * *', prompt: 'check CI' }) })
    assert.equal(backgroundReader().quiet(f.path()), false, name)
    f.done()
  }
})

test("a subagent's background shell still running keeps it monitoring; one that ended does not", () => {
  const f = fixture({ 's.jsonl': WATCH, 's/subagents/agent-a1.jsonl': SHELL })
  assert.equal(backgroundReader().quiet(f.path()), false)
  appendFileSync(f.path(), SHELL_DONE)
  assert.equal(backgroundReader().quiet(f.path()), true, "its end may land in the parent's transcript")
  f.done()
})

test('no transcript, a missing file or no watch at all leaves Orca\'s monitoring', () => {
  const reader = backgroundReader()
  assert.equal(reader.quiet(null), false)
  assert.equal(reader.quiet(join(tmpdir(), 'no-such-transcript.jsonl')), false)
  const f = fixture({ 's.jsonl': SHELL + SHELL_DONE })
  assert.equal(reader.quiet(f.path()), false, 'monitoring something this cannot see')
  f.done()
})

test('a start line longer than one read is still read, even split inside a character', () => {
  // The reader takes 1 MiB at a time and carries a line's start over to the next read. Losing the
  // line that starts the shell would show a running shell as idle. The boundary also falls inside
  // a 2-byte character, which the decoder keeps whole.
  const prefix = '{"type":"user","message":{"role":"user","content":"'
  // Each 'é' is 2 bytes; one ASCII 'x' shifts the run so the boundary byte is an 'é''s second byte.
  const shift = ((1 << 20) - Buffer.byteLength(WATCH + prefix)) % 2 === 0 ? 'x' : ''
  const head = WATCH
  const start = `${prefix}${shift}${'é'.repeat(600_000)}"},"toolUseResult":{"stdout":"","backgroundTaskId":"bsh1"}}\n`
  const at = (1 << 20) - Buffer.byteLength(head + prefix + shift)
  assert.ok(at > 0 && at % 2 === 1, 'the first read ends inside a 2-byte character')
  const f = fixture({ 's.jsonl': head + start })
  assert.equal(backgroundReader().quiet(f.path()), false)
  f.done()
})
