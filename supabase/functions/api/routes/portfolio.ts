// /api/portfolio — rent and risk analytics for the active org.
//   GET /                → KPIs, rent expiring by year, tenant concentration, data coverage, rent roll,
//                          non-renewals and risk scores (scores are stored on leases.risk_score / risk_reasons)
//   GET /expiring?months → leases ending within the period with renewal status and notice-by date
//   GET /rent-roll.csv   → the rent roll as CSV
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { withOrg } from '../lib/auth.ts';
import { db } from '../lib/supabase.ts';
import { toCsv } from '../lib/http.ts';
import {
  addMonths, currentMonthlyRent, daysBetween, effectiveStatus, loadLeases, normalizeName, round2, termValue, today, yearsBetween,
  type AnalyticsLease,
} from '../lib/analytics-core.ts';
import {
  hasRenewalOption, loadPortfolioContext, marketRateFor, noticeBy, renewalStatus, scoreLease, type PortfolioContext,
} from '../lib/analytics-risk.ts';
import { log } from '../lib/log.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

interface RentRollRow {
  id: string;
  tenant_name: string | null;
  landlord_name: string | null;
  premises_address: string | null;
  property_type: string | null;
  rentable_area: number | null;
  commencement_date: string | null;
  expiration_date: string | null;
  monthly_rent: number | null;
  annual_rent: number | null;
  rent_psf: number | null;
  security_deposit: number | null;
  status: string;
  notice_by: string | null;
  risk_score: number | null;
}

function rentRollRow(l: AnalyticsLease, now: string): RentRollRow {
  const monthly = currentMonthlyRent(l, now);
  const annual = monthly !== null ? round2(monthly * 12) : null;
  const deposit = Number(termValue(l, 'security_deposit'));
  return {
    id: l.id,
    tenant_name: l.tenant_name,
    landlord_name: l.landlord_name,
    premises_address: l.premises_address,
    property_type: l.property_type,
    rentable_area: l.rentable_area,
    commencement_date: l.commencement_date,
    expiration_date: l.expiration_date,
    monthly_rent: monthly,
    annual_rent: annual,
    rent_psf: annual !== null && l.rentable_area ? round2(annual / l.rentable_area) : null,
    security_deposit: Number.isFinite(deposit) && termValue(l, 'security_deposit') !== null ? deposit : null,
    status: effectiveStatus(l, now),
    notice_by: noticeBy(l),
    risk_score: l.risk_score,
  };
}

const COVERAGE_FIELDS: { key: string; has: (l: AnalyticsLease) => boolean }[] = [
  { key: 'tenant', has: (l) => Boolean(l.tenant_name) },
  { key: 'landlord', has: (l) => Boolean(l.landlord_name) },
  { key: 'premises_address', has: (l) => Boolean(l.premises_address) },
  { key: 'rentable_area', has: (l) => Boolean(l.rentable_area) },
  { key: 'commencement_date', has: (l) => Boolean(l.commencement_date) },
  { key: 'expiration_date', has: (l) => Boolean(l.expiration_date) },
  { key: 'base_rent', has: (l) => l.base_rent_monthly !== null || l.schedule.length > 0 },
  { key: 'security_deposit', has: (l) => termValue(l, 'security_deposit') !== null },
  { key: 'renewal_options', has: (l) => termValue(l, 'renewal_options') !== null },
  { key: 'renewal_notice_months', has: (l) => termValue(l, 'renewal_notice_months') !== null },
  { key: 'property_type', has: (l) => Boolean(l.property_type) },
];

