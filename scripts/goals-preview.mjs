// Browser-only fixture for the Goals section in the actual panel code. No plugin install, worker or goals files:
// `orca` is a stub that keeps the goals in memory and answers sidebar.goalAction the way the worker does
// (src/goals.ts: edits are "you"), and records every request in window.previewCalls.
//   node scripts/goals-preview.mjs                   serve; open the printed URL (add ?theme=light, ?open=<goal id>, ?add=1, ?showdone=1, ?fold=1)
//   node scripts/goals-preview.mjs --shots <dir>     capture the section, an open card, the add box and the done goals, dark and light, 360 px, then exit
//   node scripts/goals-preview.mjs --selftest        click through add, tick, edit next, mark done, reopen, confirm and "Not yet" in headless Chrome, then exit
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  source: 'cli', capacity: null, ready: true, focusedPanes: [],
  coordinators: [{ key: 'home', name: 'bounti', repos: ['bounti'], workspaceId: 'home', session: agent('Coordinator', 'claude', { state: 'done', dispatch: null }) }],
  rows: [
    wrow('identity:des-340', 'des-340-super-admin-permissions', 'working', { linearIssue: 'DES-340' }),
    wrow('identity:bou-4206', 'bou-4206-aic-split-lessons', 'waiting', { linearIssue: 'BOU-4206' })
  ]
}
const g = (id, title, over = {}) => ({
  id, title, steps: [], links: { linear: [], worktrees: [] }, status: 'open', createdAt: now - 5 * 24 * H, updatedAt: now - 2 * H, lastChange: { by: 'you', field: 'created', at: now - 5 * 24 * H }, working: false, ...over
})
const goals = [
  g('g_super-admin', 'Ship super admin', {
    note: 'Super Admins see all News posts and documents, can moderate, and can oversee group chats without notifications. Custom roles moved to DES-354.',
    steps: [['Visibility fix in News and Documents', 1], ['Moderation rights (edit, delete, block)', 1], ['Group chat oversight without notifications', 0], ['Admin presence shown in chats', 0]].map(([text, d]) => ({ text, done: !!d })),
    next: 'Finish chat oversight without notifications', doneWhen: 'Super Admins see everything, can moderate, and the PR is merged',
    links: { linear: ['DES-340'], worktrees: [{ key: 'des-340', path: '/fixture/des-340-super-admin-permissions', name: 'mono/des-340-super-admin-permissions' }] },
    lastChange: { by: 'the DES-340 lead', field: 'next', at: now - 2 * H }, working: true }),
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
  g('g_pdf-export', 'Fix PDF export timeouts on large schedules', {
    steps: [['Reproduce with the 200-shift schedule', 1], ['Stream the render', 1], ['Add a regression test', 1]].map(([text, d]) => ({ text, done: !!d })),
    next: 'Merge the PR', doneWhen: 'A 200-shift schedule exports in under 10 s', status: 'proposed', links: { linear: ['BOU-4300'], worktrees: [] },
    lastChange: { by: 'the BOU-4300 lead', field: 'status', at: now - 40 * 60_000 } }),
  g('g_lawyer-intro', 'Intro call with the Germany lawyer', { status: 'done', doneAt: now - 3 * 24 * H, steps: [{ text: 'Book the call', done: true }], lastChange: { by: 'you', field: 'status', at: now - 3 * 24 * H } })
]
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
  if (a.action === 'add') { if (!a.title.trim()) return 'a goal needs a title'; const n = { id: 'g_' + Math.random().toString(36).slice(2, 8), title: a.title.trim(), steps: [], links: { linear: [], worktrees: [] }, status: 'open', createdAt: Date.now(), working: false }; stamp(n, 'created'); goals.push(n); return null; }
  if (!x) return 'no goal ' + a.id;
  if (a.action === 'update') { const f = []; for (const [k, v] of Object.entries(a.patch)) { if (k === 'title' && !v.trim()) return 'a goal needs a title'; if (v.trim() !== (x[k] ?? '')) { v.trim() ? (x[k] = v.trim()) : delete x[k]; f.push(k); } } if (f.length) stamp(x, f.join(',')); }
  else if (a.action === 'step') { x.steps[a.step - 1].done = a.done; stamp(x, 'steps'); }
  else if (a.action === 'addStep') { x.steps.push({ text: a.text, done: false }); stamp(x, 'steps'); }
  else if (a.action === 'done' || a.action === 'confirm') { x.status = 'done'; x.doneAt = Date.now(); x.working = false; stamp(x, 'status'); }
  else if (a.action === 'reopen' || (a.action === 'reject' && x.status === 'proposed')) { x.status = 'open'; delete x.doneAt; stamp(x, 'status'); }
  return null;
};
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
      if (name === 'sidebar.goalAction') { const error = apply(data); const out = JSON.parse(JSON.stringify(goals)); if (!error) setTimeout(() => (listeners['sidebar.goalsChanged'] || []).forEach((f) => f(out)), 0); return { ok: !error, ...(error ? { error } : {}), goals: out }; }
      if (name === 'sidebar.settings') return { settings: {}, error: null, version: null, writers: [] };
      return name === 'sidebar.linear' ? null : { ok: true };
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
    ok(document.querySelector('#goals-head .lfold span').textContent === 'Goals' && $('#goals-head .gc').textContent === '5', 'header: Goals 5');
    ok($('#goals-head .gdn').textContent === '· 1 done', 'header: · 1 done');
    ok(!!row('g_super-admin').querySelector('.wd') && !row('g_lesson-splitting').querySelector('.wd'), 'green dot only on the goal with a working agent');
    ok(row('g_super-admin').querySelector('.cnt').textContent === '2/4' && row('g_super-admin').querySelector('.nx').textContent.startsWith('Finish chat'), 'row: count 2/4 and next');
    ok(row('g_pdf-export').querySelector('.nx').textContent === 'lead says done', 'proposed row says "lead says done"');
    ok(!titles().includes('Intro call with the Germany lawyer'), 'done goal hidden');
    // fold
    $('[data-gfold]').click(); await wait(); ok(titles().length === 0 && previewCalls.some((c) => c.name === 'storage.set' && c.data.v.folded === true), 'fold hides rows and is stored');
    $('[data-gfold]').click(); await wait(); ok(titles().length === 5, 'unfold shows 5');
    // add
    $('[data-gadd]').click(); await wait(); const inp = $('#goal-new'); ok(!$('#goal-add').hidden && document.activeElement === inp, 'add box opens focused');
    key(inp, 'Escape'); await wait(); ok($('#goal-add').hidden, 'Esc cancels the add box');
    $('[data-gadd]').click(); await wait(); $('#goal-new').value = 'Hire a designer'; key($('#goal-new'), 'Enter'); await wait(300);
    ok(titles().includes('Hire a designer') && previewCalls.some((c) => c.name === 'sidebar.goalAction' && c.data.action === 'add' && c.data.title === 'Hire a designer') && $('#goal-add').hidden, 'Enter adds a goal');
    // open card, tick, edit next
    row('g_shift-scheduling').click(); await wait();
    ok(!$('#goalpop').hidden && $('#goalpop .meta').textContent.startsWith('Next updated by you'), 'click opens the card with who changed it last');
    $('#goalpop [data-gstep="1"]').click(); await wait(300);
    ok($('#goalpop [data-gstep="1"]').getAttribute('aria-checked') === 'true' && row('g_shift-scheduling').querySelector('.cnt').textContent === '1/4' && $('#goalpop .meta').textContent.startsWith('Steps updated by you · just now'), 'tick a step: card, row count and meta follow');
    await edit('next', 'Draft the Austria template', 'enter'); await wait(250);
    ok(row('g_shift-scheduling').querySelector('.nx').textContent === 'Draft the Austria template' && $('#goalpop .meta').textContent.startsWith('Next updated by you'), 'edit next (Enter) saves; the row shows it');
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
    // outside click closes
    row('g_shift-scheduling').click(); await wait(); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await wait(); ok($('#goalpop').hidden, 'a press outside closes the card');
    // mark done
    row('g_planning-assistance').click(); await wait(); $('#goalpop [data-gfinish]').click(); await wait(300);
    ok($('#goalpop').hidden && !titles().includes('Plan "planning assistance" for shift scheduling by studying other products') && $('#goals-head .gdn').textContent === '· 2 done', 'Mark done: card closes, goal leaves the list, done count 2 (' + $('#goalpop').hidden + ' ' + $('#goals-head .gdn')?.textContent + ' ' + titles().length + ' ' + JSON.stringify(previewCalls.slice(-3)) + ')');
    // show done, reopen
    $('[data-gdone]').click(); await wait(); ok(titles().includes('Intro call with the Germany lawyer') && row('g_lawyer-intro').classList.contains('fin'), 'the done toggle shows done goals');
    row('g_lawyer-intro').click(); await wait(); ok(!!$('#goalpop [data-greopen]') && !$('#goalpop [data-gfinish]'), 'a done goal offers Reopen');
    $('#goalpop [data-greopen]').click(); await wait(300);
    ok($('#goals-head .gdn').textContent === '· 1 done' && row('g_lawyer-intro').querySelector('.nx'), 'Reopen brings it back as open');
    // confirm proposed
    row('g_pdf-export').click(); await wait(); ok(!!$('#goalpop [data-gconfirm]') && !!$('#goalpop [data-gnot]') && !$('#goalpop [data-gfinish]'), 'proposed card offers Confirm done / Not yet');
    $('#goalpop [data-gconfirm]').click(); await wait(300); ok(row('g_pdf-export').classList.contains('fin'), 'Confirm done marks it done');
    // not yet on a fresh proposal
    goals.find((x) => x.id === 'g_lesson-splitting').status = 'proposed'; listeners['sidebar.goalsChanged'].forEach((f) => f(JSON.parse(JSON.stringify(goals)))); await wait();
    row('g_lesson-splitting').click(); await wait(); $('#goalpop [data-gnot]').click(); await wait(300);
    ok(row('g_lesson-splitting').querySelector('.nx').textContent.startsWith('Answer review') && $('#goalpop').hidden, '"Not yet" sends it back to open');
    // empty title is refused
    row('g_lesson-splitting').click(); await wait(); await edit('title', '   '); await wait(); ok($('#goalpop [data-gedit="title"]').textContent.startsWith('Finish lesson splitting'), 'an emptied title reverts');
    // searching hides the section
    key(document.body, 'Escape'); await wait();
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
    execFile(chrome, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--window-size=600,800', '--virtual-time-budget=8000', '--dump-dom', `${base}?selftest=1`], { timeout: 60_000, maxBuffer: 20e6 }, (e, out) => {
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
  const run = async () => {
    for (const j of jobs) {
      const file = join(out, `goals-${j.name}-${j.theme}-${W}.png`)
      await new Promise((resolve, reject) => {
        const query = `theme=${j.theme}${j.click ? `&click=${encodeURIComponent(j.click)}` : ''}${j.type ? `&type=${encodeURIComponent(j.type)}` : ''}${j.showdone ? '&showdone=1' : ''}${j.empty ? '&empty=1' : ''}`
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
