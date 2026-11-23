// The Linear section's rules: reading issues, filters and order, routing, the message, a send.
import { assert, test } from 'orca/testing'
import type { LinearData, LinearIssue } from './protocol.ts'
import { activeCycle, decodeLinear, encodeLinear, DEFAULT_DISPLAY, isDefaultDisplay, issueOfBranch, toggleProject, type Display, type LinearView, linearMessage, linkRows, rowsByIssue, teamsOf, linearUiOf, linkedIssueOf, loadLinear, priorityIcon, priorityWord, pruneSent, sendIssue, sendTargets, sortIssues, statusIcon, toIssue, viewOf } from './linear.ts'

const ME = 'u-me'
const issue = (id: string, over: Partial<LinearIssue> = {}): LinearIssue => ({
  id, title: `Title ${id}`, url: `https://linear.app/acme/issue/${id}`, state: { name: 'Todo', type: 'unstarted', color: '#9a9aa3' },
  team: id.split('-')[0], project: null, projectColor: '', assignee: { id: ME, name: 'me' }, priority: 3, cycle: null, updatedAt: 0, ...over
})
const state = (name: string, type: string) => ({ name, type, color: '' })
const data = (issues: LinearIssue[], over: Partial<LinearData> = {}): LinearData => ({
  me: ME, teams: ['BOU'], issues, cycles: ['c-now'], sent: {}, lastSent: {}, at: 0, ...over
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
  // Shown (Staging hidden by default), and on Staging.
  const ids = (v: LinearView) => [v.groups.flatMap((g) => g.issues.map((i) => i.id)).sort(), v.hidden.flatMap((h) => h.issues.map((i) => i.id))]
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
  assert.ok(!('connectedTeams' in d), 'no list of every team: only the coordinator menu\'s removed chips used it')
  assert.deepEqual(d.issues.map((i) => [i.id, i.cycle, i.state.name]).sort(), [['BOU-1', 'c-now', 'In Progress'], ['BOU-2', 'c-now', 'In Review'], ['CUS-7', null, 'Todo']])
  assert.deepEqual(d.cycles, ['c-now'])
  assert.ok(!calls.some((c) => c.includes('--team CUS --state')), 'reads no issues of a team I am not in')
})

test('loading fails when Linear is not connected, so the section stays hidden', async () => {
  await assert.rejects(loadLinear(async () => { throw new Error('Linear is not connected') }))
})

