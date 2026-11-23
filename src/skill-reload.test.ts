// Reload skills: who a click reaches, what the confirmation says, what the sidebar shows afterwards,
// and the request the worker writes. The hooks and the request store: test/skill-reload.test.mjs.
import { assert, test } from 'orca/testing'
import type { AgentInfo, AgentSummary, Coordinator, SkillReloadEntry, Snapshot, WorkspaceRow } from './protocol.ts'
import { confirmText, DONE_SHOWN_MS, reloadPlan, reloadSummary, rolesText, visibleReload } from './skill-reload.ts'
import { emptyUi, render, reloadMark, RELOAD_ALL, treeLabel } from './view.ts'
import { requestReload } from './worker.ts'

const summary = (over: Partial<AgentSummary>): AgentSummary => ({
  title: 'Work', goal: '', since: '', needs: { type: 'none', ask: '', options: [] }, effort: 'quick', priority: 'P2', role: 'solo', updatedAt: 1, ...over
})
const agent = (paneKey: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  paneKey, title: paneKey, state: 'working', agentType: 'claude', summary: null, workingMode: null, coordinator: 'you', leadPane: null, parentPane: null,
  orcaSession: null, dispatch: 'open', terminal: `term-${paneKey}`, question: null, live: true, ...over
})
const row = (id: string, agents: AgentInfo[], over: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  id, name: id, branch: id, repo: 'shop', path: `/w/${id}`, main: false, agents, state: agents[0]?.state ?? null, priority: null, card: null, parentId: null,
  liveTerminals: 1, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: 0, createdAt: 0, pr: null, ...over
})
const coordinator = (key: string, session: AgentInfo | null): Coordinator => ({ key, name: key, repos: [], workspaceId: `ws-${key}`, session })

// alpha: its session, a lead with two workers (one finished), a Codex worker, an asleep lead.
// beta: its session asleep (no live session), one lead. You: one chat.
const alphaHome = agent('p-alpha', { coordinator: 'alpha', dispatch: null, summary: summary({ role: 'coordinator', providerSession: { provider: 'claude', id: 'sess-alpha' } }) })
const lead = agent('p-lead', { coordinator: 'alpha', summary: summary({ role: 'lead' }) })
const worker = agent('p-w1', { coordinator: 'alpha', leadPane: 'p-lead' })
const finished = agent('p-w2', { coordinator: 'alpha', leadPane: 'p-lead', dispatch: 'settled', state: 'done' })
const codex = agent('p-codex', { coordinator: 'alpha', leadPane: 'p-lead', agentType: 'codex' })
const sleepy = agent('p-sleep', { coordinator: 'alpha', live: false, summary: summary({ role: 'lead' }) })
const betaLead = agent('p-blead', { coordinator: 'beta', summary: summary({ role: 'lead' }) })
const chat = agent('p-chat', { coordinator: 'you', dispatch: null })
const snap: Snapshot = {
  source: 'cli', capacity: null,
  coordinators: [coordinator('alpha', alphaHome), coordinator('beta', null)],
  rows: [
    row('lead', [lead, worker, finished, codex]),
    row('sleep', [sleepy], { folderOf: 'alpha', liveTerminals: 0 }),
    row('blead', [betaLead]),
    row('chat', [chat])
  ]
}

test('a coordinator\'s reload reaches its live session, leads and workers; finished and asleep ones are skipped, Codex is unsupported', () => {
  const plan = reloadPlan(snap, { coordinator: 'alpha' })
  assert.deepEqual(plan.targets.map((t) => [t.pane, t.role]), [['p-alpha', 'coordinator'], ['p-lead', 'lead'], ['p-w1', 'worker']])
  assert.equal(plan.targets[0].session, 'sess-alpha', 'the summary\'s Claude session id goes with it')
  assert.deepEqual(plan.unsupported.map((t) => [t.pane, t.provider]), [['p-codex', 'codex']])
  assert.deepEqual(plan.skipped, { finished: 1, asleep: 1 })
  assert.ok(!plan.targets.some((t) => t.pane === 'p-blead' || t.pane === 'p-chat'), 'nothing of another coordinator or your chats')
})

test('a sleeping coordinator\'s reload reaches only its live team; all reaches every team and your chats, each pane once', () => {
  const beta = reloadPlan(snap, { coordinator: 'beta' })
  assert.deepEqual(beta.targets.map((t) => t.pane), ['p-blead'])
  const all = reloadPlan({ ...snap, rows: [...snap.rows, row('dup', [lead])] }, 'all')
  assert.deepEqual(all.targets.map((t) => [t.pane, t.role]), [['p-alpha', 'coordinator'], ['p-lead', 'lead'], ['p-w1', 'worker'], ['p-blead', 'lead'], ['p-chat', 'chat']])
  assert.equal(all.unsupported.length, 1)
  assert.deepEqual(all.skipped, { finished: 1, asleep: 1 })
  assert.deepEqual(reloadPlan(snap, { coordinator: 'nobody' }), { targets: [], unsupported: [], skipped: { finished: 0, asleep: 0 } })
})

