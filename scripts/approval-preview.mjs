// Browser-only fixture for the update-approval dialog and its tooltip, in the actual panel code.
// `orca` is a stub: no plugin, worker or update runs, and nothing is approved.
//   node scripts/approval-preview.mjs --shots <dir>   dialog at 556x1566, 300x420, 240x300, light and dark, and the tooltip
// The host text is the 0.2.87 → 0.2.91 one from the bug report; the end of its fingerprint and command were cut off in the
// screenshot, so they are reconstructed.
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = mkdtempSync(join(tmpdir(), 'orca-flow-approval-preview-'))
execFileSync('npx', ['-y', 'esbuild', 'src/panel/app.ts', '--bundle', '--format=esm', '--tsconfig-raw={}', '--log-level=warning', `--outfile=${join(build, 'app.js')}`], { cwd: root, stdio: 'inherit' })

const reason = [
  'Grants: sidebar, storage, shell.openExternal, terminals, worktrees.',
  'Adds: panels, commands, events, keybindings, customEditors, statusBarItems.',
  'Updating 0.2.87 → 0.2.91 asks for more access: new customEditors.',
  'Source: https://github.com/cyucelen/orca-flow @ 7a7cbf9c491e664eb66e70ba83c12b44',
  'Publisher: cyucelen',
  'Only approve plugins you trust: a plugin runs with the access listed above.',
  'Fingerprint: ap1-7a7cbf9c491e664eb66e70ba83c12b44'
].join('\n')
const update = { kind: 'approval', version: '0.2.91', reason, command: 'orca plugin update cyucelen.flow --approve ap1-7a7cbf9c491e664eb66e70ba83c12b44', fingerprint: 'ap1-7a7cbf9c491e664eb66e70ba83c12b44' }
const snapshot = { source: 'cli', capacity: null, ready: true, focusedPanes: [], coordinators: [], rows: [], update }
const bridge = `<style>.tip { transition: none !important; }</style><script>
const q = new URLSearchParams(location.search);
const snapshot = ${JSON.stringify(snapshot)};
window.orca = {
  plugin: { request: async (name) => name === 'sidebar.list' ? snapshot : { ok: true }, on: () => () => {} },
  storage: { get: async () => null, set: async () => {} }, shell: { openExternal: async () => {} }
};
window.addEventListener('load', () => setTimeout(() => {
  const b = document.querySelector('[data-update="approval"]');
  if (q.get('tip')) b?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  else b?.click();
}, 400));
</script>`
const html = readFileSync(join(root, 'src/panel/index.html'), 'utf8')
  .replace('<script type="module" src="./app.ts"></script>', `${bridge}<script type="module" src="./app.js"></script>`)
const assets = new Map([['/', ['text/html', html]], ['/panel.css', ['text/css', readFileSync(join(root, 'src/panel/panel.css'))]], ['/app.js', ['text/javascript', readFileSync(join(build, 'app.js'))]]])
rmSync(build, { recursive: true, force: true })
// Chrome will not size a window under ~500 px, so each shot renders in an iframe of exactly the panel's size.
const frame = (q) => `<!doctype html><body style="margin:0;background:#888"><iframe src="/?${q}" style="border:0;display:block;width:${new URLSearchParams(q).get('w')}px;height:${new URLSearchParams(q).get('h')}px"></iframe>`
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/frame') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(frame(url.searchParams.toString())); return }
  const asset = assets.get(url.pathname)
  if (!asset) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': asset[0] }); res.end(asset[1])
})
const shots = process.argv.indexOf('--shots')
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}/`
  if (shots < 0) return console.log(`Approval fixture: ${base}frame?w=300&h=420`)
  const out = process.argv[shots + 1]
  mkdirSync(out, { recursive: true })
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = mkdtempSync(join(tmpdir(), 'orca-flow-chrome-'))
  const jobs = [[556, 1566, ''], [300, 420, ''], [240, 300, ''], [300, 420, 'tip=1']]
  for (const [w, h, extra] of jobs) {
    const file = join(out, `approval-${extra ? 'tooltip-' : ''}${w}x${h}.png`)
    await new Promise((resolve, reject) => execFile(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--window-size=${w + 40},${Math.min(h + 40, 1700)}`, '--virtual-time-budget=4000', `--screenshot=${file}`, `${base}frame?w=${w}&h=${h}${extra ? `&${extra}` : ''}`], (e) => (e ? reject(e) : resolve())))
    console.log(file)
  }
  rmSync(profile, { recursive: true, force: true })
  server.close()
})
