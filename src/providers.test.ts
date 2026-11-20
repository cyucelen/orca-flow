import { assert, test } from 'orca/testing'
import { fromPs, foldCoordinatorFolders } from './worker.ts'
import { assignCoordinators } from './coordinators.ts'
import { mixedProviders, providerBadge, providerOf } from './providers.ts'
import { chatTargets, emptyUi, render } from './view.ts'
import type { Coordinator, Snapshot } from './protocol.ts'

const snapshot = (agents: NonNullable<Parameters<typeof fromPs>[0][number]['agents']>): Snapshot => ({
  source: 'cli', capacity: null, coordinators: [],
  rows: fromPs([{ identity: { key: 'w' }, path: '/w', displayName: 'Feature', repo: 'shop', liveTerminalCount: 3, agents }])
})
const claude = { paneKey: 'claude', state: 'done', agentType: 'claude', hasLivePty: true }
const codex = { paneKey: 'codex', state: 'working', agentType: 'codex', hasLivePty: true }
const badges = (html: string) => [...html.matchAll(/class="provider" role="img" aria-label="([^"]+)"/g)].map((m) => m[1])

test('zero, single, repeated and aliased providers do not show logos', () => {
  for (const agents of [[], [claude], [claude, { ...claude, paneKey: 'second' }], [claude, { ...claude, agentType: 'claude-agent-teams' }]]) {
    const s = snapshot(agents)
    assert.equal(mixedProviders(s), false)
    assert.deepEqual(badges(render(s, emptyUi()).main), [])
  }
  assert.equal(providerOf(' CoDeX '), 'codex')
  assert.equal(providerOf('opencode2'), 'opencode')
  assert.equal(providerOf('antigravity'), 'antigravity')
  assert.equal(providerOf(' AGY '), 'antigravity')
})

test('each pane in a mixed worktree shows its own accessible provider and tooltip', () => {
  const s = snapshot([claude, codex, { ...codex, paneKey: 'third', agentType: 'gemini' }])
  s.rows[0].agents[1].leadPane = 'claude'
  s.rows[0].agents[1].terminal = 'term-codex'
  s.rows[0].active = true
  s.focusedPanes = ['codex']
  const before = chatTargets(s)
  const html = render(s, emptyUi()).main
  assert.deepEqual(badges(html), ['Claude', 'Codex', 'Gemini'])
  assert.match(html, /data-menu="agent:codex" aria-current="true"/)
  assert.match(html, /data-open="identity:w" data-terminal="term-codex"/)
  for (const name of ['Claude', 'Codex', 'Gemini']) assert.ok(html.includes(`aria-label="${name}" data-tip="${name}"`))
  assert.deepEqual(chatTargets(s), before, 'provider presentation does not change chat targets')
})

test('global presence survives waiting, blocked, idle and monitoring turns, then drops on settlement or closure', () => {
  const s = snapshot([claude, codex])
  const a = s.rows[0].agents[1]
  for (const state of ['working', 'waiting', 'blocked', 'done'] as const) {
    a.state = state
    assert.equal(mixedProviders(s), true, state)
  }
  a.workingMode = 'monitoring'
  assert.equal(mixedProviders(s), true)
  a.dispatch = 'settled'
  assert.equal(mixedProviders(s), false, 'finished dispatch still holding a terminal is excluded')
  assert.equal(providerBadge(a, true), '')
  a.dispatch = 'open'
  assert.equal(mixedProviders(s), true, 'a follow-up can reopen the same live session')
  a.live = false
  assert.equal(mixedProviders(s), false, 'closed history cannot borrow another pane’s terminal count')
  s.rows[0].agents.pop()
  assert.equal(mixedProviders(s), false)
})

test('positive PTY or structured-chat evidence is required, never workspace counts or cached state', () => {
  const s = snapshot([claude, { ...codex, hasLivePty: false }, { ...codex, paneKey: 'old', hasLivePty: undefined }])
  assert.deepEqual(s.rows[0].agents.map((a) => a.live), [true, false, false])
  assert.equal(mixedProviders(s), false)
  const chat = snapshot([claude, { ...codex, hasLivePty: false, structuredHostOwned: true }])
  assert.equal(chat.rows[0].agents[1].live, true)
  assert.equal(mixedProviders(chat), true)
  // Native chats can be idle with no PTY at all, and still belong in the tree.
  chat.rows[0].liveTerminals = 0
  chat.rows[0].agents[1].state = 'done'
  assert.deepEqual(badges(render(chat, emptyUi()).main), ['Claude', 'Codex'])
})

test('coordinator sessions and folder agents participate globally without changing their routing', () => {
  const s = snapshot([{ ...claude, parentPaneKey: null }, { ...codex, parentPaneKey: 'claude' }])
  const c: Coordinator = { key: 'home', name: 'Home', repos: [], workspaceId: null }
  s.rows[0].agents.forEach((a) => { a.coordinator = 'home' })
  s.coordinators = [c]
  s.rows = foldCoordinatorFolders(s.rows, s.coordinators, ['/w'])
  assert.equal(c.session?.agentType, 'claude')
  assert.equal(s.rows[0].folderOf, 'home')
  assert.equal(mixedProviders(s), true)
  const ui = emptyUi()
  assert.deepEqual(badges(render(s, ui).main), ['Claude', 'Codex'])
  ui.folded.add('home')
  assert.deepEqual(badges(render(s, ui).main), ['Claude'], 'folding does not change the global threshold')
  ui.query = 'Feature'
  assert.deepEqual(badges(render(s, ui).main), ['Codex'], 'search does not change the global threshold')
  c.session = null
  assert.equal(mixedProviders(s), false, 'sleeping coordinator has no provider presence')
})

