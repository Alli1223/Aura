import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MediaItem } from '../api/media';
import { setAccessToken } from '../api/client';
import { makeItem } from '../test/mockApi';
import { PosterCard } from './PosterCard';

/** Minimal fetch stub for the artwork endpoint, so AuthImage can resolve. */
function stubArtworkFetch(ok = true) {
  const fetchMock = vi.fn(() =>
    ok
      ? Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      : Promise.resolve(new Response(null, { status: 404 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderCard(item: MediaItem) {
  return render(
    <MemoryRouter>
      <PosterCard item={item} />
    </MemoryRouter>,
  );
}

describe('PosterCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the sized poster and renders it as a lazy image', async () => {
    setAccessToken('tok');
    const fetchMock = stubArtworkFetch();
    renderCard(
      makeItem({
        id: 'm1',
        title: 'Inception',
        year: 2010,
        posterUrl: '/api/items/m1/artwork/poster',
      }),
    );

    const img = await screen.findByRole('img', { name: 'Inception' });
    // AuthImage renders the fetched blob as an object URL, not the raw path.
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(img).toHaveAttribute('loading', 'lazy');
    // The artwork request carried the size bucket and a bearer token.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/items/m1/artwork/poster?size=w400',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(screen.getByText('Inception')).toBeInTheDocument();
    expect(screen.getByText('2010')).toBeInTheDocument();
  });

  it('links to the item detail route', () => {
    stubArtworkFetch();
    renderCard(makeItem({ id: 'abc', title: 'Linked' }));

    expect(screen.getByRole('link', { name: /Linked/ })).toHaveAttribute('href', '/items/abc');
  });

  it('shows a title fallback tile (no image) when posterUrl is null', () => {
    renderCard(makeItem({ title: 'No Poster', posterUrl: null }));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // The title appears both in the fallback tile and the caption.
    expect(screen.getAllByText('No Poster').length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the title tile when the poster image fails to load', async () => {
    setAccessToken('tok');
    stubArtworkFetch(false);
    renderCard(makeItem({ title: 'Broken', posterUrl: '/api/items/x/artwork/poster' }));

    // The failed artwork fetch triggers onError → fallback tile (no <img>).
    await waitFor(() => {
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });
    expect(screen.getAllByText('Broken').length).toBeGreaterThanOrEqual(1);
  });

  it('shows a watched badge and no progress bar for a watched item', () => {
    renderCard(
      makeItem({
        title: 'Seen',
        posterUrl: null,
        watchState: {
          watched: true,
          positionMs: 0,
          episodeCount: 0,
          watchedEpisodeCount: 0,
          nextUnwatchedId: null,
        },
      }),
    );

    expect(screen.getByTitle('Watched')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows an in-progress bar for a partially watched leaf', () => {
    renderCard(
      makeItem({
        title: 'Partial',
        posterUrl: null,
        runtimeMs: 100_000,
        watchState: {
          watched: false,
          positionMs: 40_000,
          episodeCount: 0,
          watchedEpisodeCount: 0,
          nextUnwatchedId: null,
        },
      }),
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(screen.queryByTitle('Watched')).not.toBeInTheDocument();
  });

  it('derives the progress bar from episode counts for a container', () => {
    renderCard(
      makeItem({
        title: 'A Show',
        type: 'show',
        posterUrl: null,
        watchState: {
          watched: false,
          positionMs: 0,
          episodeCount: 10,
          watchedEpisodeCount: 3,
          nextUnwatchedId: 'ep-4',
        },
      }),
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
  });
});
