// Read-only adapters for Orca's exact pane bindings and structured chat journal.
// No account search, cwd matching, newest-file selection, or provider session mutation.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ProviderSession = { provider: 'claude' | 'codex'; id: string }
export type TranscriptIdentity = { orcaSession?: string | null; provider?: string | null; sessionId?: string }
export type TranscriptFiles = { db: string; json: string; journal?: string }
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
  journal: join(root, 'agent-session-domain.db')
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

function nativeHandle(record: any): ProviderSession | null {
  const h = record?.providerHandleChain?.at(-1)?.handle
  const provider = record?.provider
  if (!h || h.provider !== provider || !['claude', 'codex'].includes(provider)) return null
  const id = h.nativeId ?? (provider === 'codex' ? h.threadId : h.sessionId)
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
    const path = entry.providerSession?.transcriptPath ?? entry.transcriptPath
    if (typeof path !== 'string' || !existsSync(path)) return { path: null, why: 'Exact pane transcript is not on disk yet' }
    if (provider && !['claude', 'codex'].includes(provider)) return { path: null, why: 'Unsupported transcript provider' }
    const providerSession: ProviderSession | undefined = provider && typeof id === 'string' ? { provider, id } : undefined
    if (provider === 'codex' && !providerSession) return { path: null, why: 'Codex native session identity is unavailable' }
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
    if (source.binding) {
      const entry = hookEntry(source.binding.pane, source.binding.files)
      if (entry?.connectionId) return false
      if ((entry?.providerSession?.transcriptPath ?? entry?.transcriptPath) !== source.path) return false
      if (source.providerSession && (entry?.providerSession?.id !== source.providerSession.id || entry?.payload?.agentType !== source.providerSession.provider)) return false
      if (source.orcaSession && entry?.orcaSessionId && entry.orcaSessionId !== source.orcaSession) return false
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

/** Filter only known injected envelopes/notices, never arbitrary user instructions. */
export function conversationalPrompt(raw: string): string {
  if (raw.includes('=== TASK ===')) return raw
  if (/^\s*(?:# AGENTS\.md instructions|<instructions>|<skills_instructions>|<environment_context>|<permissions instructions>|<collaboration_mode>|<multi_agent_role>)/.test(raw)) return ''
  if (/^\s*You have \d+ orchestration messages?\. Run `orca orchestration check`\.?\s*$/.test(raw)) return ''
  if (/You are a dispatched worker\./.test(raw) && !raw.includes('=== TASK ===')) return ''
  return raw
}

/** Codex response items are canonical; older rollouts may contain only event_msg prose. */
export function normalizedRecords(lines: string[]): any[] {
  const records = lines.map(parse).filter(Boolean)
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
