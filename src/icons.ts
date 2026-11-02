const svg = (body: string, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${body}</svg>`;
const s = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';

export const ICON = {
  source: svg(`<circle ${s} cx="12" cy="12" r="9"/><path ${s} d="M12 11v5M12 8h.01"/>`),
  newGame: svg(`<path ${s} d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/>`),
  flag: svg(`<path ${s} d="M5 21V4m0 0h11l-2 4 2 4H5"/>`),
  first: svg(`<path ${s} d="M6 5v14M18 6l-7 6 7 6"/>`),
  prev: svg(`<path ${s} d="M15 6l-6 6 6 6"/>`),
  next: svg(`<path ${s} d="M9 6l6 6-6 6"/>`),
  last: svg(`<path ${s} d="M18 5v14M6 6l7 6-7 6"/>`),
  review: svg(`<circle ${s} cx="10.5" cy="10.5" r="6"/><path ${s} d="M15 15l5 5"/>`),
  history: svg(`<path ${s} d="M4 12a8 8 0 1 0 2.4-5.7M4 5v4h4M12 8v4l3 2"/>`),
  ret: svg(`<path ${s} d="M9 14l-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-3"/>`),
  close: svg(`<path ${s} d="M6 6l12 12M18 6L6 18"/>`),
  back: svg(`<path ${s} d="M19 12H5m0 0l6-6m-6 6l6 6"/>`),
  soundOn: svg(`<path ${s} d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>`),
  soundOff: svg(`<path ${s} d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/>`),
  star: svg(`<path ${s} d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>`),
  undo: svg(`<path ${s} d="M9 14l-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-3"/>`),
  clock: svg(`<circle ${s} cx="12" cy="12" r="9"/><path ${s} d="M12 7v5l3 2"/>`),
  flip: svg(`<path ${s} d="M7 4v16m0 0l-3-3m3 3l3-3M17 20V4m0 0l-3 3m3-3l3 3"/>`),
  win: svg(`<path ${s} d="M7 4h10v5a5 5 0 0 1-10 0zM12 14v4M8 20h8M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/>`),
  loss: svg(`<circle ${s} cx="12" cy="12" r="9"/><path ${s} d="M8 16.5c2.4-2 5.6-2 8 0M9 9.5h.01M15 9.5h.01"/>`),
  draw: svg(`<circle ${s} cx="12" cy="12" r="9"/><path ${s} d="M8 15h8M9 9.5h.01M15 9.5h.01"/>`),
  // quality badges
  best: svg(`<circle cx="12" cy="12" r="11" fill="#2e9d5b"/><path d="M12 5l2 4.3 4.7.6-3.4 3.2.9 4.7L12 15.5 7.8 17.8l.9-4.7L5.3 9.9l4.7-.6z" fill="#fff"/>`),
  good: svg(`<circle cx="12" cy="12" r="11" fill="#6aa86a"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`),
  inaccuracy: svg(`<circle cx="12" cy="12" r="11" fill="#e2b33a"/><circle cx="12" cy="12" r="3.2" fill="#fff"/>`),
  mistake: svg(`<circle cx="12" cy="12" r="11" fill="#e07b2a"/><path d="M12 6v7" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.7" fill="#fff"/>`),
  blunder: svg(`<circle cx="12" cy="12" r="11" fill="#d23c3c"/><path d="M8.5 6v7M15.5 6v7" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="8.5" cy="17.3" r="1.7" fill="#fff"/><circle cx="15.5" cy="17.3" r="1.7" fill="#fff"/>`),
  // motifs
  fork: svg(`<circle cx="12" cy="12" r="11" fill="#7a4fd0"/><path d="M12 19v-6M12 13L7 7M12 13l5-6M7 7v0M17 7v0" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`),
  hanging: svg(`<circle cx="12" cy="12" r="11" fill="#d23c3c"/><path d="M12 5c3 4 5 6.5 5 9a5 5 0 0 1-10 0c0-2.5 2-5 5-9z" fill="#fff"/>`),
  mate: svg(`<circle cx="12" cy="12" r="11" fill="#1f6fd1"/><path d="M5.5 16l1-8 3.5 3.5L12 6l2 5.5L17.5 8l1 8z" fill="#fff"/>`),
  mateBad: svg(`<circle cx="12" cy="12" r="11" fill="#222"/><path d="M5.5 16l1-8 3.5 3.5L12 6l2 5.5L17.5 8l1 8z" fill="#ff6b6b"/>`),
};

export const QUALITY_COLOR: Record<string, string> = {
  best: '#2e9d5b', good: '#6aa86a', inaccuracy: '#e2b33a', mistake: '#e07b2a', blunder: '#d23c3c',
};
