import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { HistoryEntry } from '../api/history';
import { installMockApi, makeHistoryEntry, makeUser, type MockApi } from '../test/mockApi';
import { renderApp } from '../test/renderApp';

function lastCall(api: MockApi, suffix: string, method: string) {
  return [...api.fetchMock.mock.calls]
    .reverse()
    .find(
      ([url, init]) =>
        String(url).endsWith(suffix) &&
        (init?.method ?? 'GET').toUpperCase() === method.toUpperCase(),
    );
}

function renderHistory(history: HistoryEntry[]): MockApi {
  const api = installMockApi({ session: makeUser(), libraries: [], history });
  renderApp(['/history']);
  return api;
}

describe('HistoryPage', () => {
  it('renders history rows with show context and watched status', async () => {
    renderHistory([
      makeHistoryEntry({
        item: { id: 'm1', title: 'The Matrix', type: 'movie', year: 1999 },
        watchState: { watched: true },
      }),
      makeHistoryEntry({
        item: {
          id: 'e1',
          title: 'Pilot',
          type: 'episode',
          seasonNumber: 1,
          episodeNumber: 3,
          runtimeMs: 120_000,
        },
        watchState: { watched: false, positionMs: 30_000 },
        showId: 's1',
        showTitle: 'My Show',
      }),
    ]);

    expect(await screen.findByText('The Matrix')).toBeInTheDocument();
    expect(screen.getByText('Watched')).toBeInTheDocument();
    // Episode row shows its show title and the SxxEyy · title line.
    expect(screen.getByText('My Show')).toBeInTheDocument();
    expect(screen.getByText('S1E3 · Pilot')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Watch progress' })).toBeInTheDocument();
  });

  it('removes an item: calls DELETE and drops the row', async () => {
    const api = renderHistory([
      makeHistoryEntry({ item: { id: 'm1', title: 'Keeper' }, watchState: { watched: true } }),
      makeHistoryEntry({ item: { id: 'm2', title: 'Remove Me' }, watchState: { watched: true } }),
    ]);

    await screen.findByText('Remove Me');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Remove Me from history' }));

    await waitFor(() => expect(lastCall(api, '/history/m2', 'DELETE')).toBeDefined());
    await waitFor(() => expect(screen.queryByText('Remove Me')).not.toBeInTheDocument());
    // The other row is untouched.
    expect(screen.getByText('Keeper')).toBeInTheDocument();
  });

  it('shows an empty state when there is no history', async () => {
    renderHistory([]);
    expect(await screen.findByText('Nothing watched yet')).toBeInTheDocument();
  });

  it('surfaces an error with a retry', async () => {
    const api = installMockApi({ session: makeUser(), libraries: [] });
    const real = api.fetchMock.getMockImplementation();
    let failNext = true;
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/history') && failNext) {
        failNext = false;
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return real!(input, init);
    });

    renderApp(['/history']);

    expect(await screen.findByText("Couldn't load your history")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing watched yet')).toBeInTheDocument();
  });
});
