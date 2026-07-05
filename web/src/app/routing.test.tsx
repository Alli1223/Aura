import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { installMockApi, makeLibrary, makeUser } from '../test/mockApi';
import { renderApp } from '../test/renderApp';

describe('routing & shell', () => {
  it('redirects an unauthenticated visitor from a private route to /login', async () => {
    installMockApi({ session: null });
    renderApp(['/']);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('redirects an authenticated user away from /login to the home screen', async () => {
    installMockApi({ session: makeUser({ username: 'alli' }) });
    renderApp(['/login']);

    expect(await screen.findByText(/Welcome back, alli/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('blocks a non-admin from /admin and sends them home', async () => {
    installMockApi({ session: makeUser({ role: 'user' }) });
    renderApp(['/admin']);

    expect(await screen.findByText(/Welcome back/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('allows an admin into /admin', async () => {
    installMockApi({ session: makeUser({ role: 'admin' }) });
    renderApp(['/admin']);

    expect(await screen.findByRole('heading', { name: 'Admin' })).toBeInTheDocument();
  });

  it('renders exactly the permitted libraries returned by the API in the sidebar', async () => {
    installMockApi({
      session: makeUser({ username: 'alli' }),
      libraries: [makeLibrary('Movies', 'movies'), makeLibrary('Anime', 'anime')],
    });
    renderApp(['/']);

    await screen.findByText(/Welcome back/);

    // The sidebar fetches libraries independently; wait for them to land.
    expect(await screen.findByRole('link', { name: /Movies/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Anime/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Recordings/ })).not.toBeInTheDocument();

    const libraryLinks = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/library/'));
    expect(libraryLinks).toHaveLength(2);
  });

  it('hides the register link when registration is closed', async () => {
    installMockApi({ session: null, registrationEnabled: false });
    renderApp(['/login']);

    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByRole('link', { name: /Create one/i })).not.toBeInTheDocument();
  });

  it('shows a closed message on /register when registration is disabled', async () => {
    installMockApi({ session: null, registrationEnabled: false });
    renderApp(['/register']);

    expect(await screen.findByRole('heading', { name: 'Registration closed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create account/ })).not.toBeInTheDocument();
  });
});

describe('mustChangePassword gate', () => {
  it('forces the change-password screen and clears it on a successful submit', async () => {
    const api = installMockApi({
      session: makeUser({ username: 'alli', mustChangePassword: true }),
      libraries: [makeLibrary('Movies', 'movies')],
      password: 'old-pass-123',
    });
    renderApp(['/']);

    // Gate is shown instead of the app.
    expect(await screen.findByRole('heading', { name: 'Set a new password' })).toBeInTheDocument();
    expect(screen.queryByText(/Welcome back/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old-pass-123' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'brand-new-pass-1' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'brand-new-pass-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    // Gate clears → the app renders.
    expect(await screen.findByText(/Welcome back/)).toBeInTheDocument();

    const passwordCall = api.fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/users/me/password'),
    );
    expect(passwordCall).toBeDefined();
    expect(JSON.parse(String(passwordCall?.[1]?.body))).toEqual({
      currentPassword: 'old-pass-123',
      newPassword: 'brand-new-pass-1',
    });
  });
});
