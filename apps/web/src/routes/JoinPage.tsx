import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { Spinner } from '../components/Spinner.js';
import { Button } from '../components/Button.js';

/**
 * Redeems a share link.
 *
 * This route exists separately from the project route because the visitor has
 * no role yet — loading the project first would 404 them before they had a
 * chance to join (§10).
 */
export function JoinPage() {
  const [params] = useSearchParams();
  const token = params.get('t');

  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('That link is missing its token.');
      return;
    }

    let cancelled = false;
    void api
      .joinProject(token)
      .then(({ project }) => {
        if (!cancelled) setProjectId(project.id);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err.message : 'Could not join. The link may have been revoked.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (projectId) return <Navigate to={`/p/${projectId}`} replace />;

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-lg font-semibold">This link did not work</h1>
        <p className="max-w-md text-sm text-ink-muted">{error}</p>
        <a href="/dashboard">
          <Button variant="primary">Go to your projects</Button>
        </a>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <Spinner label="Joining the project" />
    </div>
  );
}
