import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { installMockApi, makeQualities, makeUser, type MockApi } from '../test/mockApi';
import { renderApp } from '../test/renderApp';

// Bodies of PATCH /api/users/me calls (the preferences save).
function patchMeBodies(api: MockApi): Record<string, unknown>[] {
  return api.fetchMock.mock.calls
    .filter(([url, init]) => {
      const path = new URL(String(url), 'http://localhost').pathname;
      return path === '/api/users/me' && (init as RequestInit | undefined)?.method === 'PATCH';
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

async function loadSettings(): Promise<HTMLSelectElement> {
  const quality = (await screen.findByLabelText('Default quality')) as HTMLSelectElement;
  // The quality select is disabled until GET /api/qualities resolves.
  await waitFor(() => expect(quality.disabled).toBe(false));
  return quality;
}

describe('SettingsPage — Playback preferences', () => {
  it('loads the current preferences into the form', async () => {
    installMockApi({
      session: makeUser({
        preferredQuality: '480p',
        preferredSubtitleLanguage: 'fra',
        autoplayNextEpisode: false,
      }),
    });
    renderApp(['/settings']);

    const quality = await loadSettings();
    expect(quality.value).toBe('480p');
    expect((screen.getByLabelText('Subtitle language') as HTMLSelectElement).value).toBe('fra');
    expect((screen.getByLabelText('Autoplay next episode') as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('builds the quality dropdown from GET /api/qualities', async () => {
    installMockApi({ session: makeUser(), qualities: makeQualities() });
    renderApp(['/settings']);

    const quality = await loadSettings();
    const values = Array.from(quality.options).map((option) => option.value);
    // Leading "Auto" (no preference) then every permitted rung, highest first.
    expect(values).toEqual(['', '1080p', '720p', '480p', '360p']);
  });

  it('saves only the changed fields via PATCH and shows success', async () => {
    const api = installMockApi({
      session: makeUser({ preferredQuality: null, autoplayNextEpisode: true }),
    });
    renderApp(['/settings']);

    const quality = await loadSettings();
    fireEvent.change(quality, { target: { value: '720p' } });
    fireEvent.click(screen.getByLabelText('Autoplay next episode')); // → off

    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    await screen.findByText('Preferences saved.');
    const bodies = patchMeBodies(api);
    expect(bodies).toHaveLength(1);
    // Only the two changed fields; the untouched subtitle preference is omitted.
    expect(bodies[0]).toEqual({ preferredQuality: '720p', autoplayNextEpisode: false });
  });

  it('sends null to clear a preference and "off" as the subtitle sentinel', async () => {
    const api = installMockApi({
      session: makeUser({ preferredQuality: '1080p', preferredSubtitleLanguage: null }),
    });
    renderApp(['/settings']);

    const quality = await loadSettings();
    fireEvent.change(quality, { target: { value: '' } }); // Auto → clears
    fireEvent.change(screen.getByLabelText('Subtitle language'), { target: { value: 'off' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    await screen.findByText('Preferences saved.');
    expect(patchMeBodies(api)[0]).toEqual({
      preferredQuality: null,
      preferredSubtitleLanguage: 'off',
    });
  });

  it('reports a validation error from the server without a success message', async () => {
    const api = installMockApi({ session: makeUser() });
    renderApp(['/settings']);

    await loadSettings();
    // Force the server to reject: patch a bad quality directly through the client.
    fireEvent.change(screen.getByLabelText('Subtitle language'), { target: { value: 'eng' } });

    // Make the next PATCH fail as the server would for an invalid field.
    const real = api.fetchMock.getMockImplementation();
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/users/me' && (init?.method ?? 'GET').toUpperCase() === 'PATCH') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'VALIDATION', message: 'Invalid' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return real!(input, init);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid');
    expect(screen.queryByText('Preferences saved.')).not.toBeInTheDocument();
  });
});
