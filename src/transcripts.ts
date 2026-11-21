// Read-only adapters for Orca's exact pane bindings and structured chat journal.
// No account search, cwd matching, newest-file selection, or provider session mutation.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ProviderSession = { provider: 'claude' | 'codex' | 'antigravity'; id: string }
const TRANSCRIPT_PROVIDERS = new Set(['claude', 'codex', 'antigravity'])
export type TranscriptIdentity = { orcaSession?: string | null; provider?: string | null; sessionId?: string }
export type TranscriptFiles = { db: string; json: string; journal?: string; identities?: string; antigravityHome?: string }
export type TranscriptSource = {
  kind: 'jsonl' | 'journal'
  path: string
  orcaSession?: string
  providerSession?: ProviderSession
  epoch?: string
  /** Recheck a terminal's binding before publishing an asynchronous result. */
  binding?: { pane: string; files: TranscriptFiles }
}
export type FoundTranscript = { path: string; source?: TranscriptSource } | { path: null; why: string }
const root = join(homedir(), 'Library', 'Application Support', 'orca')
export const transcriptFiles: TranscriptFiles = {
  db: join(root, 'agent-hooks', 'last-status.db'),
  json: join(root, 'agent-hooks', 'last-status.json'),
  journal: join(root, 'agent-session-domain.db'),
  identities: join(root, 'agent-hooks', 'agent-identities.db'),
  antigravityHome: process.env.ANTIGRAVITY_HOME || join(homedir(), '.gemini', 'antigravity-cli')
}

function database(path: string) {
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  if (!sqlite) throw new Error('Transcript reading needs node:sqlite')
  return new sqlite.DatabaseSync(path, { readOnly: true, timeout: 1000 })
}

function hookEntry(pane: string, files: TranscriptFiles): any {
  if (existsSync(files.db)) {
    const db = database(files.db)
    try {
      const rows = db.prepare(`SELECT value FROM rows WHERE key = ? OR (substr(key, 1, 5) = 'entry' AND instr(value, ?) > 0) ORDER BY seq DESC`)
        .all(`entry\0${pane}`, JSON.stringify(pane)) as { value: string }[]
      for (const row of rows) {
        const entry = JSON.parse(row.value)
        if (entry?.paneKey === pane) return entry
      }
    } finally { db.close() }
  }
  return existsSync(files.json) ? JSON.parse(readFileSync(files.json, 'utf8'))?.entries?.[pane] : null
}

/** Deterministic Antigravity CLI transcript path for a verified conversation id.
 * Prefer `transcript_full.jsonl`: compact `transcript.jsonl` truncates `content` at ~4 KB, which
 * chops off Orca's `=== TASK ===` worker brief and framed asks at the end of long assistant replies.
 */
function antigravityTranscriptPath(id: string, files: TranscriptFiles): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) return null
  const logs = join(files.antigravityHome ?? join(homedir(), '.gemini', 'antigravity-cli'), 'brain', id, '.system_generated', 'logs')
  const full = join(logs, 'transcript_full.jsonl')
  return existsSync(full) ? full : join(logs, 'transcript.jsonl')
}

function entryTranscriptPath(entry: any, files: TranscriptFiles): string | null {
  const explicit = entry?.providerSession?.transcriptPath ?? entry?.transcriptPath
  if (typeof explicit === 'string' && explicit) return explicit
  if (entry?.payload?.agentType === 'antigravity' && typeof entry?.providerSession?.id === 'string' && entry.providerSession.id) {
    return antigravityTranscriptPath(entry.providerSession.id, files)
  }
  return null
}

/** Orca's terminal identity authority, not a claim inferred from the pane or hook's native ID.
 * agent-identity-worker-entry.js uses this exact five-part provider link key. Claude, Codex and
 * Antigravity resume by ID (empty locator); remote/WSL namespaces are deliberately not searched here.
 * Read on discovery AND publication, including for sources saved before this check existed.
 */
