// The end-of-turn summarizer: reads an agent's Claude transcript and asks Haiku for a status card
// (title, about, the ask at a glance, what it is watching, a priority guess). Shared by the plugin
// worker, which runs it when Orca reports a finished turn, and `orca-flow summarize-run`.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { COORDINATOR_HOME, isCoordinatorHome } from './coordinators.ts'
import type { AgentSummary } from './protocol.ts'
export { claudeConfigDir } from './writer.ts'
import { cliProviders, createWriter, WriterError, writerDiagnostic, type Writer } from './writer.ts'
import { checkFrame, parseFrame, sentencesOf } from '../skills/orca-flow/scripts/frame.mjs'

export const DATA_DIR = join(homedir(), '.orca-flow')
const AGENTS = join(DATA_DIR, 'agents')
const ORCA_DATA = join(homedir(), 'Library', 'Application Support', 'orca')

/**
 * Written into every card as `summarizer`. Bump it whenever SYSTEM_PROMPT, COORDINATOR_ASKS,
 * WORKER_ASKS, SUMMARY_SCHEMA, promptFor or role detection (roleOf/digest) changes: when the plugin worker
 * starts, it re-summarizes live agents whose card an older summarizer wrote (no field = 0), so the
 * fix shows at once instead of at the agent's next turn.
 */
export const SUMMARIZER_VERSION = 7

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'about', 'goal', 'since', 'needs', 'glance', 'watching', 'effort', 'priority'],
  properties: {
    title: { type: 'string', description: 'The workstream in 2-5 words, stable across turns, never the latest step' },
    about: { type: 'string', description: 'One sentence on what this workstream is for, stable across turns' },
    goal: { type: 'string', description: 'One sentence: the outcome the user asked for' },
    since: { type: 'string', description: 'At most 25 words: what concretely changed in the latest turn' },
    needs: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'ask', 'options'],
      properties: {
        type: { enum: ['none', 'decision', 'approval', 'review', 'info', 'action'] },
        ask: { type: 'string', description: 'One question in at most 25 words, or for an action the thing to do as an imperative in the agent\'s own words; empty if none' },
        options: { type: 'array', items: { type: 'string', description: 'A 1-5 word button label' }, maxItems: 4 }
      }
    },
    glance: { type: 'string', description: 'The ask in at most 8 words, as a question, or for an action as an imperative (never a question); empty when needs.type is none' },
    watching: { type: 'string', description: 'What the agent is waiting on that is not the user, in at most 4 words ("E2E run", "CI", "its workers"); empty if nothing' },
    effort: { enum: ['quick', 'deep'], description: 'How long answering the ask takes the user' },
    priority: { enum: ['P0', 'P1', 'P2', 'P3'] }
  }
}

