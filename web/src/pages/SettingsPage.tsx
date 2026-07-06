import { useMemo, useState, type FormEvent } from 'react';

import { ApiError } from '../api/client';
import { useQualities } from '../api/player';
import type { AuthUser, PlaybackPreferencesInput } from '../api/types';
import { useAuth } from '../auth/context';
import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { Page, PageHeader } from '../components/Page';
import styles from './SettingsPage.module.css';

// Common subtitle languages offered in the picker, keyed by ISO 639-2/B codes
// (what ffprobe reports on a track's `language`, so a preference matches a track
// exactly). A saved code outside this list is preserved as its own option.
const SUBTITLE_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'eng', label: 'English' },
  { code: 'spa', label: 'Spanish' },
  { code: 'fra', label: 'French' },
  { code: 'deu', label: 'German' },
  { code: 'ita', label: 'Italian' },
  { code: 'por', label: 'Portuguese' },
  { code: 'rus', label: 'Russian' },
  { code: 'jpn', label: 'Japanese' },
  { code: 'kor', label: 'Korean' },
  { code: 'zho', label: 'Chinese' },
];

/** Playback preferences form: default quality, subtitle language, autoplay. */
function PlaybackSection({ user }: { user: AuthUser }) {
  const { updatePreferences } = useAuth();
  const qualitiesQuery = useQualities();
  const rungNames = useMemo(
    () => qualitiesQuery.data?.qualities.map((rung) => rung.name) ?? [],
    [qualitiesQuery.data],
  );

  // '' means "no preference" (null on the server); 'off' is an explicit sentinel.
  const [quality, setQuality] = useState(user.preferredQuality ?? '');
  const [subtitle, setSubtitle] = useState(user.preferredSubtitleLanguage ?? '');
  const [autoplay, setAutoplay] = useState(user.autoplayNextEpisode);
  // Saved baseline the form diffs against; advances after each successful save.
  const [baseline, setBaseline] = useState({
    quality: user.preferredQuality ?? '',
    subtitle: user.preferredSubtitleLanguage ?? '',
    autoplay: user.autoplayNextEpisode,
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty =
    quality !== baseline.quality || subtitle !== baseline.subtitle || autoplay !== baseline.autoplay;

  // Keep the current value selectable even if it's outside the common list /
  // permitted rungs (e.g. a cap changed after the preference was saved).
  const qualityOptions = useMemo(
    () => (quality !== '' && !rungNames.includes(quality) ? [...rungNames, quality] : rungNames),
    [quality, rungNames],
  );
  const languageOptions = useMemo(() => {
    const known = SUBTITLE_LANGUAGES.some((lang) => lang.code === subtitle);
    if (subtitle !== '' && subtitle !== 'off' && !known) {
      return [...SUBTITLE_LANGUAGES, { code: subtitle, label: subtitle.toUpperCase() }];
    }
    return SUBTITLE_LANGUAGES;
  }, [subtitle]);

  const touch = () => setSaved(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    if (!dirty) {
      setError('No changes to save.');
      return;
    }

    const patch: PlaybackPreferencesInput = {};
    if (quality !== baseline.quality) patch.preferredQuality = quality === '' ? null : quality;
    if (subtitle !== baseline.subtitle) {
      patch.preferredSubtitleLanguage = subtitle === '' ? null : subtitle;
    }
    if (autoplay !== baseline.autoplay) patch.autoplayNextEpisode = autoplay;

    setSaving(true);
    try {
      await updatePreferences(patch);
      setBaseline({ quality, subtitle, autoplay });
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not save your preferences. Try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.formWrap} onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label className="field-label" htmlFor="pref-quality">
          Default quality
        </label>
        <select
          id="pref-quality"
          className="input"
          value={quality}
          disabled={qualitiesQuery.isPending}
          onChange={(event) => {
            setQuality(event.target.value);
            touch();
          }}
        >
          <option value="">Auto (server default)</option>
          {qualityOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <p className={styles.hint}>The quality the player starts at, capped to your maximum.</p>
      </div>

      <div className="field" style={{ marginTop: 'var(--space-4)' }}>
        <label className="field-label" htmlFor="pref-subtitle">
          Subtitle language
        </label>
        <select
          id="pref-subtitle"
          className="input"
          value={subtitle}
          onChange={(event) => {
            setSubtitle(event.target.value);
            touch();
          }}
        >
          <option value="">No preference</option>
          <option value="off">Off</option>
          {languageOptions.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </select>
        <p className={styles.hint}>Auto-selects a matching subtitle track when one is available.</p>
      </div>

      <div className="field" style={{ marginTop: 'var(--space-4)' }}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={autoplay}
            aria-label="Autoplay next episode"
            onChange={(event) => {
              setAutoplay(event.target.checked);
              touch();
            }}
          />
          <span className="field-label">Autoplay next episode</span>
        </label>
        <p className={styles.hint}>Automatically start the next episode when one finishes.</p>
      </div>

      {error && (
        <p className="alert alert-error" role="alert" style={{ marginTop: 'var(--space-4)' }}>
          {error}
        </p>
      )}
      {saved && (
        <p className="alert alert-success" role="status" style={{ marginTop: 'var(--space-4)' }}>
          Preferences saved.
        </p>
      )}

      <button
        type="submit"
        className="btn btn-primary"
        disabled={saving}
        style={{ marginTop: 'var(--space-5)' }}
      >
        {saving ? 'Saving…' : 'Save preferences'}
      </button>
    </form>
  );
}

export function SettingsPage() {
  const { user, logout } = useAuth();

  return (
    <Page>
      <PageHeader title="Settings" subtitle="Manage your account." />

      <section className={styles.card} aria-labelledby="profile-heading">
        <h2 id="profile-heading" className={styles.cardTitle}>
          Profile
        </h2>
        <dl className={styles.details}>
          <div className={styles.row}>
            <dt className={styles.term}>Username</dt>
            <dd className={styles.value}>{user?.username}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>Email</dt>
            <dd className={styles.value}>{user?.email ?? 'Not set'}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>Role</dt>
            <dd className={styles.value}>{user?.role}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.card} aria-labelledby="playback-heading">
        <h2 id="playback-heading" className={styles.cardTitle}>
          Playback
        </h2>
        {user && <PlaybackSection user={user} />}
      </section>

      <section className={styles.card} aria-labelledby="password-heading">
        <h2 id="password-heading" className={styles.cardTitle}>
          Change password
        </h2>
        <div className={styles.formWrap}>
          <ChangePasswordForm />
        </div>
      </section>

      <section className={styles.card} aria-labelledby="session-heading">
        <h2 id="session-heading" className={styles.cardTitle}>
          Session
        </h2>
        <p className={styles.hint}>Sign out of your account on this device.</p>
        <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
          Log out
        </button>
      </section>
    </Page>
  );
}
