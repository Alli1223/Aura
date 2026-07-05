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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
