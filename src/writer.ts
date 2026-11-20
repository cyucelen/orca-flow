// Small, isolated text requests through the user's existing Claude, Codex, or Antigravity (Google sign-in) CLI logins.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

// Verified against Codex 0.167.0 models_cache.json and the official GPT-6 Luna model page.
export const LUNA_MODEL = 'gpt-6-luna'
// Fast default for Antigravity (Google sign-in); supports new Gemini 4 models (Carbon, Neon, Hydrogen, Argon) too.
export const GEMINI_WRITER_MODEL = 'gemini-3.8-flash-low'
export const GEMINI_MODEL_ALIASES: Record<string, string> = {
  flash: 'gemini-3.8-flash-low',
  'gemini-3.8-flash': 'gemini-3.8-flash-low',
  carbon: 'gemini-4-carbon-low',
  'gemini-4-carbon': 'gemini-4-carbon-low',
  neon: 'gemini-4-neon-low',
  'gemini-4-neon': 'gemini-4-neon-low',
  hydrogen: 'gemini-4-hydrogen-low',
  'gemini-4-hydrogen': 'gemini-4-hydrogen-low',
  argon: 'gemini-4-argon-low',
  'gemini-4-argon': 'gemini-4-argon-low'
}
export const DEFAULT_GEMINI_MODELS: { id: string; label: string }[] = [
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)' },
  { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)' },
  { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
  { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' }
]
export const WRITER_TIMEOUT_MS = 30_000
export const PRIMARY_COOLDOWN_MS = 5 * 60_000
const TRANSIENT_COOLDOWN_MS = 30_000
const ORCA_DATA = join(homedir(), 'Library', 'Application Support', 'orca')
const FLOW_DATA = join(homedir(), '.orca-flow')
export type WriterProvider = 'haiku' | 'luna' | 'antigravity'
type Provider = WriterProvider
type Failure = 'quota' | 'auth' | 'unavailable' | 'timeout' | 'transient' | 'invalid-output' | 'unexpected'

const PROVIDER_LABEL: Record<Provider, string> = {
  haiku: 'Haiku',
  luna: 'Codex Luna',
  antigravity: 'Antigravity Gemini'
}

export class WriterError extends Error {
  readonly provider: Provider
  readonly kind: Failure
  constructor(provider: Provider, kind: Failure) {
    const action = kind === 'auth' ? 'check the provider login in Orca' : kind === 'quota' ? 'check provider usage limits' : kind === 'unavailable' ? 'check the CLI installation and selected account' : kind === 'invalid-output' ? 'the provider returned an invalid card' : kind === 'unexpected' ? 'check the writer integration' : 'a later request will retry'
    super(`${provider}: ${kind}; ${action}`)
    this.provider = provider
    this.kind = kind
  }
}

/** Normalize a configured Gemini model name or short alias (carbon, neon, hydrogen, argon, flash). */
export function normalizeGeminiModel(model?: string | null): string {
  const raw = model?.trim()
  if (!raw) return GEMINI_WRITER_MODEL
  const alias = GEMINI_MODEL_ALIASES[raw.toLowerCase()]
  if (alias) return alias
  return /^[A-Za-z0-9._-]+$/.test(raw) ? raw : GEMINI_WRITER_MODEL
}

function isGeminiModelHint(model?: string | null): boolean {
  const raw = model?.trim().toLowerCase()
  if (!raw) return false
  return raw.startsWith('gemini-') || Object.hasOwn(GEMINI_MODEL_ALIASES, raw)
}

/** Read writer/agent preferences from ~/.orca-flow/config.json; missing or broken config returns defaults. */
export function readWriterConfig(dir = FLOW_DATA): { provider: 'auto' | Provider; model?: string; defaultAgent: string } {
  try {
    const c = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    const rawProvider = typeof c?.writerProvider === 'string' ? c.writerProvider.trim().toLowerCase() : ''
    const provider: 'auto' | Provider = rawProvider === 'gemini' || rawProvider === 'agy' || rawProvider === 'antigravity' ? 'antigravity'
      : rawProvider === 'haiku' || rawProvider === 'claude' ? 'haiku'
      : rawProvider === 'luna' || rawProvider === 'codex' ? 'luna'
      : 'auto'
    const model = typeof c?.writerModel === 'string' && c.writerModel.trim() ? c.writerModel.trim() : undefined
    const rawAgent = typeof c?.defaultAgent === 'string' ? c.defaultAgent.trim().toLowerCase() : ''
    const defaultAgent = ['antigravity', 'claude', 'codex', 'gemini'].includes(rawAgent) ? rawAgent : rawAgent === 'agy' ? 'antigravity' : 'claude'
    return { provider, ...(model ? { model } : {}), defaultAgent }
  } catch {
    return { provider: 'auto', defaultAgent: 'claude' }
  }
}

/** Ordered provider chain from config.json. Explicit Gemini model implies Antigravity primary unless overridden. */
export function writerOrderFromConfig(dir = FLOW_DATA): Provider[] {
  const { provider, model } = readWriterConfig(dir)
  if (provider === 'antigravity' || (provider === 'auto' && isGeminiModelHint(model))) return ['antigravity', 'haiku', 'luna']
  if (provider === 'luna') return ['luna', 'haiku', 'antigravity']
  return ['haiku', 'luna', 'antigravity']
}

export function writerModelFromConfig(dir = FLOW_DATA): string {
  return normalizeGeminiModel(readWriterConfig(dir).model)
}

export function defaultAgentFromConfig(dir = FLOW_DATA): string {
  return readWriterConfig(dir).defaultAgent
}

/** Read available Antigravity / Gemini models from Orca's local model catalog, merged with built-in Gemini 4 models. */
export function discoverAntigravityModels(catalogPath = join(ORCA_DATA, 'agent-model-catalog.db')): { id: string; label: string }[] {
  const out = new Map<string, { id: string; label: string }>()
  const add = (id: string, label: string) => {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || out.has(id)) return
    out.set(id, { id, label })
  }
  try {
    const sqlite = process.getBuiltinModule?.('node:sqlite')
    if (sqlite && existsSync(catalogPath)) {
      const db = new sqlite.DatabaseSync(catalogPath, { readOnly: true, timeout: 1000 })
      try {
        const rows = db.prepare(`SELECT key, value FROM rows ORDER BY seq DESC`).all() as { key: string; value: string }[]
        for (const row of rows) {
          const parsed = JSON.parse(row.value)
          if (parsed?.agent !== 'antigravity' && !(typeof row.key === 'string' && row.key.startsWith('antigravity\0'))) continue
          const lists = [parsed?.live?.models, parsed?.discovered?.models].filter(Array.isArray)
          for (const models of lists) {
            for (const m of models) {
              const baseId = typeof m?.id === 'string' ? m.id.trim() : ''
              if (!baseId || !baseId.startsWith('gemini-')) continue
              const baseLabel = typeof m?.label === 'string' && m.label.trim() ? m.label.trim() : baseId
              const efforts = Array.isArray(m?.efforts) ? m.efforts : []
              if (efforts.length) {
                for (const e of efforts) {
                  if (typeof e?.value !== 'string' || !e.value) continue
                  const eLabel = typeof e?.label === 'string' && e.label.trim() ? e.label.trim() : e.value
                  add(`${baseId}-${e.value}`, `${baseLabel} (${eLabel})`)
                }
              } else {
                add(baseId, baseLabel)
              }
            }
          }
        }
      } finally {
        db.close()
      }
    }
  } catch {
    // Fall back to curated Gemini defaults when Orca's model catalog is absent or unreadable.
  }
  for (const m of DEFAULT_GEMINI_MODELS) add(m.id, m.label)
  return [...out.values()]
}

