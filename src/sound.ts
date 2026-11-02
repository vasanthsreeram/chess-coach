/**
 * Original synthesized sound effects (Web Audio, no samples). Audio starts only after a user gesture unlocks the
 * context (iOS/autoplay rules); until then, and when muted or unsupported, every call is a silent no-op.
 */
export type SoundName = 'move' | 'capture' | 'check' | 'castle' | 'promote' | 'win' | 'loss' | 'draw' | 'step' | 'select';

const PREF = 'chess-minimal.sound.v1';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = localStorage.getItem(PREF) === 'off';
const played: SoundName[] = [];

function Ctor(): typeof AudioContext | undefined {
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/** Called from user gestures: creates/resumes the context and plays a silent buffer (needed on iOS Safari). */
export function unlockAudio() {
  const C = Ctor();
  if (!C) return;
  try {
    if (!ctx) {
      ctx = new C();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch { ctx = null; }
}

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem(PREF, m ? 'off' : 'on');
}
export const soundState = () => ({ muted, unlocked: ctx?.state === 'running', supported: !!Ctor(), played: [...played] });

let noiseBuf: AudioBuffer | null = null;
function noise(c: AudioContext) {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.25), c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

/** Short filtered noise burst plus a low body: a wooden "tock". */
function knock(c: AudioContext, t: number, pitch: number, vol: number) {
  const n = c.createBufferSource(); n.buffer = noise(c);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = pitch * 6; bp.Q.value = 1.4;
  const ng = c.createGain();
  ng.gain.setValueAtTime(vol, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  n.connect(bp).connect(ng).connect(master!);
  n.start(t); n.stop(t + 0.06);
  const o = c.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(pitch, t); o.frequency.exponentialRampToValueAtTime(pitch * 0.6, t + 0.09);
  const og = c.createGain();
  og.gain.setValueAtTime(vol * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  o.connect(og).connect(master!);
  o.start(t); o.stop(t + 0.11);
}

function tone(c: AudioContext, t: number, freq: number, dur: number, vol: number, type: OscillatorType = 'triangle') {
  const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t); o.stop(t + dur + 0.02);
}

export function play(name: SoundName) {
  if (muted || !ctx || !master || ctx.state !== 'running') return;
  const c = ctx, t = c.currentTime + 0.005;
  played.push(name); if (played.length > 50) played.shift();
  switch (name) {
    case 'move': knock(c, t, 190, 0.7); break;
    case 'select': tone(c, t, 880, 0.05, 0.05, 'sine'); break;
    case 'step': knock(c, t, 260, 0.35); break;
    case 'capture': knock(c, t, 150, 0.9); knock(c, t + 0.045, 230, 0.6); break;
    case 'castle': knock(c, t, 190, 0.65); knock(c, t + 0.09, 210, 0.55); break;
    case 'check': knock(c, t, 190, 0.6); tone(c, t + 0.02, 988, 0.18, 0.12); tone(c, t + 0.1, 1319, 0.22, 0.09); break;
    case 'promote': knock(c, t, 190, 0.6); [784, 988, 1175].forEach((f, i) => tone(c, t + 0.05 + i * 0.06, f, 0.2, 0.08)); break;
    case 'win': [523, 659, 784, 1047].forEach((f, i) => tone(c, t + i * 0.11, f, 0.35, 0.12)); break;
    case 'loss': [440, 349, 294].forEach((f, i) => tone(c, t + i * 0.16, f, 0.4, 0.1, 'sine')); break;
    case 'draw': [523, 523 * 1.26].forEach((f, i) => tone(c, t + i * 0.14, f, 0.4, 0.09, 'sine')); break;
  }
}
