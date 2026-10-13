import type { Context, MiddlewareHandler } from 'hono';
import { db } from './supabase.ts';
import { ApiError, forbidden } from './http.ts';
import type { AppEnv, Profile, Role } from './types.ts';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

/** Verifies the Supabase access token and loads the caller's profile. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new ApiError('unauthorized', 'Missing bearer token');

  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) throw new ApiError('unauthorized', 'Invalid or expired token');

  c.set('token', token);
  c.set('user', data.user);
  c.set('profile', await loadProfile(data.user.id, data.user.email ?? null, data.user.user_metadata));
  await next();
};

async function loadProfile(userId: string, email: string | null, meta: Record<string, unknown> | undefined): Promise<Profile> {
  const { data } = await db().from('profiles').select('*').eq('id', userId).maybeSingle();
  if (data) return data as Profile;
  // The auth trigger normally creates this; cover users created before the trigger existed.
  const displayName = (meta?.full_name as string) || (meta?.name as string) || null;
  const { data: created, error } = await db()
    .from('profiles')
    .upsert({ id: userId, email, display_name: displayName })
    .select('*')
    .single();
  if (error) throw new Error(`Could not create profile: ${error.message}`);
  return created as Profile;
}

/**
 * Resolves the active organization and the caller's role in it.
 * Clients send the org in the `X-Org-Id` header; without it the profile's default org is used.
 */
export const withOrg: MiddlewareHandler<AppEnv> = async (c, next) => {
  const profile = c.get('profile');
  const requested = c.req.header('X-Org-Id') || profile.default_org_id;

  if (requested) {
    const role = await roleIn(requested, profile);
    if (role) {
      c.set('orgId', requested);
      c.set('role', role);
      return next();
    }
    if (c.req.header('X-Org-Id')) throw forbidden('You are not a member of this organization');
  }

  // Fall back to the first membership.
  const { data } = await db()
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', profile.id)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (!data) throw new ApiError('no_org', 'You are not a member of any organization yet');
  c.set('orgId', data.org_id);
  c.set('role', profile.is_super_admin ? 'admin' : (data.role as Role));
  await next();
};

export async function roleIn(orgId: string, profile: Profile): Promise<Role | null> {
  if (profile.is_super_admin) {
    const { data } = await db().from('organizations').select('id').eq('id', orgId).maybeSingle();
    return data ? 'admin' : null;
  }
  const { data } = await db()
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', profile.id)
    .maybeSingle();
  return (data?.role as Role) ?? null;
}

/** Require at least this role in the active organization (use after withOrg). */
export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (RANK[c.get('role')] < RANK[min]) {
      throw forbidden(min === 'admin' ? 'Organization admin access required' : 'Editor access required');
    }
    await next();
  };
}

export const requireSuperAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('profile').is_super_admin) throw forbidden('Super admin access required');
  await next();
};

export function canEdit(c: Context<AppEnv>): boolean {
  return RANK[c.get('role')] >= RANK.editor;
}

/** Load a row by id and make sure it belongs to the active org; 404 otherwise. */
export async function getOrgRow<T = Record<string, unknown>>(
  c: Context<AppEnv>,
  table: string,
  id: string,
  columns = '*',
): Promise<T> {
  const { data, error } = await db().from(table).select(columns).eq('id', id).eq('org_id', c.get('orgId')).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ApiError('not_found', 'Not found');
  return data as T;
}
