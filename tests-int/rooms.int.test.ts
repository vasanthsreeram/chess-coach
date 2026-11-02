import { describe, expect, it } from 'vitest';

const BASE = process.env.MP_URL ?? 'http://127.0.0.1:8917';
const WS = BASE.replace(/^http/, 'ws');
const ORIGIN = { origin: BASE };
let ipN = 0;
// Each test acts from its own client IP so per-IP limits do not couple tests (miniflare honours this header locally).
const ip = () => `10.9.${process.pid % 250}.${++ipN}`;

async function create(tc = 3, side = 'w', from = ip()) {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': from }, body: JSON.stringify({ tc, side }) });
  return { status: r.status, body: await r.json() as any };
}
async function join(room: string, from = ip()) {
  const r = await fetch(`${BASE}/api/rooms/${room}/join`, { method: 'POST', headers: { ...ORIGIN, 'cf-connecting-ip': from } });
  return { status: r.status, body: await r.json() as any };
}

class Client {
  ws: WebSocket; frames: any[] = []; closed: { code: number } | null = null;
  private waiters: (() => void)[] = [];
  constructor(room: string, token?: string, hello = true) {
    this.ws = new WebSocket(`${WS}/api/rooms/${room}/ws`, { headers: ORIGIN } as any);
    this.ws.onmessage = (e) => { this.frames.push(JSON.parse(String(e.data))); this.waiters.splice(0).forEach((f) => f()); };
    this.ws.onclose = (e) => { this.closed = { code: e.code }; this.waiters.splice(0).forEach((f) => f()); };
    // A refused handshake (e.g. HTTP 429) surfaces as an error event only.
    this.ws.onerror = () => { this.closed ??= { code: -1 }; this.waiters.splice(0).forEach((f) => f()); };
    if (hello) this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'hello', token }));
  }
  get last() { return this.frames[this.frames.length - 1]; }
  async until(pred: (c: Client) => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!pred(this)) {
      if (Date.now() > end) throw new Error(`timeout; last=${JSON.stringify(this.last)} closed=${JSON.stringify(this.closed)}`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 100); });
    }
    return this.last;
  }
  send(m: unknown) { this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  close() { this.ws.close(); }
}

async function seatedRoom(tc = 3) {
  const c = await create(tc, 'w'); expect(c.status).toBe(201);
  const j = await join(c.body.room); expect(j.status).toBe(200); expect(j.body.side).toBe('b');
  const w = new Client(c.body.room, c.body.token), b = new Client(c.body.room, j.body.token);
  await w.until((x) => x.last?.you === 'w' && x.last.seats.b && x.last.online.b);
  await b.until((x) => x.last?.you === 'b' && x.last.online.w);
  return { room: c.body.room as string, wt: c.body.token as string, bt: j.body.token as string, w, b };
}

