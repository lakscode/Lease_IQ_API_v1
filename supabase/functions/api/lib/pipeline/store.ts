// Non-AI persistence for the lease pipeline: saving split documents, applying abstracts, linking documents
// to lease families, and cleaning up. Everything here is testable without Claude.
import { ABSTRACT_FIELDS, CLAUSE_TYPES, DOC_TYPES, coerceFieldValue } from '../abstract.ts';
import { db, must } from '../supabase.ts';
import { downloadBytes, removePaths, sha256Hex, uploadBytes } from '../storage.ts';
import type { DocType } from '../types.ts';
import { getSetting, SETTINGS } from '../settings.ts';
import { fitsAiPdfLimits, hasUsableText, loadPdf, pickPages, subPdf, visualPages } from './pdf.ts';
import type { DocumentInput } from './ai-steps.ts';
import type {
  AbstractResult, ClauseResult, FileWork, LeaseFileRow, PreviousMapping, SignatureResult, SplitDocument, SplitResult,
} from './types.ts';

const CLAUSE_SET = new Set<string>(CLAUSE_TYPES);
const DOC_TYPE_SET = new Set<string>(DOC_TYPES);

export function documentPath(orgId: string, documentId: string): string {
  return `${orgId}/documents/${documentId}.pdf`;
}

function validDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null;
}

// ---- Split -------------------------------------------------------------------------------------

/**
 * Clean up a split result: clamp page ranges, sort, remove overlaps and give uncovered pages to the
 * preceding document. An empty result becomes one "main_lease" covering the whole file.
 */
export function normalizeSplit(result: SplitResult, totalPages: number): SplitDocument[] {
  const total = Math.max(1, totalPages);
  const raw = (result.documents ?? [])
    .map((d) => ({
      doc_type: (DOC_TYPE_SET.has(d.doc_type) ? d.doc_type : 'other') as DocType,
      title: d.title?.trim() || null,
      effective_date: validDate(d.effective_date),
      page_start: Math.max(1, Math.min(total, Math.round(Number(d.page_start) || 1))),
      page_end: Math.max(1, Math.min(total, Math.round(Number(d.page_end) || total))),
    }))
    .map((d) => (d.page_end < d.page_start ? { ...d, page_end: d.page_start } : d))
    .sort((a, b) => a.page_start - b.page_start || a.page_end - b.page_end);

  const docs: SplitDocument[] = [];
  for (const d of raw) {
    const prev = docs[docs.length - 1];
    if (prev && d.page_start <= prev.page_end) {
      if (d.page_end <= prev.page_end) continue; // fully inside the previous one
      d.page_start = prev.page_end + 1;
    }
    if (prev && d.page_start > prev.page_end + 1) prev.page_end = d.page_start - 1; // gap → previous doc
    docs.push({ index: docs.length, ...d });
  }
  if (docs.length === 0) {
    return [{ index: 0, doc_type: 'main_lease', title: null, effective_date: null, page_start: 1, page_end: total }];
  }
  docs[0].page_start = 1;
  docs[docs.length - 1].page_end = total;
  return docs;
}

