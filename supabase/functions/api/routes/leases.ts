// Lease families: list, detail ("as amended"), documents, abstract edits, clauses, signatures, document of record,
// access log, activity and the PDF abstract report (owned by the leases area).
import { Hono, type Context } from 'hono';
import type { AppEnv, LeaseStatus } from '../lib/types.ts';
import { requireRole, withOrg } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, forbidden, readJson, str } from '../lib/http.ts';
import { ABSTRACT_FIELDS, CLAUSE_TYPES, coerceFieldValue } from '../lib/abstract.ts';
import { LEASE_CLAUSES } from '../lib/lease-clauses.ts';
import { computeAlerts, noticeByDate, recomputeLease, sortFamily, type FamilyDocument, type TermValue } from '../lib/lease-terms.ts';
import { logAccess } from '../lib/access-log.ts';
import { followUpAlerts } from '../lib/lease-followups.ts';
import { log } from '../lib/log.ts';
import { downloadBytes, publicLogoUrl, sha256Hex, signedUrl } from '../lib/storage.ts';
import { escapeHtml, renderEmail, sendEmail } from '../lib/email.ts';
import { toBase64 } from '../lib/ai.ts';
import { recheckSignature } from '../lib/pipeline/maintenance.ts';
import { buildLeaseReport, type ReportInput } from '../lib/pdf-report.ts';
import {
  aiReviewCheck, buildReview, loadReviewRow, reviewStatuses, saveReviewRow, withVerdict, type ReviewClause, type ReviewDoc, type ReviewRow,
} from '../lib/lease-review.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

type Ctx = Context<AppEnv>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES: LeaseStatus[] = ['active', 'expiring', 'expired', 'renewed', 'unknown'];

const LEASE_COLUMNS =
  'id, tenant_name, landlord_name, premises_address, rentable_area, commencement_date, expiration_date, base_rent_monthly, status, property_type, risk_score, main_document_id, ai_provider, ai_model, updated_at';

const DOC_COLUMNS =
  'id, org_id, lease_id, file_id, doc_type, title, effective_date, page_start, page_end, page_count, storage_path, sha256, abstract, summary, changes_made, signature, is_scanned, ai_provider, ai_model, created_at, updated_at';

interface LeaseRow {
  id: string;
  tenant_name: string | null;
  landlord_name: string | null;
  premises_address: string | null;
  rentable_area: number | null;
  commencement_date: string | null;
  expiration_date: string | null;
  base_rent_monthly: number | null;
  status: LeaseStatus;
  property_type: string | null;
  risk_score: number | null;
  main_document_id: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  updated_at: string;
  current_terms?: Record<string, TermValue>;
}

