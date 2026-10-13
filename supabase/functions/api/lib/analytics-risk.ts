// Portfolio risk analysis: renewal status, non-renewal detection and the 0–100 lease risk score.
//
// RISK SCORE (0–100, capped). Points are added per reason; each reason is stored in leases.risk_reasons as
// { code, points, params } so the UI can translate it. Scoring:
//   expired ............................ 35   lease end date has passed (holdover or vacancy)
//   expiring_soon ...................... 30 / 20 / 10   ends within 6 / 12 / 24 months
//   non_renewal_notice ................. 25   a notice attachment (or opportunity) indicates non-renewal / termination
//   notice_passed ...................... 20   renewal notice date passed and the lease was not renewed
//   notice_near ........................ 15   renewal notice date within the next 6 months
//   no_renewal_option .................. 10   no renewal option recorded (only for leases ending within 24 months)
//   termination_option ................. 10   a termination option exists
//   unsigned_documents ................. 15 / 8   a document is unsigned / partially signed
//   high_risk_opportunities ............ 8 each, max 24   open (action/watch) high-priority risk opportunities
//   below_market ....................... 10 / 5   in-place rent ≥ 15% / ≥ 5% below the market rate per RSF
//   tenant_concentration ............... 10   the tenant pays ≥ 25% of the portfolio's annual base rent (≥ 3 tenants)
//   missing_data ....................... 5 per field, max 20   tenant, expiration, base rent, rentable area missing
import { db } from './supabase.ts';
import {
  addMonths, currentMonthlyRent, effectiveStatus, normalizeName, termValue, today, type AnalyticsLease,
} from './analytics-core.ts';
import { noticeByDate } from './lease-terms.ts';
import type { TermValue } from './lease-terms.ts';

export interface RiskReason {
  code: string;
  points: number;
  params?: Record<string, string | number>;
}

export interface NoticeHit {
  lease_id: string;
  source: 'attachment' | 'opportunity';
  title: string | null;
  date: string | null;
}

export interface MarketRate {
  id: string;
  property_type: string;
  rate_psf_annual: number;
  address_match: string | null;
  as_of: string | null;
}

export interface PortfolioContext {
  notices: Map<string, NoticeHit>;
  signatures: Map<string, 'unsigned' | 'partially_signed'>;
  highRiskOpps: Map<string, number>;
  marketRates: MarketRate[];
}

const NON_RENEWAL_RE =
  /non[\s-]?renew|not\s+(to\s+)?renew|will\s+not\s+(be\s+)?(renew|extend|exercis)|declin\w*\s+(to\s+)?(renew|extend)|terminat|vacat|surrender|no\s+intention\s+to\s+(renew|extend)|nicht\s+verl[äa]ngern|k[üu]ndig|no\s+renovar|rescisi|disdett/i;

/** Does an attachment's AI review / notes indicate a non-renewal or termination notice? */
export function indicatesNonRenewal(review: unknown, notes?: string | null, fileName?: string | null): boolean {
  const text = [JSON.stringify(review ?? ''), notes ?? '', fileName ?? ''].join(' ');
  return NON_RENEWAL_RE.test(text);
}

export function noticeBy(lease: AnalyticsLease): string | null {
  return noticeByDate(lease.current_terms as unknown as Record<string, TermValue>);
}

export function hasRenewalOption(lease: AnalyticsLease): boolean {
  const v = termValue(lease, 'renewal_options');
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && !/^(none|no|n\/a|no (renewal )?options?\.?|tenant has no option to renew\.?)$/.test(s);
}

export function hasTerminationOption(lease: AnalyticsLease): boolean {
  const v = termValue(lease, 'termination_options');
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && !/^(none|no|n\/a|no early termination( right)?\.?)$/.test(s);
}

