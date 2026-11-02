import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { classify, isFork, pickBotMove, reviewGame, winPct, type PositionEval } from '../src/analysis';

describe('chess rules via chess.js', () => {
  it('handles castling, en passant, promotion, mate and stalemate', () => {
    const c = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(c.move('O-O').san).toBe('O-O');
    const ep = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    expect(ep.move('exd6').isEnPassant()).toBe(true);
    const pr = new Chess('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    expect(pr.move({ from: 'a7', to: 'a8', promotion: 'n' }).promotion).toBe('n');
    const m = new Chess();
    for (const s of ['f3', 'e5', 'g4', 'Qh4#']) m.move(s);
    expect(m.isCheckmate()).toBe(true);
    expect(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').isStalemate()).toBe(true);
  });
});

describe('classification', () => {
  it('uses win-percentage loss thresholds', () => {
    expect(classify({ cp: 0 }, { cp: 0 }, true)).toBe('best');
    expect(classify({ cp: 50 }, { cp: 20 }, false)).toBe('good');
    expect(classify({ cp: 100 }, { cp: -60 }, false)).toBe('mistake');
    expect(classify({ cp: 300 }, { cp: -300 }, false)).toBe('blunder');
    expect(classify({ mate: 2 }, { cp: 100 }, false)).toBe('blunder');
    expect(winPct({ mate: -3 })).toBe(0);
  });
});

describe('fork detection', () => {
  it('finds a knight royal fork', () => {
    // Nc7+ forks king e8 and rook a8
    const t = isFork('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7');
    expect(t?.sort()).toEqual(['a8', 'e8']);
  });
  it('ignores a single attack', () => {
    expect(isFork('4k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7')).toBeNull();
  });
  it('ignores a "fork" where the forker is simply captured', () => {
    // Nc7 attacks a8 rook and e6 queen but black queen defends c7... queen on d8 takes
    expect(isFork('r2qk3/8/4r3/1N6/8/8/8/7K w - - 0 1', 'b5c7')).toBeNull();
  });
});

describe('reviewGame', () => {
  it('flags a missed mate, a hanging piece and a played fork from supplied engine evals', () => {
    // 1. Nc7+ (fork) ... from a position; evals are synthetic but consistent.
    const start = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
    const evals: PositionEval[] = [
      { score: { cp: 400 }, best: 'b5c7' },
      { score: { cp: -500 }, best: 'e8d7' },
      { score: { cp: 500 }, best: 'c7a8' },
    ];
    const r = reviewGame(start, ['b5c7', 'e8d7'], evals);
    expect(r[0].quality).toBe('best');
    expect(r[0].motifs[0]).toMatchObject({ kind: 'fork', by: 'played' });

    // Missed mate: white has Qh7# style mate (score mate 1) but plays a quiet move.
    const s2 = '6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
    const r2 = reviewGame(s2, ['g2g3'], [
      { score: { mate: 1 }, best: 'd1d8' },
      { score: { cp: 0 }, best: 'g8f8' },
    ]);
    expect(r2[0].quality).toBe('blunder');
    expect(r2[0].motifs.some((m) => m.kind === 'missedMate')).toBe(true);

    // Hanging: white moves queen to a square where black's best reply captures it.
    const s3 = '3rk3/8/8/8/8/8/8/3QK3 w - - 0 1';
    const r3 = reviewGame(s3, ['d1d5'], [
      { score: { cp: 0 }, best: 'e1e2' },
      { score: { cp: 900 }, best: 'd8d5' },
    ]);
    expect(r3[0].quality).toBe('blunder');
    expect(r3[0].motifs).toContainEqual({ kind: 'hanging', square: 'd5', capture: 'd8d5' });
  });
});

describe('bot move picking', () => {
  const lines = [
    { multipv: 1, cp: 50, pv: ['e2e4'] },
    { multipv: 2, cp: 30, pv: ['d2d4'] },
    { multipv: 3, cp: -400, pv: ['g2g4'] },
  ];
  it('prefers good moves but varies', () => {
    const counts: Record<string, number> = {};
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) { const m = pickBotMove(lines, rnd, ['a2a3'])!; counts[m] = (counts[m] ?? 0) + 1; }
    expect(counts['e2e4'] + counts['d2d4']).toBeGreaterThan(1500);
    expect(counts['a2a3']).toBeGreaterThan(100);
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(3);
  });
  it('takes a mate in one', () => {
    expect(pickBotMove([{ multipv: 1, mate: 1, pv: ['d1d8'] }, { multipv: 2, cp: 0, pv: ['a2a3'] }], () => 0.5)).toBe('d1d8');
  });
});
