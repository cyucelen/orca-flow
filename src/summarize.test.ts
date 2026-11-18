// A coordinator's or lead's valid message frame decides the card's ask; Haiku stays the fallback.
import { assert, test } from 'orca/testing'
import type { AgentSummary } from './protocol.ts'
import { digest, frameAsk, shortAsk, withFrame } from './summarize.ts'

const line = (type: string, content: unknown, cwd?: string) => JSON.stringify({ type, cwd, timestamp: '2026-11-18T12:00:00Z', message: { content } })
/** A session whose first prompt names its role and whose latest turn ends with `message`. */
const session = (first: string, message: string, cwd?: string, above = 'I looked into it.\n\n') =>
  digest([line('user', first, cwd), line('user', 'go on'), line('assistant', [{ type: 'text', text: `${above}${message}` }])], '/h/orca/coordinators')!
const lead = (message: string) => session('Your role: lead. Split short docs into lessons.', message)

/** What Haiku wrote for the same turn. */
const haiku = (over: Partial<AgentSummary> = {}) => ({
  title: 'Split lessons', about: 'Short docs become several lessons.', goal: '', since: 'Found the cause',
  needs: { type: 'none' as AgentSummary['needs']['type'], ask: '', options: [] as string[] }, glance: '', watching: '', effort: 'quick' as const, priority: 'P1' as const, ...over
})

const DECISION = `**BOU-4206 · Split short docs into lessons · today**
**Status:** Waiting on you: decision

**Problem:** the Kaimug PDF gives 1 lesson. Expected: about 4.
**Cause:** the planner merges each lesson under 400 tokens into a neighbor.
**Evidence:** plan.ts:173 sets LESSON_FLOOR to 400.

**Ask:** make 1 topic = 1 lesson, with a minimum of 80 tokens. Which documents get this rule?
- **A. All documents (recommended).** Hygiene changes from 1–3 lessons to 6–10.
- **B. Only documents under 1,200 tokens.** Long manuals do not change.
**Reply:** A or B

**Caution:** the plan eval uses Azure OpenAI credits. I ask before I run it.
**Next:** I change the prompt, the minimum, the screen count and the quiz size.`

const BLOCKED = `**Isola on-demand services · soon**
**Status:** Blocked

**Problem:** the iPhone build stops at Xcode. Developer Mode is off on the phone.

**Steps:**
1. On the iPhone, open Settings > Privacy & Security > Developer Mode.
2. Turn on Developer Mode. Let the phone restart.

**Reply:** done
**Next:** I run the device build again.`

const REVIEW = `**Isola on-demand services · soon**
**Status:** Ready for review

**Result:** every isola service in mono starts on demand.
**Evidence:** pnpm dev:native works on the iOS simulator.
**Link:** PR #6227

**Ask:** review the PR. Look first at the on-demand config in isola.yaml.
**Reply:** approve, or your comments
**Next:** I fix your comments.`

const WORKING = `**AI Create v2 production readiness · today**
**Status:** Working

**Done:**
- Runs are durable and rate-limited.

**Next:** nothing needed from you. I write again when the memory numbers are in.`

const BRIEFING = `**bounti · briefing**

**Waiting:**
1. today · BOU-4206 needs a decision: 1 topic = 1 lesson for all documents?
**Running:** AI Create v2 production readiness.
**Room:** 1 more worktree, or 4 more agents.

**Next:** nothing needed from you. Say "next" to open item 1.`

test('a framed decision: type, the Ask without its bullets, option labels and the Reply', () => {
  const d = lead(DECISION)
  assert.equal(d.role, 'lead')
  assert.deepEqual(frameAsk(d), {
    needs: { type: 'decision', ask: 'make 1 topic = 1 lesson, with a minimum of 80 tokens. Which documents get this rule?', options: ['A. All documents', 'B. Only documents under 1,200 tokens'] },
    reply: 'A or B'
  })
  // Haiku read it as an approval about something else: the frame wins, and its glance is replaced.
  const card = withFrame(d, haiku({ needs: { type: 'approval', ask: 'Merge the PR?', options: ['Yes', 'No'] }, glance: 'Merge the PR?' }))
  assert.equal(card.source, 'frame')
  assert.equal(card.needs.type, 'decision')
  assert.equal(card.reply, 'A or B')
  assert.equal(card.glance, 'Which documents get this rule?')
  assert.equal(card.title, 'Split lessons', 'Haiku still writes the rest')
  // Haiku's glance for the same ask stays: it reads better than a clipped sentence.
  const same = withFrame(d, haiku({ needs: { type: 'decision', ask: 'x', options: [] }, glance: '1 topic = 1 lesson for all documents?' }))
  assert.equal(same.glance, '1 topic = 1 lesson for all documents?')
})

