// Fund administration: loads an organization's fund data and derives capital accounts and fund metrics from it.
// Nothing here is stored: commitments, call/distribution allocations and NAVs are the source of truth.
//   called      = sum of capital-call allocations        paid_in     = sum of paid amounts
//   uncalled    = commitment − called                     receivable  = called − paid_in
//   NAV share   = latest NAV × investor's share of paid-in capital (commitment share before any payment)
//   DPI = distributed / paid_in   RVPI = NAV / paid_in   TVPI = DPI + RVPI
import { db, must } from './supabase.ts';
import { badRequest, num, str } from './http.ts';

export const FUND_STATUSES = ['fundraising', 'active', 'harvesting', 'closed'] as const;
export const INVESTOR_TYPES = ['institution', 'pension', 'endowment', 'family_office', 'individual', 'fund_of_funds', 'gp', 'other'] as const;
export const CALL_PURPOSES = ['investment', 'management_fee', 'expenses', 'other'] as const;
export const DISTRIBUTION_TYPES = ['income', 'return_of_capital', 'capital_gain', 'other'] as const;

export interface Fund {
  id: string; name: string; strategy: string | null; vintage_year: number | null; inception_date: string | null;
  target_size: number | null; status: string; management_fee_pct: number | null; carry_pct: number | null;
  hurdle_pct: number | null; notes: string | null; created_at: string; updated_at: string;
}
export interface Investor {
  id: string; name: string; investor_type: string; contact_name: string | null; email: string | null;
  phone: string | null; notes: string | null; created_at: string;
}
export interface Commitment { id: string; fund_id: string; investor_id: string; amount: number; commitment_date: string | null }
export interface CapitalCall {
  id: string; fund_id: string; call_number: number; call_date: string; due_date: string | null; amount: number;
  purpose: string; notes: string | null; created_at: string;
}
export interface CallAllocation { id: string; call_id: string; investor_id: string; amount: number; paid_amount: number; paid_date: string | null }
export interface Distribution {
  id: string; fund_id: string; distribution_number: number; distribution_date: string; amount: number;
  distribution_type: string; notes: string | null; created_at: string;
}
export interface DistributionAllocation { id: string; distribution_id: string; investor_id: string; amount: number }
export interface Valuation { id: string; fund_id: string; as_of_date: string; nav: number; notes: string | null; created_at: string }
export interface FundLease { id: string; fund_id: string; lease_id: string }

export interface FundData {
  funds: Fund[]; investors: Investor[]; commitments: Commitment[]; calls: CapitalCall[]; callAllocations: CallAllocation[];
  distributions: Distribution[]; distributionAllocations: DistributionAllocation[]; valuations: Valuation[]; fundLeases: FundLease[];
}

export const FUND_COLUMNS = 'id, name, strategy, vintage_year, inception_date, target_size, status, management_fee_pct, carry_pct, hurdle_pct, notes, created_at, updated_at';
export const INVESTOR_COLUMNS = 'id, name, investor_type, contact_name, email, phone, notes, created_at';
export const CALL_COLUMNS = 'id, fund_id, call_number, call_date, due_date, amount, purpose, notes, created_at';
export const DISTRIBUTION_COLUMNS = 'id, fund_id, distribution_number, distribution_date, amount, distribution_type, notes, created_at';
export const VALUATION_COLUMNS = 'id, fund_id, as_of_date, nav, notes, created_at';

const NUMERIC: Record<string, true> = {
  amount: true, paid_amount: true, nav: true, target_size: true, management_fee_pct: true, carry_pct: true, hurdle_pct: true,
};

/** numeric columns can arrive as strings; make them numbers (null stays null). */
export function toNumbers<T>(rows: T[] | null): T[] {
  return (rows ?? []).map((row) => {
    const out = { ...row } as Record<string, unknown>;
    for (const key of Object.keys(out)) if (NUMERIC[key] && out[key] !== null) out[key] = Number(out[key]);
    return out as T;
  });
}

