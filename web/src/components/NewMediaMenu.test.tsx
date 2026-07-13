import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MediaItem } from '../api/media';
import type { AuthUser, Library } from '../api/types';
import { installMockApi, makeItem, makeLibrary, makeUser } from '../test/mockApi';
import { renderApp } from '../test/renderApp';
import { newMediaSeenKey } from './newMedia';

// The "new media" indicator lives in the authenticated top bar, so these tests
// boot the full app on the home route and drive the bell menu in the header. The
// mock API's /api/home/recently-added handler returns every accessible library's
// items, newest-first — the same feed the badge/dropdown consume.

const USER_ID = 'user-1';

/** A fixed-day UTC timestamp; higher day = more recently added. */
function iso(day: number): string {
  return `2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`;
}

interface SetupOptions {
  items?: MediaItem[];
  session?: AuthUser;
  libraries?: Library[];
}

function setup(options: SetupOptions = {}): void {
  const lib = makeLibrary('Movies', 'movies');
  const libraries = options.libraries ?? [lib];
  const items = options.items ?? [];
  installMockApi({
    session: options.session ?? makeUser({ id: USER_ID, username: 'alli' }),
    libraries,
    items: libraries.length > 0 ? { [libraries[0]!.id]: items } : {},
  });
  renderApp(['/']);
}

/** The bell trigger, whatever its current unread count. */
function getTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /Recently added/ });
}

function getMenu(): HTMLElement {
  return screen.getByRole('menu', { name: 'Recently added' });
}

describe('NewMediaMenu', () => {
  // localStorage is reset between tests by the shared test setup.

  it('badges the count of items added since the stored last-seen timestamp', async () => {
    localStorage.setItem(newMediaSeenKey(USER_ID), iso(3));
    setup({
      items: [
        makeItem({ id: 'a', title: 'Old One', addedAt: iso(1) }),
        makeItem({ id: 'b', title: 'New One', addedAt: iso(5) }),
        makeItem({ id: 'c', title: 'New Two', addedAt: iso(10) }),
      ],
    });
    await screen.findByText(/Welcome back/);

    // Only the day-5 and day-10 items are newer than the day-3 marker.
    expect(await screen.findByRole('button', { name: /2 new items/ })).toBeInTheDocument();
  });

  it('lists recent items linking to /items/:id and clears the badge on open', async () => {
    setup({
      items: [
        makeItem({ id: 'a', title: 'Alpha', addedAt: iso(2) }),
        makeItem({ id: 'b', title: 'Bravo', addedAt: iso(9) }),
      ],
    });
    await screen.findByText(/Welcome back/);

    // A fresh user (no marker) treats every recently-added item as new.
    fireEvent.click(await screen.findByRole('button', { name: /2 new items/ }));

    const links = within(getMenu()).getAllByRole('menuitem');
    expect(links).toHaveLength(2);
    // The feed is newest-first: Bravo (day 9) before Alpha (day 2).
    expect(links[0]).toHaveAttribute('href', '/items/b');
    expect(links[1]).toHaveAttribute('href', '/items/a');

    // Opening persisted the newest addedAt and cleared the badge.
    expect(localStorage.getItem(newMediaSeenKey(USER_ID))).toBe(iso(9));
    expect(getTrigger()).toHaveAccessibleName('Recently added');

    // Reopening: the items are still listed, but nothing is unread.
    fireEvent.keyDown(getMenu(), { key: 'Escape' });
    fireEvent.click(getTrigger());
    expect(within(getMenu()).getAllByRole('menuitem')).toHaveLength(2);
    expect(getTrigger()).toHaveAccessibleName('Recently added');
  });

  it('caps the badge at "9+" for large counts', async () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      makeItem({ id: `item-${i}`, title: `Item ${i}`, addedAt: iso(i + 1) }),
    );
    setup({ items });
    await screen.findByText(/Welcome back/);

    // All 12 are new to a fresh user, but the badge collapses to "9+".
    expect(await screen.findByText('9+')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /12 new items/ })).toBeInTheDocument();
  });

  it('shows an empty state and no badge when there is no new media', async () => {
    setup({ items: [] });
    await screen.findByText(/Welcome back/);

    const trigger = getTrigger();
    expect(trigger).toHaveAccessibleName('Recently added');
    fireEvent.click(trigger);
    expect(within(getMenu()).getByText('No new media')).toBeInTheDocument();
  });

  it('degrades gracefully for a user with no library access', async () => {
    setup({ libraries: [] });
    await screen.findByText(/Welcome back/);

    // No accessible items → no badge; the dropdown still opens to an empty state.
    const trigger = getTrigger();
    expect(trigger).toHaveAccessibleName('Recently added');
    fireEvent.click(trigger);
    expect(within(getMenu()).getByText('No new media')).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    setup({ items: [makeItem({ id: 'a', title: 'Alpha', addedAt: iso(2) })] });
    await screen.findByText(/Welcome back/);

    fireEvent.click(await screen.findByRole('button', { name: /new item/ }));
    fireEvent.keyDown(getMenu(), { key: 'Escape' });

    expect(screen.queryByRole('menu', { name: 'Recently added' })).not.toBeInTheDocument();
    expect(getTrigger()).toHaveFocus();
  });

  it('closes when a pointer press lands outside the menu', async () => {
    setup({ items: [makeItem({ id: 'a', title: 'Alpha', addedAt: iso(2) })] });
    await screen.findByText(/Welcome back/);

    fireEvent.click(await screen.findByRole('button', { name: /new item/ }));
    expect(getMenu()).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu', { name: 'Recently added' })).not.toBeInTheDocument();
  });

  it('moves focus through the items with the arrow keys', async () => {
    setup({
      items: [
        makeItem({ id: 'a', title: 'Alpha', addedAt: iso(2) }),
        makeItem({ id: 'b', title: 'Bravo', addedAt: iso(9) }),
      ],
    });
    await screen.findByText(/Welcome back/);

    fireEvent.click(await screen.findByRole('button', { name: /new item/ }));
    const items = within(getMenu()).getAllByRole('menuitem');

    fireEvent.keyDown(getMenu(), { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(getMenu(), { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(getMenu(), { key: 'ArrowUp' });
    expect(items[0]).toHaveFocus();
  });

  it('tracks last-seen per user so a different user starts fresh', async () => {
    // user-1 has already caught up past everything; user-2 has no marker at all.
    localStorage.setItem(newMediaSeenKey('user-1'), iso(20));
    setup({
      session: makeUser({ id: 'user-2', username: 'bob' }),
      items: [
        makeItem({ id: 'a', title: 'Alpha', addedAt: iso(5) }),
        makeItem({ id: 'b', title: 'Bravo', addedAt: iso(9) }),
      ],
    });
    await screen.findByText(/Welcome back/);

    // user-1's marker must not leak: user-2 sees both items as new.
    expect(await screen.findByRole('button', { name: /2 new items/ })).toBeInTheDocument();
  });
});
