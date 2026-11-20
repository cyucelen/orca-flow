// Browser-only fixture for the Settings dialog in the actual panel code. No plugin install, worker,
// config reads or writes: `orca` is a stub whose sidebar.settings answers with fixture data and whose
// saves are recorded in window.previewCalls.
//   node scripts/settings-preview.mjs                 serve; open the printed URL (add ?page=format&theme=light)
//   node scripts/settings-preview.mjs --shots <dir>   capture every page, dark and light, narrow and wide, then exit
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = mkdtempSync(join(tmpdir(), 'orca-flow-settings-preview-'))
execFileSync('npx', ['-y', 'esbuild', 'src/panel/app.ts', '--bundle', '--format=esm', '--tsconfig-raw={}', '--log-level=warning', `--outfile=${join(build, 'app.js')}`], { cwd: root, stdio: 'inherit' })

const now = Date.now()
const agent = (paneKey, agentType, over = {}) => ({
  paneKey, agentType, live: true, title: paneKey, state: 'working', workingMode: null, coordinator: 'home', leadPane: null, parentPane: null,
  orcaSession: null, dispatch: 'open', terminal: `term-${paneKey}`, question: null, summary: null, ...over
})
const snapshot = {
  source: 'cli', capacity: null, ready: true, focusedPanes: [],
  coordinators: [{ key: 'home', name: 'Shop', repos: ['shop'], workspaceId: 'home', session: agent('Coordinator', 'claude', { state: 'done', dispatch: null }) }],
  rows: [{ id: 'feature', name: 'feature', branch: 'settings', repo: 'shop', path: '/fixture/feature', main: false, agents: [agent('Settings lead', 'claude', { state: 'waiting' }), agent('Codex worker', 'codex', { leadPane: 'Settings lead' })],
    state: 'working', priority: null, card: null, parentId: null, liveTerminals: 2, pinned: false, unread: false, active: true, workspaceStatus: null, lastActivityAt: now, createdAt: 1, pr: null }]
}
const settings = {
  version: '0.2.63', error: null,
  settings: {
    writers: [{ provider: 'claude', model: 'haiku', enabled: true }, { provider: 'codex', model: 'gpt-6-luna', enabled: true }, { provider: 'antigravity', enabled: false }],
    messageFormat: ['~/orca/coordinators', '~/orca/workspaces/shop'], marginGB: 2, warnHeadroomGB: 2, linearDryRun: false
  },
  writers: [
    { provider: 'claude', lastSuccessAt: now - 2 * 60_000, failure: null, installed: true },
    { provider: 'codex', lastSuccessAt: null, failure: null, installed: true },
    { provider: 'antigravity', lastSuccessAt: null, failure: null, installed: true }
  ]
}
const LIGHT = { '--orca-background': '#f7f7f9', '--orca-foreground': '#1c1c20', '--orca-muted-foreground': '#5f5f69', '--orca-border': '#e1e1e7', '--orca-accent': '#ececf0', '--orca-popover': '#ffffff', '--orca-popover-foreground': '#1c1c20' }
const bridge = `<script>
const q = new URLSearchParams(location.search);
if (q.get('theme') === 'light') { document.documentElement.classList.add('light'); for (const [k, v] of Object.entries(${JSON.stringify(LIGHT)})) document.documentElement.style.setProperty(k, v); }
const snapshot = ${JSON.stringify(snapshot)};
const settings = ${JSON.stringify(settings)};
if (q.get('state') === 'broken') settings.error = '~/.orca-flow/config.json isn’t valid JSON: Expected double-quoted property name in JSON at position 18';
window.previewCalls = [];
window.orca = {
  plugin: {
    request: async (name, data) => { previewCalls.push({ name, data }); return name === 'sidebar.list' ? snapshot : name === 'sidebar.settings' ? settings : name === 'sidebar.saveSettings' ? { ok: true, state: { ...settings, settings: data.settings } } : name === 'sidebar.linear' ? null : { ok: true }; },
    on: () => () => {}
  },
  storage: { get: async () => null, set: async () => {} }, shell: { openExternal: async () => {} }
};
window.addEventListener('load', () => setTimeout(() => {
  document.getElementById('settings-open').click();
  setTimeout(() => document.querySelector('[data-page="' + (q.get('page') || 'summaries') + '"]')?.click(), 100);
}, 200));
</script>`
const html = readFileSync(join(root, 'src/panel/index.html'), 'utf8')
  .replace('<head>', '<head><title>Settings fixture · Orca Flow</title>')
  .replace('<script type="module" src="./app.ts"></script>', `${bridge}<script type="module" src="./app.js"></script>`)
const assets = new Map([
  ['/', ['text/html', html]],
  ['/panel.css', ['text/css', readFileSync(join(root, 'src/panel/panel.css'))]],
  ['/app.js', ['text/javascript', readFileSync(join(build, 'app.js'))]]
])
rmSync(build, { recursive: true, force: true })
// Chrome will not size a window under ~500 px, so a narrow panel is an iframe of exactly that width.
const frame = (q) => `<!doctype html><body style="margin:0;background:#888;display:flex;justify-content:center"><iframe src="/?${q}" style="border:0;display:block;width:${new URLSearchParams(q).get('w')}px;height:${new URLSearchParams(q).get('h')}px"></iframe>`
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/frame') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(frame(url.searchParams.toString())); return }
  const asset = assets.get(url.pathname)
  if (!asset) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': asset[0] }); res.end(asset[1])
})

const shots = process.argv.indexOf('--shots')
server.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}/`
  if (shots < 0) return console.log(`Settings fixture: ${base}?page=summaries&theme=dark`)
  const out = process.argv[shots + 1] || '/tmp/orca-settings-shots'
  mkdirSync(out, { recursive: true })
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = mkdtempSync(join(tmpdir(), 'orca-flow-chrome-'))
  const sizes = { 360: [360, 820], wide: [1180, 780] }
  const jobs = []
  for (const page of ['summaries', 'format', 'capacity', 'advanced']) for (const theme of ['dark', 'light']) for (const [w, [width, height]] of Object.entries(sizes)) jobs.push({ page, theme, w, width, height })
  if (process.argv.includes('--broken')) jobs.push({ page: 'summaries', theme: 'dark', w: 'wide', width: 1180, height: 780, state: 'broken' })
  const run = async () => {
    for (const j of jobs) {
      const file = join(out, `${j.page}-${j.theme}-${j.w}${j.state ? `-${j.state}` : ''}.png`)
      await new Promise((resolve, reject) => {
        const query = `page=${j.page}&theme=${j.theme}${j.state ? `&state=${j.state}` : ''}`
        const narrow = j.width < 600
        const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--window-size=${narrow ? 600 : j.width},${j.height}`, '--virtual-time-budget=4000', `--screenshot=${file}`,
          narrow ? `${base}frame?${query}&w=${j.width}&h=${j.height}` : `${base}?${query}`]
        execFile(chrome, args, { timeout: 60_000 }, (e) => {
          if (e) return reject(e)
          // Keep just the panel: sips crops around the centre, where the iframe sits.
          if (narrow) execFileSync('sips', ['--cropToHeightWidth', String(j.height), String(j.width), file], { stdio: 'ignore' })
          resolve()
        })
      })
      console.log(file)
    }
  }
  run().catch((e) => { console.error(e.message); process.exitCode = 1 }).finally(() => { server.close(); rmSync(profile, { recursive: true, force: true }) })
})
