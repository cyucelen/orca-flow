import { assert, test } from 'orca/testing'
import { hotBytes, parsePs, parseTop, startedGroups } from './started.ts'
import { fromPs } from './worker.ts'

const MB = 1024 ** 2

test('top with the cmprs column: footprint and compressed per pid, in any unit, with or without +/-', () => {
  // As `top -l 1 -stats pid,mem,cmprs -n 5000` prints it on macOS: a header block, then the columns.
  const out = [
    'Processes: 812 total, 4 running, 808 sleeping, 4313 threads',
    'PhysMem: 31G used (4810M wired, 12G compressor), 127M unused.',
    '',
    'PID    MEM   CMPRS',
    '81265  3920M+ 3509M',
    '81266  2G-   512M+',
    '81267  1.5G  1536M-',
    '99058  928K  720K ',
    '99059  640B  0B',
    '99060  13M   12M  '
  ].join('\n')
  const top = parseTop(out)
  assert.equal(top.size, 6, 'the header and summary lines are not processes')
  assert.deepEqual(top.get(81265), { bytes: 3920 * MB, compressed: 3509 * MB })
  assert.deepEqual(top.get(81266), { bytes: 2 * 1024 * MB, compressed: 512 * MB })
  assert.deepEqual(top.get(81267), { bytes: 1.5 * 1024 * MB, compressed: 1536 * MB })
  assert.deepEqual(top.get(99058), { bytes: 928 * 1024, compressed: 720 * 1024 })
  assert.deepEqual(top.get(99059), { bytes: 640, compressed: 0 })
})

test('hot memory is the footprint minus its compressed pages, never below 0', () => {
  assert.equal(hotBytes({ bytes: 3920 * MB, compressed: 3509 * MB }), 411 * MB)
  assert.equal(hotBytes({ bytes: 1.5 * 1024 * MB, compressed: 1536 * MB }), 0)
  assert.equal(hotBytes({ bytes: 100 * MB, compressed: 120 * MB }), 0, 'top reads the two columns at slightly different moments')
  assert.equal(hotBytes(undefined), 0)
})

test('a started group keeps its footprint for the sidebar and its hot memory for the capacity gate', () => {
  const tag = (pane: string) => `ORCA_WORKTREE_ID=repo1::/w/mono ORCA_PANE_KEY=${pane} HOME=/h`
  const procs = parsePs([
    `  100     1 /usr/bin/login -flpq me ${tag('p1')}`,
    `  200     1 node /h/.nvm/bin/pnpm dev ${tag('p1')}`,
    '  201   200 next-server (v16.4.5)',
    `  300     1 /opt/android/emulator/qemu-system-aarch64 -avd Pixel ${tag('p2')}`
  ].join('\n'))
  const top = parseTop('PID MEM CMPRS\n200 100M 40M\n201 7300M+ 6100M\n300 4700M 4200M-\n')
  const rows = fromPs([{ identity: { key: 'w' }, displayName: 'mono', repo: 'mono', path: '/w/mono', agents: [{ paneKey: 'p1', state: 'idle' }] } as never])
  const groups = startedGroups(procs, top, [100], rows)
  assert.deepEqual(groups.map((g) => [g.paneKey, g.name, g.count, g.memMB, g.hotMB]), [
    ['p1', 'next-server', 2, 7400, 1260],
    ['p2', 'qemu-system-aarch64', 1, 4700, 500]
  ])
})
