import { Route, Routes } from 'react-router';

import { AppShell } from '../components/AppShell';
import { AdminPage } from '../pages/AdminPage';
import { HomePage } from '../pages/HomePage';
import { LibraryPage } from '../pages/LibraryPage';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { RegisterPage } from '../pages/RegisterPage';
import { SettingsPage } from '../pages/SettingsPage';
import { BootGate } from '../routes/BootGate';
import { PublicOnly } from '../routes/PublicOnly';
import { RequireAdmin } from '../routes/RequireAdmin';
import { RequireAuth } from '../routes/RequireAuth';

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

        {/* Private: everything behind the authenticated shell. */}
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="library/:id" element={<LibraryPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="admin" element={<AdminPage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </BootGate>
  );
}
