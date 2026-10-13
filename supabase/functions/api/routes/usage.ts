// AI usage reporting. Super admins: all organizations (optionally one). Org admins: their active organization.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { roleIn } from '../lib/auth.ts';
import { db } from '../lib/supabase.ts';
import { ApiError, badRequest, dateStr, forbidden, num, toCsv } from '../lib/http.ts';

const router = new Hono<AppEnv>();

interface UsageRow {
  id: number;
  org_id: string | null;
  user_id: string | null;
  process: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  duration_ms: number | null;
  file_id: string | null;
  lease_id: string | null;
  conversation_id: string | null;
  created_at: string;
}

interface Totals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  duration_ms: number;
}

const emptyTotals = (): Totals => ({ calls: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 0, duration_ms: 0 });

function add(t: Totals, r: UsageRow) {
  t.calls++;
  t.input_tokens += r.input_tokens ?? 0;
  t.output_tokens += r.output_tokens ?? 0;
  t.cache_creation_tokens += r.cache_creation_tokens ?? 0;
  t.cache_read_tokens += r.cache_read_tokens ?? 0;
  t.total_tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_creation_tokens ?? 0) + (r.cache_read_tokens ?? 0);
  t.duration_ms += r.duration_ms ?? 0;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Resolve the date range and the org scope the caller may see. */
async function resolveQuery(c: Context<AppEnv>) {
  const profile = c.get('profile');
  let from = dateStr(c.req.query('from'));
  let to = dateStr(c.req.query('to'));
  if (!from || !to) {
    const days = Math.min(Math.max(Math.round(num(c.req.query('days')) ?? 30), 1), 3660);
    const end = new Date();
    to = isoDay(end);
    from = isoDay(new Date(end.getTime() - (days - 1) * 86_400_000));
  }
  if (from > to) throw badRequest('"from" must be on or before "to"');

  const requested = c.req.query('org_id') || null;
  let orgId: string | null;
  if (profile.is_super_admin) {
    orgId = requested && requested !== 'all' ? requested : null;
  } else {
    const active = c.req.header('X-Org-Id') || profile.default_org_id;
    if (!active) throw forbidden('Organization admin access required');
    if (requested && requested !== active) throw forbidden('You can only see usage for your active organization');
    if ((await roleIn(active, profile)) !== 'admin') throw forbidden('Organization admin access required');
    orgId = active;
  }
  return { from, to, orgId };
}

async function loadRows(from: string, to: string, orgId: string | null): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  const end = new Date(`${to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const PAGE = 1000;
  for (let offset = 0; offset < 200_000; offset += PAGE) {
    let q = db().from('ai_usage').select('*').gte('created_at', `${from}T00:00:00Z`).lt('created_at', end.toISOString());
    if (orgId) q = q.eq('org_id', orgId);
    const { data, error } = await q.order('id').range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as UsageRow[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function names(rows: UsageRow[]) {
  const orgIds = [...new Set(rows.map((r) => r.org_id).filter((x): x is string => Boolean(x)))];
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => Boolean(x)))];
  const orgNames = new Map<string, string>();
  const emails = new Map<string, string>();
  for (let i = 0; i < orgIds.length; i += 200) {
    const { data } = await db().from('organizations').select('id, name').in('id', orgIds.slice(i, i + 200));
    for (const o of data ?? []) orgNames.set(o.id, o.name);
  }
  for (let i = 0; i < userIds.length; i += 200) {
    const { data } = await db().from('profiles').select('id, email').in('id', userIds.slice(i, i + 200));
    for (const p of data ?? []) emails.set(p.id, p.email ?? p.id);
  }
  return { orgNames, emails };
}

function group(rows: UsageRow[], keyOf: (r: UsageRow) => string): Map<string, Totals> {
  const map = new Map<string, Totals>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!map.has(k)) map.set(k, emptyTotals());
    add(map.get(k)!, r);
  }
  return map;
}

const byTotal = <T extends { total_tokens: number }>(list: T[]) => list.sort((a, b) => b.total_tokens - a.total_tokens);

// GET /api/usage?days=30 | from=&to=  [&org_id=]
router.get('/', async (c) => {
  const { from, to, orgId } = await resolveQuery(c);
  const rows = await loadRows(from, to, orgId);
  const { orgNames, emails } = await names(rows);
  const totals = emptyTotals();
  for (const r of rows) add(totals, r);

  // Every day in the range, including empty ones (for the chart).
  const daily = group(rows, (r) => r.created_at.slice(0, 10));
  const byDay: (Totals & { date: string })[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); isoDay(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = isoDay(d);
    byDay.push({ date: key, ...(daily.get(key) ?? emptyTotals()) });
    if (byDay.length > 3660) break;
  }

  return c.json({
    from,
    to,
    org_id: orgId,
    totals,
    by_day: byDay,
    by_org: byTotal([...group(rows, (r) => r.org_id ?? '')].map(([id, t]) => ({ org_id: id || null, org_name: id ? orgNames.get(id) ?? '(deleted organization)' : '(no organization)', ...t }))),
    by_user: byTotal([...group(rows, (r) => r.user_id ?? '')].map(([id, t]) => ({ user_id: id || null, email: id ? emails.get(id) ?? '(deleted user)' : '(system)', ...t }))),
    by_model: byTotal([...group(rows, (r) => r.model)].map(([model, t]) => ({ model, ...t }))),
    by_process: byTotal([...group(rows, (r) => r.process)].map(([process, t]) => ({ process, ...t }))),
  });
});

// GET /api/usage/export — one row per AI call, CSV.
router.get('/export', async (c) => {
  const { from, to, orgId } = await resolveQuery(c);
  const rows = await loadRows(from, to, orgId);
  if (rows.length > 100_000) throw new ApiError('payload_too_large', 'Too many rows; choose a shorter range');
  const { orgNames, emails } = await names(rows);
  const csv = toCsv(
    ['timestamp', 'organization', 'user', 'process', 'model', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'total_tokens', 'duration_ms', 'file_id', 'lease_id', 'conversation_id'],
    rows.map((r) => [
      r.created_at, r.org_id ? orgNames.get(r.org_id) ?? r.org_id : '', r.user_id ? emails.get(r.user_id) ?? r.user_id : '', r.process, r.model,
      r.input_tokens, r.output_tokens, r.cache_creation_tokens, r.cache_read_tokens,
      r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens, r.duration_ms ?? '', r.file_id ?? '', r.lease_id ?? '', r.conversation_id ?? '',
    ]),
  );
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="ai-usage-${from}-to-${to}.csv"`,
  });
});

export default router;
