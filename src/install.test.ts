// The message-format Stop hook in the Claude profile's settings.json (ensureStopHook in install.ts).
import { assert, test } from 'orca/testing'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureOwnStopHook, ensureStopHook, promptHookFor, sessionHookFor, stopHookFor } from './install.ts'
import { claudeDiscoveryDir, ensureOwnLinks, ensureSeeds, linksFor } from './install.ts'
import { bootstrapCoordinator, coordinatorPrompt } from './coordinator-bootstrap.ts'
import { scaffoldCoordinator } from './coordinators.ts'

const profile = () => {
  const home = mkdtempSync(join(tmpdir(), 'stop-hook-'))
  const claudeDir = join(home, '.claude')
  mkdirSync(claudeDir)
  return { home, claudeDir, hook: stopHookFor(home, claudeDir) }
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

test('Claude profile selection and Codex USER discovery use separate roots across accounts', () => {
  assert.equal(claudeDiscoveryDir('/user', '/selected-profile', '/explicit-profile'), '/selected-profile')
  assert.equal(claudeDiscoveryDir('/user', null, '/explicit-profile'), '/explicit-profile')
  assert.equal(claudeDiscoveryDir('/user', null), '/user/.claude')
  for (const home of ['/users/one', '/users/two']) for (const claudeDir of [`${home}/.claude`, `${home}/orca/profiles/account-two`]) {
    const links = linksFor('/installed/flow', home, claudeDir)
    assert.deepEqual(links.map((l) => l.from), [`${claudeDir}/skills/orca-flow`, `${home}/.agents/skills/orca-flow`, `${home}/.gemini/config/skills/orca-flow`])
    assert.ok(links.every((l) => l.to === '/installed/flow/skills/orca-flow'))
  }
})

test('known installed release links can be repaired after Orca removes the old hash', () => {
  const home = mkdtempSync(join(tmpdir(), 'release-discovery-'))
  try {
    const root = join(home, 'plugins/cyucelen.flow')
    const old = join(root, 'a'.repeat(64), 'skills/orca-flow'), next = join(root, 'b'.repeat(64), 'skills/orca-flow')
    const from = join(home, 'skill'); symlinkSync(old, from)
    assert.deepEqual(ensureOwnLinks([{ from, to: next }], true, { repairOnly: true }), [`linked ${from}`])
    assert.equal(readlinkSync(from), next)
  } finally { rmSync(home, { recursive: true }) }
})

test('installed discovery updates our skill links but preserves user files and other plugin symlinks, including dangling ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'discovery-'))
  try {
    const old = join(home, 'old-plugin'), next = join(home, 'new-plugin'), other = join(home, 'other-plugin')
    for (const dir of [old, next, other]) { mkdirSync(join(dir, 'skills/orca-flow'), { recursive: true }); writeFileSync(join(dir, 'orca-plugin.json'), JSON.stringify({ id: dir === other ? 'other' : 'flow', name: dir === other ? 'Other' : 'Orca Flow' })) }
    const links = linksFor(old, home, join(home, 'claude-profile'))
    ensureOwnLinks(links, true)
    ensureOwnLinks(linksFor(next, home, join(home, 'claude-profile')), true)
    assert.equal(readlinkSync(links[0].from), join(next, 'skills/orca-flow'))
    assert.equal(readlinkSync(links[1].from), join(next, 'skills/orca-flow'))
    rmSync(links[1].from)
    symlinkSync(join(other, 'skills/orca-flow'), links[1].from)
    ensureOwnLinks(links, true)
    assert.equal(readlinkSync(links[1].from), join(other, 'skills/orca-flow'))
    rmSync(links[1].from); symlinkSync(join(home, 'missing-user-skill'), links[1].from)
    ensureOwnLinks(links, true, { repairOnly: true })
    assert.equal(readlinkSync(links[1].from), join(home, 'missing-user-skill'))
    rmSync(links[1].from); writeFileSync(links[1].from, 'user-owned')
    ensureOwnLinks(links, true)
    assert.equal(readFileSync(links[1].from, 'utf8'), 'user-owned')
    const dev = linksFor(join(home, 'dev'), home, join(home, 'new-profile'))
    ensureOwnLinks(dev, false)
    assert.equal(existsSync(dev[0].from), false)
    assert.equal(readlinkSync(links[0].from), join(old, 'skills/orca-flow'))
  } finally { rmSync(home, { recursive: true }) }
})

