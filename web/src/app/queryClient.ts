import { QueryClient } from '@tanstack/react-query';

/** Builds a QueryClient with app defaults. A fresh one per test keeps caches isolated. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
        staleTime: 30 * 1000,
      },
    },
  });
}