/** Everything the fund area needs for one organization, in parallel. */
export async function loadFundData(orgId: string): Promise<FundData> {
  const q = (table: string, columns: string) => db().from(table).select(columns).eq('org_id', orgId);
  const [funds, investors, commitments, calls, callAllocations, distributions, distributionAllocations, valuations, fundLeases] = await Promise.all([
    q('funds', FUND_COLUMNS).order('name'),
    q('fund_investors', INVESTOR_COLUMNS).order('name'),
    q('fund_commitments', 'id, fund_id, investor_id, amount, commitment_date'),
    q('fund_capital_calls', CALL_COLUMNS).order('call_date', { ascending: false }),
    q('fund_call_allocations', 'id, call_id, investor_id, amount, paid_amount, paid_date'),
    q('fund_distributions', DISTRIBUTION_COLUMNS).order('distribution_date', { ascending: false }),
    q('fund_distribution_allocations', 'id, distribution_id, investor_id, amount'),
    q('fund_valuations', VALUATION_COLUMNS).order('as_of_date', { ascending: false }),
    q('fund_leases', 'id, fund_id, lease_id'),
  ]);
  return {
    funds: toNumbers(must(funds) as unknown as Fund[]),
    investors: must(investors) as unknown as Investor[],
    commitments: toNumbers(must(commitments) as unknown as Commitment[]),
    calls: toNumbers(must(calls) as unknown as CapitalCall[]),
    callAllocations: toNumbers(must(callAllocations) as unknown as CallAllocation[]),
    distributions: toNumbers(must(distributions) as unknown as Distribution[]),
    distributionAllocations: toNumbers(must(distributionAllocations) as unknown as DistributionAllocation[]),
    valuations: toNumbers(must(valuations) as unknown as Valuation[]),
    fundLeases: must(fundLeases) as unknown as FundLease[],
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) / 100 : null);

/**
 * Split `total` across weights, to the cent, so the parts add up exactly (largest remainder).
 * Weights of 0 get nothing; returns [] when every weight is 0.
 */