interface DocRow extends FamilyDocument {
  org_id: string;
  lease_id: string | null;
  page_end: number | null;
  page_count: number | null;
  storage_path: string | null;
  sha256: string | null;
  summary: string | null;
  signature: Record<string, unknown> | null;
  is_scanned: boolean | null;
  updated_at: string;
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function listItem(row: LeaseRow, documentCount: number) {
  return {
    id: row.id,
    tenant_name: row.tenant_name,
    landlord_name: row.landlord_name,
    premises_address: row.premises_address,
    rentable_area: asNumber(row.rentable_area),
    commencement_date: row.commencement_date,
    expiration_date: row.expiration_date,
    base_rent_monthly: asNumber(row.base_rent_monthly),
    status: row.status,
    property_type: row.property_type,
    risk_score: row.risk_score,
    document_count: documentCount,
    main_document_id: row.main_document_id,
    ai_provider: row.ai_provider,
    ai_model: row.ai_model,
    updated_at: row.updated_at,
  };
}

async function loadLease(c: Ctx, id: string): Promise<LeaseRow> {
  if (!UUID_RE.test(id)) throw new ApiError('not_found', 'Lease not found');
  const { data, error } = await db().from('leases').select(`${LEASE_COLUMNS}, current_terms`).eq('id', id).eq('org_id', c.get('orgId')).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ApiError('not_found', 'Lease not found');
  return data as LeaseRow;
}

async function leaseDocuments(orgId: string, leaseId: string): Promise<DocRow[]> {
  const rows = must(await db().from('documents').select(DOC_COLUMNS).eq('org_id', orgId).eq('lease_id', leaseId), 'documents') as DocRow[];
  return sortFamily(rows);
}

async function loadDoc(c: Ctx, leaseId: string, docId: string): Promise<DocRow> {
  if (!UUID_RE.test(docId)) throw new ApiError('not_found', 'Document not found');
  const { data, error } = await db().from('documents').select(DOC_COLUMNS).eq('id', docId).eq('org_id', c.get('orgId')).eq('lease_id', leaseId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ApiError('not_found', 'Document not found');
  return data as DocRow;
}

function docOut(d: DocRow, fileNames: Map<string, string>) {
  return {
    id: d.id,
    doc_type: d.doc_type,
    title: d.title,
    effective_date: d.effective_date,
    page_start: d.page_start,
    page_end: d.page_end,
    page_count: d.page_count,
    file_id: d.file_id,
    file_name: d.file_id ? fileNames.get(d.file_id) ?? null : null,
    changes_made: d.changes_made,
    summary: d.summary,
    signature: d.signature,
    ai_provider: d.ai_provider,
    ai_model: d.ai_model,
    sha256: d.sha256,
    has_pdf: Boolean(d.storage_path),
    is_scanned: d.is_scanned,
    abstract: d.abstract ?? {},
    created_at: d.created_at,
  };
}

async function failedFilesFor(orgId: string, leaseId: string, fileIds: string[]): Promise<{ id: string; file_name: string }[]> {
  const byTarget = must(await db().from('lease_files').select('id, file_name').eq('org_id', orgId).eq('status', 'failed').eq('target_lease_id', leaseId), 'failed files') as { id: string; file_name: string }[];
  const byDocs = fileIds.length
    ? (must(await db().from('lease_files').select('id, file_name').eq('org_id', orgId).eq('status', 'failed').in('id', fileIds), 'failed files') as { id: string; file_name: string }[])
    : [];
  const seen = new Map<string, { id: string; file_name: string }>();
  for (const f of [...byTarget, ...byDocs]) seen.set(f.id, f);
  return [...seen.values()];
}

async function fileNameMap(fileIds: string[]): Promise<Map<string, string>> {
  if (!fileIds.length) return new Map();
  const rows = must(await db().from('lease_files').select('id, file_name').in('id', fileIds), 'files') as { id: string; file_name: string }[];
  return new Map(rows.map((r) => [r.id, r.file_name]));
}

/** Alerts for open tasks and expiring supporting documents. Never fails the lease detail (e.g. before migration 0208). */
async function followUps(orgId: string, leaseId: string) {
  const [tasks, atts] = await Promise.all([
    db().from('lease_tasks').select('title, due_date').eq('org_id', orgId).eq('lease_id', leaseId).eq('done', false),
    db().from('attachments').select('file_name, category, ai_review').eq('org_id', orgId).eq('lease_id', leaseId),
  ]);
  if (tasks.error) log.warn('leases', `Tasks unavailable: ${tasks.error.message}`);
  if (atts.error) log.warn('leases', `Attachments unavailable: ${atts.error.message}`);
  return followUpAlerts({
    tasks: (tasks.data ?? []) as { title: string; due_date: string | null }[],
    attachments: (atts.data ?? []) as { file_name: string; category: string | null; ai_review: { key_date?: string | null; fields?: Record<string, string> } | null }[],
  });
}

async function leaseDetail(c: Ctx, id: string) {
  const orgId = c.get('orgId');
  const lease = await loadLease(c, id);
  const docs = await leaseDocuments(orgId, id);
  const fileIds = [...new Set(docs.map((d) => d.file_id).filter((v): v is string => Boolean(v)))];
  const terms = (lease.current_terms ?? {}) as Record<string, TermValue>;
  const alerts = [
    ...computeAlerts({
      status: lease.status,
      terms,
      hasMainLease: docs.some((d) => d.doc_type === 'main_lease'),
      failedFiles: await failedFilesFor(orgId, id, fileIds),
    }),
    ...(await followUps(orgId, id)),
  ];
  const names = await fileNameMap(fileIds);
  return {
    lease: { ...listItem(lease, docs.length), current_terms: terms },
    documents: docs.map((d) => docOut(d, names)),
    alerts,
    notice_by: noticeByDate(terms),
    raw: { lease, docs },
  };
}

// ---- List & detail ---------------------------------------------------------------------------------

// GET /api/leases?search=&status=
router.get('/', async (c) => {
  const orgId = c.get('orgId');
  const search = str(c.req.query('search'));
  const status = str(c.req.query('status'));
  let q = db().from('leases')
    .select(`${LEASE_COLUMNS}, documents:documents!documents_lease_id_fkey(count)`)
    .eq('org_id', orgId)
    .order('tenant_name', { ascending: true, nullsFirst: false });
  if (status && (STATUSES as string[]).includes(status)) q = q.eq('status', status);
  if (search) {
    const s = search.replace(/[,()%*\\]/g, ' ').trim();
    if (s) q = q.or(`tenant_name.ilike.%${s}%,landlord_name.ilike.%${s}%,premises_address.ilike.%${s}%`);
  }
  const rows = must(await q, 'leases') as unknown as (LeaseRow & { documents: { count: number }[] })[];
  const [parents, reviews] = await Promise.all([leaseParents(orgId), reviewStatuses(orgId)]);
  return c.json(rows.map((r) => ({
    ...listItem(r, r.documents?.[0]?.count ?? 0),
    parent_lease_id: parents.get(r.id) ?? null,
    review: reviews.get(r.id) ?? null,
  })));
});

/** Tenant name for grouping: case, punctuation and spacing ignored. */
const tenantKey = (name: string | null) => (name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Lease families for the list: leases of the same tenant, plus leases that came out of the same upload (a file
 * uploaded with "Add amendment" and its target lease; leases split from one PDF). In each family the "first" lease
 * is the parent of the others: the one with a main lease, then the earliest commencement, then the oldest.
 * Returns child → parent; top-level leases are absent.
 */
async function leaseParents(orgId: string): Promise<Map<string, string>> {
  const leases = must(await db().from('leases').select('id, tenant_name, main_document_id, commencement_date, created_at').eq('org_id', orgId), 'leases') as
    { id: string; tenant_name: string | null; main_document_id: string | null; commencement_date: string | null; created_at: string }[];
  const docs = must(await db().from('documents').select('lease_id, file_id').eq('org_id', orgId).not('lease_id', 'is', null).not('file_id', 'is', null), 'documents') as
    { lease_id: string; file_id: string }[];
  const fileIds = [...new Set(docs.map((d) => d.file_id))];
  const targets = new Map<string, string | null>();
  for (let i = 0; i < fileIds.length; i += 200) {
    const files = must(await db().from('lease_files').select('id, target_lease_id').eq('org_id', orgId).in('id', fileIds.slice(i, i + 200)), 'files') as { id: string; target_lease_id: string | null }[];
    for (const f of files) targets.set(f.id, f.target_lease_id);
  }

  // Union-find over leases.
  const known = new Set(leases.map((l) => l.id));
  const up = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (up.has(root)) root = up.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    if (!known.has(a) || !known.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) up.set(rb, ra);
  };

  const byTenant = new Map<string, string>();
  for (const l of leases) {
    const key = tenantKey(l.tenant_name);
    if (!key) continue;
    if (byTenant.has(key)) union(byTenant.get(key)!, l.id);
    else byTenant.set(key, l.id);
  }
  const firstOfFile = new Map<string, string>();
  for (const d of docs) {
    const target = targets.get(d.file_id);
    if (target) union(target, d.lease_id);
    if (firstOfFile.has(d.file_id)) union(firstOfFile.get(d.file_id)!, d.lease_id);
    else firstOfFile.set(d.file_id, d.lease_id);
  }

  // Pick each family's first lease.
  const families = new Map<string, typeof leases>();
  for (const l of leases) families.set(find(l.id), [...(families.get(find(l.id)) ?? []), l]);
  const parents = new Map<string, string>();
  for (const members of families.values()) {
    if (members.length < 2) continue;
    const [head] = [...members].sort((a, b) =>
      Number(!a.main_document_id) - Number(!b.main_document_id)
      || (a.commencement_date ?? '9999').localeCompare(b.commencement_date ?? '9999')
      || a.created_at.localeCompare(b.created_at));
    for (const m of members) if (m.id !== head.id) parents.set(m.id, head.id);
  }
  return parents;
}

// GET /api/leases/:id
router.get('/:id', async (c) => {
  const { raw: _raw, ...detail } = await leaseDetail(c, c.req.param('id'));
  return c.json(detail);
});

// ---- Documents -------------------------------------------------------------------------------------

// GET /api/leases/:id/documents/:docId/pdf → { url }
router.get('/:id/documents/:docId/pdf', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const doc = await loadDoc(c, leaseId, c.req.param('docId'));
  if (!doc.storage_path) throw new ApiError('not_found', 'PDF not available for this document');
  let url: string;
  try {
    url = await signedUrl(doc.storage_path, 900);
  } catch {
    throw new ApiError('not_found', 'PDF not available for this document');
  }
  await logAccess({ orgId: c.get('orgId'), userId: c.get('user').id, action: 'view', leaseId, documentId: doc.id, fileId: doc.file_id, details: { title: doc.title } });
  return c.json({ url });
});

// GET /api/leases/:id/documents/:docId/pages
router.get('/:id/documents/:docId/pages', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const doc = await loadDoc(c, leaseId, c.req.param('docId'));
  const pages = must(await db().from('document_pages').select('page_number, text').eq('document_id', doc.id).eq('org_id', doc.org_id).order('page_number'), 'pages');
  return c.json({ document_id: doc.id, page_start: doc.page_start, pages });
});

