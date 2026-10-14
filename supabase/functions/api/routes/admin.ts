// Super admin settings: AI model, email provider, users, organizations, email domains.
import { Hono, type Context } from 'hono';
import type { User } from '@supabase/supabase-js';
import type { AppEnv, Role } from '../lib/types.ts';
import { requireSuperAdmin } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, forbidden, notFound, readJson, str } from '../lib/http.ts';
import { DEFAULT_MODEL, getModel, SUPPORTED_MODELS } from '../lib/ai.ts';
import { setSecret, setSetting, SECRETS, SETTINGS } from '../lib/settings.ts';
import { emailConfigured, getEmailSettings, renderEmail, sendEmail, sendgridKeyStatus, type EmailSettings } from '../lib/email.ts';
import { env } from '../lib/env.ts';
import { publicLogoUrl, removePaths } from '../lib/storage.ts';
import { loadOrg, membersRouter, normalizeEmail, parseRole, removeMembers, addMember } from '../lib/account-members.ts';
import { CURRENCIES, orgDataCounts } from '../lib/account-orgs.ts';
import { applyDomainToExistingUsers, claimableDomain } from '../lib/account-domains.ts';
import { signInProviders } from './me.ts';

const router = new Hono<AppEnv>();
router.use('*', requireSuperAdmin);

// ---- AI model & email ------------------------------------------------------------------------

router.get('/settings', async (c) => {
  return c.json({
    ai_model: await getModel(),
    default_model: DEFAULT_MODEL,
    models: SUPPORTED_MODELS,
    ai_configured: Boolean(env.anthropicApiKey),
    email: await getEmailSettings(),
    ...(await sendgridKeyStatus()),
    email_configured: await emailConfigured(),
  });
});

router.put('/settings/ai-model', async (c) => {
  const model = str((await readJson(c)).model);
  if (!model || !SUPPORTED_MODELS.some((m) => m.id === model)) throw badRequest('Unsupported model');
  await setSetting(SETTINGS.aiModel, model, c.get('user').id);
  return c.json({ ai_model: model });
});

router.put('/settings/email', async (c) => {
  const body = await readJson(c);
  const provider = body.provider === 'sendgrid' ? 'sendgrid' : body.provider === 'default' ? 'default' : null;
  if (!provider) throw badRequest('Provider must be default or sendgrid');
  const fromName = (str(body.from_name) ?? 'Lease IQ').slice(0, 100);
  const fromEmail = str(body.from_email)?.toLowerCase() ?? '';
  if (provider === 'sendgrid' && !normalizeEmail(fromEmail)) throw badRequest('A valid sender address is required for SendGrid');
  // sendgrid_api_key: a new key to save; omitted or empty keeps the saved one. clear_sendgrid_api_key removes it.
  const apiKey = str(body.sendgrid_api_key)?.trim();
  if (apiKey && (!apiKey.startsWith('SG.') || apiKey.length > 200 || /\s/.test(apiKey))) {
    throw badRequest('That does not look like a SendGrid API key (it should start with "SG.")');
  }
  const value: EmailSettings = { provider, from_name: fromName, from_email: fromEmail };
  await setSetting(SETTINGS.email, value, c.get('user').id);
  if (apiKey) await setSecret(SECRETS.sendgridApiKey, apiKey, c.get('user').id);
  else if (body.clear_sendgrid_api_key === true) await setSecret(SECRETS.sendgridApiKey, null, c.get('user').id);
  return c.json({ email: value, ...(await sendgridKeyStatus()), email_configured: await emailConfigured() });
});

router.post('/settings/email/test', async (c) => {
  const to = normalizeEmail((await readJson(c)).to) ?? c.get('user').email;
  if (!to) throw badRequest('Recipient required');
  try {
    await sendEmail({
      to: [to],
      subject: 'Lease IQ test email',
      html: renderEmail({ title: 'Email is working', bodyHtml: '<p>This is a test message from Lease IQ. Your email settings are working.</p>' }),
      text: 'This is a test message from Lease IQ. Your email settings are working.',
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw badRequest((err as Error).message);
  }
  return c.json({ sent: true, to });
});

// ---- Users -----------------------------------------------------------------------------------

async function allAuthUsers(): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    users.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return users;
}

async function membershipsByUser(userIds?: string[]) {
  let q = db().from('org_members').select('user_id, role, org:organizations(id, name)');
  if (userIds) q = q.in('user_id', userIds);
  const rows = must(await q) as unknown as { user_id: string; role: Role; org: { id: string; name: string } | null }[];
  const map = new Map<string, { org_id: string; org_name: string; role: Role }[]>();
  for (const r of rows) {
    if (!r.org) continue;
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id)!.push({ org_id: r.org.id, org_name: r.org.name, role: r.role });
  }
  return map;
}