describe('invite rooms on a real local Durable Object', () => {
  it('two seats only: third visitor is a read-only spectator', async () => {
    const { room, w, b } = await seatedRoom();
    expect(room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await join(room)).status).toBe(409);
    const spec = new Client(room);
    const v = await spec.until((x) => x.last?.t === 'state');
    expect(v.you).toBeNull();
    spec.send({ t: 'move', uci: 'e2e4', v: 0 });
    expect((await spec.until((x) => x.last?.t === 'error')).code).toBe('not-seated');
    // A forged token is just a spectator.
    const forged = new Client(room, 'A'.repeat(43));
    expect((await forged.until((x) => x.last?.t === 'state')).you).toBeNull();
    [w, b, spec, forged].forEach((c) => c.close());
  });

  it('legal moves converge on every client; out-of-turn, stale, illegal frames are refused with the authoritative state', async () => {
    const { room, w, b } = await seatedRoom();
    const spec = new Client(room);
    await spec.until((x) => x.last?.t === 'state');
    b.send({ t: 'move', uci: 'e7e5', v: 0 });
    expect((await b.until((x) => x.last?.t === 'error')).code).toBe('turn');
    w.send({ t: 'move', uci: 'e2e5', v: 0 });
    expect((await w.until((x) => x.last?.t === 'error')).code).toBe('illegal');
    w.send({ t: 'move', uci: 'e2e4', v: 0 });
    for (const c of [w, b, spec]) await c.until((x) => x.last?.moves?.length === 1);
    w.send({ t: 'move', uci: 'd2d4', v: 0 });
    const stale = await w.until((x) => x.last?.t === 'error');
    expect(stale.code).toBe('stale');
    expect(stale.moves).toEqual(['e2e4']);
    b.send({ t: 'move', uci: 'e7e5', v: 1 });
    const fens = await Promise.all([w, b, spec].map((c) => c.until((x) => x.last?.moves?.length === 2).then((f) => f.fen)));
    expect(new Set(fens).size).toBe(1);
    expect(fens[0]).toContain('4p3/4P3');
    expect(w.last.running).toBe('w');
    expect(b.last.clock.b).toBeLessThan(180_000);
    [w, b, spec].forEach((c) => c.close());
  });

  it('reconnect with the seat token restores side and position; opponent sees offline/online presence', async () => {
    const { room, wt, w, b } = await seatedRoom();
    w.send({ t: 'move', uci: 'g1f3', v: 0 });
    await b.until((x) => x.last?.moves?.length === 1);
    w.close();
    await b.until((x) => x.last?.online?.w === false);
    const w2 = new Client(room, wt);
    const v = await w2.until((x) => x.last?.t === 'state');
    expect(v.you).toBe('w'); expect(v.moves).toEqual(['g1f3']);
    await b.until((x) => x.last?.online?.w === true);
    [w2, b].forEach((c) => c.close());
  });

  it('checkmate ends the game for both clients and later moves are refused', async () => {
    const { w, b } = await seatedRoom();
    const seq = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
    for (let i = 0; i < seq.length; i++) {
      (i % 2 ? b : w).send({ t: 'move', uci: seq[i], v: i });
      await w.until((x) => x.last?.moves?.length === i + 1);
    }
    for (const c of [w, b]) expect((await c.until((x) => !!x.last?.result)).result).toEqual({ winner: 'b', how: 'checkmate' });
    w.send({ t: 'move', uci: 'a2a3', v: 4 });
    expect((await w.until((x) => x.last?.t === 'error')).code).toBe('over');
    [w, b].forEach((c) => c.close());
  });

  it('abuse: cross-origin, malformed ids, unknown rooms, oversize and flooding frames, socket cap, creation rate limit', async () => {
    const xo = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"tc":3,"side":"w"}' });
    expect(xo.status).toBe(403);
    expect((await create(5)).status).toBe(400); // unsupported time control
    expect((await join('short')).status).toBe(404);
    expect((await join('A'.repeat(22))).status).toBe(404);
    const ghost = new Client('B'.repeat(22));
    await ghost.until((x) => !!x.closed); expect(ghost.closed!.code).toBe(4404);

    const { room, w, b } = await seatedRoom();
    w.send('x'.repeat(300));
    await w.until((x) => !!x.closed); expect(w.closed!.code).toBe(1008);
    for (let i = 0; i < 45; i++) b.send({ t: 'ping' });
    await b.until((x) => !!x.closed); expect(b.closed!.code).toBe(1008);
    const mustHello = new Client(room, undefined, false);
    await new Promise((r) => (mustHello.ws.onopen = r));
    mustHello.send({ t: 'move', uci: 'e2e4', v: 0 });
    await mustHello.until((x) => !!x.closed); expect(mustHello.closed!.code).toBe(1008);

    const many = Array.from({ length: 10 }, () => new Client(room));
    await new Promise((r) => setTimeout(r, 1500));
    // w, b and mustHello were closed above, so the room holds 8 of these and refuses the other 2.
    expect(many.filter((c) => c.closed?.code === -1).length).toBe(2);
    many.forEach((c) => c.close());

    const flooder = ip();
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await create(3, 'w', flooder)).status);
    // 10 per 60 s window; a burst may straddle one window boundary, so at most 2 windows' worth succeed.
    expect(codes.filter((c) => c === 201).length).toBeLessThanOrEqual(20);
    expect(codes).toContain(429);
    expect(codes.every((c) => c === 201 || c === 429)).toBe(true);
  });

  it('server flags the side to move on backend time with no client message (1-minute control)', async () => {
    const { w, b } = await seatedRoom(1);
    w.send({ t: 'move', uci: 'e2e4', v: 0 });
    await b.until((x) => x.last?.moves?.length === 1);
    const t0 = Date.now();
    const r = await b.until((x) => !!x.last?.result, 75_000);
    expect(r.result).toEqual({ winner: 'w', how: 'timeout' });
    expect(r.clock.b).toBe(0);
    expect(Date.now() - t0).toBeGreaterThan(58_000);
    expect((await w.until((x) => !!x.last?.result)).result.how).toBe('timeout');
    [w, b].forEach((c) => c.close());
  });
});
