// The agent message frame, checked and read. skills/orca-flow/messages.md is the spec: a change
// to a status word, label or rule there changes the constants and rules here, in the same commit.
// Pure functions, no dependencies: the Stop hook (stop-check.mjs) and the plugin import this file.

/** The five status words; `Waiting on you` takes one of the ask types after it. */
export const STATUS_WORDS = ['Working', 'Waiting on you', 'Blocked', 'Ready for review', 'Done']
export const ASK_TYPES = ['decision', 'approval', 'review', 'info']
/** Every bold label a frame line may start with. */
export const LABELS = ['Status', 'Done', 'Plan', 'Problem', 'Cause', 'Evidence', 'Steps', 'Result', 'Link', 'Answer', 'Waiting', 'Running', 'Room', 'Ask', 'Reply', 'Warning', 'Caution', 'Next']
/** The priority words that end a header and a route line. */
export const LEVELS = ['now', 'today', 'soon', 'someday']
/** A status that stops until the user replies, so its frame needs a Reply line. */
export const NEEDS_REPLY = /^(Waiting on you: |Blocked$|Ready for review$)/

const STATUS = new RegExp(`^(${STATUS_WORDS.filter((w) => w !== 'Waiting on you').join('|')}|Waiting on you: (${ASK_TYPES.join('|')}))$`)
const ROUTE = new RegExp(`^\\S.* → lead in [^\\s/]+/\\S+ · (${LEVELS.join('|')})$`)
const HEADER = /^\*\*[^*].*\*\*$/
const LABEL = /^\*\*([^*:]+):\*\*/

/** The message's lines, trimmed, without the lines of ``` code fences (the fence lines too). */
function linesOf(text) {
  const out = []
  let fenced = false
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) fenced = !fenced
    else if (!fenced) out.push(line)
  }
  return out
}

const labelOf = (line) => LABEL.exec(line)?.[1] ?? null
const valueOf = (line) => line.replace(LABEL, '').trim()
const nextFilled = (lines, i) => lines.slice(i + 1).find((l) => l !== '') ?? ''

/**
 * The frame: from its header (the last whole-bold line with " · " that a Status line follows, or for
 * a coordinator a Waiting line, which makes it a Briefing) to the end of the message.
 */
function findFrame(lines, briefing) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!HEADER.test(lines[i]) || !lines[i].includes(' · ')) continue
    const after = labelOf(nextFilled(lines, i))
    if (after === 'Status' || (briefing && after === 'Waiting')) return { header: lines[i], lines: lines.slice(i), briefing: after === 'Waiting' }
  }
  return null
}

/**
 * Checks the last message of a turn against the frame. `role` is 'coordinator', 'lead' or another
 * role: only a coordinator may write route lines or a Briefing.
 * Returns { ok, misses: [{ rule, detail }] }; rules: route lines pass whole, then header,
 * status-word, briefing, next-last, reply, label.
 */
export function checkFrame(text, { role } = {}) {
  const lines = linesOf(text)
  const filled = lines.filter((l) => l !== '')
  const coordinator = role === 'coordinator'
  if (coordinator && filled.length > 0 && filled.every((l) => ROUTE.test(l))) return { ok: true, misses: [] }

  const frame = findFrame(lines, coordinator)
  if (!frame) return { ok: false, misses: [{ rule: 'header', detail: 'the message has no frame header (**ticket · workstream · level** followed by **Status:**)' }] }

  const misses = []
  const labelled = frame.lines.filter((l) => labelOf(l))
  const has = (label) => labelled.some((l) => labelOf(l) === label)
  const statusLine = labelled.find((l) => labelOf(l) === 'Status')
  const status = statusLine ? valueOf(statusLine).replace(/\.$/, '') : null
  if (frame.briefing) {
    const missing = ['Running', 'Room'].filter((l) => !has(l))
    if (missing.length) misses.push({ rule: 'briefing', detail: `a Briefing needs ${missing.map((l) => `**${l}:**`).join(' and ')}` })
  } else if (!STATUS.test(status)) {
    misses.push({ rule: 'status-word', detail: `Status "${status}" is not one of: ${STATUS_WORDS.join(', ')}` })
  }

  // The frame is the last thing: a code block after it counts too, so read the raw last line.
  const last = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
  if (!last.startsWith('**Next:**')) misses.push({ rule: 'next-last', detail: 'the last line is not **Next:**' })

  if (status && NEEDS_REPLY.test(status) && !has('Reply')) misses.push({ rule: 'reply', detail: `Status "${status}" needs a **Reply:** line` })

  for (const line of labelled) {
    const label = labelOf(line)
    if (!LABELS.includes(label)) misses.push({ rule: 'label', detail: `**${label}:** is not a frame label` })
  }
  return { ok: misses.length === 0, misses }
}

/**
 * Reads the frame's header, status, ask, reply and next, or null when the message has no frame
 * header. It does not judge the frame: pair it with checkFrame to know the frame is valid.
 * `status` is null for a Briefing; `ask` keeps its option lines, one per line.
 */
export function parseFrame(text) {
  const frame = findFrame(linesOf(text), true)
  if (!frame) return null
  const out = { header: frame.header.slice(2, -2).trim(), status: null, ask: null, reply: null, next: null }
  let open = null
  for (const line of frame.lines) {
    const label = labelOf(line)
    if (label) {
      open = null
      const value = valueOf(line)
      if (label === 'Status') out.status = value.replace(/\.$/, '')
      else if (label === 'Ask') (out.ask = value), (open = 'ask')
      else if (label === 'Reply') out.reply = value
      else if (label === 'Next') out.next = value
    } else if (open === 'ask' && line !== '') {
      out.ask = out.ask ? `${out.ask}\n${line}` : line
    } else if (line === '') open = null
  }
  return out
}
