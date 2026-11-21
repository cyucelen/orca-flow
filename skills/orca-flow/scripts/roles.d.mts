// Types for roles.mjs, so the plugin's TypeScript (src/summarize.ts) can import it.
export type RoleRecord = { role: 'lead'; at: string; by: string; cwd?: string }
export const ROLES_FILE: string
export function flowDir(env?: Record<string, string | undefined>, home?: string): string
export function readRoles(data?: string): Record<string, unknown>
export function recordedRole(data: string, session: unknown): 'lead' | null
export function recordLead(data: string, session: string, options?: { by?: string; cwd?: string; at?: string }): RoleRecord
export function clearRole(data: string, session: string): boolean
export function currentSession(options?: { env?: Record<string, string | undefined>; cwd?: string; home?: string }): { id: string; from: string } | null
