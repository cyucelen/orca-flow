// Run from this Orca worktree with "node scripts/handover-fixture.mjs".
// Five disposable shells exercise the installed host. Each calls Orca under its own identity.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { classifyRun } from '../src/handover.ts'

const [role, directory] = process.argv.slice(2)
const dir = directory ?? mkdtempSync(join(tmpdir(), 'flow-handover-'))
const script = fileURLToPath(import.meta.url)
const sides = ['A', 'B']
const roles = ['source', 'worker-A', 'worker-B', 'receiver-A', 'receiver-B']
const cli = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : 'orca')

function orca(args) {
  const result = JSON.parse(execFileSync(cli, [...args, '--environment', 'local', '--json'], { encoding: 'utf8', timeout: 30_000 }))
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.result
}
const op = (...args) => orca(['orchestration', ...args])
const file = key => join(dir, key + '.json')
function record(key, value) {
  writeFileSync(file(key) + '.part', JSON.stringify(value, null, 2))
  renameSync(file(key) + '.part', file(key))
  return value
}
async function read(key) {
  const end = Date.now() + 90_000
  while (!existsSync(file(key))) {
    for (const r of roles) {
      if (existsSync(file(r + '-error'))) throw Error(readFileSync(file(r + '-error'), 'utf8'))
    }
    if (Date.now() > end) throw Error('Timed out waiting for ' + key)
    await delay(100)
  }
  return JSON.parse(readFileSync(file(key), 'utf8'))
}
const handle = role => read(role + '-handle')
const route = id => op('run-show', '--id', id, '--full').run
const gates = id => op('gate-list', '--run', id, '--status', 'pending').gates
const inspect = id => classifyRun(route(id), async args => orca(args))

async function source() {
  for (const side of sides) {
    const run = op('run-create', '--objective', 'Flow handover fixture ' + side).runId
    const task = op('task-create', '--run', run, '--spec', 'Return fixture report ' + side).taskId
    const waiting = op('task-create', '--run', run, '--spec', 'Fixture decision ' + side).taskId
    const gate = op('gate-create', '--task', waiting, '--question', 'Finish fixture ' + side + '?').gateId
    const worker = await handle('worker-' + side)
    const dispatch = op('dispatch', '--run', run, '--task', task, '--to', worker).dispatch.id
    record('assignment-' + side, { run, task, waiting, gate, dispatch, worker })
  }
  const unread = await read('unread')
  for (const side of sides) {
    const { run, dispatch, gate } = await read('assignment-' + side)
    assert.equal(route(run).coordinator_handle, await handle('source'))
    assert.deepEqual(gates(run).map(g => g.id), [gate])
    const before = record('before-' + side, await inspect(run))
    assert.ok(before.why.includes('open dispatch ' + dispatch))
    const mail = op('inbox', '--terminal', 'run:' + run).messages
    assert.deepEqual(mail.filter(m => !m.handled).map(m => m.id), side === 'A' ? [unread] : [])
  }
  record('ready', true)
  // Verify the source can still receive B's mail after A moves.
  const status = await read('midpoint-message')
  const { run } = await read('assignment-B')
  assert.equal(route(run).coordinator_handle, await handle('source'))
  assert.deepEqual(op('check', '--peek', '--run', run).messages.map(m => m.id), [status])
  record('source-verified', true)
}

async function worker(side) {
  const { task, dispatch } = await read('assignment-' + side)
  const report = join(dir, 'report-' + side + '.txt')
  const send = (...args) => op('send', '--task-id', task, '--dispatch-id', dispatch, ...args).messageId
  if (side === 'A') record('unread', send('--type', 'status', '--subject', 'Before A moves', '--body', 'Unread'))
  else {
    await read('moved-A')
    record('midpoint-message', send('--type', 'status', '--subject', 'B still at source', '--body', 'After A moved'))
  }
  await read('moved-B')
  writeFileSync(report, 'Fixture report ' + side)
  record('done-' + side, send('--type', 'worker_done', '--subject', 'Report ' + side, '--body', 'Completed fixture.',
    '--outcome', 'succeeded', '--report-path', report))
}

async function receiver(side) {
  await read(side === 'A' ? 'ready' : 'source-verified')
  const { run, dispatch, task, waiting, gate, worker } = await read('assignment-' + side)
  assert.equal(op('run-current').runId, null)
  op('run-use', '--id', run)
  assert.equal(op('run-current').runId, run)
  assert.equal(route(run).coordinator_handle, await handle(role))
  record('moved-' + side, true)
  for (const s of sides) await read('done-' + s)
  const messages = record('mail-' + side, op('check', '--peek', '--run', run).messages)
  assert.deepEqual(messages.map(m => m.id), [await read(side === 'A' ? 'unread' : 'midpoint-message'), await read('done-' + side)])
  const done = messages[1]
  assert.equal(done.from, worker)
  assert.equal(done.type, 'worker_done')
  assert.deepEqual(done.payload, { dispatchId: dispatch, taskId: task, outcome: 'succeeded', reportPath: join(dir, 'report-' + side + '.txt') })
  assert.equal(readFileSync(done.payload.reportPath, 'utf8'), 'Fixture report ' + side)
  assert.deepEqual(gates(run).map(g => g.id), [gate])
  const settled = op('worker-list', '--run', run, '--full').workers
  assert.equal(settled.length, 1)
  assert.equal(settled[0].dispatchStatus, 'completed')
  record('worker-' + side + '-states', { workerState: settled[0].workerState, dispatchStatus: settled[0].dispatchStatus })
  assert.deepEqual(op('check', '--run', run).messages.map(m => m.id), messages.map(m => m.id))
  assert.deepEqual((await inspect(run)).why, ['pending gate ' + gate])
  // Only after recording delivery and the untouched gate, settle this fixture's gated task.
  op('gate-resolve', '--id', gate, '--resolution', 'Fixture verified')
  op('task-update', '--run', run, '--id', waiting, '--status', 'completed')
  assert.equal((await inspect(run)).live, false)
}

async function launch() {
  console.log('Fixture receipts and reports in ' + dir)
  const handles = []
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
  try {
    for (const role of roles) {
      const command = [process.execPath, script, role, dir].map(quote).join(' ')
      const { terminal } = orca(['terminal', 'create', '--worktree', 'current', '--title', 'Flow fixture ' + role, '--command', command])
      assert.ok(terminal.handle && terminal.handle !== process.env.ORCA_TERMINAL_HANDLE && !handles.includes(terminal.handle))
      handles.push(terminal.handle)
      record(role + '-handle', terminal.handle)
    }
    for (const r of roles) await read(r + '-finished')
    console.log('Both run routes, worker reports, files, unread mail, pending gates and final classifications verified.')
  } finally {
    for (const h of handles) orca(['terminal', 'close', '--terminal', h])
  }
}

if (!role) await launch()
else {
  try {
    assert.ok(roles.includes(role))
    assert.equal(process.env.ORCA_TERMINAL_HANDLE, await handle(role))
    if (role === 'source') {
      assert.equal(op('run-current').runId, null)
      await source()
    } else if (role.startsWith('worker-')) await worker(role.at(-1))
    else await receiver(role.at(-1))
    record(role + '-finished', true)
  } catch (error) {
    record(role + '-error', error.stack)
    throw error
  }
}
