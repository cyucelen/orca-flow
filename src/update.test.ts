import { assert, test } from 'orca/testing'
import { cannotUpdate, checkForUpdates, DEV_FOLDER, releasesFromTags, updater, type InstalledPlugin, type Release, type UpdateState } from './update.ts'

const sha = (c: string) => c.repeat(40)
const releases: Release[] = [{ version: '0.2.63', commit: sha('a') }, { version: '0.2.64', commit: sha('b') }]
const fromTag: InstalledPlugin = { isDev: false, source: { kind: 'git', resolvedCommit: sha('b') } }
const fromBranch: InstalledPlugin = { isDev: false, source: { kind: 'git', resolvedCommit: sha('c') } }
const check = (over: Partial<Parameters<typeof checkForUpdates>[0]> = {}) =>
  checkForUpdates({ key: 'cyucelen.flow', current: '0.2.64', releases: async () => releases, plugin: async () => fromTag, now: () => 5, ...over })

test('release tags: an annotated tag is read at its peeled commit; other refs are skipped', () => {
  const lsRemote = [
    `${sha('1')}\trefs/tags/v0.2.63`, `${sha('a')}\trefs/tags/v0.2.63^{}`,
    `${sha('b')}\trefs/tags/v0.2.64`, `${sha('2')}\trefs/tags/nightly`, `${sha('3')}\trefs/tags/v1.0.0-rc1`
  ].join('\n')
  assert.deepEqual(releasesFromTags(lsRemote), [{ version: '0.2.63', commit: sha('a') }, { version: '0.2.64', commit: sha('b') }])
})

test('up to date: the newest release is the running one', async () => {
  assert.deepEqual(await check(), { kind: 'current', current: '0.2.64', latest: '0.2.64', at: 5 })
})

test('a newer release is found and offered', async () => {
  const r = await check({ releases: async () => [...releases, { version: '0.2.65', commit: sha('d') }] })
  assert.deepEqual(r, { kind: 'available', current: '0.2.64', version: '0.2.65', at: 5 })
  // A catalog install, or a copy Orca could not describe, keeps today's behaviour.
  for (const plugin of [{ source: { kind: 'catalog' } }, null] as InstalledPlugin[]) {
    assert.equal((await check({ plugin: async () => plugin, releases: async () => [...releases, { version: '0.2.65', commit: sha('d') }] })).kind, 'available')
  }
})

test('a failed check says why and offers nothing', async () => {
  const r = await check({ releases: async () => { throw new Error('Could not resolve host: github.com') } })
  assert.deepEqual(r, { kind: 'failed', current: '0.2.64', reason: 'Could not resolve host: github.com', at: 5 })
})

test('a copy that cannot update: dev folder, no version, folder install, branch or commit build', async () => {
  const dev = await check({ key: null, releases: async () => { throw new Error('must not read the network') } })
  assert.deepEqual(dev, { kind: 'cannot', current: '0.2.64', reason: DEV_FOLDER, latest: null, at: 5 })
  assert.equal((await check({ current: '' })).kind, 'cannot')
  assert.equal((await check({ plugin: async () => ({ isDev: true, source: null }) })).kind, 'cannot')
  assert.match(cannotUpdate('k', '0.2.64', { source: { kind: 'folder' } }, releases)!, /installed from a folder/)
  // Installed from this branch: the manifest says 0.2.64, but the commit is not the v0.2.64 tag's.
  const branch = await check({ plugin: async () => fromBranch, releases: async () => [...releases, { version: '0.2.65', commit: sha('d') }] })
  assert.equal(branch.kind, 'cannot')
  assert.match((branch as { reason: string }).reason, /installed from commit ccccccc, not the 0\.2\.64 release/)
  assert.equal((branch as { latest: string | null }).latest, '0.2.65')
})

test('an older release is never offered, whatever the copy', async () => {
  for (const plugin of [fromTag, fromBranch, null]) {
    for (const current of ['0.2.64', '0.2.70']) {
      const r = await check({ current, plugin: async () => plugin })
      assert.notEqual(r.kind, 'available', `${current} offered an older release`)
    }
  }
})

test('the status bar and the panel button follow each check, and stop offering when nothing is newer', () => {
  const shown: UpdateState[] = []
  const u = updater({ key: 'cyucelen.flow', current: '0.2.64', dir: '/nonexistent', show: (s) => shown.push(s), start: () => { throw new Error('no real update in tests') }, later: () => {}, log: () => {} })
  u.found('0.2.65')
  assert.deepEqual(u.state, { kind: 'available', version: '0.2.65' })
  u.found(null)
  assert.deepEqual(u.state, { kind: 'none' })
  assert.deepEqual(shown, [{ kind: 'available', version: '0.2.65' }, { kind: 'none' }])
})