function terminalIdentityMatches(entry: any, files: TranscriptFiles, orcaSession: string): boolean {
  if (entry?.connectionId || (entry?.orcaSessionId && entry.orcaSessionId !== orcaSession)) return false
  const provider = entry?.payload?.agentType, nativeId = entry?.providerSession?.id
  if (!TRANSCRIPT_PROVIDERS.has(provider) || typeof nativeId !== 'string' || !nativeId) return false
  // Older saved sources only carried the hook DB path; Orca puts its identity DB beside it.
  const path = files.identities ?? join(files.db, '..', 'agent-identities.db')
  if (!existsSync(path)) return false
  const db = database(path)
  try {
    const rows = db.prepare(`SELECT p.orca_session_id, i.agent FROM provider_links p
      LEFT JOIN identities i ON i.orca_session_id = p.orca_session_id
      WHERE p.execution_host = 'local' AND p.wsl_distro = '' AND p.agent = ?
        AND p.provider_session_id = ? AND p.locator = ''`).all(provider, nativeId) as { orca_session_id: string; agent: string | null }[]
    return rows.length === 1 && rows[0].orca_session_id === orcaSession && rows[0].agent === provider
  } finally { db.close() }
}

function nativeHandle(record: any): ProviderSession | null {
  const h = record?.providerHandleChain?.at(-1)?.handle
  const provider = record?.provider
  const handleProvider = h?.provider ?? h?.agent
  if (!h || handleProvider !== provider || !TRANSCRIPT_PROVIDERS.has(provider)) return null
  const id = h.nativeId ?? (provider === 'codex' ? h.threadId : h.sessionId ?? h.conversationId)
  return typeof id === 'string' && id ? { provider, id } : null
}

function journalIdentity(path: string, orcaSession: string): { providerSession: ProviderSession; epoch: string } | null {
  const db = database(path)
  try {
    const row = db.prepare(`SELECT r.record_json, s.epoch FROM agent_session_records r
      LEFT JOIN journal_chat_state s ON s.session_id = r.session_id WHERE r.session_id = ?`).get(orcaSession) as { record_json: string; epoch: string } | undefined
    if (!row) return null
    if (!row.epoch) throw new Error('Chat history is unavailable')
    const record = JSON.parse(row.record_json)
    if (record.sessionId !== orcaSession || record.location?.executionHostId !== 'local' || record.location?.wslDistro) throw new Error('Chat identity is unavailable locally')
    const providerSession = nativeHandle(record)
    if (!providerSession) throw new Error('Chat provider identity is unavailable')
    return { providerSession, epoch: row.epoch }
  } finally { db.close() }
}

/** The live inventory's Orca id and a status event's native id are different namespaces. */
export function discoverTranscript(pane: string, files = transcriptFiles, identity: TranscriptIdentity = {}): FoundTranscript {
  try {
    // A structured chat has a record keyed by its exact Orca id. Never use this id as a native id.
    if (identity.orcaSession && files.journal && existsSync(files.journal)) {
      const current = journalIdentity(files.journal, identity.orcaSession)
      if (current) {
        if ((identity.provider && identity.provider !== current.providerSession.provider)
          || (identity.sessionId && identity.sessionId !== current.providerSession.id)) return { path: null, why: 'Chat identity changed; waiting for current inventory' }
        return { path: files.journal, source: { kind: 'journal', path: files.journal, orcaSession: identity.orcaSession, ...current } }
      }
    }
    const entry = hookEntry(pane, files)
    if (!entry) return { path: null, why: 'No exact pane transcript binding; check Orca agent hooks' }
    if (entry.connectionId) return { path: null, why: 'Remote transcript reading is not supported' }
    const provider = entry.payload?.agentType
    const id = entry.providerSession?.id
    if ((identity.provider && provider !== identity.provider)
      || (identity.sessionId && id !== identity.sessionId)
      || (identity.orcaSession && entry.orcaSessionId && entry.orcaSessionId !== identity.orcaSession)) {
      return { path: null, why: 'Pane identity changed; waiting for current inventory' }
    }
    if (identity.orcaSession && !terminalIdentityMatches(entry, files, identity.orcaSession)) {
      return { path: null, why: 'Orca/native session binding unavailable or changed; waiting for verified identity metadata' }
    }
    const path = entryTranscriptPath(entry, files)
    if (typeof path !== 'string' || !existsSync(path)) return { path: null, why: 'Exact pane transcript is not on disk yet' }
    if (provider && !TRANSCRIPT_PROVIDERS.has(provider)) return { path: null, why: 'Unsupported transcript provider' }
    const providerSession: ProviderSession | undefined = provider && typeof id === 'string' ? { provider, id } : undefined
    if (provider && provider !== 'claude' && !providerSession) return { path: null, why: `${provider} native session identity is unavailable` }
    // Preserve the legacy discovery shape for old Claude hook records without identity metadata.
    if (!providerSession && !identity.orcaSession) return { path }
    const source: TranscriptSource = { kind: 'jsonl', path, providerSession, ...(identity.orcaSession ? { orcaSession: identity.orcaSession } : {}), binding: { pane, files } }
    if (!sourceCurrent(source)) return { path: null, why: 'Transcript identity does not match its pane' }
    return { path, source }
  } catch {
    // DB errors can include private paths or row content. Never emit those in background logs.
    return { path: null, why: 'Transcript metadata unavailable or unsupported; check local Orca version and hooks' }
  }
}