export const SYSTEM_PROMPT = `You write status cards for a developer who runs many coding agents in parallel and switches between them constantly. Each card must let them re-enter a workstream in seconds.

Rules:
- "title" names the workstream in 2-5 words ("Guest checkout", "Search ranking fix"), never the latest step. If a previous title is given and the work is the same, keep it.
- "about" is one plain sentence on what the workstream is for ("Let returning customers check out without re-entering their address."). Keep the previous one unless the goal changed.
- "glance" is the ask in at most 8 words, as the question or action itself ("Keep the old checkout behind a flag?", "Review the pricing page before Friday."). When the agent's final message asks the user something, restate THAT question; never invent a different one. For an "action", it is the imperative ("Rename the project to katos in Orca settings."), never a question.
- The first request of an Orca worker starts with an orchestration preamble (Task and Dispatch ids, how to report). The actual task is the brief inside it; summarize that, not the preamble.
- "watching": when the turn ended waiting on something other than the user (tests, CI, a deploy, workers it started), name it in at most 4 words; otherwise empty.
- Never put ids, hashes, terminal names, file paths or URLs in title, about, glance or watching.
- Be concrete in "since": name PRs, tests, numbers. No filler, no "the agent".
- "since" is what changed in the latest turn only.
- "needs" and "glance" come ONLY from the agent's final message of the latest turn. An ask, action or question from the earlier turn, or from earlier in the latest turn, that the final message does not repeat is not current: needs.type "none" and glance "". The earlier turn is context for "title", "about" and "goal" only.
- An optional invitation or offer is not an ask: "let me know if…", "tell me how", "if you'd rather…, tell me", "say the word if…", "happy to … if you want" means needs.type "none" and glance "". Only a question or to-do the agent actually waits on counts.
- "needs": what the agent is waiting on from the user right now. "none" if the turn ended with work finished and nothing asked, and "none" when it is waiting on something else: workers it started, a background job, a long-running command, CI. Only a question, a decision or something for the user to do counts. "approval" = yes/no on something prepared; "decision" = choose between options; "review" = look at a diff/PR/result; "info" = a fact only the user has; "action" = something only the user can do outside the chat (change a setting, run a command, log in somewhere, rename a project), often with "tell me when done". Ask ONE question in at most 25 words; if the agent asked several, ask the most important and say "(+2 more)". Options are 1-5 word labels like "Merge", "Keep both", "Ask each time", never sentences.
- An "action" is not a question: never rephrase it as one ("Rename cacasports to katos in Orca?" is wrong). Keep the agent's own wording as an imperative in "ask" and "glance" ("Rename the project to katos in Orca settings."). Its options are ["Done"] or empty. The rules below apply to actions too: a heads-up about a later action is not an ask, and an action the user already took on is not one.
- An ask needs a question the user can answer RIGHT NOW, or an action the user can do right now. A heads-up about a later step is not one: "releasing waits for your go-ahead", "I'll ask you once the PR is up", "merging needs your OK later" while the work it depends on is still running or not yet there means needs.type "none" and glance "", with what it waits on first in "watching". Never turn such a statement into a question.
- An ask the user has already taken on is not an ask. When the user's latest message takes it on ("ok reviewing", "on it", "will look", "checking now", "give me a minute") and the agent's reply only acknowledges and waits, the ask is acknowledged: needs.type "none" and glance "", with what it waits on in "watching" ("your review of the PR"). It is an ask again only when the agent asks something new.
- "effort": "quick" if the user can answer in under a minute.
- "priority" guess: P0 now = blocking production, a customer or a release; P1 today = critical path of current focus; P2 soon = matters but can wait a day; P3 someday = exploration. When unsure pick the lower level.
Write in English even if the conversation is in another language.`

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
}

/**
 * An Orca dispatch wraps the real brief in a long preamble (ids, how to report). Only the text after
 * its `=== TASK ===` marker is the task; the preamble would drown it out.
 */
export function briefOf(text: string): string {
  const i = text.indexOf('=== TASK ===')
  if (i < 0) return text
  return text.slice(i + '=== TASK ==='.length).replace(/<\/pasted_content>[\s\S]*$/, '').trim()
}

type Role = 'lead' | 'worker' | 'coordinator' | 'solo'
type Event = { kind: 'user' | 'assistant' | 'tool'; text: string; raw?: string; at?: string; reports?: boolean }

/** Decided from facts, not by the model: a lead's first prompt names its role; an agent Orca
 * dispatched carries Orca's worker preamble (or, outside a coordinator folder, its Dispatch id);
 * any other session in one of the user's coordinator folders is that coordinator (a lead or worker
 * the coordinator started in a tab of its folder is not); any other agent that started workers
 * coordinates them. */
export function roleOf(firstPrompt: string, events: Event[], cwd: string | null = null, home = COORDINATOR_HOME): Role {
  if (/your role: lead\b/i.test(firstPrompt)) return 'lead'
  if (/You are a dispatched worker\.|Your task ID is: task_/.test(firstPrompt)) return 'worker'
  if (cwd && isCoordinatorHome(cwd, home)) return 'coordinator'
  if (/dispatch[ _-]?id|worker_done/i.test(firstPrompt)) return 'worker'
  // Only a command that runs it, not one that merely mentions it (in a heredoc, a grep, a test).
  const runs = /^Bash: (?:.*(?:&&|;)\s*)?(?:\S*\/)?orca orchestration worker-start\b/
  if (events.some((e) => e.kind === 'tool' && runs.test(e.text))) return 'coordinator'
  return 'solo'
}