async function analyse(orgId: string) {
  const now = today();
  const [leases, ctx] = await Promise.all([loadLeases(orgId), loadPortfolioContext(orgId)]);
  const inPlace = leases.filter((l) => effectiveStatus(l, now) !== 'expired');

  // ---- KPIs (in-place = not expired) ----
  let annualRent = 0;
  let leasedArea = 0;
  let psfRent = 0;
  let psfArea = 0;
  let waltWeighted = 0;
  let waltRent = 0;
  const annualRentByTenant = new Map<string, number>();
  const tenantLabel = new Map<string, string>();
  for (const l of inPlace) {
    const annual = (currentMonthlyRent(l, now) ?? 0) * 12;
    annualRent += annual;
    leasedArea += l.rentable_area ?? 0;
    if (annual > 0 && l.rentable_area) {
      psfRent += annual;
      psfArea += l.rentable_area;
    }
    // WALT: rent-weighted average remaining years over leases with an end date.
    if (annual > 0 && l.expiration_date) {
      waltWeighted += annual * yearsBetween(now, l.expiration_date);
      waltRent += annual;
    }
    const key = normalizeName(l.tenant_name);
    if (key) {
      annualRentByTenant.set(key, (annualRentByTenant.get(key) ?? 0) + annual);
      if (!tenantLabel.has(key)) tenantLabel.set(key, l.tenant_name!);
    }
  }
  const kpis = {
    lease_count: leases.length,
    in_place_count: inPlace.length,
    annual_base_rent: round2(annualRent),
    leased_area: leasedArea,
    avg_rent_psf: psfArea > 0 ? round2(psfRent / psfArea) : null,
    walt_years: waltRent > 0 ? Math.round((waltWeighted / waltRent) * 100) / 100 : null,
    tenant_count: annualRentByTenant.size,
  };

  // ---- Rent expiring by year ----
  const byYear = new Map<string, { year: string; annual_rent: number; count: number }>();
  for (const l of inPlace) {
    if (!l.expiration_date) continue;
    const year = l.expiration_date.slice(0, 4);
    const row = byYear.get(year) ?? { year, annual_rent: 0, count: 0 };
    row.annual_rent += (currentMonthlyRent(l, now) ?? 0) * 12;
    row.count++;
    byYear.set(year, row);
  }
  const rent_expiring_by_year = [...byYear.values()]
    .sort((a, b) => (a.year < b.year ? -1 : 1))
    .map((r) => ({ ...r, annual_rent: round2(r.annual_rent) }));

  // ---- Tenant concentration (top 5 + other) ----
  const tenants = [...annualRentByTenant.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const concentration = tenants.slice(0, 5).map(([key, v]) => ({
    tenant: tenantLabel.get(key) ?? key,
    annual_rent: round2(v),
    share: annualRent > 0 ? v / annualRent : 0,
  }));
  const otherRent = tenants.slice(5).reduce((s, [, v]) => s + v, 0);
  if (otherRent > 0) concentration.push({ tenant: '__other__', annual_rent: round2(otherRent), share: otherRent / annualRent });

  // ---- Data coverage (all leases) ----
  const coverage = COVERAGE_FIELDS.map((f) => {
    const present = leases.filter(f.has).length;
    return { field: f.key, present, total: leases.length, pct: leases.length ? present / leases.length : 0 };
  });

  // ---- Risk scores (stored) ----
  const portfolio = { annualRentByTenant, totalAnnualRent: annualRent, tenantCount: annualRentByTenant.size };
  const risk = leases.map((l) => {
    const { score, reasons } = scoreLease(l, ctx, portfolio, now);
    return { lease: l, score, reasons };
  });
  const changed = risk.filter((r) => r.lease.risk_score !== r.score || JSON.stringify(r.lease.risk_reasons ?? null) !== JSON.stringify(r.reasons));
  await Promise.all(
    changed.map(async (r) => {
      const { error } = await db().from('leases').update({ risk_score: r.score, risk_reasons: r.reasons }).eq('id', r.lease.id).eq('org_id', orgId);
      if (error) log.error('portfolio.risk', `Risk score update failed: ${error.message}`);
      r.lease.risk_score = r.score;
      r.lease.risk_reasons = r.reasons;
    }),
  );

  return { now, leases, ctx, kpis, rent_expiring_by_year, concentration, coverage, risk };
}

function nonRenewals(leases: AnalyticsLease[], ctx: PortfolioContext, now: string) {
  const out: { id: string; tenant_name: string | null; premises_address: string | null; expiration_date: string | null; annual_rent: number | null; reason: string; date: string | null }[] = [];
  for (const l of leases) {
    const rs = renewalStatus(l, ctx, now);
    const monthly = currentMonthlyRent(l, now);
    const base = { id: l.id, tenant_name: l.tenant_name, premises_address: l.premises_address, expiration_date: l.expiration_date, annual_rent: monthly !== null ? round2(monthly * 12) : null };
    if (rs === 'notice_received') out.push({ ...base, reason: 'notice_received', date: ctx.notices.get(l.id)?.date ?? null });
    else if (rs === 'expired') out.push({ ...base, reason: 'expired', date: l.expiration_date });
    else if (rs === 'notice_passed') out.push({ ...base, reason: 'notice_passed', date: noticeBy(l) });
    else if (rs === 'no_option') out.push({ ...base, reason: 'no_option', date: null });
  }
  const order = ['notice_received', 'notice_passed', 'expired', 'no_option'];
  return out.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason) || ((a.expiration_date ?? '9999') < (b.expiration_date ?? '9999') ? -1 : 1));
}

