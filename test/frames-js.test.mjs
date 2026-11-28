// The panel and the custom editors must load without Orca transpiling anything: Orca transpiles a frame's .ts/.tsx/.mts/
// .jsx modules under a 2000 ms timer on its main thread, which a busy cold start loses, and keeps the failure until Orca
// quits (the black panel). scripts/build-frames.mjs generates the .js they load; these tests keep it that way.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build, htmlEntries, importsOf, ROOT, scriptSources, staleness, toJs, TRANSPILED } from '../scripts/build-frames.mjs'

process.removeAllListeners('warning') // stripTypeScriptTypes is "experimental" and says so

const entries = htmlEntries()
const extOf = (f) => (/\.[^./]+$/.exec(f) ?? [''])[0]

test('the manifest names the panel and both editors', () => {
  assert.deepEqual(entries, ['src/panel/index.html', 'src/editor/index.html', 'src/editor/goals.html'])
})

test('no HTML entry loads, directly or through any import, a file Orca transpiles', () => {
  const { graphs, problems } = build()
  assert.deepEqual(problems, [])
  for (const entry of entries) {
    const graph = graphs.get(entry)
    assert.ok(graph.length > 1, `${entry}: the graph was walked`)
    assert.deepEqual(graph.filter((f) => TRANSPILED.has(extOf(f))), [], `${entry} loads transpiled modules`)
    for (const src of scriptSources(readFileSync(join(ROOT, entry), 'utf8'))) assert.ok(!TRANSPILED.has(extOf(src)), `${entry}: <script src="${src}">`)
  }
  // The panel still reaches the shared skill script through its relative path.
  assert.ok(graphs.get('src/panel/index.html').includes('skills/orca-flow/scripts/goal-next.mjs'))
})

test('the generated JavaScript matches a fresh generation from the .ts sources', () => {
  assert.deepEqual(staleness(), [], 'run: node scripts/build-frames.mjs')
})

