import { db } from './supabase.ts';

export interface ErrorLogEntry {
  source: 'ui' | 'api';
  area: string;
  level?: 'error' | 'warning';
  code?: string | null;
  message: string;
  details?: Record<string, unknown> | null;
  userId?: string | null;
  email?: string | null;
  path?: string | null;
  userAgent?: string | null;
}

const cut = (v: string | null | undefined, max: number) => (v ? v.slice(0, max) : null);

export interface ErrorLogFilters {
  /** 'signup' also matches sub-areas such as 'signup.sso' */
  area?: string | null;
  level?: string | null;
  source?: string | null;
  /** ISO date/time, or a relative window like '30m', '24h', '7d' */
  since?: string | null;
  /** text search in message, code and email */
  q?: string | null;
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

/** Newest first. Values are sanitised before they reach the PostgREST filter syntax. */
export async function listErrorLogs(f: ErrorLogFilters): Promise<Record<string, unknown>[]> {
  const limit = Math.min(Math.max(f.limit || 200, 1), 1000);
  let q = db().from('error_log').select('*').order('created_at', { ascending: false }).limit(limit);
  const area = f.area?.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  if (area) q = q.or(`area.eq.${area},area.like.${area}.%`);
  if (f.level === 'error' || f.level === 'warning') q = q.eq('level', f.level);
  if (f.source === 'ui' || f.source === 'api') q = q.eq('source', f.source);
  const since = f.since ? sinceDate(f.since) : null;
  if (since) q = q.gte('created_at', since);
  const text = f.q?.replace(/[^\p{L}\p{N}@._ -]/gu, '').trim().slice(0, 100);
  if (text) q = q.or(`message.ilike.%${text}%,code.ilike.%${text}%,email.ilike.%${text}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Append to error_log. Never throws (logging must not break the request). */
export async function logError(entry: ErrorLogEntry): Promise<void> {
  let details = entry.details ?? null;
  if (details && JSON.stringify(details).length > 4000) details = { truncated: true };
  const { error } = await db().from('error_log').insert({
    source: entry.source,
    area: entry.area.slice(0, 60),
    level: entry.level ?? 'error',
    code: cut(entry.code, 100),
    message: entry.message.slice(0, 2000) || '(no message)',
    details,
    user_id: entry.userId ?? null,
    email: cut(entry.email?.trim().toLowerCase(), 320),
    path: cut(entry.path, 500),
    user_agent: cut(entry.userAgent, 400),
  });
  if (error) console.error('error_log insert failed:', error.message, '| original:', entry.area, entry.message);
}