// ---- PDF notes (text selected on a page, with a note) ----------------------------------------------

const NOTE_COLORS = ['yellow', 'green', 'blue', 'pink'];
const NOTE_COLUMNS = 'id, document_id, page, quote, rects, color, body, created_by, created_at, updated_at, author:profiles!document_notes_profile_fk(email, display_name)';

interface NoteRow {
  id: string; document_id: string; page: number; quote: string | null; rects: unknown; color: string; body: string;
  created_by: string | null; created_at: string; updated_at: string;
  author: { email: string | null; display_name: string | null } | null;
}

function noteOut(r: NoteRow) {
  const { author, ...rest } = r;
  return { ...rest, author: author?.display_name || author?.email || null };
}

/** Highlight rectangles, normalized to the page (0..1). At most 200; anything malformed is rejected. */
function noteRects(v: unknown): { x: number; y: number; w: number; h: number }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 200) throw badRequest('Invalid highlight');
  const unit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= -0.01 && n <= 1.01;
  return v.map((r) => {
    const { x, y, w, h } = (r ?? {}) as Record<string, unknown>;
    if (![x, y, w, h].every(unit)) throw badRequest('Invalid highlight');
    const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
    return { x: round(x as number), y: round(y as number), w: round(w as number), h: round(h as number) };
  });
}

function noteBody(v: unknown): string {
  const body = str(v);
  if (!body) throw badRequest('Write a note.');
  if (body.length > 5000) throw badRequest('Notes can be at most 5,000 characters.');
  return body;
}

async function loadNote(c: Ctx, leaseId: string, noteId: string): Promise<NoteRow> {
  if (!UUID_RE.test(noteId)) throw new ApiError('not_found', 'Note not found');
  const { data, error } = await db().from('document_notes').select(NOTE_COLUMNS).eq('id', noteId).eq('org_id', c.get('orgId')).eq('lease_id', leaseId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ApiError('not_found', 'Note not found');
  return data as unknown as NoteRow;
}

/** Notes can be changed by their author or an admin. */
function assertNoteOwner(c: Ctx, note: NoteRow) {
  if (note.created_by !== c.get('user').id && c.get('role') !== 'admin') throw forbidden('Only the author or an admin can change this note.');
}

// GET /api/leases/:id/documents/:docId/notes
router.get('/:id/documents/:docId/notes', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const doc = await loadDoc(c, leaseId, c.req.param('docId'));
  const rows = must(await db().from('document_notes').select(NOTE_COLUMNS).eq('document_id', doc.id).eq('org_id', doc.org_id)
    .order('page').order('created_at'), 'notes') as unknown as NoteRow[];
  return c.json(rows.map(noteOut));
});

// POST /api/leases/:id/documents/:docId/notes { page, quote?, rects?, color?, body }
router.post('/:id/documents/:docId/notes', requireRole('editor'), async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const doc = await loadDoc(c, leaseId, c.req.param('docId'));
  const body = await readJson(c);
  const page = Number(body.page);
  if (!Number.isInteger(page) || page < 1 || (doc.page_count && page > doc.page_count)) throw badRequest('Invalid page');
  const color = str(body.color) ?? 'yellow';
  if (!NOTE_COLORS.includes(color)) throw badRequest('Invalid color');
  const row = must(await db().from('document_notes').insert({
    org_id: doc.org_id, lease_id: leaseId, document_id: doc.id, page,
    quote: str(body.quote)?.slice(0, 2000) ?? null, rects: noteRects(body.rects), color, body: noteBody(body.body),
    created_by: c.get('user').id,
  }).select(NOTE_COLUMNS).single(), 'note') as unknown as NoteRow;
  return c.json(noteOut(row), 201);
});

// PATCH /api/leases/:id/notes/:noteId { body?, color? }
router.patch('/:id/notes/:noteId', requireRole('editor'), async (c) => {
  const leaseId = c.req.param('id');
  const note = await loadNote(c, leaseId, c.req.param('noteId'));
  assertNoteOwner(c, note);
  const body = await readJson(c);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.body !== undefined) update.body = noteBody(body.body);
  if (body.color !== undefined) {
    if (!NOTE_COLORS.includes(String(body.color))) throw badRequest('Invalid color');
    update.color = body.color;
  }
  const row = must(await db().from('document_notes').update(update).eq('id', note.id).select(NOTE_COLUMNS).single(), 'note') as unknown as NoteRow;
  return c.json(noteOut(row));
});

// DELETE /api/leases/:id/notes/:noteId
router.delete('/:id/notes/:noteId', requireRole('editor'), async (c) => {
  const note = await loadNote(c, c.req.param('id'), c.req.param('noteId'));
  assertNoteOwner(c, note);
  must(await db().from('document_notes').delete().eq('id', note.id), 'delete note');
  return c.json({ ok: true });
});

// ---- Tasks (follow-ups; open ones that are overdue or due soon become alerts) ----------------------

const TASK_COLUMNS = 'id, lease_id, title, due_date, done, done_at, attachment_id, created_by, created_at, attachment:attachments(file_name), creator:profiles!lease_tasks_profile_fk(email, display_name)';
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface TaskRow {
  id: string; lease_id: string; title: string; due_date: string | null; done: boolean; done_at: string | null;
  attachment_id: string | null; created_by: string | null; created_at: string;
  attachment: { file_name: string } | null;
  creator: { email: string | null; display_name: string | null } | null;
}

function taskOut(r: TaskRow) {
  const { attachment, creator, ...rest } = r;
  return { ...rest, attachment_name: attachment?.file_name ?? null, created_by_name: creator?.display_name || creator?.email || null };
}

