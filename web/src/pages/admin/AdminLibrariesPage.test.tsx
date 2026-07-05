import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Library } from '../../api/types';
import { installMockApi, makeLibrary, makeUser, type MockApi } from '../../test/mockApi';
import { renderApp } from '../../test/renderApp';

/** The admin content area — scopes queries away from the sidebar's library links. */
async function main() {
  return within(await screen.findByRole('main'));
}

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

function renderLibraries(libraries: Library[]): MockApi {
  const api = installMockApi({ session: makeUser({ role: 'admin' }), libraries });
  renderApp(['/admin/libraries']);
  return api;
}

describe('AdminLibrariesPage', () => {
  it('lists libraries with their type and paths', async () => {
    const lib = makeLibrary('Movies', 'movies');
    renderLibraries([lib]);
    const content = await main();

    expect(await content.findByText('Movies')).toBeInTheDocument();
    expect(content.getByText(lib.paths[0]!)).toBeInTheDocument();
  });

  it('creates a library via POST /libraries', async () => {
    const api = renderLibraries([]);
    const content = await main();
    fireEvent.click(await content.findByRole('button', { name: 'New library' }));

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Films' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'movies' } });
    fireEvent.change(screen.getByLabelText('Path 1'), { target: { value: '/media/movies' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create library' }));

    await waitFor(() => expect(lastCall(api, '/libraries', 'POST')).toBeDefined());
    expect(body(lastCall(api, '/libraries', 'POST'))).toEqual({
      name: 'Films',
      type: 'movies',
      paths: ['/media/movies'],
    });
    // The new library lands in the list after the invalidation refetch.
    expect(await content.findByText('Films')).toBeInTheDocument();
  });

  it('triggers a scan and reflects the running status', async () => {
    const lib = makeLibrary('Anime', 'anime');
    const api = renderLibraries([lib]);
    const content = await main();
    await content.findByText('Anime');

    fireEvent.click(content.getByRole('button', { name: 'Scan' }));

    await waitFor(() => expect(lastCall(api, `/libraries/${lib.id}/scan`, 'POST')).toBeDefined());
    expect(await content.findByText('Scanning…')).toBeInTheDocument();
  });

  it('deletes a library after confirmation', async () => {
    const lib = makeLibrary('Recordings', 'recordings');
    const api = renderLibraries([lib]);
    const content = await main();
    await content.findByText('Recordings');

    fireEvent.click(content.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('heading', { name: 'Delete library' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete library' }));

    await waitFor(() => expect(lastCall(api, `/libraries/${lib.id}`, 'DELETE')).toBeDefined());
    await waitFor(() => expect(content.queryByText('Recordings')).not.toBeInTheDocument());
  });

  it('scans every library with "Scan all"', async () => {
    const api = renderLibraries([makeLibrary('Movies', 'movies'), makeLibrary('TV', 'tv')]);
    const content = await main();
    await content.findByText('Movies');

    fireEvent.click(content.getByRole('button', { name: 'Scan all' }));

    await waitFor(() => expect(lastCall(api, '/api/scan', 'POST')).toBeDefined());
  });
});
