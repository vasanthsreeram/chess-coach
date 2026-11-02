// Deterministic, chess.js-verified facts about one reviewed move. Shared by the browser and the
// /api/feedback Worker, so the model only ever sees (and may only rephrase) facts computed here.
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js';
import { classify, isFork, negate, uciToMove, VALUE, type Quality, type Score } from './analysis';

export const FEEDBACK_VERSION = 1;
export const MAX_PV = 8;

export interface FeedbackInput {
  fen: string; move: string; best: string | null;
  bestPv: string[]; replyPv: string[];
  /** Engine score before the move, side to move (the mover) perspective. */
  before: Score;
  /** Engine score of the position after the move, side to move (the opponent) perspective. */
  afterRaw: Score | null;
}

export type FactKind = 'what' | 'threat' | 'tactic' | 'why' | 'better' | 'eval' | 'fallback';
export interface Fact { id: string; kind: FactKind; text: string }
export interface Feedback { quality: Quality; headline: string; facts: Fact[]; bestLine: string[]; replyLine: string[] }

const NAME: Record<PieceSymbol, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const SIDE = (c: Color) => (c === 'w' ? 'White' : 'Black');
const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const QUALITY_HEAD: Record<Quality, string> = { best: 'Best move', good: 'Good move', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' };
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function tryMove(c: Chess, uci: string): Move | null {
  if (!UCI.test(uci)) return null;
  try { return c.move(uciToMove(uci)); } catch { return null; }
}

/** Legal prefix of a UCI line from `fen`. */
export function legalPrefix(fen: string, pv: string[], max = MAX_PV): string[] {
  const c = new Chess(fen); const out: string[] = [];
  for (const u of pv.slice(0, max)) { if (!tryMove(c, u)) break; out.push(u); }
  return out;
}

/** Plain-English description of a move, e.g. "White's knight takes the pawn on e5 (Nxe5), giving check". */
export function describeMove(m: Move, withSan = true): string {
  const who = `${SIDE(m.color)}'s ${NAME[m.piece]}`;
  let s: string;
  if (m.isKingsideCastle()) s = `${SIDE(m.color)} castles kingside`;
  else if (m.isQueensideCastle()) s = `${SIDE(m.color)} castles queenside`;
  else if (m.isEnPassant()) s = `${who} on ${m.from} takes the pawn on ${m.to[0]}${m.from[1]} en passant`;
  else if (m.captured) s = `${who} on ${m.from} takes the ${NAME[m.captured]} on ${m.to}`;
  else s = `${who} moves from ${m.from} to ${m.to}`;
  if (m.promotion) s += ` and promotes to a ${NAME[m.promotion]}`;
  if (withSan) s += ` (${m.san.replace(/[+#]$/, '')})`;
  if (m.san.endsWith('#')) s += ', checkmate';
  else if (m.san.endsWith('+')) s += ', giving check';
  return s;
}

/** Numbered line with full piece names, e.g. "1. knight f3→e5 (Ne5), 1... pawn d6 takes e5 (dxe5)". */
export function describeLine(fen: string, pv: string[], max = 4): string {
  const c = new Chess(fen); const out: string[] = [];
  for (const u of pv.slice(0, max)) {
    const no = c.moveNumber(), white = c.turn() === 'w';
    const m = tryMove(c, u); if (!m) break;
    const verb = m.isKingsideCastle() ? 'castles kingside' : m.isQueensideCastle() ? 'castles queenside'
      : m.captured ? `${m.from} takes ${NAME[m.captured]} ${m.isEnPassant() ? `${m.to[0]}${m.from[1]}` : m.to}` : `${m.from}–${m.to}`;
    const piece = m.isKingsideCastle() || m.isQueensideCastle() ? SIDE(m.color) : `${SIDE(m.color)} ${NAME[m.piece]}`;
    out.push(`${no}${white ? '.' : '...'} ${piece} ${verb}${m.promotion ? ` =${NAME[m.promotion]}` : ''} (${m.san})`);
  }
  return out.join(', ');
}

/** Material captured by each side along a line. Stops before a trailing capture can be answered beyond the line. */
function exchange(fen: string, pv: string[]): { taken: Record<Color, PieceSymbol[]>; plies: number } {
  const c = new Chess(fen); const taken: Record<Color, PieceSymbol[]> = { w: [], b: [] };
  const moves: Move[] = []; const fens = [c.fen()];
  for (const u of pv) { const m = tryMove(c, u); if (!m) break; moves.push(m); fens.push(c.fen()); }
  // Drop trailing captures that could still be recaptured beyond the end of the line, so a
  // capture whose answer lies outside the line is never reported as a material win.
  let end = moves.length;
  while (end > 0 && moves[end - 1].captured) {
    const p = new Chess(fens[end]);
    if (!p.moves({ verbose: true }).some((x) => x.to === moves[end - 1].to)) break;
    end--;
  }
  for (const m of moves.slice(0, end)) if (m.captured) taken[m.color].push(m.captured);
  return { taken, plies: end };
}
const sum = (ps: PieceSymbol[]) => ps.reduce((a, p) => a + VALUE[p], 0);
const list = (ps: PieceSymbol[]) => {
  const n: Record<string, number> = {};
  ps.forEach((p) => (n[NAME[p]] = (n[NAME[p]] ?? 0) + 1));
  return Object.entries(n).map(([k, v]) => (v > 1 ? `${v} ${k}s` : `a ${k}`)).join(' and ');
};

/** Enemy (non-king) pieces of `victim` that are pinned to their king. */
export function pinnedPieces(c: Chess, victim: Color): Square[] {
  const kingSq = c.findPiece({ type: 'k', color: victim })[0];
  if (!kingSq) return [];
  const out: Square[] = [];
  for (const row of c.board()) for (const p of row) {
    if (!p || p.color !== victim || p.type === 'k') continue;
    const before = c.attackers(kingSq, other(victim)).length;
    const copy = new Chess(c.fen(), { skipValidation: true });
    copy.remove(p.square);
    if (copy.attackers(kingSq, other(victim)).length > before) out.push(p.square);
  }
  return out;
}

/** Pieces of `side` (value ≥ 3) attacked by the opponent and not defended. */
function loosePieces(c: Chess, side: Color): Square[] {
  const out: Square[] = [];
  for (const row of c.board()) for (const p of row) {
    if (!p || p.color !== side || p.type === 'k' || p.type === 'p') continue;
    if (c.isAttacked(p.square, other(side)) && !c.isAttacked(p.square, side)) out.push(p.square);
  }
  return out;
}

const CENTER: Square[] = ['d4', 'e4', 'd5', 'e5'];
const centerControl = (c: Chess, side: Color) => CENTER.filter((s) => c.attackers(s, side).length > 0).length;

export function scoreText(s: Score, side: Color): string {
  if (s.mate !== undefined) return s.mate > 0 ? `${SIDE(side)} has a forced mate in ${s.mate}` : s.mate < 0 ? `${SIDE(other(side))} has a forced mate in ${-s.mate}` : 'checkmate';
  const v = (s.cp ?? 0) / 100;
  if (Math.abs(v) < 0.2) return 'about equal';
  return `engine favours ${SIDE(v > 0 ? side : other(side))} by ${Math.abs(v).toFixed(1)} pawn units`;
}

/** Validates untrusted input (from the browser or an HTTP request). Returns null when invalid. */
export function sanitizeInput(x: any): FeedbackInput | null {
  if (!x || typeof x !== 'object') return null;
  const okScore = (s: any): Score | null => {
    if (!s || typeof s !== 'object') return null;
    const cp = s.cp, mate = s.mate;
    if (mate !== undefined && mate !== null) return Number.isInteger(mate) && Math.abs(mate) <= 99 ? { mate } : null;
    return Number.isInteger(cp) && Math.abs(cp) <= 10000 ? { cp } : null;
  };
  if (typeof x.fen !== 'string' || x.fen.length > 100 || typeof x.move !== 'string' || !UCI.test(x.move)) return null;
  let c: Chess;
  try { c = new Chess(x.fen); } catch { return null; }
  if (!tryMove(c, x.move)) return null;
  const arr = (a: any) => (Array.isArray(a) && a.length <= MAX_PV && a.every((u) => typeof u === 'string' && UCI.test(u)) ? a as string[] : null);
  const bestPv = arr(x.bestPv ?? []), replyPv = arr(x.replyPv ?? []);
  if (!bestPv || !replyPv) return null;
  const best = x.best === null || x.best === undefined ? null : typeof x.best === 'string' && UCI.test(x.best) ? x.best : undefined;
  if (best === undefined) return null;
  const before = okScore(x.before);
  const afterRaw = x.afterRaw === null ? null : okScore(x.afterRaw);
  if (!before || afterRaw === undefined || (x.afterRaw !== null && !afterRaw)) return null;
  const fen = new Chess(x.fen).fen();
  return { fen, move: x.move, best: best && legalPrefix(fen, [best]).length ? best : null, bestPv: legalPrefix(fen, bestPv), replyPv: legalPrefix(c.fen(), replyPv), before, afterRaw };
}

export function buildFeedback(inp: FeedbackInput): Feedback {
  const pre = new Chess(inp.fen);
  const mover = pre.turn(), opp = other(mover);
  const post = new Chess(inp.fen);
  const m = post.move(uciToMove(inp.move));
  const facts: Fact[] = [];
  const add = (kind: FactKind, text: string) => facts.push({ id: `f${facts.length + 1}`, kind, text });

  const mated = post.isCheckmate();
  const drawn = !mated && (post.isStalemate() || post.isInsufficientMaterial() || post.isThreefoldRepetition() || post.isDraw());
  const after: Score = mated ? { mate: 1 } : drawn ? { cp: 0 } : negate(inp.afterRaw ?? { cp: 0 });
  const bestPv = inp.bestPv[0] === inp.best ? inp.bestPv : inp.best ? [inp.best] : [];
  const playedBest = inp.best === inp.move || mated;
  const quality = classify(inp.before, after, playedBest);
  const bad = quality === 'inaccuracy' || quality === 'mistake' || quality === 'blunder';

  add('what', `${describeMove(m, false)}.`);
  if (mated) add('tactic', `That is checkmate: ${SIDE(mover)} wins the game.`);
  else if (post.isStalemate()) add('tactic', `${SIDE(opp)} has no legal move and is not in check: the game is a draw by stalemate.`);
  else if (drawn) add('tactic', 'The game is drawn after this move.');

  // Missed / allowed mate, from engine scores.
  if (inp.before.mate !== undefined && inp.before.mate > 0 && !(after.mate !== undefined && after.mate > 0) && inp.best && !playedBest)
    add('better', `${SIDE(mover)} had a forced mate in ${inp.before.mate}. It starts with ${describeLine(inp.fen, bestPv, 1).replace(/^\S+ /, '')}.`);
  if (!mated && after.mate !== undefined && after.mate < 0 && !(inp.before.mate !== undefined && inp.before.mate < 0))
    add('threat', `This allows mate in ${-after.mate} for ${SIDE(opp)}${inp.replyPv[0] ? `: ${describeLine(post.fen(), inp.replyPv, 1).replace(/^\S+ \S+ /, '')}` : ''}.`);

  // Tactics created by the move.
  if (!mated && !drawn) {
    const fork = isFork(inp.fen, inp.move);
    if (fork && !bad) add('tactic', `The ${NAME[m.piece]} on ${m.to} attacks ${fork.map((s) => `the ${NAME[post.get(s)!.type]} on ${s}`).join(' and ')} at once (a fork).`);
    const pinsBefore = new Set(pinnedPieces(pre, opp));
    const newPins = pinnedPieces(post, opp).filter((s) => !pinsBefore.has(s));
    for (const s of newPins.slice(0, 1)) add('tactic', `${SIDE(opp)}'s ${NAME[post.get(s)!.type]} on ${s} is now pinned to its king, so it cannot legally move off the line.`);
  }

  // Opponent's immediate reply, followed through the engine line so recaptures are counted.
  if (!mated && !drawn && inp.replyPv.length) {
    const r = new Chess(post.fen()).move(uciToMove(inp.replyPv[0]));
    const loose = loosePieces(post, mover);
    const mateShown = facts.some((f) => f.kind === 'threat');
    if (mateShown) { /* the forced-mate fact already names this reply */ }
    else if (r.captured || r.san.includes('+') || bad) add('threat', `${SIDE(opp)}'s best reply: ${describeMove(r)}.`);
    else if (loose.length) add('threat', `${SIDE(mover)}'s ${NAME[post.get(loose[0])!.type]} on ${loose[0]} is attacked and not defended.`);
    const ex = exchange(post.fen(), inp.replyPv);
    // Include the played move's own capture in the exchange.
    const gainMover = sum(ex.taken[mover]) + (m.captured ? VALUE[m.captured] : 0) + (m.promotion ? VALUE[m.promotion] - 1 : 0);
    const gainOpp = sum(ex.taken[opp]);
    const allMover = [...(m.captured ? [m.captured] : []), ...ex.taken[mover]];
    if (ex.plies > 0 && (allMover.length || ex.taken[opp].length) && gainMover !== gainOpp) {
      const net = gainMover - gainOpp;
      const parts = [allMover.length ? `${SIDE(mover)} wins ${list(allMover)}` : '', ex.taken[opp].length ? `${SIDE(opp)} wins ${list(ex.taken[opp])}` : ''].filter(Boolean).join(', ');
      add('why', `In the engine line after this move, ${parts}: ${net > 0 ? SIDE(mover) : SIDE(opp)} gains ${Math.abs(net)} point${Math.abs(net) === 1 ? '' : 's'} of material in this line.`);
    } else if (m.captured && !m.promotion && !inp.replyPv.some((move) => move.length === 5) && ex.plies > 0 && gainMover === gainOpp && ex.taken[opp].length) {
      add('why', `In this engine line, both sides capture material of equal value.`);
    }
  }

  // Objective reasons for non-tactical good moves.
  if (!bad && !mated && !drawn) {
    if (m.isKingsideCastle() || m.isQueensideCastle()) add('why', `Castling tucks the king away from the centre and brings the rook toward the middle.`);
    else if ((m.piece === 'n' || m.piece === 'b') && m.from[1] === (mover === 'w' ? '1' : '8') && pre.moveNumber() <= 12)
      add('why', `It develops the ${NAME[m.piece]} off the back rank, an early-game goal.`);
    const cc0 = centerControl(pre, mover), cc1 = centerControl(post, mover);
    if (cc1 > cc0) add('why', `${SIDE(mover)} now controls ${cc1} of the 4 centre squares (d4, e4, d5, e5), up from ${cc0}.`);
  }

  // Better alternative, with a concrete line.
  if (inp.best && !playedBest && !facts.some((f) => f.kind === 'better')) {
    const betterPosition = new Chess(inp.fen);
    const bm = betterPosition.move(uciToMove(inp.best));
    const target = betterPosition.board().flat().find((piece) => piece && piece.color === opp && piece.type === 'q' && betterPosition.attackers(piece.square, mover).includes(bm.to));
    add('better', `Better: ${describeMove(bm)}${target ? `, attacking the queen on ${target.square}` : ''}.`);
    const fork = isFork(inp.fen, inp.best);
    if (fork) { const x = new Chess(inp.fen); x.move(uciToMove(inp.best)); add('tactic', `That move would attack ${fork.map((s) => `the ${NAME[x.get(s)!.type]} on ${s}`).join(' and ')} at once (a fork).`); }
    const bex = exchange(inp.fen, bestPv);
    const bg = sum(bex.taken[mover]) - sum(bex.taken[opp]);
    if (bex.plies > 1 && bg > 0) add('why', `In the engine's line after the better move, ${SIDE(mover)} wins ${list(bex.taken[mover])}${bex.taken[opp].length ? ` for ${list(bex.taken[opp])}` : ''}.`);
  }

  if (!mated && !drawn) add('eval', `Engine evaluation: ${scoreText(inp.before, mover)} before, ${scoreText(after, mover)} after.`);
  if (bad && !facts.some((f) => f.kind === 'tactic' || f.kind === 'threat' || (f.kind === 'why'))) {
    add('fallback', `No simple tactic explains this one; the engine prefers another plan. Step through its line to compare.`);
  }

  const headline = `${QUALITY_HEAD[quality]}: ${pre.moveNumber()}${mover === 'w' ? '.' : '...'} ${m.san}`;
  return { quality, headline, facts, bestLine: playedBest ? [] : bestPv, replyLine: mated || drawn ? [] : inp.replyPv };
}

/** Deterministic choice of up to 3 facts for the compact panel (used immediately and as fallback). */
export function defaultPick(fb: Feedback): Fact[] {
  const bad = fb.quality === 'inaccuracy' || fb.quality === 'mistake' || fb.quality === 'blunder';
  // For sound moves the reason matters more than a marginal alternative (still playable via the line buttons).
  const order: FactKind[] = bad ? ['threat', 'tactic', 'better', 'why', 'fallback'] : ['tactic', 'why', 'threat', 'better'];
  const what = fb.facts.find((f) => f.kind === 'what')!;
  const rest = order.flatMap((k) => fb.facts.filter((f) => f.kind === k));
  const result = [what, ...rest].slice(0, 3);
  const better = bad ? fb.facts.find((f) => f.kind === 'better') : undefined;
  if (better && !result.some((f) => f.id === better.id)) {
    if (result.length >= 3) result.pop();
    result.push(better);
  }
  return result;
}

// ---- model output validation ------------------------------------------------------------------

const SQ = /\b[a-h][1-8]\b/g;
const SAN = /\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|[a-h][1-8](?==)|O-O(?:-O)?)/g;
const NUM = /\d+(?:\.\d+)?/g;
const WORDS = /\b(king|queen|rook|bishop|knight|pawn|white|black|mate|checkmate|stalemate|check|draw|drawn|win|wins|winning|won|lose|loses|losing|lost|forced|fork|pin|pinned|skewer|hanging|free|trap|trapped|sacrifice|blunder|mistake|best|attack|attacks|defended|undefended|promote|promotes|castle|castles|centre|center|material|ahead|behind)s?\b/gi;
const set = (s: string, re: RegExp) => new Set((s.match(re) ?? []).map((x) => x.toLowerCase().replace(/s$/, '')));