export async function loadFilePageTexts(fileId: string): Promise<{ page: number; text: string }[]> {
  const rows: { page_number: number; text: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const batch = must(await db().from('lease_file_pages').select('page_number, text').eq('file_id', fileId)
      .order('page_number').range(from, from + 999)) as { page_number: number; text: string }[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows.map((r) => ({ page: r.page_number, text: r.text }));
}

export async function savePageTexts(file: { id: string; org_id: string }, pages: { page: number; text: string }[], source: 'text' | 'ocr'): Promise<void> {
  const rows = pages.map((p) => ({ file_id: file.id, org_id: file.org_id, page_number: p.page, text: p.text, source }));
  for (let i = 0; i < rows.length; i += 200) {
    must(await db().from('lease_file_pages').upsert(rows.slice(i, i + 200)), 'save page text');
  }
}

/** Documents (with storage) created from a file. */
async function fileDocuments(fileId: string): Promise<{ id: string; storage_path: string | null; lease_id: string | null }[]> {
  return must(await db().from('documents').select('id, storage_path, lease_id').eq('file_id', fileId)) as {
    id: string; storage_path: string | null; lease_id: string | null;
  }[];
}

/** Remove a file's documents (rows + stored PDFs). Returns the lease ids they belonged to. */
export async function removeFileDocuments(fileId: string): Promise<string[]> {
  const docs = await fileDocuments(fileId);
  await removePaths(docs.map((d) => d.storage_path ?? ''));
  if (docs.length) must(await db().from('documents').delete().in('id', docs.map((d) => d.id)), 'delete documents');
  return [...new Set(docs.map((d) => d.lease_id).filter((v): v is string => Boolean(v)))];
}

/**
 * Save the split: one PDF per document in storage ({org}/documents/{id}.pdf), its SHA-256, the documents row
 * (not yet linked to a lease) and its pages in document_pages. Replaces any documents the file had.
 */
export async function saveSplit(file: LeaseFileRow, docs: SplitDocument[], fileBytes?: Uint8Array): Promise<SplitDocument[]> {
  await removeFileDocuments(file.id);
  const bytes = fileBytes ?? (await downloadBytes(file.storage_path));
  const pdf = await loadPdf(bytes);
  const pageTexts = await loadFilePageTexts(file.id);
  const textByPage = new Map(pageTexts.map((p) => [p.page, p.text]));
  const out: SplitDocument[] = [];

  for (const d of docs) {
    const id = crypto.randomUUID();
    const docBytes = docs.length === 1 && d.page_start === 1 && d.page_end === pdf.getPageCount()
      ? bytes
      : await subPdf(pdf, d.page_start, d.page_end);
    const path = documentPath(file.org_id, id);
    await uploadBytes(path, docBytes, 'application/pdf');
    const sha256 = await sha256Hex(docBytes);
    const pageCount = d.page_end - d.page_start + 1;
    must(await db().from('documents').insert({
      id,
      org_id: file.org_id,
      file_id: file.id,
      lease_id: null,
      doc_type: d.doc_type,
      title: d.title,
      effective_date: d.effective_date,
      page_start: d.page_start,
      page_end: d.page_end,
      page_count: pageCount,
      storage_path: path,
      sha256,
      is_scanned: file.is_scanned,
      abstract: {},
    }), 'insert document');
    const pages = Array.from({ length: pageCount }, (_, k) => ({
      document_id: id,
      org_id: file.org_id,
      page_number: k + 1,
      text: textByPage.get(d.page_start + k) ?? '',
    }));
    for (let i = 0; i < pages.length; i += 200) {
      must(await db().from('document_pages').insert(pages.slice(i, i + 200)), 'insert document pages');
    }
    out.push({ ...d, document_id: id });
  }
  return out;
}

// ---- Inputs for AI calls --------------------------------------------------------------------------

export async function documentPages(documentId: string): Promise<{ page: number; text: string }[]> {
  const rows = must(await db().from('document_pages').select('page_number, text').eq('document_id', documentId).order('page_number')) as {
    page_number: number; text: string;
  }[];
  return rows.map((r) => ({ page: r.page_number, text: r.text }));
}

export type AiMode = 'economy' | 'quality';

/**
 * How much of each document Claude reads (super admin setting, default economy):
 *   economy: page text, plus a PDF of only the signature / image-only pages; split sees page previews; abstract effort medium
 *   quality: the whole PDF for every call; abstract effort high (about 3–5× the input tokens)
 */
export async function aiMode(): Promise<AiMode> {
  return (await getSetting<string>(SETTINGS.aiMode, 'economy')) === 'quality' ? 'quality' : 'economy';
}

/**
 * Claude input for a stored document. Economy mode (when the pages have text): the page texts plus, unless
 * `visual` is false, a small PDF of the signature / image-only pages. Otherwise the document's PDF when it fits
 * Claude's limits, or its page texts.
 */
export async function documentInput(
  doc: { id: string; storage_path: string | null; page_count: number | null; title?: string | null },
  opts: { visual?: boolean } = {},
): Promise<DocumentInput> {
  if ((await aiMode()) === 'economy') {
    const pages = await documentPages(doc.id);
    if (hasUsableText(pages.map((p) => p.text))) {
      if (opts.visual === false || !doc.storage_path) return { kind: 'text', pages };
      try {
        const picked = visualPages(pages);
        return { kind: 'text', pages, visual: { bytes: await pickPages(await downloadBytes(doc.storage_path), picked), pages: picked } };
      } catch {
        return { kind: 'text', pages };
      }
    }
  }
  if (doc.storage_path) {
    try {
      const bytes = await downloadBytes(doc.storage_path);
      if (fitsAiPdfLimits(doc.page_count ?? 0, bytes.length)) return { kind: 'pdf', bytes, title: doc.title ?? undefined };
    } catch {
      // fall back to text
    }
  }
  return { kind: 'text', pages: await documentPages(doc.id) };
}

// ---- Linking -----------------------------------------------------------------------------------

export interface LeaseCandidate {
  id: string;
  tenant_name: string | null;
  landlord_name: string | null;
  premises_address: string | null;
  commencement_date: string | null;
  expiration_date: string | null;
  main_document_id: string | null;
}

export async function leaseCandidates(orgId: string, limit = 300): Promise<LeaseCandidate[]> {
  return must(await db().from('leases')
    .select('id, tenant_name, landlord_name, premises_address, commencement_date, expiration_date, main_document_id')
    .eq('org_id', orgId).order('updated_at', { ascending: false }).limit(limit)) as LeaseCandidate[];
}

// Words that say nothing about which lease a document belongs to.
const GENERIC_WORDS = new Set([
  'the', 'and', 'llc', 'inc', 'ltd', 'corp', 'corporation', 'company', 'limited', 'partnership', 'group', 'holdings',
  'street', 'road', 'avenue', 'ave', 'suite', 'floor', 'unit', 'building', 'drive', 'boulevard', 'blvd', 'lane',
  'north', 'south', 'east', 'west', 'tenant', 'landlord', 'lease', 'properties', 'property', 'trust', 'center',
  'way', 'court', 'place', 'plaza', 'park', 'highway', 'route', 'city', 'state',
]);
// Words start with a letter: bare numbers (street numbers) also match amounts and dates in any lease.
const words = (s: string | null | undefined) =>
  new Set((s ?? '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g)?.filter((w) => !GENERIC_WORDS.has(w)) ?? []);

/**
 * Existing leases worth showing the AI for linking: those whose tenant, landlord or address words appear in the
 * document text (best matches first, at most `max`), plus the lease the user picked. Sending the whole portfolio
 * costs ~60 input tokens per lease on every document.
 */
export function relevantCandidates<T extends LeaseCandidate>(candidates: T[], documentText: string, targetLeaseId: string | null, max = 12): T[] {
  const text = words(documentText);
  // Share of a name's distinctive words found in the document (0..1), and how many matched.
  const match = (name: string | null) => {
    const w = [...words(name)];
    const hits = w.filter((x) => text.has(x)).length;
    return { hits, share: w.length ? hits / w.length : 0 };
  };
  const scored = candidates.map((c) => {
    const tenant = match(c.tenant_name);
    const address = match(c.premises_address);
    const landlord = match(c.landlord_name);
    // Most of the tenant name, or most of a multi-word address, identifies a lease; a landlord alone is weak.
    const strong = tenant.share > 0.5 || (address.hits >= 2 && address.share >= 0.5);
    const score = c.id === targetLeaseId ? 1000 : tenant.share * 3 + address.share * 2 + landlord.share;
    return { c, score, strong };
  });
  return scored
    .filter((s) => s.score >= 1000 || s.strong)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.c);
}

/** A completed file in the organization with exactly the same content (same SHA-256), if any. */
export async function duplicateFile(orgId: string, fileId: string, sha256: string): Promise<{ id: string; file_name: string; created_at: string } | null> {
  const { data } = await db().from('lease_files').select('id, file_name, created_at')
    .eq('org_id', orgId).eq('sha256', sha256).eq('status', 'completed').neq('id', fileId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string; file_name: string; created_at: string } | null) ?? null;
}

async function leaseInOrg(orgId: string, leaseId: string | null | undefined): Promise<LeaseCandidate | null> {
  if (!leaseId || !/^[0-9a-f-]{36}$/i.test(leaseId)) return null;
  const { data } = await db().from('leases')
    .select('id, tenant_name, landlord_name, premises_address, commencement_date, expiration_date, main_document_id')
    .eq('id', leaseId).eq('org_id', orgId).maybeSingle();
  return (data as LeaseCandidate | null) ?? null;
}

function overlap(a: { page_start: number | null; page_end: number | null }, b: { page_start: number; page_end: number }): number {
  if (a.page_start == null || a.page_end == null) return 0;
  return Math.max(0, Math.min(a.page_end, b.page_end) - Math.max(a.page_start, b.page_start) + 1);
}

/**
 * Decide which lease family a document belongs to (creating a lease when needed).
 * Order: previous mapping (re-analysis keeps lease ids) → upload target (amendments) → same-file main lease →
 * existing lease named by the AI → an unused previous lease (re-analysis) → new lease.
 */
export async function resolveLease(
  file: LeaseFileRow,
  work: FileWork,
  doc: SplitDocument,
  link: AbstractResult['link'] | null,
): Promise<{ leaseId: string; created: boolean; reason: string }> {
  const orgId = file.org_id;
  const docs = work.documents ?? [];
  const previous = work.previous ?? [];
  const isMain = doc.doc_type === 'main_lease';

  // 1. Re-analysis: the previous document at these pages keeps its lease.
  if (work.mode === 'reanalysis' && previous.length) {
    const best = previous
      .map((p) => ({ p, o: overlap(p, doc) }))
      .filter((x) => x.o > 0)
      .sort((a, b) => b.o - a.o)[0];
    if (best && (await leaseInOrg(orgId, best.p.lease_id))) {
      return { leaseId: best.p.lease_id, created: false, reason: 'previous mapping' };
    }
  }

  // Lease ids already assigned to other documents of this file.
  const assigned = new Map<number, string>();
  const ids = docs.map((d) => d.document_id).filter((v): v is string => Boolean(v));
  if (ids.length) {
    const rows = must(await db().from('documents').select('id, lease_id').in('id', ids)) as { id: string; lease_id: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r.lease_id]));
    for (const d of docs) {
      const l = d.document_id ? byId.get(d.document_id) : null;
      if (l && d.index !== doc.index) assigned.set(d.index, l);
    }
  }

  if (!isMain) {
    // 2. Explicit upload target.
    if (await leaseInOrg(orgId, file.target_lease_id)) {
      return { leaseId: file.target_lease_id!, created: false, reason: 'upload target' };
    }
    // 3. Main lease in the same file.
    if (link?.kind === 'same_file' && link.document_index != null && assigned.has(link.document_index)) {
      return { leaseId: assigned.get(link.document_index)!, created: false, reason: 'same file (AI)' };
    }
    const mains = docs.filter((d) => d.doc_type === 'main_lease' && assigned.has(d.index));
    if (mains.length === 1 && link?.kind !== 'existing_lease') {
      return { leaseId: assigned.get(mains[0].index)!, created: false, reason: 'same file' };
    }
    // 4. Existing lease chosen by the AI.
    if (link?.kind === 'existing_lease' && (await leaseInOrg(orgId, link.lease_id))) {
      return { leaseId: link.lease_id!, created: false, reason: 'existing lease (AI)' };
    }
  } else {
    // A main lease can fill an existing family whose main lease is missing.
    const target = await leaseInOrg(orgId, file.target_lease_id);
    if (target && !target.main_document_id) return { leaseId: target.id, created: false, reason: 'upload target (missing main lease)' };
    if (link?.kind === 'existing_lease') {
      const existing = await leaseInOrg(orgId, link.lease_id);
      if (existing && !existing.main_document_id) return { leaseId: existing.id, created: false, reason: 'existing lease missing its main lease (AI)' };
    }
  }

  // 5. Re-analysis: reuse a previous lease no document has claimed yet, so no lease (and its saved work) is lost.
  if (work.mode === 'reanalysis' && previous.length) {
    const used = new Set(assigned.values());
    const unused = [...new Set(previous.map((p) => p.lease_id))].find((id) => !used.has(id));
    if (unused && (await leaseInOrg(orgId, unused))) return { leaseId: unused, created: false, reason: 'previous lease reused' };
  }

  // 6. New lease family.
  const created = must(await db().from('leases').insert({ org_id: orgId }).select('id').single(), 'create lease') as { id: string };
  return { leaseId: created.id, created: true, reason: 'new lease' };
}

