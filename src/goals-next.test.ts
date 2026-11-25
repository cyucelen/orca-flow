// The Next step's button on a goal: Jump to agent (an agent on a linked worktree, or the coordinator the step was
// assigned to) or Assign to coordinator, and the worker's assignment (over a temporary data folder, never the real one).
import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { add, get, update } from '../skills/orca-flow/scripts/goals.mjs'
import type { AssignedSession, GoalAssignment } from '../skills/orca-flow/scripts/goals.d.mts'
import { goalRow, goalStepMessage, goalViews, jumpTarget, liveCoordinators, nextButton, nextButtonHtml, type GoalView } from './goals-view.ts'
import { applyGoalAction, assignNext, readGoals, type AssignIo } from './goals.ts'
import { emptyUi, render } from './view.ts'
import type { AgentInfo, Coordinator, Snapshot, WorkspaceRow } from './protocol.ts'

const NOW = 1_800_000_000_000
const view = (over: Partial<GoalView> = {}): GoalView => ({
  id: 'g_ship', title: 'Ship super admin', steps: [], next: 'Finish chat oversight', links: { linear: [], worktrees: [{ key: 'des-340' }] }, status: 'open',
  createdAt: NOW - 1e9, updatedAt: NOW, lastChange: { by: 'you', field: 'next', at: NOW }, livePanes: [], ...over
})
const agent = (paneKey: string, state: AgentInfo['state'], over: Partial<AgentInfo> = {}): AgentInfo => ({
  paneKey, title: `agent ${paneKey}`, state, agentType: 'claude', summary: null, workingMode: null, coordinator: 'home', leadPane: null, parentPane: null, orcaSession: null, dispatch: null,
  terminal: `term-${paneKey}`, question: null, live: true, ...over
})
const row = (id: string, agents: AgentInfo[], over: Partial<WorkspaceRow> = {}) => ({ id, name: id, path: `/w/${id}`, agents, ...over }) as WorkspaceRow
const coordinator = (key: string, session: AgentInfo | null, over: Partial<Coordinator> = {}): Coordinator => ({
  key, name: key, repos: [], workspaceId: `folder:${key}`, session,
  sessions: session ? { version: 1, current: `m-${key}`, members: [{ id: `m-${key}`, workspaceId: `folder:${key}`, orcaSession: 'conv', agentType: session.agentType, title: 'c', paneKey: session.paneKey, terminals: [] }] } : undefined, ...over
})
const snap = (rows: WorkspaceRow[] = [], coordinators: Coordinator[] = []) => ({ rows, coordinators })
const assigned = (over: Partial<GoalAssignment> = {}): GoalAssignment => ({ coordinator: 'home', name: 'home', next: 'Finish chat oversight', state: 'delivered', at: NOW, by: 'you', token: 't', ...over })

function withData<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-flow-goals-next-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
async function withDataAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-flow-goals-next-'))
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------- which button ----------

test('a working agent on a linked worktree: Jump to agent, to its exact workspace and terminal', () => {
  const s = snap([row('identity:des-340', [agent('w1', 'waiting'), agent('w2', 'working')])])
  const b = nextButton(view(), s)
  assert.equal(b?.kind, 'jump')
  assert.deepEqual(b?.kind === 'jump' && b.target, { workspaceId: 'identity:des-340', terminal: 'term-w2', paneKey: 'w2', name: 'agent w2' }, 'the working agent before the waiting one')
  const html = nextButtonHtml(view(), b)
  assert.match(html, /^<button class="gact act pill send" data-gjump="g_ship"[^>]*>Jump <svg[^]*<\/svg><\/button>$/, 'the Linear row\'s Send pill: one word and the arrow')
  assert.match(html, /aria-label="Jump to agent w2">/, 'the full meaning in the accessible name, no tooltip')
})

test('an agent waiting for the user (a question or a permission prompt) is on the step too', () => {
  for (const state of ['waiting', 'blocked'] as const) {
    const b = nextButton(view(), snap([row('identity:des-340', [agent('w1', state)])]))
    assert.equal(b?.kind === 'jump' && b.target.terminal, 'term-w1', state)
  }
})

