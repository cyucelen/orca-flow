// Orca Flow's Antigravity (agy) hooks: the installer next to Orca's own "orca-status" definition in
// ~/.gemini/config/hooks.json, and the read-only readiness the sidebar shows. Fixtures follow the
// format Google documents (https://antigravity.google/docs/hooks/) and the shape Orca 1.4.265 writes.
// agy itself was not installed: fixture-tested, not live-tested.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGY_HOOK_NAME, AGY_REASON, agyCommand, agyDefinition, antigravityReloadReadiness, ensureAntigravityHooks, ensureOwnAntigravityHooks } from './antigravity-hooks.ts'

/** Orca's own definition, as Orca writes it: direct handlers for PreInvocation, PostInvocation and Stop; matcher groups for the tool events. */
const ORCA_CMD = `/bin/sh -c 'if [ -f /h/.orca/agent-hooks/antigravity-hook.sh ]; then ORCA_ANTIGRAVITY_EVENT=PreInvocation /bin/sh /h/.orca/agent-hooks/antigravity-hook.sh; else echo "{}"; fi'`
const orcaStatus = {
  PreInvocation: [{ type: 'command', command: ORCA_CMD, timeout: 10 }],
  PostInvocation: [{ type: 'command', command: ORCA_CMD, timeout: 10 }],
  Stop: [{ type: 'command', command: ORCA_CMD, timeout: 10 }],
  PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ORCA_CMD, timeout: 10 }] }],
  PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ORCA_CMD, timeout: 10 }] }]
}
/** A user's own definition, from the documented example. */
const mine = { PreInvocation: [{ type: 'command', command: './scripts/reminder.sh' }], PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './scripts/lint.sh', timeout: 10 }] }] }
const SKILL = '/h/.gemini/config/skills/orca-flow'

function world() {
  const home = mkdtempSync(join(tmpdir(), 'agy-hooks-'))
  const file = join(home, '.gemini', 'config', 'hooks.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ 'orca-status': orcaStatus, 'my-hook': mine }, null, 2))
  writeFileSync(join(home, '.gemini', 'settings.json'), '{"keep":"me"}')
  return { home, file }
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

test('the command is wrapped in /bin/sh -c like Orca\'s, starts node only while a reload waits, and answers {} otherwise', () => {
  assert.equal(agyCommand(SKILL, 'PreInvocation'), `/bin/sh -c 'if [ -e "\${ORCA_FLOW_DIR:-$HOME/.orca-flow}/skill-reload/active" ]; then exec node "${SKILL}/scripts/agy-hook.mjs" PreInvocation; else echo "{}"; fi'`)
  assert.throws(() => agyCommand("/h/it's/orca-flow", 'PostToolUse'), /cannot quote/)
  const def = agyDefinition(SKILL)
  assert.deepEqual(Object.keys(def), ['PreInvocation', 'PostToolUse'])
  assert.deepEqual((def.PostToolUse as any)[0].matcher, 'run_command', 'only after shell commands, where the confirm command runs')
})

test('our definition goes next to Orca\'s, once; every other key and settings.json stay; a turned-off definition stays off', () => {
  const { home, file } = world()
  try {
    assert.match(ensureOwnAntigravityHooks(false, file, SKILL)[0], /development folder/)
    assert.equal(read(file)[AGY_HOOK_NAME], undefined, 'a development folder writes nothing')
    assert.deepEqual(ensureAntigravityHooks(file, SKILL), [`added the ${AGY_HOOK_NAME} hooks in ${file}`])
    const after = read(file)
    assert.deepEqual(Object.keys(after), ['orca-status', 'my-hook', AGY_HOOK_NAME])
    assert.deepEqual(after['orca-status'], orcaStatus)
    assert.deepEqual(after['my-hook'], mine)
    assert.deepEqual(after[AGY_HOOK_NAME], agyDefinition(SKILL))
    assert.deepEqual(ensureAntigravityHooks(file, SKILL), [], 'a second run changes nothing')
    // The user turned it off (/hooks in agy): an update keeps it off.
    writeFileSync(file, JSON.stringify({ ...after, [AGY_HOOK_NAME]: { ...after[AGY_HOOK_NAME], enabled: false, PreInvocation: [] } }))
    assert.deepEqual(ensureAntigravityHooks(file, SKILL), [`updated the ${AGY_HOOK_NAME} hooks in ${file}`])
    assert.equal(read(file)[AGY_HOOK_NAME].enabled, false)
    assert.deepEqual(read(file)[AGY_HOOK_NAME].PreInvocation, agyDefinition(SKILL).PreInvocation)
    assert.equal(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'), '{"keep":"me"}')
    // No file (Orca has not set Antigravity up), or a broken one: left alone.
    writeFileSync(file, '{broken')
    assert.match(ensureAntigravityHooks(file, SKILL)[0], /not valid JSON/)
    assert.equal(readFileSync(file, 'utf8'), '{broken')
    writeFileSync(file, '[]')
    assert.match(ensureAntigravityHooks(file, SKILL)[0], /not a JSON object/)
    rmSync(file)
    assert.match(ensureAntigravityHooks(file, SKILL)[0], /no Antigravity hooks file yet \(Orca creates it\)/)
    assert.deepEqual(ensureOwnAntigravityHooks(false, file, SKILL), [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('readiness: not installed, ready, turned off, unreadable, each with its one action', () => {
  const { home, file } = world()
  try {
    assert.deepEqual(antigravityReloadReadiness(file), { state: 'not-installed', reason: AGY_REASON['not-installed'] })
    ensureAntigravityHooks(file, SKILL)
    assert.deepEqual(antigravityReloadReadiness(file), { state: 'ready', reason: '' })
    const ours = read(file)[AGY_HOOK_NAME]
    writeFileSync(file, JSON.stringify({ [AGY_HOOK_NAME]: { ...ours, enabled: false } }))
    assert.equal(antigravityReloadReadiness(file).state, 'disabled')
    assert.match(antigravityReloadReadiness(file).reason, /turn orca-flow-reload on with \/hooks in agy/)
    writeFileSync(file, JSON.stringify({ [AGY_HOOK_NAME]: { PreInvocation: ours.PreInvocation } }))
    assert.equal(antigravityReloadReadiness(file).state, 'not-installed', 'both events are needed')
    writeFileSync(file, '{broken')
    assert.equal(antigravityReloadReadiness(file).state, 'unreadable')
    rmSync(file)
    assert.equal(antigravityReloadReadiness(file).state, 'not-installed')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
