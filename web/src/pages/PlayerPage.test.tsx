import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, type Location } from 'react-router';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import Hls from 'hls.js';

import { AppRoutes } from '../app/AppRoutes';
import { Providers } from '../app/Providers';
import {
  installMockApi,
  makeAudioTrack,
  makeDetail,
  makeDirectDecision,
  makeFile,
  makeItem,
  makePlaylistDetail,
  makePlaylistItem,
  makeQualities,
  makeSubtitleTrack,
  makeTranscodeDecision,
  makeTrickplayManifest,
  makeUser,
  type MockApi,
  type MockApiConfig,
} from '../test/mockApi';
import { LocationProbe } from '../test/LocationProbe';
import { createTestQueryClient, renderApp } from '../test/renderApp';

// hls.js is mocked wholesale: a fake class recording its instances plus the
// static surface the player touches (isSupported / Events). jsdom cannot play
// media, so the transcode path is verified by asserting loadSource/attachMedia
// were called — the real segment loading never runs.
vi.mock('hls.js', () => {
  class FakeHls {
    static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
    static isSupported = vi.fn(() => true);
    static instances: FakeHls[] = [];
    loadSource = vi.fn();
    attachMedia = vi.fn();
    on = vi.fn();
    destroy = vi.fn();
    constructor() {
      FakeHls.instances.push(this);
    }
  }
  return { default: FakeHls };
});

interface FakeHlsInstance {
  loadSource: Mock;
  attachMedia: Mock;
  on: Mock;
  destroy: Mock;
}
const HlsMock = Hls as unknown as { instances: FakeHlsInstance[]; isSupported: Mock };

let playSpy: Mock;
let pauseSpy: Mock;
let requestFullscreenSpy: Mock;

beforeEach(() => {
  HlsMock.instances.length = 0;
  HlsMock.isSupported.mockReturnValue(true);

  // jsdom's HTMLMediaElement throws on play(); stub play/pause so they drive the
  // paused flag + fire the matching events, and back currentTime with a field.
  playSpy = vi.fn(function (this: HTMLMediaElement) {
    (this as unknown as { _paused: boolean })._paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  pauseSpy = vi.fn(function (this: HTMLMediaElement) {
    (this as unknown as { _paused: boolean })._paused = true;
    this.dispatchEvent(new Event('pause'));
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: playSpy });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: pauseSpy,
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get(this: { _paused?: boolean }) {
      return this._paused ?? true;
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get(this: { _ct?: number }) {
      return this._ct ?? 0;
    },
    set(this: { _ct?: number }, value: number) {
      this._ct = value;
    },
  });

  requestFullscreenSpy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(Element.prototype, 'requestFullscreen', {
    configurable: true,
    value: requestFullscreenSpy,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
});

function setup(
  config: MockApiConfig,
  path: string,
): { api: MockApi; view: ReturnType<typeof renderApp> } {
  const api = installMockApi({ session: makeUser({ username: 'alli' }), ...config });
  const view = renderApp([path]);
  return { api, view };
}

/** POST /api/stream/hls/:mediaFileId calls, as parsed URLs (start requests). */
function hlsStartCalls(api: MockApi, mediaFileId: string): URL[] {
  return api.fetchMock.mock.calls
    .filter(([url, init]) => {
      const parsed = new URL(String(url), 'http://localhost');
      return (
        parsed.pathname === `/api/stream/hls/${mediaFileId}` &&
        (init as RequestInit | undefined)?.method === 'POST'
      );
    })
    .map(([url]) => new URL(String(url), 'http://localhost'));
}

/** DELETE /api/stream/hls/:sessionId calls, as parsed URLs. */
function hlsDeleteCalls(api: MockApi): URL[] {
  return api.fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        /\/api\/stream\/hls\/[^/]+(\?|$)/.test(String(url)) &&
        (init as RequestInit | undefined)?.method === 'DELETE',
    )
    .map(([url]) => new URL(String(url), 'http://localhost'));
}

/** Bodies of POST /api/items/:id/progress calls. */
function progressCalls(api: MockApi, itemId: string): { positionMs: number }[] {
  return api.fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url).includes(`/api/items/${itemId}/progress`) &&
        (init as RequestInit | undefined)?.method === 'POST',
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { positionMs: number });
}

