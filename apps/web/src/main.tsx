import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { AuthProvider } from './lib/auth.js';
import './index.css';

// Monaco is deliberately NOT imported here. It is ~4MB and is pulled in by the
// lazily-loaded project route instead, so the landing page never pays for it
// (§13).

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Socket events are the invalidation signal for anything that changes
      // live, so aggressive refetching would just duplicate work.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        // Retrying a 403 or 404 only delays the error the user needs to see.
        if (status !== undefined && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          {/* The toaster lives inside <App> so it can follow the resolved
              theme; Sonner needs light/dark told to it, not inherited. */}
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  </StrictMode>,
);