function taskTitle(v: unknown): string {
  const title = str(v);
  if (!title) throw badRequest('Enter a task.');
  return title.slice(0, 300);
}

function taskDue(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DATE_ONLY_RE.test(v) || Number.isNaN(Date.parse(v))) throw badRequest('Enter a date as YYYY-MM-DD.');
  return v;
}

async function loadTask(c: Ctx, leaseId: string, taskId: string): Promise<{ id: string }> {
  if (!UUID_RE.test(taskId)) throw new ApiError('not_found', 'Task not found');
  const { data, error } = await db().from('lease_tasks').select('id').eq('id', taskId).eq('org_id', c.get('orgId')).eq('lease_id', leaseId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ApiError('not_found', 'Task not found');
  return data as { id: string };
}

// GET /api/leases/:id/tasks → open tasks first (by due date), then done ones
router.get('/:id/tasks', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const rows = must(await db().from('lease_tasks').select(TASK_COLUMNS).eq('org_id', c.get('orgId')).eq('lease_id', leaseId)
    .order('done').order('due_date', { nullsFirst: false }).order('created_at'), 'tasks') as unknown as TaskRow[];
  return c.json(rows.map(taskOut));
});

// POST /api/leases/:id/tasks { title, due_date?, attachment_id? }
router.post('/:id/tasks', requireRole('editor'), async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const orgId = c.get('orgId');
  const body = await readJson(c);
  const attachmentId = str(body.attachment_id);
  if (attachmentId) {
    const att = UUID_RE.test(attachmentId)
      ? must(await db().from('attachments').select('id').eq('id', attachmentId).eq('org_id', orgId).eq('lease_id', leaseId).maybeSingle(), 'attachment')
      : null;
    if (!att) throw badRequest('Unknown supporting document');
  }
  const row = must(await db().from('lease_tasks').insert({
    org_id: orgId, lease_id: leaseId, title: taskTitle(body.title), due_date: taskDue(body.due_date),
    attachment_id: attachmentId, created_by: c.get('user').id,
  }).select(TASK_COLUMNS).single(), 'task') as unknown as TaskRow;
  return c.json(taskOut(row), 201);
});

// PATCH /api/leases/:id/tasks/:taskId { title?, due_date?, done? }
router.patch('/:id/tasks/:taskId', requireRole('editor'), async (c) => {
  const leaseId = c.req.param('id');
  const task = await loadTask(c, leaseId, c.req.param('taskId'));
  const body = await readJson(c);
  const update: Record<string, unknown> = {};
  if (body.title !== undefined) update.title = taskTitle(body.title);
  if (body.due_date !== undefined) update.due_date = taskDue(body.due_date);
  if (body.done !== undefined) {
    update.done = body.done === true;
    update.done_at = body.done === true ? new Date().toISOString() : null;
  }
  const row = must(await db().from('lease_tasks').update(update).eq('id', task.id).select(TASK_COLUMNS).single(), 'task') as unknown as TaskRow;
  return c.json(taskOut(row));
});

// DELETE /api/leases/:id/tasks/:taskId
router.delete('/:id/tasks/:taskId', requireRole('editor'), async (c) => {
  const task = await loadTask(c, c.req.param('id'), c.req.param('taskId'));
  must(await db().from('lease_tasks').delete().eq('id', task.id), 'delete task');
  return c.json({ ok: true });
});

// PATCH /api/leases/:id/documents/:docId/abstract { field, value }
router.patch('/:id/documents/:docId/abstract', requireRole('editor'), async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const doc = await loadDoc(c, leaseId, c.req.param('docId'));
  const body = await readJson(c);
  const fieldKey = str(body.field);
  const field = ABSTRACT_FIELDS.find((f) => f.key === fieldKey);
  if (!field) throw badRequest('Unknown abstract field');
  const raw = body.value;
  const value = coerceFieldValue(field, raw);
  if (value === null && raw !== null && raw !== undefined && String(raw).trim() !== '') {
    throw badRequest(field.kind === 'date' ? 'Enter a date as YYYY-MM-DD.' : field.kind === 'text' || field.kind === 'longtext' ? 'Invalid value' : 'Enter a number.');
  }
  const abstract = { ...(doc.abstract ?? {}) } as Record<string, unknown>;
  const oldValue = abstract[field.key] ?? null;
  if (oldValue === value) return c.json({ document: { id: doc.id, abstract, changes_made: doc.changes_made }, changed: false });
  if (value === null) delete abstract[field.key];
  else abstract[field.key] = value;
  const update: Record<string, unknown> = { abstract };
  if (field.key === 'changes_made') update.changes_made = value;
  must(await db().from('documents').update(update).eq('id', doc.id), 'save abstract');
  must(await db().from('abstract_edits').insert({
    org_id: doc.org_id, document_id: doc.id, lease_id: leaseId, field: field.key,
    old_value: oldValue, new_value: value, edited_by: c.get('user').id,
  }), 'record edit');
  await logAccess({ orgId: doc.org_id, userId: c.get('user').id, action: 'edit', leaseId, documentId: doc.id, details: { field: field.key, old_value: oldValue, new_value: value } });
  await recomputeLease(leaseId);
  return c.json({ document: { id: doc.id, abstract, changes_made: update.changes_made ?? doc.changes_made }, changed: true });
});

// GET /api/leases/:id/edits → abstract edit history
router.get('/:id/edits', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  return c.json(await editHistory(c.get('orgId'), leaseId));
});

async function editHistory(orgId: string, leaseId: string) {
  const docs = must(await db().from('documents').select('id, title, doc_type').eq('org_id', orgId).eq('lease_id', leaseId), 'docs') as { id: string; title: string | null; doc_type: string }[];
  if (!docs.length) return [];
  const rows = must(await db().from('abstract_edits')
    .select('id, document_id, field, old_value, new_value, edited_at, editor:profiles!abstract_edits_profile_fk(email, display_name)')
    .eq('org_id', orgId).in('document_id', docs.map((d) => d.id)).order('edited_at', { ascending: false }).limit(500), 'edits') as unknown as {
    id: number; document_id: string; field: string; old_value: unknown; new_value: unknown; edited_at: string;
    editor: { email: string | null; display_name: string | null } | null;
  }[];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return rows.map((r) => ({
    id: r.id,
    document_id: r.document_id,
    document_title: byId.get(r.document_id)?.title ?? null,
    doc_type: byId.get(r.document_id)?.doc_type ?? null,
    field: r.field,
    field_label: ABSTRACT_FIELDS.find((f) => f.key === r.field)?.label ?? r.field,
    old_value: r.old_value,
    new_value: r.new_value,
    edited_at: r.edited_at,
    edited_by: r.editor?.display_name || r.editor?.email || null,
  }));
}

