import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANTIGRAVITY_MODEL, claudeSettingsEnv, cliProviders, cliResolver, codexHomeFromAccounts, createWriter, failureReason, LUNA_MODEL, PRIMARY_COOLDOWN_MS, providerFailure, runWriterCommand, WriterError, writerDiagnostic, type CommandRunner } from './writer.ts'
import { SUMMARY_SCHEMA, summarizePane, summaryProviders, turnSummarizer, validateSummary } from './summarize.ts'
import { configuredWriters } from './config.ts'
import type { WriterSetting } from './settings.ts'

const card = (title = 'Guest checkout') => ({ title, about: 'Enable guest checkout.', goal: 'Buy without an account.', since: 'Tests pass.', needs: { type: 'none', ask: '', options: [] }, glance: '', watching: '', effort: 'quick', priority: 'P1' })
const request = { prompt: 'Synthetic checkout task', system: 'Write a card.', schema: SUMMARY_SCHEMA }
const failure = (provider: 'haiku' | 'luna', kind: ConstructorParameters<typeof WriterError>[1]) => async () => { throw new WriterError(provider, kind) }

test('Haiku remains primary; quota falls back, skips cooldown, and recovers later', async () => {
  let now = 10, primaryCalls = 0, fallbackCalls = 0, unavailable = false
  const logs: string[] = []
  const writer = createWriter({ now: () => now, log: (message) => logs.push(message), ...summaryProviders({
    haiku: async () => { primaryCalls++; if (unavailable) throw new WriterError('haiku', 'quota'); return card('Primary title') },
    luna: async () => { fallbackCalls++; return card('Luna title') }
  }) })
  assert.equal((await writer(request) as any).title, 'Primary title')
  assert.equal(fallbackCalls, 0)
  unavailable = true
  assert.equal((await writer(request) as any).title, 'Luna title')
  await writer(request)
  assert.equal(primaryCalls, 2)
  assert.equal(fallbackCalls, 2)
  assert.equal(logs.length, 1)
  now += PRIMARY_COOLDOWN_MS
  unavailable = false
  assert.equal((await writer(request) as any).title, 'Primary title')
  assert.equal(primaryCalls, 3)
  assert.match(logs.at(-1)!, /recovered/)
})

test('concurrent jobs share one failed primary probe, including at recovery', async () => {
  let calls = 0, now = 1
  const writer = createWriter({ now: () => now, haiku: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); throw new WriterError('haiku', 'timeout') }, luna: async () => card() })
  await Promise.all([writer(request), writer(request), writer(request)])
  assert.equal(calls, 1)
  now += 30_000
  await Promise.all([writer(request), writer(request)])
  assert.equal(calls, 2)
})

test('total failure cools down Luna too; retries are bounded and can recover', async () => {
  let now = 1, calls = 0
  const writer = createWriter({ now: () => now, haiku: failure('haiku', 'auth'), luna: async () => { if (++calls === 1) throw new WriterError('luna', 'quota'); return card() } })
  await assert.rejects(writer(request), /luna: quota/)
  await assert.rejects(writer(request), /luna: quota/)
  assert.equal(calls, 1)
  now += PRIMARY_COOLDOWN_MS
  assert.deepEqual(await writer(request), card())
})

test('programming errors and malformed provider output never trigger broad fallback', async () => {
  let fallbackCalls = 0
  for (const haiku of [async () => { throw new TypeError('private prompt') }, async () => ({ title: 'incomplete' }), async () => ({ ...card(), pane: 'overwrite' })]) {
    const writer = createWriter(summaryProviders({ haiku, luna: async () => { fallbackCalls++; return card() } }))
    await assert.rejects(writer(request))
  }
  assert.equal(fallbackCalls, 0)
  assert.ok(!writerDiagnostic(new Error('secret bearer token')).includes('secret'))
})

