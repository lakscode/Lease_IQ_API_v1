// GET /logs — the error log, for the UI (Logs page) and for scripts.
// Access: a signed-in super admin, or `Authorization: Bearer <LOGS_API_TOKEN>` when that env var is set.
// Query: area, level (error|warning), source (ui|api), since (ISO or 30m/24h/7d), q (text), limit (≤1000),
//        format=json (default) | text (one line per entry, handy with curl).
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { db } from '../lib/supabase.ts';
import { getEnv } from '../lib/runtime.ts';
import { ApiError, forbidden } from '../lib/http.ts';
import { listErrorLogs } from '../lib/error-log.ts';

const router = new Hono<AppEnv>();

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorize(c: Context<AppEnv>): Promise<void> {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new ApiError('unauthorized', 'Missing bearer token');

  const logsToken = getEnv('LOGS_API_TOKEN');
  if (logsToken && logsToken.length >= 24 && sameSecret(token, logsToken)) return;

  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) throw new ApiError('unauthorized', 'Invalid or expired token');
  const { data: profile } = await db().from('profiles').select('is_super_admin').eq('id', data.user.id).maybeSingle();
  if (!profile?.is_super_admin) throw forbidden('Super admin access required');
}

router.get('/', async (c) => {
  await authorize(c);
  const rows = await listErrorLogs({
    area: c.req.query('area'),
    level: c.req.query('level'),
    source: c.req.query('source'),
    since: c.req.query('since'),
    q: c.req.query('q'),
    limit: Number(c.req.query('limit')) || undefined,
  });
  if (c.req.query('format') === 'text') {
    const lines = rows.map((r) =>
      [r.created_at, String(r.level).toUpperCase(), r.source, r.area, r.code ?? '-', r.email ?? '-', String(r.message).replace(/\s+/g, ' ')].join(' | '),
    );
    return c.text(lines.length ? `${lines.join('\n')}\n` : 'No log entries.\n');
  }
  return c.json(rows);
});

export default router;
