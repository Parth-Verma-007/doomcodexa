import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useAuthState } from './lib/auth.js';
import { useColorMode } from './stores/uiStore.js';
import { Landing } from './routes/Landing.js';
import { AuthPage } from './routes/AuthPage.js';
import { Spinner } from './components/Spinner.js';

// The IDE pulls in Monaco, xterm and Yjs — several megabytes that a visitor
// landing on the marketing page should never download (§13). The landing route
// stays eagerly bundled because it is the first paint.
const Dashboard = lazy(() =>
  import('./routes/Dashboard.js').then((m) => ({ default: m.Dashboard })),
);
const ProjectPage = lazy(() =>
  import('./routes/ProjectPage.js').then((m) => ({ default: m.ProjectPage })),
);
const JoinPage = lazy(() => import('./routes/JoinPage.js').then((m) => ({ default: m.JoinPage })));
// Lazy like the rest: most accounts will never open it, and it should not cost
// them anything that they could have.
const AdminPage = lazy(() =>
  import('./routes/AdminPage.js').then((m) => ({ default: m.AdminPage })),
);

export function App() {
  useThemeClass();
  const mode = useColorMode();

  return (
    <>
      <Suspense fallback={<FullPageSpinner />}>
        <AppRoutes />
      </Suspense>
      {/* Sonner paints its own surfaces, so it has to be told the mode — it
          cannot infer it from the tokens the way the rest of the app does. */}
      <Toaster
        position="bottom-right"
        theme={mode}
        toastOptions={{
          style: {
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-ink)',
          },
        }}
      />
    </>
  );
}

function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner label="Loading" />
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/sign-in" element={<AuthPage mode="sign-in" />} />
      <Route path="/sign-up" element={<AuthPage mode="sign-up" />} />
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth>
            <AdminPage />
          </RequireAuth>
        }
      />
      <Route
        path="/join"
        element={
          <RequireAuth>
            <JoinPage />
          </RequireAuth>
        }
      />
      <Route
        path="/p/:projectId"
        element={
          <RequireAuth>
            <ProjectPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * Publishes the resolved theme — `dark` or `light`, nothing else — to <html>
 * for the CSS token blocks.
 *
 * The inline script in index.html does this first, before paint, from the same
 * persisted key; this hook only keeps it in step afterwards. The `.light` and
 * `.dark` classes are kept alongside `data-theme` because Tailwind's `dark:`
 * variant and any third-party CSS look for a class, not our attribute.
 */
function useThemeClass(): void {
  const mode = useColorMode();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = mode;
    root.classList.toggle('light', mode === 'light');
    root.classList.toggle('dark', mode === 'dark');
  }, [mode]);
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuthState();
  const location = useLocation();

  if (!isLoaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading" />
      </div>
    );
  }

  if (!isSignedIn) {
    // Preserve where they were headed so a share link survives the sign-in.
    const target = `${location.pathname}${location.search}`;
    return <Navigate to={`/sign-in?redirect_url=${encodeURIComponent(target)}`} replace />;
  }

  return <>{children}</>;
}
