import assert from 'node:assert/strict'
import { test } from 'node:test'
import { awaitHandover, handoverGate } from '../skills/orca-flow/scripts/await-handover.mjs'

const fixture = () => ({
  record: { source: 'source', phase: 'delivered', provider: 'codex', bootstrap: { context: '/fixture/context-1', deadline: 120000 }, target: { id: 'target', terminals: ['term-target'] } },
  coordinator: { sessions: { current: 'source' } }
})

test('first-turn barrier survives incomplete registration and retryable errors, continuing on exact cutover without another prompt', async () => {
  const f = fixture(); let time = 0, reads = 0
  delete f.record.target
  f.record.error = 'temporary reveal failure'
  const result = await awaitHandover({ dir: '/fixture', context: '/fixture/context-1', caller: 'term-target', now: () => time,
    read: (file) => { reads++; return file.endsWith('coordinator.json') ? f.coordinator : f.record },
    sleep: async (ms) => {
      time += ms
      if (time === 500) { f.record.target = { id: 'target', terminals: ['term-target'] }; f.coordinator.sessions.current = 'target' }
      if (time === 750) { f.record.phase = 'complete'; delete f.record.error }
    }
  })
  assert.deepEqual(result, { status: 'ready', provider: 'codex', member: 'target' })
  assert.equal(time, 750, 'selection alone does not release before the journal commit')
  assert.equal(reads, 8, 'only the two local state files are read on each check')
})

test('the passive barrier is bounded when cutover never commits', async () => {
  const f = fixture(); let time = 0
  const result = await awaitHandover({ dir: '/fixture', context: '/fixture/context-1', caller: 'term-target', now: () => time,
    read: (file) => file.endsWith('coordinator.json') ? f.coordinator : f.record,
    sleep: async (ms) => { time += ms }
  })
  assert.equal(result.status, 'expired')
  assert.equal(time, 120000)
  assert.equal(f.coordinator.sessions.current, 'source')
  assert.equal(f.record.phase, 'delivered')
})

test('completed cutover is recognized even if the provider begins executing the prompt later', () => {
  const f = fixture(); f.record.phase = 'complete'; f.coordinator.sessions.current = 'target'
  assert.equal(handoverGate(f.record, f.coordinator, '/fixture/context-1', 'term-target', 200000).status, 'ready')
  assert.equal(handoverGate(f.record, f.coordinator, '/fixture/context-1', 'term-other', 0).status, 'refused')
  assert.equal(handoverGate(f.record, f.coordinator, '/fixture/context-2', 'term-target', 0).status, 'refused')
  f.coordinator.sessions.current = 'newer-selection'
  assert.equal(handoverGate(f.record, f.coordinator, '/fixture/context-1', 'term-target', 0).status, 'refused')
})

test('a missing/invalid journal or a legacy attempt fails closed without invoking Orca', async () => {
  const f = fixture(); delete f.record.bootstrap
  assert.equal(handoverGate(f.record, f.coordinator, '/fixture/context-1', 'term-target', 0).status, 'refused')
  let time = 0
  const result = await awaitHandover({ dir: '/fixture', context: '/fixture/context-1', caller: 'term-target', now: () => time, sleep: async ms => { time += ms }, read: () => { throw Error('missing') } })
  assert.equal(result.status, 'expired')
  assert.equal(time, 120000)
})

test('a transient coordinator file read during selection cannot strand the first turn', async () => {
  const f = fixture(); let time = 0
  const result = await awaitHandover({ dir: '/fixture', context: '/fixture/context-1', caller: 'term-target', now: () => time,
    sleep: async ms => { time += ms; f.record.phase = 'complete'; f.coordinator.sessions.current = 'target' },
    read: file => { if (!time) throw new SyntaxError('partial JSON'); return file.endsWith('coordinator.json') ? f.coordinator : f.record }
  })
  assert.equal(result.status, 'ready')
  assert.equal(time, 250)
})

test('an adopting attempt releases the barrier to the target with the one run-use to run', () => {
  const f = fixture(); f.record.phase = 'adopting'; f.record.runs = [{ id: 'run_live' }]; f.coordinator.sessions.current = 'target'
  assert.deepEqual(handoverGate(f.record, f.coordinator, '/fixture/context-1', 'term-target', 0), { status: 'ready', provider: 'codex', member: 'target', adopt: 'run_live', next: 'orca orchestration run-use --id run_live' })
  assert.equal(handoverGate(f.record, f.coordinator, '/fixture/context-1', 'term-other', 0).status, 'refused', 'never another terminal')
  f.coordinator.sessions.current = 'source'
  assert.equal(handoverGate(f.record, f.coordinator, '/fixture/context-1', 'term-target', 0).status, 'refused', 'only once the selection committed')
})
