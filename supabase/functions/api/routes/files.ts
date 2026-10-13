// Lease file upload, processing pipeline control and the files list (owned by the leases area).
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { requireRole, requireSuperAdmin, withOrg, getOrgRow } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, readJson, str, num } from '../lib/http.ts';
import { env } from '../lib/env.ts';
import { aiConfigured } from '../lib/ai.ts';
import { logAccess } from '../lib/access-log.ts';
import { safeName, signedUploadUrl, signedUrl } from '../lib/storage.ts';
import { runInBackground } from '../lib/runtime.ts';
import {
  continueProcessing, deleteFileCompletely, isLocked, loadFile, prepareReanalysis, prepareRetry, startProcessing,
} from '../lib/pipeline/runner.ts';
import { allDocuments, rebuildAllClauses, rebuildSearch, recheckSignature } from '../lib/pipeline/maintenance.ts';
import type { LeaseFileRow } from '../lib/pipeline/types.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

const SOURCES = ['computer', 'google_drive', 'onedrive', 'sharepoint'] as const;
const STATUSES = ['queued', 'processing', 'completed', 'failed'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILE_COLUMNS =
  'id, org_id, uploaded_by, file_name, storage_path, file_size, sha256, page_count, is_scanned, source, target_lease_id, status, error, steps, lock_until, created_at, updated_at, processed_at';

interface FileDocSummary {
  id: string;
  file_id: string;
  doc_type: string;
  title: string | null;
  lease_id: string | null;
  page_start: number | null;
  page_end: number | null;
  tenant_name: string | null;
  premises_address: string | null;
}

interface TokenRun {
  process: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
}

/** Files of the org with their documents and AI token use per run (process). */
async function listFiles(orgId: string, fileIds?: string[]) {
  let q = db().from('lease_files')
    .select(`${FILE_COLUMNS}, uploader:profiles!lease_files_uploader_profile_fk(email, display_name)`)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (fileIds) q = q.in('id', fileIds);
  const files = must(await q, 'list files') as unknown as (LeaseFileRow & { uploader: { email: string | null; display_name: string | null } | null })[];
  const ids = files.map((f) => f.id);

  const docs: FileDocSummary[] = [];
  const usage = new Map<string, Map<string, TokenRun>>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const rows = must(await db().from('documents')
      .select('id, file_id, doc_type, title, lease_id, page_start, page_end, lease:leases!documents_lease_id_fkey(tenant_name, premises_address)')
      .in('file_id', chunk).order('page_start'), 'list documents') as unknown as (Omit<FileDocSummary, 'tenant_name' | 'premises_address'> & {
      lease: { tenant_name: string | null; premises_address: string | null } | null;
    })[];
    for (const r of rows) {
      docs.push({ id: r.id, file_id: r.file_id, doc_type: r.doc_type, title: r.title, lease_id: r.lease_id, page_start: r.page_start, page_end: r.page_end,
        tenant_name: r.lease?.tenant_name ?? null, premises_address: r.lease?.premises_address ?? null });
    }
    const u = must(await db().from('ai_usage')
      .select('file_id, process, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens')
      .eq('org_id', orgId).in('file_id', chunk), 'usage') as {
      file_id: string; process: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
    }[];
    for (const row of u) {
      const byProcess = usage.get(row.file_id) ?? new Map<string, TokenRun>();
      const run = byProcess.get(row.process) ?? { process: row.process, calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0 };
      run.calls += 1;
      run.input_tokens += row.input_tokens ?? 0;
      run.output_tokens += row.output_tokens ?? 0;
      run.cache_read_tokens += row.cache_read_tokens ?? 0;
      run.cache_creation_tokens += row.cache_creation_tokens ?? 0;
      run.total_tokens = run.input_tokens + run.output_tokens + run.cache_read_tokens + run.cache_creation_tokens;
      byProcess.set(row.process, run);
      usage.set(row.file_id, byProcess);
    }
  }

  return files.map((f) => {
    const { uploader, storage_path: _p, lock_until, ...rest } = f;
    return {
      ...rest,
      uploaded_by_name: uploader?.display_name || uploader?.email || null,
      locked: Boolean(lock_until && Date.parse(lock_until) > Date.now()),
      documents: docs.filter((d) => d.file_id === f.id),
      tokens: [...(usage.get(f.id)?.values() ?? [])],
    };
  });
}

type FileSummary = Awaited<ReturnType<typeof listFiles>>[number];

function matches(f: FileSummary, search: string): boolean {
  const s = search.toLowerCase();
  return f.file_name.toLowerCase().includes(s)
    || f.documents.some((d) => [d.tenant_name, d.premises_address, d.title].some((v) => v?.toLowerCase().includes(s)));
}

