// Just the Node APIs the worker uses, so `tsc` passes without @types/node.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { maxBuffer?: number; timeout?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): unknown
}
declare module 'node:fs' {
  export function writeFileSync(path: string, data: string, options: { flag?: string; mode?: number }): void
  export function existsSync(path: string): boolean
}
declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): unknown
  export function readdirSync(path: string): string[]
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function watch(path: string, options: { recursive?: boolean }, listener: () => void): { close(): void }
}
declare module 'node:os' {
  export function homedir(): string
}
declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
}
declare module 'node:child_process' {
  export function execFileSync(file: string, args: readonly string[], options: { encoding: 'utf8' }): string
}
declare module 'node:fs' {
  export function readdirSync(path: string): string[]
}
declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string
  export function writeFileSync(path: string, data: string): void
}
declare module 'node:os' {
  export function tmpdir(): string
}
declare module 'node:child_process' {
  export function execFile(file: string, args: readonly string[], options: { cwd?: string; timeout?: number; maxBuffer?: number }, callback: (error: Error | null, stdout: string, stderr: string) => void): unknown
}
declare module 'node:fs' {
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
}
declare module 'node:child_process' {
  export function execFile(file: string, args: readonly string[], options: { cwd?: string; timeout?: number; maxBuffer?: number; env?: Record<string, string> }, callback: (error: Error | null, stdout: string, stderr: string) => void): unknown
}
declare module 'node:fs' {
  export function renameSync(from: string, to: string): void
}
declare const process: { env: Record<string, string | undefined>; pid: number; kill(pid: number, signal: string): void; getBuiltinModule?(id: string): any }
declare module 'node:child_process' {
  export function execFile(file: string, args: readonly string[], options: { cwd?: string; timeout?: number; maxBuffer?: number; env?: Record<string, string> }, callback: (error: Error | null, stdout: string, stderr: string) => void): { stdin: { end(data: string): void } | null }
}
declare module 'node:os' {
  export function userInfo(): { username: string }
}
declare module 'node:fs' {
  export function lstatSync(path: string): { isSymbolicLink(): boolean }
  export function readlinkSync(path: string): string
  export function symlinkSync(target: string, path: string): void
  export function unlinkSync(path: string): void
}
interface ImportMeta { url: string }
declare module 'node:fs' {
  export function copyFileSync(from: string, to: string): void
}
declare module 'node:child_process' {
  export function spawn(command: string, args: readonly string[], options: { detached?: boolean; stdio?: 'ignore' }): { unref(): void }
}
declare module 'node:fs' {
  export function chmodSync(path: string, mode: number): void
}
declare module 'node:fs' {
  export function appendFileSync(path: string, data: string): void
  export function statSync(path: string): { size: number }
  export function openSync(path: string, flags: 'r'): number
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number
  export function closeSync(fd: number): void
}
declare module 'node:string_decoder' {
  export class StringDecoder {
    constructor(encoding: 'utf8')
    write(bytes: Uint8Array): string
  }
}
declare const Buffer: { byteLength(text: string): number }

declare module 'node:child_process' {
  export function spawn(file: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; detached: boolean; stdio: string[] }): {
    pid?: number
    kill(signal: string): void
    stdin: { end(data: string): void; on(event: string, listener: (...args: any[]) => void): void }
    stdout: { setEncoding(encoding: string): { on(event: string, listener: (...args: any[]) => void): void } }
    stderr: { setEncoding(encoding: string): { on(event: string, listener: (...args: any[]) => void): void } }
    on(event: string, listener: (...args: any[]) => void): void
  }
}
declare module 'node:fs' {
  export function readdirSync(path: string, options: { withFileTypes: true }): { name: string; isDirectory(): boolean; isFile(): boolean }[]
  export function statSync(path: string): { size: number; mtimeMs: number }
}
declare module 'node:fs' {
  export function realpathSync(path: string): string
}
declare module 'node:fs' {
  export function watch(path: string, options: { recursive?: boolean }, listener: (event: string, filename: string | null) => void): { close(): void }
}
