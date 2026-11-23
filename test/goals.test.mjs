// node --test test/goals.test.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as goals from '../skills/orca-flow/scripts/goals.mjs'

const CLI = new URL('../skills/orca-flow/scripts/orca-flow.mjs', import.meta.url).pathname
const tmp = () => mkdtempSync(join(tmpdir(), 'orca-flow-goals-'))

// A fake `orca` that knows two worktrees, for --worktree selectors.
function fakeOrca() {
  const bin = tmp()
  const wt = { current: 'alpha', 'name:alpha': 'alpha', 'name:beta': 'beta' }
  writeFileSync(
    join(bin, 'orca'),
    `#!/usr/bin/env node
const a = process.argv.slice(2)
const sel = a[a.indexOf('--worktree') + 1]
const name = ${JSON.stringify(wt)}[sel]
if (a[0] === 'worktree' && a[1] === 'show' && name) {
  console.log(JSON.stringify({ ok: true, result: { worktree: { id: 'r1::/w/' + name, path: '/w/' + name, displayName: name, identity: { key: 'key-' + name } } } }))
} else { console.log(JSON.stringify({ ok: false, error: { message: 'unknown' } })); process.exit(1) }
`
  )
  chmodSync(join(bin, 'orca'), 0o755)
  return bin
}

function cli(dir, bin, ...argv) {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: { ...process.env, ORCA_FLOW_DIR: dir, ORCA_CLI_BIN_DIR: bin, CLAUDE_CODE_SESSION_ID: '', CLAUDECODE: '' } })
  return { out: r.stdout.trim(), err: r.stderr.trim(), code: r.status }
}

test('add keeps a title-only goal, list puts open first, then proposed, then done (newest first)', () => {
  const data = tmp()
  const a = goals.add('Documents for the lawyer', {}, { data, by: 'you', now: 1000 })
  assert.match(a.id, /^g_documents-for-the-[a-z0-9]{4}$/)
  assert.deepEqual(a.steps, [])
  assert.equal(a.status, 'open')
  assert.deepEqual(a.lastChange, { by: 'you', field: 'created', at: 1000 })
  const b = goals.add('Second', { next: 'start', steps: ['one', 'two'], linear: ['des-340'] }, { data, now: 2000 })
  const c = goals.add('Third', {}, { data, now: 3000 })
  const d = goals.add('Fourth', {}, { data, now: 4000 })
  goals.propose(c.id, 'agent x', { data })
  goals.done(a.id, 'you', { data })
  goals.done(d.id, 'you', { data })
  assert.deepEqual(goals.list({ data }).map((g) => g.title), ['Second', 'Third', 'Fourth', 'Documents for the lawyer'])
  assert.deepEqual(goals.get(b.id, { data }).links.linear, ['DES-340'])
  assert.equal(goals.get('g_second', { data }).id, b.id, 'a unique start of the id is enough')
})

test('steps tick and untick by number or text; update records who changed what', () => {
  const data = tmp()
  const g = goals.add('Ship', { steps: ['write draft', 'send to lawyer'] }, { data })
  const t1 = goals.tick(g.id, 2, 'lead beta', { data })
  assert.deepEqual(t1.steps.map((s) => s.done), [false, true])
  assert.equal(t1.lastChange.by, 'lead beta')
  assert.equal(t1.lastChange.field, 'steps')
  const t2 = goals.setStep(g.id, 'draft', true, 'you', { data })
  assert.deepEqual(t2.steps.map((s) => s.done), [true, true])
  assert.deepEqual(goals.setStep(g.id, 1, false, 'you', { data }).steps.map((s) => s.done), [false, true])
  assert.throws(() => goals.tick(g.id, 3, 'x', { data }), /no step 3/)
  assert.throws(() => goals.tick(g.id, 'nothing', 'x', { data }), /no step matches/)
  const u = goals.update(g.id, { next: 'call them', doneWhen: 'signed' }, 'you', { data })
  assert.equal(u.next, 'call them')
  assert.equal(u.lastChange.field, 'next,doneWhen')
  assert.equal(goals.update(g.id, { next: '' }, 'you', { data }).next, undefined)
  assert.equal(goals.addStep(g.id, 'follow up', 'you', { data }).steps.length, 3)
})

test('goals link by worktree and are found by key or path; unlink removes', () => {
  const data = tmp()
  const g = goals.add('Billing', {}, { data })
  goals.add('Unlinked', {}, { data })
  const wt = { key: 'key-alpha', path: '/w/alpha', name: 'alpha' }
  goals.link(g.id, { worktree: wt }, 'coordinator', { data })
  goals.link(g.id, { worktree: wt }, 'coordinator', { data })
  assert.equal(goals.get(g.id, { data }).links.worktrees.length, 1)
  assert.deepEqual(goals.forWorktree('/w/alpha', { data }).map((x) => x.id), [g.id])
  assert.deepEqual(goals.forWorktree({ key: 'key-alpha' }, { data }).map((x) => x.id), [g.id])
  assert.deepEqual(goals.forWorktree('/w/beta', { data }), [])
  goals.link(g.id, { linear: 'des-1' }, 'you', { data })
  assert.deepEqual(goals.unlink(g.id, { linear: 'DES-1' }, 'you', { data }).links.linear, [])
  goals.unlink(g.id, { worktree: wt }, 'you', { data })
  assert.deepEqual(goals.forWorktree('/w/alpha', { data }), [])
})

