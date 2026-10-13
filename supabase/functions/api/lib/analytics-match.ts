// Matching rent roll records to leases, and the field-by-field "system record" comparison.
//
// Match confidence (0–1) = weighted average of the signals available for the record/lease pair:
//   tenant name similarity (weight 0.70) — normalised names (legal suffixes and punctuation stripped)
//   location overlap       (weight 0.15) — unit number found in the premises address, property-name tokens overlap
//   date proximity         (weight 0.15) — start/end dates equal (1), within 31 days (0.8), within a year (0.4)
// Signals that can't be computed (e.g. no unit in the record) are left out of the average, so a name-only
// file still matches on the name. A record is matched when confidence ≥ MATCH_THRESHOLD and the name
// similarity is ≥ 0.5; otherwise it stays unmatched for manual review.
import {
  addressTokens, currentMonthlyRent, daysBetween, nameSimilarity, nextEscalation, round2, type AnalyticsLease,
} from './analytics-core.ts';

export const MATCH_THRESHOLD = 0.6;

export interface MatchableRecord {
  tenant: string | null;
  property: string | null;
  unit: string | null;
  start_date: string | null;
  end_date: string | null;
}

function unitTokens(unit: string): string[] {
  // "Suite 400" → ["400"], "Unit 112" → ["112"], "C-140" → ["c", "140"]; keep the distinctive parts.
  return [...addressTokens(unit)].filter((t) => !['suite', 'ste', 'unit', 'space', 'floor', 'fl', 'bldg', 'building', 'no'].includes(t));
}

