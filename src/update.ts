// "Update available" in the status bar, and the update itself on click. Orca reports no update
// information for a Git install, so the worker reads the repository's version tags. The update
// runs `orca plugin update <key>` in a detached shell that outlives this worker (Orca stops the
// worker when it installs the new version) and leaves its result in RESULT_DIR for the next worker.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { approvalTip } from './approval.ts'
import type { UpdateState } from './protocol.ts'

export type { UpdateState }

export const REPO = 'https://github.com/cyucelen/orca-flow.git'

// ---------- versions ----------

type Version = [number, number, number]

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return 0
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** Release versions from `git ls-remote --tags --refs` (refs/tags/vX.Y.Z); anything else is skipped. */
export function versionsFromTags(lsRemote: string): string[] {
  return lsRemote.split('\n').map((l) => /refs\/tags\/(v\d+\.\d+\.\d+)$/.exec(l.trim())?.[1]).filter((v): v is string => Boolean(v)).map((v) => v.slice(1))
}

/** The newest release above `current`, or null. */
export function newerVersion(current: string, versions: string[]): string | null {
  const newest = [...versions].sort(compareVersions).at(-1)
  return newest && compareVersions(newest, current) > 0 ? newest : null
}

export function latestRelease(git = ['/usr/bin/git', '/opt/homebrew/bin/git', 'git'].find((p) => p === 'git' || existsSync(p))!): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(git, ['ls-remote', '--tags', '--refs', REPO], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { GIT_TERMINAL_PROMPT: '0', PATH: '/usr/bin:/bin:/opt/homebrew/bin' } }, (err, stdout) => {
      if (err) return reject(new Error(err.message.split('\n')[0]))
      resolve(versionsFromTags(stdout))
    })
  })
}

/** A release and the commit its tag points to. */
export type Release = { version: string; commit: string }

/** Releases from `git ls-remote --tags` (no --refs): an annotated tag's peeled `^{}` line gives its commit. */
export function releasesFromTags(lsRemote: string): Release[] {
  const byVersion = new Map<string, string>()
  for (const line of lsRemote.split('\n')) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/v(\d+\.\d+\.\d+)(\^\{\})?$/.exec(line.trim())
    if (m && (m[3] || !byVersion.has(m[2]))) byVersion.set(m[2], m[1])
  }
  return [...byVersion].map(([version, commit]) => ({ version, commit }))
}

export function readReleases(git = ['/usr/bin/git', '/opt/homebrew/bin/git', 'git'].find((p) => p === 'git' || existsSync(p))!): Promise<Release[]> {
  return new Promise((resolve, reject) => {
    execFile(git, ['ls-remote', '--tags', REPO], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { GIT_TERMINAL_PROMPT: '0', PATH: '/usr/bin:/bin:/opt/homebrew/bin' } }, (err, stdout) => {
      if (err) return reject(new Error(err.message.split('\n')[0]))
      resolve(releasesFromTags(stdout))
    })
  })
}

/** This plugin as `orca plugin list` reports it: where Orca installed it from. */
export type InstalledPlugin = { isDev?: boolean; source?: { kind?: string; resolvedCommit?: string } | null } | null

/**
 * Why this copy cannot update itself to a newer release, or null when it can. `orca plugin update`
 * moves a Git install from a version tag to the newest tag, but a branch install to its branch's
 * newest commit and leaves a commit pin where it is; a folder install re-copies its folder. So only a
 * copy whose commit is the running version's release tag (or a catalog install) updates to a release.
 */
export function cannotUpdate(key: string | null, current: string, plugin: InstalledPlugin, releases: Release[]): string | null {
  if (!key || plugin?.isDev) return DEV_FOLDER
  if (!current) return NO_VERSION
  const source = plugin?.source
  if (!source?.kind || source.kind === 'catalog') return null
  if (source.kind !== 'git') return `This copy was installed from a ${source.kind}, not a release, so it isn’t updated from here.`
  const tag = releases.find((r) => r.version === current)
  if (tag && source.resolvedCommit && tag.commit === source.resolvedCommit) return null
  return `This copy was installed from commit ${(source.resolvedCommit ?? 'unknown').slice(0, 7)}, not the ${current} release, so it isn’t updated from here. Reinstall from a release to get updates.`
}

