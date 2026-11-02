import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { startClock, press, remaining, timeoutResult, canMate, fmtClock } from '../src/clock';
import { explainPly, pvSan, reviewGame, type PositionEval } from '../src/analysis';

describe('clock', () => {
  it.each([1, 3, 10])('%i-minute control starts both sides equal and White’s first move is free', (m) => {
    const c = startClock(m);
    expect(c.w).toBe(m * 60_000); expect(c.b).toBe(m * 60_000);
    const r = press(c, 'w', 1_000_000);
    expect(r.flagged).toBe(false);
    expect(r.clock.w).toBe(m * 60_000);
    // Black's clock now runs on wall time.
    expect(remaining(r.clock, 'b', 'b', 1_000_000 + 2_500)).toBe(m * 60_000 - 2_500);
    expect(remaining(r.clock, 'w', 'b', 1_000_000 + 2_500)).toBe(m * 60_000);
  });
  it('switches on a move and deducts elapsed wall time (including engine think time)', () => {
    let c = press(startClock(1), 'w', 0).clock;
    c = press(c, 'b', 7_000).clock;
    expect(c.b).toBe(53_000);
    expect(c.since).toBe(7_000);
    expect(remaining(c, 'w', 'w', 17_000)).toBe(50_000);
  });
  it('boundary: a move 1 ms before expiry stands; at exactly expiry or later it flags', () => {
    const c = { w: 5_000, b: 5_000, since: 0 };
    expect(press(c, 'w', 4_999).flagged).toBe(false);
    expect(press(c, 'w', 4_999).clock.w).toBe(1);
    expect(press(c, 'w', 5_000).flagged).toBe(true);
    expect(press(c, 'w', 60_000).clock.w).toBe(0);
  });
  it('elapsed time survives a serialised reload (wall-clock based)', () => {
    const c = press(startClock(3), 'w', 1_000).clock;
    const reloaded = JSON.parse(JSON.stringify(c));
    expect(remaining(reloaded, 'b', 'b', 1_000 + 90_000)).toBe(90_000);
  });
  it('timeout: win for opponent with mating material, draw when opponent cannot mate', () => {
    expect(timeoutResult(new Chess(), 'w')).toEqual({ winner: 'b', how: 'timeout' });
    const bareKing = new Chess('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    expect(timeoutResult(bareKing, 'w')).toEqual({ winner: null, how: 'timeout vs insufficient material' });
    const loneKnightVsBare = new Chess('4k3/8/8/8/8/8/8/R3K1n1 w - - 0 1');
    expect(canMate(loneKnightVsBare, 'b')).toBe(true); // White has a rook, so a helpmate exists
    const knightVsKing = new Chess('4k3/8/8/8/8/8/8/4K1n1 w - - 0 1');
    expect(timeoutResult(knightVsKing, 'w').winner).toBe(null);
    expect(canMate(new Chess('4k3/8/8/8/8/8/P7/4K3 w - - 0 1'), 'w')).toBe(true);
  });
  it('formats', () => {
    expect(fmtClock(180_000)).toBe('3:00');
    expect(fmtClock(59_001)).toBe('1:00');
    expect(fmtClock(9_450)).toBe('0:09.4');
    expect(fmtClock(-5)).toBe('0:00');
  });
});

describe('explanations', () => {
  it('inaccuracy without a detected tactic: names played move, recommendation, eval change and engine line — no invented tactic', () => {
    // 1.e4 e5 2.Nf3 then 2...f6 (engine prefers Nc6). Evals are supplied as if from the engine.
    const moves = ['e2e4', 'e7e5', 'g1f3', 'f7f6'];
    const evals: PositionEval[] = [
      { score: { cp: 30 }, best: 'e2e4', pv: ['e2e4'] },
      { score: { cp: -30 }, best: 'e7e5', pv: ['e7e5'] },
      { score: { cp: 35 }, best: 'g1f3', pv: ['g1f3'] },
      { score: { cp: -40 }, best: 'b8c6', pv: ['b8c6', 'f1b5', 'a7a6'] },
      { score: { cp: 190 }, best: 'f3e5', pv: ['f3e5', 'f6e5', 'd1h5', 'e8e7'] },
    ];
    const rev = reviewGame(new Chess().fen(), moves, evals);
    expect(rev[3].quality).toBe('mistake');
    const c = new Chess(); for (const m of moves.slice(0, 3)) c.move(m);
    const text = explainPly(c.fen(), rev[3], evals[3].pv, evals[4].pv).join('\n');
    expect(text).toContain('2... f6 (Black) is a mistake.');
    expect(text).toContain('Engine recommends Nc6 instead: 2... Nc6 3. Bb5 a6.');
    expect(text).toContain('−0.40 before, −1.90 after');
    expect(text).toContain('No single tactic');
    expect(text).toContain('Engine continuation after f6: 3. Nxe5 fxe5 4. Qh5+ Ke7.');
    expect(text).not.toMatch(/forks the|hanging:|allows mate|forced mate/);
  });
  it('states a substantiated tactic (allowed mate) with its engine move', () => {
    const moves = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6'];
    const evals: PositionEval[] = [
      { score: { cp: 30 }, best: 'e2e4' }, { score: { cp: -30 }, best: 'e7e5' }, { score: { cp: 30 }, best: 'f1c4' },
      { score: { cp: -30 }, best: 'b8c6' }, { score: { cp: 40 }, best: 'd1h5' }, { score: { cp: -50 }, best: 'g7g6' },
      { score: { mate: 1 }, best: 'h5f7', pv: ['h5f7'] },
    ];
    const rev = reviewGame(new Chess().fen(), moves, evals);
    const c = new Chess(); for (const m of moves.slice(0, 5)) c.move(m);
    const text = explainPly(c.fen(), rev[5], undefined, evals[6].pv).join('\n');
    expect(rev[5].quality).toBe('blunder');
    expect(text).toContain('Engine recommends g6 instead');
    expect(text).toContain('It allows mate in 1, starting with Qxf7#.');
  });
  it('pvSan handles promotion and stops at an illegal move', () => {
    expect(pvSan('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7a8q', 'e8d7', 'zzzz'])).toBe('1. a8=Q+ Kd7');
  });
});
