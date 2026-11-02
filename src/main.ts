import './style.css';
import { Chess, type Color, type Square, type Move } from 'chess.js';
import { Engine, Cancelled } from './engine';
import { ICON, QUALITY_COLOR } from './icons';
import { pickBotMove, reviewGame, winPct, fmtScore, pvSan, sanOf, type PlyReview, type PositionEval, type Score, uciToMove } from './analysis';
import { type Clock, TIME_CONTROLS, startClock, remaining, press, timeoutResult, fmtClock } from './clock';
import { buildFeedback, defaultPick, describeLine, type Feedback, type FeedbackInput } from './facts';
import { requestFeedback, cancelFeedback, cached, feedbackKey, stats as feedbackStats } from './feedback';
import { play, unlockAudio, isMuted, setMuted, soundState, type SoundName } from './sound';
import { Connection, createRoom, joinRoom, roomFromHash, inviteUrl, seatFor } from './online';

const GLYPH: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const NAME: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const FILES = 'abcdefgh';
const STORE = 'chess-minimal.v1';
const HISTORY = 'chess-minimal.history.v1';
const TC_PREF = 'chess-minimal.tc.v1';
const BOT_DEPTH = 8;
const REVIEW_DEPTH = 12;
// Keep a hard per-position time budget on slow phones while retaining a depth ceiling.
const REVIEW_MOVETIME_MS = 600;

type Mode = 'play' | 'over' | 'review';
type Result = { winner: Color | null; how: string };
/** A finished game as stored in this browser's history. */
interface GameRecord { id: string; moves: string[]; player: Color; result: Result; tc: number | null; endedAt: number; evals?: PositionEval[] }

const st = {
  game: new Chess(),
  id: '',
  player: 'w' as Color,
  mode: 'play' as Mode,
  selected: null as Square | null,
  promo: null as { from: Square; to: Square } | null,
  choosing: false,
  showHistory: false,
  thinking: false,
  resigned: null as Color | null,
  flagged: null as Color | null,
  tc: null as number | null,
  clock: null as Clock | null,
  tcChoice: 3 as number | null,
  // review of a stored game
  rec: null as GameRecord | null,
  review: null as PlyReview[] | null,
  evals: null as PositionEval[] | null,
  progress: 0,
  idx: -1,
  // exploration from a reviewed position; never written to the record
  explore: null as { base: number; moves: string[]; line?: string[] } | null,
  exEval: null as { fen: string; e: PositionEval } | null,
  exToken: 0,
  showBest: true,
  // invite-link game against another person; null for bot games
  online: null as Connection | null,
  onlineErr: '',
  vsFriend: false,
};

function moveSound(move: Move | null, position: Chess) {
  if (!move) return;
  const sound: SoundName = position.inCheck() ? 'check' : move.promotion ? 'promote' : move.isCapture() || move.isEnPassant() ? 'capture' : move.isKingsideCastle() || move.isQueensideCastle() ? 'castle' : 'move';
  play(sound);
}

let engine: Engine | null = null;
const getEngine = () => (engine ??= new Engine());

const app = document.getElementById('app')!;
const $ = (h: string) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild as HTMLElement; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pieceHtml = (c: Color, t: string) => `<span class="pc ${c}">${GLYPH[t]}\uFE0E</span>`;
const colorName = (c: Color) => (c === 'w' ? 'white' : 'black');
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const lans = (g: Chess) => g.history({ verbose: true }).map((m) => m.lan);

function save() {
  if (st.online) return; // the server owns online games; keep the saved bot game untouched
  localStorage.setItem(STORE, JSON.stringify({ id: st.id, moves: lans(st.game), player: st.player, resigned: st.resigned, flagged: st.flagged, tc: st.tc, clock: st.clock }));
}

function loadHistory(): GameRecord[] {
  try { const h = JSON.parse(localStorage.getItem(HISTORY) ?? '[]'); return Array.isArray(h) ? h : []; } catch { return []; }
}
function saveHistory(h: GameRecord[]) { localStorage.setItem(HISTORY, JSON.stringify(h)); }
/** Adds or updates a record keyed by id, so repeated saves (reload, re-review) never duplicate. */
function archive(rec: GameRecord) {
  const h = loadHistory();
  const i = h.findIndex((r) => r.id === rec.id);
  if (i >= 0) h[i] = { ...h[i], ...rec }; else h.unshift(rec);
  saveHistory(h);
}

/** Stable id for games saved by the previous version (no id field), so migrating twice cannot duplicate. */
function legacyId(moves: string[], player: string, resigned: unknown) {
  let x = 2166136261;
  for (const ch of `${moves.join(' ')}|${player}|${resigned}`) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `legacy-${x.toString(36)}`;
}

function load() {
  const p = localStorage.getItem(TC_PREF);
  if (p !== null) st.tcChoice = p === 'none' ? null : Number(p);
  try {
    const d = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (!d) return;
    const g = new Chess();
    for (const m of d.moves) g.move(uciToMove(m));
    st.game = g; st.player = d.player === 'b' ? 'b' : 'w'; st.resigned = d.resigned ?? null;
    st.flagged = d.flagged ?? null; st.tc = d.tc ?? null; st.clock = d.clock ?? null;
    st.id = d.id ?? legacyId(d.moves, st.player, st.resigned);
    if (!d.id) save();
    if (result()) { st.mode = 'over'; archiveCurrent(); }
  } catch { localStorage.removeItem(STORE); }
}

function sqXY(sq: string, flip: boolean) {
  let f = FILES.indexOf(sq[0]); let r = 8 - Number(sq[1]);
  if (flip) { f = 7 - f; r = 7 - r; }
  return { x: f + 0.5, y: r + 0.5 };
}

function arrow(uci: string, color: string, flip: boolean, width = 0.18) {
  const a = sqXY(uci.slice(0, 2), flip), b = sqXY(uci.slice(2, 4), flip);
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
  const head = 0.42, ex = b.x - ux * head, ey = b.y - uy * head, px = -uy, py = ux;
  return `<line x1="${a.x}" y1="${a.y}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" opacity=".85"/>
    <polygon points="${b.x},${b.y} ${ex + px * 0.3},${ey + py * 0.3} ${ex - px * 0.3},${ey - py * 0.3}" fill="${color}" opacity=".85"/>`;
}

function positionResult(g: Chess): Result | null {
  if (g.isCheckmate()) return { winner: g.turn() === 'w' ? 'b' : 'w', how: 'checkmate' };
  if (g.isStalemate()) return { winner: null, how: 'stalemate' };
  if (g.isThreefoldRepetition()) return { winner: null, how: 'threefold repetition' };
  if (g.isInsufficientMaterial()) return { winner: null, how: 'insufficient material' };
  if (g.isDraw()) return { winner: null, how: 'fifty-move rule' };
  return null;
}

