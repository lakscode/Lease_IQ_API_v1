// Financial tools (mounted at /api): /leases/:id/rent-audit…, /leases/:id/cam…, /market-rates…, /leases/:id/market
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { withOrg, requireRole, getOrgRow } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { badRequest, dateStr, notFound, num, readJson, str } from '../lib/http.ts';
import { logAccess } from '../lib/access-log.ts';
import { today } from '../lib/lease-terms.ts';
import type { RentPeriod } from '../lib/intel-insights.ts';
import {
  MAX_AUDIT_MONTHS, billingChecks, computeAudit, effectiveSchedule, latestRentRollRecord, monthStart, monthsBetween,
  nextStep, systemMonthlyRent, leaseRentForMonth,
} from '../lib/intel-rent.ts';
import { computeCam, parseCam } from '../lib/intel-cam.ts';
import { analyzeMarket, resolveMarketRate, type LeaseAnalysisInput, type MarketRateRow } from '../lib/intel-market.ts';

const router = new Hono<AppEnv>();
for (const p of ['/leases/:id/rent-audit', '/leases/:id/rent-audit/*', '/leases/:id/cam', '/leases/:id/cam/*', '/leases/:id/market', '/market-rates', '/market-rates/*']) {
  router.use(p, withOrg);
}

const LEASE_COLUMNS = 'id, tenant_name, premises_address, rentable_area, base_rent_monthly, commencement_date, expiration_date, status, property_type, market_rate_id, market_rate_override';

type LeaseRow = LeaseAnalysisInput & { commencement_date: string | null };

async function loadLease(c: Context<AppEnv>) {
  return getOrgRow<LeaseRow>(c, 'leases', c.req.param('id') as string, LEASE_COLUMNS);
}

async function leaseSchedule(orgId: string, lease: LeaseRow) {
  const { data } = await db().from('lease_insights').select('rent_schedule, cam_terms, status, generated_at')
    .eq('lease_id', lease.id).eq('org_id', orgId).maybeSingle();
  return { ...effectiveSchedule((data?.rent_schedule ?? null) as RentPeriod[] | null, lease), insights: data };
}

// ---- Rent audit ---------------------------------------------------------------------------------

router.get('/leases/:id/rent-audit', async (c) => {
  const orgId = c.get('orgId');
  const lease = await loadLease(c);
  const [{ schedule, source }, system, audits] = await Promise.all([
    leaseSchedule(orgId, lease),
    latestRentRollRecord(orgId, lease.id),
    db().from('rent_audits').select('id, start_month, end_month, totals, created_at, created_by')
      .eq('org_id', orgId).eq('lease_id', lease.id).order('start_month', { ascending: false }),
  ]);
  const asOf = today();
  return c.json({
    lease,
    as_of: asOf,
    schedule,
    schedule_source: source,
    current_month_rent: leaseRentForMonth(schedule, monthStart(asOf) as string).rent,
    next_step: nextStep(schedule, asOf),
    system: system.record ? {
      record: system.record,
      import: system.import,
      monthly_base_rent: systemMonthlyRent(system.record),
    } : null,
    checks: billingChecks(schedule, system.record, asOf),
    audits: audits.data ?? [],
  });
});

function auditRange(body: Record<string, unknown>) {
  const start = monthStart(body.start_month);
  const end = monthStart(body.end_month);
  if (!start || !end) throw badRequest('start_month and end_month (YYYY-MM) are required');
  if (end < start) throw badRequest('end_month must not be before start_month');
  if (monthsBetween(start, end).length > MAX_AUDIT_MONTHS) throw badRequest(`At most ${MAX_AUDIT_MONTHS} months per audit`);
  return { start, end };
}

async function runAudit(c: Context<AppEnv>, body: Record<string, unknown>) {
  const orgId = c.get('orgId');
  const lease = await loadLease(c);
  const { start, end } = auditRange(body);
  const [{ schedule, source }, system] = await Promise.all([leaseSchedule(orgId, lease), latestRentRollRecord(orgId, lease.id)]);
  const overrides = (body.billed && typeof body.billed === 'object' ? body.billed : {}) as Record<string, unknown>;
  const systemMonthly = body.system_monthly !== undefined ? num(body.system_monthly) : systemMonthlyRent(system.record);
  return { lease, start, end, source, systemMonthly, ...computeAudit(schedule, start, end, systemMonthly, overrides) };
}

/** Compute without saving (viewers too). Body: {start_month, end_month, billed?: {YYYY-MM: amount}}. */
router.post('/leases/:id/rent-audit/compute', async (c) => {
  const r = await runAudit(c, await readJson(c));
  return c.json({ start_month: r.start, end_month: r.end, schedule_source: r.source, system_monthly: r.systemMonthly, rows: r.rows, totals: r.totals });
});