/** What a check for updates found. `latest` is the newest release, which may be older than a development build. */
export type UpdateCheck =
  | { kind: 'current'; current: string; latest: string | null; at: number }
  | { kind: 'available'; current: string; version: string; at: number }
  | { kind: 'failed'; current: string; reason: string; at: number }
  | { kind: 'cannot'; current: string; reason: string; latest: string | null; at: number }

/**
 * One check, the same for the 15-minute timer and Settings' Check for Updates: only a release newer
 * than the running version is ever offered, and only to a copy that can update to it.
 */
export async function checkForUpdates(d: { key: string | null; current: string; releases: () => Promise<Release[]>; plugin: () => Promise<InstalledPlugin>; now?: () => number }): Promise<UpdateCheck> {
  const at = (d.now ?? Date.now)()
  const current = d.current
  if (!d.key || !current) return { kind: 'cannot', current, reason: d.key ? NO_VERSION : DEV_FOLDER, latest: null, at }
  let releases: Release[]
  try { releases = await d.releases() } catch (e) { return { kind: 'failed', current, reason: (e as Error).message || 'The release list could not be read.', at } }
  const plugin = await d.plugin().catch(() => null)
  const latest = [...releases.map((r) => r.version)].sort(compareVersions).at(-1) ?? null
  const reason = cannotUpdate(d.key, current, plugin, releases)
  if (reason) return { kind: 'cannot', current, reason, latest, at }
  const version = newerVersion(current, releases.map((r) => r.version))
  return version ? { kind: 'available', current, version, at } : { kind: 'current', current, latest, at }
}

// ---------- what the status bar item says ----------

/** How an update ended, as the status bar shows it. */
export type UpdateOutcome = Extract<UpdateState, { kind: 'updated' | 'approval' | 'failed' }>

export type UpdateItem = {
  id: 'update'
  visible: boolean
  text?: string
  icon?: 'download' | 'refresh' | 'check' | 'warning' | 'error'
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  tooltip?: string
}

export function updateItem(state: UpdateState): UpdateItem {
  const base = { id: 'update' as const }
  switch (state.kind) {
    case 'none':
      return { ...base, visible: false }
    case 'available':
      return { ...base, visible: true, text: `Orca Flow ${state.version} available`, icon: 'download' as const, tone: 'accent' as const, tooltip: `Click to update Orca Flow to ${state.version}` }
    case 'confirm':
      return { ...base, visible: true, text: `Update to ${state.version}? Click again`, icon: 'download' as const, tone: 'warning' as const, tooltip: 'Click again within 15 seconds to update; Orca Flow restarts on the new version' }
    case 'updating':
      return { ...base, visible: true, text: `Updating to ${state.version}…`, icon: 'refresh' as const, tone: 'neutral' as const, tooltip: 'Orca is installing the new version' }
    case 'updated':
      return { ...base, visible: true, text: `Orca Flow updated to ${state.version}`, icon: 'check' as const, tone: 'success' as const, tooltip: 'Running the new version' }
    case 'approval':
      return { ...base, visible: true, text: `Orca Flow ${state.version} needs your approval`, icon: 'warning' as const, tone: 'warning' as const, tooltip: approvalTip(state) }
    case 'failed':
      return { ...base, visible: true, text: `Orca Flow ${state.version} update failed`, icon: 'error' as const, tone: 'danger' as const, tooltip: `${state.reason}\nClick to try again` }
  }
}

/**
 * Update now: the status bar item's second click and the panel's confirmed click. Starts only from
 * available or failed (or the status bar's pending confirm); an approval never starts here: it is
 * approved only by the panel's explicit Approve and update (updater.approve).
 */
export function updateNow(state: UpdateState): { next: UpdateState; start: boolean; message: string } {
  switch (state.kind) {
    case 'available':
    case 'failed':
    case 'confirm':
      return { next: { kind: 'updating', version: state.version }, start: true, message: `Updating Orca Flow to ${state.version}…` }
    case 'approval':
      return { next: state, start: false, message: `Orca Flow ${state.version} asks for new access, so it was not installed. Open the Orca Flow panel to review it and approve, or run: ${state.command}` }
    case 'updating':
      return { next: state, start: false, message: `Already updating to ${state.version}.` }
    default:
      return { next: state, start: false, message: 'Orca Flow is up to date.' }
  }
}