function locationScore(rec: MatchableRecord, lease: AnalyticsLease): number | null {
  const addr = addressTokens(lease.premises_address);
  if (!addr.size || (!rec.unit && !rec.property)) return null;
  const parts: number[] = [];
  if (rec.unit) {
    const toks = unitTokens(rec.unit);
    if (toks.length) parts.push(toks.every((t) => addr.has(t)) ? 1 : toks.some((t) => /\d/.test(t) && addr.has(t)) ? 0.6 : 0);
  }
  if (rec.property) {
    const toks = [...addressTokens(rec.property)].filter((t) => t.length > 2);
    if (toks.length) parts.push(toks.filter((t) => addr.has(t)).length / toks.length);
  }
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

/** Comparison verdict: the unit decides when the record has one (all its tokens in the address); else the property. */
function premisesMatch(rec: MatchableRecord, lease: AnalyticsLease): boolean | null {
  const addr = addressTokens(lease.premises_address);
  if (!addr.size) return null;
  const unit = rec.unit ? unitTokens(rec.unit) : [];
  if (unit.length) return unit.every((t) => addr.has(t));
  const loc = locationScore(rec, lease);
  return loc === null ? null : loc >= 0.5;
}

function dateCloseness(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const days = Math.abs(daysBetween(a, b));
  return days === 0 ? 1 : days <= 31 ? 0.8 : days <= 366 ? 0.4 : 0;
}

function dateScore(rec: MatchableRecord, lease: AnalyticsLease): number | null {
  const parts = [dateCloseness(rec.start_date, lease.commencement_date), dateCloseness(rec.end_date, lease.expiration_date)].filter(
    (x): x is number => x !== null,
  );
  return parts.length ? Math.max(...parts) : null;
}

export function scoreMatch(rec: MatchableRecord, lease: AnalyticsLease): { confidence: number; name: number } {
  const name = nameSimilarity(rec.tenant, lease.tenant_name);
  let weighted = name * 0.7;
  let weights = 0.7;
  const loc = locationScore(rec, lease);
  if (loc !== null) {
    weighted += loc * 0.15;
    weights += 0.15;
  }
  const date = dateScore(rec, lease);
  if (date !== null) {
    weighted += date * 0.15;
    weights += 0.15;
  }
  return { confidence: Math.round((weighted / weights) * 100) / 100, name };
}

export function bestMatch(rec: MatchableRecord, leases: AnalyticsLease[]): { lease_id: string | null; confidence: number | null } {
  let best: { id: string; confidence: number; name: number } | null = null;
  for (const lease of leases) {
    const s = scoreMatch(rec, lease);
    if (!best || s.confidence > best.confidence || (s.confidence === best.confidence && s.name > best.name)) {
      best = { id: lease.id, ...s };
    }
  }
  if (!best || best.confidence < MATCH_THRESHOLD || best.name < 0.5) return { lease_id: null, confidence: best ? best.confidence : null };
  return { lease_id: best.id, confidence: best.confidence };
}

// ---- Comparison ------------------------------------------------------------------------------

export interface RentRollRecordRow extends MatchableRecord {
  id: string;
  external_id: string | null;
  status: string | null;
  area: number | null;
  monthly_base_rent: number | null;
  annual_base_rent: number | null;
  security_deposit: number | null;
  next_escalation_date: string | null;
  next_escalation_rent: number | null;
}

export interface ComparisonRow {
  field: string;
  label: string;
  lease_value: string | number | null;
  system_value: string | number | null;
  match: boolean | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function closeEnough(a: number, b: number, relTol: number, absTol: number): boolean {
  return Math.abs(a - b) <= Math.max(absTol, Math.abs(b) * relTol);
}

export function compareRecord(rec: RentRollRecordRow, lease: AnalyticsLease, now: string): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  const push = (field: string, label: string, lv: string | number | null, sv: string | number | null, eq: (l: never, s: never) => boolean) =>
    rows.push({ field, label, lease_value: lv, system_value: sv, match: lv === null || sv === null ? null : eq(lv as never, sv as never) });

  push('tenant', 'Tenant', lease.tenant_name, rec.tenant, (l: string, s: string) => nameSimilarity(l, s) >= 0.85);

  const systemPremises = [rec.property, rec.unit].filter(Boolean).join(' · ') || null;
  rows.push({ field: 'premises', label: 'Premises / unit', lease_value: lease.premises_address, system_value: systemPremises, match: premisesMatch(rec, lease) });

  push('start_date', 'Start date', lease.commencement_date, rec.start_date, (l: string, s: string) => l === s);
  push('end_date', 'End date', lease.expiration_date, rec.end_date, (l: string, s: string) => l === s);
  push('area', 'Rentable area', lease.rentable_area, num(rec.area), (l: number, s: number) => closeEnough(l, s, 0.01, 1));

  const leaseRent = currentMonthlyRent(lease, now);
  const sysRent = num(rec.monthly_base_rent) ?? (num(rec.annual_base_rent) !== null ? round2(num(rec.annual_base_rent)! / 12) : null);
  push('monthly_base_rent', 'Monthly base rent', leaseRent, sysRent, (l: number, s: number) => closeEnough(l, s, 0.005, 1));

  const depositRaw = lease.current_terms?.security_deposit?.value;
  push('security_deposit', 'Security deposit', num(depositRaw), num(rec.security_deposit), (l: number, s: number) => closeEnough(l, s, 0, 1));

  // Next escalation only when the lease has a rent schedule (comparable terms).
  const next = lease.schedule.length ? nextEscalation(lease, now) : null;
  if (next || rec.next_escalation_date || rec.next_escalation_rent !== null) {
    rows.push({
      field: 'next_escalation_date',
      label: 'Next escalation date',
      lease_value: next?.date ?? null,
      system_value: rec.next_escalation_date,
      match: next && rec.next_escalation_date ? Math.abs(daysBetween(next.date, rec.next_escalation_date)) <= 31 : null,
    });
    const sysNext = num(rec.next_escalation_rent);
    rows.push({
      field: 'next_escalation_rent',
      label: 'Next escalation rent',
      lease_value: next?.monthly_rent ?? null,
      system_value: sysNext,
      match: next && sysNext !== null ? closeEnough(next.monthly_rent, sysNext, 0.005, 1) : null,
    });
  }
  return rows;
}
