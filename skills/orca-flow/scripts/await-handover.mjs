// Read-only first-turn barrier. No Orca commands, mailbox reads, writes, or work dispatch.
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function handoverGate(record, coordinator, context, caller, now) {
  if (!record || record.bootstrap?.context !== context) return { status: 'refused', reason: 'The handover attempt changed or has no bootstrap barrier.' }
  const target = record.target
  const mine = !!caller && target?.terminals?.includes(caller)
  if (record.phase === 'complete') {
    return mine && coordinator?.sessions?.current === target.id
      ? { status: 'ready', provider: record.provider, member: target.id }
      : { status: 'refused', reason: 'This conversation is not the selected handover target.' }
  }
  if (!Number.isFinite(record.bootstrap.deadline) || now >= record.bootstrap.deadline) return { status: 'expired', reason: 'Cutover did not complete within the bootstrap window; keep the original current.' }
  // A failed reveal/transport may be retried within this SAME window. Ending the first turn on
  // its temporary error would recreate the lost-wakeup bug. A later attempt has a different token.
  return { status: 'waiting' }
}

export async function awaitHandover({ dir, context, caller, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), read = (file) => JSON.parse(readFileSync(file, 'utf8')) }) {
  // The local cap also bounds malformed/future-dated records. Neither the agent nor Retry extends it.
  const end = now() + 120_000
  for (;;) {
    let result
    try { result = handoverGate(read(join(dir, '.orca-flow-handover.json')), read(join(dir, 'coordinator.json')), context, caller, now()) }
    // coordinator.json may be between truncate and write. A transient read failure must not end
    // the first turn while the backend can still commit. Keep waiting, with the same local cap.
    catch { result = { status: 'waiting' } }
    if (result.status !== 'waiting') return result
    if (now() >= end) return { status: 'expired', reason: 'The bounded bootstrap wait ended without cutover.' }
    await sleep(Math.min(250, end - now()))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const context = process.argv[2]
  if (!context) throw new Error('usage: node await-handover.mjs <exact-context-path>')
  const result = await awaitHandover({ dir: process.cwd(), context, caller: process.env.ORCA_TERMINAL_HANDLE })
  console.log(JSON.stringify(result))
  process.exitCode = result.status === 'ready' ? 0 : 1
}
