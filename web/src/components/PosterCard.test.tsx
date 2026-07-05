import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { MediaItem } from '../api/media';
import { makeItem } from '../test/mockApi';
import { PosterCard } from './PosterCard';

function renderCard(item: MediaItem) {
  return render(
    <MemoryRouter>
      <PosterCard item={item} />
    </MemoryRouter>,
  );
}

describe('PosterCard', () => {
  it('renders the lazy poster image and the title/year caption', () => {
    renderCard(
      makeItem({
        id: 'm1',
        title: 'Inception',
        year: 2010,
        posterUrl: '/api/items/m1/artwork/poster',
      }),
    );

    const img = screen.getByRole('img', { name: 'Inception' });
    expect(img).toHaveAttribute('src', '/api/items/m1/artwork/poster?size=w400');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(screen.getByText('Inception')).toBeInTheDocument();
    expect(screen.getByText('2010')).toBeInTheDocument();
  });

  it('links to the item detail route', () => {
    renderCard(makeItem({ id: 'abc', title: 'Linked' }));

    expect(screen.getByRole('link', { name: /Linked/ })).toHaveAttribute('href', '/items/abc');
  });

  it('shows a title fallback tile (no image) when posterUrl is null', () => {
    renderCard(makeItem({ title: 'No Poster', posterUrl: null }));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // The title appears both in the fallback tile and the caption.
    expect(screen.getAllByText('No Poster').length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the title tile when the poster image fails to load', () => {
    renderCard(makeItem({ title: 'Broken', posterUrl: '/api/items/x/artwork/poster' }));

    fireEvent.error(screen.getByRole('img'));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getAllByText('Broken').length).toBeGreaterThanOrEqual(1);
  });

  it('shows a watched badge and no progress bar for a watched item', () => {
    renderCard(
      makeItem({
        title: 'Seen',
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
