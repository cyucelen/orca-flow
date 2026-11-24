// The Completed goals tab: search and filters, rows, details, states and copy (exact, from the approved design), and the worker's read of the goals.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { add, done, reopen } from '../skills/orca-flow/scripts/goals.mjs'
import { readCompleted } from './completed-goals.ts'
import {
  BATCH, completedBy, completedParts, completedUi, DAY, detailHtml, doneAtOf, filterCompleted, highlight, matchGoal, noMatchText, savedUiOf, toastHtml,
  type CompletedData, type CompletedGoal, type CompletedUi
} from './completed-goals-view.ts'

const noMatch = (text: string, re: RegExp, message?: string) => assert.ok(!re.test(text), message ?? `unexpected ${re}`)
// Midday local time, so the month and day never shift with the machine's time zone.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()
const NOW = at(2026, 11, 24, 15)
const goal = (over: Partial<CompletedGoal> = {}): CompletedGoal => ({
  id: 'g1', title: 'Ship the billing export for finance', note: 'Finance wants a monthly CSV of every invoice line.', doneWhen: 'Finance downloads the export themselves.', next: 'Tell finance it is live',
  steps: [{ text: 'CSV columns agreed', done: true }, { text: 'Export job', done: true }, { text: 'Backfill October', done: false }],
  links: { linear: ['BNT-412'], worktrees: [{ name: 'billing-export', workspaceId: 'ws-billing' }] },
  status: 'done', createdAt: at(2026, 11, 2), updatedAt: at(2026, 11, 18), doneAt: at(2026, 11, 18, 16), doneBy: 'you', lastChange: { by: 'you', field: 'status', at: at(2026, 11, 18, 16) }, ...over
})
const ready = (goals: CompletedGoal[], error: string | null = null): CompletedData => ({ phase: 'ready', goals, error })
const ui = (over: Partial<CompletedUi> = {}): CompletedUi => ({ ...completedUi(), ...over })
const GOALS = [
  goal(),
  goal({ id: 'g2', title: 'Coordinator restarts keep the open tasks', note: 'After a restart the coordinator forgot which workers were running.', doneWhen: undefined, next: undefined, steps: [], links: { linear: ['BNT-398', 'BNT-401'], worktrees: [] }, doneAt: at(2026, 11, 20, 10), proposedBy: 'billing lead' }),
  goal({ id: 'g3', title: 'Usage tab shows cost per workstream', note: undefined, doneWhen: undefined, next: undefined, steps: [{ text: 'Price table', done: true }, { text: 'CSV export of the totals', done: true }], links: { linear: [], worktrees: [{ name: 'usage-cost', workspaceId: null }] }, doneAt: at(2026, 11, 22, 18) }),
  goal({ id: 'g4', title: 'Write the onboarding guide', note: undefined, doneWhen: undefined, next: undefined, steps: [], links: { linear: [], worktrees: [] }, doneAt: at(2026, 11, 15), createdAt: at(2026, 10, 1) }),
  goal({ id: 'g5', title: 'Provider logos in the sidebar', note: undefined, doneWhen: undefined, next: 'Kubernetes badge', steps: [], links: { linear: [], worktrees: [] }, doneAt: at(2025, 12, 30) })
]
const ids = (rows: { g: CompletedGoal }[]) => rows.map((r) => r.g.id)

// ---------- search ----------

test('search: every word must be somewhere in title, description, done when, next, a todo, a Linear id or a worktree name', () => {
  const g = goal()
  assert.deepEqual(matchGoal(g, ''), { field: null, label: '', text: '' })
  assert.equal(matchGoal(g, 'billing')?.field, 'title', 'the title wins when it matches')
  assert.deepEqual([matchGoal(g, 'csv')?.label, matchGoal(g, 'csv')?.text], ['Description', 'Finance wants a monthly CSV of every invoice line.'])
  assert.equal(matchGoal(g, 'themselves')?.label, 'Done when')
  assert.equal(matchGoal(g, 'live')?.label, 'Next', 'a done goal stays searchable by its Next')
  assert.equal(matchGoal(g, 'october')?.label, 'Todo')
  assert.equal(matchGoal(g, 'bnt-412')?.label, 'Linear')
  assert.equal(matchGoal(goal({ title: 'x', note: undefined, doneWhen: undefined, next: undefined, steps: [] }), 'billing-export')?.label, 'Worktree')
  assert.equal(matchGoal(g, 'BILLING FINANCE')?.field, 'title', 'case-insensitive, words in any order and place')
  assert.equal(matchGoal(g, 'billing kubernetes'), null, 'one word missing: no match')
  assert.equal(matchGoal(goal({ links: { linear: [], worktrees: [{ path: '/w/some-tree' }] } }), 'some-tree')?.label, 'Worktree', 'a path-only link is named by its last part')
})