// GET /api/leases/:id/clauses[?include_dismissed=1] → grouped by type (removed clauses only on request)
router.get('/:id/clauses', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  return c.json(await groupedClauses(c.get('orgId'), leaseId, c.req.query('include_dismissed') === '1'));
});

/** Types a user may assign: both taxonomies (the clause's classifier decides which one its prediction used). */
const EDITABLE_TYPES = new Set<string>([...CLAUSE_TYPES, ...Object.values(LEASE_CLAUSES)]);

// PATCH /api/leases/:id/clauses/:clauseId { clause_type?, verified?, dismissed? } → edit a predicted clause.
// Each change is recorded in clause_edits (Activity tab).
router.patch('/:id/clauses/:clauseId', requireRole('editor'), async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const orgId = c.get('orgId');
  const clause = must(await db().from('clauses')
    .select('id, document_id, lease_id, clause_type, original_clause_type, verified, dismissed, text')
    .eq('id', c.req.param('clauseId')).eq('org_id', orgId).maybeSingle(), 'load clause') as {
    id: string; document_id: string; lease_id: string | null; clause_type: string; original_clause_type: string | null;
    verified: boolean; dismissed: boolean; text: string | null;
  } | null;
  const doc = clause && must(await db().from('documents').select('lease_id').eq('id', clause.document_id).maybeSingle(), 'doc') as { lease_id: string | null } | null;
  if (!clause || doc?.lease_id !== leaseId) throw new ApiError('not_found', 'Clause not found');

  const body = await readJson(c);
  const update: Record<string, unknown> = {};
  const changes: { action: 'type' | 'verify' | 'unverify' | 'dismiss' | 'restore'; old_value: string | null; new_value: string | null }[] = [];
  if ('clause_type' in body) {
    const type = str(body.clause_type);
    if (!type || !EDITABLE_TYPES.has(type)) throw badRequest('Choose a clause type from the list');
    if (type !== clause.clause_type) {
      const original = clause.original_clause_type ?? clause.clause_type;
      update.clause_type = type;
      update.original_clause_type = type === original ? null : original; // back to the prediction → no longer "changed"
      changes.push({ action: 'type', old_value: clause.clause_type, new_value: type });
    }
  }
  if (typeof body.verified === 'boolean' && body.verified !== clause.verified) {
    update.verified = body.verified;
    changes.push({ action: body.verified ? 'verify' : 'unverify', old_value: null, new_value: null });
  }
  if (typeof body.dismissed === 'boolean' && body.dismissed !== clause.dismissed) {
    update.dismissed = body.dismissed;
    changes.push({ action: body.dismissed ? 'dismiss' : 'restore', old_value: null, new_value: null });
  }
  if (!changes.length) return c.json({ id: clause.id, changed: false });

  const userId = c.get('user').id;
  const now = new Date().toISOString();
  must(await db().from('clauses').update({ ...update, edited_by: userId, edited_at: now }).eq('id', clause.id), 'save clause');
  must(await db().from('clause_edits').insert(changes.map((ch) => ({
    org_id: orgId, document_id: clause.document_id, lease_id: leaseId, clause_id: clause.id,
    clause_text: (clause.text ?? '').slice(0, 300), ...ch, edited_by: userId, edited_at: now,
  }))), 'record clause edit');
  await logAccess({ orgId, userId, action: 'edit', leaseId, documentId: clause.document_id, details: { clause_id: clause.id, changes } });
  return c.json({ id: clause.id, changed: true, ...update });
});

// POST /api/leases/:id/documents/:docId/clauses { clause_type, text, page, rects?, section? }
// A clause a user marked on the PDF (source 'user'): verified, kept across re-classification, recorded as 'add'.
router.post('/:id/documents/:docId/clauses', requireRole('editor'), async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const doc = await loadDoc(c, leaseId, c.req.param('docId'));
  const body = await readJson(c);
  const type = str(body.clause_type);
  if (!type || !EDITABLE_TYPES.has(type)) throw badRequest('Choose a clause type from the list');
  const text = str(body.text);
  if (!text) throw badRequest('Select the clause text in the document.');
  const page = Number(body.page);
  if (!Number.isInteger(page) || page < 1 || (doc.page_count && page > doc.page_count)) throw badRequest('Invalid page');
  const userId = c.get('user').id;
  const now = new Date().toISOString();
  const row = must(await db().from('clauses').insert({
    org_id: doc.org_id, document_id: doc.id, lease_id: leaseId, source: 'user', model: null,
    clause_type: type, confidence: null, alt_types: null, section: str(body.section)?.slice(0, 120) ?? null,
    page, paragraph: null, line: null, text: text.slice(0, 4000), rects: noteRects(body.rects),
    verified: true, dismissed: false, original_clause_type: null, created_by: userId, edited_by: userId, edited_at: now,
  }).select('id').single(), 'add clause') as { id: string };
  must(await db().from('clause_edits').insert({
    org_id: doc.org_id, document_id: doc.id, lease_id: leaseId, clause_id: row.id, clause_text: text.slice(0, 300),
    action: 'add', old_value: null, new_value: type, edited_by: userId, edited_at: now,
  }), 'record clause edit');
  await logAccess({ orgId: doc.org_id, userId, action: 'edit', leaseId, documentId: doc.id, details: { clause_id: row.id, added: type } });
  return c.json({ id: row.id }, 201);
});

// DELETE /api/leases/:id/clauses/:clauseId → only clauses a user added (predictions are removed with PATCH dismissed).
router.delete('/:id/clauses/:clauseId', requireRole('editor'), async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const orgId = c.get('orgId');
  const clauseId = c.req.param('clauseId');
  const clause = UUID_RE.test(clauseId)
    ? must(await db().from('clauses').select('id, document_id, lease_id, source, clause_type, text').eq('id', clauseId).eq('org_id', orgId).maybeSingle(), 'load clause') as
      { id: string; document_id: string; lease_id: string | null; source: string; clause_type: string; text: string | null } | null
    : null;
  if (!clause || clause.lease_id !== leaseId) throw new ApiError('not_found', 'Clause not found');
  if (clause.source !== 'user') throw badRequest('Only clauses added by a user can be deleted. Remove predicted clauses instead.');
  must(await db().from('clauses').delete().eq('id', clause.id), 'delete clause');
  const userId = c.get('user').id;
  must(await db().from('clause_edits').insert({
    org_id: orgId, document_id: clause.document_id, lease_id: leaseId, clause_id: clause.id, clause_text: (clause.text ?? '').slice(0, 300),
    action: 'delete', old_value: clause.clause_type, new_value: null, edited_by: userId, edited_at: new Date().toISOString(),
  }), 'record clause edit');
  return c.json({ ok: true });
});