// ---- Abstract ------------------------------------------------------------------------------------

export function signatureRecord(sig: SignatureResult | null | undefined): Record<string, unknown> | null {
  if (!sig) return null;
  return {
    status: sig.status ?? 'unclear',
    method: sig.method ?? 'unknown',
    parties: (sig.parties ?? []).map((p) => ({ party: p.party, signer: p.signer ?? null, date: validDate(p.date) ?? p.date ?? null })),
    signature_pages: sig.signature_pages ?? [],
    notes: sig.notes ?? null,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Which classifier produced a clause: Claude AI or a Vercel AI Gateway model (CLAUSE_TYPES names), or the local SVM,
 * LangChain or Llama (lease_clauses.json names).
 */
export type ClauseSource = 'claude' | 'svm' | 'gateway' | 'langchain' | 'llama' | 'openai';

export function clauseRows(orgId: string, documentId: string, leaseId: string | null, clauses: ClauseResult[], source: ClauseSource = 'claude', model: string | null = null) {
  const known = (type: string) => source === 'svm' || source === 'langchain' || source === 'llama' || CLAUSE_SET.has(type);
  return clauses
    .filter((c) => c && c.clause_type)
    .map((c) => ({
      org_id: orgId,
      document_id: documentId,
      lease_id: leaseId,
      source,
      model,
      clause_type: known(c.clause_type) ? c.clause_type : 'Miscellaneous',
      confidence: Number.isFinite(Number(c.confidence)) ? Math.max(0, Math.min(1, Number(c.confidence))) : null,
      alt_types: (c.alternatives ?? []).filter((a) => known(a.type) && a.type !== c.clause_type).slice(0, 3)
        .map((a) => ({ type: a.type, confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)) })),
      section: c.section ?? null,
      page: Number.isInteger(c.page) ? c.page : null,
      paragraph: Number.isInteger(c.paragraph) ? c.paragraph : null,
      line: Number.isInteger(c.line) ? c.line : null,
      text: (c.excerpt ?? '').slice(0, 1000),
    }));
}