test('highlight: words marked, text escaped, a long text starts shortly before the first word', () => {
  assert.equal(highlight('Export <b>the</b> data', 'export data'), '<mark>Export</mark> &lt;b&gt;the&lt;/b&gt; <mark>data</mark>')
  assert.equal(highlight('a (b) c', '(b'), 'a <mark>(b</mark>) c', 'regex characters in the search are plain text')
  assert.equal(highlight('plain', ''), 'plain')
  const long = `${'x'.repeat(60)} needle here`
  assert.match(highlight(long, 'needle', true), /^….*<mark>needle<\/mark> here$/)
  assert.equal(highlight(long, 'needle', false).startsWith('xxx'), true)
})

// ---------- filters ----------

test('filters: Completed within, Linked to and Sort; the total is every completed goal', () => {
  const all = (over: Partial<CompletedUi> = {}) => filterCompleted(GOALS, ui(over), NOW)
  assert.deepEqual(ids(all().rows), ['g3', 'g2', 'g1', 'g4', 'g5'], 'newest first')
  assert.deepEqual(ids(all({ sort: 'old' }).rows), ['g5', 'g4', 'g1', 'g2', 'g3'])
  assert.equal(all().total, 5)
  assert.deepEqual(ids(all({ within: '7' }).rows), ['g3', 'g2', 'g1'], '7 days: the last 7 × 24 h (g1 was 5 days 23 hours ago, g4 9 days)')
  assert.deepEqual(ids(all({ within: '30' }).rows), ['g3', 'g2', 'g1', 'g4'])
  assert.deepEqual(ids(all({ within: '90' }).rows), ['g3', 'g2', 'g1', 'g4'])
  assert.deepEqual(ids(all({ linked: 'linear' }).rows), ['g2', 'g1'])
  assert.deepEqual(ids(all({ linked: 'worktree' }).rows), ['g3', 'g1'])
  assert.deepEqual(ids(all({ linked: 'none' }).rows), ['g4', 'g5'])
  assert.deepEqual(ids(all({ linked: 'none', within: '30', q: 'guide' }).rows), ['g4'], 'filters and search together')
  assert.equal(all({ within: '7' }).total, 5, 'the total ignores the filters')
  const edge = [goal({ id: 'e', doneAt: NOW - 7 * DAY }), goal({ id: 'f', doneAt: NOW - 7 * DAY - 1 })]
  assert.deepEqual(ids(filterCompleted(edge, ui({ within: '7' }), NOW).rows), ['e'], 'exactly 7 days still counts')
  const open = goal({ id: 'o', status: 'open' })
  assert.equal(filterCompleted([open], ui(), NOW).total, 0, 'only done goals')
})

test('the no-match sentence is built from the active filters', () => {
  assert.equal(noMatchText(ui({ q: 'kubernetes', within: '30' })), 'No goal completed in the last 30 days matches “kubernetes”.')
  assert.equal(noMatchText(ui({ within: '7', linked: 'linear' })), 'No goal completed in the last 7 days and linked to a Linear issue fits these filters.')
  assert.equal(noMatchText(ui({ linked: 'worktree' })), 'No goal linked to a worktree fits these filters.')
  assert.equal(noMatchText(ui({ linked: 'none', q: ' x ' })), 'No goal with nothing linked matches “x”.')
})

