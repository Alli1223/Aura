import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { setAccessToken, setAuthBridge } from '../api/client';

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
