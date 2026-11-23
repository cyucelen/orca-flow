// A coordinator's or lead's valid message frame decides the card's ask; Haiku stays the fallback.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import type { AgentSummary } from './protocol.ts'
import { digest, frameAsk, roleOf, shortAsk, withFrame } from './summarize.ts'

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

// The frame fixtures (test/frames.md), in their order.
const spec = readFileSync(new URL('../test/frames.md', import.meta.url).pathname, 'utf8')
const [DECISION, STYLE, INFO, PLAN, LATER, BLOCKED, REVIEW, RELEASED, ANSWER, APPROVAL, BRIEFING, ROUTE] = [...spec.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((m) => m[1])

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
  assert.deepEqual([approval.needs.type, approval.needs.ask, approval.reply, approval.status], ['approval', 'run the account merge on the staging database?', 'yes or no', 'Needs your yes'])
})

test('Working, Idle, a Briefing and a route line ask nothing, whatever Haiku guessed', () => {
  for (const [name, d] of [['working', lead(PLAN)], ['released', lead(RELEASED)], ['answer', lead(ANSWER)], ['briefing', coordinator(BRIEFING)], ['route', coordinator(ROUTE)]] as const) {
    const card = withFrame(d, guessed)
    assert.deepEqual([card.needs, card.glance, card.reply, card.status, card.source], [{ type: 'none', ask: '', options: [] }, '', undefined, undefined, 'frame'], name)
  }
  assert.equal(coordinator(BRIEFING).role, 'coordinator')
})