test('the coordinator the current step was assigned to: Jump to agent, to its current live session', () => {
  const s = snap([], [coordinator('home', agent('cpane', 'done', { terminal: 'term-c' }))])
  const b = nextButton(view({ assigned: assigned() }), s)
  assert.deepEqual(b?.kind === 'jump' && b.target, { workspaceId: 'folder:home', terminal: 'term-c', paneKey: 'cpane', name: 'home', coordinator: 'home' })
  assert.equal(nextButton(view({ assigned: assigned({ state: 'unconfirmed' }) }), s)?.kind, 'jump', 'an unconfirmed delivery can be checked with Jump')
})

test('after a handover the jump follows the coordinator to its new current session, never the recorded pane', () => {
  const g = view({ assigned: assigned({ session: { workspaceId: 'folder:home', terminal: 'term-old', paneKey: 'old' } }) })
  const b = nextButton(g, snap([], [coordinator('home', agent('new', 'working', { terminal: 'term-new', agentType: 'codex' }))]))
  assert.equal(b?.kind === 'jump' && b.target.terminal, 'term-new')
})

test('an agent that worked on the step and is still live counts: a done lead gives Jump →', () => {
  const lead = agent('lead', 'done')
  const worker = agent('worker', 'done', { parentPane: 'lead', summary: { updatedAt: NOW } as AgentInfo['summary'] })
  const b = nextButton(view(), snap([row('identity:des-340', [worker, lead])]))
  assert.equal(b?.kind === 'jump' && b.target.terminal, 'term-lead', 'the worktree lead, not the agent it dispatched')
  assert.equal(jumpTarget(view(), snap([row('identity:des-340', [agent('lead', 'done', { live: false }), worker])]))?.terminal, 'term-worker', 'the lead\'s session is closed: another live agent there')
  const older = agent('a', 'done', { parentPane: 'gone-lead', summary: { updatedAt: NOW - 60_000 } as AgentInfo['summary'] })
  const newer = agent('b', 'done', { parentPane: 'gone-lead', summary: { updatedAt: NOW } as AgentInfo['summary'] })
  assert.equal(jumpTarget(view(), snap([row('identity:des-340', [agent('gone-lead', 'done', { live: false }), older, newer])]))?.terminal, 'term-b', 'most recently active first')
})

test('a working agent beats a done lead; an agent waiting for the user beats it too', () => {
  const lead = agent('lead', 'done')
  assert.equal(jumpTarget(view(), snap([row('identity:des-340', [lead, agent('w', 'working', { parentPane: 'lead' })])]))?.terminal, 'term-w')
  assert.equal(jumpTarget(view(), snap([row('identity:des-340', [lead, agent('q', 'waiting', { parentPane: 'lead' })])]))?.terminal, 'term-q')
  const s = snap([row('identity:des-340', [lead])], [coordinator('home', agent('cpane', 'done', { terminal: 'term-c' }))])
  assert.equal(jumpTarget(view({ assigned: assigned() }), s)?.terminal, 'term-lead', 'an agent on the worktree before the assigned coordinator')
})

test('avatars and the button follow one rule: a live done agent is both an avatar and the jump target; asleep or removed, neither', () => {
  const lead = agent('lead', 'done')
  const cases: [string, WorkspaceRow[], string[]][] = [
    ['a done live lead', [row('identity:des-340', [lead])], ['lead']],
    ['working and done', [row('identity:des-340', [lead, agent('w', 'working', { parentPane: 'lead' })])], ['w', 'lead']],
    ['asleep: its session closed', [row('identity:des-340', [agent('lead', 'done', { live: false })])], []],
    ['removed: the linked worktree is gone', [row('identity:other', [agent('x', 'working')])], []]
  ]
  for (const [what, rows, panes] of cases) {
    const v = goalViews([view()], rows)[0]
    assert.deepEqual(v.livePanes, panes, what)
    const b = nextButton(v, snap(rows))
    assert.equal(b?.kind, panes.length ? 'jump' : 'assign', what)
    if (b?.kind === 'jump') assert.equal(b.target.paneKey, panes[0], `${what}: Jump → goes to the first avatar`)
  }
})

