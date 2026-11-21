// The recorded lead role. Until now a lead was known only by "Your role: lead" in its first prompt;
// a session the user made a lead later (a dispatched worker they kept steering, a chat they started)
// had nothing that said so. `orca-flow role lead` records it here, keyed by the Claude session id,
// and every role reader honors it: the SessionStart hook (session-start.mjs) that gives a lead its
// instructions back on resume and compaction, the Stop hook's gate (stop-check.mjs) and the
// sidebar's roleOf (src/summarize.ts).
//
// ~/.orca-flow/roles.json (ORCA_FLOW_DIR moves it): { "<session id>": { role: "lead", at, by, cwd } }
// Only "lead" is recorded; `orca-flow role clear` removes the entry. No dependencies.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ROLES_FILE = 'roles.json'

/** The orca-flow data folder: ORCA_FLOW_DIR, else ~/.orca-flow. */
export const flowDir = (env = process.env, home = homedir()) => env.ORCA_FLOW_DIR || join(home, '.orca-flow')

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every record; an empty store when the file is missing or broken. */
export function readRoles(data = flowDir()) {
  try {
    const roles = JSON.parse(readFileSync(join(data, ROLES_FILE), 'utf8'))
    return isObject(roles) ? roles : {}
  } catch {
    return {}
  }
}

/** The role recorded for a session ('lead'), or null. */
export function recordedRole(data, session) {
  if (typeof session !== 'string' || !session) return null
  const entry = readRoles(data)[session]
  return isObject(entry) && entry.role === 'lead' ? 'lead' : null
}

function writeRoles(data, roles) {
  mkdirSync(data, { recursive: true })
  const path = join(data, ROLES_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(roles, null, 2)}\n`)
  renameSync(tmp, path)
}

/** Records a session as a lead (once: a second call refreshes the entry). */
export function recordLead(data, session, { by = 'user', cwd, at = new Date().toISOString() } = {}) {
  const roles = readRoles(data)
  roles[session] = { role: 'lead', at, by, ...(cwd ? { cwd } : {}) }
  writeRoles(data, roles)
  return roles[session]
}

/** Removes a session's record. True when there was one. */
export function clearRole(data, session) {
  const roles = readRoles(data)
  if (!(session in roles)) return false
  delete roles[session]
  writeRoles(data, roles)
  return true
}

/**
 * The Claude Code session this command runs in. Claude Code gives its Bash tool the session id as
 * CLAUDE_CODE_SESSION_ID (CLAUDE_SESSION_ID is accepted too). Inside Claude Code without it (an
 * older version), the newest transcript in the profile's project folder for cwd is the session that
 * is writing right now. Outside Claude Code (Codex, Antigravity, a plain shell) there is no Claude
 * session to record: null, never a guess from another agent's transcripts.
 */
export function currentSession({ env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  const id = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID
  if (id) return { id, from: env.CLAUDE_CODE_SESSION_ID ? 'CLAUDE_CODE_SESSION_ID' : 'CLAUDE_SESSION_ID' }
  if (env.CLAUDECODE !== '1') return null
  const config = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const project = join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  if (!existsSync(project)) return null
  let newest = null
  for (const name of readdirSync(project)) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const at = statSync(join(project, name)).mtimeMs
      if (!newest || at > newest.at) newest = { name, at }
    } catch {}
  }
  return newest ? { id: newest.name.slice(0, -'.jsonl'.length), from: `the newest transcript in ${project}` } : null
}