test('only Completed within and Sort are read back from storage; anything unknown is the default', () => {
  assert.deepEqual(savedUiOf({ within: '30', sort: 'old', q: 'secret', linked: 'linear' }), { within: '30', sort: 'old' })
  assert.deepEqual(savedUiOf({ within: '5', sort: 'sideways' }), { within: 'all', sort: 'new' })
  assert.deepEqual(savedUiOf(null), { within: 'all', sort: 'new' })
})

// ---------- who completed it, and old goals ----------

test('who completed it: doneBy, the agent that said it was done; a goal from before shows only the date, unless the last change was the status change', () => {
  assert.deepEqual(completedBy(goal()), { by: 'you', proposedBy: null })
  assert.deepEqual(completedBy(goal({ proposedBy: 'billing lead' })), { by: 'you', proposedBy: 'billing lead' })
  const old = goal({ doneBy: undefined })
  assert.deepEqual(completedBy(old), { by: 'you', proposedBy: null }, 'last change was the status change by you')
  assert.deepEqual(completedBy(goal({ doneBy: undefined, lastChange: { by: 'you', field: 'next', at: 1 } })), { by: null, proposedBy: null }, 'edited since: not known')
  const html = detailHtml(goal({ doneBy: undefined, lastChange: { by: 'you', field: 'next', at: 1 } }), false, NOW)
  assert.match(html, />Nov 18, 2026 · 6d ago</)
  noMatch(html, / by you/)
})

test('doneAt falls back to updatedAt for the oldest files, and a goal with neither still lists', () => {
  assert.equal(doneAtOf({ doneAt: undefined, updatedAt: 5, createdAt: 1 }), 5)
  assert.equal(doneAtOf({ doneAt: NaN, updatedAt: 5, createdAt: 1 }), 5)
  assert.equal(doneAtOf({ doneAt: undefined, updatedAt: 0, createdAt: 1 }), 1)
  const bare = goal({ id: 'old', doneAt: undefined, doneBy: undefined, updatedAt: at(2026, 11, 3), lastChange: { by: 'you', field: 'next', at: 1 } })
  const out = completedParts(ready([bare]), ui({ sel: 'old' }), NOW)
  assert.match(out.body, /Nov 3/)
})

// ---------- the page ----------

test('the page: header with the total, count line, month headings with their counts, rows and the details pane', () => {
  const p = completedParts(ready(GOALS), ui({ sel: 'g1' }), NOW)
  assert.match(p.head, /<h1>Completed goals<\/h1><span class="gc">5<\/span>/)
  assert.equal(p.tools, true)
  assert.match(p.count, /5 goals, newest first/)
  assert.match(p.body, /<h2 class="month label" id="mh-November2026">November 2026<span class="n">4<\/span><\/h2>/)
  assert.match(p.body, /<h2 class="month label" id="mh-December2025">December 2025<span class="n">1<\/span><\/h2>/)
  assert.match(p.body, /<span class="dt" title="[^"]*Wed, Nov 18, 2026[^"]*">Nov 18<\/span>/)
  assert.match(p.body, /<span class="dt"[^>]*>Dec 30, 2025<\/span>/, 'another year says the year')
  assert.match(p.body, /<aside class="dpane" id="dpane" aria-labelledby="dtitle"/)
  assert.equal(completedParts(ready(GOALS), ui({ sort: 'old' }), NOW).count.includes('5 goals, oldest first'), true)
  assert.match(completedParts(ready([goal()]), ui(), NOW).count, /1 goal, newest first/)
})

