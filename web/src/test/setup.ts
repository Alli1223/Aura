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

// jsdom has no URL.createObjectURL/revokeObjectURL; AuthImage turns a fetched
// artwork blob into an object URL. Deterministic ids let tests assert an image
// resolved without caring about the exact value.
let objectUrlCounter = 0;
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => `blob:mock/${(objectUrlCounter += 1)}`;
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}

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
