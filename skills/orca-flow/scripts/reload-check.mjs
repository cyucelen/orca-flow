#!/usr/bin/env node
// Claude Code (and Codex) PostToolUse hook: hands a busy agent the sidebar's skill-reload note after its next
// tool call, so a worker deep in a long turn re-reads its updated skill without waiting for a new
// prompt (skill-reload.mjs). Its settings.json entry starts node only while
// ~/.orca-flow/skill-reload/active exists (some target still waits), so other tool calls cost a
// file test. Given at most once per request and pane, whichever hook comes first. It also records the
// confirmation when the agent runs `orca-flow skills-reloaded`: hooks run outside the agent's sandbox,
// which (Codex workspace-write) cannot write ~/.orca-flow. Any error: exit 0, no output.
//
// Environment for tests: HOME moves ~ (and ~/orca/coordinators), ORCA_FLOW_DIR moves ~/.orca-flow.
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { flowDir } from './roles.mjs'
import { confirmFromToolCall, deliverReload } from './skill-reload.mjs'
import { firstPromptOf, hookRole, skillOf } from './stop-check.mjs'

/**
 * A target's role: what the sidebar said when it asked (its role reader, summarize.ts roleOf, knows a
 * dispatched worker in a coordinator's folder is a worker), except that hookRole's lead wins: the
 * user may have made it a lead (`orca-flow role lead`) after its last summary. With no sidebar
 * role, hookRole alone (the rule the Stop and SessionStart hooks use), else worker.
 */
export function targetRole(target, hook) {
  if (hook === 'lead' && target?.role !== 'coordinator') return 'lead'
  return target?.role ?? hook ?? 'worker'
}

/** The note for a targeted session, or null (not an Orca pane, not targeted, already given or confirmed). */
export function reloadNote(input, event, { env = process.env, home = homedir(), script = process.argv[1], now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || !env.ORCA_AGENT_PANE) return null
  const data = flowDir(env, home)
  const cwd = resolve(input.cwd || process.cwd())
  const role = (target) => targetRole(target, hookRole({ cwd, home, data, session: input.session_id, first: () => firstPromptOf(input.transcript_path) }))
  return deliverReload(input, { event, pane: env.ORCA_AGENT_PANE, data, skill: skillOf(script), role, now })
}

/** Records the confirmation of a targeted session whose tool call just ran `orca-flow skills-reloaded`. */
export function recordConfirm(input, { env = process.env, home = homedir(), script = process.argv[1], now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || !env.ORCA_AGENT_PANE) return false
  return confirmFromToolCall(input, { pane: env.ORCA_AGENT_PANE, data: flowDir(env, home), skill: skillOf(script), now })
}

async function main() {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const input = JSON.parse(raw)
    // The confirm command just ran: record it here, since a sandboxed shell may not have been able to.
    try { recordConfirm(input) } catch {}
    const note = reloadNote(input, 'PostToolUse')
    if (note) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } })}\n`)
  } catch {}
}

// Run as the hook, not when a test imports it. Never exit non-zero: Claude Code would show the error.
if (process.argv[1]?.endsWith('reload-check.mjs')) {
  process.exitCode = 0
  await main()
}
