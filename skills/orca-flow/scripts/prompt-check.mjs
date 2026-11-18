#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: the quiet half of the message-format check. When the Stop hook
// (stop-check.mjs) found only silent-tier misses in an agent's last message, it left a reminder for
// that session; at the agent's next prompt this hook hands it to the agent as additionalContext,
// which the user does not see, and deletes it, so each reminder is given once. Same gates as the
// Stop hook: an Orca pane, the user's opt-in for this folder, a coordinator or a lead.
// Any error: exit 0, no output.
//
// Environment for tests: HOME moves ~ (and ~/orca/coordinators), ORCA_FLOW_DIR moves ~/.orca-flow.
import { readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { gate, reminderFile, specOf } from './stop-check.mjs'

/** The hook's answer: the additionalContext output, or null. Consumes the reminder it reads. */
export function remind(input, { env = process.env, home = homedir(), script = process.argv[1] } = {}) {
  const g = gate(input, { env, home })
  if (!g) return null
  const file = reminderFile(g.data, input.session_id)
  if (!file) return null
  let entry
  try {
    entry = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  // Given once, even when what follows fails.
  try {
    unlinkSync(file)
  } catch {
    return null
  }
  const rules = Array.isArray(entry?.rules) ? entry.rules.filter((r) => r && typeof r.rule === 'string') : []
  if (!rules.length) return null
  const text = [
    'Orca Flow message-format note for you, not for the user (do not mention or answer it): your last message to the user missed these frame rules.',
    ...rules.map((r) => `- ${r.rule}: ${r.detail ?? ''}`.trimEnd()),
    `Keep them in your next message. Do not rewrite the last one. The rules are in ${specOf(script)}.`
  ].join('\n')
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
}

async function main() {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const out = remind(JSON.parse(raw))
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`)
  } catch {}
}

// Run as the hook, not when a test imports it. Never exit non-zero: Claude Code would show the error.
if (process.argv[1]?.endsWith('prompt-check.mjs')) {
  process.exitCode = 0
  await main()
}
