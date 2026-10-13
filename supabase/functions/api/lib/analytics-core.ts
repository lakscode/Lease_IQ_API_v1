// Shared analytics helpers: loading a portfolio snapshot (leases + rent schedules) and the rent/status maths
// used by the dashboard, portfolio, reports and imports routers.
import { db } from './supabase.ts';
import { addMonths, today } from './lease-terms.ts';
import type { LeaseStatus } from './types.ts';

export interface RentStep {
  start: string | null;
  end: string | null;
  monthly_rent: number | null;
  annual_rent: number | null;
  rent_psf: number | null;
  abatement: unknown;
  note?: string | null;
}

export interface AnalyticsLease {
  id: string;
  tenant_name: string | null;
  landlord_name: string | null;
  premises_address: string | null;
  rentable_area: number | null;
  commencement_date: string | null;
  expiration_date: string | null;
  base_rent_monthly: number | null;
  status: LeaseStatus;
  property_type: string | null;
  risk_score: number | null;
  risk_reasons: unknown;
  current_terms: Record<string, { value: unknown; source_document_id?: string }>;
  main_document_id: string | null;
  market_rate_id: string | null;
  market_rate_override: number | null;
  updated_at: string;
  /** From lease_insights.rent_schedule (empty when not generated). */
  schedule: RentStep[];
}

const LEASE_COLUMNS =
  'id, tenant_name, landlord_name, premises_address, rentable_area, commencement_date, expiration_date, base_rent_monthly, status, property_type, risk_score, risk_reasons, current_terms, main_document_id, market_rate_id, market_rate_override, updated_at';

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function normaliseSchedule(raw: unknown): RentStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .map((s) => ({
      start: toDate(s.start),
      end: toDate(s.end),
      monthly_rent: toNum(s.monthly_rent),
      annual_rent: toNum(s.annual_rent),
      rent_psf: toNum(s.rent_psf),
      abatement: s.abatement,
      note: typeof s.note === 'string' ? s.note : null,
    }))
    .filter((s) => s.monthly_rent !== null || s.annual_rent !== null);
}

/** All leases of an org with their rent schedules. */
export async function loadLeases(orgId: string): Promise<AnalyticsLease[]> {
  const [leasesRes, insightsRes] = await Promise.all([
    db().from('leases').select(LEASE_COLUMNS).eq('org_id', orgId),
    db().from('lease_insights').select('lease_id, rent_schedule').eq('org_id', orgId),
  ]);
  if (leasesRes.error) throw new Error(leasesRes.error.message);
  if (insightsRes.error) throw new Error(insightsRes.error.message);
  const schedules = new Map<string, RentStep[]>();
  for (const row of insightsRes.data ?? []) schedules.set(row.lease_id as string, normaliseSchedule(row.rent_schedule));
  return (leasesRes.data ?? []).map((l) => {
    const lease = l as unknown as AnalyticsLease;
    return {
      ...lease,
      rentable_area: toNum(lease.rentable_area),
      base_rent_monthly: toNum(lease.base_rent_monthly),
      market_rate_override: toNum(lease.market_rate_override),
      current_terms: lease.current_terms ?? {},
      schedule: schedules.get(lease.id) ?? [],
    };
  });
}