describe('PlayerPage — decision & attach', () => {
  it('direct play: points the <video> at the token-carrying direct URL', async () => {
    const { api } = setup(
      { decisions: { 'file-1': makeDirectDecision('file-1') } },
      '/player/file-1',
    );

    const video = await screen.findByTestId('player-video');
    await waitFor(() =>
      expect(video.getAttribute('src')).toBe('/api/stream/direct/file-1?token=stream-token'),
    );

    const decided = api.fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url).includes('/api/stream/decide/file-1') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(decided).toBe(true);
    // Direct play never spins up hls.js.
    expect(HlsMock.instances).toHaveLength(0);
  });

  it('transcode: starts an HLS session and attaches hls.js to the playlist', async () => {
    const { api } = setup(
      { decisions: { 'file-1': makeTranscodeDecision('file-1', '720p') } },
      '/player/file-1',
    );

    await waitFor(() => expect(hlsStartCalls(api, 'file-1')).toHaveLength(1));
    await waitFor(() => expect(HlsMock.instances.length).toBeGreaterThan(0));

    const instance = HlsMock.instances.at(-1);
    expect(instance).toBeDefined();
    await waitFor(() => expect(instance?.loadSource).toHaveBeenCalled());
    const playlistUrl = String(instance?.loadSource.mock.calls[0]?.[0]);
    expect(playlistUrl).toMatch(/\/api\/stream\/hls\/session-\d+\/index\.m3u8\?token=stream-token/);
    expect(instance?.attachMedia).toHaveBeenCalled();

    // The first start requests the server-chosen rung from t=0.
    const first = hlsStartCalls(api, 'file-1')[0];
    expect(first?.searchParams.get('quality')).toBe('720p');
    expect(first?.searchParams.get('startOffset')).toBe('0');
  });

  it('shows an error with a link back when the decision is forbidden (404)', async () => {
    const api = installMockApi({ session: makeUser() });
    const real = api.fetchMock.getMockImplementation();
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (/\/api\/stream\/decide\//.test(String(input))) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'gone' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return real!(input, init);
    });
    renderApp(['/player/file-1']);

    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
  });
});

