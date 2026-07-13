import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  installMockApi,
  makeCollection,
  makeCollectionDetail,
  makeItem,
  makeUser,
} from '../test/mockApi';
import { renderApp } from '../test/renderApp';

describe('CollectionDetailPage', () => {
  it('renders the member grid in order with the collection name and count', async () => {
    const collection = makeCollection({ id: 'c1', name: 'The Trilogy' });
    const items = [
      makeItem({ id: 'm1', title: 'Part One', year: null }),
      makeItem({ id: 'm2', title: 'Part Two', year: null }),
      makeItem({ id: 'm3', title: 'Part Three', year: null }),
    ];
    installMockApi({
      session: makeUser(),
      libraries: [],
      collectionDetails: { c1: makeCollectionDetail(collection, items) },
    });
    renderApp(['/collections/c1']);

    expect(await screen.findByRole('heading', { name: 'The Trilogy' })).toBeInTheDocument();
    expect(screen.getByText('3 items')).toBeInTheDocument();
    // Every member is rendered as a poster card linking to its detail route.
    expect(screen.getByRole('link', { name: 'Part One' })).toHaveAttribute('href', '/items/m1');
    expect(screen.getByRole('link', { name: 'Part Two' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Part Three' })).toBeInTheDocument();
  });

  it('shows an empty state when the collection has no accessible items', async () => {
    const collection = makeCollection({ id: 'c2', name: 'Empty' });
    installMockApi({
      session: makeUser(),
      libraries: [],
      collectionDetails: { c2: makeCollectionDetail(collection, []) },
    });
    renderApp(['/collections/c2']);

    expect(await screen.findByText('No items to show')).toBeInTheDocument();
  });

  it('shows a not-found state for an unknown or invisible collection (404)', async () => {
    installMockApi({ session: makeUser(), libraries: [], collectionDetails: {} });
    renderApp(['/collections/ghost']);

    expect(await screen.findByText('Collection not found')).toBeInTheDocument();
  });
});
