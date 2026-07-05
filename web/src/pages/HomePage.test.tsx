import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ItemWatchState } from '../api/media';
import {
  installMockApi,
  makeContinueEntry,
  makeItem,
  makeLibrary,
  makeUser,
  type MockApi,
} from '../test/mockApi';
import { renderApp } from '../test/renderApp';

/** The <section> wrapping a row heading, for scoped queries. */
function rowSection(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const section = heading.closest('section');
  if (section === null) throw new Error(`No <section> found for row "${name}"`);
  return section;
}

/** A show watch-state overlay: started `watchedEpisodeCount` of `episodeCount`. */
function showState(overrides: Partial<ItemWatchState>): ItemWatchState {
  return {
    watched: false,
    positionMs: 0,
    episodeCount: 10,
    watchedEpisodeCount: 0,
    nextUnwatchedId: null,
    ...overrides,
  };
}

function boot(config: Parameters<typeof installMockApi>[0]): MockApi {
  const api = installMockApi({ session: makeUser({ username: 'alli' }), ...config });
  renderApp(['/']);
  return api;
}

describe('HomePage — Continue Watching', () => {
  it('renders in-progress items with a progress bar and links to /items/:id', async () => {
    const lib = makeLibrary('Movies', 'movies');
    boot({
      libraries: [lib],
      continueWatching: [
        makeContinueEntry({
          positionMs: 60_000,
          item: { id: 'cw1', title: 'Half Watched', libraryId: lib.id, runtimeMs: 120_000 },
        }),
      ],
    });

    await screen.findByRole('heading', { name: 'Continue Watching' });
    const row = within(rowSection('Continue Watching'));
    const link = await row.findByRole('link', { name: /Half Watched/ });
    expect(link).toHaveAttribute('href', '/items/cw1');
    expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('hides the Continue Watching row when there is nothing in progress', async () => {
    const lib = makeLibrary('Movies', 'movies');
    boot({
      libraries: [lib],
      continueWatching: [],
      items: { [lib.id]: [makeItem({ id: 'a', title: 'Anchor', libraryId: lib.id })] },
    });

    // Anchor on a row that does render, then assert the empty row never appears.
    await screen.findByRole('heading', { name: 'Recently Added' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Continue Watching' })).not.toBeInTheDocument(),
    );
  });
});

describe('HomePage — Recently Added', () => {
  it('renders a cross-library row with items from every permitted library', async () => {
    const movies = makeLibrary('Movies', 'movies');
    const anime = makeLibrary('Anime', 'anime');
    boot({
      libraries: [movies, anime],
      items: {
        [movies.id]: [makeItem({ id: 'a', title: 'Alpha', libraryId: movies.id })],
        [anime.id]: [makeItem({ id: 'b', title: 'Bravo', libraryId: anime.id })],
      },
    });

    await screen.findByRole('heading', { name: 'Recently Added' });
    const row = within(rowSection('Recently Added'));
    await row.findByRole('link', { name: /Alpha/ });
    expect(row.getByRole('link', { name: /Bravo/ })).toBeInTheDocument();
  });

  it('renders one row per permitted library and omits libraries with no items', async () => {
    const movies = makeLibrary('Movies', 'movies');
    const anime = makeLibrary('Anime', 'anime');
    boot({
      libraries: [movies, anime],
      // Only the Movies library has content; Anime is empty.
      items: { [movies.id]: [makeItem({ id: 'a', title: 'Alpha', libraryId: movies.id })] },
    });

    await screen.findByRole('heading', { name: 'Movies' });
    await within(rowSection('Movies')).findByRole('link', { name: /Alpha/ });
    // The empty Anime library gets no row of its own.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Anime' })).not.toBeInTheDocument(),
    );
  });
});

describe('HomePage — On Deck', () => {
  it('derives next-up shows (started, unfinished, with a next episode)', async () => {
    const lib = makeLibrary('Shows', 'tv');
    const ongoing = makeItem({
      id: 'show1',
      title: 'Ongoing Show',
      type: 'show',
      libraryId: lib.id,
      watchState: showState({ watchedEpisodeCount: 3, nextUnwatchedId: 'ep-4' }),
    });
    const notStarted = makeItem({
      id: 'show2',
      title: 'Fresh Show',
      type: 'show',
      libraryId: lib.id,
      watchState: showState({ watchedEpisodeCount: 0, nextUnwatchedId: 'ep-1' }),
    });
    boot({ libraries: [lib], items: { [lib.id]: [ongoing, notStarted] } });

    await screen.findByRole('heading', { name: 'On Deck' });
    const onDeck = within(rowSection('On Deck'));
    await onDeck.findByRole('link', { name: /Ongoing Show/ });
    // A show you haven't started is not On Deck, though it is Recently Added.
    expect(onDeck.queryByRole('link', { name: /Fresh Show/ })).not.toBeInTheDocument();
    expect(
      within(rowSection('Recently Added')).getByRole('link', { name: /Fresh Show/ }),
    ).toBeInTheDocument();
  });
});

describe('HomePage — access & row resilience', () => {
  it('shows a friendly empty state when the user has no library access', async () => {
    boot({ libraries: [] });

    expect(await screen.findByText(/Ask an admin for library access/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Continue Watching' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recently Added' })).not.toBeInTheDocument();
  });

  it('shows a per-row skeleton while a feed is loading', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const api = installMockApi({
      session: makeUser(),
      libraries: [lib],
      continueWatching: [
        makeContinueEntry({ item: { id: 'cw1', title: 'Resume Me', libraryId: lib.id } }),
      ],
    });
    // Gate the continue-watching response so its skeleton is observable.
    const real = api.fetchMock.getMockImplementation();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/continue-watching')) {
        return gate.then(() => real!(input, init));
      }
      return real!(input, init);
    });

    renderApp(['/']);

    expect((await screen.findAllByTestId('row-skeleton')).length).toBeGreaterThan(0);
    release();
    expect(await screen.findByRole('link', { name: /Resume Me/ })).toBeInTheDocument();
  });

  it('shows a per-row error with a working retry without killing the page', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const api = installMockApi({
      session: makeUser(),
      libraries: [lib],
      continueWatching: [
        makeContinueEntry({ item: { id: 'cw1', title: 'Resume Me', libraryId: lib.id } }),
      ],
      items: { [lib.id]: [makeItem({ id: 'ra1', title: 'New Movie', libraryId: lib.id })] },
    });
    const real = api.fetchMock.getMockImplementation();
    let failNext = true;
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/continue-watching') && failNext) {
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

    renderApp(['/']);

    // The failing row surfaces a retry; a sibling row still renders fine.
    expect(await screen.findByText("Couldn't load Continue Watching")).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Recently Added' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Resume Me/ })).toBeInTheDocument();
  });

  it('renders a focusable rail that scrolls with the arrow keys', async () => {
    const lib = makeLibrary('Movies', 'movies');
    boot({
      libraries: [lib],
      continueWatching: [
        makeContinueEntry({ item: { id: 'cw1', title: 'Resume Me', libraryId: lib.id } }),
      ],
    });

    await screen.findByRole('link', { name: /Resume Me/ });
    const rail = screen.getByRole('list', { name: 'Continue Watching' });
    expect(rail).toHaveAttribute('tabindex', '0');

    // jsdom leaves Element.scrollBy undefined; attach a spy to observe the nudge.
    const scrollBy = vi.fn();
    Object.defineProperty(rail, 'scrollBy', { value: scrollBy, configurable: true });
    fireEvent.keyDown(rail, { key: 'ArrowRight' });
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number) }));
  });
});