export function sourceCurrent(source: TranscriptSource): boolean {
  try {
    if (source.kind === 'journal') {
      if (!source.orcaSession || !source.providerSession) return false
      const current = journalIdentity(source.path, source.orcaSession)
      return !!current && current.epoch === source.epoch && current.providerSession.id === source.providerSession.id && current.providerSession.provider === source.providerSession.provider
    }
    if (source.orcaSession && (!source.binding || !source.providerSession)) return false
    if (source.binding) {
      const entry = hookEntry(source.binding.pane, source.binding.files)
      if (entry?.connectionId) return false
      if (entryTranscriptPath(entry, source.binding.files) !== source.path) return false
      if (source.providerSession && (entry?.providerSession?.id !== source.providerSession.id || entry?.payload?.agentType !== source.providerSession.provider)) return false
      if (source.orcaSession && !terminalIdentityMatches(entry, source.binding.files, source.orcaSession)) return false
    }
    if (source.providerSession?.provider === 'codex') {
      const meta = readFileSync(source.path, 'utf8').split('\n').slice(0, 8).map(parse).find((r) => r?.type === 'session_meta')?.payload
      return (meta?.id ?? meta?.session_id) === source.providerSession.id && !meta?.source?.subagent
    }
    return true
  } catch { return false }
}

const parse = (line: string): any => { try { return JSON.parse(line) } catch { return null } }
const timestamp = (n: unknown): string | undefined => typeof n === 'number' && Number.isFinite(n) ? new Date(n).toISOString() : typeof n === 'string' ? n : undefined
const text = (blocks: any): string => Array.isArray(blocks) ? blocks.filter((b) => ['text', 'input_text', 'output_text'].includes(b?.type) && typeof b.text === 'string').map((b) => b.text).join('\n') : ''

/** Strip Antigravity XML wrappers (<USER_REQUEST>, <ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>). */
function antigravityUserText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const req = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(raw)
  if (req) return req[1].trim()
  if (/^\s*<CONTEXT_SUMMARY>/.test(raw)) return ''
  return raw
    .replace(/^\s*<USER_REQUEST>\s*/, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim()
}

/** Antigravity transcript tool_calls args can store JSON-encoded string values like `"cmd"`. */
function parseAntigravityArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      try { out[k] = JSON.parse(v) } catch { out[k] = v }
    } else {
      out[k] = v
    }
  }
  return out
}

