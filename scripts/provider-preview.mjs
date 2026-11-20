// Browser-only fixture for the actual panel code. No plugin install, worker, session reads or writes.
// Run: node scripts/provider-preview.mjs; open the printed URL with Orca's embedded browser.
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, '.orca/provider-preview')
mkdirSync(output, { recursive: true })
execFileSync('npx', ['-y', 'esbuild', 'src/panel/app.ts', '--bundle', '--format=esm', '--tsconfig-raw={}', `--outfile=${join(output, 'app.js')}`], { cwd: root, stdio: 'inherit' })

const agent = (paneKey, agentType, over = {}) => ({
  paneKey, agentType, live: true, title: paneKey, state: 'working', workingMode: null,
  coordinator: 'home', leadPane: null, parentPane: null, orcaSession: null,
  dispatch: 'open', terminal: `term-${paneKey}`, question: null, summary: null, ...over
})
const row = (id, agents, over = {}) => ({
  id, name: id, branch: 'provider-logos', repo: 'shop', path: `/fixture/${id}`, main: false,
  agents, state: 'working', priority: null, card: null, parentId: null, liveTerminals: agents.length,
  pinned: false, unread: false, active: true, workspaceStatus: null, lastActivityAt: Date.now(),
  createdAt: 1, pr: null, ...over
})
const fixture = {
  source: 'cli', capacity: null, ready: true, focusedPanes: ['Codex worker'],
  coordinators: [{ key: 'home', name: 'Shop', repos: ['shop'], workspaceId: 'home',
    session: agent('Coordinator', 'claude', { state: 'done', dispatch: null }) }],
  rows: [
    row('feature', [
      agent('Codex continuation', 'codex', { state: 'done' }),
      agent('Codex lead', 'codex', { leadPane: 'Codex continuation', state: 'done' }),
      agent('Codex worker', 'codex', { leadPane: 'Codex lead' }),
      agent('Claude worker', 'claude', { leadPane: 'Codex lead', state: 'waiting' }),
      agent('Finished Gemini worker', 'gemini', { state: 'done', dispatch: 'settled' }),
      agent('Unknown agent', '<untrusted>', { leadPane: 'Codex lead' })
    ]),
    row('folder', [agent('Folder helper', 'codex', { state: 'done' })], { folderOf: 'home', branch: null })
  ]
}
const bridge = `<script>
const fixture = ${JSON.stringify(fixture).replaceAll('<', '\u003c')};
const listeners = new Map();
window.previewCalls = [];
window.orca = {
  plugin: {
    request: async (name, data) => { previewCalls.push({name, data}); return name === 'sidebar.list' ? fixture : name === 'sidebar.linear' ? null : {opened: true}; },
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); }
  },
  storage: {get: async () => null, set: async () => {}}, shell: {openExternal: async () => {}}
};
window.previewCase = (kind) => {
  const s = structuredClone(fixture);
  if (kind === 'claude-antigravity' || kind === 'codex-antigravity') {
    const partner = kind.split('-')[0];
    s.coordinators[0].session.agentType = partner;
    s.rows[0].agents = [
      { ...s.rows[0].agents[1], paneKey: 'Catalog lead', title: 'Catalog lead', agentType: partner, leadPane: null },
      { ...s.rows[0].agents[2], paneKey: 'Search worker', title: 'Search worker', agentType: 'antigravity', leadPane: 'Catalog lead', state: 'waiting' }
    ];
    s.rows.pop();
    s.focusedPanes = ['Search worker'];
  }
  if (kind === 'single') {
    s.coordinators[0].session.agentType = 'codex';
    s.rows.flatMap(r => r.agents).forEach(a => { if (a.agentType === 'claude') a.agentType = 'codex'; });
  }
  if (kind === 'closed') {
    s.coordinators[0].session.live = false;
    s.rows.flatMap(r => r.agents).forEach(a => { if (a.agentType === 'claude') a.live = false; });
  }
  listeners.get('sidebar.changed')(s);
};
</script>`
const html = readFileSync(join(root, 'src/panel/index.html'), 'utf8')
  .replace('<head>', '<head><title>Provider fixture · Orca Flow</title>')
  .replace('<script type="module" src="./app.ts"></script>', `${bridge}<script type="module" src="./app.js"></script>`)
const assets = new Map([
  ['/', ['text/html', html]],
  ['/panel.css', ['text/css', readFileSync(join(root, 'src/panel/panel.css'))]],
  ['/app.js', ['text/javascript', readFileSync(join(output, 'app.js'))]]
])
const server = createServer((req, res) => {
  const asset = assets.get(req.url)
  if (!asset) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': asset[0] }); res.end(asset[1])
})
server.listen(0, '127.0.0.1', () => console.log(`Provider fixture: http://127.0.0.1:${server.address().port}`))