test("an unreadable frame, the old shape, a worker, or a chat keeps Haiku's ask", () => {
  const broken = lead(DECISION.replace('**Reply:** A, B or no', ''))
  assert.equal(frameAsk(broken), null, 'a pick with no Reply is a block-tier miss')
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

test('a lead the user recorded (orca-flow role lead) is a lead on the card; worker, chat and coordinator stay otherwise', () => {
  const at = (first: string, cwd?: string) => [
    JSON.stringify({ type: 'user', sessionId: 's-1', cwd, timestamp: '2026-11-20T14:52:00Z', message: { content: first } }),
    JSON.stringify({ type: 'assistant', sessionId: 's-1', timestamp: '2026-11-21T21:27:00Z', message: { content: [{ type: 'text', text: 'Done.' }] } })
  ]
  const recorded = (session: string) => (session === 's-1' ? 'lead' : null)
  const nobody = () => null
  // The provider-costs shape: dispatched as a worker, then steered by the user as its lead.
  const preamble = 'You are working inside Orca. You are a dispatched worker.\nYour task ID is: task_275091af6331\n=== TASK ===\nDesign the cost page.'
  assert.equal(digest(at(preamble), '/h/orca/coordinators', recorded)!.role, 'lead')
  assert.equal(digest(at(preamble), '/h/orca/coordinators', nobody)!.role, 'worker')
  assert.equal(digest(at('fix the bug'), '/h/orca/coordinators', recorded)!.role, 'lead', 'a chat the user made a lead')
  assert.equal(digest(at('fix the bug'), '/h/orca/coordinators', nobody)!.role, 'solo')
  assert.equal(digest(at('hello', '/h/orca/coordinators/bounti'), '/h/orca/coordinators', recorded)!.role, 'coordinator', 'the folder decides')
  assert.equal(digest(at('Your role: lead. Ship it.'), '/h/orca/coordinators', nobody)!.role, 'lead', 'the role line still works alone')
  assert.equal(roleOf(preamble, [], null, '/h/orca/coordinators', 'lead'), 'lead')
  assert.equal(roleOf(preamble, [], null, '/h/orca/coordinators', null), 'worker')
  assert.equal(roleOf('hi', [], '/h/orca/coordinators/x', '/h/orca/coordinators', 'lead'), 'coordinator')
})

test('a frame with only style misses still decides the ask', () => {
  // No option marked (recommended), a 5-sentence context, a code hash: all silent misses.
  const styled = DECISION.replace(' (recommended)', '').replace('Your decision on the fix itself is held until this test ends.', 'Your decision on the fix itself is held until this test ends. The fix sits in 1b44b06. It took 2 days.')
  const framed = frameAsk(lead(styled))
  assert.equal(framed?.needs.type, 'decision')
  assert.deepEqual(framed?.needs.options, ['A. All 10 documents + Kaimug', 'B. Without peri'])
  assert.equal(withFrame(lead(styled), guessed).source, 'frame')
  const long = lead(PLAN.replace(/\n\n\*\*Working\*\*\n\n([^\n]+)/, (_, c) => `\n\n**Working**\n\n${c} One. Two. Three. Four.`))
  assert.deepEqual(withFrame(long, guessed).needs, { type: 'none', ask: '', options: [] }, 'a long Working context still clears a guessed ask')
})

test('Waiting on <thing> asks nothing and names what the card watches', () => {
  const waiting = (thing: string) => lead(`**Waiting on ${thing}**\n\nThe fix for the saved address is pushed. CI runs the tests, about 10 minutes.`)
  assert.deepEqual(frameAsk(waiting('CI')), { needs: { type: 'none', ask: '', options: [] }, reply: '', status: 'Waiting on CI', waitingOn: 'CI' })
  const card = withFrame(waiting('CI'), { ...guessed, watching: 'tests' })
  assert.deepEqual([card.needs.type, card.glance, card.watching, card.status, card.source], ['none', '', 'CI', undefined, 'frame'])
  assert.equal(withFrame(waiting('a free slot for a worker to start the eval run'), haiku()).watching, 'a free slot for a worker…', 'clipped to six words')
  assert.equal(withFrame(lead(PLAN), haiku({ watching: 'its workers' })).watching, 'its workers', "Working keeps Haiku's watching")
  assert.equal(frameAsk(lead('**Waiting on your review**\n\nPR #55 is up.\n\n**Ask:** review PR #55?\n**Reply:** approve, or your comments')), null, 'Waiting on your ... is an old status word')
})

test('the queued QA list in message-samples.md (sample 6) asks nothing and watches memory', () => {
  const samples = readFileSync(new URL('../docs/message-samples.md', import.meta.url).pathname, 'utf8')
  const queued = [...samples.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((m) => m[1]).find((b) => /^\*\*Waiting on memory for a new worktree\*\*$/m.test(b))
  assert.ok(queued, 'sample 6 has its Waiting on After')
  const d = coordinator(queued!)
  assert.deepEqual(frameAsk(d)?.needs, { type: 'none', ask: '', options: [] })
  assert.equal(frameAsk(d)?.waitingOn, 'memory for a new worktree')
  const card = withFrame(d, guessed)
  assert.deepEqual([card.needs.type, card.glance, card.watching, card.source], ['none', '', 'memory for a new worktree', 'frame'])
})

test('an agent that runs orca-flow dispatch or plan start/next coordinates; read-only forms and mentions do not', () => {
  const ran = (command: string) => [{ kind: 'tool' as const, text: `Bash: ${command}` }]
  const solo = (command: string) => assert.equal(roleOf('fix the bug', ran(command), null, '/h/orca/coordinators', null), 'solo', command)
  const coordinates = (command: string) => assert.equal(roleOf('fix the bug', ran(command), null, '/h/orca/coordinators', null), 'coordinator', command)
  coordinates('orca-flow dispatch --spec "fix the parser"')
  coordinates('node /Users/a/.orca/orca-flow.mjs dispatch --spec "x"')
  coordinates('node "/Users/a/My Projects/orca-flow.mjs" plan start --plan "Model routing"')
  coordinates('node "/Users/a/My Projects/orca-flow.mjs" plan next --plan "Model routing"')
  coordinates('cd repo && orca-flow plan next')
  coordinates('npm test; orca-flow dispatch --spec x')
  coordinates('orca orchestration worker-start --from term_1 --spec "x" --json')
  solo('orca-flow route "fix the parser"')
  solo('node /Users/a/.orca/orca-flow.mjs plan check --plan "Model routing"')
  solo('orca-flow plan status')
  solo('grep -rn "orca-flow dispatch" src')
  solo('cat docs/model-routing.md')
  solo('echo done && grep "plan start" README.md')
  assert.equal(roleOf('fix the bug', [{ kind: 'tool', text: 'Bash: cat <<\'EOF\'\norca-flow dispatch --spec x\nEOF' }], null, '/h/orca/coordinators', null), 'solo', 'a heredoc body')
  assert.equal(roleOf('fix the bug', [{ kind: 'tool', text: 'Bash: orca-flow dispatch --spec x' }], null, '/h/orca/coordinators', null), 'coordinator')
})

// Mail and notifications: a wake (Orca's mail notice, a task notification) is not the user, and a short
// acknowledgment after it must not clear the ask the user still has open.
const WAKE = 'You have 1 orchestration message. Run `orca orchestration check`.'
const NOTIFY = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'
const say = (text: string) => line('assistant', [{ type: 'text', text }])
const tool = line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'orca orchestration check' } }])
/** A lead's session: it asks a pick, then each of `after` happens in order (a string is a user prompt or a wake, an array an assistant text). */
const leadAfter = (...after: (string | { say: string })[]) => digest([
  line('user', 'Your role: lead. Split short docs into lessons.'), line('user', 'go on'), say(DECISION),
  ...after.map((e) => (typeof e === 'string' ? line('user', e) : say(e.say)))
], '/h/orca/coordinators')!
const PICK = 'run the plan eval on Azure OpenAI?'