test('the fold and filter come back from storage, defaults for anything else', () => {
  assert.deepEqual(linearUiOf({ folded: true, filter: 'cycle' }), { folded: true, filter: 'cycle', display: DEFAULT_DISPLAY, groupFolds: [] })
  assert.deepEqual(linearUiOf({ folded: 'yes', filter: 'all' }), { folded: false, filter: 'mine', display: DEFAULT_DISPLAY, groupFolds: [] })
  assert.deepEqual(linearUiOf(null), { folded: false, filter: 'mine', display: DEFAULT_DISPLAY, groupFolds: [] })
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

test('a branch name links its issue as a whole token, any case, only for teams in the loaded issues', () => {
  const teams = new Set(['BOU', 'DES'])
  assert.equal(issueOfBranch('bou-4179-planned-hours', teams), 'BOU-4179')
  assert.equal(issueOfBranch('cyucelen/BOU-4179', teams), 'BOU-4179')
  assert.equal(issueOfBranch('feat/des-12_fix', teams), 'DES-12')
  assert.equal(issueOfBranch('rebou-4179', teams), null, 'not inside a longer word')
  assert.equal(issueOfBranch('bou-41790x', teams), 'BOU-41790', 'the whole number, never a prefix of it')
  assert.equal(issueOfBranch('bou-4179x', teams), 'BOU-4179')
  assert.equal(issueOfBranch('eng-12-thing', teams), null, 'a team not in the loaded issues')
  assert.equal(issueOfBranch('eng-12-bou-7', teams), 'BOU-7', 'the first token of a known team')
  assert.equal(issueOfBranch('main', teams), null)
  assert.equal(issueOfBranch(null, teams), null)
  assert.equal(issueOfBranch('bou-4179', new Set()), null)
})

test("Orca's link wins over the branch; an issue on several worktrees shows the most recently active", () => {
  const rows = [
    { id: 'a', branch: 'bou-4179-planned-hours', linearIssue: null, lastActivityAt: 10 },
    { id: 'b', branch: 'bou-4179-follow-up', linearIssue: null, lastActivityAt: 30 },
    { id: 'c', branch: 'bou-4179-other', linearIssue: 'BOU-9', lastActivityAt: 50 },
    { id: 'd', branch: 'main', linearIssue: null, lastActivityAt: 99 }
  ]
  const linked = linkRows(rows, new Set(['BOU']))
  assert.deepEqual(linked.map((r) => r.linearIssue), ['BOU-4179', 'BOU-4179', 'BOU-9', null])
  assert.equal(rows[0].linearIssue, null, 'the rows given are not changed')
  const by = rowsByIssue(linked)
  assert.equal(by.get('BOU-4179')?.id, 'b')
  assert.equal(by.get('BOU-9')?.id, 'c')
  assert.equal(by.size, 2)
  assert.deepEqual([...teamsOf({ issues: [issue('BOU-1'), issue('DES-2'), issue('BOU-3')] })], ['BOU', 'DES'])
  assert.equal(teamsOf(null).size, 0)
})

// ---------- display options ----------

const show = (over: Partial<Display['show']> = {}) => ({ ...DEFAULT_DISPLAY.show, ...over })
const display = (over: Partial<Display> = {}): Display => ({ ...DEFAULT_DISPLAY, ...over })
const groupsOf = (v: LinearView) => v.groups.map((g) => [g.label, g.issues.map((i) => i.id)])
const st = {
  progress: state('In Progress', 'started'), review: state('In Review', 'started'), todo: state('Todo', 'unstarted'),
  triage: state('Triage', 'triage'), backlog: state('Backlog', 'backlog'), staging: state('Staging', 'started')
}
const mixed = data([
  issue('BOU-1', { state: st.todo, priority: 2, project: 'Shift Scheduling', projectColor: '#26b5ce', updatedAt: 300 }),
  issue('BOU-2', { state: st.progress, priority: 3, project: 'Shift Scheduling', projectColor: '#26b5ce', updatedAt: 100 }),
  issue('BOU-3', { state: st.backlog, priority: 1, updatedAt: 500 }),
  issue('BOU-4', { state: st.triage, priority: 0, project: 'ISO 27001', updatedAt: 200 }),
  issue('BOU-5', { state: st.staging, priority: 2 }),
  issue('BOU-6', { state: st.review, priority: 1, assignee: { id: 'u-ernst', name: 'ernst' }, project: 'ISO 27001' }),
  issue('BOU-7', { state: st.backlog, priority: 4, assignee: null, project: 'Shift Scheduling' }),
  issue('BOU-8', { state: st.todo, priority: 2, assignee: null })
])

test('the default display: grouped by status in state order, Backlog and Staging folded away at the end', () => {
  const v = viewOf(mixed, 'team')
  assert.deepEqual(groupsOf(v), [['In Progress', ['BOU-2']], ['In Review', ['BOU-6']], ['Todo', ['BOU-8', 'BOU-1']], ['Triage', ['BOU-4']]])
  assert.deepEqual(v.hidden.map((h) => [h.state, h.issues.map((i) => i.id)]), [['backlog', ['BOU-3', 'BOU-7']], ['staging', ['BOU-5']]])
  assert.equal(v.count, 5)
  assert.ok(isDefaultDisplay(DEFAULT_DISPLAY))
})

test('Show puts a state back in the list or folds it away; the count follows', () => {
  const v = viewOf(mixed, 'team', new Set(), display({ show: show({ triage: false, backlog: true, staging: true }) }))
  assert.deepEqual(v.groups.map((g) => g.label), ['In Progress', 'In Review', 'Todo', 'Backlog', 'Staging'])
  assert.deepEqual(v.hidden.map((h) => h.state), ['triage'])
  assert.equal(v.count, 7)
  assert.ok(!isDefaultDisplay(display({ show: show({ backlog: true }) })))
})

test('group by project: by count, then name, "No project" last; by priority: urgent to none; by assignee: me, by count, unassigned last', () => {
  const all = display({ show: show({ backlog: true, staging: true }) })
  assert.deepEqual(groupsOf(viewOf(mixed, 'team', new Set(), { ...all, group: 'project' })).map((g) => g[0]), ['Shift Scheduling', 'ISO 27001', 'No project'])
  assert.deepEqual(groupsOf(viewOf(mixed, 'team', new Set(), { ...all, group: 'priority' })).map((g) => g[0]), ['Urgent', 'High', 'Medium', 'Low', 'No priority'])
  assert.deepEqual(groupsOf(viewOf(mixed, 'team', new Set(), { ...all, group: 'assignee' })), [['me', ['BOU-3', 'BOU-1', 'BOU-5', 'BOU-2', 'BOU-4']], ['ernst', ['BOU-6']], ['Unassigned', ['BOU-8', 'BOU-7']]])
  const none = viewOf(mixed, 'team', new Set(), { ...all, group: 'none' })
  assert.equal(none.groups.length, 1)
  assert.equal(none.groups[0].label, '')
})

test('sort within groups: priority, status, recently updated or newest; linked issues always last', () => {
  const flat = (sort: Display['sort'], linked = new Set<string>()) => viewOf(mixed, 'team', linked, display({ group: 'none', sort, show: show({ backlog: true }) })).groups[0].issues.map((i) => i.id)
  assert.deepEqual(flat('priority'), ['BOU-6', 'BOU-3', 'BOU-8', 'BOU-1', 'BOU-2', 'BOU-7', 'BOU-4'])
  assert.deepEqual(flat('status'), ['BOU-2', 'BOU-6', 'BOU-8', 'BOU-1', 'BOU-4', 'BOU-3', 'BOU-7'])
  assert.deepEqual(flat('updated').slice(0, 4), ['BOU-3', 'BOU-1', 'BOU-4', 'BOU-2'])
  assert.deepEqual(flat('newest'), ['BOU-8', 'BOU-7', 'BOU-6', 'BOU-4', 'BOU-3', 'BOU-2', 'BOU-1'])
  assert.deepEqual(flat('newest', new Set(['BOU-8'])).slice(-1), ['BOU-8'])
})

test('projects: every project of the filter with its color and count, "No project" last; picking narrows the list and the folds', () => {
  const v = viewOf(mixed, 'team')
  assert.deepEqual(v.projects.map((p) => [p.key, p.name, p.color, p.count]), [['Shift Scheduling', 'Shift Scheduling', '#26b5ce', 3], ['ISO 27001', 'ISO 27001', '', 2], ['', 'No project', '', 3]])
  const picked = viewOf(mixed, 'team', new Set(), toggleProject(DEFAULT_DISPLAY, 'Shift Scheduling'))
  assert.deepEqual(groupsOf(picked), [['In Progress', ['BOU-2']], ['Todo', ['BOU-1']]])
  assert.deepEqual(picked.hidden.map((h) => [h.state, h.issues.map((i) => i.id)]), [['backlog', ['BOU-7']]])
  assert.equal(picked.projects.length, 3, 'the project list stays whole while narrowed')
  const noProject = viewOf(mixed, 'team', new Set(), toggleProject(DEFAULT_DISPLAY, ''))
  assert.deepEqual(groupsOf(noProject), [['Todo', ['BOU-8']]])
  assert.deepEqual(toggleProject(toggleProject(DEFAULT_DISPLAY, 'A'), 'A').projects, [], 'unpicking the last one shows every project again')
  assert.deepEqual(toggleProject(toggleProject(DEFAULT_DISPLAY, 'A'), 'B').projects, ['A', 'B'])
})

test('display options and folded groups come back from storage, defaults for anything malformed', () => {
  const saved = { folded: false, filter: 'team', display: { group: 'project', sort: 'updated', show: { triage: false, backlog: true }, projects: ['Shift Scheduling', '', 3] }, groupFolds: ['status:Todo', 7] }
  assert.deepEqual(linearUiOf(saved), { folded: false, filter: 'team', display: { group: 'project', sort: 'updated', show: { triage: false, backlog: true, staging: false }, projects: ['Shift Scheduling', ''] }, groupFolds: ['status:Todo'] })
  assert.deepEqual(linearUiOf({ display: { group: 'labels', sort: 1, show: 'all' } }).display, DEFAULT_DISPLAY)
})

test('an issue reads its project color and when it was updated', () => {
  const i = toIssue({ identifier: 'BOU-1', project: { name: 'P', color: '#26b5ce' }, updatedAt: '2026-11-18T09:21:40.492Z' })!
  assert.equal(i.projectColor, '#26b5ce')
  assert.equal(i.updatedAt, Date.parse('2026-11-18T09:21:40.492Z'))
  const bad = toIssue({ identifier: 'BOU-2', project: { name: 'P', color: 'url(x)' }, updatedAt: 'soon' })!
  assert.equal(bad.projectColor, '')
  assert.equal(bad.updatedAt, 0)
})

// ---------- the panel's copy ----------

/** A team's worth of open issues as Linear gives them: long titles and slugged URLs, real ids. */
function realistic(n: number): LinearData {
  const words = ['Planner', 'show', 'the', 'total', 'planned', 'staff', 'hours', 'per', 'day', 'and', 'week', 'Clock-in', 'store', 'terminal', 'employee', 'PIN', 'QR', 'code', 'Presence', 'checks', 'verify', 'GPS', 'native', 'Error:', 'request', 'entity', 'too', 'large']
  const uuid = (k: number) => `${(k * 2654435761 >>> 0).toString(16).padStart(8, '0')}-ac1e-4cd7-87c2-${(k * 40503 >>> 0).toString(16).padStart(12, '0')}`
  const states: LinearIssue['state'][] = [['Triage', 'triage'], ['Backlog', 'backlog'], ['Todo', 'unstarted'], ['Analyzed', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Staging', 'started'], ['Blocked', 'started']].map(([name, type], k) => ({ name, type, color: `#${(k * 1234567).toString(16).slice(0, 6).padStart(6, '0')}` }))
  const issues = Array.from({ length: n }, (_, k): LinearIssue => {
    const team = ['BOU', 'DES', 'CUS'][k % 3]
    const id = `${team}-${1000 + k}`
    const title = Array.from({ length: 8 + (k % 9) }, (_, w) => words[(k * 7 + w * 3) % words.length]).join(' ')
    return {
      id, title, url: `https://linear.app/bounti/issue/${id}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
      state: states[k % states.length], team, project: k % 4 ? `Project ${k % 23}` : null, projectColor: k % 4 ? '#26b5ce' : '',
      assignee: k % 5 ? { id: uuid(k % 17), name: `person${k % 17}` } : null, priority: k % 5, cycle: k % 3 ? uuid(1000 + (k % 6)) : null, updatedAt: 1794993700492 - k * 61_000
    }
  })
  return { me: uuid(1), teams: ['BOU', 'DES'], issues, cycles: [uuid(1001)], sent: { 'BOU-1001': { coordinator: 'bounti', at: 5 } }, lastSent: { BOU: 'bounti' }, at: 9 }
}

test('the panel copy of 700 issues stays well under the 256 KiB Orca allows a post', () => {
  const data = realistic(700)
  assert.ok(JSON.stringify(data).length > 256 * 1024, 'the raw shape is what Orca dropped')
  const size = JSON.stringify(encodeLinear(data)).length
  assert.ok(size < 200 * 1024, `encoded: ${Math.round(size / 1024)} KiB`)
})

test('the panel copy decodes to the same data, links shortened to the issue (Linear redirects to the slug)', () => {
  const data = realistic(50)
  data.issues.push(issue('ENG-7', { url: 'https://example.com/elsewhere', team: 'BOU', cycle: null, updatedAt: 0 }), issue('BOU-9', { url: '' }))
  const back = decodeLinear(encodeLinear(data))!
  const expected = data.issues.map((i) => ({ ...i, url: i.url.startsWith('https://linear.app/bounti/issue/') ? `https://linear.app/bounti/issue/${i.id}` : i.url, updatedAt: Math.round(i.updatedAt / 1000) * 1000 }))
  assert.deepEqual(back.issues, expected)
  assert.deepEqual({ ...back, issues: [] }, { ...data, issues: [] })
  assert.equal(decodeLinear(null), null)
  assert.equal(decodeLinear({ issues: [] } as any), null, 'not the panel copy')
})
