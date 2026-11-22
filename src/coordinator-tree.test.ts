// The orca-flow tree the user reported on 0.2.65: the coordinator's conversation is listed twice
// (a stale pre-restart pane and the live resumed pane), so the root row said Sleeping, the live pane
// showed as a child holding the leads, and the stale pane showed as a dim sibling. Uses only APIs
// that existed in 0.2.65, so it also runs against that source.
import { assert, test } from 'orca/testing'
import { memberAgent, wakePlan } from './coordinator-sessions.ts'
import { assignCoordinators } from './coordinators.ts'
import { foldCoordinatorFolders, fromPs } from './worker.ts'
import { emptyUi, render } from './view.ts'
import type { Coordinator, CoordinatorSessions } from './protocol.ts'

const DIR = '/fixture/coordinators/orca-flow'
const WS = 'ws::/fixture/coordinators/orca-flow'
const MAIN = '6595cd51-313b-44c8-81f7-735fcec424ef'
const STALE = 'e6cc45c5:15579261'
const LIVE = '3d2a9720:34a16455'
const LEAD = 'd51d72a6:00d3ab14'
const RELEASE = '0d1a7e82:release'
const TERM = { [LIVE]: 'term_6687c482', [LEAD]: 'term_lead', 'd49db763:w': 'term_w1', '9e1b6172:w': 'term_w2', [RELEASE]: 'term_release', 'rel-worker:1': 'term_rw' } as Record<string, string>

function tree() {
  const rows = fromPs([
    { worktreeId: WS, path: DIR, displayName: 'orca-flow', repo: 'orca-flow', liveTerminalCount: 2, agents: [
      { paneKey: STALE, orcaSessionId: MAIN, agentType: 'codex', state: 'done', conversationName: 'Resume status message clipping' },
      { paneKey: LIVE, orcaSessionId: MAIN, agentType: 'codex', state: 'working', hasLivePty: true, conversationName: 'Orca Flow coordinators' },
      // A distinct earlier conversation in the folder, not a member and closed: it keeps its own
      // asleep row (no member duplicate), which the tree leaves out like any sleeping lead.
      { paneKey: 'hist:1', orcaSessionId: 'another-conversation', agentType: 'claude', state: 'done', conversationName: 'Disk cleanup' }
    ] },
    { worktreeId: 'wt::status', path: '/fixture/orca-plugin/coordinator-handover-status', identity: { key: 'status' }, displayName: 'coordinator-handover-status', repo: 'orca-plugin', branch: 'cyucelen/coordinator-handover-status', liveTerminalCount: 3, agents: [
      { paneKey: LEAD, parentPaneKey: LIVE, orcaSessionId: 'lead', agentType: 'claude', state: 'done', hasLivePty: true, conversationName: 'Coordinator status and errors' },
      { paneKey: '9e1b6172:w', parentPaneKey: LEAD, orcaSessionId: 'w2', agentType: 'claude', state: 'working', hasLivePty: true, taskTitle: 'Readable coordinator open and handover failures with recovery' },
      { paneKey: 'd49db763:w', parentPaneKey: LEAD, orcaSessionId: 'w1', agentType: 'claude', state: 'done', hasLivePty: true, taskTitle: 'Coordinator live-session resolution' }
    ] },
    { worktreeId: 'wt::release', path: '/fixture/orca-plugin/release-open-prs', identity: { key: 'release' }, displayName: 'release-open-prs', repo: 'orca-plugin', branch: 'release-open-prs', liveTerminalCount: 2,
      linkedPR: { number: 52, url: 'https://example.invalid/pull/52', state: 'open', title: 'Release' }, agents: [
        { paneKey: RELEASE, parentPaneKey: LIVE, orcaSessionId: 'release', agentType: 'claude', state: 'working', hasLivePty: true, conversationName: 'Release open Orca Flow PRs' },
        { paneKey: 'rel-worker:1', parentPaneKey: RELEASE, orcaSessionId: 'rel-worker', agentType: 'codex', state: 'working', hasLivePty: true, taskTitle: 'Verify release notes' }
      ] }
  ], { cards: {}, summaries: {} }, new Map([[DIR, WS]]))
  // The coordinator's runs dispatched both leads from its live terminal; each lead dispatched its workers.
  const lineage = {
    paneOf: new Map(Object.entries(TERM).map(([pane, t]) => [t, pane])),
    dispatcherOf: new Map([[LEAD, TERM[LIVE]], [RELEASE, TERM[LIVE]], ['9e1b6172:w', 'term_lead'], ['d49db763:w', 'term_lead'], ['rel-worker:1', 'term_release']]),
    dispatchOf: new Map<string, 'open' | 'settled'>([[LEAD, 'open'], [RELEASE, 'open'], ['9e1b6172:w', 'open'], ['d49db763:w', 'settled'], ['rel-worker:1', 'open']])
  }
  // coordinator.json as on disk: the codex member current (bound to both panes), the old Claude member with no rows.
  const id = JSON.stringify([WS, 'session', MAIN])
  const sessions: CoordinatorSessions = { version: 1, current: id, members: [
    { id: JSON.stringify([WS, 'session', 'old-claude']), workspaceId: WS, workspacePath: DIR, orcaSession: 'old-claude', agentType: 'claude', title: 'Claude Code', paneKey: 'old-claude:pane', terminals: ['term_ddf53e6a'], resumeSessionId: 'f826b397' },
    { id, workspaceId: WS, workspacePath: DIR, orcaSession: MAIN, agentType: 'codex', title: 'Resume status message clipping', paneKey: LIVE, resumeSessionId: '01a1f660',
      bindings: [{ terminal: 'term_f480ae98', paneKey: STALE, orcaSession: MAIN }, { terminal: TERM[LIVE], paneKey: LIVE, orcaSession: MAIN }], terminals: ['term_f480ae98', TERM[LIVE]] }
  ] }
  const c = { key: 'orca-flow', name: 'orca-flow', repos: [], workspaceId: null, dir: DIR, about: '', sessions }
  return { rows, lineage, c }
}

