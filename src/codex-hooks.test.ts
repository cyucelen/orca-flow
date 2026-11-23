// Orca Flow's Codex hooks: the installer (next to Orca's own entries in an Orca-managed account's
// hooks.json, never its trust, config or auth) and the read-only readiness the sidebar shows.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_REASON, codexHooksFor, codexReloadReadiness, codexTrustHash, ensureCodexHooks, ensureOwnCodexHooks, managedCodexHomes, readHookState } from './codex-hooks.ts'

/** Orca's own Codex hook command (form 2), as it is in a real account's hooks.json. */
const ORCA_CMD = ": orca-agent-hook-form=2; if [ -n \"${ORCA_PANE_KEY-}\" ] && [ -n \"${ORCA_AGENT_HOOK_ROOT-}\" ] && [ -f \"${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh\" ]; then /bin/sh \"${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh\" || :; elif [ -z \"${ORCA_AGENT_HOOK_ROOT-}\" ] && [ -n \"${ORCA_PANE_KEY-}\" ] && [ -n \"${ORCA_AGENT_HOOK_PORT-}\" ] && [ -f \"${HOME-}/.orca/agent-hooks/codex-hook.sh\" ]; then /bin/sh \"${HOME-}/.orca/agent-hooks/codex-hook.sh\" || :; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi"
const orcaGroup = (timeout = 10) => ({ hooks: [{ type: 'command', command: ORCA_CMD, timeout, statusMessage: 'Reporting status to Orca' }] })
const ORCA_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt']
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

/** A temp Orca data folder with one managed Codex account home like Orca's: hooks.json, config.toml, auth.json, the marker. */
function account() {
  const data = mkdtempSync(join(tmpdir(), 'codex-hooks-'))
  const home = join(data, 'codex-accounts', 'acct-1', 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.orca-managed-home'), 'orca\n')
  const hooks = { hooks: Object.fromEntries(ORCA_EVENTS.map((e) => [e, [orcaGroup(e === 'Interrupt' ? 3 : 10)]])) }
  hooks.hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-audit', timeout: 5 }] } as any)
  writeFileSync(join(home, 'hooks.json'), JSON.stringify(hooks, null, 2))
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.2-astra"\n\n[hooks.state."/x/hooks.json:stop:0:0"]\nenabled = true\ntrusted_hash = "sha256:abc"\n')
  writeFileSync(join(home, 'auth.json'), '{"secret":"never read"}')
  return { data, home, skill: '/u/.agents/skills/orca-flow' }
}

test('Codex trust hashes: Codex\'s own algorithm, checked against a real account\'s Orca-trusted entries', () => {
  const orca = { command: ORCA_CMD, timeout: 10, statusMessage: 'Reporting status to Orca' }
  assert.equal(codexTrustHash('user_prompt_submit', orca), 'sha256:8ea1302cbe5790e03a4ef2956313c1dd48a55600551e062ee61c3b629e2a39d1')
  assert.equal(codexTrustHash('post_tool_use', orca), 'sha256:b0315c94b3f571e1c012f96f440d38fd05623315bd2b4e228ec279d88fbc9497')
  assert.equal(codexTrustHash('session_start', orca), 'sha256:94b4d1a902ec6b5098ba63efae732f362d7348f600f2a83a4a710ea7db4a5545')
  assert.notEqual(codexTrustHash('post_tool_use', orca, 'Bash'), codexTrustHash('post_tool_use', orca), 'a tool event hashes its matcher')
  assert.equal(codexTrustHash('user_prompt_submit', orca, 'Bash'), codexTrustHash('user_prompt_submit', orca), 'a prompt event does not')
})

test('our three hooks go next to Orca\'s in each Orca-managed account, once, keeping every other entry; trust, config and auth are never written', () => {
  const { data, home, skill } = account()
  try {
    assert.deepEqual(managedCodexHomes(data), [home])
    mkdirSync(join(data, 'codex-accounts', 'unmarked', 'home'), { recursive: true })
    assert.deepEqual(managedCodexHomes(data), [home], 'only homes Orca marked')
    const before = read(join(home, 'hooks.json'))
    const config = readFileSync(join(home, 'config.toml'), 'utf8')
    assert.deepEqual(ensureOwnCodexHooks([home], false, skill), ['left the Codex hooks in 1 Codex home(s) to the installed copy: this is a development folder'])
    assert.deepEqual(read(join(home, 'hooks.json')), before, 'a development folder writes nothing')
    assert.deepEqual(ensureCodexHooks(home, skill), ['UserPromptSubmit', 'SessionStart', 'PostToolUse'].map((e) => `added the ${e} hook in ${join(home, 'hooks.json')}`))
    const after = read(join(home, 'hooks.json')).hooks
    const ours = codexHooksFor(home, skill)
    for (const e of ORCA_EVENTS) assert.deepEqual(after[e][0], before.hooks[e][0], `Orca's ${e} entry stays first and unchanged`)
    assert.deepEqual(after.UserPromptSubmit, [orcaGroup(), ours[0].entry])
    assert.deepEqual(after.SessionStart, [orcaGroup(), ours[1].entry])
    assert.deepEqual(after.PostToolUse, [orcaGroup(), before.hooks.PostToolUse[1], ours[2].entry], 'the user\'s own entry stays')
    assert.match(ours[0].entry.hooks[0].command, /^if \[ -n "\$\{ORCA_AGENT_PANE:-\$\{ORCA_PANE_KEY-\}\}" \]; then node "\/u\/.agents\/skills\/orca-flow\/scripts\/prompt-check.mjs"; fi$/)
    assert.equal(ours[0].entry.hooks[0].statusMessage, 'Orca Flow: Reload skills', 'named in Codex\'s review, not "Unnamed hook"')
    assert.match(ours[2].entry.hooks[0].command, /skill-reload\/active" \]; then node "\/u\/.agents\/skills\/orca-flow\/scripts\/reload-check.mjs"/)
    assert.deepEqual(ensureCodexHooks(home, skill), [], 'a second run changes nothing (the trust key stays put)')
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), config, 'config.toml and its trust state untouched')
    assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), '{"secret":"never read"}')
    // A home without hooks.json (Orca has not set it up) or with a broken one is left alone.
    rmSync(join(home, 'hooks.json'))
    assert.match(ensureCodexHooks(home, skill)[0], /no hooks.json yet \(Orca creates it\)/)
    writeFileSync(join(home, 'hooks.json'), '{broken')
    assert.match(ensureCodexHooks(home, skill).join(), /not valid JSON/)
    assert.equal(readFileSync(join(home, 'hooks.json'), 'utf8'), '{broken')
  } finally { rmSync(data, { recursive: true, force: true }) }
})

