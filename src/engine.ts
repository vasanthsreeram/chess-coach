// UCI wrapper around the bundled single-threaded Stockfish WASM worker.
export interface PvLine { multipv: number; cp?: number; mate?: number; pv: string[] }
export interface SearchResult { bestmove: string | null; lines: PvLine[] }

export class Cancelled extends Error { constructor() { super('cancelled'); } }

export class Engine {
  private worker: Worker;
  private ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private listener: ((line: string) => void) | null = null;

  constructor(url = new URL('engine/stockfish-19-lite-single.js', document.baseURI).href) {
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => this.listener?.(String(e.data));
    this.ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('engine load timeout')), 30000);
      this.worker.onerror = (e) => { clearTimeout(t); reject(e); };
      this.listener = (l) => {
        if (l === 'uciok') this.worker.postMessage('isready');
        if (l === 'readyok') { clearTimeout(t); this.listener = null; resolve(); }
      };
      this.worker.postMessage('uci');
    });
  }

  whenReady() { return this.ready; }

  /** Invalidates queued/running searches; running search is stopped. */
  cancelAll() { this.generation++; this.worker.postMessage('stop'); }

  search(fen: string, opts: { depth?: number; movetime?: number; multipv?: number }): Promise<SearchResult> {
    const gen = this.generation;
    const run = async (): Promise<SearchResult> => {
      await this.ready;
      if (gen !== this.generation) throw new Cancelled();
      await this.sync();
      if (gen !== this.generation) throw new Cancelled();
      return new Promise<SearchResult>((resolve, reject) => {
        const lines = new Map<number, PvLine>();
        this.listener = (l) => {
          if (l.startsWith('info') && l.includes(' pv ')) {
            const mpv = Number(/ multipv (\d+)/.exec(l)?.[1] ?? 1);
            const cp = /score cp (-?\d+)/.exec(l);
            const mate = /score mate (-?\d+)/.exec(l);
            if (/ (lowerbound|upperbound)/.test(l)) return;
            lines.set(mpv, { multipv: mpv, cp: cp ? Number(cp[1]) : undefined, mate: mate ? Number(mate[1]) : undefined, pv: l.split(' pv ')[1].trim().split(/\s+/) });
          } else if (l.startsWith('bestmove')) {
            this.listener = null;
            if (gen !== this.generation) return reject(new Cancelled());
            const bm = l.split(/\s+/)[1];
            resolve({ bestmove: bm && bm !== '(none)' ? bm : null, lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv) });
          }
        };
        this.worker.postMessage(`setoption name MultiPV value ${opts.multipv ?? 1}`);
        this.worker.postMessage(`position fen ${fen}`);
        const limits = [opts.depth ? `depth ${opts.depth}` : '', opts.movetime ? `movetime ${opts.movetime}` : ''].filter(Boolean).join(' ');
        this.worker.postMessage(`go ${limits || 'movetime 500'}`);
      });
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private sync() {
    return new Promise<void>((resolve) => {
      this.listener = (l) => { if (l === 'readyok') { this.listener = null; resolve(); } };
      this.worker.postMessage('isready');
    });
  }

  terminate() { this.worker.terminate(); }
}