describe('PlayerPage — quality / audio / subtitles', () => {
  it('quality menu lists /api/qualities and switching restarts the session at the current position', async () => {
    const { api } = setup(
      {
        decisions: { 'file-1': makeTranscodeDecision('file-1', '720p') },
        qualities: makeQualities(),
      },
      '/player/file-1',
    );

    await waitFor(() => expect(hlsStartCalls(api, 'file-1')).toHaveLength(1));

    const video = screen.getByTestId('player-video') as HTMLVideoElement;
    video.currentTime = 42;

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Quality/ }));
    // The menu lists every permitted rung.
    expect(screen.getByRole('menuitemradio', { name: /1080p/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /480p/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /480p/ }));

    await waitFor(() => expect(hlsStartCalls(api, 'file-1')).toHaveLength(2));
    const restart = hlsStartCalls(api, 'file-1').at(-1);
    expect(restart?.searchParams.get('quality')).toBe('480p');
    expect(restart?.searchParams.get('startOffset')).toBe('42');
    // Restarting frees the previous transcode session.
    expect(hlsDeleteCalls(api).length).toBeGreaterThan(0);
  });

  it('audio menu switches the track, restarting the session with the new audioTrack', async () => {
    const { api } = setup(
      {
        decisions: { 'file-1': makeTranscodeDecision('file-1', '720p') },
        audioTracks: {
          'file-1': [
            makeAudioTrack({ index: 0, label: 'English Stereo (AAC)', default: true }),
            makeAudioTrack({
              index: 1,
              label: 'French Stereo (AAC)',
              language: 'fra',
              default: false,
            }),
          ],
        },
      },
      '/player/file-1',
    );

    await waitFor(() => expect(hlsStartCalls(api, 'file-1')).toHaveLength(1));

    const video = screen.getByTestId('player-video') as HTMLVideoElement;
    video.currentTime = 20;

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Audio/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /French/ }));

    await waitFor(() => expect(hlsStartCalls(api, 'file-1')).toHaveLength(2));
    const restart = hlsStartCalls(api, 'file-1').at(-1);
    expect(restart?.searchParams.get('audioTrack')).toBe('1');
    expect(restart?.searchParams.get('startOffset')).toBe('20');
  });

  it('renders a text subtitle <track>, toggles it on/off, and disables image subs', async () => {
    setup(
      {
        decisions: { 'file-1': makeDirectDecision('file-1') },
        subtitles: {
          'file-1': [
            makeSubtitleTrack({ id: 'embedded-2', kind: 'text', label: 'English' }),
            makeSubtitleTrack({ id: 'embedded-3', kind: 'image', label: 'Spanish (PGS)' }),
          ],
        },
      },
      '/player/file-1',
    );

    const video = await screen.findByTestId('player-video');
    // Only the text track is added as a <track>, pointing at the token .vtt URL.
    await waitFor(() => expect(video.querySelectorAll('track')).toHaveLength(1));
    const track = video.querySelector('track');
    expect(track?.getAttribute('src')).toBe(
      '/api/stream/subtitles/file-1/embedded-2.vtt?token=stream-token',
    );

    // Image-based tracks are surfaced but disabled with an explanatory tooltip.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Subtitles/ }));
    const imageOption = screen.getByRole('menuitemradio', { name: /Spanish \(PGS\)/ });
    expect(imageOption).toHaveAttribute('aria-disabled', 'true');
    expect(imageOption).toHaveAttribute('title', 'Not supported in browser');

    // The quick-toggle turns subtitles on (first text track) then off again.
    const toggle = screen.getByRole('button', { name: 'Toggle subtitles' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('PlayerPage — resume, progress & lifecycle', () => {
  const resumeConfig = (): MockApiConfig => {
    const item = makeItem({
      id: 'movie-1',
      type: 'movie',
      title: 'Interstellar',
      runtimeMs: 120_000,
      watchState: {
        watched: false,
        positionMs: 45_000,
        episodeCount: 0,
        watchedEpisodeCount: 0,
        nextUnwatchedId: null,
      },
    });
    return {
      decisions: { 'file-1': makeDirectDecision('file-1') },
      details: {
        'movie-1': makeDetail(item, { files: [makeFile({ id: 'file-1', durationMs: 120_000 })] }),
      },
    };
  };

  it('prompts to resume and "Start over" begins at 0', async () => {
    setup(resumeConfig(), '/player/file-1?item=movie-1');

    expect(await screen.findByRole('dialog', { name: 'Resume playback' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Start over/ }));

    const video = screen.getByTestId('player-video') as HTMLVideoElement;
    await waitFor(() => expect(video.getAttribute('src')).toContain('stream-token'));
    expect(video.currentTime).toBe(0);
    expect(playSpy).toHaveBeenCalled();
  });

  it('"Resume" begins at the stored position', async () => {
    setup(resumeConfig(), '/player/file-1?item=movie-1');

    fireEvent.click(await screen.findByRole('button', { name: /Resume from/ }));

    const video = screen.getByTestId('player-video') as HTMLVideoElement;
    await waitFor(() => expect(video.getAttribute('src')).toContain('stream-token'));
    expect(video.currentTime).toBe(45);
  });

  it('reports progress on pause and again on unmount with the item id + position', async () => {
    const item = makeItem({ id: 'movie-1', type: 'movie', title: 'Dune', runtimeMs: 120_000 });
    const { api, view } = setup(
      {
        decisions: { 'file-1': makeDirectDecision('file-1') },
        details: {
          'movie-1': makeDetail(item, { files: [makeFile({ id: 'file-1', durationMs: 120_000 })] }),
        },
      },
      '/player/file-1?item=movie-1',
    );

    const video = (await screen.findByTestId('player-video')) as HTMLVideoElement;
    await waitFor(() => expect(video.getAttribute('src')).toContain('stream-token'));

    video.currentTime = 15;
    fireEvent.pause(video);
    await waitFor(() => expect(progressCalls(api, 'movie-1').length).toBeGreaterThan(0));
    expect(progressCalls(api, 'movie-1').at(-1)?.positionMs).toBe(15_000);

    video.currentTime = 30;
    fireEvent.timeUpdate(video);
    view.unmount();
    await waitFor(() =>
      expect(progressCalls(api, 'movie-1').some((call) => call.positionMs === 30_000)).toBe(true),
    );
  });

  it('deletes the HLS session on unmount to free the transcode slot', async () => {
    const { api, view } = setup(
      { decisions: { 'file-1': makeTranscodeDecision('file-1') } },
      '/player/file-1',
    );

    await waitFor(() => expect(hlsStartCalls(api, 'file-1')).toHaveLength(1));
    view.unmount();

    await waitFor(() => expect(hlsDeleteCalls(api).length).toBeGreaterThan(0));
    expect(hlsDeleteCalls(api)[0]?.pathname).toBe('/api/stream/hls/session-1');
  });
});

describe('PlayerPage — session lifecycle robustness', () => {
  it('attaches hls.js under a StrictMode double-mount (transcode)', async () => {
    installMockApi({
      session: makeUser(),
      decisions: { 'file-1': makeTranscodeDecision('file-1', '720p') },
    });
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/player/file-1']}>
          <Providers queryClient={createTestQueryClient()}>
            <AppRoutes />
          </Providers>
        </MemoryRouter>
      </StrictMode>,
    );

    // The double-mount must not leave the video without a stream: exactly one
    // hls.js instance ends up with the playlist loaded.
    await waitFor(() =>
      expect(HlsMock.instances.filter((i) => i.loadSource.mock.calls.length > 0)).toHaveLength(1),
    );
  });

  it('rapid quality switches attach only the latest session and free the superseded one', async () => {
    const api = installMockApi({
      session: makeUser(),
      decisions: { 'file-1': makeTranscodeDecision('file-1', '720p') },
      qualities: makeQualities(),
    });

    // Gate hls-start responses so two switches can be in flight simultaneously.
    const real = api.fetchMock.getMockImplementation();
    const gates: Array<() => void> = [];
    let gateStarts = false;
    api.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const isStart =
        /\/api\/stream\/hls\/file-1(\?|$)/.test(String(input)) &&
        (init?.method ?? 'GET').toUpperCase() === 'POST';
      if (gateStarts && isStart) {
        return new Promise<Response>((resolve) => {
          gates.push(() => resolve(real!(input, init) as Promise<Response>));
        });
      }
      return real!(input, init) as Promise<Response>;
    });

    renderApp(['/player/file-1']);
    await waitFor(() => expect(HlsMock.instances).toHaveLength(1));

    gateStarts = true;
    const video = screen.getByTestId('player-video') as HTMLVideoElement;
    video.currentTime = 10;

    // Switch to 480p, then immediately to 360p (both start requests gated).
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Quality/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /480p/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Quality/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /360p/ }));

    await waitFor(() => expect(gates).toHaveLength(2));
    // Release both in-flight starts; the superseded (480p) one must be discarded.
    gates.forEach((release) => release());

    await waitFor(() => expect(HlsMock.instances).toHaveLength(2));
    const latest = HlsMock.instances.at(-1);
    expect(String(latest?.loadSource.mock.calls[0]?.[0])).toContain('session-3');
    // The orphaned 480p session (session-2) was DELETEd, not leaked.
    await waitFor(() =>
      expect(hlsDeleteCalls(api).some((url) => url.pathname === '/api/stream/hls/session-2')).toBe(
        true,
      ),
    );
  });
});

