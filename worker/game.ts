// Pure, server-authoritative rules for a two-player room. No I/O: the Durable Object (room.ts) persists
// the returned state, so every function here is deterministic given `now` and is unit-testable.
import { Chess, type Color } from 'chess.js';
import { type Clock, TIME_CONTROLS, startClock, remaining, press, timeoutResult } from '../src/clock';

export type Result = { winner: Color | null; how: string };
export interface RoomState {
  v: 1;
  tc: number;
  createdAt: number;
  updatedAt: number;
  /** SHA-256 (hex) of each seat token; tokens themselves are never stored. */
  seats: { w: string | null; b: string | null };
  moves: string[];
  clock: Clock;
  result: Result | null;
  endedAt: number | null;
}

export const MAX_PLIES = 600;
/** Unjoined rooms, and games whose first moves never happen, expire after this. */
export const IDLE_MS = 60 * 60_000;
/** Finished rooms are kept this long so reconnecting players can still see the result, then deleted. */
export const FINISHED_TTL_MS = 60 * 60_000;
/** Hard cap on any room's lifetime regardless of activity. */
export const MAX_LIFETIME_MS = 24 * 60 * 60_000;
/** If both seats are filled but a side never makes its first move, the game is aborted (no result for history). */
export const FIRST_MOVE_MS = 5 * 60_000;

export const isTc = (n: unknown): n is number => typeof n === 'number' && (TIME_CONTROLS as readonly number[]).includes(n);
export const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export function createRoom(tc: number, side: Color, tokenHash: string, now: number): RoomState {
  return { v: 1, tc, createdAt: now, updatedAt: now, seats: { w: side === 'w' ? tokenHash : null, b: side === 'b' ? tokenHash : null }, moves: [], clock: startClock(tc), result: null, endedAt: null };
}

export function replay(moves: string[]): Chess {
  const g = new Chess();
  for (const m of moves) g.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  return g;
}

export function positionResult(g: Chess): Result | null {
  if (g.isCheckmate()) return { winner: g.turn() === 'w' ? 'b' : 'w', how: 'checkmate' };
  if (g.isStalemate()) return { winner: null, how: 'stalemate' };
  if (g.isThreefoldRepetition()) return { winner: null, how: 'threefold repetition' };
  if (g.isInsufficientMaterial()) return { winner: null, how: 'insufficient material' };
  if (g.isDraw()) return { winner: null, how: 'fifty-move rule' };
  return null;
}

export const sideOf = (s: RoomState, hash: string | null): Color | null => (!hash ? null : s.seats.w === hash ? 'w' : s.seats.b === hash ? 'b' : null);

/** Gives the free seat to a new player. Returns null when the room is full. */
export function claimSeat(s: RoomState, hash: string, now: number): Color | null {
  const free: Color | null = s.seats.w === null ? 'w' : s.seats.b === null ? 'b' : null;
  if (!free || s.result) return null;
  s.seats[free] = hash; s.updatedAt = now;
  return free;
}

const finish = (s: RoomState, r: Result, now: number) => { s.result = r; s.endedAt = now; s.updatedAt = now; };

/** Settles a clock expiry or an abandoned start. Returns true if the state changed. */
export function settle(s: RoomState, now: number, g = replay(s.moves)): boolean {
  if (s.result) return false;
  const started = s.seats.w && s.seats.b;
  if (s.moves.length < 2) {
    const since = s.moves.length === 0 ? s.updatedAt : s.clock.since!;
    if ((started && now - since >= FIRST_MOVE_MS) || (!started && now - s.createdAt >= IDLE_MS)) { finish(s, { winner: null, how: 'aborted' }, now); return true; }
    if (s.moves.length === 0) return false;
  }
  const turn = g.turn();
  if (remaining(s.clock, turn, turn, now) > 0) return false;
  s.clock = { ...s.clock, [turn]: 0 };
  finish(s, timeoutResult(g, turn), now);
  return true;
}

export type MoveError = 'over' | 'not-seated' | 'waiting' | 'turn' | 'stale' | 'illegal' | 'format' | 'limit';

/**
 * Applies `uci` for `side`. `ver` is the ply count the client saw; any other value means the client
 * is behind (or racing another tab) and the move is refused so the client can reconcile.
 */
export function applyMove(s: RoomState, side: Color | null, uci: unknown, ver: unknown, now: number): MoveError | null {
  if (typeof uci !== 'string' || !UCI.test(uci) || typeof ver !== 'number') return 'format';
  const g = replay(s.moves);
  if (settle(s, now, g)) return 'over';
  if (s.result) return 'over';
  if (!side) return 'not-seated';
  if (!s.seats.w || !s.seats.b) return 'waiting';
  if (ver !== s.moves.length) return 'stale';
  if (g.turn() !== side) return 'turn';
  if (s.moves.length >= MAX_PLIES) return 'limit';
  let lan: string;
  try { lan = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).lan; } catch { return 'illegal'; }
  s.clock = press(s.clock, side, now).clock; // settle() above guarantees the mover still had time
  s.moves.push(lan);
  s.updatedAt = now;
  const r = positionResult(g);
  if (r) finish(s, r, now);
  return null;
}

export function resign(s: RoomState, side: Color | null, now: number): MoveError | null {
  if (settle(s, now) || s.result) return 'over';
  if (!side) return 'not-seated';
  if (s.moves.length < 2) finish(s, { winner: null, how: 'aborted' }, now);
  else finish(s, { winner: side === 'w' ? 'b' : 'w', how: 'resignation' }, now);
  return null;
}

/** When the Durable Object alarm must next fire: a flag fall, an abandoned start, or deletion. */
export function nextDeadline(s: RoomState): { at: number; kind: 'settle' | 'delete' } {
  const hardStop = s.createdAt + MAX_LIFETIME_MS;
  if (s.result) return { at: Math.min(s.endedAt! + FINISHED_TTL_MS, hardStop), kind: 'delete' };
  let at = hardStop;
  if (!s.seats.w || !s.seats.b) at = s.createdAt + IDLE_MS;
  else if (s.moves.length === 0) at = s.updatedAt + FIRST_MOVE_MS;
  else {
    const g = replay(s.moves); const turn = g.turn();
    at = s.clock.since! + s.clock[turn];
    if (s.moves.length === 1) at = Math.min(at, s.clock.since! + FIRST_MOVE_MS);
  }
  // Reaching the hard lifetime cap deletes the room instead of repeatedly
  // rearming an alarm at a deadline that has already passed.
  return at >= hardStop ? { at: hardStop, kind: 'delete' } : { at, kind: 'settle' };
}

/** What a client may see: no token hashes. Clock values are as of `now`. */
export function view(s: RoomState, you: Color | null, now: number, online: { w: boolean; b: boolean }) {
  const g = replay(s.moves);
  const turn = g.turn();
  const running = !s.result && s.clock.since !== null ? turn : null;
  return {
    t: 'state' as const, tc: s.tc, you, moves: s.moves, fen: g.fen(), seats: { w: !!s.seats.w, b: !!s.seats.b }, online,
    clock: { w: remaining(s.clock, 'w', turn, now), b: remaining(s.clock, 'b', turn, now) }, running, result: s.result,
  };
}
export type RoomView = ReturnType<typeof view>;
