// Join-by-email-domain: a super admin claims a company domain for an organization; people who sign in
// with a verified Google or Microsoft account on that domain join automatically (see GET /api/me).
import type { User } from '@supabase/supabase-js';
import { db } from './supabase.ts';
import { badRequest } from './http.ts';
import { addMember } from './account-members.ts';
import type { Role } from './types.ts';

/** Free/public mailbox providers that can never be claimed. */
export const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.de', 'outlook.es', 'outlook.it', 'outlook.pt', 'hotmail.com', 'hotmail.co.uk',
  'hotmail.de', 'hotmail.es', 'hotmail.it', 'hotmail.fr', 'live.com', 'live.co.uk', 'live.de', 'live.it', 'msn.com', 'passport.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'yahoo.fr', 'yahoo.com.br', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aim.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de', 'freenet.de', 'mail.com', 'email.com',
  'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'inbox.com', 'tutanota.com', 'tuta.io', 'fastmail.com',
  'hey.com', 'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it',
  'orange.fr', 'free.fr', 'laposte.net', 'wanadoo.fr', 'sapo.pt', 'terra.com.br', 'uol.com.br', 'bol.com.br', 'btinternet.com',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net', 'charter.net', 'bigpond.com', 'rediffmail.com',
]);

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Normalize and validate a claimable domain ("@Acme.com" → "acme.com"). Throws 400 when invalid or public. */
export function claimableDomain(value: unknown): string {
  const d = String(value ?? '').trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(d)) throw badRequest('Enter a valid domain such as acme.com');
  if (PUBLIC_DOMAINS.has(d)) throw badRequest(`${d} is a public email domain and can't be claimed`);
  return d;
}

export function emailDomain(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  return email && at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

function providersOf(user: User): string[] {
  const list = (user.app_metadata?.providers as string[] | undefined) ?? [];
  const main = user.app_metadata?.provider as string | undefined;
  const fromIdentities = (user.identities ?? []).map((i) => i.provider);
  return [...new Set([...list, ...(main ? [main] : []), ...fromIdentities])];
}

const SSO_PROVIDERS = new Set(['google', 'azure']);

export function hasSsoProvider(user: User): boolean {
  return providersOf(user).some((p) => SSO_PROVIDERS.has(p));
}

/** Microsoft Entra tenant ids found on the user's Azure identities. */
export function msTenantIds(user: User): string[] {
  const ids = new Set<string>();
  for (const identity of user.identities ?? []) {
    if (identity.provider !== 'azure') continue;
    const d = (identity.identity_data ?? {}) as Record<string, unknown>;
    const claims = (d.custom_claims ?? {}) as Record<string, unknown>;
    for (const v of [d.tid, claims.tid]) if (typeof v === 'string' && v) ids.add(v.toLowerCase());
  }
  return [...ids];
}

interface DomainRow { id: string; org_id: string; domain: string; default_role: Role; ms_tenant_id: string | null }

async function isRemoved(orgId: string, email: string): Promise<boolean> {
  const { data } = await db().from('org_member_removals').select('email').eq('org_id', orgId).eq('email', email.toLowerCase()).maybeSingle();
  return Boolean(data);
}

/**
 * Called on every GET /api/me (idempotent). Adds the user to the org that claimed their email domain when they
 * signed in with a verified Google/Microsoft account, the tenant matches (if restricted) and they weren't removed.
 * Returns the org id joined, if any.
 */
export async function applyDomainJoin(user: User): Promise<string | null> {
  if (!user.email || !user.email_confirmed_at || !hasSsoProvider(user)) return null;
  const domain = emailDomain(user.email);
  if (!domain) return null;
  const { data } = await db().from('org_domains').select('id, org_id, domain, default_role, ms_tenant_id').eq('domain', domain).maybeSingle();
  const row = data as DomainRow | null;
  if (!row) return null;
  if (row.ms_tenant_id && !msTenantIds(user).includes(row.ms_tenant_id.toLowerCase())) return null;
  if (await isRemoved(row.org_id, user.email)) return null;
  const result = await addMember(row.org_id, user.id, row.default_role, user.email);
  return result === 'added' ? row.org_id : null;
}

/**
 * "Add existing users": apply the domain rule to accounts that already exist. Any account on the domain with a
 * confirmed email joins (when a Microsoft tenant is set, only accounts from that tenant). Removed people are skipped.
 */
export async function applyDomainToExistingUsers(row: DomainRow): Promise<{ added: number; already_member: number; skipped_removed: number; skipped_unverified: number }> {
  const out = { added: 0, already_member: 0, skipped_removed: 0, skipped_unverified: 0 };
  const { data: profiles } = await db().from('profiles').select('id, email').ilike('email', `%@${row.domain.replace(/[\\%_]/g, (ch) => `\\${ch}`)}`);
  for (const p of profiles ?? []) {
    const email = (p.email as string).toLowerCase();
    if (emailDomain(email) !== row.domain) continue;
    if (await isRemoved(row.org_id, email)) { out.skipped_removed++; continue; }
    const { data: auth } = await db().auth.admin.getUserById(p.id);
    const user = auth?.user;
    if (!user?.email_confirmed_at) { out.skipped_unverified++; continue; }
    if (row.ms_tenant_id && !msTenantIds(user).includes(row.ms_tenant_id.toLowerCase())) { out.skipped_unverified++; continue; }
    const r = await addMember(row.org_id, p.id, row.default_role, email);
    out[r]++;
  }
  return out;
}
