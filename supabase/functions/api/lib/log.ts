// Structured server logging. Every entry is one JSON line on the console (Supabase → Edge Functions → Logs, or
// the Node terminal). Warnings and errors are also stored in error_log (Settings → Error log, GET /api/logs).
// Never throws: logging must not break a request or a pipeline step.
import { logError } from './error-log.ts';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogContext {
  userId?: string | null;
  email?: string | null;
  path?: string | null;
  code?: string | null;
  [key: string]: unknown;
}

function write(level: LogLevel, area: string, message: string, ctx: LogContext = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, area, msg: message, ...ctx });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  if (level === 'info') return;
  const { userId, email, path, code, ...details } = ctx;
  void logError({
    source: 'api',
    area,
    level: level === 'warn' ? 'warning' : 'error',
    code: code ?? null,
    message,
    details: Object.keys(details).length ? details : null,
    userId: userId ?? null,
    email: email ?? null,
    path: path ?? null,
  }).catch(() => undefined);
}

/** Error → loggable fields (message, name, first stack lines). */
export function errorFields(err: unknown): { error: string; errorName?: string; stack?: string } {
  const e = err as Error;
  return {
    error: e?.message || String(err),
    ...(e?.name && e.name !== 'Error' ? { errorName: e.name } : {}),
    ...(e?.stack ? { stack: e.stack.split('\n').slice(0, 6).join('\n') } : {}),
  };
}

export const log = {
  /** Major steps and successful operations (console only). */
  info: (area: string, message: string, ctx?: LogContext) => write('info', area, message, ctx),
  /** Recoverable problems, fallbacks (console + error_log as 'warning'). */
  warn: (area: string, message: string, ctx?: LogContext) => write('warn', area, message, ctx),
  /** Failures (console + error_log). */
  error: (area: string, message: string, ctx?: LogContext) => write('error', area, message, ctx),
};
