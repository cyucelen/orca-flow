// Browser-only fixture for the Analytics sidebar section and the Usage tab, in the actual panel and
// editor code. No plugin install, no worker, nothing read from ~/.orca-flow: `orca` is a stub that
// answers from src/analytics-fixture.ts (the same data the tests use).
//   node scripts/analytics-preview.mjs                 serve; open the printed URL
//                                                      /sidebar?theme=light   the panel at 340 px (add &w=30d, &m=cost, &details=1, &fold=1 folded)
//                                                      /editor?theme=dark&w=30d&click=<selector>&details=1&empty=running
//   node scripts/analytics-preview.mjs --shots <dir>   capture the sidebar and the Usage tab, dark and light, then exit
//   add --live                                         the views from the running local.flow (orca plugin dev request analytics.view) in place of the fixture
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = mkdtempSync(join(tmpdir(), 'orca-flow-analytics-preview-'))
const esbuild = (args) => execFileSync('npx', ['-y', 'esbuild', ...args, '--bundle', '--tsconfig-raw={}', '--log-level=warning'], { cwd: root, stdio: 'inherit' })
esbuild(['src/panel/app.ts', '--format=esm', `--outfile=${join(build, 'app.js')}`])
esbuild(['src/editor/main.ts', '--format=esm', `--outfile=${join(build, 'editor.js')}`])
// The fixture's views, computed by the real aggregation (node side), as plain JSON for the browser stub.
writeFileSync(join(build, 'dump.ts'), `
import { analyticsView, buildModel, usageSummary, workstreamView } from ${JSON.stringify(join(root, 'src/analytics.ts'))}
import { FIXTURE_NOW, fixtureInputs, fixtureModel } from ${JSON.stringify(join(root, 'src/analytics-fixture.ts'))}
import { normalizeRouting } from ${JSON.stringify(join(root, 'src/routing.ts'))}
export function dump() {
  const model = fixtureModel()
  const views = Object.fromEntries(['7d', '30d', 'all'].map((w) => [w, analyticsView(model, w, { state: 'done', read: 0, total: 0 })]))
  const running = Object.fromEntries(['7d', '30d', 'all'].map((w) => [w, analyticsView(model, w, { state: 'running', read: 120, total: 340 })]))
  const ws = Object.fromEntries([...model.workstreams.keys()].map((id) => [id, workstreamView(model, id)]))
  const empty = buildModel({ now: FIXTURE_NOW, usage: [], coverage: new Map(), links: [], routes: [], routing: normalizeRouting(undefined) })
  const emptyViews = Object.fromEntries(['7d', '30d', 'all'].map((w) => [w, analyticsView(empty, w, { state: 'running', read: 12, total: 340 })]))
  return { views, running, ws, emptyViews, summary: usageSummary(fixtureInputs().usage, FIXTURE_NOW), now: FIXTURE_NOW }
}
`)
esbuild([join(build, 'dump.ts'), '--format=esm', '--platform=node', '--packages=external', `--outfile=${join(build, 'dump.mjs')}`])
const data = (await import(pathToFileURL(join(build, 'dump.mjs')).href)).dump()
// --live: this Mac's usage, as the running development plugin answers it (read only).
if (process.argv.includes('--live')) {
  const ask = (w) => JSON.parse(execFileSync('orca', ['plugin', 'dev', 'request', 'local.flow', 'analytics.view', '--data', JSON.stringify({ window: w }), '--json'], { maxBuffer: 64 << 20 })).result.result
  data.views = Object.fromEntries(['7d', '30d', 'all'].map((w) => [w, ask(w)]))
}

