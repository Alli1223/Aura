import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActivitySession } from '../../api/activity';
import { installMockApi, makeActivitySession, makeUser, type MockApi } from '../../test/mockApi';
import { renderApp } from '../../test/renderApp';

function lastCall(api: MockApi, suffix: string, method: string) {
  return [...api.fetchMock.mock.calls]
    .reverse()
    .find(
      ([url, init]) =>
        String(url).endsWith(suffix) &&
        (init?.method ?? 'GET').toUpperCase() === method.toUpperCase(),
    );
}

function renderActivity(
  overrides: {
    activitySessions?: ActivitySession[];
    activitySessionsError?: boolean;
    admin?: boolean;
  } = {},
): MockApi {
  const api = installMockApi({
    session: makeUser({ role: overrides.admin === false ? 'user' : 'admin' }),
    activitySessions: overrides.activitySessions,
    activitySessionsError: overrides.activitySessionsError,
  });
  renderApp(['/admin/activity']);
  return api;
}

describe('ActivitySection', () => {
  it('renders active sessions from the mocked GET', async () => {
    renderActivity({
      activitySessions: [
        makeActivitySession({
          id: 's1',
          username: 'alice',
          title: 'The Matrix',
          itemType: 'movie',
          quality: '1080p',
        }),
      ],
    });

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('The Matrix')).toBeInTheDocument();
    // Quality label is shown in the transcode column.
    expect(screen.getByText(/1080p/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('shows the empty state when there are no sessions', async () => {
    renderActivity({ activitySessions: [] });
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('shows an error state when the request fails', async () => {
    renderActivity({ activitySessionsError: true });
    expect(await screen.findByText("Couldn't load activity")).toBeInTheDocument();
  });

  it('stops a session: confirm, optimistic removal, and DELETE call', async () => {
    const api = renderActivity({
      activitySessions: [
        makeActivitySession({ id: 's1', username: 'alice', title: 'The Matrix' }),
        makeActivitySession({ id: 's2', username: 'bob', title: 'Inception' }),
      ],
    });
    await screen.findByText('alice');

    // Clicking Stop opens a confirm dialog; nothing is killed yet.
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0]!);
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Stop the transcode session/i);
    expect(lastCall(api, '/activity/sessions/s1', 'DELETE')).toBeUndefined();

    // Confirming kills the session: the row is optimistically removed and DELETE fires.
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));

    await waitFor(() => expect(screen.queryByText('alice')).not.toBeInTheDocument());
    expect(screen.getByText('bob')).toBeInTheDocument();
    await waitFor(() => expect(lastCall(api, '/activity/sessions/s1', 'DELETE')).toBeDefined());
  });

  it('is admin-only: a non-admin is redirected away from the section', async () => {
    const api = renderActivity({ admin: false, activitySessions: [makeActivitySession()] });

    // Redirected home (RequireAdmin): the Activity heading never renders and the
    // sessions endpoint is never hit.
    await waitFor(() => expect(screen.queryByText('Active sessions')).not.toBeInTheDocument());
    expect(lastCall(api, '/activity/sessions', 'GET')).toBeUndefined();
  });
});
