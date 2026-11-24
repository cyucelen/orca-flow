// Browser-only fixture for the Completed goals tab and the sidebar's Goals header, in the actual tab and panel code. No plugin install,
// no worker, nothing read from ~/.orca-flow: `orca` is a stub whose "worker" keeps the goals in memory and answers goals.completed,
// goals.reopen, goals.restore, goals.openCompleted and sidebar.goalAction the way src/worker.ts does (the store itself is tested in
// test/goals.test.mjs). The clock is fixed at 2026-11-24 15:00, the date of the approved design's mock, so dates match its shots.
//   node scripts/goals-history-preview.mjs                   serve; open the printed URLs
//       /tab?theme=light&w=1000     the tab alone    (&many=1 312 goals, &empty=1, &off=1, &error=1, &loading=1,
//                                    &do=search:export|select:g1|reopen:g1|undo|within:30|linked:linear|sort:old|more|wait:300)
//       /side?theme=dark            the sidebar panel alone (&empty=1: no completed goal)
//       /both                       the sidebar (340 px) and the tab side by side, sharing one worker: Reopen in the tab shows in the sidebar
//   node scripts/goals-history-preview.mjs --shots <dir>     capture the tab (1000 and 600 px, light and dark, every state) and the sidebar header, then exit
//   node scripts/goals-history-preview.mjs --selftest        click through search, every filter, no matches + Clear filters, empty, Reopen, Undo, the sidebar
//                                                            header at 0 completed, live updates and the states in headless Chrome, then exit
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyHistory, speedView } from '../src/token-speed.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = mkdtempSync(join(tmpdir(), 'orca-flow-goals-history-preview-'))
const bundle = (entry, out) => execFileSync('npx', ['-y', 'esbuild', entry, '--bundle', '--format=esm', '--tsconfig-raw={}', '--log-level=warning', `--outfile=${join(build, out)}`], { cwd: root, stdio: 'inherit' })
bundle('src/panel/app.ts', 'app.js')
bundle('src/editor/goals-main.ts', 'goals.js')

const NOW = new Date('2026-11-24T15:00:00').getTime()
const DAY = 86_400_000
const H = 3_600_000

// ---------- fixture data (the approved design's sample goals) ----------
const at = (daysAgo, h = 11) => NOW - daysAgo * DAY - (15 - h) * H
const S = (text, done = true) => ({ text, done })
const W = (name) => ({ name, path: `/Users/me/orca/workspaces/orca-flow/${name}` })
const done = (id, title, over) => ({ id, title, status: 'done', steps: [], links: { linear: [], worktrees: [] }, lastChange: { by: 'you', field: 'status', at: over.doneAt }, updatedAt: over.doneAt, ...over })
const FIXTURE = [
  done('g1', 'Ship the billing export for finance', { note: 'Finance wants a monthly CSV of every invoice line, with tax split out, so they can stop copying from Stripe by hand.', doneWhen: 'Finance downloads November’s export from the admin page without asking us.', next: 'Tell finance it is live', steps: [S('CSV columns agreed with finance'), S('Export job behind the admin page'), S('Tax split per line'), S('Backfill October', false)], links: { linear: ['BNT-412'], worktrees: [W('billing-export')] }, createdAt: at(22), doneAt: at(6, 16), doneBy: 'you' }),
  done('g2', 'Coordinator restarts keep the open tasks', { note: 'After a restart the coordinator forgot which workers were still running.', doneWhen: 'Restarting the coordinator lists the same running workers as before.', steps: [S('Repro with two workers'), S('Store the task list on disk'), S('Test: restart mid-task')], links: { linear: ['BNT-398', 'BNT-401'], worktrees: [] }, createdAt: at(15), doneAt: at(4, 10), doneBy: 'you', proposedBy: 'billing lead' }),
  done('g3', 'Usage tab shows cost per workstream', { doneWhen: 'Each workstream row has an estimate at API list prices.', steps: [S('Price table'), S('Per-workstream totals'), S('CSV export of the per-workstream totals')], links: { linear: [], worktrees: [W('usage-cost')] }, createdAt: at(30), doneAt: at(2, 18), doneBy: 'you' }),
  done('g4', 'Write the onboarding guide for new teammates', { note: 'One page: install, first coordinator, first worker, where logs live.', doneWhen: 'A new teammate gets a worker running without asking in Slack.', createdAt: at(40), doneAt: at(9), doneBy: 'you' }),
  // The next three are in the format the previous version wrote: no doneBy, no proposedBy.
  done('g5', 'Linear links open the right issue in Orca’s browser', { steps: [S('Parse BNT- ids in goal text'), S('Open in Orca browser, not Safari')], links: { linear: ['BNT-377'], worktrees: [W('linear-links')] }, createdAt: at(33), doneAt: at(13) }),
  done('g6', 'Settings dialog saves only what changed', { note: 'Two dialogs open at once overwrote each other’s settings.', doneWhen: 'Changing a model in one dialog never resets a feature toggled in another.', steps: [S('Diff against the loaded settings'), S('Test with two dialogs')], links: { linear: ['BNT-430'], worktrees: [W('settings-diff')] }, createdAt: at(18), doneAt: at(17), lastChange: { by: 'you', field: 'steps', at: at(16) } }),
  done('g7', 'Export goals as Markdown for the weekly update', { note: 'Paste-ready list of goals done this week.', doneWhen: 'The Friday update takes under five minutes.', steps: [S('Markdown format'), S('Copy button'), S('Group by week', false)], links: { linear: [], worktrees: [W('goals-export')] }, createdAt: at(50), doneAt: at(24), doneBy: 'you' }),
  done('g8', 'Sleep idle workers after 30 minutes', { doneWhen: 'Memory stays under 70% with eight workers open overnight.', steps: [S('Idle timer'), S('Wake on message')], links: { linear: ['BNT-355'], worktrees: [] }, createdAt: at(70), doneAt: at(38), doneBy: 'you' }),
  done('g9', 'Codex hooks survive an Orca restart', { note: 'Orca rewrote hooks.json on agent launch.', steps: [S('Find what rewrites hooks.json'), S('Re-add ours after launch')], links: { linear: ['BNT-342'], worktrees: [W('codex-hooks')] }, createdAt: at(80), doneAt: at(46), doneBy: 'you', proposedBy: 'codex-hooks' }),
  // A goal with no doneAt at all (the oldest files): dated by its last update.
  done('g10', 'Provider logos in the sidebar', { createdAt: at(120), doneAt: undefined, updatedAt: at(95), lastChange: { by: 'you', field: 'next', at: at(95) } }),
  { id: 'a1', title: 'Faster worker start', status: 'open', next: 'Profile the launch', steps: [S('Profile the launch', false), S('Cache the plugin list', false)], links: { linear: [], worktrees: [] }, createdAt: at(3), updatedAt: at(1), lastChange: { by: 'you', field: 'next', at: at(1) } },
  { id: 'a2', title: 'Goals history page', status: 'open', next: 'Write the spec', steps: [], links: { linear: [], worktrees: [] }, createdAt: at(2), updatedAt: at(1), lastChange: { by: 'you', field: 'created', at: at(2) } },
  { id: 'a3', title: 'PDF export times out on large schedules', status: 'proposed', proposedBy: 'the BOU-4300 lead', steps: [S('Stream the render'), S('Regression test')], links: { linear: ['BOU-4300'], worktrees: [] }, createdAt: at(1), updatedAt: at(0.03), lastChange: { by: 'the BOU-4300 lead', field: 'status', at: at(0.03) } }
]
const many = () => {
  const verbs = ['Fix', 'Ship', 'Clean up', 'Speed up', 'Document', 'Test', 'Redesign', 'Move']
  const things = ['the worker list', 'goal search', 'Linear sync', 'usage charts', 'the settings dialog', 'coordinator handover', 'skill reload', 'the update check', 'token speed', 'routing rules']
  return Array.from({ length: 302 }, (_, i) => {
    const d = Math.floor(i * 1.15) + 1
    const n = i % 5
    return done(`m${i}`, `${verbs[i % verbs.length]} ${things[(i * 7) % things.length]}${i % 6 === 0 ? ' for the beta' : ''}`, {
      steps: Array.from({ length: n }, (_, k) => S(`Step ${k + 1}`, k < n - (i % 2))), links: { linear: i % 3 === 0 ? [`BNT-${600 - i}`] : [], worktrees: i % 4 === 1 ? [W(`wt-${i}`)] : [] },
      createdAt: at(d + 9), doneAt: at(d + 10, 9 + (i % 8)), doneBy: 'you'
    })
  })
}

