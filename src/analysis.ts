import { Chess, type Color, type Square, type PieceSymbol } from 'chess.js';
import type { PvLine } from './engine';

/** Engine score from the perspective of the side to move. */
export interface Score { cp?: number; mate?: number }

export const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/** Lichess-style win percentage (0..100) for the side the score belongs to. */
export function winPct(s: Score): number {
  if (s.mate !== undefined) return s.mate > 0 ? 100 : s.mate < 0 ? 0 : 50;
  const cp = Math.max(-1000, Math.min(1000, s.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export const negate = (s: Score): Score => (s.mate !== undefined ? { mate: -s.mate } : { cp: -(s.cp ?? 0) });

export type Quality = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export function classify(before: Score, after: Score, playedIsBest: boolean): Quality {
  if (playedIsBest) return 'best';
  const loss = winPct(before) - winPct(after);
  if (loss >= 15) return 'blunder';
  if (loss >= 10) return 'mistake';
  if (loss >= 5) return 'inaccuracy';
  return 'good';
}

/** Pieces of `victimColor` attacked by the piece on `from`, filtered to targets that are genuinely threatened. */
export function forkTargets(chess: Chess, from: Square): Square[] {
  const attacker = chess.get(from);
  if (!attacker) return [];
  const victim: Color = attacker.color === 'w' ? 'b' : 'w';
  const out: Square[] = [];
  for (const row of chess.board()) for (const p of row) {
    if (!p || p.color !== victim || p.type === 'p') continue;
    if (!chess.attackers(p.square, attacker.color).includes(from)) continue;
    const defended = chess.isAttacked(p.square, victim);
    if (p.type === 'k' || VALUE[p.type] > VALUE[attacker.type] || !defended) out.push(p.square);
  }
  return out;
}

/** A move is a fork if, after it, the moved piece threatens two or more targets (king counts). */
export function isFork(fen: string, uci: string): Square[] | null {
  const c = new Chess(fen);
  const m = c.move(uciToMove(uci));
  const t = forkTargets(c, m.to);
  // A fork from a square where the forking piece can simply be taken for free is not a fork.
  const forker = c.get(m.to)!;
  const opp: Color = forker.color === 'w' ? 'b' : 'w';
  const capturable = c.isAttacked(m.to, opp) && !c.isAttacked(m.to, forker.color);
  return t.length >= 2 && !capturable ? t : null;
}

export function uciToMove(uci: string) {
  return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci.length > 4 ? uci[4] : undefined };
}

export type Motif =
  | { kind: 'fork'; by: 'played' | 'missed' | 'allowed'; move: string; targets: Square[] }
  | { kind: 'hanging'; square: Square; capture: string }
  | { kind: 'missedMate'; move: string; mateIn: number }
  | { kind: 'allowedMate'; move: string; mateIn: number };

export interface PlyReview {
  ply: number; san: string; uci: string; color: Color;
  quality: Quality; best: string | null; before: Score; after: Score; motifs: Motif[];
}

export interface PositionEval { score: Score; best: string | null; terminal?: 'mate' | 'draw'; pv?: string[] }

/**
 * Builds the review from per-position evals. evals[i] is the evaluation of the position
 * before ply i (side to move), evals[n] is the final position.
 */
export function reviewGame(startFen: string, uciMoves: string[], evals: PositionEval[]): PlyReview[] {
  const c = new Chess(startFen);
  const out: PlyReview[] = [];
  uciMoves.forEach((uci, i) => {
    const fenBefore = c.fen();
    const color = c.turn();
    const m = c.move(uciToMove(uci));
    const fenAfter = c.fen();
    const before = evals[i].score;
    const next = evals[i + 1];
    const after = next.terminal === 'mate' ? { mate: 1 } : next.terminal === 'draw' ? { cp: 0 } : negate(next.score);
    const best = evals[i].best;
    const quality = classify(before, after, best === uci || (next.terminal === 'mate'));
    const motifs: Motif[] = [];
    const bad = quality === 'mistake' || quality === 'blunder';

    if (before.mate !== undefined && before.mate > 0 && !(after.mate !== undefined && after.mate > 0) && best)
      motifs.push({ kind: 'missedMate', move: best, mateIn: before.mate });
    if (after.mate !== undefined && after.mate < 0 && !(before.mate !== undefined && before.mate < 0) && next.best)
      motifs.push({ kind: 'allowedMate', move: next.best, mateIn: -after.mate });

    if (quality !== 'inaccuracy' && quality !== 'mistake' && quality !== 'blunder') {
      const t = isFork(fenBefore, uci);
      if (t) motifs.push({ kind: 'fork', by: 'played', move: uci, targets: t });
    } else if (best && best !== uci) {
      const t = isFork(fenBefore, best);
      if (t) motifs.push({ kind: 'fork', by: 'missed', move: best, targets: t });
    }

    if (bad && next.best && !next.terminal) {
      const reply = new Chess(fenAfter);
      const rm = reply.move(uciToMove(next.best));
      const victim = new Chess(fenAfter).get(rm.to);
      if (rm.captured && victim && victim.color === color && VALUE[victim.type] >= 3) {
        motifs.push({ kind: 'hanging', square: rm.to, capture: next.best });
      } else {
        const t = isFork(fenAfter, next.best);
        if (t) motifs.push({ kind: 'fork', by: 'allowed', move: next.best, targets: t });
      }
    }
    out.push({ ply: i, san: m.san, uci, color, quality, best, before, after, motifs });
  });
  return out;
}

/**
 * Weak-bot move choice. Picks among MultiPV candidates with a soft preference for better moves
 * and an occasional outright blunder. Strength is roughly club-beginner; it is NOT rating-calibrated.
 */
export function pickBotMove(lines: PvLine[], rnd: () => number = Math.random, legal: string[] = []): string | null {
  const cands = lines.filter((l) => l.pv.length);
  if (rnd() < 0.12 && legal.length) return legal[Math.floor(rnd() * legal.length)];
  if (!cands.length) return legal[0] ?? null;
  // Always take a forced mate in 1-2; beginners spot short mates often.
  const mate = cands.find((l) => l.mate !== undefined && l.mate > 0 && l.mate <= 2);
  if (mate) return mate.pv[0];
  const top = winPct(cands[0]);
  const weights = cands.map((l) => Math.exp(-(top - winPct(l)) / 9));
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cands.length; i++) { r -= weights[i]; if (r <= 0) return cands[i].pv[0]; }
  return cands[0].pv[0];
}

const PIECE_NAME: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const SIDE = (c: Color) => (c === 'w' ? 'White' : 'Black');

/** Engine PV (UCI) rendered as numbered SAN from `fen`, truncated to `max` plies. Stops at the first illegal move. */
export function pvSan(fen: string, pv: string[] | undefined, max = 6): string {
  if (!pv?.length) return '';
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, max)) {
    const no = c.moveNumber(), white = c.turn() === 'w';
    let m;
    try { m = c.move(uciToMove(u)); } catch { break; }
    out.push(white ? `${no}. ${m.san}` : out.length === 0 ? `${no}... ${m.san}` : m.san);
  }
  return out.join(' ');
}