test('a row: title, date, progress ring with link pills (Linear ids in monospace), Reopen; no second line without todos and links', () => {
  const body = completedParts(ready(GOALS), ui(), NOW).body
  assert.match(body, /aria-label="Ship the billing export for finance, completed Nov 18, 2026, 2 of 3 todos done, linked to BNT-412, billing-export"/)
  assert.match(body, /<span class="gprogress">[^]*<span>2\/3<\/span><\/span><span class="lchip"><span class="mono">BNT-412<\/span><\/span><span class="lchip"><svg[^>]*>[^]*<\/svg>billing-export<\/span>/)
  assert.match(body, /aria-label="Reopen Ship the billing export for finance"/)
  const lone = completedParts(ready([GOALS[3]]), ui(), NOW).body
  noMatch(lone, /class="l2"/, 'no todos and no links: one line')
  assert.equal(body.match(/tabindex="0"/g)?.length, 2, 'one tab stop in the list: the first row and its Reopen')
  const rove = completedParts(ready(GOALS), ui({ rove: 'g2' }), NOW).body
  assert.match(rove, /data-open="g2" tabindex="0"/)
  assert.match(rove, /data-open="g3" tabindex="-1"/)
  assert.match(completedParts(ready(GOALS), ui({ sel: 'g1' }), NOW).body, /class="crow sel" data-id="g1"><button class="copen" data-open="g1" tabindex="-1" aria-label="[^"]*" aria-current="true" aria-controls="dpane">/)
})

test('search shows where it matched: the field and the words marked, the title marked in place', () => {
  const body = completedParts(ready(GOALS), ui({ q: 'csv' }), NOW).body
  assert.match(body, /<span class="hit"><span class="hf">Description:<\/span> Finance wants a monthly <mark>CSV<\/mark> of every invoice line\.<\/span>/)
  assert.match(body, /<span class="hit"><span class="hf">Todo:<\/span> [^]*<mark>CSV<\/mark> export of the totals/)
  const title = completedParts(ready(GOALS), ui({ q: 'billing' }), NOW).body
  assert.match(title, /<span class="ti">Ship the <mark>billing<\/mark> export for finance<\/span>/)
  noMatch(title, /class="hit"/, 'a title match has no second hit line')
  assert.match(completedParts(ready(GOALS), ui({ q: 'billing' }), NOW).count, /<b>1<\/b> of 5 goals match<\/span><button class="cta" data-clear-all>Clear filters<\/button>/)
  assert.match(completedParts(ready(GOALS), ui({ q: 'x' }), NOW).side, /data-clear-q aria-label="Clear search"/)
  assert.match(completedParts(ready(GOALS), ui(), NOW).side, /<kbd aria-hidden="true">\/<\/kbd>/)
})

test('no matches: the count says 0 of N, the sentence and a Clear filters button; the count line has no second Clear link', () => {
  const p = completedParts(ready(GOALS), ui({ q: 'kubernetes', within: '30' }), NOW)
  assert.match(p.count, /<b>0<\/b> of 5 goals match<\/span>$/)
  assert.match(p.body, /<h2>No goals match<\/h2><p>No goal completed in the last 30 days matches “kubernetes”\.<\/p><button class="gbtn quiet" data-clear-all>Clear filters<\/button>/)
  assert.equal(p.tools, true, 'search and filters stay')
  assert.match(p.filters, /data-f="within" data-v="30" aria-pressed="true"/)
})

test('filters are groups of toggle buttons labelled by their visible label', () => {
  const f = completedParts(ready(GOALS), ui({ within: '90', linked: 'worktree', sort: 'old' }), NOW).filters
  for (const label of ['Completed', 'Linked to', 'Sort']) assert.match(f, new RegExp(`<span class="flabel" id="fl-[a-z]+">${label}</span>`))
  assert.match(f, /role="group" aria-labelledby="fl-within"/)
  for (const [k, v] of [['within', '90'], ['linked', 'worktree'], ['sort', 'old']]) assert.match(f, new RegExp(`data-f="${k}" data-v="${v}" aria-pressed="true"`))
  assert.equal(f.match(/aria-pressed="true"/g)?.length, 3)
  for (const t of ['7 days', '30 days', '90 days', 'All time', 'Any', 'Linear issue', 'Worktree', 'Nothing', 'Newest first', 'Oldest first']) assert.ok(f.includes(`>${t}</button>`), t)
})