interface EditedClause {
  text: string | null; clause_type: string; original_clause_type: string | null;
  verified: boolean; dismissed: boolean; edited_by: string | null; edited_at: string;
}
const clauseKey = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Replace a document's predicted clauses with the output of one classifier. Clauses a user edited (type, verified,
 * removed) keep those edits when the new output has a clause with the same text. Clauses a user added (source
 * 'user') are left alone.
 */
export async function replaceClauses(orgId: string, documentId: string, leaseId: string | null, clauses: ClauseResult[], source: ClauseSource = 'claude', model: string | null = null): Promise<number> {
  const edited = must(await db().from('clauses')
    .select('text, clause_type, original_clause_type, verified, dismissed, edited_by, edited_at')
    .eq('document_id', documentId).neq('source', 'user').not('edited_at', 'is', null), 'load edited clauses') as EditedClause[];
  const edits = new Map(edited.map((e) => [clauseKey(e.text), e]));
  must(await db().from('clauses').delete().eq('document_id', documentId).neq('source', 'user'), 'delete clauses');
  // Every row carries every edit column: a bulk insert fills columns missing from some rows with NULL, not the default.
  const unedited = { original_clause_type: null, verified: false, dismissed: false, edited_by: null, edited_at: null };
  const rows = clauseRows(orgId, documentId, leaseId, clauses, source, model).map((r) => {
    const e = edits.get(clauseKey(r.text));
    if (!e) return { ...r, ...unedited };
    // The user's type wins; remember the new prediction when it differs.
    return {
      ...r, clause_type: e.clause_type, original_clause_type: e.clause_type !== r.clause_type ? r.clause_type : null,
      verified: e.verified, dismissed: e.dismissed, edited_by: e.edited_by, edited_at: e.edited_at,
    };
  });
  for (let i = 0; i < rows.length; i += 200) must(await db().from('clauses').insert(rows.slice(i, i + 200)), 'insert clauses');
  return rows.length;
}

