import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router';

import { AppShell } from '../components/AppShell';
import { FullPageLoader } from '../components/Spinner';
import { HistoryPage } from '../pages/HistoryPage';
import { HomePage } from '../pages/HomePage';
import { ItemDetailPage } from '../pages/ItemDetailPage';
import { LibraryPage } from '../pages/LibraryPage';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { RegisterPage } from '../pages/RegisterPage';
import { SearchPage } from '../pages/SearchPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ActivitySection } from '../pages/admin/ActivitySection';
import { AdminAccessPage } from '../pages/admin/AdminAccessPage';
import { AdminLayout } from '../pages/admin/AdminLayout';
import { AdminLibrariesPage } from '../pages/admin/AdminLibrariesPage';
import { AdminLogsPage } from '../pages/admin/AdminLogsPage';
import { AdminSettingsPage } from '../pages/admin/AdminSettingsPage';
import { AdminStatsPage } from '../pages/admin/AdminStatsPage';
import { AdminTasksPage } from '../pages/admin/AdminTasksPage';
import { AdminUsersPage } from '../pages/admin/AdminUsersPage';
import { BootGate } from '../routes/BootGate';
import { PublicOnly } from '../routes/PublicOnly';
import { RequireAdmin } from '../routes/RequireAdmin';
import { RequireAuth } from '../routes/RequireAuth';

// The player pulls in hls.js (a large dependency only ever needed on this
// route), so it is code-split out of the main bundle and loaded on demand.
const PlayerPage = lazy(() =>
  import('../pages/PlayerPage').then((module) => ({ default: module.PlayerPage })),
);

/** The full route tree, gated on the boot refresh settling first. */
export function AppRoutes() {
  return (
    <BootGate>
      <Routes>
        {/* Public: redirect home if already signed in. */}
        <Route element={<PublicOnly />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>

        {/* Private: everything behind auth. The player is full-screen (no shell). */}
        <Route element={<RequireAuth />}>
          <Route
            path="player/:mediaFileId"
            element={
              <Suspense fallback={<FullPageLoader label="Loading player" />}>
                <PlayerPage />
              </Suspense>
            }
          />
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="library/:id" element={<LibraryPage />} />
            <Route path="items/:id" element={<ItemDetailPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="admin" element={<AdminLayout />}>
                <Route index element={<AdminUsersPage />} />
                <Route path="libraries" element={<AdminLibrariesPage />} />
                <Route path="access" element={<AdminAccessPage />} />
                <Route path="settings" element={<AdminSettingsPage />} />
                <Route path="tasks" element={<AdminTasksPage />} />
                <Route path="activity" element={<ActivitySection />} />
                <Route path="stats" element={<AdminStatsPage />} />
                <Route path="logs" element={<AdminLogsPage />} />
              </Route>
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </BootGate>
  );
}