const LIGHT = { '--orca-background': '#f7f7f9', '--orca-foreground': '#1c1c20', '--orca-muted-foreground': '#5f5f69', '--orca-border': '#e1e1e7', '--orca-accent': '#ececf0', '--orca-popover': '#ffffff', '--orca-popover-foreground': '#1c1c20' }
const DARK = { '--orca-background': '#161618', '--orca-foreground': '#e9e9ec', '--orca-muted-foreground': '#8d8d96', '--orca-border': '#27272c', '--orca-accent': '#1f1f23', '--orca-popover': '#232328', '--orca-popover-foreground': '#e9e9ec' }
const theme = `<script>
const q = new URLSearchParams(location.search);
const light = q.get('theme') === 'light';
if (light) document.documentElement.classList.add('light');
for (const [k, v] of Object.entries(light ? ${JSON.stringify(LIGHT)} : ${JSON.stringify(DARK)})) document.documentElement.style.setProperty(k, v);
document.head.insertAdjacentHTML('beforeend', '<style>.tip { transition: none !important; }</style>');
// tall=1: the Analytics section unclipped (it scrolls at 45vh in Orca), to look at its whole layout.
if (q.get('tall')) document.head.insertAdjacentHTML('beforeend', '<style>.tsec { max-height: none !important; }</style>');
if (q.get('click')) setTimeout(() => document.querySelector(q.get('click'))?.click(), 600);
if (q.get('click2')) setTimeout(() => document.querySelector(q.get('click2'))?.click(), 900);
</script>`

// ---- the sidebar: the real panel with a stub worker ----
const now = data.now
const agent = (paneKey, agentType, over = {}) => ({ paneKey, agentType, live: true, title: paneKey, state: 'working', workingMode: null, coordinator: 'home', leadPane: null, parentPane: null, orcaSession: null, dispatch: 'open', terminal: `term-${paneKey}`, question: null, summary: null, ...over })
const snapshot = {
  source: 'cli', capacity: null, ready: true, focusedPanes: [],
  coordinators: [{ key: 'home', name: 'Shop', repos: ['shop'], workspaceId: 'home', session: agent('Coordinator', 'claude', { state: 'done', dispatch: null }) }],
  rows: [{ id: 'feature', name: 'feature', branch: 'settings', repo: 'shop', path: '/fixture/feature', main: false, agents: [agent('Settings lead', 'claude', { state: 'waiting' }), agent('Codex worker', 'codex', { leadPane: 'Settings lead' })],
    state: 'working', priority: null, card: null, parentId: null, liveTerminals: 2, pinned: false, unread: false, active: true, workspaceStatus: null, lastActivityAt: now, createdAt: 1, pr: null }]
}
const wave = (n, base, amp, phase) => Array.from({ length: n }, (_, k) => Math.max(0, Math.round((base + amp * Math.sin(k / 4 + phase) + amp * 0.4 * Math.sin(k / 1.7 + phase)) * 10) / 10))
const series = (n, step) => ({
  start: Date.now() - n * step, step, netSecs: 3600,
  tok: { 'claude-opus-5-5': wave(n, 42, 22, 0.3), 'claude-sonnet-5-5': wave(n, 60, 30, 1.9), 'gpt-6.2-astra': wave(n, 24, 14, 3.1) },
  up: wave(n, 38000, 16000, 0.7), down: wave(n, 210000, 90000, 2.4)
})
const speed = {
  now, ready: true, tokPerSec: 118, net: { at: now, up: 41000, down: 232000, procs: 4 },
  internet: { at: Date.now() - 3 * 3600_000, down: 412e6, up: 48e6, rtt: 18, rpm: 1420 },
  models: [['claude-opus-5-5', 'Opus 5.5', 62, 58, 1184], ['claude-sonnet-5-5', 'Sonnet 5.5', 91, 87, 902], ['gpt-6.2-astra', 'GPT-6.2 Astra', 118, 104, 311]]
    .map(([id, label, m1, m24, c], slot) => ({ id, label, slot, median1h: m1, median24h: m24, count1h: Math.round(c / 20), count24h: c, tokens24h: c * 900 })),
  series: { '1h': series(60, 60_000), '24h': series(96, 900_000) },
  usage: { ...data.summary, tokens: 52_400_000, cost: 48.2, unpriced: 0 }
}
const sidebarBridge = `${theme}<script>
const snapshot = ${JSON.stringify(snapshot)};
const speed = ${JSON.stringify(speed)};
const views = ${JSON.stringify(data.views)};
window.previewCalls = [];
window.orca = {
  plugin: {
    request: async (name, d) => { previewCalls.push({ name, data: d });
      if (name === 'sidebar.list') return snapshot;
      if (name === 'sidebar.tokenSpeed') return speed;
      if (name === 'analytics.view') return views[d?.window ?? '7d'];
      return null; },
    on: () => () => {}
  },
  storage: { get: async (k) => (k === 'speed-ui' ? { folded: !!q.get('fold'), range: '1h', window: q.get('w') || '7d', metric: q.get('m') || 'tokens' } : null), set: async () => {} }, shell: { openExternal: async () => {} }
};
if (q.get('details')) window.addEventListener('load', () => setTimeout(() => document.querySelector('[data-udetails]')?.click(), 900));
</script>`
const sidebarHtml = readFileSync(join(root, 'src/panel/index.html'), 'utf8')
  .replace('<head>', '<head><title>Analytics sidebar fixture</title>')
  .replace('<script type="module" src="./app.ts"></script>', `${sidebarBridge}<script type="module" src="./app.js"></script>`)

