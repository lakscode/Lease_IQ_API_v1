import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';
import type { AppEnv, Locale, Profile, Role } from '../lib/types.ts';
import { anonClient, db } from '../lib/supabase.ts';
import { publicLogoUrl } from '../lib/storage.ts';
import { ApiError, badRequest, readJson } from '../lib/http.ts';
import { applyDomainJoin } from '../lib/account-domains.ts';

const router = new Hono<AppEnv>();

export interface MyOrg {
  id: string;
  name: string;
  currency: string;
  logo_url: string | null;
  role: Role;
  /** True when the user is only here via super-admin access (not a real member). */
  via_super_admin: boolean;
}

/** Organizations the caller can switch to (super admins: all of them). */
export async function myOrgs(userId: string, isSuperAdmin: boolean): Promise<MyOrg[]> {
  const { data: memberships, error } = await db()
    .from('org_members')
    .select('role, org:organizations(id, name, currency, logo_path)')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);

  const result = new Map<string, MyOrg>();
  for (const m of memberships ?? []) {
    const org = m.org as unknown as { id: string; name: string; currency: string; logo_path: string | null } | null;
    if (!org) continue;
    result.set(org.id, {
      id: org.id, name: org.name, currency: org.currency, logo_url: publicLogoUrl(org.logo_path),
      role: isSuperAdmin ? 'admin' : (m.role as Role), via_super_admin: false,
    });
  }
  if (isSuperAdmin) {
    const { data: all } = await db().from('organizations').select('id, name, currency, logo_path').order('name');
    for (const org of all ?? []) {
      if (!result.has(org.id)) {
        result.set(org.id, { id: org.id, name: org.name, currency: org.currency, logo_url: publicLogoUrl(org.logo_path), role: 'admin', via_super_admin: true });
      }
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// GET /api/me — who am I, which orgs can I use, which one is active by default.
/** Sign-in methods of an auth user ('email', 'google', 'azure', ...). */
export function signInProviders(user: User): string[] {
  const list = (user.app_metadata?.providers as string[] | undefined) ?? [];
  const main = user.app_metadata?.provider as string | undefined;
  const all = [...new Set([...list, ...(main ? [main] : []), ...(user.identities ?? []).map((i) => i.provider)])];
  return all.length ? all : ['email'];
}

router.get('/', async (c) => {
  const user = c.get('user');
  let profile = c.get('profile');
  // Join by email domain (idempotent; never blocks sign-in).
  try {
    const joined = await applyDomainJoin(user);
    if (joined && !profile.default_org_id) profile = { ...profile, default_org_id: joined };
  } catch (err) {
    console.error('domain join failed:', (err as Error).message);
  }
  const orgs = await myOrgs(user.id, profile.is_super_admin);
  const memberOrgs = orgs.filter((o) => !o.via_super_admin);
  const activeOrgId =
    (profile.default_org_id && orgs.some((o) => o.id === profile.default_org_id) && profile.default_org_id) ||
    memberOrgs[0]?.id ||
    orgs[0]?.id ||
    null;

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      providers: signInProviders(user),
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at ?? null,
      email_confirmed_at: user.email_confirmed_at ?? null,
      /** Pending address while an email change awaits confirmation. */
      new_email: user.new_email ?? null,
    },
    profile,
    orgs,
    active_org_id: activeOrgId,
  });
});

const LOCALES: Locale[] = ['en', 'de', 'es', 'pt', 'it'];

// PATCH /api/me — { display_name?, locale?, default_org_id? }
router.patch('/', async (c) => {
  const user = c.get('user');
  const profile = c.get('profile');
  const body = await readJson(c);
  const update: Partial<Profile> = {};

  if ('display_name' in body) {
    const name = typeof body.display_name === 'string' ? body.display_name.trim().slice(0, 120) : '';
    update.display_name = name || null;
  }
  if ('locale' in body) {
    if (!LOCALES.includes(body.locale as Locale)) throw badRequest('Unsupported language');
    update.locale = body.locale as Locale;
  }
  if ('default_org_id' in body) {
    const orgId = body.default_org_id;
    if (orgId === null) update.default_org_id = null;
    else {
      if (typeof orgId !== 'string') throw badRequest('default_org_id must be an organization id');
      const orgs = await myOrgs(user.id, profile.is_super_admin);
      if (!orgs.some((o) => o.id === orgId)) throw badRequest('You are not a member of that organization');
      update.default_org_id = orgId;
    }
  }
  if (!Object.keys(update).length) throw badRequest('Nothing to update');

  const { data, error } = await db().from('profiles').update(update).eq('id', user.id).select('*').single();
  if (error) throw new Error(error.message);
  return c.json({ profile: data as Profile });
});

// POST /api/me/password — { current_password, new_password }. Email/password accounts only.
router.post('/password', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  if (!signInProviders(user).includes('email') || !user.email) {
    throw badRequest('Your sign-in provider manages your password');
  }
  if (!current) throw badRequest('Enter your current password');
  if (next.length < 6) throw badRequest('The new password must be at least 6 characters');
  if (next === current) throw badRequest('The new password must be different from the current one');

  const anon = anonClient();
  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email: user.email, password: current });
  if (signInError || !signIn.session) throw new ApiError('forbidden', 'The current password is incorrect');
  // Drop the verification session only (scope local keeps the user's other sessions).
  await anon.auth.signOut({ scope: 'local' }).catch(() => undefined);

  const { error } = await db().auth.admin.updateUserById(user.id, { password: next });
  if (error) throw badRequest(error.message);
  return c.json({ ok: true });
});

export default router;
