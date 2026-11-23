// Skill reload: running agents re-read their updated skill instructions in the same conversation.
//
// Updating the plugin (or `orca skills update`) changes the skill files on disk, but an agent that
// read SKILL.md and its role file an hour ago keeps that text in its conversation. Claude Code's own
// `/reload-skills` re-sends only the skill listing (names and descriptions), never the body of a
// skill already read, and it would have to be typed into the agent's input. So the sidebar's
// "Reload skills" writes a request here, and our Claude Code hooks hand each targeted session a
// short note at its next turn boundary (UserPromptSubmit, SessionStart on resume/compact) or, for a
// busy one, after its next tool call (PostToolUse): re-read the files from disk, then confirm with
// `orca-flow skills-reloaded`. Nothing is typed into a terminal and no mail is sent.
//
// ~/.orca-flow/skill-reload/ (ORCA_FLOW_DIR moves it):
//   requests.json            { version: 1, targets: { <pane>: Target } }, written by the plugin worker
//   active                   exists while a supported target waits for delivery; the PostToolUse
//                            hook's shell gate checks it, so no node starts on other tool calls
//   delivered/<pane>.<id>    created once per request and pane (exclusive create): the note is given once
//   confirmed/<pane>.json    { pane, session, hash, request, at }, written by `orca-flow skills-reloaded`,
//                            or by the PostToolUse hook when it sees that command run: a sandboxed
//                            shell (Codex's workspace-write) cannot write ~/.orca-flow, hooks can
// "Confirmed" means a confirmation whose hash equals the request's hash. No dependencies.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join, relative } from 'node:path'

export const RELOAD_DIR = 'skill-reload'
/** A request older than this is gone: its note is no longer given and the sidebar forgets it. */
export const RELOAD_TTL_MS = 24 * 3600_000
export const ROLES = ['coordinator', 'lead', 'worker', 'chat']

export const reloadDir = (data) => join(data, RELOAD_DIR)
export const activeFile = (data) => join(reloadDir(data), 'active')
const requestsFile = (data) => join(reloadDir(data), 'requests.json')
/** A pane key or session id as a file name. */
export const fileKey = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
export const deliveredFile = (data, pane, request) => join(reloadDir(data), 'delivered', `${fileKey(pane)}.${fileKey(request)}`)
export const confirmedFile = (data, key) => join(reloadDir(data), 'confirmed', `${fileKey(key)}.json`)

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

/**
 * A short hash of what an agent reads from the skill: every .md file under its folder (SKILL.md,
 * roles/, messages.md, templates/), by relative path and content. Scripts are run, not read, so a
 * script-only change asks no one to re-read. Through a link, the files it points at.
 */
export function skillHash(skill) {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (dir === skill && name === 'scripts') continue
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      else if (name.endsWith('.md')) files.push(path)
    }
  }
  walk(skill)
  const h = createHash('sha256')
  for (const f of files) h.update(`${relative(skill, f)}\0`).update(readFileSync(f)).update('\0')
  return h.digest('hex').slice(0, 16)
}

/** Every target of an unexpired request, by pane; an empty store when the file is missing or broken. */
export function readRequests(data, now = Date.now()) {
  const file = readJson(requestsFile(data), {})
  const targets = isObject(file?.targets) ? file.targets : {}
  return Object.fromEntries(Object.entries(targets).filter(([pane, t]) => pane && isObject(t) && typeof t.request === 'string' && typeof t.hash === 'string' && Number(t.expiresAt) > now))
}

/** True when this pane has had the note for its request. */
export const wasDelivered = (data, pane, request) => existsSync(deliveredFile(data, pane, request))

/** The latest confirmation for a pane, else for a session; null when none. */
export function readConfirmation(data, { pane, session }) {
  for (const key of [pane, session]) {
    if (!key) continue
    const c = readJson(confirmedFile(data, key), null)
    if (isObject(c) && typeof c.hash === 'string') return c
  }
  return null
}

/** Confirmed: a confirmation of this exact hash, made after the request. */
export const isConfirmed = (target, confirmation) =>
  Boolean(confirmation && confirmation.hash === target.hash && Number(confirmation.at) >= Number(target.at))

/** Supported targets whose note has not been given yet. */
export function pendingTargets(data, now = Date.now()) {
  return Object.entries(readRequests(data, now)).filter(([pane, t]) => t.supported !== false && !wasDelivered(data, pane, t.request))
}

/** How long after its note a target keeps the PostToolUse gate open, so the hook can record its confirmation. */
export const CONFIRM_WINDOW_MS = 30 * 60_000

