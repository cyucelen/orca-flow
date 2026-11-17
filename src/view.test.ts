// The panel's HTML from a snapshot, checked in Node.
import { assert, test } from 'orca/testing'
import type { AgentInfo, AgentSummary, Snapshot, WorkspaceRow } from './protocol.ts'
import { askingRows, askKindOf, character, colorSlots, emptyUi, faceOf, finishedAgents, freeLooks, gaugesOf, prBadge, render, updateButton } from './view.ts'
import type { CockpitStats } from './protocol.ts'
import { pressGate } from './panel/press.ts'
import { removeWorktree } from './cockpit.ts'

const noMatch = (text: string, re: RegExp, message?: string) => assert.ok(!re.test(text), message ?? `unexpected ${re}`)

const summary = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  title: 'Work', about: 'What this is for.', glance: '', goal: '', since: 'Did a thing',
  needs: { type: 'none', ask: '', options: [] }, effort: 'quick', priority: 'P2', role: 'solo', updatedAt: 1, ...over
})
const agent = (paneKey: string, title: string, state: AgentInfo['state'], over: Partial<AgentInfo> = {}): AgentInfo => ({
  paneKey, title, state, agentType: 'claude', summary: null, workingMode: null, coordinator: 'you', leadPane: null, parentPane: null, dispatch: null, terminal: null, question: null, ...over
})
const row = (id: string, repo: string, agents: AgentInfo[], over: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  id, name: id, branch: id, repo, path: `/w/${id}`, main: false, agents, state: agents[0]?.state ?? null, priority: null, card: null, parentId: null,
  liveTerminals: agents.length ? 1 : 0, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: 0, createdAt: 0, pr: null, ...over
})

const asks = (glance: string, priority: 'P1' | 'P2' = 'P1') =>
  summary({ title: glance, priority, glance, about: `About ${glance}.`, needs: { type: 'decision', ask: `${glance} long form`, options: [] } })

const snap: Snapshot = {
  source: 'cli',
  capacity: { verdict: 'agents-only', freeGB: 1.6, marginGB: 2, diskFreeGB: 18, agentGB: 0.5, envGB: 2.6, pressure: 'normal', finishedOpen: 1 },
  coordinators: [{ key: 'alpha', name: 'alpha', repos: ['shop'], workspaceId: 'ws-fv' }, { key: 'main', name: 'main', repos: [], workspaceId: null }],
  rows: [
    row('coord', 'shop', [agent('p-coord', 'Checkout bug', 'working', { coordinator: 'alpha' })], { priority: 'P1' }),
    row('dup', 'shop', [agent('p-dup', 'Duplicate accounts', 'done', { coordinator: 'alpha', leadPane: 'p-coord', summary: asks('Merge accounts by email?') })], { priority: 'P1' }),
    row('hook', 'blog', [agent('p-hook', 'Launch post headline', 'done', { coordinator: 'main', summary: asks('Pick a headline', 'P2') })], { priority: 'P2' }),
    row('pricing', 'shop', [agent('p-pricing', 'Pricing page', 'working')]),
    row('cleanup', 'shop', [agent('p-cleanup', 'State cleanup', 'done', { summary: summary({ since: 'PR #1753 merged' }) })]),
    row('quiet', 'video', [])
  ]
}

test('up next: the first briefing is open with about, the glance and one jump; the rest are one line', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /Up next · 2/)
  const brief = main.slice(main.indexOf('class="brief"'), main.indexOf('</div><button class="item"', main.indexOf('class="brief"')) + 1)
  assert.match(brief, /About Merge accounts by email\?\./)
  assert.match(brief, /Asks · decision/)
  assert.match(brief, /Merge accounts by email\?/)
  assert.equal((brief.match(/data-open=/g) ?? []).length, 1, 'the only action is Jump to session')
  noMatch(main, /⌘⇧N/, 'no keyboard shortcut shown')
  noMatch(main, /data-tip="Pick a headline"/, 'rows have no long tooltips')
})

test('closing the first and opening another follows the person', () => {
  const ui = emptyUi()
  ui.closed.add('p-dup')
  ui.opened.add('p-hook')
  const { main } = render(snap, ui)
  assert.match(main, /About Pick a headline/)
  noMatch(main, /About Merge accounts by email/)
})

test('coordinators: a single-project coordinator is its project; multi-repo groups label projects softly', () => {
  const { main } = render(snap, emptyUi())
  const tree = main.slice(main.indexOf('class="tree"'))
  const first = tree.indexOf('<section class="coordinator">')
  const alpha = tree.slice(first, tree.indexOf('<section class="coordinator">', first + 1))
  assert.match(alpha, /alpha/)
  assert.match(alpha, /class="item indent"/, 'the worker nests under its coordinator')
  noMatch(alpha, /class="soft"/)
  assert.match(tree, /Launch post headline[\s\S]*?<span class="soft">blog<\/span>/)
  assert.match(tree, /chats you started/)
})

test('characters carry state; no status dots', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /class="spin"/, 'working characters carry a spinner badge')
  noMatch(main, /class="dot/, 'no status dots')
  assert.equal(faceOf(agent('x', 'x', 'blocked')), 'asks')
  assert.equal(faceOf(agent('x', 'x', 'done', { summary: summary() })), 'done')
})

test('a finished session stays in its place in the tree, dimmed; only Idle folds in the footer', () => {
  const { main, footer } = render(snap, emptyUi())
  noMatch(footer, /Finished/, 'no Finished section')
  assert.match(main, /<button class="item finished" data-open="cleanup"[^>]*data-menu="agent:p-cleanup"[^>]*>[\s\S]*?data-tip="Done"[\s\S]*?State cleanup/)
  assert.match(footer, /Idle · 1/)
})

test('cockpit flags only what is over and explains on demand; search replaces the lists', () => {
  assert.deepEqual(gaugesOf(snap.capacity!).map((g) => [g.key, g.icon, g.text, g.tone]), [['memory', 'chip', '1.6 GB free', 'warn'], ['disk', 'disk', '18 GB free', 'warn'], ['idle', 'pause', '1', '']])
  const ui = emptyUi()
  assert.match(render(snap, ui).cockpit, /data-tip="Room for agents, not environments" data-tone="warn"/)
  const roomy = { ...snap.capacity!, verdict: 'ok' as const, freeGB: 6.1 }
  assert.deepEqual(gaugesOf(roomy)[0], { key: 'memory', icon: 'chip', text: '6.1 GB free', tone: '', tip: 'Memory, after 2 GB margin' })
  assert.deepEqual(gaugesOf({ ...roomy, diskFreeGB: 212.4 })[1].text, '212 GB free')
  assert.deepEqual(gaugesOf({ ...roomy, freeGB: null, diskFreeGB: null }).map((g) => g.key), ['idle'], 'no number before it is measured')
  for (const g of gaugesOf(snap.capacity!)) assert.ok(g.tip.split(' ').length <= 5, `"${g.tip}" is over five words`)
  ui.query = 'headline'
  const { main } = render(snap, ui)
  assert.match(main, /Launch post headline/)
  noMatch(main, /Up next/)
})

test('old summaries cannot claim an ask, and leaked ids are never shown', () => {
  const old = { ...summary({ needs: { type: 'review', ask: 'Agent is running in term_2cab2e54-96b7. Check it?', options: [] } }) } as AgentSummary
  delete (old as { glance?: string }).glance
  const s2: Snapshot = { ...snap, rows: [row('x', 'shop', [agent('p-x', 'Fix bug', 'done', { summary: old })])] }
  const { main } = render(s2, emptyUi())
  noMatch(main, /Up next/, 'an old-format summary does not put anything in Up next')
  noMatch(main, /term_2cab/)
})

