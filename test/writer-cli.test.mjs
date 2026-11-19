// Opt-in installed-CLI contract check. No real provider/MCP traffic, credentials or model usage.
// ORCA_FLOW_CODEX_VERIFY=1 node --test test/writer-cli.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliProviders, runWriterCommand, LUNA_MODEL, WriterError } from '../src/writer.ts'
import { SUMMARY_SCHEMA } from '../src/summarize.ts'

function toolNames(body) {
  const names = []
  const visit = (tool) => {
    if (typeof tool.name === 'string') names.push(tool.name)
    // Code-mode tools can be described as nested declarations, not just JSON function names.
    for (const match of (tool.description ?? '').matchAll(/declare const tools: \{ ([\w$]+)\(/g)) names.push(match[1])
    for (const child of tool.tools ?? []) visit(child)
  }
  for (const tool of body.tools ?? []) visit(tool)
  for (const input of body.input ?? []) if (input.type === 'additional_tools') visit(input)
  return names
}

const enabled = process.env.ORCA_FLOW_CODEX_VERIFY === '1'
const card = { title: 'Synthetic checkout', about: 'A synthetic fixture.', goal: '', since: 'Verified.', needs: { type: 'none', ask: '', options: [] }, glance: '', watching: '', effort: 'quick', priority: 'P2' }

test('installed Codex isolates writer config and sends only the exact requested model', { skip: !enabled, timeout: 90_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'writer-cli-contract-'))
  const mcpMarker = join(home, 'mcp-started'), hookMarker = join(home, 'hook-started')
  const requests = []
  let rejectModel = false
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    // The fake API-key account uses uncompressed HTTP/SSE, just like the local positive control.
    assert.equal(req.headers['content-encoding'], undefined)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ path: req.url, body })
    if (rejectModel) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'model_not_found', message: `model ${LUNA_MODEL} is not supported` } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(card) }] }
    for (const [type, payload] of [
      ['response.created', { response: { id: 'resp_synthetic' } }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response: { id: 'resp_synthetic', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]
    ]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
    res.end()
  })
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const config = `model = "wrong-model"\nmodel_provider = "synthetic"\nweb_search = "live"\n[model_providers.synthetic]\nname = "Synthetic"\nbase_url = "${endpoint}/inherited"\nwire_api = "responses"\n[mcp_servers.harmless]\ncommand = "/usr/bin/touch"\nargs = [${JSON.stringify(mcpMarker)}]\n[features]\nshell_tool = true\napps = true\nhooks = true\nplugins = true\n`
  writeFileSync(join(home, 'config.toml'), config)
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-not-a-secret' }))
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `/usr/bin/touch '${hookMarker}'` }] }] } }))
  const env = { HOME: home, CODEX_HOME: home, PATH: process.env.PATH }
  const oldHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  try {
    const version = await runWriterCommand({ bin: 'codex', args: ['--version'], env, cwd: home, input: '' })
    assert.equal(version.error, null)
    t.diagnostic(version.stdout.trim())
    // This read-only command establishes the merge trap without launching a server.
    const merged = await runWriterCommand({ bin: 'codex', args: ['mcp', 'list', '--json', '-c', 'mcp_servers={}'], env, cwd: home, input: '' })
    assert.equal(merged.error, null)
    assert.equal(JSON.parse(merged.stdout).find((s) => s.name === 'harmless')?.enabled, true)
    assert.equal(existsSync(mcpMarker), false)

    // Positive control: a harmless launcher/hook runs, custom provider receives the exact model,
    // and shell declarations really are present (including newer additional_tools inputs).
    const positive = await runWriterCommand({ bin: 'codex', args: ['exec', '--ephemeral', '--skip-git-repo-check', '--model', LUNA_MODEL, '--sandbox', 'read-only', '--dangerously-bypass-hook-trust', '-c', 'features.apps=false', '-'], env, cwd: home, input: 'Synthetic fixture only; return JSON.' })
    assert.equal(positive.error, null, positive.stderr)
    assert.equal(existsSync(mcpMarker), true)
    assert.equal(existsSync(hookMarker), true)
    assert.equal(requests.at(-1).path, '/inherited/responses')
    assert.ok(toolNames(requests.at(-1).body).some((name) => /exec_command|shell_command/.test(name)))
    rmSync(mcpMarker); rmSync(hookMarker); requests.length = 0

    let checkedFeatures = false
    const providers = cliProviders(async (command) => {
      assert.ok(command.args.includes('--ignore-user-config'))
      if (!checkedFeatures) {
        checkedFeatures = true
        const overrides = command.args.flatMap((arg, index) => arg === '-c' && command.args[index + 1]?.startsWith('features.') ? ['-c', command.args[index + 1]] : [])
        const features = await runWriterCommand({ bin: command.bin, args: ['features', 'list', ...overrides], env, cwd: home, input: '' })
        assert.equal(features.error, null)
        for (const name of ['shell_tool', 'apps', 'hooks', 'plugins', 'image_generation', 'view_image']) {
          assert.ok(new RegExp(`^${name}\\s+.*\\sfalse$`, 'm').test(features.stdout), `${name} is effectively disabled`)
        }
      }
      // Only the test endpoint and hook trust are overridden. Production args come from the
      // real adapter; credentials/env are replaced with this wholly synthetic account.
      const args = [...command.args.slice(0, -1), '-c', `openai_base_url=${JSON.stringify(endpoint + '/openai')}`, '--dangerously-bypass-hook-trust', '-']
      const result = await runWriterCommand({ ...command, args, env })
      return result
    })
    const request = { prompt: 'Synthetic fixture only; return JSON.', system: 'Write a synthetic card.', schema: SUMMARY_SCHEMA }
    assert.deepEqual(await providers.luna(request), card)
    assert.equal(existsSync(mcpMarker), false)
    assert.equal(existsSync(hookMarker), false, 'hooks are disabled even when trusted')
    assert.ok(requests.length > 0)
    for (const { path, body } of requests) {
      assert.equal(path, '/openai/responses')
      assert.equal(body.model, LUNA_MODEL)
      // Codex can carry tools as top-level tools OR additional_tools input messages, with
      // deferred declarations inside the functions.exec description. Inspect all of them.
      const names = toolNames(body)
      assert.deepEqual(names.filter((name) => /^(exec_command|shell_command|write_stdin|web|web__run|web_search|imagegen|image_gen__imagegen|view_image)$|^mcp__/.test(name)), [])
    }
    t.diagnostic('MCP merge reproduced; provider pinned; no shell/web/MCP/app/image declarations; no hook or MCP launch')
    requests.length = 0
    rejectModel = true
    await assert.rejects(providers.luna(request), (e) => e instanceof WriterError && e.kind === 'unavailable')
    assert.ok(requests.length > 0)
    assert.deepEqual([...new Set(requests.map((r) => r.body.model))], [LUNA_MODEL], 'no silent substitute after model rejection')
    assert.ok(requests.every((r) => r.path === '/openai/responses'))
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), config)
    t.diagnostic('Rejected Luna fails closed; every attempted request remains gpt-6-luna; original config unchanged')
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  }
})
