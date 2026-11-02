// Browser side of the Chess.com import and shared analysis cache. Every server answer is re-validated here.
import { ANALYSIS_SCHEMA, ENGINE_KEY, IMPORT_VERSION, MAX_PLIES, REVIEW_KEY_HEADER, REVIEW_KEY_RE, parseShare, pgnToUci, validateEvals, type ImportedGame } from './chesscom';
import type { PositionEval } from './analysis';

export type ImportOutcome =
  | { ok: true; game: ImportedGame; cached: boolean }
  | { ok: false; error: 'link' | 'need_username' | 'not_found' | 'unsupported' | 'incomplete' | 'rate' | 'upstream' | 'upstream_busy' | 'username' | 'network'; searched?: string[] };

export const stats = { analysisHits: 0, analysisMisses: 0, analysisStored: 0 };

export async function importChesscom(text: string, username?: string): Promise<ImportOutcome> {
  if (!parseShare(text)) return { ok: false, error: 'link' };
  try {
    const res = await fetch('api/chesscom/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: IMPORT_VERSION, text: text.trim().slice(0, 500), username: username?.trim() || undefined }) });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.game && Array.isArray(data.game.moves) && data.game.moves.length <= MAX_PLIES) return { ok: true, game: data.game, cached: !!data.cached };
    const known = ['link', 'need_username', 'not_found', 'unsupported', 'incomplete', 'rate', 'upstream', 'upstream_busy', 'username'];
    return { ok: false, error: known.includes(data?.error) ? data.error : 'upstream', searched: data?.searched };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** Parses a pasted PGN locally (no server call). */
export function parsePgn(text: string): { moves: string[]; white: string; black: string; result: string } | null {
  if (!/\d+\.\s*\S/.test(text)) return null;
  const moves = pgnToUci(text);
  if (!moves) return null;
  const tag = (k: string) => (new RegExp(`\\[${k} "([^"]{0,40})"\\]`).exec(text)?.[1] ?? '').trim();
  return { moves, white: tag('White') || 'White', black: tag('Black') || 'Black', result: tag('Result') };
}

const SECRET_STORE = 'chess-minimal.review-key.v1';

/**
 * This browser's random cache secret (32 bytes from crypto.getRandomValues), created once and kept in
 * localStorage. Sent only in the request header; the server stores a hash. Clearing site data loses access.
 */
export function deviceSecret(): string {
  const have = localStorage.getItem(SECRET_STORE);
  if (have && REVIEW_KEY_RE.test(have)) return have;
  const b = crypto.getRandomValues(new Uint8Array(32));
  const s = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem(SECRET_STORE, s);
  return s;
}

/** This browser's saved evals for an imported game, or null (miss, offline, D1 down, or invalid data). */
export async function fetchCachedAnalysis(key: string, moves: string[]): Promise<PositionEval[] | null> {
  try {
    const q = new URLSearchParams({ game: key, engine: ENGINE_KEY, schema: String(ANALYSIS_SCHEMA) });
    const res = await fetch(`api/analysis?${q}`, { headers: { [REVIEW_KEY_HEADER]: deviceSecret() }, credentials: 'same-origin', cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    const evals = data?.hit ? validateEvals(moves, data.evals) : null;
    if (evals) stats.analysisHits++; else stats.analysisMisses++;
    return evals;
  } catch { stats.analysisMisses++; return null; }
}

export async function storeAnalysis(key: string, evals: PositionEval[]) {
  try {
    const res = await fetch('api/analysis', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', [REVIEW_KEY_HEADER]: deviceSecret() }, body: JSON.stringify({ game: key, engine: ENGINE_KEY, schema: ANALYSIS_SCHEMA, evals }) });
    if (res.ok) stats.analysisStored++;
  } catch { /* cache is best effort */ }
}
