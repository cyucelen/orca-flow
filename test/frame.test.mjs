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

// The examples in messages.md are the fixtures: the spec and the checker cannot drift apart.
const SPEC = readFileSync(new URL('../skills/orca-flow/messages.md', import.meta.url), 'utf8')
const EXAMPLES = [...SPEC.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((m) => m[1])
const [DECISION, PLAN, BLOCKED, REVIEW, RELEASED, ANSWER, APPROVAL, BRIEFING, ROUTE] = EXAMPLES

const rules = (text, role = 'lead') => checkFrame(text, { role }).misses.map((m) => m.rule)
const ok = (text, role = 'lead') => assert.deepEqual(checkFrame(text, { role }), { ok: true, misses: [] }, text.split('\n').find((l) => l.startsWith('**')))

test('every example in messages.md passes: the briefing and the route line as a coordinator', () => {
  assert.equal(EXAMPLES.length, 9)
  for (const example of EXAMPLES) ok(example, 'coordinator')
  for (const example of [DECISION, PLAN, BLOCKED, REVIEW, RELEASED, ANSWER, APPROVAL]) ok(example, 'lead')
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
  assert.deepEqual(misses.filter((m) => m.rule === 'label').map((m) => m.detail.match(/\*\*(\w+):/)[1]), ['Status', 'Answer', 'Evidence'])
  assert.deepEqual(got, ['header', 'context', 'label', 'label', 'label', 'cost-number'], 'and it has no context paragraph')
  assert.equal(parseFrame(OLD_EVAL), null, 'the old shape is not read: the sidebar falls back to Haiku')
})

test('status: a bold status phrase, the last one outside code fences', () => {
  assert.deepEqual(rules('Done. The PR is up.'), ['status'])
  assert.deepEqual(rules(PLAN.replace('**Working**', '**In progress**')), ['status'])
  assert.deepEqual(rules(PLAN.replace('**Working**', '**working**')), ['status'], 'the words never change')
  assert.deepEqual(rules(PLAN.replace('**Working**', 'Working')), ['status'], 'bold as a whole')
  assert.deepEqual(rules(DECISION.replace('**Waiting on you: decision**', '**Waiting on you: choice**')), ['status'])
  assert.deepEqual(rules(PLAN.replace('**Working**', '**Working.**')), [], 'one trailing period')
  assert.deepEqual(rules('```\n' + RELEASED + '\n```'), ['status'], 'a frame inside a code block does not count')
  assert.deepEqual(rules(`**Blocked**\n\nOld frame.\n\n**Steps:**\n1. x\n\n**Reply:** done\n\n${RELEASED}`), [], 'the last frame counts')
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
  const bad = checkFrame(ANSWER.replace('The row is gray', '**Answer:** the row is gray'), { role: 'lead' }).misses
  assert.deepEqual(bad.map((m) => m.rule), ['context', 'label'])
  assert.match(bad[1].detail, /\*\*Answer:\*\*/)
  for (const label of ['Done', 'Plan', 'Problem', 'Cause', 'Evidence', 'Result', 'Link', 'Waiting', 'Running', 'Room', 'Status']) {
    assert.deepEqual(rules(`${RELEASED}\n**${label}:** x`), ['label'], label)
  }
  assert.deepEqual(rules(`**Notes:** above the frame\n\n${RELEASED}`), [], 'detail above the frame is free')
})

test('ask, reply and ask-status: an ask needs a waiting status and a Reply', () => {
  assert.deepEqual(rules(DECISION.replace('**Reply:** A, B or no', '')), ['ask'])
  assert.deepEqual(rules(REVIEW.replace(/\*\*Ask:\*\*.*\n/, '')), ['ask'])
  assert.deepEqual(rules(APPROVAL.replace('**Reply:** yes or no\n', '')), ['ask'])
  assert.deepEqual(rules(BLOCKED.replace('**Reply:** done\n', '')), ['reply'])
  assert.deepEqual(rules(BLOCKED.replace(/\*\*Steps:\*\*\n(\d\..*\n)+/, '')), ['reply'], 'Blocked says what to do')
  assert.deepEqual(rules(`${RELEASED}\n\n**Ask:** any feedback?\n**Reply:** your feedback`), ['ask-status'])
  assert.deepEqual(rules(PLAN), [], 'Working needs no ask')
})

test('options and recommended: a decision gives 2 or more options, one recommended', () => {
  assert.deepEqual(rules(DECISION.replace(/- \*\*B\..*\n/, '')), ['options'])
  assert.deepEqual(rules(DECISION.replace(' (recommended)', '')), ['recommended'])
  assert.deepEqual(rules(DECISION.replace('**B. Without peri.**', '**B. Without peri (recommended).**')), ['recommended'])
  assert.match(checkFrame(DECISION.replace(' (recommended)', ''), { role: 'lead' }).misses[0].detail, /0 are marked/)
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

test('parseFrame reads the new shape: status, context, ask, options, reply, steps, next, warning', () => {
  assert.deepEqual(parseFrame(DECISION), {
    status: 'Waiting on you: decision',
    context: 'The repo has 10 eval documents (table above). Most of their passages are under 400 tokens, so option A changes long documents too. We must test A and B before we choose. The A/B decision is held until this test ends.',
    ask: 'run the plan eval on Azure OpenAI?',
    options: ['A. All 10 documents + Kaimug', 'B. Without peri'],
    reply: 'A, B or no',
    steps: [],
    next: null,
    warning: null
  })
  assert.deepEqual(parseFrame(BLOCKED).steps.length, 4)
  assert.equal(parseFrame(BLOCKED).steps[1], 'Turn on Developer Mode. Let the phone restart.')
  assert.equal(parseFrame(BLOCKED).next, 'I run the device build again.')
  assert.match(parseFrame(APPROVAL).warning, /^the migration changes 1,240/)
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
  assert.match(out.reason, /^- status: /m)
  assert.ok(out.reason.includes(join(w.home, '.claude', 'skills', 'orca-flow', 'messages.md')), 'the spec through the link, not resolved')
  assert.match(out.reason, /rewrite the message with the frame last/)
  const [logged] = misses(w)
  assert.deepEqual({ ...logged, at: typeof logged.at }, { at: 'string', pane: 'tab:1', worktree: w.worktree, role: 'lead', session: 's1', rules: ['status'] })
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
