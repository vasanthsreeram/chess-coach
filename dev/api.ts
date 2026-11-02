// Local /api/feedback for `vite dev` / `vite preview` and e2e tests. Runs the real Worker handler with
// in-memory rate limits. AI: a mock by default; DS_REAL=1 calls the real DeepSeek V4.1 Flash through the
// already-authenticated `cf ai run` CLI (no deploy, no secrets in this process).
import type { Plugin, Connect } from 'vite';
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import worker, { type Env } from '../worker/index';
import { fakeD1 } from './fakeD1';
import type { Fetcher } from '../worker/chesscom';

// Chess.com upstream: a recorded fixture by default (no network in tests); CHESSCOM_LIVE=1 uses the real public API.
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/chesscom-sample.json', import.meta.url), 'utf8'));
export const upstreamLog: string[] = [];
const fixtureFetch: Fetcher = async (url) => {
  upstreamLog.push(url);
  const body = url.endsWith('/samplewhite/games/archives') ? fixture.archives_samplewhite : url.endsWith('/samplewhite/games/2026/11') ? fixture.month_2026_11
    : /\/games\/archives$/.test(url) ? { archives: [] } : /\/games\/\d{4}\/\d{2}$/.test(url) ? { games: [] } : null;
  return new Response(body ? JSON.stringify(body) : '{"code":0}', { status: body ? 200 : 404 });
};
const upstream: Fetcher = process.env.CHESSCOM_LIVE === '1' ? (u, i) => { upstreamLog.push(u); return fetch(u, i); } : fixtureFetch;
let d1Down = process.env.FAKE_D1_DOWN === '1';
let db = fakeD1({ fail: () => d1Down });

function limiter(limit: number) {
  const hits = new Map<string, number[]>();
  return { async limit({ key }: { key: string }) {
    const now = Date.now(); const h = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    const success = h.length < limit; if (success) h.push(now); hits.set(key, h); return { success };
  } };
}

const mockAI: Env['AI'] = {
  async run(_model, input: any) {
    const ids = [...String(input.messages[1].content).matchAll(/^(f\d+) \[(\w+)\]: (.*)$/gm)];
    const pick = ['what', 'threat', 'tactic', 'better', 'why'].flatMap((k) => ids.filter((m) => m[2] === k)).slice(0, 3);
    await new Promise((r) => setTimeout(r, Number(process.env.MOCK_AI_DELAY ?? 300)));
    return { choices: [{ message: { content: JSON.stringify({ items: pick.map((m) => ({ id: m[1], text: m[3] })) }) } }] };
  },
};

const realAI: Env['AI'] = {
  run(model, input) {
    const dir = mkdtempSync(join(tmpdir(), 'dsreq-')); const f = join(dir, 'body.json');
    writeFileSync(f, JSON.stringify(input));
    return new Promise((resolve, reject) => execFile('cf', ['ai', 'run', model, '--body', `@${f}`, '-q'], { timeout: 20_000 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    }));
  },
};

export const apiLog: { status: number; model: string | null }[] = [];

export function feedbackApi(): Plugin {
  const env: Env = { ASSETS: { fetch: async () => new Response('', { status: 404 }) }, AI: process.env.DS_REAL === '1' ? realAI : mockAI, RL_IP: limiter(Number(process.env.RL_IP ?? 20)), RL_GLOBAL: limiter(300), get DB() { return db; } };
  const mw: Connect.NextHandleFunction = async (req, res, next) => {
    const path = req.url?.split('?')[0] ?? '';
    // Test-only switch to simulate a D1 outage (dev/preview server only; never part of the Worker).
    if (path.endsWith('/__test/d1')) { d1Down = req.url!.includes('down=1'); if (req.url!.includes('reset=1')) db = fakeD1({ fail: () => d1Down }); res.end('ok'); return; }
    if (!/\/api\/(feedback|chesscom\/import|analysis)$/.test(path)) return next();
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const host = req.headers.host ?? 'localhost';
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    headers.set('cf-connecting-ip', req.socket.remoteAddress ?? 'local');
    const apiPath = req.url!.slice(req.url!.indexOf('/api/'));
    const r = await worker.fetch(new Request(`http://${host}${apiPath}`, { method: req.method, headers, body: req.method === 'POST' || req.method === 'PUT' ? Buffer.concat(chunks) : undefined }), env, undefined, upstream);
    const body = await r.text();
    if (apiPath.startsWith('/api/feedback')) try { apiLog.push({ status: r.status, model: r.status === 200 ? JSON.parse(body).model : null }); } catch { /* non-JSON */ }
    console.log(`[api] ${req.method} ${apiPath.split('?')[0]} ${r.status}`);
    res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(body);
  };
  return { name: 'feedback-api', configureServer: (s) => { s.middlewares.use(mw); }, configurePreviewServer: (s) => { s.middlewares.use(mw); } };
}
