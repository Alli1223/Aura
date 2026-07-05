import type { ReactNode } from 'react';

import { ErrorState } from '../components/ErrorState';
import { FullPageLoader } from '../components/Spinner';
import { useAuth } from '../auth/context';

/**
 * Blocks the router until the boot refresh settles. A transient failure
 * (network / server error) shows a retryable error instead of dumping the
 * user on the login screen.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const { status, retryBoot } = useAuth();

  if (status === 'loading') {
    return <FullPageLoader label="Starting Aura" />;
  }

  if (status === 'error') {
    return (
      <ErrorState
        fullPage
        title="Can't reach the server"
        message="We couldn't restore your session. Check your connection and try again."
        onRetry={retryBoot}
      />
    );
  }

  return <>{children}</>;
}
