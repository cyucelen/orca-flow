import { assert, test } from 'orca/testing'
import { coordinatorProviders, firstProvider, readInstalledProviders } from './coordinator-providers.ts'

test('host installed names are preserved, deduplicated and intersected with trackable session-id harnesses', async () => {
  const installed = await readInstalledProviders(async args => {
    assert.deepEqual(args, ['agent', 'installed'])
    return { agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }, { id: 'hermes', name: 'Hermes' }, { id: 'antigravity', name: 'Antigravity' }, { id: 'hermes' }, { id: 'untracked-cli', name: 'Untracked' }, { id: 'pi', name: 'Pi' }, { id: 'prime-agent', name: 'Prime Agent' }] }
  })
  assert.deepEqual(coordinatorProviders(installed), [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }, { id: 'hermes', name: 'Hermes' }, { id: 'antigravity', name: 'Antigravity' }])
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

test('an Antigravity first-session choice still passes its workspace availability guard and shared bootstrap', async () => {
  const { launchAntigravityCoordinator } = await import('./antigravity.ts')
  const options = coordinatorProviders(await readInstalledProviders(async () => ({ agents: [{ id: 'codex', name: 'Codex' }, { id: 'antigravity', name: 'Antigravity' }] })))
  assert.equal(firstProvider(options).kind, 'provider')
  assert.deepEqual(firstProvider(options, 'antigravity'), { kind: 'start', agent: 'antigravity' })
  const launched: { agent: string; prompt: string }[] = []
  const start = (enabled: boolean) => launchAntigravityCoordinator('folder:fixture', '/fixture/coordinator', '/fixture/plugin',
    async (args) => { assert.deepEqual(args, ['agent', 'installed', '--worktree', 'path:/fixture/coordinator']); return { agents: enabled ? [{ id: 'antigravity' }] : [] } },
    async input => { launched.push(input); return { terminalId: 'fixture-terminal' } })
  await assert.rejects(start(false), /enabled Antigravity CLI/)
  assert.equal(launched.length, 0, 'a globally offered option cannot bypass workspace revalidation')
  await start(true)
  assert.equal(launched[0].agent, 'antigravity')
  assert.match(launched[0].prompt, /Your role: coordinator/)
  assert.match(launched[0].prompt, /owned projects and scope/)
  assert.match(launched[0].prompt, /AGENTS.md/)
})
