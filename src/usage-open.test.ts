import { assert, test } from 'orca/testing'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureUsageStub, USAGE_PATH } from './usage-open.ts'
import { parseTaskTitles, readTitles, runsMissingTitles, writeTitles } from './usage-titles.ts'

test('the stub: the folder, a .gitignore holding * and the stub file; run again it changes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-open-'))
  try {
    const stub = ensureUsageStub(root)
    assert.equal(stub, join(root, USAGE_PATH))
    assert.equal(USAGE_PATH, '.orca/orca-flow/usage.orcaflow-usage')
    assert.equal(readFileSync(join(root, '.orca/orca-flow/.gitignore'), 'utf8'), '*\n')
    assert.ok(existsSync(stub))
    writeFileSync(stub, 'kept')
    ensureUsageStub(root)
    assert.equal(readFileSync(stub, 'utf8'), 'kept', 'an existing stub is not rewritten')
    // A .gitignore without * is replaced; one that has it stays.
    writeFileSync(join(root, '.orca/orca-flow/.gitignore'), 'node_modules\n')
    ensureUsageStub(root)
    assert.equal(readFileSync(join(root, '.orca/orca-flow/.gitignore'), 'utf8'), '*\n')
    writeFileSync(join(root, '.orca/orca-flow/.gitignore'), '# mine\n*\n!keep\n')
    ensureUsageStub(root)
    assert.equal(readFileSync(join(root, '.orca/orca-flow/.gitignore'), 'utf8'), '# mine\n*\n!keep\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('task titles: parsed from task-list, kept on disk, and only the runs with a missing title are asked', () => {
  const found = parseTaskTitles({ tasks: [{ id: 't1', title: '  Fix  the\nbug ', status: 'completed' }, { id: 't2', title: '' }, { id: 7, title: 'x' }, { title: 'no id' }] })
  assert.deepEqual(found, { t1: 'Fix the bug' })
  assert.deepEqual(parseTaskTitles(null), {})
  assert.deepEqual(parseTaskTitles({ tasks: 'nope' }), {})
  const dir = mkdtempSync(join(tmpdir(), 'usage-titles-'))
  try {
    assert.deepEqual(readTitles(dir), {})
    writeTitles(dir, found)
    assert.deepEqual(readTitles(dir), found)
    mkdirSync(join(dir, 'usage'), { recursive: true })
    writeFileSync(join(dir, 'usage', 'titles.json'), '{broken')
    assert.deepEqual(readTitles(dir), {}, 'a broken file reads as none')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.deepEqual(runsMissingTitles([{ taskId: 't1', runId: 'r1' }, { taskId: 't2', runId: 'r2' }, { taskId: 't3', runId: 'r2' }, { taskId: null, runId: 'r3' }, { taskId: 't4', runId: null }], found), ['r2'])
})