// ---------- the browser side: the fake worker, and `orca` for each frame ----------

/** Runs first on every page: a fixed clock and the shared in-memory worker. `args`: { NOW, FIXTURE, many, snapshot, speed }. */
function installWorker(args) {
  const t0 = performance.now()
  Date.now = () => args.NOW + (performance.now() - t0)
  const clone = (x) => JSON.parse(JSON.stringify(x))
  const q = new URLSearchParams(location.search)
  const W = { goals: clone(args.FIXTURE), calls: [], opened: [], stored: {}, frames: [], on: true, fail: null, hang: false, openReason: null, refuse: null, latency: 0, workspaces: { 'billing-export': 'ws-billing', 'goals-export': 'ws-export', 'codex-hooks': 'ws-codex' } }
  const doneGoals = () => W.goals.filter((g) => g.status === 'done')
  // The store's order (goals.mjs list): open, then proposed, each oldest added first, then done.
  const ordered = () => { const rank = { open: 0, proposed: 1, done: 2 }; return [...W.goals].sort((a, b) => rank[a.status] - rank[b.status] || (a.status === 'done' ? (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt) : a.createdAt - b.createdAt)) }
  const post = (name, payload) => setTimeout(() => W.frames.forEach((l) => (l[name] || []).forEach((f) => f(clone(payload === undefined ? null : payload)))), 0)
  W.post = post
  const user = (g, field) => { g.updatedAt = Date.now(); g.lastChange = { by: 'you', field, at: Date.now() } }
  const reopen = (g) => { g.status = 'open'; delete g.doneAt; delete g.doneBy; delete g.proposedBy; user(g, 'status') }
  const finish = (g, extra = {}) => { const prop = g.proposedBy; g.status = 'done'; g.doneAt = extra.doneAt ?? Date.now(); g.doneBy = 'you'; if (extra.proposedBy || prop) g.proposedBy = extra.proposedBy || prop; user(g, 'status') }
  W.changed = () => { post('sidebar.goalsChanged', ordered().map((g) => ({ ...g, livePanes: [] }))); post('goals.changed') }
  W.request = async (name, d) => {
    W.calls.push({ name, d: clone(d ?? null) })
    if (W.hang && name === 'goals.completed') return new Promise(() => {})
    if (W.latency) await new Promise((r) => setTimeout(r, W.latency))
    if (name === 'sidebar.list') return args.snapshot
    if (name === 'sidebar.goals') return ordered().map((g) => ({ ...g, livePanes: [] }))
    if (name === 'sidebar.goalAction') {
      const g = W.goals.find((x) => x.id === d.id)
      if (d.action === 'add') W.goals.push({ id: 'n' + W.goals.length, title: d.title, status: 'open', steps: [], links: { linear: [], worktrees: [] }, createdAt: Date.now(), updatedAt: Date.now(), lastChange: { by: 'you', field: 'created', at: Date.now() } })
      else if (g && (d.action === 'done' || d.action === 'confirm')) finish(g)
      else if (g && d.action === 'reopen') reopen(g)
      W.changed()
      return { ok: true, goals: ordered().map((x) => ({ ...x, livePanes: [] })) }
    }
    if (name === 'goals.completed') {
      if (W.fail) throw new Error(W.fail)
      if (!W.on) return { on: false, goals: [] }
      const out = doneGoals().sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt)).map((g) => ({ ...clone(g), links: { ...g.links, worktrees: g.links.worktrees.map((w) => ({ ...w, workspaceId: W.workspaces[w.name] ?? null })) } }))
      return { on: true, goals: out }
    }
    if (name === 'goals.reopen' || name === 'goals.restore') {
      if (W.refuse) return { ok: false, error: W.refuse }
      const g = W.goals.find((x) => x.id === d.id)
      if (!g) return { ok: false, error: `no goal "${d.id}"` }
      if (name === 'goals.reopen') reopen(g)
      else finish(g, { doneAt: d.doneAt, proposedBy: d.proposedBy })
      W.changed()
      if (name === 'goals.reopen') post('sidebar.goalFlash', { id: d.id })
      return { ok: true }
    }
    if (name === 'goals.openCompleted') return W.openReason ? { opened: false, reason: W.openReason } : { opened: true }
    if (name === 'sidebar.open') return { opened: true }
    if (name === 'sidebar.settings') return { settings: {}, error: null, version: null, writers: [] }
    if (name === 'sidebar.tokenSpeed') return args.speed
    return null
  }
  if (q.get('many')) W.goals.push(...clone(args.many))
  if (q.get('empty')) W.goals = W.goals.filter((g) => g.status !== 'done')
  if (q.get('off')) W.on = false
  if (q.get('error')) W.fail = 'EACCES: permission denied, open ~/.orca-flow/goals/g1.json'
  if (q.get('loading')) W.hang = true
  window.__W = W
}

