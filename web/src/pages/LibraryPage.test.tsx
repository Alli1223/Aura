import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Location } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { MediaItem } from '../api/media';
import type { Library } from '../api/types';
import { installMockApi, makeItem, makeLibrary, makeUser, type MockApi } from '../test/mockApi';
import { renderApp } from '../test/renderApp';

/** Requests to a library's items endpoint, most recent last. */
function itemsRequests(api: MockApi, libraryId: string): unknown[][] {
  return api.fetchMock.mock.calls.filter((call) =>
    String(call[0]).includes(`/libraries/${libraryId}/items`),
  );
}

/** Query params of the most recent items request. */
function lastItemsParams(api: MockApi, libraryId: string): URLSearchParams {
  const calls = itemsRequests(api, libraryId);
  const url = String(calls.at(-1)?.[0] ?? '');
  return new URL(url, 'http://localhost').searchParams;
}

/** Boots the full app on a library route with a mocked API. */
function renderLibrary(
  lib: Library,
  items: MediaItem[],
  urlLibraryId: string = lib.id,
): { api: MockApi; getLocation: () => Location | null } {
  const api = installMockApi({
    session: makeUser({ username: 'alli' }),
    libraries: [lib],
    items: { [lib.id]: items },
  });
  let location: Location | null = null;
  renderApp([`/library/${urlLibraryId}`], (loc) => {
    location = loc;
  });
  return { api, getLocation: () => location };
}

function standardItems(libraryId: string): MediaItem[] {
  return [
    makeItem({
      id: 'a',
      title: 'Alpha',
      year: 2000,
      genres: ['Action'],
      libraryId,
      watchState: {
        watched: true,
        positionMs: 0,
        episodeCount: 0,
        watchedEpisodeCount: 0,
        nextUnwatchedId: null,
      },
    }),
    makeItem({ id: 'b', title: 'Beta', year: 2010, genres: ['Comedy'], libraryId }),
  ];
}

describe('LibraryPage — grid & states', () => {
  it('renders the library name and a poster grid of the returned items', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const { api } = renderLibrary(lib, standardItems(lib.id));

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Movies' })).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
    // Initial request carries the sort/order defaults and pagination.
    const params = lastItemsParams(api, lib.id);
    expect(params.get('sort')).toBe('title');
    expect(params.get('order')).toBe('asc');
    expect(params.get('page')).toBe('1');
  });

  it('shows a title fallback (no image) for an item with a null poster', async () => {
    const lib = makeLibrary('Movies', 'movies');
    renderLibrary(lib, [makeItem({ id: 'np', title: 'No Poster', posterUrl: null, libraryId: lib.id })]);

    await screen.findAllByText('No Poster');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders watched and in-progress overlays from watchState', async () => {
    const lib = makeLibrary('Movies', 'movies');
    renderLibrary(lib, [
      makeItem({
        id: 'w',
        title: 'Watched One',
        libraryId: lib.id,
        watchState: {
          watched: true,
          positionMs: 0,
          episodeCount: 0,
          watchedEpisodeCount: 0,
          nextUnwatchedId: null,
        },
      }),
      makeItem({
        id: 'p',
        title: 'In Progress',
        runtimeMs: 100_000,
        libraryId: lib.id,
        watchState: {
          watched: false,
          positionMs: 50_000,
          episodeCount: 0,
          watchedEpisodeCount: 0,
          nextUnwatchedId: null,
        },
      }),
    ]);

    await screen.findByText('Watched One');
    expect(screen.getByTitle('Watched')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('shows a loading skeleton first, then the grid', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const items = [makeItem({ id: 'a', title: 'Alpha', libraryId: lib.id })];
    const api = installMockApi({
      session: makeUser(),
      libraries: [lib],
      items: { [lib.id]: items },
    });
    // Gate the items response so the skeleton is observable.
    const real = api.fetchMock.getMockImplementation();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(`/libraries/${lib.id}/items`)) {
        return gate.then(() => real!(input, init));
      }
      return real!(input, init);
    });

    renderApp([`/library/${lib.id}`]);

    expect((await screen.findAllByTestId('poster-skeleton')).length).toBeGreaterThan(0);
    release();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByTestId('poster-skeleton')).not.toBeInTheDocument();
  });

  it('shows the empty state when no items match', async () => {
    const lib = makeLibrary('Movies', 'movies');
    renderLibrary(lib, []);

    expect(await screen.findByText('No items match')).toBeInTheDocument();
  });

  it('shows an error state with a working retry', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const items = [makeItem({ id: 'a', title: 'Alpha', libraryId: lib.id })];
    const api = installMockApi({
      session: makeUser(),
      libraries: [lib],
      items: { [lib.id]: items },
    });
    const real = api.fetchMock.getMockImplementation();
    let failNext = true;
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(`/libraries/${lib.id}/items`) && failNext) {
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

    renderApp([`/library/${lib.id}`]);

    expect(await screen.findByText("Couldn't load this library")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  it('shows a not-found state (no leak) for an inaccessible library', async () => {
    const lib = makeLibrary('Movies', 'movies');
    renderLibrary(lib, [], 'lib-does-not-exist');

    expect(await screen.findByText('Library not found')).toBeInTheDocument();
    expect(screen.queryByText('No items match')).not.toBeInTheDocument();
  });
});

