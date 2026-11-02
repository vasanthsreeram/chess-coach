// Chess.com import and shared analysis cache routes. D1 is optional: without it (or when it fails) import
// still works through the public API and analysis is simply computed in the browser.
import { ANALYSIS_SCHEMA, ENGINE_KEY, IMPORT_VERSION, MAX_PLIES, REVIEW_KEY_HEADER, REVIEW_KEY_RE, gameKey, gameUrl, isFinished, movesHash, parseShare, pgnResultTag, pgnToUci, validUser, validateEvals, type GameKind, type ImportedGame } from '../src/chesscom';

export interface D1Stmt { bind(...v: unknown[]): D1Stmt; first<T = any>(): Promise<T | null>; run(): Promise<unknown> }
export interface D1Like { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<unknown> }
interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }
export interface ImportEnv { DB?: D1Like; RL_IP: RateLimit; RL_GLOBAL: RateLimit }
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.chess.com/pub/player/';
const UA = 'chess.vasanth.cloud game-review importer (+https://chess.vasanth.cloud)';
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_UPSTREAM_BYTES = 8_000_000;
const MONTHS_PER_USER = 3;
const MAX_BODY = 1024;
const MAX_ANALYSIS_BODY = 96_000;
const MAX_ROWS_PER_KEY = 200;

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

export function sameOrigin(req: Request): boolean {
  const host = new URL(req.url).host;
  const origin = req.headers.get('origin');
  if (origin) { try { return new URL(origin).host === host; } catch { return false; } }
  return req.headers.get('sec-fetch-site') === 'same-origin';
}

async function limited(env: ImportEnv, req: Request, bucket: string): Promise<boolean> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const [a, b] = await Promise.all([env.RL_IP.limit({ key: `${bucket}:${ip}` }), env.RL_GLOBAL.limit({ key: bucket })]);
  return !a.success || !b.success;
}

async function readJson(req: Request, max: number): Promise<{ ok: true; body: any } | { ok: false; res: Response }> {
  if (!sameOrigin(req)) return { ok: false, res: json(403, { error: 'origin' }) };
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return { ok: false, res: json(415, { error: 'type' }) };
  if (Number(req.headers.get('content-length') ?? '0') > max) return { ok: false, res: json(413, { error: 'size' }) };
  const text = await req.text();
  if (text.length > max) return { ok: false, res: json(413, { error: 'size' }) };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, res: json(400, { error: 'json' }) }; }
}

class Upstream extends Error { constructor(public status: number) { super(`upstream ${status}`); } }

/** One bounded GET to a URL this module built itself from validated parts. */
async function getJson(fetcher: Fetcher, url: string): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetcher(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal, redirect: 'manual' });
    if (r.status === 404 || r.status === 410) return null;
    if (!r.ok) throw new Upstream(r.status);
    const text = await r.text();
    if (text.length > MAX_UPSTREAM_BYTES) throw new Upstream(413);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

/** Finds the game in a player's newest monthly archives. Serial requests, as the API docs ask. */
async function findInArchives(fetcher: Fetcher, user: string, kind: GameKind, id: string, calls: { n: number }): Promise<any | null> {
  const u = user.toLowerCase();
  calls.n++;
  const list = await getJson(fetcher, `${API}${u}/games/archives`);
  const months: string[] = [];
  for (const a of Array.isArray(list?.archives) ? list.archives : []) {
    const m = typeof a === 'string' ? /\/games\/(\d{4})\/(\d{2})$/.exec(a) : null;
    if (m) months.push(`${m[1]}/${m[2]}`);
  }
  const want = gameUrl({ kind, id });
  for (const ym of months.sort().reverse().slice(0, MONTHS_PER_USER)) {
    calls.n++;
    const arch = await getJson(fetcher, `${API}${u}/games/${ym}`);
    const g = (Array.isArray(arch?.games) ? arch.games : []).find((x: any) => x?.url === want);
    if (g) return g;
  }
  return null;
}