/** When the note was given to this pane for this request (ms), or null. */
function deliveredAt(data, pane, request) {
  const d = readJson(deliveredFile(data, pane, request), null)
  return isObject(d) && Number.isFinite(Number(d.at)) ? Number(d.at) : null
}

/** Targets that got the note within the confirmation window and have not confirmed it. */
export function readingTargets(data, now = Date.now()) {
  return Object.entries(readRequests(data, now)).filter(([pane, t]) => {
    if (t.supported === false) return false
    const at = deliveredAt(data, pane, t.request)
    return at !== null && now - at < CONFIRM_WINDOW_MS && !isConfirmed(t, readConfirmation(data, { pane, session: t.session }))
  })
}

/**
 * Keeps the PostToolUse gate file in step: present while a note is undelivered, or was given in the
 * last 30 minutes and is not confirmed yet (the hook may still record the confirmation).
 */
export function syncActive(data, now = Date.now()) {
  const waiting = pendingTargets(data, now).length > 0 || readingTargets(data, now).length > 0
  try {
    if (waiting) {
      mkdirSync(reloadDir(data), { recursive: true })
      writeFileSync(activeFile(data), `${now}\n`)
    } else rmSync(activeFile(data), { force: true })
  } catch {}
  return waiting
}

/**
 * Writes a request for these targets (each { pane, session, role, provider, supported, title }) with
 * the skill's current hash. A pane's newer request replaces its older one; expired ones are dropped.
 */
export function writeRequest(data, targets, { hash, scope, now = Date.now(), ttl = RELOAD_TTL_MS, id = `r${now.toString(36)}` }) {
  const kept = readRequests(data, now)
  for (const t of targets) {
    if (!t?.pane) continue
    kept[t.pane] = {
      request: id, at: now, expiresAt: now + ttl, hash, scope,
      role: ROLES.includes(t.role) ? t.role : 'worker',
      session: t.session || null,
      provider: t.provider || null,
      supported: t.supported !== false,
      ...(t.supported === false && typeof t.reason === 'string' && t.reason ? { reason: t.reason.slice(0, 200) } : {}),
      title: typeof t.title === 'string' ? t.title.slice(0, 120) : ''
    }
  }
  writeJson(requestsFile(data), { version: 1, targets: kept })
  syncActive(data, now)
  return { id, hash, count: targets.length }
}

/** The target this hook run is for: by its Orca pane, else by its Claude session id. Only supported ones. */
export function targetFor(requests, { pane, session }) {
  const byPane = pane ? requests[pane] : undefined
  if (byPane && byPane.supported !== false) return [pane, byPane]
  if (session) for (const [p, t] of Object.entries(requests)) if (t.session === session && t.supported !== false) return [p, t]
  return null
}

const ROLE_FILE = { coordinator: 'coordinator.md', lead: 'lead.md', worker: 'worker.md' }
const NEXT = {
  UserPromptSubmit: 'Then answer the user\'s message as you would have.',
  PostToolUse: 'Then continue the task you were doing, from where you were.',
  SessionStart: 'Then continue as you would have.'
}

/** The note an agent gets: what to re-read for its role, how to confirm, and that nothing else changes. */
export function reloadText({ skill, role, request, event }) {
  const own = ROLE_FILE[role]
  const files = role === 'chat'
    ? [`- ${join(skill, 'SKILL.md')}, if you loaded the orca-flow skill in this conversation`]
    : [`- ${join(skill, 'SKILL.md')}`, `- ${join(skill, 'roles', own)} (your role: ${role})`]
  return [
    `A note from Orca Flow for you, not for the user: the user updated the skill files on disk and asked running agents to reload them (request ${request}).`,
    'Re-read these from disk now (open each file again), even if you read them earlier in this conversation. Where the new text differs, it replaces what you remember:',
    ...files,
    '- the SKILL.md of any other skill you loaded in this conversation (for example orchestration or orca-cli), from the folder it loaded from.',
    `Then record it: node ${join(skill, 'scripts', 'orca-flow.mjs')} skills-reloaded --request ${request}`,
    'Nothing else changes: keep your current task, open asks, pending decisions and run ownership exactly as they are. Do not answer, close or drop an open ask because of this note; send no messages, start no Runs or workers and send no worker_done because of it; do not mention it to the user unless they ask.',
    NEXT[event] ?? NEXT.SessionStart
  ].join('\n')
}

/**
 * The hooks' half: the note for this session, at most once per request, or null. `role(target)`
 * decides the role (the hooks pass hookRole, falling back to the sidebar's). A subagent's tool call
 * (agent_id in the input) never takes it: the note belongs to the main conversation.
 */
