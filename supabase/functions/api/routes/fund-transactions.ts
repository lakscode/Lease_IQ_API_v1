// /api/fund — capital calls and distributions (mounted by routes/fund.ts, after its withOrg). Each one is split across the fund's investors pro rata to their
// commitments when it is created (allocations, to the cent); payments are then recorded per investor.
//   GET    /capital-calls?fund_id&status         calls with fund name, paid amount and status (paid/partial/open/overdue)
//   POST   /capital-calls { fund_id, call_date, due_date, amount, purpose, notes }
//   GET    /capital-calls/:id                    call with allocations      DELETE /capital-calls/:id
//   PATCH  /capital-calls/:id/allocations/:allocId { paid_amount, paid_date }
//   POST   /capital-calls/:id/mark-paid { paid_date }   every allocation paid in full
//   GET    /distributions?fund_id                POST /distributions { fund_id, distribution_date, amount, distribution_type, notes }
//   GET    /distributions/:id                    distribution with allocations      DELETE /distributions/:id
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { getOrgRow, requireRole } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, dateStr, num, readJson, str } from '../lib/http.ts';
import {
  CALL_COLUMNS, CALL_PURPOSES, DISTRIBUTION_COLUMNS, DISTRIBUTION_TYPES,
  allocateProRata, bodyId, callStatus, commitmentWeights, loadFundData, money, oneOf, toNumbers,
  type CallAllocation, type CapitalCall, type Distribution,
} from '../lib/fund-accounts.ts';

const router = new Hono<AppEnv>();

const today = () => new Date().toISOString().slice(0, 10);

async function nextNumber(table: 'fund_capital_calls' | 'fund_distributions', column: string, orgId: string, fundId: string) {
  const rows = must(await db().from(table).select(column).eq('org_id', orgId).eq('fund_id', fundId)
    .order(column, { ascending: false }).limit(1)) as unknown as Record<string, number>[];
  return (rows?.[0]?.[column] ?? 0) + 1;
}

async function investorNames(orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = must(await db().from('fund_investors').select('id, name').eq('org_id', orgId).in('id', ids)) ?? [];
  return new Map((rows as { id: string; name: string }[]).map((r) => [r.id, r.name]));
}

// ---- Capital calls ---------------------------------------------------------------------------

router.get('/capital-calls', async (c) => {
  const fundId = str(c.req.query('fund_id'));
  const status = str(c.req.query('status'));
  const data = await loadFundData(c.get('orgId'));
  const names = new Map(data.funds.map((f) => [f.id, f.name]));
  const now = today();
  const rows = data.calls
    .filter((call) => !fundId || call.fund_id === fundId)
    .map((call) => ({
      ...call, fund_name: names.get(call.fund_id) ?? '—',
      investors: data.callAllocations.filter((a) => a.call_id === call.id).length,
      ...callStatus(call, data.callAllocations, now),
    }))
    .filter((call) => !status || (status === 'unpaid' ? call.status !== 'paid' : call.status === status));
  return c.json(rows);
});

router.post('/capital-calls', requireRole('editor'), async (c) => {
  const body = await readJson(c);
  const orgId = c.get('orgId');
  const fund = await getOrgRow<{ id: string }>(c, 'funds', bodyId(body.fund_id, 'Fund'), 'id');
  const callDate = dateStr(body.call_date);
  if (!callDate) throw badRequest('Call date is required.');
  const dueDate = dateStr(body.due_date);
  if (dueDate && dueDate < callDate) throw badRequest('The due date can’t be before the call date.');
  const amount = money(body.amount, 'Call amount', { positive: true });
  if (amount === null) throw badRequest('Call amount is required.');

  const data = await loadFundData(orgId);
  const split = allocateProRata(amount, commitmentWeights(data, fund.id));
  if (!split.length) throw badRequest('Add investor commitments to this fund before calling capital.');

  const call = must(await db().from('fund_capital_calls').insert({
    org_id: orgId, fund_id: fund.id, call_number: await nextNumber('fund_capital_calls', 'call_number', orgId, fund.id),
    call_date: callDate, due_date: dueDate, amount,
    purpose: oneOf(body.purpose, CALL_PURPOSES, 'purpose') ?? 'investment',
    notes: str(body.notes)?.slice(0, 2000) ?? null, created_by: c.get('user').id,
  }).select(CALL_COLUMNS).single()) as unknown as CapitalCall;

  const inserted = await db().from('fund_call_allocations')
    .insert(split.map((s) => ({ org_id: orgId, call_id: call.id, investor_id: s.id, amount: s.amount })));
  if (inserted.error) {
    await db().from('fund_capital_calls').delete().eq('id', call.id).eq('org_id', orgId);
    throw new Error(inserted.error.message);
  }
  return c.json(toNumbers([call])[0], 201);
});