function userView(u: User, profile: { display_name: string | null; is_super_admin: boolean } | undefined, orgs: { org_id: string; org_name: string; role: Role }[]) {
  return {
    id: u.id,
    email: u.email ?? null,
    display_name: profile?.display_name ?? null,
    is_super_admin: Boolean(profile?.is_super_admin),
    providers: signInProviders(u),
    email_confirmed: Boolean(u.email_confirmed_at),
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
    orgs: orgs.sort((a, b) => a.org_name.localeCompare(b.org_name)),
  };
}

async function oneUser(id: string) {
  const { data, error } = await db().auth.admin.getUserById(id);
  if (error || !data?.user) throw notFound('User');
  const { data: profile } = await db().from('profiles').select('display_name, is_super_admin').eq('id', id).maybeSingle();
  const orgs = (await membershipsByUser([id])).get(id) ?? [];
  return userView(data.user, profile ?? undefined, orgs);
}

// GET /api/admin/users?search=
router.get('/users', async (c) => {
  const search = (c.req.query('search') || '').trim().toLowerCase();
  const users = await allAuthUsers();
  const { data: profiles } = await db().from('profiles').select('id, display_name, is_super_admin');
  const pmap = new Map((profiles ?? []).map((p) => [p.id as string, p as { display_name: string | null; is_super_admin: boolean }]));
  const memberships = await membershipsByUser();
  const list = users
    .map((u) => userView(u, pmap.get(u.id), memberships.get(u.id) ?? []))
    .filter((u) => !search || (u.email ?? '').toLowerCase().includes(search) || (u.display_name ?? '').toLowerCase().includes(search) ||
      u.orgs.some((o) => o.org_name.toLowerCase().includes(search)))
    .sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));
  return c.json(list);
});

function parseMemberships(value: unknown): { org_id: string; role: Role }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('orgs must be a list of { org_id, role }');
  const seen = new Set<string>();
  const out: { org_id: string; role: Role }[] = [];
  for (const m of value as Record<string, unknown>[]) {
    const orgId = str(m?.org_id);
    if (!orgId) throw badRequest('org_id is required');
    if (seen.has(orgId)) continue;
    seen.add(orgId);
    out.push({ org_id: orgId, role: parseRole(m.role) });
  }
  return out;
}

async function setMemberships(c: Context<AppEnv>, userId: string, email: string | null, wanted: { org_id: string; role: Role }[]) {
  if (wanted.length) {
    const { data: orgs } = await db().from('organizations').select('id').in('id', wanted.map((w) => w.org_id));
    if ((orgs ?? []).length !== wanted.length) throw badRequest('Unknown organization');
  }
  const current = must(await db().from('org_members').select('org_id, role').eq('user_id', userId)) as { org_id: string; role: Role }[];
  for (const cur of current) {
    const next = wanted.find((w) => w.org_id === cur.org_id);
    if (!next) await removeMembers(cur.org_id, [userId], c.get('user').id);
    else if (next.role !== cur.role) must(await db().from('org_members').update({ role: next.role }).eq('org_id', cur.org_id).eq('user_id', userId));
  }
  for (const w of wanted) {
    if (!current.some((cur) => cur.org_id === w.org_id)) await addMember(w.org_id, userId, w.role, email);
  }
  // Keep the default org valid.
  const { data: profile } = await db().from('profiles').select('default_org_id').eq('id', userId).maybeSingle();
  if (profile?.default_org_id && !wanted.some((w) => w.org_id === profile.default_org_id)) {
    await db().from('profiles').update({ default_org_id: wanted[0]?.org_id ?? null }).eq('id', userId);
  }
}

// POST /api/admin/users — { email, password, display_name?, is_super_admin?, orgs?: [{org_id, role}] }
router.post('/users', async (c) => {
  const body = await readJson(c);
  const email = normalizeEmail(body.email);
  if (!email) throw badRequest('A valid email address is required');
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 6) throw badRequest('The password must be at least 6 characters');
  const displayName = str(body.display_name);
  const memberships = parseMemberships(body.orgs);

  const { data, error } = await db().auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: displayName ? { full_name: displayName } : {},
  });
  if (error || !data.user) {
    const msg = error?.message ?? 'Could not create user';
    throw new ApiError(/already|registered|exists/i.test(msg) ? 'conflict' : 'bad_request', msg);
  }
  const id = data.user.id;
  must(await db().from('profiles').upsert({ id, email, display_name: displayName, is_super_admin: body.is_super_admin === true }));
  await setMemberships(c, id, email, memberships);
  return c.json(await oneUser(id), 201);
});

