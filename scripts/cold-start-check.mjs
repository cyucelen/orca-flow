#!/usr/bin/env node
// Busy cold start, outside Orca: does the panel draw real saved state when Orca cannot transpile anything?
//
//   node scripts/cold-start-check.mjs                 run every case in headless Chrome; exit 1 when one fails
//   node scripts/cold-start-check.mjs --shots <dir>   also save a 400 px screenshot of each panel case
//   node scripts/cold-start-check.mjs --serve         serve the cases and print their URLs (stop with Ctrl-C)
//
// 1. A throwaway HOME holds saved state: two coordinators under ~/orca/coordinators (one with a saved session member),
//    goals under ~/.orca-flow/goals and the Goals feature on. Nothing is read from or written to the real HOME.
// 2. A child process with HOME set to it runs the worker's own snapshot() (src/worker.ts), with child_process stubbed
//    so nothing reaches the live Orca: once with `orca worktree ps` failing (the CLI is not ready during a cold boot;
//    the worker falls back to workspace.list) and once with fixture worktrees (Orca ready). It also reads the goals,
//    the completed goals and the Usage view the way the worker answers the frames.
// 3. A local server stands in for Orca's frame protocol, with Orca 1.4.263's rule under a stalled main thread: every
//    module Orca would transpile (.ts .tsx .mts .jsx) answers what Orca serves when the 2000 ms budget runs out, a
//    module that throws "took over the 2000 ms transpile budget". .js/.mjs/.css are served as they are. The HTML gets
//    a stub `orca` that answers the frame's requests from step 2.
// 4. Headless Chrome loads each entry and reports what it drew. The panel must show the saved coordinators,
//    workstreams and goals with no error; the editors must draw their views. A last case loads the panel's old
//    TypeScript entry (app.ts) under the same rule and must fail the way Orca did, which shows the model holds.
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TRANSPILED = new Set(['.ts', '.tsx', '.mts', '.jsx'])
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// ---------- step 2, in the child: the worker's answers from the fixture HOME ----------
if (process.argv[2] === '--worker-answers') {
  const { createRequire, syncBuiltinESMExports } = await import('node:module')
  const cp = createRequire(import.meta.url)('node:child_process')
  const refuse = () => { throw new Error('blocked: the cold-start check never runs a command') }
  cp.execFileSync = refuse
  cp.execSync = refuse
  cp.spawnSync = refuse
  // The only commands answered are the two the coordinator lineage reads, with a fake, empty Orca: no terminals, no runs.
  const FAKE = { 'terminal list': { terminals: [] }, 'orchestration run-list': { runs: [] } }
  cp.execFile = (file, args, ...rest) => {
    const cb = rest.find((a) => typeof a === 'function')
    const answer = Array.isArray(args) ? FAKE[args.slice(0, 2).join(' ')] : undefined
    setImmediate(() => (answer ? cb?.(null, JSON.stringify({ ok: true, result: answer }), '') : cb?.(new Error('blocked: the cold-start check never runs a command'), '', '')))
    return { on() {}, kill() {}, stdin: null }
  }
  cp.spawn = () => { throw new Error('blocked: the cold-start check never runs a command') }
  cp.exec = cp.execFile
  syncBuiltinESMExports()
  process.removeAllListeners('warning')
  const home = process.env.HOME
  const data = join(home, '.orca-flow')
  const src = (f) => pathToFileURL(join(ROOT, f)).href
  const { add, done } = await import(src('skills/orca-flow/scripts/goals.mjs'))
  const shipped = add('Ship the checkout rewrite', { steps: [{ text: 'Cart totals', done: true }, 'Coupons', 'Rollout'], next: 'Validate coupon stacking', doneWhen: 'Checkout runs on the new service' }, { data })
  add('Plan the Q1 pricing page', { steps: ['Gather competitors', 'Draft'], next: 'Gather competitors' }, { data })
  done(add('Fix the flaky login test', { steps: [{ text: 'Reproduce', done: true }] }, { data }).id, { data })
  void shipped
  const worker = await import(src('src/worker.ts'))
  const { readGoals } = await import(src('src/goals.ts'))
  const { readCompleted } = await import(src('src/completed-goals.ts'))
  const { analyticsView } = await import(src('src/analytics.ts'))
  const { fixtureModel } = await import(src('src/analytics-fixture.ts'))
  const { WINDOWS } = await import(src('src/analytics-view.ts'))
  const coord = (name) => join(home, 'orca', 'coordinators', name)
  const workspaces = [
    { id: 'folder-shop', kind: 'folder', name: 'shop', path: coord('shop'), branch: '', hostId: 'local' },
    { id: 'folder-ops', kind: 'folder', name: 'ops', path: coord('ops'), branch: '', hostId: 'local' },
    { id: 'wt-checkout', kind: 'worktree', name: 'checkout-rewrite', path: '/fixture/shop/checkout-rewrite', branch: 'refs/heads/checkout-rewrite', hostId: 'local' },
    { id: 'wt-pricing', kind: 'worktree', name: 'pricing-page', path: '/fixture/shop/pricing-page', branch: 'refs/heads/pricing-page', hostId: 'local' }
  ]
  const logs = []
  const orca = { host: { call: async (name) => (name === 'workspace.list' ? { workspaces, truncated: false } : null) }, log: (m) => logs.push(m), panels: { post() {} } }
  const ps = [
    { path: coord('shop'), displayName: 'shop', repo: 'shop', liveTerminalCount: 1, agents: [{ paneKey: 'tab-shop:1', orcaSessionId: 'conv-shop', agentType: 'claude', state: 'done', hasLivePty: true, conversationName: 'Shop coordinator' }] },
    { identity: { key: 'wt-checkout' }, path: '/fixture/shop/checkout-rewrite', displayName: 'checkout-rewrite', repo: 'shop', branch: 'refs/heads/checkout-rewrite', liveTerminalCount: 1, lastActivityAt: Date.now() - 4 * 60_000,
      agents: [{ paneKey: 'tab-checkout:1', parentPaneKey: 'tab-shop:1', orcaSessionId: 'conv-checkout', agentType: 'claude', state: 'working', hasLivePty: true, conversationName: 'Checkout rewrite lead' }] },
    { identity: { key: 'wt-pricing' }, path: '/fixture/shop/pricing-page', displayName: 'pricing-page', repo: 'shop', branch: 'refs/heads/pricing-page', liveTerminalCount: 1, lastActivityAt: Date.now() - 25 * 60_000,
      agents: [{ paneKey: 'tab-pricing:1', parentPaneKey: 'tab-shop:1', orcaSessionId: 'conv-pricing', agentType: 'codex', state: 'waiting', hasLivePty: true, conversationName: 'Pricing page lead' }] }
  ]
  const features = { goals: true, linear: false, tokenSpeed: false }
  const answers = {}
  for (const [state, run] of [['cold', () => Promise.reject(new Error('orca CLI not ready'))], ['warm', () => Promise.resolve(ps)]]) {
    let lineage
    const loaded = new Promise((r) => (lineage = r))
    let snap = await worker.snapshot(orca, run, lineage, false)
    // Orca ready: the worker draws again once the coordinator lineage loaded (ready: true), as refresh() does.
    if (state === 'warm') { await loaded; snap = await worker.snapshot(orca, run, () => {}, false) }
    snap.features = features
    answers[state] = { snapshot: snap, goals: readGoals(snap.rows, data) }
  }
  answers.completed = { on: true, goals: readCompleted(answers.warm.snapshot.rows, data) }
  const model = fixtureModel()
  answers.usage = Object.fromEntries(WINDOWS.map((w) => [w, analyticsView(model, w)]))
  answers.logs = logs
  answers.saved = JSON.parse(readFileSync(join(coord('shop'), 'coordinator.json'), 'utf8'))
  process.stdout.write(JSON.stringify(answers))
  process.exit(0)
}

