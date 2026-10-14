// End-to-end checks for the account & administration API (routes/me, orgs, invites, admin, usage, support).
// Usage: start the API (PORT=3101 node src/server.ts), then: node scripts/account-smoke-test.mjs [http://localhost:3101]
// Creates temporary users/orgs/invites named acct-test-* and deletes them at the end.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const BASE = (process.argv[2] || 'http://localhost:3101').replace(/\/$/, '') + '/api';
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const RUN = Date.now().toString(36);
const TEST_DOMAIN = `acct-test-${RUN}.example.com`;
const mail = (name) => `acct-test-${name}-${RUN}@leaseiq.test`;
const PW = 'Test-pass-123!';

const ACCOUNTS = {
  admin: ['admin@leaseiq.test', '^YUzs&5UbtxijHFa'],
  manager: ['manager@leaseiq.test', 'VgVmJKg7z&!^TQ9W'],
  analyst: ['analyst@leaseiq.test', 'FcY6N!P&fwS4nkS*'],
};

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`); }
}

async function token(email, password) {
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, opts);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return data.session.access_token;
}

function caller(tok, orgId) {
  return async (method, path, body, extra = {}) => {
    const headers = { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(orgId ? { 'X-Org-Id': orgId } : {}), ...extra };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}

const created = { users: [], orgs: [], domains: [] };
let demoId;

try {
  console.log(`API ${BASE}`);
  const tAdmin = await token(...ACCOUNTS.admin);
  const tManager = await token(...ACCOUNTS.manager);
  const tAnalyst = await token(...ACCOUNTS.analyst);

  // ---------------------------------------------------------------- me
  console.log('\n/me');
  const superApi = caller(tAdmin);
  let r = await superApi('GET', '/me');
  check('GET /me (super admin)', r.status === 200 && r.json.profile.is_super_admin === true, r.json);
  demoId = r.json.orgs.find((o) => o.name === 'Demo Portfolio')?.id;
  check('Demo Portfolio visible', Boolean(demoId));
  check('GET /me has providers/last sign-in', Array.isArray(r.json.user.providers) && 'last_sign_in_at' in r.json.user);

  const sa = caller(tAdmin, demoId);
  const mgr = caller(tManager, demoId);
  const ana = caller(tAnalyst, demoId);
  r = await mgr('GET', '/me');
  const mgrRole = r.json.orgs.find((o) => o.id === demoId)?.role;
  r = await ana('GET', '/me');
  const anaRole = r.json.orgs.find((o) => o.id === demoId)?.role;
  console.log(`  manager role in Demo: ${mgrRole}, analyst role: ${anaRole}`);
  const origName = r.json.profile.display_name;
  const origLocale = r.json.profile.locale;

  r = await ana('PATCH', '/me', { display_name: 'Analyst Test Name' });
  check('PATCH /me display_name', r.status === 200 && r.json.profile.display_name === 'Analyst Test Name', r.json);
  r = await ana('PATCH', '/me', { locale: 'xx' });
  check('PATCH /me bad locale -> 400', r.status === 400);
  r = await ana('PATCH', '/me', { locale: 'de' });
  check('PATCH /me locale', r.status === 200 && r.json.profile.locale === 'de');
  r = await ana('PATCH', '/me', { default_org_id: '00000000-0000-0000-0000-000000000000' });
  check('PATCH /me default org not a member -> 400', r.status === 400);
  await ana('PATCH', '/me', { display_name: origName, locale: origLocale });
  r = await ana('POST', '/me/password', { current_password: 'wrong-password', new_password: 'whatever1' });
  check('POST /me/password wrong current -> 403', r.status === 403, r.json);
  r = await ana('POST', '/me/password', { current_password: ACCOUNTS.analyst[1], new_password: '123' });
  check('POST /me/password too short -> 400', r.status === 400);

  // A non-super org admin for the Demo org (test user).
  console.log('\nadmin users');
  r = await sa('POST', '/admin/users', { email: mail('orgadmin'), password: PW, display_name: 'Acct Test Org Admin', orgs: [{ org_id: demoId, role: 'admin' }] });
  check('POST /admin/users create org admin', r.status === 201 && r.json.orgs[0]?.role === 'admin', r.json);
  const orgAdminId = r.json?.id;
  if (orgAdminId) created.users.push(orgAdminId);
  r = await sa('POST', '/admin/users', { email: mail('orgadmin'), password: PW });
  check('POST /admin/users duplicate -> 409', r.status === 409, r.json);
  r = await mgr('GET', '/admin/users');
  check('GET /admin/users as editor -> 403', r.status === 403);
  r = await sa('GET', `/admin/users?search=${encodeURIComponent('acct-test-orgadmin')}`);
  check('GET /admin/users search', r.status === 200 && r.json.length === 1 && r.json[0].email === mail('orgadmin'), r.json);
  r = await sa('PATCH', `/admin/users/${orgAdminId}`, { display_name: 'Renamed Admin' });
  check('PATCH /admin/users display name', r.status === 200 && r.json.display_name === 'Renamed Admin', r.json);
  const me = (await superApi('GET', '/me')).json.user.id;
  r = await sa('PATCH', `/admin/users/${me}`, { is_super_admin: false });
  check('super admin cannot demote self -> 403', r.status === 403);
  r = await sa('DELETE', `/admin/users/${me}`);
  check('super admin cannot delete self -> 403', r.status === 403);

  // Password change with correct current password (on the test user).
  const tOld = await token(mail('orgadmin'), PW);
  r = await caller(tOld)('POST', '/me/password', { current_password: PW, new_password: PW + 'x' });
  check('POST /me/password correct current', r.status === 200 && r.json.sessions_revoked === true, r.json);
  r = await caller(tOld)('GET', '/me');
  check('old session revoked after password change (Supabase behaviour)', r.status === 401);
  const tOrgAdmin = await token(mail('orgadmin'), PW + 'x').catch(() => null);
  check('sign in with new password', Boolean(tOrgAdmin));
  const oa = caller(tOrgAdmin, demoId);

  // ---------------------------------------------------------------- orgs
  console.log('\n/orgs/current');
  r = await ana('GET', '/orgs/current');
  check('GET /orgs/current as viewer', r.status === 200 && r.json.id === demoId && r.json.currencies.length === 21, r.json);
  r = await ana('PATCH', '/orgs/current', { name: 'x' });
  check('PATCH /orgs/current as viewer -> 403', r.status === 403);
  r = await mgr('PATCH', '/orgs/current', { name: 'x' });
  check('PATCH /orgs/current as editor -> 403', r.status === 403);
  const demo = (await oa('GET', '/orgs/current')).json;
  r = await oa('PATCH', '/orgs/current', { name: 'Demo Portfolio (test)', currency: 'EUR' });
  check('PATCH /orgs/current as org admin', r.status === 200 && r.json.name === 'Demo Portfolio (test)' && r.json.currency === 'EUR', r.json);
  r = await oa('PATCH', '/orgs/current', { currency: 'XYZ' });
  check('PATCH bad currency -> 400', r.status === 400);
  await oa('PATCH', '/orgs/current', { name: demo.name, currency: demo.currency });
  r = await oa('GET', '/orgs/current');
  check('org restored', r.json.name === demo.name && r.json.currency === demo.currency);
  r = await ana('GET', '/orgs/current/members');
  check('GET members as viewer -> 403', r.status === 403);
  r = await mgr('GET', '/orgs/current/invites');
  check('GET invites as editor -> 403', r.status === 403);
  r = await oa('GET', '/orgs/current/members');
  check('GET members as org admin', r.status === 200 && r.json.some((m) => m.user_id === orgAdminId), r.json);
  r = await oa('PATCH', `/orgs/current/members/${orgAdminId}`, { role: 'viewer' });
  check('org admin cannot change own role -> 403', r.status === 403);
  r = await oa('DELETE', `/orgs/current/members/${orgAdminId}`);
  check('org admin cannot remove self -> 403', r.status === 403);
  r = await oa('POST', '/orgs/current/members/remove', { user_ids: [orgAdminId] });
  check('org admin cannot bulk-remove self -> 403', r.status === 403);

  // ---------------------------------------------------------------- invites
  console.log('\ninvites');
  const invitee = mail('invitee');
  r = await oa('POST', '/orgs/current/members', { email: invitee, role: 'editor' });
  check('add-or-invite new email -> invited_no_email + link', r.status === 200 && r.json.status === 'invited_no_email' && r.json.link?.includes('/invite/'), r.json);
  const link1 = r.json.link;
  const token1 = link1.split('/invite/')[1];
  r = await caller(null)('GET', `/invites/preview/${token1}`);
  check('public preview', r.status === 200 && r.json.status === 'pending' && r.json.email === invitee && r.json.org_name === demo.name, r.json);
  r = await caller(null)('GET', '/invites/preview/not-a-real-token-1234567890');
  check('preview invalid -> 404 invite_invalid', r.status === 404 && r.json.code === 'invite_invalid');
  r = await caller(tAnalyst)('POST', '/invites/accept', { token: token1 });
  check('accept with wrong account -> 403 invite_wrong_account', r.status === 403 && r.json.code === 'invite_wrong_account', r.json);
  r = await caller(null)('POST', '/invites/accept', { token: token1 });
  check('accept signed out -> 401', r.status === 401);

  // Resend: new token, old stops working
  const invites = (await oa('GET', '/orgs/current/invites')).json;
  const inv = invites.find((i) => i.email === invitee && i.status === 'pending');
  check('invite listed as pending', Boolean(inv), invites);
  r = await oa('POST', `/orgs/current/invites/${inv.id}/resend`);
  check('resend -> new link', r.status === 200 && r.json.link && r.json.link !== link1, r.json);
  const token2 = r.json.link.split('/invite/')[1];
  r = await caller(null)('GET', `/invites/preview/${token1}`);
  check('old link revoked after resend', r.json.status === 'revoked', r.json);

  // Accept with the right account
  r = await sa('POST', '/admin/users', { email: invitee, password: PW });
  check('create invitee account (no orgs)', r.status === 201, r.json);
  if (r.json?.id) created.users.push(r.json.id);
  const inviteeId = r.json?.id;
  const tInvitee = await token(invitee, PW);
  r = await caller(tInvitee)('POST', '/invites/accept', { token: token1 });
  check('accept old (revoked) token -> 410 invite_revoked', r.status === 410 && r.json.code === 'invite_revoked', r.json);
  r = await caller(tInvitee)('POST', '/invites/accept', { token: token2 });
  check('accept with matching account', r.status === 200 && r.json.org_id === demoId && r.json.role === 'editor', r.json);
  r = await caller(tInvitee)('GET', '/me');
  check('invitee now member with default org', r.json.orgs.some((o) => o.id === demoId && o.role === 'editor') && r.json.profile.default_org_id === demoId, r.json);
  r = await caller(tInvitee)('POST', '/invites/accept', { token: token2 });
  check('accept again by same user -> already_accepted', r.status === 200 && r.json.already_accepted === true, r.json);
  r = await caller(tOrgAdmin)('POST', '/invites/accept', { token: token2 });
  check('accept used invite by other -> 409 invite_used', r.status === 409 && r.json.code === 'invite_used', r.json);

  // Expired and revoked
  const expiredEmail = mail('expired');
  r = await oa('POST', '/orgs/current/members', { email: expiredEmail, role: 'viewer' });
  const tokenE = r.json.link.split('/invite/')[1];
  await svc.from('org_invites').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', r.json.invite_id);
  r = await caller(null)('GET', `/invites/preview/${tokenE}`);
  check('preview expired', r.json.status === 'expired', r.json);
  r = await caller(tAnalyst)('POST', '/invites/accept', { token: tokenE });
  check('accept expired -> 410 invite_expired', r.status === 410 && r.json.code === 'invite_expired', r.json);
  const revokeEmail = mail('revoke');
  r = await oa('POST', '/orgs/current/members', { email: revokeEmail, role: 'viewer' });
  const tokenR = r.json.link.split('/invite/')[1];
  r = await oa('DELETE', `/orgs/current/invites/${r.json.invite_id}`);
  check('revoke invite', r.status === 200);
  r = await caller(null)('GET', `/invites/preview/${tokenR}`);
  check('preview revoked', r.json.status === 'revoked');

  // Existing account -> added immediately
  r = await oa('POST', '/orgs/current/members', { email: ACCOUNTS.manager[0].toUpperCase(), role: 'viewer' });
  check('add existing member -> already_member', r.status === 200 && r.json.status === 'already_member', r.json);

  // ---------------------------------------------------------------- CSV import
  console.log('\nCSV import');
  r = await oa('GET', '/orgs/current/members/import-template');
  check('template download', r.status === 200 && r.text.startsWith('email,role') && /attachment/.test(r.headers.get('content-disposition') || ''));
  const csvUser = mail('csvuser');
  await sa('POST', '/admin/users', { email: csvUser, password: PW }).then((x) => x.json?.id && created.users.push(x.json.id));
  const csv = `email,role\n${csvUser},viewer\n${mail('csvinvite')},editor\nnot-an-email,viewer\n${mail('csvbadrole')},owner\n${ACCOUNTS.analyst[0]},viewer\n${mail('csvinvite')},viewer\n`;
  r = await oa('POST', '/orgs/current/members/import', { csv });
  const res = r.json?.results ?? [];
  check('import status 200', r.status === 200, r.json);
  check('import row: existing -> added', res[0]?.status === 'added', res[0]);
  check('import row: new -> invited_no_email', res[1]?.status === 'invited_no_email' && res[1]?.link, res[1]);
  check('import row: bad email -> failed', res[2]?.status === 'failed' && res[2]?.reason, res[2]);
  check('import row: bad role -> failed', res[3]?.status === 'failed', res[3]);
  check('import row: member -> already_member', res[4]?.status === 'already_member', res[4]);
  check('import row: duplicate -> failed', res[5]?.status === 'failed' && /Duplicate/.test(res[5]?.reason), res[5]);
  const form = new FormData();
  form.append('file', new Blob([`email,role\n${mail('csvform')},viewer\n`], { type: 'text/csv' }), 'members.csv');
  r = await oa('POST', '/orgs/current/members/import', form);
  check('import via multipart', r.status === 200 && r.json.results[0].status === 'invited_no_email', r.json);
  const big = 'email,role\n' + Array.from({ length: 501 }, (_, i) => `x${i}@example.com,viewer`).join('\n');
  r = await oa('POST', '/orgs/current/members/import', { csv: big });
  check('import > 500 rows -> 400', r.status === 400);

  // Bulk role change + bulk removal
  const csvUserId = (await svc.from('profiles').select('id').eq('email', csvUser).single()).data.id;
  r = await oa('PATCH', '/orgs/current/members', { user_ids: [csvUserId, inviteeId], role: 'editor' });
  check('bulk role change', r.status === 200 && r.json.updated === 2, r.json);
  r = await oa('POST', '/orgs/current/members/remove', { user_ids: [csvUserId] });
  check('bulk remove', r.status === 200 && r.json.removed === 1, r.json);
  const { data: removal } = await svc.from('org_member_removals').select('email').eq('org_id', demoId).eq('email', csvUser).maybeSingle();
  check('removal recorded', Boolean(removal));
  r = await oa('DELETE', `/orgs/current/members/${inviteeId}`);
  check('single remove', r.status === 200 && r.json.removed === 1, r.json);

  // ---------------------------------------------------------------- usage
  console.log('\nusage');
  r = await ana('GET', '/usage?days=30');
  check('usage as viewer -> 403', r.status === 403);
  r = await mgr('GET', '/usage?days=30');
  check('usage as editor -> 403', r.status === 403);
  r = await oa('GET', '/usage?days=30');
  check('usage as org admin', r.status === 200 && r.json.org_id === demoId && r.json.by_day.length === 30 && 'by_model' in r.json, r.json && { ...r.json, by_day: r.json.by_day?.length });
  // Synthetic usage rows (deleted right after) to check the aggregation.
  const today = new Date().toISOString();
  const { data: usageRows } = await svc.from('ai_usage').insert([
    { org_id: demoId, user_id: orgAdminId, process: 'chat', model: 'acct-test-model-a', input_tokens: 100, output_tokens: 50, cache_creation_tokens: 10, cache_read_tokens: 5, duration_ms: 1000, created_at: today },
    { org_id: demoId, user_id: orgAdminId, process: 'analysis', model: 'acct-test-model-a', input_tokens: 200, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0, duration_ms: 10, created_at: today },
    { org_id: demoId, user_id: null, process: 'insights', model: 'acct-test-model-b', input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0, duration_ms: 10, created_at: today },
  ]).select('id');
  check('insert synthetic usage', (usageRows ?? []).length === 3);
  r = await oa('GET', '/usage?days=1');
  const ma = r.json?.by_model?.find((m) => m.model === 'acct-test-model-a');
  check('usage aggregation by model incl. cache', ma && ma.calls === 2 && ma.input_tokens === 300 && ma.cache_creation_tokens === 10 && ma.cache_read_tokens === 5 && ma.total_tokens === 385, ma);
  check('usage by user (email) and by process', r.json?.by_user?.some((u) => u.email === mail('orgadmin') && u.calls === 2) && r.json?.by_process?.some((p) => p.process === 'insights'), r.json?.by_user);
  check('usage by day has today', r.json?.by_day?.[0]?.calls >= 3, r.json?.by_day);
  r = await oa('GET', '/usage/export?days=1');
  check('usage CSV contains rows', r.text.includes('acct-test-model-a') && r.text.includes(mail('orgadmin')));
  await svc.from('ai_usage').delete().in('id', (usageRows ?? []).map((x) => x.id));
  const otherOrg = (await superApi('GET', '/me')).json.orgs.find((o) => o.id !== demoId)?.id;
  r = await oa('GET', `/usage?days=30&org_id=${otherOrg}`);
  check('usage org admin other org -> 403', r.status === 403);
  r = await sa('GET', '/usage?from=2026-01-01&to=2026-12-31');
  check('usage super admin all orgs', r.status === 200 && r.json.org_id === null && r.json.by_day.length === 365, { status: r.status, org: r.json?.org_id, totals: r.json?.totals });
  console.log(`    totals: ${JSON.stringify(r.json?.totals)} models: ${r.json?.by_model?.map((m) => m.model).join(', ')}`);
  r = await sa('GET', `/usage?days=7&org_id=${demoId}`);
  check('usage super admin one org', r.status === 200 && r.json.org_id === demoId);
  r = await sa('GET', '/usage?from=2026-05-01&to=2026-04-01');
  check('usage from > to -> 400', r.status === 400);
  r = await oa('GET', '/usage/export?days=30');
  check('usage CSV export', r.status === 200 && r.text.startsWith('timestamp,organization') && /\.csv/.test(r.headers.get('content-disposition') || ''));

  // ---------------------------------------------------------------- admin orgs
  console.log('\nadmin orgs');
  r = await sa('POST', '/admin/orgs', { name: `acct-test-org-${RUN}`, currency: 'GBP' });
  check('create org', r.status === 201 && r.json.currency === 'GBP', r.json);
  const testOrg = r.json.id;
  created.orgs.push(testOrg);
  r = await sa('PATCH', `/admin/orgs/${testOrg}`, { name: `acct-test-org-${RUN}-renamed` });
  check('rename org', r.status === 200 && r.json.name.endsWith('renamed'));
  r = await sa('GET', '/admin/orgs');
  check('list orgs', r.status === 200 && r.json.some((o) => o.id === testOrg) && r.json.find((o) => o.id === demoId)?.lease_count > 0, r.json?.map?.((o) => [o.name, o.lease_count]));
  r = await sa('POST', `/admin/orgs/${testOrg}/members`, { email: mail('orgadmin'), role: 'viewer' });
  check('admin add member to org', r.status === 200 && r.json.status === 'added', r.json);
  r = await sa('GET', `/admin/orgs/${testOrg}/members`);
  check('admin list org members', r.status === 200 && r.json.length === 1);
  r = await sa('PATCH', `/admin/orgs/${testOrg}/members/${orgAdminId}`, { role: 'editor' });
  check('admin change member role', r.status === 200);
  r = await sa('GET', '/admin/orgs/00000000-0000-0000-0000-000000000000/members');
  check('admin members of unknown org -> 404', r.status === 404);
  r = await oa('GET', `/admin/orgs/${testOrg}/members`);
  check('admin routes as org admin -> 403', r.status === 403);
  r = await sa('PUT', `/admin/users/${orgAdminId}/orgs`, { orgs: [{ org_id: demoId, role: 'admin' }, { org_id: testOrg, role: 'viewer' }] });
  check('PUT user orgs', r.status === 200 && r.json.orgs.length === 2 && r.json.orgs.find((o) => o.org_id === testOrg)?.role === 'viewer', r.json);

  // Logo upload/remove on the test org
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
  const testOrgApi = caller(tAdmin, testOrg);
  const lf = new FormData();
  lf.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
  r = await testOrgApi('POST', '/orgs/current/logo', lf);
  check('logo upload', r.status === 200 && /org-logos/.test(r.json.logo_url || ''), r.json);
  const lf2 = new FormData();
  lf2.append('file', new Blob([new TextEncoder().encode('not an image')], { type: 'image/png' }), 'logo.png');
  r = await testOrgApi('POST', '/orgs/current/logo', lf2);
  check('logo invalid bytes -> 400', r.status === 400);
  const lf3 = new FormData();
  lf3.append('file', new Blob([new Uint8Array(1024 * 1024 + 10)], { type: 'image/png' }), 'big.png');
  r = await testOrgApi('POST', '/orgs/current/logo', lf3);
  check('logo > 1MB -> 413', r.status === 413);
  r = await testOrgApi('DELETE', '/orgs/current/logo');
  check('logo remove', r.status === 200 && r.json.logo_url === null);

  // Refuse deleting an org that holds data
  const { data: lease } = await svc.from('leases').insert({ org_id: testOrg, tenant_name: 'acct-test' }).select('id').single();
  r = await sa('DELETE', `/admin/orgs/${testOrg}`);
  check('delete org with data -> 409', r.status === 409 && r.json.counts?.leases === 1, r.json);
  await svc.from('leases').delete().eq('id', lease.id);

  // ---------------------------------------------------------------- domains
  console.log('\ndomains');
  r = await sa('POST', '/admin/domains', { domain: 'gmail.com', org_id: testOrg });
  check('claim public domain -> 400', r.status === 400, r.json);
  r = await sa('POST', '/admin/domains', { domain: 'Outlook.com', org_id: testOrg });
  check('claim outlook.com -> 400', r.status === 400);
  r = await sa('POST', '/admin/domains', { domain: 'not a domain', org_id: testOrg });
  check('claim invalid domain -> 400', r.status === 400);
  r = await sa('POST', '/admin/domains', { domain: `@${TEST_DOMAIN.toUpperCase()}`, org_id: testOrg, default_role: 'editor' });
  check('claim domain', r.status === 201 && r.json.domain === TEST_DOMAIN && r.json.default_role === 'editor', r.json);
  const domainId = r.json.id;
  created.domains.push(domainId);
  r = await sa('POST', '/admin/domains', { domain: TEST_DOMAIN, org_id: testOrg });
  check('claim duplicate -> 409', r.status === 409);
  r = await sa('PATCH', `/admin/domains/${domainId}`, { ms_tenant_id: 'nope' });
  check('bad tenant id -> 400', r.status === 400);
  r = await sa('GET', '/admin/domains');
  check('list domains', r.status === 200 && r.json.some((d) => d.id === domainId && d.org_name));

  // Existing users on the domain
  const d1 = `alice@${TEST_DOMAIN}`;
  const d2 = `bob@${TEST_DOMAIN}`;
  for (const e of [d1, d2]) {
    const x = await sa('POST', '/admin/users', { email: e, password: PW });
    if (x.json?.id) created.users.push(x.json.id);
  }
  await svc.from('org_member_removals').upsert({ org_id: testOrg, email: d2 });
  r = await sa('POST', `/admin/domains/${domainId}/apply`);
  check('add existing users (skips removed)', r.status === 200 && r.json.added === 1 && r.json.skipped_removed === 1, r.json);
  r = await sa('POST', `/admin/domains/${domainId}/apply`);
  check('add existing users idempotent', r.status === 200 && r.json.added === 0 && r.json.already_member === 1, r.json);

  // SSO join on GET /me: user whose app_metadata says google
  const ssoEmail = `carol@${TEST_DOMAIN}`;
  const { data: ssoUser } = await svc.auth.admin.createUser({ email: ssoEmail, password: PW, email_confirm: true, app_metadata: { provider: 'google', providers: ['google'] } });
  created.users.push(ssoUser.user.id);
  const tSso = await token(ssoEmail, PW);
  r = await caller(tSso)('GET', '/me');
  const ssoJoined = r.json?.orgs?.some((o) => o.id === testOrg && o.role === 'editor');
  console.log(`    sso user providers: ${JSON.stringify(r.json?.user?.providers)}`);
  check('domain join on GET /me (google provider)', ssoJoined, r.json);
  // Tenant restriction blocks non-matching tenant
  await sa('PATCH', `/admin/domains/${domainId}`, { ms_tenant_id: '11111111-2222-3333-4444-555555555555' });
  const daveEmail = `dave@${TEST_DOMAIN}`;
  const { data: dave } = await svc.auth.admin.createUser({ email: daveEmail, password: PW, email_confirm: true, app_metadata: { provider: 'azure', providers: ['azure'] } });
  created.users.push(dave.user.id);
  r = await caller(await token(daveEmail, PW))('GET', '/me');
  check('tenant mismatch -> not joined', r.status === 200 && r.json.orgs.length === 0, r.json?.orgs);
  // Password-only user on the domain does not auto-join
  r = await caller(await token(d2, PW))('GET', '/me');
  check('removed user not re-added', r.json.orgs.length === 0);
  r = await sa('DELETE', `/admin/domains/${domainId}`);
  check('delete domain', r.status === 200);
  created.domains.pop();

  // ---------------------------------------------------------------- settings
  console.log('\nsettings');
  r = await sa('GET', '/admin/settings');
  check('GET settings', r.status === 200 && r.json.models.length > 0, r.json);
  const settings = r.json;
  r = await sa('PUT', '/admin/settings/ai-model', { model: 'gpt-4' });
  check('unsupported model -> 400', r.status === 400);
  r = await sa('PUT', '/admin/settings/ai-model', { model: settings.ai_model });
  check('set model', r.status === 200 && r.json.ai_model === settings.ai_model);
  r = await sa('PUT', '/admin/settings/email', { provider: 'sendgrid', from_name: 'X', from_email: 'bad' });
  check('sendgrid needs valid sender -> 400', r.status === 400);
  r = await sa('PUT', '/admin/settings/email', settings.email);
  check('save email settings (unchanged)', r.status === 200, r.json);
  r = await sa('POST', '/admin/settings/email/test', {});
  check(`test email -> ${settings.email_configured ? '200' : '503 email_not_configured'}`, settings.email_configured ? r.status === 200 : r.status === 503 && r.json.code === 'email_not_configured', r.json);
  r = await mgr('GET', '/admin/settings');
  check('settings as editor -> 403', r.status === 403);

  // ---------------------------------------------------------------- support
  console.log('\nsupport');
  r = await ana('POST', '/support/tickets', { type: 'bug', summary: 'test', description: 'x', page_url: 'http://localhost:8080/dashboard' });
  const cfg = (await caller(null)('GET', '/config')).json;
  check(`support ticket -> ${cfg.jira ? 'created' : '503 integration_not_configured'}`, cfg.jira ? r.status === 201 : r.status === 503 && r.json.code === 'integration_not_configured', r.json);

  // ---------------------------------------------------------------- delete user / org
  console.log('\ncleanup checks');
  r = await sa('DELETE', `/admin/users/${inviteeId}`);
  check('delete user', r.status === 200);
  created.users = created.users.filter((id) => id !== inviteeId);
  r = await sa('DELETE', `/admin/orgs/${testOrg}`);
  check('delete empty org', r.status === 200, r.json);
  created.orgs = created.orgs.filter((id) => id !== testOrg);
} catch (err) {
  fail++;
  console.error('ERROR', err);
} finally {
  // Clean up everything named acct-test-*.
  for (const id of created.domains) await svc.from('org_domains').delete().eq('id', id);
  const { data: testUsers } = await svc.from('profiles').select('id, email').or(`email.ilike.acct-test-%,email.ilike.%@${TEST_DOMAIN}`);
  for (const u of testUsers ?? []) await svc.auth.admin.deleteUser(u.id);
  for (const id of created.users) await svc.auth.admin.deleteUser(id).catch(() => undefined);
  for (const id of created.orgs) { await svc.from('leases').delete().eq('org_id', id); await svc.from('organizations').delete().eq('id', id); }
  await svc.from('organizations').delete().ilike('name', 'acct-test-org-%');
  // Organizations auto-created on first sign-in for test users (named after the email domain; claims cascade).
  await svc.from('organizations').delete().in('name', ['leaseiq.test', TEST_DOMAIN]);
  await svc.from('organizations').delete().ilike('name', 'acct-test-%@leaseiq.test');
  if (demoId) {
    await svc.from('org_invites').delete().eq('org_id', demoId).ilike('email', 'acct-test-%');
    await svc.from('org_member_removals').delete().eq('org_id', demoId).ilike('email', 'acct-test-%');
  }
  console.log(`\n${pass} passed, ${fail} failed${failures.length ? `: ${failures.join('; ')}` : ''}`);
  process.exit(fail ? 1 : 0);
}
