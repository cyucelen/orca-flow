// Orca Flow's Codex hooks: the installer (in the system Codex home's ~/.codex/hooks.json, which Orca
// merges into every Orca-managed account when it starts Codex; never trust, config or auth) and the
// read-only readiness the sidebar shows, against fixtures shaped like Orca 1.4.265's merge.
import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_HOOKS, CODEX_REASON, codexHooksFor, codexReloadReadiness, codexTrustHash, ensureCodexHooks, ensureOwnCodexHooks, readHookState } from './codex-hooks.ts'

/** Orca's own Codex hook command (form 2), as it is in a real account's hooks.json. */
const ORCA_CMD = ": orca-agent-hook-form=2; if [ -n \"${ORCA_PANE_KEY-}\" ] && [ -n \"${ORCA_AGENT_HOOK_ROOT-}\" ] && [ -f \"${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh\" ]; then /bin/sh \"${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh\" || :; elif [ -z \"${ORCA_AGENT_HOOK_ROOT-}\" ] && [ -n \"${ORCA_PANE_KEY-}\" ] && [ -n \"${ORCA_AGENT_HOOK_PORT-}\" ] && [ -f \"${HOME-}/.orca/agent-hooks/codex-hook.sh\" ]; then /bin/sh \"${HOME-}/.orca/agent-hooks/codex-hook.sh\" || :; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi"
const orcaGroup = (timeout = 10) => ({ hooks: [{ type: 'command', command: ORCA_CMD, timeout, statusMessage: 'Reporting status to Orca' }] })
const ORCA_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt']
const SKILL = '/u/.agents/skills/orca-flow'
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const LABEL: Record<string, string> = Object.fromEntries(CODEX_HOOKS.map((h) => [h.event, h.label]))

/**
 * A temp HOME: the system Codex home (~/.codex, with the user's own PostToolUse hook on Bash and a
 * config.toml) and one Orca-managed account home like Orca's (marker, Orca-only hooks.json,
 * config.toml with Orca's trust, auth.json).
 */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-hooks-')))
  const system = join(root, '.codex')
  mkdirSync(system)
  writeFileSync(join(system, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-audit', timeout: 5 }] }] }, other: 'kept' }, null, 2))
  writeFileSync(join(system, 'config.toml'), 'model = "gpt-6.2-astra"\n')
  const home = join(root, 'orca', 'codex-accounts', 'acct-1', 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.orca-managed-home'), 'orca\n')
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(ORCA_EVENTS.map((e) => [e, [orcaGroup(e === 'Interrupt' ? 3 : 10)]])) }, null, 2))
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.2-astra"\n\n[hooks.state."/x/hooks.json:stop:0:0"]\nenabled = true\ntrusted_hash = "sha256:abc"\n')
  writeFileSync(join(home, 'auth.json'), '{"secret":"never read"}')
  return { root, system, home }
}

/**
 * What Orca does when it starts Codex (hookPass install): the account's hooks.json becomes Orca's group
 * first in each of its events, then the system home's groups for that event; nothing else survives.
 */
function orcaMerge(system: string, home: string) {
  const sys = read(join(system, 'hooks.json')).hooks ?? {}
  const merged: Record<string, unknown[]> = {}
  for (const e of new Set([...ORCA_EVENTS, ...Object.keys(sys)])) merged[e] = [...(ORCA_EVENTS.includes(e) ? [orcaGroup(e === 'Interrupt' ? 3 : 10)] : []), ...(sys[e] ?? [])]
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: merged }, null, 2))
}

/** A [hooks.state] table as Codex writes it when the user trusts a hook. */
function trust(source: string, event: string, group: number, extra = '', hash?: string) {
  const command = codexHooksFor(undefined, SKILL).find((h) => h.event === event)!.entry.hooks[0].command
  return `\n[hooks.state."${source}:${LABEL[event]}:${group}:0"]\n${extra}trusted_hash = "${hash ?? codexTrustHash(LABEL[event], { command, timeout: 10, statusMessage: 'Orca Flow: Reload skills' })}"\n`
}

