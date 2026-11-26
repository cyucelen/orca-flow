// The Bots section: which bots show, how they group, their rows, and their asks in Up next.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, AgentSummary, Bot, Coordinator, Snapshot, WorkspaceRow } from './protocol.ts'
import { buildBots, folderOf, groupBots, isBotRow, nextRunOf, plainText, purposeOf, readBotFolders, soulLine, type BotFolder } from './bots.ts'
import { askingRows, botsSection, botState, emptyUi, render, upNextOrder } from './view.ts'
import { botsOf, fromPs, snapshot, statusOf, summaryAgents, type PsWorktree } from './worker.ts'
import { COORDINATOR_FILE, readCoordinators, writeCoordinatorSessions, writeLook } from './coordinators.ts'

const NOW = 1_800_000_000_000
const noMatch = (text: string, re: RegExp, message?: string) => assert.ok(!re.test(text), message ?? `unexpected ${re}`)

const summary = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  title: 'Work', about: 'Set up the bot.', glance: '', goal: '', since: '', needs: { type: 'none', ask: '', options: [] },
  effort: 'quick', priority: 'P2', role: 'solo', updatedAt: 1, ...over
})
const asking = summary({ glance: 'Which flows should I watch first?', needs: { type: 'info', ask: 'Which flows should I watch first?', options: [] } })
const agent = (paneKey: string, state: AgentInfo['state'], over: Partial<AgentInfo> = {}): AgentInfo => ({
  paneKey, title: 'chat', state, agentType: 'claude', summary: null, workingMode: null, coordinator: 'you', leadPane: null, parentPane: null,
  orcaSession: null, dispatch: null, terminal: null, question: null, live: true, ...over
})
const row = (id: string, path: string, agents: AgentInfo[], over: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  id, name: id, branch: null, repo: 'Bots', path, main: false, agents, state: agents[0]?.state ?? null, priority: null, card: null, parentId: null,
  liveTerminals: 0, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: 0, createdAt: 0, pr: null, ...over
})
const folder = (name: string, dir: string, over: Partial<BotFolder> = {}): BotFolder => ({ folder: dir, path: `/bots/${dir}`, id: `id-${dir}`, name, avatar: 'mascot:B1', soul: `# ${name}\n\nWatches ${name}.\n`, ...over })
const bot = (over: Partial<Bot> = {}): Bot => ({
  id: 'b1', name: 'live-qa', folder: 'live-qa', avatar: 'mascot:B1', purpose: 'Watches the live cluster.', paused: false, coordinator: null,
  workspaceId: 'folder:qa', chats: [], nextRunAt: null, ...over
})
const coordinator = (key: string, bots?: string[]): Coordinator => ({ key, name: key, repos: [], workspaceId: null, ...(bots ? { bots } : {}) })
const snapOf = (over: Partial<Snapshot> = {}): Snapshot => ({ source: 'cli', capacity: null, coordinators: [], rows: [], ready: true, ...over })

// ---------- grouping ----------

test('a listed bot goes under the coordinator that lists it; an unlisted one under Personal', () => {
  const { owner, duplicates } = groupBots([{ name: 'live-qa', folder: 'live-qa' }, { name: 'Replies you owe', folder: 'replies-you-owe' }], [coordinator('alpha', ['live-qa']), coordinator('beta')])
  assert.equal(owner.get('live-qa'), 'alpha')
  assert.equal(owner.get('Replies you owe'), null)
  assert.deepEqual(duplicates, [])
})

test('a list entry matches the bot by its name or its folder, case-insensitive; repos play no part', () => {
  const bots = [{ name: 'Replies you owe', folder: 'replies-you-owe' }, { name: 'Live QA', folder: 'super-agent-live-qa' }]
  const byFolder = groupBots(bots, [{ key: 'alpha', bots: ['Replies-You-Owe'] }, { key: 'beta', bots: ['live qa'] }])
  assert.equal(byFolder.owner.get('Replies you owe'), 'alpha', 'folder name, any case')
  assert.equal(byFolder.owner.get('Live QA'), 'beta', 'bot name, any case')
  const repos = groupBots(bots, [{ key: 'alpha', repos: ['super-agent-live-qa'] } as never])
  assert.equal(repos.owner.get('Live QA'), null, 'a coordinator owning a repo of the same name does not adopt the bot')
})

