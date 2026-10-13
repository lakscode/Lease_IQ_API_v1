// Organization membership, invitations and CSV import. Shared by routes/orgs.ts (an admin's active org)
// and routes/admin.ts (super admins managing any org) through membersRouter().
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { db, must } from './supabase.ts';
import { env } from './env.ts';
import { ApiError, badRequest, forbidden, notFound, readJson, str, toCsv } from './http.ts';
import { emailConfigured, escapeHtml, renderEmail, sendEmail } from './email.ts';
import { publicLogoUrl } from './storage.ts';
import type { AppEnv, Role } from './types.ts';

export const ROLES: Role[] = ['admin', 'editor', 'viewer'];
export const INVITE_DAYS = 7;
export const MAX_IMPORT_ROWS = 500;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | null {
  const s = str(value)?.toLowerCase() ?? null;
  return s && EMAIL_RE.test(s) ? s : null;
}

export function parseRole(value: unknown, fallback?: Role): Role {
  const r = str(value)?.toLowerCase();
  if (r && (ROLES as string[]).includes(r)) return r as Role;
  if (fallback) return fallback;
  throw badRequest('Role must be admin, editor or viewer');
}

// ---- Tokens ------------------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function inviteLink(token: string): string {
  return `${env.appUrl}/invite/${token}`;
}

// ---- Lookups -----------------------------------------------------------------------------------

/** Escape LIKE wildcards so ilike() works as a case-insensitive equality. */
export function likeExact(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function findProfileByEmail(email: string): Promise<{ id: string; email: string; display_name: string | null } | null> {
  const { data } = await db().from('profiles').select('id, email, display_name').ilike('email', likeExact(email)).limit(1).maybeSingle();
  return (data as { id: string; email: string; display_name: string | null } | null) ?? null;
}

export async function loadOrg(orgId: string): Promise<{ id: string; name: string; currency: string; logo_path: string | null; created_at: string }> {
  const { data } = await db().from('organizations').select('id, name, currency, logo_path, created_at').eq('id', orgId).maybeSingle();
  if (!data) throw notFound('Organization');
  return data as { id: string; name: string; currency: string; logo_path: string | null; created_at: string };
}

// ---- Membership --------------------------------------------------------------------------------

export interface MemberRow {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: Role;
  is_super_admin: boolean;
  created_at: string;
}

export async function listMembers(orgId: string): Promise<MemberRow[]> {
  const rows = must(
    await db()
      .from('org_members')
      .select('user_id, role, created_at, profile:profiles(email, display_name, is_super_admin)')
      .eq('org_id', orgId)
      .order('created_at'),
  ) as unknown as { user_id: string; role: Role; created_at: string; profile: { email: string | null; display_name: string | null; is_super_admin: boolean } | null }[];
  return rows
    .map((r) => ({
      user_id: r.user_id,
      email: r.profile?.email ?? null,
      display_name: r.profile?.display_name ?? null,
      role: r.role,
      is_super_admin: Boolean(r.profile?.is_super_admin),
      created_at: r.created_at,
    }))
    .sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));
}

/** Add a user to an org (no-op if already a member). Clears any "removed" marker for their email. */
export async function addMember(orgId: string, userId: string, role: Role, email: string | null): Promise<'added' | 'already_member'> {
  const { data: existing } = await db().from('org_members').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle();
  if (existing) return 'already_member';
  must(await db().from('org_members').insert({ org_id: orgId, user_id: userId, role }));
  if (email) await db().from('org_member_removals').delete().eq('org_id', orgId).eq('email', email.toLowerCase());
  // Give users without a default organization this one.
  await db().from('profiles').update({ default_org_id: orgId }).eq('id', userId).is('default_org_id', null);
  return 'added';
}

