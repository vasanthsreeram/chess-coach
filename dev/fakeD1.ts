// Local stand-in for a Cloudflare D1 binding (node:sqlite, in memory) with the real migration applied.
// `fail` makes every query throw, to prove the Worker degrades safely when D1 is down.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { D1Like, D1Stmt } from '../worker/chesscom';

export function fakeD1(opts: { fail?: () => boolean } = {}): D1Like & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  for (const m of ['0001_chesscom_cache.sql', '0002_private_review_cache.sql']) db.exec(readFileSync(fileURLToPath(new URL(`../migrations/${m}`, import.meta.url)), 'utf8'));
  const check = () => { if (opts.fail?.()) throw new Error('D1_ERROR: simulated outage'); };
  const stmt = (sql: string, args: unknown[] = []): D1Stmt & { exec(): void } => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => { check(); return (db.prepare(sql).get(...(args as any[])) as any) ?? null; },
    run: async () => { check(); db.prepare(sql).run(...(args as any[])); return { success: true }; },
    exec() { db.prepare(sql).run(...(args as any[])); },
  });
  return {
    db,
    prepare: (sql) => stmt(sql),
    async batch(list) { check(); db.exec('BEGIN'); try { for (const s of list) (s as any).exec(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; },
  };
}
