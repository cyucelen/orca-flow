// node --test test/goals.test.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
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

// Goals is a Settings → Features switch, off by default: these CLI runs have it on unless the test set its own config.json.
function cli(dir, bin, ...argv) {
  if (!existsSync(join(dir, 'config.json'))) writeFileSync(join(dir, 'config.json'), JSON.stringify({ features: { goals: true } }))
  return cliRaw(dir, bin, ...argv)
}
function cliRaw(dir, bin, ...argv) {
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

const OFF = 'Goals is off (Orca Flow Settings → Features); nothing changed.'
const SUBS = [['add', 'Hire'], ['list'], ['list', '--all', '--json'], ['show', 'g_x'], ['set', 'g_x', '--next', 'n'], ['step', 'g_x', 'add', 's'], ['link', 'g_x', '--linear', 'DES-1'], ['unlink', 'g_x', '--linear', 'DES-1'], ['propose-done', 'g_x'], ['done', 'g_x'], ['reopen', 'g_x']]

test('CLI: with the Goals switch off (absent, false, broken or not exactly true) every goal command prints one line, exits 0 and touches nothing', () => {
  const bin = fakeOrca()
  for (const config of [null, '{}', '{"features":{"goals":false}}', '{"features":{"goals":"true"}}', '{"features":{"bots":true}}', '{ not json']) {
    const dir = tmp()
    if (config !== null) writeFileSync(join(dir, 'config.json'), config)
    for (const sub of SUBS) {
      const r = cliRaw(dir, bin, 'goal', ...sub)
      assert.deepEqual([r.out, r.err, r.code], [OFF, '', 0], `${sub[0]} with ${config}`)
    }
    assert.equal(existsSync(join(dir, 'goals')), false, 'nothing was written')
  }
})

test('CLI: the switch hides goals without touching them; turning it on shows them again', () => {
  const bin = fakeOrca()
  const dir = tmp()
  const added = cli(dir, bin, 'goal', 'add', 'Keep me', '--json')
  assert.equal(added.code, 0)
  const id = JSON.parse(added.out).id
  const before = readFileSync(join(dir, 'goals', `${id}.json`), 'utf8')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ features: { goals: false } }))
  assert.equal(cli(dir, bin, 'goal', 'list').out, OFF)
  assert.equal(cli(dir, bin, 'goal', 'done', id).out, OFF)
  assert.equal(readFileSync(join(dir, 'goals', `${id}.json`), 'utf8'), before, 'the file is as it was')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ features: { goals: true } }))
  assert.match(cli(dir, bin, 'goal', 'list').out, /Keep me/)
})

test('goalsEnabled reads the switch exactly as the plugin does', async () => {
  const { normalizeFeatures } = await import('../src/settings.ts').catch(() => ({ normalizeFeatures: null }))
  for (const features of [undefined, {}, { goals: true }, { goals: false }, { goals: 'true' }, { goals: 1 }, 'oops', null]) {
    const dir = tmp()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ features }))
    assert.equal(goals.goalsEnabled({ data: dir }), features?.goals === true, JSON.stringify(features))
    if (normalizeFeatures) assert.equal(goals.goalsEnabled({ data: dir }), normalizeFeatures(features).goals)
  }
  assert.equal(goals.goalsEnabled({ data: tmp() }), false, 'no config file: off')
  assert.equal(goals.goalsEnabled({ data: '/nonexistent/x' }), false)
})