test('the confirmation names the exact count by role, the unsupported provider and what is skipped', () => {
  const { title, text, ok } = confirmText(reloadPlan(snap, 'all'), 'across all coordinators and your chats')
  assert.ok(ok)
  assert.equal(title, 'Reload skills in 5 agents across all coordinators and your chats?')
  assert.match(text, /^1 coordinator, 2 leads, 1 worker, 1 chat re-read their skill files at their next turn/)
  assert.match(text, /Nothing is typed into their terminals; their tasks, open asks and runs stay as they are\./)
  assert.match(text, /1 Codex session cannot reload: Orca Flow could not check its hooks in this Codex account; restart to reload\./, 'readiness unknown: not counted, said so')
  assert.match(text, /Skipped: 1 finished, 1 asleep or closed\./)
  const none = confirmText({ targets: [], unsupported: [{ pane: 'x', session: null, role: 'worker', provider: 'codex', supported: false, title: '', coordinator: 'c', reason: 'Codex: approve Orca Flow\'s hooks once; start Codex, choose Trust all and continue (or /hooks)' }, { pane: 'y', session: null, role: 'worker', provider: 'antigravity', supported: false, title: '', coordinator: 'c' }], skipped: { finished: 0, asleep: 0 } }, 'for c')
  assert.deepEqual([none.ok, none.title], [false, 'Nothing to reload for c'])
  assert.equal(none.text, 'No running session here can take a reload. 1 Codex session cannot reload: approve Orca Flow\'s hooks once; start Codex, choose Trust all and continue (or /hooks). 1 Antigravity session cannot reload: it has no live reload; restart to reload.')
  assert.equal(rolesText([{ role: 'worker' }, { role: 'lead' }, { role: 'worker' }]), '1 lead, 2 workers')
})

const entry = (pane: string, state: SkillReloadEntry['state'], over: Partial<SkillReloadEntry> = {}): SkillReloadEntry => ({ pane, state, role: 'worker', provider: 'claude', at: 1000, expiresAt: 1000 + 86_400_000, request: 'r1', ...over })