/** Whether Orca reports an active Google / Antigravity sign-in (managed account or consumer agy login). */
export function antigravityAccountReady(result: any): boolean {
  if (result?.ok !== true || !result.result) return false
  const r = result.result
  if (typeof r.activeAccountId === 'string' && r.activeAccountId) return true
  if (typeof r.selectedAccountId === 'string' && r.selectedAccountId) return true
  if (r.currentAccount && (r.currentAccount.authMethod || r.currentAccount.email || r.currentAccount.subject)) return true
  return r.chatUsesAgy === true
}

/** Classify only at the process/provider boundary. Never retain raw output in an error/log. */
export function providerFailure(provider: Provider, error: { code?: unknown; killed?: boolean } | null, output = ''): WriterError {
  const code = error?.code
  const kind: Failure = error?.killed || code === 'ETIMEDOUT' || /\b(timeout_error|deadline[_ ]exceeded)\b|(?:request|connection) timed out/i.test(output) ? 'timeout'
    : ['ENOENT', 'EACCES', 'ENOEXEC'].includes(String(code)) ? 'unavailable'
    : /\b(429|rate[_ -]?limit(?:_error)?|quota|usage limits?|credit balance|insufficient[_ ]quota|resource[_ ]exhausted)\b|you(?:'|’)ve hit your limit|out of (?:extra )?usage/i.test(output) ? 'quota'
    : /\b(401|403|unauthorized|unauthenticated|authentication[_ ]error|invalid[_ ]api[_ ]key|invalid[_ ]grant)\b|not (?:logged|signed) in|please (?:log|sign) in|sign in with google|google sign[- ]?in|login required|token (?:has )?expired|failed to refresh.*token|authentication (?:failed|required)|failed to authenticate|(?:oauth )?token (?:revoked|expired)/i.test(output) ? 'auth'
    : /(?:unknown|unsupported) model|model[^\n]{0,100}(?:not found|not available|not supported|does not exist|invalid)|provider[^\n]{0,60}unavailable/i.test(output) ? 'unavailable'
    : ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(String(code)) || /\b(500|502|503|504|529|overloaded_error)\b|service unavailable|connection (?:reset|refused)|error sending request|temporarily unavailable/i.test(output) ? 'transient'
    : 'unexpected'
  return new WriterError(provider, kind)
}

export function writerDiagnostic(error: unknown): string {
  return error instanceof WriterError ? error.message : 'writer failed unexpectedly; check the writer integration (existing card preserved)'
}

export type WriterRequest = { prompt: string; system: string; schema: object }
export type Writer = (request: WriterRequest) => Promise<unknown>

/** One primary probe at a time; queued work skips failed providers until their bounded cooldown. */
export function createWriter(options: {
  haiku: Writer
  luna: Writer
  antigravity?: Writer
  order?: Provider[] | (() => Provider[])
  now?: () => number
  log?: (message: string) => void
}): Writer {
  const now = options.now ?? Date.now
  const writers: Partial<Record<Provider, Writer>> = {
    haiku: options.haiku,
    luna: options.luna,
    ...(options.antigravity ? { antigravity: options.antigravity } : {})
  }
  const blocked: Record<Provider, number> = { haiku: 0, luna: 0, antigravity: 0 }
  const lastError: Partial<Record<Provider, WriterError>> = {}
  let primaryProbe: Promise<void> | undefined
  const noticeAt = new Map<string, number>()
  const note = (message: string) => {
    if ((noticeAt.get(message) ?? -Infinity) + PRIMARY_COOLDOWN_MS > now()) return
    noticeAt.set(message, now())
    options.log?.(message)
  }
  const chainOf = (): Provider[] => {
    const requested = typeof options.order === 'function' ? options.order() : options.order
    const base: Provider[] = requested?.length ? requested : ['haiku', 'luna', ...(options.antigravity ? ['antigravity' as const] : [])]
    const seen = new Set<Provider>()
    return base.filter((p) => {
      if (!writers[p] || seen.has(p)) return false
      seen.add(p)
      return true
    })
  }
  const failed = (provider: Provider, error: unknown, next?: Provider) => {
    if (!(error instanceof WriterError) || ['invalid-output', 'unexpected'].includes(error.kind)) throw error
    lastError[provider] = error
    blocked[provider] = now() + (['timeout', 'transient'].includes(error.kind) ? TRANSIENT_COOLDOWN_MS : PRIMARY_COOLDOWN_MS)
    note(`${writerDiagnostic(error)}; ${next ? `trying ${PROVIDER_LABEL[next]} during cooldown` : 'existing card preserved during cooldown'}`)
  }
  return async (request) => {
    const chain = chainOf()
    const [primary, ...fallbacks] = chain
    while (primaryProbe) await primaryProbe
    if (now() >= blocked[primary]) {
      let release!: () => void
      primaryProbe = new Promise<void>((resolve) => { release = resolve })
      try {
        const output = await writers[primary]!(request)
        if (blocked[primary]) note(`${PROVIDER_LABEL[primary]} recovered; primary writer restored`)
        blocked[primary] = 0
        lastError[primary] = undefined
        return output
      } catch (error) {
        failed(primary, error, fallbacks[0])
        if (!fallbacks.length) throw error
      } finally {
        primaryProbe = undefined
        release()
      }
    }
    let lastFailure: WriterError | undefined = lastError[primary]
    for (let i = 0; i < fallbacks.length; i++) {
      const provider = fallbacks[i]
      const next = fallbacks[i + 1]
      if (now() < blocked[provider]) {
        lastFailure = lastError[provider] ?? lastFailure
        continue
      }
      try {
        const output = await writers[provider]!(request)
        blocked[provider] = 0
        lastError[provider] = undefined
        return output
      } catch (error) {
        failed(provider, error, next)
        lastFailure = error instanceof WriterError ? error : lastFailure
        if (!next) throw error
      }
    }
    throw lastFailure ?? new WriterError(chain.at(-1) ?? primary, 'unavailable')
  }
}

function binary(name: string): string {
  return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, join(homedir(), '.local', 'bin', name), ...(name === 'claude' ? [join(homedir(), '.claude', 'local', name)] : [])].find(existsSync) ?? name
}

