// node --test test/*.test.mjs
// The message frame (skills/orca-flow/scripts/frame.mjs) and the Stop hook that applies it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkFrame, parseFrame } from '../skills/orca-flow/scripts/frame.mjs'
import { optedIn, readTranscript } from '../skills/orca-flow/scripts/stop-check.mjs'

const SCRIPTS = fileURLToPath(new URL('../skills/orca-flow/scripts/', import.meta.url))

// The spec's examples (agent-message-format.md, messages.md), one message each.
const ROUTE = 'BOU-4206 → lead in mono/bou-4206-aic-split-lessons · today'

const PLAN = `**BOU-4206 · Split short docs into lessons · today**
**Status:** Working

**Plan:**
1. Find why the Kaimug PDF gives 1 lesson.
2. Change the planner so a short topic can be a lesson.
3. Run the plan eval on the corpus and on Kaimug.

**Next:** nothing needed from you. I write again when I know the cause.`

const DECISION = `**BOU-4206 · Split short docs into lessons · today**
**Status:** Waiting on you: decision

**Problem:** the Kaimug PDF gives 1 lesson. Expected: about 4.
**Cause:** the planner merges each lesson under 400 tokens into a neighbor. 4 of the 5 Kaimug topics are under 400 tokens.
**Evidence:** plan.ts:173 sets LESSON_FLOOR to 400. Topic sizes are 103, 181, 15, 411 and 93 tokens.

**Ask:** make 1 topic = 1 lesson, with a minimum of 80 tokens. Which documents get this rule?
- **A. All documents (recommended).** Hygiene changes from 1–3 lessons to 6–10.
- **B. Only documents under 1,200 tokens.** Long manuals do not change. The planner gets a special case.
**Reply:** A or B

**Caution:** the plan eval uses Azure OpenAI credits. I ask before I run it.
**Next:** I change the prompt, the minimum, the screen count and the quiz size. Then I run the tests.`

const PROCEDURE = `**Isola on-demand services · soon**
**Status:** Blocked

**Problem:** the iPhone build stops at Xcode. Developer Mode is off on the phone.

**Steps:**
1. On the iPhone, open Settings > Privacy & Security > Developer Mode.
2. Turn on Developer Mode. Let the phone restart.
3. After the restart, tap Turn On and enter the passcode.
4. If "Trust This Computer?" shows, tap Trust.
5. Keep the phone unlocked and on the same Wi-Fi as the Mac.

**Reply:** done
**Next:** I run the device build again.`

const REVIEW = `**Isola on-demand services · soon**
**Status:** Ready for review

**Result:** every isola service in mono starts on demand. A Metro service runs the Expo app.
**Evidence:** pnpm dev:native works on the iOS simulator and the Android emulator. A real iPhone run is not tested.
**Link:** PR #6227

**Ask:** review the PR. Look first at the on-demand config in isola.yaml.
**Reply:** approve, or your comments
**Next:** I fix your comments. I send worker_done when the PR merges.`

const PROGRESS = `**AI Create v2 production readiness · today**
**Status:** Working

**Done:**
- Runs are durable and rate-limited.
- Image dedup is in. 2 workers measure course memory now.

**Next:** nothing needed from you. I write again when the memory numbers are in.`

const ANSWER = `**orca-flow · sidebar**
**Status:** Done

**Answer:** the row is gray because the worker finished. A finished session stays in its place, dimmed, until Orca closes it.
**Evidence:** view.ts marks the row finished. panel.css:105 sets its opacity to 0.55.

**Next:** nothing needed from you.`

const BRIEFING = `**bounti · briefing**

**Waiting:**
1. today · BOU-4206 needs a decision: 1 topic = 1 lesson for all documents?
2. soon · Isola on-demand services needs a review: PR #6227.
**Running:** AI Create v2 production readiness, Draft shifts missing from calendar.
**Room:** 1 more worktree, or 4 more agents.

**Next:** nothing needed from you. Say "next" to open item 1.`

const rules = (text, role = 'lead') => checkFrame(text, { role }).misses.map((m) => m.rule)

test('every spec example passes: the route line and the briefing as a coordinator', () => {
  assert.deepEqual(checkFrame(ROUTE, { role: 'coordinator' }), { ok: true, misses: [] })
  assert.deepEqual(checkFrame(`${ROUTE}\n\nISO-12 → lead in mono/isola · soon\n`, { role: 'coordinator' }).ok, true, 'several route lines')
  for (const [name, text] of Object.entries({ PLAN, DECISION, PROCEDURE, REVIEW, PROGRESS, ANSWER })) {
    assert.deepEqual(checkFrame(text, { role: 'lead' }), { ok: true, misses: [] }, name)
    assert.deepEqual(checkFrame(text, { role: 'coordinator' }), { ok: true, misses: [] }, `${name} from a coordinator`)
  }
  assert.deepEqual(checkFrame(BRIEFING, { role: 'coordinator' }), { ok: true, misses: [] })
})

test('detail above the frame and code blocks in it are fine; the last frame counts', () => {
  const above = `I read plan.ts and the eval logs.\n\n\`\`\`ts\n**Status:** Nonsense\n**Bogus:** x\n\`\`\`\n\n**Old · thing · now**\n**Status:** Bad\n\n${DECISION}`
  assert.deepEqual(rules(above), [])
  assert.deepEqual(rules(`${DECISION}\n`), [], 'a trailing newline')
  assert.deepEqual(rules(PLAN.replace('Working', 'Working.')), [], 'one trailing period')
})

