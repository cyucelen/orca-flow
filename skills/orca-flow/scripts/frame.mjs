// The agent message frame, checked and read. skills/orca-flow/messages.md is the spec: a change
// to a status word, label or rule there changes the constants and rules here, in the same commit.
// Pure functions, no dependencies: the Stop hook (stop-check.mjs) and the plugin import this file.
//
// The frame: a status line (bold as a whole) that names the user's need in plain words, a short
// context paragraph that says why first, then the Ask with its options and Reply when there is an
// ask. Steps for a hand action, Warning or Caution only when needed, Next last and only when
// needed. Detail goes above the frame.

/**
 * The status lines: Working, Idle and Done as they are; `Working · needs <thing> later` for an ask
 * that does not stop the work; `Needs <plain words>` for one that does (`Needs you to <action>` for
 * a hand action).
 */
export const STATUS_WORDS = ['Working', 'Idle', 'Done', 'Working · needs <thing> later', 'Needs <plain words>']
/** The ask kinds, derived from the frame's shape; the user never sees them. */
export const ASK_TYPES = ['decision', 'approval', 'review', 'info', 'action']
/** Status words from before round 4, and the plain line that replaces each. */
export const OLD_STATUS = {
  'Waiting on you: decision': 'Needs your pick',
  'Waiting on you: approval': 'Needs your yes',
  'Waiting on you: review': 'Needs your review',
  'Waiting on you: info': 'Needs <the thing> from you',
  'Waiting on you': 'Needs <the thing> from you',
  Blocked: 'Needs you to <action>',
  'Ready for review': 'Needs your review'
}
/** Every bold label a frame line may start with. */
export const LABELS = ['Ask', 'Reply', 'Steps', 'Warning', 'Caution', 'Next']
/** The priority words that end a route line. */
export const LEVELS = ['now', 'today', 'soon', 'someday']
/** At most this many sentences in the context paragraph. */
export const CONTEXT_SENTENCES = 4
/**
 * With a lettered Ask, letters name only its options: "option A", "options A, B" and "A/B" elsewhere
 * point at earlier options. A slash pair is A-F only, so N/A and I/O pass.
 */
export const LETTERED = [/\b(?:[Oo]ption|OPTION)s?\s+[A-Z]\b/, /\b[A-F](?:\/[A-F])+\b/]
/** A Warning or Caution about money must give a number. */
export const COST = /cost|credit|money|\$|€/i

const PLAIN = /^(?:Working|Idle|Done|Working · needs \S.* later|Needs \S.*)$/
const LATER = /^Working · needs \S.* later$/
const HAND = /^Needs you to /
/** A status phrase, new or old, without one trailing period; null when the text is none. */
const phraseOf = (text) => {
  const phrase = text.trim().replace(/\.$/, '')
  return PLAIN.test(phrase) || Object.hasOwn(OLD_STATUS, phrase) ? phrase : null
}
const ROUTE = new RegExp(`^\\S.* → lead in [^\\s/]+/\\S+ · (${LEVELS.join('|')})$`)
const BOLD = /^\*\*([^*].*)\*\*$/
const LABEL = /^\*\*([^*:]+):\*\*/
const LIST = /^(?:[-*+] |\d+[.)] )/
const OPTION = /^[-*] \*\*[A-Z][.)] /

/** The message's lines, trimmed, each marked: inside a ``` fence, or a fence line itself. */
function linesOf(text) {
  const out = []
  let fenced = false
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      fenced = !fenced
      out.push({ line, fence: true, fenced: true })
    } else out.push({ line, fence: false, fenced })
  }
  return out
}

const labelOf = (line) => LABEL.exec(line)?.[1]?.trim() ?? null
const valueOf = (line) => line.replace(LABEL, '').trim()
const statusOf = (line) => {
  const inner = BOLD.exec(line)?.[1]
  return inner ? phraseOf(inner) : null
}
/** The old shape's `**Status:** Working`: found so the checker can say what to change. */
const oldStatusOf = (line) => (labelOf(line) === 'Status' ? phraseOf(valueOf(line)) : null)

/** What a status line says about the ask: whether it stops the work, and whether it is a hand action. */
function statusKind(status) {
  const old = Object.hasOwn(OLD_STATUS, status)
  const plain = old ? OLD_STATUS[status] : status
  return {
    old,
    asks: plain.startsWith('Needs ') || LATER.test(plain),
    blocking: plain.startsWith('Needs '),
    hand: HAND.test(plain),
    pick: /\b(pick|choice|choose|decide|decision)\b/i.test(status)
  }
}

/**
 * The ask's kind, from its shape: lettered options are a decision, `Reply: yes or no` an approval,
 * a Reply that starts with "approve" a review, Steps or `Reply: done` a hand action, any other ask
 * info. No ask: 'none'.
 */