test('Blocked with Steps is an action on its Problem, with Done when the Reply is "done"', () => {
  const card = withFrame(lead(BLOCKED), haiku())
  assert.deepEqual(card.needs, { type: 'action', ask: 'the iPhone build stops at Xcode. Developer Mode is off on the phone.', options: ['Done'] })
  assert.equal(card.reply, 'done')
  assert.equal(card.glance, 'The iPhone build stops at Xcode.')
  assert.equal(card.source, 'frame')
})

test('Ready for review is a review with its Ask and Reply', () => {
  const card = withFrame(lead(REVIEW), haiku())
  assert.deepEqual(card.needs, { type: 'review', ask: 'review the PR. Look first at the on-demand config in isola.yaml.', options: [] })
  assert.equal(card.reply, 'approve, or your comments')
  assert.equal(card.glance, 'Review the PR.')
})

test('Idle asks nothing, whatever Haiku guessed', () => {
  const idle = `**orca-flow · message format · today**\n**Status:** Idle\n\n**Done:**\n- PR #23 merged. Orca Flow 0.2.39 is released.\n\n**Next:** nothing needed from you. Send feedback here.`
  const card = withFrame(lead(idle), haiku({ needs: { type: 'review', ask: 'Any feedback on 0.2.39?', options: [] }, glance: 'Any feedback on 0.2.39?' }))
  assert.deepEqual([card.needs, card.glance, card.reply, card.source], [{ type: 'none', ask: '', options: [] }, '', undefined, 'frame'])
})

test('Working and a Briefing ask nothing, whatever Haiku guessed', () => {
  const guessed = haiku({ needs: { type: 'decision', ask: 'Open item 1?', options: [] }, glance: 'Open item 1?' })
  const working = withFrame(lead(WORKING), guessed)
  assert.deepEqual([working.needs, working.glance, working.reply, working.source], [{ type: 'none', ask: '', options: [] }, '', undefined, 'frame'])
  const coordinator = session('hello', BRIEFING, '/h/orca/coordinators/bounti')
  assert.equal(coordinator.role, 'coordinator')
  const briefing = withFrame(coordinator, guessed)
  assert.deepEqual([briefing.needs.type, briefing.glance, briefing.reply, briefing.source], ['none', '', undefined, 'frame'])
  const route = withFrame(session('hello', 'BOU-4206 → lead in mono/bou-4206-aic-split-lessons · today', '/h/orca/coordinators/bounti', ''), guessed)
  assert.deepEqual([route.needs.type, route.source], ['none', 'frame'], 'a route line asks nothing')
})

test("an invalid frame, a worker, or a chat keeps Haiku's ask", () => {
  const guessed = haiku({ needs: { type: 'decision', ask: 'A or B?', options: ['A', 'B'] }, glance: 'A or B?' })
  const broken = lead(DECISION.replace('**Reply:** A or B\n', ''))
  assert.equal(frameAsk(broken), null, 'a decision without Reply is not a valid frame')
  assert.deepEqual(withFrame(broken, guessed), { ...guessed, source: 'summarizer' })
  assert.deepEqual(withFrame(lead('PR is up. Merge it?'), guessed), { ...guessed, source: 'summarizer' }, 'no frame at all')
  const worker = session('=== TASK ===\nFix it. Dispatch ID d-1, send worker_done.', DECISION)
  assert.equal(worker.role, 'worker')
  assert.deepEqual(withFrame(worker, guessed), { ...guessed, source: 'summarizer' }, 'a worker is never framed')
  assert.equal(withFrame(session('fix the bug', DECISION), guessed).source, 'summarizer', 'nor a chat you started')
})

test('the whole final message is checked, not the clipped one Haiku reads', () => {
  const long = `${'Detail line. '.repeat(400)}\n\n${DECISION}`
  const d = lead(long)
  assert.ok(d.lastAssistant.length < d.lastMessage.length)
  assert.equal(frameAsk(d)?.needs.type, 'decision')
})

test('the short form of an ask is its question, at most ten words', () => {
  assert.equal(shortAsk('make 1 topic = 1 lesson. Which documents get this rule?'), 'Which documents get this rule?')
  assert.equal(shortAsk('turn on developer mode on the phone and then plug it into the mac again please'), 'Turn on developer mode on the phone and then plug…')
  assert.equal(shortAsk(''), '')
})
