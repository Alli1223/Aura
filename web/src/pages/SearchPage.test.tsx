import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MediaItem } from '../api/media';
import type { Library } from '../api/types';
import { installMockApi, makeItem, makeLibrary, makeUser, type MockApi } from '../test/mockApi';
import { renderApp } from '../test/renderApp';

// Full search results page at /search?q=, driven entirely by the URL query. The
// mock API's /api/search handler mirrors the server contract.

function searchItems(libraryId: string): MediaItem[] {
  return [
    makeItem({ id: 'alpha', title: 'Alpha', year: 2001, libraryId }),
    makeItem({ id: 'alphabet', title: 'Alphabet', year: 2015, libraryId }),
    makeItem({ id: 'bravo', title: 'Bravo', year: 1999, libraryId }),
  ];
}

function renderAt(url: string): { api: MockApi; lib: Library } {
  const lib = makeLibrary('Movies', 'movies');
  const api = installMockApi({
    session: makeUser({ username: 'alli' }),
    libraries: [lib],
    items: { [lib.id]: searchItems(lib.id) },
  });
  renderApp([url]);
  return { api, lib };
}

describe('SearchPage — results grid', () => {
  it('renders a grid of results from the URL q param and echoes the query', async () => {
    renderAt('/search?q=alph');

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Alphabet')).toBeInTheDocument();
    // Non-matching items are excluded.
    expect(screen.queryByText('Bravo')).not.toBeInTheDocument();
    // The query is echoed in the header.
    expect(screen.getByText(/Results for/)).toBeInTheDocument();
    expect(screen.getByText('“alph”')).toBeInTheDocument();
  });

  it('shows a prompt when there is no query', async () => {
    renderAt('/search');

    expect(await screen.findByText('Search your libraries')).toBeInTheDocument();
    expect(screen.queryByText(/Results for/)).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    renderAt('/search?q=zzz');

    expect(await screen.findByText('No results')).toBeInTheDocument();
    expect(screen.getByText(/Nothing matched “zzz”/)).toBeInTheDocument();
  });

  it('shows a loading skeleton before results arrive', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const api = installMockApi({
      session: makeUser(),
      libraries: [lib],
      items: { [lib.id]: searchItems(lib.id) },
    });
    // Gate the search response so the skeleton is observable.
    const real = api.fetchMock.getMockImplementation();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/search')) {
        return gate.then(() => real!(input, init));
      }
      return real!(input, init);
    });

    renderApp(['/search?q=alph']);

    expect((await screen.findAllByTestId('search-skeleton')).length).toBeGreaterThan(0);
    release();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByTestId('search-skeleton')).not.toBeInTheDocument();
  });

  it('shows an error state with a working retry', async () => {
    const lib = makeLibrary('Movies', 'movies');
    const api = installMockApi({
      session: makeUser(),
      libraries: [lib],
      items: { [lib.id]: searchItems(lib.id) },
    });
    const real = api.fetchMock.getMockImplementation();
    let failNext = true;
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/search') && failNext) {
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

    renderApp(['/search?q=alph']);

    expect(await screen.findByText("Couldn't run your search")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });
});
