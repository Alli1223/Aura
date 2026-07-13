import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LogEntry } from '../../api/logs';
import { installMockApi, makeLogEntry, makeUser, type MockApi } from '../../test/mockApi';
import { renderApp } from '../../test/renderApp';

function lastCall(api: MockApi, method: string, predicate: (url: string) => boolean) {
  return [...api.fetchMock.mock.calls]
    .reverse()
    .find(
      ([url, init]) =>
        predicate(String(url)) && (init?.method ?? 'GET').toUpperCase() === method.toUpperCase(),
    );
}

function renderLogs(
  overrides: { logs?: LogEntry[]; logsError?: boolean; admin?: boolean } = {},
): MockApi {
  const api = installMockApi({
    session: makeUser({ role: overrides.admin === false ? 'user' : 'admin' }),
    logs: overrides.logs,
    logsError: overrides.logsError,
  });
  renderApp(['/admin/logs']);
  return api;
}

describe('AdminLogsPage', () => {
  it('renders log entries from the mocked GET', async () => {
    renderLogs({
      logs: [
        makeLogEntry({ level: 'info', msg: 'server started' }),
        makeLogEntry({ level: 'error', msg: 'something exploded' }),
      ],
    });

    expect(await screen.findByText('server started')).toBeInTheDocument();
    expect(screen.getByText('something exploded')).toBeInTheDocument();
    // Level badges are rendered (colour-coded).
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('changes the request when the level filter changes', async () => {
    const api = renderLogs({ logs: [makeLogEntry({ level: 'warn', msg: 'heads up' })] });
    await screen.findByText('heads up');

    fireEvent.change(screen.getByLabelText('Filter by level'), { target: { value: 'warn' } });

    await waitFor(() =>
      expect(lastCall(api, 'GET', (url) => url.includes('/logs?') && url.includes('level=warn'))).toBeDefined(),
    );
  });

  it('has a working refresh button', async () => {
    const api = renderLogs({ logs: [makeLogEntry({ msg: 'first' })] });
    await screen.findByText('first');
    const before = api.fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/logs'),
    ).length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() =>
      expect(
        api.fetchMock.mock.calls.filter(([url]) => String(url).includes('/logs')).length,
      ).toBeGreaterThan(before),
    );
  });

  it('downloads the log file', async () => {
    const api = renderLogs({ logs: [makeLogEntry({ msg: 'downloadable line' })] });
    await screen.findByText('downloadable line');

    fireEvent.click(screen.getByRole('button', { name: 'Download logs' }));

    await waitFor(() =>
      expect(lastCall(api, 'GET', (url) => url.endsWith('/logs/download'))).toBeDefined(),
    );
  });

  it('shows the empty state when there are no entries', async () => {
    renderLogs({ logs: [] });
    expect(await screen.findByText(/No log entries/)).toBeInTheDocument();
  });

  it('shows an error state when the request fails', async () => {
    renderLogs({ logsError: true });
    expect(await screen.findByText("Couldn't load logs")).toBeInTheDocument();
  });

  it('is admin-only: a non-admin is redirected away from the section', async () => {
    const api = renderLogs({ admin: false, logs: [makeLogEntry({ msg: 'secret' })] });

    await waitFor(() => expect(screen.queryByText('Server logs')).not.toBeInTheDocument());
    expect(lastCall(api, 'GET', (url) => url.includes('/logs'))).toBeUndefined();
  });
});
