import { expect, test } from '@playwright/test';

import { ensureLibraryWithMovie, loginOrRegisterAdmin } from './helpers';

// Happy path: first user registers → becomes admin → creates a library pointed
// at the mounted fixture media → scans → the movie appears → open detail →
// Play → the player mounts and the stream decision succeeds.
test.describe.configure({ mode: 'serial' });

test('register → grant(admin) → browse → play', async ({ page }) => {
  // First registration becomes admin (asserted inside the helper).
  await loginOrRegisterAdmin(page);

  // Create/reuse the library, scan it, and wait for the fixture movie to index.
  // Leaves us on the movie detail page with the Play button visible.
  await ensureLibraryWithMovie(page);

  // Clicking Play must issue a successful playback decision and mount the
  // player. We don't assert pixel playback — the decide request returning OK
  // plus the <video> mounting is the contract.
  const decision = page.waitForResponse(
    (res) => res.url().includes('/api/stream/decide/') && res.request().method() === 'POST',
  );
  await page.getByRole('link', { name: 'Play', exact: true }).click();
  await page.waitForURL(/\/player\//);

  const decideResponse = await decision;
  expect(decideResponse.ok()).toBeTruthy();

  await expect(page.getByTestId('player-stage')).toBeVisible();
  await expect(page.getByTestId('player-video')).toHaveCount(1);
});
