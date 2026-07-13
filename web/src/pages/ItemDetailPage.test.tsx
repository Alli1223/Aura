import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  installMockApi,
  makeDetail,
  makeEpisode,
  makeFile,
  makeItem,
  makeLibrary,
  makeUser,
  type MockApi,
  type MockApiConfig,
} from '../test/mockApi';
import { renderApp } from '../test/renderApp';

/** Boots the full app on an item route with the given detail payloads mocked. */
function renderDetail(details: MockApiConfig['details'], id: string): MockApi {
  const api = installMockApi({
    session: makeUser({ username: 'alli' }),
    libraries: [makeLibrary('Movies', 'movies')],
    details,
  });
  renderApp([`/items/${id}`]);
  return api;
}

/** All PUT /watched calls captured by the fetch mock. */
function watchedCalls(api: MockApi, id: string): { watched: boolean }[] {
  return api.fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url).endsWith(`/items/${id}/watched`) &&
        (init as RequestInit | undefined)?.method === 'PUT',
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { watched: boolean });
}

describe('ItemDetailPage — movie', () => {
  function movieDetail() {
    const movie = makeItem({
      id: 'movie-1',
      type: 'movie',
      title: 'Inception',
      year: 2010,
      runtimeMs: 7_200_000,
      communityRating: 7.8,
      contentRating: 'PG-13',
      genres: ['Sci-Fi'],
      overview: 'A thief who steals corporate secrets.',
      tagline: 'Your mind is the scene of the crime.',
    });
    const file = makeFile({
      id: 'file-1',
      container: 'mkv',
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioStreams: [
        { index: 1, codec: 'aac', channels: 6, language: 'English', title: null, default: true },
      ],
      subtitleStreams: [
        { index: 2, codec: 'subrip', language: 'English', title: null, forced: false },
      ],
    });
    return { 'movie-1': makeDetail(movie, { files: [file] }) };
  }

  it('renders metadata, media/stream info and a Play link targeting files[0]', async () => {
    renderDetail(movieDetail(), 'movie-1');

    expect(await screen.findByRole('heading', { name: 'Inception' })).toBeInTheDocument();
    expect(screen.getByText('Your mind is the scene of the crime.')).toBeInTheDocument();
    expect(screen.getByText('2010')).toBeInTheDocument();
    expect(screen.getByText('2h 0m')).toBeInTheDocument();
    expect(screen.getByText('★ 7.8')).toBeInTheDocument();
    expect(screen.getByText('PG-13')).toBeInTheDocument();
    expect(screen.getByText('Sci-Fi')).toBeInTheDocument();
    expect(screen.getByText('A thief who steals corporate secrets.')).toBeInTheDocument();

    // Media info panel: container, resolution, audio & subtitle tracks.
    expect(screen.getByText('1080p')).toBeInTheDocument();
    expect(screen.getByText('MKV')).toBeInTheDocument();
    expect(screen.getByText('English · AAC · 5.1')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('English · SUBRIP')).toBeInTheDocument();

    // Play button targets the player at the first file.
    expect(screen.getByRole('link', { name: /^play$/i })).toHaveAttribute(
      'href',
      '/player/file-1?item=movie-1',
    );
  });

  it('offers a version picker that retargets the Play link when files.length > 1', async () => {
    const movie = makeItem({ id: 'movie-1', type: 'movie', title: 'Dune' });
    const details = {
      'movie-1': makeDetail(movie, {
        files: [
          makeFile({ id: 'file-1', height: 1080, container: 'mkv', videoCodec: 'h264' }),
          makeFile({ id: 'file-2', height: 2160, container: 'mkv', videoCodec: 'hevc' }),
        ],
      }),
    };
    renderDetail(details, 'movie-1');

    await screen.findByRole('heading', { name: 'Dune' });
    // Defaults to files[0].
    expect(screen.getByRole('link', { name: /^play$/i })).toHaveAttribute(
      'href',
      '/player/file-1?item=movie-1',
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), {
      target: { value: 'file-2' },
    });

    expect(screen.getByRole('link', { name: /^play$/i })).toHaveAttribute(
      'href',
      '/player/file-2?item=movie-1',
    );
  });

  it('marks watched optimistically and calls PUT /watched', async () => {
    const api = renderDetail(movieDetail(), 'movie-1');

    const toggle = await screen.findByRole('button', { name: 'Mark watched' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    // Optimistic: the button flips before the network settles.
    const flipped = await screen.findByRole('button', { name: 'Mark unwatched' });
    expect(flipped).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => expect(watchedCalls(api, 'movie-1')).toEqual([{ watched: true }]));
  });

  it('shows a Resume button and a resume progress bar when a position is stored', async () => {
    const movie = makeItem({
      id: 'movie-1',
      type: 'movie',
      title: 'Interstellar',
      runtimeMs: 100_000,
      watchState: {
        watched: false,
        positionMs: 40_000,
        episodeCount: 0,
        watchedEpisodeCount: 0,
        nextUnwatchedId: null,
      },
    });
    renderDetail(
      { 'movie-1': makeDetail(movie, { files: [makeFile({ id: 'file-1' })] }) },
      'movie-1',
    );

    expect(await screen.findByRole('link', { name: /resume/i })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Resume position' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
  });
});

describe('ItemDetailPage — show', () => {
  it('lists seasons with episode counts and links to each season', async () => {
    const show = makeItem({ id: 'show-1', type: 'show', title: 'Severance' });
    const seasons = [
      makeItem({
        id: 'season-1',
        type: 'season',
        title: 'Season 1',
        seasonNumber: 1,
        watchState: {
          watched: false,
          positionMs: 0,
          episodeCount: 9,
          watchedEpisodeCount: 3,
          nextUnwatchedId: 'ep-4',
        },
      }),
      makeItem({ id: 'season-2', type: 'season', title: 'Season 2', seasonNumber: 2 }),
    ];
    renderDetail({ 'show-1': makeDetail(show, { seasons }) }, 'show-1');

    expect(await screen.findByRole('heading', { name: 'Severance' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Season 1/ });
    expect(link).toHaveAttribute('href', '/items/season-1?show=show-1');
    expect(screen.getByText('3/9 watched')).toBeInTheDocument();
  });
});

describe('ItemDetailPage — season', () => {
  function seasonDetail() {
    const season = makeItem({ id: 'season-1', type: 'season', title: 'Season 1', seasonNumber: 1 });
    const episodes = [
      makeEpisode({
        id: 'ep-1',
        title: 'Good News About Hell',
        episodeNumber: 1,
        seasonNumber: 1,
        primaryMediaFileId: 'ep1-file',
      }),
      makeEpisode({
        id: 'ep-2',
        title: 'Half Loop',
        episodeNumber: 2,
        seasonNumber: 1,
        primaryMediaFileId: 'ep2-file',
      }),
    ];
    return { 'season-1': makeDetail(season, { episodes }) };
  }

  it('lists episodes with play targets and per-episode watched toggles', async () => {
    const api = renderDetail(seasonDetail(), 'season-1');

    expect(await screen.findByText('Good News About Hell')).toBeInTheDocument();
    expect(screen.getByText('Half Loop')).toBeInTheDocument();

    // Each episode's Play link targets the player at its primary file.
    const playLinks = screen.getAllByRole('link', { name: /^play$/i });
    expect(playLinks[0]).toHaveAttribute('href', '/player/ep1-file?item=ep-1');
    expect(playLinks[1]).toHaveAttribute('href', '/player/ep2-file?item=ep-2');

    // Per-episode toggle calls PUT for that episode id.
    fireEvent.click(screen.getByRole('button', { name: 'Mark watched: Good News About Hell' }));
    await waitFor(() => expect(watchedCalls(api, 'ep-1')).toEqual([{ watched: true }]));
  });

  it('marks the whole season watched via the season action', async () => {
    const api = renderDetail(seasonDetail(), 'season-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Mark season watched' }));

    await waitFor(() => expect(watchedCalls(api, 'season-1')).toEqual([{ watched: true }]));
    // Optimistic cascade flips the season action.
    expect(
      await screen.findByRole('button', { name: 'Mark season unwatched' }),
    ).toBeInTheDocument();
  });

  it('renders a breadcrumb back to the parent show from the ?show= param', async () => {
    const show = makeItem({ id: 'show-1', type: 'show', title: 'Severance' });
    const season = makeItem({ id: 'season-1', type: 'season', title: 'Season 1', seasonNumber: 1 });
    const api = installMockApi({
      session: makeUser({ username: 'alli' }),
      libraries: [makeLibrary('TV', 'tv')],
      details: {
        'show-1': makeDetail(show),
        'season-1': makeDetail(season, { episodes: [makeEpisode({ id: 'ep-1', title: 'Pilot' })] }),
      },
    });
    renderApp(['/items/season-1?show=show-1']);

    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const crumb = await within(nav).findByRole('link', { name: 'Severance' });
    expect(crumb).toHaveAttribute('href', '/items/show-1');
    expect(api).toBeDefined();
  });
});