function result(): Result | null {
  if (st.online) return st.online.view?.result ?? null;
  if (st.resigned) return { winner: st.resigned === 'w' ? 'b' : 'w', how: 'resignation' };
  if (st.flagged) return timeoutResult(st.game, st.flagged);
  return positionResult(st.game);
}

function archiveCurrent() {
  const r = result();
  if (!r || !st.id) return;
  const existing = loadHistory().find((x) => x.id === st.id);
  archive({ id: st.id, moves: lans(st.game), player: st.player, result: r, tc: st.tc, endedAt: existing?.endedAt ?? Date.now() });
}

const recMoves = () => (st.rec ? st.rec.moves : []);

/** Board position: live game, reviewed ply, or explored line. */
function shownPosition(): { pos: Chess; last: Move | null } {
  if (st.mode !== 'review' || !st.rec) {
    const hist = st.game.history({ verbose: true });
    return { pos: st.game, last: hist[hist.length - 1] ?? null };
  }
  const pos = new Chess();
  let last: Move | null = null;
  const base = st.explore ? st.explore.base : st.idx;
  const mv = recMoves();
  for (let i = 0; i <= base; i++) last = pos.move(uciToMove(mv[i]));
  for (const u of st.explore?.moves ?? []) last = pos.move(uciToMove(u));
  return { pos, last };
}

/** Score from White's view for the eval bar. */
function whiteView(e: PositionEval | undefined, turn: Color): Score {
  if (!e) return { cp: 0 };
  if (e.terminal === 'mate') return { mate: turn === 'w' ? -1 : 1 };
  if (e.terminal === 'draw') return { cp: 0 };
  return turn === 'w' ? e.score : { mate: e.score.mate !== undefined ? -e.score.mate : undefined, cp: e.score.cp !== undefined ? -e.score.cp : undefined };
}

function clockEl(side: Color) {
  const turn = st.game.turn();
  const o = st.online;
  const running = o ? o.view?.running === side : st.mode === 'play' && !result() && st.clock!.since !== null && turn === side;
  const ms = clockMs(side);
  const you = o ? o.view?.you : st.player;
  const who = side === you ? 'You' : o ? (you ? 'Opponent' : colorName(side)[0].toUpperCase() + colorName(side).slice(1)) : 'Bot';
  const away = o?.view && o.view.seats[side] && !o.view.online[side] ? ' <small>offline</small>' : '';
  return $(`<div class="clock ${running ? 'on' : ''} ${ms < 10_000 ? 'low' : ''}" data-side="${side}" role="timer" aria-label="${who} (${colorName(side)}) clock"><span class="who"><span class="dotc ${side}"></span>${who}${o ? away : side === st.player ? '' : ' <small>≈900</small>'}</span><span class="t">${fmtClock(ms)}</span></div>`);
}

const clockMs = (side: Color) => (st.online ? st.online.clockMs(side) : remaining(st.clock!, side, st.game.turn(), Date.now()));

/** Win percentage and label for the eval bar, both from White's point of view. */
function evalInfo(e: PositionEval | undefined, turn: Color): { pct: number; label: string } {
  if (e?.terminal === 'mate') return turn === 'w' ? { pct: 0, label: '0-1' } : { pct: 100, label: '1-0' };
  if (e?.terminal === 'draw') return { pct: 50, label: '½-½' };
  const s = whiteView(e, turn);
  const label = s.mate !== undefined ? `${s.mate < 0 ? '-' : ''}M${Math.abs(s.mate)}` : (() => { const v = (s.cp ?? 0) / 100; return `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(2)}`; })();
  return { pct: winPct(s), label };
}

function soundBtn() {
  const m = isMuted();
  const b = $(`<button class="icon" title="${m ? 'Sound off' : 'Sound on'}" aria-label="${m ? 'Unmute sounds' : 'Mute sounds'}" aria-pressed="${m}" data-sound="${m ? 'off' : 'on'}">${m ? ICON.soundOff : ICON.soundOn}</button>`);
  b.onclick = () => { setMuted(!m); unlockAudio(); render(); if (m) play('select'); };
  return b;
}
const sourceLink = () => $(`<a class="icon" href="https://github.com/nmrugg/stockfish.js/tree/v19.0.1" target="_blank" rel="noopener noreferrer" title="Engine: Stockfish 19 (GPL) — source and licence" aria-label="Stockfish source and licence">${ICON.source}</a>`);

