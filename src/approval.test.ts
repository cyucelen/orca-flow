import { assert, test } from 'orca/testing'
import { accessLine, approvalSummary, approvalTip, versionDelta } from './approval.ts'
import { updateButton } from './view.ts'
import { updateItem } from './update.ts'

// The host text exactly as the bug-report screenshot shows it (it is the update button's tooltip, which appended the command
// after "To approve and update, run:"; the command is not part of the host's reason, so it is not here). The screenshot is cut
// off at the top, above "approval before it can run.": that first line is RECONSTRUCTED, everything below it is verbatim.
const adds = ['panels "Orca Flow"', 'commands "Jump to next waiting workspace"', 'commands "Update Orca Flow"',
  ...Array.from({ length: 9 }, (_, i) => `commands "Open chat ${i + 1} in Orca Flow"`),
  'events "agent.status.changed"', 'events "workspace.created"', 'events "workspace.removed"', 'events "workspace.changed"',
  ...Array.from({ length: 9 }, (_, i) => `keybindings "Alt+${i + 1}"`),
  'customEditors "Usage"', 'statusBarItems "..."', 'statusBarItems "Orca Flow update"'].join(', ')
export const REASON = [
  'Orca Flow needs approval before it can run.', // reconstructed
  'Approving Orca Flow (cyucelen.flow 0.2.91) grants:',
  '- Runs its own code in a separate Node.js process on the Orca host, with your user account’s access to that machine.',
  '- Store data in the plugin\'s own storage folder',
  '- Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change',
  '- Open and rename your workspaces, hide projects from the sidebar or show them again, focus their terminals, open their files in Orca, and run its built-in commands',
  '- Get notified when agent status changes',
  '- Start and resume agents in your workspaces, local and SSH',
  `Adds: ${adds}`,
  'Updating 0.2.87 → 0.2.91 asks for more access: new customEditors.',
  'Source: github.com/cyucelen/orca-flow (v0.2.91) at commit 00c29b00a75c.',
  'Publisher: cyucelen.',
  'Make sure you trust cyucelen: this plugin is not from Orca and Orca has not checked this repository, so only install it if you trust cyucelen.',
  'Why approval is needed: It can run code or act in Orca, so Orca does not enable it without an explicit approval bound to exactly these files and this access.',
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
  assert.match(a.adds!, /customEditors "Usage"/)
  assert.equal(accessLine(a), 'New access: custom editor "Usage".', 'the delta, not the whole Adds list')
  assert.ok(!accessLine(a).includes('panels'))
  assert.equal(approvalSummary(state, '0.2.88').from, '0.2.88', 'the running version wins when known')
})

test('approval: without the delta lines it still shows the whole text', () => {
  const a = approvalSummary({ version: '0.2.12', reason: 'It asks for a new command.', command: COMMAND })
  assert.deepEqual([a.from, a.to, a.access, a.text], [null, '0.2.12', null, 'It asks for a new command.'])
  assert.equal(accessLine(approvalSummary({ ...state, reason: 'Updating 1.0.0 → 1.1.0 asks for more access: new commands.' })), 'Asks for more access: new commands.', 'no Adds line: the raw phrase')
  assert.equal(versionDelta(a), '0.2.12')
})

test('approval: tooltips are one short line, never the host text or the command', () => {
  assert.equal(approvalTip(state), 'Orca Flow 0.2.91 needs your approval: new customEditors. Click for details.')
  for (const tip of [approvalTip(state), updateItem(state).tooltip!, updateButton(state)]) {
    assert.ok(!/Fingerprint|--approve|Publisher/.test(tip))
  }
  assert.match(updateButton(state), /data-tip="Orca Flow 0\.2\.91 needs your approval: new customEditors\. Click for details\."/)
})
