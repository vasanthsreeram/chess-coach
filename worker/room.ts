// One Durable Object per invite room. It owns the authoritative game (rules, clocks, result), persists it to
// the object's SQLite-backed storage after every change, and fans out full positions to every socket.
// Uses the WebSocket Hibernation API so idle games cost no duration charges.
import { DurableObject } from 'cloudflare:workers';
import type { Color } from 'chess.js';
import { randomToken, sha256 } from './tokens';
import { applyMove, claimSeat, createRoom, isTc, nextDeadline, resign, settle, sideOf, view, type RoomState } from './game';

const MAX_SOCKETS = 8;
const MAX_FRAME = 256;
const FRAME_WINDOW_MS = 10_000;
const FRAMES_PER_WINDOW = 40;

interface Att { side: Color | null; hello: boolean; win: number; n: number }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export class ChessRoom extends DurableObject {
  private s: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get<RoomState>('s')) ?? null; });
  }

  private async persist() {
    const s = this.s!;
    await this.ctx.storage.put('s', s);
    await this.ctx.storage.setAlarm(nextDeadline(s).at);
  }

  private online(exclude?: WebSocket) {
    const o = { w: false, b: false };
    for (const ws of this.ctx.getWebSockets()) { if (ws === exclude) continue; const a = ws.deserializeAttachment() as Att | null; if (a?.side) o[a.side] = true; }
    return o;
  }

  private broadcast(exclude?: WebSocket) {
    if (!this.s) return;
    const now = Date.now(); const online = this.online(exclude);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment() as Att | null;
      if (!a?.hello) continue;
      try { ws.send(JSON.stringify({ ...view(this.s, a.side, now, online), now })); } catch { /* socket already closing */ }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const op = url.pathname.split('/').pop();
    if (op === 'create' && req.method === 'POST') {
      if (this.s) return json(409, { error: 'exists' });
      const b: any = await req.json().catch(() => null);
      if (!isTc(b?.tc) || (b.side !== 'w' && b.side !== 'b')) return json(400, { error: 'input' });
      const token = randomToken();
      this.s = createRoom(b.tc, b.side, await sha256(token), Date.now());
      await this.persist();
      return json(201, { token, side: b.side, tc: b.tc });
    }
    if (op === 'ws') {
      if (req.headers.get('upgrade') !== 'websocket') return json(426, { error: 'upgrade' });
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return json(429, { error: 'sockets' });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ side: null, hello: false, win: Date.now(), n: 0 } satisfies Att);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // Unknown rooms never write storage, so probing random ids cannot grow storage.
    if (!this.s) return json(404, { error: 'no room' });
    if (op === 'join' && req.method === 'POST') {
      const now = Date.now();
      if (settle(this.s, now)) { await this.persist(); this.broadcast(); }
      const token = randomToken();
      const side = claimSeat(this.s, await sha256(token), now);
      if (!side) return json(409, { error: 'full' });
      await this.persist();
      this.broadcast();
      return json(200, { token, side, tc: this.s.tc });
    }
    return json(404, { error: 'op' });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const a = ws.deserializeAttachment() as Att;
    const now = Date.now();
    if (now - a.win > FRAME_WINDOW_MS) { a.win = now; a.n = 0; }
    a.n++;
    ws.serializeAttachment(a);
    if (typeof raw !== 'string' || raw.length > MAX_FRAME || a.n > FRAMES_PER_WINDOW) { ws.close(1008, 'policy'); return; }
    let m: any;
    try { m = JSON.parse(raw); } catch { ws.close(1008, 'json'); return; }
    // Unknown or expired room: a close code the client understands, so it stops reconnecting.
    if (!this.s) { ws.close(4404, 'no room'); return; }
    const s = this.s;
    if (m?.t === 'hello') {
      a.side = typeof m.token === 'string' && m.token.length <= 64 ? sideOf(s, await sha256(m.token)) : null;
      a.hello = true;
      ws.serializeAttachment(a);
      if (settle(s, now)) await this.persist();
      this.broadcast(); // everyone learns the new presence
      return;
    }
    if (!a.hello) { ws.close(1008, 'hello first'); return; }
    if (m?.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', now })); return; }
    const before = JSON.stringify(s);
    const err = m?.t === 'move' ? applyMove(s, a.side, m.uci, m.v, now) : m?.t === 'resign' ? resign(s, a.side, now) : 'format';
    if (JSON.stringify(s) !== before) { await this.persist(); this.broadcast(); }
    // A refused frame gets the authoritative state back so the client can reconcile.
    if (err) ws.send(JSON.stringify({ ...view(s, a.side, now, this.online()), t: 'error', code: err, now }));
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ }
    // Presence changed; the closing socket may still be listed, so exclude it explicitly.
    this.broadcast(ws);
  }

  async webSocketError() { /* close handler covers cleanup */ }

  async alarm() {
    if (!this.s) return;
    const now = Date.now();
    const d = nextDeadline(this.s);
    if (d.kind === 'delete' && now >= d.at) {
      for (const ws of this.ctx.getWebSockets()) try { ws.close(4410, 'expired'); } catch { /* ignore */ }
      this.s = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    if (settle(this.s, now)) this.broadcast();
    await this.persist();
  }
}