test('assign: begin records a pending assignment for the exact next text; finish marks it delivered; neither stamps a change', () => {
  const data = tmp()
  const g = goals.add('Ship', { next: 'Draft it' }, { data, now: 1000 })
  const { goal, token } = goals.beginAssign(g.id, { coordinator: 'home', name: 'bounti', next: ' Draft it ', session: { workspaceId: 'folder:home', terminal: 'term-c' } }, 'you', { data, now: 5000 })
  assert.deepEqual({ ...goal.assignment, token: 'x' }, { coordinator: 'home', name: 'bounti', next: 'Draft it', state: 'pending', at: 5000, by: 'you', token: 'x', session: { workspaceId: 'folder:home', terminal: 'term-c' } })
  assert.deepEqual(goal.lastChange, g.lastChange, 'not a change of the goal')
  assert.equal(goals.currentAssignment(goals.get(g.id, { data }), 5000).state, 'pending')
  assert.equal(goals.finishAssign(g.id, 'wrong', { ok: true }, { data }).applied, false, 'another token changes nothing')
  const fin = goals.finishAssign(g.id, token, { ok: true, session: { workspaceId: 'folder:home', terminal: 'term-c', member: 'm' } }, { data, now: 6000 })
  assert.equal(fin.applied, true)
  assert.equal(fin.goal.assignment.state, 'delivered')
  assert.equal(fin.goal.assignment.deliveredAt, 6000)
  assert.equal(goals.finishAssign(g.id, token, { ok: false }, { data }).applied, false, 'a second answer for the same send changes nothing')
  assert.equal(goals.get(g.id, { data }).assignment.state, 'delivered')
})

test('assign: refused for the same step (pending or delivered), for a changed next text, a done goal or no next', () => {
  const data = tmp()
  const g = goals.add('Ship', { next: 'Draft it' }, { data })
  goals.beginAssign(g.id, { coordinator: 'home', next: 'Draft it' }, 'you', { data })
  assert.throws(() => goals.beginAssign(g.id, { coordinator: 'other', next: 'Draft it' }, 'you', { data }), /already being sent to home/)
  assert.throws(() => goals.beginAssign(g.id, { coordinator: 'home', next: 'Something else' }, 'you', { data }), /next step changed/)
  const later = Date.now() + goals.ASSIGN_PENDING_MS + 1
  assert.equal(goals.currentAssignment(goals.get(g.id, { data }), later), null, 'a pending send that never finished expires')
  const again = goals.beginAssign(g.id, { coordinator: 'other', next: 'Draft it' }, 'you', { data, now: later })
  goals.finishAssign(g.id, again.token, { ok: true }, { data })
  assert.throws(() => goals.beginAssign(g.id, { coordinator: 'home', next: 'Draft it' }, 'you', { data }), /already assigned to other/)
  assert.doesNotThrow(() => goals.beginAssign(g.id, { coordinator: 'home', next: 'Draft it' }, 'you', { data, stillOn: () => false }), 'its coordinator is gone: it can be replaced')
  const none = goals.add('No next', {}, { data })
  assert.throws(() => goals.beginAssign(none.id, { coordinator: 'home', next: '' }, 'you', { data }), /no next step/)
  const fin = goals.add('Finished', { next: 'x' }, { data })
  goals.done(fin.id, 'you', { data })
  assert.throws(() => goals.beginAssign(fin.id, { coordinator: 'home', next: 'x' }, 'you', { data }), /is done/)
})

test('assign: a new next text drops the assignment, and a late answer for the old one is ignored', () => {
  const data = tmp()
  const g = goals.add('Ship', { next: 'Old' }, { data })
  const { token } = goals.beginAssign(g.id, { coordinator: 'home', next: 'Old' }, 'you', { data })
  goals.update(g.id, { next: 'New' }, 'an agent', { data })
  assert.equal(goals.get(g.id, { data }).assignment, undefined)
  assert.equal(goals.finishAssign(g.id, token, { ok: true }, { data }).applied, false)
  assert.equal(goals.get(g.id, { data }).assignment, undefined)
  // Written by hand with an old text: it does not apply to the current step.
  assert.equal(goals.currentAssignment({ next: 'New', assignment: { coordinator: 'home', next: 'Old', state: 'delivered', at: 1 } }), null)
  assert.equal(goals.currentAssignment({ next: 'New' }), null)
  assert.equal(goals.currentAssignment(null), null)
})