test('render() draws an avatar for every live agent on the goal, with its own face, and Jump → with it', () => {
  const r = (agents: AgentInfo[]) => ({ ...row('identity:des-340', agents), repo: 'r', branch: 'b', main: false, state: agents[0]?.state ?? null, priority: null, card: null, parentId: null, liveTerminals: 1, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: NOW, createdAt: 1, pr: null })
  const draw = (agents: AgentInfo[]) => {
    const rows = [r(agents)]
    const s = { source: 'cli', capacity: null, ready: true, features: { goals: true, linear: false, tokenSpeed: false }, rows, coordinators: [] } as unknown as Snapshot
    return render(s, { ...emptyUi(), now: NOW }, null, goalViews([view()], rows)).goalsRows
  }
  const done = draw([agent('lead', 'done')])
  assert.match(done, /class="who" role="img" aria-label="Agents on this goal: [^"]+"/)
  assert.match(done, /data-gjump="g_ship"/)
  assert.equal((draw([agent('lead', 'done'), agent('w', 'working', { parentPane: 'lead' })]).match(/class="sav"/g) ?? []).length, 2, 'one face each')
  assert.notEqual(draw([agent('lead', 'done')]).match(/<span class="who"[^]*?<\/span><\/span>/)?.[0], draw([agent('lead', 'working')]).match(/<span class="who"[^]*?<\/span><\/span>/)?.[0], 'a working face differs from a done one')
  const many = draw(['working', 'done', 'done', 'done', 'done'].map((st, i) => agent(`a${i}`, st as AgentInfo['state'], { parentPane: i ? 'a0' : null })))
  assert.equal((many.match(/class="sav"/g) ?? []).length, 3, 'capped at 3')
  assert.match(many, /class="sav more">\+2</)
  const asleep = draw([agent('lead', 'done', { live: false })])
  assert.ok(!/class="who"/.test(asleep), 'asleep: no avatar')
  assert.match(asleep, /data-gassign="g_ship"/)
  assert.ok(!/data-tip/.test(done + many), 'no tooltips')
})

test('nobody on the step: Assign to coordinator', () => {
  const elsewhere = snap([row('identity:des-340', [agent('w1', 'done', { live: false })]), row('identity:other', [agent('w2', 'working')])])
  assert.equal(nextButton(view(), elsewhere)?.kind, 'assign', 'a closed session on the linked worktree and agents elsewhere do not count')
  assert.equal(nextButton(view({ links: { linear: [], worktrees: [] } }), snap())?.kind, 'assign', 'no links at all')
  assert.equal(nextButton(view(), snap([row('identity:other', [agent('w2', 'working')])]))?.kind, 'assign', 'a linked worktree that was removed')
  assert.equal(nextButton(view(), snap([row('identity:des-340', [])]))?.kind, 'assign', 'a linked worktree with no agent')
  assert.equal(nextButton(view(), snap([row('identity:des-340', [agent('w1', 'working', { live: false })])]))?.kind, 'assign', 'a pane without a live session')
  assert.equal(nextButton(view(), snap([row('identity:des-340', [agent('w1', 'done', { live: undefined })])]))?.kind, 'assign', 'a done agent with no evidence its session is live')
  assert.equal(nextButton(view(), snap([row('identity:des-340', [agent('w1', 'working', { terminal: null })])]))?.kind, 'assign', 'no terminal to focus')
  const html = nextButtonHtml(view(), { kind: 'assign' })
  assert.match(html, /^<button class="gact act pill send" data-gassign="g_ship"[^>]*>Assign <svg[^]*<\/svg><\/button>$/)
  assert.match(html, /aria-haspopup="menu" aria-expanded="false" aria-label="Assign the next step to a coordinator"/)
})

test('a done goal, a proposed one, and one with no Next step show no button', () => {
  const s = snap([row('identity:des-340', [agent('w1', 'working')])])
  assert.equal(nextButton(view({ status: 'done' }), s), null)
  assert.equal(nextButton(view({ status: 'proposed' }), s), null)
  assert.equal(nextButton(view({ next: undefined }), s), null)
  assert.equal(nextButtonHtml(view(), null), '')
  const html = goalRow(view({ status: 'done', doneAt: NOW }), null, '', { kind: 'assign' })
  assert.ok(!/gact/.test(html), 'never drawn on a done row')
})