test('Codex trust hashes: Codex\'s own algorithm, checked against a real account\'s Orca-trusted entries', () => {
  const orca = { command: ORCA_CMD, timeout: 10, statusMessage: 'Reporting status to Orca' }
  assert.equal(codexTrustHash('user_prompt_submit', orca), 'sha256:8ea1302cbe5790e03a4ef2956313c1dd48a55600551e062ee61c3b629e2a39d1')
  assert.equal(codexTrustHash('post_tool_use', orca), 'sha256:b0315c94b3f571e1c012f96f440d38fd05623315bd2b4e228ec279d88fbc9497')
  assert.equal(codexTrustHash('session_start', orca), 'sha256:94b4d1a902ec6b5098ba63efae732f362d7348f600f2a83a4a710ea7db4a5545')
  assert.notEqual(codexTrustHash('post_tool_use', orca, 'Bash'), codexTrustHash('post_tool_use', orca), 'a tool event hashes its matcher')
  assert.equal(codexTrustHash('user_prompt_submit', orca, 'Bash'), codexTrustHash('user_prompt_submit', orca), 'a prompt event does not')
})

test('our three hooks go into ~/.codex/hooks.json once, keeping every other entry and key; never an account home, trust, config or auth', () => {
  const { root, system, home } = setup()
  try {
    const before = read(join(system, 'hooks.json'))
    const account = readFileSync(join(home, 'hooks.json'), 'utf8')
    const config = readFileSync(join(system, 'config.toml'), 'utf8')
    assert.deepEqual(ensureOwnCodexHooks(false, system, SKILL), [`left the Codex hooks in ${join(system, 'hooks.json')} to the installed copy: this is a development folder`])
    assert.deepEqual(read(join(system, 'hooks.json')), before, 'a development folder writes nothing')
    assert.deepEqual(ensureOwnCodexHooks(true, system, SKILL), ['UserPromptSubmit', 'SessionStart', 'PostToolUse'].map((e) => `added the ${e} hook in ${join(system, 'hooks.json')}`))
    const after = read(join(system, 'hooks.json'))
    const ours = codexHooksFor(system, SKILL)
    assert.equal(after.other, 'kept', 'other keys stay')
    assert.deepEqual(after.hooks.UserPromptSubmit, [ours[0].entry])
    assert.deepEqual(after.hooks.SessionStart, [ours[1].entry])
    assert.deepEqual(after.hooks.PostToolUse, [before.hooks.PostToolUse[0], ours[2].entry], 'the user\'s own entry stays first')
    for (const h of ours) {
      const cmd = h.entry.hooks[0].command
      assert.ok(!/\$\{(CLAUDE_)?PLUGIN_(ROOT|DATA)\}/.test(cmd), 'no ${PLUGIN_ROOT}-style variable: Orca drops those from its merge')
      assert.ok(cmd.includes('"/u/.agents/skills/orca-flow/scripts/'), 'runs through the Codex user skill link, stable across plugin updates')
    }
    assert.match(ours[0].entry.hooks[0].command, /^if \[ -n "\$\{ORCA_AGENT_PANE:-\$\{ORCA_PANE_KEY-\}\}" \]; then node "\/u\/.agents\/skills\/orca-flow\/scripts\/prompt-check.mjs"; fi$/)
    assert.equal(ours[0].entry.hooks[0].statusMessage, 'Orca Flow: Reload skills', 'named in Codex\'s review, not "Unnamed hook"')
    assert.match(ours[2].entry.hooks[0].command, /skill-reload\/active" \]; then node "\/u\/.agents\/skills\/orca-flow\/scripts\/reload-check.mjs"/)
    assert.deepEqual(ensureCodexHooks(system, SKILL), [], 'a second run changes nothing (the trust key stays put)')
    assert.equal(readFileSync(join(system, 'config.toml'), 'utf8'), config, 'config.toml and its trust state untouched')
    assert.equal(readFileSync(join(home, 'hooks.json'), 'utf8'), account, 'an Orca-managed account home is never written: Orca merges into it')
    assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), '{"secret":"never read"}')
    // A missing hooks.json is created with only ours; a broken one is left alone; no ~/.codex at all: nothing.
    rmSync(join(system, 'hooks.json'))
    assert.equal(ensureCodexHooks(system, SKILL).length, 3)
    assert.deepEqual(Object.keys(read(join(system, 'hooks.json')).hooks), ['UserPromptSubmit', 'SessionStart', 'PostToolUse'])
    writeFileSync(join(system, 'hooks.json'), '{broken')
    assert.match(ensureCodexHooks(system, SKILL).join(), /not valid JSON/)
    assert.equal(readFileSync(join(system, 'hooks.json'), 'utf8'), '{broken')
    const none = join(root, 'no-codex')
    assert.match(ensureCodexHooks(none, SKILL)[0], /no .*no-codex \(Codex has not run here\)/)
    assert.equal(existsSync(none), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readiness: not installed, not merged until Orca starts Codex, needs approval, then ready by the account\'s trust at the merged position', () => {
  const { root, system, home } = setup()
  const source = join(home, 'hooks.json')
  try {
    rmSync(join(system, 'hooks.json'))
    assert.deepEqual(codexReloadReadiness(home, system), { state: 'not-installed', reason: CODEX_REASON['not-installed'] })
    writeFileSync(join(system, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-audit', timeout: 5 }] }] } }))
    assert.equal(codexReloadReadiness(home, system).state, 'not-installed', 'ours are not in ~/.codex/hooks.json')
    ensureCodexHooks(system, SKILL)
    assert.deepEqual(codexReloadReadiness(home, system), { state: 'not-merged', reason: "Codex: Orca adds Orca Flow's hooks when it next starts Codex; start a Codex agent in Orca (choose Trust all and continue if asked), then restart older Codex sessions" })
    orcaMerge(system, home)
    const merged = read(join(home, 'hooks.json')).hooks
    assert.equal(merged.UserPromptSubmit[1].hooks[0].statusMessage, 'Orca Flow: Reload skills', 'ours at group index 1, after Orca\'s')
    assert.equal(merged.PostToolUse[2].hooks[0].statusMessage, 'Orca Flow: Reload skills', 'after Orca\'s and the user\'s own PostToolUse group')
    assert.deepEqual(codexReloadReadiness(home, system), { state: 'needs-approval', reason: "Codex: approve Orca Flow's hooks once; start a Codex agent in Orca and choose Trust all and continue (or /hooks), then restart older Codex sessions" })
    const base = readFileSync(join(home, 'config.toml'), 'utf8')
    // What Codex writes on "Trust all and continue" in an Orca-launched session: keys at the merged positions.
    writeFileSync(join(home, 'config.toml'), base + trust(source, 'UserPromptSubmit', 1) + trust(source, 'SessionStart', 1))
    assert.equal(codexReloadReadiness(home, system).state, 'needs-approval', 'two of three trusted')
    writeFileSync(join(home, 'config.toml'), base + trust(source, 'UserPromptSubmit', 1) + trust(source, 'SessionStart', 1) + trust(source, 'PostToolUse', 1))
    assert.equal(codexReloadReadiness(home, system).state, 'needs-approval', 'trusted at the ~/.codex position, not the merged one (ours is the third PostToolUse group there)')
    writeFileSync(join(home, 'config.toml'), base + trust(source, 'UserPromptSubmit', 1) + trust(source, 'SessionStart', 1) + trust(source, 'PostToolUse', 2))
    assert.deepEqual(codexReloadReadiness(home, system), { state: 'ready', reason: '' })
    writeFileSync(join(home, 'config.toml'), base + trust(source, 'UserPromptSubmit', 1, 'enabled = false\n') + trust(source, 'SessionStart', 1) + trust(source, 'PostToolUse', 2))
    assert.equal(codexReloadReadiness(home, system).state, 'disabled')
    writeFileSync(join(home, 'config.toml'), base + trust(source, 'UserPromptSubmit', 1, '', 'sha256:old') + trust(source, 'SessionStart', 1) + trust(source, 'PostToolUse', 2))
    assert.equal(codexReloadReadiness(home, system).state, 'needs-approval', 'trusted with another command\'s hash')
    // A plugin update that changed a command: ~/.codex has the new one, the account still the old one until Orca next starts Codex.
    writeFileSync(join(home, 'config.toml'), base + trust(source, 'UserPromptSubmit', 1) + trust(source, 'SessionStart', 1) + trust(source, 'PostToolUse', 2))
    const sys = read(join(system, 'hooks.json'))
    sys.hooks.SessionStart[0].hooks[0].timeout = 20
    writeFileSync(join(system, 'hooks.json'), JSON.stringify(sys))
    assert.equal(codexReloadReadiness(home, system).state, 'not-merged')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readiness: the approval Orca copied into ~/.codex/config.toml counts for every account; the selected ~/.codex login reads its own files', () => {
  const { root, system, home } = setup()
  const sysSource = join(system, 'hooks.json')
  try {
    ensureCodexHooks(system, SKILL)
    orcaMerge(system, home)
    // What Orca writes into ~/.codex/config.toml when it promotes the user's approval: keys of ~/.codex/hooks.json at its own positions.
    const sysBase = readFileSync(join(system, 'config.toml'), 'utf8')
    writeFileSync(join(system, 'config.toml'), sysBase + trust(sysSource, 'UserPromptSubmit', 0) + trust(sysSource, 'SessionStart', 0) + trust(sysSource, 'PostToolUse', 1))
    assert.deepEqual(codexReloadReadiness(home, system), { state: 'ready', reason: '' }, 'carried by hash, as Orca does at its next Codex start')
    writeFileSync(join(system, 'config.toml'), sysBase + trust(sysSource, 'UserPromptSubmit', 0, 'enabled = false\n') + trust(sysSource, 'SessionStart', 0) + trust(sysSource, 'PostToolUse', 1))
    assert.equal(codexReloadReadiness(home, system).state, 'disabled')
    writeFileSync(join(system, 'config.toml'), sysBase + trust('/elsewhere/hooks.json', 'UserPromptSubmit', 0) + trust(sysSource, 'SessionStart', 0) + trust(sysSource, 'PostToolUse', 1))
    assert.equal(codexReloadReadiness(home, system).state, 'needs-approval', 'trust of another hooks.json does not count')
    // The account's own key wins over ~/.codex's when both are there.
    writeFileSync(join(system, 'config.toml'), sysBase + trust(sysSource, 'UserPromptSubmit', 0) + trust(sysSource, 'SessionStart', 0) + trust(sysSource, 'PostToolUse', 1))
    writeFileSync(join(home, 'config.toml'), readFileSync(join(home, 'config.toml'), 'utf8') + trust(join(home, 'hooks.json'), 'UserPromptSubmit', 1, 'enabled = false\n'))
    assert.equal(codexReloadReadiness(home, system).state, 'disabled')
    // The system login itself (Orca's account switcher on "system"): Codex reads ~/.codex directly, at ~/.codex positions.
    assert.equal(codexReloadReadiness(system, system).state, 'ready')
    writeFileSync(join(system, 'config.toml'), sysBase + trust(sysSource, 'UserPromptSubmit', 0) + trust(sysSource, 'SessionStart', 0) + trust(sysSource, 'PostToolUse', 2))
    assert.equal(codexReloadReadiness(system, system).state, 'needs-approval', 'wrong position in ~/.codex/hooks.json')
    // Unreadable files, and a home Orca does not manage.
    writeFileSync(join(home, 'hooks.json'), '{broken')
    assert.equal(codexReloadReadiness(home, system).state, 'unreadable')
    rmSync(join(home, '.orca-managed-home'))
    assert.equal(codexReloadReadiness(home, system).state, 'unmanaged', 'a login Orca does not manage, other than ~/.codex')
    writeFileSync(join(system, 'hooks.json'), '{broken')
    assert.equal(codexReloadReadiness(system, system).state, 'unreadable')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the hook state reader takes quoted keys, escapes, enabled and stops at the next table', () => {
  const state = readHookState('[hooks.state."/a b/hooks.json:stop:0:0"]\nenabled = false\ntrusted_hash = "sha256:1"\n[tui]\ntrusted_hash = "sha256:nope"\n[hooks.state."/q\\"x/hooks.json:stop:0:0"]   # note\ntrusted_hash = "sha256:2"\n')
  assert.deepEqual([...state], [['/a b/hooks.json:stop:0:0', { trustedHash: 'sha256:1', enabled: false }], ['/q"x/hooks.json:stop:0:0', { trustedHash: 'sha256:2', enabled: true }]])
})
