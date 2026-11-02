// Chess.com import + shared D1 analysis cache, against the local preview server (fixture upstream, fake D1).
// Shares one in-memory fake D1 per server, so run with --workers=1.
import { test, expect, type Page, type Browser } from '@playwright/test';

const SHARE = 'Check out this #chess game: samplewhite vs sampleblack - https://www.chess.com/game/live/987654321234';
const EVID = process.env.EVIDENCE_DIR ?? 'test-results';
test.describe.configure({ mode: 'serial' });
const hook = (p: Page, fn: string) => p.evaluate((f) => (window as any).__chess[f](), fn);

async function fresh(browser: Browser, mobile: boolean) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  // Record UCI commands sent to the engine worker, to prove the review settings match the cache key.
  await page.addInitScript(() => { const w: any = window; w.__uci = []; const pm = Worker.prototype.postMessage; Worker.prototype.postMessage = function (this: Worker, m: any, ...r: any[]) { if (typeof m === 'string' && m.startsWith('go ')) w.__uci.push(m); return (pm as any).call(this, m, ...r); }; });
  const api: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) api.push(`${r.method()} ${r.url()}`); });
  await page.goto('/');
  return { ctx, page, api };
}

async function importShare(page: Page, text: string, user = '') {
  if (await page.locator('[aria-label="Import a Chess.com game"]').count() === 0) await page.locator('[aria-label="Game history"]').click();
  await page.locator('[aria-label="Import a Chess.com game"]').first().click();
  await page.locator('textarea').fill(text);
  if (user) await page.locator('input[aria-label^="Chess.com username"]').fill(user);
  await page.locator('[aria-label="Find game"]').click();
}

test('share text → review; same browser reuses its saved analysis; another browser cannot; D1 down gives no false hit', async ({ browser, request }, info) => {
  const mobile = info.project.name === 'mobile';
  await request.get('/__test/d1?reset=1');

  // Browser A: imports and computes with Stockfish (depth 12, 600 ms cap), then stores to its own partition.
  const A = await fresh(browser, mobile);
  const headersA: Record<string, string>[] = [];
  A.page.on('request', (r) => { if (r.url().includes('/api/analysis')) headersA.push(r.headers()); });
  await importShare(A.page, SHARE);
  await expect(A.page.locator('.import')).toContainText('samplewhite (white) vs sampleblack (black) · 32 moves · White won by resignation');
  await expect(A.page.locator('.import .affil')).toHaveText('Not affiliated with or endorsed by Chess.com. Chess.com is a trademark of its owner.');
  await expect(A.page.locator('.import a[href="https://www.chess.com/game/live/987654321234"]')).toBeVisible();
  await A.page.screenshot({ path: `${EVID}/secure-import-found-${info.project.name}.png` });
  await A.page.locator('[aria-label="Review as samplewhite (white)"]').click();
  await expect(A.page.locator('.strip button')).toHaveCount(63, { timeout: 170_000 });
  expect(await hook(A.page, 'evalsSource')).toBe('engine');
  const gos: string[] = await A.page.evaluate(() => (window as any).__uci);
  expect(gos.filter((g) => g === 'go depth 12 movetime 600').length).toBeGreaterThanOrEqual(60);
  expect(gos.every((g) => g === 'go depth 12 movetime 600' || g === 'go depth 8')).toBe(true);
  await expect.poll(() => hook(A.page, 'importStats').then((s: any) => s.analysisStored)).toBe(1);
  const secretA = await A.page.evaluate(() => localStorage.getItem('chess-minimal.review-key.v1'));
  expect(secretA).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(headersA.length).toBeGreaterThanOrEqual(2);
  for (const h of headersA) expect(h['x-review-key']).toBe(secretA);
  const reviewA = (await hook(A.page, 'review') as any[]).map((p) => p.quality);

  // Same browser after its local history is cleared (secret kept): served from its own saved analysis.
  await A.page.evaluate(() => localStorage.removeItem('chess-minimal.history.v1'));
  await A.page.reload();
  await importShare(A.page, SHARE);
  await A.page.locator('[aria-label="Review as samplewhite (white)"]').click();
  await expect(A.page.locator('.strip button')).toHaveCount(63, { timeout: 15_000 });
  expect(await hook(A.page, 'evalsSource')).toBe('saved');
  expect(await hook(A.page, 'importStats')).toMatchObject({ analysisHits: 1 });
  await expect(A.page.locator('.srcline')).toContainText('saved analysis (this browser)');
  expect((await hook(A.page, 'review') as any[]).map((p) => p.quality)).toEqual(reviewA);
  await A.page.screenshot({ path: `${EVID}/secure-review-saved-${info.project.name}.png` });
  const fit = await A.page.evaluate(() => ({ w: document.documentElement.scrollWidth, iw: innerWidth }));
  expect(fit.w).toBeLessThanOrEqual(fit.iw);

  // Browser B (different secret): no access to A's analysis; computes and stores its own.
  const B = await fresh(browser, mobile);
  await importShare(B.page, 'https://www.chess.com/game/live/987654321234'); // game row is cached; no username needed
  await B.page.locator('[aria-label="Review as sampleblack (black)"]').click();
  await expect(B.page.locator('.progress')).toBeVisible();
  await expect(B.page.locator('.strip button')).toHaveCount(63, { timeout: 170_000 });
  expect(await hook(B.page, 'evalsSource')).toBe('engine');
  expect(await hook(B.page, 'importStats')).toMatchObject({ analysisHits: 0, analysisMisses: 1 });
  const secretB = await B.page.evaluate(() => localStorage.getItem('chess-minimal.review-key.v1'));
  expect(secretB).not.toBe(secretA);

  // Reload B: local history still has the evals.
  await B.page.reload();
  await B.page.locator('[aria-label="Game history"]').click();
  await expect(B.page.locator('.hrow').first()).toContainText('vs samplewhite (Chess.com)');
  await B.page.locator('.hrow').first().click();
  await expect(B.page.locator('.strip button')).toHaveCount(63, { timeout: 15_000 });
  expect(await hook(B.page, 'evalsSource')).toBe('local');

  // No secret ever appears in any URL.
  for (const url of [...A.api, ...B.api]) { expect(url).not.toContain(secretA!); expect(url).not.toContain(secretB!); }

  // Browser C with D1 down: import still works through the API, analysis is a miss (computed locally).
  await request.get('/__test/d1?down=1');
  const C = await fresh(browser, mobile);
  await importShare(C.page, SHARE);
  await C.page.locator('[aria-label="Review as samplewhite (white)"]').click();
  await expect(C.page.locator('.progress')).toBeVisible();
  expect(await hook(C.page, 'importStats')).toMatchObject({ analysisHits: 0, analysisMisses: 1 });
  await request.get('/__test/d1?down=0');
  for (const x of [A, B, C]) await x.ctx.close();
});