describe('PlayerPage — user playback preferences', () => {
  it("starts a transcode at the user's preferred quality", async () => {
    const { api } = setup(
      {
        session: makeUser({ preferredQuality: '480p' }),
        decisions: { 'file-1': makeTranscodeDecision('file-1', '720p') },
        qualities: makeQualities(),
      },
      '/player/file-1',
    );

    await waitFor(() => expect(hlsStartCalls(api, 'file-1')).toHaveLength(1));
    // The first HLS start uses the preference (480p), not the decision's 720p.
    expect(hlsStartCalls(api, 'file-1')[0]?.searchParams.get('quality')).toBe('480p');
  });

  it('clamps a preferred quality above the effective max down to the cap', async () => {
    const { api } = setup(
      {
        session: makeUser({ preferredQuality: '1080p' }),
        decisions: { 'file-1': makeTranscodeDecision('file-1', '480p') },
        // Effective max is 480p: 1080p is not selectable and must clamp to 480p.
        qualities: makeQualities({
          maxQuality: '480p',
          defaultQuality: '480p',
          qualities: [
            { name: '480p', maxWidth: 854, videoBitrate: '1400k', audioBitrate: '128k' },
            { name: '360p', maxWidth: 640, videoBitrate: '800k', audioBitrate: '96k' },
          ],
        }),
      },
      '/player/file-1',
    );

    await waitFor(() => expect(hlsStartCalls(api, 'file-1')).toHaveLength(1));
    expect(hlsStartCalls(api, 'file-1')[0]?.searchParams.get('quality')).toBe('480p');
  });

  it('pre-selects the subtitle track matching the preferred language', async () => {
    setup(
      {
        session: makeUser({ preferredSubtitleLanguage: 'fra' }),
        decisions: { 'file-1': makeDirectDecision('file-1') },
        subtitles: {
          'file-1': [
            makeSubtitleTrack({
              id: 'embedded-2',
              kind: 'text',
              language: 'eng',
              label: 'English',
            }),
            makeSubtitleTrack({ id: 'embedded-3', kind: 'text', language: 'fra', label: 'French' }),
          ],
        },
      },
      '/player/file-1',
    );

    await screen.findByTestId('player-video');
    const toggle = await screen.findByRole('button', { name: 'Toggle subtitles' });
    // The matching (French) track is auto-enabled on load.
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Subtitles/ }));
    expect(screen.getByRole('menuitemradio', { name: /French/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: /English/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('does not auto-enable subtitles when the preference is "off"', async () => {
    setup(
      {
        session: makeUser({ preferredSubtitleLanguage: 'off' }),
        decisions: { 'file-1': makeDirectDecision('file-1') },
        subtitles: {
          'file-1': [
            makeSubtitleTrack({
              id: 'embedded-2',
              kind: 'text',
              language: 'eng',
              label: 'English',
            }),
          ],
        },
      },
      '/player/file-1',
    );

    const toggle = await screen.findByRole('button', { name: 'Toggle subtitles' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  const renderWithNextQueue = (session: ReturnType<typeof makeUser>) => {
    installMockApi({
      session,
      decisions: { 'file-1': makeDirectDecision('file-1') },
    });
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/player/file-1',
            state: {
              queue: [{ mediaFileId: 'file-2', itemId: 'item-2', title: 'Episode 2' }],
            },
          },
        ]}
      >
        <Providers queryClient={createTestQueryClient()}>
          <AppRoutes />
        </Providers>
      </MemoryRouter>,
    );
  };

  it('auto-advances (shows the countdown) when autoplay is on', async () => {
    renderWithNextQueue(makeUser({ autoplayNextEpisode: true }));

    const video = await screen.findByTestId('player-video');
    fireEvent.ended(video);

    await screen.findByRole('dialog', { name: 'Playback finished' });
    expect(screen.getByText('Up next')).toBeInTheDocument();
    // The countdown ("starting in Ns") is the auto-advance behaviour.
    expect(screen.getByText(/starting in/i)).toBeInTheDocument();
  });

  it('offers "Up next" without a countdown when autoplay is off', async () => {
    renderWithNextQueue(makeUser({ autoplayNextEpisode: false }));

    const video = await screen.findByTestId('player-video');
    fireEvent.ended(video);

    await screen.findByRole('dialog', { name: 'Playback finished' });
    expect(screen.getByText('Up next')).toBeInTheDocument();
    // No auto-advance: the countdown text is absent, but a manual Play now remains.
    expect(screen.queryByText(/starting in/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Play now/ })).toBeInTheDocument();
  });
});

describe('PlayerPage — playlist queue (continuous playback)', () => {
  const twoItemPlaylist = () =>
    makePlaylistDetail({
      id: 'pl-1',
      items: [
        makePlaylistItem({ id: 'a', title: 'Alpha', order: 0, primaryMediaFileId: 'file-1' }),
        makePlaylistItem({ id: 'b', title: 'Bravo', order: 1, primaryMediaFileId: 'file-2' }),
      ],
    });

  it('advances to the next playlist item on ended, carrying the playlist URL context', async () => {
    let location: Location | undefined;
    const api = installMockApi({
      session: makeUser({ autoplayNextEpisode: true }),
      decisions: {
        'file-1': makeDirectDecision('file-1'),
        'file-2': makeDirectDecision('file-2'),
      },
      playlistDetails: { 'pl-1': twoItemPlaylist() },
    });
    renderApp(['/player/file-1?item=a&playlist=pl-1&index=0'], (loc) => {
      location = loc;
    });

    await screen.findByTestId('player-video');
    // The player derives its queue from the playlist (GET /api/playlists/pl-1).
    await waitFor(() =>
      expect(
        api.fetchMock.mock.calls.some(([url]) => String(url).includes('/api/playlists/pl-1')),
      ).toBe(true),
    );

    fireEvent.ended(screen.getByTestId('player-video'));
    // "Up next" surfaces the next playlist item.
    expect(await screen.findByText('Up next')).toBeInTheDocument();
    expect(screen.getByText(/Bravo/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /play now/i }));

    // Navigates to the next item with the playlist queue context in the URL.
    await waitFor(() => expect(location?.pathname).toBe('/player/file-2'));
    const search = new URLSearchParams(location?.search ?? '');
    expect(search.get('item')).toBe('b');
    expect(search.get('playlist')).toBe('pl-1');
    expect(search.get('index')).toBe('1');
  });

  it('shows "Finished" at the end of the playlist (no next item)', async () => {
    installMockApi({
      session: makeUser({ autoplayNextEpisode: true }),
      decisions: { 'file-2': makeDirectDecision('file-2') },
      playlistDetails: { 'pl-1': twoItemPlaylist() },
    });
    renderApp(['/player/file-2?item=b&playlist=pl-1&index=1']);

    const video = await screen.findByTestId('player-video');
    fireEvent.ended(video);

    expect(await screen.findByRole('dialog', { name: 'Playback finished' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replay/i })).toBeInTheDocument();
    expect(screen.queryByText('Up next')).not.toBeInTheDocument();
  });
});

