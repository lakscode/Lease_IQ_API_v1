// API request log (table api_request_log, migration 0130): one row per request, successful or not, written by the
// request middleware in app.ts after the response is ready. Read by super admins (Logs → API logs, GET /api/logs/api).
// Writing never throws and never delays the response (runInBackground). Rows older than RETENTION_DAYS are
// pruned now and then as new rows are written.
import type { Context } from 'hono';
import type { AppEnv } from './types.ts';
import { db } from './supabase.ts';
import { isEdgeRuntime, runInBackground } from './runtime.ts';
import { clientIp } from './account-logins.ts';

const RETENTION_DAYS = 30;
const PRUNE_EVERY = 200;   // on average, one prune per this many writes

/** Requests that aren't worth a row: uptime checks, the landing page, and reading the logs themselves. */
const SKIP = [/^\/api\/?$/, /^\/api\/health$/, /^\/api\/status$/, /^\/api\/logs(\/|$)/];

const SECRET_PARAM = /token|secret|password|passwd|key|code|signature/i;

/** Hide invite tokens in paths and secret-looking query values. */
function redact(path: string, query: string): { path: string; query: string | null } {
  const safePath = path.replace(/^(\/api\/invites\/(?:preview\/)?)[^/]+/, '$1:token');
  if (!query) return { path: safePath, query: null };
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) if (SECRET_PARAM.test(key)) params.set(key, '***');
  return { path: safePath, query: params.toString().slice(0, 1000) || null };
}