// ---------- step 1: the fixture HOME ----------
const home = mkdtempSync(join(tmpdir(), 'orca-flow-cold-start-'))
const coordinators = join(home, 'orca', 'coordinators')
const member = { id: JSON.stringify(['folder-shop', 'session', 'conv-shop']), workspaceId: 'folder-shop', workspacePath: join(coordinators, 'shop'), orcaSession: 'conv-shop', agentType: 'claude', title: 'Shop coordinator', paneKey: 'tab-shop:1', terminals: ['term-shop'] }
const savedShop = { name: 'shop', repos: ['shop'], about: 'Runs the shop', look: null, sessions: { version: 1, current: member.id, members: [member] } }
mkdirSync(join(coordinators, 'shop'), { recursive: true })
mkdirSync(join(coordinators, 'ops'), { recursive: true })
writeFileSync(join(coordinators, 'shop', 'coordinator.json'), JSON.stringify(savedShop, null, 2))
writeFileSync(join(coordinators, 'ops', 'coordinator.json'), JSON.stringify({ name: 'ops', repos: [] }, null, 2))
mkdirSync(join(home, '.orca-flow'), { recursive: true })
writeFileSync(join(home, '.orca-flow', 'config.json'), JSON.stringify({ features: { goals: true, linear: false, tokenSpeed: false, bots: false } }))

