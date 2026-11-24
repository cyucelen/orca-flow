// Browser-only fixture for the Goals section in the actual panel code. No plugin install, worker or goals files:
// `orca` is a stub that keeps the goals in memory and answers sidebar.goalAction the way the worker does
// (src/goals.ts: edits are "you"), and records every request in window.previewCalls.
//   node scripts/goals-preview.mjs                   serve; open the printed URL (add ?theme=light, ?open=<goal id>, ?add=1, ?showdone=1, ?fold=1)
//   node scripts/goals-preview.mjs --shots <dir>     capture the section, an open card, the add box and the done goals, dark and light, 360 px, then exit
//   node scripts/goals-preview.mjs --selftest        click through add, tick, edit next, mark done, reopen, confirm, "Not yet", Jump → and
//                                                    Assign → (hidden at rest, picker, Assigning…, delivery, then Jump →) in headless Chrome, then exit
//   --shots also captures the Next step pill with a real pointer hover (Chrome DevTools protocol): rows at rest, a hovered
//   row with Jump → and one with Assign →, the open picker and Assigning….
// The stub answers sidebar.goalAssign the way the worker does (src/goals.ts assignNext): pending at once, delivered
// after ?delay= ms (default 500), refused for a step already assigned or a Next text that changed, and a changed Next
// drops the assignment. sidebar.open answers opened: false for a terminal in window.previewGone.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { emptyHistory, speedView } from '../src/token-speed.ts'
import { goalAgents } from '../src/goals-view.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = mkdtempSync(join(tmpdir(), 'orca-flow-goals-preview-'))
execFileSync('npx', ['-y', 'esbuild', 'src/panel/app.ts', '--bundle', '--format=esm', '--tsconfig-raw={}', '--log-level=warning', `--outfile=${join(build, 'app.js')}`], { cwd: root, stdio: 'inherit' })