test('many goals: batches of 50 with Show more, the month count covers rows not shown yet', () => {
  const many = Array.from({ length: 112 }, (_, i) => goal({ id: `m${i}`, title: `Goal ${i}`, doneAt: at(2026, 11, 1) - i * 3_600_000, steps: [], links: { linear: [], worktrees: [] } }))
  const p = completedParts(ready(many), ui(), NOW)
  assert.equal(p.body.match(/<li class="crow/g)?.length, BATCH)
  assert.match(p.body, /<button class="gbtn quiet" data-more>Show 50 more<\/button><span>Showing 50 of 112<\/span>/)
  assert.match(p.body, />November 2026<span class="n">\d+<\/span>/)
  const total = [...p.body.matchAll(/class="n">(\d+)</g)].reduce((n, m) => n + Number(m[1]), 0)
  assert.equal(total, 112, 'the headings count all matching goals')
  const last = completedParts(ready(many), ui({ limit: 100 }), NOW).body
  assert.match(last, /Show 12 more<\/button><span>Showing 100 of 112/)
  noMatch(completedParts(ready(many), ui({ limit: 150 }), NOW).body, /data-more/)
})

test('details: read-only, with Reopen, links that open the issue or the worktree, a removed worktree faint, and no Next', () => {
  const html = detailHtml(goal({ proposedBy: 'billing lead' }), false, NOW)
  assert.match(html, /<h2 class="dtitle" id="dtitle">Ship the billing export for finance<\/h2>/)
  assert.match(html, /Completed<\/span><span title="[^"]*">Nov 18, 2026 by you · 6d ago<\/span><span>billing lead said it was done<\/span>/)
  assert.match(html, /<span class="k">Description<\/span><span class="v note">Finance wants/)
  assert.match(html, /<span class="k">Done when<\/span><span class="v ">Finance downloads/)
  assert.match(html, /<span class="k">Todos · 2\/3<\/span>/)
  assert.match(html, /<li class="step done">[^]*CSV columns agreed[^]*, done<\/span><\/li>/)
  assert.match(html, /Backfill October<\/span><span class="sr">, not done<\/span>/)
  noMatch(html, /Tell finance it is live|data-gedit|contenteditable/, 'Next is not shown, nothing is editable')
  assert.match(html, /<button class="lchip link" data-url="https:\/\/linear\.app\/issue\/BNT-412" title="Open BNT-412 in Linear"/)
  assert.match(html, /<button class="lchip link" data-wt="ws-billing" title="Go to worktree billing-export"/)
  assert.match(html, /Added Nov 2, 2026 · took 16 days<\/span><button class="gbtn" data-reopen="g1">Reopen<\/button>/)
  const gone = detailHtml(goal({ links: { linear: [], worktrees: [{ name: 'usage-cost', workspaceId: null }, { name: 'unread' }] } }), false, NOW)
  assert.match(gone, /<span class="lchip gone" title="Worktree removed">[^]*usage-cost<\/span>/)
  noMatch(gone, /data-wt=/)
  assert.match(gone, /<span class="lchip">[^]*unread<\/span>/, 'workspaces not read: no claim, no tooltip')
  const bare = detailHtml(goal({ note: undefined, doneWhen: ' ', steps: [], links: { linear: [], worktrees: [] } }), false, NOW)
  for (const none of ['<span class="v none">None</span>', 'No todos', 'No ticket or worktree']) assert.ok(bare.includes(none), none)
  assert.match(detailHtml(null, false, NOW), /Select a goal to see its details\./)
})

test('details on a narrow tab replace the list, with a back button; only when a goal is selected', () => {
  const p = completedParts(ready(GOALS), ui({ sel: 'g1', screen: 'detail' }), NOW)
  assert.equal(p.tools, false)
  assert.match(p.body, /<button class="back" data-backto>[^]*<span>Completed goals<\/span><\/button><\/div><article class="dscreen" aria-labelledby="dtitle">/)
  const gone = completedParts(ready(GOALS), ui({ sel: 'nope', screen: 'detail' }), NOW)
  assert.equal(gone.tools, true, 'the goal is gone: back to the list')
})

test('goal text is escaped everywhere', () => {
  const g = goal({ title: '<img src=x onerror=alert(1)>', note: '<script>x</script>', doneWhen: '"><b>', next: '<i>', steps: [{ text: '<u>t</u>', done: false }], links: { linear: ['<X-1>'], worktrees: [{ name: '<wt>', workspaceId: 'w"1' }] }, doneBy: '<me>', proposedBy: '<agent>' })
  const p = completedParts(ready([g]), ui({ sel: g.id, q: 'script' }), NOW)
  noMatch(p.body, /<img|<script|<b>|<i>|<u>|<X-1>|<wt>|<me>|<agent>/)
  const toasts = toastHtml({ kind: 'reopened', title: g.title, undo: { id: g.id, title: g.title, doneAt: 1, proposedBy: null } }) + toastHtml({ kind: 'error', text: '<b>x</b>' })
  noMatch(toasts, /<img|<script|<b>x<\/b>/)
  assert.match(p.body, /data-wt="w&quot;1"/)
})

// ---------- states ----------

test('states: loading, Goals off, error with and without goals read before, no completed goals yet', () => {
  const loading = completedParts({ phase: 'loading', goals: [], error: null }, ui(), NOW)
  assert.match(loading.head, /<h1>Completed goals<\/h1><\/div>$/, 'no count while reading')
  assert.match(loading.body, /<div class="note" role="status">Reading goals…<\/div>/)
  assert.equal(loading.tools, false)
  const off = completedParts({ phase: 'off', goals: [], error: null }, ui(), NOW)
  assert.match(off.body, /<h2>Goals is turned off<\/h2><p>Turn on Goals in Orca Flow Settings → Features to see your completed goals here\.<\/p>/)
  const failed = completedParts({ phase: 'loading', goals: [], error: 'EACCES: denied\nat x' }, ui(), NOW)
  assert.match(failed.head, /<div class="banner bad" role="alert"><b>Could not read goals\.<\/b><span>EACCES: denied<\/span><button class="cta" data-retry>Try again<\/button><\/div>/)
  assert.equal(failed.tools, false)
  const stale = completedParts(ready(GOALS, 'boom'), ui({ sel: 'g1' }), NOW)
  assert.match(stale.head, /role="alert"/)
  assert.match(stale.body, /class="crow/, 'the old list stays under the banner')
  assert.equal(stale.body.match(/data-reopen="[^"]*"[^>]*disabled/g)?.length, 6, 'Reopen waits for a read that works: 5 rows and the details')
  const empty = completedParts(ready([]), ui(), NOW)
  assert.match(empty.head, /<span class="gc">0<\/span>/)
  assert.match(empty.body, /<h2>No completed goals yet<\/h2><p>When you mark a goal done in the sidebar, it moves here\. You can search it later and reopen it\.<\/p>/)
  assert.equal(empty.tools, false)
})

test('the toast: Reopen has Undo, the others do not', () => {
  const undo = { id: 'g1', title: 'Ship it', doneAt: 1, proposedBy: null }
  assert.match(toastHtml({ kind: 'reopened', title: 'Ship it', undo }), /Reopened <b>“Ship it”<\/b>\. It’s back in Goals\.<\/span><button class="undo" data-undo>Undo<\/button><button class="x" data-dismiss aria-label="Dismiss">/)
  assert.match(toastHtml({ kind: 'undone', title: 'Ship it' }), /<b>“Ship it”<\/b> is completed again\./)
  noMatch(toastHtml({ kind: 'undone', title: 'Ship it' }), /data-undo/)
  assert.match(toastHtml({ kind: 'error', text: 'Could not reopen “Ship it”: no goal' }), /Could not reopen “Ship it”: no goal/)
})

// ---------- the worker's read: old goals unchanged ----------

function withData<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-flow-completed-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('readCompleted: only done goals, newest first; each worktree link names the workspace that shows it, or null when none does', () => withData((dir) => {
  const a = add('Alpha', { worktrees: [{ key: 'k1', name: 'alpha' }, { path: '/w/gone', name: 'gone' }] }, { data: dir })
  const b = add('Beta', {}, { data: dir })
  add('Still open', {}, { data: dir })
  done(a.id, 'you', { data: dir, doneAt: Date.now() - 5000 })
  done(b.id, 'you', { data: dir, doneAt: Date.now() - 1000 })
  const rows = [{ id: 'identity:k1', path: '/w/alpha' }, { id: 'folder-ws', path: '/w/gone', folderOf: 'c1' }, { id: 'q', path: '/w/q', queueKey: 'c1' }]
  const out = readCompleted(rows, dir)
  assert.deepEqual(out.map((g) => g.title), ['Beta', 'Alpha'])
  assert.deepEqual(out[1].links.worktrees.map((w) => w.workspaceId), ['identity:k1', null], 'a folder or queue row stands for a session, not the worktree')
  assert.deepEqual(readCompleted([], dir)[1].links.worktrees.map((w) => 'workspaceId' in w), [false, false], 'no workspaces read: no claim')
}))

test('a goal in the format of the previous version loads, lists, opens in the page and reopens unchanged; reading and drawing write nothing', () => withData((dir) => {
  mkdirSync(join(dir, 'goals'), { recursive: true })
  // As the previous version wrote a done goal: doneAt, but no doneBy and no proposedBy; and one of the oldest files without doneAt.
  const old = { id: 'g_old-1a2b', title: 'Old finished goal', note: 'kept', steps: [{ text: 's', done: true }], links: { linear: ['DES-1'], worktrees: [{ key: 'k', name: 'wt' }] }, status: 'done', createdAt: at(2026, 9, 1), updatedAt: at(2026, 9, 20), doneAt: at(2026, 9, 20), lastChange: { by: 'you', field: 'status', at: at(2026, 9, 20) } }
  const older = { id: 'g_older-3c4d', title: 'Older goal', steps: [], links: { linear: [], worktrees: [] }, status: 'done', createdAt: at(2026, 1, 1), updatedAt: at(2026, 2, 1), lastChange: { by: 'you', field: 'next', at: at(2026, 2, 1) } }
  const texts = new Map<string, string>()
  for (const g of [old, older]) { const f = join(dir, 'goals', `${g.id}.json`); texts.set(f, `${JSON.stringify(g, null, 2)}\n`); writeFileSync(f, texts.get(f)!) }
  const mtimes = new Map([...texts.keys()].map((f) => [f, statSync(f).mtimeMs]))
  const goals = readCompleted([], dir)
  assert.deepEqual(goals.map((g) => g.id), ['g_old-1a2b', 'g_older-3c4d'])
  const p = completedParts(ready(goals), ui({ sel: 'g_old-1a2b' }), at(2026, 11, 24))
  assert.match(p.body, /Old finished goal/)
  assert.match(p.body, /Sep 20/)
  assert.match(p.body, /Feb 1/, 'the goal without doneAt is dated by its last update')
  assert.match(p.body, /Sep 20, 2026 by you/, 'the last change was the status change: by you')
  for (const [f, text] of texts) { assert.equal(readFileSync(f, 'utf8'), text, 'unchanged on disk'); assert.equal(statSync(f).mtimeMs, mtimes.get(f)) }
  assert.equal(readdirSync(join(dir, 'goals')).length, 2, 'no file added')
  const r = reopen('g_old-1a2b', 'you', { data: dir })
  assert.deepEqual([r.status, r.title, r.note, r.links], ['open', 'Old finished goal', 'kept', old.links])
  assert.equal(readFileSync(join(dir, 'goals', 'g_older-3c4d.json'), 'utf8'), texts.get(join(dir, 'goals', 'g_older-3c4d.json')), 'the other goal is untouched')
}))

test('the tab is read-only: no Next step button (Jump or Assign), even for a goal whose step was assigned before it was completed', () => {
  const assigned = { ...goal({ id: 'as' }), assignment: { coordinator: 'home', name: 'bounti', next: 'Tell finance it is live', state: 'delivered', at: 1, by: 'you', token: 't' } } as CompletedGoal
  const p = completedParts(ready([assigned, ...GOALS]), ui({ sel: 'as' }), NOW)
  noMatch(p.body, /data-gjump|data-gassign|class="gact|class="gline|contenteditable|data-gedit|data-gfinish/)
  noMatch(detailHtml(assigned, true, NOW), /data-gjump|data-gassign|gact|Assign|Jump/)
})
