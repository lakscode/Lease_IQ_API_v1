// Rent audit: schedule-aware lease rent per month vs billed rent, and system billing checks from the rent roll.
import { db } from './supabase.ts';
import { today } from './lease-terms.ts';
import type { RentPeriod } from './intel-insights.ts';

export interface RentRollRecord {
  id: string;
  import_id: string;
  lease_id: string | null;
  tenant: string | null;
  monthly_base_rent: number | null;
  annual_base_rent: number | null;
  next_escalation_date: string | null;
  next_escalation_rent: number | null;
  [key: string]: unknown;
}

export interface RentRollImport { id: string; source: string; file_name: string | null; created_at: string }

/** The lease's record from the newest rent roll import that matched it. */
export async function latestRentRollRecord(orgId: string, leaseId: string): Promise<{ record: RentRollRecord | null; import: RentRollImport | null }> {
  const { data: records } = await db().from('rent_roll_records').select('*').eq('org_id', orgId).eq('lease_id', leaseId);
  if (!records?.length) return { record: null, import: null };
  const importIds = [...new Set(records.map((r) => r.import_id as string))];
  const { data: imports } = await db().from('rent_roll_imports').select('id, source, file_name, created_at')
    .eq('org_id', orgId).in('id', importIds).order('created_at', { ascending: false });
  const newest = (imports ?? [])[0] as RentRollImport | undefined;
  const record = (newest ? records.find((r) => r.import_id === newest.id) : records[0]) as RentRollRecord;
  return { record, import: newest ?? null };
}

/** System monthly base rent from a rent roll record (monthly, else annual / 12). */
export function systemMonthlyRent(record: RentRollRecord | null): number | null {
  if (!record) return null;
  if (record.monthly_base_rent !== null && record.monthly_base_rent !== undefined) return Number(record.monthly_base_rent);
  if (record.annual_base_rent !== null && record.annual_base_rent !== undefined) return Math.round((Number(record.annual_base_rent) / 12) * 100) / 100;
  return null;
}

export interface LeaseBasics {
  commencement_date: string | null;
  expiration_date: string | null;
  base_rent_monthly: number | null;
  rentable_area: number | null;
}

/** The insights schedule when present; otherwise one flat period from the current terms. */
export function effectiveSchedule(schedule: RentPeriod[] | null | undefined, lease: LeaseBasics): { schedule: RentPeriod[]; source: 'insights' | 'terms' | 'none' } {
  if (schedule && schedule.length) return { schedule, source: 'insights' };
  if (lease.base_rent_monthly !== null && lease.base_rent_monthly !== undefined && lease.commencement_date) {
    const monthly = Number(lease.base_rent_monthly);
    const area = lease.rentable_area ? Number(lease.rentable_area) : null;
    return {
      source: 'terms',
      schedule: [{
        start: lease.commencement_date, end: lease.expiration_date, monthly_rent: monthly, annual_rent: monthly * 12,
        rent_psf: area ? Math.round(((monthly * 12) / area) * 100) / 100 : null, abatement: false, abatement_pct: null,
        note: null,
      }],
    };
  }
  return { schedule: [], source: 'none' };
}

