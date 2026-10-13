// Invitation preview (public) and acceptance (signed in).
import { Hono, type Context } from 'hono';
import type { AppEnv, Role } from '../lib/types.ts';
import { db } from '../lib/supabase.ts';
import { readJson, str } from '../lib/http.ts';
import { publicLogoUrl } from '../lib/storage.ts';
import { addMember, hashToken, inviteStatus } from '../lib/account-members.ts';

const router = new Hono<AppEnv>();

interface InviteRow {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  status: string;
  expires_at: string;
  accepted_by: string | null;
  org: { name: string; logo_path: string | null } | null;
  inviter: { email: string | null; display_name: string | null } | null;
}

async function findInvite(token: string | null): Promise<InviteRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const { data } = await db()
    .from('org_invites')
    .select('id, org_id, email, role, status, expires_at, accepted_by, org:organizations(name, logo_path), inviter:profiles!org_invites_inviter_profile_fk(email, display_name)')
    .eq('token_hash', await hashToken(token))
    .maybeSingle();
  return (data as unknown as InviteRow | null) ?? null;
}

/** Invite errors carry their own codes so the accept page can explain each case. */
function inviteError(c: Context<AppEnv>, status: 403 | 404 | 409 | 410, code: string, error: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, code, ...extra }, status);
}

// GET /api/invites/preview/:token — public.
router.get('/preview/:token', async (c) => {
  const invite = await findInvite(c.req.param('token'));
  if (!invite) return inviteError(c, 404, 'invite_invalid', 'This invitation link is not valid.');
  return c.json({
    org_name: invite.org?.name ?? null,
    org_logo_url: publicLogoUrl(invite.org?.logo_path ?? null),
    email: invite.email,
    role: invite.role,
    status: inviteStatus(invite),
    expires_at: invite.expires_at,
    invited_by: invite.inviter?.display_name || invite.inviter?.email || null,
  });
});

// POST /api/invites/accept — { token }
router.post('/accept', async (c) => {
  const user = c.get('user');
  const invite = await findInvite(str((await readJson(c)).token));
  if (!invite) return inviteError(c, 404, 'invite_invalid', 'This invitation link is not valid.');
  const status = inviteStatus(invite);
  if (status === 'revoked') return inviteError(c, 410, 'invite_revoked', 'This invitation was revoked or replaced by a newer one. Ask an administrator to send a new one.');
  if (status === 'accepted') {
    if (invite.accepted_by === user.id) return c.json({ org_id: invite.org_id, org_name: invite.org?.name ?? null, already_accepted: true });
    return inviteError(c, 409, 'invite_used', 'This invitation has already been used.');
  }
  if (status === 'expired') return inviteError(c, 410, 'invite_expired', 'This invitation has expired. Ask an administrator to send a new one.');
  if ((user.email ?? '').toLowerCase() !== invite.email.toLowerCase()) {
    return inviteError(c, 403, 'invite_wrong_account', `This invitation is for ${invite.email}, but you are signed in as ${user.email}.`, { invited_email: invite.email });
  }

  await addMember(invite.org_id, user.id, invite.role, invite.email);
  await db()
    .from('org_invites')
    .update({ status: 'accepted', accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq('id', invite.id)
    .eq('status', 'pending');
  return c.json({ org_id: invite.org_id, org_name: invite.org?.name ?? null, role: invite.role });
});

export default router;
