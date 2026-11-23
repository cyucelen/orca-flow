// The Goals section: its rows, header and card as HTML, which goals show a working dot, and the worker's
// handling of the panel's edits (over a temporary data folder, never the real one).
import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { add, done, get, propose, setStep } from '../skills/orca-flow/scripts/goals.mjs'
import { goalCard, goalRow, goalViews, goalsHead, goalsRows, lastChangeText, type GoalView } from './goals-view.ts'
import { applyGoalAction, readGoals } from './goals.ts'
import { emptyUi, render } from './view.ts'
import type { AgentInfo, Snapshot, WorkspaceRow } from './protocol.ts'

const noMatch = (text: string, re: RegExp, message?: string) => assert.ok(!re.test(text), message ?? `unexpected ${re}`)
const NOW = 1_800_000_000_000
const view = (over: Partial<GoalView> = {}): GoalView => ({
  id: 'g_ship', title: 'Ship super admin', steps: [{ text: 'Visibility fix', done: true }, { text: 'Moderation', done: false }], next: 'Finish chat oversight',
  doneWhen: 'PR merged', note: 'A <b>note</b>', links: { linear: ['DES-340'], worktrees: [{ key: 'k', name: 'mono/des-340' }] }, status: 'open', createdAt: NOW - 1e9, updatedAt: NOW,
  lastChange: { by: 'the DES-340 lead', field: 'next', at: NOW - 2 * 3_600_000 }, working: false, ...over
})
const state = (over = {}) => ({ folded: false, showDone: false, open: null, now: NOW, ...over })
const agent = (state: AgentInfo['state']): AgentInfo => ({ paneKey: 'p', title: 't', state, agentType: 'claude', summary: null, workingMode: null, coordinator: 'you', leadPane: null, parentPane: null, orcaSession: null, dispatch: null, terminal: null, question: null })
const wrow = (id: string, path: string, states: AgentInfo['state'][]) => ({ id, path, agents: states.map(agent) })

function withData<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-flow-goals-view-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('a row shows the title, the step count and the next step on a second line, with no label', () => {
  const html = goalRow(view(), null)
  assert.match(html, /<span class="ti">Ship super admin<\/span><span class="nx">Finish chat oversight<\/span>/)
  assert.match(html, /<span class="cnt">1\/2<\/span>/)
  noMatch(html, /Next:/)
})

test('a goal with only a title is a valid row: no count, no dot, a quiet line for the missing next step', () => {
  const html = goalRow(view({ steps: [], next: undefined, links: { linear: [], worktrees: [] } }), null)
  noMatch(html, /class="cnt"/)
  noMatch(html, /class="wd"/)
  assert.match(html, /class="nx none">No next step yet/)
})

test('the dot shows only when an agent on a linked worktree is working', () => {
  const g = view({ links: { linear: [], worktrees: [{ key: 'wt:1' }] } }) as GoalView
  const plain = (x: GoalView) => ({ ...x, working: undefined })
  const dot = (rows: ReturnType<typeof wrow>[], goal = g) => goalViews([plain(goal) as never], rows)[0].working
  assert.equal(dot([wrow('identity:wt:1', '/a', ['working'])]), true)
  assert.equal(dot([wrow('identity:wt:1', '/a', ['waiting', 'done'])]), false, 'linked, but nobody works')
  assert.equal(dot([wrow('identity:other', '/b', ['working'])]), false, 'an agent working elsewhere')
  assert.equal(dot([wrow('x', '/a', ['working'])], view({ links: { linear: [], worktrees: [{ path: '/a' }] } })), true, 'a path link matches too')
  assert.equal(dot([wrow('wt-id', '/a', ['working'])], view({ links: { linear: [], worktrees: [{ worktreeId: 'wt-id' }] } })), true, 'so does the Orca id')
  assert.equal(dot([wrow('identity:wt:1', '/a', ['working'])], view({ status: 'done', links: g.links })), false, 'a done goal is never lit')
  assert.equal(dot([wrow('identity:wt:1', '/a', ['working'])], view({ links: { linear: ['DES-1'], worktrees: [] } })), false, 'a Linear link alone does not light it')
  assert.match(goalRow(view({ working: true }), null), /class="wd"/)
  noMatch(goalRow(view({ working: false }), null), /class="wd"/)
})

test('a proposed goal says "lead says done" on the row, and its card asks to confirm', () => {
  const g = view({ status: 'proposed' })
  assert.match(goalRow(g, null), /class="nx says">lead says done/)
  const card = goalCard(g, NOW)
  assert.match(card, /data-gconfirm="g_ship">Confirm done/)
  assert.match(card, /data-gnot="g_ship">Not yet/)
  noMatch(card, /data-gfinish/)
})

