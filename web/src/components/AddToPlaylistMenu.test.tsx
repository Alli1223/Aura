import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  installMockApi,
  makeDetail,
  makeFile,
  makeItem,
  makeLibrary,
  makePlaylistSummary,
  makeUser,
  type MockApi,
  type MockApiConfig,
} from '../test/mockApi';
import { renderApp } from '../test/renderApp';

// The "Add to playlist" control lives on the item (movie/episode) detail page.
// These tests drive it through the real detail route so the menu, its lazy
// playlist load and the add/create mutations are all exercised end to end.

function renderMovie(config: Partial<MockApiConfig> = {}): MockApi {
  const movie = makeItem({ id: 'movie-1', type: 'movie', title: 'Inception' });
  const api = installMockApi({
    session: makeUser({ username: 'alli' }),
    libraries: [makeLibrary('Movies', 'movies')],
    details: { 'movie-1': makeDetail(movie, { files: [makeFile({ id: 'file-1' })] }) },
    ...config,
  });
  renderApp(['/items/movie-1']);
  return api;
}

/** POST /api/playlists/:id/items call bodies captured by the fetch mock. */
function addCalls(api: MockApi, playlistId: string): { mediaItemId: string }[] {
  return api.fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url).endsWith(`/api/playlists/${playlistId}/items`) &&
        (init as RequestInit | undefined)?.method === 'POST',
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { mediaItemId: string });
}

describe('AddToPlaylistMenu', () => {
  it('opens, lists the user\'s playlists and POSTs the item to the chosen one', async () => {
    const api = renderMovie({
      playlists: [makePlaylistSummary({ id: 'pl-1', name: 'Watchlist', itemCount: 2 })],
    });

    fireEvent.click(await screen.findByRole('button', { name: /add to playlist/i }));

    // The menu lazily loads and lists the playlist.
    const item = await screen.findByRole('menuitem', { name: /Watchlist/ });
    fireEvent.click(item);

    await waitFor(() => expect(addCalls(api, 'pl-1')).toEqual([{ mediaItemId: 'movie-1' }]));
    // A confirmation replaces the menu.
    expect(await screen.findByRole('status')).toHaveTextContent('Added to Watchlist');
  });

  it('creates a new playlist then adds the item to it', async () => {
    const api = renderMovie({ playlists: [] });

    fireEvent.click(await screen.findByRole('button', { name: /add to playlist/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /new playlist/i }));
    fireEvent.change(screen.getByLabelText('New playlist name'), {
      target: { value: 'Faves' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // Create, then add the item to the freshly-created playlist id.
    await waitFor(() => {
      const created = api.fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/api/playlists') &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(created).toBe(true);
    });
    await waitFor(() => expect(addCalls(api, 'pl-new-1')).toEqual([{ mediaItemId: 'movie-1' }]));
  });
});
