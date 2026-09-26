import pino, { type Logger as PinoLogger } from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { filterFields } from './allowlist';

export interface LogContext {
  correlationId?: string;
  tenantId?: string;
  brandId?: string;
  runId?: string;
  publicationId?: string;
  workflowId?: string;
}

const contextStorage = new AsyncLocalStorage<LogContext>();
export const withLogContext = <T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> =>
  contextStorage.run({ ...(contextStorage.getStore() ?? {}), ...ctx }, fn);
export const currentLogContext = (): LogContext => contextStorage.getStore() ?? {};

export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
  child(component: string): Logger;
}

function wrap(p: PinoLogger): Logger {
  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') => (fields: Record<string, unknown>, msg: string) => {
      const merged = filterFields({ ...currentLogContext(), ...fields });
      p[level](merged, msg);
    };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (component) => wrap(p.child({ component })),
  };
}

let root: PinoLogger | null = null;
export function createLogger(opts: {
  service: string;
  env?: string;
  level?: string;
  destination?: pino.DestinationStream;
}): Logger {
  root = pino(
    {
      level: opts.level ?? process.env['LOG_LEVEL'] ?? 'info',
      base: { service: opts.service, env: opts.env ?? process.env['NODE_ENV'] ?? 'development' },
      messageKey: 'msg',
      // Level as its label ('error', not 50): log platforms such as Railway read severity from this field.
      formatters: { level: (label) => ({ level: label }) },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Belt and braces: pino redaction on top of the allowlist, for nested objects a caller passes under an allowed key.
      redact: {
        paths: [
          '*.token',
          '*.accessToken',
          '*.refreshToken',
          '*.secret',
          '*.password',
          '*.authorization',
          '*.cookie',
        ],
        censor: '[redacted]',
      },
    },
    opts.destination,
  );
  return wrap(root);
}

export const logger = (): Logger => {
  if (!root) return createLogger({ service: process.env['OREMEDIA_SERVICE'] ?? 'oremedia' });
  return wrap(root);
};

/** Temporal SDK log levels and logger shape, declared structurally so this package needs no Temporal dependency. */
export type SdkLogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export interface SdkLogger {
  log(level: SdkLogLevel, message: string, meta?: Record<string, unknown>): void;
  trace(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const SDK_LEVEL = { TRACE: 'debug', DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' } as const;

/**
 * The Temporal SDK's logger (Runtime.install({ logger })) routed through this logger: one JSON line on stdout at the
 * SDK's own level, through the field allowlist, instead of the SDK default that writes every level to stderr (which
 * a platform such as Railway files as an error). An `error` in the metadata is reduced to errorFields.
 */
export function sdkLogger(log: Logger): SdkLogger {
  const emit = (level: SdkLogLevel, message: string, meta: Record<string, unknown> = {}) => {
    const { error, ...rest } = meta;
    log[SDK_LEVEL[level]]({ ...rest, ...(error === undefined ? {} : errorFields(error)) }, message);
  };
  return {
    log: emit,
    trace: (m, meta) => emit('TRACE', m, meta),
    debug: (m, meta) => emit('DEBUG', m, meta),
    info: (m, meta) => emit('INFO', m, meta),
    warn: (m, meta) => emit('WARN', m, meta),
    error: (m, meta) => emit('ERROR', m, meta),
  };
}

/** Summarises an error for logs without leaking internals into user-facing messages. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      errorName: err.name,
      errorMessage: err.message.slice(0, 500),
      ...(typeof code === 'string' ? { errorCode: code } : {}),
    };
  }
  return { errorName: 'NonError', errorMessage: String(err).slice(0, 500) };
}