/** The selected Claude profile is also used when installing Orca Flow's hooks. */
export function claudeConfigDir(): string | null {
  try {
    const config = readFileSync(join(ORCA_DATA, 'claude-profiles', 'selected-host'), 'utf8').trim()
    return config && existsSync(config) ? config : null
  } catch { return null }
}

export function writerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !key.startsWith('ORCA_') && key !== 'CLAUDECODE') env[key] = value
  }
  env.HOME ??= homedir()
  env.USER ??= userInfo().username
  env.ORCA_CARD_CHILD = '1'
  return env
}

type Command = { bin: string; args: string[]; env: Record<string, string>; cwd: string; input: string }
export type CommandRunner = (command: Command) => Promise<{ stdout: string; stderr: string; error: { code?: unknown; killed?: boolean } | null }>
export const runWriterCommand = (command: Command, timeoutMs = WRITER_TIMEOUT_MS): ReturnType<CommandRunner> => new Promise((resolve) => {
  // Kill the whole process group: npm's Codex launcher starts a native child of its own.
  const child = spawn(command.bin, command.args, { env: command.env, cwd: command.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', done = false
  const finish = (error: { code?: unknown; killed?: boolean } | null) => {
    if (done) return
    done = true
    clearTimeout(timer)
    resolve({ error, stdout, stderr })
  }
  const stop = () => {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
  const timer = setTimeout(() => { stop(); finish({ killed: true }) }, timeoutMs)
  const collect = (stream: 'stdout' | 'stderr', text: string) => {
    if (done) return
    if (stream === 'stdout') stdout += text
    else stderr += text
    if (stdout.length + stderr.length > 1024 * 1024) { stop(); finish({ code: 'OUTPUT_TOO_LARGE' }) }
  }
  child.stdout.setEncoding('utf8').on('data', (text: string) => collect('stdout', text))
  child.stderr.setEncoding('utf8').on('data', (text: string) => collect('stderr', text))
  child.on('error', (error: { code?: unknown }) => finish(error))
  child.on('close', (code: number | null) => finish(code === 0 ? null : { code }))
  child.stdin.on('error', () => {})
  child.stdin.end(command.input)
})

/** Resolve via Orca's account API; never guess an account or read/copy its credentials. */
export function codexHomeFromAccounts(result: any, data = ORCA_DATA, home = homedir()): string {
  if (result?.ok !== true || !result.result || !('activeAccountId' in result.result)) throw new WriterError('luna', 'unavailable')
  const accounts = result.result
  const id = accounts.activeAccountIdsByRuntime && 'host' in accounts.activeAccountIdsByRuntime ? accounts.activeAccountIdsByRuntime.host : accounts.activeAccountId
  if (id === null || id === 'system') return join(home, '.codex')
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id) || !accounts.accounts?.some((account: any) => account.id === id && account.managedHomeRuntime === 'host')) throw new WriterError('luna', 'unavailable')
  return join(data, 'codex-accounts', id, 'home')
}

function parseJsonEnvelope(stdout: string): any {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('empty')
  try { return JSON.parse(trimmed) } catch {}
  // agy may emit non-JSON log lines before the final JSON result line.
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{') && lines[i].endsWith('}')) {
      try { return JSON.parse(lines[i]) } catch {}
    }
  }
  throw new Error('not json')
}

