// Sign-in history (table login_events, migration 0120). Supabase Auth's own audit log isn't available, so the API
// records each session once: GET /api/me (called by the app right after signing in) inserts the row, later calls in
// the same session move last_seen_at, and POST /api/me/logout sets signed_out_at.
import type { Context } from 'hono';
import type { User } from '@supabase/supabase-js';
import type { AppEnv } from './types.ts';
import { db, must } from './supabase.ts';
import { errorFields, log } from './log.ts';
import { badRequest } from './http.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEEN_EVERY_MS = 5 * 60_000; // move last_seen_at at most every 5 minutes

interface TokenClaims { session_id?: string; iat?: number; amr?: { method?: string; timestamp?: number }[] }

/** Claims of the caller's access token (already verified by authenticate()). */
function claims(c: Context<AppEnv>): TokenClaims {
  try {
    const part = c.get('token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')), (ch) => ch.charCodeAt(0)));
    return JSON.parse(json) as TokenClaims;
  } catch {
    return {};
  }
}

export function clientIp(c: Context<AppEnv>): string | null {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return (c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || forwarded || null)?.slice(0, 64) ?? null;
}

/** Record the caller's session as a sign-in (first call) or refresh its last-seen time. Never throws. */
export async function recordLogin(c: Context<AppEnv>, user: User): Promise<void> {
  try {
    const cl = claims(c);
    if (!cl.session_id) return;
    const existing = must(await db().from('login_events').select('id, last_seen_at').eq('session_id', cl.session_id).maybeSingle(), 'login event') as
      { id: number; last_seen_at: string } | null;
    const now = new Date();
    if (existing) {
      if (now.getTime() - Date.parse(existing.last_seen_at) > SEEN_EVERY_MS) {
        must(await db().from('login_events').update({ last_seen_at: now.toISOString() }).eq('id', existing.id), 'login seen');
      }
      return;
    }
    const memberships = must(await db().from('org_members').select('org_id').eq('user_id', user.id), 'memberships') as { org_id: string }[];
    const auth = cl.amr?.[0];
    const signedIn = auth?.timestamp ? new Date(auth.timestamp * 1000) : cl.iat ? new Date(cl.iat * 1000) : now;
    const { error } = await db().from('login_events').insert({
      session_id: cl.session_id,
      user_id: user.id,
      email: user.email ?? null,
      method: auth?.method ?? null,
      provider: (user.app_metadata?.provider as string | undefined) ?? null,
      ip: clientIp(c),
      user_agent: c.req.header('user-agent')?.slice(0, 400) ?? null,
      org_ids: memberships.map((m) => m.org_id),
      signed_in_at: signedIn.toISOString(),
      last_seen_at: now.toISOString(),
    });
    // 23505: another request of the same session got there first.
    if (error && error.code !== '23505') throw new Error(error.message);
  } catch (err) {
    log.warn('account.logins', `Could not record sign-in: ${(err as Error).message}`, { userId: user.id, ...errorFields(err) });
  }
}

/** Mark the caller's session as signed out. Never throws. */
export async function recordLogout(c: Context<AppEnv>): Promise<void> {
  const sessionId = claims(c).session_id;
  if (!sessionId) return;
  const { error } = await db().from('login_events').update({ signed_out_at: new Date().toISOString() }).eq('session_id', sessionId).is('signed_out_at', null);
  if (error) log.warn('account.logins', `Could not record sign-out: ${error.message}`);
}

// ---- Reports ------------------------------------------------------------------------------------

interface EventRow {
  id: number;
  user_id: string;
  email: string | null;
  method: string | null;
  provider: string | null;
  ip: string | null;
  user_agent: string | null;
  org_ids: string[];
  signed_in_at: string;
  last_seen_at: string;
  signed_out_at: string | null;
  profile: { display_name: string | null; email: string | null } | null;
}

const MAX_SCAN = 5000;  // rows aggregated per report
const MAX_EVENTS = 300; // rows listed

/**
 * Sign-ins in the last `days` days, newest first, with summaries by user and (when not scoped to one organization)
 * by organization. `orgId` limits to sign-ins by members of that organization; `userId` to one user; `q` matches
 * email or name.
 */