const now = Date.now()
const H = 3_600_000
const agent = (paneKey, agentType, over = {}) => ({
  paneKey, agentType, live: true, title: paneKey, state: 'working', workingMode: null, coordinator: 'home', leadPane: null, parentPane: null,
  orcaSession: null, dispatch: 'open', terminal: `term-${paneKey}`, question: null, summary: null, ...over
})
const wrow = (id, name, state, over = {}) => ({ id, name, branch: name, repo: 'bounti', path: `/fixture/${name}`, main: false, agents: [agent(`${name} lead`, 'claude', { state })], state, priority: null, card: null, parentId: null, liveTerminals: 1, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: now - H, createdAt: 1, pr: null, ...over })
const snapshot = {
  source: 'cli', capacity: null, ready: true, focusedPanes: [], features: { goals: true, linear: true, tokenSpeed: true },
  coordinators: [
    { key: 'home', name: 'bounti', repos: ['bounti'], workspaceId: 'folder:home', session: agent('Coordinator', 'claude', { state: 'done', dispatch: null }),
      sessions: { version: 1, current: 'm-home', members: [{ id: 'm-home', workspaceId: 'folder:home', orcaSession: 'conv-home', agentType: 'claude', title: 'bounti', paneKey: 'Coordinator', terminals: ['term-Coordinator'] }] } },
    { key: 'mono', name: 'mono', repos: ['mono'], workspaceId: 'folder:mono', session: agent('Mono coordinator', 'codex', { state: 'working', dispatch: null }),
      sessions: { version: 1, current: 'm-mono', members: [{ id: 'm-mono', workspaceId: 'folder:mono', orcaSession: 'conv-mono', agentType: 'codex', title: 'mono', paneKey: 'Mono coordinator', terminals: ['term-Mono coordinator'] }] } },
    { key: 'ops', name: 'ops (asleep)', repos: [], workspaceId: 'folder:ops', session: null }
  ],
  rows: [
    wrow('identity:des-340', 'des-340-super-admin-permissions', 'working', { linearIssue: 'DES-340' }),
    wrow('identity:bou-4206', 'bou-4206-aic-split-lessons', 'waiting', { linearIssue: 'BOU-4206' }),
    // Three live Codex agents that finished their turn and wait for review: the goal on this worktree still offers Jump →, to its lead.
    wrow('identity:des-360', 'des-360-onboarding-review', 'done', { linearIssue: 'DES-360', agents: [
      agent('des-360 lead', 'codex', { state: 'done' }),
      agent('des-360 worker 1', 'codex', { state: 'done', parentPane: 'des-360 lead' }),
      agent('des-360 worker 2', 'codex', { state: 'done', parentPane: 'des-360 lead' })
    ] })
  ]
}
const g = (id, title, over = {}) => ({
  id, title, steps: [], links: { linear: [], worktrees: [] }, status: 'open', createdAt: now - 5 * 24 * H, updatedAt: now - 2 * H, lastChange: { by: 'you', field: 'created', at: now - 5 * 24 * H }, livePanes: [], ...over
})
const goals = [
  g('g_super-admin', 'Ship super admin', {
    note: 'Super Admins see all News posts and documents, can moderate, and can oversee group chats without notifications. Custom roles moved to DES-354.',
    steps: [['Visibility fix in News and Documents', 1], ['Moderation rights (edit, delete, block)', 1], ['Group chat oversight without notifications', 0], ['Admin presence shown in chats', 0]].map(([text, d]) => ({ text, done: !!d })),
    next: 'Finish chat oversight without notifications', doneWhen: 'Super Admins see everything, can moderate, and the PR is merged',
    links: { linear: ['DES-340'], worktrees: [{ key: 'des-340', path: '/fixture/des-340-super-admin-permissions', name: 'mono/des-340-super-admin-permissions' }] },
    lastChange: { by: 'the DES-340 lead', field: 'next', at: now - 2 * H } }),
  g('g_lesson-splitting', 'Finish lesson splitting for AI course creation', {
    note: 'Short documents with several topics should become several short lessons. The Kaimug onboarding doc gave one lesson instead of five.',
    steps: [['Plan lessons by topic (PR #6277)', 1], ['Review feedback worked in', 0], ['Re-run the Kaimug document', 0]].map(([text, d]) => ({ text, done: !!d })),
    next: 'Answer review comments on PR #6277', doneWhen: 'The Kaimug document gives more than 1 lesson, each covering 1 topic',
    links: { linear: ['BOU-4206', 'BOU-4116', 'BOU-4115'], worktrees: [{ key: 'bou-4206', name: 'mono/bou-4206-aic-split-lessons' }] },
    lastChange: { by: 'you', field: 'next', at: now - 26 * H } }),
  g('g_shift-scheduling', 'Shift scheduling rule set templates for Germany and Austria, for lawyer review', {
    note: 'Documents go to our lawyer. Nothing to build, so no ticket and no worktree.',
    steps: ['Germany template drafted', 'Austria template drafted', 'Sent to the lawyer', 'Lawyer feedback worked in'].map((text) => ({ text, done: false })),
    next: 'Draft the Germany template', doneWhen: 'Both templates sent to the lawyer, and their feedback is in', lastChange: { by: 'you', field: 'next', at: now - 20 * 60_000 } }),
  g('g_planning-assistance', 'Plan "planning assistance" for shift scheduling by studying other products', {
    note: 'Research that leads to a plan. Look at how other scheduling tools suggest or auto-fill shifts.',
    steps: ['List 5 products to analyze', 'Write down what each one automates', 'Draft the feature plan'].map((text) => ({ text, done: false })),
    next: 'List 5 products to analyze', doneWhen: 'A written plan for the feature, ready to turn into tickets', lastChange: { by: 'you', field: 'next', at: now - 2 * 24 * H } }),
  g('g_onboarding-review', 'Ship the onboarding fix', {
    steps: [['Fix the empty state', 1], ['Review the PR', 0]].map(([text, d]) => ({ text, done: !!d })),
    next: 'Review the PR and merge it', links: { linear: ['DES-360'], worktrees: [{ key: 'des-360', name: 'mono/des-360-onboarding-review' }] },
    lastChange: { by: 'the DES-360 lead', field: 'next', at: now - 30 * 60_000 } }),
  g('g_pdf-export', 'Fix PDF export timeouts on large schedules', {
    steps: [['Reproduce with the 200-shift schedule', 1], ['Stream the render', 1], ['Add a regression test', 1]].map(([text, d]) => ({ text, done: !!d })),
    next: 'Merge the PR', doneWhen: 'A 200-shift schedule exports in under 10 s', status: 'proposed', links: { linear: ['BOU-4300'], worktrees: [] },
    lastChange: { by: 'the BOU-4300 lead', field: 'status', at: now - 40 * 60_000 } }),
  g('g_lawyer-intro', 'Intro call with the Germany lawyer', { status: 'done', doneAt: now - 3 * 24 * H, steps: [{ text: 'Book the call', done: true }], lastChange: { by: 'you', field: 'status', at: now - 3 * 24 * H } })
]
// Who is on each goal, by the worker's own rule (goals-view.ts goalAgents): the live agents on its linked worktrees.
for (const x of goals) x.livePanes = goalAgents(x, snapshot.rows).map(({ a }) => a.paneKey)
const LIGHT = { '--orca-background': '#f7f7f9', '--orca-foreground': '#1c1c20', '--orca-muted-foreground': '#5f5f69', '--orca-border': '#e1e1e7', '--orca-accent': '#ececf0', '--orca-popover': '#ffffff', '--orca-popover-foreground': '#1c1c20' }
const bridge = `<style>.tip { transition: none !important; }</style><script>
const q = new URLSearchParams(location.search);
if (q.get('theme') === 'light') { document.documentElement.classList.add('light'); for (const [k, v] of Object.entries(${JSON.stringify(LIGHT)})) document.documentElement.style.setProperty(k, v); }
const snapshot = ${JSON.stringify(snapshot)};
let goals = ${JSON.stringify(goals)};
const listeners = {};
const stored = {};
if (q.get('fold')) stored['goals-ui'] = { folded: true };
if (q.get('showdone')) stored['goals-ui'] = { folded: false, showDone: true };
if (q.get('empty')) goals = [];
// What the worker does for a panel edit (src/goals.ts over goals.mjs): changes the goal, stamps "you" and now.
const stamp = (x, field) => Object.assign(x, { updatedAt: Date.now(), lastChange: { by: 'you', field, at: Date.now() } });
const apply = (a) => {
  const x = goals.find((y) => y.id === a.id);
  if (a.action === 'add') { if (!a.title.trim()) return 'a goal needs a title'; const n = { id: 'g_' + Math.random().toString(36).slice(2, 8), title: a.title.trim(), steps: [], links: { linear: [], worktrees: [] }, status: 'open', createdAt: Date.now(), livePanes: [] }; stamp(n, 'created'); goals.push(n); return null; }
  if (!x) return 'no goal ' + a.id;
  if (a.action === 'update') { const f = []; for (const [k, v] of Object.entries(a.patch)) { if (k === 'title' && !v.trim()) return 'a goal needs a title'; if (v.trim() !== (x[k] ?? '')) { v.trim() ? (x[k] = v.trim()) : delete x[k]; f.push(k); } } if (f.includes('next')) x.assigned = null; if (f.length) stamp(x, f.join(',')); }
  else if (a.action === 'step') { x.steps[a.step - 1].done = a.done; stamp(x, 'steps'); }
  else if (a.action === 'addStep') { x.steps.push({ text: a.text, done: false }); stamp(x, 'steps'); }
  else if (a.action === 'done' || a.action === 'confirm') { x.status = 'done'; x.doneAt = Date.now(); x.livePanes = []; stamp(x, 'status'); }
  else if (a.action === 'reopen' || (a.action === 'reject' && x.status === 'proposed')) { x.status = 'open'; delete x.doneAt; stamp(x, 'status'); }
  return null;
};
// Assign to coordinator, as the worker does it (src/goals.ts assignNext over goals.mjs beginAssign / finishAssign).
const delay = Number(q.get('delay') ?? 500);
const post = () => { const out = JSON.parse(JSON.stringify(goals)); (listeners['sidebar.goalsChanged'] || []).forEach((f) => f(out)); };
const assign = async ({ id, coordinator, next }) => {
  const x = goals.find((y) => y.id === id);
  const c = snapshot.coordinators.find((y) => y.key === coordinator);
  if (!x || !c?.session) return 'The selected conversation is offline. Choose an open session first.';
  if (x.next !== next) return 'The next step changed; nothing was sent. Look at the new step and assign it again.';
  if (x.assigned && x.assigned.next === x.next) return x.assigned.state === 'pending' ? 'This step is already being sent to ' + x.assigned.name + '.' : 'This step is already assigned to ' + x.assigned.name + '.';
  const token = Math.random().toString(36);
  x.assigned = { coordinator, name: c.name, next, state: 'pending', at: Date.now(), by: 'you', token, session: { workspaceId: c.workspaceId, terminal: c.session.terminal, paneKey: c.session.paneKey } };
  previewDelivered.push({ id, coordinator, next, title: x.title });
  post();
  await new Promise((r) => setTimeout(r, delay));
  if (x.assigned?.token !== token || x.next !== next) return 'The next step changed while it was being sent: the coordinator got the old step, and the new one is not assigned.';
  x.assigned = { ...x.assigned, state: 'delivered', deliveredAt: Date.now() };
  post();
  return null;
};
window.previewDelivered = [];
window.previewGone = new Set();
window.previewCalls = [];
const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason?.stack || e.reason)));
window.orca = {
  plugin: {
    request: async (name, data) => {
      previewCalls.push({ name, data });
      if (name === 'sidebar.list') return snapshot;
      if (name === 'sidebar.goals') return JSON.parse(JSON.stringify(goals));
      if (name === 'sidebar.open') return { opened: !previewGone.has(data.terminal) };
      if (name === 'sidebar.goalAssign') { const error = await assign(data); return { ok: !error, ...(error ? { error } : {}), goals: JSON.parse(JSON.stringify(goals)) }; }
      if (name === 'sidebar.goalAction') { const error = apply(data); const out = JSON.parse(JSON.stringify(goals)); if (!error) setTimeout(() => (listeners['sidebar.goalsChanged'] || []).forEach((f) => f(out)), 0); return { ok: !error, ...(error ? { error } : {}), goals: out }; }
      if (name === 'sidebar.settings') return { settings: {}, error: null, version: null, writers: [] };
      if (name === 'sidebar.tokenSpeed') return ${JSON.stringify(speedView(emptyHistory(), now, { ready: true }))};
      return null;
    },
    on: (name, f) => { (listeners[name] ||= []).push(f); return () => {}; }
  },
  storage: { get: async (k) => stored[k] ?? null, set: async (k, v) => { stored[k] = v; previewCalls.push({ name: 'storage.set', data: { k, v } }); } }, shell: { openExternal: async () => {} }
};
// ?click=<selector>[,<selector>...]: click those in turn after the page shows (for screenshots).
if (q.get('click')) setTimeout(async () => { for (const s of q.get('click').split('|')) { const el = document.querySelector(s); el?.click(); await new Promise((r) => setTimeout(r, 150)); } }, 500);
// ?type=<text>: type it into the add box (after ?click opened it).
if (q.get('type')) setTimeout(() => { const i = document.getElementById('goal-new'); if (i) { i.value = q.get('type'); } }, 900);
if (q.get('selftest')) window.addEventListener('load', () => setTimeout(async () => {
  const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const log = [], fail = [];
  const ok = (c, m) => { log.push((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail.push(m); };
  const row = (id) => $('[data-gopen="' + id + '"]');
  const titles = () => [...document.querySelectorAll('#goals-rows .g .ti')].map((e) => e.textContent);
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const edit = async (field, text, how = 'blur') => { const el = $('#goalpop [data-gedit="' + field + '"]'); el.focus(); el.textContent = text; if (how === 'enter') key(el, 'Enter'); else el.blur(); await wait(); };
  try {
    await wait(300);
    ok(document.querySelector('#goals-head .lfold span').textContent === 'Goals' && $('#goals-head .gc').textContent === '6', 'header: Goals 6');
    ok(!!$('[aria-label="View completed goals"]'), 'Completed is accessible from the Goals header');
    const faces = (id) => row(id).querySelectorAll('.who .sav svg.ch').length;
    ok(faces('g_super-admin') === 1 && faces('g_lesson-splitting') === 1 && faces('g_onboarding-review') === 3 && faces('g_shift-scheduling') === 0, 'avatars for every live agent on a goal (working, asking or done), none without a linked worktree');
    ok(!document.querySelector('#goals-rows [data-tip]'), 'no tooltips on goal rows');
    ok(row('g_super-admin').querySelector('.cnt').textContent === '2/4' && row('g_super-admin').querySelector('.nx').textContent.startsWith('Finish chat'), 'row: count 2/4 and next');
    ok(row('g_pdf-export').querySelector('.nx').textContent === 'lead says done', 'proposed row says "lead says done"');
    ok(!titles().includes('Intro call with the Germany lawyer'), 'done goal hidden');
    // fold
    $('[data-gfold]').click(); await wait(); ok(titles().length === 0 && previewCalls.some((c) => c.name === 'storage.set' && c.data.v.folded === true), 'fold hides rows and is stored');
    $('[data-gfold]').click(); await wait(); ok(titles().length === 6, 'unfold shows 6');
    // add
    $('[data-gadd]').click(); await wait(); const inp = $('#goal-new'); ok(!$('#goal-add').hidden && document.activeElement === inp, 'add box opens focused');
    key(inp, 'Escape'); await wait(); ok($('#goal-add').hidden, 'Esc cancels the add box');
    $('[data-gadd]').click(); await wait(); $('#goal-new').value = 'Hire a designer'; key($('#goal-new'), 'Enter'); await wait(300);
    ok(titles().includes('Hire a designer') && previewCalls.some((c) => c.name === 'sidebar.goalAction' && c.data.action === 'add' && c.data.title === 'Hire a designer') && $('#goal-add').hidden, 'Enter adds a goal');
    // open card, tick, edit next
    row('g_shift-scheduling').click(); await wait();
    ok(!$('#goalpop').hidden && !$('#goalpop .meta'), 'click opens the card, with no last-change line');
    ok(document.activeElement === $('#goalpop'), 'opening a goal focuses the dialog, leaving the title out of edit mode');
    const fields = [...document.querySelectorAll('#goalpop .k')].map((label) => label.textContent.split(' · ')[0]);
    ok(fields.join(',') === 'Description,Done criteria,Next,Todos,Links', 'goal details follow reading order');
    $('#goalpop [data-gstep="1"]').click(); await wait(300);
    ok($('#goalpop [data-gstep="1"]').getAttribute('aria-checked') === 'true' && row('g_shift-scheduling').querySelector('.cnt').textContent === '1/4', 'tick a step: card and row count follow');
    await edit('next', 'Draft the Austria template', 'enter'); await wait(250);
    ok(row('g_shift-scheduling').querySelector('.nx').textContent === 'Draft the Austria template', 'edit next (Enter) saves; the row shows it');
    await edit('note', 'Sent to the lawyer by Friday'); await wait(250);
    ok(previewCalls.some((c) => c.data?.patch?.note === 'Sent to the lawyer by Friday'), 'edit note on blur saves');
    // a live repaint while typing keeps the focus and the text
    const nx = $('#goalpop [data-gedit="next"]'); nx.focus(); nx.textContent = 'half typed';
    listeners['sidebar.goalsChanged'].forEach((f) => f(JSON.parse(JSON.stringify(goals)))); window.dispatchEvent(new Event('resize')); await wait(150);
    ok(document.activeElement === $('#goalpop [data-gedit="next"]') && $('#goalpop [data-gedit="next"]').textContent === 'half typed', 'a repaint keeps focus and unsaved text in an open card');
    nx.blur(); await wait(250);
    // add a step with Enter
    const as = $('#goalpop [data-gedit="newStep"]'); as.focus(); as.textContent = 'Lawyer answered'; key(as, 'Enter'); await wait(300);
    ok($('#goalpop .steps').children.length === 5 && document.activeElement === $('#goalpop [data-gedit="newStep"]'), 'add a step: listed, focus stays for the next');
    // Esc closes
    key(document.body, 'Escape'); await wait(); ok($('#goalpop').hidden, 'Esc closes the card');
    // Hit-test an actual control behind the card, as a pointer would.
    row('g_shift-scheduling').click(); await wait();
    const settings = $('#settings-open');
    const bounds = settings.getBoundingClientRect();
    const point = { clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, bubbles: true };
    const hit = document.elementFromPoint(point.clientX, point.clientY);
    ok(!settings.contains(hit), 'backdrop intercepts a pointer over Settings');
    settings.focus(); ok(document.activeElement !== settings, 'background controls cannot take focus');
    for (const type of ['pointerdown', 'pointerup', 'click']) hit.dispatchEvent(new PointerEvent(type, point));
    await wait(); ok($('#goalpop').hidden && $('#settings').hidden, 'clicking over Settings dismisses only the goal card');
    // mark done
    row('g_planning-assistance').click(); await wait(); $('#goalpop [data-gfinish]').click(); await wait(300);
    ok($('#goalpop').hidden && !row('g_planning-assistance'), 'Mark done removes the goal from the active list');
    $('[data-gdone]').click(); await wait();
    const historyQuery = $('#goal-history-query');
    ok(titles().length === 2 && row('g_planning-assistance') && !row('g_pdf-export'), 'Completed shows only confirmed goals');
    historyQuery.value = 'LAWYER'; historyQuery.dispatchEvent(new Event('input')); await wait();
    ok(titles().length === 1 && row('g_lawyer-intro') && document.activeElement === historyQuery, 'search finds completed titles and retains focus');
    historyQuery.value = 'no such goal'; historyQuery.dispatchEvent(new Event('input')); await wait();
    ok($('#goals-rows').textContent.includes('No matching goals'), 'empty search feedback');
    historyQuery.value = ''; historyQuery.dispatchEvent(new Event('input')); await wait();
    row('g_lawyer-intro').click(); await wait(); ok(!!$('#goalpop [data-greopen]') && !$('#goalpop [data-gfinish]'), 'a completed goal offers Reopen');
    $('#goalpop [data-greopen]').click(); await wait(300);
    ok(!row('g_lawyer-intro'), 'reopened goal leaves completed history');
    $('[data-gdone]').click(); await wait();
    ok(row('g_lawyer-intro').querySelector('.nx'), 'reopened goal is back in the active list');
    row('g_pdf-export').click(); await wait(); ok(!!$('#goalpop [data-gconfirm]') && !!$('#goalpop [data-gnot]') && !$('#goalpop [data-gfinish]'), 'proposed card offers Confirm done / Not yet');
    $('#goalpop [data-gconfirm]').click(); await wait(300); ok(!row('g_pdf-export'), 'Confirm done moves the goal out of active goals');
    // not yet on a fresh proposal
    goals.find((x) => x.id === 'g_lesson-splitting').status = 'proposed'; listeners['sidebar.goalsChanged'].forEach((f) => f(JSON.parse(JSON.stringify(goals)))); await wait();
    row('g_lesson-splitting').click(); await wait(); $('#goalpop [data-gnot]').click(); await wait(300);
    ok(row('g_lesson-splitting').querySelector('.nx').textContent.startsWith('Answer review') && $('#goalpop').hidden, '"Not yet" sends it back to open');
    // empty title is refused
    row('g_lesson-splitting').click(); await wait(); await edit('title', '   '); await wait(); ok($('#goalpop [data-gedit="title"]').textContent.startsWith('Finish lesson splitting'), 'an emptied title reverts');
    key(document.body, 'Escape'); await wait();
    for (let i = 1; i <= 40; i++) goals.push({ ...goals[0], id: 'history-' + i, title: 'Past goal ' + i, status: 'done', doneAt: Date.now() - i * 3600000 });
    listeners['sidebar.goalsChanged'].forEach((f) => f(JSON.parse(JSON.stringify(goals))));
    $('[data-gdone]').click(); await wait();
    ok(titles().length === 20 && !!$('[data-gmore]'), 'large history opens with 20 rows');
    historyQuery.value = 'Past goal 40'; historyQuery.dispatchEvent(new Event('input')); await wait();
    ok(titles().length === 1 && row('history-40'), 'search reaches past the first batch');
    historyQuery.value = ''; historyQuery.dispatchEvent(new Event('input')); await wait();
    $('[data-gmore]').click(); await wait();
    ok(titles().length === 40, 'Show more reveals the next batch');

    // ---------- the Next step's button ----------
    $('[data-gdone]').click(); await wait();
    const act = (id) => $('[data-gopen="' + id + '"]')?.parentElement?.querySelector(':scope > .gact');
    const word = (id) => act(id)?.textContent.trim();
    const shown = (id) => !!act(id) && getComputedStyle(act(id)).display !== 'none';
    // The width the row's button gives up for the pill, and whether the cluster is one row centered in the goal row:
    // avatar, progress ring and pill share one vertical center, which is the row's center (within 1 px), the pill comes
    // after the ring, and the title and the Next text both end before the cluster.
    const room = (id) => Math.round(act(id).parentElement.getBoundingClientRect().width - row(id).getBoundingClientRect().width);
    const oneLine = (id) => {
      const r = (el) => el.getBoundingClientRect(), mid = (b) => b.top + b.height / 2;
      const box = r(act(id).parentElement), p = r(act(id)), ring = r(row(id).querySelector('.gprogress')), ti = r(row(id).querySelector('.ti')), nx = r(row(id).querySelector('.nx'));
      const who = row(id).querySelector('.who') && r(row(id).querySelector('.who'));
      const center = mid(box), first = who || ring;
      const checks = { pillAtRowCenter: Math.abs(mid(p) - center) <= 1, ringAtRowCenter: Math.abs(mid(ring) - center) <= 1, avatarAtRowCenter: !who || Math.abs(mid(who) - center) <= 1,
        pillAfterRing: p.left >= ring.right + 2, titleBeforeCluster: ti.right <= first.left, nextBeforeCluster: nx.right <= first.left, pillInRow: p.right <= box.right };
      const bad = Object.keys(checks).filter((k) => !checks[k]);
      return bad.length ? 'not one centered row: ' + bad.join(', ') + ' ' + JSON.stringify({ box: [box.top, box.bottom], p: [p.left, p.top, p.right, p.bottom], ring: [ring.left, ring.top, ring.right, ring.bottom] }) : '';
    };
    ok(word('g_super-admin') === 'Jump' && word('g_lesson-splitting') === 'Jump' && !!act('g_super-admin').querySelector('svg'), 'Jump → for a working agent and for one waiting for the user');
    ok(word('g_shift-scheduling') === 'Assign', 'Assign → when nobody is on the step');
    ok(word('g_onboarding-review') === 'Jump' && act('g_onboarding-review').getAttribute('aria-label') === 'Jump to des-360 lead' && faces('g_onboarding-review') === 3, 'agents that are done but live still count: their avatars, and Jump → to the worktree lead');
    ok([...document.querySelectorAll('#goals-rows .gline')].every((l) => !!l.querySelector('.who') === !!l.querySelector('[data-gjump]') || !!l.querySelector('.gact.rstatus')), 'every goal with avatars offers Jump →, every goal without offers Assign →');
    ok(act('g_super-admin').classList.contains('send') && act('g_super-admin').classList.contains('pill') && act('g_super-admin').getAttribute('aria-label').startsWith('Jump to ') && act('g_shift-scheduling').getAttribute('aria-label') === 'Assign the next step to a coordinator', 'the Linear Send pill, the full meaning in the label');
    ok(!shown('g_super-admin') && !shown('g_shift-scheduling') && room('g_super-admin') === 0 && room('g_shift-scheduling') === 0, 'at rest: no buttons, the row button (title and Next) has the whole width');
    row('g_shift-scheduling').focus({ focusVisible: true }); await wait();
    ok(shown('g_shift-scheduling') && room('g_shift-scheduling') > 0 && !shown('g_super-admin'), 'keyboard focus on a row shows its button and makes room for it');
    let line = oneLine('g_shift-scheduling');
    ok(!line, 'Assign → shares one centered row with the progress ring; title and Next end before it ' + line);
    row('g_shift-scheduling').blur(); await wait();
    row('g_super-admin').focus({ focusVisible: true }); await wait();
    line = oneLine('g_super-admin');
    ok(shown('g_super-admin') && !line, 'Jump → after the avatar and the progress ring, one row centered in the goal row ' + line);
    row('g_super-admin').blur(); await wait();
    ok(!act('g_lawyer-intro') && !row('g_lawyer-intro').closest('.gline'), 'no button for a goal with no Next step');
    ok(!$('.gact[data-gjump="g_pdf-export"],.gact[data-gassign="g_pdf-export"]'), 'no button for a done goal');
    // Jump to agent: reads the snapshot again, then focuses the exact pane; the card stays closed.
    let before = previewCalls.length;
    act('g_super-admin').click(); await wait(200);
    let calls = previewCalls.slice(before);
    const open1 = calls.find((c) => c.name === 'sidebar.open');
    before = previewCalls.length;
    act('g_onboarding-review').click(); await wait(200);
    const openDone = previewCalls.slice(before).find((c) => c.name === 'sidebar.open');
    ok(openDone?.data.workspaceId === 'identity:des-360' && openDone?.data.terminal === 'term-des-360 lead', 'Jump → on the done-only worktree focuses its lead');
    ok(calls[0]?.name === 'sidebar.list' && open1?.data.workspaceId === 'identity:des-340' && open1?.data.terminal === 'term-des-340-super-admin-permissions lead', 'Jump to agent re-reads the snapshot and focuses the pane of the working agent');
    ok($('#goalpop').hidden, 'pressing the button does not open the card');
    // A session that is gone: no dead pane is focused; the toast says so and the button offers Assign.
    previewGone.add('term-bou-4206-aic-split-lessons lead');
    act('g_lesson-splitting').click(); await wait(200);
    ok(/gone/.test($('#toast').textContent) && !$('#toast').hidden && word('g_lesson-splitting') === 'Assign', 'a gone session: said briefly, button falls back to Assign to coordinator');
    // Assign to coordinator: the picker lists the coordinators with a live session, with their provider logo.
    act('g_shift-scheduling').click(); await wait();
    const items = [...document.querySelectorAll('#ctx .mi')];
    ok(!$('#ctx').hidden && $('#ctx .mh').textContent === 'Assign next step to' && items.map((b) => b.textContent).join(',') === 'bounti,mono' && items.every((b) => b.querySelector('.provider svg')), 'picker: live coordinators only, name + provider logo');
    ok($('#goalpop').hidden, 'the picker does not open the card');
    const menuAt = $('#ctx').getBoundingClientRect(), rowAt = act('g_shift-scheduling').parentElement.getBoundingClientRect();
    ok(menuAt.top >= rowAt.bottom - 1 || menuAt.bottom <= rowAt.top + 1, 'the picker opens next to the goal row');
    ok(act('g_shift-scheduling').parentElement.classList.contains('menu-open') && shown('g_shift-scheduling') && !oneLine('g_shift-scheduling') && act('g_shift-scheduling').getAttribute('aria-expanded') === 'true', 'the button stays shown while its picker is open');
    const step = goals.find((y) => y.id === 'g_shift-scheduling').next;
    before = previewCalls.length;
    items[0].click(); await wait(60);
    const pend = act('g_shift-scheduling');
    ok(pend?.textContent === 'Assigning…' && pend.tagName === 'SPAN' && shown('g_shift-scheduling') && room('g_shift-scheduling') > 0 && !oneLine('g_shift-scheduling'), 'Assigning… shows without hover, in the centered cluster, while it is sent, and there is nothing to press ' + oneLine('g_shift-scheduling'));
    const req = previewCalls.slice(before).find((c) => c.name === 'sidebar.goalAssign');
    ok(req?.data.id === 'g_shift-scheduling' && req.data.coordinator === 'home' && req.data.next === step && previewDelivered.at(-1)?.next === step, 'delivery request carries the exact Next text: ' + JSON.stringify(req?.data));
    await wait(700);
    ok(word('g_shift-scheduling') === 'Jump' && !shown('g_shift-scheduling'), 'after delivery: Jump →, hidden again until hover');
    row('g_shift-scheduling').click(); await wait();
    ok(/Assigned to bounti/.test($('#goalpop [data-part="next"]').textContent), 'the card names the coordinator the step went to');
    key(document.body, 'Escape'); await wait();
    before = previewCalls.length;
    act('g_shift-scheduling').click(); await wait(200);
    const open2 = previewCalls.slice(before).find((c) => c.name === 'sidebar.open');
    ok(open2?.data.workspaceId === 'folder:home' && open2?.data.terminal === 'term-Coordinator', 'Jump to agent focuses the current session of the coordinator');
    // A second assign of the same step is refused by the worker (two panels).
    const dup = await orca.plugin.request('sidebar.goalAssign', { id: 'g_shift-scheduling', coordinator: 'mono', next: step });
    ok(!dup.ok && /already assigned/.test(dup.error) && previewDelivered.length === 1, 'a second assign of the same step is refused');
    // The Next text changes: the old assignment does not apply to the new step.
    row('g_shift-scheduling').click(); await wait(); await edit('next', 'Send both templates to the lawyer', 'enter'); await wait(250);
    key(document.body, 'Escape'); await wait();
    ok(word('g_shift-scheduling') === 'Assign', 'a new Next step goes back to Assign →');
    // A late answer for an old step does not mark the new one.
    act('g_shift-scheduling').click(); await wait(); document.querySelectorAll('#ctx .mi')[1].click(); await wait(60);
    goals.find((y) => y.id === 'g_shift-scheduling').next = 'Changed meanwhile'; listeners['sidebar.goalsChanged'].forEach((f) => f(JSON.parse(JSON.stringify(goals)))); await wait(800);
    ok(word('g_shift-scheduling') === 'Assign' && /changed while it was being sent/.test($('#toast').textContent), 'a late delivery answer for the old text leaves the new step unassigned');

  } catch (e) { fail.push('exception ' + e.message); log.push('EXC ' + e.stack); }
  if (errors.length) { fail.push('page errors'); log.push(...errors.map((m) => 'ERR ' + m)); }
  document.title = (fail.length ? 'SELFTEST FAIL ' + fail.length : 'SELFTEST PASS ' + log.length) + '\\n' + log.join('\\n');
  const pre = document.createElement('pre'); pre.id = 'selftest'; pre.textContent = (fail.length ? 'SELFTEST FAIL ' + fail.length : 'SELFTEST PASS ' + log.length) + '\\n' + log.join('\\n'); document.body.append(pre);
}, 600));
</script>`
const html = readFileSync(join(root, 'src/panel/index.html'), 'utf8')
  .replace('<head>', '<head><title>Goals fixture · Orca Flow</title>')
  .replace('<script type="module" src="./app.ts"></script>', `${bridge}<script type="module" src="./app.js"></script>`)
