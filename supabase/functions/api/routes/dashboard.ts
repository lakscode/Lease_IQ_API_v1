// GET /api/dashboard — portfolio health, expiration tiles, charts and upcoming expirations for the active org.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { withOrg } from '../lib/auth.ts';
import { db } from '../lib/supabase.ts';
import {
  addDays, addMonths, currentMonthlyRent, daysBetween, effectiveStatus, loadLeases, monthStart, monthlyRentOn, quarterOf, round2, today,
} from '../lib/analytics-core.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

router.get('/', async (c) => {
  const orgId = c.get('orgId');
  const now = today();
  const [leases, docsRes] = await Promise.all([
    loadLeases(orgId),
    db().from('documents').select('doc_type').eq('org_id', orgId),
  ]);
  if (docsRes.error) throw new Error(docsRes.error.message);

  const in90 = addDays(now, 90);
  const in12m = addMonths(now, 12);

  // Health: renewed leases count as active.
  const health = { active: 0, expiring: 0, expired: 0, unknown: 0 };
  const statusById = new Map<string, string>();
  for (const l of leases) {
    const s = effectiveStatus(l, now);
    statusById.set(l.id, s);
    if (s === 'renewed' || s === 'active') health.active++;
    else health[s]++;
  }

  const upcoming = leases.filter((l) => l.expiration_date && l.expiration_date >= now && l.expiration_date <= in12m);
  const tiles = {
    total: leases.length,
    expiring_90_days: upcoming.filter((l) => l.expiration_date! <= in90).length,
    expiring_12_months: upcoming.length,
    renewed: [...statusById.values()].filter((s) => s === 'renewed').length,
    expired: health.expired,
  };

  // Expirations by quarter: the current quarter and the next 7.
  const quarters: { quarter: string; count: number; annual_rent: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const q = quarterOf(addMonths(monthStart(now), i * 3));
    if (!quarters.some((x) => x.quarter === q)) quarters.push({ quarter: q, count: 0, annual_rent: 0 });
  }
  for (const l of leases) {
    if (!l.expiration_date || l.expiration_date < now) continue;
    const bucket = quarters.find((q) => q.quarter === quarterOf(l.expiration_date!));
    if (!bucket) continue;
    bucket.count++;
    bucket.annual_rent += (currentMonthlyRent(l, now) ?? 0) * 12;
  }
  for (const q of quarters) q.annual_rent = round2(q.annual_rent);

  // Contracted rent outlook: the next 24 months, rent on the 1st (or today for the current month).
  const outlook: { month: string; rent: number }[] = [];
  for (let i = 0; i < 24; i++) {
    const first = addMonths(monthStart(now), i);
    const day = i === 0 ? now : first;
    let total = 0;
    for (const l of leases) total += monthlyRentOn(l, day);
    outlook.push({ month: first.slice(0, 7), rent: round2(total) });
  }

  const timeline = leases
    .filter((l) => l.commencement_date || l.expiration_date)
    .map((l) => ({
      id: l.id,
      tenant_name: l.tenant_name,
      start: l.commencement_date,
      end: l.expiration_date,
      status: statusById.get(l.id),
    }))
    .sort((a, b) => ((a.end ?? '9999') < (b.end ?? '9999') ? -1 : 1));

  const docCounts = new Map<string, number>();
  for (const d of docsRes.data ?? []) docCounts.set(d.doc_type as string, (docCounts.get(d.doc_type as string) ?? 0) + 1);
  const documents_by_type = ['main_lease', 'amendment', 'addendum', 'commencement_letter', 'other']
    .map((doc_type) => ({ doc_type, count: docCounts.get(doc_type) ?? 0 }))
    .filter((d) => d.count > 0);

  const upcoming_expirations = upcoming
    .map((l) => {
      const days = daysBetween(now, l.expiration_date!);
      const monthly = currentMonthlyRent(l, now);
      return {
        id: l.id,
        tenant_name: l.tenant_name,
        premises_address: l.premises_address,
        expiration_date: l.expiration_date,
        days_left: days,
        urgency: days <= 90 ? 'urgent' : days <= 180 ? 'soon' : 'upcoming',
        monthly_rent: monthly,
        status: statusById.get(l.id),
      };
    })
    .sort((a, b) => a.days_left - b.days_left);

  return c.json({
    as_of: now,
    health,
    tiles,
    expirations_by_quarter: quarters,
    rent_outlook: outlook,
    timeline,
    documents_by_type,
    upcoming_expirations,
  });
});

export default router;