test('Codex sessions take the note only once its hooks are installed and trusted; until then they are unsupported with the reason, never requested', () => {
  const approve = 'Codex: approve Orca Flow\'s hooks once; start Codex, choose Trust all and continue (or /hooks)'
  const waiting = reloadPlan({ ...snap, codexReload: { ready: false, reason: approve } }, { coordinator: 'alpha' })
  assert.deepEqual(waiting.unsupported.map((t) => [t.pane, t.reason]), [['p-codex', approve]])
  assert.ok(!waiting.targets.some((t) => t.pane === 'p-codex'))
  const ready = reloadPlan({ ...snap, codexReload: { ready: true, reason: '' } }, { coordinator: 'alpha' })
  assert.deepEqual(ready.targets.map((t) => [t.pane, t.role]), [['p-alpha', 'coordinator'], ['p-lead', 'lead'], ['p-w1', 'worker'], ['p-codex', 'worker']])
  assert.deepEqual(ready.unsupported, [])
  assert.match(confirmText(ready, 'for alpha').text, /^1 coordinator, 1 lead, 2 workers re-read[^]* A Codex session started before you approved Orca Flow's hooks reloads only after a restart\./)
  assert.ok(!confirmText(reloadPlan(snap, { coordinator: 'beta' }), 'for beta').text.includes('Codex'), 'no Codex caveat without a Codex session')
  assert.match(reloadMark({ reloads: new Map([['p-codex', entry('p-codex', 'waiting', { provider: 'codex' })]]) }, 'p-codex'), /a Codex session started before you approved the hooks needs a restart/)
  // Its Codex thread id goes with it when the summary bound one.
  const bound = { ...codex, summary: summary({ role: 'worker', providerSession: { provider: 'codex', id: 'thread-1' } }) }
  const withThread = reloadPlan({ ...snap, rows: [row('lead', [lead, worker, finished, bound])], codexReload: { ready: true, reason: '' } }, { coordinator: 'alpha' })
  assert.equal(withThread.targets.find((t) => t.pane === 'p-codex')?.session, 'thread-1')
})

test('the summary counts reloaded, reading, waiting and unsupported apart; requested is never counted as reloaded', () => {
  const entries = [entry('a', 'reloaded', { doneAt: 2000 }), entry('b', 'reloaded', { doneAt: 2000 }), entry('c', 'reading'), entry('d', 'waiting'), entry('e', 'waiting'), entry('f', 'unsupported', { provider: 'codex' })]
  assert.equal(reloadSummary(entries), 'Skills: 2 reloaded · 1 reading · 2 waiting for next turn · 1 unsupported')
  assert.equal(reloadSummary([entry('d', 'waiting')]), 'Skills: 1 waiting for next turn')
  assert.equal(reloadSummary([]), '')
})

test('stale state disappears: done marks after a while, everything at expiry', () => {
  const entries = [entry('done', 'reloaded', { doneAt: 2000 }), entry('codex', 'unsupported'), entry('wait', 'waiting'), entry('old', 'waiting', { expiresAt: 5000 })]
  assert.deepEqual(visibleReload(entries, 3000).map((e) => e.pane), ['done', 'codex', 'wait', 'old'])
  assert.deepEqual(visibleReload(entries, 2000 + DONE_SHOWN_MS).map((e) => e.pane), ['wait'], 'a waiting one stays until it expires')
  assert.deepEqual(visibleReload(entries, 1000 + 86_400_000).map((e) => e.pane), [])
  assert.deepEqual(visibleReload(undefined, 0), [])
})

test('rows wear a small mark per state, and the heading carries the action and the summary', () => {
  const reloads = new Map([['p-w1', entry('p-w1', 'waiting')], ['p-lead', entry('p-lead', 'reloaded', { doneAt: 2000 })], ['p-codex', entry('p-codex', 'unsupported')]])
  assert.match(reloadMark({ reloads }, 'p-w1'), /class="srl srl-waiting"[^>]*data-tip="Reload waits for next turn"/)
  assert.match(reloadMark({ reloads }, 'p-lead'), /srl-reloaded/)
  assert.match(reloadMark({ reloads }, 'p-codex'), /Restart to reload skills/)
  const why = new Map([['p-codex', entry('p-codex', 'unsupported', { provider: 'codex', reason: 'Codex: approve Orca Flow\'s hooks once; start Codex, choose Trust all and continue (or /hooks)' })]])
  assert.match(reloadMark({ reloads: why }, 'p-codex'), /data-tip="Codex: approve Orca Flow&#39;s hooks once; start Codex, choose Trust all and continue \(or \/hooks\)"/, 'an unsupported row says why and what to do')
  assert.equal(reloadMark({ reloads }, 'p-other'), '')
  const label = treeLabel([...reloads.values()], emptyUi())
  assert.match(label, /data-reload-skills="all" aria-label="Reload skills in all running agents"/)
  assert.match(label, /class="reload-sum"[^]*Skills: 1 reloaded · 1 waiting for next turn · 1 unsupported/)
  const ui = emptyUi()
  ui.status.set(RELOAD_ALL, { text: 'Requesting…', tone: 'pending' })
  assert.match(treeLabel([...reloads.values()], ui), /Requesting…/)
  assert.ok(!treeLabel([], emptyUi()).includes('reload-sum'), 'no summary without a request')
  // In the whole panel: the coordinator's row and its worker's row carry their marks.
  const ui2 = emptyUi()
  ui2.now = 3000
  const main = render({ ...snap, skillReload: [entry('p-alpha', 'reading'), entry('p-w1', 'waiting')] }, ui2).main
  assert.match(main, /data-menu="coordinator:alpha"[^]*?srl-reading/)
  assert.match(main, /data-menu="agent:p-w1"[^]*?srl-waiting/)
  assert.match(main, /Skills: 1 reading · 1 waiting for next turn/)
})

test('the worker writes one request for the plan: supported targets with their session, unsupported ones marked, the hash and scope', () => {
  const writes: { targets: any[]; options: any }[] = []
  const r = requestReload(snap, { coordinator: 'alpha' }, '/skill', {
    data: '/data', hashOf: (skill) => `hash-of-${skill}`, now: 42,
    sessionOf: (pane) => (pane === 'p-lead' ? 'sess-lead' : null),
    write: ((data: string, targets: any[], options: any) => { writes.push({ targets, options }); assert.equal(data, '/data'); return { id: 'r', hash: options.hash, count: targets.length } }) as any
  })
  assert.deepEqual(r, { asked: 3, unsupported: 1, skipped: { finished: 1, asleep: 1 }, hash: 'hash-of-/skill' })
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].targets.map((t) => [t.pane, t.session, t.supported]), [['p-alpha', 'sess-alpha', true], ['p-lead', 'sess-lead', true], ['p-w1', null, true], ['p-codex', null, false]])
  assert.deepEqual(writes[0].options, { hash: 'hash-of-/skill', scope: 'coordinator:alpha', now: 42 })
  // Nothing supported: no request at all.
  const none = requestReload(snap, { coordinator: 'nobody' }, '/skill', { write: (() => { throw new Error('must not write') }) as any })
  assert.equal(none.asked, 0)
})
