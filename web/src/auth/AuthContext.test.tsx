import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Providers } from '../app/Providers';
import { createTestQueryClient } from '../test/renderApp';
import { installMockApi, makeUser } from '../test/mockApi';
import { useAuth } from './context';

function TestConsumer() {
  const { status, user, login, logout } = useAuth();
  return (
    <div>
      <p>status: {status}</p>
      <p>user: {user?.username ?? 'none'}</p>
      <button
        type="button"
        onClick={() => void login({ username: 'bob', password: 'pw-123456789' })}
      >
        do-login
      </button>
      <button type="button" onClick={() => void logout()}>
        do-logout
      </button>
    </div>
  );
}

function renderConsumer() {
  return render(
    <Providers queryClient={createTestQueryClient()}>
      <TestConsumer />
    </Providers>,
  );
}

describe('AuthProvider', () => {
  it('restores the session on boot via a refresh', async () => {
    installMockApi({ session: makeUser({ username: 'alli' }) });
    renderConsumer();

    await screen.findByText('status: authenticated');
    expect(screen.getByText('user: alli')).toBeInTheDocument();
  });

  it('reports unauthenticated when the boot refresh has no session', async () => {
    installMockApi({ session: null });
    renderConsumer();

    await screen.findByText('status: unauthenticated');
    expect(screen.getByText('user: none')).toBeInTheDocument();
  });

  it('transitions through login and logout', async () => {
    installMockApi({
      session: null,
      password: 'pw-123456789',
      authUser: makeUser({ username: 'bob' }),
    });
    renderConsumer();

    await screen.findByText('status: unauthenticated');

    fireEvent.click(screen.getByRole('button', { name: 'do-login' }));
    await screen.findByText('status: authenticated');
    expect(screen.getByText('user: bob')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'do-logout' }));
    await waitFor(() => expect(screen.getByText('status: unauthenticated')).toBeInTheDocument());
    expect(screen.getByText('user: none')).toBeInTheDocument();
  });
});
