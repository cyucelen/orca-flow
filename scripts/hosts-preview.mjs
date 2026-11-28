// Browser-only fixture for paired hosts in the actual panel code: no plugin load, worker, Orca or host.
// `orca` is a stub whose sidebar.list answers with a fixture snapshot; every request is recorded in
// window.previewCalls (a remote row's click must record no sidebar.open).
//   node scripts/hosts-preview.mjs                 serve; open the printed URL (?state=reachable|hosts|unavailable|upnext|several|checking|none)
//   node scripts/hosts-preview.mjs --shots <dir>   capture each state as <dir>/hosts-<state>.png, then exit
// The build goes to a temporary folder and the shots to <dir>: nothing is written into the plugin folder.
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = mkdtempSync(join(tmpdir(), 'orca-flow-hosts-preview-'))
execFileSync('npx', ['-y', 'esbuild', 'src/panel/app.ts', '--bundle', '--format=esm', '--tsconfig-raw={}', '--log-level=warning', `--outfile=${join(build, 'app.js')}`], { cwd: root, stdio: 'inherit' })

const now = Date.now()
const MIN = 60_000
const card = (title, over = {}) => ({ title, about: `${title}.`, goal: '', since: '', glance: '', needs: { type: 'none', ask: '', options: [] }, effort: 'quick', priority: 'P2', role: 'solo', updatedAt: now, ...over })
const agent = (paneKey, title, over = {}) => ({
  paneKey, title, agentType: 'claude', live: true, state: 'working', workingMode: null, coordinator: 'you', leadPane: null, parentPane: null,
  orcaSession: null, dispatch: null, terminal: `term-${paneKey}`, question: null, summary: null, model: { source: 'seen', name: 'Opus 5.5' }, ...over
})
const row = (id, repo, agents, over = {}) => ({ id, name: id, branch: 'main', repo, path: `/fixture/${id}`, main: false, agents, state: agents[0].state, priority: null, card: null, parentId: null,
  liveTerminals: agents.length, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: now - 7 * MIN, createdAt: 1, pr: null, ...over })
const thisMac = { id: 'local', name: 'This Mac', kind: 'local', state: 'reachable', stale: false, checkedAt: now, seenAt: now, version: '1.4.263', reason: null, memory: { totalGB: 16, availableGB: 7.5, at: now }, agents: ['claude', 'codex', 'cursor'], remoteWorkers: null }
const caca = (over = {}) => ({ id: 'runtime:env-caca', name: 'caca', kind: 'paired', state: 'reachable', stale: false, checkedAt: now - 20_000, seenAt: now - 20_000, version: '1.4.232', reason: null,
  memory: { totalGB: 15.5, availableGB: 10.6, at: now }, agents: ['claude', 'codex'], remoteWorkers: true, nextCheckAt: now + 40_000, limits: ['keep-open', 'auto-release', 'direct mail'], ...over })
const on = (h) => ({ id: h.id, name: h.name, stale: h.stale, seenAt: h.seenAt })

const coordinators = [
  { key: 'firstview', name: 'firstview', repos: ['web-app'], workspaceId: 'ws-fv', look: { color: '#e0457b', shape: 'pentagon' }, session: agent('fv', 'firstview', { coordinator: 'firstview', state: 'done', summary: card('firstview', { role: 'coordinator' }) }) },
  { key: 'flow', name: 'orca-flow', repos: [], workspaceId: 'ws-flow', look: { color: '#d4b13a', shape: 'hex' }, session: agent('flow', 'orca-flow', { coordinator: 'flow', state: 'working', model: { source: 'seen', name: 'GPT-6.2 Sol' }, agentType: 'codex' }) },
  { key: 'print', name: '3d-print', repos: [], workspaceId: null, look: { color: '#5b3f8c', shape: 'square' }, session: null }
]
/** The rows on this Mac, and caca's (a worker the orca-flow lead started there, and a chat of yours). */
function snapshot(host, extra = {}) {
  const rows = [
    row('identity:plugin', 'orca-plugin', [agent('lead', 'Support paired hosts and remote agents', { coordinator: 'flow', dispatch: 'open', summary: card('Support paired hosts and remote agents', { role: 'lead' }) })], { lastActivityAt: now - 7 * MIN }),
    row('identity:rep', 'reputation', [agent('rep', 'Reputation and reach', { state: 'done' })], { lastActivityAt: now - 15 * 24 * 60 * MIN })
  ]
  if (host) rows.push(
    row('remote:runtime:env-caca|r::/home/c/mono', 'mono', [agent('runtime:env-caca|t:e2e', "Run mono's full e2e suite", { coordinator: 'flow', leadPane: 'lead', dispatch: 'open', terminal: null, model: { source: 'seen', name: 'Sonnet 5.5' } })], { host: on(host), lastActivityAt: now - 2 * MIN }),
    row('remote:runtime:env-caca|r::/home/c/reputation', 'reputation', [agent('runtime:env-caca|t:rep', 'cyucelen/reputation', { state: 'done', terminal: null, model: { source: 'seen', name: 'Claude' } })], { host: on(host), lastActivityAt: now - 39 * 24 * 60 * MIN })
  )
  return {
    source: 'cli', ready: true, focusedPanes: [], coordinators: structuredClone(coordinators), rows,
    capacity: { verdict: 'ok', freeGB: 6.8, marginGB: 2, diskFreeGB: 40.7, agentGB: 1.5, envGB: 2, pressure: 'normal', finishedOpen: 0, measuring: false },
    features: { linear: false, tokenSpeed: false, goals: false },
    ...(host ? { hosts: [thisMac, host] } : {}),
    ...extra
  }
}
const down = caca({ state: 'unavailable', stale: true, seenAt: now - 12 * MIN, checkedAt: now - MIN, reason: 'Orca could not connect: connection refused', nextCheckAt: now + 2 * MIN })
const upnext = snapshot(caca({ memory: { totalGB: 15.5, availableGB: 9.8, at: now } }))
upnext.rows.push(row('remote:runtime:env-caca|r::/home/c/ask', 'reputation', [agent('runtime:env-caca|t:ask', 'cyucelen/reputation', { state: 'done', terminal: null,
  summary: card('cyucelen/reputation', { about: 'Collecting reputation posts: 284 so far, 4 of 14 windows searched.', needs: { type: 'approval', ask: 'Allow the agent to run npm install for reputation?', options: ['Yes', 'No'] }, glance: 'Allow npm install for reputation?', priority: 'P1' }) })], { host: on(caca()), priority: 'P1', lastActivityAt: now - MIN }))