router.get('/users/:id', async (c) => c.json(await oneUser(c.req.param('id'))));

// PATCH /api/admin/users/:id — { email?, password?, display_name?, is_super_admin? }
router.patch('/users/:id', async (c) => {
  const id = c.req.param('id');
  const self = id === c.get('user').id;
  const body = await readJson(c);
  const authUpdate: { email?: string; password?: string; email_confirm?: boolean } = {};
  if ('email' in body) {
    const email = normalizeEmail(body.email);
    if (!email) throw badRequest('A valid email address is required');
    authUpdate.email = email;
    authUpdate.email_confirm = true;
  }
  if ('password' in body && body.password !== '' && body.password !== null) {
    if (typeof body.password !== 'string' || body.password.length < 6) throw badRequest('The password must be at least 6 characters');
    authUpdate.password = body.password;
  }
  if (Object.keys(authUpdate).length) {
    const { error } = await db().auth.admin.updateUserById(id, authUpdate);
    if (error) throw new ApiError(/already|registered|exists/i.test(error.message) ? 'conflict' : 'bad_request', error.message);
  }
  const profileUpdate: Record<string, unknown> = {};
  if ('display_name' in body) profileUpdate.display_name = str(body.display_name);
  if ('is_super_admin' in body) {
    if (self && body.is_super_admin !== true) throw forbidden("You can't remove your own super admin access");
    profileUpdate.is_super_admin = body.is_super_admin === true;
  }
  if (authUpdate.email) profileUpdate.email = authUpdate.email;
  if (Object.keys(profileUpdate).length) must(await db().from('profiles').update(profileUpdate).eq('id', id));
  return c.json(await oneUser(id));
});

// PUT /api/admin/users/:id/orgs — { orgs: [{org_id, role}] } replaces the user's memberships.
router.put('/users/:id/orgs', async (c) => {
  const id = c.req.param('id');
  const user = await oneUser(id);
  await setMemberships(c, id, user.email, parseMemberships((await readJson(c)).orgs));
  return c.json(await oneUser(id));
});

// DELETE /api/admin/users/:id — deletes the account (memberships, chats, profile cascade).
router.delete('/users/:id', async (c) => {
  const id = c.req.param('id');
  if (id === c.get('user').id) throw forbidden("You can't delete your own account");
  const { error } = await db().auth.admin.deleteUser(id);
  if (error) throw new ApiError(/not.?found/i.test(error.message) ? 'not_found' : 'bad_request', error.message);
  return c.json({ deleted: true });
});

// ---- Organizations ---------------------------------------------------------------------------

router.get('/orgs', async (c) => {
  const orgs = must(await db().from('organizations').select('id, name, currency, logo_path, created_at').order('name')) as
    { id: string; name: string; currency: string; logo_path: string | null; created_at: string }[];
  const { data: domains } = await db().from('org_domains').select('org_id, domain');
  const countOf = async (table: string, orgId: string) =>
    (await db().from(table).select('*', { count: 'exact', head: true }).eq('org_id', orgId)).count ?? 0;
  return c.json(
    await Promise.all(orgs.map(async (o) => ({
      id: o.id, name: o.name, currency: o.currency, logo_url: publicLogoUrl(o.logo_path), created_at: o.created_at,
      member_count: await countOf('org_members', o.id),
      lease_count: await countOf('leases', o.id),
      file_count: await countOf('lease_files', o.id),
      document_count: await countOf('documents', o.id),
      domains: (domains ?? []).filter((d) => d.org_id === o.id).map((d) => d.domain as string),
    }))),
  );
});

router.post('/orgs', async (c) => {
  const body = await readJson(c);
  const name = str(body.name);
  if (!name) throw badRequest('Organization name is required');
  const currency = (str(body.currency) ?? 'USD').toUpperCase();
  if (!CURRENCIES.includes(currency)) throw badRequest('Unsupported currency');
  const org = must(await db().from('organizations').insert({ name: name.slice(0, 120), currency, created_by: c.get('user').id }).select('id, name, currency').single()) as { id: string; name: string; currency: string };
  if (body.add_me === true) await addMember(org.id, c.get('user').id, 'admin', c.get('user').email ?? null);
  return c.json(org, 201);
});

router.patch('/orgs/:id', async (c) => {
  const id = c.req.param('id');
  await loadOrg(id);
  const body = await readJson(c);
  const update: Record<string, string> = {};
  if ('name' in body) {
    const name = str(body.name);
    if (!name) throw badRequest('Organization name is required');
    update.name = name.slice(0, 120);
  }
  if ('currency' in body) {
    const currency = str(body.currency)?.toUpperCase();
    if (!currency || !CURRENCIES.includes(currency)) throw badRequest('Unsupported currency');
    update.currency = currency;
  }
  if (!Object.keys(update).length) throw badRequest('Nothing to update');
  return c.json(must(await db().from('organizations').update(update).eq('id', id).select('id, name, currency').single()));
});