/** A click on the status bar item: available asks for a second click, which updates (updateNow). */
export function onClick(state: UpdateState): { next: UpdateState; start: boolean; message: string } {
  if (state.kind === 'available' || state.kind === 'failed')
    return { next: { kind: 'confirm', version: state.version }, start: false, message: `Update Orca Flow to ${state.version}? Click the status bar item again to update.` }
  return updateNow(state)
}

export type UpdaterDeps = {
  /** The installed plugin's key; null for a development folder, which never updates itself. */
  key: string | null
  /** The running version. */
  current: string
  /** Where the detached update leaves its result (startUpdate, readUpdateResult). */
  dir: string
  /** Called on every state change: the status bar item and the panel show it. */
  show: (state: UpdateState) => void
  /** Starts `orca plugin update` for this version (startUpdate in the worker); `approve` only from an explicit Approve and update. */
  start: (version: string, approve?: string) => void
  later: (fn: () => void, ms: number) => void
  log: (message: string) => void
}

const FINGERPRINT = /^ap\d+-[0-9a-f]+$/i
export const DEV_FOLDER = 'Updates apply to an installed Orca Flow, not a development folder.'
export const NO_VERSION = 'The manifest has no version, so there is nothing to compare releases with.'

/**
 * The update's state and its actions. The status bar command (two clicks) and the panel's request
 * (after the panel's own confirm) both start the update through apply(), one path.
 */
export function updater(d: UpdaterDeps) {
  let state: UpdateState = { kind: 'none' }
  let latest: string | null = null
  const show = (next: UpdateState) => {
    state = next
    d.show(state)
  }

  // An update that fails leaves this worker running: watch for its result. One that succeeds
  // restarts the plugin, and the new worker reads the same result at start.
  const settle = (tries = 0): void => {
    const result = readUpdateResult(d.dir, d.current)
    if (result === null) return
    // Keep watching until the result lands: readUpdateResult itself gives up on a shell that never reports (5 minutes),
    // so a poll cap shorter than that left "Updating…" up forever.
    if (result === 'pending') {
      if (state.kind !== 'updating') show({ kind: 'updating', version: pendingVersion(d.dir) ?? d.current })
      return void d.later(() => settle(tries + 1), 1000)
    }
    rmSync(d.dir, { recursive: true, force: true })
    d.log(`update to ${result.version}: ${result.kind}${'reason' in result ? ` (${result.reason})` : ''}`)
    show(result)
    if (result.kind === 'updated') d.later(() => { if (state.kind === 'updated') show(latest ? { kind: 'available', version: latest } : { kind: 'none' }) }, 10_000)
  }

  const apply = (click: { next: UpdateState; start: boolean; message: string }): string => {
    if (click.next !== state) show(click.next)
    if (click.start && click.next.kind === 'updating') {
      d.start(click.next.version)
      d.log(`updating to ${click.next.version}`)
      settle()
    }
    return click.message
  }

  return {
    get state(): UpdateState {
      return state
    },
    show,
    settle,
    /** The release check's answer: the newest release above the running one, or null. */
    found(version: string | null): void {
      latest = version
      if (latest && (state.kind === 'none' || state.kind === 'available')) show({ kind: 'available', version: latest })
      // Nothing to offer any more (a copy that cannot update, a withdrawn release): stop offering it.
      else if (!latest && state.kind === 'available') show({ kind: 'none' })
    },
    /** The status bar command. */
    click(): string {
      if (!d.key) return DEV_FOLDER
      const click = onClick(state)
      const next = click.next
      if (next.kind === 'confirm') d.later(() => { if (state.kind === 'confirm') show({ kind: 'available', version: next.version }) }, 15_000)
      return apply(click)
    },
    /** The panel's request, after its confirm. */
    /**
     * Approve and update: the one place `--approve` is passed, only for the fingerprint of the approval being shown, and only
     * from the panel's explicit click. Nothing calls it on its own; a stale or new fingerprint comes back as a new approval state.
     */
    approve(fingerprint: string): { started: boolean; message: string } {
      if (!d.key) return { started: false, message: DEV_FOLDER }
      if (state.kind !== 'approval' || !state.fingerprint || state.fingerprint !== fingerprint || !FINGERPRINT.test(fingerprint)) {
        return { started: false, message: 'That approval is out of date. Review the current details first.' }
      }
      const version = state.version
      show({ kind: 'updating', version })
      d.start(version, fingerprint)
      d.log(`updating to ${version} with the approval the person gave (${fingerprint})`)
      settle()
      return { started: true, message: `Updating Orca Flow to ${version}…` }
    },
    now(): { started: boolean; message: string } {
      if (!d.key) return { started: false, message: DEV_FOLDER }
      const click = updateNow(state)
      return { started: click.start, message: apply(click) }
    }
  }
}