/** `orca` for one frame (the tab or the sidebar), over the worker W; plus the theme and a tiny `?do=` script for screenshots. */
function installOrca(args) {
  const q = new URLSearchParams(location.search)
  const W = q.get('host') === 'parent' ? parent.__W : window.__W
  const t0 = performance.now()
  Date.now = () => args.NOW + (performance.now() - t0)
  if (q.get('theme') === 'light') { document.documentElement.classList.add('light'); for (const [k, v] of Object.entries(args.LIGHT)) document.documentElement.style.setProperty(k, v) }
  const listeners = {}
  W.frames.push(listeners)
  const errors = (window.__errors = [])
  window.addEventListener('error', (e) => errors.push(e.message))
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason?.stack || e.reason)))
  window.orca = {
    plugin: { request: (name, data) => W.request(name, data), on: (name, f) => { (listeners[name] ||= []).push(f); return { dispose() {} } } },
    storage: { get: async (k) => W.stored[k] ?? null, set: async (k, v) => { W.stored[k] = v } },
    shell: { openExternal: async (url) => { W.opened.push(url); return { opened: true } } },
    document: { get: async () => null },
    locale: 'en'
  }
  // ?do=a|b|c: after the page shows, search:<text>, select:<id>, open:<id>, within:<v>, linked:<v>, sort:<v>, reopen:<id>, undo, more, key:<k>, wait:<ms>.
  if (q.get('do')) window.addEventListener('load', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    await wait(500)
    for (const step of q.get('do').split('|')) {
      const [k, ...rest] = step.split(':'); const v = rest.join(':')
      const click = (sel) => { const el = document.querySelector(sel); if (el) el.click(); return !!el }
      if (k === 'search') { const i = document.getElementById('q'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })) }
      else if (k === 'select' || k === 'open') click(`[data-open="${v}"]`)
      else if (k === 'within' || k === 'linked' || k === 'sort') click(`[data-f="${k}"][data-v="${v}"]`)
      else if (k === 'reopen') click(`.crow[data-id="${v}"] [data-reopen]`) || click(`.dpane [data-reopen="${v}"]`) || click(`[data-reopen="${v}"]`)
      else if (k === 'undo') click('[data-undo]')
      else if (k === 'more') click('[data-more]')
      else if (k === 'key') document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: v, bubbles: true, cancelable: true }))
      else if (k === 'sidebar') click(v)
      else if (k === 'wait') await wait(Number(v))
      await wait(k === 'reopen' ? 450 : 160)
    }
    document.documentElement.dataset.done = '1'
  })
}

// ---------- the pages ----------

const LIGHT = { '--orca-background': '#ffffff', '--orca-foreground': '#18181b', '--orca-muted-foreground': '#6e6e78', '--orca-border': '#e4e4e8', '--orca-accent': '#f2f2f4', '--orca-popover': '#ffffff', '--orca-popover-foreground': '#18181b' }
const PANEL_LIGHT = { ...LIGHT, '--orca-background': '#f7f7f9', '--orca-foreground': '#1c1c20', '--orca-accent': '#ececf0' }
const now = NOW
const agent = (paneKey, agentType, over = {}) => ({ paneKey, agentType, live: true, title: paneKey, state: 'working', workingMode: null, coordinator: 'home', leadPane: null, parentPane: null, orcaSession: null, dispatch: 'open', terminal: `term-${paneKey}`, question: null, summary: null, ...over })
const wrow = (id, name, state) => ({ id, name, branch: name, repo: 'bounti', path: `/fixture/${name}`, main: false, agents: [agent(`${name} lead`, 'claude', { state })], state, priority: null, card: null, parentId: null, liveTerminals: 1, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: now - H, createdAt: 1, pr: null })
const snapshot = { source: 'cli', capacity: null, ready: true, focusedPanes: [], features: { goals: true, linear: true, tokenSpeed: true }, coordinators: [{ key: 'home', name: 'bounti', repos: ['bounti'], workspaceId: 'home', session: agent('Coordinator', 'claude', { state: 'done', dispatch: null }) }], rows: [wrow('identity:billing', 'billing-export', 'working')] }
const workerArgs = { NOW, FIXTURE, many: many(), snapshot, speed: speedView(emptyHistory(), now, { ready: true }) }
const call = (fn, a) => `(${fn.toString()})(${JSON.stringify(a)});`

