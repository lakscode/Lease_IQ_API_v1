// Organization details, logo, members and invitations for the active organization (org admins).
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { requireRole, withOrg } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, readJson, str } from '../lib/http.ts';
import { publicLogoUrl, removePaths, uploadBytes } from '../lib/storage.ts';
import { env } from '../lib/env.ts';
import { loadOrg, membersRouter } from '../lib/account-members.ts';
import { CURRENCIES, orgSummary } from '../lib/account-orgs.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

const MAX_LOGO_BYTES = 1024 * 1024;

// GET /api/orgs/current — any member.
router.get('/current', async (c) => c.json({ ...(await orgSummary(c.get('orgId'))), role: c.get('role'), currencies: CURRENCIES }));

// PATCH /api/orgs/current — { name?, currency? }
router.patch('/current', requireRole('admin'), async (c) => {
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
  must(await db().from('organizations').update(update).eq('id', c.get('orgId')));
  return c.json(await orgSummary(c.get('orgId')));
});

// POST /api/orgs/current/logo — multipart `file` (PNG or JPEG, up to 1 MB).
router.post('/current/logo', requireRole('admin'), async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw badRequest('Choose a PNG or JPEG image');
  const type = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
  if (type !== 'image/png' && type !== 'image/jpeg') throw badRequest('The logo must be a PNG or JPEG image');
  if (file.size > MAX_LOGO_BYTES) throw new ApiError('payload_too_large', 'The logo must be 1 MB or smaller');
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Check the magic bytes too, not just the declared type.
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!(isPng || isJpeg)) throw badRequest('The file is not a valid PNG or JPEG image');

  const orgId = c.get('orgId');
  const org = await loadOrg(orgId);
  const path = `${orgId}/logo-${Date.now()}.${isPng ? 'png' : 'jpg'}`;
  await uploadBytes(path, bytes, isPng ? 'image/png' : 'image/jpeg', env.logoBucket);
  must(await db().from('organizations').update({ logo_path: path }).eq('id', orgId));
  if (org.logo_path) await removePaths([org.logo_path], env.logoBucket);
  return c.json({ logo_url: publicLogoUrl(path) });
});

router.delete('/current/logo', requireRole('admin'), async (c) => {
  const org = await loadOrg(c.get('orgId'));
  must(await db().from('organizations').update({ logo_path: null }).eq('id', org.id));
  if (org.logo_path) await removePaths([org.logo_path], env.logoBucket);
  return c.json({ logo_url: null });
});

// Members & invitations: /api/orgs/current/members..., /api/orgs/current/invites...
router.route('/current', membersRouter({ orgId: (c) => c.get('orgId'), guard: [requireRole('admin')], protectSelf: true }));

export default router;
