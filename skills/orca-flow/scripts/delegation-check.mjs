#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher Agent|Task): coordinators and leads hand implementation and
// parallel work to tracked Orca workers (`orca-flow dispatch` / `orca-flow plan start`), not to
// Claude Code's native subagents. A native subagent skips everything a worker has: the Orca task
// and its tracking in the sidebar, the model the user picked per kind in Settings → Models, and the
// capacity gate. Their instructions said so in prose and leads still did it, so this hook enforces
// it for Claude Code agents.
//
// It denies an Agent call only when all hold: the agent runs in an Orca pane (ORCA_AGENT_PANE); it
// is a coordinator or a lead (hookRole in stop-check.mjs, the rule the other hooks use); the
// subagent type is not a read-only one (READ_ONLY); and the user's latest real prompt neither runs a
// slash command or skill (/review, /code-review: the user asked for that skill, and it starts the
// subagents it needs) nor asks for a subagent in plain text (asksForSubagent). Workers, chats the
// user started and every other tool: nothing.
// On by default; "delegationCheck": "off" in ~/.orca-flow/config.json turns it off. Each deny is
// logged to ~/.orca-flow/delegation.jsonl. Any error allows the call: exit 0, no output.
//
// Environment for tests: HOME moves ~ (and ~/orca/coordinators), ORCA_FLOW_DIR moves ~/.orca-flow.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { flowDir } from './roles.mjs'
import { firstPromptOf, hookRole } from './stop-check.mjs'

/** The tool's current name and the name it had before. */
export const AGENT_TOOLS = new Set(['Agent', 'Task'])
/** Subagent types that only read and answer: always allowed. */
export const READ_ONLY = new Set(['Explore', 'Plan', 'claude-code-guide', 'web-fetch', 'statusline-setup'])

const ASK = /\b(?:sub[- ]?agents?|agent tool|native agents?)\b/gi
const NEGATION = /\b(?:no|not|don'?t|do not|never|without|instead of|avoid|stop|rather than)\b[^.!?\n]*$/i
/** A slash command typed as the first word: "/review", "/code-review high". A path ("/Users/x/y.ts") has a second "/" and is not one. */
const SLASH_COMMAND = /^\/[a-z][\w:-]*$/i

/**
 * True when the text asks for a subagent: it names one ("subagent", "sub-agent", "sub agent",
 * "Agent tool", "native agent") outside a negation in the same sentence ("no subagents", "don't use
 * the Agent tool").
 */
export function asksForSubagent(text) {
  if (typeof text !== 'string') return false
  for (const m of text.matchAll(ASK)) {
    const before = text.slice(Math.max(0, m.index - 60), m.index)
    if (!NEGATION.test(before)) return true
  }
  return false
}

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : ''

/**
 * A real prompt with what it is: its text, and whether the user ran a slash command or a skill
 * (a <command-name> tag, as Claude Code records /review, or a first word such as "/review"). Null when
 * the record is not a real prompt. Of a dispatch prompt only the TASK block is the text; the
 * command check reads the text before that cut, so a TASK block cannot make a dispatch a command.
 */
function promptOf(d) {
  if (d?.type !== 'user' || d.isSidechain || d.isMeta || d.isCompactSummary) return null
  if (d.origin?.kind && d.origin.kind !== 'human') return null
  if (d.promptSource === 'system') return null
  const content = d.message?.content
  if (Array.isArray(content) && content.some((c) => c?.type === 'tool_result')) return null
  let whole = textOf(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!whole || whole.startsWith('<task-notification>')) return null
  if (/^You have \d+ orchestration messages?\b/.test(whole)) return null
  const command = /<command-name>/.test(whole) || SLASH_COMMAND.test(whole.split(/\s+/)[0])
  let text = whole
  const task = text.indexOf('=== TASK ===')
  if (task >= 0) text = text.slice(task + '=== TASK ==='.length).trim()
  return text ? { text, command } : null
}

/**
 * What the user typed in one transcript record, or null when the record is not a real prompt: tool
 * results, sidechains, skill bodies and other meta records, compaction summaries, task
 * notifications, Orca's "You have N orchestration message" wake line. Of a dispatch prompt only the
 * TASK block counts: Orca's preamble around it says "no subagents ... unless the task asks".
 */
export function realPrompt(d) {
  return promptOf(d)?.text ?? null
}

/**
 * The latest real prompt in a transcript, read from the end: its text, and whether it is a slash
 * command or skill the user ran. Empty text and command false when there is none.
 */
export function latestPromptInfo(transcript) {
  const lines = transcript.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"user"')) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    const prompt = promptOf(d)
    if (prompt) return prompt
  }
  return { text: '', command: false }
}

