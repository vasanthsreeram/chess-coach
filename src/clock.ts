import { Chess, type Color } from 'chess.js';

/** Remaining ms per side; `since` is the wall-clock epoch ms when the side to move started thinking (null = not started). */
export interface Clock { w: number; b: number; since: number | null }

export const TIME_CONTROLS = [1, 3, 10] as const;

export const startClock = (minutes: number): Clock => ({ w: minutes * 60_000, b: minutes * 60_000, since: null });

/** Time left for `side` at wall time `now`; only the side to move (`turn`) is running. */
export function remaining(c: Clock, side: Color, turn: Color, now: number): number {
  if (side !== turn || c.since === null) return c[side];
  return Math.max(0, c[side] - (now - c.since));
}

/**
 * Called when `mover` completes a move at `now`. A move made at or after expiry is rejected (flagged).
 * The first press starts the opponent's clock (White's first move is free).
 */
export function press(c: Clock, mover: Color, now: number): { clock: Clock; flagged: boolean } {
  const left = remaining(c, mover, mover, now);
  if (left <= 0) return { clock: { ...c, [mover]: 0 }, flagged: true };
  return { clock: { ...c, [mover]: left, since: now }, flagged: false };
}

/** FIDE 6.9: a flag is a draw if the opponent cannot mate by any legal sequence. Conservative check. */
export function canMate(g: Chess, color: Color): boolean {
  const mine: string[] = [], theirs: string[] = [];
  for (const row of g.board()) for (const p of row) {
    if (!p || p.type === 'k') continue;
    (p.color === color ? mine : theirs).push(p.type);
  }
  if (mine.length === 0) return false;
  // Lone minor piece cannot mate a bare king; with any enemy material a helpmate is possible.
  if (mine.length === 1 && (mine[0] === 'n' || mine[0] === 'b') && theirs.length === 0) return false;
  return true;
}

export function timeoutResult(g: Chess, flagged: Color): { winner: Color | null; how: string } {
  const opp: Color = flagged === 'w' ? 'b' : 'w';
  return canMate(g, opp) ? { winner: opp, how: 'timeout' } : { winner: null, how: 'timeout vs insufficient material' };
}

export function fmtClock(ms: number): string {
  if (ms <= 0) return '0:00';
  if (ms < 10_000) return `0:0${Math.floor(ms / 1000)}.${Math.floor((ms % 1000) / 100)}`;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