/** A rephrasing is accepted only if it introduces no square, SAN, number or chess claim word absent from the source fact. */
export function validRewrite(source: string, text: unknown): text is string {
  if (typeof text !== 'string' || text.length < 8 || text.length > 180 || /[<>\n\r`{}]/.test(text)) return false;
  for (const re of [SQ, SAN, NUM, WORDS]) {
    const src = set(source, re);
    for (const t of set(text, re)) if (!src.has(t)) return false;
  }
  // Negation flips meaning ("not defended" -> "defended") — reject if negation count differs.
  const neg = (s: string) => (s.match(/\b(not|no|never|cannot|can't|isn't|doesn't|without)\b/gi) ?? []).length;
  return neg(source) === neg(text);
}

/** Validates model JSON against server facts. Returns null if nothing usable, so callers use defaultPick. */
export function validateModelOutput(raw: unknown, facts: Fact[]): Fact[] | null {
  let obj: any = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { return null; } }
  if (!obj || !Array.isArray(obj.items)) return null;
  const byId = new Map(facts.map((f) => [f.id, f]));
  const out: Fact[] = []; const seen = new Set<string>();
  for (const it of obj.items.slice(0, 3)) {
    if (!it || typeof it.id !== 'string' || seen.has(it.id) || !byId.has(it.id)) continue;
    const f = byId.get(it.id)!; seen.add(it.id);
    // Model ranks facts; display only the original verified wording.
    out.push(f);
  }
  if (!out.length) return null;
  // The panel always starts with what happened, from verified facts.
  const what = facts.find((f) => f.kind === 'what')!;
  if (!seen.has(what.id)) { out.unshift(what); out.length = Math.min(out.length, 3); }
  const better = facts.find((f) => f.kind === 'better');
  if (better && !out.some((f) => f.id === better.id)) {
    if (out.length >= 3) out.pop();
    out.push(better);
  }
  return out;
}

export const SYSTEM_PROMPT = 'You coach a chess beginner rated about 900. You receive numbered facts that were computed and verified by a chess program. Pick the 2 or 3 facts that best explain the move, in teaching order: what happened, the most urgent threat or tactic, then the better alternative or reason. Copy each selected fact exactly as provided. Do not add or change any words or claims. Reply with JSON only: {"items":[{"id":"f1","text":"..."}]}';

export function userPrompt(fb: Feedback): string {
  return `Move quality: ${fb.quality}.\nFacts:\n${fb.facts.map((f) => `${f.id} [${f.kind}]: ${f.text}`).join('\n')}`;
}

export const RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'feedback', strict: true,
    schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } } } } },
  },
};