test('the full import graph links in a real ES module loader: every import, static or dynamic, resolves to a file with the named exports', () => {
  // vm.SourceTextModule uses V8's own parser for the static imports, so this also checks importsOf(); link() fails on a
  // missing file or a missing named export (a type-only import the stripper kept would be one) without running any code.
  const script = `
    import vm from 'node:vm'
    import { readFileSync } from 'node:fs'
    import { dirname, join, normalize } from 'node:path'
    const [root, entries, scanned] = JSON.parse(process.argv[1])
    const out = {}
    for (const entry of entries) {
      const modules = new Map()
      const load = (rel) => {
        if (!modules.has(rel)) modules.set(rel, new vm.SourceTextModule(readFileSync(join(root, rel), 'utf8'), { identifier: rel }))
        return modules.get(rel)
      }
      const scripts = [...readFileSync(join(root, entry), 'utf8').matchAll(/<script\\b[^>]*\\bsrc\\s*=\\s*["']([^"']+)["']/gi)].map((m) => normalize(join(dirname(entry), m[1])))
      const mismatches = []
      for (const s of scripts) {
        const top = load(s)
        // link() resolves the whole graph and instantiates it: a missing file or named export throws here.
        await top.link((specifier, parent) => load(normalize(join(dirname(parent.identifier), specifier))))
      }
      for (const [rel, m] of modules) {
        const v8 = [...m.dependencySpecifiers].sort().join('\\n')
        const ours = (scanned[rel] ?? []).filter((s) => !s.dynamic).map((s) => s.specifier).sort().join('\\n')
        if (v8 !== ours) mismatches.push(rel)
      }
      out[entry] = { modules: [...modules.keys()].sort(), mismatches }
    }
    console.log(JSON.stringify(out))
  `
  const { graphs } = build()
  const scanned = {}
  for (const graph of graphs.values()) for (const rel of graph) if (!rel.endsWith('.html')) scanned[rel] = importsOf(readFileSync(join(ROOT, rel), 'utf8'))
  const result = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', script, JSON.stringify([ROOT, entries, scanned])], { encoding: 'utf8' }))
  for (const entry of entries) {
    const { modules, mismatches } = result[entry]
    assert.deepEqual(mismatches, [], `${entry}: build-frames.mjs saw different static imports than V8 in these modules`)
    assert.deepEqual(modules.filter((f) => TRANSPILED.has(extOf(f))), [], `${entry}: V8 resolved transpiled modules`)
    assert.deepEqual(modules.filter((f) => f.startsWith('node:') || !/^(src|skills)\//.test(f)), [], `${entry}: only plugin files`)
    assert.deepEqual(modules, graphs.get(entry).filter((f) => !f.endsWith('.html')).sort(), `${entry}: V8 and build-frames.mjs agree on the graph`)
    // Dynamic imports V8 would only find at run time: every one in the graph is a literal relative path build-frames.mjs walked.
    for (const rel of modules) assert.equal((readFileSync(join(ROOT, rel), 'utf8').match(/\bimport\s*\(/g) ?? []).length, scanned[rel].filter((s) => s.dynamic).length, `${rel}: a non-literal dynamic import`)
  }
})

test('generation keeps every line where the .ts has it, drops type-only imports and rewrites .ts specifiers', () => {
  const ts = [
    "import { type A } from './a.ts'",
    "import type { B } from '../b.ts'",
    "import { c, type D } from './c.ts'",
    "import { e } from '../../skills/e.mjs'",
    'export const f = (x: A, y: D): number => c(x) + e(y) // a comment',
    "const g = await import('./g.ts')",
    'export type H = { h: string }',
    ''
  ].join('\n')
  const js = toJs(ts)
  const lines = js.split('\n')
  assert.equal(lines.length, ts.split('\n').length + 1, 'the banner is the only added line')
  assert.equal(lines[0], '')
  assert.equal(lines[1], '')
  assert.equal(lines[2], "import { c,        } from './c.js'")
  assert.equal(lines[3], "import { e } from '../../skills/e.mjs'")
  assert.equal(lines[4], 'export const f = (x   , y   )         => c(x) + e(y) // a comment')
  assert.equal(lines[5], "const g = await import('./g.js')")
  assert.equal(lines[6], '')
  assert.ok(js.endsWith('Do not edit.\n'))
  assert.throws(() => toJs('enum E { A }'), /not supported in strip-only mode|TypeScript enum/i)
})

test('--check fails on a stale, missing or orphaned generated file, and regeneration fixes all three', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'orca-flow-frames-'))
  try {
    cpSync(join(ROOT, 'orca-plugin.json'), join(tmp, 'orca-plugin.json'))
    cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true })
    cpSync(join(ROOT, 'skills'), join(tmp, 'skills'), { recursive: true })
    cpSync(join(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true })
    const run = (...args) => { try { return { ok: true, out: execFileSync(process.execPath, [join(tmp, 'scripts/build-frames.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' }) } } catch (e) { return { ok: false, out: e.stderr } } }
    assert.equal(run('--check').ok, true)
    writeFileSync(join(tmp, 'src/panel/press.ts'), readFileSync(join(tmp, 'src/panel/press.ts'), 'utf8') + '\nexport const added = 1\n')
    rmSync(join(tmp, 'src/panel/links.js'))
    writeFileSync(join(tmp, 'src/orphan.js'), readFileSync(join(tmp, 'src/icons.js'), 'utf8'))
    const failed = run('--check')
    assert.equal(failed.ok, false)
    assert.match(failed.out, /src\/panel\/press\.js: stale/)
    assert.match(failed.out, /src\/panel\/links\.js: missing/)
    assert.match(failed.out, /src\/orphan\.js: no entry loads it/)
    assert.equal(run().ok, true)
    assert.equal(run('--check').ok, true)
    // An entry that loads TypeScript again fails --check, whatever the generated files say.
    writeFileSync(join(tmp, 'src/editor/index.html'), readFileSync(join(tmp, 'src/editor/index.html'), 'utf8').replace('./main.js', './main.ts'))
    const ts = run('--check')
    assert.equal(ts.ok, false)
    assert.match(ts.out, /src\/editor\/index\.html: loads src\/editor\/main\.ts, which Orca transpiles/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
