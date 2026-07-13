import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  installMockApi,
  makePlaylistDetail,
  makePlaylistItem,
  makePlaylistSummary,
  makeUser,
  type MockApi,
  type MockApiConfig,
} from '../test/mockApi';
import { renderApp } from '../test/renderApp';

function render(config: MockApiConfig, path = '/playlists'): MockApi {
  const api = installMockApi({ session: makeUser({ username: 'alli' }), ...config });
  renderApp([path]);
  return api;
}

/** Calls to a given method+path prefix captured by the fetch mock. */
function calls(api: MockApi, method: string, match: RegExp): [string, RequestInit | undefined][] {
  return api.fetchMock.mock.calls.filter(
    ([url, init]) =>
      match.test(String(url)) && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  ) as [string, RequestInit | undefined][];
}

describe('PlaylistsPage — listing', () => {
  it('lists the caller\'s playlists with item counts, linking to each detail', async () => {
    render({
      playlists: [
        makePlaylistSummary({ id: 'pl-1', name: 'Road Trip', itemCount: 3 }),
        makePlaylistSummary({ id: 'pl-2', name: 'Later', itemCount: 1 }),
      ],
    });

    const road = await screen.findByRole('link', { name: 'Road Trip' });
    expect(road).toHaveAttribute('href', '/playlists/pl-1');
    expect(within(road).getByText('3 items')).toBeInTheDocument();
    const later = screen.getByRole('link', { name: 'Later' });
    expect(within(later).getByText('1 item')).toBeInTheDocument();
  });

  it('shows an empty state when there are no playlists', async () => {
    render({ playlists: [] });
    expect(await screen.findByText(/no playlists yet/i)).toBeInTheDocument();
  });

  it('creates a playlist via the inline form (POST /playlists)', async () => {
    const api = render({ playlists: [] });

    await screen.findByText(/no playlists yet/i);
    fireEvent.change(screen.getByLabelText('New playlist name'), {
      target: { value: 'Fresh Mix' },
    });
    fireEvent.click(screen.getByRole('button', { name: /new playlist/i }));

    await waitFor(() => expect(calls(api, 'POST', /\/api\/playlists$/)).toHaveLength(1));
    const [, init] = calls(api, 'POST', /\/api\/playlists$/)[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Fresh Mix' });
    // The created playlist appears once the listing refetches.
    expect(await screen.findByRole('link', { name: 'Fresh Mix' })).toBeInTheDocument();
  });
});

describe('PlaylistDetailPage', () => {
  const detailConfig = (): MockApiConfig => {
    const detail = makePlaylistDetail({
      id: 'pl-1',
      name: 'Road Trip',
      items: [
        makePlaylistItem({ id: 'a', title: 'Alpha', order: 0, primaryMediaFileId: 'a-file' }),
        makePlaylistItem({ id: 'b', title: 'Bravo', order: 1, primaryMediaFileId: 'b-file' }),
        makePlaylistItem({ id: 'c', title: 'Charlie', order: 2, primaryMediaFileId: 'c-file' }),
      ],
    });
    return { playlistDetails: { 'pl-1': detail } };
  };

  it('renders items in order with a "Play all" button carrying the playlist context', async () => {
    render(detailConfig(), '/playlists/pl-1');

    expect(await screen.findByRole('heading', { name: 'Road Trip' })).toBeInTheDocument();
    // Play all targets the first item, index 0, with the playlist queue context.
    expect(screen.getByRole('link', { name: /play all/i })).toHaveAttribute(
      'href',
      '/player/a-file?item=a&playlist=pl-1&index=0',
    );
    // Per-item play carries that item's index.
    expect(screen.getByRole('link', { name: 'Play Bravo' })).toHaveAttribute(
      'href',
      '/player/b-file?item=b&playlist=pl-1&index=1',
    );
  });

  it('reorders via move-down (PUT /items) and reflects the new order', async () => {
    const api = render(detailConfig(), '/playlists/pl-1');

    await screen.findByRole('heading', { name: 'Road Trip' });
    fireEvent.click(screen.getByRole('button', { name: 'Move Alpha down' }));

    await waitFor(() => expect(calls(api, 'PUT', /\/api\/playlists\/pl-1\/items$/)).toHaveLength(1));
    const [, init] = calls(api, 'PUT', /\/api\/playlists\/pl-1\/items$/)[0]!;
    // Alpha moves after Bravo.
    expect(JSON.parse(String(init?.body))).toEqual({ orderedItemIds: ['b', 'a', 'c'] });
  });

  it('removes an item (DELETE /items/:mediaItemId)', async () => {
    const api = render(detailConfig(), '/playlists/pl-1');

    await screen.findByRole('heading', { name: 'Road Trip' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bravo' }));

    await waitFor(() =>
      expect(calls(api, 'DELETE', /\/api\/playlists\/pl-1\/items\/b$/)).toHaveLength(1),
    );
    // Bravo is gone after the listing reconciles.
    await waitFor(() => expect(screen.queryByText('Bravo')).not.toBeInTheDocument());
  });

  it('renames the playlist (PATCH)', async () => {
    const api = render(detailConfig(), '/playlists/pl-1');

    await screen.findByRole('heading', { name: 'Road Trip' });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Playlist name'), { target: { value: 'Long Drive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls(api, 'PATCH', /\/api\/playlists\/pl-1$/)).toHaveLength(1));
    expect(await screen.findByRole('heading', { name: 'Long Drive' })).toBeInTheDocument();
  });

  it('shows a not-found state for an unknown/other-user playlist', async () => {
    render({ playlistDetails: {} }, '/playlists/ghost');
    expect(await screen.findByText('Playlist not found')).toBeInTheDocument();
  });
});