test('new and existing coordinator folders bootstrap both providers without changing user instructions or foreign symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-'))
  try {
    const fresh = scaffoldCoordinator(root, { name: 'fresh', look: null })
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      assert.match(readFileSync(join(fresh, file), 'utf8'), /Your role: coordinator/)
      assert.match(readFileSync(join(fresh, file), 'utf8'), /roles\/coordinator.md/)
    }
    const old = join(root, 'existing'); mkdirSync(old)
    writeFileSync(join(old, 'CLAUDE.md'), 'User project notes')
    bootstrapCoordinator(old, '/installed/skill')
    assert.equal(readFileSync(join(old, 'CLAUDE.md'), 'utf8'), 'User project notes')
    assert.match(readFileSync(join(old, 'AGENTS.md'), 'utf8'), /\/installed\/skill\/SKILL.md/)
    assert.deepEqual(bootstrapCoordinator(old, '/new/skill'), [])
    rmSync(join(old, 'AGENTS.md')); symlinkSync('/missing/user-instructions', join(old, 'AGENTS.md'))
    bootstrapCoordinator(old, '/new/skill')
    assert.equal(readlinkSync(join(old, 'AGENTS.md')), '/missing/user-instructions')
    ensureSeeds([{ from: join(old, 'AGENTS.md'), to: join(fresh, 'AGENTS.md') }])
    assert.equal(readlinkSync(join(old, 'AGENTS.md')), '/missing/user-instructions')
    assert.match(coordinatorPrompt('/new/skill'), /Your role: coordinator/)
    assert.match(coordinatorPrompt('/new/skill'), /coordinator.json/)
  } finally { rmSync(root, { recursive: true }) }
})

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
  assert.deepEqual(ensureOwnStopHook(hook, true), [`added the UserPromptSubmit hook in ${hook.path}`, `added the SessionStart hook in ${hook.path}`], 'the installed copy adds the prompt and session hooks next to the Stop hook')
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
  const session = sessionHookFor(home, join(home, '.claude'))
  assert.deepEqual(ensureOwnStopHook(hook, true), [`added the Stop hook in ${hook.path}`, `updated the UserPromptSubmit hook in ${hook.path}`, `added the SessionStart hook in ${hook.path}`])
  assert.deepEqual(read(hook.path), { model: 'opus', hooks: { Stop: [orcaStop, hook.entry], UserPromptSubmit: [orcaPrompt, prompt.entry], SessionStart: [session.entry] } })
  assert.deepEqual(ensureOwnStopHook(hook, true), [], 'a second run changes nothing')
  assert.equal(readFileSync(hook.path, 'utf8'), `${JSON.stringify(read(hook.path), null, 2)}\n`)
  writeFileSync(hook.path, '{"hooks":{"UserPromptSubmit":{}}}')
  assert.deepEqual(ensureOwnStopHook(hook, true), [`added the Stop hook in ${hook.path}`, `left ${hook.path}: hooks.UserPromptSubmit is not a list; the UserPromptSubmit hook is not installed`, `added the SessionStart hook in ${hook.path}`])
  rmSync(home, { recursive: true })
})

test('the SessionStart hook runs the lead bootstrap through the skill link, only in an Orca pane, on every source', () => {
  const { path, event, entry } = sessionHookFor('/h', '/h/.claude')
  assert.deepEqual([path, event], ['/h/.claude/settings.json', 'SessionStart'])
  assert.deepEqual(entry, {
    hooks: [{ type: 'command', command: 'if [ -n "${ORCA_AGENT_PANE-}" ]; then node "/h/.claude/skills/orca-flow/scripts/session-start.mjs"; fi', timeout: 10 }]
  })
})

test('the SessionStart hook goes in once, next to Orca\'s and the user\'s own, updated in place; not from a development folder', () => {
  const { home, hook } = profile()
  const session = sessionHookFor(home, join(home, '.claude'))
  const orcaStart = { hooks: [{ type: 'command', command: '/orca/agent-hooks/session-start.sh' }] }
  const userStart = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }
  const old = { type: 'command', command: 'node "/old/skills/orca-flow/scripts/session-start.mjs"', timeout: 5 }
  writeFileSync(hook.path, JSON.stringify({ hooks: { SessionStart: [orcaStart, userStart, { hooks: [old] }, { hooks: [old] }] } }))
  const dev = sessionHookFor(home, join(home, 'dev-profile'))
  assert.match(ensureOwnStopHook({ ...dev, event: 'Stop' }, false)[0], /SessionStart/, 'a development folder names it and leaves it')
  assert.equal(existsSync(dev.path), false)
  assert.ok(ensureOwnStopHook(hook, true).includes(`updated the SessionStart hook in ${hook.path}`))
  assert.deepEqual(read(hook.path).hooks.SessionStart, [orcaStart, userStart, session.entry])
  assert.deepEqual(ensureOwnStopHook(hook, true), [], 'a second run changes nothing')
  assert.deepEqual(ensureStopHook(session), [], 'nor does the hook alone')
  // It is not gated by the messageFormat opt-in: the installer writes it whatever config.json says.
  rmSync(home, { recursive: true })
})

test('Antigravity discovers the installed Flow skill and preserves existing user links', async () => {
  const { ensureOwnLinks, linksFor } = await import('./install.ts')
  const { home, claudeDir } = profile()
  try {
    const path = join(home, '.gemini', 'config', 'skills', 'orca-flow')
    const plugin = join(home, 'plugins', 'cyucelen.flow')
    const first = join(plugin, 'a'.repeat(64)), next = join(plugin, 'b'.repeat(64))
    const links = linksFor(first, home, claudeDir)
    ensureOwnLinks(links, false)
    assert.equal(existsSync(join(home, '.gemini')), false)
    ensureOwnLinks(links, true)
    assert.equal(readlinkSync(path), join(first, 'skills/orca-flow'))
    ensureOwnLinks(linksFor(next, home, claudeDir), true)
    assert.equal(readlinkSync(path), join(next, 'skills/orca-flow'))
    rmSync(path)
    symlinkSync('/fixture/user-owned', path)
    for (const repairOnly of [true, false]) ensureOwnLinks(links, true, { repairOnly })
    assert.equal(readlinkSync(path), '/fixture/user-owned')
    rmSync(path)
    const foreign = join(home, 'plugins', 'other.flow', 'c'.repeat(64), 'skills/orca-flow')
    symlinkSync(foreign, path)
    ensureOwnLinks(links, true)
    assert.equal(readlinkSync(path), foreign, 'a content-addressed path of another plugin is not ours')
  } finally { rmSync(home, { recursive: true }) }
})
