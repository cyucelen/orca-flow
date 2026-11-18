// Types for frame.mjs, so the plugin's TypeScript (src/summarize.ts) can import it.
export type Miss = { rule: string; detail: string }
export type Frame = {
  header: string
  status: string | null
  problem: string | null
  ask: string | null
  options: string[]
  reply: string | null
  next: string | null
}
export const STATUS_WORDS: string[]
export const ASK_TYPES: string[]
export const LABELS: string[]
export const LEVELS: string[]
export const NEEDS_REPLY: RegExp
export function checkFrame(text: string, options?: { role?: string }): { ok: boolean; misses: Miss[] }
export function parseFrame(text: string): Frame | null
