// The Goals section: its rows, header and card as HTML, which goals show working agents, and the worker's
// handling of the panel's edits (over a temporary data folder, never the real one).
import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { add, done, get, propose, setStep } from '../skills/orca-flow/scripts/goals.mjs'
import { goalCard, goalRow, goalViews, goalsHead, goalsRows, goalsUiOf, type GoalView } from './goals-view.ts'
import { applyGoalAction, readGoals } from './goals.ts'
import { emptyUi, render } from './view.ts'
import type { AgentInfo, Snapshot, WorkspaceRow } from './protocol.ts'

const noMatch = (text: string, re: RegExp, message?: string) => assert.ok(!re.test(text), message ?? `unexpected ${re}`)
const NOW = 1_800_000_000_000
const view = (over: Partial<GoalView> = {}): GoalView => ({
  id: 'g_ship', title: 'Ship super admin', steps: [{ text: 'Visibility fix', done: true }, { text: 'Moderation', done: false }], next: 'Finish chat oversight',
  doneWhen: 'PR merged', note: 'A <b>note</b>', links: { linear: ['DES-340'], worktrees: [{ key: 'k', name: 'mono/des-340' }] }, status: 'open', createdAt: NOW - 1e9, updatedAt: NOW,
  lastChange: { by: 'the DES-340 lead', field: 'next', at: NOW - 2 * 3_600_000 }, livePanes: [], ...over
})
const state = (over = {}) => ({ folded: false, open: null, now: NOW, ...over })
const agent = (state: AgentInfo['state'], i = 0): AgentInfo => ({ paneKey: i ? `p${i}` : 'p', title: 't', state, agentType: 'claude', summary: null, workingMode: null, coordinator: 'you', leadPane: null, parentPane: i ? 'p' : null, orcaSession: null, dispatch: null, terminal: `term-${i}`, question: null, live: true })
const wrow = (id: string, path: string, states: AgentInfo['state'][]) => ({ id, path, agents: states.map((st, i) => agent(st, i)) })

function withData<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-flow-goals-view-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('a row shows the title, the step count and the next step on a second line, with no label', () => {
  const html = goalRow(view(), null)
  assert.match(html, /<span class="ti">Ship super admin<\/span><span class="nx">Finish chat oversight<\/span>/)
  assert.match(html, /<span class="cnt">1\/2<\/span>/)
  assert.match(html, /pathLength="2" stroke-dasharray="1 2"/)
  noMatch(html, /Next:/)
})

test('a goal with only a title is a valid row: no count, no avatars, a quiet line for the missing next step', () => {
  const html = goalRow(view({ steps: [], next: undefined, links: { linear: [], worktrees: [] } }), null)
  noMatch(html, /class="cnt"/)
  noMatch(html, /class="gprogress"/)
  noMatch(html, /class="stack"/)
  assert.match(html, /class="nx none">No next step yet/)
})

