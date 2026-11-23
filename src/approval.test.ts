import { assert, test } from 'orca/testing'
import { approvalSummary, approvalTip, versionDelta } from './approval.ts'
import { updateButton } from './view.ts'
import { updateItem } from './update.ts'

// The host text as the user's screenshot showed it. Its end was cut off in the screenshot: the
// fingerprint tail and the command are reconstructed (ap1- plus 32 hex characters).
export const REASON = [
  'Grants: sidebar, storage, shell.openExternal, terminals, worktrees.',
  'Adds: panels, commands, events, keybindings, customEditors, statusBarItems.',
  'Updating 0.2.87 → 0.2.91 asks for more access: new customEditors.',
  'Source: https://github.com/cyucelen/orca-flow @ 7a7cbf9c491e664eb66e70ba83c12b44',
  'Publisher: cyucelen',
  'Only approve plugins you trust: a plugin runs with the access listed above.',
  'Fingerprint: ap1-7a7cbf9c491e664eb66e70ba83c12b44'
].join('\n')
const COMMAND = 'orca plugin update cyucelen.flow --approve ap1-7a7cbf9c491e664eb66e70ba83c12b44'
const state = { kind: 'approval' as const, version: '0.2.91', reason: REASON, command: COMMAND }

test('approval: version and access change come from the real 0.2.87 → 0.2.91 text, the details stay whole', () => {
  const a = approvalSummary(state)
  assert.equal(versionDelta(a), '0.2.87 → 0.2.91')
  assert.equal(a.access, 'new customEditors')
  assert.equal(a.text, REASON)
  assert.match(a.text, /Fingerprint: ap1-7a7cbf9c491e664eb66e70ba83c12b44/)
  assert.equal(a.command, COMMAND)
  assert.equal(a.fingerprint, 'ap1-7a7cbf9c491e664eb66e70ba83c12b44')
  assert.match(a.adds!, /customEditors/)
  assert.equal(approvalSummary(state, '0.2.88').from, '0.2.88', 'the running version wins when known')
})

test('approval: without the delta lines it still shows the whole text', () => {
  const a = approvalSummary({ version: '0.2.12', reason: 'It asks for a new command.', command: COMMAND })
  assert.deepEqual([a.from, a.to, a.access, a.text], [null, '0.2.12', null, 'It asks for a new command.'])
  assert.equal(versionDelta(a), '0.2.12')
})

test('approval: tooltips are one short line, never the host text or the command', () => {
  assert.equal(approvalTip(state), 'Orca Flow 0.2.91 needs your approval: new customEditors. Click for details.')
  for (const tip of [approvalTip(state), updateItem(state).tooltip!, updateButton(state)]) {
    assert.ok(!/Fingerprint|--approve|Publisher/.test(tip))
  }
  assert.match(updateButton(state), /data-tip="Orca Flow 0\.2\.91 needs your approval: new customEditors\. Click for details\."/)
})
