import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { setAccessToken, setAuthBridge } from '../api/client';

// jsdom has no IntersectionObserver; the infinite-scroll sentinel needs one to
// exist (it never fires here — tests drive pagination via the Load more button).
// Defined directly on globalThis (not vi.stubGlobal) so afterEach's
// unstubAllGlobals leaves it in place for the whole run.
class MockIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds = [];
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
if (!('IntersectionObserver' in globalThis)) {
  globalThis.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
}

// This jsdom build does not expose Web Storage (Node's experimental global
// `localStorage` is inert without --localstorage-file), so provide a minimal
// in-memory implementation. Components that persist small bits of per-user UI
// state (e.g. the new-media indicator's "last seen" marker) rely on it; each
// test starts from a clean store via the beforeEach below.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

// AuthImage turns a fetched artwork blob into an object URL. jsdom's own
// createObjectURL (when present) rejects a blob produced by a different realm's
// Response, so override unconditionally with a deterministic stub — tests only
// need to see that *an* object URL resolved, not its exact value.
let objectUrlCounter = 0;
URL.createObjectURL = () => `blob:mock/${(objectUrlCounter += 1)}`;
URL.revokeObjectURL = () => {};

// Each test starts from a clean slate: no in-memory token, no auth bridge, and
// any stubbed globals (fetch) restored.
beforeEach(() => {
  setAccessToken(null);
  setAuthBridge(null);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