test('CLI: show and list name the coordinator the current next step was assigned to', () => {
  const bin = fakeOrca()
  const dir = tmp()
  const id = JSON.parse(cli(dir, bin, 'goal', 'add', 'Ship', '--next', 'Draft it', '--json').out).id
  assert.doesNotMatch(cli(dir, bin, 'goal', 'show', id).out, /assigned/)
  const { token } = goals.beginAssign(id, { coordinator: 'home', name: 'bounti', next: 'Draft it' }, 'you', { data: dir })
  assert.match(cli(dir, bin, 'goal', 'show', id).out, /next assigned to coordinator bounti \(sending, just now\)/)
  goals.finishAssign(id, token, { ok: true }, { data: dir })
  assert.match(cli(dir, bin, 'goal', 'show', id).out, /next assigned to coordinator bounti \(sent, just now\)/)
  assert.match(cli(dir, bin, 'goal', 'list').out, /next: Draft it\n\s+next assigned to coordinator bounti/)
  assert.equal(JSON.parse(cli(dir, bin, 'goal', 'show', id, '--json').out).assignment.coordinator, 'home')
  cli(dir, bin, 'goal', 'set', id, '--next', 'Something else')
  assert.doesNotMatch(cli(dir, bin, 'goal', 'show', id).out, /assigned/, 'goal set --next: the new step is not assigned')
})

// ---------- completed goals: who completed it, and Undo keeping the date ----------

test('done records who completed it; the agent that proposed it is kept; reopen clears all three', () => {
  const data = tmp()
  const plain = goals.add('Plain', {}, { data })
  const d = goals.done(plain.id, 'you', { data })
  assert.equal(d.doneBy, 'you')
  assert.equal(d.proposedBy, undefined)
  const g = goals.add('Proposed', {}, { data })
  const p = goals.propose(g.id, 'lead alpha', { data })
  assert.equal(p.proposedBy, 'lead alpha')
  // The proposal survives edits made before it is confirmed.
  goals.update(g.id, { next: 'x' }, 'you', { data })
  const c = goals.done(g.id, 'you', { data })
  assert.equal(c.doneBy, 'you')
  assert.equal(c.proposedBy, 'lead alpha')
  assert.equal(goals.get(g.id, { data }).proposedBy, 'lead alpha', 'what is on disk')
  const r = goals.reopen(g.id, 'you', { data })
  assert.deepEqual([r.doneAt, r.doneBy, r.proposedBy], [undefined, undefined, undefined])
  assert.equal('proposedBy' in goals.get(g.id, { data }), false, 'not even a key is left in the file')
  // "Not yet" on a proposal drops the proposer too.
  goals.propose(g.id, 'lead beta', { data })
  assert.equal(goals.reopen(g.id, 'you', { data }).proposedBy, undefined)
})

test('Undo of a reopen: done with the original doneAt and proposer; a bad or future doneAt completes now', () => {
  const data = tmp()
  const g = goals.add('Undo me', {}, { data })
  goals.propose(g.id, 'lead alpha', { data })
  const first = goals.done(g.id, 'you', { data })
  goals.reopen(g.id, 'you', { data })
  const back = goals.done(g.id, 'you', { data, doneAt: first.doneAt - 5 * 86_400_000, proposedBy: 'lead alpha' })
  assert.equal(back.doneAt, first.doneAt - 5 * 86_400_000, 'the original date')
  assert.equal(back.proposedBy, 'lead alpha')
  assert.equal(back.lastChange.field, 'status')
  assert.equal(goals.list({ data, status: 'done' })[0].doneAt, back.doneAt)
  for (const bad of [NaN, -1, 0, '5', null, Date.now() + 86_400_000]) {
    goals.reopen(g.id, 'you', { data })
    const t = Date.now()
    const out = goals.done(g.id, 'you', { data, doneAt: bad })
    assert.ok(out.doneAt >= t && out.doneAt <= Date.now(), `doneAt ${String(bad)} is ignored`)
  }
})