/** A command that sends worker_done, not one that merely mentions it (in a heredoc, a grep, a test). */
const SENDS_DONE = /^(?:.*(?:&&|;)\s*)?(?:\S*\/)?orca orchestration send\b.*--type[= ]['"]?worker_done\b/

/**
 * `reported`: a dispatched worker that sent worker_done in the latest turn; its final message is its
 * report to its lead. `lastMessage` is that final message whole (lastAssistant is clipped for Haiku).
 */
export type Digest = { role: Role; firstPrompt: string; context: string; turn: string; lastAssistant: string; lastMessage: string; turnAt: string | null; reported: boolean }

/** Condense a Claude Code transcript into what the summarizer needs. */
export function digest(lines: string[], home = COORDINATOR_HOME): Digest | null {
  const events: Event[] = []
  let cwd: string | null = null
  for (const line of lines) {
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isSidechain) continue
    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd
    const content = d.message?.content
    if (d.type === 'user') {
      if (Array.isArray(content) && content.some((c: any) => c.type === 'tool_result')) continue
      const raw = textOf(content).trim()
      const text = briefOf(raw)
      // A dispatched worker's first message carries its Dispatch id: keep that fact for roleOf.
      if (text) events.push({ kind: 'user', text, raw, at: d.timestamp })
    } else if (d.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text.trim()) events.push({ kind: 'assistant', text: c.text.trim(), at: d.timestamp })
        if (c.type === 'tool_use') {
          const detail = c.input?.command ?? c.input?.file_path ?? c.input?.description ?? ''
          // Judged on the whole command: the shown one is clipped.
          const reports = c.name === 'Bash' && SENDS_DONE.test(String(c.input?.command ?? '').replace(/\s+/g, ' '))
          events.push({ kind: 'tool', text: `${c.name}${detail ? `: ${clip(String(detail).replace(/\s+/g, ' '), 140)}` : ''}`, at: d.timestamp, reports })
        }
      }
    }
  }
  const prompts = events.filter((e) => e.kind === 'user')
  if (prompts.length === 0) return null
  // The latest turn, and the one before it as context only: its asks are not current.
  const latest = events.indexOf(prompts.at(-1)!)
  const earlier = prompts.length > 1 ? events.slice(events.indexOf(prompts.at(-2)!), latest) : []
  const turn = events.slice(latest)
  // The final message comes from the latest turn only; an earlier turn's is not this turn's.
  const lastAssistant = [...turn].reverse().find((e) => e.kind === 'assistant')
  const render = (es: Event[]) => es
    .filter((e) => e !== lastAssistant)
    .map((e) => (e.kind === 'user' ? `USER: ${clip(e.text, 1500)}` : e.kind === 'assistant' ? `AGENT: ${clip(e.text, 800)}` : `  → ${e.text}`))
    .join('\n')
  const role = roleOf(prompts[0].raw ?? prompts[0].text, events, cwd, home)
  return {
    role,
    firstPrompt: clip(prompts[0].text, 1500),
    context: clip(render(earlier), 4000),
    turn: clip(render(turn), 10_000),
    lastAssistant: lastAssistant ? clip(lastAssistant.text, 4000) : '',
    lastMessage: lastAssistant?.text ?? '',
    turnAt: events.at(-1)?.at ?? null,
    reported: role === 'worker' && turn.some((e) => e.reports)
  }
}

// ---------- finding things on this Mac ----------

const HOOKS_DIR = join(ORCA_DATA, 'agent-hooks')

type Found = { path: string } | { path: null; why: string }

/**
 * Where Orca's hook state records a pane's Claude transcript. Current Orca keeps that state in
 * SQLite (agent-hooks/last-status.db: one `entry\0<pane>` row per pane, its JSON value carrying
 * `providerSession.transcriptPath`); older Orca wrote agent-hooks/last-status.json. Reads the
 * database first, the JSON file second, and says why when neither has a transcript on disk.
 */
export function findTranscript(pane: string, files = { db: join(HOOKS_DIR, 'last-status.db'), json: join(HOOKS_DIR, 'last-status.json') }): Found {
  const misses: string[] = []
  for (const [file, read] of [[files.db, entryFromDb], [files.json, entryFromJson]] as const) {
    if (!existsSync(file)) {
      misses.push(`${file} does not exist`)
      continue
    }
    let entry: any
    try {
      entry = read(file, pane)
    } catch (e) {
      misses.push(`${file}: ${(e as Error).message}`)
      continue
    }
    const path = entry?.providerSession?.transcriptPath ?? entry?.transcriptPath
    if (typeof path === 'string' && existsSync(path)) return { path }
    misses.push(entry ? `${file} names ${typeof path === 'string' ? `${path}, which does not exist` : 'no transcript'}` : `${file} has no entry for the pane`)
  }
  return { path: null, why: misses.join('; ') }
}

