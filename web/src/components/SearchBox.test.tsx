import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Location } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { MediaItem } from '../api/media';
import type { Library } from '../api/types';
import { installMockApi, makeItem, makeLibrary, makeUser } from '../test/mockApi';
import { renderApp } from '../test/renderApp';

// The top-bar search box lives in the authenticated shell, so these tests boot
// the full app on the home route and drive the combobox in the header. The mock
// API's /api/search handler mirrors the server's ranking + scoping.

function searchItems(libraryId: string): MediaItem[] {
  return [
    makeItem({ id: 'alpha', title: 'Alpha', year: 2001, libraryId }),
    makeItem({ id: 'alphabet', title: 'Alphabet', year: 2015, libraryId }),
    makeItem({ id: 'bravo', title: 'Bravo', year: 1999, libraryId }),
  ];
}

function renderSearch(): { lib: Library; getLocation: () => Location | null } {
  const lib = makeLibrary('Movies', 'movies');
  installMockApi({
    session: makeUser({ username: 'alli' }),
    libraries: [lib],
    items: { [lib.id]: searchItems(lib.id) },
  });
  let location: Location | null = null;
  renderApp(['/'], (loc) => {
    location = loc;
  });
  return { lib, getLocation: () => location };
}

function getInput(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Search' });
}

describe('SearchBox — instant dropdown', () => {
  it('stays closed below the 2-character minimum', async () => {
    renderSearch();
    await screen.findByText(/Welcome back/);

    fireEvent.change(getInput(), { target: { value: 'a' } });
    // No debounce elapsed yet, but even after it the listbox must not open.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens a debounced dropdown of matches after ≥2 chars, each linking to /items/:id', async () => {
    renderSearch();
    await screen.findByText(/Welcome back/);

    fireEvent.change(getInput(), { target: { value: 'alph' } });

    const alpha = await screen.findByRole('option', { name: /Alpha \(2001\)/ }, { timeout: 2000 });
    expect(alpha).toHaveAttribute('href', '/items/alpha');
    expect(screen.getByRole('option', { name: /Alphabet \(2015\)/ })).toHaveAttribute(
      'href',
      '/items/alphabet',
    );
    // Non-matching items never appear.
    expect(screen.queryByRole('option', { name: /Bravo/ })).not.toBeInTheDocument();
    // The "See all results" affordance is present.
    expect(screen.getByRole('option', { name: /See all results/ })).toBeInTheDocument();
  });

  it('ranks the exact title above its prefix match', async () => {
    renderSearch();
    await screen.findByText(/Welcome back/);

    fireEvent.change(getInput(), { target: { value: 'alph' } });
    await screen.findByRole('option', { name: /Alpha \(2001\)/ }, { timeout: 2000 });

    const options = screen.getAllByRole('option');
    // Alpha (exact) before Alphabet (prefix); the last option is "See all".
    expect(options[0]).toHaveAttribute('href', '/items/alpha');
    expect(options[1]).toHaveAttribute('href', '/items/alphabet');
  });
});

describe('SearchBox — keyboard navigation', () => {
  it('selects a result with ArrowDown and opens it with Enter', async () => {
    const { getLocation } = renderSearch();
    await screen.findByText(/Welcome back/);

    const input = getInput();
    fireEvent.change(input, { target: { value: 'alph' } });
    await screen.findByRole('option', { name: /Alpha \(2001\)/ }, { timeout: 2000 });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Alpha \(2001\)/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(getLocation()?.pathname).toBe('/items/alpha'));
  });

  it('closes on Escape', async () => {
    renderSearch();
    await screen.findByText(/Welcome back/);

    const input = getInput();
    fireEvent.change(input, { target: { value: 'alph' } });
    await screen.findByRole('listbox', undefined, { timeout: 2000 });

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('navigates to the full results page on Enter with nothing selected', async () => {
    const { getLocation } = renderSearch();
    await screen.findByText(/Welcome back/);

    const input = getInput();
    fireEvent.change(input, { target: { value: 'alph' } });
    await screen.findByRole('option', { name: /Alpha \(2001\)/ }, { timeout: 2000 });

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(getLocation()?.pathname).toBe('/search'));
    expect(getLocation()?.search).toBe('?q=alph');
    // The full results page echoes the query.
    expect(await screen.findByText(/Results for/)).toBeInTheDocument();
  });
});
