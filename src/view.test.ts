// The panel's HTML from a snapshot, checked in Node.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import type { AgentInfo, AgentSummary, LinearData, LinearIssue, Snapshot, WorkspaceRow } from './protocol.ts'
import { type UiState, coordinatorOrder, LINEAR_ROWS, askingRows, askKindOf, BRANCH_COLORS, nodeOf, branchChip, branchColor, branchName, character, laneColor, chatDigit, chatTargets, colorSlots, emptyUi, faceOf, fitLabel, textWidth, finishedAgents, freeLooks, gaugesOf, prBadge, render, updateButton } from './view.ts'
import type { CockpitStats } from './protocol.ts'
import { pressGate } from './panel/press.ts'
import { capGlyph } from './lines.ts'
import { DEFAULT_DISPLAY } from './linear.ts'
import { removeWorktree } from './cockpit.ts'

const noMatch = (text: string, re: RegExp, message?: string) => assert.ok(!re.test(text), message ?? `unexpected ${re}`)
/** The tree and, pinned under it, what asks you (Up next), in the order the page shows them. */
const page = (s: Snapshot, ui: UiState) => { const r = render(s, ui); return r.main + r.attention }

const summary = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  title: 'Work', about: 'What this is for.', glance: '', goal: '', since: 'Did a thing',
  needs: { type: 'none', ask: '', options: [] }, effort: 'quick', priority: 'P2', role: 'solo', updatedAt: 1, ...over
})
const agent = (paneKey: string, title: string, state: AgentInfo['state'], over: Partial<AgentInfo> = {}): AgentInfo => ({
  paneKey, title, state, agentType: 'claude', summary: null, workingMode: null, coordinator: 'you', leadPane: null, parentPane: null, orcaSession: null, dispatch: null, terminal: null, question: null, ...over
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
  const main = page(snap, emptyUi())
  assert.match(main, /Up next · 2/)
  const brief = main.slice(main.indexOf('class="brief"'), main.indexOf('</div><button class="item"', main.indexOf('class="brief"')) + 1)
  assert.match(brief, /About Merge accounts by email\?\./)
  assert.match(brief, /Asks · decision/)
  assert.match(brief, /Merge accounts by email\?/)
  assert.equal((brief.match(/data-open=/g) ?? []).length, 1, 'the only action is Jump to session')
  noMatch(main, /⌘⇧N/, 'no keyboard shortcut shown')
  noMatch(main, /data-tip="Pick a headline"/, 'rows have no long tooltips')
})

test('Up next is pinned under the tree, so the tree never moves when an ask comes or goes', () => {
  const asking = render(snap, emptyUi())
  assert.match(asking.main, /^<div class="tree"><div class="label">Coordinators<\/div>/, 'the scrolling part starts with the tree')
  noMatch(asking.main, /Up next|class="upnext"|data-brief=/, 'nothing from Up next above or inside it')
  assert.match(asking.attention, /^<section class="upnext"><div class="label">Up next · 2<\/div>/)
  const html = readFileSync(new URL('./panel/index.html', import.meta.url).pathname, 'utf8')
  const at = (id: string) => html.indexOf(`id="${id}"`)
  assert.ok(at('main') > 0 && at('main') < at('attention') && at('attention') < at('footer'), 'the page: tree, then Up next, then the footer')
  // With no asks the tree starts the same way, and Up next is empty (the page hides its slot).
  const calm: Snapshot = { ...snap, rows: snap.rows.map((r) => ({ ...r, agents: r.agents.map((a) => ({ ...a, summary: a.summary ? summary() : null })) })) }
  const quiet = render(calm, emptyUi())
  assert.equal(quiet.attention, '')
  assert.match(quiet.main, /^<div class="tree"><div class="label">Coordinators<\/div>/)
  assert.equal(render(snap, { ...emptyUi(), query: 'headline' }).attention, '', 'search shows only what it found')
})

test('closing the first and opening another follows the person', () => {
  const ui = emptyUi()
  ui.closed.add('p-dup')
  ui.opened.add('p-hook')
  const main = page(snap, ui)
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
  assert.match(main, /class="beam b-working"/, 'working characters in the tree carry a shimmer on their ring')
  assert.match(character('#fff', 'worker', 'working', 20), /class="spin"/, 'a character on its own still spins')
  noMatch(character('#fff', 'worker', 'working', 20, true, 'question', false), /class="spin"/, 'unless the tree\'s ring shows it')
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
  const main = page(snap, ui)
  assert.match(main, /Launch post headline/)
  noMatch(main, /Up next/)
})

test('old summaries cannot claim an ask, and leaked ids are never shown', () => {
  const old = { ...summary({ needs: { type: 'review', ask: 'Agent is running in term_2cab2e54-96b7. Check it?', options: [] } }) } as AgentSummary
  delete (old as { glance?: string }).glance
  const s2: Snapshot = { ...snap, rows: [row('x', 'shop', [agent('p-x', 'Fix bug', 'done', { summary: old })])] }
  const main = page(s2, emptyUi())
  noMatch(main, /Up next/, 'an old-format summary does not put anything in Up next')
  noMatch(main, /term_2cab/)
})

test('blocked always asks; a summary cannot hide Orca\'s waiting', () => {
  const calm = summary({ glance: 'Wait for E2E results', needs: { type: 'none', ask: '', options: [] } })
  const s3: Snapshot = { ...snap, rows: [
    row('w', 'shop', [agent('p-w', 'Live preview', 'waiting', { summary: calm })]),
    row('b', 'shop', [agent('p-b', 'Permission', 'blocked', { summary: calm })])
  ] }
  const main = page(s3, emptyUi())
  assert.match(main, /Up next · 2/, 'both count: Orca says both wait on you')
  assert.match(main, /Approve a permission prompt|Answer its question/)
  noMatch(main, /Wait for E2E results/)
})

test('once you answer and the agent works again, it leaves Up next', () => {
  const answered = agent('p-dup', 'Duplicate accounts', 'working', { summary: asks('Merge accounts by email?') })
  const s4: Snapshot = { ...snap, rows: [row('dup', 'shop', [answered])] }
  const main = page(s4, emptyUi())
  noMatch(main, /Up next/)
  assert.match(main, /data-node="working"[\s\S]*?class="beam b-working"/, 'it shows as working in the tree')
})

test('monitoring comes from Orca: its working mode, even while its state says working', () => {
  const watching = agent('p-m', 'Valuation', 'working', { workingMode: 'monitoring' })
  const done = agent('p-d', 'Cleanup', 'done', { summary: summary({ watching: 'E2E run' }) })
  assert.equal(faceOf(watching), 'monitoring')
  assert.equal(faceOf(done), 'done', 'our own summary does not override Orca')
  const s5: Snapshot = { ...snap, rows: [row('m', 'shop', [watching])] }
  const main = page(s5, emptyUi())
  assert.match(main, /class="node n-monitoring"[\s\S]*?class="beam b-monitoring"/)
  noMatch(main, /Up next/)
})

/** What a person can read in the panel's HTML: its text, and every tooltip. */
const readable = (html: string) =>
  `${html.replace(/<[^>]+>/g, ' ')}\n${[...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1]).join('\n')}`.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