function kindOf(parts) {
  const block = (label) => parts.blocks.find((b) => b.label === label)
  const ask = block('Ask')
  const reply = block('Reply')?.value ?? ''
  if ((ask?.items ?? []).some((l) => OPTION.test(l))) return 'decision'
  if (!ask && !block('Steps') && !reply) return 'none'
  if (/^yes or no\b/i.test(reply)) return 'approval'
  if (/^approve\b/i.test(reply)) return 'review'
  if (block('Steps') || /^done\.?$/i.test(reply)) return 'action'
  return ask ? 'info' : 'none'
}

/** Sentences of a paragraph: a . ? or ! ends one only before a space or the end (not 0.2.40, plan.ts). */
export const sentencesOf = (text) => text.split(/[.?!]+(?=\s|$)/).map((s) => s.trim()).filter(Boolean)

/** The frame: from the last status line (outside code fences) to the end of the message. */
function findFrame(lines, { old = false } = {}) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].fenced) continue
    const status = statusOf(lines[i].line) ?? (old ? oldStatusOf(lines[i].line) : null)
    if (status) return { at: i, status, old: !statusOf(lines[i].line), lines: lines.slice(i + 1) }
  }
  return null
}

/**
 * Splits the frame's lines into its parts: the context paragraph, other text before the first
 * label (a second paragraph, lists, tables), and each label with its value and list items.
 */
function partsOf(frame) {
  const parts = { context: [], before: [], blocks: [], fences: 0, after: [] }
  let block = null
  let blank = false
  let paragraph = 0
  for (const { line, fence, fenced } of frame.lines) {
    if (fence || fenced) {
      if (fence) parts.fences++
      continue
    }
    if (line === '') {
      blank = true
      continue
    }
    const label = labelOf(line)
    if (label) {
      block = { label, value: valueOf(line), line, items: [] }
      parts.blocks.push(block)
    } else if (!block) {
      const plain = !LIST.test(line) && !line.startsWith('|') && !line.startsWith('#')
      if (plain && (paragraph === 0 || (paragraph === 1 && !blank && parts.before.length === 0))) {
        paragraph = 1
        parts.context.push(line)
      } else parts.before.push(line)
    } else if (LIST.test(line)) block.items.push(line)
    else if (!blank && block.items.length === 0) block.value = `${block.value} ${line}`.trim() // a wrapped label line
    else parts.after.push(line)
    blank = false
  }
  return parts
}

const miss = (rule, detail) => ({ rule, detail })

/**
 * Checks the last message of a turn against the frame. `role` is 'coordinator', 'lead' or another
 * role: only a coordinator may write route lines or a numbered list of waiting items.
 * Returns { ok, misses: [{ rule, detail }] }. Rules: status, header, context, context-long, detail,
 * label, ask, ask-status, options, recommended, letters, cost-number, next-last, status-old.
 */