/** Save (upsert by month range). */
router.post('/leases/:id/rent-audit', requireRole('editor'), async (c) => {
  const r = await runAudit(c, await readJson(c));
  const row = must(await db().from('rent_audits').upsert({
    org_id: c.get('orgId'), lease_id: r.lease.id, start_month: r.start, end_month: r.end,
    rows: r.rows, totals: r.totals, created_by: c.get('user').id, created_at: new Date().toISOString(),
  }, { onConflict: 'lease_id,start_month,end_month' }).select('*').single())!;
  await logAccess({ orgId: c.get('orgId'), userId: c.get('user').id, action: 'save', leaseId: r.lease.id, details: { rent_audit: row.id, start_month: r.start, end_month: r.end } });
  return c.json(row, 201);
});

router.get('/leases/:id/rent-audit/:auditId', async (c) => {
  const lease = await loadLease(c);
  const { data } = await db().from('rent_audits').select('*').eq('id', c.req.param('auditId')).eq('lease_id', lease.id).eq('org_id', c.get('orgId')).maybeSingle();
  if (!data) throw notFound('Rent audit');
  return c.json(data);
});

router.delete('/leases/:id/rent-audit/:auditId', requireRole('editor'), async (c) => {
  const lease = await loadLease(c);
  const { data } = await db().from('rent_audits').delete().eq('id', c.req.param('auditId')).eq('lease_id', lease.id).eq('org_id', c.get('orgId')).select('id');
  if (!data?.length) throw notFound('Rent audit');
  return c.json({ ok: true });
});

// ---- CAM reconciliation -------------------------------------------------------------------------

function yearParam(c: Context<AppEnv>): number {
  const year = Number(c.req.param('year'));
  if (!Number.isInteger(year) || year < 1950 || year > 2200) throw badRequest('Invalid year');
  return year;
}

router.get('/leases/:id/cam', async (c) => {
  const orgId = c.get('orgId');
  const lease = await loadLease(c);
  const [{ insights }, recs] = await Promise.all([
    leaseSchedule(orgId, lease),
    db().from('cam_reconciliations').select('id, year, result, updated_at').eq('org_id', orgId).eq('lease_id', lease.id).order('year', { ascending: false }),
  ]);
  return c.json({
    lease,
    cam_terms: insights?.cam_terms ?? null,
    reconciliations: (recs.data ?? []).map((r) => ({
      id: r.id, year: r.year, updated_at: r.updated_at,
      total_due: r.result?.total_due ?? null, balance: r.result?.balance ?? null, balance_direction: r.result?.balance_direction ?? null,
    })),
  });
});

/** Compute without saving. Body: {year, inputs, settings}. */
router.post('/leases/:id/cam/compute', async (c) => {
  await loadLease(c);
  const body = await readJson(c);
  const year = Number(body.year) || new Date().getUTCFullYear();
  const { inputs, settings } = parseCam(body as never, year);
  return c.json({ year, inputs, settings, result: computeCam(inputs, settings) });
});

router.get('/leases/:id/cam/:year', async (c) => {
  const lease = await loadLease(c);
  const { data } = await db().from('cam_reconciliations').select('*').eq('lease_id', lease.id).eq('org_id', c.get('orgId')).eq('year', yearParam(c)).maybeSingle();
  if (!data) throw notFound('CAM reconciliation');
  return c.json({ id: data.id, year: data.year, inputs: data.inputs?.inputs ?? {}, settings: data.inputs?.settings ?? {}, result: data.result, updated_at: data.updated_at });
});

router.put('/leases/:id/cam/:year', requireRole('editor'), async (c) => {
  const lease = await loadLease(c);
  const year = yearParam(c);
  const { inputs, settings } = parseCam((await readJson(c)) as never, year);
  const result = computeCam(inputs, settings);
  const row = must(await db().from('cam_reconciliations').upsert({
    org_id: c.get('orgId'), lease_id: lease.id, year, inputs: { inputs, settings }, result, created_by: c.get('user').id,
  }, { onConflict: 'lease_id,year' }).select('*').single())!;
  await logAccess({ orgId: c.get('orgId'), userId: c.get('user').id, action: 'save', leaseId: lease.id, details: { cam_reconciliation: row.id, year } });
  return c.json({ id: row.id, year, inputs, settings, result, updated_at: row.updated_at });
});

router.delete('/leases/:id/cam/:year', requireRole('editor'), async (c) => {
  const lease = await loadLease(c);
  const { data } = await db().from('cam_reconciliations').delete().eq('lease_id', lease.id).eq('org_id', c.get('orgId')).eq('year', yearParam(c)).select('id');
  if (!data?.length) throw notFound('CAM reconciliation');
  return c.json({ ok: true });
});