test('known operational failures are classified without exposing command/output/credentials', () => {
  const cases: [any, string, string][] = [
    [{ code: 'ENOENT' }, '', 'unavailable'], [{ code: 'EACCES' }, '', 'unavailable'],
    [{ killed: true }, 'private prompt', 'timeout'], [{ code: 'ECONNRESET' }, '', 'transient'],
    [null, 'API Error: 429 rate_limit_error secret', 'quota'], [null, "You've hit your limit", 'quota'],
    [null, 'Not logged in token secret', 'auth'], [null, 'API Error: 401', 'auth'],
    [null, 'API Error: 529 overloaded_error', 'transient'], [null, 'model gpt-6-luna is not supported', 'unavailable'],
    [null, 'unknown option --bad-flag', 'unexpected'],
    [null, 'Error: invalid_request_error: messages: text content blocks must be non-empty', 'unexpected'],
    [null, 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be positive"}}', 'unexpected'],
    [null, 'stream disconnected before completion: error sending request', 'transient']
  ]
  for (const [error, output, kind] of cases) {
    const result = providerFailure('haiku', error, output)
    assert.equal(result.kind, kind)
    assert.ok(!result.message.includes('secret'))
  }
})

test('Google sign-in, quota, timeout and model errors are classified', () => {
  const cases: [string, string][] = [
    ['rpc error: code = DeadlineExceeded desc = DEADLINE_EXCEEDED secret', 'timeout'], ['deadline exceeded while waiting', 'timeout'],
    ['429 RESOURCE_EXHAUSTED: secret', 'quota'], ['resource exhausted for project', 'quota'],
    ['16 UNAUTHENTICATED: secret', 'auth'], ['oauth2: invalid_grant secret', 'auth'], ['token refresh failed: invalid grant', 'auth'],
    ['You are not signed in.', 'auth'], ['Not logged in', 'auth'], ['Please sign in with Google to continue', 'auth'],
    ['Google sign-in required', 'auth'], ['google signin expired', 'auth'], ['Login required', 'auth'],
    ['Unknown model: gemini-9-ultra', 'unavailable'], ['unsupported model gemini-4-carbon-low', 'unavailable'], ['model "gemini-9" is invalid', 'unavailable']
  ]
  for (const [output, kind] of cases) {
    const result = providerFailure('flash', { code: 1 }, output)
    assert.equal(result.kind, kind, output)
    assert.ok(!result.message.includes('secret'))
  }
})

test('selected host account is resolved explicitly; no silent account substitution', () => {
  const metadata = { ok: true, result: { activeAccountId: 'other', activeAccountIdsByRuntime: { host: 'selected' }, accounts: [{ id: 'selected', managedHomeRuntime: 'host' }] } }
  assert.equal(codexHomeFromAccounts(metadata, '/orca', '/home'), '/orca/codex-accounts/selected/home')
  assert.equal(codexHomeFromAccounts({ ok: true, result: { activeAccountId: null } }, '/orca', '/home'), '/home/.codex')
  assert.equal(codexHomeFromAccounts({ ok: true, result: { activeAccountId: 'stale', activeAccountIdsByRuntime: { host: null } } }, '/orca', '/home'), '/home/.codex')
  for (const bad of [{ ok: false }, { ok: true, result: {} }, { ok: true, result: { activeAccountId: '../escape', accounts: [] } }]) assert.throws(() => codexHomeFromAccounts(bad))
})

test('CLI adapters use exact Luna model, stdin, isolated output schema, and preserve explicit account/config', async () => {
  const old = process.env.CODEX_HOME
  process.env.CODEX_HOME = '/existing/account'
  const calls: Parameters<CommandRunner>[0][] = []
  const providers = cliProviders(async (command) => {
    calls.push(command)
    if (command.args[0] === '-p') return { stdout: JSON.stringify({ is_error: true, result: 'Rate limit reached private-text' }), stderr: '', error: null }
    const output = command.args[command.args.indexOf('--output-last-message') + 1]
    const schema = command.args[command.args.indexOf('--output-schema') + 1]
    assert.deepEqual(JSON.parse(readFileSync(schema, 'utf8')), SUMMARY_SCHEMA)
    assert.equal(command.env.CODEX_HOME, '/existing/account')
    assert.equal(command.input, request.prompt)
    assert.equal(command.args[command.args.indexOf('--model') + 1], LUNA_MODEL)
    assert.ok(command.args.includes('--ephemeral'))
    assert.ok(command.args.includes('model_provider="openai"'))
    assert.ok(command.args.includes('features.shell_tool=false'))
    assert.ok(command.args.includes('--ignore-user-config'))
    assert.ok(!command.args.includes('resume'))
    assert.equal(command.env.CLAUDECODE, undefined)
    assert.equal(command.env.ORCA_TERMINAL_ID, undefined)
    writeFileSync(output, JSON.stringify(card()))
    return { stdout: 'ignored commentary', stderr: '', error: null }
  })
  try {
    assert.deepEqual(await createWriter(summaryProviders(providers))(request), card())
    assert.equal(calls.length, 2)
    assert.ok(!existsSync(calls[1].cwd), 'temporary output removed')
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old }
})

test('missing/malformed fallback output fails safely and removes temporary files', async () => {
  const old = process.env.CODEX_HOME
  process.env.CODEX_HOME = '/existing/account'
  let dir = ''
  try {
    const providers = cliProviders(async (command) => { dir = command.cwd; return { stdout: 'not a card', stderr: '', error: null } })
    await assert.rejects(providers.luna(request), /invalid-output/)
    assert.ok(!existsSync(dir))
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old }
})

test('actual process adapter captures output, nonzero exit and executable absence', async () => {
  const base = { env: {}, cwd: tmpdir(), input: 'synthetic' }
  const result = await runWriterCommand({ ...base, bin: '/bin/sh', args: ['-c', 'cat; printf error >&2; exit 3'] })
  assert.deepEqual(result, { stdout: 'synthetic', stderr: 'error', error: { code: 3 } })
  const missing = await runWriterCommand({ ...base, bin: '/nonexistent/orca-flow-writer', args: [] })
  assert.equal(missing.error?.code, 'ENOENT')
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-writer-test-'))
  const transcript = join(dir, 'transcript.jsonl')
  writeFileSync(transcript, [
    { type: 'user', timestamp: '2026-11-19T12:00:00Z', message: { content: 'Enable guest checkout' } },
    { type: 'assistant', timestamp: '2026-11-19T12:01:00Z', message: { content: [{ type: 'text', text: 'Tests pass.' }] } }
  ].map((v) => JSON.stringify(v)).join('\n'))
  const input = { pane: 'pane', transcript, dir }
  const path = join(dir, 'pane.json')
  const previous = { ...card('Existing title'), turnAt: '2026-11-18T12:00:00Z', updatedAt: 1 }
  writeFileSync(path, JSON.stringify(previous))
  return { dir, input, path, previous }
}

test('manual summarizePane consumer publishes fallback title and summary together, then skips duplicate', async () => {
  const f = fixture()
  try {
    const writer = createWriter(summaryProviders({ haiku: failure('haiku', 'unavailable'), luna: async () => card('Fallback title') }))
    assert.equal(await summarizePane({ ...f.input, writer }), 'written')
    const saved = JSON.parse(readFileSync(f.path, 'utf8'))
    assert.equal(saved.title, 'Fallback title')
    assert.equal(saved.since, 'Tests pass.')
    assert.equal(saved.source, 'summarizer')
    assert.equal(await summarizePane({ ...f.input, writer: async () => { throw new Error('must skip') } }), 'skipped')
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('background consumer preserves exact existing card on total/invalid failure and recovers on later work', async () => {
  const f = fixture(), logs: string[] = []
  let now = 1, valid = false
  const writer = createWriter({ now: () => now, ...summaryProviders({ haiku: async () => { if (valid) return card('Recovered primary title'); throw new WriterError('haiku', 'quota') }, luna: async () => ({ title: 'incomplete' }) }) })
  const queue = turnSummarizer({ run: (job) => summarizePane({ ...job, dir: f.dir, writer }), log: (m) => logs.push(m) })
  try {
    await queue.enqueue(f.input)
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), f.previous)
    assert.match(logs[0], /invalid-output/)
    const failed = createWriter({ haiku: failure('haiku', 'quota'), luna: failure('luna', 'auth') })
    await assert.rejects(summarizePane({ ...f.input, writer: failed }))
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), f.previous)
    valid = true; now += PRIMARY_COOLDOWN_MS
    await queue.enqueue(f.input)
    assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).title, 'Recovered primary title')
  } finally { queue.dispose(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('late writer does not overwrite a concurrently published same/newer turn', async () => {
  for (const turnAt of ['2026-11-19T12:01:00Z', '2026-11-20T12:01:00Z']) {
    const f = fixture()
    try {
      const saved = { ...card('Concurrent title'), turnAt, updatedAt: 2 }
      const result = await summarizePane({ ...f.input, force: true, writer: async () => { writeFileSync(f.path, JSON.stringify(saved)); return card('Late title') } })
      assert.equal(result, 'skipped')
      assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), saved)
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  }
})

test('validation protects both title and all required card fields', () => {
  for (const value of [null, [], { ...card(), title: ' ' }, { ...card(), needs: { type: 'decision', ask: '?', options: [1] } }, { ...card(), effort: 'unknown' }, { ...card(), since: null }, { ...card(), updatedAt: 999 }]) assert.throws(() => validateSummary(value))
})


test('deadline kills the launcher and its descendants before they can write later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-writer-timeout-'))
  const marker = join(dir, 'leaked')
  try {
    const started = Date.now()
    const result = await runWriterCommand({ bin: '/bin/sh', args: ['-c', `sleep 0.3; printf leaked > '${marker}'`], env: {}, cwd: dir, input: '' }, 40)
    assert.equal(result.error?.killed, true)
    assert.ok(Date.now() - started < 1000)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(existsSync(marker), false, 'descendant must not outlive timeout')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('background outage logs are sanitized and throttled across panes', async () => {
  const logs: string[] = []
  const queue = turnSummarizer({ run: failure('luna', 'auth'), log: (message) => logs.push(message) })
  try {
    await Promise.all(['a', 'b', 'c'].map((pane) => queue.enqueue({ pane, transcript: 'unused' })))
    assert.equal(logs.length, 1)
    assert.match(logs[0], /check the provider login/)
  } finally { queue.dispose() }
})

test('Haiku adapter classifies actual result/errors and API error envelopes without a live request', async () => {
  const cases: [string, string, { code?: unknown; killed?: boolean } | null, string][] = [
    ['', '', { killed: true }, 'timeout'],
    [JSON.stringify({ type: 'error', error: { type: 'timeout_error', message: 'Synthetic server deadline' } }), '', null, 'timeout'],
    ['null', '', { killed: true }, 'timeout'],
    [JSON.stringify({ structured_output: card() }), '', { killed: true }, 'timeout'],
    ['', '', { code: 'ENOENT' }, 'unavailable'],
    ['[]', 'Not logged in', { code: 1 }, 'auth'],
    ['partial JSON', 'API Error: 429', { code: 1 }, 'quota'],
    [JSON.stringify({ type: 'result', is_error: true, result: "You've hit your limit" }), '', null, 'quota'],
    [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['rate_limit_error'] }), '', { code: 1 }, 'quota'],
    [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API request failed'], api_error_status: 429 }), '', null, 'quota'],
    [JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Synthetic enforced spend cap' } }), '', { code: 1 }, 'quota'],
    [JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits' } }), '', { code: 1 }, 'quota'],
    [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Unknown argument --bad-flag'] }), '', { code: 1 }, 'unexpected'],
    [JSON.stringify({ structured_output: card(), result: 'Discussion of quota in the input' }), 'Unknown argument --bad-flag', { code: 1 }, 'unexpected'],
    ['null', '', null, 'invalid-output']
  ]
  for (const [stdout, stderr, error, kind] of cases) {
    const providers = cliProviders(async () => ({ stdout, stderr, error }))
    await assert.rejects(providers.haiku(request), (e) => e instanceof WriterError && e.kind === kind)
  }
})

test('Haiku returned quota/timeout failures invoke Luna, while nonzero programming errors do not', async () => {
  for (const fixture of [
    { stdout: 'null', stderr: '', error: { killed: true } },
    { stdout: JSON.stringify({ type: 'result', is_error: true, errors: ['rate_limit_error'] }), stderr: '', error: { code: 1 } },
    { stdout: '', stderr: 'Unknown argument --bad-flag', error: { code: 1 } }
  ]) {
    let calls = 0
    const { haiku } = cliProviders(async () => fixture)
    const writer = createWriter(summaryProviders({ haiku, luna: async () => { calls++; return card() } }))
    if (fixture.stderr) { await assert.rejects(writer(request), /unexpected/); assert.equal(calls, 0) }
    else { assert.deepEqual(await writer(request), card()); assert.equal(calls, 1) }
  }
})

test('Luna strips inherited endpoint overrides without changing the selected auth home', async () => {
  const keys = ['CODEX_HOME', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL']
  const original = keys.map((key) => process.env[key])
  process.env.CODEX_HOME = '/selected/auth'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/custom'
  process.env.CHATGPT_BASE_URL = 'http://127.0.0.1:1/custom'
  try {
    const providers = cliProviders(async (command) => {
      assert.equal(command.env.CODEX_HOME, '/selected/auth')
      assert.equal(command.env.OPENAI_BASE_URL, undefined)
      assert.equal(command.env.CHATGPT_BASE_URL, undefined)
      writeFileSync(command.args[command.args.indexOf('--output-last-message') + 1], JSON.stringify(card()))
      return { stdout: '', stderr: '', error: null }
    })
    assert.deepEqual(await providers.luna(request), card())
  } finally {
    keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i] })
  }
})

// ---------- writers from config.json ----------

const chainOf = (...entries: [string, string | undefined, boolean][]) => entries.map(([provider, model, enabled]) => ({ provider, ...(model ? { model } : {}), enabled }) as WriterSetting)
const named = (name: string, calls: string[], fail?: () => WriterError | undefined) => async () => { calls.push(name); const e = fail?.(); if (e) throw e; return card(name) }

test('absent config = today: Haiku first, then Luna', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-writer-config-'))
  try {
    const calls: string[] = []
    let haikuDown = false
    const writer = createWriter({ writers: () => configuredWriters(dir), haiku: named('haiku', calls, () => haikuDown ? new WriterError('haiku', 'quota') : undefined), sonnet: named('sonnet', calls), luna: named('luna', calls) })
    assert.equal((await writer(request) as any).title, 'haiku')
    haikuDown = true
    assert.equal((await writer(request) as any).title, 'luna')
    assert.deepEqual(calls, ['haiku', 'haiku', 'luna'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('order, enable and Claude model come from config, read again for every request', async () => {
  const calls: string[] = []
  let writers = chainOf(['codex', 'gpt-6-luna', true], ['claude', 'sonnet', true], ['antigravity', undefined, false])
  const writer = createWriter({ writers: () => writers, haiku: named('haiku', calls), sonnet: named('sonnet', calls), luna: named('luna', calls) })
  assert.equal((await writer(request) as any).title, 'luna')
  writers = chainOf(['codex', 'gpt-6-luna', false], ['claude', 'sonnet', true])
  assert.equal((await writer(request) as any).title, 'sonnet')
  writers = chainOf(['claude', 'haiku', true], ['codex', 'gpt-6-luna', true])
  assert.equal((await writer(request) as any).title, 'haiku')
  assert.deepEqual(calls, ['luna', 'sonnet', 'haiku'])
})

test('a turned-off writer is never called, even as the last resort', async () => {
  const calls: string[] = []
  const writer = createWriter({ writers: () => chainOf(['claude', 'haiku', true], ['codex', 'gpt-6-luna', false]), haiku: named('haiku', calls, () => new WriterError('haiku', 'quota')), luna: named('luna', calls) })
  await assert.rejects(writer(request), /haiku: quota/)
  await assert.rejects(writer(request), /haiku: quota/)
  assert.deepEqual(calls, ['haiku'])
})

test('no writer turned on: the card waits with an actionable error', async () => {
  const writer = createWriter({ writers: () => chainOf(['claude', 'haiku', false], ['codex', 'gpt-6-luna', false]), haiku: async () => card(), luna: async () => card() })
  await assert.rejects(writer(request), (e) => e instanceof WriterError && e.kind === 'disabled' && /turn on a writer/.test(e.message))
})

test('cooldowns follow the configured order; one probe of the first writer at a time; health reports them', async () => {
  let now = 1_000
  const calls: string[] = []
  let codexDown = true
  const writer = createWriter({
    now: () => now,
    writers: () => chainOf(['codex', 'gpt-6-luna', true], ['claude', 'haiku', true]),
    luna: async () => { calls.push('luna'); await new Promise((r) => setTimeout(r, 5)); if (codexDown) throw new WriterError('luna', 'auth'); return card('luna') },
    haiku: named('haiku', calls)
  })
  const results = await Promise.all([writer(request), writer(request), writer(request)]) as any[]
  assert.deepEqual(results.map((r) => r.title), ['haiku', 'haiku', 'haiku'])
  assert.equal(calls.filter((c) => c === 'luna').length, 1, 'one failed probe shared by queued work')
  const health = writer.health()
  assert.deepEqual(health.find((h) => h.provider === 'codex')?.failure, { kind: 'auth', until: 1_000 + PRIMARY_COOLDOWN_MS })
  assert.equal(health.find((h) => h.provider === 'claude')?.lastSuccessAt, 1_000)
  now += PRIMARY_COOLDOWN_MS
  codexDown = false
  assert.equal((await writer(request) as any).title, 'luna')
  assert.equal(writer.health().find((h) => h.provider === 'codex')?.failure, null)
})

test('invalid output from the first configured writer never falls through', async () => {
  const calls: string[] = []
  const configured = createWriter({ ...summaryProviders({ sonnet: async () => ({ title: 'incomplete' }), luna: named('luna', calls) }), writers: () => chainOf(['claude', 'sonnet', true], ['codex', 'gpt-6-luna', true]) })
  await assert.rejects(configured(request), /sonnet: invalid-output/)
  assert.deepEqual(calls, [])
})

test('the Claude adapter passes the configured model to claude -p --model', async () => {
  for (const model of ['haiku', 'sonnet'] as const) {
    let args: string[] = []
    const providers = cliProviders(async (command) => { args = command.args; return { stdout: JSON.stringify({ structured_output: card() }), stderr: '', error: null } })
    assert.deepEqual(await providers[model](request), card())
    assert.equal(args[args.indexOf('--model') + 1], model)
    assert.equal(args[args.indexOf('--tools') + 1], '')
  }
})

test('Antigravity adapter isolates tools via a temporary custom agent, strict settings, stdin stream-json, and cleans up session files', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'orca-agy-home-'))
  const oldHome = process.env.HOME
  process.env.HOME = fakeHome
  const cid = '12345678-1234-4234-8234-123456789abc'
  let workDir = ''
  try {
    const providers = cliProviders(async (command) => {
      workDir = command.cwd
      assert.equal(command.args[command.args.indexOf('--agent') + 1], 'orca-flow-card-writer')
      assert.equal(command.args[command.args.indexOf('--model') + 1], ANTIGRAVITY_MODEL)
      assert.equal(command.args[command.args.indexOf('--input-format') + 1], 'stream-json')
      assert.equal(command.args[command.args.indexOf('--output-format') + 1], 'stream-json')
      assert.ok(command.args.includes('--disable-slash-commands'))
      assert.ok(!command.args.some((a) => a.includes(request.prompt)), 'prompt stays on stdin, never argv')
      assert.deepEqual(JSON.parse(command.input.trim()), { event: 'user', message: { content: request.prompt } })
      const settings = JSON.parse(command.args[command.args.indexOf('--settings') + 1])
      assert.equal(settings.agentMode, '')
      assert.equal(settings.toolPermission, 'strict')
      assert.equal(settings.allowNonWorkspaceAccess, false)
      assert.equal(settings.modelProvider, '')
      assert.ok(settings.permissions.deny.includes('command(*)'))
      assert.ok(settings.permissions.deny.includes('read_file(*)'))
      assert.ok(settings.permissions.deny.includes('mcp(*)'))
      const agentMd = readFileSync(join(command.cwd, '.agents', 'agents', 'orca-flow-card-writer', 'agent.md'), 'utf8')
      assert.match(agentMd, /^tools: \[\]$/m)
      assert.match(agentMd, /^inheritCustomizations: false$/m)
      assert.match(agentMd, /^inheritMcp: false$/m)
      assert.match(agentMd, /^excludeDefaultComponents: true$/m)
      assert.match(agentMd, /^commandExecutionPolicy: off$/m)
      // Simulate agy persisting the headless conversation under HOME.
      const brain = join(fakeHome, '.gemini', 'antigravity-cli', 'brain', cid)
      const convs = join(fakeHome, '.gemini', 'antigravity-cli', 'conversations')
      mkdirSync(brain, { recursive: true })
      mkdirSync(convs, { recursive: true })
      writeFileSync(join(brain, 'state.json'), '{}')
      writeFileSync(join(convs, `${cid}.db`), 'db')
      const stream = [
        JSON.stringify({ event: 'init', conversation_id: cid, init: { model: ANTIGRAVITY_MODEL } }),
        JSON.stringify({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: `\`\`\`json\n${JSON.stringify(card('Flash title'))}\n\`\`\`\n` } })
      ].join('\n')
      return { stdout: stream, stderr: '', error: null }
    })
    assert.deepEqual(await providers.flash(request), card('Flash title'))
    assert.equal(existsSync(workDir), false, 'temporary workspace removed')
    assert.equal(existsSync(join(fakeHome, '.gemini', 'antigravity-cli', 'brain', cid)), false, 'ephemeral brain removed')
    assert.equal(existsSync(join(fakeHome, '.gemini', 'antigravity-cli', 'conversations', `${cid}.db`)), false, 'ephemeral db removed')
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('Antigravity adapter classifies auth/quota/model errors, rejects tool steps, and participates in writer chains and health', async () => {
  const cases: [string, string, { code?: unknown; killed?: boolean } | null, string][] = [
    ['', 'You are not logged into Antigravity.', { code: 1 }, 'auth'],
    [JSON.stringify({ event: 'result', result: { status: 'ERROR', error: '429 quota exceeded' } }), '', { code: 1 }, 'quota'],
    [JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'model gemini-3.8-flash-low is not recognized as a known model' } }), '', { code: 1 }, 'unavailable'],
    ['', '', { killed: true }, 'timeout'],
    [
      [
        JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'run_command' } }),
        JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(card()) } })
      ].join('\n'),
      '',
      null,
      'invalid-output'
    ]
  ]
  for (const [stdout, stderr, error, kind] of cases) {
    const providers = cliProviders(async () => ({ stdout, stderr, error }))
    await assert.rejects(providers.flash(request), (e) => e instanceof WriterError && e.kind === kind)
  }
  const calls: string[] = []
  let now = 5_000
  const writer = createWriter({
    now: () => now,
    writers: () => chainOf(['claude', 'haiku', true], ['antigravity', ANTIGRAVITY_MODEL, true]),
    haiku: named('haiku', calls, () => new WriterError('haiku', 'quota')),
    flash: named('flash', calls)
  })
  assert.equal((await writer(request) as any).title, 'flash')
  assert.deepEqual(calls, ['haiku', 'flash'])
  assert.equal(writer.health().find((h) => h.provider === 'antigravity')?.lastSuccessAt, 5_000)
})

