// Cloudflare Worker: static assets plus POST /api/feedback, which phrases server-computed chess facts
// with DeepSeek V4.1 Flash on Workers AI. The model never sees user text and its output is validated.
import { buildFeedback, defaultPick, RESPONSE_SCHEMA, sanitizeInput, SYSTEM_PROMPT, userPrompt, validateModelOutput, FEEDBACK_VERSION } from '../src/facts';

export const MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const MAX_BODY = 2048;
const AI_TIMEOUT_MS = 8000;

interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }
export interface Env {
  ASSETS: { fetch(r: Request): Promise<Response> };
  AI: { run(model: string, input: unknown, opts?: unknown): Promise<any> };
  RL_IP: RateLimit;
  RL_GLOBAL: RateLimit;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

function sameOrigin(req: Request): boolean {
  const host = new URL(req.url).host;
  const origin = req.headers.get('origin');
  if (origin) { try { return new URL(origin).host === host; } catch { return false; } }
  const site = req.headers.get('sec-fetch-site');
  return site === 'same-origin';
}

function contentOf(res: any): string | null {
  const c = res?.choices?.[0]?.message?.content ?? res?.response;
  return typeof c === 'string' ? c : c && typeof c === 'object' ? JSON.stringify(c) : null;
}

export async function handleFeedback(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  if (!sameOrigin(req)) return json(403, { error: 'origin' });
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json(415, { error: 'type' });
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BODY) return json(413, { error: 'size' });
  const text = await req.text();
  if (text.length > MAX_BODY) return json(413, { error: 'size' });
  let body: any;
  try { body = JSON.parse(text); } catch { return json(400, { error: 'json' }); }
  if (body?.v !== FEEDBACK_VERSION) return json(400, { error: 'version' });
  const input = sanitizeInput(body);
  if (!input) return json(400, { error: 'input' });

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const [a, b] = await Promise.all([env.RL_IP.limit({ key: ip }), env.RL_GLOBAL.limit({ key: 'global' })]);
  if (!a.success || !b.success) return json(429, { error: 'rate' });

  const fb = buildFeedback(input);
  let items = null;
  try {
    const res = await Promise.race([
      env.AI.run(MODEL, {
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt(fb) }],
        max_completion_tokens: 300, temperature: 0.2,
        chat_template_kwargs: { enable_thinking: false },
        response_format: RESPONSE_SCHEMA,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), AI_TIMEOUT_MS)),
    ]);
    const content = contentOf(res);
    items = content ? validateModelOutput(content, fb.facts) : null;
  } catch {
    items = null;
  }
  return json(200, { v: FEEDBACK_VERSION, model: items ? MODEL : null, items: items ?? defaultPick(fb) });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/feedback') return handleFeedback(req, env);
    if (url.pathname.startsWith('/api/')) return json(404, { error: 'not found' });
    return env.ASSETS.fetch(req);
  },
};
