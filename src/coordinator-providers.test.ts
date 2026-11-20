import { assert, test } from 'orca/testing'
import { coordinatorProviders, firstProvider, readInstalledProviders } from './coordinator-providers.ts'

test('host installed names are preserved, deduplicated and intersected with trackable session-id harnesses', async () => {
  const installed = await readInstalledProviders(async args => {
    assert.deepEqual(args, ['agent', 'installed'])
    return { agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }, { id: 'hermes', name: 'Hermes' }, { id: 'hermes' }, { id: 'untracked-cli', name: 'Untracked' }, { id: 'pi', name: 'Pi' }, { id: 'prime-agent', name: 'Prime Agent' }] }
  })
  assert.deepEqual(coordinatorProviders(installed), [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }, { id: 'hermes', name: 'Hermes' }])
  assert.equal(await readInstalledProviders(async () => { throw Error('offline') }), null)
  assert.equal(await readInstalledProviders(async () => ({ sessions: [] })), null)
})

test('first start handles zero, unknown, one and many without choosing a default or stale fallback', () => {
  const hermes = { id: 'hermes', name: 'Hermes' }, codex = { id: 'codex', name: 'Codex' }
  for (const available of [null, [], [hermes, codex]]) assert.equal(firstProvider(available).kind, 'provider')
  assert.deepEqual(firstProvider([hermes]), { kind: 'start', agent: 'hermes' })
  assert.deepEqual(firstProvider([hermes, codex], 'codex'), { kind: 'start', agent: 'codex' })
  assert.deepEqual(firstProvider([hermes, codex], 'hermes'), { kind: 'start', agent: 'hermes' })
  assert.equal(firstProvider([hermes], 'codex').kind, 'provider', 'stale choice does not become the remaining provider')
  assert.equal(firstProvider(null, 'codex').kind, 'provider')
})
