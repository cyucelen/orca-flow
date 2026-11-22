import { assert, test } from 'orca/testing'
import { discover, parseCodexCatalog, parseInstalled, type Exec } from './model-discovery.ts'

const INSTALLED = JSON.stringify({ id: 'x', ok: true, result: { agents: [{ id: 'claude', name: 'Claude', default: true }, { id: 'codex', name: 'Codex', default: false }] }, _meta: {} })
const level = (effort: string) => ({ effort, description: 'd' })
const CATALOG = JSON.stringify({ models: [
  { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(level), default_reasoning_level: 'low', priority: 1 },
  { slug: 'gpt-secret', visibility: 'hide', supported_reasoning_levels: [level('low')] },
  { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list', supported_reasoning_levels: [level('low')] },
  { slug: 'no-levels', visibility: 'list' },
  { display_name: 'no slug', visibility: 'list' }
] })

test('parseInstalled: envelope, bare result, garbage', () => {
  assert.deepEqual(parseInstalled(INSTALLED), ['claude', 'codex'])
  assert.deepEqual(parseInstalled(JSON.stringify({ agents: [{ id: 'cursor' }, 'x', { name: 'no id' }] })), ['cursor', 'x'])
  assert.deepEqual(parseInstalled(JSON.stringify({ ok: true, result: { agents: [] } })), [])
  for (const bad of ['', 'nope', '[]', '{"ok":false,"error":{}}', '{"ok":true,"result":{}}', '{"agents":3}']) assert.equal(parseInstalled(bad), null)
})

test('parseCodexCatalog: real shape, hidden dropped, ultra dropped, garbage null', () => {
  assert.deepEqual(parseCodexCatalog(CATALOG), [
    { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low'] },
    { id: 'no-levels' }
  ])
  assert.equal(parseCodexCatalog('warning: x\n' + CATALOG)?.length, 3)
  for (const bad of ['', 'nope', '{}', '{"models":"x"}', '{"models":[]}', '{"models":[{"slug":"a","visibility":"hide"}]}']) assert.equal(parseCodexCatalog(bad), null)
})

test('discover: both lookups; a failed one is unknown, not empty', async () => {
  const calls: string[] = []
  const exec: Exec = async (cmd, args, opts) => {
    calls.push(`${cmd} ${args.join(' ')} ${opts?.timeoutMs}`)
    return cmd === 'orca' ? INSTALLED : CATALOG
  }
  const a = await discover(exec)
  assert.deepEqual(a.agents, ['claude', 'codex'])
  assert.equal(a.models.claude, null)
  assert.equal(a.models.codex?.length, 3)
  assert.deepEqual(calls.sort(), ['codex debug models 10000', 'orca agent installed --json 10000'])
  const down: Exec = async () => { throw new Error('timeout') }
  assert.deepEqual(await discover(down), { agents: null, models: { claude: null, codex: null } })
  const junk: Exec = async () => 'not json'
  assert.deepEqual(await discover(junk, { orcaBin: '/o', codexBin: '/c' }), { agents: null, models: { claude: null, codex: null } })
})
