// The Linear section's rules: reading issues, filters and order, routing, the message, a send.
import { assert, test } from 'orca/testing'
import type { LinearData, LinearIssue } from './protocol.ts'
import { activeCycle, linearMessage, linearUiOf, linkedIssueOf, loadLinear, priorityIcon, priorityWord, pruneSent, sendIssue, sendTargets, sortIssues, statusIcon, toIssue, viewOf } from './linear.ts'

const ME = 'u-me'
const issue = (id: string, over: Partial<LinearIssue> = {}): LinearIssue => ({
  id, title: `Title ${id}`, url: `https://linear.app/acme/issue/${id}`, state: { name: 'Todo', type: 'unstarted', color: '#9a9aa3' },
  team: id.split('-')[0], project: null, assignee: { id: ME, name: 'me' }, priority: 3, cycle: null, ...over
})
const state = (name: string, type: string) => ({ name, type, color: '' })
const data = (issues: LinearIssue[], over: Partial<LinearData> = {}): LinearData => ({
  me: ME, teams: ['BOU'], connectedTeams: ['BOU', 'CUS'], issues, cycles: ['c-now'], sent: {}, lastSent: {}, at: 0, ...over
})

test('reads an issue from the CLI: one-line text, a known priority, safe color and URL; anything else is not an issue', () => {
  const i = toIssue({
    identifier: 'bou-12', title: 'Fix\n<b>the</b>\u001b[31m thing', url: 'javascript:alert(1)', priority: 9,
    state: { name: 'In Progress', type: 'Started', color: 'red;x' }, team: { key: 'BOU' }, project: { name: 'Shift\tScheduling' },
    assignee: { id: 'u1', displayName: 'ernst' }, cycle: { id: 'c1', name: null }
  })!
  assert.equal(i.id, 'BOU-12')
  assert.equal(i.title, 'Fix <b>the</b> [31m thing')
  assert.equal(i.url, '')
  assert.equal(i.priority, 0)
  assert.deepEqual(i.state, { name: 'In Progress', type: 'started', color: '' })
  assert.equal(i.project, 'Shift Scheduling')
  assert.deepEqual(i.assignee, { id: 'u1', name: 'ernst' })
  assert.equal(i.cycle, 'c1')
  assert.equal(toIssue({ identifier: 'not an id' }), null)
  assert.equal(toIssue(null), null)
  assert.equal(toIssue({ identifier: 'BOU-1', state: { color: '#f2c94c' } })!.state.color, '#f2c94c')
})

test("a worktree's linked issue reads as its identifier, from an identifier or a URL", () => {
  assert.equal(linkedIssueOf('BOU-4179'), 'BOU-4179')
  assert.equal(linkedIssueOf('bou-4179'), 'BOU-4179')
  assert.equal(linkedIssueOf('https://linear.app/acme/issue/BOU-4179/planner-hours'), 'BOU-4179')
  assert.equal(linkedIssueOf(null), null)
  assert.equal(linkedIssueOf(''), null)
  assert.equal(linkedIssueOf(42), null)
})

test('the active cycle is the one most of the started issues are in', () => {
  const started = state('In Progress', 'started')
  assert.equal(activeCycle([issue('BOU-1', { cycle: 'old', state: started }), issue('BOU-2', { cycle: 'now', state: started }), issue('BOU-3', { cycle: 'now', state: started }), issue('BOU-4', { cycle: 'next' }), issue('BOU-5', { cycle: 'next' }), issue('BOU-6', { cycle: 'next' })]), 'now')
  assert.equal(activeCycle([issue('BOU-1', { cycle: 'next' })]), null)
  assert.equal(activeCycle([]), null)
})

test('order: linked last; then urgent, high, medium, low, none; then In Progress before Todo before Backlog; then newest', () => {
  const list = [
    issue('BOU-1', { priority: 0 }),
    issue('BOU-2', { priority: 1 }),
    issue('BOU-3', { priority: 2, state: state('Backlog', 'backlog') }),
    issue('BOU-4', { priority: 2, state: state('In Progress', 'started') }),
    issue('BOU-5', { priority: 2 }),
    issue('BOU-6', { priority: 2 }),
    issue('BOU-7', { priority: 1 }),
    issue('BOU-8', { priority: 4 })
  ]
  assert.deepEqual(sortIssues(list, new Set(['BOU-7'])).map((i) => i.id), ['BOU-2', 'BOU-4', 'BOU-6', 'BOU-5', 'BOU-3', 'BOU-8', 'BOU-1', 'BOU-7'])
})