/** The latest real prompt's text in a transcript; '' when there is none. */
export function latestPrompt(transcript) {
  return latestPromptInfo(transcript).text
}

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** The deny reason: where the work goes instead, with the CLI as the agent reaches it (through the skill link). */
export function denyReason({ role, subagentType, script }) {
  const cli = join(dirname(resolve(script)), 'orca-flow.mjs')
  return [
    `Orca Flow: you are a ${role}, so implementation and parallel work go to tracked Orca workers, not to a native "${subagentType}" subagent (a subagent skips the Orca task, the model the user picked in Settings → Models and the capacity gate).`,
    `Start a worker: node "${cli}" dispatch --role worker --kind simple|normal|hard --worktree current --task-title "<outcome>" --spec-file - (the spec on stdin).`,
    `Several independent tasks: write a plan file and run node "${cli}" plan start <plan.json>.`,
    'If capacity or routing refuses (exit 2 or 3), queue the task or tell the user the blocker. Do not run it as a native subagent instead.',
    `Native subagents are only for small read-only lookups: subagent_type ${[...READ_ONLY].slice(0, 4).join(', ')}. Another type only when the user explicitly asks for a subagent.`
  ].join('\n')
}

/**
 * The hook's answer for one PreToolUse input: null to allow (print nothing), else the deny output
 * and the log line.
 */
export function decide(input, { env = process.env, home = homedir(), script = process.argv[1] } = {}) {
  if (!input || typeof input !== 'object' || !env.ORCA_AGENT_PANE) return null
  if (!AGENT_TOOLS.has(input.tool_name)) return null
  const tool = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  const subagentType = typeof tool.subagent_type === 'string' && tool.subagent_type.trim() ? tool.subagent_type.trim() : 'general-purpose'
  if (READ_ONLY.has(subagentType)) return null
  const data = flowDir(env, home)
  if (readJson(join(data, 'config.json'))?.delegationCheck === 'off') return null
  const cwd = resolve(input.cwd || process.cwd())
  const session = typeof input.session_id === 'string' ? input.session_id : null
  const role = hookRole({ cwd, home, data, session, first: () => firstPromptOf(input.transcript_path) })
  if (role !== 'coordinator' && role !== 'lead') return null
  // A transcript that cannot be read leaves the user's latest prompt unknown: allow, as any error does.
  let transcript
  try { transcript = readFileSync(input.transcript_path, 'utf8') } catch { return null }
  const prompt = latestPromptInfo(transcript)
  if (prompt.command || asksForSubagent(prompt.text)) return null
  return {
    output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyReason({ role, subagentType, script }) } },
    logFile: join(data, 'delegation.jsonl'),
    log: { at: new Date().toISOString(), session, role, subagentType, description: typeof tool.description === 'string' ? tool.description : null }
  }
}

async function main() {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const verdict = decide(JSON.parse(raw))
    if (!verdict) return
    try {
      mkdirSync(dirname(verdict.logFile), { recursive: true })
      appendFileSync(verdict.logFile, `${JSON.stringify(verdict.log)}\n`)
    } catch {}
    process.stdout.write(`${JSON.stringify(verdict.output)}\n`)
  } catch {}
}

// Run as the hook, not when a test imports it. Never exit non-zero: Claude Code would show the error.
if (process.argv[1]?.endsWith('delegation-check.mjs')) {
  process.exitCode = 0
  await main()
}
