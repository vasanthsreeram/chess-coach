import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import worker, { type Env } from '../worker/index';
import { fakeD1 } from '../dev/fakeD1';
import { ANALYSIS_SCHEMA, ENGINE_KEY, REVIEW_KEY_HEADER, isFinished, parseShare, pgnToUci, resultOf, validateEvals } from '../src/chesscom';
import { uciToMove } from '../src/analysis';

const fx = JSON.parse(readFileSync(new URL('./fixtures/chesscom-sample.json', import.meta.url), 'utf8'));
const SHARE = 'Check out this #chess game: samplewhite vs sampleblack - https://www.chess.com/game/live/987654321234';
const ORIGIN = 'https://chess.example';

function setup(o: { ip?: boolean; down?: boolean; db?: boolean; upstreamStatus?: number; game?: (g: any) => any } = {}) {
  const calls: string[] = [];
  const month = o.game ? { games: [o.game(structuredClone(fx.month_2026_11.games[0]))] } : fx.month_2026_11;
  const fetcher = vi.fn(async (url: string) => {
    calls.push(url);
    if (o.upstreamStatus) return new Response('', { status: o.upstreamStatus });
    const body = url.endsWith('/samplewhite/games/archives') ? fx.archives_samplewhite : url.endsWith('/samplewhite/games/2026/11') ? month
      : url.endsWith('/archives') ? { archives: ['https://api.chess.com/pub/player/x/games/2026/11'] } : url.match(/\/games\/\d{4}\/\d{2}$/) ? { games: [] } : null;
    return new Response(body ? JSON.stringify(body) : '{}', { status: body ? 200 : 404 });
  });
  let down = !!o.down;
  const db = fakeD1({ fail: () => down });
  const env: Env = {
    ASSETS: { fetch: async () => new Response('asset') }, AI: { run: vi.fn() },
    RL_IP: { limit: async () => ({ success: o.ip ?? true }) }, RL_GLOBAL: { limit: async () => ({ success: true }) },
    DB: o.db === false ? undefined : db,
  };
  const call = (req: Request) => worker.fetch(req, env, undefined, fetcher as any);
  return { env, db, calls, call, setDown: (d: boolean) => { down = d; } };
}
const post = (path: string, b: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  new Request(`${ORIGIN}${path}`, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: typeof b === 'string' ? b : JSON.stringify(b) });
const imp = (text: string, username?: string, h?: Record<string, string>) => post('/api/chesscom/import', { v: 1, text, username }, h);
// Two independent browser secrets (random, test-only).
const KEY_A = 'A'.repeat(20) + '_aaaaaaaaaaaaaaaaaaaaa-';
const KEY_B = 'B'.repeat(20) + '-bbbbbbbbbbbbbbbbbbbbb_';
const GAME = 'live:987654321234';
const getA = (game: string, key: string | null = KEY_A, engine = ENGINE_KEY, schema = ANALYSIS_SCHEMA, extra: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/analysis?${new URLSearchParams({ game, engine, schema: String(schema) })}`, { headers: { origin: ORIGIN, ...(key === null ? {} : { [REVIEW_KEY_HEADER]: key }), ...extra } });
const putA = (game: string, evals: unknown, key: string | null = KEY_A, engine = ENGINE_KEY, schema = ANALYSIS_SCHEMA) =>
  post('/api/analysis', { game, engine, schema, evals }, key === null ? {} : { [REVIEW_KEY_HEADER]: key }, 'PUT');

/** Structurally valid evals: first legal move as "best", correct terminal flags. */
function fakeEvals(moves: string[]) {
  const c = new Chess(); const out: any[] = [];
  for (let i = 0; i <= moves.length; i++) {
    if (c.isCheckmate()) out.push({ score: { mate: 0 }, best: null, terminal: 'mate' });
    else if (c.isStalemate() || c.isInsufficientMaterial()) out.push({ score: { cp: 0 }, best: null, terminal: 'draw' });
    else { const b = c.moves({ verbose: true })[0].lan; out.push({ score: { cp: 10 * i }, best: b, pv: [b] }); }
    if (i < moves.length) c.move(uciToMove(moves[i]));
  }
  return out;
}

describe('parseShare', () => {
  it('reads the full share text, bare URLs and other documented URL shapes', () => {
    expect(parseShare(SHARE)).toEqual({ kind: 'live', id: '987654321234', users: ['samplewhite', 'sampleblack'] });
    expect(parseShare('https://www.chess.com/game/live/987654321234')).toEqual({ kind: 'live', id: '987654321234', users: [] });
    expect(parseShare('chess.com/game/daily/123?ref=x')).toBeNull(); // needs scheme to avoid matching arbitrary text
    expect(parseShare('https://chess.com/game/daily/123?ref=x')?.kind).toBe('daily');
    expect(parseShare('https://www.chess.com/live/game/42')).toMatchObject({ kind: 'live', id: '42' });
  });
  it.each([
    'https://evil.example/game/live/1', 'https://www.chess.com.evil.example/game/live/1', 'https://www.chess.com/game/live/abc',
    'https://www.chess.com/game/live/1234567890123456789', 'hello', 'x'.repeat(600), 42,
  ])('rejects %s', (t) => expect(parseShare(t)).toBeNull());
});

describe('PGN and results', () => {
  it('parses the synthetic PGN and maps chess.com result codes', () => {
    const moves = pgnToUci(fx.month_2026_11.games[0].pgn)!;
    expect(moves.length).toBe(63);
    expect(moves[0]).toBe('e2e4');
    expect(resultOf({ whiteResult: 'win', blackResult: 'resigned' })).toEqual({ winner: 'w', how: 'resignation' });
    expect(resultOf({ whiteResult: 'agreed', blackResult: 'agreed' })).toEqual({ winner: null, how: 'agreement' });
    expect(pgnToUci('[Variant "Chess960"]\n1. e4 e5')).toBeNull();
    expect(pgnToUci('1. e4 e5 2. Ke3 Ke6 3. Qh5 Qxh5 4. Kxe9')).toBeNull();
  });
});

describe('/api/chesscom/import', () => {
  it('finds the shared game via documented archives, stores minimal data, then serves it from D1 with zero upstream calls', async () => {
    const t = setup();
    const r = await t.call(imp(SHARE));
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.cached).toBe(false);
    expect(j.game).toMatchObject({ key: 'live:987654321234', white: 'samplewhite', black: 'sampleblack', whiteResult: 'win', blackResult: 'resigned', timeControl: '600' });
    expect(j.game.moves).toHaveLength(63);
    expect(t.calls).toEqual(['https://api.chess.com/pub/player/samplewhite/games/archives', 'https://api.chess.com/pub/player/samplewhite/games/2026/11']);
    const row: any = t.db.db.prepare('SELECT * FROM chesscom_games').get();
    expect(Object.keys(row).sort()).toEqual(['black', 'black_result', 'end_time', 'game_id', 'game_key', 'imported_at', 'kind', 'moves', 'moves_sha256', 'time_class', 'time_control', 'white', 'white_result']);
    expect(JSON.stringify(row)).not.toMatch(/rating|uuid|clk|679/);
    expect((t.db.db.prepare('SELECT username_lc FROM chesscom_players ORDER BY 1').all() as any[]).map((x) => x.username_lc)).toEqual(['sampleblack', 'samplewhite']);
    const again: any = await (await t.call(imp('https://www.chess.com/game/live/987654321234'))).json();
    expect(again.cached).toBe(true);
    expect(again.game.moves).toEqual(j.game.moves);
    expect(t.calls).toHaveLength(2);
  });

  it('bare URL without usernames asks for a username; with one it works', async () => {
    const t = setup();
    const r = await t.call(imp('https://www.chess.com/game/live/987654321234'));
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).error).toBe('need_username');
    expect(t.calls).toHaveLength(0);
    expect((await t.call(imp('https://www.chess.com/game/live/987654321234', 'SAMPLEWHITE'))).status).toBe(200);
  });

  it('unknown game: bounded search (≤ 1 + 3 months per user, max 2 users) then not_found', async () => {
    const t = setup();
    const r = await t.call(imp('Check out this #chess game: someone vs other - https://www.chess.com/game/live/999'));
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error).toBe('not_found');
    expect(t.calls.length).toBeLessThanOrEqual(8);
    expect(t.calls.every((u) => u.startsWith('https://api.chess.com/pub/player/'))).toBe(true);
  });

  it('upstream 429 / 5xx gives honest errors; D1 down still imports', async () => {
    expect(((await (await setup({ upstreamStatus: 429 }).call(imp(SHARE))).json()) as any).error).toBe('upstream_busy');
    expect(((await (await setup({ upstreamStatus: 500 }).call(imp(SHARE))).json()) as any).error).toBe('upstream');
    for (const t of [setup({ down: true }), setup({ db: false })]) expect((await t.call(imp(SHARE))).status).toBe(200);
  });

  it.each([
    ['cross-origin', imp(SHARE, undefined, { origin: 'https://evil.example' }), 403],
    ['no origin', imp(SHARE, undefined, { origin: '' }), 403],
    ['bad link', imp('https://evil.example/game/live/1'), 400],
    ['SSRF-ish username', imp(SHARE, '../../x'), 400],
    ['wrong version', post('/api/chesscom/import', { v: 9, text: SHARE }), 400],
    ['oversize', post('/api/chesscom/import', 'x'.repeat(5000)), 413],
    ['GET', new Request(`${ORIGIN}/api/chesscom/import`), 405],
  ])('rejects %s without upstream calls', async (_, req, status) => {
    const t = setup();
    expect((await t.call(req as Request)).status).toBe(status);
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ['missing end time', (g: any) => ({ ...g, end_time: undefined })],
    ['zero end time', (g: any) => ({ ...g, end_time: 0 })],
    ['future end time', (g: any) => ({ ...g, end_time: Math.floor(Date.now() / 1000) + 86_400 })],
    ['no decisive result (in progress)', (g: any) => ({ ...g, white: { ...g.white, result: 'win' }, black: { ...g.black, result: 'win' } })],
    ['unknown result code', (g: any) => ({ ...g, black: { ...g.black, result: 'playing' } })],
    ['PGN result "*"', (g: any) => ({ ...g, pgn: g.pgn.replace('[Result "1-0"]', '[Result "*"]') })],
    ['PGN result disagrees', (g: any) => ({ ...g, pgn: g.pgn.replace('[Result "1-0"]', '[Result "0-1"]') })],
  ])('rejects an incomplete or inconsistent game: %s (nothing stored)', async (_, mut) => {
    const t = setup({ game: mut });
    const r = await t.call(imp(SHARE));
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).error).toBe('incomplete');
    expect(t.db.db.prepare('SELECT COUNT(*) AS n FROM chesscom_games').get()).toEqual({ n: 0 });
  });

  it('isFinished accepts decisive and drawn finished games only', () => {
    const t = 1_700_000_000;
    expect(isFinished({ whiteResult: 'win', blackResult: 'resigned', endTime: t }, '1-0')).toBe(true);
    expect(isFinished({ whiteResult: 'timeout', blackResult: 'win', endTime: t })).toBe(true);
    expect(isFinished({ whiteResult: 'agreed', blackResult: 'agreed', endTime: t }, '1/2-1/2')).toBe(true);
    expect(isFinished({ whiteResult: 'agreed', blackResult: 'win', endTime: t })).toBe(false);
    expect(isFinished({ whiteResult: 'win', blackResult: 'resigned', endTime: 1.5 })).toBe(false);
    expect(isFinished({ whiteResult: 'win', blackResult: 'resigned', endTime: t }, null)).toBe(false);
  });

  it('rate limited before any upstream call', async () => {
    const t = setup({ ip: false });
    expect((await t.call(imp(SHARE))).status).toBe(429);
    expect(t.calls).toHaveLength(0);
  });
});

describe('/api/analysis per-browser capability cache', () => {
  async function imported() { const t = setup(); const j: any = await (await t.call(imp(SHARE))).json(); return { ...t, moves: j.game.moves as string[] }; }
  const shifted = (ev: any[], cp: number) => ev.map((e) => (e.terminal ? e : { ...e, score: { cp } }));

  it('same browser: miss → store → hit (reuse after reload/new tab with the same secret)', async () => {
    const t = await imported();
    expect(await (await t.call(getA(GAME))).json()).toEqual({ hit: false });
    expect((await t.call(putA(GAME, fakeEvals(t.moves)))).status).toBe(200);
    const j: any = await (await t.call(getA(GAME))).json();
    expect(j.hit).toBe(true);
    expect(j.evals).toHaveLength(64);
    expect(validateEvals(t.moves, j.evals)).toEqual(j.evals);
  });

  it('two different secrets cannot read each other or poison each other', async () => {
    const t = await imported();
    await t.call(putA(GAME, shifted(fakeEvals(t.moves), 11), KEY_A));
    // B cannot read A's row.
    expect(await (await t.call(getA(GAME, KEY_B))).json()).toEqual({ hit: false });
    // B writes poisoned scores; A still gets its own, B gets B's.
    expect((await t.call(putA(GAME, shifted(fakeEvals(t.moves), -999), KEY_B))).status).toBe(200);
    expect(((await (await t.call(getA(GAME, KEY_A))).json()) as any).evals[1].score.cp).toBe(11);
    expect(((await (await t.call(getA(GAME, KEY_B))).json()) as any).evals[1].score.cp).toBe(-999);
    // A new device with no rows sees nothing, even though two rows exist.
    expect(await (await t.call(getA(GAME, 'C'.repeat(43)))).json()).toEqual({ hit: false });
  });

  it('only a hash of the secret is stored', async () => {
    const t = await imported();
    await t.call(putA(GAME, fakeEvals(t.moves)));
    const rows = t.db.db.prepare('SELECT * FROM review_cache_private').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(KEY_A);
  });

  it.each([
    ['missing secret', () => getA(GAME, null), 401],
    ['short secret', () => getA(GAME, 'abc'), 401],
    ['secret with bad characters', () => getA(GAME, 'A'.repeat(42) + '='), 401],
    ['missing secret on PUT', () => putA(GAME, [], null), 401],
    ['plain HTTP (non-loopback)', () => new Request(`http://chess.example/api/analysis?game=${GAME}`, { headers: { origin: 'http://chess.example', [REVIEW_KEY_HEADER]: KEY_A } }), 403],
    ['cross-origin GET', () => getA(GAME, KEY_A, ENGINE_KEY, ANALYSIS_SCHEMA, { origin: 'https://evil.example' }), 403],
    ['no origin, cross-site GET', () => new Request(`${ORIGIN}/api/analysis?game=${GAME}`, { headers: { [REVIEW_KEY_HEADER]: KEY_A, 'sec-fetch-site': 'cross-site' } }), 403],
    ['other engine settings', () => getA(GAME, KEY_A, 'sf19-lite-single|d12|mpv1'), 400],
    ['old schema 1', () => getA(GAME, KEY_A, ENGINE_KEY, 1), 400],
  ])('rejects %s', async (_, req, status) => {
    const t = await imported();
    expect((await t.call(req())).status).toBe(status);
  });

  it('a secret in the URL is not accepted as a credential', async () => {
    const t = await imported();
    await t.call(putA(GAME, fakeEvals(t.moves)));
    const r = new Request(`${ORIGIN}/api/analysis?${new URLSearchParams({ game: GAME, engine: ENGINE_KEY, schema: String(ANALYSIS_SCHEMA), [REVIEW_KEY_HEADER]: KEY_A, key: KEY_A })}`, { headers: { origin: ORIGIN } });
    expect((await t.call(r)).status).toBe(401);
  });

  it('rows of the old public prototype table are never served', async () => {
    const t = await imported();
    t.db.db.prepare('INSERT INTO chesscom_analysis VALUES (?, ?, ?, ?, ?, 0)').run(GAME, ENGINE_KEY, ANALYSIS_SCHEMA, 'x', JSON.stringify(fakeEvals(t.moves)));
    expect(await (await t.call(getA(GAME))).json()).toEqual({ hit: false });
  });

  it('rejects incomplete, illegal, mislabelled or unknown-game evals', async () => {
    const t = await imported();
    const ev = fakeEvals(t.moves);
    const bad = [
      ev.slice(0, 10),
      ev.map((e, i) => (i === 5 ? { ...e, best: 'a1a8' } : e)),
      ev.map((e, i) => (i === 5 ? { ...e, pv: ['e2e4', 'e2e4'] } : e)),
      ev.map((e, i) => (i === 5 ? { ...e, terminal: 'mate' } : e)),
      ev.map((e, i) => (i === 5 ? { ...e, score: {} } : e)),
    ];
    for (const b of bad) expect((await t.call(putA(GAME, b))).status).toBe(400);
    expect((await t.call(putA('live:5', ev))).status).toBe(404);
    expect((await t.call(post('/api/analysis', 'x'.repeat(100_000), { [REVIEW_KEY_HEADER]: KEY_A }, 'PUT'))).status).toBe(413);
    expect(await (await t.call(getA(GAME))).json()).toEqual({ hit: false });
  });

  it('per-secret row quota and content-hash mismatch', async () => {
    const t = await imported();
    await t.call(putA(GAME, fakeEvals(t.moves)));
    t.db.db.prepare("UPDATE review_cache_private SET moves_sha256 = 'x'").run();
    expect(await (await t.call(getA(GAME))).json()).toEqual({ hit: false });
    const ins = t.db.db.prepare("INSERT INTO review_cache_private VALUES (?, ?, 'e', 2, 's', '[]', 0)");
    const hash = (t.db.db.prepare('SELECT owner_hash FROM review_cache_private').get() as any).owner_hash;
    t.db.db.exec('PRAGMA foreign_keys = OFF');
    for (let i = 0; i < 199; i++) ins.run(hash, `live:${i}`); // 200 rows incl. GAME = at quota
    expect((await t.call(putA(GAME, fakeEvals(t.moves)))).status).toBe(200); // updating an existing row is allowed
    t.db.db.prepare("DELETE FROM review_cache_private WHERE game_key = ?").run(GAME);
    ins.run(hash, 'live:199');
    expect((await t.call(putA(GAME, fakeEvals(t.moves)))).status).toBe(507);
  });

  it('D1 outage: reads are misses, writes fail cleanly; rate limits apply', async () => {
    const t = await imported();
    t.setDown(true);
    expect(await (await t.call(getA(GAME))).json()).toEqual({ hit: false, reason: 'db_error' });
    expect((await t.call(putA(GAME, fakeEvals(t.moves)))).status).toBe(503);
    expect((await setup({ ip: false }).call(getA(GAME))).status).toBe(429);
    expect((await t.call(new Request(`${ORIGIN}/api/analysis`, { method: 'DELETE' }))).status).toBe(405);
  });
});