describe('ItemDetailPage — loading / error / not-found', () => {
  it('shows a skeleton first, then the content', async () => {
    const movie = makeItem({ id: 'movie-1', type: 'movie', title: 'Arrival' });
    const api = installMockApi({
      session: makeUser(),
      libraries: [makeLibrary('Movies', 'movies')],
      details: { 'movie-1': makeDetail(movie, { files: [makeFile({ id: 'file-1' })] }) },
    });
    const real = api.fetchMock.getMockImplementation();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (/\/api\/items\/movie-1$/.test(String(input))) {
        return gate.then(() => real!(input, init));
      }
      return real!(input, init);
    });

    renderApp(['/items/movie-1']);

    expect(await screen.findByTestId('detail-skeleton')).toBeInTheDocument();
    release();
    expect(await screen.findByRole('heading', { name: 'Arrival' })).toBeInTheDocument();
    expect(screen.queryByTestId('detail-skeleton')).not.toBeInTheDocument();
  });

  it('shows an error state with a working retry', async () => {
    const movie = makeItem({ id: 'movie-1', type: 'movie', title: 'Tenet' });
    const api = installMockApi({
      session: makeUser(),
      libraries: [makeLibrary('Movies', 'movies')],
      details: { 'movie-1': makeDetail(movie, { files: [makeFile({ id: 'file-1' })] }) },
    });
    const real = api.fetchMock.getMockImplementation();
    let failNext = true;
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (/\/api\/items\/movie-1$/.test(String(input)) && failNext) {
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

    renderApp(['/items/movie-1']);

    expect(await screen.findByText("Couldn't load this item")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Tenet' })).toBeInTheDocument();
  });

  it('shows a not-found cloak for an unknown or inaccessible item', async () => {
    renderDetail({}, 'ghost');

    expect(await screen.findByText('Not found')).toBeInTheDocument();
  });
});
