// The one rule for a goal's next step, shared by goals.mjs (CLI and worker) and the panel (src/goals-view.ts bundles it).
// No Node imports. A goal's effective next is its written `next`, else the text of its first open (not done) step, in
// list order. It is derived on every read and never stored, so it follows the steps as they are ticked.
const clean = (s) => String(s ?? '').trim()

/**
 * The goal's next step: { text } for its written next, { text, fromStep } (the 1-based number of the step) when it is the
 * first open step, null when there is neither (no steps, or every step is done, and no written next).
 */
export function goalNext(g) {
  const written = clean(g?.next)
  if (written) return { text: written }
  const steps = Array.isArray(g?.steps) ? g.steps : []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const text = clean(s?.text)
    if (!s?.done && text) return { text, fromStep: i + 1 }
  }
  return null
}

/** The effective next's text, '' when there is none. */
export const nextText = (g) => goalNext(g)?.text ?? ''

/** True when the goal has steps and every one is done. */
export const allStepsDone = (g) => Array.isArray(g?.steps) && g.steps.length > 0 && g.steps.every((s) => !!s?.done)