router.get('/', async (c) => {
  const a = await analyse(c.get('orgId'));
  const rent_roll = a.leases.map((l) => rentRollRow(l, a.now)).sort((x, y) => (x.tenant_name ?? '').localeCompare(y.tenant_name ?? ''));
  return c.json({
    as_of: a.now,
    kpis: a.kpis,
    rent_expiring_by_year: a.rent_expiring_by_year,
    concentration: a.concentration,
    coverage: a.coverage,
    rent_roll,
    non_renewals: nonRenewals(a.leases, a.ctx, a.now),
    risk: a.risk
      .map((r) => ({
        id: r.lease.id,
        tenant_name: r.lease.tenant_name,
        premises_address: r.lease.premises_address,
        expiration_date: r.lease.expiration_date,
        status: effectiveStatus(r.lease, a.now),
        market_rate_psf: marketRateFor(r.lease, a.ctx.marketRates),
        score: r.score,
        reasons: r.reasons,
      }))
      .sort((x, y) => y.score - x.score),
  });
});

router.get('/expiring', async (c) => {
  const orgId = c.get('orgId');
  const months = Math.min(120, Math.max(1, Number(c.req.query('months')) || 12));
  const now = today();
  const until = addMonths(now, months);
  const [leases, ctx] = await Promise.all([loadLeases(orgId), loadPortfolioContext(orgId)]);
  const rows = leases
    .filter((l) => l.expiration_date && l.expiration_date >= now && l.expiration_date <= until)
    .map((l) => {
      const monthly = currentMonthlyRent(l, now);
      return {
        id: l.id,
        tenant_name: l.tenant_name,
        premises_address: l.premises_address,
        expiration_date: l.expiration_date,
        days_left: daysBetween(now, l.expiration_date!),
        annual_rent: monthly !== null ? round2(monthly * 12) : null,
        renewal_status: renewalStatus(l, ctx, now),
        has_renewal_option: hasRenewalOption(l),
        notice_by: noticeBy(l),
        status: effectiveStatus(l, now),
      };
    })
    .sort((a, b) => a.days_left - b.days_left);
  return c.json({ months, until, total_annual_rent: round2(rows.reduce((s, r) => s + (r.annual_rent ?? 0), 0)), rows });
});

async function rentRollCsv(c: Context<AppEnv>) {
  const now = today();
  const leases = await loadLeases(c.get('orgId'));
  const rows = leases.map((l) => rentRollRow(l, now)).sort((x, y) => (x.tenant_name ?? '').localeCompare(y.tenant_name ?? ''));
  const csv = toCsv(
    ['Tenant', 'Landlord', 'Premises', 'Property type', 'Rentable area', 'Start', 'End', 'Monthly rent', 'Annual rent', 'Rent per sq ft', 'Security deposit', 'Status', 'Notice by', 'Risk score'],
    rows.map((r) => [r.tenant_name, r.landlord_name, r.premises_address, r.property_type, r.rentable_area, r.commencement_date, r.expiration_date, r.monthly_rent, r.annual_rent, r.rent_psf, r.security_deposit, r.status, r.notice_by, r.risk_score]),
  );
  return new Response(`﻿${csv}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="rent-roll-${now}.csv"`,
    },
  });
}

router.get('/rent-roll.csv', rentRollCsv);

export default router;
