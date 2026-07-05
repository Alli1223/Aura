import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AccessMatrix } from '../../api/admin';
import { installMockApi, makeUser, type MockApi } from '../../test/mockApi';
import { renderApp } from '../../test/renderApp';

function lastCall(api: MockApi, suffix: string, method: string) {
  return [...api.fetchMock.mock.calls]
    .reverse()
    .find(
      ([url, init]) =>
        String(url).endsWith(suffix) &&
        (init?.method ?? 'GET').toUpperCase() === method.toUpperCase(),
    );
}

const MATRIX: AccessMatrix = {
  users: [
    { id: 'u1', username: 'alice', role: 'user', isEnabled: true, libraryIds: ['libA'] },
    { id: 'u2', username: 'bob', role: 'user', isEnabled: true, libraryIds: [] },
  ],
  libraries: [
    { id: 'libA', name: 'Movies', type: 'movies' },
    { id: 'libB', name: 'TV', type: 'tv' },
  ],
};

function renderAccess(matrix: AccessMatrix = MATRIX): MockApi {
  const api = installMockApi({ session: makeUser({ role: 'admin' }), access: matrix });
  renderApp(['/admin/access']);
  return api;
}

describe('AdminAccessPage', () => {
  it('renders the user x library grid with the correct checked state', async () => {
    renderAccess();
    await screen.findByText('alice');

    expect(screen.getByRole('checkbox', { name: 'Grant alice access to Movies' })).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Grant alice access to TV' }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Grant bob access to Movies' }),
    ).not.toBeChecked();
  });

  it('grants access optimistically and calls POST', async () => {
    const api = renderAccess();
    await screen.findByText('bob');

    const cell = screen.getByRole('checkbox', { name: 'Grant bob access to Movies' });
    fireEvent.click(cell);

    // Optimistic cache update flips the cell before the settle refetch.
    await waitFor(() => expect(cell).toBeChecked());
    await waitFor(() => expect(lastCall(api, '/libraries/libA/access', 'POST')).toBeDefined());
  });

  it('revokes access optimistically and calls DELETE', async () => {
    const api = renderAccess();
    await screen.findByText('alice');

    const cell = screen.getByRole('checkbox', { name: 'Grant alice access to Movies' });
    expect(cell).toBeChecked();
    fireEvent.click(cell);

    await waitFor(() => expect(cell).not.toBeChecked());
    await waitFor(() =>
      expect(lastCall(api, '/libraries/libA/access/u1', 'DELETE')).toBeDefined(),
    );
  });
});