/** Load everything the risk and renewal analyses need beyond the leases themselves. */
export async function loadPortfolioContext(orgId: string): Promise<PortfolioContext> {
  const [attRes, oppRes, docRes, rateRes] = await Promise.all([
    db().from('attachments').select('lease_id, file_name, category, doc_date, notes, ai_review, created_at').eq('org_id', orgId).eq('category', 'notice'),
    db().from('opportunities').select('lease_id, category, kind, status, priority, summary, due_date').eq('org_id', orgId).eq('kind', 'risk'),
    db().from('documents').select('lease_id, signature').eq('org_id', orgId).not('lease_id', 'is', null),
    db().from('market_rates').select('id, property_type, rate_psf_annual, address_match, as_of').eq('org_id', orgId),
  ]);
  for (const r of [attRes, oppRes, docRes, rateRes]) if (r.error) throw new Error(r.error.message);

  const notices = new Map<string, NoticeHit>();
  for (const a of attRes.data ?? []) {
    if (!indicatesNonRenewal(a.ai_review, a.notes as string | null, a.file_name as string | null)) continue;
    const review = (a.ai_review ?? {}) as { key_date?: string };
    notices.set(a.lease_id as string, {
      lease_id: a.lease_id as string,
      source: 'attachment',
      title: a.file_name as string,
      date: (a.doc_date as string | null) ?? review.key_date ?? (a.created_at as string).slice(0, 10),
    });
  }
  const highRiskOpps = new Map<string, number>();
  for (const o of oppRes.data ?? []) {
    const open = o.status === 'action' || o.status === 'watch';
    if (open && o.priority === 'high') highRiskOpps.set(o.lease_id as string, (highRiskOpps.get(o.lease_id as string) ?? 0) + 1);
    // A renewal-deadline finding that says the tenant gave notice of non-renewal counts as a notice too.
    if (open && !notices.has(o.lease_id as string) && o.category === 'renewal_notice_deadline' && /non[\s-]?renew|not\s+renew|vacat/i.test(String(o.summary ?? ''))) {
      notices.set(o.lease_id as string, { lease_id: o.lease_id as string, source: 'opportunity', title: o.summary as string, date: o.due_date as string | null });
    }
  }
  const signatures = new Map<string, 'unsigned' | 'partially_signed'>();
  for (const d of docRes.data ?? []) {
    const status = (d.signature as { status?: string } | null)?.status;
    const leaseId = d.lease_id as string;
    if (status === 'unsigned') signatures.set(leaseId, 'unsigned');
    else if (status === 'partially_signed' && signatures.get(leaseId) !== 'unsigned') signatures.set(leaseId, 'partially_signed');
  }
  const marketRates = (rateRes.data ?? []).map((r) => ({ ...r, rate_psf_annual: Number(r.rate_psf_annual) })) as MarketRate[];
  return { notices, signatures, highRiskOpps, marketRates };
}

/** Market rate ($/RSF/yr) for a lease: override, assigned rate, address match, then property type. */
export function marketRateFor(lease: AnalyticsLease, rates: MarketRate[]): number | null {
  if (lease.market_rate_override !== null && lease.market_rate_override > 0) return lease.market_rate_override;
  if (lease.market_rate_id) {
    const r = rates.find((x) => x.id === lease.market_rate_id);
    if (r) return r.rate_psf_annual;
  }
  const type = (lease.property_type ?? '').toLowerCase();
  const address = (lease.premises_address ?? '').toLowerCase();
  const sameType = rates.filter((r) => r.property_type.toLowerCase() === type);
  const byAddress = sameType.find((r) => r.address_match && address.includes(r.address_match.toLowerCase()));
  if (byAddress) return byAddress.rate_psf_annual;
  const generic = sameType.filter((r) => !r.address_match).sort((a, b) => ((a.as_of ?? '') < (b.as_of ?? '') ? 1 : -1));
  return generic[0]?.rate_psf_annual ?? null;
}

export type RenewalStatus = 'renewed' | 'notice_received' | 'option_available' | 'notice_passed' | 'no_option' | 'expired';

