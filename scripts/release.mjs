#!/usr/bin/env node
// Decides the release for a PR merged into main; .github/workflows/release.yml runs it.
//
//   node scripts/release.mjs [--event <file>] [--manifest <file>]
//
// The event defaults to $GITHUB_EVENT_PATH; tags come from the git checkout. When the release
// needs a version bump it rewrites the manifest. It prints `key=value` lines for $GITHUB_OUTPUT:
// release, version, tag, bump, notes, message, tag_message.
//
// The rules:
// - A `no-release` label: no release.
// - This PR already has a tag (its Pull-Request trailer): release that tag again, so a rerun
//   finishes what an earlier run left undone. The workflow skips what already exists.
// - The manifest is above the newest tag (bumped by hand, or an old-style "Orca Flow X.Y.Z" release
//   PR): release that version as it is, without a bump commit.
// - A release PR (title "Orca Flow X.Y.Z" or branch release-*) whose version is already tagged: no
//   release. Release PRs never bump.
// - Otherwise bump from max(newest tag, manifest): patch, or minor/major with `release:minor` or
//   `release:major`.
//
// The notes list every first-parent commit on main since the newest tag, one "- <subject>" line
// each, so a release also names commits pushed straight to main and PRs whose own run GitHub
// cancelled. Release commits and bot commits are left out. An empty range falls back to the PR.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

export function parseVersion(v) {
  const m = VERSION.exec(String(v).replace(/^v/, ''))
  return m ? m.slice(1).map(Number) : null
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/** The newest vX.Y.Z tag as X.Y.Z, or null. Other tags are ignored. */
export function newestTag(tags) {
  return tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.slice(1)).sort(compareVersions).at(-1) ?? null
}