let answers
try {
  answers = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--worker-answers'], { env: { ...process.env, HOME: home }, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] }))
} catch (e) {
  console.error(`the worker's snapshot failed in the fixture HOME: ${e.message}`)
  process.exit(1)
}

// ---------- step 3: Orca's frame protocol, with every transpile timing out ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' }
const served = []
const bridge = (state) => `<script>
(() => {
  const answers = ${JSON.stringify({ ...answers[state], completed: answers.completed, usage: answers.usage })};
  const errors = window.__coldStartErrors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)), true);
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason?.message || e.reason)));
  const stored = {};
  window.orca = {
    plugin: {
      request: async (name, input) => {
        if (name === 'sidebar.list') return JSON.parse(JSON.stringify(answers.snapshot));
        if (name === 'sidebar.goals') return JSON.parse(JSON.stringify(answers.goals));
        if (name === 'sidebar.settings') return { settings: {}, error: null, version: null, writers: [] };
        if (name === 'goals.completed') return JSON.parse(JSON.stringify(answers.completed));
        if (name === 'analytics.view') return answers.usage[input?.window] ?? Object.values(answers.usage)[0];
        return null;
      },
      on: () => () => {}
    },
    storage: { get: async (k) => stored[k] ?? null, set: async (k, v) => { stored[k] = v } },
    shell: { openExternal: async () => {} }
  };
  // What the frame drew, read by --dump-dom once the page settles.
  window.addEventListener('load', () => setTimeout(() => {
    const $$ = (s) => [...document.querySelectorAll(s)];
    const main = document.getElementById('main');
    const report = {
      errors,
      coordinators: $$('section.coordinator .coord-name .name').map((e) => e.textContent),
      workstreams: main ? [...new Set($$('#main [data-open]').map((e) => e.getAttribute('data-open')))] : [],
      mainText: main ? main.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400) : null,
      goals: $$('#goals-rows .g .ti').map((e) => e.textContent),
      app: document.getElementById('app')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300) ?? null,
      loadFailed: document.querySelector('.load-failed')?.textContent ?? null
    };
    const pre = document.createElement('pre');
    pre.id = 'cold-start-report';
    pre.hidden = true;
    pre.textContent = JSON.stringify(report);
    document.body.append(pre);
  }, 1500));
})();
</script>`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '')
  if (rel.startsWith('..')) return res.writeHead(403).end()
  served.push(rel)
  const ext = extname(rel)
  if (TRANSPILED.has(ext)) {
    // Orca 1.4.263 serves this module when the transpile worker misses the 2000 ms budget (nI(...) in out/main/index.js).
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    return res.end(`throw new Error(${JSON.stringify(`${rel}: took over the 2000 ms transpile budget; split it into smaller modules`)})\n`)
  }
  let body
  try { body = readFileSync(join(ROOT, rel)) } catch { return res.writeHead(404).end() }
  if (ext === '.html') {
    let html = body.toString('utf8')
    // ?entry=ts: the entry as it was before this change (the .ts module), to show the model reproduces the failure.
    if (url.searchParams.get('entry') === 'ts') html = html.replace(/(<script\b[^>]*\bsrc=["'][^"']+)\.js(["'])/g, '$1.ts$2')
    html = html.replace('<head>', `<head>${bridge(url.searchParams.get('state') ?? 'cold')}`)
    res.writeHead(200, { 'content-type': MIME['.html'] })
    return res.end(html)
  }
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' })
  res.end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const cases = [
  { name: 'panel, Orca CLI not ready (workspace.list fallback)', path: 'src/panel/index.html?state=cold', shot: 'panel-cold.png' },
  { name: 'panel, Orca ready', path: 'src/panel/index.html?state=warm', shot: 'panel-warm.png' },
  { name: 'Usage editor', path: 'src/editor/index.html?state=warm' },
  { name: 'Completed goals editor', path: 'src/editor/goals.html?state=warm' },
  { name: 'panel, old TypeScript entry (must fail like Orca did)', path: 'src/panel/index.html?state=warm&entry=ts', shot: 'panel-old-ts-entry.png' }
]