test('a bot two coordinators list stays with the first and is reported once', () => {
  const coordinators = [coordinator('alpha', ['live-qa']), coordinator('beta', ['LIVE-QA'])]
  const { owner, duplicates } = groupBots([{ name: 'live-qa', folder: 'live-qa' }], coordinators)
  assert.equal(owner.get('live-qa'), 'alpha')
  assert.deepEqual(duplicates, [{ bot: 'live-qa', kept: 'alpha', also: ['beta'] }])
  const lines: string[] = []
  const data = { listed: [{ id: 'b1', name: 'live-qa' }], automations: [] }
  botsOf([], coordinators, data, (l) => lines.push(l), [])
  botsOf([], coordinators, data, (l) => lines.push(l), [])
  assert.deepEqual(lines, ['bot live-qa is listed by alpha, beta; it shows under alpha'], 'logged once, not at every snapshot')
})

// ---------- what a bot shows ----------

test('a purpose is Orca specialty without markdown, else the first non-heading line of SOUL.md', () => {
  assert.equal(purposeOf('Always-on **zero-mock live regression sentinel** for `super-core-01`.', ''), 'Always-on zero-mock live regression sentinel for super-core-01.')
  assert.equal(purposeOf(null, '# Replies you owe\n\nReminds you of replies you still owe.\n\n## How I work\n'), 'Reminds you of replies you still owe.')
  assert.equal(purposeOf('', '# Only a heading\n'), '')
  assert.equal(soulLine('---\n# T\n- **Watches:** [Slack](https://slack.com) threads'), 'Watches: Slack threads')
  assert.equal(plainText('## A _b_ ~~c~~'), 'A b c')
  assert.ok(purposeOf('x'.repeat(400), '').length <= 160, 'clipped for the wire')
})

test('a bot folder is found by the id in its bot.json, else by its name or folder', () => {
  const folders = [folder('Replies you owe', 'replies-you-owe', { id: 'r' }), folder('qa', 'super-agent-live-qa', { id: 'q' })]
  assert.equal(folderOf({ id: 'q', name: 'renamed' }, folders)?.folder, 'super-agent-live-qa')
  assert.equal(folderOf({ name: 'REPLIES YOU OWE' }, folders)?.folder, 'replies-you-owe')
  assert.equal(folderOf({ name: 'replies-you-owe' }, folders)?.folder, 'replies-you-owe')
})

test('the next run is the soonest enabled automation of that bot still ahead', () => {
  const automations = [
    { bot: { botId: 'b1' }, enabled: true, nextRunAt: NOW + 3 * 3_600_000 },
    { bot: { botId: 'b1' }, enabled: true, nextRunAt: NOW + 15 * 60_000 },
    { bot: { botId: 'b1' }, enabled: false, nextRunAt: NOW + 60_000 },
    { bot: { botId: 'b2' }, enabled: true, nextRunAt: NOW + 60_000 },
    { bot: { botId: 'b1' }, enabled: true, nextRunAt: NOW - 60_000 },
    { enabled: true, nextRunAt: NOW + 1 }
  ]
  assert.equal(nextRunOf('b1', automations, NOW), NOW + 15 * 60_000)
  assert.equal(nextRunOf('b3', automations, NOW), null)
})

