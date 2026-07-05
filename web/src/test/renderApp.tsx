import { QueryClient } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter, type Location } from 'react-router';

import { AppRoutes } from '../app/AppRoutes';
import { Providers } from '../app/Providers';
import { LocationProbe } from './LocationProbe';

/** A QueryClient tuned for tests: no retries, no background refetching. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });
}

/**
 * Renders the full route tree at the given path with an isolated cache.
 * Pass `onLocation` to observe the router location (for URL-reflection asserts).
 */
export function renderApp(
  initialEntries: string[] = ['/'],
  onLocation?: (location: Location) => void,
): RenderResult {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Providers queryClient={createTestQueryClient()}>
        <AppRoutes />
        {onLocation && <LocationProbe onLocation={onLocation} />}
      </Providers>
    </MemoryRouter>,
  );
}