const several = snapshot(caca())
several.hosts = [thisMac, caca(), caca({ id: 'runtime:box', name: 'build-box', version: '1.4.263', limits: [], memory: { totalGB: 64, availableGB: 48.2, at: now } }),
  caca({ id: 'runtime:old', name: 'old-laptop', state: 'unavailable', stale: true, seenAt: now - 2 * 24 * 60 * MIN, reason: 'timed out', memory: { totalGB: 8, availableGB: 5.1, at: now } })]
const fixtures = {
  none: snapshot(null),
  reachable: snapshot(caca()),
  hosts: snapshot(caca()),
  unavailable: snapshot(down),
  checking: snapshot(caca({ state: 'checking', stale: true, checkedAt: null, nextCheckAt: null, seenAt: now - 3 * 60 * MIN })),
  upnext,
  several
}
const opens = new Set(['hosts', 'unavailable', 'several', 'checking'])

const bridge = `<script>
const q = new URLSearchParams(location.search);
const state = q.get('state') || 'reachable';
const fixture = ${JSON.stringify(fixtures).replaceAll('<', '\\u003c')}[state];
window.previewCalls = [];
const listeners = new Map();
window.orca = { plugin: {
  request: async (name, data) => { previewCalls.push({ name, data }); if (name === 'sidebar.list') return structuredClone(fixture); if (name === 'sidebar.focus') return { changed: false }; return { ok: true } },
  on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) }
}, storage: { get: async () => null, set: async () => {} }, shell: { openExternal: async () => {} } };
if (${JSON.stringify([...opens])}.includes(state)) setTimeout(() => document.querySelector('[data-hosts]')?.click(), 600);
</script>`
const html = readFileSync(join(root, 'src/panel/index.html'), 'utf8')
  .replace('<head>', '<head><title>Paired hosts fixture · Orca Flow</title>')
  .replace('<script type="module" src="./app.js"></script>', `${bridge}<script type="module" src="./app.js"></script>`)
const assets = new Map([
  ['/', ['text/html', html]],
  ['/panel.css', ['text/css', readFileSync(join(root, 'src/panel/panel.css'))]],
  ['/app.js', ['text/javascript', readFileSync(join(build, 'app.js'))]]
])
rmSync(build, { recursive: true, force: true })
// Chrome will not size a window under ~500 px: the panel renders in an iframe of the sidebar's size.
const frame = (q) => `<!doctype html><body style="margin:0;background:#888;display:flex;justify-content:center;align-items:center;min-height:100vh"><iframe src="/?${q}" style="border:0;display:block;flex:none;width:${new URLSearchParams(q).get('w')}px;height:${new URLSearchParams(q).get('h')}px"></iframe></body>`
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
  if (shots < 0) return console.log(`Paired hosts fixture: ${base}?state=reachable`)
  const out = process.argv[shots + 1]
  if (!out) { console.error('--shots needs a folder outside the plugin'); process.exit(1) }
  mkdirSync(out, { recursive: true })
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = mkdtempSync(join(tmpdir(), 'orca-flow-chrome-'))
  const [width, height] = [420, 720]
  const run = async () => {
    for (const state of ['reachable', 'hosts', 'unavailable', 'upnext', 'several', 'checking', 'none']) {
      const file = join(out, `hosts-${state}.png`)
      await new Promise((resolve, reject) => {
        const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--window-size=${Math.max(600, width + 100)},${height + 100}`, '--virtual-time-budget=4000', `--screenshot=${file}`,
          `${base}frame?state=${state}&w=${width}&h=${height}`]
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
