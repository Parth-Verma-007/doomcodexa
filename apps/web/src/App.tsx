import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SignIn, SignUp } from '@clerk/clerk-react';
import { Toaster } from 'sonner';
import { SignedIn, SignedOut, useAuthState } from './lib/auth.js';
import { env } from './lib/env.js';
import { registerTokenGetter } from './lib/api.js';
import { disconnectAll, registerSocketTokenGetter } from './lib/socket.js';
import { useColorMode } from './stores/uiStore.js';
import { Landing } from './routes/Landing.js';
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
  useClerkTokenBridge();
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
      <Route path="/sign-in/*" element={<AuthScreen mode="sign-in" />} />
      <Route path="/sign-up/*" element={<AuthScreen mode="sign-up" />} />
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
 * Everything that needs Clerk's token lives above the routes, so the bridge
 * and theme hooks stay in the eager bundle while the routes themselves split.
 */

/**
 * Hands Clerk's token getter to the two non-React modules that need it.
 *
 * Doing this in a hook rather than importing `useAuth` inside those modules is
 * what lets the socket manager fetch a *fresh* token on every reconnect
 * attempt, which is the whole mechanism behind surviving token expiry.
 */
function useClerkTokenBridge(): void {
  const { getToken, isSignedIn, isLoaded } = useAuthState();

  useEffect(() => {
    registerTokenGetter(() => getToken());
    registerSocketTokenGetter(() => getToken());
  }, [getToken]);

  useEffect(() => {
    // Signing out must drop the sockets, or the next user inherits rooms they
    // are not a member of until the server times the connection out.
    if (isLoaded && !isSignedIn) disconnectAll();
  }, [isLoaded, isSignedIn]);
}

/**
 * Publishes the resolved theme — `dark` or `light`, nothing else — to <html>
 * for the CSS token blocks.
 *
 * The inline script in index.html does this first, before paint, from the same
 * persisted key; this hook only keeps it in step afterwards. The classes are
 * kept alongside `data-theme` because embedded third-party widgets (Clerk's,
 * for one) look for `.light`/`.dark`, not our attribute.
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

function AuthScreen({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const params = new URLSearchParams(useLocation().search);
  const redirect = params.get('redirect_url') ?? '/dashboard';

  // With Clerk bypassed there is nothing to sign in to, and rendering <SignIn>
  // would crash on the missing publishable key.
  if (env.devBypass) return <Navigate to={redirect} replace />;

  return (
    <div className="flex h-full items-center justify-center bg-surface-0 p-6">
      <SignedOut>
        {mode === 'sign-in' ? (
          <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl={redirect} />
        ) : (
          <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" forceRedirectUrl={redirect} />
        )}
      </SignedOut>
      <SignedIn>
        <Navigate to={redirect} replace />
      </SignedIn>
    </div>
  );
}