/** Filter only known injected envelopes/notices, never arbitrary user instructions. */
export function conversationalPrompt(raw: string): string {
  if (raw.includes('=== TASK ===')) return raw
  if (/^\s*(?:# AGENTS\.md instructions|<instructions>|<skills_instructions>|<environment_context>|<permissions instructions>|<collaboration_mode>|<multi_agent_role>)/.test(raw)) return ''
  if (/^\s*You have \d+ orchestration messages?\. Run `orca orchestration check`\.?\s*$/.test(raw)) return ''
  if (/You are a dispatched worker\./.test(raw) && !raw.includes('=== TASK ===')) return ''
  return raw
}

/** Normalize Antigravity CLI transcripts, Codex rollouts, and Claude JSONL into one event stream. */
export function normalizedRecords(lines: string[]): any[] {
  const records = lines.map(parse).filter(Boolean)
  const antigravity = records.some((r) => typeof r.step_index === 'number' && ['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'SYSTEM_MESSAGE'].includes(r.type))
  if (antigravity) {
    const out: any[] = []
    for (const r of records) {
      const at = timestamp(r.created_at)
      if (r.type === 'USER_INPUT') {
        const prompt = antigravityUserText(r.content)
        if (prompt) out.push({ type: 'user', timestamp: at, message: { content: prompt } })
      } else if (r.type === 'PLANNER_RESPONSE') {
        const calls = Array.isArray(r.tool_calls) ? r.tool_calls : []
        const content: any[] = []
        for (const tc of calls) {
          if (typeof tc?.name === 'string') content.push({ type: 'tool_use', name: tc.name, input: parseAntigravityArgs(tc.args) })
        }
        const reply = typeof r.content === 'string' ? r.content.trim() : ''
        if (reply) content.push({ type: 'text', text: reply })
        if (content.length) out.push({ type: 'assistant', timestamp: at, message: { content } })
        if (r.status === 'DONE' && reply && calls.length === 0) out.push({ type: 'system', subtype: 'turn_duration', timestamp: at })
      }
    }
    return out
  }
  const codex = records.some((r) => ['session_meta', 'response_item', 'event_msg', 'turn_context'].includes(r.type))
  if (!codex) return records
  const hasMessages = new Set(records.filter((r) => r.type === 'response_item' && r.payload?.type === 'message').map((r) => r.payload.role))
  const out: any[] = []
  for (const r of records) {
    const p = r.payload ?? {}, at = timestamp(r.timestamp)
    if (r.type === 'session_meta') out.push({ cwd: p.cwd })
    if (r.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      const channel = p.phase === 'final_answer' ? 'final' : p.phase ?? p.channel
      if (channel === 'analysis' || channel === 'summary') continue
      out.push({ type: p.role, timestamp: at, channel, codex: true, message: { content: [{ type: 'text', text: text(p.content) }] } })
    } else if (r.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) {
      let input: any = {}
      try { input = JSON.parse(p.arguments ?? p.input ?? '{}') } catch {}
      out.push({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', name: p.name, input }] } })
    } else if (r.type === 'event_msg') {
      if (p.type === 'user_message' && !hasMessages.has('user') && typeof p.message === 'string') out.push({ type: 'user', timestamp: at, message: { content: p.message } })
      if (p.type === 'agent_message' && !hasMessages.has('assistant') && typeof p.message === 'string') out.push({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: p.message }] } })
      if (['task_complete', 'turn_complete', 'turn_aborted'].includes(p.type)) out.push({ type: 'system', subtype: 'turn_duration', timestamp: at })
    }
  }
  return out
}

/** Current epoch, visible root items only; no queued drafts, child sessions, or superseded revisions. */
export function readTranscript(path: string, source?: TranscriptSource): string[] {
  if (source && !sourceCurrent(source)) throw new Error('Transcript identity changed')
  if (source?.kind !== 'journal') return readFileSync(path, 'utf8').split('\n')
  const db = database(path)
  try {
    const rows = db.prepare(`SELECT i.payload_json FROM journal_items i JOIN journal_chat_state s
      ON s.session_id = i.session_id AND s.epoch = i.epoch
      WHERE i.session_id = ? AND i.epoch = ? AND i.hidden = 0 AND i.root = 1 AND i.subagent_row = 0
      ORDER BY i.ordinal, i.sequence, i.sequence_index`).all(source.orcaSession!, source.epoch!) as { payload_json: string }[]
    const out: any[] = []
    for (const row of rows) {
      const item = JSON.parse(row.payload_json), b = item.body
      if (item.shortened) throw new Error('Chat transcript is incomplete')
      if (item.agentId || item.parentAgentId || !b) continue
      const at = timestamp(b.completedAt ?? item.observedAt)
      if (b.kind === 'message' && ['user', 'assistant'].includes(b.role)) {
        if (b.state === 'streaming' || b.state === 'pending') continue
        out.push({ type: b.role, timestamp: at, message: { content: [{ type: 'text', text: text(b.blocks) }] } })
      } else if (b.kind === 'tool-call') out.push({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', name: b.name, input: b.input }] } })
      else if (b.kind === 'turn' && typeof b.completedAt === 'number') out.push({ type: 'system', subtype: 'turn_duration', timestamp: timestamp(b.completedAt) })
    }
    return out.map((r) => JSON.stringify(r))
  } finally { db.close() }
}

/**
 * Orca's own prompt text: its dispatch preamble and the coordinator/lead start prompts. Codex names
 * its thread after the first prompt and Orca forwards that as conversationName, so it is not a title.
 */
export const ORCA_PROMPT = /^\s*(?:You are working inside Orca\b|You are a dispatched worker\b|Your role: (?:coordinator|lead)\b)/i
/** The line Orca puts before a dispatch it pastes into a terminal agent (Claude Code shows it as a paste). */
const ORCA_LEAD_LINE = 'Please carry out this task from my Orca coordinator by following the brief I pasted below.'

/** Orca's prompt text, as Orca itself recognizes a dispatch: its lead line and paste tag, then its preamble. */
export function orcaPrompt(raw: string): boolean {
  let t = raw.trimStart()
  if (t.startsWith(ORCA_LEAD_LINE)) t = t.slice(ORCA_LEAD_LINE.length).trimStart()
  const paste = /^<pasted_content\b[^>]{0,64}>/.exec(t)
  if (paste) t = t.slice(paste[0].length)
  return ORCA_PROMPT.test(t)
}

export type Opener = 'orca' | 'user'

/**
 * Who opened a conversation, from its first conversational user prompt in normalized records: Orca
 * (its dispatch preamble or a lead/coordinator start prompt) or the user. Null until there is one.
 */
export function openerIn(records: any[]): Opener | null {
  for (const d of records) {
    if (d?.type !== 'user' || d.isSidechain || d.isMeta) continue
    const content = d.message?.content
    if (Array.isArray(content) && content.some((c: any) => c?.type === 'tool_result')) continue
    const raw = (typeof content === 'string' ? content : text(content)).trim()
    if (!raw) continue
    if (orcaPrompt(raw)) return 'orca'
    // Provider envelopes and Claude's slash-command records come before the first real prompt.
    if (!conversationalPrompt(raw) || /^<(?:command-|local-command-)/.test(raw)) continue
    return 'user'
  }
  return null
}

/** The complete lines in a file's first `max` bytes. */
function headLines(path: string, max: number): string[] {
  const size = statSync(path).size
  const bytes = new Uint8Array(Math.min(size, max))
  const fd = openSync(path, 'r')
  try { readSync(fd, bytes, 0, bytes.length, 0) } finally { closeSync(fd) }
  const lines = new TextDecoder().decode(bytes).split('\n')
  return size > max ? lines.slice(0, -1) : lines
}

const openers = new Map<string, Opener>()

/**
 * Who opened the conversation behind a found transcript, read from the head of the file (or the
 * structured chat's items). A conversation's first prompt never changes, so a decided answer is cached
 * per transcript and provider session; "no prompt yet" is not, and is read again next time.
 */
export function conversationOpener(found: FoundTranscript, max = 1024 * 1024): Opener | null {
  if (!found.path) return null
  const s = found.source
  const key = [s?.kind ?? 'jsonl', found.path, s?.orcaSession ?? '', s?.providerSession?.provider ?? '', s?.providerSession?.id ?? '', s?.epoch ?? ''].join('\0')
  const cached = openers.get(key)
  if (cached) return cached
  let opener: Opener | null
  try {
    opener = openerIn(normalizedRecords(s?.kind === 'journal' ? readTranscript(found.path, s) : headLines(found.path, max)))
  } catch { return null }
  if (opener) openers.set(key, opener)
  return opener
}