export function deliverReload(input, { event, pane, data, skill, role = (t) => t.role, now = Date.now() }) {
  if (!isObject(input) || input.agent_id || !data) return null
  const session = typeof input.session_id === 'string' ? input.session_id : null
  const hit = targetFor(readRequests(data, now), { pane, session })
  if (!hit) return null
  const [key, target] = hit
  if (isConfirmed(target, readConfirmation(data, { pane: key, session }))) return null
  // Exclusive create: of two hooks racing (parallel tool calls), one gives the note.
  const file = deliveredFile(data, key, target.request)
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const fd = openSync(file, 'wx')
    writeSync(fd, JSON.stringify({ at: now, event, session }))
    closeSync(fd)
  } catch {
    return null
  }
  syncActive(data, now)
  const r = role(target)
  return reloadText({ skill, role: ROLES.includes(r) ? r : 'worker', request: target.request, event })
}

/** The confirm command in a shell command line: `orca-flow skills-reloaded` or `node …/orca-flow.mjs skills-reloaded`, and its --request id. */
const CONFIRM_COMMAND = /(?:^|[;&|(]\s*|\s)(?:node\s+)?['"]?[^\s'"]*orca-flow(?:\.mjs)?['"]?\s+skills-reloaded\b([^;&|\n]*)/

/** The request id a tool call's command confirms (or '' when it names none); null when it runs no confirm command. */
export function confirmCommandOf(input) {
  const cmd = input?.tool_input?.command ?? input?.tool_input?.cmd
  const line = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : null
  const m = line && CONFIRM_COMMAND.exec(line)
  if (!m) return null
  return /--request[ =]['"]?([A-Za-z0-9._-]+)/.exec(m[1])?.[1] ?? ''
}

/**
 * The PostToolUse hook's half of the confirmation: when this session just ran the confirm command
 * for its delivered request, record it here, outside any sandbox, with the hash of the files as they
 * are now. Nothing for another session, an undelivered note, another request id, or a subagent.
 */
export function confirmFromToolCall(input, { pane, data, skill, now = Date.now() }) {
  if (!isObject(input) || input.agent_id || !data) return false
  const request = confirmCommandOf(input)
  if (request === null) return false
  const session = typeof input.session_id === 'string' ? input.session_id : null
  const hit = targetFor(readRequests(data, now), { pane, session })
  if (!hit) return false
  const [key, target] = hit
  if ((request && request !== target.request) || !wasDelivered(data, key, target.request)) return false
  if (isConfirmed(target, readConfirmation(data, { pane: key, session }))) return false
  writeJson(confirmedFile(data, key), { pane: key, session, hash: skillHash(skill), request: target.request, at: now, by: 'hook' })
  syncActive(data, now)
  return true
}

/**
 * `orca-flow skills-reloaded`: records that this session re-read the skill, with the hash of the
 * files as they are now. Keyed by the Orca pane (ORCA_AGENT_PANE, ORCA_PANE_KEY in Codex), else by
 * the session (Claude Code's, or the Codex thread).
 */
export function confirmReload(data, { pane, session, skill, request, now = Date.now() }) {
  if (!pane && !session) throw new Error('no Orca pane or Claude Code session found: nothing to record')
  const hash = skillHash(skill)
  const entry = { pane: pane || null, session: session || null, hash, request: request || null, at: now }
  writeJson(confirmedFile(data, pane || session), entry)
  const hit = targetFor(readRequests(data, now), { pane, session })
  syncActive(data, now)
  if (hit && hit[1].hash !== hash) return { entry, message: `Recorded, but the skill changed again since the request (asked for ${hit[1].hash}, read ${hash}). Read the files once more and run this again.` }
  return { entry, message: `Recorded: skills reloaded (orca-flow ${hash}).` }
}

/**
 * What the sidebar shows per pane for unexpired requests: waiting (not delivered: its next turn has
 * not come), reading (the note was given, no matching confirmation yet), reloaded (confirmed for
 * this hash) or unsupported (a provider with no live reload: restart to reload).
 */
export function reloadStatus(data, now = Date.now()) {
  return Object.entries(readRequests(data, now)).map(([pane, t]) => {
    const base = { pane, role: t.role, provider: t.provider, at: t.at, expiresAt: t.expiresAt, request: t.request }
    if (t.supported === false) return { ...base, state: 'unsupported', ...(t.reason ? { reason: t.reason } : {}) }
    const c = readConfirmation(data, { pane, session: t.session })
    if (isConfirmed(t, c)) return { ...base, state: 'reloaded', doneAt: Number(c.at) }
    return { ...base, state: wasDelivered(data, pane, t.request) ? 'reading' : 'waiting' }
  })
}