test('reported orca-flow tree: the root is the live main conversation, opens its pane, no duplicate member rows, leads directly under it', () => {
  const { rows, lineage, c } = tree()
  const all = assignCoordinators(rows, [c], lineage)
  const coordinators: Coordinator[] = [{ ...c }]
  const visible = foldCoordinatorFolders(all, coordinators, [DIR])
  const view = coordinators[0]

  // Root identity and live status.
  assert.equal(memberAgent(c.sessions.members[1], all)?.paneKey, LIVE)
  assert.equal(view.session?.paneKey, LIVE)
  assert.equal(view.session?.state, 'working')
  const html = render({ rows: visible, coordinators, source: 'cli', capacity: null }, emptyUi()).main
  const root = html.match(/<div class="item coord[^]*?<\/div>/)![0]
  assert.ok(!/Sleeping|Not started/.test(root), 'the root row shows live status, not Sleeping')

  // Click destination: the exact live pane's terminal, never a resume or the stale pane.
  assert.deepEqual(wakePlan(c, all, 0), { kind: 'open', member: c.sessions.members[1], workspaceId: WS, terminal: TERM[LIVE] })

  // No member row of the main conversation, live or stale; the distinct closed conversation keeps its own row, hidden from the tree.
  const panes = visible.flatMap((r) => r.agents.map((a) => a.paneKey))
  assert.ok(!panes.includes(LIVE) && !panes.includes(STALE), `no duplicate main-conversation rows: ${panes.join(', ')}`)
  assert.ok(!html.includes(`agent:${LIVE}`) && !html.includes(`agent:${STALE}`))
  assert.ok(panes.includes('hist:1'), 'a different conversation in the folder keeps its own row')
  assert.ok(!html.includes('agent:hist:1'), 'closed, it leaves the tree like any sleeping lead')

  // Ancestry: both leads directly under the root, each lead's workers under it.
  const of = (pane: string) => all.flatMap((r) => r.agents).find((a) => a.paneKey === pane)!
  assert.deepEqual([LEAD, RELEASE].map((p) => [of(p).coordinator, of(p).leadPane]), [['orca-flow', null], ['orca-flow', null]])
  assert.deepEqual(['9e1b6172:w', 'd49db763:w'].map((p) => [of(p).coordinator, of(p).leadPane]), [['orca-flow', LEAD], ['orca-flow', LEAD]])
  assert.deepEqual([of('rel-worker:1').coordinator, of('rel-worker:1').leadPane], ['orca-flow', RELEASE])
  for (const lead of [LEAD, RELEASE]) assert.match(html, new RegExp(`data-menu="agent:${lead}"[^>]*data-depth="0"`))
  for (const worker of ['9e1b6172:w', 'd49db763:w', 'rel-worker:1']) assert.match(html, new RegExp(`data-menu="agent:${worker}"[^>]*data-depth="1"`))
  assert.match(html, /data-menu="agent:0d1a7e82:release"[^]*?#52/, 'the release lead keeps its PR')
})
