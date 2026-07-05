import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
  installMockApi,
  makeDetail,
  makeEpisode,
  makeItem,
  MOCK_ACCESS_TOKEN,
} from '../test/mockApi';
import { createTestQueryClient } from '../test/renderApp';
import { setAccessToken } from './client';
import { useItemChildren } from './detail';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: createTestQueryClient() }, children);
}

describe('useItemChildren', () => {
  it("fetches a season's episodes from GET /items/:id/children", async () => {
    setAccessToken(MOCK_ACCESS_TOKEN);
    const season = makeItem({ id: 'season-1', type: 'season' });
    const episodes = [
      makeEpisode({ id: 'ep-1', title: 'Pilot' }),
      makeEpisode({ id: 'ep-2', title: 'Second' }),
    ];
    installMockApi({ details: { 'season-1': makeDetail(season, { episodes }) } });

    const { result } = renderHook(() => useItemChildren('season-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((child) => child.id)).toEqual(['ep-1', 'ep-2']);
  });

  it("fetches a show's seasons from GET /items/:id/children", async () => {
    setAccessToken(MOCK_ACCESS_TOKEN);
    const show = makeItem({ id: 'show-1', type: 'show' });
    const seasons = [makeItem({ id: 'season-1', type: 'season', title: 'Season 1' })];
    installMockApi({ details: { 'show-1': makeDetail(show, { seasons }) } });

    const { result } = renderHook(() => useItemChildren('show-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.id).toBe('season-1');
  });

  it('does not fetch when the id is empty', () => {
    setAccessToken(MOCK_ACCESS_TOKEN);
    const api = installMockApi({});

    const { result } = renderHook(() => useItemChildren(''), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(api.fetchMock).not.toHaveBeenCalled();
  });
});
