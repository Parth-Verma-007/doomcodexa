import { Router } from 'express';
import mongoose from 'mongoose';
import { registry } from '../../observability/metrics.js';
import { config } from '../../config.js';
import { asyncHandler } from '../errors.js';

export const healthRouter: Router = Router();

/** Liveness. Deliberately dependency-free so it stays up during a Mongo blip. */
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/** Readiness. Reports the pieces a request actually needs. */
healthRouter.get('/ready', (_req, res) => {
  const mongoUp = mongoose.connection.readyState === 1;
  res.status(mongoUp ? 200 : 503).json({
    status: mongoUp ? 'ready' : 'degraded',
    checks: {
      mongo: mongoUp ? 'up' : 'down',
      execution: config.exec.disabled ? 'disabled' : 'enabled',
    },
  });
});

/**
 * Prometheus scrape. Basic-auth'd here as well as firewalled by Caddy — the
 * metrics leak project and run counts, which is not something to publish.
 */
healthRouter.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    if (!isMetricsAuthorised(req.headers.authorization)) {
      res.set('WWW-Authenticate', 'Basic realm="codexa-metrics"').status(401).end();
      return;
    }
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }),
);

function isMetricsAuthorised(header: string | undefined): boolean {
  if (!config.metrics.password) return !config.isProduction;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return safeEquals(user, config.metrics.user) && safeEquals(password, config.metrics.password);
}

/** Constant-time comparison so the password is not discoverable by timing. */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) {
    diff |= (bufA[i] as number) ^ (bufB[i] as number);
  }
  return diff === 0;
}