if (process.argv.includes('--serve')) {
  for (const c of cases) console.log(`${c.name}: ${base}/${c.path}`)
  console.log(`fixture HOME: ${home}`)
  process.on('SIGINT', () => { rmSync(home, { recursive: true, force: true }); process.exit(0) })
} else {
  const chrome = (args) => new Promise((resolve, reject) => {
    const profile = mkdtempSync(join(tmpdir(), 'orca-flow-cold-start-chrome-'))
    execFile(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=400,900', ...args], { timeout: 60_000, maxBuffer: 20e6 }, (e, out) => {
      rmSync(profile, { recursive: true, force: true })
      e ? reject(e) : resolve(out)
    })
  })
  const shotsAt = process.argv.indexOf('--shots')
  const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null
  if (shots) mkdirSync(shots, { recursive: true })
  const failures = []
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}   ${what}`); if (!ok) failures.push(what) }
  const reportOf = async (c) => {
    served.length = 0
    const dom = await chrome(['--virtual-time-budget=10000', '--dump-dom', `${base}/${c.path}`])
    const m = /<pre id="cold-start-report" hidden="">([\s\S]*?)<\/pre>/.exec(dom)
    const report = m ? JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null
    if (shots && c.shot) await chrome(['--virtual-time-budget=10000', `--screenshot=${join(shots, c.shot)}`, `${base}/${c.path}`])
    return { report, transpiled: [...new Set(served.filter((f) => TRANSPILED.has(extname(f))))] }
  }
  try {
    const { cold, warm } = answers
    console.log(`worker snapshot, CLI not ready: source=${cold.snapshot.source}, ${cold.snapshot.coordinators.length} coordinators, ${cold.snapshot.rows.length} rows; log: ${answers.logs.find((l) => l.includes('worktree ps failed')) ?? '(none)'}`)
    console.log(`worker snapshot, Orca ready:    source=${warm.snapshot.source}, ${warm.snapshot.coordinators.length} coordinators, ${warm.snapshot.rows.length} rows, ${warm.goals.length} goals`)
    check(cold.snapshot.source === 'api' && cold.snapshot.coordinators.map((c) => c.name).join() === 'ops,shop', 'cold worker snapshot: workspace.list fallback, both saved coordinators from disk')
    check(JSON.stringify(cold.snapshot.coordinators.find((c) => c.name === 'shop').sessions) === JSON.stringify(savedShop.sessions), 'cold worker snapshot: the saved session member comes back exactly as saved')
    check(JSON.stringify(answers.saved.sessions.members.map((m) => m.id)) === JSON.stringify([member.id]) && answers.saved.sessions.current === member.id, 'the saved coordinator.json keeps its member and current after both snapshots')

    for (const c of cases) {
      const { report, transpiled } = await reportOf(c)
      console.log(`\n${c.name}\n  ${base}/${c.path}\n  ${report ? JSON.stringify({ coordinators: report.coordinators, workstreams: report.workstreams, goals: report.goals, errors: report.errors, main: report.mainText }) : 'no report: the page did not finish'}`)
      if (c.path.includes('entry=ts')) {
        check(transpiled.includes('src/panel/app.ts') && !!report && report.errors.some((e) => e.includes('took over the 2000 ms transpile budget')) && report.coordinators.length === 0, 'old .ts entry: the transpile timeout throws and no coordinator draws (the reported black panel)')
        check(/^Orca Flow could not load\. Restart Orca/.test(report?.loadFailed ?? ''), `old .ts entry: the frame says it could not load instead of staying blank ("${report?.loadFailed}")`)
        continue
      }
      check(transpiled.length === 0, `${c.name}: no module Orca transpiles was requested${transpiled.length ? ` (${transpiled.join(', ')})` : ''}`)
      check(!!report && report.loadFailed === null, `${c.name}: no "could not load" message`)
      check(!!report && report.errors.length === 0, `${c.name}: no error${report?.errors.length ? `: ${report.errors.join(' | ')}` : ''}`)
      if (!report) continue
      if (c.path.startsWith('src/panel/')) {
        check(report.coordinators.includes('shop') && report.coordinators.includes('ops'), `${c.name}: both saved coordinators draw (${report.coordinators.join(', ')})`)
        check(report.goals.includes('Ship the checkout rewrite') && report.goals.includes('Plan the Q1 pricing page') && !report.goals.includes('Fix the flaky login test'), `${c.name}: the open saved goals draw (${report.goals.length})`)
        if (c.path.includes('state=warm')) check(report.workstreams.includes('identity:wt-checkout') && report.workstreams.includes('identity:wt-pricing'), `${c.name}: both workstreams draw (${report.workstreams.join(', ')})`)
      } else {
        check(!!report.app && report.app.length > 20, `${c.name}: the view draws ("${(report.app ?? '').slice(0, 60)}…")`)
      }
    }
    if (shots) console.log(`\nscreenshots in ${shots}`)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall cold-start checks passed')
  process.exit(failures.length ? 1 : 0)
}
