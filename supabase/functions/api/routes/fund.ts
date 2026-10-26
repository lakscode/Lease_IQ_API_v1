// /api/fund — fund administration: funds, investors and commitments, NAV, the leases a fund holds, overview.
// Capital calls and distributions are in fund-transactions.ts (same /fund prefix). Metrics: lib/fund-accounts.ts.
//   GET    /overview                         totals across funds, funds with metrics, upcoming calls, recent distributions
//   GET    /funds                            funds with metrics          POST /funds   PATCH/DELETE /funds/:id
//   GET    /funds/:id                        fund, metrics, capital accounts, commitments, calls, distributions, NAVs, leases
//   GET    /funds/:id/capital-accounts.csv   (download)
//   POST   /funds/:id/leases { lease_id }    DELETE /funds/:id/leases/:leaseId
//   GET    /property-map                     every lease with its fund (fund_id null = unassigned), and the funds
//   PUT    /property-map { lease_ids, fund_id }   assign leases to a fund (moving them), or fund_id null to unassign
//   GET    /investors                        investors with commitments and totals   POST   PATCH/DELETE /investors/:id
//   POST   /commitments { fund_id, investor_id, amount, commitment_date }            PATCH/DELETE /commitments/:id
//   GET    /valuations?fund_id               POST /valuations { fund_id, as_of_date, nav, notes }   DELETE /valuations/:id
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { getOrgRow, requireRole, withOrg } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, dateStr, num, readJson, str, toCsv } from '../lib/http.ts';
import {
  FUND_COLUMNS, FUND_STATUSES, INVESTOR_COLUMNS, INVESTOR_TYPES, VALUATION_COLUMNS,
  bodyId, callStatus, capitalAccounts, fundMetrics, loadFundData, money, oneOf, toNumbers, type Fund, type FundData,
} from '../lib/fund-accounts.ts';
import transactions from './fund-transactions.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);
router.route('/', transactions);   // /capital-calls…, /distributions…

const today = () => new Date().toISOString().slice(0, 10);

function pct(value: unknown, what: string): number | null {
  const n = num(value);
  if (n === null) return null;
  if (n < 0 || n > 100) throw badRequest(`${what} must be between 0 and 100.`);
  return n;
}

/** Fields of a fund from a request body; `partial` keeps absent keys out (PATCH). */
function fundFields(body: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (key: string, value: () => unknown) => { if (!partial || key in body) out[key] = value(); };
  set('name', () => {
    const name = str(body.name);
    if (!name) throw badRequest('Fund name is required.');
    return name.slice(0, 200);
  });
  set('strategy', () => str(body.strategy)?.slice(0, 100) ?? null);
  set('vintage_year', () => {
    const y = num(body.vintage_year);
    if (y !== null && (!Number.isInteger(y) || y < 1900 || y > 2200)) throw badRequest('Vintage year must be a year.');
    return y;
  });
  set('inception_date', () => dateStr(body.inception_date));
  set('target_size', () => money(body.target_size, 'Target size'));
  set('status', () => oneOf(body.status, FUND_STATUSES, 'status') ?? 'active');
  set('management_fee_pct', () => pct(body.management_fee_pct, 'Management fee'));
  set('carry_pct', () => pct(body.carry_pct, 'Carried interest'));
  set('hurdle_pct', () => pct(body.hurdle_pct, 'Hurdle rate'));
  set('notes', () => str(body.notes)?.slice(0, 5000) ?? null);
  return out;
}

