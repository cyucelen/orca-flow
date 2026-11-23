// Types for skill-reload.mjs, so the plugin's TypeScript (src/worker.ts) can import it.
export type ReloadRole = 'coordinator' | 'lead' | 'worker' | 'chat'
export type ReloadTarget = { pane: string; session?: string | null; role: ReloadRole; provider?: string | null; supported?: boolean; title?: string }
export type StoredTarget = { request: string; at: number; expiresAt: number; hash: string; scope: string; role: ReloadRole; session: string | null; provider: string | null; supported: boolean; title: string }
export type ReloadState = 'waiting' | 'reading' | 'reloaded' | 'unsupported'
export type ReloadStatusEntry = { pane: string; role: ReloadRole; provider: string | null; at: number; expiresAt: number; request: string; state: ReloadState; doneAt?: number }
export const RELOAD_DIR: string
export const RELOAD_TTL_MS: number
export const ROLES: ReloadRole[]
export function reloadDir(data: string): string
export function activeFile(data: string): string
export function fileKey(s: unknown): string
export function deliveredFile(data: string, pane: string, request: string): string
export function confirmedFile(data: string, key: string): string
export function skillHash(skill: string): string
export function readRequests(data: string, now?: number): Record<string, StoredTarget>
export function wasDelivered(data: string, pane: string, request: string): boolean
export function readConfirmation(data: string, who: { pane?: string | null; session?: string | null }): { pane: string | null; session: string | null; hash: string; request: string | null; at: number } | null
export function isConfirmed(target: StoredTarget, confirmation: { hash: string; at: number } | null): boolean
export function pendingTargets(data: string, now?: number): [string, StoredTarget][]
export function syncActive(data: string, now?: number): boolean
export function writeRequest(data: string, targets: ReloadTarget[], options: { hash: string; scope: string; now?: number; ttl?: number; id?: string }): { id: string; hash: string; count: number }
export function targetFor(requests: Record<string, StoredTarget>, who: { pane?: string | null; session?: string | null }): [string, StoredTarget] | null
export function reloadText(options: { skill: string; role: ReloadRole; request: string; event: string }): string
export function deliverReload(input: unknown, options: { event: string; pane?: string | null; data: string; skill: string; role?: (t: StoredTarget) => string; now?: number }): string | null
export function confirmReload(data: string, options: { pane?: string | null; session?: string | null; skill: string; request?: string | null; now?: number }): { entry: { pane: string | null; session: string | null; hash: string; request: string | null; at: number }; message: string }
export const CONFIRM_WINDOW_MS: number
export function readingTargets(data: string, now?: number): [string, StoredTarget][]
export function confirmCommandOf(input: unknown): string | null
export function confirmFromToolCall(input: unknown, options: { pane?: string | null; data: string; skill: string; now?: number }): boolean
export function reloadStatus(data: string, now?: number): ReloadStatusEntry[]