export function transcriptOf(pane: string, files?: { db: string; json: string }): string | null {
  return findTranscript(pane, files).path
}

/**
 * The newest entry row for the pane. Opened read-only: Orca writes the database live in WAL mode.
 * `node:sqlite` comes from the runtime (Node 22.13+ unflagged; Orca's plugin host runs Node 24), so
 * the plugin needs no native build; on a runtime without it the JSON fallback still applies.
 */
function entryFromDb(file: string, pane: string): any {
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  if (!sqlite) throw new Error('this runtime has no node:sqlite')
  const db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 1000 })
  try {
    // Rows are keyed `entry\0<pane>`; match on the value's paneKey too, in case the key layout changes.
    const rows = db.prepare(`SELECT value FROM rows WHERE key = ? OR (substr(key, 1, 5) = 'entry' AND instr(value, ?) > 0) ORDER BY seq DESC`)
      .all(`entry\0${pane}`, JSON.stringify(pane)) as { value: string }[]
    for (const row of rows) {
      const entry = JSON.parse(row.value)
      if (entry?.paneKey === pane) return entry
    }
    return null
  } finally {
    db.close()
  }
}

function entryFromJson(file: string, pane: string): any {
  return JSON.parse(readFileSync(file, 'utf8'))?.entries?.[pane] ?? null
}

// ---------- the card on disk ----------

const fileKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_')

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Write via a temp file and rename, so the panel never reads half a file. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

/**
 * A coordinator relays its leads' and workers' questions ("the lead is waiting on you, try it").
 * Those asks belong to the agent that asked, which shows its own question badge; repeated on the
 * coordinator they show the same ask twice. So a coordinator's card asks only what the user must
 * answer to the coordinator itself.
 */
export const COORDINATOR_ASKS = `This agent is a COORDINATOR: it routes work to leads and workers, which have their own cards. For "needs", count only a question the user must answer TO THE COORDINATOR ITSELF: which project or coordinator takes a request, approving a worktree removal, approving freeing memory or stopping a session, a conflict between two workstreams, or a fact it needs before it can start work; or an "action" the user must do for the coordinator itself outside the chat ("rename the project in Orca's settings, tell me when done"). Every decision about a workstream a lead owns (reviewing or merging its PR, picking an option, approving its release) is the lead's ask, on the lead's card, even when the coordinator repeats it. A question it relays or summarizes from a lead or worker (from a lead's status note, a "stopped without reporting" notice or the queue), or one that tells the user to answer, try or review something in another agent's chat, is NOT its ask: set needs.type "none" and glance "" (name what it waits on in "watching", e.g. "lead's review").`

/**
 * A dispatched worker reports to the agent that dispatched it. Its report's "Decision for you",
 * question or review is for that lead (which shows it, or asks the user, itself); on the worker it
 * showed an ask nobody was waiting on.
 */
export const WORKER_ASKS = `This agent is a dispatched WORKER: a lead or coordinator dispatched it and it reports to that lead, not to the user. A decision, question, review or to-do in its report ("Decision for you: …", "Left for you: …", "Should we …?") is addressed to its lead, which decides or asks the user itself: set needs.type "none" and glance "". Count a need only when the worker is genuinely blocked waiting in its own chat on the user before it can finish its task (a permission, a fact only the user has), not when its final message is its report.`

/** Stated as a fact when the latest turn ran `orca orchestration send --type worker_done`. */
export const WORKER_REPORTED = `FACT: in the latest turn this worker sent worker_done to its lead: its task is over and its final message is its report to that lead. needs.type is "none" and glance is "".`

