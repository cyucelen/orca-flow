import { assert, test } from 'orca/testing'
import { handoverTargets, readHandoverProviders } from './handover-providers.ts'

test('handover offers enabled supported alternatives, not sessions or unrelated agents', async () => {
  const available = await readHandoverProviders(async (args) => {
    assert.deepEqual(args, ['agent', 'installed'])
    return { agents: [{ id: 'hermes' }, { id: 'codex', default: true }, { id: 'claude' }, { id: 'codex' }] }
  })
  assert.deepEqual(available, ['claude', 'codex'])
  assert.deepEqual(handoverTargets(available, 'claude'), ['codex'])
  assert.deepEqual(handoverTargets(available, 'codex'), ['claude'])
  assert.deepEqual(handoverTargets(available, 'other'), ['claude', 'codex'])
})

test('unavailable and unknown discovery never advertises a provider', async () => {
  assert.deepEqual(handoverTargets(['claude', 'hermes'], 'claude'), [])
  assert.deepEqual(handoverTargets(['codex'], 'codex'), [])
  assert.deepEqual(await readHandoverProviders(async () => ({ agents: [] })), [])
  assert.equal(await readHandoverProviders(async () => { throw Error('unreachable') }), null)
  assert.equal(await readHandoverProviders(async () => ({ sessions: [{ agent: 'claude' }] })), null)
  assert.deepEqual(handoverTargets(null, 'codex'), [])
  assert.deepEqual(handoverTargets(undefined, 'claude'), [])
})