const read = (f) => readFileSync(join(root, f), 'utf8')
const tabHtml = read('src/editor/goals.html').replace('./editor.css', '/editor.css').replace('./goals.css', '/goals.css').replace('<div id="app">', `<script>${hostedWorker()}${call(installOrca, { LIGHT, NOW })}</script><div id="app">`).replace('src="./goals-main.ts"', 'src="/goals.js"')
const sideHtml = read('src/panel/index.html').replace('<head>', '<head><title>Goals fixture</title>').replace('<script type="module" src="./app.ts"></script>', `<script>${hostedWorker()}${call(installOrca, { LIGHT: PANEL_LIGHT, NOW })}</script><script type="module" src="/app.js"></script>`)
/** The page's own worker, unless it is hosted by /both's parent (which has one for both frames). */
function hostedWorker() { return `if (new URLSearchParams(location.search).get('host') !== 'parent') { ${call(installWorker, workerArgs)} }` }

const bothHtml = (theme, doParam = '') => `<!doctype html><meta charset="utf-8"><title>Completed goals + sidebar</title><body style="margin:0;background:#2a2a2e;display:flex;gap:12px;padding:12px;align-items:flex-start">
<script>${call(installWorker, workerArgs)}</script>
<iframe id="side" src="/side?host=parent&theme=${theme}" style="border:0;width:340px;height:760px;flex:none"></iframe>
<iframe id="tab" src="/tab?host=parent&theme=${theme}${doParam ? `&do=${encodeURIComponent(doParam)}` : ''}" style="border:0;width:1000px;height:760px;flex:none"></iframe>`
const frameHtml = (q) => `<!doctype html><body style="margin:0;background:#888;display:flex;justify-content:center;align-items:center;min-height:100vh"><iframe src="/${new URLSearchParams(q).get('page')}?${q}" style="border:0;display:block;flex:none;width:${new URLSearchParams(q).get('w')}px;height:${new URLSearchParams(q).get('h')}px"></iframe>`

const assets = new Map([
  ['/tab', ['text/html', tabHtml]], ['/side', ['text/html', sideHtml]],
  ['/editor.css', ['text/css', read('src/editor/editor.css')]], ['/goals.css', ['text/css', read('src/editor/goals.css')]], ['/panel.css', ['text/css', read('src/panel/panel.css')]],
  ['/app.js', ['text/javascript', readFileSync(join(build, 'app.js'))]], ['/goals.js', ['text/javascript', readFileSync(join(build, 'goals.js'))]]
])
rmSync(build, { recursive: true, force: true })
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/frame') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(frameHtml(url.searchParams.toString())); return }
  if (url.pathname === '/both') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(bothHtml(url.searchParams.get('theme') === 'light' ? 'light' : 'dark', url.searchParams.get('do') ?? '')); return }
  if (url.pathname === '/selftest') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(selftestHtml); return }
  const asset = assets.get(url.pathname)
  if (!asset) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': asset[0] }); res.end(asset[1])
})

// ---------- the self test: runs in /selftest, a page holding the sidebar and the tab over one worker ----------