test('an agent proposes, only done closes, reopen puts it back', () => {
  const data = tmp()
  const g = goals.add('Research', {}, { data })
  const p = goals.propose(g.id, 'lead alpha', { data })
  assert.equal(p.status, 'proposed')
  assert.equal(p.doneAt, undefined)
  assert.throws(() => goals.propose(goals.done(g.id, 'you', { data }).id, 'x', { data }), /only an open goal/)
  const d = goals.get(g.id, { data })
  assert.equal(d.status, 'done')
  assert.ok(d.doneAt)
  const r = goals.reopen(g.id, 'you', { data })
  assert.equal(r.status, 'open')
  assert.equal(r.doneAt, undefined)
})

test('a corrupt goal file is skipped, not fatal', () => {
  const data = tmp()
  const g = goals.add('Fine', {}, { data })
  mkdirSync(join(data, 'goals'), { recursive: true })
  writeFileSync(join(data, 'goals', 'g_broken.json'), '{not json')
  writeFileSync(join(data, 'goals', 'g_shape.json'), JSON.stringify({ id: 'g_shape' }))
  assert.deepEqual(goals.list({ data }).map((x) => x.id), [g.id])
  assert.equal(goals.get('g_broken', { data }), null)
})

test('concurrent writes to two goals from separate processes never clobber each other', async () => {
  const data = tmp()
  const a = goals.add('Alpha', { steps: ['a1', 'a2', 'a3', 'a4', 'a5'] }, { data })
  const b = goals.add('Beta', { steps: ['b1', 'b2', 'b3', 'b4', 'b5'] }, { data })
  const run = (id, by) =>
    new Promise((resolve, reject) => {
      const script = `import * as g from ${JSON.stringify(new URL('../skills/orca-flow/scripts/goals.mjs', import.meta.url).href)}
for (let i = 1; i <= 5; i++) g.tick(${JSON.stringify(id)}, i, ${JSON.stringify(by)}, { data: ${JSON.stringify(data)} })`
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' })
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))))
    })
  await Promise.all([run(a.id, 'one'), run(b.id, 'two')])
  assert.ok(goals.get(a.id, { data }).steps.every((s) => s.done))
  assert.ok(goals.get(b.id, { data }).steps.every((s) => s.done))
  assert.equal(goals.get(b.id, { data }).lastChange.by, 'two')
  assert.ok(!readdirSync(join(data, 'goals')).some((f) => f.endsWith('.tmp')), 'no temp files left')
})

test('CLI: add, list, step tick, propose-done, list --worktree current', () => {
  const dir = tmp()
  const bin = fakeOrca()
  const add = cli(dir, bin, 'goal', 'add', 'Ship billing', '--next', 'write the spec', '--done-when', 'live', '--step', 'spec', '--step', 'build', '--linear', 'des-340', '--worktree', 'name:alpha', '--by', 'coordinator')
  assert.equal(add.code, 0, add.err)
  const id = JSON.parse(cli(dir, bin, 'goal', 'list', '--json').out)[0].id
  const other = cli(dir, bin, 'goal', 'add', 'Lawyer docs', '--by', 'you')
  assert.equal(other.code, 0, other.err)
  assert.match(cli(dir, bin, 'goal', 'list').out, new RegExp(`${id}  Ship billing  0/2\\n    next: write the spec`))
  assert.match(cli(dir, bin, 'goal', 'step', id, 'tick', '1', '--by', 'lead alpha').out, /1\. \[x\] spec/)
  assert.match(cli(dir, bin, 'goal', 'step', id, 'tick', 'build', '--by', 'lead alpha').out, /2\. \[x\] build/)
  assert.match(cli(dir, bin, 'goal', 'set', id, '--next', 'tell the user', '--by', 'lead alpha').out, /next: tell the user/)
  assert.match(cli(dir, bin, 'goal', 'propose-done', id, '--by', 'lead alpha').out, /\[proposed\]/)
  const here = cli(dir, bin, 'goal', 'list', '--worktree', 'current')
  assert.match(here.out, /Ship billing {2}\[proposed\] {2}2\/2/)
  assert.doesNotMatch(here.out, /Lawyer/)
  assert.equal(cli(dir, bin, 'goal', 'list', '--worktree', 'name:beta').out, 'No goals.')
  const shown = JSON.parse(cli(dir, bin, 'goal', 'show', id, '--json').out)
  assert.equal(shown.status, 'proposed')
  assert.equal(shown.lastChange.by, 'lead alpha')
  assert.equal(shown.links.worktrees[0].path, '/w/alpha')
  assert.match(cli(dir, bin, 'goal', 'done', id, '--by', 'you').out, /\[done\]/)
  assert.doesNotMatch(cli(dir, bin, 'goal', 'list').out, /Ship billing/)
  assert.match(cli(dir, bin, 'goal', 'list', '--all').out, /Ship billing/)
})

test('CLI: unknown goal and missing usage exit 1 with a message; by falls back to the worktree name', () => {
  const dir = tmp()
  const bin = fakeOrca()
  const bad = cli(dir, bin, 'goal', 'show', 'g_nope')
  assert.equal(bad.code, 1)
  assert.match(bad.err, /no goal "g_nope"/)
  assert.equal(cli(dir, bin, 'goal', 'step', 'x').code, 1)
  const id = JSON.parse(cli(dir, bin, 'goal', 'add', 'No by', '--json').out).id
  assert.equal(JSON.parse(cli(dir, bin, 'goal', 'show', id, '--json').out).lastChange.by, 'agent alpha')
  assert.equal(JSON.parse(readFileSync(join(dir, 'goals', `${id}.json`), 'utf8')).title, 'No by')
})
