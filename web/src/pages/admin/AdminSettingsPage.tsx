import { useState } from 'react';

import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import {
  QUALITY_NAMES,
  useSettings,
  useUpdateSettings,
  type AdminSettings,
  type QualityName,
  type SettingsPatch,
} from '../../api/admin';
import { errorMessage } from './adminHelpers';
import styles from './Admin.module.css';

export function AdminSettingsPage() {
  const settings = useSettings();

  if (settings.isPending) {
    return (
      <div className={styles.stateBlock}>
        <Spinner label="Loading settings" />
      </div>
    );
  }

  if (settings.isError) {
    return (
      <ErrorState
        title="Couldn't load settings"
        message={errorMessage(settings.error)}
        onRetry={() => void settings.refetch()}
      />
    );
  }

  return <SettingsForm initial={settings.data} />;
}

function SettingsForm({ initial }: { initial: AdminSettings }) {
  const updateSettings = useUpdateSettings();

  const [form, setForm] = useState<AdminSettings>(initial);
  // The saved baseline the form diffs against. Advances after each successful
  // save so the "no changes" guard keeps working (a fresh `initial` prop won't
  // re-seed the form's own useState).
  const [baseline, setBaseline] = useState<AdminSettings>(initial);
  const [revealKey, setRevealKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const buildPatch = (): SettingsPatch => {
    const patch: SettingsPatch = {};
    (Object.keys(baseline) as (keyof AdminSettings)[]).forEach((key) => {
      if (form[key] !== baseline[key]) {
        // Narrowing across the union is safe: same key on both objects.
        (patch as Record<string, unknown>)[key] = form[key];
      }
    });
    return patch;
  };

  const submit = () => {
    setError(null);
    setSaved(false);
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      setError('No changes to save.');
      return;
    }
    updateSettings.mutate(patch, {
      onSuccess: (settings) => {
        setBaseline(settings);
        setForm(settings);
        setSaved(true);
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const keyWasSet = initial.tmdbApiKey !== '';

  return (
    <section className={styles.section} aria-labelledby="settings-heading">
      <div className={styles.toolbar}>
        <h2 id="settings-heading" className={styles.toolbarTitle}>
          Server settings
        </h2>
      </div>

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className={styles.formRow}>
          <label className="field-label" htmlFor="serverName">
            Server name
          </label>
          <input
            id="serverName"
            className="input"
            value={form.serverName}
            onChange={(event) => set('serverName', event.target.value)}
          />
        </div>

        <div className={styles.formRow}>
          <label className={styles.switch}>
            <input
              type="checkbox"
              checked={form.registrationEnabled}
              aria-label="Registration enabled"
              onChange={(event) => set('registrationEnabled', event.target.checked)}
            />
            <span className={styles.switchTrack} aria-hidden="true">
              <span className={styles.switchThumb} />
            </span>
            <span className="field-label">Allow new user registration</span>
          </label>
        </div>

        <div className={styles.formRow}>
          <label className="field-label" htmlFor="baseUrl">
            Base URL
          </label>
          <input
            id="baseUrl"
            className="input"
            value={form.baseUrl}
            placeholder="https://media.example.com"
            onChange={(event) => set('baseUrl', event.target.value)}
          />
          <span className={styles.hint}>External URL of this server. Leave blank if unset.</span>
        </div>

        <div className={styles.formRow}>
          <label className="field-label" htmlFor="transcodeDir">
            Transcode directory
          </label>
          <input
            id="transcodeDir"
            className="input"
            value={form.transcodeDir}
            onChange={(event) => set('transcodeDir', event.target.value)}
          />
        </div>

        <div className={styles.formRow}>
          <label className="field-label" htmlFor="defaultQuality">
            Default quality
          </label>
          <select
            id="defaultQuality"
            className="input"
            value={form.defaultQuality}
            onChange={(event) => set('defaultQuality', event.target.value as QualityName)}
          >
            {QUALITY_NAMES.map((quality) => (
              <option key={quality} value={quality}>
                {quality}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.formRow}>
          <label className="field-label" htmlFor="maxQuality">
            Maximum quality
          </label>
          <select
            id="maxQuality"
            className="input"
            value={form.maxQuality}
            onChange={(event) => set('maxQuality', event.target.value as QualityName)}
          >
            {QUALITY_NAMES.map((quality) => (
              <option key={quality} value={quality}>
                {quality}
              </option>
            ))}
          </select>
          <span className={styles.hint}>Server-wide ceiling; per-user caps can only be lower.</span>
        </div>

        <div className={styles.formRow}>
          <label className="field-label" htmlFor="tmdbApiKey">
            TMDB API key{' '}
            <span
              className={`${styles.badge} ${keyWasSet ? styles.badgeSuccess : styles.badgeNeutral}`}
            >
              {keyWasSet ? 'Set' : 'Not set'}
            </span>
          </label>
          <div className={styles.inputRow}>
            <input
              id="tmdbApiKey"
              className="input"
              type={revealKey ? 'text' : 'password'}
              autoComplete="off"
              value={form.tmdbApiKey}
              placeholder="v3 API key or v4 read token"
              onChange={(event) => set('tmdbApiKey', event.target.value)}
            />
            <button
              type="button"
              className={`btn btn-ghost ${styles.btnSm}`}
              aria-pressed={revealKey}
              onClick={() => setRevealKey((current) => !current)}
            >
              {revealKey ? 'Hide' : 'Reveal'}
            </button>
          </div>
          <span className={styles.hint}>Used for metadata enrichment. Stored securely.</span>
        </div>

        {error !== null && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="alert alert-success" role="status">
            Settings saved.
          </p>
        )}

        <div className={styles.formActions}>
          <button type="submit" className="btn btn-primary" disabled={updateSettings.isPending}>
            {updateSettings.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </section>
  );
}
