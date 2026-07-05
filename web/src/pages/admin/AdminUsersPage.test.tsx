import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AdminUser } from '../../api/admin';
import { installMockApi, makeAdminUser, makeUser, type MockApi } from '../../test/mockApi';
import { renderApp } from '../../test/renderApp';

/** Most recent request matching a URL suffix + method. */
function lastCall(api: MockApi, suffix: string, method: string) {
  return [...api.fetchMock.mock.calls]
    .reverse()
    .find(
      ([url, init]) =>
        String(url).endsWith(suffix) &&
        (init?.method ?? 'GET').toUpperCase() === method.toUpperCase(),
    );
}

function body(call: unknown[] | undefined): Record<string, unknown> {
  const init = call?.[1] as RequestInit | undefined;
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

function renderUsers(users: AdminUser[]): MockApi {
  const api = installMockApi({
    session: makeUser({ role: 'admin', id: 'me', username: 'boss' }),
    adminUsers: users,
  });
  renderApp(['/admin']);
  return api;
}

describe('AdminUsersPage', () => {
  it('renders a table of users', async () => {
    renderUsers([
      makeAdminUser({ id: 'u1', username: 'alice', email: 'alice@example.com', role: 'user' }),
      makeAdminUser({ id: 'u2', username: 'bob', role: 'admin' }),
    ]);

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Max quality' })).toBeInTheDocument();
  });

  it('changing a role PATCHes the user', async () => {
    const api = renderUsers([makeAdminUser({ id: 'u1', username: 'alice', role: 'user' })]);
    await screen.findByText('alice');

    fireEvent.change(screen.getByLabelText('Role for alice'), { target: { value: 'admin' } });

    await waitFor(() => expect(lastCall(api, '/users/u1', 'PATCH')).toBeDefined());
    expect(body(lastCall(api, '/users/u1', 'PATCH'))).toEqual({ role: 'admin' });
  });

  it('toggling enabled PATCHes the user', async () => {
    const api = renderUsers([makeAdminUser({ id: 'u1', username: 'alice', isEnabled: true })]);
    await screen.findByText('alice');

    fireEvent.click(screen.getByLabelText('Enabled for alice'));

    await waitFor(() => expect(lastCall(api, '/users/u1', 'PATCH')).toBeDefined());
    expect(body(lastCall(api, '/users/u1', 'PATCH'))).toEqual({ isEnabled: false });
  });

  it('surfaces the last-admin 409 as a friendly message', async () => {
    renderUsers([makeAdminUser({ id: 'u2', username: 'bob', role: 'admin', isEnabled: true })]);
    await screen.findByText('bob');

    fireEvent.change(screen.getByLabelText('Role for bob'), { target: { value: 'user' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/last enabled administrator/i);
  });

  it('reset password confirms then reveals the generated temporary password', async () => {
    const api = renderUsers([makeAdminUser({ id: 'u1', username: 'alice' })]);
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    fireEvent.click(await screen.findByRole('button', { name: /Generate temporary password/ }));

    await waitFor(() => expect(lastCall(api, '/users/u1/password', 'POST')).toBeDefined());
    const sent = String(body(lastCall(api, '/users/u1/password', 'POST')).newPassword);
    expect(sent.length).toBeGreaterThan(8);

    expect(await screen.findByRole('heading', { name: 'Temporary password' })).toBeInTheDocument();
    expect(screen.getByText(sent)).toBeInTheDocument();
  });

  it('deleting a user confirms and calls DELETE, then removes the row', async () => {
    const api = renderUsers([makeAdminUser({ id: 'u1', username: 'alice', role: 'user' })]);
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // Confirmation dialog.
    expect(await screen.findByRole('heading', { name: 'Delete user' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete user' }));

    await waitFor(() => expect(lastCall(api, '/users/u1', 'DELETE')).toBeDefined());
    await waitFor(() => expect(screen.queryByText('alice')).not.toBeInTheDocument());
  });

  it('redirects a non-admin away from the admin area', async () => {
    installMockApi({ session: makeUser({ role: 'user' }) });
    renderApp(['/admin']);

    expect(await screen.findByText(/Welcome back/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();
  });
});
