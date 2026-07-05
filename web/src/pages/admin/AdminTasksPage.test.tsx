import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { TaskStatus } from '../../api/admin';
import { installMockApi, makeTask, makeUser, type MockApi } from '../../test/mockApi';
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

function renderTasks(tasks: TaskStatus[], taskRunConflictId?: string): MockApi {
  const api = installMockApi({
    session: makeUser({ role: 'admin' }),
    tasks,
    taskRunConflictId,
  });
  renderApp(['/admin/tasks']);
  return api;
}

describe('AdminTasksPage', () => {
  it('renders task statuses', async () => {
    renderTasks([
      makeTask({ id: 'scan', name: 'Library scan', lastRunAt: '2026-06-01T10:00:00.000Z' }),
      makeTask({ id: 'backup', name: 'Database backup', enabled: false }),
    ]);

    expect(await screen.findByText('Library scan')).toBeInTheDocument();
    expect(screen.getByText('Database backup')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('runs a task with "Run now"', async () => {
    const api = renderTasks([makeTask({ id: 'scan', name: 'Library scan' })]);
    await screen.findByText('Library scan');

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(lastCall(api, '/tasks/scan/run', 'POST')).toBeDefined());
  });

  it('surfaces a 409 already-running conflict', async () => {
    renderTasks([makeTask({ id: 'scan', name: 'Library scan' })], 'scan');
    await screen.findByText('Library scan');

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already running/i);
  });
});
