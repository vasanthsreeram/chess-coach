import { test, expect, type Page } from '@playwright/test';
import { Chess } from 'chess.js';

// A long deterministic game so the move strip overflows and must scroll.
function longGame(plies: number) {
  const g = new Chess();
  for (let i = 0; i < plies; i++) {
    const ms = g.moves({ verbose: true }).filter((m) => { const c = new Chess(g.fen()); c.move(m); return !c.isGameOver(); });
    g.move(ms[(i * 7 + 3) % ms.length]);
  }
  return g.history({ verbose: true }).map((m) => m.lan);
}
const GAME = { moves: longGame(50), player: 'w', resigned: 'w' };

/** Samples the strip's scrollLeft every frame for `ms` after running `act`. */
async function sampleStrip(page: Page, act: () => Promise<void>, ms = 900) {
  await page.evaluate((ms) => {
    const w = window as any; w.__s = [];
    const t0 = performance.now();
    const f = () => { const s = document.querySelector('.strip'); if (s) w.__s.push(Math.round(s.scrollLeft)); if (performance.now() - t0 < ms) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }, ms);
  await act();
  await page.waitForTimeout(ms + 100);
  return page.evaluate(() => (window as any).__s as number[]);
}

async function openLong(page: Page) {
  await page.addInitScript((d) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify(d)); } }, GAME);
  await page.goto('/');
  await page.locator('.overlay [aria-label="Review game"]').click();
  await expect(page.locator('.strip button')).toHaveCount(50, { timeout: 150_000 });
}

test('review nav: Next/Back never rewind the move strip; late feedback does not move it', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(String(e)));
  await openLong(page);
  await page.locator('.strip button').nth(30).click();
  await page.waitForTimeout(1500); // let feedback for ply 30 settle
  const report: Record<string, unknown> = {};
  // Next: strip should move forward only, never drop back towards move 1.
  const next = await sampleStrip(page, () => page.click('[aria-label="Next move"]'));
  report.next = { start: next[0], min: Math.min(...next), end: next[next.length - 1] };
  // Late AI feedback arrives (mock ~1s): strip must stay put.
  const idle = await sampleStrip(page, async () => {}, 1500);
  report.idleDuringFeedback = { min: Math.min(...idle), max: Math.max(...idle) };
  // Best toggle: unrelated control must not scroll the strip.
  const best = await sampleStrip(page, () => page.click('[aria-label="Show best move"]'), 600);
  report.best = { min: Math.min(...best), max: Math.max(...best) };
  // Rapid navigation: 8 quick Back presses land on the right ply with the strip near it.
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) await page.click('[aria-label="Previous move"]');
  report.rapidMs = Date.now() - t0;
  await expect(page.locator('.strip button.cur')).toHaveAttribute('aria-label', new RegExp(`^${Math.floor(23 / 2) + 1}\\.\\.\\. `));
  const back = await sampleStrip(page, () => page.click('[aria-label="Previous move"]'));
  report.back = { start: back[0], max: Math.max(...back), min: Math.min(...back), end: back[back.length - 1] };
  console.log('nav-stability', test.info().project.name, JSON.stringify(report));

  expect(Math.min(...next)).toBeGreaterThanOrEqual(next[0] - 2);
  expect(Math.max(...idle) - Math.min(...idle)).toBeLessThanOrEqual(2);
  expect(Math.max(...best) - Math.min(...best)).toBeLessThanOrEqual(2);
  expect(Math.max(...back)).toBeLessThanOrEqual(back[0] + 2);
  expect(Math.min(...back)).toBeGreaterThan(50); // never rewound towards move 1
  // Current move is visible inside the strip.
  const vis = await page.evaluate(() => { const s = document.querySelector('.strip')!.getBoundingClientRect(); const c = document.querySelector('.strip .cur')!.getBoundingClientRect(); return c.left >= s.left - 1 && c.right <= s.right + 1; });
  expect(vis).toBe(true);
  expect(errors).toEqual([]);
});

test('review nav: re-renders for the same position do not abort the pending AI request', async ({ page }) => {
  const sent: string[] = []; const failed: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/feedback')) sent.push(r.postDataJSON().move); });
  page.on('requestfailed', (r) => { if (r.url().includes('/api/feedback')) failed.push(r.postDataJSON().move); });
  await openLong(page);
  await page.locator('.strip button').nth(20).click();
  await page.waitForTimeout(800); // request in flight (debounce 700ms, mock ~300ms+)
  await page.click('[aria-label="Show best move"]');
  await page.click('[aria-label="Show best move"]');
  await expect(page.locator('.explain .src')).toBeVisible({ timeout: 5000 });
  console.log('feedback requests', JSON.stringify({ sent, failed }));
  expect(failed).toEqual([]);
});

test('review nav: stale exploration result never lands after navigating away', async ({ page }) => {
  await openLong(page);
  await page.locator('.strip button').nth(10).click();
  await page.click('[aria-label="Play best line"]');
  await page.click('[aria-label="Return to game"]');
  await page.click('[aria-label="Next move"]');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__chess.exEval())).toBeNull();
  await expect(page.locator('.explain .head')).not.toContainText('Exploring');
  await expect(page.locator('.strip button.cur')).toHaveAttribute('aria-label', /^6\.\.\. /);
});
