import { test, expect, devices, type Browser, type Page } from '@playwright/test';

async function player(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page, errors };
}
const sq = (p: Page, s: string) => p.locator(`[data-sq="${s}"]`);
async function move(p: Page, from: string, to: string) { await sq(p, from).click(); await sq(p, to).click(); }
const online = (p: Page) => p.evaluate(() => (window as any).__chess.online());
const moves = (p: Page) => p.evaluate(() => (window as any).__chess.moves());

async function createFriendGame(p: Page, minutes: 1 | 3 | 10, side: 'white' | 'black', fresh = true) {
  if (fresh) await p.goto('/');
  await p.getByRole('radio', { name: 'Play against a friend with an invite link' }).click();
  await p.getByRole('radio', { name: `${minutes} minute${minutes > 1 ? 's' : ''} per side` }).click();
  await p.getByRole('button', { name: `Play as ${side}` }).click();
  const link = p.getByRole('textbox', { name: 'Invite link' });
  await expect(link).toBeVisible();
  return link.inputValue();
}

test('two browsers: invite, legal and prohibited moves, convergence, spectator, reconnect, checkmate, review into history; bot game untouched', async ({ browser }) => {
  const A = await player(browser), B = await player(browser), S = await player(browser);
  // A has an unfinished bot game saved; the online game must not overwrite it.
  await A.page.goto('/');
  await A.page.getByRole('button', { name: 'Play as white' }).click();
  await move(A.page, 'e2', 'e4');
  await expect.poll(() => moves(A.page).then((m) => m.length), { timeout: 20_000 }).toBe(2);
  const botSave = await A.page.evaluate(() => localStorage.getItem('chess-minimal.v1'));
  expect(botSave).toContain('e2e4');

  await A.page.getByRole('button', { name: 'New game' }).click();
  const url = await createFriendGame(A.page, 3, 'white', false);
  expect(url).toMatch(/#room=[A-Za-z0-9_-]{22}$/);
  await expect(A.page.locator('.status')).toHaveText(/Waiting for your friend/);

  await B.page.goto(url);
  await expect(B.page.locator('.status')).toHaveText('Opponent to move.');
  await expect(A.page.locator('.status')).toHaveText(/Your move/);
  await expect(A.page.getByRole('textbox', { name: 'Invite link' })).toHaveCount(0);
  expect((await online(B.page)).view.you).toBe('b');

  // Spectator: the link after both seats are taken is watch-only.
  await S.page.goto(url);
  await expect(S.page.locator('.status')).toHaveText(/Watching/);

  // Prohibited: Black moving first, Black moving White's pawn, spectator moving.
  await move(B.page, 'e7', 'e5');
  await move(B.page, 'e2', 'e4');
  await move(S.page, 'e2', 'e4');
  await B.page.waitForTimeout(500);
  expect(await moves(A.page)).toEqual([]);

  await move(A.page, 'f2', 'f3');
  for (const p of [A.page, B.page, S.page]) await expect.poll(() => moves(p)).toEqual(['f3']);
  // A cannot move twice.
  await move(A.page, 'g2', 'g4');
  await A.page.waitForTimeout(400);
  expect(await moves(B.page)).toEqual(['f3']);
  await move(B.page, 'e7', 'e5');
  await expect.poll(() => moves(A.page)).toEqual(['f3', 'e5']);

  // Reconnect: drop B's socket, and separately reload A; both resume their seats.
  await B.page.evaluate(() => (window as any).__chess.dropSocket());
  await expect.poll(async () => (await online(B.page)).status).toBe('open');
  await A.page.reload();
  await expect.poll(async () => (await online(A.page))?.view?.you).toBe('w');
  expect(await moves(A.page)).toEqual(['f3', 'e5']);

  await move(A.page, 'g2', 'g4');
  await expect.poll(() => moves(B.page)).toEqual(['f3', 'e5', 'g4']);
  await move(B.page, 'd8', 'h4');
  for (const p of [A.page, B.page, S.page]) await expect.poll(() => moves(p)).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
  await expect(A.page.locator('.overlay[data-result="loss"][data-how="checkmate"]')).toBeVisible();
  await expect(B.page.locator('.overlay[data-result="win"][data-how="checkmate"]')).toBeVisible();
  await expect(S.page.locator('.overlay[data-how="checkmate"]')).toBeVisible();

  // Finished online game lands in both players' existing history and opens in the existing review.
  for (const P of [A, B]) {
    const h = await P.page.evaluate(() => (window as any).__chess.history());
    const rec = h.find((r: any) => r.id.startsWith('online-'));
    expect(rec).toMatchObject({ moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], tc: 3, result: { winner: 'b', how: 'checkmate' } });
  }
  expect(await S.page.evaluate(() => (window as any).__chess.history().length)).toBe(0);
  await B.page.getByRole('button', { name: 'Review game' }).last().click();
  await expect(B.page.getByRole('heading', { name: 'Move analysis' })).toBeVisible();
  await expect.poll(() => B.page.evaluate(() => (window as any).__chess.review()?.length ?? 0), { timeout: 60_000 }).toBe(4);

  // The saved bot game is byte-identical, and resumes when A starts back from the bare URL.
  expect(await A.page.evaluate(() => localStorage.getItem('chess-minimal.v1'))).toBe(botSave);
  await A.page.goto('/');
  await expect.poll(() => moves(A.page)).toHaveLength(2);
  expect((await moves(A.page))[0]).toBe('e4');
  for (const P of [A, B, S]) { expect(P.errors).toEqual([]); await P.ctx.close(); }
});

