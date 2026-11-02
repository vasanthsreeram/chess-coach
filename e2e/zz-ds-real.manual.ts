import { test, expect } from '@playwright/test';
const games = {
  scholar: { moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'], player: 'b', resigned: null },
  damiano: { moves: ['e2e4', 'e7e5', 'g1f3', 'f7f6', 'f3e5', 'f6e5', 'd1h5', 'e8e7', 'h5e5', 'e7f7', 'f1c4', 'd7d5', 'c4d5', 'f7g6'], player: 'b', resigned: 'b' },
};
for (const [name, g] of Object.entries(games)) test(`real DS ${name}`, async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript((d) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify(d)); } }, g);
  await page.goto('http://localhost:4180/');
  await page.locator('.overlay [aria-label="Review game"]').click();
  await expect(page.locator('.strip button')).toHaveCount(g.moves.length, { timeout: 120_000 });
  const plies = name === 'scholar' ? [5, 6, 0] : [3, 4, 6, 8];
  for (const i of plies) {
    await page.locator('.strip button').nth(i).click();
    const det = await page.locator('.explain').innerText();
    const res = await page.waitForResponse((r) => r.url().includes('/api/feedback'), { timeout: 30_000 }).catch(() => null);
    const body = res ? await res.json() : null;
    await page.waitForTimeout(300);
    const txt = await page.locator('.explain').innerText();
    const docH = await page.evaluate(() => document.documentElement.scrollHeight);
    console.log(`=== ${name} ply ${i} status=${res?.status()} model=${body?.model} docH=${docH}\n--- deterministic:\n${det}\n--- shown:\n${txt}`);
    await page.screenshot({ path: `test-results/ds-${name}-ply${i}.png` });
  }
});