test('only listed bots show (with their folder, chats and home); a folder Orca does not list stays out', () => {
  const folders = [folder('Replies you owe', 'replies-you-owe', { id: 'r', avatar: 'mascot:E1' }), folder('live-qa', 'live-qa', { id: 'b1' })]
  const home = row('folder:qa', '/bots/live-qa', [agent('p-home', 'done', { summary: asking })], { bot: 'live-qa' })
  const run = row('folder:qa-run', '/w/run', [agent('p-run', 'working')], { bot: 'live-qa' })
  const { bots } = buildBots({
    listed: [{ id: 'b1', name: 'live-qa', specialty: 'Runs **live** checks.', paused: false }], folders,
    automations: [{ bot: { botId: 'b1' }, enabled: true, nextRunAt: NOW + 60_000 }], botRows: [run, home], coordinators: [], now: NOW
  })
  assert.equal(bots.length, 1, 'replies-you-owe has a folder but `orca bot list` does not list it')
  const b = bots[0]
  assert.equal(b.folder, 'live-qa')
  assert.equal(b.avatar, 'mascot:B1')
  assert.equal(b.purpose, 'Runs live checks.')
  assert.equal(b.workspaceId, 'folder:qa', 'the home folder, not the first chat workspace')
  assert.deepEqual(b.chats.map((c) => [c.workspaceId, c.agent.paneKey]), [['folder:qa-run', 'p-run'], ['folder:qa', 'p-home']])
  assert.equal(b.nextRunAt, NOW + 60_000)
  assert.equal(b.coordinator, null)
})

test('a bot workspace no listed bot claims still shows, so its asks never vanish; unread bot list shows none', () => {
  const orphan = row('folder:x', '/bots/x', [agent('p-x', 'done', { summary: asking })], { bot: 'x' })
  const { bots } = buildBots({ listed: [], folders: [folder('x', 'x')], automations: [], botRows: [orphan], coordinators: [coordinator('alpha', ['X'])], now: NOW })
  assert.deepEqual(bots.map((b) => [b.name, b.workspaceId, b.coordinator, b.purpose]), [['x', 'folder:x', 'alpha', 'Watches x.']])
  assert.equal(botsOf([], [], { listed: null, automations: [] }, () => {}, []), null, 'unknown until Orca answers: the section stays hidden')
  assert.deepEqual(botsOf([], [], { listed: [], automations: [] }, () => {}, []), [], 'Orca listed none: the empty state')
})