test('header: no frame header, or only a route line from a lead', () => {
  assert.deepEqual(rules('Done. The PR is up.'), ['header'])
  assert.deepEqual(rules(ROUTE), ['header'], 'only a coordinator routes')
  assert.deepEqual(rules(BRIEFING), ['header'], 'only a coordinator briefs')
  assert.deepEqual(rules(PLAN.replace('**BOU-4206 · Split short docs into lessons · today**', '**BOU-4206 Split short docs**')), ['header'], 'a header has " · "')
  assert.deepEqual(rules(PLAN.replace('**Status:** Working\n', '')), ['header'], 'a header is followed by Status')
  assert.deepEqual(rules('```\n' + PLAN + '\n```'), ['header'], 'a frame inside a code block does not count')
  assert.deepEqual(rules(`${ROUTE}\nAlso, I looked at the queue.`, 'coordinator'), ['header'], 'a route message is route lines only')
})

test('status-word: one of the five, with an ask type after Waiting on you', () => {
  assert.deepEqual(rules(PLAN.replace('Working', 'In progress')), ['status-word'])
  assert.deepEqual(rules(PLAN.replace('Working', 'working')), ['status-word'], 'the words never change')
  assert.deepEqual(rules(DECISION.replace('Waiting on you: decision', 'Waiting on you: choice')), ['status-word'])
  assert.deepEqual(rules(DECISION.replace('Waiting on you: decision', 'Waiting on you')), ['status-word'])
})

test('briefing: Running and Room', () => {
  const missing = checkFrame(BRIEFING.replace(/\*\*Room:\*\*.*\n/, ''), { role: 'coordinator' }).misses
  assert.deepEqual(missing.map((m) => m.rule), ['briefing'])
  assert.match(missing[0].detail, /\*\*Room:\*\*/)
})

test('next-last: the frame ends the message with Next', () => {
  assert.deepEqual(rules(PLAN.replace(/\n\*\*Next:\*\*.*$/, '')), ['next-last'])
  assert.deepEqual(rules(`${PLAN}\n\nLet me know.`), ['next-last'])
  assert.deepEqual(rules(`${PLAN}\n\`\`\`sh\nls\n\`\`\``), ['next-last'], 'a code block after the frame')
})

test('reply: an agent that waits on the user says what to type', () => {
  assert.deepEqual(rules(DECISION.replace('**Reply:** A or B\n', '')), ['reply'])
  assert.deepEqual(rules(PROCEDURE.replace('**Reply:** done\n', '')), ['reply'])
  assert.deepEqual(rules(REVIEW.replace('**Reply:** approve, or your comments\n', '')), ['reply'])
  assert.deepEqual(rules(PLAN), [], 'Working needs none')
})

test('label: only the frame labels; option bullets are not labels, and detail above the frame is free', () => {
  const bad = checkFrame(PLAN.replace('**Plan:**', '**Summary:**'), { role: 'lead' }).misses
  assert.deepEqual(bad, [{ rule: 'label', detail: '**Summary:** is not a frame label' }])
  assert.deepEqual(rules(DECISION.replace('**Caution:**', '**Fault:**')), ['label'], 'Fault became Problem')
  assert.deepEqual(rules(`**Notes:** above the frame\n\n${PLAN}`), [])
})

test('several misses are all named', () => {
  assert.deepEqual(rules(DECISION.replace('**Reply:** A or B\n', '').replace('**Cause:**', '**Why:**') + '\nThanks!'), ['next-last', 'reply', 'label'])
})

test('parseFrame reads status, problem, ask, its option labels, reply and next', () => {
  assert.deepEqual(parseFrame(DECISION), {
    header: 'BOU-4206 · Split short docs into lessons · today',
    status: 'Waiting on you: decision',
    problem: 'the Kaimug PDF gives 1 lesson. Expected: about 4.',
    ask: 'make 1 topic = 1 lesson, with a minimum of 80 tokens. Which documents get this rule?',
    options: ['A. All documents', 'B. Only documents under 1,200 tokens'],
    reply: 'A or B',
    next: 'I change the prompt, the minimum, the screen count and the quiz size. Then I run the tests.'
  })
  assert.deepEqual(parseFrame(PLAN), { header: 'BOU-4206 · Split short docs into lessons · today', status: 'Working', problem: null, ask: null, options: [], reply: null, next: 'nothing needed from you. I write again when I know the cause.' })
  assert.deepEqual(parseFrame(PROCEDURE).options, [], 'Steps are not options')
  assert.equal(parseFrame(PROCEDURE).reply, 'done')
  assert.equal(parseFrame(BRIEFING).status, null)
  assert.equal(parseFrame(BRIEFING).header, 'bounti · briefing')
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

function hook(w, input, env = { ORCA_AGENT_PANE: 'tab:1' }) {
  const script = join(w.home, '.claude', 'skills', 'orca-flow', 'scripts', 'stop-check.mjs')
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
  assert.match(out.reason, /^- header: /m)
  assert.ok(out.reason.includes(join(w.home, '.claude', 'skills', 'orca-flow', 'messages.md')), 'the spec through the link, not resolved')
  assert.match(out.reason, /rewrite the message with the frame last/)
  const [logged] = misses(w)
  assert.deepEqual({ ...logged, at: typeof logged.at }, { at: 'string', pane: 'tab:1', worktree: w.worktree, role: 'lead', session: 's1', rules: ['header'] })
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
