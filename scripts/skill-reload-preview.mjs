// Browser-only fixture for "Reload skills" in the actual panel code: no plugin load, worker or Orca
// state. `orca` is a stub whose sidebar.list answers with a fixture tree and whose sidebar.reloadSkills
// is recorded in window.previewCalls.
//   node scripts/skill-reload-preview.mjs                 serve; open the printed URL (?show=menu|confirm|coordinator-confirm)
//   node scripts/skill-reload-preview.mjs --shots <dir>   capture the status, the menu and both confirmations, then exit
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = mkdtempSync(join(tmpdir(), 'orca-flow-reload-preview-'))
execFileSync('npx', ['-y', 'esbuild', 'src/panel/app.ts', '--bundle', '--format=esm', '--tsconfig-raw={}', '--log-level=warning', `--outfile=${join(build, 'app.js')}`], { cwd: root, stdio: 'inherit' })

const now = Date.now()
const role = (r) => ({ title: r, goal: '', since: '', needs: { type: 'none', ask: '', options: [] }, effort: 'quick', priority: 'P2', role: r, updatedAt: now })
const agent = (paneKey, title, over = {}) => ({
  paneKey, title, agentType: 'claude', live: true, state: 'working', workingMode: null, coordinator: 'shop', leadPane: null, parentPane: null,
  orcaSession: null, dispatch: 'open', terminal: `term-${paneKey}`, question: null, summary: null, ...over
})
const row = (id, repo, agents, over = {}) => ({ id, name: id, branch: id, repo, path: `/fixture/${id}`, main: false, agents, state: agents[0].state, priority: null, card: null, parentId: null,
  liveTerminals: agents.length, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: now - 7 * 60_000, createdAt: 1, pr: null, ...over })
const entry = (pane, state, r, over = {}) => ({ pane, state, role: r, provider: 'claude', at: now - 4 * 60_000, expiresAt: now + 20 * 3600_000, request: 'r1', ...over })
const fixture = {
  source: 'cli', capacity: null, ready: true, focusedPanes: [],
  coordinators: [
    { key: 'shop', name: 'Shop', repos: ['shop'], workspaceId: 'ws-shop', look: { color: '#4cb782', shape: 'pentagon' }, session: agent('home-shop', 'Shop', { state: 'done', dispatch: null, summary: role('coordinator') }) },
    { key: 'docs', name: 'Docs', repos: ['docs'], workspaceId: 'ws-docs', look: { color: '#b07cf0', shape: 'hex' }, session: agent('home-docs', 'Docs', { coordinator: 'docs', state: 'done', dispatch: null, summary: role('coordinator') }) }
  ],
  rows: [
    row('checkout', 'shop', [
      agent('lead', 'Guest checkout', { summary: role('lead') }),
      agent('w1', 'Cart totals rounding', { leadPane: 'lead' }),
      agent('w2', 'Coupon stacking tests', { leadPane: 'lead', agentType: 'codex' }),
      agent('w3', 'Address form copy', { leadPane: 'lead', state: 'done', dispatch: 'settled' })
    ]),
    row('api-docs', 'docs', [agent('dlead', 'API reference refresh', { coordinator: 'docs', state: 'done', summary: role('lead') })]),
    row('scratch', 'notes', [agent('chat', 'Release notes draft', { coordinator: 'you', dispatch: null })])
  ],
  skillReload: [
    entry('home-shop', 'reloaded', 'coordinator', { doneAt: now - 2 * 60_000 }),
    entry('lead', 'reading', 'lead'),
    entry('w1', 'waiting', 'worker'),
    entry('w2', 'unsupported', 'worker', { provider: 'codex' }),
    entry('home-docs', 'reloaded', 'coordinator', { doneAt: now - 60_000 }),
    entry('dlead', 'waiting', 'lead')
  ]
}
const bridge = `<script>
const q = new URLSearchParams(location.search);
const fixture = ${JSON.stringify(fixture).replaceAll('<', '\\u003c')};
if (q.get('status') === 'none') delete fixture.skillReload;
fixture.features = { linear: false, tokenSpeed: false };
const listeners = new Map();
window.previewCalls = [];
window.orca = { plugin: {
  request: async (name, data) => {
    previewCalls.push({ name, data });
    if (name === 'sidebar.list') return structuredClone(fixture);
    if (name === 'sidebar.reloadSkills') return { ok: true, asked: 3, unsupported: 1, skipped: { finished: 1, asleep: 0 } };
    if (name === 'sidebar.linear' || name === 'sidebar.tokenSpeed') return null;
    return { ok: true };
  },
  on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) }
}, storage: { get: async () => null, set: async () => {} }, shell: { openExternal: async () => {} } };
// ?show=menu: the Shop coordinator's right-click menu; confirm: the heading's action; coordinator-confirm: the menu's item.
const after = (ms, fn) => setTimeout(fn, ms);
const show = q.get('show');
const row = () => document.querySelector('[data-menu="coordinator:shop"]');
if (show === 'menu' || show === 'coordinator-confirm') after(600, () => {
  const r = row().getBoundingClientRect();
  row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 18 }));
  if (show === 'coordinator-confirm') after(200, () => [...document.querySelectorAll('#ctx .mi')].find((el) => el.textContent.includes('Reload skills'))?.click());
});
if (show === 'confirm') after(600, () => document.querySelector('[data-reload-skills]').click());
</script>`
const html = readFileSync(join(root, 'src/panel/index.html'), 'utf8')
  .replace('<head>', '<head><title>Reload skills fixture · Orca Flow</title>')
  .replace('<script type="module" src="./app.ts"></script>', `${bridge}<script type="module" src="./app.js"></script>`)