test('a slow invite join never accepts a move as a bot game', async ({ browser }) => {
  const A = await player(browser, devices['Pixel 7']), B = await player(browser, devices['Pixel 7']);
  const url = await createFriendGame(A.page, 3, 'black');
  await B.page.route('**/api/rooms/*/join', async (route) => { await new Promise((resolve) => setTimeout(resolve, 1800)); await route.continue(); });
  await B.page.goto(url);
  await expect(B.page.locator('.status')).toHaveText('Connecting…');
  await sq(B.page, 'e2').tap(); await sq(B.page, 'e4').tap();
  expect(await moves(B.page)).toEqual([]);
  await expect(B.page.locator('.status')).toHaveText(/You play white/);
  await sq(B.page, 'e2').tap(); await sq(B.page, 'e4').tap();
  await expect.poll(() => moves(A.page)).toEqual(['e4']);
  for (const P of [A, B]) { expect(P.errors).toEqual([]); await P.ctx.close(); }
});

test('mobile: invite via share sheet, join on a second phone, server flags on time (1 minute)', async ({ browser }) => {
  const phone = { ...devices['Pixel 7'] };
  const A = await player(browser, phone), B = await player(browser, phone);
  await A.page.addInitScript(() => { (navigator as any).share = async (d: any) => { (window as any).__shared = d.url; }; });
  await createFriendGame(A.page, 1, 'black');
  await A.page.getByRole('button', { name: 'Share invite link' }).tap();
  const url = await A.page.evaluate(() => (window as any).__shared);
  expect(url).toMatch(/#room=/);
  const box = await A.page.getByRole('dialog', { name: 'Invite a friend' }).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(412);

  // Simulate a slow invite join: the board must not briefly behave like a bot game.
  await B.page.route('**/api/rooms/*/join', async (route) => { await new Promise((resolve) => setTimeout(resolve, 1500)); await route.continue(); });
  await B.page.goto(url);
  await expect(B.page.locator('.status')).toHaveText('Connecting…');
  await sq(B.page, 'e2').tap(); await sq(B.page, 'e4').tap();
  expect(await moves(B.page)).toEqual([]);
  await expect(B.page.locator('.status')).toHaveText(/You play white/);
  await sq(B.page, 'e2').tap(); await sq(B.page, 'e4').tap();
  await expect.poll(() => moves(A.page)).toEqual(['e4']);
  // Black never moves: the server flags Black after 60 s of its own time, with no client involvement.
  await expect(A.page.locator('.overlay[data-result="loss"][data-how="timeout"]')).toBeVisible({ timeout: 75_000 });
  await expect(B.page.locator('.overlay[data-result="win"][data-how="timeout"]')).toBeVisible({ timeout: 5_000 });
  await expect(A.page.locator('.clock[data-side="b"] .t')).toHaveText('0:00');
  for (const P of [A, B]) { expect(P.errors).toEqual([]); await P.ctx.close(); }
});

test('expired or unknown link shows an error and falls back to the new-game dialog', async ({ browser }) => {
  const A = await player(browser);
  await A.page.goto(`/#room=${'Z'.repeat(22)}`);
  await expect(A.page.getByRole('alert')).toHaveText(/expired or does not exist/);
  await expect(A.page.getByRole('dialog', { name: 'New game' })).toBeVisible();
  await A.ctx.close();
});
