import { test, expect, type Page } from '@playwright/test';

const api = (page: Page) => ({
  st: () => page.evaluate(() => { const c = (window as any).__chess; return { fen: c.fen(), n: c.moves().length, mode: c.mode(), clock: c.clock(), result: c.result(), history: c.history() }; }),
});
const errorsOf = (page: Page) => { const e: string[] = []; page.on('pageerror', (x) => e.push(String(x))); page.on('console', (m) => { if (m.type() === 'error') e.push(m.text()); }); return e; };
const STORE = 'chess-minimal.v1';
const SCHOLAR = { moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'], player: 'b', resigned: null };

for (const m of [1, 3, 10]) {
  test(`${m}-minute control: both clocks show ${m}:00, then switch and run on moves`, async ({ page }) => {
    const errors = errorsOf(page);
    await page.goto('/');
    await page.click(`[aria-label="${m} minute${m > 1 ? 's' : ''} per side"]`);
    await page.click('[aria-label="Play as white"]');
    await expect(page.locator('.clock')).toHaveCount(2);
    await expect(page.locator('.clock[data-side="w"] .t')).toHaveText(`${m}:00`);
    await expect(page.locator('.clock[data-side="b"] .t')).toHaveText(`${m}:00`);
    await page.click('[data-sq="e2"]'); await page.click('[data-sq="e4"]');
    await expect.poll(async () => (await api(page).st()).n, { timeout: 30_000 }).toBe(2);
    const s = await api(page).st();
    expect(s.clock.b).toBeLessThan(m * 60_000);      // bot paid for its engine time
    expect(s.clock.b).toBeGreaterThan(m * 60_000 - 5_000);
    await page.waitForTimeout(1500);
    const s2 = await api(page).st();
    expect(s2.clock.w).toBeLessThan(m * 60_000 - 1_000); // white's clock now running
    await expect(page.locator('.clock[data-side="w"]')).toHaveClass(/on/);
    expect(errors).toEqual([]);
  });
}

test('1-minute game: elapsed time survives reload, real flag ends game, no moves after, history recorded once', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = errorsOf(page);
  await page.goto('/');
  await page.click('[aria-label="1 minute per side"]');
  await page.click('[aria-label="Play as white"]');
  await page.click('[data-sq="d2"]'); await page.click('[data-sq="d4"]');
  await expect.poll(async () => (await api(page).st()).n, { timeout: 30_000 }).toBe(2);
  await page.waitForTimeout(5_000);
  const before = (await api(page).st()).clock.w;
  await page.reload();
  const after = (await api(page).st()).clock.w;
  console.log('white ms before reload', Math.round(before), 'after reload', Math.round(after));
  expect(after).toBeLessThanOrEqual(before);
  expect(after).toBeLessThan(56_000);
  // Wait for the real flag.
  await expect(page.locator('.overlay[data-how="timeout"]')).toBeVisible({ timeout: 70_000 });
  await expect(page.locator('.overlay[data-result="loss"]')).toBeVisible();
  const s = await api(page).st();
  expect(s.clock.w).toBe(0);
  expect(s.result).toEqual({ winner: 'b', how: 'timeout' });
  // No moves after expiry.
  await page.locator('[data-sq="e2"]').click({ force: true });
  await page.locator('[data-sq="e4"]').click({ force: true });
  expect((await api(page).st()).n).toBe(2);
  expect(s.history.length).toBe(1);
  expect(s.history[0].result.how).toBe('timeout');
  await page.reload();
  const r = await api(page).st();
  expect(r.history.length).toBe(1);
  expect(r.mode).toBe('over');
  await page.screenshot({ path: `test-results/flag-${test.info().project.name}.png` });
  expect(errors).toEqual([]);
});