test('the Antigravity adapter runs the model chosen in Settings; an unknown one runs the default', async () => {
  const cases: [string | undefined, string][] = [
    ['gemini-4-carbon-low', 'gemini-4-carbon-low'], ['gemini-4-neon-low', 'gemini-4-neon-low'], ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-low'],
    ['gemini-4-argon-low', 'gemini-4-argon-low'], ['gemini-3.8-flash-low', ANTIGRAVITY_MODEL], ['gemini-9-ultra', ANTIGRAVITY_MODEL], ['--yolo', ANTIGRAVITY_MODEL], [undefined, ANTIGRAVITY_MODEL]
  ]
  for (const [chosen, ran] of cases) {
    let args: string[] = []
    const providers = cliProviders(async (command) => {
      args = command.args
      return { stdout: JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(card('Flash title')) } }), stderr: '', error: null }
    })
    const writer = createWriter({ ...summaryProviders(providers), writers: () => chainOf(['antigravity', chosen, true]) })
    assert.deepEqual(await writer(request), card('Flash title'))
    assert.equal(args[args.indexOf('--model') + 1], ran, String(chosen))
    assert.equal(args.filter((a) => a === '--model').length, 1)
    assert.equal(args[args.indexOf('--agent') + 1], 'orca-flow-card-writer')
    assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).toolPermission, 'strict')
  }
  // A direct call (no Settings) and a forged request model both run a listed model only.
  const seen: string[] = []
  const providers = cliProviders(async (command) => {
    seen.push(command.args[command.args.indexOf('--model') + 1])
    return { stdout: JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(card()) } }), stderr: '', error: null }
  })
  await providers.flash(request)
  await providers.flash({ ...request, model: 'gemini-4-neon-low' })
  await providers.flash({ ...request, model: 'other-model' })
  assert.deepEqual(seen, [ANTIGRAVITY_MODEL, 'gemini-4-neon-low', ANTIGRAVITY_MODEL])
  // Other writers never receive a model.
  const got: (string | undefined)[] = []
  const writer = createWriter({ writers: () => chainOf(['claude', 'sonnet', true]), sonnet: async (r) => { got.push(r.model); return card() } })
  await writer(request)
  assert.deepEqual(got, [undefined])
})

