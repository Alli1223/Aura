import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { getLibraries, getPublicSettings } from './endpoints';
import type { Library, PublicSettings } from './types';

export const queryKeys = {
  publicSettings: ['public-settings'] as const,
  libraries: ['libraries'] as const,
};

/** Server name + registration toggle. Safe to call while unauthenticated. */
export function usePublicSettings(): UseQueryResult<PublicSettings> {
  return useQuery({
    queryKey: queryKeys.publicSettings,
    queryFn: getPublicSettings,
    staleTime: 5 * 60 * 1000,
  });
}

/** The current user's permitted libraries — powers the sidebar. */
export function useLibraries(): UseQueryResult<Library[]> {
  return useQuery({
    queryKey: queryKeys.libraries,
    queryFn: getLibraries,
    staleTime: 60 * 1000,
  });
}