/** What Haiku reads for one turn: the role's rules, the card so far, and the turn itself. */
export function promptFor(d: Digest, previous: { title?: string; about?: string } | null, goal?: string): string {
  return [
    d.role === 'coordinator' && COORDINATOR_ASKS,
    d.role === 'worker' && WORKER_ASKS,
    d.reported && WORKER_REPORTED,
    goal && `Coordinator's goal for this workstream: ${goal}`,
    previous?.title && `Previous title: ${previous.title}${previous.about ? `\nPrevious about: ${previous.about}` : ''}`,
    `FIRST REQUEST:\n${d.firstPrompt}`,
    d.context && `EARLIER TURN (context only; its asks are not current):\n${d.context}`,
    `LATEST TURN:\n${d.turn}`,
    `AGENT'S FINAL MESSAGE THIS TURN:\n${d.lastAssistant || '(none)'}`
  ].filter(Boolean).join('\n\n')
}

/** Facts win over the model: a worker that sent worker_done asks the user nothing. */
export function withFacts<S extends object>(d: Digest, summary: S): S {
  return d.reported ? { ...summary, needs: { type: 'none', ask: '', options: [] }, glance: '' } : summary
}

// ---------- the message frame ----------

type Needs = AgentSummary['needs']
const NO_ASK: Needs = { type: 'none', ask: '', options: [] }

/**
 * The ask exactly as a coordinator or lead wrote it, when its final message has a valid frame
 * (skills/orca-flow/messages.md); null for another role or a message without one. Its kind comes
 * from the frame's shape (frame.mjs), its status line is kept for Up next's label, and an ask
 * under `Working · needs ... later` is not blocking. Working, Idle, Done and a route line ask
 * nothing. A hand action without an Ask takes its ask from the status line ("Needs you to turn on
 * Developer Mode"), else from the context's first sentence, with "Done" as the button when the
 * Reply line is "done".
 */
export function frameAsk(d: Pick<Digest, 'role' | 'lastMessage'>): { needs: Needs; reply: string; status: string } | null {
  if ((d.role !== 'coordinator' && d.role !== 'lead') || !d.lastMessage.trim()) return null
  if (!checkFrame(d.lastMessage, { role: d.role }).ok) return null
  const f = parseFrame(d.lastMessage)
  if (!f || f.kind === 'none') return { needs: NO_ASK, reply: '', status: f?.status ?? '' }
  const type = f.kind as Needs['type']
  const reply = f.reply ?? ''
  const options = type === 'action' && /^done\.?$/i.test(reply) ? ['Done'] : f.options
  const todo = /^Needs you to (.+)$/.exec(f.status)?.[1]
  // A pointer to detail above the frame ("(error above)") means nothing on a card.
  const first = sentencesOf(f.context)[0]?.replace(/\s*\([^()]*\babove\)/g, '')
  const ask = f.ask ?? (type !== 'action' ? '' : todo ? `${todo.charAt(0).toUpperCase()}${todo.slice(1)}.` : first ? `${first}.` : '')
  return { needs: { type, ask, options, ...(f.blocking ? {} : { blocking: false }) }, reply, status: f.status }
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4))

/** The ask in a few words: its question sentence (else its first), clipped to ten words. */
export function shortAsk(ask: string): string {
  const sentences = ask.split(/(?<=[.?!])\s+/).filter(Boolean)
  const pick = [...sentences].reverse().find((s) => s.endsWith('?')) ?? sentences[0] ?? ''
  const w = pick.split(/\s+/)
  const short = w.length > 10 ? `${w.slice(0, 10).join(' ')}…` : pick
  return short.charAt(0).toUpperCase() + short.slice(1)
}

/**
 * A valid frame decides the ask, not Haiku: needs and reply come from the frame, and Haiku's glance
 * stays only when it is about the same ask (same type, a word in common), else the Ask's short
 * form. `source` says where the ask came from, so drift between the two shows on the card.
 */
export function withFrame<S extends { needs: Needs; glance?: string }>(d: Pick<Digest, 'role' | 'lastMessage'>, summary: S): S & { reply?: string; status?: string; source: 'frame' | 'summarizer' } {
  const framed = frameAsk(d)
  if (!framed) return { ...summary, source: 'summarizer' }
  const { needs, reply, status } = framed
  const theirs = summary.glance ?? ''
  const same = summary.needs?.type === needs.type && [...words(theirs)].some((w) => words(needs.ask).has(w))
  const glance = needs.type === 'none' ? '' : same ? theirs : shortAsk(needs.ask)
  const asks = needs.type !== 'none'
  return { ...summary, needs, glance, ...(asks && reply ? { reply } : {}), ...(asks ? { status } : {}), source: 'frame' }
}

