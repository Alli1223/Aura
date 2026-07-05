import { QueryClient } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { AppRoutes } from '../app/AppRoutes';
import { Providers } from '../app/Providers';

/** A QueryClient tuned for tests: no retries, no background refetching. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });
}

/** Renders the full route tree at the given path with an isolated cache. */
export function renderApp(initialEntries: string[] = ['/']): RenderResult {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Providers queryClient={createTestQueryClient()}>
        <AppRoutes />
      </Providers>
    </MemoryRouter>,
  );
}