router.delete('/orgs/:id', async (c) => {
  const id = c.req.param('id');
  const org = await loadOrg(id);
  const counts = await orgDataCounts(id);
  if (counts.leases || counts.lease_files || counts.documents) {
    return c.json({
      error: `${org.name} still holds data (${counts.lease_files} files, ${counts.documents} documents, ${counts.leases} leases). Delete its leases first.`,
      code: 'conflict',
      counts,
    }, 409);
  }
  must(await db().from('organizations').delete().eq('id', id));
  if (org.logo_path) await removePaths([org.logo_path], env.logoBucket);
  return c.json({ deleted: true });
});

// Members & invitations of any org: /api/admin/orgs/:orgId/members..., /invites...
router.use('/orgs/:orgId/*', async (c, next) => {
  await loadOrg(c.req.param('orgId'));
  await next();
});
router.route('/orgs/:orgId', membersRouter({ orgId: (c) => c.req.param('orgId') as string, guard: [], protectSelf: false }));

// ---- Email domains ---------------------------------------------------------------------------

const DOMAIN_COLUMNS = 'id, org_id, domain, default_role, ms_tenant_id, created_at, org:organizations(name)';

function domainView(d: Record<string, unknown>) {
  const org = d.org as { name: string } | null;
  return { id: d.id, org_id: d.org_id, org_name: org?.name ?? null, domain: d.domain, default_role: d.default_role, ms_tenant_id: d.ms_tenant_id, created_at: d.created_at };
}

function tenantId(value: unknown): string | null {
  const t = str(value)?.toLowerCase() ?? null;
  if (t && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) throw badRequest('The Microsoft tenant ID must be a GUID');
  return t;
}

router.get('/domains', async (c) => {
  const rows = must(await db().from('org_domains').select(DOMAIN_COLUMNS).order('domain')) as Record<string, unknown>[];
  return c.json(rows.map(domainView));
});

router.post('/domains', async (c) => {
  const body = await readJson(c);
  const domain = claimableDomain(body.domain);
  const orgId = str(body.org_id);
  if (!orgId) throw badRequest('Choose an organization');
  await loadOrg(orgId);
  const { data: existing } = await db().from('org_domains').select('id, org:organizations(name)').eq('domain', domain).maybeSingle();
  if (existing) throw new ApiError('conflict', `${domain} is already claimed`);
  const row = must(
    await db()
      .from('org_domains')
      .insert({ domain, org_id: orgId, default_role: parseRole(body.default_role, 'viewer'), ms_tenant_id: tenantId(body.ms_tenant_id), created_by: c.get('user').id })
      .select(DOMAIN_COLUMNS)
      .single(),
  ) as Record<string, unknown>;
  return c.json(domainView(row), 201);
});

router.patch('/domains/:id', async (c) => {
  const body = await readJson(c);
  const update: Record<string, unknown> = {};
  if ('default_role' in body) update.default_role = parseRole(body.default_role);
  if ('ms_tenant_id' in body) update.ms_tenant_id = tenantId(body.ms_tenant_id);
  if ('org_id' in body) {
    const orgId = str(body.org_id);
    if (!orgId) throw badRequest('Choose an organization');
    await loadOrg(orgId);
    update.org_id = orgId;
  }
  if (!Object.keys(update).length) throw badRequest('Nothing to update');
  const rows = must(await db().from('org_domains').update(update).eq('id', c.req.param('id')).select(DOMAIN_COLUMNS)) as Record<string, unknown>[];
  if (!rows.length) throw notFound('Domain');
  return c.json(domainView(rows[0]));
});

router.delete('/domains/:id', async (c) => {
  const rows = must(await db().from('org_domains').delete().eq('id', c.req.param('id')).select('id')) ?? [];
  if (!rows.length) throw notFound('Domain');
  return c.json({ deleted: true });
});

// POST /api/admin/domains/:id/apply — "Add existing users"
router.post('/domains/:id/apply', async (c) => {
  const { data } = await db().from('org_domains').select('id, org_id, domain, default_role, ms_tenant_id').eq('id', c.req.param('id')).maybeSingle();
  if (!data) throw notFound('Domain');
  return c.json(await applyDomainToExistingUsers(data as { id: string; org_id: string; domain: string; default_role: Role; ms_tenant_id: string | null }));
});

export default router;