test('pending while this panel sends it or the store says a send is under way; it cannot be pressed', () => {
  assert.equal(nextButton(view(), snap(), { assigning: new Set(['g_ship']) })?.kind, 'pending')
  assert.equal(nextButton(view({ assigned: assigned({ state: 'pending' }) }), snap())?.kind, 'pending')
  const html = nextButtonHtml(view(), { kind: 'pending' })
  assert.match(html, /^<span class="gact rstatus pending" role="status"><span class="refreshing"><\/span>Assigning…<\/span>$/, 'a row status like Linear\'s Sending…, not a button, and not a hover pill (always shown)')
  assert.ok(!/<button|\bsend\b/.test(html))
  assert.ok(!/data-gassign|data-gjump/.test(html))
})

test('an assignment for another Next text does not apply: Assign to coordinator for the new step', () => {
  const s = snap([], [coordinator('home', agent('cpane', 'done'))])
  assert.equal(nextButton(view({ assigned: assigned({ next: 'An older step' }) }), s)?.kind, 'assign')
  assert.equal(nextButton(view({ assigned: assigned({ next: 'An older step', state: 'pending' }) }), s)?.kind, 'assign', 'nor a pending one for the old text')
})

test('the button sits beside the row button (never inside it), so pressing it does not open the card', () => {
  const html = goalRow(view({ title: '<img src=x>' }), null, '', { kind: 'jump', target: { workspaceId: 'w', terminal: 't', paneKey: 'p', name: '<b>lead</b>' } })
  assert.match(html, /^<div class="gline"><button class="g"[^]*?<\/button><button class="gact act pill send" data-gjump=/)
  assert.ok(!html.includes('<img') && !html.includes('<b>lead'), 'goal and agent names are escaped')
})

// ---------- verified jump ----------

test('a session that is gone is not a jump target: the button falls back to Assign to coordinator', () => {
  const g = view({ assigned: assigned() })
  const s = snap([row('identity:des-340', [agent('w1', 'working')])], [coordinator('home', agent('cpane', 'done', { terminal: 'term-c' }))])
  assert.equal(jumpTarget(g, s)?.terminal, 'term-w1')
  assert.equal(jumpTarget(g, s, new Set(['term-w1']))?.terminal, 'term-c', 'the worker is gone: the assigned coordinator')
  assert.equal(jumpTarget(g, s, new Set(['term-w1', 'term-c'])), null, 'both gone')
  assert.equal(nextButton(g, s, { gone: new Set(['term-w1', 'term-c']) })?.kind, 'assign')
  const asleep = snap([], [coordinator('home', null)])
  assert.equal(jumpTarget(g, asleep), null, 'a coordinator with no live current session')
  assert.equal(jumpTarget(g, snap([], [coordinator('home', agent('cpane', 'done', { live: false }))])), null)
  assert.equal(jumpTarget(g, snap()), null, 'a coordinator that was deleted')
  assert.equal(jumpTarget(view(), snap([row('identity:des-340', [agent('w1', 'working')], { historical: true })])), null, 'a historical row is no live session')
})

test('the picker offers only coordinators with a live current session', () => {
  const s = snap([], [coordinator('home', agent('a', 'done')), coordinator('asleep', null), coordinator('dead', agent('b', 'done', { live: false }))])
  assert.deepEqual(liveCoordinators(s).map((c) => c.key), ['home'])
  assert.deepEqual(liveCoordinators(snap()), [])
})

test('render() draws the button on the row from the snapshot and the panel state', () => {
  const s = { source: 'cli', capacity: null, ready: true, features: { goals: true, linear: false, tokenSpeed: false }, rows: [row('identity:des-340', [agent('w1', 'working')], { repo: 'r', branch: 'b', main: false, state: 'working', priority: null, card: null, parentId: null, liveTerminals: 1, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: NOW, createdAt: 1, pr: null })], coordinators: [] } as unknown as Snapshot
  const ui = { ...emptyUi(), now: NOW }
  assert.match(render(s, ui, null, [view()]).goalsRows, /data-gjump="g_ship"/)
  assert.match(render(s, ui, null, [view({ id: 'g_two', links: { linear: [], worktrees: [] } })]).goalsRows, /data-gassign="g_two"/)
  ui.goalAssigning!.add('g_two')
  assert.match(render(s, ui, null, [view({ id: 'g_two', links: { linear: [], worktrees: [] } })]).goalsRows, /Assigning…/)
})