// ---- the Usage tab: the real editor frame with a stub worker ----
const editorBridge = `${theme}<script>
const data = ${JSON.stringify(data)};
const pick = q.get('empty') ? data.emptyViews : q.get('fill') ? data.running : data.views;
window.orca = {
  plugin: {
    request: async (name, d) => name === 'analytics.view' ? pick[d?.window ?? '7d'] : name === 'analytics.workstream' ? (data.ws[d.id] ?? null) : null,
    on: () => () => {}
  },
  storage: { get: async () => ({ window: q.get('w') || '7d' }), set: async () => {} },
  document: { get: async () => ({ version: 1, readOnly: false, content: { kind: 'text', text: '' } }) }
};
if (q.get('details')) window.addEventListener('load', () => setTimeout(() => document.querySelector('[data-act="details"]')?.click(), 1200));
</script>`
const editorHtml = readFileSync(join(root, 'src/editor/index.html'), 'utf8')
  .replace('<head>', '<head><title>Usage fixture</title>')
  .replace('<script type="module" src="./main.ts"></script>', `${editorBridge}<script type="module" src="./editor.js"></script>`)

const assets = new Map([
  ['/sidebar', ['text/html', sidebarHtml]], ['/editor', ['text/html', editorHtml]],
  ['/panel.css', ['text/css', readFileSync(join(root, 'src/panel/panel.css'))]],
  ['/editor.css', ['text/css', readFileSync(join(root, 'src/editor/editor.css'))]],
  ['/app.js', ['text/javascript', readFileSync(join(build, 'app.js'))]],
  ['/editor.js', ['text/javascript', readFileSync(join(build, 'editor.js'))]]
])
rmSync(build, { recursive: true, force: true })
// Chrome will not size a window under ~500 px: narrow shots render in an iframe of exactly that size.
const frame = (src, w, h) => `<!doctype html><body style="margin:0;background:#888;display:flex;justify-content:center;align-items:center;min-height:100vh"><iframe src="${src}" style="border:0;display:block;flex:none;width:${w}px;height:${h}px"></iframe>`
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/frame') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(frame(url.searchParams.get('src'), url.searchParams.get('w'), url.searchParams.get('h'))); return }
  // The panel's index.html links ./panel.css and the editor's ./editor.css relative to /sidebar and /editor.
  const asset = assets.get(url.pathname)
  if (!asset) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': asset[0] }); res.end(asset[1])
})