export function sanOf(fen: string, uci: string): string {
  try { return new Chess(fen).move(uciToMove(uci)).san; } catch { return uci; }
}

/** Score (side-to-move perspective) as text for `side`. */
export function fmtScore(s: Score): string {
  if (s.mate !== undefined) return s.mate > 0 ? `forced mate in ${s.mate}` : s.mate < 0 ? `getting mated in ${-s.mate}` : 'checkmate';
  const v = (s.cp ?? 0) / 100;
  return `${v > 0 ? '+' : v < 0 ? '\u2212' : ''}${Math.abs(v).toFixed(2)}`;
}

const QUALITY_TEXT: Record<Quality, string> = { best: 'the engine\'s top move', good: 'a good move', inaccuracy: 'an inaccuracy', mistake: 'a mistake', blunder: 'a blunder' };

/**
 * Plain-text explanation of a reviewed ply. Only states tactics present in `rev.motifs` (which are tied to engine
 * lines); otherwise it reports the evaluation change and the engine continuation.
 */
export function explainPly(fenBefore: string, rev: PlyReview, bestPv?: string[], replyPv?: string[]): string[] {
  const c = new Chess(fenBefore);
  const no = `${c.moveNumber()}${rev.color === 'w' ? '.' : '...'}`;
  const after = new Chess(fenBefore); after.move(uciToMove(rev.uci));
  const fenAfter = after.fen();
  const lines: string[] = [];
  const bestSan = rev.best ? sanOf(fenBefore, rev.best) : null;
  lines.push(`${no} ${rev.san} (${SIDE(rev.color)}) is ${QUALITY_TEXT[rev.quality]}.`);
  if (rev.best && rev.best !== rev.uci && rev.quality !== 'best') {
    const line = pvSan(fenBefore, bestPv?.[0] === rev.best ? bestPv : [rev.best]);
    lines.push(`Engine recommends ${bestSan} instead${line ? `: ${line}` : ''}.`);
  }
  const wb = Math.round(winPct(rev.before)), wa = Math.round(winPct(rev.after));
  lines.push(`Evaluation for ${SIDE(rev.color)}: ${fmtScore(rev.before)} before, ${fmtScore(rev.after)} after (win chance ${wb}% \u2192 ${wa}%).`);
  const names = (sqs: string[], fen: string) => { const p = new Chess(fen); return sqs.map((s) => `${PIECE_NAME[p.get(s as Square)!.type]} on ${s}`).join(' and '); };
  for (const m of rev.motifs) {
    if (m.kind === 'fork') {
      if (m.by === 'played') lines.push(`${rev.san} forks the ${names(m.targets, fenAfter)}.`);
      else if (m.by === 'missed') lines.push(`${bestSan} would have forked the ${names(m.targets, (() => { const x = new Chess(fenBefore); x.move(uciToMove(m.move)); return x.fen(); })())}.`);
      else lines.push(`It allows ${sanOf(fenAfter, m.move)}, forking the ${names(m.targets, (() => { const x = new Chess(fenAfter); x.move(uciToMove(m.move)); return x.fen(); })())}.`);
    } else if (m.kind === 'hanging') {
      const victim = after.get(m.square);
      lines.push(`The engine can capture the ${victim ? PIECE_NAME[victim.type] : 'piece'} on ${m.square} with ${sanOf(fenAfter, m.capture)}.`);
    } else if (m.kind === 'missedMate') {
      lines.push(`${sanOf(fenBefore, m.move)} started a forced mate in ${m.mateIn}; ${rev.san} lets it slip.`);
    } else {
      lines.push(`It allows mate in ${m.mateIn}, starting with ${sanOf(fenAfter, m.move)}.`);
    }
  }
  const bad = rev.quality === 'inaccuracy' || rev.quality === 'mistake' || rev.quality === 'blunder';
  if (bad && rev.motifs.length === 0) lines.push('No single tactic (fork, hanging piece, mate) was detected; the engine simply rates the resulting position worse.');
  const cont = pvSan(fenAfter, replyPv);
  if (cont) lines.push(`Engine continuation after ${rev.san}: ${cont}.`);
  return lines;
}
