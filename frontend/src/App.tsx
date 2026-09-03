/**
 * The route table, and the guard that keeps officer screens closed.
 *
 * Routes are declared here rather than scattered through the pages so the whole
 * surface of the platform is readable in one screen - ten pages, one login, one
 * fallback. The sidebar in `AppShell` walks the same list of paths, so a link and
 * its destination cannot drift apart.
 *
 * The guard is a real one in the sense that matters for a demo: it decides from
 * `capabilities`, which come from `/api/auth/me`, not from a client-side flag. It
 * is *not* a security boundary - the backend re-checks the role on every write,
 * because a route guard only hides a screen, it does not protect an endpoint.
 */
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { usePlatform } from './state/PlatformContext';
import AdminPage from './pages/AdminPage';
import AlertsPage from './pages/AlertsPage';
import Dashboard from './pages/Dashboard';
import ForecastPage from './pages/ForecastPage';
import HistoryPage from './pages/HistoryPage';
import LoginPage from './pages/LoginPage';
import NotFound from './pages/NotFound';
import OfficerPage from './pages/OfficerPage';
import OverviewPage from './pages/OverviewPage';
import ReportPage from './pages/ReportPage';
import RiskMapPage from './pages/RiskMapPage';
import SensorsPage from './pages/SensorsPage';

/**
 * Wraps a screen that needs privileges.
 *
 * An anonymous visitor is sent to the sign-in page carrying where they were
 * going, so signing in lands them on the screen they asked for. A visitor who is
 * already signed in but lacks the role is *not* redirected - they get told what
 * they are missing, because silently bouncing a logged-in user to a login form
 * they have already completed is the most confusing thing this could do.
 */
function Guard({ need, children }: { need: 'officer' | 'admin'; children: ReactNode }) {
  const { session, capabilities } = usePlatform();
  const location = useLocation();

  const ok =
    need === 'admin'
      ? capabilities.is_admin
      : capabilities.can_manage_alerts || capabilities.can_review_reports;

  if (ok) return <>{children}</>;

  if (!session.authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-panel border border-risk-moderate/40 bg-risk-moderate/10">
        <ShieldAlert className="h-5 w-5 text-risk-moderate" aria-hidden />
      </span>
      <h1 className="font-display text-base font-semibold text-ink">Not your desk</h1>
      <p className="mt-1 text-xs leading-relaxed text-dim">
        This screen needs {need === 'admin' ? 'administrator' : 'officer'} privileges. You are
        signed in as <span className="text-ink">{session.role.toLowerCase()}</span>.
      </p>
    </div>
  );
}

/** Every path on the platform. */
export default function App() {
  return (
    <Routes>
      {/* Sign-in sits outside the shell: a full-screen form, no sidebar to
          distract from the one thing that page is for. */}
      <Route path="/login" element={<LoginPage />} />

      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="/map" element={<RiskMapPage />} />
        <Route path="/forecast" element={<ForecastPage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/sensors" element={<SensorsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route
          path="/officer"
          element={
            <Guard need="officer">
              <OfficerPage />
            </Guard>
          }
        />
        <Route
          path="/admin"
          element={
            <Guard need="admin">
              <AdminPage />
            </Guard>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
