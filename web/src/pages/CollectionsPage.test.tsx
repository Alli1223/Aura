import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  installMockApi,
  makeCollection,
  makeLibrary,
  makeUser,
} from '../test/mockApi';
import { renderApp } from '../test/renderApp';

describe('CollectionsPage', () => {
  it('renders a card per collection from the mocked GET', async () => {
    installMockApi({
      session: makeUser(),
      libraries: [makeLibrary('Movies')],
      collections: [
        makeCollection({ id: 'c1', name: 'The Matrix Collection', itemCount: 3 }),
        makeCollection({ id: 'c2', name: 'Toy Story Collection', itemCount: 1 }),
      ],
    });
    renderApp(['/collections']);

    expect(
      await screen.findByRole('link', { name: /The Matrix Collection, 3 items/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Toy Story Collection, 1 item/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('links each card to its detail route', async () => {
    installMockApi({
      session: makeUser(),
      libraries: [],
      collections: [makeCollection({ id: 'c9', name: 'Franchise', itemCount: 2 })],
    });
    renderApp(['/collections']);

    const link = await screen.findByRole('link', { name: /Franchise, 2 items/ });
    expect(link).toHaveAttribute('href', '/collections/c9');
  });

  it('shows an empty state when there are no collections', async () => {
    installMockApi({ session: makeUser(), libraries: [], collections: [] });
    renderApp(['/collections']);

    expect(await screen.findByText('No collections yet')).toBeInTheDocument();
  });

  it('shows an error state (with retry) when the request fails', async () => {
    installMockApi({ session: makeUser(), libraries: [], collectionsError: true });
    renderApp(['/collections']);

    expect(await screen.findByText("Couldn't load collections")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('exposes a Collections entry in the sidebar nav', async () => {
    installMockApi({ session: makeUser(), libraries: [makeLibrary('Movies')], collections: [] });
    renderApp(['/']);

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Collections' })).toHaveAttribute(
        'href',
        '/collections',
      ),
    );
  });
});
