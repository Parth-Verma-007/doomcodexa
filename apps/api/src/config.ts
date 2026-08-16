import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';

/**
 * Environment parsing. Fails loudly at boot rather than producing `undefined`
 * three layers down at 2am.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === '1' || v === 'true' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/codexa'),

  /**
   * The local engine has no sandbox (see localEngine.ts). Selecting it in
   * production therefore requires saying so out loud.
   */
  EXEC_LOCAL_ALLOW_UNSANDBOXED: booleanish.default(false),

  EXEC_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  EXEC_RUN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
  EXEC_COMPILE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  /**
   * Only the JVM's `-Xmx` is actually bound by this. Without a container there
   * is no portable way to cap a process's memory, so it is a hint, not a limit
   * — see the note in localEngine.ts.
   */
  EXEC_MEMORY_MB: z.coerce.number().int().min(64).max(2048).default(256),
  EXEC_MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(1024 * 1024),
  EXEC_WORKSPACE_ROOT: z.string().optional(),
  /** Set to 1 to disable execution entirely (e.g. a host with no compilers). */
  EXEC_DISABLED: booleanish.default(false),

  /**
   * Comma-separated emails allowed into /admin.
   *
   * Deliberately an env var rather than a flag on the user document. An admin
   * bit in the database is one bad write away from privilege escalation, and
   * this app already lets users edit shared state. Configuration cannot be
   * escalated into from inside the application at all — the worst an attacker
   * with database access can do is rename themselves, not grant themselves
   * anything. Empty means nobody is an admin and /admin 404s for everyone.
   */
  ADMIN_EMAILS: z.string().default(''),

  METRICS_USER: z.string().default('codexa'),
  METRICS_PASSWORD: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

const isProduction = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

if (isProduction && !env.METRICS_PASSWORD) {
  throw new Error('METRICS_PASSWORD is required when NODE_ENV=production.');
}

export const config = {
  env: env.NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: env.NODE_ENV === 'development',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,

  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  mongoUri: env.MONGODB_URI,

  auth: {
    /**
     * scrypt's cost parameter. Lowered under test for the same reason every
     * project lowers its bcrypt rounds: a suite that creates a few hundred
     * accounts would otherwise spend most of its runtime deliberately burning
     * CPU, and the thing being tested is the logic around the hash, not the
     * hash. Never lowered outside tests.
     */
    passwordCostN: isTest ? 1024 : 65_536,
  },

  exec: {
    disabled: env.EXEC_DISABLED,
    allowUnsandboxedLocal: env.EXEC_LOCAL_ALLOW_UNSANDBOXED,
    maxConcurrency: env.EXEC_MAX_CONCURRENCY,
    runTimeoutMs: env.EXEC_RUN_TIMEOUT_MS,
    compileTimeoutMs: env.EXEC_COMPILE_TIMEOUT_MS,
    memoryBytes: env.EXEC_MEMORY_MB * 1024 * 1024,
    maxOutputBytes: env.EXEC_MAX_OUTPUT_BYTES,
    workspaceRoot: env.EXEC_WORKSPACE_ROOT || path.join(os.tmpdir(), 'codexa-workspaces'),
  },

  /** Lower-cased once here so every comparison is a plain lookup. */
  adminEmails: new Set(
    env.ADMIN_EMAILS.split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),

  metrics: {
    user: env.METRICS_USER,
    password: env.METRICS_PASSWORD,
  },
} as const;

export type Config = typeof config;