test('boundary: clock already expired while away flags on load; 1.2 s left flags without moving', async ({ page }) => {
  const errors = errorsOf(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('chess-minimal.v1', JSON.stringify({ id: 'away', moves: ['e2e4', 'e7e5'], player: 'w', resigned: null, flagged: null, tc: 1, clock: { w: 30_000, b: 50_000, since: Date.now() - 31_000 } }));
  });
  await page.goto('/');
  await expect(page.locator('.overlay[data-how="timeout"][data-result="loss"]')).toBeVisible();
  expect((await api(page).st()).n).toBe(2);
  await page.evaluate(() => localStorage.setItem('chess-minimal.v1', JSON.stringify({ id: 'edge', moves: ['e2e4', 'e7e5'], player: 'w', resigned: null, flagged: null, tc: 1, clock: { w: 1_200, b: 50_000, since: Date.now() } })));
  await page.reload();
  await expect(page.locator('.clock[data-side="w"]')).toHaveClass(/low/);
  await expect(page.locator('.overlay[data-how="timeout"]')).toBeVisible({ timeout: 3_000 });
  const h = (await api(page).st()).history;
  expect(h.map((x: any) => x.id).sort()).toEqual(['away', 'edge']);
  expect(errors).toEqual([]);
});

test('legacy data: finished game migrated to history once; in-progress game preserved', async ({ page }) => {
  const errors = errorsOf(page);
  await page.addInitScript((d) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify(d)); } }, SCHOLAR);
  await page.goto('/');
  await expect(page.locator('.overlay[data-result="loss"]')).toBeVisible();
  let s = await api(page).st();
  expect(s.history.length).toBe(1);
  expect(s.history[0].id).toMatch(/^legacy-/);
  await page.reload(); await page.reload();
  s = await api(page).st();
  expect(s.history.length).toBe(1);
  // Legacy in-progress (untimed) game
  await page.evaluate(() => localStorage.setItem('chess-minimal.v1', JSON.stringify({ moves: ['e2e4', 'c7c5', 'g1f3'], player: 'w', resigned: null })));
  await page.reload();
  s = await api(page).st();
  expect(s.n).toBe(3); expect(s.mode).toBe('play'); expect(s.clock).toBe(null);
  await expect.poll(async () => (await api(page).st()).n, { timeout: 30_000 }).toBe(4); // bot answers as black
  expect((await api(page).st()).history.length).toBe(1);
  expect(errors).toEqual([]);
});

