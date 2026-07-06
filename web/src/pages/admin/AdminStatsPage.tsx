import {
  formatBytes,
  useAdminStats,
  type MostWatchedItem,
  type AdminStats,
} from '../../api/adminStats';
import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import { errorMessage } from './adminHelpers';
import admin from './Admin.module.css';
import styles from './AdminStats.module.css';

// Admin server-wide statistics: headline count tiles, recently-added tiles, and
// tables for per-library storage, most-watched items and most-active users.

/** One headline metric tile. */
function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileLabel}>{label}</span>
    </div>
  );
}

/** The "Show · S1E2 · Title"-style label for a most-watched episode. */
function watchedLabel(row: MostWatchedItem): string {
  if (row.type !== 'episode') return row.title;
  const code =
    (row.seasonNumber !== null ? `S${row.seasonNumber}` : '') +
    (row.episodeNumber !== null ? `E${row.episodeNumber}` : '');
  return [row.showTitle, code, row.title]
    .filter((part) => part !== '' && part !== null)
    .join(' · ');
}

function StatsContent({ stats }: { stats: AdminStats }) {
  const { totals, storageByLibrary, mostWatched, mostActiveUsers, recentlyAdded } = stats;

  return (
    <div className={styles.stats}>
      <section aria-labelledby="totals-heading">
        <h2 id="totals-heading" className={admin.toolbarTitle}>
          Overview
        </h2>
        <div className={styles.tileGrid}>
          <StatTile label="Users" value={totals.users} />
          <StatTile label="Libraries" value={totals.libraries} />
          <StatTile label="Items" value={totals.items.total} />
          <StatTile label="Movies" value={totals.items.movie} />
          <StatTile label="Shows" value={totals.items.show} />
          <StatTile label="Episodes" value={totals.items.episode} />
          <StatTile label="Files" value={totals.files} />
        </div>
      </section>

      <section aria-labelledby="recent-heading">
        <h2 id="recent-heading" className={admin.toolbarTitle}>
          Recently added
        </h2>
        <div className={styles.tileGrid}>
          <StatTile label="Last 24 hours" value={recentlyAdded.last24h} />
          <StatTile label="Last 7 days" value={recentlyAdded.last7d} />
          <StatTile label="Last 30 days" value={recentlyAdded.last30d} />
        </div>
      </section>

      <section aria-labelledby="storage-heading">
        <h2 id="storage-heading" className={admin.toolbarTitle}>
          Storage by library
        </h2>
        {storageByLibrary.length === 0 ? (
          <div className={admin.stateBlock}>No libraries yet.</div>
        ) : (
          <div className={admin.tableWrap}>
            <table className={admin.table}>
              <caption className="visually-hidden">Storage by library</caption>
              <thead>
                <tr>
                  <th scope="col">Library</th>
                  <th scope="col">Type</th>
                  <th scope="col">Files</th>
                  <th scope="col">Size</th>
                </tr>
              </thead>
              <tbody>
                {storageByLibrary.map((row) => (
                  <tr key={row.libraryId}>
                    <td className={admin.primaryCell}>{row.name}</td>
                    <td className={admin.muted}>{row.type}</td>
                    <td className={admin.muted}>{row.fileCount}</td>
                    <td>{formatBytes(row.totalBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="most-watched-heading">
        <h2 id="most-watched-heading" className={admin.toolbarTitle}>
          Most watched
        </h2>
        {mostWatched.length === 0 ? (
          <div className={admin.stateBlock}>Nothing has been watched yet.</div>
        ) : (
          <div className={admin.tableWrap}>
            <table className={admin.table}>
              <caption className="visually-hidden">Most watched items</caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Plays</th>
                  <th scope="col">Viewers</th>
                </tr>
              </thead>
              <tbody>
                {mostWatched.map((row) => (
                  <tr key={row.mediaItemId}>
                    <td className={admin.primaryCell}>{watchedLabel(row)}</td>
                    <td className={admin.muted}>{row.playCount}</td>
                    <td className={admin.muted}>{row.viewers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="most-active-heading">
        <h2 id="most-active-heading" className={admin.toolbarTitle}>
          Most active users
        </h2>
        {mostActiveUsers.length === 0 ? (
          <div className={admin.stateBlock}>No watch activity yet.</div>
        ) : (
          <div className={admin.tableWrap}>
            <table className={admin.table}>
              <caption className="visually-hidden">Most active users</caption>
              <thead>
                <tr>
                  <th scope="col">User</th>
                  <th scope="col">Plays</th>
                  <th scope="col">Items</th>
                </tr>
              </thead>
              <tbody>
                {mostActiveUsers.map((row) => (
                  <tr key={row.userId}>
                    <td className={admin.primaryCell}>{row.username}</td>
                    <td className={admin.muted}>{row.playCount}</td>
                    <td className={admin.muted}>{row.itemCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function AdminStatsPage() {
  const stats = useAdminStats();

  if (stats.isPending) {
    return (
      <div className={admin.stateBlock}>
        <Spinner label="Loading statistics" />
      </div>
    );
  }

  if (stats.isError) {
    return (
      <ErrorState
        title="Couldn't load statistics"
        message={errorMessage(stats.error)}
        onRetry={() => void stats.refetch()}
      />
    );
  }

  return <StatsContent stats={stats.data} />;
}