/** `{ error, code }` of an error response, read from a copy so the client still gets the body. */
async function errorBody(res: Response): Promise<{ code: string | null; message: string | null }> {
  if (res.status < 400 || !(res.headers.get('content-type') || '').includes('application/json')) return { code: null, message: null };
  try {
    const body = (await res.clone().json()) as { error?: unknown; code?: unknown };
    return {
      code: typeof body.code === 'string' ? body.code.slice(0, 100) : null,
      message: typeof body.error === 'string' ? body.error.slice(0, 2000) : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

/** Record the finished request. Call after `await next()`. */
export function recordRequest(c: Context<AppEnv>, startedAt: number): void {
  if (c.req.method === 'OPTIONS') return;
  const url = new URL(c.req.url);
  if (SKIP.some((re) => re.test(url.pathname))) return;
  const status = c.res.status;
  const durationMs = Date.now() - startedAt;
  const user = c.get('user') as { id?: string; email?: string } | undefined;
  const orgId = (c.get('orgId') as string | undefined) ?? null;
  const { path, query } = redact(url.pathname, url.search.replace(/^\?/, ''));
  const res = c.res;
  const ip = clientIp(c);
  const userAgent = c.req.header('user-agent')?.slice(0, 400) ?? null;

  runInBackground(async () => {
    const err = await errorBody(res);
    const { error } = await db().from('api_request_log').insert({
      method: c.req.method,
      path: path.slice(0, 500),
      query,
      status,
      duration_ms: durationMs,
      user_id: user?.id ?? null,
      email: user?.email?.toLowerCase() ?? null,
      org_id: orgId,
      error_code: err.code,
      error_message: err.message,
      ip,
      user_agent: userAgent,
      runtime: isEdgeRuntime ? 'edge' : 'node',
    });
    // console only: logging this through log.error would write error_log on every failed insert.
    if (error) console.error('api_request_log insert failed:', error.message);
    if (Math.random() < 1 / PRUNE_EVERY) {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
      await db().from('api_request_log').delete().lt('created_at', cutoff);
    }
  });
}

export type RequestOutcome = 'success' | 'error' | 'client_error' | 'server_error';

export interface RequestLogFilters {
  outcome?: string | null;
  method?: string | null;
  /** path contains */
  path?: string | null;
  /** email contains */
  user?: string | null;
  org_id?: string | null;
  /** ISO date/time, or a relative window like '30m', '24h', '7d' */
  since?: string | null;
  /** only requests slower than this (ms) */
  min_ms?: number | null;
  limit?: number;
}

function sinceDate(since: string): string | null {
  const rel = /^(\d+)\s*([mhd])$/i.exec(since.trim());
  if (rel) {
    const ms = Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2].toLowerCase() as 'm' | 'h' | 'd'];
    return new Date(Date.now() - ms).toISOString();
  }
  const d = new Date(since);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

/** Rows, or (`countOnly`) just the number of matching rows. */
const query = (countOnly: boolean) =>
  db().from('api_request_log').select('*', countOnly ? { count: 'exact', head: true } : undefined);
type Query = ReturnType<typeof query>;

/** Filters shared by the row query and the summary counts. Values are sanitised before PostgREST sees them. */
function applyFilters(q: Query, f: RequestLogFilters, { outcome = true } = {}): Query {
  const method = f.method?.toUpperCase();
  if (method && METHODS.includes(method)) q = q.eq('method', method);
  const path = f.path?.replace(/[^A-Za-z0-9/_.:-]/g, '').slice(0, 200);
  if (path) q = q.ilike('path', `%${path}%`);
  const user = f.user?.replace(/[^\p{L}\p{N}@._+-]/gu, '').slice(0, 100);
  if (user) q = q.ilike('email', `%${user}%`);
  if (f.org_id && UUID.test(f.org_id)) q = q.eq('org_id', f.org_id);
  const since = f.since ? sinceDate(f.since) : null;
  if (since) q = q.gte('created_at', since);
  if (f.min_ms && f.min_ms > 0) q = q.gte('duration_ms', Math.floor(f.min_ms));
  if (outcome) {
    if (f.outcome === 'success') q = q.lt('status', 400);
    else if (f.outcome === 'error') q = q.gte('status', 400);
    else if (f.outcome === 'client_error') q = q.gte('status', 400).lt('status', 500);
    else if (f.outcome === 'server_error') q = q.gte('status', 500);
  }
  return q;
}

export interface RequestLogRow {
  id: number; created_at: string; method: string; path: string; query: string | null; status: number; duration_ms: number;
  user_id: string | null; email: string | null; org_id: string | null; org_name?: string | null; error_code: string | null;
  error_message: string | null; ip: string | null; user_agent: string | null; runtime: string | null;
}

/** Newest first, with organization names, plus counts for the same filters (ignoring the outcome filter). */
export async function listRequestLogs(f: RequestLogFilters) {
  const limit = Math.min(Math.max(f.limit || 200, 1), 1000);
  const counted = () => applyFilters(query(true), f, { outcome: false });
  const [rowsRes, total, clientErrors, serverErrors] = await Promise.all([
    applyFilters(query(false), f).order('created_at', { ascending: false }).limit(limit),
    counted(),
    counted().gte('status', 400).lt('status', 500),
    counted().gte('status', 500),
  ]);
  for (const r of [rowsRes, total, clientErrors, serverErrors]) if (r.error) throw new Error(r.error.message);

  const rows = (rowsRes.data ?? []) as RequestLogRow[];
  const orgIds = [...new Set(rows.map((r) => r.org_id).filter((id): id is string => Boolean(id)))];
  if (orgIds.length) {
    const { data } = await db().from('organizations').select('id, name').in('id', orgIds);
    const names = new Map((data ?? []).map((o: { id: string; name: string }) => [o.id, o.name]));
    for (const r of rows) r.org_name = r.org_id ? names.get(r.org_id) ?? null : null;
  }
  const durations = rows.map((r) => r.duration_ms).sort((a, b) => a - b);
  const totalCount = total.count ?? 0;
  const errors = (clientErrors.count ?? 0) + (serverErrors.count ?? 0);
  return {
    summary: {
      total: totalCount,
      success: totalCount - errors,
      client_errors: clientErrors.count ?? 0,
      server_errors: serverErrors.count ?? 0,
      // Timing of the rows returned (newest `limit`), not of every matching request.
      avg_ms: durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null,
      p95_ms: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null,
      sample: durations.length,
    },
    rows,
  };
}