export function allocateProRata(total: number, weights: { id: string; weight: number }[]): { id: string; amount: number }[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w.weight), 0);
  if (sum <= 0) return [];
  const cents = Math.round(total * 100);
  const parts = weights.map((w) => {
    const exact = (cents * Math.max(0, w.weight)) / sum;
    return { id: w.id, cents: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = cents - parts.reduce((s, p) => s + p.cents, 0);
  for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    p.cents += 1;
    left -= 1;
  }
  return parts.filter((p) => p.cents > 0).map((p) => ({ id: p.id, amount: p.cents / 100 }));
}

export type CallStatus = 'paid' | 'partial' | 'open' | 'overdue';

export function callStatus(call: CapitalCall, allocations: CallAllocation[], today: string): { status: CallStatus; paid: number } {
  const own = allocations.filter((a) => a.call_id === call.id);
  const paid = round2(own.reduce((s, a) => s + a.paid_amount, 0));
  if (paid >= call.amount - 0.005) return { status: 'paid', paid };
  if (call.due_date && call.due_date < today) return { status: 'overdue', paid };
  return { status: paid > 0 ? 'partial' : 'open', paid };
}

export interface CapitalAccount {
  investor_id: string; investor_name: string; investor_type: string; commitment: number; ownership_pct: number;
  called: number; paid_in: number; receivable: number; uncalled: number; distributed: number; nav_share: number | null;
}

export interface FundMetrics {
  commitments: number; called: number; paid_in: number; receivable: number; uncalled: number; distributed: number;
  nav: number | null; nav_date: string | null; dpi: number | null; rvpi: number | null; tvpi: number | null;
  investors: number; properties: number; called_pct: number | null;
}

/** Capital account of every investor with a commitment to (or activity in) the fund. */
export function capitalAccounts(data: FundData, fundId: string): CapitalAccount[] {
  const callIds = new Set(data.calls.filter((c) => c.fund_id === fundId).map((c) => c.id));
  const distIds = new Set(data.distributions.filter((d) => d.fund_id === fundId).map((d) => d.id));
  const byInvestor = new Map<string, { commitment: number; called: number; paid_in: number; distributed: number }>();
  const entry = (id: string) => {
    let e = byInvestor.get(id);
    if (!e) byInvestor.set(id, (e = { commitment: 0, called: 0, paid_in: 0, distributed: 0 }));
    return e;
  };
  for (const c of data.commitments) if (c.fund_id === fundId) entry(c.investor_id).commitment += c.amount;
  for (const a of data.callAllocations) {
    if (!callIds.has(a.call_id)) continue;
    entry(a.investor_id).called += a.amount;
    entry(a.investor_id).paid_in += a.paid_amount;
  }
  for (const a of data.distributionAllocations) if (distIds.has(a.distribution_id)) entry(a.investor_id).distributed += a.amount;

  const nav = latestValuation(data, fundId)?.nav ?? null;
  const totalCommitment = [...byInvestor.values()].reduce((s, e) => s + e.commitment, 0);
  const totalPaid = [...byInvestor.values()].reduce((s, e) => s + e.paid_in, 0);
  const names = new Map(data.investors.map((i) => [i.id, i]));

  return [...byInvestor.entries()]
    .map(([id, e]) => {
      const share = totalPaid > 0 ? e.paid_in / totalPaid : totalCommitment > 0 ? e.commitment / totalCommitment : 0;
      return {
        investor_id: id,
        investor_name: names.get(id)?.name ?? '—',
        investor_type: names.get(id)?.investor_type ?? 'other',
        commitment: round2(e.commitment),
        ownership_pct: totalCommitment > 0 ? Math.round((e.commitment / totalCommitment) * 10000) / 100 : 0,
        called: round2(e.called),
        paid_in: round2(e.paid_in),
        receivable: round2(e.called - e.paid_in),
        uncalled: round2(Math.max(0, e.commitment - e.called)),
        distributed: round2(e.distributed),
        nav_share: nav === null ? null : round2(nav * share),
      };
    })
    .sort((a, b) => b.commitment - a.commitment || a.investor_name.localeCompare(b.investor_name));
}

export function latestValuation(data: FundData, fundId: string): Valuation | null {
  return data.valuations
    .filter((v) => v.fund_id === fundId)
    .reduce<Valuation | null>((best, v) => (!best || v.as_of_date > best.as_of_date ? v : best), null);
}

export function fundMetrics(data: FundData, fundId: string): FundMetrics {
  const accounts = capitalAccounts(data, fundId);
  const sum = (key: 'commitment' | 'called' | 'paid_in' | 'distributed' | 'uncalled') => round2(accounts.reduce((s, a) => s + a[key], 0));
  const commitments = sum('commitment');
  const called = sum('called');
  const paid_in = sum('paid_in');
  const distributed = sum('distributed');
  const valuation = latestValuation(data, fundId);
  const nav = valuation?.nav ?? null;
  const dpi = ratio(distributed, paid_in);
  const rvpi = nav === null ? null : ratio(nav, paid_in);
  return {
    commitments, called, paid_in, distributed, nav,
    receivable: round2(called - paid_in),
    uncalled: sum('uncalled'),
    nav_date: valuation?.as_of_date ?? null,
    dpi, rvpi,
    tvpi: dpi === null ? null : round2(dpi + (rvpi ?? 0)),
    investors: data.commitments.filter((c) => c.fund_id === fundId).length,
    properties: data.fundLeases.filter((l) => l.fund_id === fundId).length,
    called_pct: commitments > 0 ? Math.round((called / commitments) * 1000) / 10 : null,
  };
}

/** Commitment amounts of a fund, the weights for pro-rata calls and distributions. */
export function commitmentWeights(data: FundData, fundId: string): { id: string; weight: number }[] {
  return data.commitments.filter((c) => c.fund_id === fundId).map((c) => ({ id: c.investor_id, weight: c.amount }));
}

// ---- Request validation (shared by routes/fund.ts and routes/fund-transactions.ts) ---------------

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T | null {
  const v = str(value);
  if (v === null) return null;
  if (!(allowed as readonly string[]).includes(v)) throw badRequest(`Unknown ${what} "${v}"`);
  return v as T;
}

/** A required id from a request body (uuid), so a missing one is a 400, not a database error. */
export function bodyId(value: unknown, what: string): string {
  const id = str(value);
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw badRequest(`${what} is required.`);
  return id;
}

export function money(value: unknown, what: string, { positive = false } = {}): number | null {
  const n = num(value);
  if (n === null) return null;
  if (n < 0 || (positive && n === 0)) throw badRequest(`${what} must be ${positive ? 'greater than 0' : '0 or more'}.`);
  return Math.round(n * 100) / 100;
}
