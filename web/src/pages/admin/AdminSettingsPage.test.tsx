import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AdminSettings } from '../../api/admin';
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

function body(call: unknown[] | undefined): Record<string, unknown> {
  const init = call?.[1] as RequestInit | undefined;
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

function renderSettings(settings: Partial<AdminSettings>): MockApi {
  const api = installMockApi({ session: makeUser({ role: 'admin' }), settings });
  renderApp(['/admin/settings']);
  return api;
}

describe('AdminSettingsPage', () => {
  it('loads the current settings values into the form', async () => {
    renderSettings({ serverName: 'My Aura', defaultQuality: '480p', maxQuality: '1080p' });

    expect(await screen.findByLabelText('Server name')).toHaveValue('My Aura');
    expect(screen.getByLabelText('Default quality')).toHaveValue('480p');
    expect(screen.getByLabelText('Maximum quality')).toHaveValue('1080p');
  });

  it('masks the TMDB key and reveals it on toggle', async () => {
    renderSettings({ tmdbApiKey: 'secret-key-123' });

    const key = await screen.findByLabelText(/TMDB API key/);
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveValue('secret-key-123');
    expect(screen.getByText('Set')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(key).toHaveAttribute('type', 'text');
  });

  it('saves only the changed fields via PATCH', async () => {
    const api = renderSettings({ serverName: 'My Aura', baseUrl: '' });
    const name = await screen.findByLabelText('Server name');

    fireEvent.change(name, { target: { value: 'Renamed Aura' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(lastCall(api, '/settings', 'PATCH')).toBeDefined());
    expect(body(lastCall(api, '/settings', 'PATCH'))).toEqual({ serverName: 'Renamed Aura' });
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
  });

  it('reports no changes when re-saving without further edits', async () => {
    const api = renderSettings({ serverName: 'My Aura' });
    const name = await screen.findByLabelText('Server name');
    const patchCount = () =>
      api.fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/settings') &&
          (init?.method ?? 'GET').toUpperCase() === 'PATCH',
      ).length;

    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    const afterFirst = patchCount();
    expect(afterFirst).toBe(1);

    // The baseline advanced, so a second save with no edits is a no-op.
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('No changes to save.')).toBeInTheDocument();
    expect(patchCount()).toBe(afterFirst);
  });
});