const assets = new Map([
  ['/', ['text/html', html]],
  ['/panel.css', ['text/css', readFileSync(join(root, 'src/panel/panel.css'))]],
  ['/app.js', ['text/javascript', readFileSync(join(build, 'app.js'))]]
])
rmSync(build, { recursive: true, force: true })
// Chrome will not size a window under ~500 px, so the narrow panel renders in an iframe of exactly that size.
const frame = (q) => `<!doctype html><body style="margin:0;background:#888;display:flex;justify-content:center;align-items:center;min-height:100vh"><iframe src="/?${q}" style="border:0;display:block;flex:none;width:${new URLSearchParams(q).get('w')}px;height:${new URLSearchParams(q).get('h')}px"></iframe>`
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/frame') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(frame(url.searchParams.toString())); return }
  const asset = assets.get(url.pathname)
  if (!asset) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': asset[0] }); res.end(asset[1])
})

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const shots = process.argv.indexOf('--shots')
server.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}/`
  if (process.argv.includes('--selftest')) {
    const profile = mkdtempSync(join(tmpdir(), 'orca-flow-chrome-'))
    execFile(chrome, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--window-size=600,800', '--virtual-time-budget=20000', '--dump-dom', `${base}?selftest=1`], { timeout: 60_000, maxBuffer: 20e6 }, (e, out) => {
      const m = /<pre id="selftest">([\s\S]*?)<\/pre>/.exec(out ?? '')
      const text = m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : `no result (${e?.message ?? 'page did not finish'})`
      console.log(text)
      if (!m || text.startsWith('SELFTEST FAIL')) process.exitCode = 1
      server.close(); rmSync(profile, { recursive: true, force: true })
    })
    return
  }
  if (shots < 0) return console.log(`Goals fixture: ${base}?theme=dark`)
  const out = process.argv[shots + 1] || '/tmp/orca-goals-shots'
  mkdirSync(out, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'orca-flow-chrome-'))
  const W = 360
  const jobs = []
  for (const theme of ['dark', 'light']) {
    jobs.push({ theme, name: 'section', h: 760 })
    jobs.push({ theme, name: 'card', h: 760, click: '[data-gopen="g_super-admin"]' })
    jobs.push({ theme, name: 'card-proposed', h: 760, click: '[data-gopen="g_pdf-export"]' })
    jobs.push({ theme, name: 'add', h: 760, click: '[data-gadd]', type: 'Book the lawyer call for next week' })
    jobs.push({ theme, name: 'done-shown', h: 760, showdone: true })
    jobs.push({ theme, name: 'empty', h: 360, empty: true })
  }
  // The Next step pill shows on :hover, which a plain --screenshot cannot reach: these drive Chrome over the DevTools
  // protocol and move the pointer onto the row (no click), at exactly 360 px.
  const hovers = []
  for (const theme of ['dark', 'light']) {
    hovers.push({ theme, name: 'next-rest', h: 420 })
    hovers.push({ theme, name: 'next-hover-jump', h: 420, hover: '[data-gopen="g_super-admin"] .ti' })
    hovers.push({ theme, name: 'next-hover-assign', h: 420, hover: '[data-gopen="g_shift-scheduling"] .ti' })
    hovers.push({ theme, name: 'next-hover-done-agents', h: 760, hover: '[data-gopen="g_onboarding-review"] .ti' })
    hovers.push({ theme, name: 'next-picker', h: 420, click: '[data-gassign="g_shift-scheduling"]' })
    hovers.push({ theme, name: 'next-assigning', h: 420, click: '[data-gassign="g_shift-scheduling"]|#ctx .mi', delay: 60000 })
  }
  const cdpShots = async () => {
    const cdpProfile = mkdtempSync(join(tmpdir(), 'orca-flow-chrome-cdp-'))
    const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${cdpProfile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' })
    try {
      let port
      for (let i = 0; i < 100 && !port; i++) {
        try { port = readFileSync(join(cdpProfile, 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { await sleep(100) }
      }
      if (!port) throw new Error('Chrome did not open its DevTools port')
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((r, x) => { ws.onopen = r; ws.onerror = x })
      let id = 0
      const waiting = new Map()
      const events = []
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id) } else if (d.method) events.push(d.method) }
      const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
      await send('Page.enable')
      for (const j of hovers) {
        await send('Emulation.setDeviceMetricsOverride', { width: W, height: j.h, deviceScaleFactor: 1, mobile: false })
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: W - 1, y: j.h - 1 })
        events.length = 0
        const query = `theme=${j.theme}${j.click ? `&click=${encodeURIComponent(j.click)}` : ''}${j.delay ? `&delay=${j.delay}` : ''}`
        await send('Page.navigate', { url: `${base}?${query}` })
        for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); i++) await sleep(50)
        await sleep(j.click ? 1300 : 900)
        if (j.hover) {
          const r = await send('Runtime.evaluate', { expression: `(() => { const b = document.querySelector(${JSON.stringify(j.hover)}).getBoundingClientRect(); return JSON.stringify({ x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2 }) })()`, returnByValue: true })
          const at = JSON.parse(r.result.result.value)
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
          await sleep(300)
        }
        const shot = await send('Page.captureScreenshot', { format: 'png' })
        const file = join(out, `goals-${j.name}-${j.theme}-${W}.png`)
        writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
        console.log(file)
      }
      ws.close()
    } finally {
      proc.kill()
      await sleep(300)
      rmSync(cdpProfile, { recursive: true, force: true })
    }
  }
  const run = async () => {
    await cdpShots()
    for (const j of jobs) {
      const file = join(out, `goals-${j.name}-${j.theme}-${W}.png`)
      await new Promise((resolve, reject) => {
        const query = `theme=${j.theme}${j.click ? `&click=${encodeURIComponent(j.click)}` : ''}${j.type ? `&type=${encodeURIComponent(j.type)}` : ''}${j.showdone ? '&showdone=1' : ''}${j.empty ? '&empty=1' : ''}${j.delay ? `&delay=${j.delay}` : ''}`
        const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--window-size=${W + 240},${j.h + 100}`, '--virtual-time-budget=4000', `--screenshot=${file}`, `${base}frame?${query}&w=${W}&h=${j.h}`]
        execFile(chrome, args, { timeout: 60_000 }, (e, _out, stderr) => {
          if (e && !/bytes written to file/.test(String(stderr))) return reject(e)
          execFileSync('sips', ['--cropToHeightWidth', String(j.h), String(W), file], { stdio: 'ignore' })
          resolve()
        })
      })
      console.log(file)
    }
  }
  run().catch((e) => { console.error(e.message); process.exitCode = 1 }).finally(() => { server.close(); rmSync(profile, { recursive: true, force: true }) })
})