test('bot folders are read from disk: bot.json and SOUL.md; a folder without bot.json is skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'bots-'))
  try {
    mkdirSync(join(root, 'replies-you-owe'))
    writeFileSync(join(root, 'replies-you-owe', 'bot.json'), JSON.stringify({ id: 'r', name: 'Replies you owe', avatar: 'mascot:E1' }))
    writeFileSync(join(root, 'replies-you-owe', 'SOUL.md'), '# Replies you owe\n\nReminds you of replies you still owe.\n')
    mkdirSync(join(root, 'stray'))
    const folders = readBotFolders(root)
    assert.deepEqual(folders.map((f) => [f.folder, f.id, f.name, f.avatar, soulLine(f.soul)]), [['replies-you-owe', 'r', 'Replies you owe', 'mascot:E1', 'Reminds you of replies you still owe.']])
    assert.ok(isBotRow({ path: join(root, 'replies-you-owe'), bot: null }, root))
    assert.ok(isBotRow({ path: '/elsewhere', bot: 'live-qa' }, root))
    assert.ok(!isBotRow({ path: '/w/shop', bot: null }, root))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------- coordinator.json keeps `bots` ----------

test('coordinators read `bots`, and every writer of coordinator.json keeps it', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-bots-'))
  try {
    const dir = join(root, 'alpha')
    mkdirSync(dir)
    const file = join(dir, COORDINATOR_FILE)
    writeFileSync(file, JSON.stringify({ name: 'alpha', repos: [], bots: ['live-qa', 'Replies you owe', 7, ''], sessions: { version: 1, current: null, members: [] } }))
    assert.deepEqual(readCoordinators(root)[0].bots, ['live-qa', 'Replies you owe'])
    const bots = () => JSON.parse(readFileSync(file, 'utf8')).bots
    writeLook(dir, { color: '#5b8def', shape: 'hex' })
    assert.deepEqual(bots(), ['live-qa', 'Replies you owe', 7, ''], 'a new look')
    writeCoordinatorSessions(dir, { version: 1, current: null, members: [] }, { sessions: { version: 1, current: null, members: [] } })
    assert.deepEqual(bots(), ['live-qa', 'Replies you owe', 7, ''], 'sessions')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------- rows ----------

test('a bot row: its avatar, name and purpose on one line, a click opens its home workspace', () => {
  const html = botsSection(snapOf({ bots: [bot()] }), { ...emptyUi(), now: NOW })
  assert.match(html, /<span>Bots<\/span><span class="fc">1<\/span>/, 'the header counts the bots')
  assert.match(html, /<div class="bgroup">Personal<\/div>/)
  assert.match(html, /class="item brow" data-open="folder:qa"/)
  assert.match(html, /<span class="bname">live-qa<\/span><span class="bpurpose">Watches the live cluster\.<\/span>/)
  assert.match(html, /<svg class="ch"/, 'a character stands for the avatar')
  noMatch(html, /Run now|Pause|Move|aria-haspopup/, 'no actions on a bot row')
})

test('a bot row says what it does now: waiting on you, working, paused, else when it runs next', () => {
  const ui = { ...emptyUi(), now: NOW }
  const cell = (b: Bot) => { const h = botsSection(snapOf({ bots: [b] }), ui); return h.slice(h.indexOf('<span class="r">')) }
  assert.match(cell(bot({ chats: [{ workspaceId: 'folder:qa', agent: agent('p', 'blocked') }, { workspaceId: 'folder:qa', agent: agent('q', 'working') }] })), /rstatus ask">Waiting on you/)
  assert.match(cell(bot({ chats: [{ workspaceId: 'folder:qa', agent: agent('q', 'working') }], paused: true })), />Working</)
  assert.match(cell(bot({ paused: true, nextRunAt: NOW + 60_000 })), />Paused</)
  assert.match(cell(bot({ nextRunAt: NOW + 12 * 60_000 })), /class="age" data-tip="Next run [^"]+">in 12m</)
  assert.equal(botState(bot({ nextRunAt: NOW + 5 * 3_600_000 }), NOW).text, 'in 5h')
  assert.equal(botState(bot(), NOW).text, '', 'nothing scheduled: nothing on the right')
  assert.match(botsSection(snapOf({ bots: [bot({ workspaceId: null })] }), ui), /class="item brow" disabled data-tip="Its Home chat is not open in Orca"/)
})

test('bots group under the coordinator that adopted them, in the Coordinators order, Personal last', () => {
  const coordinators = [coordinator('zeta'), coordinator('alpha')]
  const s = snapOf({
    coordinators,
    rows: [row('zeta-home', '/c/zeta', [])],
    bots: [bot({ id: '1', name: 'mine' }), bot({ id: '2', name: 'for-alpha', coordinator: 'alpha' }), bot({ id: '3', name: 'for-zeta', coordinator: 'zeta' }), bot({ id: '4', name: 'gone', coordinator: 'deleted' })]
  })
  const html = botsSection(s, { ...emptyUi(), now: NOW })
  const order = [...html.matchAll(/class="bgroup">([^<]+)<|class="bname">([^<]+)</g)].map((m) => m[1] ?? m[2])
  assert.deepEqual(order, ['zeta', 'for-zeta', 'alpha', 'for-alpha', 'Personal', 'mine', 'gone'], 'a coordinator that no longer exists leaves its bot in Personal')
})

test('no bots: one muted line; folded: the header and its count only; unknown: no section', () => {
  const ui = { ...emptyUi(), now: NOW }
  assert.match(botsSection(snapOf({ bots: [] }), ui), /<span class="fc">0<\/span>.*<div class="empty bempty">No bots yet\. Ask a coordinator to adopt one, or create one in Orca\.<\/div>/)
  const folded = botsSection(snapOf({ bots: [bot()] }), { ...ui, botsFolded: true })
  assert.match(folded, /data-bfold aria-expanded="false"/)
  assert.match(folded, /<span class="fc">1<\/span>/)
  noMatch(folded, /brow/)
  assert.equal(botsSection(snapOf({ bots: null }), ui), '')
  assert.equal(render(snapOf(), ui).bots, '')
})

// ---------- Up next ----------

test('an idle bot never enters Up next, even when its last reply ends in a question', () => {
  // Its turn ended; the summarizer read the question as an ask. Orca says done: it waits for its next message.
  const idle = agent('p-home', 'done', { summary: asking })
  const s = snapOf({ coordinators: [coordinator('alpha')], bots: [bot({ coordinator: 'alpha', nextRunAt: NOW + 12 * 60_000, chats: [{ workspaceId: 'folder:qa', agent: idle }] })] })
  const r = render(s, { ...emptyUi(), now: NOW })
  assert.equal(r.attention, '', 'no Up next item')
  assert.equal(askingRows(s).length, 0, 'nor in the status bar or jump-to-next')
  assert.match(statusOf(s).text, /clear/)
  noMatch(r.bots, /Waiting on you/, 'its row shows no waiting state')
  assert.match(r.bots, />in 12m</, 'its next run instead')
  assert.equal(botState(bot({ chats: [{ workspaceId: 'folder:qa', agent: idle }] }), NOW).face, 'done')
  // A later ask from a working bot does not either.
  const later = agent('p-run', 'working', { summary: summary({ glance: 'Need a token later', needs: { type: 'info', ask: 'Token?', options: [], blocking: false } }) })
  assert.equal(render(snapOf({ bots: [bot({ chats: [{ workspaceId: 'folder:qa', agent: later }] })] }), { ...emptyUi(), now: NOW }).attention, '')
})

test('a bot chat stopped on a permission prompt is an Up next item: the bot name, its group, the usual jump', () => {
  // Its summary's stale question never shows: the prompt is the ask.
  const ask = agent('p-home', 'blocked', { summary: asking })
  const s = snapOf({ coordinators: [coordinator('alpha')], bots: [bot({ coordinator: 'alpha', chats: [{ workspaceId: 'folder:qa', agent: ask }, { workspaceId: 'folder:qa', agent: agent('p-run', 'done', { summary: asking }) }] })] })
  const r = render(s, { ...emptyUi(), now: NOW })
  assert.match(r.attention, /Up next · 1/)
  assert.match(r.attention, /<span class="t strong">live-qa<\/span><span class="r">alpha · P2<\/span>/)
  assert.match(r.attention, /<span class="kicker">Needs your yes<\/span><span>Approve a permission prompt\.<\/span>/)
  noMatch(r.attention, /Which flows/)
  assert.match(r.bots, /rstatus ask">Waiting on you/)
  assert.match(r.attention, /<button class="jump" data-open="folder:qa">Jump to session<\/button>/)
  assert.equal(askingRows(s).length, 1, 'the status bar and jump-to-next read the same queue')
  assert.equal(askingRows(s)[0].id, 'folder:qa')
  assert.match(statusOf(s).text, /1 waiting/)
  const personal = render(snapOf({ bots: [bot({ chats: [{ workspaceId: 'folder:qa', agent: agent('w', 'waiting', { question: 'Which env?' }) }] })] }), { ...emptyUi(), now: NOW })
  assert.match(personal.attention, /<span class="r">Personal<\/span>/)
  assert.match(personal.attention, /Which env\?/)
})

test('bot chats go through the same summarizer as agents', () => {
  const s = snapOf({ rows: [row('w', '/w/shop', [agent('p-w', 'done')])], bots: [bot({ chats: [{ workspaceId: 'folder:qa', agent: agent('p-home', 'done') }] })] })
  assert.deepEqual(summaryAgents(s).map((t) => [t.agent.paneKey, t.worktreeId]), [['p-w', 'w'], ['p-home', 'folder:qa']])
})

// ---------- bot workspaces are not ordinary rows ----------

test("a bot's workspace shows only in Bots: not in the tree, Idle, search or a second Up next item", () => {
  const ps: PsWorktree[] = [
    { identity: { key: 'wt2:local:a' }, displayName: 'shop-fix', repo: 'shop', path: '/w/shop-fix', branch: 'refs/heads/fix', liveTerminalCount: 1, agents: [{ paneKey: 'p-shop', state: 'working', agentType: 'claude', conversationName: 'Fix the cart' }] },
    { displayName: 'super-agent-live-qa', repo: 'Bots', path: '/bots/live-qa', bot: 'super-agent-live-qa', botHome: true, agents: [{ paneKey: 'p-home', orcaSessionId: 's1', state: 'blocked', agentType: 'claude', conversationName: 'super-agent-live-qa', structuredHostOwned: true }] },
    { displayName: 'replies', repo: 'Bots', path: '/bots/replies-you-owe', bot: 'Replies you owe', agents: [] }
  ]
  const all = fromPs(ps, { cards: {}, summaries: { 'p-home': { ...asking, orcaSession: 's1', providerSession: { provider: 'claude', id: 'x' } } } }, new Map([['/bots/live-qa', 'folder:qa'], ['/bots/replies-you-owe', 'folder:r']]))
  assert.deepEqual(all.map((r) => r.bot ?? null), [null, 'super-agent-live-qa', 'Replies you owe'], 'fromPs keeps Orca\'s bot mark')
  const botRows = all.filter((r) => isBotRow(r))
  const rows = all.filter((r) => !isBotRow(r))
  const bots = botsOf(botRows, [], { listed: [{ id: 'b1', name: 'super-agent-live-qa' }], automations: [] }, () => {}, [folder('super-agent-live-qa', 'live-qa', { id: 'b1' })], NOW)!
  assert.deepEqual(bots.map((b) => [b.name, b.workspaceId, b.chats.length]), [['super-agent-live-qa', 'folder:qa', 1], ['Replies you owe', 'folder:r', 0]])
  const s = snapOf({ rows, bots })
  const ui = { ...emptyUi(), now: NOW }
  const r = render(s, ui)
  noMatch(r.main, /live-qa|replies/i, 'the tree has no bot workspace')
  assert.equal(upNextOrder(s).length, 1)
  assert.equal((r.attention.match(/data-brief=/g) ?? []).length, 1, 'its ask shows once')
  assert.match(r.bots, /class="bname">super-agent-live-qa</)
  assert.match(r.bots, /class="bname">Replies you owe</)
  const found = render(s, { ...ui, query: 'live' }).main
  assert.match(found, /No matching workspaces/, 'search finds no bot workspace')
})

// ---------- Settings → Features → Bots ----------

test('Bots off: no section, no bot chat in Up next, the queue or the status bar; Bots on shows them as before', async () => {
  const ps: PsWorktree[] = [
    { identity: { key: 'wt2:local:a' }, displayName: 'shop-fix', repo: 'shop', path: '/w/shop-fix', branch: 'refs/heads/fix', liveTerminalCount: 1, agents: [{ paneKey: 'p-shop', state: 'working', agentType: 'claude', conversationName: 'Fix the cart' }] },
    { displayName: 'super-agent-live-qa', repo: 'Bots', path: '/bots/live-qa', bot: 'super-agent-live-qa', botHome: true, agents: [{ paneKey: 'p-home', orcaSessionId: 's1', state: 'blocked', agentType: 'claude', conversationName: 'super-agent-live-qa' }] }
  ]
  const orca = { host: { call: async () => ({ workspaces: [], truncated: false }) }, log: () => {} }
  const off = await snapshot(orca as never, async () => ps, () => {}, false)
  assert.equal('bots' in off, false, 'the snapshot carries no bots')
  assert.deepEqual(off.rows.map((r) => r.name), ['shop-fix'], 'the bot workspace is no ordinary row either')
  const ui = { ...emptyUi(), now: NOW }
  const r = render(off, ui)
  assert.equal(r.bots, '')
  noMatch(r.main + r.attention, /live-qa/)
  // The snapshot reads the real coordinator folders, whose sessions may ask: count only bot rows.
  assert.equal(askingRows(off).filter((row) => row.bot).length, 0)
  assert.equal(upNextOrder(off).filter((p) => p.row.bot).length, 0)
  assert.deepEqual(summaryAgents(off), summaryAgents(snapOf({ rows: off.rows })), 'no bot chat is summarized')
  // On: the snapshot the worker builds with bots, as before.
  const withBots = snapOf({ rows: off.rows, bots: [bot({ chats: [{ workspaceId: 'folder:qa', agent: agent('p-home', 'blocked') }] })] })
  assert.match(render(withBots, ui).bots, /class="bname">live-qa</)
  assert.equal(askingRows(withBots).length, 1)
})
