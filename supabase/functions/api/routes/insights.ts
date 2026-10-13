// Opportunities & insights (mounted at /api): /leases/:id/insights, /opportunities
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { withOrg, requireRole, getOrgRow } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, readJson, str } from '../lib/http.ts';
import { aiConfigured } from '../lib/ai.ts';
import { runInBackground } from '../lib/runtime.ts';
import { ALL_CATEGORIES, cleanCamTerms, cleanSchedule, generateInsights, kindOf } from '../lib/intel-insights.ts';

const router = new Hono<AppEnv>();
router.use('/leases/:id/insights', withOrg);
router.use('/leases/:id/insights/*', withOrg);
router.use('/opportunities', withOrg);

/** A run older than this that is still "processing" was cut off (e.g. server restart). */
const STALE_MS = 20 * 60 * 1000;

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const STATUS_ORDER: Record<string, number> = { action: 0, watch: 1, needs_data: 2, none: 3 };

function sortOpportunities<T extends { status: string; priority: string | null; due_date: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    || (PRIORITY_ORDER[a.priority ?? ''] ?? 9) - (PRIORITY_ORDER[b.priority ?? ''] ?? 9)
    || String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')));
}

router.get('/leases/:id/insights', async (c) => {
  const lease = await getOrgRow<{ id: string }>(c, 'leases', c.req.param('id'), 'id');
  const [{ data: insights }, { data: opps }] = await Promise.all([
    db().from('lease_insights').select('*').eq('lease_id', lease.id).eq('org_id', c.get('orgId')).maybeSingle(),
    db().from('opportunities').select('*').eq('lease_id', lease.id).eq('org_id', c.get('orgId')),
  ]);
  let status = insights?.status ?? 'none';
  let error = insights?.error ?? null;
  if (status === 'processing' && Date.now() - Date.parse(insights.updated_at) > STALE_MS) {
    status = 'failed';
    error = 'The review did not finish. Run it again.';
    await db().from('lease_insights').update({ status, error }).eq('lease_id', lease.id);
  }
  return c.json({
    lease_id: lease.id,
    status,
    error,
    generated_at: insights?.generated_at ?? null,
    updated_at: insights?.updated_at ?? null,
    rent_schedule: insights?.rent_schedule ?? [],
    cam_terms: insights?.cam_terms ?? null,
    opportunities: sortOpportunities(opps ?? []),
  });
});

router.post('/leases/:id/insights', requireRole('editor'), async (c) => {
  const orgId = c.get('orgId');
  const lease = await getOrgRow<{ id: string }>(c, 'leases', c.req.param('id'), 'id');
  if (!aiConfigured()) throw new ApiError('ai_not_configured', 'AI is not configured. Set ANTHROPIC_API_KEY on the API.');
  const { data: current } = await db().from('lease_insights').select('status, updated_at').eq('lease_id', lease.id).maybeSingle();
  if (current?.status === 'processing' && Date.now() - Date.parse(current.updated_at) < STALE_MS) {
    throw new ApiError('conflict', 'The review is already running for this lease.');
  }
  must(await db().from('lease_insights').upsert({ lease_id: lease.id, org_id: orgId, status: 'processing', error: null }));
  const input = { orgId, userId: c.get('user').id, leaseId: lease.id, locale: c.get('profile').locale };
  runInBackground(async () => {
    try {
      await generateInsights(input);
    } catch (err) {
      await db().from('lease_insights').update({ status: 'failed', error: ((err as Error).message || 'Review failed').slice(0, 500) }).eq('lease_id', lease.id);
    }
  });
  return c.json({ lease_id: lease.id, status: 'processing' }, 202);
});

/** Hand-edit the extracted rent schedule and/or CAM terms (used by the financial tools). */
router.patch('/leases/:id/insights', requireRole('editor'), async (c) => {
  const orgId = c.get('orgId');
  const lease = await getOrgRow<{ id: string }>(c, 'leases', c.req.param('id'), 'id');
  const body = await readJson(c);
  const update: Record<string, unknown> = { lease_id: lease.id, org_id: orgId };
  if ('rent_schedule' in body) {
    if (!Array.isArray(body.rent_schedule)) throw badRequest('rent_schedule must be an array');
    update.rent_schedule = cleanSchedule(body.rent_schedule as never[]);
  }
  if ('cam_terms' in body) update.cam_terms = body.cam_terms === null ? null : cleanCamTerms(body.cam_terms as never);
  if (Object.keys(update).length === 2) throw badRequest('Nothing to update');
  const { data: existing } = await db().from('lease_insights').select('status').eq('lease_id', lease.id).maybeSingle();
  if (!existing) update.status = 'none';
  const row = must(await db().from('lease_insights').upsert(update).select('*').single())!;
  return c.json(row);
});

// Org-wide opportunities for portfolio use.
router.get('/opportunities', async (c) => {
  let q = db().from('opportunities')
    .select('*, leases(tenant_name, premises_address, status, expiration_date)')
    .eq('org_id', c.get('orgId'));
  const kind = str(c.req.query('kind'));
  const status = str(c.req.query('status'));
  const priority = str(c.req.query('priority'));
  const category = str(c.req.query('category'));
  const leaseId = str(c.req.query('lease_id'));
  if (kind) {
    if (kind !== 'revenue' && kind !== 'risk') throw badRequest('kind must be revenue or risk');
    q = q.eq('kind', kind);
  }
  if (status) q = q.in('status', status.split(','));
  if (priority) q = q.in('priority', priority.split(','));
  if (category) q = q.eq('category', category);
  if (leaseId) q = q.eq('lease_id', leaseId);
  const rows = must(await q.limit(5000)) as (Record<string, unknown> & {
    status: string; priority: string | null; due_date: string | null;
    leases: { tenant_name: string | null; premises_address: string | null; status: string; expiration_date: string | null } | null;
  })[];
  return c.json(sortOpportunities(rows).map(({ leases, ...o }) => ({
    ...o,
    tenant_name: leases?.tenant_name ?? null,
    premises_address: leases?.premises_address ?? null,
    lease_status: leases?.status ?? null,
    lease_expiration_date: leases?.expiration_date ?? null,
  })));
});

// Category list (for filters/legends).
router.get('/opportunities/categories', (c) => c.json(ALL_CATEGORIES.map((category) => ({ category, kind: kindOf(category) }))));

export default router;