function render() {
  const reviewing = st.mode === 'review' && st.rec;
  const flip = (reviewing ? st.rec!.player : st.player) === 'b';
  const { pos, last } = shownPosition();
  const wrap = $(`<div class="wrap ${reviewing ? 'review' : 'playing'}"></div>`);

  // top bar
  const top = $(`<header class="bar top"></header>`);
  if (reviewing) {
    const back = $(`<button class="icon flat" title="Close review" aria-label="Close review">${ICON.back}</button>`);
    back.onclick = closeReview;
    top.append(back, $(`<h1>Move analysis</h1>`), soundBtn(), sourceLink());
  } else {
    if (st.online) {
      const inv = $(`<button class="icon" title="Copy invite link" aria-label="Copy invite link">${ICON.share}</button>`);
      inv.onclick = () => shareInvite();
      top.append(inv);
    }
    const newBtn = $(`<button class="icon" title="New game" aria-label="New game">${ICON.newGame}</button>`);
    newBtn.onclick = () => { st.choosing = true; st.showHistory = false; render(); };
    top.append(newBtn);
    if (st.mode === 'play') {
      const resign = $(`<button class="icon" title="Resign" aria-label="Resign">${ICON.flag}</button>`) as HTMLButtonElement;
      resign.disabled = st.game.history().length < 1;
      resign.onclick = () => { if (st.online) st.online.send({ t: 'resign' }); else { st.resigned = st.player; endGame(); } };
      if (st.online && !st.online.view?.you) resign.disabled = true;
      top.append(resign);
    }
    if (st.mode === 'over') {
      const rv = $(`<button class="icon" title="Review game" aria-label="Review game">${ICON.review}</button>`);
      rv.onclick = () => reviewCurrent();
      top.append(rv);
    }
    // History is reachable whenever no clock is running for an in-progress game.
    if (st.mode !== 'play' || st.game.history().length === 0 || !st.tc) {
      const hb = $(`<button class="icon" title="Game history" aria-label="Game history">${ICON.history}</button>`);
      hb.onclick = () => { st.showHistory = true; st.choosing = false; render(); };
      top.append(hb);
    }
    top.append($(`<div class="spacer"></div>`), soundBtn(), sourceLink());
    top.append($(`<div class="thinking ${st.thinking ? 'on' : ''}" role="status" aria-label="${st.thinking ? 'Bot is thinking' : 'Idle'}"></div>`));
  }
  wrap.append(top);

  // horizontal eval bar (review only, from White's point of view)
  if (reviewing && st.evals) {
    const e = st.explore ? (st.exEval?.fen === pos.fen() ? st.exEval.e : undefined) : st.evals[st.idx + 1];
    const { pct, label } = evalInfo(e, pos.turn());
    const ahead = pct >= 50 ? 'w' : 'b';
    wrap.append($(`<div class="evalbar" role="meter" aria-label="Evaluation ${label}, White win chance ${Math.round(pct)} percent" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><div class="w" style="width:${pct}%"></div><span class="lbl ${ahead}">${label}</span></div>`));
  }

  const showClocks = !reviewing && st.tc && (st.clock || st.online?.view);
  if (showClocks) { wrap.classList.add('clocked'); wrap.append(clockEl(st.player === 'w' ? 'b' : 'w')); }

  // board
  const board = $(`<div class="board" role="grid" aria-label="Chess board"></div>`);
  const rev = reviewing && !st.explore && st.review && st.idx >= 0 ? st.review[st.idx] : null;
  const marks = new Map<string, string[]>();
  const addMark = (sq: string, cls: string) => marks.set(sq, [...(marks.get(sq) ?? []), cls]);
  let arrows = '';
  const badges = new Map<string, string[]>();
  const addBadge = (sq: string, icon: string, label: string) => badges.set(sq, [...(badges.get(sq) ?? []), `<span class="badge${badges.has(sq) ? ' l2' : ''}" title="${label}">${icon}</span>`]);
  if (rev) {
    const to = rev.uci.slice(2, 4);
    addMark(to, `q-${rev.quality}`);
    addBadge(to, ICON[rev.quality], `${rev.san}: ${rev.quality}`);
    if (st.showBest && rev.best && rev.best !== rev.uci) arrows += arrow(rev.best, '#418c9a', flip, 0.2);
    arrows += arrow(rev.uci, QUALITY_COLOR[rev.quality], flip, 0.14);
    for (const m of rev.motifs) {
      if (m.kind === 'fork') {
        m.targets.forEach((t) => addMark(t, 'hl-fork'));
        if (m.by !== 'played') arrows += arrow(m.move, m.by === 'missed' ? '#7a4fd0' : '#b03aa0', flip, 0.12);
        addBadge(m.move.slice(2, 4), ICON.fork, m.by === 'played' ? 'Fork' : m.by === 'missed' ? 'Missed fork' : 'Allows a fork');
      } else if (m.kind === 'hanging') {
        addMark(m.square, 'hl-red');
        arrows += arrow(m.capture, '#d23c3c', flip, 0.12);
        addBadge(m.square, ICON.hanging, 'Piece left hanging');
      } else if (m.kind === 'missedMate') {
        arrows += arrow(m.move, '#1f6fd1', flip, 0.2);
        addBadge(m.move.slice(2, 4), ICON.mate, `Missed mate in ${m.mateIn}`);
      } else if (m.kind === 'allowedMate') {
        arrows += arrow(m.move, '#222', flip, 0.12);
        addBadge(m.move.slice(2, 4), ICON.mateBad, `Allows mate in ${m.mateIn}`);
      }
    }
  }
  if (reviewing && st.showBest && st.explore && st.exEval?.fen === pos.fen() && st.exEval.e.best) arrows += arrow(st.exEval.e.best, '#418c9a', flip, 0.2);
  const canExplore = reviewing && !!st.review;
  const legal = st.selected && (st.mode === 'play' || canExplore) ? pos.moves({ square: st.selected, verbose: true }) : [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const file = flip ? 7 - f : f, rank = flip ? r + 1 : 8 - r;
    const sq = `${FILES[file]}${rank}` as Square;
    const p = pos.get(sq);
    const cls = ['sq', (file + rank) % 2 === 1 ? 'l' : 'd'];
    if (last && (last.from === sq || last.to === sq)) cls.push('last');
    if (st.selected === sq) cls.push('sel');
    const lm = legal.find((m) => m.to === sq);
    if (lm) cls.push(p || lm.isEnPassant() ? 'cap' : 'dot');
    if (p?.type === 'k' && p.color === pos.turn() && pos.inCheck()) cls.push('check');
    cls.push(...(marks.get(sq) ?? []));
    const label = `${sq}${p ? `, ${colorName(p.color)} ${NAME[p.type]}` : ''}`;
    const coords = `${f === 0 ? `<span class="co r" aria-hidden="true">${rank}</span>` : ''}${r === 7 ? `<span class="co f" aria-hidden="true">${FILES[file]}</span>` : ''}`;
    const el = $(`<button class="${cls.join(' ')}" data-sq="${sq}" aria-label="${label}">${coords}${p ? pieceHtml(p.color, p.type) : ''}${(badges.get(sq) ?? []).join('')}</button>`);
    el.onclick = () => onSquare(sq);
    board.append(el);
  }
  if (arrows) board.append($(`<svg class="arrows" viewBox="0 0 8 8">${arrows}</svg>`));
  if (st.promo) board.append(promoOverlay(pos.turn()));
  if (st.showHistory) board.append(historyOverlay());
  else if (st.choosing) board.append(chooseOverlay());
  else if (st.mode === 'over') board.append(endOverlay());
  else if (st.online) { const w = onlineOverlay(); if (w) board.append(w); }
  wrap.append(board);
  if (reviewing && st.review) wrap.append(coachCard(pos));
  if (showClocks) wrap.append(clockEl(st.player));
  if (!reviewing) wrap.append($(`<p class="status" aria-live="polite">${esc(statusText())}</p>`));

  // review controls
  if (reviewing) {
    if (!st.review) {
      wrap.append($(`<div class="progress" role="progressbar" aria-label="Analysing game" aria-valuenow="${Math.round(st.progress * 100)}"><div style="width:${st.progress * 100}%"></div></div>`));
      wrap.append($(`<p class="status">Stockfish is analysing the game… ${Math.round(st.progress * 100)}%</p>`));
    } else {
      const n = st.review.length;
      const mk = (icon: string, label: string, text: string, fn: () => void, dis: boolean, cls = 'act') => {
        const b = $(`<button class="${cls}" title="${label}" aria-label="${label}">${icon}${text ? `<span>${text}</span>` : ''}</button>`) as HTMLButtonElement;
        b.disabled = dis; b.onclick = () => { fn(); render(); };
        return b;
      };
      const go = (i: number) => () => { leaveExplore(); st.idx = i; stepSound(); };
      const movenav = $(`<div class="movenav"></div>`);
      const strip = $(`<div class="strip" role="list" aria-label="Moves"></div>`);
      st.review.forEach((p, i) => {
        if (p.color === 'w' || i === 0) strip.append($(`<span class="no" aria-hidden="true">${Math.floor(i / 2) + 1}.${p.color === 'b' ? '..' : ''}</span>`));
        const label = `${Math.floor(i / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san}, ${p.quality}${p.motifs.map((m) => `, ${m.kind}`).join('')}`;
        const cur = st.explore ? i === st.explore.base : i === st.idx;
        const showQ = p.quality !== 'good';
        const b = $(`<button role="listitem" class="mv ${p.color} q-${p.quality} ${cur ? 'cur' : ''}" title="${label}" aria-label="${label}" ${cur ? 'aria-current="true"' : ''}>${showQ ? `<span class="qi">${ICON[p.quality]}</span>` : ''}<span class="san">${esc(p.san)}</span></button>`);
        b.onclick = () => { leaveExplore(); st.idx = i; stepSound(); render(); };
        strip.append(b);
      });
      movenav.append(mk(ICON.first, 'Start', '', go(-1), !st.explore && st.idx < 0, 'icon flat'), strip, mk(ICON.last, 'Last move', '', go(n - 1), !st.explore && st.idx >= n - 1, 'icon flat'));
      wrap.append(movenav);
      const actions = $(`<div class="actions"></div>`);
      const best = mk(ICON.star, 'Show best move', 'Best', () => { st.showBest = !st.showBest; }, false);
      best.setAttribute('aria-pressed', String(st.showBest));
      if (st.explore) {
        const ex = st.explore, ln = ex.line;
        const onLine = !!ln && ex.moves.length < ln.length && ex.moves.every((u, k) => u === ln[k]);
        actions.append(mk(ICON.undo, 'Undo explored move', 'Undo', exploreBack, false), best);
        if (onLine) actions.append(mk(ICON.next, 'Next move in line', 'Line', () => { ex.moves.push(ln![ex.moves.length]); stepSound(); analyseExplore(); }, false));
        actions.append(mk('', 'Return to game', 'Return', leaveExplore, false, 'next'));
      } else {
        actions.append(mk(ICON.prev, 'Previous move', 'Back', go(st.idx - 1), st.idx < 0), best, mk('', 'Next move', st.idx >= n - 1 ? 'End of game' : 'Next', go(st.idx + 1), st.idx >= n - 1, 'next'));
      }
      wrap.append(actions);
    }
  }
  // The rebuilt strip starts at scrollLeft 0; restore the old offset instantly, then glide only from there,
  // otherwise `scroll-behavior: smooth` replays a scroll from move 1 on every render.
  const prevScroll = app.querySelector('.strip')?.scrollLeft;
  app.replaceChildren(wrap);
  fitReviewBoard();
  const cur = wrap.querySelector<HTMLElement>('.strip .cur');
  const strip = cur?.parentElement;
  if (cur && strip) {
    const target = cur.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2;
    if (prevScroll !== undefined) strip.scrollTo({ left: prevScroll, behavior: 'instant' });
    strip.scrollTo({ left: target, behavior: prevScroll === undefined ? 'instant' : 'smooth' });
  }
}

