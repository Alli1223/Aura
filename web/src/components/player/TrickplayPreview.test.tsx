import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeTrickplayManifest } from '../../test/mockApi';
import { TrickplayPreview } from './TrickplayPreview';

describe('TrickplayPreview', () => {
  const manifest = makeTrickplayManifest('file-1');

  it('draws the correct sheet tile via background-image + background-position', () => {
    // t=120s => index 12 => col 2, row 1 on sheet 0 => offset (-640, -180).
    render(
      <TrickplayPreview
        manifest={manifest}
        mediaFileId="file-1"
        token="stream-token"
        timeSec={120}
      />,
    );

    const thumb = screen.getByTestId('trickplay-thumb');
    expect(thumb.style.backgroundImage).toContain(
      '/api/stream/trickplay/file-1/sprite-0.jpg?token=stream-token',
    );
    expect(thumb.style.backgroundPosition).toBe('-640px -180px');
    expect(thumb.style.width).toBe('320px');
    expect(thumb.style.height).toBe('180px');
  });

  it('selects the second sheet once the time spills past a full sheet', () => {
    // t=1000s => index 100 => sheet 1, col 0, row 0 => offset (0, 0).
    render(
      <TrickplayPreview
        manifest={manifest}
        mediaFileId="file-1"
        token="stream-token"
        timeSec={1000}
      />,
    );

    const thumb = screen.getByTestId('trickplay-thumb');
    expect(thumb.style.backgroundImage).toContain('sprite-1.jpg');
    // A zero offset serialises as "0px" (browsers/jsdom normalise "-0px").
    expect(thumb.style.backgroundPosition).toBe('0px 0px');
  });

  it('shows a formatted time label for the hovered position', () => {
    render(
      <TrickplayPreview
        manifest={manifest}
        mediaFileId="file-1"
        token="stream-token"
        timeSec={750}
      />,
    );
    expect(screen.getByText('12:30')).toBeInTheDocument();
  });

  it('is hidden from assistive tech (purely visual)', () => {
    render(
      <TrickplayPreview
        manifest={manifest}
        mediaFileId="file-1"
        token="stream-token"
        timeSec={0}
      />,
    );
    expect(screen.getByTestId('trickplay-preview')).toHaveAttribute('aria-hidden', 'true');
  });
});
