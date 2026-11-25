#!/usr/bin/env node
// Claude Code SessionStart hook: gives a lead its role back when its session resumes or compacts.
// A lead's instructions came once, with its first prompt ("Your role: lead") or when the user made
// it a lead later (recorded with `orca-flow role lead`, see roles.mjs). After a resume or a
// compaction nothing but the compaction summary carried them. On source `resume` and `compact`,
// and on `startup` only for a session with a record, a lead (hookRole in stop-check.mjs, the same
// rule the Stop hook and the sidebar use) gets a short bootstrap as additionalContext: its role and
// the two files to read again. Anyone else (a coordinator, a worker, a chat the user started, a
// cleared record) gets nothing. Not gated by the messageFormat opt-in. On resume and compact it also
// gives the sidebar's skill-reload note to a session a "Reload skills" request names
// (reload-check.mjs): a compaction or a resume is a turn boundary too. Any error: exit 0, no output.
//
// Environment for tests: HOME moves ~ (and ~/orca/coordinators), ORCA_FLOW_DIR moves ~/.orca-flow.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { flowDir, recordedRole } from './roles.mjs'
import { firstPromptOf, hookRole, skillOf } from './stop-check.mjs'
import { reloadNote } from './reload-check.mjs'

/** What a lead reads at once, with the skill's files as the agent reaches them (through the link). */
export function leadBootstrap(skill) {
  return [
    'Your role: lead. (Orca Flow restates it each time this session resumes or is compacted.)',
    `Read ${join(skill, 'SKILL.md')} and ${join(skill, 'roles', 'lead.md')} now and follow the lead role.`,
    'Implementation and parallel work go to tracked Orca workers (orca-flow dispatch, or plan start for several tasks), never to native subagents; those are only for read-only lookups (Explore).',
    "Before the first worker on a new fix or workstream whose plan isn't in the user's own words (a bug, a ticket, a handed plan), question the user one question per turn and start workers only after their yes on the plan.",
    'If you were dispatched, worker_done applies to the whole workstream, not to a first deliverable: send it only when the user says the workstream is done or the PR is merged.'
  ].join('\n')
}

/** The hook's answer: the additionalContext output for a lead, else null. */
export function bootstrap(input, { env = process.env, home = homedir(), script = process.argv[1] } = {}) {
  if (!input || typeof input !== 'object' || !env.ORCA_AGENT_PANE) return null
  const source = input.source
  if (source !== 'resume' && source !== 'compact' && source !== 'startup') return null
  const data = flowDir(env, home)
  const session = input.session_id
  // A fresh start carries its role line in its own first prompt; only a record needs restating.
  if (source === 'startup' && recordedRole(data, session) !== 'lead') return null
  const cwd = resolve(input.cwd || process.cwd())
  const role = hookRole({ cwd, home, data, session, first: () => firstPromptOf(input.transcript_path) })
  if (role !== 'lead') return null
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: leadBootstrap(skillOf(script)) } }
}

/** Both notes this hook gives, in one output: a lead's bootstrap and, on resume or compact, the skill-reload note. */
export function startNotes(input, options = {}) {
  let lead = null
  let reload = null
  try { lead = bootstrap(input, options)?.hookSpecificOutput.additionalContext ?? null } catch {}
  if (input?.source === 'resume' || input?.source === 'compact') try { reload = reloadNote(input, 'SessionStart', options) } catch {}
  const text = [lead, reload].filter(Boolean).join('\n\n')
  return text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : null
}

async function main() {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const out = startNotes(JSON.parse(raw))
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`)
  } catch {}
}

// Run as the hook, not when a test imports it. Never exit non-zero: Claude Code would show the error.
if (process.argv[1]?.endsWith('session-start.mjs')) {
  process.exitCode = 0
  await main()
}
