// Organization helpers shared by routes/orgs.ts and routes/admin.ts.
import { db } from './supabase.ts';
import { publicLogoUrl } from './storage.ts';
import { loadOrg } from './account-members.ts';

export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'CNY', 'HKD', 'SGD',
  'INR', 'ZAR', 'BRL', 'MXN', 'SEK', 'NOK', 'DKK', 'PLN', 'AED', 'SAR',
];

async function count(table: string, orgId: string): Promise<number> {
  const { count: n, error } = await db().from(table).select('*', { count: 'exact', head: true }).eq('org_id', orgId);
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

export async function orgSummary(orgId: string) {
  const org = await loadOrg(orgId);
  return {
    id: org.id,
    name: org.name,
    currency: org.currency,
    logo_url: publicLogoUrl(org.logo_path),
    created_at: org.created_at,
    member_count: await count('org_members', orgId),
  };
}

/** Data an organization holds; an org with any of it can't be deleted. */
export async function orgDataCounts(orgId: string): Promise<{ leases: number; lease_files: number; documents: number }> {
  const [leases, leaseFiles, documents] = await Promise.all([count('leases', orgId), count('lease_files', orgId), count('documents', orgId)]);
  return { leases, lease_files: leaseFiles, documents };
}