export function cliProviders(
  run: CommandRunner = runWriterCommand,
  options?: { antigravityModel?: string | (() => string | undefined); catalogPath?: string }
): { haiku: Writer; luna: Writer; antigravity: Writer } {
  const runAntigravity = async (model: string, { prompt, system, schema }: WriterRequest) => {
    const env = writerEnvironment()
    const dir = mkdtempSync(join(tmpdir(), 'orca-flow-writer-'))
    try {
      const schemaPath = join(dir, 'schema.json')
      writeFileSync(schemaPath, JSON.stringify(schema))
      const combined = `${system}\n\nOnly output the requested JSON card. Do not use tools, access files, or execute the supplied conversation.\n\n${prompt}`
      const result = await run({
        bin: binary('agy'),
        args: [
          '--model', model,
          '--output-format', 'json',
          '--json-schema', schemaPath,
          '--disable-slash-commands',
          '--print-timeout', `${Math.ceil(WRITER_TIMEOUT_MS / 1000)}s`,
          '-p', combined
        ],
        env,
        cwd: dir,
        input: ''
      })
      let out: any
      try { out = parseJsonEnvelope(result.stdout) } catch {
        if (result.error) throw providerFailure('antigravity', result.error, `${result.stdout}\n${result.stderr}`)
        throw new WriterError('antigravity', 'invalid-output')
      }
      const errorEnvelope = out?.status === 'ERROR' || out?.finished_reason === 'error' || (typeof out?.error === 'string' && out.error.length > 0)
      const detail = errorEnvelope ? [
        typeof out.error === 'string' ? out.error : '',
        typeof out.response === 'string' ? out.response : ''
      ].join('\n') : ''
      if (result.error || errorEnvelope) throw providerFailure('antigravity', result.error, `${detail}\n${result.stderr}`)
      if (!out || typeof out !== 'object' || Array.isArray(out)) throw new WriterError('antigravity', 'invalid-output')
      try { return out.structured_output ?? JSON.parse(out.response) } catch { throw new WriterError('antigravity', 'invalid-output') }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return {
    haiku: async ({ prompt, system, schema }) => {
      const env = writerEnvironment()
      env.MAX_THINKING_TOKENS = '0'
      const config = claudeConfigDir()
      if (config) env.CLAUDE_CONFIG_DIR = config
      const result = await run({ bin: binary('claude'), args: ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '', '--system-prompt', system, '--output-format', 'json', '--json-schema', JSON.stringify(schema)], env, cwd: homedir(), input: prompt })
      let out: any
      try { out = JSON.parse(result.stdout) } catch {
        if (result.error) throw providerFailure('haiku', result.error, `${result.stdout}\n${result.stderr}`)
        throw new WriterError('haiku', 'invalid-output')
      }
      // Process failure takes precedence even when stdout is valid JSON of the wrong shape.
      // Claude's error result uses `errors: string[]`; API errors use `error: {type, message}`.
      const errorEnvelope = out?.is_error === true || out?.type === 'error' || (typeof out?.subtype === 'string' && out.subtype.startsWith('error_'))
      const detail = errorEnvelope ? [
        typeof out.result === 'string' ? out.result : '',
        typeof out.api_error_status === 'number' ? String(out.api_error_status) : '',
        ...(Array.isArray(out.errors) ? out.errors.filter((e: unknown) => typeof e === 'string') : []),
        typeof out.error?.type === 'string' ? out.error.type : '',
        typeof out.error?.message === 'string' ? out.error.message : ''
      ].join('\n') : ''
      if (result.error || errorEnvelope) throw providerFailure('haiku', result.error, `${detail}\n${result.stderr}`)
      if (!out || typeof out !== 'object' || Array.isArray(out)) throw new WriterError('haiku', 'invalid-output')
      try { return out.structured_output ?? JSON.parse(out.result) } catch { throw new WriterError('haiku', 'invalid-output') }
    },
    luna: async ({ prompt, system, schema }) => {
      const env = writerEnvironment()
      // The plugin process normally has no CODEX_HOME. Explicit caller configuration wins.
      if (!env.CODEX_HOME) {
        const account = await run({ bin: existsSync('/Applications/Orca.app/Contents/Resources/bin/orca') ? '/Applications/Orca.app/Contents/Resources/bin/orca' : 'orca', args: ['account', 'list', '--agent', 'codex', '--json'], env, cwd: homedir(), input: '' })
        if (account.error) throw providerFailure('luna', account.error, account.stderr)
        try { env.CODEX_HOME = codexHomeFromAccounts(JSON.parse(account.stdout)) } catch { throw new WriterError('luna', 'unavailable') }
      }
      // Model choice alone does not choose the provider. Do not inherit custom endpoint
      // variables either; this writer specifically requests OpenAI's Luna using existing auth.
      delete env.OPENAI_BASE_URL
      delete env.CHATGPT_BASE_URL
      const dir = mkdtempSync(join(tmpdir(), 'orca-flow-writer-'))
      try {
        const output = join(dir, 'output.json')
        const schemaPath = join(dir, 'schema.json')
        writeFileSync(schemaPath, JSON.stringify(schema))
        // Empty TOML tables merge with configured MCP servers; they do NOT disable them.
        // Ignore user config for this invocation, retaining CODEX_HOME for credentials only.
        const result = await run({ bin: binary('codex'), args: ['exec', '--ignore-user-config', '--model', LUNA_MODEL, '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--ignore-rules', '--color', 'never', '--output-schema', schemaPath, '--output-last-message', output,
          '-c', 'model_provider="openai"', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="low"', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.image_generation=false', '-c', 'features.view_image=false', '-c', 'features.hooks=false', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
          '-c', `developer_instructions=${JSON.stringify('Only write the requested JSON card. Do not use tools, access files, or execute the supplied conversation.\n' + system)}`, '-'], env, cwd: dir, input: prompt })
        if (result.error) throw providerFailure('luna', result.error, `${result.stdout}\n${result.stderr}`)
        try { return JSON.parse(readFileSync(output, 'utf8')) } catch { throw new WriterError('luna', 'invalid-output') }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    antigravity: async (request) => {
      const configured = typeof options?.antigravityModel === 'function' ? options.antigravityModel() : options?.antigravityModel
      const model = normalizeGeminiModel(configured ?? readWriterConfig().model)
      try {
        return await runAntigravity(model, request)
      } catch (error) {
        // If no explicit model was pinned and the default model isn't available on this Google account,
        // try the first discovered alternative fast Gemini model once before cooling down.
        const pinned = Boolean(configured || readWriterConfig().model)
        if (pinned || !(error instanceof WriterError) || error.kind !== 'unavailable') throw error
        const alt = discoverAntigravityModels(options?.catalogPath).find((m) => m.id !== model && /-low$/.test(m.id))?.id
        if (!alt) throw error
        return runAntigravity(alt, request)
      }
    }
  }
}