// ---------- running the update outside the worker ----------

/** What `orca plugin update --json` printed and how it exited, as the next worker finds it. */
export function resultOf(exit: number, output: string, key: string, version: string): UpdateOutcome {
  let parsed: any = null
  try {
    parsed = JSON.parse(output)
  } catch {}
  if (exit === 0 && parsed?.ok !== false) return { kind: 'updated', version: parsed?.result?.version ?? version }
  const code = parsed?.error?.code ?? ''
  const message: string | undefined = parsed?.error?.message
  // The host updates to its newest release, which can be newer than the one this worker offered: name what it evaluated.
  const target = /Updating\s+v?[0-9][\w.+-]*\s*(?:→|->)\s*v?([0-9][\w.+-]*)/.exec(message ?? '')?.[1] ?? version
  if (exit === 3 || code === 'approval_required' || code === 'approval_stale') {
    const fp: string | undefined = parsed?.error?.data?.approvalFingerprint
    // Never approved here: the person reads what it asks for, then approves with a click or runs the command themselves.
    return { kind: 'approval', version: target, reason: message ?? 'The new version asks for different access.', command: `orca plugin update ${key}${fp ? ` --approve ${fp}` : ''}`, ...(fp ? { fingerprint: fp } : {}) }
  }
  return { kind: 'failed', version: target, reason: parsed?.error?.message ?? (output.trim().split('\n').at(-1) || `orca plugin update exited ${exit}`) }
}

/** The version the running update was started for, or null when none is. */
export function pendingVersion(dir: string): string | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'pending.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** Starts the update in a shell that outlives this worker; it writes `exit` and `out.json` to `dir`. */
export function startUpdate(orcaBin: string, key: string, version: string, dir: string, approve?: string): void {
  if (approve !== undefined && !FINGERPRINT.test(approve)) throw new Error('Not an approval fingerprint.')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pending.json'), JSON.stringify({ key, version, at: Date.now() }))
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const script = `${q(orcaBin)} plugin update ${q(key)}${approve ? ` --approve ${q(approve)}` : ''} --json > ${q(join(dir, 'out.json'))} 2>&1; echo $? > ${q(join(dir, 'exit.tmp'))}; mv ${q(join(dir, 'exit.tmp'))} ${q(join(dir, 'exit'))}`
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * What the last update left: null when none ran, 'pending' while its shell has not finished, or its
 * outcome. Running version `current` already at the target counts as updated, whatever the files say.
 */
export function readUpdateResult(dir: string, current: string): UpdateOutcome | 'pending' | null {
  let pending: { key: string; version: string; at: number } | null = null
  try {
    pending = JSON.parse(readFileSync(join(dir, 'pending.json'), 'utf8'))
  } catch {
    return null
  }
  if (!pending) return null
  if (compareVersions(current, pending.version) >= 0) return { kind: 'updated', version: current }
  if (!existsSync(join(dir, 'exit'))) return Date.now() - pending.at < 5 * 60_000 ? 'pending' : { kind: 'failed', version: pending.version, reason: 'The update did not report back.' }
  const exit = Number(readFileSync(join(dir, 'exit'), 'utf8').trim())
  let out = ''
  try {
    out = readFileSync(join(dir, 'out.json'), 'utf8')
  } catch {}
  return resultOf(Number.isFinite(exit) ? exit : 1, out, pending.key, pending.version)
}