const shots = process.argv.indexOf('--shots')
server.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}`
  if (shots < 0) return console.log(`Analytics fixture: ${base}/sidebar?theme=dark  ${base}/editor?theme=dark&w=7d`)
  const out = process.argv[shots + 1] || '/tmp/orca-analytics-shots'
  mkdirSync(out, { recursive: true })
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = mkdtempSync(join(tmpdir(), 'orca-flow-chrome-'))
  const jobs = []
  for (const theme of ['dark', 'light']) {
    jobs.push({ name: `sidebar-${theme}-340`, path: '/sidebar', q: `theme=${theme}`, w: 340, h: 1100 })
    jobs.push({ name: `sidebar-${theme}-340-folded`, path: '/sidebar', q: `theme=${theme}&fold=1`, w: 340, h: 420 })
    jobs.push({ name: `usage-${theme}-desktop`, path: '/editor', q: `theme=${theme}&w=7d`, w: 1280, h: 1500, plain: true })
    jobs.push({ name: `usage-${theme}-narrow`, path: '/editor', q: `theme=${theme}&w=7d`, w: 420, h: 1800 })
  }
  // The other screens and states, desktop width, dark and light.
  for (const theme of ['dark', 'light']) {
    jobs.push({ name: `usage-${theme}-kind`, path: '/editor', q: `theme=${theme}&click=${encodeURIComponent('tr[data-go="kind:hard"]')}`, w: 1280, h: 760, plain: true })
    jobs.push({ name: `usage-${theme}-workstream`, path: '/editor', q: `theme=${theme}&click=${encodeURIComponent('[data-go="ws:L"]')}&details=1`, w: 1280, h: 1100, plain: true })
    jobs.push({ name: `usage-${theme}-comparison`, path: '/editor', q: `theme=${theme}&w=30d&click=${encodeURIComponent('[data-go="cmp:p1"]')}&details=1`, w: 1280, h: 760, plain: true })
    jobs.push({ name: `usage-${theme}-empty`, path: '/editor', q: `theme=${theme}&empty=1`, w: 1280, h: 420, plain: true })
    jobs.push({ name: `usage-${theme}-filling`, path: '/editor', q: `theme=${theme}&fill=1&w=30d`, w: 1280, h: 640, plain: true })
  }
  jobs.push({ name: 'sidebar-dark-340-30d-cost', path: '/sidebar', q: 'theme=dark&w=30d&m=cost', w: 340, h: 1100 })
  jobs.push({ name: 'sidebar-dark-340-details', path: '/sidebar', q: 'theme=dark&details=1', w: 340, h: 1400 })
  jobs.push({ name: 'sidebar-dark-340-tall', path: '/sidebar', q: 'theme=dark&tall=1', w: 340, h: 2000 })
  jobs.push({ name: 'sidebar-light-340-tall', path: '/sidebar', q: 'theme=light&tall=1&w=30d&m=cost', w: 340, h: 2000 })
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
  const run = async () => {
    for (const j of jobs.filter((x) => !only || x.name.includes(only))) {
      const file = join(out, `${j.name}.png`)
      await new Promise((resolve, reject) => {
        const target = j.plain ? `${base}${j.path}?${j.q}` : `${base}/frame?src=${encodeURIComponent(`${j.path}?${j.q}`)}&w=${j.w}&h=${j.h}`
        const framed = !j.plain
        const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--window-size=${framed ? Math.max(600, j.w + 100) : j.w},${framed ? j.h + 100 : j.h}`, '--virtual-time-budget=5000', `--screenshot=${file}`, target]
        execFile(chrome, args, { timeout: 60_000 }, (e, _out, stderr) => {
          if (e && !/bytes written to file/.test(String(stderr))) return reject(e)
          if (framed) execFileSync('sips', ['--cropToHeightWidth', String(j.h), String(j.w), file], { stdio: 'ignore' })
          resolve()
        })
      })
      console.log(file)
    }
  }
  run().catch((e) => { console.error(e.message); process.exitCode = 1 }).finally(() => { server.close(); rmSync(profile, { recursive: true, force: true }) })
})
