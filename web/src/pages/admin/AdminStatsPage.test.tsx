import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AdminStats } from '../../api/adminStats';
import { installMockApi, makeAdminStats, makeUser } from '../../test/mockApi';
import { renderApp } from '../../test/renderApp';

const STATS: AdminStats = makeAdminStats({
  totals: {
    users: 3,
    libraries: 2,
    files: 42,
    items: { movie: 10, show: 4, season: 8, episode: 120, total: 142 },
  },
  storageByLibrary: [
    {
      libraryId: 'lib-movies',
      name: 'Movies',
      type: 'movies',
      fileCount: 10,
      totalBytes: 2_147_483_648,
    },
    { libraryId: 'lib-tv', name: 'TV', type: 'tv', fileCount: 32, totalBytes: 4096 },
  ],
  mostWatched: [
    {
      mediaItemId: 'm1',
      title: 'Popular Movie',
      type: 'movie',
      showTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      playCount: 12,
      viewers: 3,
    },
    {
      mediaItemId: 'e1',
      title: 'Great Episode',
      type: 'episode',
      showTitle: 'Best Show',
      seasonNumber: 2,
      episodeNumber: 5,
      playCount: 8,
      viewers: 2,
    },
  ],
  mostActiveUsers: [{ userId: 'u1', username: 'bingewatcher', playCount: 40, itemCount: 22 }],
  recentlyAdded: { last24h: 1, last7d: 5, last30d: 20 },
});

describe('AdminStatsPage', () => {
  it('renders tiles and tables with human-readable sizes', async () => {
    installMockApi({ session: makeUser({ role: 'admin' }), adminStats: STATS });
    renderApp(['/admin/stats']);

    // Headline sections (headings are unique; tile labels like "Users" collide
    // with the admin sub-nav tabs, so assert on unique tiles instead).
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Storage by library' })).toBeInTheDocument();
    expect(screen.getByText('Shows')).toBeInTheDocument();
    expect(screen.getByText('Episodes')).toBeInTheDocument();
    expect(screen.getByText('Last 7 days')).toBeInTheDocument();

    // Storage table with human-readable sizes.
    expect(screen.getByText('2.0 GB')).toBeInTheDocument();
    expect(screen.getByText('4.0 KB')).toBeInTheDocument();

    // Most-watched, with episode show context.
    expect(screen.getByText('Popular Movie')).toBeInTheDocument();
    expect(screen.getByText('Best Show · S2E5 · Great Episode')).toBeInTheDocument();

    // Most-active users.
    expect(screen.getByText('bingewatcher')).toBeInTheDocument();
  });

  it('surfaces an error with a retry', async () => {
    const api = installMockApi({ session: makeUser({ role: 'admin' }), adminStats: STATS });
    const real = api.fetchMock.getMockImplementation();
    let failNext = true;
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/admin/stats') && failNext) {
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

    renderApp(['/admin/stats']);

    expect(await screen.findByText("Couldn't load statistics")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('is admin-only: a regular user is redirected away from the stats page', async () => {
    installMockApi({ session: makeUser({ role: 'user' }), adminStats: STATS });
    renderApp(['/admin/stats']);

    // RequireAdmin bounces non-admins home; the stats never render.
    await waitFor(() => expect(screen.getByText(/Welcome back/)).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.queryByText('Most watched')).not.toBeInTheDocument();
  });
});
