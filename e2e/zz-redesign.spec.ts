import { test, expect, type Page } from '@playwright/test';

const EVID = process.env.EVIDENCE_DIR ?? 'test-results';
const SCHOLAR = { moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'], player: 'b', resigned: null };
const snd = (page: Page) => page.evaluate(() => (window as any).__chess.sound());
const noOverflow = async (page: Page) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(o.sw).toBeLessThanOrEqual(o.w);
};
const errorsOf = (page: Page) => { const e: string[] = []; page.on('pageerror', (x) => e.push(String(x))); page.on('console', (m) => { if (m.type() === 'error') e.push(m.text()); }); return e; };

test('sound: plays on deliberate moves and bot replies, mute persists across reload', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto('/');
  await page.screenshot({ path: `${EVID}/chooser-${test.info().project.name}.png` });
  await page.click('[aria-label="Play as white"]');
  await page.screenshot({ path: `${EVID}/initial-game-${test.info().project.name}.png` });
  await noOverflow(page);
  expect((await snd(page)).muted).toBe(false);
  await page.click('[data-sq="e2"]'); await page.click('[data-sq="e4"]');
  await expect.poll(() => page.evaluate(() => (window as any).__chess.moves().length), { timeout: 30_000 }).toBe(2);
  const s1 = await snd(page);
  console.log('sound after player move + bot reply', JSON.stringify(s1));
  expect(s1.unlocked).toBe(true);
  expect(s1.played.length).toBe(2); // one for the player move, one for the bot move: no duplicates
  await page.click('[aria-label="Mute sounds"]');
  await expect(page.locator('[aria-label="Unmute sounds"]')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('[aria-label="Unmute sounds"]')).toBeVisible();
  await page.click('[data-sq="d2"]'); await page.click('[data-sq="d4"]');
  await expect.poll(() => page.evaluate(() => (window as any).__chess.moves().length), { timeout: 30_000 }).toBe(4);
  expect((await snd(page)).played).toEqual([]);
  await page.click('[aria-label="Unmute sounds"]');
  expect((await snd(page)).played).toEqual(['select']);
  await page.screenshot({ path: `${EVID}/play-${test.info().project.name}.png` });
  expect(errors).toEqual([]);
});

test('review styling: eval label, coach card, move strip, actions, explore; no overflow at 320px', async ({ page }) => {
  const errors = errorsOf(page);
  const n = test.info().project.name;
  await page.addInitScript((d) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify(d)); } }, SCHOLAR);
  await page.goto('/');
  await page.screenshot({ path: `${EVID}/game-over-${n}.png` });
  await page.locator('.overlay [aria-label="Review game"]').click();
  await expect(page.locator('.strip button')).toHaveCount(7, { timeout: 60_000 });
  // Opens on the player's blunder (Nf6).
  await expect(page.locator('.strip button.cur')).toHaveAttribute('aria-label', /Nf6, blunder/);
  await expect(page.locator('.explain .head')).toContainText('Blunder: 3... Nf6');
  await expect(page.locator('.evalbar .lbl')).toHaveText('M1'); // White mates in 1 after Nf6
  await expect(page.locator('.explain .pill')).toHaveText('M1');
  await expect(page.locator('.coach .avatar')).toHaveCount(0);
  await expect(page.locator('.explain p:not(.head):not(.links)')).toHaveCount(3);
  const card = await page.locator('.explain').evaluate(el => ({ scroll: el.scrollHeight, visible: el.clientHeight }));
  expect(card.scroll).toBeLessThanOrEqual(card.visible);
  await page.screenshot({ path: `${EVID}/review-blunder-${n}.png` });
  await noOverflow(page);
  // Best toggle removes/restores the best-move arrow.
  const polys = await page.locator('svg.arrows polygon').count();
  await page.click('[aria-label="Show best move"]');
  await expect(page.locator('svg.arrows polygon')).toHaveCount(polys - 1);
  await page.click('[aria-label="Show best move"]');
  await expect(page.locator('svg.arrows polygon')).toHaveCount(polys);
  // Start / Next / Last
  await page.click('[aria-label="Start"]');
  await expect(page.locator('.explain .head')).toContainText('Start position');
  await expect(page.locator('.evalbar .lbl')).toHaveText(/^\+0\.\d\d$/);
  await page.click('[aria-label="Next move"]');
  await expect(page.locator('.explain .head')).toContainText('1. e4');
  await page.screenshot({ path: `${EVID}/review-first-move-${n}.png` });
  await page.click('[aria-label="Last move"]');
  await expect(page.locator('.evalbar .lbl')).toHaveText('1-0');
  await expect(page.locator('[aria-label="Next move"]')).toBeDisabled();
  await expect(page.locator('[aria-label="Next move"]')).toHaveText('End of game');
  await page.screenshot({ path: `${EVID}/review-mate-${n}.png` });
  // explore from ply 4 (after 3. Qh5)
  await page.locator('.strip button').nth(4).click();
  await page.click('[data-sq="g7"]'); await page.click('[data-sq="g6"]');
  await expect(page.locator('.explain')).toContainText('Best:', { timeout: 30_000 });
  await expect(page.locator('[aria-label="Return to game"]')).toBeVisible();
  await page.screenshot({ path: `${EVID}/review-explore-${n}.png` });
  await page.click('[aria-label="Return to game"]');
  await expect(page.locator('.strip button').nth(4)).toHaveClass(/cur/);
  // narrow phone
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator('.strip button').nth(5).click();
  await noOverflow(page);
  for (const sel of ['[aria-label="Next move"]', '[aria-label="Previous move"]', '[aria-label="Show best move"]', '[aria-label="Close review"]']) {
    const b = await page.locator(sel).boundingBox();
    expect(b!.x).toBeGreaterThanOrEqual(0); expect(b!.x + b!.width).toBeLessThanOrEqual(320); expect(b!.height).toBeGreaterThanOrEqual(40);
  }
  await page.screenshot({ path: `${EVID}/review-320px-${n}.png`, fullPage: true });
  console.log('review sounds', JSON.stringify((await snd(page)).played));
  // history list with text labels
  await page.click('[aria-label="Close review"]');
  await page.click('[aria-label="Game history"]');
  await expect(page.locator('.hrow')).toContainText('Lost · checkmate');
  await page.screenshot({ path: `${EVID}/history-320px-${n}.png` });
  expect(errors).toEqual([]);
});
