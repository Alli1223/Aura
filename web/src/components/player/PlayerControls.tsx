import { useRef, useState, type ChangeEvent } from 'react';

import { formatTime } from './format';
import {
  BackGlyph,
  FullscreenExitGlyph,
  FullscreenGlyph,
  GearGlyph,
  PauseGlyph,
  PlayGlyph,
  SubtitlesGlyph,
  VolumeHighGlyph,
  VolumeMuteGlyph,
} from './PlayerIcons';
import styles from './PlayerControls.module.css';

// Presentational control bar for the player. All playback state and imperative
// media control live in PlayerPage; this component is a pure function of props
// plus its own local "which settings panel is open" UI state. Kept accessible:
// the scrub and volume are real range inputs, every icon button has a label,
// and the settings menus are labelled radio-style lists.

/** A quality rung option (plus the synthetic 'Original' direct-play option). */
export interface QualityOption {
  /** 'Original' for direct play, otherwise the ladder rung name. */
  value: string;
  label: string;
}

/** An audio or subtitle option; image subtitles arrive disabled with a reason. */
export interface TrackOption {
  /** Stable id: an audio-relative index (as a string) or a subtitle track id. */
  value: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface PlayerControlsProps {
  title: string;
  visible: boolean;
  playing: boolean;
  onPlayPause: () => void;
  currentTimeSec: number;
  durationSec: number;
  bufferedSec: number;
  onSeek: (sec: number) => void;
  volume: number;
  muted: boolean;
  onVolume: (value: number) => void;
  onToggleMute: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onBack: () => void;
  qualityOptions: QualityOption[];
  activeQuality: string;
  onSelectQuality: (value: string) => void;
  audioOptions: TrackOption[];
  activeAudioId: string | null;
  onSelectAudio: (value: string) => void;
  subtitleOptions: TrackOption[];
  /** null == subtitles off. */
  activeSubtitleId: string | null;
  onSelectSubtitle: (value: string | null) => void;
  /** Reset the auto-hide timer on any control interaction. */
  onActivity: () => void;
}

type Panel = 'root' | 'quality' | 'audio' | 'subtitles';

interface OptionRow {
  key: string;
  label: string;
  active: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
}

function OptionList({ label, rows }: { label: string; rows: OptionRow[] }) {
  return (
    <ul className={styles.optionList} role="group" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={row.active}
            aria-disabled={row.disabled ? 'true' : undefined}
            title={row.disabled ? row.disabledReason : undefined}
            className={`${styles.option} ${row.active ? styles.optionActive : ''} ${
              row.disabled ? styles.optionDisabled : ''
            }`}
            onClick={() => {
              if (!row.disabled) row.onSelect();
            }}
          >
            <span className={styles.optionCheck} aria-hidden="true">
              {row.active ? '✓' : ''}
            </span>
            <span className={styles.optionLabel}>{row.label}</span>
            {row.disabled && row.disabledReason !== undefined && (
              <span className={styles.optionHint}>{row.disabledReason}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PlayerControls(props: PlayerControlsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>('root');
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The menu is only ever shown while the controls are visible, so it can never
  // linger invisibly when the bar auto-hides (no effect / setState needed).
  const showMenu = menuOpen && props.visible;

  const duration = props.durationSec > 0 ? props.durationSec : 0;
  const scrubMax = duration > 0 ? duration : 1;
  const bufferedPercent = duration > 0 ? Math.min(100, (props.bufferedSec / duration) * 100) : 0;

  const onScrub = (event: ChangeEvent<HTMLInputElement>) => {
    props.onActivity();
    props.onSeek(Number(event.target.value));
  };
  const onVolume = (event: ChangeEvent<HTMLInputElement>) => {
    props.onActivity();
    props.onVolume(Number(event.target.value));
  };

  const activeSubtitle = props.activeSubtitleId;

  return (
    <div
      className={`${styles.controls} ${props.visible ? styles.visible : styles.hidden}`}
      data-testid="player-controls"
      aria-hidden={!props.visible}
    >
      <div className={styles.topBar}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Back"
          onClick={props.onBack}
        >
          <BackGlyph />
        </button>
        <span className={styles.title}>{props.title}</span>
      </div>

      <div className={styles.bottomBar}>
        <div className={styles.scrubRow}>
          <span className={styles.time}>{formatTime(props.currentTimeSec)}</span>
          <div className={styles.scrubWrap}>
            <div className={styles.scrubBuffered} style={{ width: `${bufferedPercent}%` }} />
            <input
              type="range"
              className={styles.scrub}
              min={0}
              max={scrubMax}
              step="any"
              value={Math.min(props.currentTimeSec, scrubMax)}
              onChange={onScrub}
              aria-label="Seek"
              aria-valuetext={`${formatTime(props.currentTimeSec)} of ${formatTime(duration)}`}
            />
          </div>
          <span className={styles.time}>{formatTime(duration)}</span>
        </div>

        <div className={styles.buttonRow}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={props.playing ? 'Pause' : 'Play'}
            onClick={props.onPlayPause}
          >
            {props.playing ? <PauseGlyph /> : <PlayGlyph />}
          </button>

          <div className={styles.volumeGroup}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={props.muted ? 'Unmute' : 'Mute'}
              aria-pressed={props.muted}
              onClick={props.onToggleMute}
            >
              {props.muted || props.volume === 0 ? <VolumeMuteGlyph /> : <VolumeHighGlyph />}
            </button>
            <input
              type="range"
              className={styles.volume}
              min={0}
              max={1}
              step={0.05}
              value={props.muted ? 0 : props.volume}
              onChange={onVolume}
              aria-label="Volume"
            />
          </div>

          <span className={styles.spacer} />

          {props.subtitleOptions.length > 0 && (
            <button
              type="button"
              className={`${styles.iconButton} ${activeSubtitle !== null ? styles.iconActive : ''}`}
              aria-label="Toggle subtitles"
              aria-pressed={activeSubtitle !== null}
              onClick={() => {
                props.onActivity();
                // Quick toggle: off → first text track; on → off.
                if (activeSubtitle !== null) {
                  props.onSelectSubtitle(null);
                  return;
                }
                const firstText = props.subtitleOptions.find((option) => !option.disabled);
                if (firstText !== undefined) props.onSelectSubtitle(firstText.value);
              }}
            >
              <SubtitlesGlyph />
            </button>
          )}

          <div className={styles.settings} ref={menuRef}>
            <button
              type="button"
              className={`${styles.iconButton} ${menuOpen ? styles.iconActive : ''}`}
              aria-label="Settings"
              aria-haspopup="menu"
              aria-expanded={showMenu}
              onClick={() => {
                props.onActivity();
                setPanel('root');
                setMenuOpen((open) => !open);
              }}
            >
              <GearGlyph />
            </button>

            {showMenu && (
              <div className={styles.menu} role="menu" aria-label="Playback settings">
                {panel === 'root' && (
                  <ul className={styles.menuList}>
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuRow}
                        onClick={() => setPanel('quality')}
                      >
                        <span>Quality</span>
                        <span className={styles.menuValue}>{props.activeQuality}</span>
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuRow}
                        onClick={() => setPanel('audio')}
                        disabled={props.audioOptions.length === 0}
                      >
                        <span>Audio</span>
                        <span className={styles.menuValue}>
                          {props.audioOptions.find((o) => o.value === props.activeAudioId)?.label ??
                            'Default'}
                        </span>
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuRow}
                        onClick={() => setPanel('subtitles')}
                      >
                        <span>Subtitles</span>
                        <span className={styles.menuValue}>
                          {activeSubtitle === null
                            ? 'Off'
                            : (props.subtitleOptions.find((o) => o.value === activeSubtitle)
                                ?.label ?? 'On')}
                        </span>
                      </button>
                    </li>
                  </ul>
                )}

                {panel === 'quality' && (
                  <div className={styles.panel}>
                    <button
                      type="button"
                      className={styles.panelBack}
                      onClick={() => setPanel('root')}
                    >
                      ‹ Quality
                    </button>
                    <OptionList
                      label="Quality"
                      rows={props.qualityOptions.map((option) => ({
                        key: option.value,
                        label: option.label,
                        active: option.value === props.activeQuality,
                        onSelect: () => {
                          props.onActivity();
                          props.onSelectQuality(option.value);
                          setMenuOpen(false);
                        },
                      }))}
                    />
                  </div>
                )}

                {panel === 'audio' && (
                  <div className={styles.panel}>
                    <button
                      type="button"
                      className={styles.panelBack}
                      onClick={() => setPanel('root')}
                    >
                      ‹ Audio
                    </button>
                    <OptionList
                      label="Audio track"
                      rows={props.audioOptions.map((option) => ({
                        key: option.value,
                        label: option.label,
                        active: option.value === props.activeAudioId,
                        onSelect: () => {
                          props.onActivity();
                          props.onSelectAudio(option.value);
                          setMenuOpen(false);
                        },
                      }))}
                    />
                  </div>
                )}

                {panel === 'subtitles' && (
                  <div className={styles.panel}>
                    <button
                      type="button"
                      className={styles.panelBack}
                      onClick={() => setPanel('root')}
                    >
                      ‹ Subtitles
                    </button>
                    <OptionList
                      label="Subtitles"
                      rows={[
                        {
                          key: '__off__',
                          label: 'Off',
                          active: activeSubtitle === null,
                          onSelect: () => {
                            props.onActivity();
                            props.onSelectSubtitle(null);
                            setMenuOpen(false);
                          },
                        },
                        ...props.subtitleOptions.map((option) => ({
                          key: option.value,
                          label: option.label,
                          active: option.value === activeSubtitle,
                          disabled: option.disabled,
                          disabledReason: option.disabledReason,
                          onSelect: () => {
                            props.onActivity();
                            props.onSelectSubtitle(option.value);
                            setMenuOpen(false);
                          },
                        })),
                      ]}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            className={styles.iconButton}
            aria-label={props.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            aria-pressed={props.fullscreen}
            onClick={props.onToggleFullscreen}
          >
            {props.fullscreen ? <FullscreenExitGlyph /> : <FullscreenGlyph />}
          </button>
        </div>
      </div>
    </div>
  );
}