// GET /api/files?search=&status=
router.get('/', async (c) => {
  const orgId = c.get('orgId');
  const search = str(c.req.query('search'));
  const status = str(c.req.query('status'));
  const all = await listFiles(orgId);
  const summary = {
    files: all.length,
    documents: all.reduce((n, f) => n + f.documents.length, 0),
    processing: all.filter((f) => f.status === 'queued' || f.status === 'processing').length,
    needs_attention: all.filter((f) => f.status === 'failed' || (f.status === 'completed' && f.documents.length === 0)).length,
  };
  let files = all;
  if (status === 'attention') files = files.filter((f) => f.status === 'failed' || (f.status === 'completed' && f.documents.length === 0));
  else if (status === 'active') files = files.filter((f) => f.status === 'queued' || f.status === 'processing');
  else if (status && (STATUSES as readonly string[]).includes(status)) files = files.filter((f) => f.status === status);
  if (search) files = files.filter((f) => matches(f, search));
  return c.json({ summary, files, ai_configured: aiConfigured() });
});

// ---- Maintenance (super admins) — registered before /:id routes ---------------------------------

router.post('/maintenance/rebuild-clauses', requireSuperAdmin, async (c) => {
  if (!aiConfigured()) throw new ApiError('ai_not_configured', 'AI is not configured. Set ANTHROPIC_API_KEY on the API.');
  const docs = (await allDocuments()).filter((d) => d.storage_path || d.page_count);
  const profile = c.get('profile');
  runInBackground(() => rebuildAllClauses(docs, profile.id, profile.locale));
  return c.json({ documents: docs.length });
});

router.post('/maintenance/rebuild-search', requireSuperAdmin, async (c) => {
  const result = await rebuildSearch();
  return c.json(result);
});

// ---- Upload -------------------------------------------------------------------------------------

// POST /api/files/upload-url { file_name, size } → signed upload URL in the private bucket
router.post('/upload-url', requireRole('editor'), async (c) => {
  const body = await readJson(c);
  const fileName = str(body.file_name);
  const size = num(body.size);
  if (!fileName) throw badRequest('file_name is required');
  if (!/\.pdf$/i.test(fileName)) throw badRequest('Only PDF files can be uploaded.');
  if (size === null || size <= 0) throw badRequest('size is required');
  if (size > env.maxUploadMb * 1024 * 1024) throw new ApiError('payload_too_large', `Files can be at most ${env.maxUploadMb} MB.`);
  const fileId = crypto.randomUUID();
  const path = `${c.get('orgId')}/files/${fileId}/${safeName(fileName)}`;
  const signed = await signedUploadUrl(path);
  return c.json({ file_id: fileId, path: signed.path, token: signed.token, signed_url: signed.signedUrl });
});

// POST /api/files { file_id, path, file_name, size, source, target_lease_id? } → create + start processing
router.post('/', requireRole('editor'), async (c) => {
  const orgId = c.get('orgId');
  const user = c.get('user');
  const body = await readJson(c);
  const fileId = str(body.file_id);
  const path = str(body.path);
  const fileName = str(body.file_name);
  const size = num(body.size);
  const source = str(body.source) ?? 'computer';
  const targetLeaseId = str(body.target_lease_id);
  if (!fileId || !UUID_RE.test(fileId)) throw badRequest('file_id is required');
  if (!path || !path.startsWith(`${orgId}/files/${fileId}/`)) throw badRequest('Invalid upload path');
  if (!fileName) throw badRequest('file_name is required');
  if (!(SOURCES as readonly string[]).includes(source)) throw badRequest('Invalid source');
  if (size !== null && size > env.maxUploadMb * 1024 * 1024) throw new ApiError('payload_too_large', `Files can be at most ${env.maxUploadMb} MB.`);
  if (targetLeaseId) await getOrgRow(c, 'leases', targetLeaseId, 'id');

  const { data: existing } = await db().from('lease_files').select('id').eq('id', fileId).maybeSingle();
  if (existing) throw new ApiError('conflict', 'This upload was already registered.');
  // The object must exist in storage (uploaded with the signed URL).
  const folder = `${orgId}/files/${fileId}`;
  const { data: objects, error: listErr } = await db().storage.from(env.storageBucket).list(folder);
  if (listErr) throw new Error(listErr.message);
  const object = (objects ?? []).find((o) => `${folder}/${o.name}` === path);
  if (!object) throw badRequest('The file has not been uploaded yet.');

  must(await db().from('lease_files').insert({
    id: fileId,
    org_id: orgId,
    uploaded_by: user.id,
    file_name: fileName.slice(0, 255),
    storage_path: path,
    file_size: size ?? (object.metadata as { size?: number } | null)?.size ?? null,
    source,
    target_lease_id: targetLeaseId,
    status: 'queued',
    steps: [],
    work: { mode: 'analysis' },
  }), 'create file');
  await logAccess({ orgId, userId: user.id, action: 'upload', fileId, leaseId: targetLeaseId, details: { file_name: fileName, source, size } });
  startProcessing(fileId);
  const [file] = await listFiles(orgId, [fileId]);
  return c.json(file, 201);
});