export function renewalStatus(lease: AnalyticsLease, ctx: PortfolioContext, now = today()): RenewalStatus {
  const status = effectiveStatus(lease, now);
  if (status === 'expired') return 'expired';
  if (status === 'renewed') return 'renewed';
  if (ctx.notices.has(lease.id)) return 'notice_received';
  if (!hasRenewalOption(lease)) return 'no_option';
  const nb = noticeBy(lease);
  if (nb && nb < now) return 'notice_passed';
  return 'option_available';
}

export function scoreLease(
  lease: AnalyticsLease,
  ctx: PortfolioContext,
  portfolio: { annualRentByTenant: Map<string, number>; totalAnnualRent: number; tenantCount: number },
  now = today(),
): { score: number; reasons: RiskReason[] } {
  const reasons: RiskReason[] = [];
  const add = (code: string, points: number, params?: Record<string, string | number>) => reasons.push({ code, points, ...(params ? { params } : {}) });
  const status = effectiveStatus(lease, now);
  const exp = lease.expiration_date;

  if (status === 'expired') add('expired', 35, { date: exp! });
  else if (exp) {
    if (exp <= addMonths(now, 6)) add('expiring_soon', 30, { date: exp, months: 6 });
    else if (exp <= addMonths(now, 12)) add('expiring_soon', 20, { date: exp, months: 12 });
    else if (exp <= addMonths(now, 24)) add('expiring_soon', 10, { date: exp, months: 24 });
  }

  if (status !== 'expired') {
    const notice = ctx.notices.get(lease.id);
    if (notice) add('non_renewal_notice', 25, { date: notice.date ?? '' });
    const nb = noticeBy(lease);
    if (status !== 'renewed' && hasRenewalOption(lease) && nb && !notice) {
      if (nb < now) add('notice_passed', 20, { date: nb });
      else if (nb <= addMonths(now, 6)) add('notice_near', 15, { date: nb });
    }
    if (!hasRenewalOption(lease) && exp && exp <= addMonths(now, 24) && status !== 'renewed') add('no_renewal_option', 10);
    if (hasTerminationOption(lease)) add('termination_option', 10);
  }

  const sig = ctx.signatures.get(lease.id);
  if (sig === 'unsigned') add('unsigned_documents', 15);
  else if (sig === 'partially_signed') add('partially_signed_documents', 8);

  const opps = ctx.highRiskOpps.get(lease.id) ?? 0;
  if (opps > 0) add('high_risk_opportunities', Math.min(24, opps * 8), { count: opps });

  const monthly = currentMonthlyRent(lease, now);
  const market = marketRateFor(lease, ctx.marketRates);
  if (status !== 'expired' && monthly && lease.rentable_area && market) {
    const psf = (monthly * 12) / lease.rentable_area;
    const gap = (market - psf) / market;
    if (gap >= 0.15) add('below_market', 10, { pct: Math.round(gap * 100) });
    else if (gap >= 0.05) add('below_market', 5, { pct: Math.round(gap * 100) });
  }

  if (status !== 'expired' && portfolio.tenantCount >= 3 && portfolio.totalAnnualRent > 0) {
    const share = (portfolio.annualRentByTenant.get(normalizeName(lease.tenant_name)) ?? 0) / portfolio.totalAnnualRent;
    if (share >= 0.25) add('tenant_concentration', 10, { pct: Math.round(share * 100) });
  }

  const missing: string[] = [];
  if (!lease.tenant_name) missing.push('tenant');
  if (!exp) missing.push('expiration_date');
  if (lease.base_rent_monthly === null && !lease.schedule.length) missing.push('base_rent');
  if (!lease.rentable_area) missing.push('rentable_area');
  if (missing.length) add('missing_data', Math.min(20, missing.length * 5), { fields: missing.join(',') });

  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0));
  reasons.sort((a, b) => b.points - a.points);
  return { score, reasons };
}