export function bumpVersion(version, level) {
  const [major, minor, patch] = parseVersion(version)
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function bumpLevel(labels) {
  return labels.includes('release:major') ? 'major' : labels.includes('release:minor') ? 'minor' : 'patch'
}

/** An old-style PR that only bumps the version: title "Orca Flow X.Y.Z" or a release-* branch. */
export function isReleasePr({ title = '', head = '' }) {
  return /^Orca Flow \d+\.\d+\.\d+$/.test(title.trim()) || head.startsWith('release-')
}

export function noteLine({ number, title }) {
  return `- ${title.trim()} (#${number})`
}

const RELEASE_COMMIT = /^Orca Flow \d+\.\d+\.\d+( \(#\d+\))?$/

/** Note lines for commits since the newest tag ({ subject, author }, oldest first), or '' when none count. */
export function notesFrom(commits = []) {
  return commits
    .filter((c) => !RELEASE_COMMIT.test(c.subject.trim()) && !/\[bot\]$/.test(c.author ?? ''))
    .map((c) => `- ${c.subject.trim()}`)
    .join('\n')
}

/** The commit message, as earlier release commits read: "Orca Flow X.Y.Z", a blank line, the notes. */
export function commitMessage(version, notes) {
  return `Orca Flow ${version}\n\n${notes}`
}

/** The annotated tag's message: the commit message plus a trailer naming the PR, so reruns find it. */
export function tagMessage(version, notes, number) {
  return `${commitMessage(version, notes)}\n\nPull-Request: #${number}`
}

/** PR number -> version, from the Pull-Request trailers of tags this script made. */
export function releasedPrs(tags) {
  const out = new Map()
  for (const { name, message } of tags) {
    const m = /^Pull-Request: #(\d+)$/m.exec(message ?? '')
    if (m && /^v\d+\.\d+\.\d+$/.test(name)) out.set(Number(m[1]), name.slice(1))
  }
  return out
}

/**
 * The release for one merged PR.
 * input: { manifest, tags: [{ name, message }], pr: { number, title, labels, head, body },
 *          commits?: first-parent commits on main since the newest tag, [{ subject, author }] oldest first,
 *          handNotes?: notes written for a hand-bumped version (the body of its "Orca Flow X.Y.Z" commit) }
 * returns { release: false, reason } or { release: true, version, bump, notes, reason }
 */
export function decide({ manifest, tags, pr, commits, handNotes }) {
  const labels = pr.labels ?? []
  if (labels.includes('no-release')) return { release: false, reason: 'no-release label' }
  if (!parseVersion(manifest)) throw new Error(`manifest version is not X.Y.Z: ${manifest}`)

  const done = releasedPrs(tags).get(pr.number)
  if (done) {
    const message = tags.find((t) => t.name === `v${done}`).message
    const notes = message.replace(/^Orca Flow .*\n\n/, '').replace(/\n\nPull-Request: #\d+\s*$/, '')
    return { release: true, version: done, bump: false, notes, reason: `#${pr.number} already tagged v${done}; finishing it` }
  }

  const newest = newestTag(tags.map((t) => t.name))
  const release = isReleasePr(pr)
  if (!newest || compareVersions(manifest, newest) > 0) {
    const notes = handNotes?.trim() || notesFrom(commits) || (release && pr.body?.trim()) || noteLine(pr)
    return { release: true, version: manifest, bump: false, notes, reason: `manifest ${manifest} is above the newest tag ${newest ?? '(none)'}` }
  }
  if (release) return { release: false, reason: `release PR for ${manifest}, already tagged` }

  // Here the manifest is at or below the newest tag, so max(newest tag, manifest) is the tag.
  const level = bumpLevel(labels)
  return { release: true, version: bumpVersion(newest, level), bump: true, notes: notesFrom(commits) || noteLine(pr), reason: `${level} bump from ${newest}` }
}

/**
 * The manifest text with a new top-level version and every other byte unchanged. A JSON round trip
 * would not do: it rewrites escapes such as "\u2026" in the file.
 */
export function withVersion(text, version) {
  const top = /^(  "version"\s*:\s*")[^"]*(")/m
  if (!top.test(text)) throw new Error('no top-level "version" in the manifest')
  const out = text.replace(top, `$1${version}$2`)
  if (JSON.parse(out).version !== version) throw new Error('the manifest version did not change')
  return out
}

/** $GITHUB_OUTPUT lines; multi-line values use a heredoc with a delimiter they cannot contain. */
export function outputs(values, delimiter = `EOF_${randomBytes(8).toString('hex')}`) {
  return Object.entries(values)
    .map(([k, v]) => (String(v).includes('\n') || k === 'notes' || k.endsWith('message') ? `${k}<<${delimiter}\n${v}\n${delimiter}` : `${k}=${v}`))
    .join('\n') + '\n'
}

/** The PR fields this script reads, from a pull_request event. */
export function prFromEvent(event) {
  const p = event.pull_request
  return { number: p.number, title: p.title ?? '', body: p.body ?? '', head: p.head?.ref ?? '', labels: (p.labels ?? []).map((l) => l.name) }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

/** vX.Y.Z tags with their annotation messages (a lightweight tag gives its commit's message). */
function gitTags() {
  return git('for-each-ref', 'refs/tags/v*', '--format=%(refname:short)%00%(contents)%01')
    .split('\x01')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((s) => ({ name: s.split('\0')[0], message: s.split('\0')[1] ?? '' }))
}

/** First-parent commits on HEAD since the tag, oldest first; none without a tag. */
function commitsSince(tag) {
  if (!tag) return []
  return git('log', '--first-parent', '--reverse', '--format=%an%x00%s%x01', `${tag}..HEAD`)
    .split('\x01')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((s) => ({ author: s.split('\0')[0], subject: s.split('\0')[1] ?? '' }))
}

/** The body of the newest commit titled "Orca Flow <version>" (squashed: "... (#n)"), without trailers, or ''. */
function handNotesFor(version) {
  const title = `^Orca Flow ${version.replaceAll('.', '\\.')}( \\(#[0-9]+\\))?$`
  const body = git('log', '-1', '--format=%b', '--extended-regexp', `--grep=${title}`)
  return body.replace(/\n(Co-Authored-By|Signed-off-by):.*$/gim, '').trim()
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const eventPath = arg('--event') ?? process.env.GITHUB_EVENT_PATH
  const manifestPath = arg('--manifest') ?? fileURLToPath(new URL('../orca-plugin.json', import.meta.url))
  if (!eventPath) throw new Error('no event: pass --event <file> or set GITHUB_EVENT_PATH')

  const pr = prFromEvent(JSON.parse(readFileSync(eventPath, 'utf8')))
  const text = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(text).version
  const tags = gitTags()
  const newest = newestTag(tags.map((t) => t.name))
  const r = decide({ manifest, tags, pr, commits: commitsSince(newest && `v${newest}`), handNotes: handNotesFor(manifest) })
  console.error(`release: ${r.release ? `v${r.version}` : 'none'} (${r.reason})`)
  if (!r.release) return process.stdout.write(outputs({ release: false }))

  if (r.bump) writeFileSync(manifestPath, withVersion(text, r.version))
  process.stdout.write(outputs({
    release: true,
    version: r.version,
    tag: `v${r.version}`,
    bump: r.bump,
    notes: r.notes,
    message: commitMessage(r.version, r.notes),
    tag_message: tagMessage(r.version, r.notes, pr.number)
  }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