function investorFields(body: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (key: string, value: () => unknown) => { if (!partial || key in body) out[key] = value(); };
  set('name', () => {
    const name = str(body.name);
    if (!name) throw badRequest('Investor name is required.');
    return name.slice(0, 200);
  });
  set('investor_type', () => oneOf(body.investor_type, INVESTOR_TYPES, 'investor type') ?? 'institution');
  set('contact_name', () => str(body.contact_name)?.slice(0, 200) ?? null);
  set('email', () => {
    const email = str(body.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address.');
    return email;
  });
  set('phone', () => str(body.phone)?.slice(0, 50) ?? null);
  set('notes', () => str(body.notes)?.slice(0, 5000) ?? null);
  return out;
}

function fundWithMetrics(data: FundData, fund: Fund) {
  return { ...fund, metrics: fundMetrics(data, fund.id) };
}

async function fundLeases(c: Context<AppEnv>, data: FundData, fundId: string) {
  const ids = data.fundLeases.filter((l) => l.fund_id === fundId).map((l) => l.lease_id);
  if (!ids.length) return [];
  const rows = must(await db().from('leases')
    .select('id, tenant_name, landlord_name, premises_address, property_type, rentable_area, base_rent_monthly, expiration_date, status')
    .eq('org_id', c.get('orgId')).in('id', ids).order('tenant_name')) ?? [];
  return (rows as { base_rent_monthly: number | string | null; rentable_area: number | string | null }[]).map((r) => ({
    ...r,
    base_rent_monthly: r.base_rent_monthly === null ? null : Number(r.base_rent_monthly),
    rentable_area: r.rentable_area === null ? null : Number(r.rentable_area),
  }));
}

// ---- Overview --------------------------------------------------------------------------------

router.get('/overview', async (c) => {
  const data = await loadFundData(c.get('orgId'));
  const funds = data.funds.map((f) => fundWithMetrics(data, f));
  const total = (key: 'commitments' | 'called' | 'paid_in' | 'receivable' | 'uncalled' | 'distributed') =>
    Math.round(funds.reduce((s, f) => s + f.metrics[key], 0) * 100) / 100;
  const navFunds = funds.filter((f) => f.metrics.nav !== null);
  const paidIn = total('paid_in');
  const distributed = total('distributed');
  const nav = navFunds.length ? Math.round(navFunds.reduce((s, f) => s + (f.metrics.nav ?? 0), 0) * 100) / 100 : null;
  const names = new Map(data.funds.map((f) => [f.id, f.name]));
  const now = today();
  const openCalls = data.calls
    .map((call) => ({ ...call, fund_name: names.get(call.fund_id) ?? '—', ...callStatus(call, data.callAllocations, now) }))
    .filter((call) => call.status !== 'paid')
    .sort((a, b) => (a.due_date ?? a.call_date).localeCompare(b.due_date ?? b.call_date))
    .slice(0, 10);
  const recentDistributions = data.distributions.slice(0, 5).map((d) => ({ ...d, fund_name: names.get(d.fund_id) ?? '—' }));
  return c.json({
    totals: {
      funds: funds.length, investors: data.investors.length,
      commitments: total('commitments'), called: total('called'), paid_in: paidIn, receivable: total('receivable'),
      uncalled: total('uncalled'), distributed, nav,
      dpi: paidIn > 0 ? Math.round((distributed / paidIn) * 100) / 100 : null,
      tvpi: paidIn > 0 ? Math.round(((distributed + (nav ?? 0)) / paidIn) * 100) / 100 : null,
    },
    funds,
    open_calls: openCalls,
    recent_distributions: recentDistributions,
  });
});

// ---- Funds -----------------------------------------------------------------------------------

router.get('/funds', async (c) => {
  const data = await loadFundData(c.get('orgId'));
  return c.json(data.funds.map((f) => fundWithMetrics(data, f)));
});

router.post('/funds', requireRole('editor'), async (c) => {
  const fields = fundFields(await readJson(c), false);
  const row = must(await db().from('funds')
    .insert({ ...fields, org_id: c.get('orgId'), created_by: c.get('user').id }).select(FUND_COLUMNS).single());
  return c.json(toNumbers([row as unknown as Fund])[0], 201);
});

router.get('/funds/:id', async (c) => {
  const fund = await getOrgRow<{ id: string }>(c, 'funds', c.req.param('id'), 'id');
  const data = await loadFundData(c.get('orgId'));
  const row = data.funds.find((f) => f.id === fund.id)!;
  const investors = new Map(data.investors.map((i) => [i.id, i.name]));
  const now = today();
  return c.json({
    fund: row,
    metrics: fundMetrics(data, fund.id),
    accounts: capitalAccounts(data, fund.id),
    commitments: data.commitments.filter((x) => x.fund_id === fund.id)
      .map((x) => ({ ...x, investor_name: investors.get(x.investor_id) ?? '—' }))
      .sort((a, b) => b.amount - a.amount),
    calls: data.calls.filter((x) => x.fund_id === fund.id).map((x) => ({ ...x, ...callStatus(x, data.callAllocations, now) })),
    distributions: data.distributions.filter((x) => x.fund_id === fund.id),
    valuations: data.valuations.filter((x) => x.fund_id === fund.id),
    leases: await fundLeases(c, data, fund.id),
  });
});

router.patch('/funds/:id', requireRole('editor'), async (c) => {
  const fund = await getOrgRow<{ id: string }>(c, 'funds', c.req.param('id'), 'id');
  const fields = fundFields(await readJson(c), true);
  const row = must(await db().from('funds').update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', fund.id).eq('org_id', c.get('orgId')).select(FUND_COLUMNS).single());
  return c.json(toNumbers([row as unknown as Fund])[0]);
});

router.delete('/funds/:id', requireRole('editor'), async (c) => {
  const fund = await getOrgRow<{ id: string }>(c, 'funds', c.req.param('id'), 'id');
  must(await db().from('funds').delete().eq('id', fund.id).eq('org_id', c.get('orgId')));
  return c.json({ deleted: true });
});

router.get('/funds/:id/capital-accounts.csv', async (c) => {
  const fund = await getOrgRow<{ id: string; name: string }>(c, 'funds', c.req.param('id'), 'id, name');
  const data = await loadFundData(c.get('orgId'));
  const rows = capitalAccounts(data, fund.id).map((a) => [
    a.investor_name, a.investor_type, a.commitment, a.ownership_pct, a.called, a.paid_in, a.receivable, a.uncalled, a.distributed, a.nav_share,
  ]);
  const csv = toCsv(['Investor', 'Type', 'Commitment', 'Ownership %', 'Called', 'Paid in', 'Receivable', 'Uncalled', 'Distributed', 'NAV share'], rows);
  const slug = fund.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fund';
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="capital-accounts-${slug}-${today()}.csv"`,
    },
  });
});

router.post('/funds/:id/leases', requireRole('editor'), async (c) => {
  const fund = await getOrgRow<{ id: string }>(c, 'funds', c.req.param('id'), 'id');
  const body = await readJson<{ lease_id?: unknown }>(c);
  const lease = await getOrgRow<{ id: string }>(c, 'leases', bodyId(body.lease_id, 'Lease'), 'id');
  // A lease belongs to one fund: adding it here moves it from any other fund.
  must(await db().from('fund_leases').upsert(
    { org_id: c.get('orgId'), fund_id: fund.id, lease_id: lease.id }, { onConflict: 'lease_id' },
  ));
  return c.json({ fund_id: fund.id, lease_id: lease.id }, 201);
});

router.delete('/funds/:id/leases/:leaseId', requireRole('editor'), async (c) => {
  const fund = await getOrgRow<{ id: string }>(c, 'funds', c.req.param('id'), 'id');
  must(await db().from('fund_leases').delete()
    .eq('org_id', c.get('orgId')).eq('fund_id', fund.id).eq('lease_id', c.req.param('leaseId')));
  return c.json({ deleted: true });
});

// ---- Fund ↔ property mapping ------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/property-map', async (c) => {
  const orgId = c.get('orgId');
  const [leases, links, funds] = await Promise.all([
    db().from('leases')
      .select('id, tenant_name, landlord_name, premises_address, property_type, rentable_area, base_rent_monthly, expiration_date, status')
      .eq('org_id', orgId).order('tenant_name'),
    db().from('fund_leases').select('fund_id, lease_id').eq('org_id', orgId),
    db().from('funds').select('id, name, status').eq('org_id', orgId).order('name'),
  ]);
  const fundOf = new Map((must(links) as { fund_id: string; lease_id: string }[]).map((l) => [l.lease_id, l.fund_id]));
  const rows = (must(leases) as { id: string; rentable_area: number | string | null; base_rent_monthly: number | string | null }[]).map((l) => ({
    ...l,
    rentable_area: l.rentable_area === null ? null : Number(l.rentable_area),
    base_rent_monthly: l.base_rent_monthly === null ? null : Number(l.base_rent_monthly),
    fund_id: fundOf.get(l.id) ?? null,
  }));
  return c.json({ funds: must(funds), leases: rows });
});

router.put('/property-map', requireRole('editor'), async (c) => {
  const orgId = c.get('orgId');
  const body = await readJson<{ lease_ids?: unknown; fund_id?: unknown }>(c);
  const ids = Array.isArray(body.lease_ids) ? [...new Set(body.lease_ids.map(String).filter((id) => UUID_RE.test(id)))] : [];
  if (!ids.length) throw badRequest('Choose at least one property.');
  if (ids.length > 1000) throw badRequest('You can map at most 1000 properties at once.');
  const fundId = body.fund_id === null || body.fund_id === '' ? null : bodyId(body.fund_id, 'Fund');
  if (fundId) await getOrgRow(c, 'funds', fundId, 'id');

  // Only this organization's leases.
  const owned = (must(await db().from('leases').select('id').eq('org_id', orgId).in('id', ids)) as { id: string }[]).map((l) => l.id);
  if (owned.length !== ids.length) throw new ApiError('not_found', 'Some properties were not found.');

  if (fundId) {
    must(await db().from('fund_leases').upsert(owned.map((leaseId) => ({ org_id: orgId, fund_id: fundId, lease_id: leaseId })), { onConflict: 'lease_id' }));
  } else {
    must(await db().from('fund_leases').delete().eq('org_id', orgId).in('lease_id', owned));
  }
  return c.json({ updated: owned.length, fund_id: fundId });
});

// ---- Investors & commitments -----------------------------------------------------------------

router.get('/investors', async (c) => {
  const data = await loadFundData(c.get('orgId'));
  const fundNames = new Map(data.funds.map((f) => [f.id, f.name]));
  const accounts = data.funds.flatMap((f) => capitalAccounts(data, f.id));
  return c.json(data.investors.map((inv) => {
    const own = accounts.filter((a) => a.investor_id === inv.id);
    const sum = (key: 'commitment' | 'paid_in' | 'distributed' | 'receivable') => Math.round(own.reduce((s, a) => s + a[key], 0) * 100) / 100;
    return {
      ...inv,
      commitments: data.commitments.filter((x) => x.investor_id === inv.id)
        .map((x) => ({ ...x, fund_name: fundNames.get(x.fund_id) ?? '—' })),
      total_commitment: sum('commitment'),
      paid_in: sum('paid_in'),
      receivable: sum('receivable'),
      distributed: sum('distributed'),
    };
  }));
});

router.post('/investors', requireRole('editor'), async (c) => {
  const fields = investorFields(await readJson(c), false);
  const row = must(await db().from('fund_investors')
    .insert({ ...fields, org_id: c.get('orgId'), created_by: c.get('user').id }).select(INVESTOR_COLUMNS).single());
  return c.json(row, 201);
});

router.patch('/investors/:id', requireRole('editor'), async (c) => {
  const inv = await getOrgRow<{ id: string }>(c, 'fund_investors', c.req.param('id'), 'id');
  const fields = investorFields(await readJson(c), true);
  const row = must(await db().from('fund_investors').update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', inv.id).eq('org_id', c.get('orgId')).select(INVESTOR_COLUMNS).single());
  return c.json(row);
});

async function hasActivity(orgId: string, investorId: string, fundId?: string): Promise<boolean> {
  let calls = db().from('fund_call_allocations').select('id, fund_capital_calls!inner(fund_id)', { count: 'exact', head: true })
    .eq('org_id', orgId).eq('investor_id', investorId);
  let dists = db().from('fund_distribution_allocations').select('id, fund_distributions!inner(fund_id)', { count: 'exact', head: true })
    .eq('org_id', orgId).eq('investor_id', investorId);
  if (fundId) {
    calls = calls.eq('fund_capital_calls.fund_id', fundId);
    dists = dists.eq('fund_distributions.fund_id', fundId);
  }
  const [a, b] = await Promise.all([calls, dists]);
  if (a.error) throw new Error(a.error.message);
  if (b.error) throw new Error(b.error.message);
  return (a.count ?? 0) + (b.count ?? 0) > 0;
}

router.delete('/investors/:id', requireRole('editor'), async (c) => {
  const inv = await getOrgRow<{ id: string }>(c, 'fund_investors', c.req.param('id'), 'id');
  if (await hasActivity(c.get('orgId'), inv.id)) {
    throw new ApiError('conflict', 'This investor has capital calls or distributions. Delete those first.');
  }
  must(await db().from('fund_investors').delete().eq('id', inv.id).eq('org_id', c.get('orgId')));
  return c.json({ deleted: true });
});

router.post('/commitments', requireRole('editor'), async (c) => {
  const body = await readJson(c);
  const fund = await getOrgRow<{ id: string }>(c, 'funds', bodyId(body.fund_id, 'Fund'), 'id');
  const inv = await getOrgRow<{ id: string }>(c, 'fund_investors', bodyId(body.investor_id, 'Investor'), 'id');
  const amount = money(body.amount, 'Commitment', { positive: true });
  if (amount === null) throw badRequest('Commitment amount is required.');
  const res = await db().from('fund_commitments').insert({
    org_id: c.get('orgId'), fund_id: fund.id, investor_id: inv.id, amount, commitment_date: dateStr(body.commitment_date),
  }).select('id, fund_id, investor_id, amount, commitment_date').single();
  if (res.error?.code === '23505') throw new ApiError('conflict', 'This investor already has a commitment to this fund. Edit it instead.');
  return c.json(toNumbers([must(res)])[0], 201);
});

router.patch('/commitments/:id', requireRole('editor'), async (c) => {
  const row = await getOrgRow<{ id: string }>(c, 'fund_commitments', c.req.param('id'), 'id');
  const body = await readJson(c);
  const update: Record<string, unknown> = {};
  if ('amount' in body) {
    const amount = money(body.amount, 'Commitment', { positive: true });
    if (amount === null) throw badRequest('Commitment amount is required.');
    update.amount = amount;
  }
  if ('commitment_date' in body) update.commitment_date = dateStr(body.commitment_date);
  const out = must(await db().from('fund_commitments').update(update).eq('id', row.id).eq('org_id', c.get('orgId'))
    .select('id, fund_id, investor_id, amount, commitment_date').single());
  return c.json(toNumbers([out])[0]);
});

router.delete('/commitments/:id', requireRole('editor'), async (c) => {
  const row = await getOrgRow<{ id: string; fund_id: string; investor_id: string }>(c, 'fund_commitments', c.req.param('id'), 'id, fund_id, investor_id');
  if (await hasActivity(c.get('orgId'), row.investor_id, row.fund_id)) {
    throw new ApiError('conflict', 'This investor has capital calls or distributions in this fund. Delete those first.');
  }
  must(await db().from('fund_commitments').delete().eq('id', row.id).eq('org_id', c.get('orgId')));
  return c.json({ deleted: true });
});

// ---- NAV -------------------------------------------------------------------------------------

router.get('/valuations', async (c) => {
  const fundId = str(c.req.query('fund_id'));
  let q = db().from('fund_valuations').select(`${VALUATION_COLUMNS}, funds(name)`).eq('org_id', c.get('orgId'))
    .order('as_of_date', { ascending: false });
  if (fundId) q = q.eq('fund_id', fundId);
  const rows = toNumbers(must(await q) as unknown as { funds: { name: string } | null }[]);
  return c.json(rows.map(({ funds, ...v }) => ({ ...v, fund_name: funds?.name ?? '—' })));
});

router.post('/valuations', requireRole('editor'), async (c) => {
  const body = await readJson(c);
  const fund = await getOrgRow<{ id: string }>(c, 'funds', bodyId(body.fund_id, 'Fund'), 'id');
  const asOf = dateStr(body.as_of_date);
  if (!asOf) throw badRequest('As-of date is required.');
  const nav = money(body.nav, 'NAV');
  if (nav === null) throw badRequest('NAV is required.');
  // One NAV per fund and date: recording the same date again replaces it.
  const row = must(await db().from('fund_valuations').upsert({
    org_id: c.get('orgId'), fund_id: fund.id, as_of_date: asOf, nav, notes: str(body.notes)?.slice(0, 2000) ?? null,
    created_by: c.get('user').id,
  }, { onConflict: 'fund_id,as_of_date' }).select(VALUATION_COLUMNS).single());
  return c.json(toNumbers([row])[0], 201);
});

router.delete('/valuations/:id', requireRole('editor'), async (c) => {
  const row = await getOrgRow<{ id: string }>(c, 'fund_valuations', c.req.param('id'), 'id');
  must(await db().from('fund_valuations').delete().eq('id', row.id).eq('org_id', c.get('orgId')));
  return c.json({ deleted: true });
});

export default router;