test('filters: Mine is assigned to me, Team my teams, Cycle the active cycle; closed issues never show, Staging folds away', () => {
  const d = data([
    issue('BOU-1'),
    issue('BOU-2', { assignee: { id: 'u-ernst', name: 'ernst' }, cycle: 'c-now' }),
    issue('BOU-3', { assignee: null, cycle: 'c-old' }),
    issue('BOU-4', { state: state('Staging', 'started') }),
    issue('BOU-5', { state: state('Deployed', 'completed') }),
    issue('BOU-6', { state: state('Canceled', 'canceled') }),
    issue('BOU-7', { state: state('Duplicate', 'duplicate') }),
    issue('CUS-1', { cycle: 'c-now' })
  ])
  const ids = (v: { shown: LinearIssue[]; staging: LinearIssue[] }) => [v.shown.map((i) => i.id).sort(), v.staging.map((i) => i.id)]
  assert.deepEqual(ids(viewOf(d, 'mine')), [['BOU-1', 'CUS-1'], ['BOU-4']])
  assert.deepEqual(ids(viewOf(d, 'team')), [['BOU-1', 'BOU-2', 'BOU-3'], ['BOU-4']])
  assert.deepEqual(ids(viewOf(d, 'cycle')), [['BOU-2'], []])
  // Not knowing who the user is shows nothing as Mine rather than everything.
  assert.deepEqual(ids(viewOf({ ...d, me: null }, 'mine')), [[], []])
})

test('the message: start line, priority word with Linear\'s name, project when there is one, the URL, how to link', () => {
  const i = issue('BOU-4179', { title: 'Planner: show the total planned staff hours', priority: 2, project: 'Shift Scheduling', url: 'https://linear.app/bounti/issue/BOU-4179' })
  assert.equal(linearMessage(i), [
    'Start BOU-4179: Planner: show the total planned staff hours',
    'Priority: today (High in Linear) · Project: Shift Scheduling',
    'https://linear.app/bounti/issue/BOU-4179',
    'Link the worktree with --linear-issue BOU-4179.'
  ].join('\n'))
  assert.equal(linearMessage(issue('BOU-1', { priority: 0 })).split('\n')[1], 'Priority: someday (No priority in Linear)')
  assert.deepEqual([1, 2, 3, 4, 0].map(priorityWord), ['now', 'today', 'soon', 'someday', 'someday'])
})

test('routing: the coordinator owning the team first, else the one it was last sent to, else tree order', () => {
  const cs = [{ key: 'isola' }, { key: 'bounti', linearTeams: ['BOU'] }, { key: 'flow', linearTeams: ['CUS'] }]
  assert.deepEqual(sendTargets('BOU', cs, { BOU: 'isola' }), [{ key: 'bounti', suggested: 'Suggested · owns BOU' }, { key: 'isola', suggested: null }, { key: 'flow', suggested: null }])
  assert.deepEqual(sendTargets('DES', cs, { DES: 'flow' }).map((t) => [t.key, t.suggested]), [['flow', 'Suggested · last sent DES'], ['isola', null], ['bounti', null]])
  assert.deepEqual(sendTargets('DES', cs).map((t) => [t.key, t.suggested]), [['isola', null], ['bounti', null], ['flow', null]])
  // A remembered coordinator that was deleted suggests nothing.
  assert.deepEqual(sendTargets('DES', cs, { DES: 'gone' }).map((t) => t.suggested), [null, null, null])
})

test('a send stops showing as starting once a worktree links it, or after a day', () => {
  const now = 100 * 3_600_000
  const sent = { 'BOU-1': { coordinator: 'a', at: now - 1000 }, 'BOU-2': { coordinator: 'a', at: now - 1000 }, 'BOU-3': { coordinator: 'a', at: now - 25 * 3_600_000 } }
  assert.deepEqual(pruneSent(sent, new Set(['BOU-2']), now), { 'BOU-1': sent['BOU-1'] })
  assert.equal(pruneSent({ 'BOU-1': sent['BOU-1'] }, new Set(), now), null)
})

test('a send types the message, then moves the issue to In Progress and assigns it only when nobody has it', async () => {
  const calls: string[] = []
  const run = async (args: string[]) => void calls.push(args.join(' '))
  let typed = ''
  const r = await sendIssue(issue('BOU-9', { assignee: null }), { run, deliver: async (m) => void (typed = m) })
  assert.deepEqual(r, { ok: true, warnings: [] })
  assert.match(typed, /^Start BOU-9: /)
  assert.deepEqual(calls, ['linear status set BOU-9 --to In Progress', 'linear assignee set BOU-9 --me'])

  calls.length = 0
  await sendIssue(issue('BOU-9', { assignee: { id: 'u-ernst', name: 'ernst' } }), { run, deliver: async () => {} })
  assert.deepEqual(calls, ['linear status set BOU-9 --to In Progress'])
})

