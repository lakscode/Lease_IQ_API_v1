// Lease report rows and filters (shared by /api/reports JSON, CSV and email).
import { currentMonthlyRent, effectiveStatus, inRange, loadLeases, round2, today, type AnalyticsLease } from './analytics-core.ts';
import { toCsv } from './http.ts';

export interface ReportFilters {
  search?: string | null;
  tenant?: string | null;
  landlord?: string | null;
  /** One or more statuses (comma separated in the query string). */
  status?: string[] | null;
  start_from?: string | null;
  start_to?: string | null;
  end_from?: string | null;
  end_to?: string | null;
  /** Annual rent range. */
  rent_min?: number | null;
  rent_max?: number | null;
}

export interface ReportRow {
  id: string;
  tenant_name: string | null;
  landlord_name: string | null;
  premises_address: string | null;
  commencement_date: string | null;
  expiration_date: string | null;
  annual_rent: number | null;
  monthly_rent: number | null;
  status: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function s(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}
function d(v: unknown): string | null {
  const t = s(v);
  return t && DATE_RE.test(t) ? t : null;
}
function n(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** Accepts a query-string record or a JSON body object. */
export function parseFilters(q: Record<string, unknown>): ReportFilters {
  const status = Array.isArray(q.status) ? q.status.map(String) : s(q.status)?.split(',') ?? null;
  return {
    search: s(q.search),
    tenant: s(q.tenant),
    landlord: s(q.landlord),
    status: status?.map((x) => x.trim()).filter(Boolean) ?? null,
    start_from: d(q.start_from),
    start_to: d(q.start_to),
    end_from: d(q.end_from),
    end_to: d(q.end_to),
    rent_min: n(q.rent_min),
    rent_max: n(q.rent_max),
  };
}

export function toRow(l: AnalyticsLease, now: string): ReportRow {
  const monthly = currentMonthlyRent(l, now);
  return {
    id: l.id,
    tenant_name: l.tenant_name,
    landlord_name: l.landlord_name,
    premises_address: l.premises_address,
    commencement_date: l.commencement_date,
    expiration_date: l.expiration_date,
    monthly_rent: monthly,
    annual_rent: monthly !== null ? round2(monthly * 12) : null,
    status: effectiveStatus(l, now),
  };
}

type Dim = 'status' | 'landlord' | 'end';

/** Apply the filters; `skip` leaves one dimension out (used for cross-filtered charts). */
export function applyFilters(rows: ReportRow[], f: ReportFilters, skip?: Dim): ReportRow[] {
  const search = f.search?.toLowerCase();
  return rows.filter((r) => {
    if (search && ![r.tenant_name, r.landlord_name, r.premises_address].some((v) => v?.toLowerCase().includes(search))) return false;
    if (f.tenant && (r.tenant_name ?? '') !== f.tenant) return false;
    if (skip !== 'landlord' && f.landlord && (r.landlord_name ?? '') !== f.landlord) return false;
    if (skip !== 'status' && f.status?.length && !f.status.includes(r.status)) return false;
    if (!inRange(r.commencement_date, f.start_from, f.start_to)) return false;
    if (skip !== 'end' && !inRange(r.expiration_date, f.end_from, f.end_to)) return false;
    if (f.rent_min !== null && f.rent_min !== undefined && (r.annual_rent ?? -Infinity) < f.rent_min) return false;
    if (f.rent_max !== null && f.rent_max !== undefined && (r.annual_rent ?? Infinity) > f.rent_max) return false;
    return true;
  });
}

export async function buildReport(orgId: string, f: ReportFilters) {
  const now = today();
  const all = (await loadLeases(orgId)).map((l) => toRow(l, now));
  const rows = applyFilters(all, f).sort((a, b) => (a.tenant_name ?? '').localeCompare(b.tenant_name ?? ''));

  const statuses = ['active', 'expiring', 'renewed', 'expired', 'unknown'];
  const forStatus = applyFilters(all, f, 'status');
  const by_status = statuses.map((status) => ({ status, count: forStatus.filter((r) => r.status === status).length }));

  const byYear = new Map<string, { year: string; count: number; annual_rent: number }>();
  for (const r of applyFilters(all, f, 'end')) {
    if (!r.expiration_date) continue;
    const year = r.expiration_date.slice(0, 4);
    const row = byYear.get(year) ?? { year, count: 0, annual_rent: 0 };
    row.count++;
    row.annual_rent = round2(row.annual_rent + (r.annual_rent ?? 0));
    byYear.set(year, row);
  }
  const expirations_by_year = [...byYear.values()].sort((a, b) => (a.year < b.year ? -1 : 1));

  const byLandlord = new Map<string, number>();
  for (const r of applyFilters(all, f, 'landlord')) {
    if (!r.landlord_name || r.status === 'expired') continue;
    byLandlord.set(r.landlord_name, (byLandlord.get(r.landlord_name) ?? 0) + (r.annual_rent ?? 0));
  }
  const rent_by_landlord = [...byLandlord.entries()]
    .map(([landlord, annual_rent]) => ({ landlord, annual_rent: round2(annual_rent) }))
    .sort((a, b) => b.annual_rent - a.annual_rent)
    .slice(0, 10);

  const uniq = (vals: (string | null)[]) => [...new Set(vals.filter((v): v is string => Boolean(v)))].sort((a, b) => a.localeCompare(b));
  return {
    as_of: now,
    total: all.length,
    rows,
    totals: {
      count: rows.length,
      annual_rent: round2(rows.reduce((sum, r) => sum + (r.annual_rent ?? 0), 0)),
      monthly_rent: round2(rows.reduce((sum, r) => sum + (r.monthly_rent ?? 0), 0)),
    },
    options: { tenants: uniq(all.map((r) => r.tenant_name)), landlords: uniq(all.map((r) => r.landlord_name)) },
    charts: { by_status, expirations_by_year, rent_by_landlord },
  };
}

export function reportCsv(rows: ReportRow[]): string {
  return `﻿${toCsv(
    ['Tenant', 'Landlord', 'Premises', 'Start', 'End', 'Annual rent', 'Monthly rent', 'Status'],
    rows.map((r) => [r.tenant_name, r.landlord_name, r.premises_address, r.commencement_date, r.expiration_date, r.annual_rent, r.monthly_rent, r.status]),
  )}`;
}

/** Human-readable summary of active filters for emails. */
export function describeFilters(f: ReportFilters): string[] {
  const out: string[] = [];
  if (f.search) out.push(`Search: ${f.search}`);
  if (f.tenant) out.push(`Tenant: ${f.tenant}`);
  if (f.landlord) out.push(`Landlord: ${f.landlord}`);
  if (f.status?.length) out.push(`Status: ${f.status.join(', ')}`);
  if (f.start_from || f.start_to) out.push(`Start: ${f.start_from ?? '…'} – ${f.start_to ?? '…'}`);
  if (f.end_from || f.end_to) out.push(`End: ${f.end_from ?? '…'} – ${f.end_to ?? '…'}`);
  if (f.rent_min !== null && f.rent_min !== undefined || f.rent_max !== null && f.rent_max !== undefined) {
    out.push(`Annual rent: ${f.rent_min ?? '…'} – ${f.rent_max ?? '…'}`);
  }
  return out;
}