test('different workspaces count globally and Up next uses the same provider gate', () => {
  const s = snapshot([claude])
  s.rows.push(...snapshot([{ ...codex, state: 'waiting' }]).rows.map((r) => ({ ...r, id: 'other' })))
  const html = render(s, emptyUi())
  assert.deepEqual(badges(html.main), ['Claude', 'Codex'])
  assert.deepEqual(badges(html.attention), ['Codex'])
  assert.deepEqual(badges(render(s, { ...emptyUi(), query: 'claude' }).main), ['Claude'])
})

test('unknown or missing metadata never invents a provider, injects markup or triggers logos', () => {
  const unknown = { ...codex, agentType: '<img src=x onerror=alert(1)>', conversationName: 'Claude Codex Gemini' }
  const s = snapshot([claude, unknown, { ...unknown, paneKey: 'missing', agentType: undefined }])
  assert.equal(mixedProviders(s), false)
  for (const id of [null, '', 'unknown', 'gpt-6', 'claude-opus-5', 'toString', '__proto__']) assert.equal(providerOf(id), null)
  s.rows.push(...snapshot([codex]).rows)
  assert.deepEqual(badges(render(s, emptyUi()).main).sort(), ['Claude', 'Codex', 'Unknown provider', 'Unknown provider'])
  const badge = providerBadge(s.rows[0].agents[1], true)
  assert.ok(!badge.includes('onerror'))
  assert.ok(!badge.includes('tabindex') && !badge.includes('data-open'), 'the badge adds no focus or click target')
})

test('all bundled known providers have usable inline marks and never need remote images', () => {
  for (const agentType of ['claude', 'codex', 'gemini', 'antigravity', 'cursor', 'copilot', 'opencode']) {
    const s = snapshot([{ ...codex, agentType }])
    const badge = providerBadge(s.rows[0].agents[0], true)
    assert.match(badge, /<svg viewBox="0 0 \d+ \d+"/)
    assert.ok(!badge.includes('<img') && !badge.includes('src=') && !badge.includes('Unknown provider'))
  }
})

test('three-level live Codex lineage keeps workers under their actual lead, with status and focus intact', () => {
  // Observed host shape: continuation -> lead -> this worker. The continuation can currently
  // be a folder-agent row; changing which session represents the coordinator is separate work.
  const s = snapshot([
    { ...codex, paneKey: 'continuation', state: 'done' },
    { ...codex, paneKey: 'lead', parentPaneKey: 'continuation', state: 'done' },
    { ...codex, paneKey: 'worker', parentPaneKey: 'lead' },
    { ...codex, paneKey: 'sibling', parentPaneKey: 'continuation', state: 'waiting' }
  ])
  s.rows = assignCoordinators(s.rows, [], {
    dispatcherOf: new Map(), paneOf: new Map([['term-worker', 'worker']]),
    dispatchOf: new Map([['worker', 'open']])
  })
  s.rows[0].active = true
  s.focusedPanes = ['worker']
  assert.deepEqual(s.rows[0].agents.map((a) => [a.paneKey, a.leadPane]), [
    ['continuation', null], ['lead', 'continuation'], ['worker', 'lead'], ['sibling', 'continuation']
  ])
  assert.deepEqual(chatTargets(s).map((t) => t.key), ['agent:continuation', 'agent:lead', 'agent:worker', 'agent:sibling'])
  const html = render(s, emptyUi()).main
  assert.match(html, /data-terminal="term-worker"[^>]*data-menu="agent:worker" aria-current="true"[^>]*data-node="working"/)
  assert.equal((html.match(/data-menu="agent:worker"/g) ?? []).length, 1)
  assert.ok(html.indexOf('data-menu="agent:lead"') < html.indexOf('data-menu="agent:worker"'))
  assert.ok(html.indexOf('data-menu="agent:worker"') < html.indexOf('data-menu="agent:sibling"'))
  s.rows.push(...snapshot([claude]).rows)
  assert.equal(badges(render(s, emptyUi()).main).filter((n) => n === 'Codex').length, 4)
})

test('missing parents, self-parenting and cycles cannot hide or duplicate sidebar agents', () => {
  const s = snapshot(['a', 'b', 'c', 'd'].map((paneKey) => ({ ...codex, paneKey })))
  const [a, b, c, d] = s.rows[0].agents
  a.leadPane = 'b'; b.leadPane = 'a'; c.leadPane = 'c'; d.leadPane = 'missing'
  const targets = chatTargets(s).map((t) => t.key)
  assert.equal(targets.length, 4)
  assert.deepEqual([...new Set(targets)].sort(), ['agent:a', 'agent:b', 'agent:c', 'agent:d'])
  const html = render(s, emptyUi()).main
  for (const key of ['a', 'b', 'c', 'd']) assert.equal((html.match(new RegExp(`data-menu="agent:${key}"`, 'g')) ?? []).length, 1)
})
