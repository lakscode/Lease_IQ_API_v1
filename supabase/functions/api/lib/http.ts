import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { errorFields, log } from './log.ts';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'no_org'
  | 'ai_not_configured'
  | 'email_not_configured'
  | 'integration_not_configured'
  | 'payload_too_large'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  no_org: 403,
  ai_not_configured: 503,
  email_not_configured: 503,
  integration_not_configured: 503,
  payload_too_large: 413,
  internal: 500,
};

/** Throw from any handler; the app's onError turns it into `{ error, code }` JSON. */
export class ApiError extends HTTPException {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(STATUS[code] as 400, { message });
    this.code = code;
  }
}

export const badRequest = (message: string) => new ApiError('bad_request', message);
export const notFound = (what = 'Resource') => new ApiError('not_found', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do this') => new ApiError('forbidden', message);

export function errorResponse(err: Error, c: Context) {
  const ctx = {
    method: c.req.method,
    path: c.req.path,
    userId: (c.get('user') as { id?: string } | undefined)?.id ?? null,
    email: (c.get('user') as { email?: string } | undefined)?.email ?? null,
  };
  if (err instanceof ApiError) {
    // Server-side ApiErrors (not configured, internal) are worth seeing; 4xx are normal client errors.
    if (err.status >= 500) log.warn('api.error', err.message, { ...ctx, code: err.code, status: err.status });
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: err.message, code: 'bad_request' }, err.status);
  }
  log.error('api.unhandled', err?.message || 'Unhandled error', { ...ctx, code: 'internal', ...errorFields(err) });
  return c.json({ error: 'Internal server error', code: 'internal' }, 500);
}

/** Parse a JSON body; returns {} for an empty/invalid body. */
export async function readJson<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** YYYY-MM-DD or null. */
export function dateStr(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) ? s.slice(0, 10) : null;
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\r\n');
}