test('done keeps the order of the completed goals by doneAt, so an Undo returns a goal to its place', () => {
  const data = tmp()
  const [a, b, c] = ['A', 'B', 'C'].map((t) => goals.add(t, {}, { data }))
  const done = (g, at) => goals.done(g.id, 'you', { data, doneAt: at })
  const now = Date.now()
  done(a, now - 3000); done(b, now - 2000); done(c, now - 1000)
  assert.deepEqual(goals.list({ data, status: 'done' }).map((g) => g.title), ['C', 'B', 'A'])
  goals.reopen(b.id, 'you', { data })
  done(b, now - 2000)
  assert.deepEqual(goals.list({ data, status: 'done' }).map((g) => g.title), ['C', 'B', 'A'])
})

test('a goal written before doneBy and proposedBy existed loads, lists and reopens unchanged, and reading never writes', () => {
  const data = tmp()
  mkdirSync(join(data, 'goals'), { recursive: true })
  // Exactly what the previous version wrote: no doneBy, no proposedBy; a second one without even doneAt (the oldest files).
  const old = {
    id: 'g_old-1a2b', title: 'Old finished goal', note: 'n', steps: [{ text: 's', done: true }], links: { linear: ['DES-1'], worktrees: [{ key: 'k', name: 'wt' }] },
    status: 'done', createdAt: 1_700_000_000_000, updatedAt: 1_700_100_000_000, doneAt: 1_700_100_000_000, lastChange: { by: 'you', field: 'status', at: 1_700_100_000_000 }
  }
  const older = { id: 'g_older-3c4d', title: 'Older', steps: [], links: { linear: [], worktrees: [] }, status: 'done', createdAt: 1_600_000_000_000, updatedAt: 1_600_000_500_000, lastChange: { by: 'you', field: 'next', at: 1_600_000_500_000 } }
  const files = [old, older].map((g) => [join(data, 'goals', `${g.id}.json`), `${JSON.stringify(g, null, 2)}\n`])
  for (const [f, text] of files) writeFileSync(f, text)
  const listed = goals.list({ data, status: 'done' })
  assert.deepEqual(listed.map((g) => g.id), ['g_old-1a2b', 'g_older-3c4d'], 'newest first, a missing doneAt falls back to updatedAt')
  assert.equal(listed[0].doneBy, undefined)
  assert.equal(goals.get('g_old-1', { data }).title, 'Old finished goal')
  for (const [f, text] of files) assert.equal(readFileSync(f, 'utf8'), text, 'listing and reading change no file')
  const r = goals.reopen('g_old-1a2b', 'you', { data })
  assert.equal(r.status, 'open')
  assert.equal(r.doneAt, undefined)
  assert.equal(r.title, 'Old finished goal')
  assert.deepEqual(r.links, old.links)
  assert.equal(readFileSync(files[1][0], 'utf8'), files[1][1], 'the other goal is untouched')
  // Undo with the date the tab read from the old goal.
  const back = goals.done('g_old-1a2b', 'you', { data, doneAt: old.doneAt })
  assert.equal(back.doneAt, old.doneAt)
  assert.equal(back.doneBy, 'you')
})

test('CLI: goal show names who completed a goal', () => {
  const dir = tmp()
  const bin = fakeOrca()
  const id = JSON.parse(cli(dir, bin, 'goal', 'add', 'Ship', '--json').out).id
  cli(dir, bin, 'goal', 'propose-done', id, '--by', 'lead alpha')
  assert.match(cli(dir, bin, 'goal', 'done', id, '--by', 'you').out, /done by: you \(proposed by lead alpha\)/)
})

test('goalHints: the two feedback examples get hints', () => {
  const hints = goals.goalHints({
    title: 'Ship super admin',
    steps: [{ text: 'Moderation rights (edit, delete, block)', done: false }, { text: 'Super Admins see everything', done: false }],
    doneWhen: 'Super Admins see everything, can moderate, and the PR is merged'
  })
  assert.equal(hints.length, 3)
  assert.match(hints[0], /"Moderation rights \(edit, delete, block\)".*one step per checkable outcome/)
  assert.match(hints[1], /ends at the merge.*released to production/)
  assert.match(hints[2], /no release step.*"Released to production"/)
})

