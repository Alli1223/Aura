import { useEffect, useState } from 'react';

import { fetchAuthedObjectUrl } from '../api/client';

// Renders an authenticated image. The artwork endpoint
// (GET /api/items/:id/artwork/:kind) requires a Bearer token, which a plain
// `<img src>` cannot send, so we fetch the bytes through the API client (which
// attaches the token and shares the silent-refresh flow), turn the response
// into a blob object URL, and hand that to a native `<img>`. The object URL is
// revoked when the source changes or the component unmounts.
//
// While loading, or on failure, nothing is rendered and `onError` fires so the
// parent (e.g. PosterCard) can show its own fallback tile.

export interface AuthImageProps {
  /** Same-origin artwork URL beginning with `/api` (or null → no image). */
  src: string | null;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'auto' | 'sync';
  /** Called when the source can't be fetched, so the parent can fall back. */
  onError?: () => void;
}

export function AuthImage({
  src,
  alt,
  className,
  loading = 'lazy',
  decoding = 'async',
  onError,
}: AuthImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    // src is never null in practice (parents render a fallback instead), but
    // stay robust: nothing to fetch, and the cleanup below clears any prior url.
    if (src === null) return;

    let active = true;
    let created: string | null = null;

    fetchAuthedObjectUrl(src)
      .then((url) => {
        if (active) {
          created = url;
          setObjectUrl(url);
        } else {
          // Unmounted/superseded before we could use it — don't leak it.
          URL.revokeObjectURL(url);
        }
      })
      .catch(() => {
        if (active) onError?.();
      });

    return () => {
      active = false;
      // Reset in cleanup (not synchronously in the effect body) so a src change
      // drops the stale image and revokes its url before the next fetch lands.
      setObjectUrl(null);
      if (created !== null) URL.revokeObjectURL(created);
    };
    // onError is intentionally excluded: a parent that passes an inline
    // callback would otherwise re-run this effect (and re-fetch) every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (objectUrl === null) return null;

  return (
    <img
      className={className}
      src={objectUrl}
      alt={alt}
      loading={loading}
      decoding={decoding}
    />
  );
}
