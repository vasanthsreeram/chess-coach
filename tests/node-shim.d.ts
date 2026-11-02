// Minimal Node typings for test/dev helpers. @types/node is not a dependency of this project
// (node_modules is shared and must not be changed), so only the few APIs used are declared.
declare const process: { env: Record<string, string | undefined> };
declare module 'node:fs' { export function readFileSync(path: string | URL, enc: 'utf8'): string }
declare module 'node:url' { export function fileURLToPath(u: string | URL): string }
declare module 'node:sqlite' {
  interface Statement { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown }
  export class DatabaseSync { constructor(path: string); exec(sql: string): void; prepare(sql: string): Statement }
}
