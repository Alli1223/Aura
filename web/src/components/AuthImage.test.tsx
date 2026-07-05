import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setAccessToken } from '../api/client';
import { AuthImage } from './AuthImage';

function imageResponse(status = 200): Response {
  // Typed-array body (not a Blob) so Response construction is portable across
  // Node versions in CI.
  return new Response(new Uint8Array([1, 2, 3]), { status });
}

describe('AuthImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches the source with a bearer token and renders it as a blob image', async () => {
    setAccessToken('tok');
    const fetchMock = vi.fn(() => Promise.resolve(imageResponse()));
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthImage src="/api/items/m1/artwork/poster?size=w400" alt="Poster" />);

    const img = await screen.findByRole('img', { name: 'Poster' });
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/items/m1/artwork/poster?size=w400',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('renders nothing and calls onError when the fetch fails', async () => {
    setAccessToken('tok');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(imageResponse(404))),
    );
    const onError = vi.fn();

    render(<AuthImage src="/api/items/x/artwork/poster" alt="Broken" onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('revokes the object url on unmount', async () => {
    setAccessToken('tok');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(imageResponse())),
    );
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    const { unmount } = render(<AuthImage src="/api/items/m1/artwork/poster" alt="Poster" />);
    const img = await screen.findByRole('img', { name: 'Poster' });
    const url = img.getAttribute('src');

    unmount();
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it('renders nothing when src is null', () => {
    render(<AuthImage src={null} alt="None" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
