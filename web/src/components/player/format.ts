// Time formatting shared by the player controls and its overlays. Lives in a
// plain module (not a component file) so exporting a helper doesn't trip the
// react-refresh "only export components" rule.

/** mm:ss, or h:mm:ss past an hour. Negative/NaN clamps to 0:00. */
export function formatTime(totalSeconds: number): string {
  let value = totalSeconds;
  if (!Number.isFinite(value) || value < 0) value = 0;
  const seconds = Math.floor(value % 60);
  const minutes = Math.floor((value / 60) % 60);
  const hours = Math.floor(value / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