/** The treemap's tiles: their classes, consumer key, tooltip and inner HTML. */
const tilesOf = (html: string) =>
  [...html.matchAll(/<div class="tile ([^"]*)" style="([^"]*)"(?: data-use="([^"]*)")? data-tip="([^"]*)">([\s\S]*?)<\/div>/g)].map((m) => ({ cls: m[1], style: m[2], use: m[3] ?? '', tip: m[4], inner: m[5] }))
/** The legend's pills by consumer key. */
const pillsOf = (html: string) => new Map([...html.matchAll(/<span class="lg ([^"]*)" data-use="([^"]*)"( data-in="small")? data-tip="([^"]*)">/g)].map((m) => [m[2], { cls: m[1], tip: m[4], inSliver: Boolean(m[3]) }]))

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
  assert.equal(pillsOf(open).get('started:/w/old|p-gone')!.tip, 'vite · 300 MB\nLeft running in old-feature', 'what a sleeping agent left running')
  assert.equal(tiles.find((t) => t.use === 'small')!.tip, '1 small · 300 MB\nvite · old-feature: 300 MB', 'too small for a label: folded into the sliver')
  assert.equal(tiles.find((t) => t.cls.startsWith('rest'))!.tip, 'Everything else · 12.1 GB\nOther apps and sessions')
  assert.match(tiles.find((t) => t.cls.startsWith('free'))!.tip, /^0\.9 GB free of 16 GB$/)
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
  const pills = pillsOf(open)
  for (const t of tiles.filter((x) => x.use && x.use !== 'small')) {
    assert.match(t.inner, /class="t-v"/, `${t.use}: a consumer's own tile shows its size`)
    if (!/class="t-n"/.test(t.inner)) assert.ok(pills.has(t.use), `${t.use}: a tile without room for its name has a pill`)
  }
  for (const [key, pill] of pills) if (pill.inSliver) assert.ok(tiles.some((t) => t.use === 'small'), `${key} is folded into a sliver that is drawn`)
  for (const pane of ['p0', 'p1', 'p2']) assert.equal((open.match(new RegExp(`data-yes="close:${pane}"`, 'g')) ?? []).length, 1, `${pane} sleeps from one place`)
  assert.ok(tiles.filter((t) => /^c[0-2]\b/.test(t.cls)).length <= 3, 'three consumers in color at most, the rest neutral')
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

test('the treemap never draws more than is used, folds a seventh consumer into the sliver, and copes without figures', () => {
  const g = (i: number, memMB: number) => ({ key: `/w/x${i}|`, path: `/w/x${i}`, paneKey: null, workspaceId: `x${i}`, worktreeName: `x${i}`, repo: 'shop', name: `proc${i}`, count: 1, memMB })
  const ui = emptyUi()
  ui.cockpitOpen = true
  // Footprints can include swapped memory, so together they can exceed what RAM reports as used.
  ui.stats = { ram: { usedGB: 4, totalGB: 16 }, swap: null, heaviest: [], finished: [], merged: [], started: [1, 2, 3].map((i) => g(i, 2048)) }
  let open = render(snap, ui).copen
  noMatch(open, /class="tile rest/, 'nothing else is left of the 4 GB used')
  assert.match(tilesOf(open).find((t) => t.cls.startsWith('free'))!.style, /^left:calc\(25% \+ 1px\);top:calc\(0% \+ 1px\);width:calc\(75% - 2px\)/, 'free starts where used ends')
  noMatch(open, /class="chip/, 'no swap, no swap chip')
  // Six consumers at most get a tile of their own.
  ui.stats = { ...ui.stats, ram: { usedGB: 14, totalGB: 16 }, started: [1, 2, 3, 4, 5, 6, 7].map((i) => g(i, 1536)) }
  open = render(snap, ui).copen
  const tiles = tilesOf(open)
  assert.equal(tiles.filter((t) => t.use.startsWith('started:')).length, 6)
  assert.equal(tiles.find((t) => t.use === 'small')!.tip, '1 small · 1.5 GB\nproc7 · x7: 1.5 GB')
  assert.match(open, /data-use="started:\/w\/x7\|" data-in="small" data-tip="proc7 · 1\.5 GB[^"]*"><i class="key"><\/i><span class="lg-n">proc7 · x7<\/span><span class="lg-v">1\.5 GB<\/span>/, 'the seventh is a pill with its size, lit with the sliver')
  ui.stats = { ...ui.stats, ram: null }
  open = render(snap, ui).copen
  noMatch(open, /class="tm"|class="mhead"/, 'no RAM figures: no headline, no treemap')
  assert.equal((open.match(/<span class="lg-v">1\.5 GB<\/span>/g) ?? []).length, 7, 'every consumer a pill with its size')
  ui.stats = { ...ui.stats, ram: { usedGB: 8, totalGB: 16 }, swap: { usedGB: 1, totalGB: 4 }, started: [] }
  open = render(snap, ui).copen
  assert.deepEqual(tilesOf(open).map((t) => t.cls), ['rest', 'free'], 'no consumers: everything else and free')
  noMatch(open, /class="legend"/)
  assert.match(open, /<span class="chip" data-tip="Swap: 1 of 4 GB used">/, 'swap with room to spare is a quiet chip')
})

test('tile labels: the size is never cut; the name and the character give way first, then the type shrinks', () => {
  // The estimate errs wide of what SF really draws (measured in Chromium on macOS), so a label judged to fit does.
  for (const [text, px, real] of [['12.8 GB', 12, 48.5], ['3.0 GB', 12, 40.5], ['592 MB', 12, 46.1], ['100.0 GB', 12, 56.5], ['3.0 GB', 10.5, 35.7], ['12.8 GB', 10.5, 42.7],
    ['next-server +5 · employee repo', 10.5, 158.1], ['Clock terminal mock for e2e', 10.5, 141.7], ['BOU-3949 PR 2', 10.5, 81.4]] as const) {
    assert.ok(textWidth(text, px) >= real, `${text} at ${px}px: ${textWidth(text, px)} < ${real}`)
  }
  // The live case: a 12.8 GB column 63 px wide keeps its size whole and leaves its long name to the pill.
  const live = fitLabel(63, 70, '12.8 GB', 'next-server +5 · employee repo', true)
  assert.equal(live.value, 'sm', 'one size down, whole')
  assert.equal(live.name, null)
  assert.equal(fitLabel(68, 70, '12.8 GB', 'next-server +5 · employee repo', true).value, 'md', 'a little wider, full size')
  assert.deepEqual(fitLabel(120, 60, '6.5 GB', 'BOU-3949 PR 2', true), { value: 'md', avatar: 'row', name: 'below', room: false }, 'room for all of it')
  assert.equal(fitLabel(120, 80, '6.5 GB', 'BOU-3949 PR 2', true).room, true, 'and for a sleep button above it')
  assert.deepEqual(fitLabel(120, 22, '3.7 GB', '8 small', false), { value: 'sm', avatar: null, name: 'inline', room: false }, 'a short tile puts the name after the size')
  assert.deepEqual(fitLabel(44, 50, '3.0 GB', 'Search index', true), { value: 'xs', avatar: null, name: null, room: false }, 'a narrow tile shrinks the type')
  assert.equal(fitLabel(20, 20, '592 MB', 'Clock', true).value, null, 'a tiny tile shows nothing')
  // Whatever the box, what is shown fits it.
  const SIDE = { md: 6, sm: 4, xs: 3 }, PX = { md: 12, sm: 10.5, xs: 9.5 }
  for (let w = 8; w <= 240; w += 4) for (let h = 8; h <= 136; h += 4) for (const [value, name] of [['12.8 GB', 'next-server +5 · employee repo'], ['592 MB', 'Docs'], ['100.0 GB', 'other']]) {
    const fit = fitLabel(w, h, value, name, true)
    if (!fit.value) continue
    const cw = w - 2 - 2 * SIDE[fit.value]
    assert.ok(textWidth(value, PX[fit.value]) + (fit.avatar === 'row' ? 20 : 0) <= cw, `${value} in ${w}×${h}`)
    if (fit.name === 'below') assert.ok(textWidth(name, 10.5) <= cw || textWidth(`${name.slice(0, 12)}…`, 10.5) <= cw, `${name} in ${w}×${h}`)
    if (fit.name === 'inline') assert.ok(textWidth(value, PX[fit.value]) + textWidth(` · ${name}`, 10.5) <= cw, `${value} · ${name} in ${w}×${h}`)
  }
})

test('in the treemap no label is wider than its tile, whatever the data', () => {
  const session = (i: number, title: string, mb: number) => ({ paneKey: `p${i}`, terminal: `t${i}`, workspaceId: `w${i}`, title, repo: 'mono', memMB: mb })
  const left = (i: number, name: string, count: number, mb: number, worktreeName: string) => ({ key: `/o/${i}|`, path: `/o/${i}`, paneKey: null, workspaceId: `o${i}`, worktreeName, repo: 'mono', name, count, memMB: mb })
  const shapes: [string, CockpitStats][] = [
    ['one dominant, several small', { ram: { usedGB: 23.5, totalGB: 48 }, swap: { usedGB: 22.2, totalGB: 23 }, finished: [], merged: [],
      heaviest: [session(0, 'Clock terminal mock for e2e', 592), session(1, 'Shared store terminal state', 537), session(2, 'Orca-flow repository review', 461)],
      started: [left(0, 'next-server', 6, 13107, 'employee repo'), left(1, 'idb_companion', 2, 20, 'ios-sim')] }],
    ['many small', { ram: { usedGB: 20, totalGB: 48 }, swap: null, finished: [], merged: [], started: [],
      heaviest: [880, 640, 520, 470, 410, 350].map((mb, i) => session(i, `Task number ${i}`, mb)) }],
    ['five even', { ram: { usedGB: 30, totalGB: 48 }, swap: null, finished: [], merged: [], heaviest: [],
      started: [0, 1, 2, 3, 4].map((i) => left(i, 'next-server', 3, 3072, `feature-${i}`)) }],
    ['no free', { ram: { usedGB: 48, totalGB: 48 }, swap: null, finished: [], merged: [], heaviest: [],
      started: [10240, 8192, 6144, 2048, 1024].map((mb, i) => left(i, 'node', 2, mb, `wt-${i}`)) }]
  ]
  const ui = emptyUi()
  ui.cockpitOpen = true
  const SIDE: Record<string, number> = { '': 6, 'fit-sm': 4, 'fit-xs': 3 }, PX: Record<string, number> = { '': 12, 'fit-sm': 10.5, 'fit-xs': 9.5 }
  const folds: Record<string, number> = {}
  for (const [name, stats] of shapes) {
    ui.stats = stats
    const open = render({ ...snap, rows: [] }, ui).copen
    for (const t of tilesOf(open)) {
      // The narrowest panel draws the treemap 236 px wide; a tile's width is its share less the 2 px gap.
      const [, wp, hp] = /width:calc\(([\d.]+)% - 2px\);height:calc\(([\d.]+)% - 2px\)/.exec(t.style)!.map(Number)
      const w = (wp * 236) / 100, h = (hp * 136) / 100
      const kind = /fit-(sm|xs)/.exec(t.cls)?.[0] ?? ''
      const value = /class="t-v">([^<]*)</.exec(t.inner)?.[1]
      if (t.use && t.use !== 'small') assert.ok(value, `${name}: ${t.use} shows its size`)
      if (!value) continue
      assert.ok(textWidth(value, PX[kind]) <= w - 2 - 2 * SIDE[kind], `${name}: ${value} fits ${w.toFixed(1)} px`)
      assert.ok(h - 2 >= (kind ? 13 : 16), `${name}: ${value} fits ${h.toFixed(1)} px high`)
    }
    folds[name] = (open.match(/data-in="small"/g) ?? []).length
  }
  assert.deepEqual(folds, { 'one dominant, several small': 4, 'many small': 6, 'five even': 0, 'no free': 2 }, 'only consumers too small for a label fold')
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
  const main = page({ ...snap, rows: [row('q', 'orca-plugin', [asking])] }, emptyUi())
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
  const at = (w: AgentInfo) => page({ ...snap, rows: [row('at', 'web-app', [lead, w])] }, emptyUi())

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
  const main = page({ ...snap, rows: [two] }, emptyUi())
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

test('the PR shows as its number in the state\'s color; the tooltip adds the state and the title', () => {
  const chip = prBadge({ number: 6080, url: 'https://github.com/o/r/pull/6080', state: 'open', title: 'Private PDF storage', checks: 'pending' })
  assert.equal(chip, '<span class="pr pr-pending" role="link" data-pr="https://github.com/o/r/pull/6080" data-tip="PR #6080 checks pending\nPrivate PDF storage" aria-label="PR #6080 checks pending">#6080</span>')
  assert.match(prBadge({ number: 7, url: 'u', state: 'merged', title: 'a <b> & "c"', checks: null }), /data-tip="PR #7 merged\na &lt;b&gt; &amp; &quot;c&quot;"/, 'the title is escaped')
  assert.match(prBadge({ number: 7, url: 'u', state: 'draft', checks: null }), /data-tip="PR #7 draft"/, 'no title, no second line')
})

test('a branch shows without its user/ prefix; its color is stable per repo and branch', () => {
  assert.equal(branchName('berkantay/bou-4186-clock-terminal'), 'bou-4186-clock-terminal')
  assert.equal(branchName('pr-on-rows'), 'pr-on-rows', 'no prefix: unchanged')
  assert.equal(branchName('team/feat/x'), 'feat/x', 'only the first segment goes')
  const c = branchColor('mono', 'berkantay/bou-4186-clock-terminal')
  assert.ok(Number.isInteger(c) && c >= 0 && c < BRANCH_COLORS)
  assert.equal(branchColor('mono', 'berkantay/bou-4186-clock-terminal'), c, 'the same branch, the same color, every time')
  const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((b) => branchColor('mono', `feat-${b}`)))
  assert.equal(spread.size, BRANCH_COLORS, 'branches spread over the whole palette')
  assert.equal(branchChip({ repo: 'mono', branch: null, pr: null }), '', 'no branch: nothing')
  const chip = branchChip({ repo: 'mono', branch: 'berkantay/bou-4186-clock-terminal', pr: null })
  assert.match(chip, /^<span class="br"><span class="br-b" data-tip="berkantay\/bou-4186-clock-terminal · mono"><svg class="gh" viewBox="0 0 16 16"[\s\S]*<\/svg><span class="br-n">bou-4186-clock-terminal<\/span><\/span><\/span>$/, 'the GitHub mark, the short branch, the whole one on hover')
  noMatch(chip, /class="pr /, 'no PR: no number')
  assert.match(branchChip({ repo: 'mono', branch: 'dev', pr: null }), /^<span class="br quiet">/, 'a long-lived branch shows quieter')
  noMatch(chip, /style=|data-branch|--br/, 'the mark and the branch are never painted in the branch color')
  assert.equal(laneColor({ repo: 'mono', branch: 'berkantay/bou-4186-clock-terminal' }), c, 'its tree lines wear its color')
  assert.equal(laneColor({ repo: 'mono', branch: 'dev' }), null, 'a long-lived branch draws neutral lines')
  assert.equal(laneColor({ repo: 'mono', branch: null }), null, 'no branch: neutral lines')
  assert.match(branchChip({ repo: 'shop', branch: 'me/x', pr: { number: 9, url: 'u', state: 'open', checks: 'success' } }), /<span class="br-n">x<\/span><\/span><span class="pr pr-ok" role="link" data-pr="u"[^>]*>#9<\/span><\/span>$/, 'with a PR, its number follows the branch')
})

test('each chat shows its worktree\'s branch, colored per branch, with the PR number when there is one', () => {
  const pr = (number: number, state: string, checks: 'success' | 'pending' | null = null) => ({ number, url: `https://github.com/o/r/pull/${number}`, state, title: `PR ${number}`, checks })
  const lead = agent('p-lead', 'Clock terminal', 'working', { coordinator: 'alpha', summary: summary({ role: 'lead' }) })
  const same = agent('p-same', 'Write tests', 'working', { coordinator: 'alpha', leadPane: 'p-lead' })
  const own = agent('p-own', 'Split migration', 'working', { coordinator: 'alpha', leadPane: 'p-lead' })
  const twin = agent('p-twin', 'Second chat on the clock branch', 'working', { coordinator: 'alpha' })
  const bare = agent('p-bare', 'Spike', 'working', { coordinator: 'alpha' })
  const gone = agent('p-gone', 'Document cleanup', 'done', { coordinator: 'alpha', dispatch: 'settled', summary: summary({ role: 'lead' }) })
  const s: Snapshot = { ...snap, rows: [
    row('clock', 'shop', [lead, same], { branch: 'berkantay/clock', pr: pr(6241, 'open', 'success'), createdAt: 1, lastActivityAt: 1 }),
    row('split', 'shop', [own], { branch: 'berkantay/split', pr: pr(6250, 'draft'), createdAt: 2 }),
    row('clock2', 'shop', [twin], { branch: 'berkantay/clock', createdAt: 3 }),
    row('spike', 'shop', [bare], { branch: null, createdAt: 4, lastActivityAt: 1 }),
    row('cleanup', 'shop', [gone], { branch: 'cleanup', pr: pr(6113, 'merged'), createdAt: 5, lastActivityAt: 1 })
  ] }
  const { main } = render(s, { ...emptyUi(), now: 3_600_001 })
  const line = (pane: string) => new RegExp(`<(button|div) class="item[^"]*"[^>]*data-menu="agent:${pane}"[\\s\\S]*?</\\1>`).exec(main)![0]
  const color = (pane: string) => /^<[^>]*data-branch="(\d)"/.exec(line(pane))?.[1] ?? null
  const branch = (pane: string) => /class="br-n">([^<]*)</.exec(line(pane))?.[1] ?? null
  const prs = (pane: string) => [...line(pane).matchAll(/class="pr [^"]*"[^>]*>#(\d+)</g)].map((m) => Number(m[1]))
  const clock = String(branchColor('shop', 'berkantay/clock'))
  assert.equal(branch('p-lead'), 'clock', 'the lead shows its branch, user/ prefix stripped')
  assert.deepEqual(prs('p-lead'), [6241], 'and its PR\'s number')
  assert.equal(color('p-lead'), clock, 'in its branch\'s color')
  assert.match(line('p-lead'), /Clock terminal<\/span><span class="r"><span class="br">[\s\S]*?#6241<\/span><\/span><span class="age">1h<\/span><\/span><\/button>$/, 'branch, then age, last on the row')
  assert.equal(branch('p-same'), null, 'a worker in its lead\'s worktree does not repeat the branch')
  assert.deepEqual(prs('p-same'), [])
  assert.equal(color('p-same'), clock, 'but wears its color, so it groups with its lead')
  assert.match(line('p-same'), /^<button class="item indent"/)
  assert.equal(branch('p-own'), 'split', 'a worker in a worktree of its own shows that worktree\'s branch')
  assert.deepEqual(prs('p-own'), [6250])
  assert.equal(color('p-twin'), clock, 'another worktree on the same branch: the same color')
  assert.equal(color('p-own'), String(branchColor('shop', 'berkantay/split')))
  assert.deepEqual(prs('p-twin'), [], 'no PR: no number')
  assert.equal(branch('p-bare'), null, 'no branch: nothing')
  assert.equal(color('p-bare'), null)
  noMatch(line('p-bare'), /class="(br|pr)[ "]|data-branch|class="gh"/)
  assert.deepEqual(prs('p-gone'), [6113], 'a finished lead shows its merged PR')
  assert.match(line('p-gone'), /class="pr pr-merged"[\s\S]*<button class="act" data-remove="cleanup"[^>]*>remove<\/button><\/div>$/, 'next to its remove button, last on the row')
  const current: Snapshot = { ...s, rows: s.rows.map((r) => (r.id === 'clock' ? { ...r, active: true } : r)) }
  assert.match(render(current, emptyUi()).main, /class="item current"[^>]*data-menu="agent:p-lead" aria-current="true" data-branch="\d"[\s\S]*?#6241</, 'the current row keeps its border and its branch')
})

test('a lead and its workers form one lane of tree lines, in the lead\'s branch color', () => {
  const lead = agent('p-lead', 'Clock terminal', 'working', { coordinator: 'alpha', summary: summary({ role: 'lead' }) })
  const same = agent('p-same', 'Write tests', 'working', { coordinator: 'alpha', leadPane: 'p-lead' })
  const own = agent('p-own', 'Split migration', 'working', { coordinator: 'alpha', leadPane: 'p-lead' })
  const dev = agent('p-dev', 'Presence verification', 'working', { coordinator: 'alpha' })
  const bare = agent('p-bare', 'Spike', 'working', { coordinator: 'alpha' })
  const s: Snapshot = { ...snap, rows: [
    row('clock', 'shop', [lead, same], { branch: 'berkantay/clock', createdAt: 1 }),
    row('split', 'shop', [own], { branch: 'berkantay/split', createdAt: 2 }),
    row('dev', 'shop', [dev], { branch: 'dev', main: true, createdAt: 3 }),
    row('spike', 'shop', [bare], { branch: null, createdAt: 4 })
  ] }
  const { main } = render(s, emptyUi())
  const group = /<section class="coordinator"><div class="item coord"[^>]*data-menu="coordinator:alpha"[\s\S]*?<div class="group">([\s\S]*?)<\/div><\/section>/.exec(main)![1]
  const lanes = [...group.matchAll(/<div class="lane"( data-branch="(\d)")?>([\s\S]*?)<\/div>(?=<div class="lane"|$)/g)].map((m) => ({ color: m[2] ?? null, panes: [...m[3].matchAll(/data-menu="agent:([^"]+)"/g)].map((x) => x[1]) }))
  assert.deepEqual(lanes, [
    { color: String(branchColor('shop', 'berkantay/clock')), panes: ['p-lead', 'p-same', 'p-own'] },
    { color: null, panes: ['p-dev'] },
    { color: null, panes: ['p-bare'] }
  ], 'one lane per lead with its workers, colored by the lead\'s branch; dev and no branch stay neutral')
  assert.equal([...group.matchAll(/<i class="tl" aria-hidden="true"><\/i>/g)].length, 5, 'every row carries its line')
  const folded = render(s, { ...emptyUi(), folded: new Set(['alpha']) }).main
  noMatch(/<section class="coordinator"><div class="item coord"[^>]*data-menu="coordinator:alpha"[\s\S]*?<\/section>/.exec(folded)![0], /class="lane"/, 'a folded team draws no lines')
})

test('a chat\'s node says its state: asking, working, done while in flight, finished', () => {
  const at = (a: AgentInfo, rows: WorkspaceRow[]) => nodeOf(a, rows.find((r) => r.agents.includes(a))!, rows.flatMap((r) => r.agents))
  const ask = agent('p-a', 'Ask', 'waiting')
  const work = agent('p-w', 'Work', 'working')
  const watch = agent('p-m', 'Watch', 'working', { workingMode: 'monitoring' })
  const lead = agent('p-l', 'Lead', 'done', { summary: summary({ role: 'lead' }) })
  const worker = agent('p-k', 'Worker', 'working', { leadPane: 'p-l' })
  const solo = agent('p-s', 'Solo', 'done')
  const rows = [row('a', 'shop', [ask]), row('w', 'shop', [work, watch]), row('l', 'shop', [lead, worker]), row('s', 'shop', [solo])]
  assert.equal(at(ask, rows), 'asking')
  assert.equal(at(work, rows), 'working')
  assert.equal(at(watch, rows), 'monitoring')
  assert.equal(at(lead, rows), 'done', 'a lead whose worker still works is done, not finished')
  assert.equal(at(solo, rows), 'finished')
  const openPr = [row('s', 'shop', [solo], { pr: { number: 1, url: 'u', state: 'open', checks: null } })]
  assert.equal(at(solo, openPr), 'done', 'the owner of an open PR is still in flight')
})

test('Graph: each chat is a ring with one connector; the lead\'s PR is a bead on its ring', () => {
  const lead = agent('p-lead', 'Clock terminal', 'done', { coordinator: 'alpha', summary: summary({ role: 'lead' }) })
  const work = agent('p-a-work', 'Kiosk', 'working', { coordinator: 'alpha', leadPane: 'p-lead' })
  const asks = agent('p-b-ask', 'Schema', 'waiting', { coordinator: 'alpha', leadPane: 'p-lead' })
  const fin = agent('p-c-fin', 'API', 'done', { coordinator: 'alpha', leadPane: 'p-lead' })
  const s: Snapshot = { ...snap, rows: [row('clock', 'shop', [lead, work, asks, fin], { branch: 'me/clock', pr: { number: 6241, url: 'u', state: 'merged', checks: 'success' } })] }
  const m = render(s, emptyUi()).main, graph = m.slice(m.indexOf('class="tree"'))
  const rowOf = (html: string, pane: string) => new RegExp(`<(button|div) class="item[^"]*"[^>]*data-menu="agent:${pane}"[\\s\\S]*?</\\1>`).exec(html)![0]
  assert.match(rowOf(graph, 'p-lead'), /data-node="done"[\s\S]*<svg class="tl-c"[^>]*><path class="fork"[^>]*\/><circle class="node n-done"/, 'a connector into a ring around the character')
  assert.match(rowOf(graph, 'p-a-work'), /class="node n-working"/)
  assert.match(rowOf(graph, 'p-b-ask'), /class="node n-asking k-question"/, 'asking wears its ask\'s color')
  for (const pane of ['p-lead', 'p-a-work', 'p-b-ask', 'p-c-fin']) assert.equal([...rowOf(graph, pane).matchAll(/<path class="fork/g)].length, 1, `${pane}: exactly one connector`)
  noMatch(graph, /merge"/, 'no second, merging connector')
  assert.match(rowOf(graph, 'p-c-fin'), /data-node="finished"/, 'a finished one dims its one connector (panel.css)')
  assert.match(rowOf(graph, 'p-lead'), /<circle class="node n-done"[^>]*\/><g class="tl-cap" transform="translate\([\d.]+ [\d.]+\)"><circle class="cap c-merged"/, 'the lead\'s PR is a bead on its ring')
  assert.equal([...graph.matchAll(/class="tl-cap"/g)].length, 1, 'once, nothing trails past the last child')
  assert.match(graph, /<svg class="tl-h"[^>]*><circle class="node n-sleeping"/, 'a sleeping coordinator\'s ring is dashed')
  assert.equal([...graph.matchAll(/<i class="tl" aria-hidden="true"><\/i>/g)].length, 4, 'every row carries its runs')
})

test('a working ring carries a travelling shimmer instead of the character\'s spinning badge', () => {
  const lead = agent('p-lead', 'Clock terminal', 'working', { coordinator: 'alpha' })
  const watch = agent('p-watch', 'Deploy watch', 'working', { coordinator: 'alpha', leadPane: 'p-lead', workingMode: 'monitoring' })
  const done = agent('p-done', 'Docs', 'done', { coordinator: 'alpha', leadPane: 'p-lead' })
  const s: Snapshot = { ...snap, rows: [row('clock', 'shop', [lead, watch, done], { branch: 'me/clock' })] }
  const m = render(s, emptyUi()).main, graph = m.slice(m.indexOf('class="tree"'))
  const rowOf = (html: string, pane: string) => new RegExp(`<(button|div) class="item[^"]*"[^>]*data-menu="agent:${pane}"[\\s\\S]*?</\\1>`).exec(html)![0]
  assert.match(rowOf(graph, 'p-lead'), /<i class="beam b-working" aria-hidden="true"><\/i>/)
  assert.match(rowOf(graph, 'p-watch'), /class="node n-monitoring"[\s\S]*<i class="beam b-monitoring"/, 'monitoring: its own slower beam on a dashed ring')
  noMatch(rowOf(graph, 'p-done'), /class="beam/, 'a done chat\'s ring is still')
  for (const pane of ['p-lead', 'p-watch']) noMatch(rowOf(graph, pane), /class="spin/, `${pane}: no spinning badge beside the shimmer`)
  assert.match(rowOf(graph, 'p-done'), /fill="#5fbf8a"/, 'the done badge stays')
  assert.match(rowOf(graph, 'p-lead'), /viewBox="-1.6 -3.2 24.8 24.8"/, 'the character keeps its frame, so it does not grow')
})

test('the PR cap: a ring in the checks\' color while open, a dot once merged, a cross when failing', () => {
  const pr = (state: string, checks: string | null = null) => capGlyph({ state, checks })
  assert.equal(capGlyph(null), null)
  assert.equal(pr('open', 'success'), 'open')
  assert.equal(pr('open'), 'open')
  assert.equal(pr('open', 'pending'), 'pending')
  assert.equal(pr('open', 'failure'), 'failing')
  assert.equal(pr('merged', 'failure'), 'merged')
  assert.equal(pr('closed'), 'closed')
  assert.equal(pr('draft'), 'draft')
})

test('the focused row wears a slim bar on its left edge, not a box', () => {
  const lead = agent('p-lead', 'Clock terminal', 'working', { coordinator: 'alpha' })
  const s: Snapshot = { ...snap, rows: [row('clock', 'shop', [lead], { branch: 'me/clock', active: true }), row('dev', 'shop', [agent('p-dev', 'Dev', 'working', { coordinator: 'alpha' })], { branch: 'dev' })],
    coordinators: [{ ...snap.coordinators[0], active: true, session: agent('p-c', 'alpha', 'done') }, snap.coordinators[1]] }
  const main = render({ ...s, focusedPanes: ['p-lead', 'p-c'] }, emptyUi()).main
  assert.match(main, /class="item current"[^>]*data-menu="agent:p-lead"[^>]*>(?:<i class="tl"[^>]*><\/i>)?<svg class="tl-c"[\s\S]*?<\/svg>(?:<i class="beam[^"]*"[^>]*><\/i>)?<i class="fb" aria-hidden="true"><\/i>/)
  assert.match(main, /<div class="item coord current" data-menu="coordinator:alpha" aria-current="true"><svg class="tl-h"[\s\S]*?<\/svg><i class="fb" aria-hidden="true"><\/i>/, 'a coordinator too')
  assert.equal([...main.matchAll(/class="fb"/g)].length, 2, 'only the focused rows')
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
  assert.match(right('p-lead'), /<span class="soft">orca-plugin<\/span><span class="br">[\s\S]*class="pr pr-ok"[\s\S]*<span class="age">1h<\/span>$/, 'the lead row keeps project, PR and age')
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
  const main = page(s, emptyUi())
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
  const chat = agent('p-c', 'Alert watch', 'working', { workingMode: 'monitoring' })
  assert.equal(inline(rows([{ ...lead, dispatch: 'settled' }, chat])), false, 'not while another chat in the worktree works, monitoring included')
  assert.equal(inline(rows([{ ...lead, dispatch: 'settled' }], { pr: null })), true, 'the settled path still works without a PR')
  assert.equal(inline(rows([{ ...lead, dispatch: 'settled' }], { pr: pr('open') })), true, 'and with any PR')
})

test("removing a lead's worktree: only a lead mid-turn stops it, the rest is up to the checkout checks", async () => {
  const lead = agent('p-ob', 'Draft shifts', 'done', { dispatch: 'open', summary: summary({ role: 'lead' }) })
  const at = (state: string, l = lead) => row('ob', 'mono', [l], { path: '/nonexistent/orca-flow-test', pr: { number: 6239, url: 'u', state, checks: null } })
  assert.deepEqual(await removeWorktree(async () => ({}), at('open')), { removed: false, reason: 'not a git checkout' }, 'open PR: the person confirmed, on to the checkout checks')
  assert.deepEqual(await removeWorktree(async () => ({}), at('merged')), { removed: false, reason: 'not a git checkout' }, 'merged: on to the checkout checks')
  assert.deepEqual(await removeWorktree(async () => ({}), at('open', { ...lead, state: 'working' })), { removed: false, reason: 'Draft shifts is working in this worktree' })
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
  const main = page({ ...snap, rows: [row('w', 'shop', [a])] }, emptyUi())
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
  const withPr = page({ ...snap, rows: [row('w', 'shop', [lead], { pr })] }, emptyUi())
  assert.match(withPr, /class="jump" data-open="w">Jump to session<\/button><button class="jump" data-pr="https:\/\/pr\/7">Open PR<\/button>/)
  noMatch(page({ ...snap, rows: [row('w', 'shop', [lead])] }, emptyUi()), /Open PR/, 'no PR, no button')
  const question = agent('p-q', 'Checkout', 'waiting', { question: 'Which one?' })
  noMatch(page({ ...snap, rows: [row('w', 'shop', [question], { pr })] }, emptyUi()), /Open PR/, 'a question is answered in the session')
})

test('every asking face in the tree has an Up next entry, a coordinator asking you included', () => {
  const ask = summary({ glance: 'Unblock the worktree?', role: 'coordinator', priority: 'P1', needs: { type: 'decision', ask: 'Unblock the worktree?', options: [] } })
  const session = agent('p-home', 'Bounti coordination', 'done', { summary: ask, terminal: 'term-home' })
  const s: Snapshot = { ...snap, coordinators: [{ ...snap.coordinators[0], session }, snap.coordinators[1]] }
  const { main: tree, attention: upnext } = render(s, emptyUi())
  const askingInTree = (tree.match(/data-tip="(Asks a question|Wants a review|Needs a yes\/no)"/g) ?? []).length
  const entries = (upnext.match(/data-brief=/g) ?? []).length
  assert.equal(askingInTree, 3, 'two agents and the coordinator ask')
  assert.equal(entries, askingInTree, 'Up next lists each of them')
  assert.match(upnext, /data-menu="coordinator:alpha"[^>]*>[\s\S]*?<span class="t[^"]*">alpha<\/span><span class="r">coordinator · P1/)
  assert.match(upnext, /Unblock the worktree\?/)
  const ui = emptyUi()
  ui.opened.add('p-home')
  assert.match(render(s, ui).attention, /<button class="jump" data-coordinator="alpha">Jump to session<\/button>/, 'opens it the way its row does')
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

// ---------- Option+1..9 ----------

/** The tree's chat rows (coordinators and agents), top to bottom, by the data-menu key chatTargets uses. */
const treeChats = (main: string) => [...main.slice(main.indexOf('class="tree"')).matchAll(/data-menu="((?:coordinator|agent):[^"]+)"/g)].map((m) => m[1])

test('chat numbers follow the tree: each coordinator, its leads with their workers, your chats, then sleeping coordinators', () => {
  const sleepy = { ...snap, coordinators: [...snap.coordinators, { key: 'zzz', name: 'zzz', repos: [], workspaceId: 'ws-z' }] }
  const targets = chatTargets(sleepy)
  assert.deepEqual(targets.map((t) => t.key), [
    'coordinator:alpha', 'agent:p-coord', 'agent:p-dup', // alpha, its lead and the worker nested under it
    'coordinator:main', 'agent:p-hook',
    'agent:p-cleanup', 'agent:p-pricing', // You has no session: only your chats, in start order, are numbered
    'coordinator:zzz' // asleep, below You
  ])
  // Each opens what a click on its row opens.
  assert.deepEqual(targets[0], { key: 'coordinator:alpha', coordinator: 'alpha' })
  assert.deepEqual(targets[1], { key: 'agent:p-coord', workspaceId: 'coord' })
  // Option+N opens the Nth row of the tree, top to bottom; the rows show no number.
  const { main, attention } = render(sleepy, emptyUi())
  assert.deepEqual(treeChats(main), targets.map((t) => t.key))
  noMatch(main, /⌥|class="num"|<kbd/, 'no shortcut labels on the rows')
  noMatch(attention, /⌥|class="num"|<kbd/, 'nor in Up next')
})

test("a folded group's team gives its numbers to the rows below; a terminal goes along", () => {
  const withTerm = { ...snap, rows: snap.rows.map((r) => (r.id === 'pricing' ? { ...r, agents: [{ ...r.agents[0], terminal: 'term-p' }] } : r)) }
  const ui = emptyUi()
  ui.folded.add('alpha')
  const targets = chatTargets(withTerm, ui.folded)
  assert.deepEqual(targets.map((t) => t.key), ['coordinator:alpha', 'coordinator:main', 'agent:p-hook', 'agent:p-cleanup', 'agent:p-pricing'])
  assert.deepEqual(targets[4], { key: 'agent:p-pricing', workspaceId: 'pricing', terminal: 'term-p' })
  const { main } = render(withTerm, ui)
  assert.deepEqual(treeChats(main), targets.map((t) => t.key), 'the numbers still follow the rows shown')
  noMatch(main, /⌥|class="num"/)
})

test('only the first nine chats get a number', () => {
  const many = { ...snap, coordinators: [], rows: Array.from({ length: 12 }, (_, i) => row(`w${i}`, 'shop', [agent(`p${i}`, `Chat ${i}`, 'working')], { createdAt: i })) }
  const targets = chatTargets(many)
  assert.equal(targets.length, 9)
  assert.deepEqual(targets.map((t) => t.key).slice(-1), ['agent:p8'])
  const { main } = render(many, emptyUi())
  assert.deepEqual(treeChats(main).slice(0, 9), targets.map((t) => t.key), 'the first nine rows, top to bottom')
  assert.equal(treeChats(main).length, 12, 'the rest show, without a shortcut')
  noMatch(main, /⌥|class="num"/)
  assert.equal(chatTargets({ rows: [], coordinators: [] }).length, 0)
})

test('Option+digit by physical key, without other modifiers', () => {
  const key = (code: string, over: Partial<{ altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) =>
    chatDigit({ code, altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, ...over })
  assert.equal(key('Digit1'), 1)
  assert.equal(key('Digit9'), 9)
  assert.equal(key('Digit0'), null)
  assert.equal(key('KeyA'), null)
  assert.equal(key('Numpad1'), null)
  assert.equal(key('Digit1', { altKey: false }), null, 'a plain digit types')
  assert.equal(key('Digit1', { metaKey: true }), null, "Cmd+Option is Orca's")
  assert.equal(key('Digit1', { ctrlKey: true }), null)
  assert.equal(key('Digit1', { shiftKey: true }), null)
})

test('Remove worktree is offered only while no agent in the worktree is mid-turn', async () => {
  const { canRemove } = await import('./rank.ts')
  const done = agent('p-a', 'Collaborator main push access', 'done')
  for (const state of ['done', 'waiting', 'blocked'] as const)
    assert.equal(canRemove(row('w', 'web-app', [done, agent('p-b', 'Other', state)])), true, `${state}: offered`)
  assert.equal(canRemove(row('w', 'web-app', [done, agent('p-b', 'Alert watch', 'working', { workingMode: 'monitoring' })])), false, 'a monitoring chat in the same worktree hides it')
  assert.equal(canRemove(row('w', 'web-app', [done], { main: true })), false, 'never the main checkout')
})

// ---------- the Linear section ----------

const lin = (id: string, over: Partial<LinearIssue> = {}): LinearIssue => ({
  id, title: `Issue ${id}`, url: `https://linear.app/acme/issue/${id}`, state: { name: 'Todo', type: 'unstarted', color: '' },
  team: 'BOU', project: null, projectColor: '', assignee: { id: 'me', name: 'me' }, priority: 3, cycle: 'c1', updatedAt: 0, ...over
})
const linearData = (issues: LinearIssue[], over: Partial<LinearData> = {}): LinearData => ({
  me: 'me', teams: ['BOU'], connectedTeams: ['BOU'], issues, cycles: ['c1'], sent: {}, lastSent: {}, at: 0, ...over
})
const linearUi = (over: Partial<UiState> = {}): UiState => ({ ...emptyUi(), ...over })
/** The issue IDs a section shows, top to bottom. */
const shownIds = (html: string) => [...html.matchAll(/class="lid">([^<]+)</g)].map((m) => m[1])

test('the Linear section is hidden until Linear data comes, and while searching', () => {
  assert.equal(render(snap, emptyUi()).linear, '')
  assert.equal(render(snap, { ...emptyUi(), query: 'x' }, linearData([lin('BOU-1')])).linear, '')
  assert.match(render(snap, emptyUi(), linearData([lin('BOU-1')])).linear, /Linear · BOU/)
})

test('Linear rows: status and priority icons, ID and title, escaped; a linked issue shows its lead and coordinator and sorts last', () => {
  const lead = agent('p-lead', 'Raise the body limit', 'working', { coordinator: 'alpha', summary: summary({ role: 'lead' }), terminal: 'term-1' })
  const s: Snapshot = { ...snap, rows: [...snap.rows, row('wt-87', 'mono', [lead], { linearIssue: 'BOU-87' })] }
  const html = render(s, emptyUi(), linearData([
    lin('BOU-87', { priority: 1 }),
    lin('BOU-2', { title: '<img src=x onerror=alert(1)>', priority: 2 }),
    lin('BOU-3', { priority: 0 })
  ])).linear
  assert.deepEqual(shownIds(html), ['BOU-2', 'BOU-3', 'BOU-87'])
  noMatch(html, /<img/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  const linked = html.slice(html.indexOf('BOU-87'))
  assert.match(html, /class="item lrow linked" data-open="wt-87" data-terminal="term-1">/)
  assert.match(linked, /<span>alpha<\/span>/)
  noMatch(linked.slice(0, linked.indexOf('</button>')), /Send/)
  assert.match(html, /data-lsend="BOU-2"[^>]*>.*Send/)
})

test('the switch: Mine, Team and Cycle with their counts; Team and Cycle name the assignee when it is not me', () => {
  const d = linearData([lin('BOU-1'), lin('BOU-2', { assignee: { id: 'u2', name: 'ernst' } }), lin('BOU-3', { assignee: null, cycle: 'old' })])
  const mine = render(snap, emptyUi(), d).linear
  assert.match(mine, /data-lfilter="mine" aria-pressed="true">Mine 1</)
  assert.match(mine, /data-lfilter="team" aria-pressed="false">Team 3</)
  assert.match(mine, /data-lfilter="cycle" aria-pressed="false">Cycle 2</)
  noMatch(mine, /class="rest"/)
  const team = render(snap, linearUi({ linearFilter: 'team' }), d).linear
  assert.deepEqual(shownIds(team), ['BOU-3', 'BOU-2', 'BOU-1'])
  assert.match(team, /<span class="rest">ernst<\/span>/)
  assert.match(team, /<span class="rest">unassigned<\/span>/)
  assert.equal((team.match(/class="rest"/g) ?? []).length, 2, 'not on my own issue')
})

test('folded, the section is its header: the count and name of the filter, and what is starting', () => {
  const d = linearData([lin('BOU-1'), lin('BOU-2')], { sent: { 'BOU-2': { coordinator: 'alpha', at: 1 } } })
  const html = render(snap, linearUi({ linearFolded: true }), d).linear
  assert.match(html, /data-lfold aria-expanded="false"/)
  assert.match(html, /<span class="fc">2<\/span>/)
  assert.match(html, /1 starting<\/span><span class="sepd">Mine</)
  noMatch(html, /class="lid"|data-lfilter/)
})

test('Staging folds away at the end; a long list shows its first rows and how many more', () => {
  const many = Array.from({ length: LINEAR_ROWS + 5 }, (_, i) => lin(`BOU-${i + 1}`))
  const staging = [lin('BOU-900', { state: { name: 'Staging', type: 'started', color: '' } }), lin('BOU-901', { state: { name: 'Staging', type: 'started', color: '' } })]
  const html = render(snap, emptyUi(), linearData([...many, ...staging])).linear
  assert.equal(shownIds(html).length, LINEAR_ROWS)
  assert.match(html, /data-lmore="linear-all:status:Todo" aria-expanded="false">.*5 more<\/button>/)
  assert.match(html, /data-lmore="linear-hidden:staging" aria-expanded="false">.*2 on Staging<\/button>/)
  assert.ok(html.indexOf('5 more') < html.indexOf('on Staging'))
  const open = render(snap, linearUi({ unfolded: new Set(['linear-all:status:Todo', 'linear-hidden:staging']) }), linearData([...many, ...staging])).linear
  assert.equal(shownIds(open).length, LINEAR_ROWS + 7)
  assert.match(render(snap, linearUi({ linearFilter: 'cycle' }), linearData([lin('BOU-1')], { cycles: [] })).linear, /Nothing open: no active cycle found/)
})

test('a sent issue shows its coordinator starting until a worktree links it; then its lead', () => {
  const d = linearData([lin('BOU-5')], { sent: { 'BOU-5': { coordinator: 'alpha', at: 1 } } })
  const sent = render(snap, emptyUi(), d).linear
  assert.match(sent, /data-coordinator="alpha"/)
  assert.match(sent, /alpha · starting/)
  assert.match(sent, /data-tip="In Progress"/, 'shown In Progress, as the send moved it')
  const lead = agent('p-l', 'Hours', 'working', { coordinator: 'alpha', summary: summary({ role: 'lead' }) })
  const linked = render({ ...snap, rows: [...snap.rows, row('wt-5', 'mono', [lead], { linearIssue: 'BOU-5' })] }, emptyUi(), d).linear
  noMatch(linked, /starting/)
  assert.match(linked, /data-open="wt-5"/)
})

test("the tree shows a worktree's Linear issue before its lead's title, not on workers in the same worktree", () => {
  const lead = agent('p-l', 'Planner hours', 'working', { coordinator: 'alpha' })
  const worker = agent('p-w', 'Write tests', 'working', { coordinator: 'alpha', leadPane: 'p-l' })
  const { main } = render({ ...snap, rows: [row('wt', 'shop', [lead, worker], { linearIssue: 'BOU-4179' })] }, emptyUi())
  assert.equal((main.match(/class="idchip"/g) ?? []).length, 1)
  assert.match(main, /class="idchip">.*BOU-4179<\/span><span class="t">Planner hours</)
})

test('coordinators in tree order: awake ones first, then sleeping', () => {
  const s: Snapshot = { ...snap, coordinators: [{ key: 'zz', name: 'zz', repos: [], workspaceId: null }, ...snap.coordinators] }
  assert.deepEqual(coordinatorOrder(s).map((c) => c.key), ['alpha', 'main', 'zz'])
})

test('a worktree created without --linear-issue is linked by its branch: the section shows its lead, the tree its ID', () => {
  const lead = agent('p-l', 'Planner staff-hour totals', 'working', { coordinator: 'alpha', summary: summary({ role: 'lead' }) })
  const s: Snapshot = { ...snap, rows: [row('wt-hours', 'mono', [lead], { branch: 'bou-4179-planned-hours' })] }
  const r = render(s, emptyUi(), linearData([lin('BOU-4179'), lin('BOU-1')]))
  assert.match(r.linear, /class="item lrow linked" data-open="wt-hours"/)
  noMatch(r.linear.slice(r.linear.indexOf('BOU-4179')), /data-lsend="BOU-4179"/)
  assert.deepEqual(shownIds(r.linear), ['BOU-1', 'BOU-4179'])
  assert.match(r.main, /class="idchip">.*BOU-4179<\/span><span class="t">Planner staff-hour totals</)
  // Without Linear data no team is known, so a branch links nothing.
  noMatch(render(s, emptyUi()).main, /idchip/)
})

test('display: a Display button left of the switch, with a dot once anything differs from the default; none while folded', () => {
  const d = linearData([lin('BOU-1')])
  const plain = render(snap, emptyUi(), d).linear
  assert.match(plain, /data-ldisplay[^>]*aria-label="Display options"[^>]*>.*?<\/button><span class="seg"/)
  noMatch(plain, /class="dot"/)
  const changed = render(snap, linearUi({ linearDisplay: { ...DEFAULT_DISPLAY, sort: 'updated' } }), d).linear
  assert.match(changed, /aria-label="Display options \(changed\)"[^>]*>.*?<span class="dot"><\/span><\/button>/)
  noMatch(render(snap, linearUi({ linearFolded: true }), d).linear, /data-ldisplay/)
})

test('groups are sub-headers with a glyph, name and count; a folded group hides its rows; Backlog folds away at the end', () => {
  const d = linearData([
    lin('BOU-1', { state: { name: 'In Progress', type: 'started', color: '' } }),
    lin('BOU-2'), lin('BOU-3'),
    lin('BOU-4', { state: { name: 'Backlog', type: 'backlog', color: '' } })
  ])
  const html = render(snap, emptyUi(), d).linear
  assert.match(html, /data-lgroup="status:In Progress" aria-expanded="true">.*?<span class="lic"[^>]*>.*?<span class="gl">In Progress<\/span><span class="gc">1<\/span>/)
  assert.match(html, /data-lgroup="status:Todo" aria-expanded="true">.*?<span class="gc">2<\/span>/)
  assert.match(html, /data-lmore="linear-hidden:backlog" aria-expanded="false">.*1 in Backlog<\/button>/)
  assert.deepEqual(shownIds(html), ['BOU-1', 'BOU-3', 'BOU-2'])
  const folded = render(snap, linearUi({ linearGroupFolds: new Set(['status:Todo']) }), d).linear
  assert.match(folded, /data-lgroup="status:Todo" aria-expanded="false">/)
  assert.deepEqual(shownIds(folded), ['BOU-1'])
  const flat = render(snap, linearUi({ linearDisplay: { ...DEFAULT_DISPLAY, group: 'none' } }), d).linear
  noMatch(flat, /data-lgroup/)
  assert.deepEqual(shownIds(flat), ['BOU-1', 'BOU-3', 'BOU-2'])
})

test('grouped by project: a color dot per project, "No project" last; a project filter shows one chip that clears it', () => {
  const d = linearData([lin('BOU-1', { project: 'Shift <Scheduling>', projectColor: '#26b5ce' }), lin('BOU-2', { project: 'Shift <Scheduling>', projectColor: '#26b5ce' }), lin('BOU-3'), lin('BOU-4', { project: 'ISO', projectColor: 'red;}' })])
  const byProject = render(snap, linearUi({ linearDisplay: { ...DEFAULT_DISPLAY, group: 'project' } }), d).linear
  assert.deepEqual([...byProject.matchAll(/<span class="gl">([^<]*)<\/span>/g)].map((m) => m[1]), ['Shift &lt;Scheduling&gt;', 'ISO', 'No project'])
  assert.match(byProject, /<i class="pdot" style="background:#26b5ce"/)
  noMatch(byProject, /red;\}/)
  const one = render(snap, linearUi({ linearDisplay: { ...DEFAULT_DISPLAY, projects: ['Shift <Scheduling>'] } }), d).linear
  assert.match(one, /<div class="pchips"><button class="pchip" data-lprojects-clear[^>]*><i class="pdot" style="background:#26b5ce"[^>]*><\/i>Shift &lt;Scheduling&gt;<svg/)
  assert.deepEqual(shownIds(one).sort(), ['BOU-1', 'BOU-2'])
  assert.match(one, /Mine 2</)
  const two = render(snap, linearUi({ linearDisplay: { ...DEFAULT_DISPLAY, projects: ['ISO', ''] } }), d).linear
  assert.match(two, /data-lprojects-clear[^>]*>2 projects<svg/)
  assert.match(render(snap, linearUi({ linearDisplay: { ...DEFAULT_DISPLAY, projects: ['Gone'] } }), d).linear, /Nothing open in these projects/)
})