function toImported(g: any, kind: GameKind, id: string): ImportedGame | 'unsupported' | 'incomplete' {
  if (g.rules !== 'chess' || (g.initial_setup && g.initial_setup !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')) return 'unsupported';
  const moves = pgnToUci(g.pgn);
  const w = g.white, b = g.black;
  if (!isFinished({ whiteResult: w?.result, blackResult: b?.result, endTime: g.end_time }, typeof g.pgn === 'string' ? pgnResultTag(g.pgn) : null)) return 'incomplete';
  if (!moves || !validUser(w?.username) || !validUser(b?.username) || typeof w.result !== 'string' || typeof b.result !== 'string') return 'unsupported';
  return {
    key: gameKey({ kind, id }), url: gameUrl({ kind, id }), white: w.username, black: b.username,
    whiteResult: w.result.slice(0, 24), blackResult: b.result.slice(0, 24),
    endTime: g.end_time, timeClass: String(g.time_class ?? '').slice(0, 12), timeControl: String(g.time_control ?? '').slice(0, 16), moves,
  };
}

const rowToGame = (r: any): ImportedGame => ({ key: r.game_key, url: gameUrl({ kind: r.kind, id: r.game_id }), white: r.white, black: r.black, whiteResult: r.white_result, blackResult: r.black_result, endTime: r.end_time, timeClass: r.time_class, timeControl: r.time_control, moves: r.moves.split(' ') });

async function loadGame(db: D1Like | undefined, key: string): Promise<ImportedGame | null> {
  if (!db) return null;
  try {
    const r = await db.prepare('SELECT * FROM chesscom_games WHERE game_key = ?1').bind(key).first();
    const g = r ? rowToGame(r) : null;
    return g && isFinished(g) ? g : null;
  } catch { return null; }
}

async function storeGame(db: D1Like | undefined, g: ImportedGame, kind: GameKind, id: string) {
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.batch([
      db.prepare('INSERT INTO chesscom_players (username_lc, username, first_seen) VALUES (?1, ?2, ?3) ON CONFLICT(username_lc) DO UPDATE SET username = excluded.username').bind(g.white.toLowerCase(), g.white, now),
      db.prepare('INSERT INTO chesscom_players (username_lc, username, first_seen) VALUES (?1, ?2, ?3) ON CONFLICT(username_lc) DO UPDATE SET username = excluded.username').bind(g.black.toLowerCase(), g.black, now),
      db.prepare('INSERT OR IGNORE INTO chesscom_games (game_key, kind, game_id, white, black, white_result, black_result, end_time, time_class, time_control, moves, moves_sha256, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)')
        .bind(g.key, kind, id, g.white, g.black, g.whiteResult, g.blackResult, g.endTime, g.timeClass, g.timeControl, g.moves.join(' '), await movesHash(g.moves), now),
    ]);
  } catch { /* cache only; the import result is still returned */ }
}

/** POST /api/chesscom/import { v, text, username? } → { v, game, cached } or a typed error with a fallback hint. */
export async function handleImport(req: Request, env: ImportEnv, fetcher: Fetcher): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const r = await readJson(req, MAX_BODY);
  if (!r.ok) return r.res;
  const { v, text, username } = r.body ?? {};
  if (v !== IMPORT_VERSION) return json(400, { error: 'version' });
  const ref = parseShare(text);
  if (!ref) return json(400, { error: 'link' });
  if (username !== undefined && username !== '' && !validUser(username)) return json(400, { error: 'username' });
  if (await limited(env, req, 'cc-import')) return json(429, { error: 'rate' });

  const key = gameKey(ref);
  const hit = await loadGame(env.DB, key);
  if (hit) return json(200, { v: IMPORT_VERSION, game: hit, cached: true });

  const users = [...new Set([...(username ? [username] : []), ...ref.users].map((u) => u.toLowerCase()))].slice(0, 2);
  if (!users.length) return json(422, { error: 'need_username', key });
  const calls = { n: 0 };
  try {
    for (const u of users) {
      const g = await findInArchives(fetcher, u, ref.kind, ref.id, calls);
      if (!g) continue;
      const game = toImported(g, ref.kind, ref.id);
      if (game === 'unsupported' || game === 'incomplete') return json(422, { error: game, key });
      await storeGame(env.DB, game, ref.kind, ref.id);
      return json(200, { v: IMPORT_VERSION, game, cached: false, upstreamCalls: calls.n });
    }
  } catch (e) {
    return json(502, { error: e instanceof Upstream && e.status === 429 ? 'upstream_busy' : 'upstream', key });
  }
  return json(404, { error: 'not_found', key, searched: users, upstreamCalls: calls.n });
}

const ANALYSIS_KEY_RE = /^(live|daily):\d{1,15}$/;

/** HTTPS only, except plain-HTTP loopback for local development and tests. */
function secureTransport(req: Request): boolean {
  const u = new URL(req.url);
  return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
}

/**
 * Per-browser capability: the browser sends its random secret in a header; the server keeps only
 * SHA-256(domain || secret). Rows are partitioned by that hash, so one secret can neither read nor
 * overwrite another's analysis. Returns the owner hash, or an error response.
 */
