import { locateThumbnail, trickplaySpriteUrl, type TrickplayManifest } from '../../api/trickplay';
import { formatTime } from './format';
import styles from './TrickplayPreview.module.css';

// The scrub-preview thumbnail shown while hovering the seek bar. Given the
// trickplay manifest and a hover time it draws the correct tile from the
// correct sprite sheet: a fixed thumbWidth x thumbHeight window whose
// background is the sprite sheet, shifted by `background-position` so only the
// target tile shows. The sheet URL carries the streaming `?token=`, so a plain
// background-image authenticates (unlike the artwork route, which needs
// AuthImage's Bearer fetch) and the browser caches each sheet by URL.
//
// Purely presentational + aria-hidden: it never steals focus or announces, so
// the underlying seek bar stays fully keyboard-accessible.

export interface TrickplayPreviewProps {
  manifest: TrickplayManifest;
  mediaFileId: string;
  token: string;
  /** Hovered source time in seconds. */
  timeSec: number;
}

export function TrickplayPreview({ manifest, mediaFileId, token, timeSec }: TrickplayPreviewProps) {
  const tile = locateThumbnail(manifest, timeSec);
  const spriteUrl = trickplaySpriteUrl(mediaFileId, tile.sheet, token);

  return (
    <div className={styles.preview} data-testid="trickplay-preview" aria-hidden="true">
      <div
        className={styles.thumb}
        data-testid="trickplay-thumb"
        style={{
          width: `${manifest.thumbWidth}px`,
          height: `${manifest.thumbHeight}px`,
          backgroundImage: `url("${spriteUrl}")`,
          backgroundPosition: `-${tile.x}px -${tile.y}px`,
        }}
      />
      <span className={styles.time}>{formatTime(timeSec)}</span>
    </div>
  );
}
