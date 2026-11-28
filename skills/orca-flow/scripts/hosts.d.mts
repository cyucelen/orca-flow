// Types for hosts.mjs.
export type PairedHost = { id: string; environmentId: string; name: string; runtimeId: string | null }
export type HostStatus = { reachable: boolean; connectionState: string | null; version: string | null; runtimeId: string | null; capabilities: string[] }
export type HostMemory = { totalGB: number; availableGB: number; at: number | null }
export type Probe<W = any> = { host: PairedHost; at: number; reachable: boolean; status: HostStatus | null; worktrees: W[] | null; agents: string[] | null; memory: HostMemory | null; errors: Record<string, string> }
export type OrcaRun = (args: string[]) => Promise<any>
export const LOCAL_HOST: 'local'
export const REMOTE_WORKER_CAPABILITY: string
export const PROBE_TIMEOUT_MS: number
export const STALE_AFTER_MS: number
export function hostIdOf(environmentId: string): string
export function pairedHosts(result: unknown): PairedHost[]
export function statusOf(result: unknown): HostStatus
export function memoryOf(result: unknown): HostMemory | null
export function agentsOf(result: unknown): string[]
export function hostKey<T extends string | null | undefined>(hostId: string, id: T): T
export function relabelWorktrees<W extends Record<string, any>>(worktrees: W[] | unknown, host: { id: string; name: string }): (W & { hostId: string; hostName: string })[]
export function safeReason(e: unknown): string
export function probeHost<W = any>(host: PairedHost, orca: OrcaRun, opts?: { want?: { worktrees?: boolean; agents?: boolean; memory?: boolean }; now?: () => number }): Promise<Probe<W>>
export function findHost(hosts: PairedHost[], query: string): PairedHost | null