async function owner(req: Request): Promise<{ hash: string } | { res: Response }> {
  if (!secureTransport(req)) return { res: json(403, { error: 'https' }) };
  if (!sameOrigin(req)) return { res: json(403, { error: 'origin' }) };
  const secret = req.headers.get(REVIEW_KEY_HEADER) ?? '';
  if (!REVIEW_KEY_RE.test(secret)) return { res: json(401, { error: 'key' }) };
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`chess-review-cache-v2:${secret}`));
  return { hash: [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

/** GET /api/analysis?game=live:123&engine=...&schema=2 with the secret header → { hit, evals? } from this browser's own rows only. */
export async function handleAnalysisGet(req: Request, env: ImportEnv): Promise<Response> {
  const o = await owner(req);
  if ('res' in o) return o.res;
  const u = new URL(req.url);
  const key = u.searchParams.get('game') ?? '';
  if (!ANALYSIS_KEY_RE.test(key) || u.searchParams.get('engine') !== ENGINE_KEY || u.searchParams.get('schema') !== String(ANALYSIS_SCHEMA)) return json(400, { error: 'key' });
  if (await limited(env, req, 'cc-an-read')) return json(429, { error: 'rate' });
  if (!env.DB) return json(200, { hit: false, reason: 'no_db' });
  try {
    const row: any = await env.DB.prepare('SELECT a.evals, a.moves_sha256 AS a_sha, g.moves, g.moves_sha256 AS g_sha FROM review_cache_private a JOIN chesscom_games g ON g.game_key = a.game_key WHERE a.owner_hash = ?1 AND a.game_key = ?2 AND a.engine = ?3 AND a.schema_version = ?4')
      .bind(o.hash, key, ENGINE_KEY, ANALYSIS_SCHEMA).first();
    if (!row || row.a_sha !== row.g_sha) return json(200, { hit: false });
    const evals = validateEvals(row.moves.split(' '), JSON.parse(row.evals));
    return evals ? json(200, { hit: true, evals }) : json(200, { hit: false });
  } catch {
    return json(200, { hit: false, reason: 'db_error' });
  }
}

/** PUT /api/analysis { game, engine, schema, evals } with the secret header — stores into this browser's own partition only. */
export async function handleAnalysisPut(req: Request, env: ImportEnv): Promise<Response> {
  const o = await owner(req);
  if ('res' in o) return o.res;
  const r = await readJson(req, MAX_ANALYSIS_BODY);
  if (!r.ok) return r.res;
  const { game, engine, schema, evals } = r.body ?? {};
  if (typeof game !== 'string' || !ANALYSIS_KEY_RE.test(game) || engine !== ENGINE_KEY || schema !== ANALYSIS_SCHEMA) return json(400, { error: 'key' });
  if (await limited(env, req, 'cc-an-write')) return json(429, { error: 'rate' });
  if (!env.DB) return json(503, { error: 'no_db' });
  try {
    const g: any = await env.DB.prepare('SELECT moves, moves_sha256 FROM chesscom_games WHERE game_key = ?1').bind(game).first();
    if (!g) return json(404, { error: 'game' });
    const moves = g.moves.split(' ');
    if (moves.length > MAX_PLIES) return json(400, { error: 'evals' });
    const clean = validateEvals(moves, evals);
    if (!clean) return json(400, { error: 'evals' });
    const n: any = await env.DB.prepare('SELECT COUNT(*) AS n FROM review_cache_private WHERE owner_hash = ?1 AND NOT (game_key = ?2 AND engine = ?3 AND schema_version = ?4)').bind(o.hash, game, ENGINE_KEY, ANALYSIS_SCHEMA).first();
    if ((n?.n ?? 0) >= MAX_ROWS_PER_KEY) return json(507, { error: 'quota' });
    await env.DB.prepare('INSERT INTO review_cache_private (owner_hash, game_key, engine, schema_version, moves_sha256, evals, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(owner_hash, game_key, engine, schema_version) DO UPDATE SET moves_sha256 = excluded.moves_sha256, evals = excluded.evals, created_at = excluded.created_at')
      .bind(o.hash, game, ENGINE_KEY, ANALYSIS_SCHEMA, g.moves_sha256, JSON.stringify(clean), Math.floor(Date.now() / 1000)).run();
    return json(200, { stored: true });
  } catch {
    return json(503, { error: 'db_error' });
  }
}