// ---- One file -------------------------------------------------------------------------------------

async function orgFile(c: Parameters<typeof getOrgRow>[0], id: string): Promise<LeaseFileRow> {
  if (!UUID_RE.test(id)) throw new ApiError('not_found', 'File not found');
  await getOrgRow(c, 'lease_files', id, 'id');
  return loadFile(id);
}

router.get('/:id', async (c) => {
  await orgFile(c, c.req.param('id'));
  const [file] = await listFiles(c.get('orgId'), [c.req.param('id')]);
  return c.json(file);
});

// GET /api/files/:id/logs → processing log + steps
router.get('/:id/logs', async (c) => {
  const file = await orgFile(c, c.req.param('id'));
  const logs = must(await db().from('processing_logs').select('id, step, level, message, created_at')
    .eq('file_id', file.id).eq('org_id', file.org_id).order('id'), 'logs');
  return c.json({ file: { id: file.id, file_name: file.file_name, status: file.status, error: file.error }, steps: file.steps, logs });
});

// GET /api/files/:id/pdf → { url } signed URL to the original upload
router.get('/:id/pdf', async (c) => {
  const file = await orgFile(c, c.req.param('id'));
  const url = await signedUrl(file.storage_path, 600).catch(() => {
    throw new ApiError('not_found', 'PDF not available');
  });
  await logAccess({ orgId: file.org_id, userId: c.get('user').id, action: 'view', fileId: file.id, details: { file_name: file.file_name } });
  return c.json({ url });
});

// POST /api/files/:id/process → continue processing (used by the Leases page while files are queued/processing)
router.post('/:id/process', async (c) => {
  const file = await orgFile(c, c.req.param('id'));
  const result = file.status === 'queued' || file.status === 'processing'
    ? (isLocked(file) ? 'locked' : await continueProcessing(file.id))
    : 'idle';
  const fresh = await loadFile(file.id);
  return c.json({ result, status: fresh.status, error: fresh.error, steps: fresh.steps });
});

router.post('/:id/retry', requireRole('editor'), async (c) => {
  const file = await orgFile(c, c.req.param('id'));
  await prepareRetry(file.id);
  startProcessing(file.id);
  const [out] = await listFiles(file.org_id, [file.id]);
  return c.json(out);
});

router.post('/:id/reanalyze', requireRole('editor'), async (c) => {
  const file = await orgFile(c, c.req.param('id'));
  await prepareReanalysis(file.id);
  startProcessing(file.id);
  const [out] = await listFiles(file.org_id, [file.id]);
  return c.json(out);
});

// POST /api/files/:id/signatures → re-check signatures of every document in the file (background)
router.post('/:id/signatures', requireRole('editor'), async (c) => {
  const file = await orgFile(c, c.req.param('id'));
  if (!aiConfigured()) throw new ApiError('ai_not_configured', 'AI is not configured. Set ANTHROPIC_API_KEY on the API.');
  const docs = must(await db().from('documents').select('id').eq('file_id', file.id).eq('org_id', file.org_id)) as { id: string }[];
  const profile = c.get('profile');
  runInBackground(async () => {
    for (const d of docs) {
      try {
        await recheckSignature(d.id, file.org_id, profile.id, profile.locale);
      } catch (err) {
        console.error('[signatures]', d.id, (err as Error).message);
      }
    }
  });
  return c.json({ documents: docs.length });
});

router.delete('/:id', requireRole('editor'), async (c) => {
  const file = await orgFile(c, c.req.param('id'));
  if ((file.status === 'processing' || file.status === 'queued') && isLocked(file)) {
    throw new ApiError('conflict', 'The file is being processed. Try again when it has finished.');
  }
  const result = await deleteFileCompletely(file.id);
  await logAccess({ orgId: file.org_id, userId: c.get('user').id, action: 'delete', fileId: file.id, leaseId: file.target_lease_id, details: { file_name: file.file_name, ...result } });
  return c.json({ ok: true, ...result });
});

export default router;
