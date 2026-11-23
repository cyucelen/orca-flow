#!/usr/bin/env node
// Antigravity CLI (agy) hook: the sidebar's "Reload skills" note for Antigravity sessions, through
// agy's documented hooks (https://antigravity.google/docs/hooks/), installed by src/antigravity-hooks.ts
// in ~/.gemini/config/hooks.json under the hook name "orca-flow-reload", next to Orca's "orca-status".
//
//   agy-hook.mjs PreInvocation   before each model call (the user's next prompt, and after each tool
//                                call inside a turn): the note as {"injectSteps":[{"ephemeralMessage":…}]},
//                                once per request, as reload-check.mjs gives it to Claude Code and Codex
//   agy-hook.mjs PostToolUse     after run_command: records the confirmation when the agent ran
//                                `orca-flow skills-reloaded` (agy's terminal sandbox may refuse that
//                                command's write to ~/.orca-flow); agy's PostToolUse cannot inject
//
// agy hooks read camelCase JSON on stdin (conversationId, workspacePaths, transcriptPath,
// invocationNum, toolCall {name, args}) and answer one JSON object on stdout; anything else, or any
// error, answers {} (what Orca's own Antigravity hook answers). The pane comes from the env Orca gives
// its terminals (ORCA_PANE_KEY, which Orca's own Antigravity hook reads), else the conversation id
// matches the request's session. Fixture-tested only: agy was not installed where this was written.
import { recordConfirm, reloadNote } from './reload-check.mjs'

/** agy's hook input in the shape the shared reload code reads (Claude Code's snake_case). */
export function fromAgy(input) {
  if (!input || typeof input !== 'object') return null
  const paths = Array.isArray(input.workspacePaths) ? input.workspacePaths.filter((p) => typeof p === 'string') : []
  return {
    session_id: typeof input.conversationId === 'string' ? input.conversationId : undefined,
    cwd: paths[0],
    transcript_path: typeof input.transcriptPath === 'string' ? input.transcriptPath : undefined,
    ...(input.toolCall && typeof input.toolCall === 'object' ? { tool_name: input.toolCall.name, tool_input: { command: commandOf(input.toolCall.args) } } : {})
  }
}

/** The shell command of a run_command call: agy does not document its argument names, so the first string argument that runs orca-flow, else the first string. */
function commandOf(args) {
  if (typeof args === 'string') return args
  if (!args || typeof args !== 'object') return undefined
  const strings = Object.values(args).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []))
  return strings.find((s) => /skills-reloaded/.test(s)) ?? strings[0]
}

/** The hook's answer for one event. Never throws. */
export function agyAnswer(event, raw, options = {}) {
  try {
    const input = fromAgy(raw)
    if (!input) return {}
    if (event === 'PostToolUse') {
      recordConfirm(input, options)
      return {}
    }
    if (event === 'PreInvocation') {
      // The first model call of a turn answers the user's message; later ones continue the turn.
      const note = reloadNote(input, raw.invocationNum > 0 ? 'PostToolUse' : 'UserPromptSubmit', options)
      return note ? { injectSteps: [{ ephemeralMessage: note }] } : {}
    }
  } catch {}
  return {}
}

async function main() {
  let out = {}
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    out = agyAnswer(process.argv[2], JSON.parse(raw))
  } catch {}
  process.stdout.write(`${JSON.stringify(out)}\n`)
}

// Run as the hook, not when a test imports it. Never exit non-zero.
if (process.argv[1]?.endsWith('agy-hook.mjs')) {
  process.exitCode = 0
  await main()
}