// ---------- a goal with only todos ----------

test('a goal with only todos gets the Assign button, and Jump once its first todo is handed over', () => withDataAsync(async (dir) => {
  const g = add('Ship', { steps: ['Draft', 'Send'], worktrees: [] }, { data: dir })
  const v = (goal = get(g.id, { data: dir })!) => readGoals([], dir).find((x) => x.id === goal.id)!
  assert.equal(v().next, undefined)
  assert.equal(nextButton(v(), snap())?.kind, 'assign', 'no written next: the first open todo is the next step')
  assert.match(render({ source: 'cli', capacity: null, ready: true, features: { goals: true, linear: false, tokenSpeed: false }, rows: [], coordinators: [] } as unknown as Snapshot, { ...emptyUi(), now: NOW }, null, [v()]).goalsRows, new RegExp(`data-gassign="${g.id}"`))
  const x = io(dir)
  const r = await assignNext({ id: g.id, coordinator: 'home', next: 'Draft' }, x)
  assert.equal(r.ok, true, r.error)
  assert.match(x.sent[0].message, /Next step: "Draft" \(todo 1 of the goal's list\)/)
  assert.match(x.sent[0].message, new RegExp(`orca-flow goal step ${g.id} tick 1 `))
  assert.ok(!/goal set \S+ --next/.test(x.sent[0].message), 'a todo is finished by ticking it, not by setting --next')
  const live = snap([], [coordinator('home', agent('cpane', 'done', { terminal: 'term-c' }))])
  assert.equal(v().assigned?.next, 'Draft')
  assert.equal(nextButton(v(), live)?.kind, 'jump', 'assigned: Jump to the coordinator')
  assert.equal(jumpTarget(v(), live)?.coordinator, 'home')
  applyGoalAction({ action: 'step', id: g.id, step: 1, done: true }, [], dir)
  assert.equal(v().assigned, null, 'its todo is ticked: the assignment is no longer current')
  assert.equal(nextButton(v(), live)?.kind, 'assign', 'the next todo is unassigned')
  assert.equal((await assignNext({ id: g.id, coordinator: 'home', next: 'Draft' }, x)).ok, false, 'the old todo text is refused')
  assert.equal((await assignNext({ id: g.id, coordinator: 'home', next: 'Send' }, x)).ok, true)
  assert.equal(nextButton(view({ next: undefined, steps: [{ text: 'a', done: true }] }), live), null, 'all todos done: no button')
}))

test('ticking the todo that is the written next clears it; the button then follows the next open todo', () => withDataAsync(async (dir) => {
  const g = add('Ship', { next: 'Draft', steps: ['Draft', 'Send'] }, { data: dir })
  await assignNext({ id: g.id, coordinator: 'home', next: 'Draft' }, io(dir))
  assert.equal(readGoals([], dir)[0].assigned?.next, 'Draft')
  const r = applyGoalAction({ action: 'step', id: g.id, step: 1, done: true }, [], dir)
  assert.equal(r.goals[0].next, undefined)
  assert.equal(r.goals[0].assigned, null)
  assert.equal(nextButton(r.goals[0], snap())?.kind, 'assign')
}))

// ---------- the message ----------



test('the message carries the exact step, the goal title and id, and the goal commands, each goal text on one line', () => {
  const m = goalStepMessage({ id: 'g_ship', title: 'Ship\nit', next: 'Finish chat oversight; rm -rf ~ $(whoami)\r\x1b[2J', doneWhen: 'PR merged' })
  assert.match(m, /^Next step: "Finish chat oversight; rm -rf ~ \$\(whoami\) \[2J"$/m, 'control characters go, the text stays as data')
  assert.match(m, /^Goal: "Ship it"$/m)
  assert.match(m, /goal g_ship/)
  assert.match(m, /orca-flow goal show g_ship/)
  assert.match(m, /orca-flow goal set g_ship --next/)
  assert.match(m, /orca-flow goal link g_ship --worktree/)
  assert.ok(!/[\r\x1b]/.test(m))
})

// ---------- the worker's assignment ----------

const SESSION: AssignedSession = { workspaceId: 'folder:home', terminal: 'term-c', paneKey: 'cpane', orcaSession: 'conv', agentType: 'claude' }
function io(dir: string, over: Partial<AssignIo> = {}): AssignIo & { sent: { key: string; message: string }[] } {
  const sent: { key: string; message: string }[] = []
  return {
    sent, rows: () => [], data: dir,
    target: (key) => ({ name: `coordinator ${key}`, session: SESSION }),
    stillOn: () => true,
    deliver: async (key, message) => { sent.push({ key, message }); return { session: { ...SESSION, member: 'm' } } },
    ...over
  }
}

test('assigning records it on the goal (coordinator, session, the exact next text, time) and the view jumps there', () => withDataAsync(async (dir) => {
  const g = add('Ship', { next: 'Draft the Germany template' }, { data: dir })
  const x = io(dir)
  const r = await assignNext({ id: g.id, coordinator: 'home', next: 'Draft the Germany template' }, x)
  assert.equal(r.ok, true, r.error)
  assert.equal(x.sent.length, 1)
  assert.match(x.sent[0].message, /^Next step: "Draft the Germany template"$/m)
  const a = get(g.id, { data: dir })!.assignment!
  assert.equal(a.coordinator, 'home')
  assert.equal(a.name, 'coordinator home')
  assert.equal(a.next, 'Draft the Germany template')
  assert.equal(a.state, 'delivered')
  assert.equal(a.session?.terminal, 'term-c')
  assert.equal(typeof a.at, 'number')
  assert.equal(typeof a.deliveredAt, 'number')
  const v = r.goals.find((y) => y.id === g.id)!
  assert.equal(v.assigned?.coordinator, 'home')
  assert.equal(nextButton(v, snap([], [coordinator('home', agent('cpane', 'done', { terminal: 'term-c' }))]))?.kind, 'jump')
}))

test('a second assignment of the same step is refused, pending or delivered; two presses never deliver twice', () => withDataAsync(async (dir) => {
  const g = add('Ship', { next: 'Step one' }, { data: dir })
  let release!: () => void
  const x = io(dir, { deliver: async (key, message) => { x.sent.push({ key, message }); await new Promise<void>((r) => (release = r)); return {} } })
  const first = assignNext({ id: g.id, coordinator: 'home', next: 'Step one' }, x)
  const second = await assignNext({ id: g.id, coordinator: 'other', next: 'Step one' }, x)
  assert.equal(second.ok, false)
  assert.match(second.error!, /already being sent to coordinator home/)
  assert.equal(second.goals.find((y) => y.id === g.id)?.assigned?.state, 'pending', 'other panels see it pending')
  release()
  assert.equal((await first).ok, true)
  const third = await assignNext({ id: g.id, coordinator: 'home', next: 'Step one' }, x)
  assert.equal(third.ok, false)
  assert.match(third.error!, /already assigned to coordinator home/)
  assert.equal(x.sent.length, 1)
}))

test('a step delivered to a coordinator that is gone can be assigned again', () => withDataAsync(async (dir) => {
  const g = add('Ship', { next: 'Step one' }, { data: dir })
  const x = io(dir)
  await assignNext({ id: g.id, coordinator: 'home', next: 'Step one' }, x)
  const again = await assignNext({ id: g.id, coordinator: 'other', next: 'Step one' }, { ...x, stillOn: () => false })
  assert.equal(again.ok, true, again.error)
  assert.equal(get(g.id, { data: dir })!.assignment!.coordinator, 'other')
}))

test('a late delivery answer for an old step does not mark the new step as assigned', () => withDataAsync(async (dir) => {
  const g = add('Ship', { next: 'Old step' }, { data: dir })
  let release!: () => void
  const x = io(dir, { deliver: async () => { await new Promise<void>((r) => (release = r)); return { session: SESSION } } })
  const pending = assignNext({ id: g.id, coordinator: 'home', next: 'Old step' }, x)
  update(g.id, { next: 'New step' }, 'an agent', { data: dir })
  release()
  const r = await pending
  assert.equal(r.ok, false)
  assert.match(r.error!, /next step changed while it was being sent/)
  const after = get(g.id, { data: dir })!
  assert.equal(after.next, 'New step')
  assert.equal(after.assignment, undefined)
  const v = r.goals.find((y) => y.id === g.id)!
  assert.equal(v.assigned, null)
  assert.equal(nextButton(v, snap([], [coordinator('home', agent('cpane', 'done'))]))?.kind, 'assign', 'Assign to coordinator for the new step')
}))

test('a button drawn for an old Next text sends nothing once the step changed', () => withDataAsync(async (dir) => {
  const g = add('Ship', { next: 'New step' }, { data: dir })
  const x = io(dir)
  const r = await assignNext({ id: g.id, coordinator: 'home', next: 'Old step' }, x)
  assert.equal(r.ok, false)
  assert.match(r.error!, /next step changed; nothing was sent/)
  assert.equal(x.sent.length, 0)
}))

test('changing Next after delivery drops the assignment: the new step is not assigned', () => withDataAsync(async (dir) => {
  const g = add('Ship', { next: 'Step one' }, { data: dir })
  await assignNext({ id: g.id, coordinator: 'home', next: 'Step one' }, io(dir))
  applyGoalAction({ action: 'update', id: g.id, patch: { next: 'Step two' } }, [], dir)
  assert.equal(get(g.id, { data: dir })!.assignment, undefined)
  assert.equal(readGoals([], dir)[0].assigned, null)
  applyGoalAction({ action: 'update', id: g.id, patch: { note: 'unrelated' } }, [], dir)
  const ok = await assignNext({ id: g.id, coordinator: 'home', next: 'Step two' }, io(dir))
  assert.equal(ok.ok, true)
  applyGoalAction({ action: 'update', id: g.id, patch: { note: 'another note' } }, [], dir)
  assert.equal(get(g.id, { data: dir })!.assignment?.next, 'Step two', 'other edits keep it')
}))

test('a failed delivery leaves the step unassigned; an unconfirmed one counts, with a warning', () => withDataAsync(async (dir) => {
  const g = add('Ship', { next: 'Step one' }, { data: dir })
  const failed = await assignNext({ id: g.id, coordinator: 'home', next: 'Step one' }, io(dir, { deliver: async () => { throw new Error('The selected conversation is offline.') } }))
  assert.equal(failed.ok, false)
  assert.match(failed.error!, /offline/)
  assert.equal(get(g.id, { data: dir })!.assignment, undefined)
  const unsure = await assignNext({ id: g.id, coordinator: 'home', next: 'Step one' }, io(dir, { deliver: async () => ({ session: SESSION, uncertain: true }) }))
  assert.equal(unsure.ok, true)
  assert.match(unsure.warning!, /did not confirm/)
  assert.equal(get(g.id, { data: dir })!.assignment!.state, 'unconfirmed')
  const noSession = await assignNext({ id: add('Two', { next: 'x' }, { data: dir }).id, coordinator: 'asleep', next: 'x' }, io(dir, { target: () => { throw new Error('The selected conversation is offline. Choose an open session first.') } }))
  assert.equal(noSession.ok, false, 'a coordinator with no live session is refused before anything is recorded')
}))

test('goals written before (no links, no assignment field) read, show and edit exactly as before', () => withData((dir) => {
  mkdirSync(join(dir, 'goals'), { recursive: true })
  const old = { id: 'g_old-1', title: 'Old goal', next: 'Do it', steps: [], status: 'open', createdAt: 1, updatedAt: 2, lastChange: { by: 'you', field: 'created', at: 1 } }
  const file = join(dir, 'goals', 'g_old-1.json')
  writeFileSync(file, JSON.stringify(old))
  const [v] = readGoals([], dir)
  assert.equal(v.title, 'Old goal')
  assert.deepEqual(v.links, { linear: [], worktrees: [] })
  assert.equal(v.assigned, null)
  assert.equal(nextButton(v, snap())?.kind, 'assign')
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(old), 'reading rewrites nothing')
  const r = applyGoalAction({ action: 'update', id: 'g_old-1', patch: { next: 'Do it now' } }, [], dir)
  assert.equal(r.ok, true)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.next, 'Do it now')
  assert.ok(!('assignment' in saved), 'no assignment field appears')
}))