/** Validate before facts/frame overrides and before any write; reject unknown metadata too. */
export function validateSummary(value: unknown): Omit<AgentSummary, 'role' | 'updatedAt'> {
  const v = value as any
  const strings = ['title', 'about', 'goal', 'since', 'glance', 'watching']
  const keys = [...strings, 'needs', 'effort', 'priority']
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || Object.keys(v).some((k) => !keys.includes(k))
    || strings.some((k) => typeof v[k] !== 'string' || v[k].length > 4000)
    || !v.title.trim() || !v.about.trim()
    || !['quick', 'deep'].includes(v.effort) || !['P0', 'P1', 'P2', 'P3'].includes(v.priority)
    || !v.needs || typeof v.needs !== 'object' || Array.isArray(v.needs)
    || Object.keys(v.needs).some((k) => !['type', 'ask', 'options'].includes(k))
    || !['none', 'decision', 'approval', 'review', 'info', 'action'].includes(v.needs.type)
    || typeof v.needs.ask !== 'string' || v.needs.ask.length > 4000
    || !Array.isArray(v.needs.options) || v.needs.options.length > 4
    || v.needs.options.some((s: unknown) => typeof s !== 'string' || s.length > 500)) {
    throw new Error('Invalid writer card')
  }
  return v
}

/** Provider validation is part of the boundary, never a programming-error fallback. */
export function summaryProviders(providers = cliProviders()) {
  const checked = (provider: 'haiku' | 'luna', run: Writer): Writer => async (request) => {
    const value = await run(request)
    try { return validateSummary(value) } catch { throw new WriterError(provider, 'invalid-output') }
  }
  return { haiku: checked('haiku', providers.haiku), luna: checked('luna', providers.luna) }
}

// The worker and summarize-run share the same writer and output validation.
const summaryWriter = createWriter(summaryProviders())

/**
 * Summarizes one pane's latest turn into ~/.orca-flow/agents/<pane>.json. Skips a turn already
 * summarized (unless forced), and keeps the newest when two finish close together (even when
 * forced). Returns what it did.
 */
export async function summarizePane(input: { pane: string; transcript: string; worktreeId?: string; goal?: string; force?: boolean; dir?: string; writer?: Writer }): Promise<'written' | 'skipped' | 'empty'> {
  const out = join(input.dir ?? AGENTS, `${fileKey(input.pane)}.json`)
  const d = digest(readFileSync(input.transcript, 'utf8').split('\n'))
  if (!d) return 'empty'
  const previous = readJson(out)
  if (!input.force && previous?.turnAt && d.turnAt && previous.turnAt >= d.turnAt) return 'skipped'
  // Both providers write the same title/card contract; a valid frame still decides the ask.
  const generated = await (input.writer ?? summaryWriter)({ prompt: promptFor(d, previous, input.goal), system: SYSTEM_PROMPT, schema: SUMMARY_SCHEMA })
  const summary = withFrame(d, withFacts(d, validateSummary(generated)))
  // Another call may have published while the provider ran; never overwrite that same/newer turn.
  const latest = readJson(out)
  if (latest?.turnAt && d.turnAt && (latest.turnAt > d.turnAt || (latest.turnAt === d.turnAt && latest.updatedAt !== previous?.updatedAt))) return 'skipped'
  writeJson(out, { pane: input.pane, worktreeId: input.worktreeId ?? '', transcript: input.transcript, turnAt: d.turnAt, updatedAt: Date.now(), role: d.role, summarizer: SUMMARIZER_VERSION, ...summary })
  return 'written'
}

// ---------- when to summarize ----------

type StatusEvent = {
  paneKey: string
  workspaceId: string | null
  state: string
  /** The agent's own turn. Orca keeps `state` working while background work runs (an artifact watch, a job, a cron), so this is what says the turn ended. */
  mainAgent?: { state: string; stateStartedAt?: number }
}

/**
 * Whether an event ends a turn: Orca says done or waiting, or it says working only because of
 * background work while the agent's own turn is done or waiting. A turn still running never is.
 */
