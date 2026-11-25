// Types for goal-next.mjs.
type StepLike = { text: string; done?: boolean }
type NextOf = { next?: string; steps?: StepLike[] }
/** A goal's next step: its written next ({ text }), else its first open step ({ text, fromStep: 1-based number }), else null. */
export function goalNext(g: NextOf | null | undefined): { text: string; fromStep?: number } | null
/** The next step's text, '' when there is none. */
export function nextText(g: NextOf | null | undefined): string
/** True when the goal has steps and every one is done. */
export function allStepsDone(g: Pick<NextOf, 'steps'> | null | undefined): boolean