test('malformed links, bad usernames and PGN fallback', async ({ browser }, info) => {
  const { ctx, page, api } = await fresh(browser, info.project.name === 'mobile');
  await importShare(page, 'https://evil.example/game/live/1');
  await expect(page.locator('.import .msg')).toContainText('Paste a Chess.com game link');
  expect(api.filter((a) => a.includes('chesscom'))).toHaveLength(0);
  // An unfinished PGN (no result, not a terminal position) is refused: no live assistance.
  await page.locator('textarea').fill('[White "Alice"]\n[Black "Bob"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *');
  await page.locator('[aria-label="Find game"]').click();
  await expect(page.locator('.import .msg')).toContainText('no final result');
  await page.locator('textarea').fill('https://www.chess.com/game/live/987654321234');
  await page.locator('input[aria-label^="Chess.com username"]').fill('bad/name');
  await page.locator('[aria-label="Find game"]').click();
  await expect(page.locator('.import .msg')).toContainText('not valid');
  await page.locator('input[aria-label^="Chess.com username"]').fill('');
  await page.locator('textarea').fill('https://www.chess.com/game/live/777');
  await page.locator('[aria-label="Find game"]').click();
  await expect(page.locator('.import .msg')).toContainText('Add one player');
  await expect(page.locator('input[aria-label^="Chess.com username"]')).toHaveAttribute('placeholder', 'Username of either player');
  await page.locator('textarea').fill('Check out this #chess game: nobody1 vs nobody2 - https://www.chess.com/game/live/5');
  await page.locator('input[aria-label^="Chess.com username"]').fill('');
  await page.locator('[aria-label="Find game"]').click();
  await expect(page.locator('.import .msg')).toContainText('paste the PGN');
  // PGN fallback is parsed in the browser; no server call.
  const before = api.length;
  await page.locator('textarea').fill('[White "Alice"]\n[Black "Bob"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1');
  await page.locator('[aria-label="Find game"]').click();
  await expect(page.locator('.import')).toContainText('Alice (white) vs Bob (black) · 2 moves');
  await page.locator('[aria-label="Review as Alice (white)"]').click();
  await expect(page.locator('.strip button')).toHaveCount(4, { timeout: 60_000 });
  expect(api.slice(before).filter((a) => !a.includes('/api/feedback'))).toHaveLength(0);
  await ctx.close();
});


test('import dialog fits a small phone without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.locator('[aria-label="Game history"]').click();
  await page.locator('[aria-label="Import a Chess.com game"]').click();
  const fit = async () => page.evaluate(() => { const p = document.querySelector('.panel.import')!; return { panel: p.scrollHeight <= p.clientHeight, page: document.documentElement.scrollHeight <= innerHeight }; });
  expect(await fit()).toEqual({ panel: true, page: true });
  await page.locator('textarea').fill(SHARE);
  await page.locator('[aria-label="Find game"]').click();
  await expect(page.locator('.import')).toContainText('samplewhite');
  expect(await fit()).toEqual({ panel: true, page: true });
});
