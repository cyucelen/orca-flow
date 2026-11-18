// A coordinator's or lead's valid message frame decides the card's ask; Haiku stays the fallback.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import type { AgentSummary } from './protocol.ts'
import { digest, frameAsk, shortAsk, withFrame } from './summarize.ts'

const line = (type: string, content: unknown, cwd?: string) => JSON.stringify({ type, cwd, timestamp: '2026-11-18T12:00:00Z', message: { content } })
/** A session whose first prompt names its role and whose latest turn ends with `message`. */
const session = (first: string, message: string, cwd?: string, above = 'I looked into it.\n\n') =>
  digest([line('user', first, cwd), line('user', 'go on'), line('assistant', [{ type: 'text', text: `${above}${message}` }])], '/h/orca/coordinators')!
const lead = (message: string) => session('Your role: lead. Split short docs into lessons.', message)
const coordinator = (message: string) => session('hello', message, '/h/orca/coordinators/bounti', '')

/** What Haiku wrote for the same turn. */
const haiku = (over: Partial<AgentSummary> = {}) => ({
  title: 'Split lessons', about: 'Short docs become several lessons.', goal: '', since: 'Found the cause',
  needs: { type: 'none' as AgentSummary['needs']['type'], ask: '', options: [] as string[] }, glance: '', watching: '', effort: 'quick' as const, priority: 'P1' as const, ...over
})
const guessed = haiku({ needs: { type: 'decision', ask: 'Open item 1?', options: [] }, glance: 'Open item 1?' })

// The examples in skills/orca-flow/messages.md, in its order.
const spec = readFileSync(new URL('../skills/orca-flow/messages.md', import.meta.url).pathname, 'utf8')
const [DECISION, INFO, PLAN, LATER, BLOCKED, REVIEW, RELEASED, ANSWER, APPROVAL, BRIEFING, ROUTE] = [...spec.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((m) => m[1])

test('a framed pick: decision, the Ask, option labels, the Reply and the status line', () => {
  const d = lead(DECISION)
  assert.equal(d.role, 'lead')
  assert.deepEqual(frameAsk(d), {
    needs: { type: 'decision', ask: 'run the plan eval on Azure OpenAI?', options: ['A. All 10 documents + Kaimug', 'B. Without peri'] },
    reply: 'A, B or no',
    status: 'Needs your pick'
  })
  // Haiku read it as an approval about something else: the frame wins, and its glance is replaced.
  const card = withFrame(d, haiku({ needs: { type: 'approval', ask: 'Merge the PR?', options: ['Yes', 'No'] }, glance: 'Merge the PR?' }))
  assert.equal(card.source, 'frame')
  assert.equal(card.needs.type, 'decision')
  assert.equal(card.reply, 'A, B or no')
  assert.equal(card.status, 'Needs your pick')
  assert.equal(card.glance, 'Run the plan eval on Azure OpenAI?')
  assert.equal(card.title, 'Split lessons', 'Haiku still writes the rest')
  // Haiku's glance for the same ask stays.
  const same = withFrame(d, haiku({ needs: { type: 'decision', ask: 'x', options: [] }, glance: 'Run the eval with or without peri?' }))
  assert.equal(same.glance, 'Run the eval with or without peri?')
})

test('a fact or a file is info; a later need is not blocking', () => {
  const info = withFrame(lead(INFO), haiku())
  assert.deepEqual(info.needs, { type: 'info', ask: 'where are the JBC and Foodelity source PDFs?', options: [] })
  assert.deepEqual([info.status, info.reply], ['Needs 2 files from you', 'the 2 file paths, or a link'])
  const later = withFrame(lead(LATER), haiku())
  assert.deepEqual(later.needs, { type: 'info', ask: 'where are the JBC and Foodelity source PDFs?', options: [], blocking: false })
  assert.equal(later.status, 'Working · needs 2 files later')
})

test('a hand action takes its ask from the status line, with Done when the Reply is done', () => {
  const card = withFrame(lead(BLOCKED), haiku())
  assert.deepEqual(card.needs, { type: 'action', ask: 'Turn on Developer Mode.', options: ['Done'] })
  assert.equal(card.reply, 'done')
  assert.equal(card.glance, 'Turn on Developer Mode.')
  assert.equal(card.source, 'frame')
})

test('a review and a yes keep their Ask and Reply', () => {
  const review = withFrame(lead(REVIEW), haiku())
  assert.deepEqual(review.needs, { type: 'review', ask: 'review PR #6227. Look first at the on-demand config in isola.yaml.', options: [] })
  assert.equal(review.reply, 'approve, or your comments')
  assert.equal(review.glance, 'Review PR #6227.')
  const approval = withFrame(lead(APPROVAL), haiku())
  assert.deepEqual([approval.needs.type, approval.needs.ask, approval.reply, approval.status], ['approval', 'run the merge migration on staging?', 'yes or no', 'Needs your yes'])
})

test('Working, Idle, a Briefing and a route line ask nothing, whatever Haiku guessed', () => {
  for (const [name, d] of [['working', lead(PLAN)], ['released', lead(RELEASED)], ['answer', lead(ANSWER)], ['briefing', coordinator(BRIEFING)], ['route', coordinator(ROUTE)]] as const) {
    const card = withFrame(d, guessed)
    assert.deepEqual([card.needs, card.glance, card.reply, card.status, card.source], [{ type: 'none', ask: '', options: [] }, '', undefined, undefined, 'frame'], name)
  }
  assert.equal(coordinator(BRIEFING).role, 'coordinator')
})

test("an invalid frame, the old shape, a worker, or a chat keeps Haiku's ask", () => {
  const broken = lead(DECISION.replace(' (recommended)', ''))
  assert.equal(frameAsk(broken), null, 'a pick with no recommended option is not a valid frame')
  assert.deepEqual(withFrame(broken, guessed), { ...guessed, source: 'summarizer' })
  const old = '**BOU-4206 · Split · today**\n**Status:** Waiting on you: approval\n\n**Ask:** run the eval?\n**Reply:** yes or no\n**Next:** I run it.'
  assert.deepEqual(withFrame(lead(old), guessed), { ...guessed, source: 'summarizer' }, 'the old header + Status shape')
  const oldWord = INFO.replace('**Needs 2 files from you**', '**Waiting on you: info**')
  assert.deepEqual(withFrame(lead(oldWord), guessed), { ...guessed, source: 'summarizer' }, 'an old status word')
  assert.deepEqual(withFrame(lead('PR is up. Merge it?'), guessed), { ...guessed, source: 'summarizer' }, 'no frame at all')
  const worker = session('=== TASK ===\nFix it. Dispatch ID d-1, send worker_done.', DECISION)
  assert.equal(worker.role, 'worker')
  assert.deepEqual(withFrame(worker, guessed), { ...guessed, source: 'summarizer' }, 'a worker is never framed')
  assert.equal(withFrame(session('fix the bug', DECISION), guessed).source, 'summarizer', 'nor a chat you started')
})

test('the whole final message is checked, not the clipped one Haiku reads', () => {
  const d = lead(`${'Detail line. '.repeat(400)}\n\n${DECISION}`)
  assert.ok(d.lastAssistant.length < d.lastMessage.length)
  assert.equal(frameAsk(d)?.needs.type, 'decision')
})

test('the short form of an ask is its question, at most ten words', () => {
  assert.equal(shortAsk('make 1 topic = 1 lesson. Which documents get this rule?'), 'Which documents get this rule?')
  assert.equal(shortAsk('turn on developer mode on the phone and then plug it into the mac again please'), 'Turn on developer mode on the phone and then plug…')
  assert.equal(shortAsk(''), '')
})
