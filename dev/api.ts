// Local /api/feedback for `vite dev` / `vite preview` and e2e tests. Runs the real Worker handler with
// in-memory rate limits. AI: a mock by default; DS_REAL=1 calls the real DeepSeek V4.1 Flash through the
// already-authenticated `cf ai run` CLI (no deploy, no secrets in this process).
import type { Plugin, Connect } from 'vite';
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker, { type Env } from '../worker/index';

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
  const env: Env = { ASSETS: { fetch: async () => new Response('', { status: 404 }) }, AI: process.env.DS_REAL === '1' ? realAI : mockAI, RL_IP: limiter(Number(process.env.RL_IP ?? 20)), RL_GLOBAL: limiter(300) };
  const mw: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.endsWith('/api/feedback')) return next();
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const host = req.headers.host ?? 'localhost';
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    headers.set('cf-connecting-ip', req.socket.remoteAddress ?? 'local');
    const r = await worker.fetch(new Request(`http://${host}/api/feedback`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), env);
    const body = await r.text();
    try { apiLog.push({ status: r.status, model: r.status === 200 ? JSON.parse(body).model : null }); } catch { /* non-JSON */ }
    console.log(`[api] ${r.status} ${r.status === 200 ? JSON.parse(body).model ?? 'fallback' : ''}`);
    res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(body);
  };
  return { name: 'feedback-api', configureServer: (s) => { s.middlewares.use(mw); }, configurePreviewServer: (s) => { s.middlewares.use(mw); } };
}
