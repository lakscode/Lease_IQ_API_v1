// Lease families: list, detail ("as amended"), documents, abstract edits, clauses, signatures, document of record,
// access log, activity and the PDF abstract report (owned by the leases area).
import { Hono, type Context } from 'hono';
import type { AppEnv, LeaseStatus } from '../lib/types.ts';
import { requireRole, withOrg } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, readJson, str } from '../lib/http.ts';
import { ABSTRACT_FIELDS, CLAUSE_TYPES, coerceFieldValue } from '../lib/abstract.ts';
import { computeAlerts, noticeByDate, recomputeLease, sortFamily, type FamilyDocument, type TermValue } from '../lib/lease-terms.ts';
import { logAccess } from '../lib/access-log.ts';
import { downloadBytes, publicLogoUrl, sha256Hex, signedUrl } from '../lib/storage.ts';
import { escapeHtml, renderEmail, sendEmail } from '../lib/email.ts';
import { toBase64 } from '../lib/ai.ts';
import { recheckSignature } from '../lib/pipeline/maintenance.ts';
import { buildLeaseReport, type ReportInput } from '../lib/pdf-report.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

type Ctx = Context<AppEnv>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES: LeaseStatus[] = ['active', 'expiring', 'expired', 'renewed', 'unknown'];

const LEASE_COLUMNS =
  'id, tenant_name, landlord_name, premises_address, rentable_area, commencement_date, expiration_date, base_rent_monthly, status, property_type, risk_score, main_document_id, updated_at';

const DOC_COLUMNS =
  'id, org_id, lease_id, file_id, doc_type, title, effective_date, page_start, page_end, page_count, storage_path, sha256, abstract, summary, changes_made, signature, is_scanned, created_at, updated_at';

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

async function leaseDetail(c: Ctx, id: string) {
  const orgId = c.get('orgId');
  const lease = await loadLease(c, id);
  const docs = await leaseDocuments(orgId, id);
  const fileIds = [...new Set(docs.map((d) => d.file_id).filter((v): v is string => Boolean(v)))];
  const terms = (lease.current_terms ?? {}) as Record<string, TermValue>;
  const alerts = computeAlerts({
    status: lease.status,
    terms,
    hasMainLease: docs.some((d) => d.doc_type === 'main_lease'),
    failedFiles: await failedFilesFor(orgId, id, fileIds),
  });
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
  return c.json(rows.map((r) => listItem(r, r.documents?.[0]?.count ?? 0)));
});

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

// GET /api/leases/:id/clauses → grouped by type
router.get('/:id/clauses', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  return c.json(await groupedClauses(c.get('orgId'), leaseId));
});

interface ClauseOut {
  id: string; document_id: string; document_title: string | null; doc_type: string | null; clause_type: string;
  confidence: number | null; alt_types: { type: string; confidence: number }[] | null; section: string | null;
  page: number | null; paragraph: number | null; line: number | null; text: string | null;
}

async function groupedClauses(orgId: string, leaseId: string): Promise<{ clause_type: string; clauses: ClauseOut[] }[]> {
  const docs = must(await db().from('documents').select('id, title, doc_type, page_start').eq('org_id', orgId).eq('lease_id', leaseId), 'docs') as { id: string; title: string | null; doc_type: string }[];
  if (!docs.length) return [];
  const rows = must(await db().from('clauses')
    .select('id, document_id, clause_type, confidence, alt_types, section, page, paragraph, line, text')
    .eq('org_id', orgId).in('document_id', docs.map((d) => d.id)), 'clauses') as Omit<ClauseOut, 'document_title' | 'doc_type'>[];
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

// POST /api/leases/:id/report/saved { destination, name? } → log a cloud save done by the browser
router.post('/:id/report/saved', async (c) => {
  const leaseId = c.req.param('id');
  await loadLease(c, leaseId);
  const body = await readJson(c);
  const destination = str(body.destination);
  if (!destination || !['google_drive', 'onedrive', 'sharepoint'].includes(destination)) throw badRequest('Invalid destination');
  await logAccess({ orgId: c.get('orgId'), userId: c.get('user').id, action: 'save', leaseId, details: { destination, name: str(body.name) } });
  return c.json({ ok: true });
});

export default router;
