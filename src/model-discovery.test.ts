import { assert, test } from 'orca/testing'
import { discover, parseClaudeModels, parseCodexCatalog, parseInstalled, type Exec } from './model-discovery.ts'

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

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const CLAUDE_OUT = [
  '{"type":"system","subtype":"init"}',
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'orca-flow', response: { models: [
    { value: 'default', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: LEVELS },
    { value: 'claude-fable-5-1', displayName: 'Fable 5.1', supportsEffort: true, supportedEffortLevels: LEVELS },
    { value: 'opus', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: LEVELS },
    { value: 'claude-off', displayName: 'Off', disabled: true },
    { value: 'haiku', displayName: 'Haiku 5.5', supportsEffort: true, supportedEffortLevels: LEVELS },
    { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
    { value: 'sonnet', displayName: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'ultra'] },
    { value: 'claude-plain', displayName: 'Plain', supportsEffort: false }
  ] } } })
].join('\n')

test('parseClaudeModels: skips default and disabled, aliases first, efforts as reported', () => {
  const m = parseClaudeModels(CLAUDE_OUT)
  assert.deepEqual(m?.map((x) => x.id), ['haiku', 'sonnet', 'opus', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-plain'])
  assert.equal(m?.[0].label, 'Haiku 5.5')
  assert.deepEqual(m?.[1].efforts, ['low', 'medium', 'high'])
  assert.deepEqual(m?.[2].efforts, LEVELS)
  assert.equal(m?.[4].efforts, undefined)
  assert.deepEqual(m?.[5].efforts, [])
  for (const bad of ['', 'nope', '{"type":"control_response","response":{"response":{}}}', '{"type":"control_response","response":{"response":{"models":[{"value":"default"}]}}}']) assert.equal(parseClaudeModels(bad), null)
})

test('discover: all lookups; a failed one is unknown, not empty', async () => {
  const calls: string[] = []
  const exec: Exec = async (cmd, args, opts) => {
    calls.push(`${cmd} ${cmd === 'sh' ? args[3] : args.join(' ')} ${opts?.timeoutMs}`)
    return cmd === 'orca' ? INSTALLED : cmd === 'sh' ? CLAUDE_OUT : CATALOG
  }
  const a = await discover(exec, { claudeBin: '/c/claude' })
  assert.deepEqual(a.agents, ['claude', 'codex'])
  assert.equal(a.models.claude?.length, 6)
  assert.equal(a.models.codex?.length, 3)
  assert.deepEqual(calls.sort(), ['codex debug models 10000', 'orca agent installed --json 10000', 'sh /c/claude 20000'])
  const down: Exec = async () => { throw new Error('timeout') }
  assert.deepEqual(await discover(down), { agents: null, models: { claude: null, codex: null } })
  const junk: Exec = async () => 'not json'
  assert.deepEqual(await discover(junk, { orcaBin: '/o', codexBin: '/c' }), { agents: null, models: { claude: null, codex: null } })
})