test('a failed delivery changes nothing in Linear; a failed Linear update is a warning; a dry run runs nothing', async () => {
  const calls: string[] = []
  const r = await sendIssue(issue('BOU-9'), { run: async (a) => void calls.push(a.join(' ')), deliver: async () => { throw new Error('no chat') } })
  assert.deepEqual(r, { ok: false, error: 'no chat', warnings: [] })
  assert.equal(calls.length, 0)

  const w = await sendIssue(issue('BOU-9'), { run: async () => { throw new Error('state not found') }, deliver: async () => {} })
  assert.equal(w.ok, true)
  assert.deepEqual(w.warnings, ['Moving it to In Progress failed: state not found'])

  const lines: string[] = []
  let delivered = false
  const dry = await sendIssue(issue('BOU-9', { assignee: null }), { run: async (a) => void calls.push(a.join(' ')), deliver: async () => void (delivered = true), dryRun: true, log: (l) => lines.push(l) })
  assert.equal(dry.ok, true)
  assert.equal(delivered, false)
  assert.equal(calls.length, 0)
  assert.equal(lines.length, 3)
})

test('loading: my teams are the ones I am a member of; each issue once, with its cycle; the active cycle per team', async () => {
  const raw = (id: string, over: Record<string, unknown> = {}) => ({ identifier: id, title: id, url: `https://linear.app/x/${id}`, state: { name: 'Todo', type: 'unstarted' }, team: { key: id.split('-')[0] }, priority: 2, assignee: { id: ME, displayName: 'me' }, ...over })
  const calls: string[] = []
  const run = async (args: string[]) => {
    const a = args.join(' ')
    calls.push(a)
    if (a === 'linear team list') return { teams: [{ key: 'BOU' }, { key: 'CUS' }] }
    if (a.startsWith('linear list --filter assigned')) return { issues: [raw('BOU-1'), raw('CUS-7')] }
    if (a === 'linear team members --team BOU') return { members: [{ id: ME }] }
    if (a === 'linear team members --team CUS') return { members: [{ id: 'u-other' }] }
    if (a === 'linear list-issues --team BOU --state started') return { issues: [raw('BOU-1', { cycle: { id: 'c-now' }, state: { name: 'In Progress', type: 'started' } }), raw('BOU-2', { assignee: null, cycle: { id: 'c-now' }, state: { name: 'In Review', type: 'started' } })] }
    if (a.startsWith('linear list-issues --team BOU')) return { issues: [] }
    throw new Error(`unexpected ${a}`)
  }
  const d = await loadLinear(run, 5)
  assert.equal(d.me, ME)
  assert.deepEqual(d.teams, ['BOU'])
  assert.deepEqual(d.connectedTeams, ['BOU', 'CUS'])
  assert.deepEqual(d.issues.map((i) => [i.id, i.cycle, i.state.name]).sort(), [['BOU-1', 'c-now', 'In Progress'], ['BOU-2', 'c-now', 'In Review'], ['CUS-7', null, 'Todo']])
  assert.deepEqual(d.cycles, ['c-now'])
  assert.ok(!calls.some((c) => c.includes('--team CUS --state')), 'reads no issues of a team I am not in')
})

test('loading fails when Linear is not connected, so the section stays hidden', async () => {
  await assert.rejects(loadLinear(async () => { throw new Error('Linear is not connected') }))
})

test('the fold and filter come back from storage, defaults for anything else', () => {
  assert.deepEqual(linearUiOf({ folded: true, filter: 'cycle' }), { folded: true, filter: 'cycle' })
  assert.deepEqual(linearUiOf({ folded: 'yes', filter: 'all' }), { folded: false, filter: 'mine' })
  assert.deepEqual(linearUiOf(null), { folded: false, filter: 'mine' })
})

test("Linear's glyphs: rings by state, bars by priority; a state name cannot break the markup", () => {
  assert.match(statusIcon(state('Backlog', 'backlog')), /stroke-dasharray/)
  assert.match(statusIcon(state('In Review', 'started')), /<path d="M7 7 L7 4 A3 3 0 1 1 /)
  assert.ok(!/<path d="M7 7/.test(statusIcon(state('Todo', 'unstarted'))))
  assert.ok(!statusIcon(state('"><script>', 'started')).includes('<script>'))
  assert.match(priorityIcon(1), /#e8823b/)
  assert.equal((priorityIcon(2).match(/opacity="0.9"/g) ?? []).length, 3)
  assert.equal((priorityIcon(4).match(/opacity="0.9"/g) ?? []).length, 1)
  assert.match(priorityIcon(0), /class="lic none"/)
})