/** On phones, sizes the review board to the space left after the coach panel and controls, so nothing scrolls. */
function fitReviewBoard() {
  const wrap = app.querySelector<HTMLElement>('.wrap.review');
  if (!wrap || innerWidth >= 900) return;
  wrap.style.removeProperty('--size');
  const board = wrap.querySelector<HTMLElement>('.board')!;
  const kids = [...wrap.children] as HTMLElement[];
  const others = kids.filter((e) => e !== board).reduce((a, e) => a + e.getBoundingClientRect().height, 0);
  const gaps = (parseFloat(getComputedStyle(wrap).rowGap) || 0) * (kids.length - 1);
  const outside = document.documentElement.scrollHeight - wrap.getBoundingClientRect().height;
  const size = Math.floor(Math.max(180, Math.min(innerWidth, 640, innerHeight - others - gaps - Math.max(0, outside))));
  wrap.style.setProperty('--size', `${size}px`);
}
addEventListener('resize', fitReviewBoard);

function statusText() {
  if (st.choosing || st.showHistory) return '';
  if (st.online) return onlineStatus();
  const r = result();
  if (r) return r.winner ? `${r.winner === st.player ? 'You win' : 'Bot wins'} by ${r.how}.` : `Draw by ${r.how}.`;
  if (st.thinking) return 'Bot is thinking…';
  if (st.game.turn() === st.player) return st.game.inCheck() ? 'Check! Your move.' : st.game.history().length ? 'Your move.' : `You play ${colorName(st.player)}. Your move.`;
  return 'Bot to move.';
}

/** Sound for the ply now shown in review. */
function stepSound() {
  const { pos, last } = shownPosition();
  if (last) moveSound(last, pos); else play('step');
}

function coachCard(pos: Chess) {
  const card = $(`<section class="coach" aria-label="Coach"></section>`);
  const panel = explainPanel(pos);
  card.append(panel);
  return card;
}

const fbMemo = new Map<string, { input: FeedbackInput; fb: Feedback }>();
/** Deterministic feedback for reviewed ply `i` (memoised; recomputed only when the game or evals change). */
function plyFeedback(i: number) {
  const id = `${st.rec!.id}|${i}|${st.evals!.length}`;
  const hit = fbMemo.get(id);
  if (hit) return hit;
  const c = new Chess(); const mv = recMoves();
  for (let k = 0; k < i; k++) c.move(uciToMove(mv[k]));
  const e0 = st.evals![i], e1 = st.evals![i + 1];
  const input: FeedbackInput = { fen: c.fen(), move: mv[i], best: e0.best, bestPv: e0.pv ?? [], replyPv: e1?.terminal ? [] : e1?.pv ?? [], before: e0.score, afterRaw: e1?.terminal ? null : e1?.score ?? null };
  const r = { input, fb: buildFeedback(input) };
  fbMemo.set(id, r);
  return r;
}