export async function loginReport(opts: { orgId?: string | null; userId?: string | null; q?: string | null; days: number }) {
  for (const id of [opts.orgId, opts.userId]) if (id && !UUID_RE.test(id)) throw badRequest('Invalid id');
  const since = new Date(Date.now() - opts.days * 86_400_000).toISOString();
  let query = db().from('login_events')
    .select('id, user_id, email, method, provider, ip, user_agent, org_ids, signed_in_at, last_seen_at, signed_out_at, profile:profiles!login_events_user_id_fkey(display_name, email)')
    .gte('signed_in_at', since)
    .order('signed_in_at', { ascending: false })
    .limit(MAX_SCAN);
  if (opts.orgId) query = query.contains('org_ids', [opts.orgId]);
  if (opts.userId) query = query.eq('user_id', opts.userId);
  let rows = must(await query, 'login events') as unknown as EventRow[];
  const q = opts.q?.trim().toLowerCase();
  if (q) rows = rows.filter((r) => (r.email ?? '').toLowerCase().includes(q) || (r.profile?.display_name ?? '').toLowerCase().includes(q));

  const orgIds = [...new Set(rows.flatMap((r) => r.org_ids))];
  const orgNames = new Map<string, string>();
  for (let i = 0; i < orgIds.length; i += 200) {
    const orgs = must(await db().from('organizations').select('id, name').in('id', orgIds.slice(i, i + 200)), 'organizations') as { id: string; name: string }[];
    for (const o of orgs) orgNames.set(o.id, o.name);
  }
  const name = (r: EventRow) => r.profile?.display_name || null;

  const byUser = new Map<string, { user_id: string; name: string | null; email: string | null; logins: number; last_login: string; last_seen: string; methods: Set<string>; ips: Set<string> }>();
  for (const r of rows) {
    const u = byUser.get(r.user_id) ?? { user_id: r.user_id, name: name(r), email: r.email ?? r.profile?.email ?? null, logins: 0, last_login: r.signed_in_at, last_seen: r.last_seen_at, methods: new Set(), ips: new Set() };
    u.logins += 1;
    if (r.last_seen_at > u.last_seen) u.last_seen = r.last_seen_at;
    u.methods.add(r.provider && r.provider !== 'email' ? r.provider : r.method ?? 'password');
    if (r.ip) u.ips.add(r.ip);
    byUser.set(r.user_id, u);
  }

  const byOrg = new Map<string, { org_id: string; name: string; logins: number; users: Set<string>; last_login: string }>();
  if (!opts.orgId) {
    for (const r of rows) {
      for (const id of r.org_ids) {
        const o = byOrg.get(id) ?? { org_id: id, name: orgNames.get(id) ?? '—', logins: 0, users: new Set(), last_login: r.signed_in_at };
        o.logins += 1;
        o.users.add(r.user_id);
        byOrg.set(id, o);
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  return {
    days: opts.days,
    truncated: rows.length >= MAX_SCAN,
    totals: {
      logins: rows.length,
      users: byUser.size,
      today: rows.filter((r) => r.signed_in_at.slice(0, 10) === today).length,
      active_sessions: rows.filter((r) => !r.signed_out_at && Date.now() - Date.parse(r.last_seen_at) < 24 * 3_600_000).length,
    },
    events: rows.slice(0, MAX_EVENTS).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      name: name(r),
      email: r.email ?? r.profile?.email ?? null,
      method: r.method,
      provider: r.provider,
      ip: r.ip,
      user_agent: r.user_agent,
      orgs: r.org_ids.map((id) => ({ id, name: orgNames.get(id) ?? '—' })),
      signed_in_at: r.signed_in_at,
      last_seen_at: r.last_seen_at,
      signed_out_at: r.signed_out_at,
    })),
    by_user: [...byUser.values()].map((u) => ({ ...u, methods: [...u.methods], ips: u.ips.size })).sort((a, b) => b.last_login.localeCompare(a.last_login)),
    by_org: [...byOrg.values()].map((o) => ({ org_id: o.org_id, name: o.name, logins: o.logins, users: o.users.size, last_login: o.last_login })).sort((a, b) => b.logins - a.logins),
  };
}

/** `days` query parameter: 1..365, default 30. */
export function reportDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30;
}
