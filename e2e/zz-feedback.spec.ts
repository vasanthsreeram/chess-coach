import { test, expect, type Page } from '@playwright/test';

const EVID = process.env.EVIDENCE_DIR ?? 'test-results';
const SCHOLAR = { moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'], player: 'b', resigned: null };
const C = (page: Page) => ({ stats: () => page.evaluate(() => (window as any).__chess.feedbackStats()), fen: () => page.evaluate(() => (window as any).__chess.shownFen()), hist: () => page.evaluate(() => (window as any).__chess.history()) });

async function openScholar(page: Page) {
  await page.addInitScript((d) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify(d)); } }, SCHOLAR);
  await page.goto('/');
  await page.locator('.overlay [aria-label="Review game"]').click();
  await expect(page.locator('.strip button')).toHaveCount(7, { timeout: 60_000 });
}

test('feedback: deterministic text at once, one debounced call, cache, AI label; 320x640 fits without scrolling', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/feedback')) calls.push(r.postDataJSON().move); });
  await page.setViewportSize({ width: 320, height: 640 });
  await openScholar(page);
  // Deterministic facts are shown before any network answer.
  await expect(page.locator('.explain .head')).toContainText('Blunder: 3... Nf6');
  await expect(page.locator('.explain')).toContainText('This allows mate in 1 for White');
  await expect(page.locator('.explain .src')).toBeVisible({ timeout: 10_000 });
  expect(calls).toEqual(['g8f6']);
  // Rapid navigation: only the settled position is requested; stale ones are cancelled or never sent.
  for (let i = 0; i < 4; i++) await page.click('[aria-label="Previous move"]');
  await page.waitForTimeout(1500);
  expect(calls).toEqual(['g8f6', 'e7e5']);
  await expect(page.locator('.explain .head')).toContainText('1... e5');
  // Back to a cached ply: no new request.
  await page.locator('.strip button').nth(5).click();
  await page.waitForTimeout(1200);
  expect(calls.length).toBe(2);
  expect((await C(page).stats()).cacheHits).toBeGreaterThan(0);
  // Layout: panel fully visible, no internal scroll, no page scroll at 320x640.
  const m = await page.evaluate(() => {
    const e = document.querySelector('.explain')!; const r = e.getBoundingClientRect();
    return { inner: e.scrollHeight - e.clientHeight, docH: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth, bottom: r.bottom, h: innerHeight };
  });
  console.log('layout 320x640', JSON.stringify(m), 'panel:\n' + await page.locator('.explain').innerText());
  expect(m.inner).toBeLessThanOrEqual(0);
  expect(m.docH).toBeLessThanOrEqual(640);
  expect(m.docW).toBeLessThanOrEqual(320);
  expect(m.bottom).toBeLessThanOrEqual(640);
  await page.screenshot({ path: `${EVID}/feedback-320x640-${test.info().project.name}.png` });
});

test('every ply of a tactical game fits 320x640 with no page or panel scroll', async ({ page }) => {
  // Damiano defence trap: captures, checks, recaptures, long explanations.
  const game = { moves: ['e2e4', 'e7e5', 'g1f3', 'f7f6', 'f3e5', 'f6e5', 'd1h5', 'e8e7', 'h5e5', 'e7f7', 'f1c4', 'd7d5', 'c4d5', 'f7g6'], player: 'b', resigned: 'b' };
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript((d) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify(d)); } }, game);
  await page.goto('/');
  await page.locator('.overlay [aria-label="Review game"]').click();
  await expect(page.locator('.strip button')).toHaveCount(14, { timeout: 90_000 });
  let worst = 0;
  for (let i = 0; i < 14; i++) {
    await page.locator('.strip button').nth(i).click();
    const m = await page.evaluate(() => { const e = document.querySelector('.explain')!; return { inner: e.scrollHeight - e.clientHeight, docH: document.documentElement.scrollHeight, text: (e as HTMLElement).innerText }; });
    worst = Math.max(worst, m.docH);
    expect(m.inner, m.text).toBeLessThanOrEqual(0);
    expect(m.docH, m.text).toBeLessThanOrEqual(640);
    expect(m.text).not.toMatch(/undefined|NaN|null/);
    if (i === 4 || i === 6) { console.log(`ply ${i}:\n${m.text}`); await page.screenshot({ path: `${EVID}/feedback-ply${i}-320-${test.info().project.name}.png` }); }
  }
  console.log('worst document height', worst);
});

test('play best line and their reply from the right positions; saved game unchanged', async ({ page }) => {
  await openScholar(page);
  const saved = JSON.stringify((await C(page).hist())[0].moves);
  const afterQh5 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
  await page.click('[aria-label="Play best line"]');
  const f1 = await C(page).fen();
  expect(f1.startsWith('r1bqkbnr/pppp1p1p/2n3p1/4p2Q/')).toBe(true); // g6 played from the before-move position
  await expect(page.locator('.explain .head')).toContainText('Exploring');
  await page.click('[aria-label="Next move in line"]');
  expect(await C(page).fen()).not.toBe(f1);
  await page.screenshot({ path: `${EVID}/feedback-bestline-${test.info().project.name}.png` });
  await page.click('[aria-label="Return to game"]');
  await page.click('[aria-label="Play their reply"]');
  expect(await C(page).fen()).toMatch(/^r1bqkb1r\/pppp1Qpp\/2n2n2\//); // Qxf7# after the actual move
  await page.click('[aria-label="Return to game"]');
  expect(await C(page).fen()).not.toBe(afterQh5);
  expect(JSON.stringify((await C(page).hist())[0].moves)).toBe(saved);
});

test('rate-limited or offline API keeps deterministic feedback', async ({ page }) => {
  let n = 0;
  await page.route('**/api/feedback', (r) => { n++; return n === 1 ? r.fulfill({ status: 429, body: '{}' }) : r.abort('internetdisconnected'); });
  await openScholar(page);
  await page.waitForTimeout(1500);
  await expect(page.locator('.explain')).toContainText('This allows mate in 1 for White');
  await expect(page.locator('.explain .src')).toHaveCount(0);
  // After a 429 the client backs off: further navigation sends nothing.
  await page.click('[aria-label="Previous move"]');
  await page.waitForTimeout(1200);
  expect(n).toBe(1);
});

test('tampered API response is re-validated in the browser', async ({ page }) => {
  await page.route('**/api/feedback', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ v: 1, model: 'x', items: [{ id: 'f2', text: 'Black wins the white queen on d1 with Qxd1.' }] }) }));
  await openScholar(page);
  await page.waitForTimeout(1500);
  const t = await page.locator('.explain').innerText();
  expect(t).not.toContain('d1');
  expect(t).toContain('This allows mate in 1 for White');
});