test('history reopen after new game: explanation, explore alternative line, undo, return; archive unchanged', async ({ page }) => {
  const errors = errorsOf(page);
  await page.addInitScript((d) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify(d)); } }, SCHOLAR);
  await page.goto('/');
  await expect(page.locator('.overlay[data-result="loss"]')).toBeVisible();
  // Start a new game, then reload: history must still list the old game.
  await page.locator('.overlay [aria-label="New game"]').click();
  await page.click('[aria-label="Play as white"]');
  await page.reload();
  await page.click('[aria-label="Game history"]');
  await expect(page.locator('.hrow')).toHaveCount(1);
  await expect(page.locator('.hrow')).toContainText('Lost · checkmate');
  await page.locator('.hrow').click();
  await expect(page.locator('.strip button')).toHaveCount(7, { timeout: 60_000 });
  // The blunder Nf6 (ply 6) is auto-selected.
  const text = await page.locator('.explain').innerText();
  console.log('EXPLANATION Nf6:\n' + text);
  expect(text).toContain('Blunder: 3... Nf6');
  expect(text).toContain('This allows mate in 1 for White: queen h5 takes pawn f7 (Qxf7#).');
  expect(text).toMatch(/Better: Black's \w+ /);
  // Explore from the position after 3.Qh5 (black to move): try 3...g6, then 4.Qf3 Nf6.
  await page.locator('.strip button').nth(4).click();
  const archivedFen = await page.evaluate(() => (window as any).__chess.shownFen());
  for (const [a, b] of [['g7', 'g6'], ['h5', 'f3'], ['g8', 'f6']]) { await page.click(`[data-sq="${a}"]`); await page.click(`[data-sq="${b}"]`); }
  await expect(page.locator('.explain .head')).toContainText('3... g6 4. Qf3 Nf6');
  await expect(page.locator('.explain')).toContainText(/Engine: .* for White to move\. Best: /, { timeout: 30_000 });
  const ex = await page.evaluate(() => ({ fen: (window as any).__chess.shownFen(), ev: (window as any).__chess.exEval() }));
  expect(ex.ev.fen).toBe(ex.fen); // no stale engine result
  console.log('EXPLORE:\n' + await page.locator('.explain').innerText());
  await page.screenshot({ path: `test-results/explore-${test.info().project.name}.png` });
  await page.click('[aria-label="Undo explored move"]');
  await expect(page.locator('.explain .head')).toContainText('3... g6 4. Qf3');
  await expect(page.locator('.explain')).toContainText(/for Black to move/, { timeout: 30_000 });
  await page.click('[aria-label="Return to game"]');
  expect(await page.evaluate(() => (window as any).__chess.shownFen())).toBe(archivedFen);
  await expect(page.locator('.strip button').nth(4)).toHaveClass(/cur/);
  const h = (await api(page).st()).history;
  expect(h[0].moves).toEqual(['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
  expect(h[0].evals.length).toBe(8); // review cached with the record
  // Close review returns to the new, unstarted game.
  await page.click('[aria-label="Close review"]');
  expect((await api(page).st()).n).toBe(0);
  expect(errors).toEqual([]);
});

test('explore: promotion choice and end state in an explored line', async ({ page }) => {
  const errors = errorsOf(page);
  await page.addInitScript(() => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify({ moves: ['h2h4', 'g7g5', 'h4g5', 'h7h6', 'g5h6', 'g8f6', 'h6h7', 'f6g8'], player: 'w', resigned: 'b' })); } });
  await page.goto('/');
  await page.locator('.overlay [aria-label="Review game"]').click();
  await expect(page.locator('.strip button')).toHaveCount(8, { timeout: 60_000 });
  await page.locator('.strip button').nth(7).click();
  await page.click('[data-sq="h7"]'); await page.click('[data-sq="g8"]');
  await page.click('[aria-label="Promote to knight"]');
  await expect(page.locator('.explain .head')).toContainText('hxg8=N');
  await expect(page.locator('.explain')).toContainText('Best:', { timeout: 30_000 });
  expect((await api(page).st()).history[0].moves.length).toBe(8);
  expect(errors).toEqual([]);
});

test('inaccuracy/mistake in a real engine review has a recommended move and grounded text', async ({ page }) => {
  // 1.e4 e5 2.Nf3 f6?! 3.Nxe5 ... (Damiano) — then resigned.
  await page.addInitScript(() => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('chess-minimal.v1', JSON.stringify({ moves: ['e2e4', 'e7e5', 'g1f3', 'f7f6', 'b1c3', 'd7d6', 'a2a3', 'a7a6'], player: 'w', resigned: 'w' })); } });
  await page.goto('/');
  await page.locator('.overlay [aria-label="Review game"]').click();
  await expect(page.locator('.strip button')).toHaveCount(8, { timeout: 60_000 });
  const review = await page.evaluate(() => (window as any).__chess.review());
  console.log('qualities', review.map((r: any) => `${r.san}:${r.quality}`).join(' '));
  const i = review.findIndex((r: any) => r.quality === 'inaccuracy' || r.quality === 'mistake');
  expect(i).toBeGreaterThanOrEqual(0);
  await page.locator('.strip button').nth(i).click();
  const text = await page.locator('.explain').innerText();
  console.log('EXPLANATION:\n' + text);
  expect(text).toMatch(/^(Inaccuracy|Mistake): /m);
  expect(text).toMatch(/Better: (White|Black)'s \w+ /);
  expect(text).not.toMatch(/undefined|NaN/);
  await page.screenshot({ path: `test-results/inaccuracy-${test.info().project.name}.png` });
});