test('wake, no text: the card keeps the pick', () => {
  const d = leadAfter(WAKE, WAKE, NOTIFY)
  assert.equal(d.lastMessage, DECISION)
  assert.equal(frameAsk(d)?.needs.ask, PICK)
})

test('wake, short ack "Noted.": the card keeps the pick', () => {
  for (const wake of [WAKE, NOTIFY]) {
    const d = leadAfter(wake, { say: 'Noted.' })
    assert.equal(d.lastMessage, DECISION, 'the ack does not replace the frame')
    assert.equal(frameAsk(d)?.needs.type, 'decision')
    assert.equal(frameAsk(d)?.needs.ask, PICK)
    assert.match(d.turn, /Noted\./, 'Haiku still sees the ack in the turn')
  }
})

test('two or three repeated wakes with acks: still the same pick', () => {
  const d = leadAfter(WAKE, { say: 'Noted.' }, WAKE, { say: 'Ok.' }, NOTIFY, { say: 'Got it.' })
  assert.equal(d.lastMessage, DECISION)
  assert.equal(frameAsk(d)?.needs.ask, PICK)
})

test('wake, then a changed decision as one new frame: the new ask decides', () => {
  const next = INFO
  const d = leadAfter(WAKE, { say: 'Noted.' }, WAKE, { say: `The worker's report changed the plan; the pick above is replaced.\n\n${next}` })
  assert.equal(d.lastMessage.includes('Needs 2 files from you'), true)
  assert.equal(frameAsk(d)?.needs.type, 'info')
  assert.equal(frameAsk(d)?.needs.ask, 'where are the JBC and Foodelity source PDFs?')
  const idle = leadAfter(WAKE, { say: RELEASED })
  assert.deepEqual(frameAsk(idle)?.needs, { type: 'none', ask: '', options: [] }, 'Idle after a wake ends the ask')
})

test('a human prompt starts a new turn: "status?" is not a wake', () => {
  const d = leadAfter(WAKE, { say: 'Noted.' }, 'status?')
  assert.equal(d.lastMessage, '', 'no reply yet, and the earlier turn is not current')
  const answered = leadAfter('status?', { say: 'Noted.' })
  assert.equal(answered.lastMessage, 'Noted.', 'a short reply to a human is that turn\'s final message')
  assert.equal(frameAsk(answered), null)
  const framed = leadAfter(WAKE, 'status?', { say: ANSWER })
  assert.equal(framed.lastMessage, ANSWER)
})

test('a long message after a wake without a frame is not an acknowledgment', () => {
  const long = 'The worker finished and all 12 tests pass. '.repeat(8).trim()
  const d = leadAfter(WAKE, { say: long })
  assert.equal(d.lastMessage, long)
})

test('a coordinator after a wake does not inherit a lead\'s ask', () => {
  const lines = (...after: string[]) => [
    line('user', 'hello', '/h/orca/coordinators/bounti'), line('user', 'next?'), say(BRIEFING), line('user', WAKE), tool,
    line('user', [{ type: 'tool_result', content: 'From the lead: please pick A or B for the plan eval. Reply: A or B' }]),
    ...after.map(say)
  ]
  const acked = digest(lines('Noted.'), '/h/orca/coordinators')!
  assert.equal(acked.role, 'coordinator')
  assert.equal(acked.lastMessage, BRIEFING, 'the coordinator\'s own last frame stands')
  assert.deepEqual(frameAsk(acked)?.needs, { type: 'none', ask: '', options: [] })
  const bare = digest([line('user', 'hello', '/h/orca/coordinators/bounti'), line('user', WAKE), tool, line('user', [{ type: 'tool_result', content: 'From the lead: pick A or B' }]), say('Noted.')], '/h/orca/coordinators')!
  assert.equal(bare.lastMessage, 'Noted.', 'with no frame of its own, the ack decides and asks nothing')
  assert.equal(frameAsk(bare), null)
})

test('a worker after a wake is untouched: no frame rules apply to it', () => {
  const d = digest([line('user', 'You are a dispatched worker. Your task ID is: task_1\n=== TASK ===\nFix it'), say('Which file do you mean?'), line('user', WAKE), say('Noted.')], '/h/orca/coordinators')!
  assert.equal(d.role, 'worker')
  assert.equal(d.lastMessage, 'Noted.')
})