/** Browser side: clicks through everything, in the sidebar frame and the tab frame. Each check is a line; the page title says the result. */
async function selftest(args) {
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
  const side = document.getElementById('side'), tab = document.getElementById('tab')
  const W = window.__W
  const log = [], fail = []
  const ok = (c, m, got) => { log.push((c ? 'ok   ' : 'FAIL ') + m + (!c && got !== undefined ? '\n       got: ' + JSON.stringify(typeof got === 'function' ? got() : got) : '')); if (!c) fail.push(m) }
  const T = () => tab.contentDocument, S = () => side.contentDocument
  const $ = (s, d = T()) => d.querySelector(s)
  const $$ = (s, d = T()) => [...d.querySelectorAll(s)]
  const titles = () => $$('.crow .ti').map((e) => e.textContent)
  const sideTitles = () => $$('#goals-rows .g .ti', S()).map((e) => e.textContent)
  const count = () => $('#count span').textContent
  const type = async (text) => { const i = $('#q'); i.focus(); i.value = text; i.dispatchEvent(new tab.contentWindow.Event('input', { bubbles: true })); await wait() }
  const key = (el, k, extra = {}) => el.dispatchEvent(new tab.contentWindow.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }))
  const seg = async (k, v) => { $(`[data-f="${k}"][data-v="${v}"]`).click(); await wait() }
  const pressed = (k) => $$(`[data-f="${k}"]`).find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.v
  const clearAll = async () => { const b = $('[data-clear-all]'); if (b) { b.click(); await wait() } }
  const tipOf = () => $('[data-gcompleted]', S())?.dataset.tip
  try {
    for (let i = 0; i < 60 && !$$('.crow').length; i++) await wait(50)
    await wait(300)
    // ---- the sidebar header ----
    ok($('#goals-head .lfold span', S()).textContent === 'Goals' && $('#goals-head .gc', S()).textContent === '3', 'sidebar: Goals 3 (the active goals)')
    ok(!!$('[data-gcompleted]', S()) && $('[data-gcompleted]', S()).textContent === 'Completed ›', 'sidebar: Completed › is in the header')
    ok(tipOf() === '10 completed goals · opens a tab' && !$('[data-gcompleted] .gc', S()), 'sidebar: the total is in the tooltip, not a count on the button')
    ok(!sideTitles().includes('Ship the billing export for finance') && sideTitles().length === 3, 'sidebar: no completed goal in the list')
    ok(!$('[data-gdone], #goal-history-search, [data-gmore]', S()), 'sidebar: no in-sidebar history, search or Show more')
    W.openReason = 'Focus a workspace first: the Completed goals tab opens inside it.'
    $('[data-gcompleted]', S()).click(); await wait(150)
    ok(W.calls.at(-1).name === 'goals.openCompleted' && $('#toast', S()).textContent.includes('Focus a workspace first: the Completed goals tab opens inside it.') && !$('#toast', S()).hidden, 'sidebar: when the tab cannot open, the reason is said in the panel toast')
    W.openReason = null
    $('[data-gcompleted]', S()).click(); await wait(150)
    ok(W.calls.at(-1).name === 'goals.openCompleted', 'sidebar: Completed › asks the worker to open the tab')
    // ---- the tab: the default view ----
    ok($('.vhead h1').textContent === 'Completed goals' && $('.vhead .gc').textContent === '10', 'tab: header with the total, 10')
    ok(count() === '10 goals, newest first', 'tab: count line "10 goals, newest first"')
    ok(titles()[0] === 'Usage tab shows cost per workstream' && titles()[9] === 'Provider logos in the sidebar', 'tab: newest first, a goal with no doneAt is dated by its last update')
    ok($$('.month').map((m) => m.textContent).join('|') === 'November 20266|October 20263|August 20261', 'tab: month headings with their counts')
    ok($$('.crow')[0].querySelector('.dt').textContent === 'Nov 22' && $$('.crow')[2].querySelector('.dt').textContent === 'Nov 18', 'tab: dates as "Nov 18" (this year)')
    ok($('#dpane').classList.contains('placeholder') && $('#dpane').textContent === 'Select a goal to see its details.', 'tab: details pane says to select a goal')
    ok($$('.copen[tabindex="0"]').length === 1 && $$('.rbtn[tabindex="0"]').length === 1, 'tab: the list is one tab stop')
    // ---- select, details ----
    $('[data-open="g1"]').click(); await wait()
    ok($('.crow[data-id="g1"]').classList.contains('sel') && $('#dtitle').textContent === 'Ship the billing export for finance', 'details: click selects the row and fills the pane')
    ok($('.dstat').textContent.includes('Nov 18, 2026 by you · 6d ago'), 'details: completed date, "by you" and how long ago', () => $('.dstat').textContent)
    ok($('.dpane').textContent.includes('Finance wants a monthly CSV') && $('.dpane').textContent.includes('Todos · 3/4') && !$('.dpane').textContent.includes('Tell finance it is live'), 'details: description and todos; Next is not shown', () => $('.dpane').textContent)
    ok($('.dfoot .meta').textContent === 'Added Nov 2, 2026 · took 16 days', 'details: added and took', () => $('.dfoot .meta').textContent)
    ok(!$('.dpane [contenteditable], .dpane input'), 'details: read-only')
    $('[data-open="g2"]').click(); await wait()
    ok($('.dstat').textContent.includes('billing lead said it was done'), 'details: the agent that said it was done')
    $('[data-open="g5"]').click(); await wait()
    ok($('.dstat').textContent.includes('Nov 11, 2026 by you'), 'details of an old-format goal whose last change was the status change: "by you"')
    $('[data-open="g6"]').click(); await wait()
    ok($('.dstat').textContent.includes('Nov 7, 2026 · ') && !$('.dstat').textContent.includes(' by '), 'details of an old-format goal edited since: the date only, no "by"', () => $('.dstat').textContent)
    $('[data-open="g1"]').click(); await wait()
    // links in the details
    $('.dpane [data-url]').click(); await wait()
    ok(W.opened.at(-1) === 'https://linear.app/issue/BNT-412', 'details: the Linear chip opens the issue')
    $('.dpane [data-wt]').click(); await wait()
    ok(W.calls.at(-1).name === 'sidebar.open' && W.calls.at(-1).d.workspaceId === 'ws-billing', 'details: the worktree chip switches to the worktree')
    $('[data-open="g3"]').click(); await wait()
    ok(!!$('.dpane .lchip.gone[title="Worktree removed"]') && !$('.dpane [data-wt]'), 'details: a removed worktree is faint with the tooltip "Worktree removed"')
    // ---- search ----
    await type('export')
    ok(titles().join('|') === 'Usage tab shows cost per workstream|Ship the billing export for finance|Export goals as Markdown for the weekly update', 'search "export": 3 goals, newest first')
    ok(count() === '3 of 10 goals match' && $('#count .cta').textContent === 'Clear filters', 'search: "3 of 10 goals match" with Clear filters')
    ok($('.crow[data-id="g3"] .hit').textContent.startsWith('Todo: ') && !!$('.crow[data-id="g3"] .hit mark'), 'search: a match outside the title shows the field and the marked words')
    ok($('.crow[data-id="g1"] .ti mark').textContent === 'export', 'search: a title match is marked in the title')
    ok(!!$('.search .clear') && !$('.search kbd'), 'search: × replaces the "/" hint')
    await type('billing finance'); ok(titles().length === 1 && titles()[0].startsWith('Ship the billing'), 'search: every word must match, in any place')
    await type('bnt-398'); ok(titles().join() === 'Coordinator restarts keep the open tasks', 'search finds a Linear id')
    await type('goals-export'); ok(titles().join() === 'Export goals as Markdown for the weekly update', 'search finds a worktree name')
    await type('tell finance'); ok(titles().length === 1 && $('.hit').textContent.startsWith('Next: '), 'search finds Next, which the details do not show')
    await type('mark'); ok($('.crow[data-id="g7"]').textContent.includes('Markdown'), 'search is case-insensitive')
    key($('#q'), 'Escape'); await wait(); ok($('#q').value === '' && titles().length === 10 && T().activeElement === $('#q'), 'Esc clears the search and keeps focus in it')
    ok(!!$('.search kbd'), 'the "/" hint is back')
    // ---- each filter ----
    await seg('within', '7'); ok(titles().length === 3 && count() === '3 of 10 goals match' && !!$('#count .cta'), 'Completed 7 days: 3 goals')
    await seg('within', '30'); ok(titles().length === 7, 'Completed 30 days: 7 goals')
    await seg('within', '90'); ok(titles().length === 9 && !titles().includes('Provider logos in the sidebar'), 'Completed 90 days: 9 goals')
    await seg('within', 'all'); ok(titles().length === 10 && pressed('within') === 'all' && count() === '10 goals, newest first', 'Completed all time: 10 goals')
    await seg('linked', 'linear'); ok(titles().length === 6, 'Linked to Linear issue: 6 goals')
    await seg('linked', 'worktree'); ok(titles().length === 6, 'Linked to Worktree: 6 goals')
    await seg('linked', 'none'); ok(titles().join('|') === 'Write the onboarding guide for new teammates|Provider logos in the sidebar', 'Linked to Nothing: 2 goals')
    await seg('linked', 'any'); ok(titles().length === 10, 'Linked to Any: 10 goals')
    await seg('sort', 'old'); ok(titles()[0] === 'Provider logos in the sidebar' && count() === '10 goals, oldest first' && titles().at(-1) === 'Usage tab shows cost per workstream', 'Sort oldest first')
    await seg('sort', 'new'); ok(titles()[0] === 'Usage tab shows cost per workstream', 'Sort newest first')
    await seg('within', '30'); await seg('linked', 'linear'); await type('settings')
    ok(titles().join() === 'Settings dialog saves only what changed' && count() === '1 of 10 goals match', 'search and filters together')
    // ---- the saved filters: Completed within and Sort only ----
    await seg('sort', 'old')
    ok(JSON.stringify(W.stored['goals-history-ui']) === JSON.stringify({ within: '30', sort: 'old' }), 'only Completed within and Sort are stored (not the search, not Linked to): ' + JSON.stringify(W.stored['goals-history-ui']))
    // ---- no matches + Clear filters ----
    await type('kubernetes')
    ok(count() === '0 of 10 goals match' && !$('#count .cta'), 'no matches: "0 of 10 goals match", no second Clear link')
    ok($('.empty-state h2').textContent === 'No goals match' && $('.empty-state p').textContent === 'No goal completed in the last 30 days and linked to a Linear issue matches “kubernetes”.', 'no matches: the sentence names the active filters and the search', () => $('.empty-state p').textContent)
    ok(!$('#tools').hidden && $('#q').value === 'kubernetes' && pressed('within') === '30', 'no matches: search and filters stay as they were')
    $('.empty-state [data-clear-all]').click(); await wait()
    ok(titles().length === 10 && $('#q').value === '' && pressed('within') === 'all' && pressed('linked') === 'any' && pressed('sort') === 'old', 'Clear filters resets search, Completed and Linked to, and keeps Sort')
    await seg('sort', 'new')
    // ---- keyboard ----
    $('#q').blur(); key($('.crow'), '/'); await wait(); ok(T().activeElement === $('#q'), '"/" focuses the search')
    $('[data-open="g4"]').focus(); key($('[data-open="g4"]'), 'ArrowDown'); await wait(); ok(T().activeElement.dataset.open === 'g5' && T().activeElement.tabIndex === 0 && $('[data-open="g4"]').tabIndex === -1, 'ArrowDown moves to the next row; the tab stop moves with it')
    key(T().activeElement, 'End'); ok(T().activeElement.dataset.open === 'g10', 'End goes to the last row'); key(T().activeElement, 'Home'); ok(T().activeElement.dataset.open === 'g3', 'Home goes to the first row')
    // ---- live update: the selected goal is reopened elsewhere (the sidebar or the CLI) ----
    $('[data-open="g4"]').click(); await wait(); await type('onboarding'); await seg('within', 'all')
    W.goals.find((g) => g.id === 'g4').status = 'open'; W.changed(); await wait(300)
    ok(!titles().includes('Write the onboarding guide for new teammates') && !$('.toast'), 'live: a goal reopened elsewhere leaves the list with no toast')
    ok($('#q').value === 'onboarding' && count().startsWith('0 of 9'), 'live: the search text is kept', () => [$('#q').value, count()])
    await clearAll()
    ok(sideTitles().includes('Write the onboarding guide for new teammates') && tipOf() === '9 completed goals · opens a tab', 'live: ...and it is in the sidebar', () => [sideTitles(), tipOf()])
    W.goals.find((g) => g.id === 'g4').status = 'done'; W.changed(); await wait(300)
    ok(titles().includes('Write the onboarding guide for new teammates') && titles().length === 10, 'live: a goal completed elsewhere just appears, in its place')
    // ---- Reopen from the tab ----
    $('[data-open="g1"]').click(); await wait()
    const before = titles().length
    $('.crow[data-id="g1"] [data-reopen]').click(); await wait(450)
    ok(W.calls.some((c) => c.name === 'goals.reopen' && c.d.id === 'g1'), 'reopen: the worker is asked')
    ok(!titles().includes('Ship the billing export for finance') && titles().length === before - 1, 'reopen: the goal leaves the tab')
    ok($('.toast .t').textContent === 'Reopened “Ship the billing export for finance”. It’s back in Goals.' && !!$('.toast .undo'), 'reopen: the toast says it, with Undo', () => $('.toast')?.textContent)
    ok($('#dtitle') ? $('#dtitle').textContent !== 'Ship the billing export for finance' : true, 'reopen: the selection moved on')
    ok(sideTitles()[0] === 'Ship the billing export for finance' && sideTitles().length === 4, 'reopen: the sidebar active list gained it, in its place (oldest added first)')
    ok($('#goals-rows .g.flash', S()) && $('#goals-rows .g.flash .ti', S()).textContent === 'Ship the billing export for finance', 'reopen: the sidebar row flashes')
    ok($('#goalpop', S()).hidden, 'reopen: the sidebar does not open the goal card')
    ok(tipOf() === '9 completed goals · opens a tab' && $('#goals-head .gc', S()).textContent === '4', 'reopen: the sidebar totals follow (4 active, 9 completed)', () => [$('#goals-head .gc', S()).textContent, tipOf()])
    ok(count() === '9 goals, newest first' && $('.vhead .gc').textContent === '9', 'reopen: the tab total follows')
    // ---- Undo: the original date ----
    const was = W.goals.find((g) => g.id === 'g1')
    ok(was.doneAt === undefined, 'undo: (precondition) the reopened goal has no doneAt')
    $('.toast .undo').click(); await wait(400)
    const back = W.goals.find((g) => g.id === 'g1')
    ok(back.status === 'done' && back.doneAt === FIXTURE_G1_DONE, 'undo: the goal is done again with its original doneAt')
    ok(titles().includes('Ship the billing export for finance') && $('.crow[data-id="g1"] .dt').textContent === 'Nov 18' && titles().indexOf('Ship the billing export for finance') === 2, 'undo: it returns to the same place, still dated Nov 18')
    ok($('.toast .t').textContent === '“Ship the billing export for finance” is completed again.' && !$('.toast .undo'), 'undo: the toast confirms, with no Undo', () => $('.toast')?.textContent)
    ok(!sideTitles().includes('Ship the billing export for finance'), 'undo: the sidebar loses it again')
    ok(W.calls.filter((c) => c.name === 'goals.restore').length === 1 && W.calls.at(-1).d !== undefined, 'undo: through goals.restore with the original date')
    // Undo of a goal an agent proposed keeps the proposer
    $('[data-open="g2"]').click(); await wait(); $('.crow[data-id="g2"] [data-reopen]').click(); await wait(450)
    key(T().body, 'z', { metaKey: true }); await wait(400)
    ok(W.goals.find((g) => g.id === 'g2').proposedBy === 'billing lead' && titles().includes('Coordinator restarts keep the open tasks'), 'undo with Cmd-Z keeps who said it was done')
    // a refused Reopen
    W.refuse = 'no goal "g3"'
    $('.crow[data-id="g3"] [data-reopen]').click(); await wait(450)
    ok(titles().includes('Usage tab shows cost per workstream') && $('.toast .t').textContent === 'Could not reopen “Usage tab shows cost per workstream”: no goal "g3"', 'reopen refused: the row stays, the toast says why', () => $('.toast')?.textContent)
    W.refuse = null
    // ---- the sidebar completes a goal: the tab shows it, by you ----
    const fresh = W.goals.find((g) => g.id === 'a1')
    S().querySelector('[data-gopen="a1"]').click(); await wait(200)
    $('#goalpop [data-gfinish]', S()).click(); await wait(400)
    ok(fresh.status === 'done' && fresh.doneBy === 'you', 'sidebar Mark done records doneBy')
    ok(titles()[0] === 'Faster worker start', 'live: a goal marked done in the sidebar is first in the tab')
    $('[data-open="' + 'a1' + '"]').click(); await wait(); ok($('.dstat').textContent.includes('by you · just now'), 'details: "by you · just now"', () => $('.dstat').textContent)
    // ---- narrow tab: the details replace the list ----
    tab.style.width = '600px'; await wait(200)
    ok(tab.contentWindow.getComputedStyle($('.dpane')).display === 'none', 'narrow: no details pane')
    $('[data-open="g7"]').click(); await wait()
    ok(!!$('.dscreen') && $('#tools').hidden, 'narrow: the details replace the list')
    ok(T().activeElement === $('.back') && $('.back').textContent.trim() === 'Completed goals', 'narrow: focus is on "‹ Completed goals"')
    key($('.dscreen'), 'Escape'); await wait()
    ok(!$('.dscreen') && T().activeElement.dataset.open === 'g7', 'narrow: Esc goes back and focuses the same row')
    tab.style.width = '1000px'; await wait(200)
    // ---- Show more: batches of 50 ----
    W.goals.push(...args.many); W.changed(); await wait(300)
    ok($$('.crow').length === 50 && $('.more').textContent.includes('Showing 50 of 313'), 'many: 50 rows, "Showing 50 of 313"')
    $('[data-more]').click(); await wait()
    ok($$('.crow').length === 100 && T().activeElement.classList.contains('copen'), 'many: Show 50 more adds a batch and focuses its first row')
    await type('settings'); ok($$('.crow').length < 50 && !$('[data-more]'), 'many: search runs over every goal, and starts from 50 again')
    await clearAll(); await type('');
    W.goals = W.goals.filter((g) => !g.id.startsWith('m')); W.changed(); await wait(300)
    // ---- states: error, off, empty, then the header at 0 completed ----
    W.fail = 'EACCES: permission denied'; W.changed(); await wait(300)
    ok(!!$('.banner.bad[role="alert"]') && $('.banner').textContent.includes('Could not read goals.') && titles().length > 0 && $$('[data-reopen][disabled]').length > 0, 'error: the banner, the old list stays, Reopen is disabled')
    W.fail = null; $('.banner [data-retry]').click(); await wait(300)
    ok(!$('.banner') && !$('[data-reopen][disabled]'), 'error: Try again reads again and clears it')
    W.on = false; W.changed(); await wait(300)
    ok($('.empty-state h2').textContent === 'Goals is turned off' && $('#tools').hidden, 'off: "Goals is turned off"')
    W.on = true
    for (const g of W.goals) if (g.status === 'done') { g.status = 'open'; delete g.doneAt }
    W.changed(); await wait(400)
    ok($('.empty-state h2').textContent === 'No completed goals yet' && $('.vhead .gc').textContent === '0' && $('#tools').hidden, 'empty: "No completed goals yet", the tab left open stays usable')
    ok(!$('[data-gcompleted]', S()) && !$('#goals-head', S()).textContent.includes('Completed') && !!$('[data-gadd]', S()) && !!$('[data-gfold]', S()), 'sidebar: Completed › is hidden at 0 completed goals; fold and + stay')
    // a goal done again brings the button back
    S().querySelector('[data-gopen="a2"]').click(); await wait(200); $('#goalpop [data-gfinish]', S()).click(); await wait(400)
    ok(!!$('[data-gcompleted]', S()) && tipOf() === '1 completed goal · opens a tab', 'sidebar: the button is back with one completed goal ("1 completed goal")', () => [tipOf(), $('#goals-head', S()).textContent])
    ok(titles().join() === 'Goals history page', 'tab: the goal is there')
    const errs = [...(tab.contentWindow.__errors || []), ...(side.contentWindow.__errors || [])]
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''))
  } catch (e) { fail.push('exception ' + e.message); log.push('EXC ' + e.stack) }
  const text = (fail.length ? 'SELFTEST FAIL ' + fail.length : 'SELFTEST PASS ' + log.length) + '\n' + log.join('\n')
  const pre = document.createElement('pre'); pre.id = 'selftest'; pre.textContent = text; document.body.append(pre)
}
const FIXTURE_G1_DONE = FIXTURE.find((g) => g.id === 'g1').doneAt
const selftestHtml = `<!doctype html><meta charset="utf-8"><title>selftest</title><body style="margin:0;display:flex;gap:12px;padding:12px;align-items:flex-start">
<script>${call(installWorker, workerArgs)}</script>
<iframe id="side" src="/side?host=parent" style="border:0;width:340px;height:760px;flex:none"></iframe>
<iframe id="tab" src="/tab?host=parent" style="border:0;width:1000px;height:760px;flex:none"></iframe>
<script>const FIXTURE_G1_DONE = ${FIXTURE_G1_DONE}; window.addEventListener('load', () => setTimeout(() => (${selftest.toString()})(${JSON.stringify({ many: many() })}), 1200))</script>`

