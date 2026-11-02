import { test, expect, type Page } from '@playwright/test';
import { Chess } from 'chess.js';

const state = (page: Page) => page.evaluate(() => ({ fen: (window as any).__chess.fen(), n: (window as any).__chess.moves().length, mode: (window as any).__chess.mode() }));

async function playOne(page: Page) {
  const { fen, n } = await state(page);
  const c = new Chess(fen);
  const moves = c.moves({ verbose: true });
  const mv = moves.find((m) => m.captured) ?? moves[Math.floor(Math.random() * moves.length)];
  await page.click(`[data-sq="${mv.from}"]`);
  await expect(page.locator(`[data-sq="${mv.to}"]`)).toHaveClass(/dot|cap/);
  await page.click(`[data-sq="${mv.to}"]`);
  if (mv.promotion) await page.click('[aria-label="Promote to queen"]');
  // bot must answer (or game ends)
  await expect.poll(async () => { const s = await state(page); return s.n >= n + 2 || s.mode !== 'play'; }, { timeout: 30_000 }).toBe(true);
}

test('play vs bot, resign, review with navigation and explanation text', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.click('[aria-label="Play as white"]');
  for (let i = 0; i < 8; i++) { if ((await state(page)).mode !== 'play') break; await playOne(page); }
  expect((await state(page)).n).toBeGreaterThanOrEqual(10);

  // persistence: reload keeps the game
  const before = await state(page);
  await page.reload();
  expect((await state(page)).fen).toBe(before.fen);

  if ((await state(page)).mode === 'play') await page.click('[aria-label="Resign"]');
  await expect(page.locator('.overlay[data-result]')).toBeVisible();
  await page.locator('.overlay [aria-label="Review game"]').click();
  await expect(page.locator('.strip button').first()).toBeVisible({ timeout: 120_000 });
  const n = await page.locator('.strip button').count();
  expect(n).toBe((await state(page)).n);

  await page.click('[aria-label="Start"]');
  await page.click('[aria-label="Next move"]');
  await expect(page.locator('.badge').first()).toBeVisible();
  await expect(page.locator('svg.arrows')).toHaveCount(1);
  await page.click('[aria-label="Last move"]');
  await expect(page.locator('[aria-label="Next move"]')).toBeDisabled();
  await page.click('[aria-label="Previous move"]');
  await expect(page.locator('.strip button.cur')).toHaveCount(1);
  await page.locator('.evalbar').waitFor();

  const review = await page.evaluate(() => (window as any).__chess.review());
  console.log('qualities', review.map((r: any) => r.quality[0]).join(''), 'motifs', JSON.stringify(review.flatMap((r: any) => r.motifs)));
  await expect(page.locator('.explain')).toContainText(/(Best move|Good move|Inaccuracy|Mistake|Blunder): \d+\.(\.\.)? \S+/);
  await expect(page.locator('.explain .head')).toBeVisible();
  await page.screenshot({ path: `test-results/review-${test.info().project.name}.png` });
  expect(errors).toEqual([]);
});

test('new game as black: bot opens; engine wasm served', async ({ page }) => {
  const res = await page.request.get('/engine/stockfish-19-lite-single.wasm');
  expect(res.ok()).toBe(true);
  await page.goto('/');
  await page.click('[aria-label="Play as black"]');
  await expect.poll(async () => (await state(page)).n, { timeout: 30_000 }).toBe(1);
  await expect(page.locator('[data-sq="a1"]')).toHaveCSS('grid-row-start', 'auto');
  // board flipped: first square in DOM is h1
  expect(await page.locator('.sq').first().getAttribute('data-sq')).toBe('h1');
});

test('review of a known blunder shows allowed-mate and fork/hanging evidence on the board', async ({ page }) => {
  // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#  — player is black and gets mated.
  await page.addInitScript(() => localStorage.setItem('chess-minimal.v1', JSON.stringify({ moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'], player: 'b', resigned: null })));
  await page.goto('/');
  await expect(page.locator('.overlay[data-result="loss"]')).toBeVisible();
  await page.locator('.overlay [aria-label="Review game"]').click();
  await expect(page.locator('.strip button')).toHaveCount(7, { timeout: 60_000 });
  const nf6 = page.locator('.strip button').nth(5);
  await expect(nf6).toHaveAttribute('aria-label', /Nf6, blunder.*allowedMate/);
  await nf6.click();
  await expect(page.locator('.badge[title^="Allows mate in 1"]')).toBeVisible();
  await expect(page.locator('[data-sq="f7"] .badge')).toHaveCount(1);
  await expect(page.locator('svg.arrows polygon')).toHaveCount(3); // best, played, mating reply
  await page.screenshot({ path: `test-results/blunder-${test.info().project.name}.png` });
});
