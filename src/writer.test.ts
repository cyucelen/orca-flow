import { assert, test } from 'orca/testing'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliProviders, codexHomeFromAccounts, createWriter, LUNA_MODEL, PRIMARY_COOLDOWN_MS, providerFailure, runWriterCommand, WriterError, writerDiagnostic, type CommandRunner } from './writer.ts'
import { SUMMARY_SCHEMA, summarizePane, summaryProviders, turnSummarizer, validateSummary } from './summarize.ts'

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
    [null, 'unknown option --bad-flag', 'unexpected']
  ]
  for (const [error, output, kind] of cases) {
    const result = providerFailure('haiku', error, output)
    assert.equal(result.kind, kind)
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