describe('PlayerPage — skip intro / credits markers', () => {
  /** A 1000s movie with a resolved duration and the given skip markers. */
  const movieWithMarkers = (
    markers: { type: 'intro' | 'credits'; startMs: number; endMs: number }[],
  ): MockApiConfig => {
    const item = makeItem({ id: 'movie-1', type: 'movie', title: 'Movie', runtimeMs: 1_000_000 });
    return {
      decisions: { 'file-1': makeDirectDecision('file-1') },
      details: {
        'movie-1': makeDetail(item, {
          files: [makeFile({ id: 'file-1', durationMs: 1_000_000, markers })],
        }),
      },
    };
  };

  it('shows "Skip Intro" within the intro range and seeks past it on click', async () => {
    setup(
      movieWithMarkers([{ type: 'intro', startMs: 0, endMs: 60_000 }]),
      '/player/file-1?item=movie-1',
    );

    const video = (await screen.findByTestId('player-video')) as HTMLVideoElement;
    await waitFor(() => expect(video.getAttribute('src')).toContain('stream-token'));

    // Playback begins at t=0, inside [0, 60000) => the button is offered.
    const skip = await screen.findByRole('button', { name: 'Skip Intro' });
    fireEvent.click(skip);

    // Direct play: seeking sets currentTime to the marker end (60s).
    expect(video.currentTime).toBe(60);
    // Now past the intro, the button disappears.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Skip Intro' })).not.toBeInTheDocument(),
    );
  });

  it('shows "Skip Credits" only once the playhead enters the credits range', async () => {
    setup(
      movieWithMarkers([{ type: 'credits', startMs: 900_000, endMs: 1_000_000 }]),
      '/player/file-1?item=movie-1',
    );

    const video = (await screen.findByTestId('player-video')) as HTMLVideoElement;
    await waitFor(() => expect(video.getAttribute('src')).toContain('stream-token'));

    // At t=0 there is no credits button yet.
    expect(screen.queryByRole('button', { name: 'Skip Credits' })).not.toBeInTheDocument();

    // Advance into the credits range.
    video.currentTime = 950;
    fireEvent.timeUpdate(video);

    const skip = await screen.findByRole('button', { name: 'Skip Credits' });
    fireEvent.click(skip);
    // No next item queued => seeks to the end of the credits marker (1000s).
    expect(video.currentTime).toBe(1000);
  });

  it('hides the skip button outside every marker range', async () => {
    setup(
      movieWithMarkers([{ type: 'intro', startMs: 0, endMs: 60_000 }]),
      '/player/file-1?item=movie-1',
    );

    const video = (await screen.findByTestId('player-video')) as HTMLVideoElement;
    await waitFor(() => expect(video.getAttribute('src')).toContain('stream-token'));

    // Move well past the intro; no marker covers this position.
    video.currentTime = 300;
    fireEvent.timeUpdate(video);

    await waitFor(() =>
      expect(screen.queryByTestId('skip-button')).not.toBeInTheDocument(),
    );
  });

  it('renders no skip button when the file has no markers', async () => {
    setup(movieWithMarkers([]), '/player/file-1?item=movie-1');
    await screen.findByTestId('player-video');
    expect(screen.queryByTestId('skip-button')).not.toBeInTheDocument();
  });

  it('"Skip Credits" advances to the next queued item when one exists', async () => {
    let location: Location | undefined;
    const item = makeItem({ id: 'a', type: 'episode', title: 'Alpha', runtimeMs: 1_000_000 });
    installMockApi({
      session: makeUser({ autoplayNextEpisode: true }),
      decisions: {
        'file-1': makeDirectDecision('file-1'),
        'file-2': makeDirectDecision('file-2'),
      },
      details: {
        a: makeDetail(item, {
          files: [
            makeFile({
              id: 'file-1',
              durationMs: 1_000_000,
              markers: [{ type: 'credits', startMs: 900_000, endMs: 1_000_000 }],
            }),
          ],
        }),
      },
    });
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/player/file-1',
            search: '?item=a',
            state: {
              queue: [{ mediaFileId: 'file-2', itemId: 'b', title: 'Bravo' }],
            },
          },
        ]}
      >
        <Providers queryClient={createTestQueryClient()}>
          <AppRoutes />
          <LocationProbe onLocation={(loc) => (location = loc)} />
        </Providers>
      </MemoryRouter>,
    );

    const video = (await screen.findByTestId('player-video')) as HTMLVideoElement;
    await waitFor(() => expect(video.getAttribute('src')).toContain('stream-token'));

    video.currentTime = 950;
    fireEvent.timeUpdate(video);

    fireEvent.click(await screen.findByRole('button', { name: 'Skip Credits' }));
    await waitFor(() => expect(location?.pathname).toBe('/player/file-2'));
    expect(new URLSearchParams(location?.search ?? '').get('item')).toBe('b');
  });
});