test('readiness: not installed, then needs the user\'s approval, ready once all three are trusted, off when disabled', () => {
  const { data, home, skill } = account()
  try {
    assert.equal(codexReloadReadiness(home).state, 'not-installed')
    assert.equal(codexReloadReadiness(home).reason, CODEX_REASON['not-installed'])
    ensureCodexHooks(home, skill)
    const r = codexReloadReadiness(home)
    assert.deepEqual(r, { state: 'needs-approval', reason: "Codex: approve Orca Flow's hooks once; start Codex, choose Trust all and continue (or /hooks)" })
    // What Codex writes when the user trusts them: one table per hook, keyed by file, event, group, handler.
    const source = join(realpathSync(home), 'hooks.json')
    const trust = (label: string, group: number, cmd: string, extra = '') => `\n[hooks.state."${source}:${label}:${group}:0"]\n${extra}trusted_hash = "${codexTrustHash(label, { command: cmd, timeout: 10, statusMessage: 'Orca Flow: Reload skills' })}"\n`
    const [p, s, t] = codexHooksFor(home, skill).map((h) => h.entry.hooks[0].command)
    const base = readFileSync(join(home, 'config.toml'), 'utf8')
    writeFileSync(join(home, 'config.toml'), base + trust('user_prompt_submit', 1, p) + trust('session_start', 1, s))
    assert.equal(codexReloadReadiness(home).state, 'needs-approval', 'two of three trusted')
    writeFileSync(join(home, 'config.toml'), base + trust('user_prompt_submit', 1, p) + trust('session_start', 1, s) + trust('post_tool_use', 1, t))
    assert.equal(codexReloadReadiness(home).state, 'needs-approval', 'trusted at the wrong position (ours is the third PostToolUse group)')
    writeFileSync(join(home, 'config.toml'), base + trust('user_prompt_submit', 1, p) + trust('session_start', 1, s) + trust('post_tool_use', 2, t))
    assert.deepEqual(codexReloadReadiness(home), { state: 'ready', reason: '' })
    writeFileSync(join(home, 'config.toml'), base + trust('user_prompt_submit', 1, p, 'enabled = false\n') + trust('session_start', 1, s) + trust('post_tool_use', 2, t))
    assert.equal(codexReloadReadiness(home).state, 'disabled')
    // A trusted hook whose command changed since needs the approval again.
    writeFileSync(join(home, 'config.toml'), base + trust('user_prompt_submit', 1, `${p} `) + trust('session_start', 1, s) + trust('post_tool_use', 2, t))
    assert.equal(codexReloadReadiness(home).state, 'needs-approval')
    writeFileSync(join(home, 'hooks.json'), '{broken')
    assert.equal(codexReloadReadiness(home).state, 'unreadable')
    rmSync(join(home, '.orca-managed-home'))
    assert.equal(codexReloadReadiness(home).state, 'unmanaged', 'a system login Orca does not manage')
  } finally { rmSync(data, { recursive: true, force: true }) }
})

test('the hook state reader takes quoted keys, escapes, enabled and stops at the next table', () => {
  const state = readHookState('[hooks.state."/a b/hooks.json:stop:0:0"]\nenabled = false\ntrusted_hash = "sha256:1"\n[tui]\ntrusted_hash = "sha256:nope"\n[hooks.state."/q\\"x/hooks.json:stop:0:0"]   # note\ntrusted_hash = "sha256:2"\n')
  assert.deepEqual([...state], [['/a b/hooks.json:stop:0:0', { trustedHash: 'sha256:1', enabled: false }], ['/q"x/hooks.json:stop:0:0', { trustedHash: 'sha256:2', enabled: true }]])
})
