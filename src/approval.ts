/**
 * An update that needs approval, read for display: the version change and the access change pulled
 * out of the host's own text, which is kept whole for the details. Never approves anything; the
 * person runs the command themselves.
 */
export type ApprovalSummary = { from: string | null; to: string; access: string | null; adds: string | null; fingerprint: string | null; text: string; command: string }

/** `Updating 0.2.87 → 0.2.91 asks for more access: new customEditors.` The pieces are optional. */
export function approvalSummary(state: { version: string; reason: string; command: string; fingerprint?: string }, running?: string | null): ApprovalSummary {
  const reason = state.reason ?? ''
  const move = /Updating\s+v?([0-9][\w.+-]*)\s*(?:→|->|to)\s*v?([0-9][\w.+-]*)/i.exec(reason)
  const access = /asks for (?:more|new|different) access:?\s*(.*?)(?:\.(?=\s|$)|$)/im.exec(reason)?.[1]?.trim()
  return {
    from: running || move?.[1] || null,
    to: state.version || move?.[2] || '',
    access: access || null,
    adds: /^\s*Adds:\s*(.+)$/im.exec(reason)?.[1]?.trim() || null,
    fingerprint: state.fingerprint ?? /Fingerprint:\s*(ap\d+-[0-9a-f]+)/i.exec(reason)?.[1] ?? null,
    text: reason.trim(),
    command: state.command
  }
}

/** The one line a tooltip carries: never the host's full text. */
export function approvalTip(state: { version: string; reason: string; command: string }): string {
  const a = approvalSummary(state)
  return `Orca Flow ${a.to} needs your approval${a.access ? `: ${a.access}` : ''}. Click for details.`
}

/** The summary line under the dialog title: `0.2.87 → 0.2.91`. */
export function versionDelta(a: ApprovalSummary): string {
  return a.from ? `${a.from} → ${a.to}` : a.to
}

const KIND: Record<string, string> = { customEditors: 'custom editor', panels: 'panel', commands: 'command', events: 'event', keybindings: 'keybinding', statusBarItems: 'status bar item' }

/**
 * The access delta as one line: the kinds named by "new customEditors" matched to the entries of that kind in the Adds line
 * (`New access: custom editor "Usage"`). With nothing to match it is the raw delta phrase; the whole Adds list is never the delta.
 */
export function accessLine(a: ApprovalSummary): string {
  if (!a.access) return 'It asks for different access than the version you run.'
  const kinds = a.access.split(/[\s,;]+/).filter((k) => k in KIND)
  const entries = [...(a.adds ?? '').matchAll(/(\w+)\s+"([^"]*)"/g)].filter((m) => kinds.includes(m[1]) && m[2] && m[2] !== '...')
  if (!entries.length) return `Asks for more access: ${a.access}.`
  return `New access: ${entries.map((m) => `${KIND[m[1]]} "${m[2]}"`).join(', ')}.`
}