export function checkFrame(text, { role } = {}) {
  const lines = linesOf(text)
  const coordinator = role === 'coordinator'
  const filled = lines.filter((l) => !l.fenced && l.line !== '')
  if (coordinator && filled.length > 0 && filled.every((l) => ROUTE.test(l.line))) return { ok: true, misses: [] }

  const frame = findFrame(lines, { old: true })
  if (!frame) return { ok: false, misses: [miss('status', `end with a bold status line that names the need in plain words: ${STATUS_WORDS.map((w) => `**${w}**`).join(', ')}`)] }

  const misses = []
  const before = lines.slice(0, frame.at).filter((l) => !l.fenced && l.line !== '').at(-1)?.line ?? ''
  if (BOLD.test(before) && before.includes(' · ')) misses.push(miss('header', 'remove the header line (ticket · workstream · level) above the status'))

  const status = frame.status
  const said = statusKind(status)
  if (said.old) misses.push(miss('status-old', `write the need in plain words: **${OLD_STATUS[status]}**, not "${status}"`))

  const parts = partsOf(frame)
  if (frame.old) parts.blocks.unshift({ label: 'Status', value: frame.status, line: '', items: [] })
  if (parts.context.length === 0) misses.push(miss('context', 'add a context paragraph of 2-4 sentences under the status line'))
  else {
    const n = sentencesOf(parts.context.join(' ')).length
    if (n > CONTEXT_SENTENCES) misses.push(miss('context-long', `cut the context to ${CONTEXT_SENTENCES} sentences (it has ${n}); move detail above the frame`))
  }

  const lists = parts.before.filter((l) => LIST.test(l))
  const waitingList = coordinator && lists.length > 0 && lists.every((l) => /^\d+[.)] /.test(l))
  const stray = parts.before.filter((l) => !(waitingList && /^\d+[.)] /.test(l)))
  const misplaced = parts.blocks.flatMap((b) => (b.label === 'Ask' || b.label === 'Steps' ? [] : b.items))
  if (parts.fences || stray.length || parts.after.length || misplaced.length) {
    const what = [parts.fences && 'code', stray.some((l) => l.startsWith('|')) && 'a table', stray.some((l) => l.startsWith('#')) && 'a heading',
      (stray.some((l) => LIST.test(l)) || misplaced.length) && 'a list', (stray.some((l) => !LIST.test(l) && !/^[|#]/.test(l)) || parts.after.length) && 'a second paragraph'].filter(Boolean)
    misses.push(miss('detail', `move ${what.join(', ')} above the status line; the frame only points to it ("table above")`))
  }

  for (const b of parts.blocks) if (!LABELS.includes(b.label)) misses.push(miss('label', `drop the **${b.label}:** label; its content goes in the context paragraph`))

  const has = (label) => parts.blocks.some((b) => b.label === label)
  if (said.hand && (!has('Reply') || !(has('Steps') || has('Ask')))) {
    misses.push(miss('ask', `"${status}" needs **Steps:** (or **Ask:**) and **Reply:** done`))
  } else if (said.asks && !said.hand && (!has('Ask') || !has('Reply'))) {
    misses.push(miss('ask', `"${status}" needs ${[!has('Ask') && '**Ask:**', !has('Reply') && '**Reply:**'].filter(Boolean).join(' and ')}`))
  }
  if (!said.asks && has('Ask')) {
    misses.push(miss('ask-status', `an **Ask:** needs a status that names the need: **Needs ...**, or **Working · needs ... later** while work goes on (not ${status})`))
  }

  const options = parts.blocks.filter((b) => b.label === 'Ask').flatMap((b) => b.items).filter((l) => OPTION.test(l))
  if (said.asks && (options.length > 0 || said.pick)) {
    if (options.length < 2) misses.push(miss('options', 'a decision needs 2 or more options as bullets: - **A. ...**'))
    else {
      const marked = options.filter((l) => /\(recommended\)/i.test(l)).length
      if (marked !== 1) misses.push(miss('recommended', `mark exactly one option (recommended); ${marked} are marked`))
    }
  }

  const lettered = parts.blocks.filter((b) => b.label === 'Ask').flatMap((b) => b.items).some((l) => OPTION.test(l))
  if (lettered) {
    const found = lines
      .filter((l) => !l.fenced && !OPTION.test(l.line) && labelOf(l.line) !== 'Reply')
      .map((l) => LETTERED.map((re) => re.exec(l.line)?.[0]).find(Boolean))
      .find(Boolean)
    if (found) misses.push(miss('letters', `option letters belong to the current Ask: name earlier options by what they are; refer to a current option by its bare letter (found "${found}")`))
  }

  for (const b of parts.blocks) {
    if ((b.label === 'Warning' || b.label === 'Caution') && COST.test(b.value) && !/\d/.test(b.value)) {
      misses.push(miss('cost-number', `give the cost in **${b.label}:** as a number (about $6)`))
    }
  }

  const last = parts.blocks.at(-1)
  if (has('Next') && (last?.label !== 'Next' || last.items.length > 0)) misses.push(miss('next-last', 'put **Next:** last, or leave it out'))
  return { ok: misses.length === 0, misses }
}

/** An option bullet's label: "- **A. All documents (recommended).** …" gives "A. All documents". */
const optionLabel = (line) => {
  const bold = /^[-*] \*\*([^*]+)\*\*/.exec(line)?.[1]
  return bold ? bold.replace(/\s*\([^)]*\)/g, '').replace(/[.:]\s*$/, '').trim() : null
}

/**
 * Reads the frame: status line, the ask's kind (derived, or 'none') and whether it stops the work,
 * context paragraph, ask, its option labels, reply, steps, next and the Warning or Caution text;
 * null when the message has no plain status line (an old status word, or the old header and
 * **Status:** shape). It does not judge the frame: pair it with checkFrame.
 */
export function parseFrame(text) {
  const frame = findFrame(linesOf(text))
  if (!frame || statusKind(frame.status).old) return null
  const parts = partsOf(frame)
  const said = statusKind(frame.status)
  const kind = said.asks ? kindOf(parts) : 'none'
  const block = (label) => parts.blocks.find((b) => b.label === label)
  const ask = block('Ask')
  const warning = parts.blocks.find((b) => b.label === 'Warning' || b.label === 'Caution')
  return {
    status: frame.status,
    kind,
    blocking: kind !== 'none' && said.blocking,
    context: parts.context.join(' '),
    ask: ask?.value ?? null,
    options: (ask?.items ?? []).map(optionLabel).filter(Boolean),
    reply: block('Reply')?.value ?? null,
    steps: (block('Steps')?.items ?? []).map((l) => l.replace(LIST, '').trim()),
    next: block('Next')?.value ?? null,
    warning: warning?.value ?? null
  }
}
