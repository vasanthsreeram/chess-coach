// Browser side of /api/feedback: one debounced call per settled review position, cached, cancellable.
import { FEEDBACK_VERSION, validateModelOutput, type Fact, type Feedback, type FeedbackInput } from './facts';

const DEBOUNCE_MS = 700;
const TIMEOUT_MS = 10_000;
const cache = new Map<string, Fact[] | 'failed'>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight: AbortController | null = null;
let pendingKey: string | null = null;
let backoffUntil = 0;
export const stats = { requests: 0, cacheHits: 0, aborted: 0 };

export const feedbackKey = (i: FeedbackInput) => JSON.stringify([FEEDBACK_VERSION, i.fen, i.move, i.best, i.bestPv, i.replyPv, i.before, i.afterRaw]);

export function cached(i: FeedbackInput): Fact[] | null {
  const c = cache.get(feedbackKey(i));
  return c && c !== 'failed' ? c : null;
}

/** Cancels the pending/in-flight request (navigation moved on). */
export function cancelFeedback() {
  clearTimeout(timer); pendingKey = null;
  if (inflight) { inflight.abort(); inflight = null; stats.aborted++; }
}

/** Schedules a request for the shown position. `done` runs only with validated items for that key. */
export function requestFeedback(i: FeedbackInput, fb: Feedback, done: (key: string, items: Fact[]) => void) {
  const key = feedbackKey(i);
  if (cache.has(key)) { stats.cacheHits++; return; }
  // A re-render of the same position (e.g. Best toggle) keeps the pending or in-flight request.
  if (key === pendingKey) return;
  cancelFeedback();
  if (Date.now() < backoffUntil || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  pendingKey = key;
  timer = setTimeout(async () => {
    const ctl = new AbortController(); inflight = ctl;
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    stats.requests++;
    try {
      const res = await fetch('api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: FEEDBACK_VERSION, ...i }), signal: ctl.signal });
      if (res.status === 429) { backoffUntil = Date.now() + 60_000; return; }
      if (!res.ok) { cache.set(key, 'failed'); return; }
      const data = await res.json();
      // Re-validate against facts computed in this browser; never trust the response blindly.
      const items = data?.model ? validateModelOutput(data, fb.facts) : null;
      cache.set(key, items ?? 'failed');
      if (items) done(key, items);
    } catch {
      // Aborted (stale) or offline: keep the deterministic text, allow a retry later.
    } finally {
      clearTimeout(t);
      if (inflight === ctl) { inflight = null; pendingKey = null; }
    }
  }, DEBOUNCE_MS);
}
