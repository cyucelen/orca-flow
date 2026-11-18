// The message-format Stop hook in the Claude profile's settings.json (ensureStopHook in install.ts).
import { assert, test } from 'orca/testing'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureOwnStopHook, ensureStopHook, promptHookFor, stopHookFor } from './install.ts'

const profile = () => {
  const home = mkdtempSync(join(tmpdir(), 'stop-hook-'))
  const claudeDir = join(home, '.claude')
  mkdirSync(claudeDir)
  return { home, claudeDir, hook: stopHookFor(home, claudeDir) }
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

test('the hook runs the script through the skill link, only in an Orca pane', () => {
  const { path, entry } = stopHookFor('/h', '/h/.claude')
  assert.equal(path, '/h/.claude/settings.json')
  assert.deepEqual(entry, {
    hooks: [{ type: 'command', command: 'if [ -n "${ORCA_AGENT_PANE-}" ]; then node "/h/.claude/skills/orca-flow/scripts/stop-check.mjs"; fi', timeout: 10 }]
  })
})

test('adds the hook once, keeps every other key and hook, writes 2-space JSON', () => {
  const { home, hook } = profile()
  const orcaHook = { hooks: [{ type: 'command', command: '/orca/agent-hooks/stop.sh' }] }
  const settings = { model: 'opus', hooks: { Stop: [orcaHook], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] }, permissions: { allow: ['Bash(ls)'] } }
  writeFileSync(hook.path, JSON.stringify(settings))
  assert.deepEqual(ensureStopHook(hook), [`added the Stop hook in ${hook.path}`])
  assert.deepEqual(read(hook.path), { ...settings, hooks: { ...settings.hooks, Stop: [orcaHook, hook.entry] } })
  assert.equal(readFileSync(hook.path, 'utf8'), `${JSON.stringify(read(hook.path), null, 2)}\n`)
  assert.deepEqual(ensureStopHook(hook), [], 'a second run changes nothing')
  assert.equal(read(hook.path).hooks.Stop.length, 2)
  rmSync(home, { recursive: true })
})

test('updates an older copy of our hook in place and drops a second copy', () => {
  const { home, hook } = profile()
  const old = { type: 'command', command: 'node "/old/.claude/skills/orca-flow/scripts/stop-check.mjs"', timeout: 5 }
  const other = { type: 'command', command: 'say done' }
  writeFileSync(hook.path, JSON.stringify({ hooks: { Stop: [{ hooks: [other, old] }, { hooks: [old] }] } }))
  assert.deepEqual(ensureStopHook(hook), [`updated the Stop hook in ${hook.path}`])
  assert.deepEqual(read(hook.path).hooks.Stop, [{ hooks: [other, hook.entry.hooks[0]] }])
  assert.deepEqual(ensureStopHook(hook), [])
  rmSync(home, { recursive: true })
})

test('a missing settings.json gets only our hook; broken JSON or a strange shape is left alone', () => {
  const { home, hook } = profile()
  assert.deepEqual(ensureStopHook(hook), [`added the Stop hook in ${hook.path}`])
  assert.deepEqual(read(hook.path), { hooks: { Stop: [hook.entry] } })

  writeFileSync(hook.path, '{ "hooks": ')
  const [line] = ensureStopHook(hook)
  assert.match(line, /^left .*settings\.json: not valid JSON/)
  assert.equal(readFileSync(hook.path, 'utf8'), '{ "hooks": ')

  writeFileSync(hook.path, '{"hooks":{"Stop":{}}}')
  assert.match(ensureStopHook(hook)[0], /hooks\.Stop is not a list/)
  assert.equal(readFileSync(hook.path, 'utf8'), '{"hooks":{"Stop":{}}}')
  writeFileSync(hook.path, '[]')
  assert.match(ensureStopHook(hook)[0], /not a JSON object/)
  rmSync(home, { recursive: true })
})

test('a settings.json that is a link stays a link; a development folder writes nothing', () => {
  const { home, hook } = profile()
  const real = join(home, 'dotfiles-settings.json')
  writeFileSync(real, '{"theme":"dark"}')
  symlinkSync(real, hook.path)
  ensureStopHook(hook)
  assert.ok(lstatSync(hook.path).isSymbolicLink())
  assert.equal(readlinkSync(hook.path), real)
  assert.deepEqual(read(real), { theme: 'dark', hooks: { Stop: [hook.entry] } })

  const dev = stopHookFor(home, join(home, 'dev-profile'))
  assert.equal(ensureOwnStopHook(dev, false).length, 1)
  assert.equal(existsSync(dev.path), false)
  assert.deepEqual(ensureOwnStopHook(hook, true), [`added the UserPromptSubmit hook in ${hook.path}`], 'the installed copy adds the prompt hook next to the Stop hook')
  assert.deepEqual(ensureOwnStopHook(hook, true), [])
  assert.ok(lstatSync(hook.path).isSymbolicLink())
  rmSync(home, { recursive: true })
})

test('the UserPromptSubmit hook runs the reminder script through the skill link, only in an Orca pane', () => {
  const { path, event, entry } = promptHookFor('/h', '/h/.claude')
  assert.deepEqual([path, event], ['/h/.claude/settings.json', 'UserPromptSubmit'])
  assert.deepEqual(entry, {
    hooks: [{ type: 'command', command: 'if [ -n "${ORCA_AGENT_PANE-}" ]; then node "/h/.claude/skills/orca-flow/scripts/prompt-check.mjs"; fi', timeout: 10 }]
  })
})

test('both hooks go in once, next to Orca\'s own hooks, each updated in place', () => {
  const { home, hook } = profile()
  const prompt = promptHookFor(home, join(home, '.claude'))
  const orcaStop = { hooks: [{ type: 'command', command: '/orca/agent-hooks/stop.sh' }] }
  const orcaPrompt = { hooks: [{ type: 'command', command: '/orca/agent-hooks/prompt.sh' }] }
  const old = { type: 'command', command: 'node "/old/skills/orca-flow/scripts/prompt-check.mjs"', timeout: 5 }
  writeFileSync(hook.path, JSON.stringify({ model: 'opus', hooks: { Stop: [orcaStop], UserPromptSubmit: [orcaPrompt, { hooks: [old] }, { hooks: [old] }] } }))
  assert.deepEqual(ensureOwnStopHook(hook, true), [`added the Stop hook in ${hook.path}`, `updated the UserPromptSubmit hook in ${hook.path}`])
  assert.deepEqual(read(hook.path), { model: 'opus', hooks: { Stop: [orcaStop, hook.entry], UserPromptSubmit: [orcaPrompt, prompt.entry] } })
  assert.deepEqual(ensureOwnStopHook(hook, true), [], 'a second run changes nothing')
  assert.equal(readFileSync(hook.path, 'utf8'), `${JSON.stringify(read(hook.path), null, 2)}\n`)
  writeFileSync(hook.path, '{"hooks":{"UserPromptSubmit":{}}}')
  assert.deepEqual(ensureOwnStopHook(hook, true), [`added the Stop hook in ${hook.path}`, `left ${hook.path}: hooks.UserPromptSubmit is not a list; the UserPromptSubmit hook is not installed`])
  rmSync(home, { recursive: true })
})