describe('PlayerPage — keyboard shortcuts', () => {
  it('space toggles play/pause and "f" requests fullscreen', async () => {
    setup({ decisions: { 'file-1': makeDirectDecision('file-1') } }, '/player/file-1');

    await screen.findByTestId('player-video');
    await waitFor(() => expect(playSpy).toHaveBeenCalled());

    // Playing → space pauses.
    fireEvent.keyDown(window, { key: ' ' });
    expect(pauseSpy).toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'f' });
    expect(requestFullscreenSpy).toHaveBeenCalled();
  });
});

describe('PlayerPage — trickplay scrub preview & chapter markers', () => {
  /** Stubs an element's geometry so the hover math has a real bar width. */
  const stubRect = (element: Element, width: number, left = 0): void => {
    element.getBoundingClientRect = () =>
      ({
        left,
        right: left + width,
        width,
        top: 0,
        bottom: 20,
        height: 20,
        x: left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  /** A 1000s movie with a resolved duration so the seek bar has a scale. */
  const movieWith = (
    extra: Partial<MockApiConfig>,
    fileOverrides: Parameters<typeof makeFile>[0] = {},
  ): MockApiConfig => {
    const item = makeItem({ id: 'movie-1', type: 'movie', title: 'Movie', runtimeMs: 1_000_000 });
    return {
      decisions: { 'file-1': makeDirectDecision('file-1') },
      details: {
        'movie-1': makeDetail(item, {
          files: [makeFile({ id: 'file-1', durationMs: 1_000_000, ...fileOverrides })],
        }),
      },
      ...extra,
    };
  };

  it('shows a trickplay thumbnail on seek-bar hover and hides it on leave', async () => {
    setup(
      movieWith({ trickplay: { 'file-1': makeTrickplayManifest('file-1') } }),
      '/player/file-1?item=movie-1',
    );

    const scrubBar = await screen.findByTestId('scrub-bar');
    stubRect(scrubBar, 1000);

    // No preview until the pointer moves over the bar.
    expect(screen.queryByTestId('trickplay-preview')).not.toBeInTheDocument();

    fireEvent.pointerMove(scrubBar, { clientX: 500 });

    // 50% of a 1000s file => 8:20; a thumbnail is drawn for that hover time.
    const preview = await screen.findByTestId('trickplay-preview');
    expect(preview).toBeInTheDocument();
    expect(screen.getByText('8:20')).toBeInTheDocument();
    const thumb = screen.getByTestId('trickplay-thumb');
    // t=500s => index 50 => sheet 0, col 0, row 5 => offset (0, -900).
    expect(thumb.style.backgroundImage).toContain(
      '/api/stream/trickplay/file-1/sprite-0.jpg?token=stream-token',
    );
    // A zero x-offset serialises as "0px" (browsers/jsdom normalise "-0px").
    expect(thumb.style.backgroundPosition).toBe('0px -900px');

    fireEvent.pointerLeave(scrubBar);
    await waitFor(() => expect(screen.queryByTestId('trickplay-preview')).not.toBeInTheDocument());
  });

  it('renders one chapter tick per chapter at the right position with a title tooltip', async () => {
    const chapters = [
      { index: 0, startMs: 0, endMs: 300_000, title: 'Intro' },
      { index: 1, startMs: 300_000, endMs: 600_000, title: 'The Heist' },
      { index: 2, startMs: 600_000, endMs: 1_000_000, title: null },
    ];
    setup(movieWith({}, { chapters }), '/player/file-1?item=movie-1');

    const markers = await screen.findAllByTestId('chapter-marker');
    expect(markers).toHaveLength(3);
    // startMs/durationMs: 300s of 1000s => 30% across the bar.
    expect(markers[1]).toHaveStyle({ left: '30%' });
    expect(markers[0]).toHaveAttribute('title', 'Intro');
    expect(markers[1]).toHaveAttribute('title', 'The Heist');
    // A titleless chapter falls back to its 1-based position.
    expect(markers[2]).toHaveAttribute('title', 'Chapter 3');
    expect(markers[0]).toHaveAttribute('aria-label', 'Jump to chapter: Intro');
  });

  it('seeks to the chapter start when a marker is clicked', async () => {
    const chapters = [
      { index: 0, startMs: 0, endMs: 300_000, title: 'Intro' },
      { index: 1, startMs: 300_000, endMs: 600_000, title: 'The Heist' },
    ];
    setup(movieWith({}, { chapters }), '/player/file-1?item=movie-1');

    const video = (await screen.findByTestId('player-video')) as HTMLVideoElement;
    await waitFor(() => expect(video.getAttribute('src')).toContain('stream-token'));

    const markers = await screen.findAllByTestId('chapter-marker');
    fireEvent.click(markers[1]!);
    // Direct play: seeking sets the element currentTime to the chapter start (300s).
    expect(video.currentTime).toBe(300);
  });

  it('degrades gracefully with no trickplay: no preview, but the player still works', async () => {
    // No `trickplay` entry → GET .../manifest answers 404 → null manifest.
    const { api } = setup(movieWith({}), '/player/file-1?item=movie-1');

    const scrubBar = await screen.findByTestId('scrub-bar');
    stubRect(scrubBar, 1000);

    // Let the manifest request resolve (to 404) before asserting no preview.
    await waitFor(() =>
      expect(
        api.fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/api/stream/trickplay/file-1/manifest'),
        ),
      ).toBe(true),
    );

    fireEvent.pointerMove(scrubBar, { clientX: 500 });
    expect(screen.queryByTestId('trickplay-preview')).not.toBeInTheDocument();

    // The player itself is unaffected: the video and a working seek bar remain.
    const video = screen.getByTestId('player-video') as HTMLVideoElement;
    expect(video).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: 'Seek' }), { target: { value: '120' } });
    expect(video.currentTime).toBe(120);
  });
});
