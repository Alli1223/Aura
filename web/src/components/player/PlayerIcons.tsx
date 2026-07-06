import type { SVGProps } from 'react';

// Player-specific glyphs. Kept local to the player so the shared Icons.tsx set
// (navigation/actions) does not grow a playback-only concern. Solid fills read
// better than strokes at the small sizes of a control bar.

type IconProps = SVGProps<SVGSVGElement>;

function Glyph({ children, ...props }: IconProps) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function PlayGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 5v14l11-7z" />
    </Glyph>
  );
}

export function PauseGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </Glyph>
  );
}

export function ReplayGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" />
    </Glyph>
  );
}

export function VolumeHighGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 9v6h4l5 5V4L8 9H4zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM15 2.5v2.1a7 7 0 0 1 0 14.8v2.1a9 9 0 0 0 0-19z" />
    </Glyph>
  );
}

export function VolumeMuteGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 9v6h4l5 5V4L8 9H4zm15.5 3 2.3-2.3-1.4-1.4L18 10.6l-2.3-2.3-1.4 1.4L16.6 12l-2.3 2.3 1.4 1.4L18 13.4l2.3 2.3 1.4-1.4L19.5 12z" />
    </Glyph>
  );
}

export function FullscreenGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
    </Glyph>
  );
}

export function FullscreenExitGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
    </Glyph>
  );
}

export function GearGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm7.4-2a7.6 7.6 0 0 0-.1-1l1.7-1.3-1.7-3-2 .8a7.4 7.4 0 0 0-1.7-1l-.3-2.1h-3.4l-.3 2.1a7.4 7.4 0 0 0-1.7 1l-2-.8-1.7 3L5.7 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 1.7 3 2-.8c.5.4 1.1.7 1.7 1l.3 2.1h3.4l.3-2.1c.6-.3 1.2-.6 1.7-1l2 .8 1.7-3L19.3 13c.1-.3.1-.7.1-1z" />
    </Glyph>
  );
}

export function SubtitlesGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm2 8v2h5v-2H6zm7 0v2h5v-2h-5zM6 15v2h8v-2H6zm10 0v2h2v-2h-2z" />
    </Glyph>
  );
}

export function BackGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z" />
    </Glyph>
  );
}