function explainPanel(pos: Chess) {
  const panel = $(`<div class="explain" aria-live="polite"></div>`);
  const add = (t: string, cls = '') => { const p = $(`<p class="${cls}">${esc(t)}</p>`); panel.append(p); return p; };
  const head = (t: string, icon = '', score = '') => panel.append($(`<p class="head">${icon ? `<span class="hi">${icon}</span>` : ''}<span class="ht">${esc(t)}</span>${score ? `<span class="pill">${esc(score)}</span>` : ''}</p>`));
  if (st.explore) {
    const mv = recMoves();
    const baseFen = (() => { const c = new Chess(); for (let i = 0; i <= st.explore!.base; i++) c.move(uciToMove(mv[i])); return c.fen(); })();
    const ready = st.exEval?.fen === pos.fen();
    head(`Exploring (saved game unchanged): ${pvSan(baseFen, st.explore.moves, 6)}`, '', ready ? evalInfo(st.exEval!.e, pos.turn()).label : '');
    const end = positionResult(pos);
    if (end) add(end.winner ? `${end.winner === 'w' ? 'White' : 'Black'} wins by ${end.how}.` : `Draw by ${end.how}.`);
    else if (!ready) add('Engine is thinking…', 'dim');
    else {
      const e = st.exEval!.e;
      const side = pos.turn() === 'w' ? 'White' : 'Black';
      add(`Engine: ${fmtScore(e.score)} for ${side} to move.${e.best ? ` Best: ${sanOf(pos.fen(), e.best)}.` : ''}`);
      if (e.pv?.length) add(`Line: ${describeLine(pos.fen(), e.pv, 2)}.`, 'dim');
    }
    return panel;
  }
  if (st.idx < 0 || !st.review || !st.evals) {
    head('Start position', '', st.evals ? evalInfo(st.evals[0], 'w').label : '');
    add('Tap a piece to explore.', 'dim');
    return panel;
  }
  const rev = st.review[st.idx];
  const { input, fb } = plyFeedback(st.idx);
  head(fb.headline, ICON[rev.quality], evalInfo(st.evals[st.idx + 1], pos.turn()).label);
  const worded = cached(input);
  for (const f of worded ?? defaultPick(fb)) add(f.text, `f-${f.kind}`);
  const links = $(`<p class="links"></p>`);
  const link = (label: string, base: number, line: string[]) => {
    const b = $(`<button class="lnk" aria-label="${label}">▶ ${label.replace('Play ', '')}</button>`);
    b.onclick = () => { st.explore = { base, moves: [line[0]], line }; stepSound(); analyseExplore(); };
    links.append(b);
  };
  if (fb.bestLine.length) link('Play best line', st.idx - 1, fb.bestLine);
  if (fb.replyLine.length) link('Play their reply', st.idx, fb.replyLine);
  if (worded) links.append($(`<span class="src" title="Facts computed by chess.js and Stockfish, prioritised by DeepSeek V4.1 Flash">AI-assisted</span>`));
  if (links.childElementCount) panel.append(links);
  requestFeedback(input, fb, (key) => { if (st.mode === 'review' && !st.explore && st.review && st.idx >= 0 && feedbackKey(plyFeedback(st.idx).input) === key) render(); });
  return panel;
}

function promoOverlay(color: Color) {
  const o = $(`<div class="overlay"><div class="panel promo" role="dialog" aria-label="Choose promotion piece"></div></div>`);
  for (const t of ['q', 'r', 'b', 'n']) {
    const b = $(`<button title="Promote to ${NAME[t]}" aria-label="Promote to ${NAME[t]}">${pieceHtml(color, t)}</button>`);
    b.onclick = (e) => {
      e.stopPropagation(); const { from, to } = st.promo!; st.promo = null;
      if (st.mode === 'review') exploreMove(`${from}${to}${t}`); else playerMove(from, to, t);
    };
    o.firstElementChild!.append(b);
  }
  o.onclick = () => { st.promo = null; render(); };
  return o;
}

function chooseOverlay() {
  const o = $(`<div class="overlay"><div class="panel choose col" role="dialog" aria-label="New game"></div></div>`);
  const tcRow = $(`<div class="tcs" role="radiogroup" aria-label="Minutes per side"></div>`);
  for (const m of [...TIME_CONTROLS, null] as (number | null)[]) {
    const label = m ? `${m} minute${m > 1 ? 's' : ''} per side` : 'No clock';
    const b = $(`<button class="tc ${st.tcChoice === m ? 'on' : ''}" role="radio" aria-checked="${st.tcChoice === m}" title="${label}" aria-label="${label}">${m ? `${m}<small>min</small>` : `∞<small>no clock</small>`}</button>`);
    b.onclick = (e) => { e.stopPropagation(); st.tcChoice = m; localStorage.setItem(TC_PREF, m ? String(m) : 'none'); render(); };
    if (st.vsFriend && m === null) (b as HTMLButtonElement).disabled = true; // online games always have a clock
    tcRow.append(b);
  }
  const sides = $(`<div class="sides"></div>`);
  const opts: [Color | 'r', string, string][] = [['w', 'Play as white', 'White'], ['b', 'Play as black', 'Black'], ['r', 'Random colour', 'Random']];
  for (const [c, label, text] of opts) {
    const b = $(`<button class="side" title="${label}" aria-label="${label}">${c === 'r' ? `<span class="pair">${pieceHtml('w', 'k')}${pieceHtml('b', 'k')}</span>` : pieceHtml(c, 'k')}<small>${text}</small></button>`);
    b.onclick = (e) => {
      e.stopPropagation();
      const side: Color = c === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : c;
      if (st.vsFriend) newOnlineGame(st.tcChoice ?? 10, side); else newGame(side);
    };
    sides.append(b);
  }
  const vs = $(`<div class="tcs" role="radiogroup" aria-label="Opponent"></div>`);
  for (const [friend, label] of [[false, 'Bot'], [true, 'Friend']] as const) {
    const b = $(`<button class="tc vs ${st.vsFriend === friend ? 'on' : ''}" role="radio" aria-checked="${st.vsFriend === friend}" aria-label="Play against ${friend ? 'a friend with an invite link' : 'the bot'}">${label}<small>${friend ? 'invite link' : '≈900'}</small></button>`);
    b.onclick = (e) => { e.stopPropagation(); st.vsFriend = friend; if (friend && st.tcChoice === null) st.tcChoice = 10; render(); };
    vs.append(b);
  }
  const err = st.onlineErr ? $(`<p class="note err" role="alert">${esc(st.onlineErr)}</p>`) : null;
  o.firstElementChild!.append($(`<h2>New game <small>${st.vsFriend ? 'vs a friend' : 'vs bot ≈900'}</small></h2>`), $(`<p class="lab">Opponent</p>`), vs, $(`<p class="lab">${ICON.clock}Time per side</p>`), tcRow, $(`<p class="lab">Play as</p>`), sides);
  if (err) o.firstElementChild!.append(err);
  o.onclick = () => { if (st.game.history().length || st.mode !== 'play') { st.choosing = false; render(); } };
  return o;
}

