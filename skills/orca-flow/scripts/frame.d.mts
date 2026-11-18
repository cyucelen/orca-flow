// Types for frame.mjs, so the plugin's TypeScript (src/summarize.ts) can import it.
export type Miss = { rule: string; detail: string }
export type Frame = {
  status: string
  /** The ask's kind, derived from the frame's shape: never shown to the user. */
  kind: 'decision' | 'approval' | 'review' | 'info' | 'action' | 'none'
  /** False for an ask under `Working · needs ... later`, and for no ask. */
  blocking: boolean
  context: string
  ask: string | null
  options: string[]
  reply: string | null
  steps: string[]
  next: string | null
  warning: string | null
}
export const STATUS_WORDS: string[]
export const ASK_TYPES: string[]
export const OLD_STATUS: Record<string, string>
export const LABELS: string[]
export const LEVELS: string[]
export const CONTEXT_SENTENCES: number
export const COST: RegExp
export const LETTERED: RegExp[]
export function sentencesOf(text: string): string[]
export function checkFrame(text: string, options?: { role?: string }): { ok: boolean; misses: Miss[] }
export function parseFrame(text: string): Frame | null
