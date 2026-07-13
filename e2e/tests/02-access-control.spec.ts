import { expect, test } from '@playwright/test';

import {
  E2E_LIBRARY_NAME,
  MOVIE_TITLE_RE,
  ensureLibraryWithMovie,
  grantAccess,
  loginOrRegisterAdmin,
  registerNormalUser,
  uniqueUsername,
} from './helpers';

// Per-user access control, end-to-end: a fresh normal user can see nothing and
// is denied direct navigation to the library/item/stream URLs, until an admin
// grants access — after which the same URLs work. Proves the server-side grant
// enforcement (not just UI hiding), including the stream decision 404 cloak.
test.describe.configure({ mode: 'serial' });

test('a new user is denied until an admin grants library access', async ({ browser }) => {
  // Admin context: ensure the scanned library exists and capture real ids.
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginOrRegisterAdmin(adminPage);
  const ids = await ensureLibraryWithMovie(adminPage);

  // A brand-new normal user in a completely fresh browser context.
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  const user = { username: uniqueUsername('e2e_user'), password: 'e2e-user-password-1' };
  await registerNormalUser(userPage, user);

  // --- Before any grant: nothing is visible or reachable. ---

  // Sidebar shows no libraries. Scope to the (single) visible primary nav — the
  // app renders a second, hidden sidebar for the mobile drawer, and getByText
  // matches hidden nodes too, whereas getByRole('navigation') excludes them.
  await expect(
    userPage.getByRole('navigation', { name: 'Primary' }).getByText('No libraries yet'),
  ).toBeVisible();
  await expect(userPage.getByRole('link', { name: E2E_LIBRARY_NAME, exact: true })).toHaveCount(0);

  // Direct navigation to the library id is 404-cloaked in the UI.
  await userPage.goto(`/library/${ids.libraryId}`);
  await expect(userPage.getByText('Library not found')).toBeVisible();

  // Direct navigation to the item id is 404-cloaked in the UI.
  await userPage.goto(ids.itemHref);
  await expect(userPage.getByText('Not found', { exact: true })).toBeVisible();

  // Direct navigation to the player: the stream decision is refused server-side
  // (404), and the player surfaces "Unavailable".
  const deniedDecision = userPage.waitForResponse((res) =>
    res.url().includes('/api/stream/decide/'),
  );
  await userPage.goto(ids.playerHref);
  expect((await deniedDecision).status()).toBe(404);
  await expect(userPage.getByText('Unavailable')).toBeVisible();

  // --- Admin grants access. ---
  await grantAccess(adminPage, user.username, E2E_LIBRARY_NAME);

  // --- After the grant: the user can see and browse the library. ---
  await userPage.goto('/');
  const libraryLink = userPage.getByRole('link', { name: E2E_LIBRARY_NAME, exact: true });
  await expect(libraryLink).toBeVisible();
  await libraryLink.click();
  await expect(userPage.getByRole('link', { name: MOVIE_TITLE_RE }).first()).toBeVisible();

  await adminContext.close();
  await userContext.close();
});