test('blocked always asks; a summary cannot hide Orca\'s waiting', () => {
  const calm = summary({ glance: 'Wait for E2E results', needs: { type: 'none', ask: '', options: [] } })
  const s3: Snapshot = { ...snap, rows: [
    row('w', 'shop', [agent('p-w', 'Live preview', 'waiting', { summary: calm })]),
    row('b', 'shop', [agent('p-b', 'Permission', 'blocked', { summary: calm })])
  ] }
  const { main } = render(s3, emptyUi())
  assert.match(main, /Up next · 2/, 'both count: Orca says both wait on you')
  assert.match(main, /Approve a permission prompt|Answer its question/)
  noMatch(main, /Wait for E2E results/)
})

test('once you answer and the agent works again, it leaves Up next', () => {
  const answered = agent('p-dup', 'Duplicate accounts', 'working', { summary: asks('Merge accounts by email?') })
  const s4: Snapshot = { ...snap, rows: [row('dup', 'shop', [answered])] }
  const { main } = render(s4, emptyUi())
  noMatch(main, /Up next/)
  assert.match(main, /class="spin"/, 'it shows as working in the tree')
})

test('monitoring comes from Orca: its working mode, even while its state says working', () => {
  const watching = agent('p-m', 'Valuation', 'working', { workingMode: 'monitoring' })
  const done = agent('p-d', 'Cleanup', 'done', { summary: summary({ watching: 'E2E run' }) })
  assert.equal(faceOf(watching), 'monitoring')
  assert.equal(faceOf(done), 'done', 'our own summary does not override Orca')
  const s5: Snapshot = { ...snap, rows: [row('m', 'shop', [watching])] }
  const { main } = render(s5, emptyUi())
  assert.match(main, /class="spin slow"/)
  noMatch(main, /Up next/)
})

/** What a person can read in the panel's HTML: its text, and every tooltip. */
const readable = (html: string) =>
  `${html.replace(/<[^>]+>/g, ' ')}\n${[...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1]).join('\n')}`.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