export async function loadLease(orgId: string, leaseId: string): Promise<AnalyticsLease | null> {
  const { data, error } = await db().from('leases').select(LEASE_COLUMNS).eq('org_id', orgId).eq('id', leaseId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const { data: ins } = await db().from('lease_insights').select('rent_schedule').eq('lease_id', leaseId).eq('org_id', orgId).maybeSingle();
  const lease = data as unknown as AnalyticsLease;
  return {
    ...lease,
    rentable_area: toNum(lease.rentable_area),
    base_rent_monthly: toNum(lease.base_rent_monthly),
    market_rate_override: toNum(lease.market_rate_override),
    current_terms: lease.current_terms ?? {},
    schedule: normaliseSchedule(ins?.rent_schedule),
  };
}

export function termValue(lease: AnalyticsLease, key: string): unknown {
  const v = lease.current_terms?.[key]?.value;
  return v === '' ? null : (v ?? null);
}

/**
 * Status as of today. The stored status is computed when the lease's documents change, so it can be stale
 * (an "active" lease can have expired since). Dates win; "renewed" is kept while the lease is in force.
 */
export function effectiveStatus(lease: AnalyticsLease, now = today()): LeaseStatus {
  const exp = lease.expiration_date;
  if (!exp) return 'unknown';
  if (exp < now) return 'expired';
  if (lease.status === 'renewed') return 'renewed';
  return exp <= addMonths(now, 12) ? 'expiring' : 'active';
}

/** Monthly rent of a schedule step after abatement (true = fully abated; 0–1 = fraction; >1 = amount abated). */
function stepMonthly(step: RentStep): number {
  const base = step.monthly_rent ?? (step.annual_rent !== null ? step.annual_rent / 12 : 0);
  const a = step.abatement;
  if (a === true) return 0;
  const n = typeof a === 'number' ? a : null;
  if (n !== null && n > 0) return n <= 1 ? base * (1 - n) : Math.max(0, base - n);
  return base;
}

/**
 * Contracted monthly rent on a given day: the rent schedule step covering the day when the schedule exists,
 * otherwise base_rent_monthly between commencement (if known) and expiration. 0 outside the term.
 */
export function monthlyRentOn(lease: AnalyticsLease, day: string): number {
  if (lease.expiration_date && day > lease.expiration_date) return 0;
  if (lease.schedule.length) {
    const step = lease.schedule.find((s) => (!s.start || s.start <= day) && (!s.end || s.end >= day));
    if (step) return stepMonthly(step);
    // Before the first step or after the last one: fall back to the base rent within the term.
  }
  if (lease.commencement_date && day < lease.commencement_date) return 0;
  return lease.base_rent_monthly ?? 0;
}

/** Current in-place monthly rent (schedule step for today, else base rent). null when unknown. */
export function currentMonthlyRent(lease: AnalyticsLease, now = today()): number | null {
  if (lease.schedule.length) {
    const step = lease.schedule.find((s) => (!s.start || s.start <= now) && (!s.end || s.end >= now));
    if (step) return round2(stepMonthly(step));
  }
  return lease.base_rent_monthly;
}

/** The next rent step after today, from the schedule. */
export function nextEscalation(lease: AnalyticsLease, now = today()): { date: string; monthly_rent: number } | null {
  const current = currentMonthlyRent(lease, now);
  const next = lease.schedule
    .filter((s) => s.start && s.start > now)
    .sort((a, b) => (a.start! < b.start! ? -1 : 1))
    .find((s) => current === null || Math.abs(stepMonthly(s) - current) > 0.5);
  return next ? { date: next.start!, monthly_rent: round2(stepMonthly(next)) } : null;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function yearsBetween(from: string, to: string): number {
  return daysBetween(from, to) / 365.25;
}

/** Calendar quarter label, e.g. "2026 Q4". */
export function quarterOf(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return `${y} Q${Math.floor((m - 1) / 3) + 1}`;
}

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Normalised tenant name for grouping and matching: lower-case, no punctuation, no legal suffixes. */
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'l l c', 'co', 'corp', 'corporation', 'company', 'ltd', 'limited', 'lp', 'llp', 'plc',
  'pllc', 'pc', 'gmbh', 'ag', 'sa', 'srl', 'spa', 'bv', 'nv', 'the', 'dba', 'and', '&',
]);

export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\./g, '') // "L.L.C." → "llc"
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !LEGAL_SUFFIXES.has(t))
    .join(' ');
}

function bigrams(s: string): string[] {
  const t = s.replace(/ /g, '');
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** 0–1 similarity of two names after normalisation (max of token overlap and character-bigram Dice). */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const tokenScore = (2 * common) / (ta.size + tb.size);
  const ba = bigrams(na);
  const bb = bigrams(nb);
  const counts = new Map<string, number>();
  for (const g of bb) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of ba) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      hits++;
      counts.set(g, c - 1);
    }
  }
  const dice = ba.length + bb.length ? (2 * hits) / (ba.length + bb.length) : 0;
  // One name fully contained in the other ("Bluebird Coffee" vs "Bluebird Coffee Roasters") is a strong signal.
  const contained = na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na)) ? 0.9 : 0;
  return Math.max(tokenScore, dice, contained);
}

export function addressTokens(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 1 || /\d/.test(t)),
  );
}

/** Inclusive YYYY-MM-DD range check (no bounds = always true; a missing value fails any bound). */
export function inRange(value: string | null, from?: string | null, to?: string | null): boolean {
  if (!from && !to) return true;
  if (!value) return false;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

export { addMonths, today };