test('an open goal offers Mark done; a done goal is struck through and offers Reopen', () => {
  assert.match(goalCard(view(), NOW), /data-gfinish="g_ship">Mark done/)
  const g = view({ status: 'done' })
  assert.match(goalRow(g, null), /class="g fin"/)
  noMatch(goalRow(g, null), /class="nx/, 'a done goal is one line')
  assert.match(goalCard(g, NOW), /data-greopen="g_ship">Reopen/)
})

test('the header counts the goals still to do, offers the done ones, and + adds', () => {
  const goals = [view(), view({ id: 'b', status: 'proposed' }), view({ id: 'c', status: 'done' }), view({ id: 'd', status: 'done' })]
  const head = goalsHead(goals, state())
  assert.match(head, /<span>Goals<\/span><span class="gc">2<\/span>/)
  assert.match(head, /data-gdone aria-pressed="false">· 2 done/)
  assert.match(head, /data-gadd/)
  assert.match(goalsHead(goals, state({ showDone: true })), /class="gdn on"/)
  noMatch(goalsHead([view()], state()), /gdn/, 'no done goals: no toggle')
})

test('no goals: the header has the title and + only; searching hides the whole section', () => {
  const head = goalsHead([], state())
  assert.match(head, /Goals/)
  noMatch(head, /class="gc"|gdn/)
  assert.equal(goalsRows([], state()), '')
  assert.equal(goalsHead([view()], state(), true), '')
  assert.equal(goalsRows([view()], state(), true), '')
})

test('done goals show only when the toggle is on, after the open ones; folded shows no rows', () => {
  const goals = [view({ id: 'a', title: 'Open one' }), view({ id: 'c', title: 'Finished', status: 'done' })]
  noMatch(goalsRows(goals, state()), /Finished/)
  const shown = goalsRows(goals, state({ showDone: true }))
  assert.ok(shown.indexOf('Open one') < shown.indexOf('Finished'))
  assert.equal(goalsRows(goals, state({ folded: true })), '')
  assert.match(goalsRows(goals, state({ open: 'a' })), /class="g menu-open" data-gopen="a"/)
})

test('goal text is escaped, in the row and in the card', () => {
  const g = view({ title: '<img src=x onerror=alert(1)>', next: '"><script>', note: '<b>x</b>' })
  for (const html of [goalRow(g, null), goalCard(g, NOW)]) noMatch(html, /<img|<script|<b>/)
})

test('the card has editable next, note, done-when and title, tickable steps, links and one muted last-change line', () => {
  const card = goalCard(view(), NOW)
  for (const f of ['title', 'next', 'note', 'doneWhen', 'newStep']) assert.match(card, new RegExp(`data-gedit="${f}" data-g="g_ship"`))
  assert.match(card, /data-gstep="1" data-g="g_ship" role="checkbox" aria-checked="true"/)
  assert.match(card, /data-gstep="2"[^>]*aria-checked="false"/)
  assert.match(card, /DES-340/)
  assert.match(card, /mono\/des-340/)
  assert.equal(card.match(/class="meta"/g)?.length, 1)
  assert.match(card, /Next updated by the DES-340 lead · 2h ago/)
  assert.match(goalCard(view({ links: { linear: [], worktrees: [] } }), NOW), /No ticket or worktree/)
})

test('who changed it last reads in one line', () => {
  const at = NOW - 5 * 60_000
  assert.equal(lastChangeText({ lastChange: { by: 'you', field: 'next', at } }, NOW), 'Next updated by you · 5m ago')
  assert.equal(lastChangeText({ lastChange: { by: 'you', field: 'doneWhen', at } }, NOW), 'Done criteria updated by you · 5m ago')
  assert.equal(lastChangeText({ lastChange: { by: 'a lead', field: 'next,steps', at: NOW } }, NOW), 'Next and Steps updated by a lead · just now')
  assert.equal(lastChangeText({ lastChange: { by: 'you', field: 'created', at } }, NOW), 'Added by you · 5m ago')
  assert.equal(lastChangeText({ lastChange: { by: 'you', field: 'status', at: NOW - 3 * 86_400_000 } }, NOW), 'Status changed by you · 3d ago')
})

test('render() puts the section above the tree and drops it while searching or before the goals are read', () => {
  const snap = { rows: [] as WorkspaceRow[], source: 'cli', capacity: null, coordinators: [], ready: true } as Snapshot
  const ui = emptyUi()
  assert.equal(render(snap, ui, null, null).goalsHead, '', 'not read yet')
  const out = render(snap, ui, null, [view()])
  assert.match(out.goalsHead, /Goals/)
  assert.match(out.goalsRows, /Ship super admin/)
  const searching = render(snap, { ...ui, query: 'x' }, null, [view()])
  assert.equal(searching.goalsHead + searching.goalsRows, '')
  const folded = render(snap, { ...ui, goalsFolded: true }, null, [view()])
  assert.match(folded.goalsHead, /aria-expanded="false"/)
  assert.equal(folded.goalsRows, '')
})

// ---------- the worker's side: the panel's edits ----------

test('the panel adds a goal from one line, as "you"', () => withData((dir) => {
  const r = applyGoalAction({ action: 'add', title: '  Hire a designer ' }, [], dir)
  assert.equal(r.ok, true)
  assert.equal(r.goals.length, 1)
  assert.equal(r.goals[0].title, 'Hire a designer')
  assert.equal(r.goals[0].lastChange.by, 'you')
  assert.equal(r.goals[0].working, false)
  assert.equal(readdirSync(join(dir, 'goals')).length, 1, 'one file per goal')
}))

test('an empty title is refused and nothing is written', () => withData((dir) => {
  const r = applyGoalAction({ action: 'add', title: '   ' }, [], dir)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /needs a title/)
  assert.deepEqual(readGoals([], dir), [])
}))