test('a CLI resolves through the login shell once; noisy startup output is skipped; a failed lookup falls back', async () => {
  const calls: string[][] = []
  const resolve = cliResolver(async (file, args) => { calls.push([file, ...args]); return 'welcome back\n/Users/me/.nvm/bin/codex\n' }, '/bin/zsh', (p) => p.startsWith('/Users/me'))
  assert.equal(await resolve('codex'), '/Users/me/.nvm/bin/codex')
  assert.equal(await resolve('codex'), '/Users/me/.nvm/bin/codex')
  assert.deepEqual(calls, [['/bin/zsh', '-ilc', 'command -v codex']], 'asked once')
  // A path that does not exist, a shell that fails: today's fixed list (or the bare name).
  const bare = cliResolver(async () => { throw new Error('timeout') }, '/bin/zsh', () => false)
  assert.equal(await bare('nonexistent-cli'), 'nonexistent-cli')
  const missing = cliResolver(async () => '/gone/codex\n', '/bin/zsh', () => false)
  assert.equal(await missing('nonexistent-cli'), 'nonexistent-cli')
})

test('the interactive lookup takes the last valid path from noisy output; a failed one falls to the -lc result', async () => {
  const noisy = cliResolver(async () => 'Last login: today\n/not/real/codex\n/Users/me/.nvm/bin/codex\nnvm ready\n', '/bin/zsh', (p) => p.startsWith('/Users/me'))
  assert.equal(await noisy('codex'), '/Users/me/.nvm/bin/codex')
  const calls: string[] = []
  const fallback = cliResolver(async (_f, args) => { calls.push(args[0]); if (args[0] === '-ilc') throw new Error('timed out'); return '/opt/homebrew/bin/codex\n' }, '/bin/zsh', () => true)
  assert.equal(await fallback('codex'), '/opt/homebrew/bin/codex')
  assert.deepEqual(calls, ['-ilc', '-lc'])
})