// ---------- run ----------

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const shots = process.argv.indexOf('--shots')
server.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}`
  const profile = mkdtempSync(join(tmpdir(), 'orca-flow-chrome-'))
  const finish = () => { server.close(); rmSync(profile, { recursive: true, force: true }) }
  if (process.argv.includes('--selftest')) {
    execFile(chrome, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--window-size=1500,900', '--virtual-time-budget=60000', '--dump-dom', `${base}/selftest`], { timeout: 120_000, maxBuffer: 50e6 }, (e, out) => {
      const m = /<pre id="selftest">([\s\S]*?)<\/pre>/.exec(out ?? '')
      const text = m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : `no result (${e?.message ?? 'page did not finish'})`
      console.log(text)
      if (!m || text.startsWith('SELFTEST FAIL')) process.exitCode = 1
      finish()
    })
    return
  }
  if (shots < 0) { console.log(`Completed goals fixture:\n  ${base}/tab?theme=dark&w=1000\n  ${base}/side?theme=dark\n  ${base}/both`); return }
  const out = process.argv[shots + 1] || '/tmp/orca-goals-history-shots'
  mkdirSync(out, { recursive: true })
  // [name, query, width, height, page]. The `do` script runs after load; Chrome will not size a window under ~500 px, so every shot sits in an iframe of its exact size.
  const states = [
    ['main', 'do=select:g1', [1000, 600]], ['search', 'do=search:export|select:g7', [1000]], ['nomatch', 'do=search:kubernetes|within:30', [1000, 600]], ['empty', 'empty=1', [1000, 600]],
    ['reopened', 'do=select:g1|reopen:g1', [1000, 600]], ['undone', 'do=reopen:g2|undo', [1000]], ['detail', 'do=open:g1', [600]], ['many', 'many=1', [1000]], ['many-end', 'many=1&do=more|more|more|more|more|more', [1000]],
    ['loading', 'loading=1', [1000]], ['off', 'off=1', [1000]], ['error', 'error=1', [1000]]
  ]
  const jobs = []
  for (const [name, q, widths] of states) for (const w of widths) for (const theme of ['dark', 'light']) jobs.push({ file: `${name}-${w}-${theme}`, page: 'tab', q: `${q}&theme=${theme}`, w, h: w === 1000 ? 760 : 820 })
  // The detail screen opens on a narrow tab only.
  for (const theme of ['dark', 'light']) { jobs.push({ file: `sidebar-${theme}`, page: 'side', q: `theme=${theme}`, w: 340, h: 360 }); jobs.push({ file: `sidebar-reopened-${theme}`, page: 'both', q: `theme=${theme}&do=${encodeURIComponent('select:g1|reopen:g1')}`, w: 1376, h: 784, budget: 1300, side: true }); jobs.push({ file: `sidebar-empty-${theme}`, page: 'side', q: `empty=1&theme=${theme}`, w: 340, h: 360 }) }
  const run = async () => {
    for (const j of jobs) {
      const file = join(out, `${j.file}.png`)
      await new Promise((resolve, reject) => {
        const url = j.page === 'both' ? `${base}/both?${j.q}` : `${base}/frame?page=${j.page}&${j.q}&w=${j.w}&h=${j.h}`
        execFile(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--user-data-dir=${profile}`, `--window-size=${j.side ? j.w : Math.max(j.w + 40, 700)},${j.side ? j.h : j.h + 120}`, `--virtual-time-budget=${j.budget ?? 6000}`, `--screenshot=${file}`, url], { timeout: 60_000 }, (e, _o, stderr) => {
          if (e && !/bytes written to file/.test(String(stderr))) return reject(e)
          // `side`: also keep the sidebar alone (the left 340 px) beside the full page.
          if (j.side) { const alone = file.replace('.png', '-alone.png'); execFileSync('cp', [file, alone]); execFileSync('sips', ['-c', String(760 * 2), String(340 * 2), '--cropOffset', '24', '24', alone], { stdio: 'ignore' }) }
          if (!j.side)
          execFileSync('sips', ['--cropToHeightWidth', String(j.h * 2), String(j.w * 2), file], { stdio: 'ignore' })
          resolve()
        })
      })
      console.log(file)
    }
  }
  run().catch((e) => { console.error(e.message); process.exitCode = 1 }).finally(finish)
})