function historyOverlay() {
  const h = loadHistory();
  const o = $(`<div class="overlay"><div class="panel hist" role="dialog" aria-label="Game history"></div></div>`);
  const p = o.firstElementChild!;
  p.append($(`<h2>${ICON.history}Game history</h2>`), $(`<p class="note">Saved on this device only (${h.length} game${h.length === 1 ? '' : 's'}). Tap a game to review it.</p>`));
  const list = $(`<div class="hlist" role="list"></div>`);
  for (const r of h) {
    const kind = r.result.winner === null ? 'draw' : r.result.winner === r.player ? 'win' : 'loss';
    const d = new Date(r.endedAt);
    const when = `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    const b = $(`<button role="listitem" class="hrow" data-id="${esc(r.id)}" aria-label="${kind} by ${r.result.how}, ${Math.ceil(r.moves.length / 2)} moves, ${when}"><span class="ri ${kind}">${ICON[kind]}</span><span class="hk ${kind}">${kind === 'win' ? 'Won' : kind === 'loss' ? 'Lost' : 'Draw'} · ${esc(r.result.how)} <small>as ${colorName(r.player)}</small></span><span class="dim">${r.tc ? `${r.tc} min · ` : ''}${Math.ceil(r.moves.length / 2)} mv · ${when}</span></button>`);
    b.onclick = (e) => { e.stopPropagation(); openReview(r); };
    list.append(b);
  }
  p.append(list);
  if (!h.length) list.append($(`<p class="note">No finished games yet.</p>`));
  const close = $(`<button class="act" title="Close history" aria-label="Close history">${ICON.close}<span>Close</span></button>`);
  close.onclick = (e) => { e.stopPropagation(); st.showHistory = false; render(); };
  p.append(close);
  o.onclick = () => { st.showHistory = false; render(); };
  return o;
}

function endOverlay() {
  const r = result()!;
  const kind = r.winner === null ? 'draw' : r.winner === st.player ? 'win' : 'loss';
  if (st.online && !st.online.view?.you) {
    const o = $(`<div class="overlay" data-result="${r.winner ?? 'draw'}" data-how="${r.how}"><div class="panel" role="dialog" aria-label="Game over"><p class="endt"><b>${r.winner ? `${colorName(r.winner)} won` : r.how === 'aborted' ? 'Aborted' : 'Draw'}</b><small>by ${r.how}</small></p></div></div>`);
    const ng = $(`<button class="act" title="New game" aria-label="New game">${ICON.newGame}<span>New</span></button>`);
    ng.onclick = (e) => { e.stopPropagation(); st.choosing = true; render(); };
    o.firstElementChild!.append(ng);
    return o;
  }
  const o = $(`<div class="overlay" data-result="${kind}" data-how="${r.how}"><div class="panel" role="dialog" aria-label="Game over: ${kind} by ${r.how}"><div class="big ${kind}" title="${kind} by ${r.how}">${ICON[kind]}</div><p class="endt"><b>${kind === 'win' ? 'You won' : kind === 'loss' ? 'You lost' : 'Draw'}</b><small>by ${r.how}</small></p></div></div>`);
  const rv = $(`<button class="next" title="Review game" aria-label="Review game">${ICON.review}<span>Review</span></button>`);
  rv.onclick = (e) => { e.stopPropagation(); reviewCurrent(); };
  if (r.how === 'aborted') rv.hidden = true; // aborted games are not saved to history
  const ng = $(`<button class="act" title="New game" aria-label="New game">${ICON.newGame}<span>New</span></button>`);
  ng.onclick = (e) => { e.stopPropagation(); st.choosing = true; render(); };
  o.firstElementChild!.append(rv, ng);
  return o;
}

function onSquare(sq: Square) {
  if (st.mode === 'review') return onExploreSquare(sq);
  if (st.mode !== 'play' || st.thinking || st.game.turn() !== st.player || st.promo || st.choosing || st.showHistory) return;
  if (st.online && (!st.online.view?.you || !st.online.view.seats.w || !st.online.view.seats.b || st.online.status !== 'open')) return;
  if (checkFlag()) return;
  const p = st.game.get(sq);
  if (st.selected) {
    const mv = st.game.moves({ square: st.selected, verbose: true }).filter((m) => m.to === sq);
    if (mv.length) {
      if (mv.some((m) => m.promotion)) { st.promo = { from: st.selected, to: sq }; st.selected = null; render(); return; }
      return playerMove(st.selected, sq);
    }
  }
  st.selected = p && p.color === st.player && st.selected !== sq ? sq : null;
  render();
}

/** Applies the clock for a move by `mover`. Returns false (and ends the game) if the mover's flag already fell. */
function clockMove(mover: Color): boolean {
  if (st.online || !st.tc || !st.clock) return true;
  const r = press(st.clock, mover, Date.now());
  st.clock = r.clock;
  if (r.flagged) { st.flagged = mover; endGame(); return false; }
  return true;
}

/** Ends the game if the side to move has run out of time. */
function checkFlag(): boolean {
  if (st.online) return false; // the server flags online games
  if (st.mode !== 'play' || !st.tc || !st.clock || st.flagged || result()) return false;
  const turn = st.game.turn();
  if (remaining(st.clock, turn, turn, Date.now()) > 0) return false;
  st.clock = { ...st.clock, [turn]: 0 };
  st.flagged = turn; endGame();
  return true;
}

function playerMove(from: Square, to: Square, promotion?: string) {
  if (st.online) {
    // Optimistic: show the move now; the server's next full position confirms or replaces it.
    const v = st.game.history().length;
    const m = st.game.move({ from, to, promotion });
    st.selected = null;
    st.online.send({ t: 'move', uci: m.lan, v });
    moveSound(m, st.game);
    return render();
  }
  if (!clockMove(st.player)) return;
  const m = st.game.move({ from, to, promotion });
  st.selected = null;
  save();
  if (result()) return endGame();
  moveSound(m, st.game);
  render();
  botMove();
}

async function botMove() {
  if (st.online) return;
  if (st.mode !== 'play' || st.choosing || st.game.turn() === st.player || st.thinking) return;
  if (checkFlag()) return;
  st.thinking = true; render();
  const fen = st.game.fen(), id = st.id;
  const started = performance.now();
  try {
    const res = await getEngine().search(fen, { depth: BOT_DEPTH, multipv: 5 });
    if (st.id !== id || st.game.fen() !== fen || st.mode !== 'play') return;
    const legal = st.game.moves({ verbose: true }).map((m) => m.lan);
    const uci = pickBotMove(res.lines, Math.random, legal) ?? res.bestmove;
    // Vary total thinking time, while limiting the added delay when the bot is short of time.
    const left = st.clock ? remaining(st.clock, st.game.turn(), st.game.turn(), Date.now()) : Infinity;
    const targetMs = 600 + Math.random() * 1900;
    const wait = Math.min(Math.max(0, targetMs - (performance.now() - started)), left / 15);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (st.id !== id || st.game.fen() !== fen || st.mode !== 'play' || !uci) return;
    st.thinking = false;
    if (!clockMove(st.game.turn())) return;
    const m = st.game.move(uciToMove(uci));
    save();
    if (result()) return endGame();
    moveSound(m, st.game);
    render();
  } catch (e) {
    if (!(e instanceof Cancelled)) console.error(e);
  } finally {
    if (st.id === id && st.thinking) { st.thinking = false; render(); }
  }
}

function endGame() {
  st.mode = 'over'; st.thinking = false; st.selected = null; st.promo = null;
  save(); archiveCurrent();
  const r = result();
  play(!r || r.winner === null ? 'draw' : r.winner === st.player ? 'win' : 'loss');
  render();
}

function newGame(color: Color) {
  leaveOnline();
  engine?.cancelAll();
  Object.assign(st, {
    game: new Chess(), id: newId(), player: color, mode: 'play', selected: null, promo: null, choosing: false, showHistory: false, thinking: false,
    resigned: null, flagged: null, tc: st.tcChoice, clock: st.tcChoice ? startClock(st.tcChoice) : null,
    rec: null, review: null, evals: null, progress: 0, idx: -1, explore: null, exEval: null,
  });
  save(); render(); botMove();
}

function reviewCurrent() {
  const rec = loadHistory().find((r) => r.id === st.id);
  if (rec) openReview(rec);
}

function closeReview() {
  leaveExplore();
  engine?.cancelAll(); cancelFeedback();
  Object.assign(st, { rec: null, review: null, evals: null, idx: -1, selected: null, promo: null });
  st.mode = result() ? 'over' : 'play';
  render();
  botMove();
}

async function openReview(rec: GameRecord) {
  engine?.cancelAll();
  Object.assign(st, { mode: 'review', rec, review: null, evals: null, idx: -1, progress: 0, choosing: false, showHistory: false, selected: null, promo: null, explore: null, exEval: null, thinking: false });
  render();
  let evals = rec.evals;
  if (!evals || evals.length !== rec.moves.length + 1) {
    const pos = new Chess();
    const fens = [pos.fen(), ...rec.moves.map((m) => (pos.move(uciToMove(m)), pos.fen()))];
    const out: PositionEval[] = [];
    const eng = getEngine();
    try {
      for (let i = 0; i < fens.length; i++) {
        const c = new Chess(fens[i]);
        if (c.isCheckmate()) out.push({ score: { mate: 0 }, best: null, terminal: 'mate' });
        else if (c.isStalemate() || c.isInsufficientMaterial()) out.push({ score: { cp: 0 }, best: null, terminal: 'draw' });
        else {
          const r = await eng.search(fens[i], { depth: REVIEW_DEPTH, movetime: REVIEW_MOVETIME_MS });
          const l = r.lines[0];
          out.push({ score: { cp: l?.cp, mate: l?.mate }, best: r.bestmove, pv: l?.pv.slice(0, 8) });
        }
        if (st.rec !== rec) return;
        st.progress = (i + 1) / fens.length;
        render();
      }
    } catch (e) {
      if (e instanceof Cancelled) return;
      throw e;
    }
    evals = out;
    archive({ ...rec, evals });
  }
  if (st.rec !== rec) return;
  st.evals = evals;
  st.review = reviewGame(new Chess().fen(), rec.moves, evals);
  st.idx = Math.max(0, st.review.findIndex((p) => p.color === rec.player && p.quality === 'blunder'));
  render();
}

// ---- exploration -------------------------------------------------------------------------------

function onExploreSquare(sq: Square) {
  if (!st.review || st.promo) return;
  const { pos } = shownPosition();
  if (positionResult(pos)) return;
  const p = pos.get(sq);
  if (st.selected) {
    const mv = pos.moves({ square: st.selected, verbose: true }).filter((m) => m.to === sq);
    if (mv.length) {
      if (mv.some((m) => m.promotion)) { st.promo = { from: st.selected, to: sq }; st.selected = null; render(); return; }
      const from = st.selected; st.selected = null;
      return exploreMove(`${from}${sq}`);
    }
  }
  st.selected = p && p.color === pos.turn() && st.selected !== sq ? sq : null;
  render();
}

function exploreMove(uci: string) {
  cancelFeedback();
  if (!st.explore) st.explore = { base: st.idx, moves: [] };
  st.explore.moves.push(uci);
  stepSound();
  analyseExplore();
}

function exploreBack() {
  if (!st.explore) return;
  st.explore.moves.pop();
  if (!st.explore.moves.length) leaveExplore(); else analyseExplore();
}

function leaveExplore() {
  if (!st.explore) return;
  st.explore = null; st.exEval = null; st.selected = null; st.exToken++;
  engine?.cancelAll();
}

async function analyseExplore() {
  const token = ++st.exToken;
  const fen = shownPosition().pos.fen();
  render();
  if (positionResult(new Chess(fen))) return;
  const eng = getEngine();
  eng.cancelAll();
  try {
    const r = await eng.search(fen, { depth: REVIEW_DEPTH });
    if (token !== st.exToken) return; // a newer exploration move superseded this search
    const l = r.lines[0];
    st.exEval = { fen, e: { score: { cp: l?.cp, mate: l?.mate }, best: r.bestmove, pv: l?.pv.slice(0, 8) } };
    render();
  } catch (e) {
    if (!(e instanceof Cancelled)) console.error(e);
  }
}

document.addEventListener('keydown', (e) => {
  if (st.mode !== 'review' || !st.review || st.explore) return;
  const n = st.review.length;
  if (e.key === 'ArrowLeft') st.idx = Math.max(-1, st.idx - 1);
  else if (e.key === 'ArrowRight') st.idx = Math.min(n - 1, st.idx + 1);
  else if (e.key === 'Home') st.idx = -1;
  else if (e.key === 'End') st.idx = n - 1;
  else return;
  stepSound();
  render();
});

// Clock ticker: updates only the clock text (full re-render would disturb taps) and flags expiry.
setInterval(() => {
  if (st.mode !== 'play' || !st.tc || !(st.clock || st.online)) return;
  if (checkFlag()) return;
  document.querySelectorAll<HTMLElement>('.clock').forEach((el) => {
    const side = el.dataset.side as Color;
    const ms = clockMs(side);
    el.querySelector('.t')!.textContent = fmtClock(ms);
    el.classList.toggle('low', ms < 10_000);
  });
}, 100);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkFlag(); });

// Read-only hook for automated browser tests.
(window as any).__chess = {
  fen: () => st.game.fen(), moves: () => st.game.history(), mode: () => st.mode, review: () => st.review,
  clock: () => (st.clock ? { w: remaining(st.clock, 'w', st.game.turn(), Date.now()), b: remaining(st.clock, 'b', st.game.turn(), Date.now()) } : null),
  online: () => (st.online ? { status: st.online.status, view: st.online.view, room: st.online.room } : null), dropSocket: () => st.online?.drop(),
  result: () => result(), sound: () => soundState(), history: () => loadHistory(), shownFen: () => shownPosition().pos.fen(), exEval: () => st.exEval, feedbackStats: () => ({ ...feedbackStats }),
};

// Unlock audio on the first deliberate interactions (autoplay policies, iOS needs a touch/click).
for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) document.addEventListener(ev, () => { if (!soundState().unlocked) unlockAudio(); }, { capture: true, passive: true });

const bootRoom = roomFromHash();
if (bootRoom) enterRoom(bootRoom);
else {
  load();
  if (!localStorage.getItem(STORE)) st.choosing = true;
}
render();
addEventListener('hashchange', () => { const r = roomFromHash(); if (r && r !== st.online?.room) enterRoom(r); });
getEngine().whenReady().then(() => { if (!checkFlag()) botMove(); }).catch((e) => console.error('engine failed', e));

// ---- invite-link games ---------------------------------------------------------------------------

async function newOnlineGame(tc: number, side: Color) {
  st.onlineErr = '';
  try {
    const room = await createRoom(tc, side);
    history.replaceState(null, '', `#room=${room}`);
    enterRoom(room);
  } catch (e) {
    st.onlineErr = (e as Error).message === 'rate' ? 'Too many new games. Wait a minute and try again.' : 'Could not create the game. Check your connection.';
    render();
  }
}