export function endsTurn(event: Pick<StatusEvent, 'state' | 'mainAgent'>): boolean {
  if (event.state === 'done' || event.state === 'waiting') return true
  const main = event.mainAgent?.state
  return event.state === 'working' && (main === 'done' || main === 'waiting')
}
type Job = { pane: string; transcript: string; worktreeId?: string; force?: boolean }
type Queued = Job & { waiters: (() => void)[] }

/**
 * Runs the summarizer when Orca reports that an agent's turn ended (done) or it asked the user
 * something (waiting). Waits a moment so the transcript is flushed, coalesces bursts per pane,
 * keeps one run per pane and at most `parallel` Haiku calls at once (each is a node process).
 */
export function turnSummarizer(opts: {
  run: (job: Job) => Promise<unknown>
  findTranscript?: (pane: string) => Found
  delayMs?: number
  /** Waits before looking again for a transcript that was not there yet. */
  retryMs?: number[]
  parallel?: number
  log?: (message: string) => void
}) {
  const find = opts.findTranscript ?? ((pane: string) => findTranscript(pane))
  // A missing transcript means no summary at all; say so once, loudly, instead of failing silently.
  let warned = false
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()
  const failureNotices = new Map<string, number>()
  const again = new Map<string, Queued>()
  const queue: Queued[] = []
  const settle = (job: Queued) => { for (const w of job.waiters) w() }
  /** The turn end last scheduled per pane, so Orca repeating one (each status update is an event) runs it once. */
  const lastEnd = new Map<string, string>()

  const pump = () => {
    while (running.size < (opts.parallel ?? 2)) {
      const i = queue.findIndex((j) => !running.has(j.pane))
      if (i < 0) return
      const [job] = queue.splice(i, 1)
      running.add(job.pane)
      const { waiters: _, ...plain } = job
      opts.run(plain)
        .catch((e) => {
          const diagnostic = writerDiagnostic(e)
          // A provider outage can affect every pane; one actionable notice is enough.
          if (e instanceof WriterError) {
            const now = Date.now()
            if ((failureNotices.get(diagnostic) ?? 0) + 5 * 60_000 > now) return
            failureNotices.set(diagnostic, now)
          }
          opts.log?.(`summary for ${job.pane} failed: ${diagnostic}`)
        })
        .finally(() => {
          running.delete(job.pane)
          settle(job)
          const next = again.get(job.pane)
          if (next) {
            again.delete(job.pane)
            queue.push(next)
          }
          pump()
        })
    }
  }

  /** A newer job for the same pane replaces a waiting one; it keeps the waiters and any force. */
  const merge = (old: Queued | undefined, job: Queued): Queued =>
    old ? { ...job, force: job.force || old.force, waiters: [...old.waiters, ...job.waiters] } : job

  const enqueue = (job: Job): Promise<void> =>
    new Promise((resolve) => {
      const queued: Queued = { ...job, waiters: [resolve] }
      if (running.has(job.pane)) return void again.set(job.pane, merge(again.get(job.pane), queued))
      const i = queue.findIndex((j) => j.pane === job.pane)
      if (i >= 0) queue[i] = merge(queue[i], queued)
      else queue.push(queued)
      pump()
    })

  return {
    onStatus(event: StatusEvent): void {
      if (!endsTurn(event)) return
      const pane = event.paneKey
      if (event.mainAgent?.stateStartedAt !== undefined) {
        const end = `${event.mainAgent.state}@${event.mainAgent.stateStartedAt}`
        if (lastEnd.get(pane) === end) return
        lastEnd.set(pane, end)
      }
      // A new session can report its first status a moment before Claude creates its transcript
      // file, so a miss is looked up again before it counts.
      const retries = opts.retryMs ?? [5000, 15_000]
      const attempt = (n: number, delay: number) => {
        clearTimeout(timers.get(pane))
        timers.set(pane, setTimeout(() => {
          timers.delete(pane)
          const found = find(pane)
          if (found.path !== null) return void enqueue({ pane, transcript: found.path, worktreeId: event.workspaceId ?? undefined })
          if (n < retries.length) return attempt(n + 1, retries[n])
          if (warned) return
          warned = true
          opts.log?.(`SUMMARIES OFF: no Claude transcript found for pane ${pane}, so its turn was not summarized (${found.why}). Further misses are not logged.`)
        }, delay))
      }
      attempt(0, opts.delayMs ?? 2000)
    },
    /** Queues a job through the same per-pane and parallel limits; resolves once it has run (or failed, logged). */
    enqueue,
    dispose(): void {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      for (const job of queue.splice(0)) settle(job)
      for (const job of again.values()) settle(job)
      again.clear()
    }
  }
}

