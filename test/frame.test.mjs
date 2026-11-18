// node --test test/*.test.mjs
// The message frame (skills/orca-flow/scripts/frame.mjs) and the Stop hook that applies it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkFrame, parseFrame, TIERS } from '../skills/orca-flow/scripts/frame.mjs'
import { optedIn, readTranscript } from '../skills/orca-flow/scripts/stop-check.mjs'

const SCRIPTS = fileURLToPath(new URL('../skills/orca-flow/scripts/', import.meta.url))

// The examples in messages.md are the fixtures: the spec and the checker cannot drift apart.
const SPEC = readFileSync(new URL('../skills/orca-flow/messages.md', import.meta.url), 'utf8')
const EXAMPLES = [...SPEC.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((m) => m[1])
const [DECISION, STYLE, INFO, PLAN, LATER, BLOCKED, REVIEW, RELEASED, ANSWER, APPROVAL, BRIEFING, ROUTE] = EXAMPLES

const rules = (text, role = 'lead') => checkFrame(text, { role }).misses.map((m) => m.rule)
const ok = (text, role = 'lead') => assert.deepEqual(checkFrame(text, { role }), { ok: true, misses: [] }, text.split('\n').find((l) => l.startsWith('**')))

test('every example in messages.md passes: the briefing and the route line as a coordinator', () => {
  assert.equal(EXAMPLES.length, 12)
  for (const example of EXAMPLES) ok(example, 'coordinator')
  for (const example of [DECISION, STYLE, INFO, PLAN, LATER, BLOCKED, REVIEW, RELEASED, ANSWER, APPROVAL]) ok(example, 'lead')
  ok(`${ROUTE}\n\nISO-12 → lead in mono/isola · soon\n`, 'coordinator')
  assert.deepEqual(rules(ROUTE), ['status'], 'only a coordinator routes')
  assert.deepEqual(rules(BRIEFING), ['detail'], "only a coordinator lists waiting items")
})

// The BOU-4206 lead's eval message in the old shape, with the faults the user found.
const OLD_EVAL = `I counted the passages per document (table above).

**BOU-4206 · Split short docs into lessons · today**
**Status:** Waiting on you: approval

**Answer:** the repo has 10 eval documents. Most passages are under 400 tokens.
**Evidence:** see the table above. peri has 212 passages.

**Ask:** run the plan eval on Azure OpenAI?
**Reply:** yes or no

**Caution:** the eval uses Azure credits ($). We could leave peri out.
**Next:** I run it after your yes.`

test("the BOU-4206 eval message in the old shape fails: header, its labels, a cost with no number", () => {
  const misses = checkFrame(OLD_EVAL, { role: 'lead' }).misses
  const got = misses.map((m) => m.rule)
  for (const rule of ['header', 'label', 'cost-number']) assert.ok(got.includes(rule), `${rule} in ${got}`)
  assert.deepEqual(misses.filter((m) => m.rule === 'label').map((m) => m.detail.match(/\*\*(\w+):/)[1]), ['Answer', 'Evidence'])
  assert.deepEqual(got, ['header', 'status-old', 'status-label', 'context', 'label', 'label', 'cost-number'], 'and it has no context paragraph')
  assert.equal(parseFrame(OLD_EVAL), null, 'the old shape is not read: the sidebar falls back to Haiku')
})

test('status: a bold status line in plain words, the last one outside code fences', () => {
  assert.deepEqual(rules('Done. The PR is up.'), ['status'])
  assert.deepEqual(rules(PLAN.replace('**Working**', '**In progress**')), ['status'])
  assert.deepEqual(rules(PLAN.replace('**Working**', '**working**')), ['status'], 'the words never change')
  assert.deepEqual(rules(PLAN.replace('**Working**', 'Working')), ['status'], 'bold as a whole')
  assert.deepEqual(rules(INFO.replace('**Needs 2 files from you**', '**needs 2 files from you**')), ['status'])
  assert.deepEqual(rules(LATER.replace('**Working · needs 2 files later**', '**Working · needs 2 files**')), ['status'], 'a later need says "later"')
  assert.deepEqual(rules(PLAN.replace('**Working**', '**Working.**')), [], 'one trailing period')
  assert.deepEqual(rules('```\n' + RELEASED + '\n```'), ['status'], 'a frame inside a code block does not count')
  assert.deepEqual(rules(`**Needs you to restart**\n\nOld frame.\n\n**Steps:**\n1. x\n\n**Reply:** done\n\n${RELEASED}`), [], 'the last frame counts')
})

test('status-old: the old status words name the plain line to use', () => {
  const old = (status, text) => checkFrame(text.replace(/^\*\*(Needs|Working ·)[^\n]*\*\*$/m, `**${status}**`), { role: 'lead' }).misses
  const info = old('Waiting on you: info', INFO)
  assert.deepEqual(info.map((m) => m.rule), ['status-old'], 'the BOU-4206 3:08 PM message')
  assert.match(info[0].detail, /\*\*Needs <the thing> from you\*\*/)
  assert.match(old('Waiting on you: decision', DECISION)[0].detail, /\*\*Needs your pick\*\*/)
  assert.match(old('Waiting on you: approval', APPROVAL)[0].detail, /\*\*Needs your yes\*\*/)
  assert.match(old('Ready for review', REVIEW)[0].detail, /\*\*Needs your review\*\*/)
  assert.match(old('Blocked', BLOCKED)[0].detail, /\*\*Needs you to <action>\*\*/)
  assert.deepEqual(old('Blocked', BLOCKED).map((m) => m.rule), ['status-old'], 'the rest of the old frame still checks out')
  assert.equal(parseFrame(INFO.replace('**Needs 2 files from you**', '**Waiting on you: info**')), null, 'the sidebar falls back to Haiku')
})

test('header: the old header line above the status line', () => {
  assert.deepEqual(rules(`**BOU-4206 · Split short docs into lessons · today**\n${PLAN.slice(PLAN.indexOf('**Working**'))}`), ['header'])
  assert.deepEqual(rules(`**Note** · fine\n\nThe text.\n\n${ANSWER}`), [], 'a bold line further up is detail, not a header')
})

test('context: a plain paragraph of at most 4 sentences', () => {
  assert.deepEqual(rules('**Idle**\n\n**Next:** nothing.'), ['context'])
  assert.deepEqual(rules('**Idle**'), ['context'])
  assert.deepEqual(rules('**Idle**\n\n- PR merged.\n- Released.'), ['context', 'detail'], 'a list is not context')
  const five = 'The PR merged. Release 0.2.40 is out. Nothing runs. Send feedback here. I am idle.'
  assert.deepEqual(rules(`**Idle**\n\n${five}`), ['context-long'])
  assert.deepEqual(rules('**Idle**\n\nVersion 0.2.40 of plan.ts and isola.yaml is out. See ~/x/y.md for it.'), [], 'dots in numbers and paths do not end a sentence')
  assert.deepEqual(rules('**Idle**\n\nThe PR merged.\nRelease 0.2.40 is out.\nNothing runs.'), [], 'one paragraph may span lines')
})

test('detail: tables, headings, code, lists and a second paragraph go above the frame', () => {
  const idle = (extra) => rules(`**Idle**\n\nThe PR merged, and the release is out.\n\n${extra}`)
  assert.deepEqual(idle('| a | b |\n| --- | --- |'), ['detail'])
  assert.deepEqual(idle('## Changes'), ['detail'])
  assert.deepEqual(idle('```\nnpm test\n```'), ['detail'])
  assert.deepEqual(idle('It took 3 rounds of review.'), ['detail'], 'a second paragraph')
  assert.deepEqual(idle('- the sidebar\n- the hook'), ['detail'], 'a list outside Ask and Steps')
  assert.deepEqual(rules(`${BLOCKED.replace('**Reply:** done', '**Reply:** done\n- or skip it')}`), ['detail'], 'a list under Reply')
  assert.match(checkFrame('**Idle**\n\nThe release is out.\n\n| a |', { role: 'lead' }).misses[0].detail, /a table above the status line/)
  assert.deepEqual(rules(`${ANSWER}\n\nAnything else?`), ['detail'], 'text after the frame')
})

test('label: only Ask, Reply, Steps, Warning, Caution and Next', () => {
  const bad = checkFrame(ANSWER.replace("A worker's row", "**Answer:** a worker's row"), { role: 'lead' }).misses
  assert.deepEqual(bad.map((m) => m.rule), ['context', 'label'])
  assert.match(bad[1].detail, /\*\*Answer:\*\*/)
  for (const label of ['Done', 'Plan', 'Problem', 'Cause', 'Evidence', 'Result', 'Link', 'Waiting', 'Running', 'Room', 'Status']) {
    assert.deepEqual(rules(`${RELEASED}\n**${label}:** x`), ['label'], label)
  }
  assert.deepEqual(rules(`**Notes:** above the frame\n\n${RELEASED}`), [], 'detail above the frame is free')
})

test('ask and ask-status: a need has an Ask and a Reply; Working, Idle and Done have no Ask', () => {
  assert.deepEqual(rules(DECISION.replace('**Reply:** A, B or no', '')), ['ask'])
  assert.deepEqual(rules(REVIEW.replace(/\*\*Ask:\*\*.*\n/, '')), ['ask'])
  assert.deepEqual(rules(APPROVAL.replace('**Reply:** yes or no\n', '')), ['ask'])
  assert.deepEqual(rules(INFO.replace(/\*\*Ask:\*\*.*\n/, '')), ['ask'])
  assert.deepEqual(rules(LATER.replace(/\*\*Reply:\*\*.*/, '')), ['ask'], 'a later need asks too')
  assert.deepEqual(rules(BLOCKED.replace('**Reply:** done\n', '')), ['ask'])
  const bare = checkFrame(BLOCKED.replace(/\*\*Steps:\*\*\n(\d\..*\n)+/, ''), { role: 'lead' }).misses
  assert.deepEqual(bare.map((m) => m.rule), ['ask'], 'a hand action without Steps or an Ask')
  assert.match(bare[0].detail, /\*\*Steps:\*\* \(or \*\*Ask:\*\*\) and \*\*Reply:\*\* done/)
  assert.deepEqual(rules(`${PLAN}\n\n**Ask:** where are the 2 PDFs?\n**Reply:** the file paths`), ['ask-status'], 'Working with an Ask')
  assert.match(checkFrame(`${PLAN}\n\n**Ask:** x?\n**Reply:** y`, { role: 'lead' }).misses[0].detail, /Working · needs \.\.\. later/)
  assert.deepEqual(rules(`${RELEASED}\n\n**Ask:** any feedback?\n**Reply:** your feedback`), ['ask-status'])
  assert.deepEqual(rules(PLAN), [], 'Working needs no ask')
})

test('options and recommended: a pick gives 2 or more options, one recommended', () => {
  const pick = APPROVAL.replace('**Needs your yes**', '**Needs your pick**')
  assert.deepEqual(rules(pick), ['options'], '"Needs your pick" without options')
  assert.deepEqual(rules(LATER.replace('needs 2 files later', 'needs your pick later')), ['options'])
  assert.deepEqual(rules(DECISION.replace(/- \*\*B\..*\n/, '')), ['options'])
  assert.deepEqual(rules(DECISION.replace(' (recommended)', '')), ['recommended'])
  assert.deepEqual(rules(DECISION.replace('**B. Without peri.**', '**B. Without peri (recommended).**')), ['recommended'])
  assert.match(checkFrame(DECISION.replace(' (recommended)', ''), { role: 'lead' }).misses[0].detail, /0 are marked/)
})

// The BOU-4206 lead's plan-compare message: tested variants called A and B, then a new A/B/C.
const COMPARE = (columns, context) => `${columns}
| --- | --- | --- |
| Kaimug | 4 | 4 |
| peri | 31 | 11 |

**Needs your pick**

${context}

**Ask:** which rule goes in?
- **A. All documents (recommended).** Kaimug gets 4 lessons. peri gets 31.
- **B. No rule.** Nothing changes.
- **C. Courses under 1,200 tokens.** Kaimug gets 4 lessons. peri keeps 11.

**Reply:** A, B or C`

test('letters: option letters belong to the current Ask', () => {
  const failing = COMPARE('| Course | Option A | Option B |', 'The eval ran both variants (table above). With option A, B the short courses split well. peri grows from 11 to 31 lessons under the all-documents rule.')
  const misses = checkFrame(failing, { role: 'lead' }).misses
  assert.deepEqual(misses.map((m) => m.rule), ['letters'])
  assert.match(misses[0].detail, /^option letters belong to the current Ask: name earlier options by what they are; refer to a current option by its bare letter/)
  assert.match(misses[0].detail, /"Option A"/, 'the table header above the frame counts')

  const fixed = COMPARE('| Course | All documents | Courses under 1,200 tokens |', 'The eval ran both rules (table above). Short courses split well under each rule. peri grows from 11 to 31 lessons under the all-documents rule. C is the earlier courses-under-1,200 rule.')
  assert.deepEqual(rules(fixed), [])

  const context = (text) => rules(COMPARE('| Course | All | Short |', text))
  assert.deepEqual(context('The earlier A/B decision is held.'), ['letters'], 'a slash pair')
  assert.deepEqual(context('We tested A/B/C last week.'), ['letters'])
  assert.deepEqual(context('We tested options A and B last week.'), ['letters'])
  assert.deepEqual(context('Options A, B or C all split Kaimug.'), ['letters'])
  assert.deepEqual(context('The A/B test ran last week.'), ['letters'], 'an A/B test is flagged too: rare, accepted')
  assert.deepEqual(context('A short course splits well. I tested it on Kaimug. C is the earlier rule.'), [], 'bare capital letters pass')
  assert.deepEqual(context('The rule is N/A for peri. I/O time is 2 seconds.'), [], 'N/A and I/O are not option letters')
  assert.deepEqual(rules(`${COMPARE('| Course | All | Short |', 'The eval ran (table above).')}\n**Next:** I apply option C.`), ['letters'], 'Next counts too')
  assert.deepEqual(rules(COMPARE('```\nOption A | Option B\n```', 'The eval ran (code above).')), [], 'code fences are not read')

  assert.deepEqual(rules(`We dropped option A last week.\n\n${APPROVAL}`), [], 'no lettered Ask: the rule does not apply')
  assert.deepEqual(rules(`**Idle**\n\nThe A/B decision is answered: option A is in.`), [], 'nor with no Ask at all')
})

// The BOU-4207 image-style lead's frame that the user could not read cold.
const STYLE_HOT = `**Needs your pick**

The root cause is above: the style exists only as vague text, and the reference photos change from image to image and are stronger than that text. My earlier question about the style anchor plus new reference text, or new reference text only, is held.

**Ask:** do I reproduce the drift locally with the Kaimug PDF before you choose the fix?
- **A. Reproduce first (recommended).** I test the style anchor and the reference text.
- **B. Choose now.** No reproduction.

**Reply:** A or B`

test('above: a pointer to the detail never replaces the point', () => {
  const misses = checkFrame(STYLE_HOT, { role: 'lead' }).misses
  assert.deepEqual(misses.map((m) => m.rule), ['above'], 'the BOU-4207 frame; its jargon has no backticks, so only "above" is caught')
  assert.equal(misses[0].detail, `state the point in one sentence, then point with '(detail above)' (found "is above")`)
  const idle = (context) => rules(`**Idle**\n\n${context}`)
  assert.deepEqual(idle('The images differ because each one follows its reference photo (detail above).'), [], '(detail above) passes')
  assert.deepEqual(idle('The release is out (changes above). Nothing runs now.'), [])
  for (const text of ['Above, the cause.', 'As above, nothing changed.', 'See above for the cause.', 'The cause is shown above.', 'The steps are listed above.', 'The cause is described above.', 'The numbers are above.']) {
    assert.deepEqual(idle(text), ['above'], text)
  }
  assert.deepEqual(rules(APPROVAL.replace('run the account merge on the staging database?', 'run the merge as above?')), ['above'], 'in the Ask too')
  assert.deepEqual(rules(DECISION.replace('About $1, but', 'See above. About $1, but')), ['above'], 'and in an option')
  assert.deepEqual(rules(`The root cause is above.\n\n${RELEASED}`), [], 'the detail above the frame is free')
  assert.deepEqual(idle('The eval cost is above $5, and 3 lessons are above 400 tokens.'), [], 'above a number is a comparison')
  assert.deepEqual(idle('Above 400 tokens, a passage gets its own lesson.'), [])
})

test('code-term: a backticked code name in the frame gets plain words', () => {
  const idle = (context) => checkFrame(`**Idle**\n\n${context}`, { role: 'lead' }).misses
  const bad = idle('The planner merges lessons under `LESSON_FLOOR` into a neighbor.')
  assert.deepEqual(bad.map((m) => m.rule), ['code-term'])
  assert.equal(bad[0].detail, 'explain `LESSON_FLOOR` in plain words, or use plain words')
  assert.deepEqual(idle('The planner merges lessons under `LESSON_FLOOR` (the smallest lesson size) into a neighbor.'), [])
  for (const term of ['plan.ts', 'apps/ai-create', 'lessonFloor', 'plan()', 'MAX', 'host:port', 'lesson_floor']) {
    assert.deepEqual(idle(`The cause is in \`${term}\`.`).map((m) => m.rule), ['code-term'], term)
  }
  for (const word of ['peri', 'Kaimug', 'AI', 'yes or no']) assert.deepEqual(idle(`The cause is \`${word}\`.`), [], `${word} is not a code name`)
  assert.deepEqual(rules(APPROVAL.replace('the merge changes 1,240', 'the `0042_merge_accounts` migration changes 1,240')), ['code-term'], 'a Caution counts')
  assert.deepEqual(rules(DECISION.replace('About $1, but', 'Sets `LESSON_FLOOR` to 80. About $1, but')), ['code-term'], 'an option counts')
  const steps = BLOCKED.replace('2. Turn on Developer Mode.', '2. Run `xcrun devicectl list devices` and check `~/Library/Developer/Xcode`. Turn on Developer Mode.')
  assert.deepEqual(rules(steps), [], 'Steps may hold exact commands and paths')
  assert.deepEqual(rules(REVIEW.replace('**Reply:** approve, or your comments', '**Reply:** approve, or comments in `isola.yaml`').replace(/\*\*Next:\*\*.*/, '**Next:** I rerun `pnpm dev:native`.')), [], 'Reply and Next may too')
  assert.deepEqual(rules(`Set \`LESSON_FLOOR\` in plan.ts.\n\n${RELEASED}`), [], 'the detail above the frame is free')
})

test('cost-number: a cost warning gives the amount', () => {
  const warn = (text) => rules(`${APPROVAL}\n**Warning:** ${text}`)
  assert.deepEqual(warn('the eval costs Azure credits.'), ['cost-number'])
  assert.deepEqual(warn('this spends money ($).'), ['cost-number'])
  assert.deepEqual(warn('it costs about €4.'), [])
  assert.deepEqual(warn('it deletes the staging data.'), [], 'not about cost')
})

test('next-last: Next is optional, and last when it is there', () => {
  assert.deepEqual(rules(REVIEW.replace(/\n\*\*Next:\*\*.*$/, '')), [])
  assert.deepEqual(rules(`${REVIEW}\n**Caution:** it can break the Android build.`), ['next-last'])
})

test('parseFrame reads status, kind, blocking, context, ask, options, reply, steps, next, warning', () => {
  assert.deepEqual(parseFrame(DECISION), {
    status: 'Needs your pick',
    kind: 'decision',
    blocking: true,
    context: DECISION.split('\n\n').find((p) => p.startsWith('AI Create turns')),
    ask: 'run the plan eval on Azure OpenAI?',
    options: ['A. All 10 documents + Kaimug', 'B. Without peri'],
    reply: 'A, B or no',
    steps: [],
    next: null,
    warning: null
  })
  const kinds = [DECISION, STYLE, INFO, PLAN, LATER, BLOCKED, REVIEW, RELEASED, ANSWER, APPROVAL, BRIEFING].map((e) => { const f = parseFrame(e); return `${f.kind}${f.blocking ? '' : ' later'}` })
  assert.deepEqual(kinds, ['decision', 'decision', 'info', 'none later', 'info later', 'action', 'review', 'none later', 'none later', 'approval', 'none later'])
  assert.deepEqual(parseFrame(BLOCKED).steps.length, 4)
  assert.equal(parseFrame(BLOCKED).steps[1], 'Turn on Developer Mode. Let the phone restart.')
  assert.equal(parseFrame(BLOCKED).next, 'I run the device build again.')
  assert.match(parseFrame(APPROVAL).warning, /^the merge changes 1,240/)
  assert.equal(parseFrame(BRIEFING).status, 'Idle')
  assert.equal(parseFrame('just text'), null)
  assert.equal(parseFrame(ROUTE), null)
})

// ---------- the Stop hook ----------

test('opt-in: "all", or a folder that holds the working folder', () => {
  assert.equal(optedIn('all', '/w/x'), true)
  assert.equal(optedIn(['/w/x'], '/w/x'), true)
  assert.equal(optedIn(['/w/x/'], '/w/x/y'), true)
  assert.equal(optedIn(['/w/x'], '/w/xy'), false)
  assert.equal(optedIn(['~/w'], '/h/w/a', '/h'), true)
  assert.equal(optedIn(undefined, '/w/x'), false)
  assert.equal(optedIn('none', '/w/x'), false)
})

const entry = (type, content, extra = {}) => JSON.stringify({ type, message: { content, ...(extra.id ? { id: extra.id } : {}) }, ...extra })

test('the transcript gives the first prompt and the last text of the latest turn', () => {
  const lines = [
    entry('user', 'Your role: lead. Fix BOU-1.'),
    entry('assistant', [{ type: 'text', text: 'old turn' }]),
    entry('user', 'go on'),
    entry('assistant', [{ type: 'tool_use', name: 'Bash', input: {} }]),
    entry('user', [{ type: 'tool_result', content: 'ok' }]),
    entry('assistant', [{ type: 'text', text: 'side' }], { isSidechain: true }),
    entry('assistant', [{ type: 'text', text: 'part 1' }], { id: 'm1' }),
    entry('assistant', [{ type: 'text', text: 'part 2' }], { id: 'm1' }),
    'not json'
  ]
  assert.deepEqual(readTranscript(lines), { first: 'Your role: lead. Fix BOU-1.', last: 'part 1\npart 2' })
  assert.deepEqual(readTranscript([...lines, entry('user', 'and now?')]), { first: 'Your role: lead. Fix BOU-1.', last: '' }, 'a new turn has no text yet')
})

/** A temp home with the skill linked like the plugin links it, and a transcript. */
function world({ config, firstPrompt = 'Your role: lead. Fix BOU-1.', last = 'All done.' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'stop-check-'))
  const data = join(home, '.orca-flow')
  mkdirSync(data)
  if (config !== undefined) writeFileSync(join(data, 'config.json'), JSON.stringify(config))
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  symlinkSync(join(SCRIPTS, '..'), join(home, '.claude', 'skills', 'orca-flow'))
  const worktree = join(home, 'w', 'repo', 'feature')
  mkdirSync(worktree, { recursive: true })
  mkdirSync(join(home, 'orca', 'coordinators', 'bounti'), { recursive: true })
  const transcript = join(home, 't.jsonl')
  writeFileSync(transcript, [entry('user', firstPrompt), entry('assistant', [{ type: 'text', text: last }])].join('\n'))
  return { home, data, worktree, transcript }
}