test('the panel updates fields, ticks and adds steps, all recorded by "you"', () => withData((dir) => {
  const g = add('Ship', { steps: ['one', 'two'] }, { data: dir, by: 'a lead' })
  let r = applyGoalAction({ action: 'update', id: g.id, patch: { next: 'Do one', note: 'N', doneWhen: 'D' } }, [], dir)
  assert.equal(r.ok, true)
  assert.deepEqual([r.goals[0].next, r.goals[0].note, r.goals[0].doneWhen], ['Do one', 'N', 'D'])
  assert.deepEqual(r.goals[0].lastChange, { by: 'you', field: 'note,next,doneWhen', at: r.goals[0].lastChange.at })
  r = applyGoalAction({ action: 'step', id: g.id, step: 2, done: true }, [], dir)
  assert.deepEqual(r.goals[0].steps.map((s) => s.done), [false, true])
  assert.equal(r.goals[0].lastChange.field, 'steps')
  r = applyGoalAction({ action: 'step', id: g.id, step: 2, done: false }, [], dir)
  assert.deepEqual(r.goals[0].steps.map((s) => s.done), [false, false], 'a tick can be taken back')
  r = applyGoalAction({ action: 'addStep', id: g.id, text: ' three ' }, [], dir)
  assert.deepEqual(r.goals[0].steps.map((s) => s.text), ['one', 'two', 'three'])
  r = applyGoalAction({ action: 'update', id: g.id, patch: { next: '' } }, [], dir)
  assert.equal(r.goals[0].next, undefined, 'an emptied next is cleared')
  r = applyGoalAction({ action: 'update', id: g.id, patch: { title: '' } }, [], dir)
  assert.equal(r.ok, false)
  assert.equal(readGoals([], dir)[0].title, 'Ship')
  assert.equal(applyGoalAction({ action: 'step', id: g.id, step: 9, done: true }, [], dir).ok, false)
  assert.equal(applyGoalAction({ action: 'update', id: 'g_nope', patch: { next: 'x' } }, [], dir).ok, false)
}))

test('mark done, reopen, confirm a proposal, and "Not yet"', () => withData((dir) => {
  const a = add('A', {}, { data: dir })
  const b = add('B', {}, { data: dir })
  const c = add('C', {}, { data: dir })
  propose(b.id, 'the lead', { data: dir })
  propose(c.id, 'the lead', { data: dir })
  let r = applyGoalAction({ action: 'done', id: a.id }, [], dir)
  assert.equal(r.goals.find((g) => g.id === a.id)?.status, 'done')
  assert.equal(get(a.id, { data: dir })?.lastChange.by, 'you')
  r = applyGoalAction({ action: 'reopen', id: a.id }, [], dir)
  assert.equal(r.goals.find((g) => g.id === a.id)?.status, 'open')
  r = applyGoalAction({ action: 'confirm', id: b.id }, [], dir)
  assert.equal(r.goals.find((g) => g.id === b.id)?.status, 'done')
  assert.ok(r.goals.find((g) => g.id === b.id)?.doneAt)
  r = applyGoalAction({ action: 'reject', id: c.id }, [], dir)
  const rejected = r.goals.find((g) => g.id === c.id)!
  assert.equal(rejected.status, 'open')
  assert.deepEqual([rejected.lastChange.by, rejected.lastChange.field], ['you', 'status'])
}))

test('"Not yet" leaves a goal that is no longer proposed alone', () => withData((dir) => {
  const g = add('A', {}, { data: dir })
  done(g.id, 'you', { data: dir })
  assert.equal(applyGoalAction({ action: 'reject', id: g.id }, [], dir).goals[0].status, 'done', 'a done goal is not reopened by a stale Not yet')
}))

test('what an agent writes with `orca-flow goal` is what the panel reads, with the dot from the rows', () => withData((dir) => {
  const g = add('Ship', { steps: ['one'], worktrees: [{ key: 'wt:1', name: 'des-340' }] }, { data: dir, by: 'the DES-340 lead' })
  setStep(g.id, 1, true, 'the DES-340 lead', { data: dir })
  assert.equal(readGoals([], dir)[0].working, false)
  const lit = readGoals([wrow('identity:wt:1', '/x', ['working'])], dir)
  assert.equal(lit[0].working, true)
  assert.equal(lit[0].lastChange.by, 'the DES-340 lead')
  assert.match(readFileSync(join(dir, 'goals', `${g.id}.json`), 'utf8'), /"title": "Ship"/)
}))