/** YYYY-MM or YYYY-MM-DD → YYYY-MM-01, or null. */
export function monthStart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})/.exec(value.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Monthly rent after abatement for a period. */
export function effectiveRent(p: RentPeriod): number | null {
  if (p.monthly_rent === null || p.monthly_rent === undefined) return null;
  if (!p.abatement) return Number(p.monthly_rent);
  const pct = p.abatement_pct === null || p.abatement_pct === undefined ? 100 : Number(p.abatement_pct);
  return Math.round(Number(p.monthly_rent) * (1 - pct / 100) * 100) / 100;
}

/** The period in effect on the month's first day, else one starting during the month. */
export function periodForMonth(schedule: RentPeriod[], month: string): RentPeriod | null {
  const first = month;
  const last = monthEnd(month);
  return schedule.find((p) => p.start <= first && (!p.end || p.end >= first))
    ?? schedule.find((p) => p.start > first && p.start <= last)
    ?? null;
}

export function leaseRentForMonth(schedule: RentPeriod[], month: string): { rent: number | null; abated: boolean } {
  const p = periodForMonth(schedule, month);
  if (!p) return { rent: null, abated: false };
  return { rent: effectiveRent(p), abated: p.abatement };
}

/** First schedule step after `asOf` whose monthly rent differs from the rent in effect on `asOf`. */
export function nextStep(schedule: RentPeriod[], asOf = today()): { date: string; monthly_rent: number | null } | null {
  const current = schedule.find((p) => p.start <= asOf && (!p.end || p.end >= asOf));
  const currentRent = current ? effectiveRent(current) : null;
  const next = schedule.filter((p) => p.start > asOf).sort((a, b) => a.start.localeCompare(b.start))
    .find((p) => effectiveRent(p) !== currentRent);
  return next ? { date: next.start, monthly_rent: effectiveRent(next) } : null;
}

export type CheckResult = 'match' | 'mismatch' | 'check';

export interface BillingCheck { key: 'current_rent' | 'next_step_date' | 'next_step_rent'; lease: number | string | null; system: number | string | null; result: CheckResult }

/** Amounts match within 1 currency unit; dates match when in the same month. */
export function billingChecks(schedule: RentPeriod[], record: RentRollRecord | null, asOf = today()): BillingCheck[] {
  const month = monthStart(asOf) as string;
  const leaseNow = leaseRentForMonth(schedule, month).rent;
  const systemNow = systemMonthlyRent(record);
  const step = nextStep(schedule, asOf);
  const sysDate = record?.next_escalation_date ?? null;
  const sysStepRent = record?.next_escalation_rent ?? null;
  const amount = (a: number | null, b: number | null): CheckResult =>
    a === null || b === null ? 'check' : Math.abs(Number(a) - Number(b)) <= 1 ? 'match' : 'mismatch';
  const date = (a: string | null, b: string | null): CheckResult =>
    !a || !b ? (!a && !b && record ? 'match' : 'check') : a.slice(0, 7) === b.slice(0, 7) ? 'match' : 'mismatch';
  return [
    { key: 'current_rent', lease: leaseNow, system: systemNow, result: amount(leaseNow, systemNow) },
    { key: 'next_step_date', lease: step?.date ?? null, system: sysDate, result: record ? date(step?.date ?? null, sysDate) : 'check' },
    {
      key: 'next_step_rent', lease: step?.monthly_rent ?? null, system: sysStepRent === null ? null : Number(sysStepRent),
      result: !step && sysStepRent === null && record ? 'match' : amount(step?.monthly_rent ?? null, sysStepRent === null ? null : Number(sysStepRent)),
    },
  ];
}

export interface AuditRow {
  month: string;
  lease_rent: number | null;
  billed_rent: number | null;
  difference: number | null;   // billed − lease (positive = over-billed)
  abated: boolean;
  billed_override: boolean;
}

export interface AuditTotals {
  lease: number;
  billed: number;
  under: number;   // lease rent not billed
  over: number;    // billed above lease rent
  net: number;     // under − over: owed by the tenant (positive) or to the tenant (negative)
  months: number;
  unresolved: number; // months without a lease or billed amount (excluded from totals)
}

export const MAX_AUDIT_MONTHS = 240;

/**
 * Month-by-month audit. Billed rent defaults to the system monthly base rent; `overrides` (keyed YYYY-MM or
 * YYYY-MM-01) replace it per month. Months without both amounts are listed but excluded from the totals.
 */
export function computeAudit(
  schedule: RentPeriod[], start: string, end: string, systemMonthly: number | null, overrides: Record<string, unknown> = {},
): { rows: AuditRow[]; totals: AuditTotals } {
  const override = new Map<string, number>();
  for (const [k, v] of Object.entries(overrides ?? {})) {
    const m = monthStart(k);
    if (m && v !== null && v !== '' && Number.isFinite(Number(v))) override.set(m, Number(v));
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const totals: AuditTotals = { lease: 0, billed: 0, under: 0, over: 0, net: 0, months: 0, unresolved: 0 };
  const rows = monthsBetween(start, end).map((month) => {
    const { rent, abated } = leaseRentForMonth(schedule, month);
    const hasOverride = override.has(month);
    const billed = hasOverride ? (override.get(month) as number) : systemMonthly;
    const diff = rent !== null && billed !== null ? r2(billed - rent) : null;
    totals.months += 1;
    if (diff === null) totals.unresolved += 1;
    else {
      totals.lease += rent as number;
      totals.billed += billed as number;
      if (diff < 0) totals.under += -diff;
      else totals.over += diff;
    }
    return { month, lease_rent: rent, billed_rent: billed, difference: diff, abated, billed_override: hasOverride };
  });
  totals.lease = r2(totals.lease);
  totals.billed = r2(totals.billed);
  totals.under = r2(totals.under);
  totals.over = r2(totals.over);
  totals.net = r2(totals.under - totals.over);
  return { rows, totals };
}
