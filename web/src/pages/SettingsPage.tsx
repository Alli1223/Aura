import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { Page, PageHeader } from '../components/Page';
import { useAuth } from '../auth/context';
import styles from './SettingsPage.module.css';

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
