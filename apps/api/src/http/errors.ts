import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { PathError, type ApiErrorBody, type ErrorCode } from '@codexa/shared';
import { logger } from '../observability/logger.js';
import { config } from '../config.js';

/**
 * One error envelope for the whole API (§11):
 *   { error: { code, message, details? } }
 */

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  payload_too_large: 413,
  internal: 500,
  unavailable: 503,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError('bad_request', message, details);
  }
  static unauthorized(message = 'You must be signed in.') {
    return new ApiError('unauthorized', message);
  }
  static forbidden(message = 'You do not have permission to do that.') {
    return new ApiError('forbidden', message);
  }
  static notFound(message = 'Not found.') {
    return new ApiError('not_found', message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError('conflict', message, details);
  }
  static tooLarge(message: string) {
    return new ApiError('payload_too_large', message);
  }
  static unavailable(message: string) {
    return new ApiError('unavailable', message);
  }
}

/** Express 5 forwards rejected promises automatically, so this is only for clarity. */
export const notFoundHandler: RequestHandler = (req) => {
  throw ApiError.notFound(`No route for ${req.method} ${req.path}`);
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const { code, message, details, status } = normalise(err);

  const log = req.log ?? logger;
  if (status >= 500) {
    log.error({ err, code }, 'request failed');
  } else {
    log.warn({ code, message }, 'request rejected');
  }

  const body: ApiErrorBody = {
    error: {
      code,
      // Never leak an internal error message to a client in production.
      message: status >= 500 && config.isProduction ? 'Something went wrong.' : message,
      ...(details === undefined ? {} : { details }),
    },
  };

  res.status(status).json(body);
};

function normalise(err: unknown): {
  code: ErrorCode;
  status: number;
  message: string;
  details?: unknown;
} {
  if (err instanceof ApiError) {
    return { code: err.code, status: err.status, message: err.message, details: err.details };
  }

  if (err instanceof ZodError) {
    return {
      code: 'validation_failed',
      status: 422,
      message: 'Request body failed validation.',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }

  // A rejected filename or path — a client error, not a server fault.
  if (err instanceof PathError) {
    return { code: 'bad_request', status: 400, message: err.message };
  }

  if (isMongoDuplicateKeyError(err)) {
    return {
      code: 'conflict',
      status: 409,
      message: 'That already exists.',
    };
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return { code: 'bad_request', status: 400, message: 'Malformed JSON body.' };
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  return { code: 'internal', status: 500, message };
}

function isMongoDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

/**
 * Wrap an async handler. Express 5 already forwards rejections, but keeping the
 * helper documents intent at call sites and survives a downgrade.
 */
export function asyncHandler<T extends RequestHandler>(handler: T): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
