import { test, expect } from '@playwright/test';
test('screens: chooser, timed play, history list', async ({ page }) => {
  const n = test.info().project.name;
  await page.addInitScript(() => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify({ moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'], player: 'b', resigned: null })); } });
  await page.goto('/');
  await page.locator('.overlay [aria-label="New game"]').click();
  await page.screenshot({ path: `test-results/chooser-${n}.png` });
  await page.click('[aria-label="Game history"]');
  await expect(page.locator('.hrow')).toHaveCount(1);
  await page.screenshot({ path: `test-results/history-${n}.png` });
  await page.click('[aria-label="Close history"]');
  await page.click('[aria-label="New game"]');
  await page.click('[aria-label="3 minutes per side"]');
  await page.click('[aria-label="Play as white"]');
  await page.click('[data-sq="e2"]'); await page.click('[data-sq="e4"]');
  await expect.poll(() => page.evaluate(() => (window as any).__chess.moves().length), { timeout: 30_000 }).toBe(2);
  await page.click('[data-sq="g1"]');
  await page.screenshot({ path: `test-results/play-clock-${n}.png` });
});
