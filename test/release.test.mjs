// node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { commitMessage, decide, newestTag, notesFrom, outputs, prFromEvent, tagMessage, withVersion } from '../scripts/release.mjs'

const tag = (v, message = `Orca Flow ${v}\n\n- something`) => ({ name: `v${v}`, message })
const tags = [tag('0.2.9'), tag('0.2.28'), tag('0.2.30')]
const pr = (extra = {}) => ({ number: 12, title: 'X', labels: [], head: 'feature', body: '', ...extra })
const at = (manifest, p = pr(), t = tags, handNotes = '', commits = []) => decide({ manifest, tags: t, pr: p, handNotes, commits })

test('newest tag compares numbers, not text, and ignores other tags', () => {
  assert.equal(newestTag(['v0.2.9', 'v0.2.30', 'v0.2.28', 'latest', 'v1.0.0-rc1']), '0.2.30')
  assert.equal(newestTag([]), null)
})

test('a merged PR is a patch release by default', () => {
  assert.deepEqual(at('0.2.30'), { release: true, version: '0.2.31', bump: true, notes: '- X (#12)', reason: 'patch bump from 0.2.30' })
})

test('release:minor and release:major labels pick the bump', () => {
  assert.equal(at('0.2.30', pr({ labels: ['release:minor'] })).version, '0.3.0')
  assert.equal(at('0.2.30', pr({ labels: ['release:major'] })).version, '1.0.0')
  assert.equal(at('0.2.30', pr({ labels: ['release:minor', 'release:major'] })).version, '1.0.0')
})

test('no-release label: nothing, even when the manifest was bumped', () => {
  assert.equal(at('0.2.30', pr({ labels: ['no-release'] })).release, false)
  assert.equal(at('0.2.31', pr({ labels: ['no-release'] })).release, false)
})

test('a manifest bumped by hand above the newest tag is released as it is', () => {
  const r = at('0.3.0', pr({ labels: ['release:major'] }))
  assert.deepEqual([r.release, r.version, r.bump, r.notes], [true, '0.3.0', false, '- X (#12)'])
  // The notes of its "Orca Flow X.Y.Z" commit win when there is one.
  assert.equal(at('0.3.0', pr(), tags, '- Hand-written note').notes, '- Hand-written note')
  // No tags at all: the manifest version is the first release.
  assert.equal(at('0.1.0', pr(), []).version, '0.1.0')
})

test('a manifest behind the newest tag bumps from the tag', () => {
  assert.equal(at('0.2.20').version, '0.2.31')
})

test('old-style release PRs are tagged as they are and never bumped', () => {
  const release = pr({ title: 'Orca Flow 0.2.31', head: 'cyucelen/bump', body: '- Bullet one\n- Bullet two\n' })
  const r = at('0.2.31', release)
  assert.deepEqual([r.release, r.version, r.bump, r.notes], [true, '0.2.31', false, '- Bullet one\n- Bullet two'])
  // Already tagged by hand: nothing to do, and no bump to 0.2.32.
  assert.equal(at('0.2.30', release).release, false)
  assert.equal(at('0.2.30', pr({ head: 'release-0.2.30', title: 'Bump' })).release, false)
  assert.equal(at('0.2.31', pr({ head: 'release-0.2.31', title: 'Bump' })).version, '0.2.31')
})

test('a rerun after the tag was pushed finishes the same release instead of bumping again', () => {
  const ours = { name: 'v0.2.31', message: tagMessage('0.2.31', '- X (#12)', 12) }
  const r = at('0.2.31', pr(), [...tags, ours])
  assert.deepEqual([r.release, r.version, r.bump, r.notes], [true, '0.2.31', false, '- X (#12)'])
  // Another PR after it bumps as usual.
  assert.equal(at('0.2.31', pr({ number: 13 }), [...tags, ours]).version, '0.2.32')
})

test('commit and tag text match earlier release commits', () => {
  assert.equal(commitMessage('0.2.31', '- X (#12)'), 'Orca Flow 0.2.31\n\n- X (#12)')
  assert.equal(tagMessage('0.2.31', '- X (#12)', 12), 'Orca Flow 0.2.31\n\n- X (#12)\n\nPull-Request: #12')
  assert.equal(at('0.2.30', pr({ title: '  Memory as a treemap ', number: 10 })).notes, '- Memory as a treemap (#10)')
})

test('the manifest rewrite only changes the version and keeps the formatting', () => {
  const text = readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')
  const out = withVersion(text, '9.9.9')
  const version = JSON.parse(text).version
  assert.equal(out, text.replace(`"version": "${version}"`, '"version": "9.9.9"'))
  assert.ok(out.endsWith('}\n'))
  // Escapes stay as written.
  assert.equal(withVersion('{\n  "version": "0.1.0",\n  "text": "\\u2026"\n}\n', '0.1.1'), '{\n  "version": "0.1.1",\n  "text": "\\u2026"\n}\n')
})

test('outputs: plain values as key=value, notes and messages as heredocs', () => {
  assert.equal(outputs({ release: true, version: '0.2.31', notes: '- X (#12)' }, 'EOF'), 'release=true\nversion=0.2.31\nnotes<<EOF\n- X (#12)\nEOF\n')
})

test('PR fields come from the pull_request event', () => {
  const event = { pull_request: { number: 12, title: 'X', body: null, head: { ref: 'feature' }, labels: [{ name: 'release:minor' }] } }
  assert.deepEqual(prFromEvent(event), { number: 12, title: 'X', body: '', head: 'feature', labels: ['release:minor'] })
})

const commit = (subject, author = 'Someone') => ({ subject, author })

test('notes list every commit on main since the newest tag, oldest first', () => {
  const commits = [commit('Option+1..9 opens chats (#13)'), commit('A resumed agent keeps its lead'), commit('X (#12)')]
  assert.equal(at('0.2.30', pr(), tags, '', commits).notes, '- Option+1..9 opens chats (#13)\n- A resumed agent keeps its lead\n- X (#12)')
})

test('notes skip release commits and bot commits', () => {
  const commits = [commit('Orca Flow 0.2.31'), commit('Orca Flow 0.2.32 (#20)'), commit('Tidy', 'github-actions[bot]'), commit('X (#12)')]
  assert.equal(notesFrom(commits), '- X (#12)')
  assert.equal(notesFrom([commit('Orca Flow 0.2.31')]), '')
})

test('an empty range, or one with only release commits, falls back to the PR line', () => {
  assert.equal(at('0.2.30', pr(), tags, '', []).notes, '- X (#12)')
  assert.equal(at('0.2.30', pr(), tags, '', [commit('Orca Flow 0.2.30')]).notes, '- X (#12)')
  // A hand-bumped version lists the commits too, unless its own release commit has notes.
  assert.equal(at('0.3.0', pr(), tags, '', [commit('Y (#11)'), commit('X (#12)')]).notes, '- Y (#11)\n- X (#12)')
  assert.equal(at('0.3.0', pr(), tags, '- Hand-written', [commit('X (#12)')]).notes, '- Hand-written')
})