test('goalHints: a bundled step has a list in parentheses or three comma-separated items, not just "and"', () => {
  const bundled = (text) => goals.bundledStep(text)
  assert.equal(bundled('Moderation rights (edit, delete, block)'), true)
  assert.equal(bundled('Rights (edit/delete)'), true)
  assert.equal(bundled('Edit, delete, block'), true)
  assert.equal(bundled('Edit and delete posts'), false)
  assert.equal(bundled('Super Admins can delete any post'), false)
  assert.equal(bundled('Move the card (the old one)'), false)
  assert.equal(bundled('Edit, delete'), false)
})

test('goalHints: nothing for a release step, a done-when that ends at the release, or a goal that ships nothing', () => {
  assert.deepEqual(goals.goalHints({ title: 'Ship super admin', steps: ['Super Admins can delete any post', 'Released to production'], doneWhen: 'Super Admins can moderate and it is released to production' }), [])
  assert.deepEqual(goals.goalHints({ title: 'Add export', steps: ['Export works', 'Deployed'] }), [])
  assert.deepEqual(goals.goalHints({ title: 'Decide on pricing', steps: ['Compare three tiers', 'Pick one'], doneWhen: 'The user has chosen a tier' }), [])
  assert.deepEqual(goals.goalHints({ title: 'Ship super admin', steps: [] }), [], 'a goal without steps is left alone')
  assert.deepEqual(goals.goalHints({ title: 'Write the doc', steps: ['Draft'], doneWhen: 'The PR is merged' }).length, 1, 'only the merge hint: the title ships nothing')
  assert.deepEqual(goals.goalHints({ title: 'Fix login', steps: ['Login works'], doneWhen: 'Users can log in, the PR is merged and deployed' }), [])
})

test('CLI: goal add prints hints and still saves the goal as written', () => {
  const dir = tmp()
  const bin = fakeOrca()
  const step = 'Moderation rights (edit, delete, block)'
  const doneWhen = 'Super Admins can moderate, and the PR is merged'
  const r = cli(dir, bin, 'goal', 'add', 'Ship super admin', '--step', step, '--done-when', doneWhen)
  assert.equal(r.code, 0)
  assert.match(r.out, /^Added\./)
  assert.match(r.out, /hint: step "Moderation rights \(edit, delete, block\)" bundles/)
  assert.match(r.out, /hint: done-when ends at the merge/)
  assert.match(r.out, /hint: this goal ships a change but has no release step/)
  const g = goals.list({ data: dir })[0]
  assert.equal(g.title, 'Ship super admin')
  assert.deepEqual(g.steps, [{ text: step, done: false }])
  assert.equal(g.doneWhen, doneWhen)
  // step add and set --done-when hint too; a clean goal gets none; --json stays plain JSON.
  assert.match(cli(dir, bin, 'goal', 'step', g.id, 'add', 'Block, mute, ban').out, /hint: step "Block, mute, ban" bundles/)
  assert.match(cli(dir, bin, 'goal', 'set', g.id, '--done-when', 'It is merged').out, /hint: done-when ends at the merge/)
  assert.doesNotMatch(cli(dir, bin, 'goal', 'set', g.id, '--next', 'Start').out, /hint:/)
  const clean = cli(dir, bin, 'goal', 'add', 'Ship exports', '--step', 'Users can export a CSV', '--step', 'Released to production', '--done-when', 'Users can export a CSV and it is released to production')
  assert.doesNotMatch(clean.out, /hint:/)
  assert.doesNotThrow(() => JSON.parse(cli(dir, bin, 'goal', 'add', 'Ship x', '--step', 'A (b, c)', '--json').out))
})
