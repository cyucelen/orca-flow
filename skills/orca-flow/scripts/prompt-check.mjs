#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: the quiet half of the message-format check. When the Stop hook
// (stop-check.mjs) found only silent-tier misses in an agent's last message, it left a reminder for
// that session; at the agent's next prompt this hook hands it to the agent as additionalContext,
// which the user does not see, and deletes it, so each reminder is given once. Same gates as the
// Stop hook: an Orca pane, the user's opt-in for this folder, a coordinator or a lead.
// It also gives the sidebar's skill-reload note to a session a "Reload skills" request names
// (reload-check.mjs, skill-reload.mjs); that needs no opt-in.
// Any error: exit 0, no output.
//
// Environment for tests: HOME moves ~ (and ~/orca/coordinators), ORCA_FLOW_DIR moves ~/.orca-flow.
import { readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { gate, reminderFile, specOf } from './stop-check.mjs'
import { reloadNote } from './reload-check.mjs'

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
    'A note from Orca Flow for you, not for the user (do not mention or answer it). Your last message broke these format rules:',
    ...rules.map((r) => `- ${r.rule}: ${r.detail ?? ''}`.trimEnd()),
    `Follow them in your next message. Leave the last one as it is. The rules are in ${specOf(script)}.`
  ].join('\n')
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
}

/**
 * Both notes this hook gives, in one output: the format reminder (opt-in) and the sidebar's
 * skill-reload note (reload-check.mjs; needs no opt-in, only a request naming this session).
 */
export function promptNotes(input, options = {}) {
  let reminder = null
  let reload = null
  try { reminder = remind(input, options)?.hookSpecificOutput.additionalContext ?? null } catch {}
  try { reload = reloadNote(input, 'UserPromptSubmit', options) } catch {}
  const text = [reload, reminder].filter(Boolean).join('\n\n')
  return text ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } : null
}

async function main() {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const out = promptNotes(JSON.parse(raw))
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`)
  } catch {}
}

// Run as the hook, not when a test imports it. Never exit non-zero: Claude Code would show the error.
if (process.argv[1]?.endsWith('prompt-check.mjs')) {
  process.exitCode = 0
  await main()
}