function hook(w, input, env = { ORCA_AGENT_PANE: 'tab:1' }, name = 'stop-check.mjs') {
  const script = join(w.home, '.claude', 'skills', 'orca-flow', 'scripts', name)
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: 's1', transcript_path: w.transcript, cwd: w.worktree, stop_hook_active: false, ...input }),
    env: { PATH: process.env.PATH, HOME: w.home, ...env },
    encoding: 'utf8'
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  return r.stdout ? JSON.parse(r.stdout) : null
}

const misses = (w) => (existsSync(join(w.data, 'format-misses.jsonl')) ? readFileSync(join(w.data, 'format-misses.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])

test('stop hook: blocks a lead that misses the frame, names the rule and the spec, logs the miss', () => {
  const w = world({ config: { messageFormat: 'all' } })
  const out = hook(w, {})
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /^- status: /m)
  assert.ok(out.reason.includes(join(w.home, '.claude', 'skills', 'orca-flow', 'messages.md')), 'the spec through the link, not resolved')
  assert.ok(out.reason.includes('Rewrite only the frame at the bottom, from the status line down. Do not repeat the detail above it: the user already read it.'), 'frame-only rewrite')
  assert.match(out.reason, /^The rules are in .*messages\.md\.$/m)
  const [logged] = misses(w)
  assert.deepEqual({ ...logged, at: typeof logged.at }, { at: 'string', pane: 'tab:1', worktree: w.worktree, role: 'lead', session: 's1', tier: 'block', rules: ['status'] })
  rmSync(w.home, { recursive: true })
})

test('stop hook: a good frame passes; last_assistant_message wins over the transcript', () => {
  const w = world({ config: { messageFormat: 'all' }, last: PLAN })
  assert.equal(hook(w, {}), null)
  assert.equal(hook(w, { last_assistant_message: 'no frame' }).decision, 'block')
  writeFileSync(w.transcript, entry('user', 'Your role: lead.') + '\n' + entry('assistant', [{ type: 'text', text: 'no frame' }]))
  assert.equal(hook(w, { last_assistant_message: PLAN }), null)
  assert.equal(misses(w).length, 1)
  rmSync(w.home, { recursive: true })
})

test('stop hook: a coordinator is known by its folder and may route', () => {
  const w = world({ config: { messageFormat: 'all' }, firstPrompt: 'hello', last: ROUTE })
  const cwd = join(w.home, 'orca', 'coordinators', 'bounti')
  assert.equal(hook(w, { cwd }), null)
  assert.equal(hook(w, { cwd, last_assistant_message: 'Sure.' }).decision, 'block')
  assert.equal(misses(w)[0].role, 'coordinator')
  assert.equal(hook(w, { last_assistant_message: 'Sure.' }), null, 'not a lead nor in a coordinator folder: not checked')
  rmSync(w.home, { recursive: true })
})

test('stop hook: silent without the pane, without opt-in, outside the opted-in folders, and on stop_hook_active', () => {
  const off = world({})
  assert.equal(hook(off, {}), null, 'no config')
  writeFileSync(join(off.data, 'config.json'), JSON.stringify({ messageFormat: [join(off.home, 'other')] }))
  assert.equal(hook(off, {}), null, 'another folder')
  writeFileSync(join(off.data, 'config.json'), JSON.stringify({ messageFormat: [join(off.home, 'w', 'repo')] }))
  assert.equal(hook(off, {}).decision, 'block', 'a parent folder of the worktree')
  assert.equal(hook(off, {}, {}), null, 'not in an Orca pane')
  assert.equal(hook(off, { stop_hook_active: true }), null, 'never loops')
  writeFileSync(join(off.data, 'config.json'), '{broken')
  assert.equal(hook(off, {}), null, 'a broken config is off')
  assert.equal(misses(off).length, 1)
  rmSync(off.home, { recursive: true })
})

test('stop hook: ORCA_FLOW_DIR moves the data folder; bad input exits 0 quietly', () => {
  const w = world({})
  const data = join(w.home, 'elsewhere')
  mkdirSync(data)
  writeFileSync(join(data, 'config.json'), JSON.stringify({ messageFormat: 'all' }))
  assert.equal(hook(w, {}, { ORCA_AGENT_PANE: 'tab:1', ORCA_FLOW_DIR: data }).decision, 'block')
  assert.equal(readFileSync(join(data, 'format-misses.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1)
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'stop-check.mjs')], { input: 'not json', env: { PATH: process.env.PATH, HOME: w.home, ORCA_AGENT_PANE: 'x' }, encoding: 'utf8' })
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
  rmSync(w.home, { recursive: true })
})

// ---------- two tiers: block, or log and remind quietly ----------

test('every rule has a tier, and messages.md states the same tier', () => {
  const source = readFileSync(new URL('../skills/orca-flow/scripts/frame.mjs', import.meta.url), 'utf8')
  const used = [...new Set([...source.matchAll(/miss\('([a-z-]+)'/g)].map((m) => m[1]))].sort()
  assert.deepEqual(Object.keys(TIERS).sort(), used, 'TIERS names exactly the rules checkFrame uses')
  for (const [rule, tier] of Object.entries(TIERS)) {
    assert.ok(['block', 'silent'].includes(tier), rule)
    assert.match(SPEC, new RegExp(`\\*\\*${rule}\\*\\* \\(${tier}\\)`), `messages.md says ${rule} (${tier})`)
  }
  const tiers = checkFrame(`${OLD_EVAL}`, { role: 'lead' }).misses.map((m) => `${m.rule}:${m.tier}`)
  assert.deepEqual(tiers, ['header:silent', 'status-old:block', 'status-label:block', 'context:silent', 'label:silent', 'label:silent', 'cost-number:silent'])
})

const LONG = PLAN.replace('I write again when it reports.', 'I write again when it reports. The tests take about 5 minutes. The Kaimug fixture runs last.')
const reminder = (w, session = 's1') => join(w.data, 'reminders', `${session}.json`)

test('stop hook, block tier only: blocks, logs tier block, leaves no reminder', () => {
  const w = world({ config: { messageFormat: 'all' } })
  assert.equal(hook(w, { last_assistant_message: INFO.replace(/\*\*Reply:\*\*.*/, '') }).decision, 'block')
  assert.deepEqual(misses(w).map((l) => [l.tier, l.rules]), [['block', ['ask']]])
  assert.equal(existsSync(reminder(w)), false)
  rmSync(w.home, { recursive: true })
})

test('stop hook, silent tier only: no block, logs tier silent, stores the reminder', () => {
  const w = world({ config: { messageFormat: 'all' } })
  assert.deepEqual(rules(LONG), ['context-long'])
  assert.equal(hook(w, { last_assistant_message: LONG }), null, 'a 5-sentence context does not stop the turn')
  assert.deepEqual(misses(w).map((l) => [l.tier, l.rules, l.session]), [['silent', ['context-long'], 's1']])
  const stored = JSON.parse(readFileSync(reminder(w), 'utf8'))
  assert.deepEqual(stored.rules.map((r) => r.rule), ['context-long'])
  assert.match(stored.rules[0].detail, /it has 5/)
  rmSync(w.home, { recursive: true })
})

test('stop hook, both tiers: blocks once naming all, logs both tiers, no reminder', () => {
  const w = world({ config: { messageFormat: 'all' } })
  const both = LONG.replace('**Working**', '**Working**\n\n**Ask:** may I start?\n**Reply:** yes or no').replace(/\n\n\*\*Ask:\*\*[^\n]*\n\*\*Reply:\*\*[^\n]*/, '') + '\n\n**Ask:** may I start?\n**Reply:** yes or no'
  assert.deepEqual(rules(both), ['context-long', 'ask-status'])
  const out = hook(w, { last_assistant_message: both })
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /- ask-status: [\s\S]*Fix these too while you rewrite:\n- context-long: /)
  assert.deepEqual(misses(w).map((l) => [l.tier, l.rules]), [['block', ['ask-status']], ['silent', ['context-long']]])
  assert.equal(existsSync(reminder(w)), false, 'the rewrite already covers the silent misses')
  rmSync(w.home, { recursive: true })
})

test('prompt hook: hands the reminder over once, unseen by the user, then clears it', () => {
  const w = world({ config: { messageFormat: 'all' } })
  hook(w, { last_assistant_message: LONG })
  const prompt = (input = {}, env) => hook(w, { prompt: 'go on', hook_event_name: 'UserPromptSubmit', ...input }, env, 'prompt-check.mjs')
  assert.equal(prompt({ session_id: 'other' }), null, 'another session has no reminder')
  assert.equal(prompt({}, {}), null, 'not in an Orca pane: no output')
  assert.ok(existsSync(reminder(w)), 'and the reminder waits')
  const out = prompt()
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  const text = out.hookSpecificOutput.additionalContext
  assert.match(text, /not for the user/)
  assert.match(text, /^- context-long: cut the context to 4 sentences/m)
  assert.ok(text.includes(join(w.home, '.claude', 'skills', 'orca-flow', 'messages.md')))
  assert.equal(existsSync(reminder(w)), false, 'consumed')
  assert.equal(prompt(), null, 'given once')
  rmSync(w.home, { recursive: true })
})

test('prompt hook: the same gates as the Stop hook; bad input exits 0 quietly', () => {
  const w = world({ config: { messageFormat: 'all' }, firstPrompt: 'fix the bug' })
  mkdirSync(join(w.data, 'reminders'))
  writeFileSync(reminder(w), JSON.stringify({ rules: [{ rule: 'above', detail: 'x' }] }))
  const prompt = (input = {}, env) => hook(w, { prompt: 'go on', ...input }, env, 'prompt-check.mjs')
  assert.equal(prompt(), null, 'not a lead nor a coordinator')
  writeFileSync(join(w.data, 'config.json'), JSON.stringify({ messageFormat: [join(w.home, 'other')] }))
  assert.equal(prompt({ cwd: join(w.home, 'orca', 'coordinators', 'bounti') }), null, 'not opted in here')
  writeFileSync(join(w.data, 'config.json'), JSON.stringify({ messageFormat: 'all' }))
  assert.ok(existsSync(reminder(w)), 'nothing consumed while a gate is off')
  assert.match(prompt({ cwd: join(w.home, 'orca', 'coordinators', 'bounti') }).hookSpecificOutput.additionalContext, /- above: x/, 'a coordinator')
  writeFileSync(reminder(w), '{broken')
  assert.equal(prompt({ cwd: join(w.home, 'orca', 'coordinators', 'bounti') }), null, 'a broken reminder is skipped')
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'prompt-check.mjs')], { input: 'not json', env: { PATH: process.env.PATH, HOME: w.home, ORCA_AGENT_PANE: 'x' }, encoding: 'utf8' })
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
  rmSync(w.home, { recursive: true })
})
