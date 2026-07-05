import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { AuthProvider } from '../auth/AuthProvider';
import { createQueryClient } from './queryClient';

/**
 * App-wide providers: TanStack Query + auth. Tests can inject their own
 * QueryClient to keep caches isolated.
 */
export function Providers({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  const [client] = useState(() => queryClient ?? createQueryClient());

  return (
    <QueryClientProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
