// Chess.com share-link parsing and game import, shared by the browser and the Worker.
// Only the documented Published-Data API (https://www.chess.com/news/view/published-data-api) is used:
// /pub/player/{user}/games/archives and /pub/player/{user}/games/{YYYY}/{MM}. Game pages under
// www.chess.com/game/ are robots-disallowed and are never fetched; the share URL is only parsed for its id.
import { Chess } from 'chess.js';
import type { PositionEval } from './analysis';

export const IMPORT_VERSION = 1;
/** Bump when the stored eval shape or the review engine settings change; old rows then never match. */
export const ANALYSIS_SCHEMA = 2;
export const ENGINE_ID = 'sf19-lite-single';
export const REVIEW_DEPTH = 12;
/** Per-position time cap for the review pass (`go depth 12 movetime 600`, whichever ends first). */
export const REVIEW_MOVETIME_MS = 600;
export const ENGINE_KEY = `${ENGINE_ID}|d${REVIEW_DEPTH}|t${REVIEW_MOVETIME_MS}|mpv1`;
/** Request header carrying the per-browser cache secret. Never sent in URLs. */
export const REVIEW_KEY_HEADER = 'x-review-key';
/** 32 random bytes, base64url without padding. */
export const REVIEW_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const MAX_PLIES = 600;

export type GameKind = 'live' | 'daily';
export interface ShareRef { kind: GameKind; id: string; users: string[] }
/** Minimal public record of an imported game. No ratings, uuids, clocks or profile data are kept. */
export interface ImportedGame {
  key: string; // `${kind}:${id}`
  url: string; // canonical public game URL on chess.com (attribution link)
  white: string; black: string;
  whiteResult: string; blackResult: string;
  endTime: number; timeClass: string; timeControl: string;
  moves: string[]; // UCI
}

const USER_RE = /^[A-Za-z0-9_-]{3,25}$/;
const URL_RE = /https?:\/\/(?:www\.)?chess\.com\/(?:game\/(live|daily)\/(\d{1,15})|(live|daily)\/game\/(\d{1,15})|game\/(\d{1,15}))(?=[/?#\s]|$)/i;

export const validUser = (u: unknown): u is string => typeof u === 'string' && USER_RE.test(u);

/** Parses a pasted share message ("Check out this #chess game: a vs b - https://www.chess.com/game/live/1") or a bare URL. */
export function parseShare(text: unknown): ShareRef | null {
  if (typeof text !== 'string' || text.length > 500) return null;
  const m = URL_RE.exec(text);
  if (!m) return null;
  const kind = ((m[1] ?? m[3] ?? 'live').toLowerCase()) as GameKind;
  const id = m[2] ?? m[4] ?? m[5];
  const users: string[] = [];
  const vs = /([A-Za-z0-9_-]{3,25})\s+vs\.?\s+([A-Za-z0-9_-]{3,25})/i.exec(text.slice(0, m.index));
  if (vs) users.push(vs[1], vs[2]);
  return { kind, id, users };
}

export const gameKey = (r: { kind: GameKind; id: string }) => `${r.kind}:${r.id}`;
export const gameUrl = (r: { kind: GameKind; id: string }) => `https://www.chess.com/game/${r.kind}/${r.id}`;

/** Converts PGN movetext (standard start only) to UCI moves; null if illegal or a variant/custom start. */
export function pgnToUci(pgn: string): string[] | null {
  if (typeof pgn !== 'string' || pgn.length > 100_000) return null;
  const fen = /\[FEN "([^"]*)"\]/.exec(pgn);
  if (fen && fen[1] !== new Chess().fen()) return null;
  const variant = /\[Variant "([^"]*)"\]/.exec(pgn);
  if (variant && !/^standard$/i.test(variant[1])) return null;
  try {
    const c = new Chess();
    c.loadPgn(pgn);
    const moves = c.history({ verbose: true }).map((m) => m.lan);
    return moves.length > 0 && moves.length <= MAX_PLIES ? moves : null;
  } catch { return null; }
}

const WIN_LOSS = new Set(['checkmated', 'resigned', 'timeout', 'abandoned', 'lose', 'kingofthehill', 'threecheck', 'bughousepartnerlose']);
const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