/** Turn the AI's fields into documents.abstract ({key: value, pages: {key: page}}). */
export function buildAbstract(fields: AbstractResult['fields'], changesMade: string | null): Record<string, unknown> {
  const abstract: Record<string, unknown> = {};
  const pages: Record<string, number> = {};
  for (const f of ABSTRACT_FIELDS) {
    if (f.key === 'changes_made') continue;
    const entry = fields?.[f.key];
    const value = coerceFieldValue(f, entry?.value);
    if (value === null) continue;
    abstract[f.key] = value;
    if (entry?.page && Number.isInteger(entry.page)) pages[f.key] = entry.page;
  }
  if (changesMade) abstract.changes_made = changesMade;
  abstract.pages = pages;
  return abstract;
}

/** Store an abstract result on its document and link it to a lease. Clauses are stored by pipeline/clauses.ts. */
export async function applyAbstract(doc: SplitDocument, result: AbstractResult, leaseId: string): Promise<void> {
  if (!doc.document_id) throw new Error(`Document ${doc.index} was not saved`);
  const changes = doc.doc_type === 'main_lease' ? null : (result.changes_made?.trim() || null);
  const update: Record<string, unknown> = {
    lease_id: leaseId,
    abstract: buildAbstract(result.fields, changes),
    summary: result.summary?.trim() || null,
    changes_made: changes,
    signature: signatureRecord(result.signature),
    ai_provider: result.ai?.provider ?? null,
    ai_model: result.ai?.model ?? null,
  };
  const eff = validDate(result.effective_date);
  if (!doc.effective_date && eff) update.effective_date = eff;
  must(await db().from('documents').update(update).eq('id', doc.document_id), 'save abstract');
}

/** Previous document → lease mapping of a file (taken before a re-analysis). */
export async function previousMapping(fileId: string): Promise<PreviousMapping[]> {
  const rows = must(await db().from('documents').select('lease_id, doc_type, page_start, page_end').eq('file_id', fileId)) as {
    lease_id: string | null; doc_type: DocType; page_start: number | null; page_end: number | null;
  }[];
  return rows.filter((r) => r.lease_id).map((r) => ({ lease_id: r.lease_id!, doc_type: r.doc_type, page_start: r.page_start, page_end: r.page_end }));
}