async function enterRoom(room: string) {
  leaveOnline();
  engine?.cancelAll();
  Object.assign(st, {
    game: new Chess(), id: `online-${room}`, player: 'w', mode: 'play', selected: null, promo: null, choosing: false, showHistory: false, thinking: false,
    resigned: null, flagged: null, tc: null, clock: null, rec: null, review: null, evals: null, progress: 0, idx: -1, explore: null, exEval: null, onlineErr: '',
  });
  render();
  try {
    if (!seatFor(room)) await joinRoom(room);
  } catch (e) {
    st.onlineErr = (e as Error).message === 'no room' ? 'This game link has expired or does not exist.' : (e as Error).message === 'rate' ? 'Too many attempts. Wait a minute and try again.' : 'Could not join the game. Check your connection.';
    st.choosing = true; history.replaceState(null, '', location.pathname); render();
    return;
  }
  st.online = new Connection(room, syncOnline);
}

function leaveOnline() {
  if (!st.online) return;
  st.online.close(); st.online = null;
  if (roomFromHash()) history.replaceState(null, '', location.pathname);
}

/** Applies the server's full position. Local optimistic moves are replaced whenever they disagree. */
function syncOnline() {
  const o = st.online; if (!o) return;
  if (o.status === 'gone' && !o.view?.result) { leaveOnline(); st.onlineErr = 'This game has expired.'; st.choosing = true; return render(); }
  const v = o.view;
  if (v) {
    const before = lans(st.game);
    const wasOver = st.mode === 'over';
    if (before.join() !== v.moves.join()) {
      const g = new Chess();
      let last: Move | null = null;
      for (const m of v.moves) last = g.move(uciToMove(m));
      // Sound only for a new opponent move; our own move already played its sound optimistically.
      const extendsLocal = v.moves.length === before.length + 1 && before.every((m, i) => m === v.moves[i]);
      if (extendsLocal && last) moveSound(last, g);
      st.game = g; st.selected = null; st.promo = null;
    }
    st.player = v.you ?? 'w'; st.tc = v.tc;
    if (v.result && !wasOver && st.mode !== 'review') {
      st.mode = 'over'; st.selected = null; st.promo = null;
      if (v.you && v.result.how !== 'aborted') archiveCurrent();
      play(v.result.winner === null ? 'draw' : v.result.winner === v.you ? 'win' : 'loss');
    }
  }
  if (st.mode !== 'review') render();
}

