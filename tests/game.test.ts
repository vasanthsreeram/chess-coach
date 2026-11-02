import { describe, expect, it } from 'vitest';
import { applyMove, claimSeat, createRoom, FIRST_MOVE_MS, IDLE_MS, FINISHED_TTL_MS, MAX_LIFETIME_MS, nextDeadline, resign, settle, sideOf, view, type RoomState } from '../worker/game';

const T0 = 1_000_000;
function seated(tc = 3): RoomState {
  const s = createRoom(tc, 'w', 'hw', T0);
  expect(claimSeat(s, 'hb', T0)).toBe('b');
  return s;
}
const play = (s: RoomState, ucis: string[], t = T0) => ucis.forEach((u, i) => expect(applyMove(s, i % 2 ? 'b' : 'w', u, s.moves.length, t + i)).toBeNull());

describe('room rules (server-authoritative)', () => {
  it('seats exactly two players; a third is refused; tokens map to sides', () => {
    const s = seated();
    expect(claimSeat(s, 'h3', T0)).toBeNull();
    expect(sideOf(s, 'hw')).toBe('w'); expect(sideOf(s, 'hb')).toBe('b'); expect(sideOf(s, 'nope')).toBeNull(); expect(sideOf(s, null)).toBeNull();
  });

  it('refuses moves before the opponent joins, from spectators, out of turn, stale versions, illegal and malformed moves', () => {
    const lone = createRoom(3, 'w', 'hw', T0);
    expect(applyMove(lone, 'w', 'e2e4', 0, T0)).toBe('waiting');
    const s = seated();
    expect(applyMove(s, null, 'e2e4', 0, T0)).toBe('not-seated');
    expect(applyMove(s, 'b', 'e7e5', 0, T0)).toBe('turn');
    expect(applyMove(s, 'w', 'e2e5', 0, T0)).toBe('illegal');
    expect(applyMove(s, 'w', 'e2e4; drop', 0, T0)).toBe('format');
    expect(applyMove(s, 'w', 'e2e4', '0', T0)).toBe('format');
    expect(applyMove(s, 'w', 'e2e4', 0, T0)).toBeNull();
    // A second tab of White racing with the same version is refused.
    expect(applyMove(s, 'w', 'd2d4', 0, T0)).toBe('stale');
    expect(applyMove(s, 'b', 'e7e5', 0, T0)).toBe('stale');
    expect(s.moves).toEqual(['e2e4']);
  });

  it('detects checkmate and then refuses further moves', () => {
    const s = seated();
    play(s, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(s.result).toEqual({ winner: 'b', how: 'checkmate' });
    expect(applyMove(s, 'w', 'a2a3', 4, T0 + 10)).toBe('over');
  });

  it('runs the clock on server time; first White move is free; flag falls exactly at zero', () => {
    const s = seated(1);
    play(s, ['e2e4'], T0 + 50_000); // White's first move does not consume White's time
    expect(s.clock.w).toBe(60_000);
    expect(applyMove(s, 'b', 'e7e5', 1, T0 + 50_000 + 20_000)).toBeNull();
    expect(s.clock.b).toBe(40_000);
    const deadline = nextDeadline(s);
    expect(deadline).toEqual({ at: T0 + 70_000 + 60_000, kind: 'settle' });
    expect(settle(s, deadline.at - 1)).toBe(false);
    expect(settle(s, deadline.at)).toBe(true);
    expect(s.result).toEqual({ winner: 'b', how: 'timeout' });
    // A move that arrives after the flag fell is refused even though the alarm has not run yet.
    const t = seated(1); play(t, ['e2e4', 'e7e5'], T0);
    expect(applyMove(t, 'w', 'g1f3', 2, T0 + 1 + 60_000)).toBe('over');
    expect(t.result?.how).toBe('timeout');
  });

  it('resignation after both sides moved is a loss for the resigner', () => {
    const s = seated();
    play(s, ['e2e4', 'e7e5']);
    expect(resign(s, 'b', T0 + 5)).toBeNull();
    expect(s.result).toEqual({ winner: 'w', how: 'resignation' });
  });

  it('resigning before both sides moved aborts; spectators cannot resign', () => {
    const s = seated();
    expect(resign(s, null, T0)).toBe('not-seated');
    play(s, ['e2e4']);
    expect(resign(s, 'b', T0 + 1)).toBeNull();
    expect(s.result).toEqual({ winner: null, how: 'aborted' });
  });

  it('expires unjoined rooms and aborts games whose first move never comes', () => {
    const lone = createRoom(10, 'b', 'hb', T0);
    expect(nextDeadline(lone)).toEqual({ at: T0 + IDLE_MS, kind: 'settle' });
    expect(settle(lone, T0 + IDLE_MS)).toBe(true);
    expect(lone.result?.how).toBe('aborted');
    expect(nextDeadline(lone)).toEqual({ at: T0 + IDLE_MS + FINISHED_TTL_MS, kind: 'delete' });
    const s = seated(10);
    expect(settle(s, T0 + FIRST_MOVE_MS - 1)).toBe(false);
    expect(settle(s, T0 + FIRST_MOVE_MS)).toBe(true);
    expect(s.result?.how).toBe('aborted');
  });

  it('deletes a room at its hard lifetime limit instead of rearming a past alarm', () => {
    const s = seated();
    s.updatedAt = T0 + MAX_LIFETIME_MS;
    expect(nextDeadline(s)).toEqual({ at: T0 + MAX_LIFETIME_MS, kind: 'delete' });
  });

  it('client view never contains seat token hashes', () => {
    const s = seated();
    const v = view(s, 'w', T0, { w: true, b: false });
    expect(JSON.stringify(v)).not.toContain('hw');
    expect(JSON.stringify(v)).not.toContain('hb');
    expect(v.seats).toEqual({ w: true, b: true });
  });
});