// ---- Market Rent Engine -------------------------------------------------------------------------

const RATE_COLUMNS = 'id, property_type, rate_psf_annual, source, as_of, address_match, created_at';

function rateFields(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || 'property_type' in body) {
    const t = str(body.property_type);
    if (!t) throw badRequest('property_type is required');
    out.property_type = t.slice(0, 80);
  }
  if (!partial || 'rate_psf_annual' in body) {
    const r = num(body.rate_psf_annual);
    if (r === null || r < 0) throw badRequest('rate_psf_annual must be a non-negative number');
    out.rate_psf_annual = r;
  }
  if (!partial || 'source' in body) out.source = str(body.source)?.slice(0, 200) ?? null;
  if (!partial || 'as_of' in body) out.as_of = dateStr(body.as_of);
  if (!partial || 'address_match' in body) out.address_match = str(body.address_match)?.slice(0, 200) ?? null;
  return out;
}

router.get('/market-rates', async (c) => {
  const rows = must(await db().from('market_rates').select(RATE_COLUMNS).eq('org_id', c.get('orgId')).order('property_type').order('address_match', { nullsFirst: true }));
  return c.json(rows ?? []);
});

router.post('/market-rates', requireRole('editor'), async (c) => {
  const row = must(await db().from('market_rates').insert({ org_id: c.get('orgId'), ...rateFields(await readJson(c), false) }).select(RATE_COLUMNS).single())!;
  return c.json(row, 201);
});

router.get('/market-rates/analysis', async (c) => {
  const orgId = c.get('orgId');
  const [leases, rates] = await Promise.all([
    db().from('leases').select(LEASE_COLUMNS).eq('org_id', orgId).order('tenant_name'),
    db().from('market_rates').select(RATE_COLUMNS).eq('org_id', orgId),
  ]);
  if (leases.error) throw new Error(leases.error.message);
  const result = analyzeMarket((leases.data ?? []) as LeaseAnalysisInput[], (rates.data ?? []) as MarketRateRow[]);
  const types = [...new Set([
    ...(rates.data ?? []).map((r) => r.property_type as string),
    ...(leases.data ?? []).map((l) => l.property_type as string | null).filter((t): t is string => Boolean(t)),
  ])].sort();
  return c.json({ ...result, property_types: types });
});

router.patch('/market-rates/:rateId', requireRole('editor'), async (c) => {
  const rate = await getOrgRow<{ id: string }>(c, 'market_rates', c.req.param('rateId'), 'id');
  const fields = rateFields(await readJson(c), true);
  if (!Object.keys(fields).length) throw badRequest('Nothing to update');
  const row = must(await db().from('market_rates').update(fields).eq('id', rate.id).select(RATE_COLUMNS).single())!;
  return c.json(row);
});

router.delete('/market-rates/:rateId', requireRole('editor'), async (c) => {
  const rate = await getOrgRow<{ id: string }>(c, 'market_rates', c.req.param('rateId'), 'id');
  must(await db().from('market_rates').delete().eq('id', rate.id));
  return c.json({ ok: true });
});

/** Per-lease market settings: {property_type?, market_rate_id?, market_rate_override?} (null clears). */
router.patch('/leases/:id/market', requireRole('editor'), async (c) => {
  const orgId = c.get('orgId');
  const lease = await loadLease(c);
  const body = await readJson(c);
  const update: Record<string, unknown> = {};
  if ('property_type' in body) update.property_type = str(body.property_type)?.slice(0, 80) ?? null;
  if ('market_rate_id' in body) {
    const id = str(body.market_rate_id);
    if (id) {
      const { data } = await db().from('market_rates').select('id').eq('id', id).eq('org_id', orgId).maybeSingle();
      if (!data) throw notFound('Market rate');
    }
    update.market_rate_id = id;
  }
  if ('market_rate_override' in body) {
    const v = body.market_rate_override === null || body.market_rate_override === '' ? null : num(body.market_rate_override);
    if (v !== null && v < 0) throw badRequest('market_rate_override must be a non-negative number');
    if (body.market_rate_override !== null && body.market_rate_override !== '' && v === null) throw badRequest('market_rate_override must be a number');
    update.market_rate_override = v;
  }
  if (!Object.keys(update).length) throw badRequest('Nothing to update');
  const row = must(await db().from('leases').update(update).eq('id', lease.id).eq('org_id', orgId).select(LEASE_COLUMNS).single()) as LeaseRow;
  const { data: rates } = await db().from('market_rates').select(RATE_COLUMNS).eq('org_id', orgId);
  const market = resolveMarketRate(row, (rates ?? []) as MarketRateRow[]);
  return c.json({ lease: row, market: { rate_psf: market.rate_psf, source: market.source, rate_id: market.rate?.id ?? null } });
});

export default router;