interface ClauseOut {
  id: string; document_id: string; document_title: string | null; doc_type: string | null; clause_type: string;
  source: 'claude' | 'svm' | 'gateway' | 'langchain' | 'llama' | 'openai' | 'user'; model: string | null; confidence: number | null;
  original_clause_type: string | null; verified: boolean; dismissed: boolean; edited_at: string | null; alt_types: { type: string; confidence: number }[] | null; section: string | null;
  page: number | null; paragraph: number | null; line: number | null; text: string | null;
  rects: { x: number; y: number; w: number; h: number }[] | null; created_by: string | null; created_by_name?: string | null;
}

async function groupedClauses(orgId: string, leaseId: string, includeDismissed = false): Promise<{ clause_type: string; clauses: ClauseOut[] }[]> {
  const docs = must(await db().from('documents').select('id, title, doc_type, page_start').eq('org_id', orgId).eq('lease_id', leaseId), 'docs') as { id: string; title: string | null; doc_type: string }[];
  if (!docs.length) return [];
  const rows = must(await db().from('clauses')
    .select('id, document_id, clause_type, source, model, confidence, alt_types, section, page, paragraph, line, text, original_clause_type, verified, dismissed, edited_at, rects, created_by')
    .eq('org_id', orgId).in('document_id', docs.map((d) => d.id)), 'clauses') as Omit<ClauseOut, 'document_title' | 'doc_type'>[];
  if (!includeDismissed) rows.splice(0, rows.length, ...rows.filter((r) => !r.dismissed));
  const names = await userNames(rows.filter((r) => r.source === 'user').map((r) => r.created_by));
  for (const r of rows) r.created_by_name = r.created_by ? names.get(r.created_by) ?? null : null;
  const byId = new Map(docs.map((d) => [d.id, d]));
  const order = new Map<string, number>(CLAUSE_TYPES.map((t, i) => [t, i]));
  const groups = new Map<string, ClauseOut[]>();
  for (const r of rows) {
    const out: ClauseOut = { ...r, confidence: asNumber(r.confidence), document_title: byId.get(r.document_id)?.title ?? null, doc_type: byId.get(r.document_id)?.doc_type ?? null };
    groups.set(r.clause_type, [...(groups.get(r.clause_type) ?? []), out]);
  }
  return [...groups.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999) || a[0].localeCompare(b[0]))
    .map(([clause_type, list]) => ({
      clause_type,
      clauses: list.sort((a, b) => (a.document_title ?? '').localeCompare(b.document_title ?? '') || (a.page ?? 0) - (b.page ?? 0)),
    }));
}

// ---- Review ----------------------------------------------------------------------------------------
// Checks that the basic fields and expected clauses (lib/review-checklist.json) were predicted, plus reviewer verdicts.

async function reviewInputs(orgId: string, lease: LeaseRow) {
  const docs = await leaseDocuments(orgId, lease.id);
  const clauses = docs.length
    ? (must(await db().from('clauses').select('id, document_id, clause_type, source, confidence, page, text, verified')
      .eq('org_id', orgId).in('document_id', docs.map((d) => d.id)).eq('dismissed', false), 'clauses') as ReviewClause[])
      .map((r) => ({ ...r, confidence: asNumber(r.confidence) }))
    : [];
  return { docs: docs as ReviewDoc[], clauses, terms: (lease.current_terms ?? {}) as Record<string, TermValue> };
}

async function reviewPayload(orgId: string, lease: LeaseRow, row?: ReviewRow | null) {
  const inputs = await reviewInputs(orgId, lease);
  const saved = row === undefined ? await loadReviewRow(orgId, lease.id) : row;
  const userIds = [saved?.started_by ?? null, saved?.completed_by ?? null,
    ...Object.values(saved?.items?.fields ?? {}).map((v) => v.by), ...Object.values(saved?.items?.clauses ?? {}).map((v) => v.by)];
  return buildReview({ ...inputs, row: saved, names: await userNames(userIds) });
}

/** Saves the row's summary (shown in the leases list) from a freshly built payload. */
async function withSummary(orgId: string, lease: LeaseRow, row: ReviewRow, userId: string) {
  const payload = await reviewPayload(orgId, lease, row);
  const { issues, reviewed, total, correct, incorrect } = payload.summary;
  await saveReviewRow(orgId, lease.id, userId, { summary: { issues, reviewed, total, correct, incorrect } });
  return payload;
}

// GET /api/leases/:id/review → checklist items with predictions, automatic checks, AI check and verdicts
router.get('/:id/review', async (c) => {
  const lease = await loadLease(c, c.req.param('id'));
  return c.json(await reviewPayload(c.get('orgId'), lease));
});

// PUT /api/leases/:id/review/items { kind: field|clause, key, verdict|null, note? } → review payload
router.put('/:id/review/items', requireRole('editor'), async (c) => {
  const lease = await loadLease(c, c.req.param('id'));
  const orgId = c.get('orgId');
  const userId = c.get('user').id;
  const body = await readJson(c);
  const existing = await loadReviewRow(orgId, lease.id);
  if (existing?.status === 'completed') throw badRequest('This review is completed. Reopen it to make changes.');
  const items = withVerdict(existing?.items, { kind: body.kind, key: body.key, verdict: body.verdict, note: body.note }, userId);
  const row = await saveReviewRow(orgId, lease.id, userId, { items });
  return c.json(await withSummary(orgId, lease, row, userId));
});

// POST /api/leases/:id/review/ai-check → asks Claude to compare predictions with the documents; review payload
router.post('/:id/review/ai-check', requireRole('editor'), async (c) => {
  const lease = await loadLease(c, c.req.param('id'));
  const orgId = c.get('orgId');
  const profile = c.get('profile');
  if ((await loadReviewRow(orgId, lease.id))?.status === 'completed') throw badRequest('This review is completed. Reopen it to run the AI check.');
  const inputs = await reviewInputs(orgId, lease);
  if (!inputs.docs.length) throw badRequest('This lease has no documents to check.');
  const ai = await aiReviewCheck({ process: 'reanalysis', orgId, userId: profile.id, leaseId: lease.id }, { ...inputs, locale: profile.locale });
  const row = await saveReviewRow(orgId, lease.id, profile.id, { ai });
  return c.json(await withSummary(orgId, lease, row, profile.id));
});

