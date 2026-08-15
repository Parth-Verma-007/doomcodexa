import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics (§15). Exposed at /metrics behind basic auth and rendered
 * by the owner-only /admin page.
 */

export const registry = new Registry();
registry.setDefaultLabels({ service: 'codexa-api' });
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: 'codexa_http_requests_total',
  help: 'HTTP requests by route, method and status class.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'codexa_http_request_duration_seconds',
  help: 'HTTP request duration.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const runsTotal = new Counter({
  name: 'codexa_runs_total',
  help: 'Code executions by language and terminal status.',
  labelNames: ['language', 'status'] as const,
  registers: [registry],
});

export const runDuration = new Histogram({
  name: 'codexa_run_duration_seconds',
  help: 'Wall-clock duration of a run, from dequeue to exit.',
  labelNames: ['language'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
  registers: [registry],
});

export const runQueueWait = new Histogram({
  name: 'codexa_run_queue_wait_seconds',
  help: 'Time a run spent queued before starting.',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'codexa_queue_depth',
  help: 'Runs currently waiting for an execution slot.',
  registers: [registry],
});

export const activeRuns = new Gauge({
  name: 'codexa_active_runs',
  help: 'Runs currently executing.',
  registers: [registry],
});

export const warmPoolSize = new Gauge({
  name: 'codexa_warm_pool_size',
  help: 'Pre-created containers available, by language.',
  labelNames: ['language'] as const,
  registers: [registry],
});

export const connectedSockets = new Gauge({
  name: 'codexa_connected_sockets',
  help: 'Connected sockets by namespace.',
  labelNames: ['namespace'] as const,
  registers: [registry],
});

export const activeRooms = new Gauge({
  name: 'codexa_active_rooms',
  help: 'Project rooms with at least one connected peer.',
  registers: [registry],
});

export const ydocCacheSize = new Gauge({
  name: 'codexa_ydoc_cache_size',
  help: 'Y.Docs currently held in the server-side LRU.',
  registers: [registry],
});

export const ydocPersists = new Counter({
  name: 'codexa_ydoc_persists_total',
  help: 'CRDT snapshots written to Mongo.',
  labelNames: ['trigger'] as const,
  registers: [registry],
});

export const rejectedUpdates = new Counter({
  name: 'codexa_rejected_updates_total',
  help: 'Socket payloads rejected, by reason.',
  labelNames: ['reason'] as const,
  registers: [registry],
});