/** The treemap's tiles: their classes, consumer key, tooltip and inner HTML. */
const tilesOf = (html: string) =>
  [...html.matchAll(/<div class="tile ([^"]*)" style="([^"]*)"(?: data-use="([^"]*)")? data-tip="([^"]*)">([\s\S]*?)<\/div>/g)].map((m) => ({ cls: m[1], style: m[2], use: m[3] ?? '', tip: m[4], inner: m[5] }))
/** The legend's pills by consumer key. */
const pillsOf = (html: string) => new Map([...html.matchAll(/<span class="lg ([^"]*)" data-use="([^"]*)" data-tip="([^"]*)">/g)].map((m) => [m[2], { cls: m[1], tip: m[3] }]))

test('the opened cockpit: RAM as a treemap with a legend, agents, and clean up that confirms in place', () => {
  const stats: CockpitStats = {
    swap: { usedGB: 20.1, totalGB: 21 }, ram: { usedGB: 15.1, totalGB: 16 },
    started: [
      { key: '/w/pricing|p-pricing', path: '/w/pricing', paneKey: 'p-pricing', workspaceId: 'pricing', worktreeName: 'pricing', repo: 'shop', name: 'next-server', count: 4, memMB: 1300 },
      { key: '/w/old|p-gone', path: '/w/old', paneKey: 'p-gone', workspaceId: 'old', worktreeName: 'old-feature', repo: 'shop', name: 'vite', count: 1, memMB: 300 }
    ],
    heaviest: [{ paneKey: 'p-pricing', terminal: 'term-pricing', workspaceId: 'pricing', title: 'Pricing page', repo: 'shop', memMB: 1500 }],
    finished: [{ paneKey: 'p-cleanup', terminal: 'term-cleanup', workspaceId: 'cleanup', title: 'State cleanup', repo: 'shop', memMB: 430 }],
    merged: [{ workspaceId: 'cleanup', name: 'state-cleanup', repo: 'shop', pr: 1753 }]
  }
  const ui = emptyUi()
  assert.match(render(snap, ui).cockpit, /aria-expanded="false"/)
  noMatch(render(snap, ui).copen, /class="copen"/)
  ui.cockpitOpen = true
  assert.match(render(snap, ui).copen, /class="copen"><div class="loader" aria-busy="true"[\s\S]*class="hop"[\s\S]*Checking what’s running…/, 'first open shows the hopping crew')
  ui.stats = stats
  ui.statsLoading = true
  assert.match(render(snap, ui).copen, /Memory <span class="refreshing" aria-label="Refreshing">/, 'reopening keeps the last stats with a spinner')
  ui.statsLoading = false
  const open = render(snap, ui).copen
  assert.match(open, /<span class="mused warn" data-tip="RAM: 15\.1 of 16 GB used, 0\.9 GB free"><b>15\.1<\/b> \/ 16 GB used<\/span>/, 'used and total, warning when nearly full')
  assert.match(open, /<span class="chip warn" data-tip="Swap: 20\.1 of 21 GB used"><svg[\s\S]*?<\/svg>Swap 20\.1 \/ 21 GB<\/span>/, 'swap as a gauge chip, warning when nearly full')
  const tiles = tilesOf(open)
  const pricing = tiles.find((t) => t.use === 'pane:p-pricing')!
  assert.equal(pricing.tip, 'Pricing page · 2.7 GB\nSession: 1.5 GB\nnext-server +3: 1.3 GB', 'a session and what it started are one tile; the split on hover')
  assert.match(pricing.cls, /^c[0-2]\b/, 'the heaviest wear a chart color')
  assert.equal(tiles.find((t) => t.use.startsWith('started:'))!.tip, 'vite · 300 MB\nLeft running in old-feature', 'what a sleeping agent left running')
  assert.equal(tiles.find((t) => t.cls.startsWith('rest'))!.tip, 'Everything else · 12.1 GB\nOther apps and sessions')
  assert.match(tiles.find((t) => t.cls === 'free')!.tip, /^0\.9 GB free of 16 GB$/)
  assert.equal((open.match(/data-yes="close:p-pricing"/g) ?? []).length, 1, 'one sleep button per session, on its tile or its pill')
  noMatch(open, /data-yes="close:p-gone"/, 'nothing to sleep for what is left running')
  assert.match(open, /<span class="label">Agents<\/span><div class="tallies"><span class="tally ask"><span class="stack">(<span class="sav">[\s\S]*?<\/span>){2}<\/span><span><b>2<\/b> asking<\/span><\/span><span class="tally">[\s\S]*?<b>2<\/b> working/)
  assert.match(open, /<span class="label">Clean up<\/span><div class="fin"><span class="stack">[\s\S]*?<\/span><span class="fin-n"><b>1<\/b> finished<\/span><button class="act pill" data-act="closeall" data-tip="Sleep 1 finished session to free 430 MB"><svg[\s\S]*?<\/svg>Sleep all · 430 MB<\/button><\/div>/, 'memory is tight here (agents-only)')
  assert.match(open, /<div class="wt" data-tip="state-cleanup\nPR #1753 merged · clean"><span class="prb pr-merged"><svg[\s\S]*?<\/svg><\/span><span class="wt-main"><span class="wt-name">state-cleanup<\/span><span class="wt-sub">#1753 · merged · clean<\/span><\/span><button class="act ibtn danger" data-act="remove:cleanup" data-tip="Remove worktree" aria-label="Remove state-cleanup"><svg/)
  ui.confirming = 'remove:cleanup'
  assert.match(render(snap, ui).copen, /#1753 · merged · clean<\/span><\/span><span class="confirm"><span class="q">Remove\?<\/span> <button class="yes" data-yes="remove:cleanup">Yes<\/button> <button class="no" data-no>No<\/button><\/span><\/div>/, 'removing confirms in place, in the card')
  ui.confirming = null
  ui.pending = 'remove:cleanup'
  assert.match(render(snap, ui).copen, /class="rstatus pending"><span class="refreshing"><\/span>Removing…/, 'the same inline style as row actions')
  ui.pending = null
  ui.notice = { key: 'remove:cleanup', text: 'Removed', ok: true }
  assert.match(render(snap, ui).copen, /class="rstatus ok">Removed/)
  ui.notice = null
  ui.pending = 'close:p-pricing'
  assert.match(render(snap, ui).copen, /class="rstatus pending"><span class="refreshing"><\/span>Sleeping…/, 'sleeping shows where its button was')
})

test('the treemap cockpit keeps every number, on its tiles, its pills or on hover', () => {
  // The numbers in the cockpit as it was: 6 finished sessions, two dev servers under their sessions,
  // two left running by sessions that slept, two merged worktrees.
  const titles = ['BOU-3949 PR 2', 'Require auth for downloading documents', 'Api-node staging secrets rotation', 'Fix flaky test', 'Lint', 'Docs']
  const rows = titles.map((t, i) => row(`ws${i}`, 'mono', [agent(`p${i}`, t, 'done', { terminal: `term-${i}`, summary: summary() })]))
  const s: Snapshot = { ...snap, rows, capacity: { ...snap.capacity!, verdict: 'agents-only' } }
  const ref = (i: number, memMB: number) => ({ paneKey: `p${i}`, terminal: `term-${i}`, workspaceId: `ws${i}`, title: titles[i], repo: 'mono', memMB })
  const group = (paneKey: string, name: string, count: number, memMB: number, worktreeName: string) =>
    ({ key: `/w/${worktreeName}|${paneKey}`, path: `/w/${worktreeName}`, paneKey, workspaceId: worktreeName, worktreeName, repo: 'mono', name, count, memMB })
  const ui = emptyUi()
  ui.cockpitOpen = true
  ui.stats = {
    ram: { usedGB: 29.3, totalGB: 48 }, swap: { usedGB: 13.6, totalGB: 15 },
    started: [group('p0', 'dev-web.cjs', 23, 6451, 'bou-3949'), group('p1', 'node', 6, 1843, 'require-auth'), group('p-gone1', 'node', 26, 6861, 'employee repo'), group('p-gone2', 'node', 24, 6554, 'add document cleanup job')],
    heaviest: [ref(0, 199), ref(1, 457), ref(2, 472)],
    finished: [ref(0, 199), ref(1, 457), ref(2, 472), ref(3, 310), ref(4, 305), ref(5, 305)],
    merged: [{ workspaceId: 'w1', name: 'bou-3949-durable-document-deletion', repo: 'mono', pr: 6125 }, { workspaceId: 'w2', name: 'employee repo', repo: 'mono', pr: 6213 }]
  }
  const open = render(s, ui).copen
  const seen = readable(open)
  for (const shown of [
    'RAM: 29.3 of 48 GB used, 18.7 GB free', 'Swap: 13.6 of 15 GB used', '18.7 GB free of 48 GB', 'Everything else · 7.0 GB',
    'BOU-3949 PR 2 · 6.5 GB\nSession: 199 MB\ndev-web.cjs +22: 6.3 GB', 'Require auth for downloading documents · 2.2 GB\nSession: 457 MB\nnode +5: 1.8 GB',
    'Api-node staging secrets rotation · 472 MB\nSession: 472 MB', 'node +25 · 6.7 GB\nLeft running in employee repo', 'node +23 · 6.4 GB\nLeft running in add document cleanup job',
    ' 6  finished', 'Sleep all · 2.0 GB', 'Sleep 6 finished sessions to free 2.0 GB',
    'PR #6125 merged · clean', '#6125 · merged · clean', 'PR #6213 merged · clean', '#6213 · merged · clean'
  ]) assert.ok(seen.includes(shown), `${JSON.stringify(shown)} is readable`)
  const text = open.replace(/<[^>]+>/g, ' ')
  for (const total of ['29.3', '6.7 GB', '6.5 GB', '6.4 GB', '2.2 GB', '472 MB']) assert.ok(text.includes(total), `${total} is on screen, not only on hover`)
  const tiles = tilesOf(open)
  assert.equal(tiles.length, 7, 'five consumers, everything else, free')
  const pills = pillsOf(open)
  for (const t of tiles.filter((x) => x.use)) {
    const named = / big/.test(t.cls)
    assert.equal(pills.has(t.use), !named, `${t.use}: a tile without room for its name has a pill`)
  }
  for (const pane of ['p0', 'p1', 'p2']) assert.equal((open.match(new RegExp(`data-yes="close:${pane}"`, 'g')) ?? []).length, 1, `${pane} sleeps from one place`)
  assert.equal(tiles.filter((t) => /^c[0-2]\b/.test(t.cls)).length, 3, 'three consumers in color, the rest neutral')
})

test('chart colors stay with their consumer between refreshes', () => {
  const memo = new Map<string, number>()
  const first = colorSlots(['x', 'y', 'z'], memo)
  assert.deepEqual(new Set(first.values()), new Set([0, 1, 2]))
  assert.deepEqual(colorSlots(['z', 'x', 'y'], memo), new Map([['z', first.get('z')], ['x', first.get('x')], ['y', first.get('y')]]), 'a new order repaints nothing')
  const later = colorSlots(['z', 'w', 'x'], memo)
  assert.equal(later.get('w'), first.get('y'), 'a newcomer takes the color that was freed')
  assert.equal(later.get('z'), first.get('z'))
  assert.equal(colorSlots(['y', 'z', 'x'], memo).get('y'), first.get('y'), 'one that comes back gets its color back when it is free')
  // In the panel: the same consumers, heaviest first one time and last the next, keep their tiles' colors.
  const orphan = (i: number, memMB: number) => ({ key: `/w/o${i}|`, path: `/w/o${i}`, paneKey: null, workspaceId: `o${i}`, worktreeName: `o${i}`, repo: 'shop', name: `proc${i}`, count: 1, memMB })
  const ui = emptyUi()
  ui.cockpitOpen = true
  const colorsAt = (sizes: number[]) => {
    ui.stats = { ram: { usedGB: 12, totalGB: 16 }, swap: null, heaviest: [], finished: [], merged: [], started: sizes.map((mb, i) => orphan(i, mb)) }
    return new Map(tilesOf(render(snap, ui).copen).filter((t) => t.use).map((t) => [t.use, t.cls.split(' ')[0]]))
  }
  const before = colorsAt([3000, 2000, 1000])
  const after = colorsAt([1000, 2000, 3000])
  assert.deepEqual(after, before)
})

test('the treemap never draws more than is used, folds a seventh consumer into other, and copes without figures', () => {
  const g = (i: number, memMB: number) => ({ key: `/w/x${i}|`, path: `/w/x${i}`, paneKey: null, workspaceId: `x${i}`, worktreeName: `x${i}`, repo: 'shop', name: `proc${i}`, count: 1, memMB })
  const ui = emptyUi()
  ui.cockpitOpen = true
  // Footprints can include swapped memory, so together they can exceed what RAM reports as used.
  ui.stats = { ram: { usedGB: 4, totalGB: 16 }, swap: null, heaviest: [], finished: [], merged: [], started: [1, 2, 3, 4, 5, 6, 7].map((i) => g(i, 1024)) }
  let open = render(snap, ui).copen
  const tiles = tilesOf(open)
  assert.equal(tiles.filter((t) => t.use).length, 6, 'six consumers get tiles')
  noMatch(open, /class="tile rest/, 'nothing else is left of the 4 GB used')
  assert.match(tiles.find((t) => t.cls === 'free')!.style, /^left:calc\(25% \+ 1px\);top:calc\(0% \+ 1px\);width:calc\(75% - 2px\)/, 'free starts where used ends')
  assert.match(open, /data-use="started:\/w\/x7\|" data-tip="proc7 · 1\.0 GB[^"]*"><i class="key"><\/i><span class="lg-n">proc7 · x7<\/span><span class="lg-v">1\.0 GB<\/span>/, 'the seventh is a pill with its size')
  noMatch(open, /class="chip/, 'no swap, no swap chip')
  ui.stats = { ...ui.stats, ram: null }
  open = render(snap, ui).copen
  noMatch(open, /class="tm"|class="mhead"/, 'no RAM figures: no headline, no treemap')
  assert.equal((open.match(/<span class="lg-v">1\.0 GB<\/span>/g) ?? []).length, 7, 'every consumer a pill with its size')
  ui.stats = { ...ui.stats, ram: { usedGB: 8, totalGB: 16 }, swap: { usedGB: 1, totalGB: 4 }, started: [] }
  open = render(snap, ui).copen
  assert.deepEqual(tilesOf(open).map((t) => t.cls), ['rest big', 'free'], 'no consumers: everything else and free')
  noMatch(open, /class="legend"/)
  assert.match(open, /<span class="chip" data-tip="Swap: 1 of 4 GB used">/, 'swap with room to spare is a quiet chip')
})

test('sleeping every finished session is offered only when memory is tight, and confirms in place', () => {
  const at = (verdict: 'ok' | 'agents-only' | 'full' | 'pressure'): Snapshot => ({ ...snap, capacity: { ...snap.capacity!, verdict }, rows: [
    row('f1', 'shop', [agent('p-f1', 'First done', 'done', { terminal: 'term-1', summary: summary() })]),
    row('f2', 'shop', [agent('p-f2', 'Second done', 'done', { terminal: 'term-2', summary: summary() })])
  ] })
  const ui = emptyUi()
  ui.cockpitOpen = true
  ui.stats = { swap: null, ram: null, started: [], heaviest: [], merged: [],
    finished: [{ paneKey: 'p-f1', terminal: 'term-1', workspaceId: 'f1', title: 'First done', repo: 'shop', memMB: 400 }, { paneKey: 'p-f2', terminal: 'term-2', workspaceId: 'f2', title: 'Second done', repo: 'shop', memMB: 700 }] }
  noMatch(render(at('ok'), ui).copen, /closeall/, 'room to spare: nothing to sleep in bulk')
  assert.match(render(at('ok'), ui).copen, /<b>2<\/b> finished<\/span><\/div>/)
  for (const v of ['agents-only', 'full', 'pressure'] as const) assert.match(render(at(v), ui).copen, /<b>2<\/b> finished<\/span><button class="act pill" data-act="closeall" data-tip="Sleep 2 finished sessions to free 1\.1 GB"><svg[\s\S]*?<\/svg>Sleep all · 1\.1 GB</, v)
  assert.deepEqual(finishedAgents(at('full').rows).map((a) => a.paneKey), ['p-f1', 'p-f2'], 'the set Sleep all puts to sleep')
  ui.confirming = 'closeall'
  assert.match(render(at('full'), ui).copen, /<span class="q">Sleep 2 sessions\?<\/span> <button class="yes" data-yes="closeall">Yes/)
  ui.confirming = null
  ui.stats = { ...ui.stats, finished: [] }
  assert.match(render(at('full'), ui).copen, /data-act="closeall" data-tip="Sleep 2 finished sessions"><svg[\s\S]*?<\/svg>Sleep all</, 'memory not known yet')
})

test('coordinators show no team characters on the right', () => {
  const { main } = render(snap, emptyUi())
  noMatch(main, /class="r troops"/)
})

test('rows keep the order their workstreams started in, whatever their activity', () => {
  const rows = [
    row('newer', 'shop', [agent('p-n', 'Newer work', 'working')], { createdAt: 200, lastActivityAt: 999 }),
    row('older', 'shop', [agent('p-o', 'Older work', 'working')], { createdAt: 100, lastActivityAt: 1 })
  ]
  const { main } = render({ ...snap, rows }, emptyUi())
  assert.ok(main.indexOf('Older work') < main.indexOf('Newer work'))
})

test('a coordinator row opens its session, folds with its chevron, and New coordinator follows the list', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /data-coordinator="alpha"/)
  assert.match(main, /class="coord-fold" data-fold="alpha"/)
  const withSleeper: Snapshot = { ...snap, coordinators: [...snap.coordinators, { key: 'ops', name: 'ops', repos: [], workspaceId: null }] }
  const sleepy = render(withSleeper, emptyUi()).main
  assert.match(sleepy, /data-coordinator="ops"[\s\S]*?<span class="name">ops<\/span><span class="sub">all projects<\/span>/, 'a sleeping coordinator gets the same full row')
  assert.ok(sleepy.indexOf('data-coordinator="ops"') > sleepy.indexOf('chats you started'), 'sleeping coordinators come after the active groups')
  assert.match(main, /data-new-coordinator>[\s\S]*New coordinator/)
  assert.ok(main.indexOf('data-new-coordinator') > main.lastIndexOf('<section class="coordinator">'))
})

test('new coordinators are offered looks nobody has; rows wear their look', () => {
  const taken = [{ key: 'a', name: 'a', repos: [], workspaceId: null, look: { color: '#5b8def', shape: 'hex' as const } }]
  const free = freeLooks(taken)
  assert.equal(free.length, 29)
  assert.ok(!free.some((l) => l.color === '#5b8def' && l.shape === 'hex'))
  const s6: Snapshot = { ...snap, coordinators: taken, rows: [] }
  assert.match(render(s6, emptyUi()).main, /data-coordinator="a"[^>]*>[\s\S]*?fill="#5b8def"/)
})

test('characters carry a one- or two-word status tooltip', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /data-tip="Asks a question" data-tone="ask">/)
  assert.match(main, /data-tip="Working">/)
  const blocked: Snapshot = { ...snap, rows: [row('b', 'shop', [agent('p-b', 'Permission', 'blocked')])] }
  assert.match(render(blocked, emptyUi()).main, /data-tip="Needs a yes\/no" data-tone="warn"/)
  for (const tip of main.match(/data-tip="[^"]*"/g) ?? []) assert.ok(tip.split(' ').length <= 4, `${tip} is too long`)
})

test('every finished session keeps its menu (sleep, remove), even before its terminal is known', () => {
  const fresh: Snapshot = { ...snap, rows: [row('f', 'shop', [agent('p-new', 'Just finished', 'done', { terminal: null, summary: summary() })])] }
  assert.match(render(fresh, emptyUi()).main, /class="item finished" data-open="f" data-menu="agent:p-new"[^>]*>[\s\S]*?Just finished/)
})

test('characters with nothing reaching outside the body are drawn centered', () => {
  assert.match(character('#4fbfc8', 'hex', 'done', 56, false), /viewBox="0 0 56 56"/)
  noMatch(character('#4fbfc8', 'hex', 'asks', 56, false), /viewBox="0 0 56 56"/, 'the raised hand needs room')
  assert.ok(!/viewBox="0 0 20 20"/.test(character('#4fbfc8', 'solo', 'working', 20)), 'a badge needs room')
})

test('the tree has a Coordinators section title', () => {
  assert.match(render(snap, emptyUi()).main, /<div class="tree"><div class="label">Coordinators<\/div>/)
})

test('Orca\'s waiting always means waiting on you, and its question shows in Up next', () => {
  const calm = summary({ needs: { type: 'none', ask: '', options: [] } })
  const asking = agent('p-q', 'Orca plugin UI', 'waiting', { summary: calm, question: 'Which agent-row actions do you want in the menu?' })
  assert.equal(faceOf(asking), 'asks', 'a summary saying nothing is needed does not override Orca')
  const { main } = render({ ...snap, rows: [row('q', 'orca-plugin', [asking])] }, emptyUi())
  assert.match(main, /Asks · question[\s\S]*Which agent-row actions do you want in the menu\?/)
  noMatch(main, /Finished/)
})

test('agent and coordinator rows say which context menu they get', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /data-menu="agent:p-dup"/)
  assert.match(main, /data-menu="coordinator:alpha"/)
})

test('a worker that sent worker_done never asks: its "decision for you" is for its lead', () => {
  // firstview's "PR 1778 code-smells sweep" ended its report "Decision for you: ..." after worker_done
  // and showed as "ASKS · DECISION" first in Up next, with a ? on the worker.
  const decision = summary({ role: 'worker', priority: 'P1', glance: 'Send analytics events even without consent?',
    needs: { type: 'decision', ask: 'Send signup_completed for visitors who declined analytics?', options: ['Send both', 'Skip both'] } })
  const lead = agent('p-lead', 'Analytics activation tracking', 'done', { coordinator: 'alpha', dispatch: 'open', summary: summary({ role: 'lead' }) })
  const worker = (dispatch: AgentInfo['dispatch'], state: AgentInfo['state'] = 'done') =>
    agent('p-w', 'PR 1778 code-smells sweep', state, { coordinator: 'alpha', leadPane: 'p-lead', dispatch, summary: decision })
  const at = (w: AgentInfo) => render({ ...snap, rows: [row('at', 'web-app', [lead, w])] }, emptyUi()).main

  assert.notEqual(faceOf(worker('settled')), 'asks', 'a settled dispatch: no ask on its face')
  const main = at(worker('settled'))
  noMatch(main, /Up next/, 'not in Up next')
  noMatch(main, /Send analytics events even without consent\?/)
  noMatch(main, /data-tip="(Asks a question|Wants a review|Needs a yes\/no)"/, 'no ask badge in the tree')
  assert.deepEqual(askingRows({ ...snap, rows: [row('at', 'web-app', [lead, worker('settled')])] }), [], 'nor in the queue jump-to-next and the status bar read')

  assert.equal(faceOf(worker('open')), 'asks', 'an open dispatch still asks: it is waiting in its own chat')
  assert.match(at(worker('open')), /Up next · 1[\s\S]*Send analytics events even without consent\?/)
  assert.equal(faceOf(worker('settled', 'waiting')), 'asks', "Orca's own waiting state still counts")
})

test('Up next lists every asking agent, even several in one workspace', () => {
  const two = row('w', 'orca-plugin', [
    agent('p-a', 'State test: question', 'waiting', { question: 'Which color?' }),
    agent('p-b', 'State test: decision', 'done', { summary: asks('Merge the test branch?') })
  ])
  const { main } = render({ ...snap, rows: [two] }, emptyUi())
  assert.match(main, /Up next · 2/)
  assert.match(main, /data-brief="p-a"[\s\S]*data-brief="p-b"|data-brief="p-b"[\s\S]*data-brief="p-a"/)
})

test('a title that leaks an id falls back to the workspace name', () => {
  const leak = row('main', 'orca-plugin', [agent('p-l', 'worker-task_475ea547ab76', 'working')])
  const { main } = render({ ...snap, rows: [leak] }, emptyUi())
  noMatch(main, /worker-task_475ea547ab76/)
})

test('actions show their progress inline on the row, not in a toast', () => {
  const ui = emptyUi()
  ui.status.set('agent:p-dup', { text: 'Sleeping…', tone: 'pending' })
  ui.status.set('coordinator:alpha', { text: 'Waking…', tone: 'pending' })
  const { main } = render(snap, ui)
  assert.match(main, /data-menu="agent:p-dup"[^>]*>[\s\S]*?class="rstatus pending"><span class="refreshing"><\/span>Sleeping…/)
  assert.match(main, /data-menu="coordinator:alpha"[\s\S]*?class="rstatus pending"><span class="refreshing"><\/span>Waking…/)
  ui.status.set('agent:p-dup', { text: 'PR not merged', tone: 'bad' })
  assert.match(render(snap, ui).main, /class="rstatus bad">PR not merged/)
})

test('a coordinator shows its own state: available while only its workers work', () => {
  const session = agent('p-home', 'Home', 'done')
  const awake: Snapshot = { ...snap, coordinators: [{ ...snap.coordinators[0], session }, snap.coordinators[1]] }
  const head = (s: Snapshot, key: string) => /<button class="coord-open"[^>]*>[\s\S]*?<\/button>/.exec(render(s, emptyUi()).main.split(`data-menu="coordinator:${key}"`)[1])![0]
  assert.match(head(awake, 'alpha'), /data-tip="Available"/)
  assert.match(head(awake, 'main'), /data-tip="Sleeping"/)
  const busy: Snapshot = { ...awake, coordinators: [{ ...snap.coordinators[0], session: { ...session, state: 'working' } }, snap.coordinators[1]] }
  assert.match(head(busy, 'alpha'), /data-tip="Working"/)
})

test('asking shows as a ? badge on the character, not a count on the coordinator row', () => {
  assert.match(character('#fff', 'worker', 'asks', 20), /class="ask-badge"[\s\S]*>\?<\/text>/)
  noMatch(character('#fff', 'worker', 'working', 20), /ask-badge/)
  noMatch(render(snap, emptyUi()).main, /class="asking"/)
})

test('PR indicators match Orca: checks color an open PR, the state colors the rest', () => {
  const pr = (state: string, checks: 'success' | 'pending' | 'failure' | 'cancelled' | null = null) => prBadge({ number: 7, url: 'u', state, checks })
  assert.match(pr('open', 'failure'), /class="pr pr-fail" role="link" data-pr="u" data-tip="PR #7 checks failed"/, 'clicking it opens the PR')
  assert.match(pr('open', 'pending'), /class="pr pr-pending" role="link" data-pr="u" data-tip="PR #7 checks pending"/)
  assert.match(pr('open', 'success'), /class="pr pr-ok" role="link" data-pr="u" data-tip="PR #7 open"/)
  assert.match(pr('open'), /class="pr pr-ok"/, 'no checks yet: open is green')
  assert.match(pr('merged', 'failure'), /class="pr pr-merged" role="link" data-pr="u" data-tip="PR #7 merged"/, 'checks only color an open PR')
  assert.match(pr('closed'), /class="pr pr-closed"/)
  assert.match(pr('draft'), /class="pr pr-draft"/)
  assert.equal(prBadge(null), '')
  const withPr: Snapshot = { ...snap, rows: [row('w', 'shop', [agent('p-w', 'Checkout', 'working')], { pr: { number: 12, url: 'u', state: 'open', checks: 'pending' } })] }
  assert.match(render(withPr, emptyUi()).main, /Checkout<\/span><span class="r">[\s\S]*?class="pr pr-pending"/, 'the row shows its worktree\'s PR')
})

test('a lead whose worker is still working stays in the tree as available, with the worker under it', () => {
  const lead = agent('p-lead', 'Onboarding', 'done', { coordinator: 'alpha' })
  const reviewer = agent('p-rev', 'Review PR', 'working', { coordinator: 'alpha', leadPane: 'p-lead' })
  const s: Snapshot = { ...snap, rows: [row('ob', 'shop', [reviewer, lead])] }
  const { main, footer } = render(s, emptyUi())
  assert.match(main, /data-tip="Available"[\s\S]*?Onboarding[\s\S]*?class="item indent"[\s\S]*?Review PR/, 'the lead heads the tree and its worker nests under it')
  noMatch(footer, /Onboarding/)
  assert.deepEqual(finishedAgents(s.rows).map((a) => a.paneKey), [], 'Sleep all leaves the lead alone')
  const done: Snapshot = { ...snap, rows: [row('ob', 'shop', [{ ...reviewer, state: 'done' }, lead])] }
  assert.deepEqual(finishedAgents(done.rows).map((a) => a.paneKey).sort(), ['p-lead', 'p-rev'], 'once its workers are done, it is finished too')
})

test("a worker nested under its lead shows no project, PR or age; the lead keeps them", () => {
  const lead = agent('p-lead', 'Orca Flow bugs', 'done', { coordinator: 'main' })
  const worker = agent('p-w', 'Fix card ask logic', 'working', { coordinator: 'main', leadPane: 'p-lead' })
  const s: Snapshot = { ...snap, rows: [row('bugs', 'orca-plugin', [lead, worker], { pr: { number: 42, url: 'u', state: 'open', checks: 'success' }, lastActivityAt: 1 })] }
  const { main } = render(s, { ...emptyUi(), now: 3_600_001 })
  const right = (pane: string) => new RegExp(`data-menu="agent:${pane}"[\\s\\S]*?<span class="r">([\\s\\S]*?)</span></button>`).exec(main)![1]
  assert.match(right('p-lead'), /<span class="soft">orca-plugin<\/span><span class="pr pr-ok"[\s\S]*<span>1h<\/span>$/, 'the lead row keeps project, PR and age')
  assert.equal(right('p-w'), '', 'the nested worker row has none of them')
})

test('the owner of an open PR stays in the tree until it merges; its finished workers still finish', () => {
  const pr = (state: string) => ({ number: 1770, url: 'u', state, checks: 'success' as const })
  const lead = agent('p-lead', 'Onboarding', 'done', { coordinator: 'alpha' })
  const reviewer = agent('p-rev', 'Review PR', 'done', { coordinator: 'alpha', leadPane: 'p-lead' })
  const at = (state: string) => ({ ...snap, rows: [row('ob', 'shop', [lead, reviewer], { pr: pr(state) })] }) as Snapshot
  assert.deepEqual(finishedAgents(at('open').rows).map((a) => a.paneKey), ['p-rev'], 'open PR: the lead stays, its done reviewer finishes')
  assert.match(render(at('open'), emptyUi()).main, /data-tip="Available"[\s\S]*?Onboarding/)
  assert.deepEqual(finishedAgents(at('draft').rows).map((a) => a.paneKey), ['p-rev'])
  assert.deepEqual(finishedAgents(at('merged').rows).map((a) => a.paneKey).sort(), ['p-lead', 'p-rev'], 'merged: both finish')
})

test('a lead stays available, never finished, until it reports worker_done', () => {
  const lead = (dispatch: AgentInfo['dispatch']) => agent('p-lead', 'Onboarding', 'done', { coordinator: 'alpha', dispatch, summary: summary({ title: 'Onboarding', role: 'lead', watching: 'CI' }) })
  const at = (dispatch: AgentInfo['dispatch']) => ({ ...snap, rows: [row('ob', 'shop', [lead(dispatch)])] }) as Snapshot
  for (const d of ['open', null] as const) {
    assert.deepEqual(finishedAgents(at(d).rows), [], `dispatch ${d}: Sleep all leaves the lead alone`)
    const { main, footer } = render(at(d), emptyUi())
    assert.match(main, /data-tip="Available"[\s\S]*?Onboarding/, `dispatch ${d}: shown as available in the tree`)
    noMatch(footer, /Onboarding/, `dispatch ${d}: not under Finished`)
  }
  assert.deepEqual(finishedAgents(at('settled').rows).map((a) => a.paneKey), ['p-lead'], 'after worker_done it finishes')
  const worker = agent('p-w', 'Fix', 'done', { dispatch: 'open', summary: summary({ role: 'worker' }) })
  assert.deepEqual(finishedAgents([row('w', 'shop', [worker])]).map((a) => a.paneKey), ['p-w'], 'a worker finishes when its turn ends')
})

test("each agent row, Up next's Jump and Finished rows open that agent's own terminal", () => {
  const lead = agent('p-lead', 'Onboarding', 'waiting', { coordinator: 'alpha', terminal: 'term-lead', summary: asks('Ship it?') })
  const worker = agent('p-w', 'Fix copy', 'working', { coordinator: 'alpha', leadPane: 'p-lead', terminal: 'term-w' })
  const slept = agent('p-old', 'Old task', 'done', { coordinator: 'alpha', leadPane: 'p-lead', terminal: null })
  const done = agent('p-d', 'Done task', 'done', { coordinator: 'alpha', leadPane: 'p-lead', terminal: 'term-d' })
  const s: Snapshot = { ...snap, rows: [row('ob', 'shop', [lead, worker, slept, done])] }
  const { main } = render(s, emptyUi())
  assert.match(main, /class="jump" data-open="ob" data-terminal="term-lead">Jump to session/)
  assert.match(main, /data-open="ob" data-terminal="term-w"[^>]*>[\s\S]*?Fix copy/)
  assert.match(main, /class="item indent finished" data-open="ob" data-terminal="term-d"[^>]*>[\s\S]*?Done task/)
  assert.match(main, /data-open="ob" data-menu="agent:p-old"[^>]*>[\s\S]*?Old task/, 'no terminal: just the workspace')
})

test('an agent with no title is named after its worktree, not its agent type', () => {
  const s: Snapshot = { ...snap, rows: [row('untangle-api', 'shop', [agent('p-u', 'claude', 'working')])] }
  assert.match(render(s, emptyUi()).main, /<span class="t">untangle-api<\/span>/)
})

test('loading states: gauges hold their place while measuring, and failed details say so', () => {
  const measuring = { ...snap.capacity!, measuring: true, freeGB: null, diskFreeGB: null }
  assert.deepEqual(gaugesOf(measuring).map((g) => [g.key, g.loading ?? false]), [['memory', true], ['disk', true], ['idle', false]])
  assert.match(render({ ...snap, capacity: measuring }, emptyUi()).cockpit, /data-tip="Measuring memory"[^>]*>[\s\S]*?<span class="refreshing"><\/span>/)
  const ui = emptyUi()
  ui.cockpitOpen = true
  ui.notice = { key: 'load', text: 'orca diagnostics timed out', ok: false }
  assert.match(render(snap, ui).copen, /Could not check what’s running: orca diagnostics timed out/)
  noMatch(render(snap, ui).copen, /class="loader"/)
})

test('the agent in the workspace focused in Orca, and a focused coordinator, get the current border', () => {
  const s: Snapshot = { ...snap, coordinators: [{ ...snap.coordinators[0], active: true }, snap.coordinators[1]],
    rows: [row('a', 'shop', [agent('p-a', 'Checkout', 'working')], { active: true }), row('b', 'shop', [agent('p-b', 'Search', 'working')])] }
  const { main } = render(s, emptyUi())
  assert.match(main, /class="item current" data-open="a"[^>]*aria-current="true"/)
  noMatch(main, /class="item current" data-open="b"/)
  assert.match(main, /class="item coord current" data-menu="coordinator:alpha"/)
})

test('only the agent whose tab is in front wears the current border, not its lead or the rest of the worktree', () => {
  // A lead and its worker share one worktree; a chat of yours runs in another.
  const lead = agent('p-lead', 'Isola on-demand services', 'done', { terminal: 'term-lead' })
  const worker = agent('p-work', 'pnpm dev:native runs on Metro', 'working', { leadPane: 'p-lead', parentPane: 'p-lead', terminal: 'term-work' })
  const rows = [row('isola', 'mono', [worker, lead], { active: true }), row('other', 'mono', [agent('p-other', 'Other', 'working')])]
  const coordinators = [{ ...snap.coordinators[0], active: false, session: agent('p-alpha', 'alpha', 'working') }]
  const current = (s: Snapshot) => [...render(s, emptyUi()).main.matchAll(/class="item[^"]*current"[^>]*data-menu="(agent|coordinator):([^"]+)"/g)].map((m) => m[2])

  assert.deepEqual(current({ ...snap, rows, coordinators, focusedPanes: ['p-work'] }), ['p-work'], 'the worker in front, not its lead')
  assert.deepEqual(current({ ...snap, rows, coordinators, focusedPanes: ['p-lead'] }), ['p-lead'], 'the lead in front, not its worker')
  assert.deepEqual(current({ ...snap, rows, coordinators, focusedPanes: [] }), [], 'a plain shell or editor in front: none')
  assert.deepEqual(current({ ...snap, rows, coordinators, focusedPanes: ['p-shell'] }), [], 'a shell tab that is no agent: none')
  assert.deepEqual(current({ ...snap, rows, coordinators, focusedPanes: ['p-other'] }), [], 'a pane of a workspace that is not focused: none')
  assert.deepEqual(current({ ...snap, rows, coordinators, focusedPanes: null }), ['p-lead'], 'focus known by workspace only: its lead')
  assert.deepEqual(current({ ...snap, rows, coordinators }), ['p-lead'], 'no focus read yet: its lead')
  assert.match(render({ ...snap, rows, coordinators, focusedPanes: ['p-work'] }, emptyUi()).main, /class="item indent current"[^>]*data-menu="agent:p-work" aria-current="true"/)

  // A coordinator follows the same rule: only its own session's tab in front.
  const focusedCoord = [{ ...coordinators[0], active: true }]
  const idle = rows.map((r) => ({ ...r, active: false }))
  assert.deepEqual(current({ ...snap, rows: idle, coordinators: focusedCoord, focusedPanes: ['p-alpha'] }), ['alpha'])
  assert.deepEqual(current({ ...snap, rows: idle, coordinators: focusedCoord, focusedPanes: ['p-shell'] }), [], 'a shell tab in its folder: none')
  assert.deepEqual(current({ ...snap, rows: idle, coordinators: focusedCoord, focusedPanes: null }), ['alpha'], 'focus known by workspace only: the coordinator')
})

test('only a lead that reported worker_done shows remove on its row; progress shows in the row', () => {
  const lead = (over: Partial<AgentInfo> = {}) => agent('p-ob', 'Onboarding', 'done', { coordinator: 'alpha', terminal: 'term-1', dispatch: 'settled', summary: summary({ role: 'lead' }), ...over })
  const inline = (agents: AgentInfo[], over: Partial<WorkspaceRow> = {}) => /data-remove=/.test(render({ ...snap, rows: [row('ob', 'shop', agents, over)] }, emptyUi()).main)
  const ui = emptyUi()
  const s: Snapshot = { ...snap, rows: [row('ob', 'shop', [lead()])] }
  assert.match(render(s, ui).main, /<div class="item finished" data-menu="agent:p-ob"[^>]*>[\s\S]*?<span class="t" data-open="ob" data-terminal="term-1" role="button" tabindex="0">Onboarding<\/span>[\s\S]*?<button class="act" data-remove="ob" data-target="agent:p-ob">remove<\/button><\/div>/)
  assert.equal(inline([lead({ dispatch: 'open' })]), false, 'not before worker_done')
  assert.equal(inline([lead({ dispatch: null })]), false, 'not without a known dispatch')
  assert.equal(inline([lead({ summary: summary({ role: 'worker' }) })]), false, 'a worker keeps it in the menu')
  assert.equal(inline([lead({ summary: summary({ role: 'solo' }) })]), false, 'your own chat keeps it in the menu')
  assert.equal(inline([lead()], { main: true }), false, 'never the main checkout')
  assert.equal(inline([lead(), agent('p-w', 'Fix', 'working', { coordinator: 'alpha', leadPane: 'p-ob' })]), false, 'not while its worker runs')
  ui.status.set('agent:p-ob', { text: 'Removing…', tone: 'pending' })
  assert.match(render(s, ui).main, /Onboarding<\/span><span class="r"><span class="rstatus pending"><span class="refreshing"><\/span>Removing…/)
})

test('a lead whose PR merged shows remove and finishes, even if it never reported worker_done', () => {
  const pr = (state: string) => ({ number: 6239, url: 'u', state, checks: null })
  const lead = agent('p-ob', 'Draft shifts missing from calendar', 'done', { coordinator: 'alpha', terminal: 'term-1', dispatch: 'open', summary: summary({ role: 'lead' }) })
  const rows = (agents: AgentInfo[], over: Partial<WorkspaceRow> = {}) => [row('ob', 'mono', agents, { pr: pr('merged'), ...over })]
  const inline = (r: WorkspaceRow[]) => /data-remove="ob"/.test(render({ ...snap, rows: r }, emptyUi()).main)
  const finished = (r: WorkspaceRow[]) => finishedAgents(r).map((a) => a.paneKey).sort()

  assert.equal(inline(rows([lead])), true, 'merged, done, nothing open: remove')
  assert.deepEqual(finished(rows([lead])), ['p-ob'], 'and it counts as finished')
  assert.match(render({ ...snap, rows: rows([lead]) }, emptyUi()).main, /<div class="item finished" data-menu="agent:p-ob"/)
  for (const state of ['open', 'draft']) {
    assert.equal(inline(rows([lead], { pr: pr(state) })), false, `${state} PR: no remove`)
    assert.deepEqual(finished(rows([lead], { pr: pr(state) })), [], `${state} PR: the lead stays in flight`)
  }
  const working = agent('p-w', 'Fix', 'working', { coordinator: 'alpha', leadPane: 'p-ob' })
  assert.equal(inline(rows([lead, working])), false, 'not while its worker runs')
  assert.deepEqual(finished(rows([lead, working])), [], 'a lead of open work stays in flight')
  assert.equal(inline(rows([lead], { main: true })), false, 'never the main checkout')
  assert.equal(inline(rows([{ ...lead, state: 'working' }])), false, 'not while the lead itself works')
  assert.equal(inline(rows([{ ...lead, dispatch: 'settled' }], { pr: null })), true, 'the settled path still works without a PR')
  assert.equal(inline(rows([{ ...lead, dispatch: 'settled' }], { pr: pr('open') })), true, 'and with any PR')
})

test("removing a merged lead's worktree gets past the active-agent guard to the checkout checks", async () => {
  const lead = agent('p-ob', 'Draft shifts', 'done', { dispatch: 'open', summary: summary({ role: 'lead' }) })
  const at = (state: string) => row('ob', 'mono', [lead], { path: '/nonexistent/orca-flow-test', pr: { number: 6239, url: 'u', state, checks: null } })
  assert.deepEqual(await removeWorktree(async () => ({}), at('open')), { removed: false, reason: 'an agent is still active' }, 'open PR: the lead holds it')
  assert.deepEqual(await removeWorktree(async () => ({}), at('merged')), { removed: false, reason: 'not a git checkout' }, 'merged: on to the checkout checks')
})

test('a redraw between pointerdown and pointerup waits until the click has run', () => {
  const fired: (() => void)[] = []
  const timers = { set: (fn: () => void) => (fired.push(fn), fired.length), clear: (h: unknown) => { fired[(h as number) - 1] = () => {} } }
  const paints: string[] = []
  let row = 'row-1'
  const gate = pressGate(() => paints.push((row = `row-${paints.length + 2}`)), { timers })
  gate.draw()
  assert.deepEqual(paints, ['row-2'], 'no press: paints at once')
  gate.down()
  const pressedRow = row
  gate.draw() // a snapshot lands mid-press
  gate.draw()
  assert.equal(row, pressedRow, 'the pressed row is still in the page')
  assert.equal(gate.held, true)
  gate.up()
  assert.equal(row, pressedRow, 'still there while the click that follows pointerup runs')
  fired.at(-1)!() // the next tick
  assert.deepEqual(paints, ['row-2', 'row-3'], 'then one paint with the newest data')
  // A press held too long (a drag, a release outside the panel) flushes anyway.
  gate.down()
  gate.draw()
  fired.at(-1)!()
  assert.deepEqual(paints, ['row-2', 'row-3', 'row-4'])
  gate.up()
  assert.equal(fired.length, 3, 'a release after the safety flush schedules nothing')
  gate.draw()
  assert.equal(paints.length, 4, 'and drawing is immediate again')
})

test('an ask wears its kind: an eye for a review, a check on amber for a yes/no, an arrow for an action, ? for a question', () => {
  const needs = (type: 'review' | 'approval' | 'decision' | 'info' | 'action') => summary({ glance: 'Look?', needs: { type, ask: 'Look?', options: [] } })
  const cases: [AgentInfo, string, RegExp, string][] = [
    [agent('p1', 'Checkout', 'done', { summary: needs('review') }), 'review', /class="review-badge"/, 'Wants a review'],
    [agent('p2', 'Checkout', 'done', { summary: needs('approval') }), 'approval', /class="approval-badge"/, 'Needs a yes\/no'],
    [agent('p3', 'Checkout', 'blocked'), 'approval', /class="approval-badge"/, 'Needs a yes\/no'],
    [agent('p4', 'Checkout', 'done', { summary: needs('decision') }), 'question', /class="ask-badge"/, 'Asks a question'],
    [agent('p5', 'Checkout', 'done', { summary: needs('info') }), 'question', /class="ask-badge"/, 'Asks a question'],
    [agent('p6', 'Checkout', 'waiting', { summary: needs('review') }), 'question', /class="ask-badge"/, 'Asks a question'],
    [agent('p7', 'Checkout', 'done', { summary: needs('action') }), 'action', /class="action-badge"/, 'Asks you to do something']
  ]
  for (const [a, kind, badge, tip] of cases) {
    assert.equal(faceOf(a), 'asks', `${a.paneKey} still counts as asking`)
    assert.equal(askKindOf(a), kind, a.paneKey)
    const main = render({ ...snap, rows: [row('w', 'shop', [a])] }, emptyUi()).main
    const line = /<button class="item[^"]*" data-open[\s\S]*?<\/button>/.exec(main)![0]
    assert.match(line, badge, `${a.paneKey} badge`)
    assert.match(line, new RegExp(`data-tip="${tip}"`), `${a.paneKey} tooltip`)
  }
  assert.match(character('#fff', 'solo', 'asks', 20), /class="ask-badge"/, 'a question by default')
})

test('a to-do for the user ("rename the project, tell me when done") is an action, not a question', () => {
  // A coordinator's "Your part: rename the project to katos in Orca's project settings. Tell me
  // when it's done." was shown as "ASKS · INFO — Rename cacasports to katos in Orca?" with a "?".
  const glance = 'Rename the project to katos in Orca settings.'
  const a = agent('p-act', 'Project rename', 'done', { summary: summary({ glance, needs: { type: 'action', ask: glance, options: ['Done'] } }) })
  assert.equal(faceOf(a), 'asks')
  assert.equal(askKindOf(a), 'action')
  const badge = character('#fff', 'solo', 'asks', 20, true, 'action')
  assert.match(badge, /class="action-badge"/)
  noMatch(badge, /ask-badge|>\?<\/text>/, 'not the question badge')
  assert.match(badge, /width="20" height="20"/, 'keeps the usual frame')
  const { main } = render({ ...snap, rows: [row('w', 'shop', [a])] }, emptyUi())
  assert.match(main, /data-tip="Asks you to do something" data-tone="action"[\s\S]*?class="action-badge"/)
  const brief = main.slice(main.indexOf('class="brief"'))
  assert.match(brief, /<span class="kicker">Asks · action<\/span><span>Rename the project to katos in Orca settings\.<\/span>/)
  noMatch(brief, /Asks · (info|question)/)
})

test('the review badge is a larger white eye, and only its frame grows to fit it', () => {
  const review = character('#fff', 'lead', 'asks', 20, true, 'review')
  assert.match(review, /class="review-badge"/)
  assert.match(review, /r="6" class="review-badge"/, '1.2x the usual badge radius of 5')
  assert.match(review, /fill="#fff" stroke="#161618"/, 'the eye is white, outlined')
  assert.match(review, /width="21.94" height="21.94" style="margin:0 -1.94px -1.94px 0" viewBox="-1.6 -3.2 27.2 27.2"/, 'room for the larger badge, laid out as 20 px')
  for (const ask of ['question', 'approval'] as const) {
    assert.match(character('#fff', 'lead', 'asks', 20, true, ask), /width="20" height="20" viewBox="-1.6 -3.2 24.8 24.8"/, `${ask} keeps its frame`)
  }
  assert.match(character('#fff', 'lead', 'asks', 20, false, 'review'), /width="20" height="20"/, 'no badge, no extra room')
})

test("a coordinator's badge is the kind of the ask it shows; a review with a PR offers Open PR", () => {
  const review = summary({ glance: 'Review the PR?', needs: { type: 'review', ask: 'Review the PR?', options: [] } })
  const session = agent('p-home', 'Home', 'done', { summary: review })
  const s: Snapshot = { ...snap, coordinators: [{ ...snap.coordinators[0], session }, snap.coordinators[1]] }
  const tree = render(s, emptyUi()).main.split('<div class="label">Coordinators</div>')[1]
  const head = /<button class="coord-open"[^>]*>[\s\S]*?<\/button>/.exec(tree.split('data-menu="coordinator:alpha"')[1])![0]
  assert.match(head, /data-tip="Wants a review" data-tone="review"[\s\S]*?class="review-badge"/)
  const lead = agent('p-l', 'Checkout', 'done', { summary: review })
  const pr = { number: 7, url: 'https://pr/7', state: 'open', checks: 'success' as const }
  const withPr = render({ ...snap, rows: [row('w', 'shop', [lead], { pr })] }, emptyUi()).main
  assert.match(withPr, /class="jump" data-open="w">Jump to session<\/button><button class="jump" data-pr="https:\/\/pr\/7">Open PR<\/button>/)
  noMatch(render({ ...snap, rows: [row('w', 'shop', [lead])] }, emptyUi()).main, /Open PR/, 'no PR, no button')
  const question = agent('p-q', 'Checkout', 'waiting', { question: 'Which one?' })
  noMatch(render({ ...snap, rows: [row('w', 'shop', [question], { pr })] }, emptyUi()).main, /Open PR/, 'a question is answered in the session')
})

test('every asking face in the tree has an Up next entry, a coordinator asking you included', () => {
  const ask = summary({ glance: 'Unblock the worktree?', role: 'coordinator', priority: 'P1', needs: { type: 'decision', ask: 'Unblock the worktree?', options: [] } })
  const session = agent('p-home', 'Bounti coordination', 'done', { summary: ask, terminal: 'term-home' })
  const s: Snapshot = { ...snap, coordinators: [{ ...snap.coordinators[0], session }, snap.coordinators[1]] }
  const { main } = render(s, emptyUi())
  const [upnext, tree] = main.split('<div class="label">Coordinators</div>')
  const askingInTree = (tree.match(/data-tip="(Asks a question|Wants a review|Needs a yes\/no)"/g) ?? []).length
  const entries = (upnext.match(/data-brief=/g) ?? []).length
  assert.equal(askingInTree, 3, 'two agents and the coordinator ask')
  assert.equal(entries, askingInTree, 'Up next lists each of them')
  assert.match(upnext, /data-menu="coordinator:alpha"[^>]*>[\s\S]*?<span class="t[^"]*">alpha<\/span><span class="r">coordinator · P1/)
  assert.match(upnext, /Unblock the worktree\?/)
  const ui = emptyUi()
  ui.opened.add('p-home')
  assert.match(render(s, ui).main, /<button class="jump" data-coordinator="alpha">Jump to session<\/button>/, 'opens it the way its row does')
})

test('update button: hidden with nothing to update, then what the update needs or how it went', () => {
  assert.equal(updateButton(undefined), '', 'an older worker sends no update state')
  assert.equal(updateButton({ kind: 'none' }), '')

  const available = updateButton({ kind: 'available', version: '0.2.16' })
  assert.match(available, /^<button class="icon update available" data-update="available" data-tip="Update Orca Flow to 0\.2\.16" data-tone="ask"/)
  assert.match(available, /<svg[\s\S]*<\/svg><span class="dot"><\/span>/, 'a download arrow with an accent dot')
  assert.equal(updateButton({ kind: 'confirm', version: '0.2.16' }), available, "the status bar's pending second click still reads as available here")

  const updating = updateButton({ kind: 'updating', version: '0.2.16' })
  assert.match(updating, /data-update="updating" data-tip="Updating Orca Flow to 0\.2\.16…"/)
  assert.match(updating, /<span class="refreshing"><\/span>/, 'the panel\'s own spinner')

  assert.match(updateButton({ kind: 'updated', version: '0.2.16' }), /class="icon update updated"[^>]*data-tip="Orca Flow updated to 0\.2\.16"/)

  const approval = updateButton({ kind: 'approval', version: '0.2.16', reason: 'It asks for a new command.', command: 'orca plugin update cyucelen.flow --approve ap1-xyz' })
  assert.match(approval, /data-tip="Orca Flow 0\.2\.16 needs your approval: It asks for a new command\.\nTo approve and update, run:\norca plugin update cyucelen\.flow --approve ap1-xyz" data-tone="warn"/)

  const failed = updateButton({ kind: 'failed', version: '0.2.16', reason: 'Could not read <github.com>' })
  assert.match(failed, /data-tip="Update to 0\.2\.16 failed: Could not read &lt;github\.com&gt;\nClick to try again" data-tone="danger"/, 'the reason, escaped, and a retry')
  assert.match(failed, /class="icon update failed"/)
})
