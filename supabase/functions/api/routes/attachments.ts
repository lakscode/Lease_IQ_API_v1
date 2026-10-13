// Supporting documents (mounted at /api): /leases/:id/attachments…, /attachments/:id…
// Upload: POST …/upload-url → browser uploads to storage with the signed URL → POST /leases/:id/attachments.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { withOrg, requireRole, getOrgRow } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, dateStr, num, readJson, str } from '../lib/http.ts';
import { env } from '../lib/env.ts';
import { aiConfigured } from '../lib/ai.ts';
import { runInBackground } from '../lib/runtime.ts';
import { logAccess } from '../lib/access-log.ts';
import { removePaths, safeName, signedUploadUrl, signedUrl } from '../lib/storage.ts';
import { ATTACHMENT_CATEGORIES } from '../lib/abstract.ts';
import { ALLOWED_EXTENSIONS, attachmentType, reviewAttachment } from '../lib/intel-attachments.ts';

const router = new Hono<AppEnv>();
router.use('/leases/:id/attachments', withOrg);
router.use('/leases/:id/attachments/*', withOrg);
router.use('/attachments/*', withOrg);

const COLUMNS = 'id, lease_id, file_name, mime_type, file_size, category, doc_date, notes, status, error, ai_review, uploaded_by, created_at, updated_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function category(value: unknown): string | null {
  const v = str(value);
  if (v === null) return null;
  if (!(ATTACHMENT_CATEGORIES as readonly string[]).includes(v)) throw badRequest(`Unknown category "${v}"`);
  return v;
}

function startReview(c: Context<AppEnv>, attachmentId: string) {
  const input = { orgId: c.get('orgId'), userId: c.get('user').id, attachmentId, locale: c.get('profile').locale };
  runInBackground(() => reviewAttachment(input));
}

router.get('/leases/:id/attachments', async (c) => {
  const lease = await getOrgRow<{ id: string }>(c, 'leases', c.req.param('id'), 'id');
  const rows = must(await db().from('attachments').select(COLUMNS)
    .eq('org_id', c.get('orgId')).eq('lease_id', lease.id).order('created_at', { ascending: false }));
  return c.json(rows ?? []);
});