// POST /api/leases/:id/review/complete { reopen?: boolean } → review payload
router.post('/:id/review/complete', requireRole('editor'), async (c) => {
  const lease = await loadLease(c, c.req.param('id'));
  const orgId = c.get('orgId');
  const userId = c.get('user').id;
  const body = await readJson(c);
  const reopen = body.reopen === true;
  const row = await saveReviewRow(orgId, lease.id, userId, reopen
    ? { status: 'in_progress', completed_by: null, completed_at: null }
    : { status: 'completed', completed_by: userId, completed_at: new Date().toISOString() });
  await logAccess({ orgId, userId, action: 'edit', leaseId: lease.id, details: { review: reopen ? 'reopened' : 'completed' } });
  return c.json(await withSummary(orgId, lease, row, userId));
});

// ---- Signatures ------------------------------------------------------------------------------------

router.get('/:id/documents/:docId/signature', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const doc = await loadDoc(c, leaseId, c.req.param('docId'));
  return c.json({ document_id: doc.id, signature: doc.signature });
});

// POST /api/leases/:id/documents/:docId/signature → re-check with AI (process 'signature')
router.post('/:id/documents/:docId/signature', requireRole('editor'), async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const doc = await loadDoc(c, leaseId, c.req.param('docId'));
  const profile = c.get('profile');
  const signature = await recheckSignature(doc.id, doc.org_id, profile.id, profile.locale);
  return c.json({ document_id: doc.id, signature });
});

// ---- Document of record ---------------------------------------------------------------------------

// POST /api/leases/:id/documents/:docId/verify → unchanged | changed | missing
router.post('/:id/documents/:docId/verify', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const doc = await loadDoc(c, leaseId, c.req.param('docId'));
  let result: 'unchanged' | 'changed' | 'missing' = 'missing';
  let actual: string | null = null;
  if (doc.storage_path) {
    try {
      actual = await sha256Hex(await downloadBytes(doc.storage_path));
      result = doc.sha256 && actual === doc.sha256 ? 'unchanged' : 'changed';
    } catch {
      result = 'missing';
    }
  }
  const checkedAt = new Date().toISOString();
  await logAccess({ orgId: doc.org_id, userId: c.get('user').id, action: 'verify', leaseId, documentId: doc.id, details: { result, expected: doc.sha256, actual } });
  return c.json({ document_id: doc.id, result, expected: doc.sha256, actual, checked_at: checkedAt });
});

// GET /api/leases/:id/access-log
router.get('/:id/access-log', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const orgId = c.get('orgId');
  const docIds = (must(await db().from('documents').select('id').eq('org_id', orgId).eq('lease_id', leaseId), 'docs') as { id: string }[]).map((d) => d.id);
  const filter = docIds.length ? `lease_id.eq.${leaseId},document_id.in.(${docIds.join(',')})` : `lease_id.eq.${leaseId}`;
  const rows = must(await db().from('access_log').select('id, action, lease_id, document_id, file_id, user_id, details, created_at')
    .eq('org_id', orgId).or(filter).order('created_at', { ascending: false }).limit(300), 'access log') as {
    id: number; action: string; document_id: string | null; file_id: string | null; user_id: string | null; details: Record<string, unknown> | null; created_at: string;
  }[];
  const users = await userNames(rows.map((r) => r.user_id));
  return c.json(rows.map((r) => ({ ...r, user_name: r.user_id ? users.get(r.user_id) ?? null : null })));
});

async function userNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!unique.length) return new Map();
  const rows = must(await db().from('profiles').select('id, email, display_name').in('id', unique), 'profiles') as { id: string; email: string | null; display_name: string | null }[];
  return new Map(rows.map((r) => [r.id, r.display_name || r.email || r.id]));
}

/** Clause edit history of a lease's documents, newest first. */
async function clauseHistory(orgId: string, leaseId: string) {
  const docs = must(await db().from('documents').select('id, title, doc_type').eq('org_id', orgId).eq('lease_id', leaseId), 'docs') as { id: string; title: string | null; doc_type: string }[];
  if (!docs.length) return [];
  const rows = must(await db().from('clause_edits')
    .select('id, document_id, clause_id, clause_text, action, old_value, new_value, edited_at, editor:profiles!clause_edits_profile_fk(email, display_name)')
    .eq('org_id', orgId).in('document_id', docs.map((d) => d.id)).order('edited_at', { ascending: false }).limit(500), 'clause edits') as unknown as {
    id: number; document_id: string; clause_id: string | null; clause_text: string | null; action: string;
    old_value: string | null; new_value: string | null; edited_at: string;
    editor: { email: string | null; display_name: string | null } | null;
  }[];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return rows.map((r) => ({
    id: r.id, document_id: r.document_id, document_title: byId.get(r.document_id)?.title ?? null, doc_type: byId.get(r.document_id)?.doc_type ?? null,
    clause_id: r.clause_id, clause_text: r.clause_text, action: r.action, old_value: r.old_value, new_value: r.new_value,
    edited_at: r.edited_at, edited_by: r.editor?.display_name || r.editor?.email || null,
  }));
}

