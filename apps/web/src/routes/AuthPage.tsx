import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Code2 } from 'lucide-react';
import { signInSchema, signUpSchema } from '@codexa/shared';
import { useAuthActions, useAuthState } from '../lib/auth.js';
import { ApiError } from '../lib/api.js';
import { Button } from '../components/Button.js';
import { GridMesh } from '../components/decor/GridMesh.js';

/**
 * Sign in and sign up.
 *
 * One component for both, because the two forms differ by a single field and
 * keeping them apart duplicated the layout, the error handling and the
 * redirect. The submitted values are checked against the very same zod schemas
 * the API uses, so the message you get for a short password is the message the
 * server would have sent — without the round trip.
 */
export function AuthPage({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const isSignUp = mode === 'sign-up';
  const { isSignedIn } = useAuthState();
  const { signIn, signUp } = useAuthActions();
  const navigate = useNavigate();

  const redirect = new URLSearchParams(useLocation().search).get('redirect_url') ?? '/dashboard';

  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isSignedIn) return <Navigate to={redirect} replace />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = isSignUp
      ? signUpSchema.safeParse({ email, username, password })
      : signInSchema.safeParse({ identifier, password });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the details above.');
      return;
    }

    setBusy(true);
    try {
      if (isSignUp) await signUp(parsed.data as never);
      else await signIn(parsed.data as never);
      navigate(redirect, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex h-full items-center justify-center bg-surface-0 p-6">
      <div className="pointer-events-none absolute inset-0">
        <GridMesh size={34} fade="top" className="opacity-20" />
      </div>

      <div className="relative w-full max-w-sm">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2 text-ink">
          <Code2 size={20} className="text-accent" />
          <span className="text-lg font-semibold tracking-tight">Codexa</span>
        </Link>

        <div className="rounded-xl border border-border bg-surface-1 p-6">
          <h1 className="mb-1 text-lg font-semibold tracking-tight">
            {isSignUp ? 'Create an account' : 'Welcome back'}
          </h1>
          <p className="mb-5 text-sm text-ink-muted">
            {isSignUp
              ? 'You need one to open a project and share it.'
              : 'Sign in to get back to your projects.'}
          </p>

          <form onSubmit={submit} noValidate>
            {isSignUp ? (
              <>
                <Field
                  id="email"
                  label="Email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={setEmail}
                  placeholder="you@example.com"
                  // The page exists to take this input and nothing else, which
                  // is the one case the rule is not written for.
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
                <Field
                  id="username"
                  label="Username"
                  autoComplete="username"
                  value={username}
                  onChange={setUsername}
                  placeholder="parth"
                  hint="This is the name your collaborators see."
                />
              </>
            ) : (
              <Field
                id="identifier"
                label="Email or username"
                autoComplete="username"
                value={identifier}
                onChange={setIdentifier}
                placeholder="parth"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
              />
            )}

            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
              hint={isSignUp ? 'At least 8 characters.' : undefined}
            />

            {error ? (
              <p
                role="alert"
                className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
              >
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" className="w-full" disabled={busy} sheen>
              {busy ? 'One moment…' : isSignUp ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-ink-muted">
          {isSignUp ? 'Already have an account? ' : 'No account yet? '}
          <Link
            to={`${isSignUp ? '/sign-in' : '/sign-up'}${
              redirect !== '/dashboard' ? `?redirect_url=${encodeURIComponent(redirect)}` : ''
            }`}
            className="text-accent hover:underline"
          >
            {isSignUp ? 'Sign in' : 'Create one'}
          </Link>
        </p>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  hint,
  ...input
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>) {
  return (
    <div className="mb-3">
      <label
        htmlFor={id}
        className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-muted"
      >
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm outline-none focus:border-accent"
        {...input}
      />
      {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export default AuthPage;