const assets = new Map([
  ['/', ['text/html', html]],
  ['/panel.css', ['text/css', readFileSync(join(root, 'src/panel/panel.css'))]],
  ['/app.js', ['text/javascript', readFileSync(join(build, 'app.js'))]]
])
rmSync(build, { recursive: true, force: true })
// Chrome will not size a window under ~500 px: the panel renders in an iframe of the sidebar's size.
const frame = (q) => `<!doctype html><body style="margin:0;background:#888;display:flex;justify-content:center;align-items:center;min-height:100vh"><iframe src="/?${q}" style="border:0;display:block;flex:none;width:${new URLSearchParams(q).get('w')}px;height:${new URLSearchParams(q).get('h')}px"></iframe>`
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
  if (shots < 0) return console.log(`Reload skills fixture: ${base}?show=menu`)
  const out = process.argv[shots + 1] || '/tmp/orca-flow-reload-shots'
  mkdirSync(out, { recursive: true })
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = mkdtempSync(join(tmpdir(), 'orca-flow-chrome-'))
  const [width, height] = [360, 640]
  const jobs = [
    { name: 'reload-status', query: '' },
    { name: 'reload-menu', query: 'show=menu&status=none' },
    { name: 'reload-confirm-all', query: 'show=confirm&status=none' },
    { name: 'reload-confirm-coordinator', query: 'show=coordinator-confirm&status=none' }
  ]
  const run = async () => {
    for (const j of jobs) {
      const file = join(out, `${j.name}.png`)
      await new Promise((resolve, reject) => {
        const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--window-size=${Math.max(600, width + 100)},${height + 100}`, '--virtual-time-budget=4000', `--screenshot=${file}`,
          `${base}frame?${j.query}&w=${width}&h=${height}`]
        execFile(chrome, args, { timeout: 60_000 }, (e, _out, stderr) => {
          if (e && !/bytes written to file/.test(String(stderr))) return reject(e)
          execFileSync('sips', ['--cropToHeightWidth', String(height), String(width), file], { stdio: 'ignore' })
          resolve()
        })
      })
      console.log(file)
    }
  }
  run().catch((e) => { console.error(e.message); process.exitCode = 1 }).finally(() => { server.close(); rmSync(profile, { recursive: true, force: true }) })
})
