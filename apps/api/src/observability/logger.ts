import { pino, type Logger } from 'pino';
import { config } from '../config.js';

/**
 * The single logger for the API. `console.log` is banned by ESLint in this
 * workspace (§15) so that everything is structured and correlatable.
 */
export const logger: Logger = pino({
  level: config.logLevel,
  base: { service: 'codexa-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["svix-signature"]',
      'res.headers["set-cookie"]',
      '*.secretKey',
      '*.token',
      '*.shareToken',
    ],
    censor: '[redacted]',
  },
  transport: config.isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
      },
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