/**
 * True only for a finished game: a positive end time not in the future, documented result codes that form
 * a decisive or drawn outcome, and (when given) a PGN Result tag that agrees. Rejects in-progress games so the
 * importer cannot be used for live assistance.
 */
export function isFinished(g: { whiteResult: unknown; blackResult: unknown; endTime: unknown }, pgnResult?: string | null, nowSec = Date.now() / 1000): boolean {
  const { whiteResult: w, blackResult: b, endTime: t } = g;
  if (typeof t !== 'number' || !Number.isInteger(t) || t <= 0 || t > nowSec + 300) return false;
  if (typeof w !== 'string' || typeof b !== 'string') return false;
  const tag = w === 'win' && WIN_LOSS.has(b) ? '1-0' : b === 'win' && WIN_LOSS.has(w) ? '0-1' : DRAWS.has(w) && DRAWS.has(b) ? '1/2-1/2' : null;
  if (!tag) return false;
  return pgnResult === undefined || pgnResult === tag;
}

/** The PGN `[Result "..."]` tag, or null when missing. */
export const pgnResultTag = (pgn: string) => /\[Result "([^"]*)"\]/.exec(pgn)?.[1] ?? null;

/** Result in the app's terms from chess.com result codes (see "Game results codes" in the API docs). */
export function resultOf(g: Pick<ImportedGame, 'whiteResult' | 'blackResult'>): { winner: 'w' | 'b' | null; how: string } {
  const HOW: Record<string, string> = {
    checkmated: 'checkmate', resigned: 'resignation', timeout: 'timeout', abandoned: 'abandonment', agreed: 'agreement',
    repetition: 'repetition', stalemate: 'stalemate', insufficient: 'insufficient material', '50move': 'fifty-move rule',
    timevsinsufficient: 'timeout vs insufficient material', lose: 'loss',
  };
  if (g.whiteResult === 'win') return { winner: 'w', how: HOW[g.blackResult] ?? g.blackResult };
  if (g.blackResult === 'win') return { winner: 'b', how: HOW[g.whiteResult] ?? g.whiteResult };
  return { winner: null, how: HOW[g.whiteResult] ?? g.whiteResult };
}

const isUci = (u: unknown) => typeof u === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u);
const isInt = (n: unknown, lim: number) => typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= lim;

/**
 * Validates a full set of evals for `moves` (one per position, including the final one): length, shape,
 * legal best moves and PV lines, and terminal flags that match the real position. Returns a clean copy
 * or null. Used before both storing and trusting cached analysis.
 */
export function validateEvals(moves: string[], evals: unknown): PositionEval[] | null {
  if (!Array.isArray(evals) || evals.length !== moves.length + 1) return null;
  const c = new Chess();
  const out: PositionEval[] = [];
  for (let i = 0; i < evals.length; i++) {
    const e: any = evals[i];
    if (!e || typeof e !== 'object' || !e.score || typeof e.score !== 'object') return null;
    const terminal = c.isCheckmate() ? 'mate' : c.isStalemate() || c.isInsufficientMaterial() ? 'draw' : undefined;
    if ((e.terminal ?? undefined) !== terminal) return null;
    if (terminal) out.push(terminal === 'mate' ? { score: { mate: 0 }, best: null, terminal } : { score: { cp: 0 }, best: null, terminal });
    else {
      const { cp, mate } = e.score;
      const okScore = (cp === undefined || isInt(cp, 100_000)) && (mate === undefined || isInt(mate, 500)) && (cp !== undefined || mate !== undefined);
      if (!okScore || !isUci(e.best)) return null;
      const pv = e.pv === undefined ? [] : e.pv;
      if (!Array.isArray(pv) || pv.length > 8 || !pv.every(isUci)) return null;
      const t = new Chess(c.fen());
      try { for (const u of [e.best]) t.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { return null; }
      const p = new Chess(c.fen());
      try { for (const u of pv) p.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { return null; }
      const score: PositionEval['score'] = {};
      if (cp !== undefined) score.cp = cp;
      if (mate !== undefined) score.mate = mate;
      out.push({ score, best: e.best, pv });
    }
    if (i < moves.length) {
      try { const u = moves[i]; c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { return null; }
    }
  }
  return out;
}

/** SHA-256 hex of the move list; ties cache rows to the exact game content. */
export async function movesHash(moves: string[]): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(moves.join(' ')));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