/** Remove members and remember their emails so domain join doesn't re-add them. */
export async function removeMembers(orgId: string, userIds: string[], removedBy: string | null): Promise<number> {
  if (!userIds.length) return 0;
  const { data: profiles } = await db().from('profiles').select('id, email').in('id', userIds);
  const removed = must(await db().from('org_members').delete().eq('org_id', orgId).in('user_id', userIds).select('user_id')) ?? [];
  const emails = (profiles ?? []).filter((p) => p.email && removed.some((r) => r.user_id === p.id)).map((p) => (p.email as string).toLowerCase());
  if (emails.length) {
    await db()
      .from('org_member_removals')
      .upsert(emails.map((email) => ({ org_id: orgId, email, removed_by: removedBy, removed_at: new Date().toISOString() })));
  }
  return removed.length;
}

// ---- Invitations -------------------------------------------------------------------------------

export interface InviteResult {
  status: 'added' | 'already_member' | 'invited' | 'invited_no_email';
  email: string;
  user_id?: string;
  invite_id?: string;
  /** Copyable invitation link when the email could not be sent. */
  link?: string;
  email_error?: string;
}

async function sendInviteEmail(orgId: string, email: string, role: Role, token: string, inviterName: string | null): Promise<{ sent: boolean; error?: string }> {
  if (!(await emailConfigured())) return { sent: false };
  const org = await loadOrg(orgId);
  const link = inviteLink(token);
  try {
    await sendEmail({
      to: [email],
      subject: `You're invited to ${org.name} on Lease IQ`,
      html: renderEmail({
        title: `Join ${org.name} on Lease IQ`,
        orgName: org.name,
        logoUrl: publicLogoUrl(org.logo_path),
        bodyHtml: `<p>${escapeHtml(inviterName || 'An administrator')} invited you to join <strong>${escapeHtml(org.name)}</strong> as <strong>${escapeHtml(role)}</strong>.</p>
          <p>Sign in or create an account with <strong>${escapeHtml(email)}</strong> to accept. This invitation expires in ${INVITE_DAYS} days.</p>`,
        cta: { label: 'Accept invitation', url: link },
        footer: 'If you were not expecting this invitation, you can ignore this email.',
      }),
      text: `You're invited to join ${org.name} on Lease IQ as ${role}. Accept: ${link}`,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: (err as Error).message };
  }
}

/** Create (or replace) a pending invitation and email it if email is configured. */
export async function createInvite(orgId: string, email: string, role: Role, invitedBy: { id: string; name: string | null }): Promise<InviteResult> {
  // Only one live invite per org/email: older pending ones stop working.
  await db().from('org_invites').update({ status: 'revoked' }).eq('org_id', orgId).eq('email', email).eq('status', 'pending');
  const token = newToken();
  const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();
  const invite = must(
    await db()
      .from('org_invites')
      .insert({ org_id: orgId, email, role, token_hash: await hashToken(token), status: 'pending', expires_at: expires, invited_by: invitedBy.id })
      .select('id')
      .single(),
  ) as { id: string };
  const mail = await sendInviteEmail(orgId, email, role, token, invitedBy.name);
  if (mail.sent) {
    await db().from('org_invites').update({ email_sent: true }).eq('id', invite.id);
    return { status: 'invited', email, invite_id: invite.id };
  }
  return { status: 'invited_no_email', email, invite_id: invite.id, link: inviteLink(token), ...(mail.error ? { email_error: mail.error } : {}) };
}

/** Existing account → added immediately; anyone else → invitation. */
export async function addOrInvite(orgId: string, email: string, role: Role, actor: { id: string; name: string | null }): Promise<InviteResult> {
  const profile = await findProfileByEmail(email);
  if (profile) {
    const status = await addMember(orgId, profile.id, role, email);
    // A pending invite for someone who is now a member is moot.
    await db().from('org_invites').update({ status: 'revoked' }).eq('org_id', orgId).eq('email', email).eq('status', 'pending');
    return { status, email, user_id: profile.id };
  }
  return createInvite(orgId, email, role, actor);
}

export function inviteStatus(row: { status: string; expires_at: string }): 'pending' | 'accepted' | 'revoked' | 'expired' {
  if (row.status === 'pending' && new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  return row.status as 'pending' | 'accepted' | 'revoked';
}

// ---- CSV import --------------------------------------------------------------------------------

export const IMPORT_TEMPLATE = toCsv(['email', 'role'], [['jane.doe@example.com', 'viewer'], ['john.smith@example.com', 'editor']]);

/** Minimal CSV parser (quotes, commas, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

export interface ImportRowResult {
  row: number;
  email: string;
  role: string;
  status: 'added' | 'already_member' | 'invited' | 'invited_no_email' | 'failed';
  reason?: string;
  link?: string;
}

export async function importMembers(orgId: string, csv: string, actor: { id: string; name: string | null }): Promise<ImportRowResult[]> {
  const rows = parseCsv(csv);
  if (!rows.length) throw badRequest('The CSV file is empty');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let emailCol = header.indexOf('email');
  let roleCol = header.indexOf('role');
  let start = 1;
  if (emailCol < 0) {
    // No header row: assume email,role
    emailCol = 0; roleCol = 1; start = 0;
  }
  const data = rows.slice(start);
  if (data.length > MAX_IMPORT_ROWS) throw badRequest(`The CSV has ${data.length} rows; the limit is ${MAX_IMPORT_ROWS}`);

  const results: ImportRowResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < data.length; i++) {
    const rawEmail = (data[i][emailCol] ?? '').trim();
    const rawRole = (roleCol >= 0 ? data[i][roleCol] ?? '' : '').trim().toLowerCase() || 'viewer';
    const rowNo = i + start + 1;
    const email = normalizeEmail(rawEmail);
    if (!email) { results.push({ row: rowNo, email: rawEmail, role: rawRole, status: 'failed', reason: 'Invalid email address' }); continue; }
    if (!(ROLES as string[]).includes(rawRole)) { results.push({ row: rowNo, email, role: rawRole, status: 'failed', reason: 'Role must be admin, editor or viewer' }); continue; }
    if (seen.has(email)) { results.push({ row: rowNo, email, role: rawRole, status: 'failed', reason: 'Duplicate email in file' }); continue; }
    seen.add(email);
    try {
      const r = await addOrInvite(orgId, email, rawRole as Role, actor);
      results.push({ row: rowNo, email, role: rawRole, status: r.status, ...(r.link ? { link: r.link } : {}), ...(r.email_error ? { reason: r.email_error } : {}) });
    } catch (err) {
      results.push({ row: rowNo, email, role: rawRole, status: 'failed', reason: (err as Error).message });
    }
  }
  return results;
}

// ---- Router ------------------------------------------------------------------------------------

/**
 * Members & invitations endpoints for one organization, mounted at
 *   /api/orgs/current            (org admins; the active org; can't change/remove themselves)
 *   /api/admin/orgs/:orgId       (super admins; any org)
 */
export function membersRouter(opts: {
  orgId: (c: Context<AppEnv>) => string;
  guard: MiddlewareHandler<AppEnv>[];
  /** Block changes to the caller's own membership. */
  protectSelf: boolean;
}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  for (const g of opts.guard) r.use('*', g);
  const actor = (c: Context<AppEnv>) => ({ id: c.get('user').id, name: c.get('profile').display_name || c.get('profile').email });
  const assertNotSelf = (c: Context<AppEnv>, ids: string[], what: string) => {
    if (opts.protectSelf && ids.includes(c.get('user').id)) throw forbidden(`You can't ${what} yourself`);
  };
  const userIdsFrom = (body: Record<string, unknown>): string[] => {
    const ids = Array.isArray(body.user_ids) ? body.user_ids.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length) throw badRequest('user_ids is required');
    return [...new Set(ids)];
  };

  r.get('/members', async (c) => c.json(await listMembers(opts.orgId(c))));

  // Add an existing account or send an invitation.
  r.post('/members', async (c) => {
    const body = await readJson(c);
    const email = normalizeEmail(body.email);
    if (!email) throw badRequest('A valid email address is required');
    const role = parseRole(body.role, 'viewer');
    return c.json(await addOrInvite(opts.orgId(c), email, role, actor(c)));
  });

  // Bulk role change: { user_ids, role }
  r.patch('/members', async (c) => {
    const body = await readJson(c);
    const ids = userIdsFrom(body);
    const role = parseRole(body.role);
    assertNotSelf(c, ids, 'change the role of');
    const updated = must(await db().from('org_members').update({ role }).eq('org_id', opts.orgId(c)).in('user_id', ids).select('user_id')) ?? [];
    return c.json({ updated: updated.length });
  });

  r.patch('/members/:userId', async (c) => {
    const userId = c.req.param('userId');
    const role = parseRole((await readJson(c)).role);
    assertNotSelf(c, [userId], 'change the role of');
    const updated = must(await db().from('org_members').update({ role }).eq('org_id', opts.orgId(c)).eq('user_id', userId).select('user_id')) ?? [];
    if (!updated.length) throw notFound('Member');
    return c.json({ updated: 1 });
  });

  // Bulk removal: { user_ids }
  r.post('/members/remove', async (c) => {
    const ids = userIdsFrom(await readJson(c));
    assertNotSelf(c, ids, 'remove');
    return c.json({ removed: await removeMembers(opts.orgId(c), ids, c.get('user').id) });
  });

  r.delete('/members/:userId', async (c) => {
    const userId = c.req.param('userId');
    assertNotSelf(c, [userId], 'remove');
    const removed = await removeMembers(opts.orgId(c), [userId], c.get('user').id);
    if (!removed) throw notFound('Member');
    return c.json({ removed });
  });

  r.get('/members/import-template', (c) =>
    c.body(IMPORT_TEMPLATE, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="members-template.csv"' }),
  );

  // CSV import: JSON { csv } or multipart form with a `file` field.
  r.post('/members/import', async (c) => {
    let csv: string | null = null;
    if ((c.req.header('Content-Type') || '').includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      if (file && typeof file !== 'string') csv = await file.text();
    } else {
      csv = str((await readJson(c)).csv);
    }
    if (!csv) throw badRequest('Upload a CSV file with email,role columns');
    const results = await importMembers(opts.orgId(c), csv, actor(c));
    const summary = { added: 0, already_member: 0, invited: 0, invited_no_email: 0, failed: 0 };
    for (const row of results) summary[row.status]++;
    return c.json({ summary, results });
  });

  r.get('/invites', async (c) => {
    const rows = must(
      await db()
        .from('org_invites')
        .select('id, email, role, status, expires_at, email_sent, created_at, accepted_at, inviter:profiles!org_invites_inviter_profile_fk(email, display_name)')
        .eq('org_id', opts.orgId(c))
        .order('created_at', { ascending: false })
        .limit(200),
    ) as unknown as { id: string; email: string; role: Role; status: string; expires_at: string; email_sent: boolean; created_at: string; accepted_at: string | null; inviter: { email: string | null; display_name: string | null } | null }[];
    return c.json(
      rows.map((row) => ({
        id: row.id, email: row.email, role: row.role, status: inviteStatus(row), expires_at: row.expires_at,
        email_sent: row.email_sent, created_at: row.created_at, accepted_at: row.accepted_at,
        invited_by: row.inviter?.display_name || row.inviter?.email || null,
      })),
    );
  });

  // Resend: a fresh token; the old link stops working.
  r.post('/invites/:inviteId/resend', async (c) => {
    const { data: invite } = await db().from('org_invites').select('id, email, role, status').eq('id', c.req.param('inviteId')).eq('org_id', opts.orgId(c)).maybeSingle();
    if (!invite) throw notFound('Invitation');
    if (invite.status === 'accepted') throw new ApiError('conflict', 'This invitation was already accepted');
    return c.json(await createInvite(opts.orgId(c), invite.email, invite.role as Role, actor(c)));
  });

  r.delete('/invites/:inviteId', async (c) => {
    const updated = must(
      await db().from('org_invites').update({ status: 'revoked' }).eq('id', c.req.param('inviteId')).eq('org_id', opts.orgId(c)).eq('status', 'pending').select('id'),
    ) ?? [];
    if (!updated.length) throw notFound('Pending invitation');
    return c.json({ revoked: true });
  });

  return r;
}