/** A fake Claude profile whose settings.json holds fake values; never real credentials. */
const fakeProfile = (settings: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-flow-settings-'))
  if (settings !== null) writeFileSync(join(dir, 'settings.json'), settings)
  return dir
}
const withConfigDir = async (dir: string, body: () => Promise<void>) => {
  const old = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try { await body() } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old }
}

test('the Claude writer merges the settings env block into the child env and keeps its forced keys', async () => {
  const dir = fakeProfile(JSON.stringify({ hooks: { Stop: [] }, awsAuthRefresh: 'fake-login', env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'fake-profile', MAX_THINKING_TOKENS: '9999', CLAUDE_CONFIG_DIR: '/elsewhere', ORCA_CARD_CHILD: '0', ORCA_X: 'y', NUMERIC: 5 } }))
  const oldProfile = process.env.AWS_PROFILE
  process.env.AWS_PROFILE = 'process-profile'
  try {
    await withConfigDir(dir, async () => {
      let seen: Parameters<CommandRunner>[0] | undefined
      const providers = cliProviders(async (command) => { seen = command; return { stdout: JSON.stringify({ structured_output: card() }), stderr: '', error: null } })
      await providers.haiku(request)
      const env = seen!.env
      assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1')
      assert.equal(env.AWS_PROFILE, 'fake-profile', 'settings env wins, like Claude Code')
      assert.equal(env.MAX_THINKING_TOKENS, '0')
      assert.equal(env.ORCA_CARD_CHILD, '1')
      assert.notEqual(env.CLAUDE_CONFIG_DIR, '/elsewhere')
      assert.equal(env.ORCA_X, undefined)
      assert.equal(env.NUMERIC, undefined)
      assert.equal(env.hooks, undefined)
      assert.equal(seen!.args[seen!.args.indexOf('--setting-sources') + 1], '')
    })
  } finally {
    if (oldProfile === undefined) delete process.env.AWS_PROFILE; else process.env.AWS_PROFILE = oldProfile
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing or invalid settings file is tolerated', async () => {
  for (const settings of [null, 'not json', '[]', '{"env": 3}', '{"env": ["a"]}']) {
    const dir = fakeProfile(settings)
    try {
      await withConfigDir(dir, async () => {
        assert.deepEqual(claudeSettingsEnv(null), {})
        const providers = cliProviders(async () => ({ stdout: JSON.stringify({ structured_output: card() }), stderr: '', error: null }))
        assert.deepEqual(await providers.haiku(request), card())
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('Bedrock credential errors are auth failures, and the reason says what to do', async () => {
  for (const text of ['Could not load AWS credentials from any providers', 'ExpiredToken: The security token included in the request is expired', 'Error: SSO session associated with this profile has expired', 'Unable to locate credentials']) {
    const e = providerFailure('haiku', null, text)
    assert.equal(e.kind, 'auth', text)
    assert.equal(e.hint, 'aws', text)
    assert.equal(failureReason(e), 'AWS credentials expired — run aws sso login')
  }
  // awsAuthRefresh is never run by the writer: one invocation, no browser login.
  const dir = fakeProfile(JSON.stringify({ awsAuthRefresh: 'fake-login', env: { CLAUDE_CODE_USE_BEDROCK: '1' } }))
  try {
    await withConfigDir(dir, async () => {
      const calls: string[] = []
      const providers = cliProviders(async (command) => { calls.push(command.bin); return { stdout: JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }), stderr: '', error: null } })
      await assert.rejects(providers.haiku(request), (e) => e instanceof WriterError && e.kind === 'auth' && e.hint === 'aws')
      assert.equal(calls.length, 1)
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('not logged in with no settings env says the Bedrock settings were not found', async () => {
  const dir = fakeProfile(null)
  try {
    await withConfigDir(dir, async () => {
      const providers = cliProviders(async () => ({ stdout: JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }), stderr: '', error: null }))
      await assert.rejects(providers.haiku(request), (e) => e instanceof WriterError && failureReason(e) === 'Claude not logged in (Bedrock settings not found)')
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the last writer failure is kept with its reason and cleared by the next success', async () => {
  let fail = true
  let changes = 0
  let t = 0
  const writer = createWriter({ haiku: async () => { if (fail) throw new WriterError('haiku', 'auth', 'aws'); return card() }, now: () => t, onFailureChange: () => { changes++ } })
  assert.equal(writer.lastFailure(), null)
  await assert.rejects(writer(request))
  assert.equal(writer.lastFailure()?.provider, 'haiku')
  assert.equal(writer.lastFailure()?.reason, 'AWS credentials expired — run aws sso login')
  fail = false
  t += PRIMARY_COOLDOWN_MS + 1
  await writer(request)
  assert.equal(writer.lastFailure(), null)
  assert.equal(changes, 2)
})

test('a failed chain names the primary writer first, then each fallback, also while the primary cools down', async () => {
  let t = 0
  let fail = true
  const writer = createWriter({
    haiku: async () => { if (fail) throw new WriterError('haiku', 'auth'); return card() },
    luna: async () => { if (fail) throw new WriterError('luna', 'unavailable'); return card() },
    now: () => t
  })
  await assert.rejects(writer(request))
  const first = writer.lastFailure()!
  assert.equal(first.provider, 'haiku')
  assert.equal(first.reason, 'Claude (Haiku) not logged in; fallback Codex Luna unavailable')
  assert.ok(first.detail.startsWith('haiku: auth;') && first.detail.includes('\nluna: unavailable;'))
  // Inside the cooldown both are skipped; the stored primary reason still comes first.
  t += 1000
  await assert.rejects(writer(request))
  assert.equal(writer.lastFailure()?.reason, 'Claude (Haiku) not logged in; fallback Codex Luna unavailable')
  // The same writer (no restart) clears the notice on its next success, from either writer.
  fail = false
  t += PRIMARY_COOLDOWN_MS + 1
  await writer(request)
  assert.equal(writer.lastFailure(), null)
})

test('a Bedrock primary failure is named even when the fallback fails differently', async () => {
  const writer = createWriter({
    haiku: async () => { throw new WriterError('haiku', 'auth', 'aws') },
    luna: async () => { throw new WriterError('luna', 'quota') },
    now: () => 0
  })
  await assert.rejects(writer(request))
  assert.equal(writer.lastFailure()?.reason, 'AWS credentials expired — run aws sso login; fallback Codex Luna usage limit reached')
})