test('a goal lists the live agents on its linked worktrees, in any state, until they sleep or are removed', () => {
  const g = view({ links: { linear: [], worktrees: [{ key: 'wt:1' }] } })
  const panes = (rows: (ReturnType<typeof wrow> & { historical?: boolean })[], goal = g) => goalViews([goal], rows)[0].livePanes
  assert.deepEqual(panes([wrow('identity:wt:1', '/a', ['working'])]), ['p'])
  assert.deepEqual(panes([wrow('identity:wt:1', '/a', ['done'])]), ['p'], 'a done agent that is still live stays')
  assert.deepEqual(panes([wrow('identity:wt:1', '/a', ['done', 'waiting', 'working'])]), ['p2', 'p1', 'p'], 'working, then asking, then the lead')
  const closed = wrow('identity:wt:1', '/a', ['done', 'working'])
  closed.agents[0].live = false
  closed.agents[1].live = false
  assert.deepEqual(panes([closed]), [], 'asleep: their sessions closed')
  const unknown = wrow('identity:wt:1', '/a', ['done'])
  delete unknown.agents[0].live
  assert.deepEqual(panes([unknown]), [], 'a done agent with no evidence its session is live')
  const noTerminal = wrow('identity:wt:1', '/a', ['working'])
  noTerminal.agents[0].terminal = null
  assert.deepEqual(panes([noTerminal]), [], 'no terminal left')
  assert.deepEqual(panes([{ ...wrow('identity:wt:1', '/a', ['working']), historical: true }]), [], 'a historical row')
  assert.deepEqual(panes([wrow('identity:other', '/b', ['working'])]), [], 'removed: the linked worktree is gone, an agent elsewhere does not count')
  assert.deepEqual(panes([wrow('x', '/a', ['done'])], view({ links: { linear: [], worktrees: [{ path: '/a' }] } })), ['p'], 'a path link matches too')
  assert.deepEqual(panes([wrow('wt-id', '/a', ['done'])], view({ links: { linear: [], worktrees: [{ worktreeId: 'wt-id' }] } })), ['p'], 'so does the Orca id')
  assert.deepEqual(panes([wrow('identity:wt:1', '/a', ['working'])], view({ status: 'done', links: g.links })), [], 'a done goal has none')
  assert.deepEqual(panes([wrow('identity:wt:1', '/a', ['working'])], view({ links: { linear: ['DES-1'], worktrees: [] } })), [], 'a Linear link alone does not count')
  const row = wrow('identity:wt:1', '/a', ['working', 'working'])
  assert.deepEqual(panes([row, row]), ['p', 'p1'], 'each agent once')
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

test('the header counts the goals still to do; Completed › opens the tab, with the total in its tooltip; + adds', () => {
  const goals = [view(), view({ id: 'b', status: 'proposed' }), view({ id: 'c', status: 'done' }), view({ id: 'd', status: 'done' })]
  const head = goalsHead(goals, state())
  assert.match(head, /<span>Goals<\/span><span class="gc">2<\/span>/)
  assert.match(head, /<button class="ghistory" data-gcompleted data-tip="2 completed goals · opens a tab"[^>]*>Completed ›<\/button>/)
  assert.equal(head.match(/class="gc"/g)?.length, 1, 'only the active count: none on the button')
  assert.match(head, /data-gadd/)
  assert.match(goalsHead([view(), view({ id: 'c', status: 'done' })], state()), /data-tip="1 completed goal · opens a tab"/)
})

test('Completed › is hidden while no goal is completed', () => {
  const head = goalsHead([view(), view({ id: 'b', status: 'proposed' })], state())
  noMatch(head, /data-gcompleted|Completed/)
  assert.match(head, /data-gfold/)
  assert.match(head, /data-gadd/)
  assert.match(goalsHead([], state()), /data-gadd/)
})

test('no goals: the header has no active count; searching hides the whole section', () => {
  const head = goalsHead([], state())
  assert.match(head, /Goals/)
  noMatch(head, /class="gc"/)
  assert.equal(goalsRows([], state()), '')
  assert.equal(goalsHead([view()], state(), true), '')
  assert.equal(goalsRows([view()], state(), true), '')
})

test('the sidebar lists only the goals still to do (done ones live in the Completed goals tab); folded shows no rows', () => {
  const goals = [view({ id: 'a', title: 'Open one' }), view({ id: 'p', title: 'Proposed one', status: 'proposed' }), view({ id: 'c', title: 'Finished', status: 'done' })]
  const shown = goalsRows(goals, state())
  assert.match(shown, /Open one/)
  assert.match(shown, /Proposed one/)
  noMatch(shown, /Finished/)
  assert.equal(goalsRows(goals, state({ folded: true })), '')
  assert.match(goalsRows(goals, state({ open: 'a' })), /class="g menu-open" data-gopen="a"/)
  // The old in-sidebar history is gone: no Show more, no way to list the done goals here.
  const many = Array.from({ length: 60 }, (_, i) => view({ id: `d${i}`, status: 'done' }))
  assert.equal(goalsRows(many, state()), '')
  noMatch(goalsHead(many, state()), /data-gdone|View completed goals/)
})

test('an older stored showDone is ignored: only the fold is kept', () => {
  assert.deepEqual(goalsUiOf({ folded: true, showDone: true }), { folded: true })
  assert.deepEqual(goalsUiOf(null), { folded: false })
})

test('goal text is escaped, in the row and in the card', () => {
  const g = view({ title: '<img src=x onerror=alert(1)>', next: '"><script>', note: '<b>x</b>' })
  for (const html of [goalRow(g, null), goalCard(g, NOW)]) noMatch(html, /<img|<script|<b>/)
})

test('the card has editable next, note, done-when and title, tickable steps, links, and no last-change line', () => {
  const card = goalCard(view(), NOW)
  for (const f of ['title', 'next', 'note', 'doneWhen', 'newStep']) assert.match(card, new RegExp(`data-gedit="${f}" data-g="g_ship"`))
  assert.match(card, /data-gstep="1" data-g="g_ship" role="checkbox" aria-checked="true"/)
  assert.match(card, /data-gstep="2"[^>]*aria-checked="false"/)
  assert.match(card, /DES-340/)
  assert.match(card, /mono\/des-340/)
  assert.ok(!/class="meta"|updated by/.test(card), "no last-change line")
  assert.match(goalCard(view({ links: { linear: [], worktrees: [] } }), NOW), /No ticket or worktree/)
})

test('render() puts the section above the tree and drops it while searching or before the goals are read', () => {
  const snap = { rows: [] as WorkspaceRow[], source: 'cli', capacity: null, coordinators: [], ready: true, features: { goals: true, linear: true, tokenSpeed: true } } as Snapshot
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
  assert.deepEqual(r.goals[0].livePanes, [])
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
  assert.deepEqual([get(b.id, { data: dir })?.doneBy, get(b.id, { data: dir })?.proposedBy], ['you', 'the lead'], 'who completed it, and who said it was done')
  assert.equal(get(a.id, { data: dir })?.doneBy, undefined, 'reopened: no longer done, so no doneBy')
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

test('what an agent writes with `orca-flow goal` is what the panel reads, with live agents from the rows', () => withData((dir) => {
  const g = add('Ship', { steps: ['one'], worktrees: [{ key: 'wt:1', name: 'des-340' }] }, { data: dir, by: 'the DES-340 lead' })
  setStep(g.id, 1, true, 'the DES-340 lead', { data: dir })
  assert.deepEqual(readGoals([], dir)[0].livePanes, [])
  const lit = readGoals([wrow('identity:wt:1', '/x', ['working'])], dir)
  assert.deepEqual(lit[0].livePanes, ['p'])
  assert.equal(lit[0].lastChange.by, 'the DES-340 lead')
  assert.match(readFileSync(join(dir, 'goals', `${g.id}.json`), 'utf8'), /"title": "Ship"/)
}))

test('Goals off (the default): nothing is drawn, even with goals in hand', () => {
  const base = { rows: [] as WorkspaceRow[], source: 'cli', capacity: null, coordinators: [], ready: true } as Snapshot
  for (const features of [undefined, { linear: true, tokenSpeed: true }, { goals: false, linear: true, tokenSpeed: true }]) {
    const out = render({ ...base, ...(features ? { features } : {}) }, emptyUi(), null, [view()])
    assert.equal(out.goalsHead + out.goalsRows, '')
  }
})

test('Goals off: the worker reads nothing, posts nothing and refuses the panel\'s edits', async () => {
  const { mountWorker, mockHost } = await import('orca/testing')
  const main = await import('./worker.ts')
  const worker = await mountWorker(main, { host: mockHost({ results: { 'statusBar.update': {}, 'workspace.list': { workspaces: [], truncated: false } } }) })
  // A development machine's config could have the switch on; the refusal is the point only while it is off.
  const { readSettings } = await import('./config.ts')
  const { homedir } = await import('node:os')
  if (readSettings(join(homedir(), '.orca-flow')).settings.features.goals) { await worker.deactivate(); return }
  assert.deepEqual(await worker.request('sidebar.goals'), [])
  const r = (await worker.request('sidebar.goalAction', { action: 'add', title: 'Nope' })) as { ok: boolean; error?: string }
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /Goals is off/)
  await worker.deactivate()
})

test('Undo: restore marks a reopened goal done again with its original completion time and proposer', () => withData((dir) => {
  const g = add('Ship', {}, { data: dir })
  propose(g.id, 'the lead', { data: dir })
  const first = done(g.id, 'you', { data: dir, doneAt: NOW - 6 * 86_400_000 })
  assert.equal(applyGoalAction({ action: 'reopen', id: g.id }, [], dir).goals[0].status, 'open')
  const r = applyGoalAction({ action: 'restore', id: g.id, doneAt: first.doneAt, proposedBy: first.proposedBy }, [], dir)
  assert.equal(r.ok, true)
  const back = get(g.id, { data: dir })!
  assert.deepEqual([back.status, back.doneAt, back.doneBy, back.proposedBy], ['done', first.doneAt, 'you', 'the lead'])
  assert.equal(applyGoalAction({ action: 'restore', id: 'g_nope' }, [], dir).ok, false)
}))