// ---------- refreshing cards an older summarizer wrote ----------

type Card = { pane?: string; transcript?: string; worktreeId?: string; summarizer?: number; updatedAt?: number }

/**
 * When the transcript's last turn ended (its last `turn_duration` line), in ms, or null. Reads only
 * the last `tail` bytes: a turn end further back than that is not looked for.
 */
export function lastTurnEnd(transcript: string, tail = 256 * 1024): number | null {
  let text: string
  try {
    const size = statSync(transcript).size
    const start = Math.max(0, size - tail)
    const bytes = new Uint8Array(size - start)
    const fd = openSync(transcript, 'r')
    try {
      readSync(fd, bytes, 0, bytes.length, start)
    } finally {
      closeSync(fd)
    }
    text = new StringDecoder('utf8').write(bytes)
  } catch {
    return null
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"turn_duration"')) continue
    try {
      const r = JSON.parse(lines[i])
      const at = r.type === 'system' && r.subtype === 'turn_duration' ? Date.parse(r.timestamp) : NaN
      if (Number.isFinite(at)) return at
    } catch {}
  }
  return null
}

/**
 * Pure: the cards whose agent finished a turn after the card was written, for idle panes only (a
 * pane mid-turn would be summarized half done). A turn end Orca's event never reported (the worker
 * was stopped, or Orca held the pane in working before mainAgent was read) is caught up this way.
 */
export function missedTurns(cards: Record<string, Card>, idlePanes: Iterable<string>, turnEnd: (transcript: string) => number | null = lastTurnEnd): { pane: string; transcript: string; worktreeId?: string }[] {
  const out: { pane: string; transcript: string; worktreeId?: string }[] = []
  const seen = new Set<string>()
  for (const pane of idlePanes) {
    if (!pane || seen.has(pane)) continue
    seen.add(pane)
    const card = cards[fileKey(pane)]
    if (!card?.transcript || !card.updatedAt) continue
    const end = turnEnd(card.transcript)
    if (end !== null && end > card.updatedAt) out.push({ pane, transcript: card.transcript, worktreeId: card.worktreeId || undefined })
  }
  return out
}

/**
 * Pure: the cards to re-summarize, one per live agent pane whose card an older summarizer wrote
 * (no `summarizer` field counts as 0). Only panes Orca lists now; a closed pane's card is left alone.
 * Cards are keyed as on disk (the pane with unsafe characters replaced).
 */
export function staleCards(cards: Record<string, Card>, livePanes: Iterable<string>, version = SUMMARIZER_VERSION): { pane: string; transcript?: string; worktreeId?: string }[] {
  const out: { pane: string; transcript?: string; worktreeId?: string }[] = []
  const seen = new Set<string>()
  for (const pane of livePanes) {
    if (!pane || seen.has(pane)) continue
    seen.add(pane)
    const card = cards[fileKey(pane)]
    if (!card || (card.summarizer ?? 0) >= version) continue
    out.push({ pane, transcript: card.transcript || undefined, worktreeId: card.worktreeId || undefined })
  }
  return out
}

/**
 * Re-summarizes stale cards without a burst (forced, unless a job says `force: false`): jobs go through `enqueue` (the turn summarizer's
 * queue, so turn summaries and refreshes share its parallel limit), at most `parallel` in flight
 * from here, each lane pausing `gapMs` before its next. A failure is logged once per pane by the
 * queue and the rest go on. `stopped` ends it early (the worker was deactivated).
 */
export async function refreshStale(opts: {
  jobs: Job[]
  enqueue: (job: Job) => Promise<unknown>
  parallel?: number
  gapMs?: number
  wait?: (ms: number) => Promise<unknown>
  stopped?: () => boolean
}): Promise<void> {
  const wait = opts.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const jobs = [...opts.jobs]
  const lane = async () => {
    for (let job = jobs.shift(); job && !opts.stopped?.(); job = jobs.shift()) {
      await opts.enqueue({ ...job, force: job.force ?? true })
      if (jobs.length) await wait(opts.gapMs ?? 3000)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.parallel ?? 2) }, lane))
}
