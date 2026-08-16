import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './observability/logger.js';
import { httpDuration, httpRequests } from './observability/metrics.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { healthRouter } from './http/routes/health.js';
import { apiRouter } from './http/routes/index.js';

export function createApp(): Express {
  const app = express();

  // Behind Caddy. Without this, rate limiting and logging see the proxy's IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON only; the SPA is on a different origin with its own CSP.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin requests and curl have no Origin header.
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`Origin ${origin} is not allowed.`));
      },
      credentials: true,
      maxAge: 86_400,
    }),
  );

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = typeof existing === 'string' ? existing : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Health checks every few seconds would otherwise drown the log.
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(metricsMiddleware);

  app.use(healthRouter);

  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Records request count and duration. Uses the matched route pattern
 * (`/api/projects/:id`) rather than the raw path, otherwise every project id
 * becomes its own time series and the metric cardinality explodes.
 */
const metricsMiddleware: express.RequestHandler = (req, res, next) => {
  const stop = httpDuration.startTimer();
  res.on('finish', () => {
    const route = `${req.baseUrl || ''}${req.route?.path ?? ''}` || 'unmatched';
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    stop(labels);
    httpRequests.inc(labels);
  });
  next();
};