router.post('/leases/:id/attachments/upload-url', requireRole('editor'), async (c) => {
  const lease = await getOrgRow<{ id: string }>(c, 'leases', c.req.param('id'), 'id');
  const body = await readJson(c);
  const fileName = str(body.file_name);
  if (!fileName) throw badRequest('file_name is required');
  if (!attachmentType(fileName)) throw badRequest(`Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
  const size = num(body.file_size);
  if (size !== null && size > env.maxUploadMb * 1024 * 1024) {
    throw new ApiError('payload_too_large', `File is larger than ${env.maxUploadMb} MB`);
  }
  const attachmentId = crypto.randomUUID();
  const path = `${c.get('orgId')}/attachments/${attachmentId}/${safeName(fileName)}`;
  const upload = await signedUploadUrl(path);
  return c.json({ attachment_id: attachmentId, lease_id: lease.id, bucket: env.storageBucket, path: upload.path, token: upload.token, signed_url: upload.signedUrl });
});

router.post('/leases/:id/attachments', requireRole('editor'), async (c) => {
  const orgId = c.get('orgId');
  const lease = await getOrgRow<{ id: string }>(c, 'leases', c.req.param('id'), 'id');
  const body = await readJson(c);
  const attachmentId = str(body.attachment_id);
  const path = str(body.path);
  const fileName = str(body.file_name);
  if (!attachmentId || !UUID.test(attachmentId) || !path || !fileName) throw badRequest('attachment_id, path and file_name are required');
  const prefix = `${orgId}/attachments/${attachmentId}/`;
  if (!path.startsWith(prefix) || path.includes('..')) throw badRequest('Invalid upload path');
  const type = attachmentType(fileName);
  if (!type) throw badRequest('Unsupported file type');

  // The file must be in storage (uploaded with the signed URL).
  const { data: listed } = await db().storage.from(env.storageBucket).list(prefix.slice(0, -1), { limit: 10 });
  const object = (listed ?? []).find((o) => `${prefix}${o.name}` === path);
  if (!object) throw badRequest('Upload not found. Upload the file before registering it.');
  const size = Number((object.metadata as { size?: number } | null)?.size ?? num(body.file_size) ?? 0);
  if (size > env.maxUploadMb * 1024 * 1024) {
    await removePaths([path]);
    throw new ApiError('payload_too_large', `File is larger than ${env.maxUploadMb} MB`);
  }

  const row = must(await db().from('attachments').insert({
    id: attachmentId,
    org_id: orgId,
    lease_id: lease.id,
    file_name: fileName.slice(0, 255),
    storage_path: path,
    mime_type: str(body.mime_type) ?? type.mime,
    file_size: size || null,
    category: category(body.category),
    doc_date: dateStr(body.doc_date),
    notes: str(body.notes),
    status: 'queued',
    uploaded_by: c.get('user').id,
  }).select(COLUMNS).single())!;

  await logAccess({ orgId, userId: c.get('user').id, action: 'upload', leaseId: lease.id, details: { attachment_id: row.id, file_name: row.file_name } });
  if (aiConfigured()) startReview(c, row.id);
  return c.json(row, 201);
});

router.patch('/attachments/:id', requireRole('editor'), async (c) => {
  const att = await getOrgRow<{ id: string; lease_id: string }>(c, 'attachments', c.req.param('id'), 'id, lease_id');
  const body = await readJson(c);
  const update: Record<string, unknown> = {};
  if ('category' in body) update.category = category(body.category);
  if ('doc_date' in body) update.doc_date = dateStr(body.doc_date);
  if ('notes' in body) update.notes = str(body.notes);
  if (!Object.keys(update).length) throw badRequest('Nothing to update');
  const row = must(await db().from('attachments').update(update).eq('id', att.id).select(COLUMNS).single())!;
  return c.json(row);
});

router.delete('/attachments/:id', requireRole('editor'), async (c) => {
  const att = await getOrgRow<{ id: string; lease_id: string; storage_path: string; file_name: string }>(c, 'attachments', c.req.param('id'), 'id, lease_id, storage_path, file_name');
  must(await db().from('attachments').delete().eq('id', att.id));
  await removePaths([att.storage_path]);
  await logAccess({ orgId: c.get('orgId'), userId: c.get('user').id, action: 'delete', leaseId: att.lease_id, details: { attachment_id: att.id, file_name: att.file_name } });
  return c.json({ ok: true });
});

router.get('/attachments/:id/download', async (c) => {
  const att = await getOrgRow<{ id: string; lease_id: string; storage_path: string; file_name: string }>(c, 'attachments', c.req.param('id'), 'id, lease_id, storage_path, file_name');
  const inline = c.req.query('inline') === '1';
  const url = await signedUrl(att.storage_path, 300, inline ? undefined : att.file_name);
  await logAccess({ orgId: c.get('orgId'), userId: c.get('user').id, action: inline ? 'view' : 'download', leaseId: att.lease_id, details: { attachment_id: att.id, file_name: att.file_name } });
  return c.json({ url });
});

/** (Re-)run the AI review. */
router.post('/attachments/:id/review', requireRole('editor'), async (c) => {
  const att = await getOrgRow<{ id: string; status: string }>(c, 'attachments', c.req.param('id'), 'id, status');
  if (!aiConfigured()) throw new ApiError('ai_not_configured', 'AI is not configured. Set ANTHROPIC_API_KEY on the API.');
  const row = must(await db().from('attachments').update({ status: 'processing', error: null }).eq('id', att.id).select(COLUMNS).single())!;
  startReview(c, att.id);
  return c.json(row, 202);
});

export default router;
