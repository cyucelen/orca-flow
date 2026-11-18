#!/usr/bin/env node
// Claude Code Stop hook: checks the last message of an Orca coordinator or lead against the agent
// message frame (frame.mjs; the spec is ../messages.md). A miss of the block tier (the sidebar or
// the user cannot read the ask) stops the turn once and asks the agent to rewrite the frame. A miss
// of the silent tier only leaves a reminder that prompt-check.mjs adds, unseen by the user, at the
// agent's next prompt.
// The plugin installs it in the Claude profile's settings.json. It does nothing unless all hold:
// the agent runs in an Orca pane (ORCA_AGENT_PANE), the user opted in with "messageFormat" in
// ~/.orca-flow/config.json ("all", or a list of folders), and the agent is a coordinator or a lead.
// Each miss is logged to ~/.orca-flow/format-misses.jsonl with its tier; reminders wait in
// ~/.orca-flow/reminders/<session>.json. Any error: exit 0, silently.
//
// Environment for tests: HOME moves ~ (and ~/orca/coordinators), ORCA_FLOW_DIR moves ~/.orca-flow.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const LEAD = /your role: lead\b/i
/** After a miss the agent rewrites only the frame: the user already read the detail above it. */
export const FRAME_ONLY = 'Rewrite only the frame at the bottom, from the status line down. Do not repeat the detail above it: the user already read it.'

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const within = (path, root) => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`)

/** "all", or a list of folders that holds cwd (the folder itself or one below it). */
export function optedIn(setting, cwd, home = homedir()) {
  if (setting === 'all') return true
  if (!Array.isArray(setting)) return false
  return setting.some((p) => typeof p === 'string' && p.trim() && within(cwd, resolve(p.trim().replace(/^~(?=\/|$)/, home))))
}

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : ''

/** The first user prompt and the last assistant text of the latest turn, from transcript lines. */
export function readTranscript(lines) {
  let first = null
  let last = null
  let lastId = null
  for (const line of lines) {
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isSidechain) continue
    const content = d.message?.content
    if (d.type === 'user') {
      if (Array.isArray(content) && content.some((c) => c?.type === 'tool_result')) continue
      const text = textOf(content).trim()
      if (!text) continue
      if (first === null) first = text
      last = null // a new turn starts
      lastId = null
    } else if (d.type === 'assistant') {
      const text = textOf(content).trim()
      if (!text) continue
      // One message can arrive as several lines, one per content block.
      const id = d.message?.id ?? null
      last = id && id === lastId && last ? `${last}\n${text}` : text
      lastId = id
    }
  }
  return { first: first ?? '', last: last ?? '' }
}

/**
 * The gates both hooks share: an Orca pane, the user's opt-in for this folder, and a coordinator
 * (by its folder) or a lead (by its first prompt). Null when any fails.
 */
export function gate(input, { env = process.env, home = homedir() } = {}) {
  const pane = env.ORCA_AGENT_PANE
  if (!input || !pane) return null
  const data = env.ORCA_FLOW_DIR || join(home, '.orca-flow')
  const cwd = resolve(input.cwd || process.cwd())
  if (!optedIn(readJson(join(data, 'config.json'), {}).messageFormat, cwd, home)) return null
  let transcript = null
  const lines = () => {
    if (transcript) return transcript
    try {
      transcript = readTranscript(readFileSync(input.transcript_path, 'utf8').split('\n'))
    } catch {
      transcript = { first: '', last: '' }
    }
    return transcript
  }
  const role = within(cwd, join(home, 'orca', 'coordinators')) ? 'coordinator' : LEAD.test(lines().first) ? 'lead' : null
  return role ? { pane, data, cwd, role, lines } : null
}

/** Where a session's pending reminder waits; null without a usable session id. */
export function reminderFile(data, session) {
  const key = String(session ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
  return key && key !== '.' && key !== '..' ? join(data, 'reminders', `${key}.json`) : null
}

/** The spec as the agent reached a script, through the skill link, not where the link points. */
export const specOf = (script) => join(dirname(dirname(resolve(script))), 'messages.md')

/**
 * Decides the hook's answer: null to let the agent stop quietly with nothing to log; else the log
 * lines (one per tier that missed), and either the block (any block-tier miss: the reason names
 * every miss, so the rewrite fixes them all) or the reminder for the next prompt (silent only).
 */
export function judge(input, { env = process.env, home = homedir(), script = process.argv[1], checkFrame }) {
  if (!input || input.stop_hook_active) return null
  const g = gate(input, { env, home })
  if (!g) return null
  const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : g.lines().last
  if (!message.trim()) return null
  const { ok, misses } = checkFrame(message, { role: g.role })
  if (ok) return null

  const at = new Date().toISOString()
  const session = input.session_id ?? null
  const tiers = ['block', 'silent'].map((tier) => [tier, misses.filter((m) => (m.tier ?? 'block') === tier)]).filter(([, ms]) => ms.length)
  const logs = tiers.map(([tier, ms]) => ({ at, pane: g.pane, worktree: g.cwd, role: g.role, session, tier, rules: ms.map((m) => m.rule) }))
  const out = { logFile: join(g.data, 'format-misses.jsonl'), logs, output: null, reminder: null }
  const blocking = misses.filter((m) => (m.tier ?? 'block') === 'block')
  if (blocking.length) {
    const silent = misses.filter((m) => m.tier === 'silent')
    const reason = [
      'Your last message does not follow the agent message frame:',
      ...blocking.map((m) => `- ${m.rule}: ${m.detail}`),
      ...(silent.length ? ['Fix these too while you rewrite:', ...silent.map((m) => `- ${m.rule}: ${m.detail}`)] : []),
      FRAME_ONLY,
      `The rules are in ${specOf(script)}.`
    ].join('\n')
    out.output = { decision: 'block', reason }
  } else {
    const file = reminderFile(g.data, session)
    if (file) out.reminder = { file, entry: { at, rules: misses.map(({ rule, detail }) => ({ rule, detail })) } }
  }
  return out
}

async function main() {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const { checkFrame } = await import('./frame.mjs')
    const verdict = judge(JSON.parse(raw), { checkFrame })
    if (!verdict) return
    try {
      mkdirSync(dirname(verdict.logFile), { recursive: true })
      appendFileSync(verdict.logFile, verdict.logs.map((l) => `${JSON.stringify(l)}\n`).join(''))
    } catch {}
    if (verdict.reminder) {
      try {
        const { file, entry } = verdict.reminder
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(entry))
        renameSync(`${file}.${process.pid}.tmp`, file)
      } catch {}
    }
    if (verdict.output) process.stdout.write(`${JSON.stringify(verdict.output)}\n`)
  } catch {}
}

// Run as the hook, not when a test imports it. Never exit non-zero: Claude Code would show the error.
if (process.argv[1]?.endsWith('stop-check.mjs')) {
  process.exitCode = 0
  await main()
}