function onlineStatus(): string {
  const o = st.online!, v = o.view;
  if (o.status === 'reconnecting') return 'Connection lost. Reconnecting…';
  if (!v) return 'Connecting…';
  const r = v.result;
  if (r) return r.how === 'aborted' ? 'Game aborted.' : r.winner ? `${v.you ? (r.winner === v.you ? 'You win' : 'Opponent wins') : `${colorName(r.winner)} wins`} by ${r.how}.` : `Draw by ${r.how}.`;
  if (!v.you) return `Watching. ${colorName(st.game.turn())} to move.`;
  if (!v.seats.w || !v.seats.b) return 'Waiting for your friend to open the invite link…';
  if (st.game.turn() === v.you) return st.game.inCheck() ? 'Check! Your move.' : st.game.history().length ? 'Your move.' : `You play ${colorName(v.you)}. Your move.`;
  return 'Opponent to move.';
}

async function shareInvite() {
  const url = inviteUrl(st.online!.room);
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Play chess with me', url });
    else { await navigator.clipboard.writeText(url); st.onlineErr = 'Invite link copied.'; render(); }
  } catch { /* user dismissed the share sheet */ }
}

/** While the second seat is empty: the invite link, ready to copy or share. */
function onlineOverlay() {
  const v = st.online!.view;
  if (!v || !v.you || (v.seats.w && v.seats.b)) return null;
  const url = inviteUrl(st.online!.room);
  const o = $(`<div class="overlay"><div class="panel choose col invite" role="dialog" aria-label="Invite a friend"><h2>Invite a friend</h2><p class="note">Send this link. The first person to open it plays ${colorName(v.you === 'w' ? 'b' : 'w')}.</p><input class="link" readonly aria-label="Invite link" value="${esc(url)}"/></div></div>`);
  const b = $(`<button class="next" aria-label="Share invite link">${ICON.share}<span>${'share' in navigator ? 'Share link' : 'Copy link'}</span></button>`);
  b.onclick = (e) => { e.stopPropagation(); shareInvite(); };
  o.firstElementChild!.append(b);
  if (st.onlineErr) o.firstElementChild!.append($(`<p class="note" role="status">${esc(st.onlineErr)}</p>`));
  o.querySelector('input')!.addEventListener('click', (e) => { e.stopPropagation(); (e.target as HTMLInputElement).select(); });
  return o;
}
