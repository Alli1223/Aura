import { expect, test } from '@playwright/test';

import {
  E2E_LIBRARY_NAME,
  ensureLibraryWithMovie,
  loginOrRegisterAdmin,
  setLibraryAccess,
  uniqueUsername,
} from './helpers';

// Admin flows: the access-grant matrix toggles a grant that persists (takes
// effect server-side), and a basic user-management action (changing a user's
// max quality) persists across a reload.
test.describe.configure({ mode: 'serial' });

test('access matrix toggle and a user-management action take effect', async ({ page, request }) => {
  await loginOrRegisterAdmin(page);
  // Ensure the E2E library exists so the matrix has a column to toggle.
  await ensureLibraryWithMovie(page);

  // A fresh target user (registered via the API — an admin already exists, so
  // this account is always a regular user).
  const target = { username: uniqueUsername('e2e_target'), password: 'e2e-target-password-1' };
  const registration = await request.post('/api/auth/register', { data: target });
  expect(registration.ok()).toBeTruthy();

  // --- Access grant matrix: toggle a grant, confirm it persisted. ---
  await page.goto('/admin/access');
  const cellName = `Grant ${target.username} access to ${E2E_LIBRARY_NAME}`;
  await expect(page.getByRole('checkbox', { name: cellName })).not.toBeChecked();

  await setLibraryAccess(page, target.username, true);

  // Reload proves the grant persisted server-side (took effect), not just in the
  // optimistic cache.
  await page.reload();
  await expect(page.getByRole('checkbox', { name: cellName })).toBeChecked();

  // --- User management: change the user's max quality, confirm it persisted. ---
  await page.goto('/admin');
  const qualitySelect = page.getByRole('combobox', {
    name: `Max quality for ${target.username}`,
  });
  await expect(qualitySelect).toBeVisible();
  await qualitySelect.selectOption('720p');

  await page.reload();
  await expect(
    page.getByRole('combobox', { name: `Max quality for ${target.username}` }),
  ).toHaveValue('720p');
});
