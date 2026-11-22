// node --test test/*.test.mjs
// Every example message the docs teach passes the checker and reads as the ask it shows: each
// ```markdown example in skills/orca-flow/messages.md, and each "After" in docs/message-samples.md
// (the "Before" blocks are the faults, not examples). The kind is expected from the status line,
// so a doc example and the checker cannot drift apart.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkFrame, LEVELS, parseFrame } from '../skills/orca-flow/scripts/frame.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const FENCE = /```markdown\n([\s\S]*?)\n```/g

const SPEC = [...read('../skills/orca-flow/messages.md').matchAll(FENCE)].map((m, i) => ({ name: `messages.md example ${i + 1}`, text: m[1] }))

/** Each "### After" block of message-samples.md, with the number of the sample it belongs to. */
const AFTERS = read('../docs/message-samples.md')
  .split(/^(?=## \d+\.)/m)
  .flatMap((section) => {
    const n = Number(/^## (\d+)\./.exec(section)?.[1])
    if (!n) return []
    return section.split(/^(?=### )/m)
      .filter((part) => part.startsWith('### After'))
      .flatMap((part) => [...part.matchAll(FENCE)].map((m) => ({ name: `message-samples.md sample ${n} After`, sample: n, text: m[1] })))
  })

const ROUTE = new RegExp(`^\\S.* → lead in [^\\s/]+/\\S+ · (?:${LEVELS.join('|')})$`)
/** A coordinator by the message's shape: a route line, or a numbered waiting list under the status line. */
function roleOf(text) {
  const lines = text.split('\n').map((l) => l.trim())
  if (lines.some((l) => ROUTE.test(l))) return 'coordinator'
  const status = lines.findLastIndex((l) => /^\*\*[^*].*\*\*$/.test(l))
  return status >= 0 && lines.slice(status + 1).some((l) => /^\d+[.)] /.test(l)) ? 'coordinator' : 'lead'
}

/** The kind, whether it stops the work, and what it waits on, as the status line says. */
function expected(status) {
  const waiting = /^Waiting on (.+)$/.exec(status)?.[1] ?? null
  if (/^(?:Working|Idle|Done)$/.test(status) || waiting) return { kind: 'none', blocking: false, waitingOn: waiting }
  if (/^Working · needs .+ later$/.test(status)) return { kind: 'info', blocking: false, waitingOn: null }
  const kind = /^Needs your pick\b/.test(status) ? 'decision'
    : /^Needs your yes\b/.test(status) ? 'approval'
    : /^Needs your review\b/.test(status) ? 'review'
    : /^Needs you to /.test(status) ? 'action'
    : 'info'
  return { kind, blocking: true, waitingOn: null }
}

test('the docs have examples to check', () => {
  assert.ok(SPEC.length >= 10, `messages.md has ${SPEC.length} examples`)
  assert.ok(AFTERS.length >= 6, `message-samples.md has ${AFTERS.length} After blocks`)
  assert.ok(!AFTERS.some((a) => /^### Before/m.test(a.text)), 'only After blocks are read')
  const coordinators = [...SPEC, ...AFTERS].filter((e) => roleOf(e.text) === 'coordinator').map((e) => e.name)
  assert.ok(coordinators.length >= 3, `the Briefing, the route line and the routed sample are coordinator messages: ${coordinators}`)
})

test('every example in messages.md and every After in message-samples.md has no misses and reads as its status line says', () => {
  for (const { name, text } of [...SPEC, ...AFTERS]) {
    const role = roleOf(text)
    assert.deepEqual(checkFrame(text, { role }).misses.map((m) => `${m.rule}: ${m.detail}`), [], `${name} (${role})`)
    const f = parseFrame(text)
    const filled = text.split('\n').map((l) => l.trim()).filter(Boolean)
    if (filled.every((l) => ROUTE.test(l))) {
      assert.equal(role, 'coordinator', `${name}: only a coordinator routes`)
      assert.equal(f, null, `${name}: a route line alone has no frame`)
      continue
    }
    assert.ok(f, `${name}: the frame is read`)
    assert.deepEqual({ kind: f.kind, blocking: f.blocking, waitingOn: f.waitingOn }, expected(f.status), `${name}: "${f.status}"`)
    // The shape agrees with the kind the status line names.
    if (f.kind === 'decision') assert.ok(f.options.length >= 2, `${name}: a pick has options`)
    if (f.kind === 'approval') assert.match(f.reply ?? '', /^yes or no\b/i, `${name}: a yes has Reply yes or no`)
    if (f.kind === 'review') assert.match(f.reply ?? '', /^approve\b/i, `${name}: a review has Reply approve`)
    if (f.kind === 'action') assert.ok(f.steps.length > 0 || /^done\.?$/i.test(f.reply ?? ''), `${name}: a hand action has Steps or Reply done`)
    if (f.kind === 'none') assert.equal(f.ask, null, `${name}: no Ask`)
  }
})

test('sample 6, the queued QA list, waits on memory for a new worktree', () => {
  const queued = AFTERS.filter((a) => a.sample === 6).at(-1)
  assert.ok(queued, 'sample 6 has an After')
  const f = parseFrame(queued.text)
  assert.deepEqual([f.kind, f.blocking, f.waitingOn], ['none', false, 'memory for a new worktree'])
})