router.get('/capital-calls/:id', async (c) => {
  const orgId = c.get('orgId');
  const call = toNumbers([await getOrgRow<CapitalCall>(c, 'fund_capital_calls', c.req.param('id'), CALL_COLUMNS)])[0];
  const [fund, allocRes] = await Promise.all([
    getOrgRow<{ name: string }>(c, 'funds', call.fund_id, 'name'),
    db().from('fund_call_allocations').select('id, call_id, investor_id, amount, paid_amount, paid_date').eq('org_id', orgId).eq('call_id', call.id),
  ]);
  const allocations = toNumbers(must(allocRes) as unknown as CallAllocation[]);
  const names = await investorNames(orgId, allocations.map((a) => a.investor_id));
  return c.json({
    ...call, fund_name: fund.name, ...callStatus(call, allocations, today()),
    allocations: allocations
      .map((a) => ({ ...a, investor_name: names.get(a.investor_id) ?? '—', outstanding: Math.round((a.amount - a.paid_amount) * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount),
  });
});

router.patch('/capital-calls/:id/allocations/:allocId', requireRole('editor'), async (c) => {
  const orgId = c.get('orgId');
  const call = await getOrgRow<{ id: string }>(c, 'fund_capital_calls', c.req.param('id'), 'id');
  const alloc = toNumbers([await getOrgRow<CallAllocation>(c, 'fund_call_allocations', c.req.param('allocId'), 'id, call_id, amount')])[0];
  if (alloc.call_id !== call.id) throw new ApiError('not_found', 'Not found');
  const body = await readJson(c);
  const paid = num(body.paid_amount);
  if (paid === null || paid < 0) throw badRequest('Paid amount must be 0 or more.');
  if (paid > alloc.amount + 0.005) throw badRequest('Paid amount can’t be more than the amount called.');
  const paidAmount = Math.round(paid * 100) / 100;
  const out = must(await db().from('fund_call_allocations').update({
    paid_amount: paidAmount,
    paid_date: paidAmount > 0 ? dateStr(body.paid_date) ?? today() : null,
  }).eq('id', alloc.id).eq('org_id', orgId).select('id, call_id, investor_id, amount, paid_amount, paid_date').single());
  return c.json(toNumbers([out])[0]);
});

router.post('/capital-calls/:id/mark-paid', requireRole('editor'), async (c) => {
  const orgId = c.get('orgId');
  const call = await getOrgRow<{ id: string }>(c, 'fund_capital_calls', c.req.param('id'), 'id');
  const body = await readJson(c);
  const paidDate = dateStr(body.paid_date) ?? today();
  const allocations = toNumbers(must(await db().from('fund_call_allocations').select('id, amount, paid_amount')
    .eq('org_id', orgId).eq('call_id', call.id)) as unknown as CallAllocation[]);
  const unpaid = allocations.filter((a) => a.paid_amount < a.amount);
  await Promise.all(unpaid.map(async (a) => {
    must(await db().from('fund_call_allocations').update({ paid_amount: a.amount, paid_date: paidDate }).eq('id', a.id).eq('org_id', orgId));
  }));
  return c.json({ updated: unpaid.length });
});

router.delete('/capital-calls/:id', requireRole('editor'), async (c) => {
  const call = await getOrgRow<{ id: string }>(c, 'fund_capital_calls', c.req.param('id'), 'id');
  must(await db().from('fund_capital_calls').delete().eq('id', call.id).eq('org_id', c.get('orgId')));
  return c.json({ deleted: true });
});

// ---- Distributions ---------------------------------------------------------------------------

router.get('/distributions', async (c) => {
  const fundId = str(c.req.query('fund_id'));
  const data = await loadFundData(c.get('orgId'));
  const names = new Map(data.funds.map((f) => [f.id, f.name]));
  return c.json(data.distributions
    .filter((d) => !fundId || d.fund_id === fundId)
    .map((d) => ({
      ...d, fund_name: names.get(d.fund_id) ?? '—',
      investors: data.distributionAllocations.filter((a) => a.distribution_id === d.id).length,
    })));
});

router.post('/distributions', requireRole('editor'), async (c) => {
  const body = await readJson(c);
  const orgId = c.get('orgId');
  const fund = await getOrgRow<{ id: string }>(c, 'funds', bodyId(body.fund_id, 'Fund'), 'id');
  const date = dateStr(body.distribution_date);
  if (!date) throw badRequest('Distribution date is required.');
  const amount = money(body.amount, 'Distribution amount', { positive: true });
  if (amount === null) throw badRequest('Distribution amount is required.');

  const data = await loadFundData(orgId);
  const split = allocateProRata(amount, commitmentWeights(data, fund.id));
  if (!split.length) throw badRequest('Add investor commitments to this fund before distributing.');

  const dist = must(await db().from('fund_distributions').insert({
    org_id: orgId, fund_id: fund.id,
    distribution_number: await nextNumber('fund_distributions', 'distribution_number', orgId, fund.id),
    distribution_date: date, amount,
    distribution_type: oneOf(body.distribution_type, DISTRIBUTION_TYPES, 'distribution type') ?? 'income',
    notes: str(body.notes)?.slice(0, 2000) ?? null, created_by: c.get('user').id,
  }).select(DISTRIBUTION_COLUMNS).single()) as unknown as Distribution;

  const inserted = await db().from('fund_distribution_allocations')
    .insert(split.map((s) => ({ org_id: orgId, distribution_id: dist.id, investor_id: s.id, amount: s.amount })));
  if (inserted.error) {
    await db().from('fund_distributions').delete().eq('id', dist.id).eq('org_id', orgId);
    throw new Error(inserted.error.message);
  }
  return c.json(toNumbers([dist])[0], 201);
});

router.get('/distributions/:id', async (c) => {
  const orgId = c.get('orgId');
  const dist = toNumbers([await getOrgRow<Distribution>(c, 'fund_distributions', c.req.param('id'), DISTRIBUTION_COLUMNS)])[0];
  const [fund, allocRes] = await Promise.all([
    getOrgRow<{ name: string }>(c, 'funds', dist.fund_id, 'name'),
    db().from('fund_distribution_allocations').select('id, distribution_id, investor_id, amount').eq('org_id', orgId).eq('distribution_id', dist.id),
  ]);
  const allocations = toNumbers(must(allocRes) as unknown as { id: string; investor_id: string; amount: number }[]);
  const names = await investorNames(orgId, allocations.map((a) => a.investor_id));
  return c.json({
    ...dist, fund_name: fund.name,
    allocations: allocations.map((a) => ({ ...a, investor_name: names.get(a.investor_id) ?? '—' })).sort((a, b) => b.amount - a.amount),
  });
});

router.delete('/distributions/:id', requireRole('editor'), async (c) => {
  const dist = await getOrgRow<{ id: string }>(c, 'fund_distributions', c.req.param('id'), 'id');
  must(await db().from('fund_distributions').delete().eq('id', dist.id).eq('org_id', c.get('orgId')));
  return c.json({ deleted: true });
});

export default router;