describe('LibraryPage — toolbar controls', () => {
  it('changing sort updates the request params and the URL', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const { api, getLocation } = renderLibrary(lib, standardItems(lib.id));
    await screen.findByText('Alpha');

    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'year' } });

    await waitFor(() => expect(lastItemsParams(api, lib.id).get('sort')).toBe('year'));
    expect(getLocation()?.search).toContain('sort=year');
  });

  it('toggling sort order updates the request params and the URL', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const { api, getLocation } = renderLibrary(lib, standardItems(lib.id));
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: /sort direction/i }));

    await waitFor(() => expect(lastItemsParams(api, lib.id).get('order')).toBe('desc'));
    expect(getLocation()?.search).toContain('order=desc');
  });

  it('selecting a genre updates the request params and the URL', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const { api, getLocation } = renderLibrary(lib, standardItems(lib.id));
    await screen.findByText('Alpha');

    fireEvent.change(screen.getByLabelText('Genre'), { target: { value: 'Action' } });

    await waitFor(() => expect(lastItemsParams(api, lib.id).get('genre')).toBe('Action'));
    expect(getLocation()?.search).toContain('genre=Action');
  });

  it('selecting a year updates the request params and the URL', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const { api, getLocation } = renderLibrary(lib, standardItems(lib.id));
    await screen.findByText('Alpha');

    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2010' } });

    await waitFor(() => expect(lastItemsParams(api, lib.id).get('year')).toBe('2010'));
    expect(getLocation()?.search).toContain('year=2010');
  });

  it('filtering by watched state updates the request params and the URL', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const { api, getLocation } = renderLibrary(lib, standardItems(lib.id));
    await screen.findByText('Alpha');

    fireEvent.change(screen.getByLabelText('Watched'), { target: { value: 'false' } });

    await waitFor(() => expect(lastItemsParams(api, lib.id).get('watched')).toBe('false'));
    expect(getLocation()?.search).toContain('watched=false');
  });

  it('debounces the search box, then updates the request and URL', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const items = [
      makeItem({ id: 'a', title: 'Alpha', libraryId: lib.id }),
      makeItem({ id: 'z', title: 'Zeta', libraryId: lib.id }),
    ];
    const { api, getLocation } = renderLibrary(lib, items);
    await screen.findByText('Alpha');

    const before = itemsRequests(api, lib.id).length;
    fireEvent.change(screen.getByLabelText('Search this library'), { target: { value: 'Zeta' } });
    // Debounced: no new request fires synchronously on keystroke.
    expect(itemsRequests(api, lib.id).length).toBe(before);

    await waitFor(() => expect(lastItemsParams(api, lib.id).get('search')).toBe('Zeta'), {
      timeout: 2000,
    });
    expect(getLocation()?.search).toContain('search=Zeta');
    expect(await screen.findByText('Zeta')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('initialises controls and the request from the URL query string', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const api = installMockApi({
      session: makeUser(),
      libraries: [lib],
      items: { [lib.id]: standardItems(lib.id) },
    });
    renderApp([`/library/${lib.id}?sort=year&order=desc`]);

    await screen.findByText('Beta');
    const params = lastItemsParams(api, lib.id);
    expect(params.get('sort')).toBe('year');
    expect(params.get('order')).toBe('desc');
    expect(screen.getByLabelText('Sort')).toHaveValue('year');
  });
});
