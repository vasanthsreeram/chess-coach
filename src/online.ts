// Client for invite-link games. The server is authoritative: every frame it sends is a full position,
// which simply replaces local state, so reconnects and refused moves reconcile without diffing.
import type { Color } from 'chess.js';

export interface RoomView {
  t: 'state' | 'error'; code?: string; tc: number; you: Color | null; moves: string[]; fen: string;
  seats: { w: boolean; b: boolean }; online: { w: boolean; b: boolean };
  clock: { w: number; b: number }; running: Color | null; result: { winner: Color | null; how: string } | null; now: number;
}
export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'gone';

const SEATS = 'chess-minimal.rooms.v1';
const SEAT_TTL = 2 * 24 * 60 * 60_000;
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;

type Seat = { token: string; side: Color; at: number };
function seats(): Record<string, Seat> {
  try { const s = JSON.parse(localStorage.getItem(SEATS) ?? '{}'); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}
export const seatFor = (room: string): Seat | null => seats()[room] ?? null;
function keepSeat(room: string, seat: Seat) {
  const now = Date.now();
  const all = Object.fromEntries(Object.entries(seats()).filter(([, v]) => now - v.at < SEAT_TTL));
  all[room] = seat;
  localStorage.setItem(SEATS, JSON.stringify(all));
}

export const roomFromHash = (h = location.hash): string | null => { const m = /^#room=([A-Za-z0-9_-]+)$/.exec(h); return m && ROOM_ID.test(m[1]) ? m[1] : null; };
export const inviteUrl = (room: string) => `${location.origin}${location.pathname}#room=${room}`;

async function post(path: string, body?: unknown) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j;
}

export async function createRoom(tc: number, side: Color): Promise<string> {
  const j = await post('/api/rooms', { tc, side });
  keepSeat(j.room, { token: j.token, side: j.side, at: Date.now() });
  return j.room;
}

/** Claims the free seat unless this browser already holds one. 'full' means watch-only. */
export async function joinRoom(room: string): Promise<'seated' | 'full'> {
  if (seatFor(room)) return 'seated';
  try {
    const j = await post(`/api/rooms/${room}/join`);
    keepSeat(room, { token: j.token, side: j.side, at: Date.now() });
    return 'seated';
  } catch (e) {
    if ((e as Error).message === 'full') return 'full';
    throw e;
  }
}

export class Connection {
  status: ConnStatus = 'connecting';
  view: RoomView | null = null;
  /** performance.now() when `view` arrived; clocks run down locally from there until the next frame. */
  recvAt = 0;
  private ws: WebSocket | null = null;
  private tries = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly room: string, private onChange: () => void) { this.open(); }

  private open() {
    if (this.closed) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${this.room}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0; this.status = 'open';
      ws.send(JSON.stringify({ t: 'hello', token: seatFor(this.room)?.token }));
      this.onChange();
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t === 'state' || m.t === 'error') { this.view = m; this.recvAt = performance.now(); this.onChange(); }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      // 4404/4410: room unknown or expired; reconnecting cannot help.
      if (e.code === 4404 || e.code === 4410) { this.status = 'gone'; this.onChange(); return; }
      this.status = 'reconnecting'; this.onChange();
      this.timer = setTimeout(() => this.open(), Math.min(8000, 300 * 2 ** this.tries++));
    };
  }

  /** Simulates a dropped network connection (used by tests); the client reconnects on its own. */
  drop() { this.ws?.close(); }

  send(m: object) { if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(m)); return true; } return false; }

  close() { this.closed = true; clearTimeout(this.timer); this.ws?.close(); this.ws = null; }

  /** Remaining ms for `side` as shown now. */
  clockMs(side: Color): number {
    const v = this.view; if (!v) return 0;
    return v.running === side ? Math.max(0, v.clock[side] - (performance.now() - this.recvAt)) : v.clock[side];
  }
}