// GET /api/leases/:id/activity → processing timeline, edits, AI usage per file
router.get('/:id/activity', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const orgId = c.get('orgId');
  const docs = must(await db().from('documents').select('id, file_id').eq('org_id', orgId).eq('lease_id', leaseId), 'docs') as { id: string; file_id: string | null }[];
  const fileIds = [...new Set(docs.map((d) => d.file_id).filter((v): v is string => Boolean(v)))];
  const targeted = must(await db().from('lease_files').select('id').eq('org_id', orgId).eq('target_lease_id', leaseId), 'files') as { id: string }[];
  for (const f of targeted) if (!fileIds.includes(f.id)) fileIds.push(f.id);

  const files = fileIds.length
    ? (must(await db().from('lease_files').select('id, file_name, status, error, steps, page_count, is_scanned, created_at, processed_at')
      .eq('org_id', orgId).in('id', fileIds).order('created_at'), 'files') as { id: string; file_name: string }[])
    : [];
  const logs = fileIds.length
    ? (must(await db().from('processing_logs').select('id, file_id, step, level, message, created_at').eq('org_id', orgId).in('file_id', fileIds).order('id').limit(1000), 'logs') as { file_id: string }[])
    : [];
  const usageFilter = fileIds.length ? `lease_id.eq.${leaseId},file_id.in.(${fileIds.join(',')})` : `lease_id.eq.${leaseId}`;
  const usageRows = must(await db().from('ai_usage').select('file_id, process, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, created_at')
    .eq('org_id', orgId).or(usageFilter).order('created_at'), 'usage') as {
    file_id: string | null; process: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; duration_ms: number | null;
  }[];
  const names = new Map(files.map((f) => [f.id, f.file_name]));
  const usage = new Map<string, Record<string, unknown> & { calls: number; input_tokens: number; output_tokens: number; cache_tokens: number; duration_ms: number }>();
  for (const u of usageRows) {
    const key = `${u.file_id ?? '-'}|${u.process}|${u.model}`;
    const agg = usage.get(key) ?? { file_id: u.file_id, file_name: u.file_id ? names.get(u.file_id) ?? null : null, process: u.process, model: u.model, calls: 0, input_tokens: 0, output_tokens: 0, cache_tokens: 0, duration_ms: 0 };
    agg.calls += 1;
    agg.input_tokens += u.input_tokens ?? 0;
    agg.output_tokens += u.output_tokens ?? 0;
    agg.cache_tokens += (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0);
    agg.duration_ms += u.duration_ms ?? 0;
    usage.set(key, agg);
  }
  return c.json({
    files: files.map((f) => ({ ...f, logs: logs.filter((l) => l.file_id === f.id) })),
    edits: await editHistory(orgId, leaseId),
    clause_edits: await clauseHistory(orgId, leaseId),
    usage: [...usage.values()],
  });
});

// ---- PDF report ------------------------------------------------------------------------------------

async function buildReport(c: Ctx, leaseId: string): Promise<{ bytes: Uint8Array; filename: string; tenant: string | null; orgName: string; logoUrl: string | null }> {
  const orgId = c.get('orgId');
  const detail = await leaseDetail(c, leaseId);
  const org = must(await db().from('organizations').select('name, currency, logo_path').eq('id', orgId).single(), 'org') as { name: string; currency: string; logo_path: string | null };
  const opportunities = must(await db().from('opportunities').select('category, kind, status, priority, summary, due_date, amount')
    .eq('org_id', orgId).eq('lease_id', leaseId).order('priority'), 'opportunities') as ReportInput['opportunities'];
  const groups = await groupedClauses(orgId, leaseId);
  const profile = c.get('profile');
  const logoUrl = publicLogoUrl(org.logo_path);
  const lease = detail.lease;
  const bytes = await buildLeaseReport({
    org: { name: org.name, currency: org.currency || 'USD', logoUrl },
    lease: { id: lease.id, tenant_name: lease.tenant_name, premises_address: lease.premises_address, status: lease.status, property_type: lease.property_type, current_terms: lease.current_terms },
    noticeBy: detail.notice_by,
    documents: detail.documents.map((d) => ({ ...d, signature: d.signature as { status?: string; method?: string } | null })),
    alerts: detail.alerts,
    opportunities: opportunities.map((o) => ({ ...o, amount: asNumber(o.amount) })),
    clauses: groups.flatMap((g) => g.clauses.map((cl) => ({ clause_type: cl.clause_type, confidence: cl.confidence, section: cl.section, page: cl.page, text: cl.text, document_title: cl.document_title }))),
    generatedBy: profile.display_name || profile.email,
  });
  const base = (lease.tenant_name || 'lease').replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 60) || 'lease';
  return { bytes, filename: `Lease-abstract-${base}.pdf`, tenant: lease.tenant_name, orgName: org.name, logoUrl };
}

// GET /api/leases/:id/report.pdf
router.get('/:id/report.pdf', async (c) => {
  const leaseId = c.req.param('id');
  const report = await buildReport(c, leaseId);
  await logAccess({ orgId: c.get('orgId'), userId: c.get('user').id, action: 'report_download', leaseId, details: { filename: report.filename } });
  return new Response(report.bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${report.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
});

// POST /api/leases/:id/report/email { to: string[] (≤10), message }
router.post('/:id/report/email', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const body = await readJson<{ to?: unknown; message?: unknown }>(c);
  const to = (Array.isArray(body.to) ? body.to : typeof body.to === 'string' ? body.to.split(/[,;\s]+/) : [])
    .map((v) => String(v).trim()).filter(Boolean);
  if (!to.length) throw badRequest('Add at least one recipient.');
  if (to.length > 10) throw badRequest('You can send to at most 10 recipients.');
  if (to.some((e) => !EMAIL_RE.test(e))) throw badRequest('Enter valid email addresses.');
  const message = str(body.message);
  const report = await buildReport(c, leaseId);
  const profile = c.get('profile');
  const sender = profile.display_name || profile.email || 'A Lease IQ user';
  const title = `Lease abstract: ${report.tenant ?? 'Lease'}`;
  const bodyHtml = `<p>${escapeHtml(sender)} shared the lease abstract for <strong>${escapeHtml(report.tenant ?? 'a lease')}</strong> with you. The PDF report is attached.</p>`
    + (message ? `<blockquote style="border-left:3px solid #e3e8f0;margin:16px 0;padding:4px 12px;color:#334155">${escapeHtml(message).replace(/\n/g, '<br>')}</blockquote>` : '');
  await sendEmail({
    to,
    subject: title,
    html: renderEmail({ title, bodyHtml, orgName: report.orgName, logoUrl: report.logoUrl }),
    text: `${sender} shared the lease abstract for ${report.tenant ?? 'a lease'}.${message ? `\n\n${message}` : ''}`,
    replyTo: profile.email ?? undefined,
    attachments: [{ filename: report.filename, content: toBase64(report.bytes), type: 'application/pdf' }],
  });
  await logAccess({ orgId: c.get('orgId'), userId: profile.id, action: 'email', leaseId, details: { to, filename: report.filename } });
  return c.json({ ok: true, sent: to.length });
});

// POST /api/leases/:id/report/saved { destination, name?, url? } → log a cloud save done by the browser
router.post('/:id/report/saved', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const body = await readJson(c);
  const destination = str(body.destination);
  if (!destination || !['google_drive', 'onedrive', 'sharepoint'].includes(destination)) throw badRequest('Invalid destination');
  const url = str(body.url);
  const link = url && /^https:\/\//i.test(url) && url.length <= 2000 ? url : null;
  await logAccess({ orgId: c.get('orgId'), userId: c.get('user').id, action: 'save', leaseId, details: { destination, name: str(body.name), url: link } });
  return c.json({ ok: true, url: link });
});

export default router;
