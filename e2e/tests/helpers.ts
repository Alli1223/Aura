import { expect, type Page } from '@playwright/test';

// Shared flows/selectors for the Aura e2e suite. Selectors prefer role/label/
// text over test ids (matching the real UI in web/src); the only test ids used
// are the player's own `data-testid` hooks that already ship in the app.

/** Fixed admin identity. The suite's first-ever registration becomes admin. */
export const ADMIN = {
  username: 'e2e_admin',
  password: 'e2e-admin-password-1',
} as const;

/** The library the suite creates/reuses, pointed at the mounted fixture dir. */
export const E2E_LIBRARY_NAME = 'E2E Movies';

/**
 * Absolute path (inside the server's MEDIA_ROOTS) of the fixture movies folder.
 * The container mounts the fixtures at /media, so the default matches CI; a
 * non-docker local run points MEDIA_ROOTS at e2e/fixtures/media and sets
 * E2E_LIBRARY_PATH to `<that>/e2e-movies`.
 */
export const E2E_LIBRARY_PATH = process.env.E2E_LIBRARY_PATH ?? '/media/e2e-movies';

/** The scanned fixture surfaces as a movie whose title contains "Test Movie". */
export const MOVIE_TITLE_RE = /Test Movie/i;

let usernameSeq = 0;
/** A fresh, schema-valid (lowercase [a-z0-9._-], 3–32 chars) username per call. */
export function uniqueUsername(prefix: string): string {
  usernameSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${usernameSeq}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export interface Credentials {
  username: string;
  password: string;
}

/** Real ids captured off the live UI, reused for direct-navigation checks. */
export interface LibraryFixtureIds {
  libraryId: string;
  /** `/items/<id>` — the movie detail route. */
  itemHref: string;
  /** `/player/<mediaFileId>?item=<itemId>` — the player route. */
  playerHref: string;
  mediaFileId: string;
  itemId: string | null;
}

// ---- Auth flows -------------------------------------------------------------

async function submitRegister(page: Page, creds: Credentials): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Username', { exact: true }).fill(creds.username);
  await page.getByLabel('Password', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function submitLogin(page: Page, creds: Credentials): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(creds.username);
  await page.getByLabel('Password', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * Establishes an authenticated admin session. On a pristine backend this
 * registers the very first user (who becomes admin); on a re-run the username
 * is already taken, so it falls back to logging in. Either way it asserts the
 * session is an admin (the sidebar's "Admin" link), which also proves the
 * "first user becomes admin" first-run rule.
 */
export async function loginOrRegisterAdmin(page: Page): Promise<void> {
  await submitRegister(page, ADMIN);

  const adminLink = page.getByRole('link', { name: 'Admin', exact: true });
  const errorAlert = page.getByRole('alert');
  await expect(adminLink.or(errorAlert)).toBeVisible();

  if (await errorAlert.isVisible()) {
    // Already registered on a prior run/attempt — sign in instead.
    await submitLogin(page, ADMIN);
  }
  await expect(adminLink).toBeVisible();
}

/**
 * Registers a brand-new normal user via the UI and asserts they land in the app
 * shell as a NON-admin (no "Admin" link). Because an admin already exists by the
 * time this runs, the new account is always a regular user.
 */
export async function registerNormalUser(page: Page, creds: Credentials): Promise<void> {
  await submitRegister(page, creds);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
}

// ---- Admin: library + scan --------------------------------------------------

function libraryIdFromUrl(url: string): string {
  const match = new URL(url).pathname.match(/\/library\/([^/]+)/);
  return match?.[1] ?? '';
}

/**
 * Ensures the E2E movie library exists, is scanned, and its fixture movie is
 * indexed — then captures the real library/item/player ids off the UI. Leaves
 * `adminPage` on the movie detail page (Play button visible). Idempotent:
 * reuses the library if a prior spec already created it.
 *
 * Requires `adminPage` to already be an authenticated admin session.
 */
export async function ensureLibraryWithMovie(adminPage: Page): Promise<LibraryFixtureIds> {
  await adminPage.goto('/admin/libraries');
  // Wait for the libraries list to finish loading before deciding whether to
  // create — the "New library" button only renders once the query resolves, and
  // the cards render in the same commit. Checking existence any earlier races
  // the loading spinner and would wrongly re-create an existing library.
  await expect(adminPage.getByRole('button', { name: 'New library' })).toBeVisible();

  const card = adminPage.locator('article').filter({ hasText: E2E_LIBRARY_NAME });
  if ((await card.count()) === 0) {
    await adminPage.getByRole('button', { name: 'New library' }).click();
    const dialog = adminPage.getByRole('dialog', { name: 'New library' });
    await dialog.getByLabel('Name', { exact: true }).fill(E2E_LIBRARY_NAME);
    // Type defaults to "movies"; only the fixture path needs setting.
    await dialog.getByLabel('Path 1', { exact: true }).fill(E2E_LIBRARY_PATH);
    await dialog.getByRole('button', { name: 'Create library' }).click();
    // The dialog closes only on a successful create; wait for it so its scrim
    // never intercepts the Scan click below.
    await expect(dialog).toBeHidden();
    await expect(card).toHaveCount(1);
  }

  // Trigger a scan (a 409 "already running" surfaces as an inline message and is
  // harmless — we wait on the indexed result below regardless).
  await card.getByRole('button', { name: 'Scan', exact: true }).click();

  // Open the library and poll (reloading) until the fixture movie is indexed.
  await adminPage.getByRole('link', { name: E2E_LIBRARY_NAME, exact: true }).click();
  await adminPage.waitForURL(/\/library\/[^/]+$/);
  const libraryId = libraryIdFromUrl(adminPage.url());

  const poster = adminPage.getByRole('link', { name: MOVIE_TITLE_RE }).first();
  await expect(async () => {
    await adminPage.reload();
    await expect(poster).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  const itemHref = (await poster.getAttribute('href')) ?? '';

  // Open the movie detail and read the Play target (carries the media file id).
  await poster.click();
  await adminPage.waitForURL(/\/items\/[^/?]+/);
  const playLink = adminPage.getByRole('link', { name: 'Play', exact: true });
  await expect(playLink).toBeVisible();
  const playerHref = (await playLink.getAttribute('href')) ?? '';

  const playerUrl = new URL(playerHref, adminPage.url());
  const mediaFileId = decodeURIComponent(playerUrl.pathname.split('/').pop() ?? '');
  const itemId = playerUrl.searchParams.get('item');

  return { libraryId, itemHref, playerHref, mediaFileId, itemId };
}

/**
 * Sets one access-matrix cell to the desired state and asserts it settles there.
 *
 * The matrix checkbox is optimistically updated and disables itself while the
 * grant/revoke is in flight, which makes Playwright's `check()` (click + assert
 * the state flipped synchronously) racy. A plain `click()` (which does not
 * assert an immediate flip) followed by an auto-waiting `toBeChecked` is stable.
 */
export async function setLibraryAccess(
  adminPage: Page,
  username: string,
  granted: boolean,
  libraryName: string = E2E_LIBRARY_NAME,
): Promise<void> {
  const checkbox = adminPage.getByRole('checkbox', {
    name: `Grant ${username} access to ${libraryName}`,
  });
  await expect(checkbox).toBeVisible();
  if ((await checkbox.isChecked()) !== granted) {
    await checkbox.click();
  }
  await expect(checkbox).toBeChecked({ checked: granted });
}

/** Grants a user access to a library via the admin access-grant matrix. */
export async function grantAccess(
  adminPage: Page,
  username: string,
  libraryName: string = E2E_LIBRARY_NAME,
): Promise<void> {
  await adminPage.goto('/admin/access');
  await setLibraryAccess(adminPage, username, true, libraryName);
}
