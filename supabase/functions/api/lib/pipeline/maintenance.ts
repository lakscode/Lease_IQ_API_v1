// Per-document AI re-runs (signature check, clause classification) and super-admin maintenance jobs.
import type { AiContext } from '../ai.ts';
import { db, must } from '../supabase.ts';
import { downloadBytes } from '../storage.ts';
import type { Locale } from '../types.ts';
import { checkSignatures } from './ai-steps.ts';
import { classifyDocumentClauses } from './clauses.ts';
import { extractPageTexts } from './pdf.ts';
import { documentInput, signatureRecord } from './store.ts';

interface DocRow {
  id: string;
  org_id: string;
  lease_id: string | null;
  file_id: string | null;
  storage_path: string | null;
  page_count: number | null;
  title: string | null;
}

const DOC_COLUMNS = 'id, org_id, lease_id, file_id, storage_path, page_count, title';

/** Re-check the signatures of one document (process 'signature'). Returns the stored signature record. */
export async function recheckSignature(documentId: string, orgId: string, userId: string | null, locale: Locale): Promise<Record<string, unknown> | null> {
  const doc = must(await db().from('documents').select(DOC_COLUMNS).eq('id', documentId).eq('org_id', orgId).single(), 'load document') as DocRow;
  const ctx: AiContext = { process: 'signature', orgId, userId, fileId: doc.file_id, leaseId: doc.lease_id };
  const result = await checkSignatures(ctx, await documentInput(doc), locale);
  const record = signatureRecord(result);
  must(await db().from('documents').update({ signature: record }).eq('id', documentId), 'save signature');
  return record;
}

/** Re-classify the clauses of one document with its organization's classifier (process 'reanalysis'). Returns the clause count. */
export async function reclassifyClauses(doc: DocRow, userId: string | null, locale: Locale): Promise<number> {
  return (await classifyDocumentClauses(doc, { userId, locale, process: 'reanalysis' })).count;
}

/** Every document that has text or a PDF (all organizations). */
export async function allDocuments(): Promise<DocRow[]> {
  const out: DocRow[] = [];
  for (let from = 0; ; from += 1000) {
    const batch = must(await db().from('documents').select(DOC_COLUMNS).order('created_at').range(from, from + 999)) as DocRow[];
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

/**
 * Re-classify every document with its organization's classifier. Organizations whose classifier turns out to be
 * unconfigured (no Claude key) are skipped for the rest of the run; their existing clauses are kept.
 */
export async function rebuildAllClauses(docs: DocRow[], userId: string | null, locale: Locale): Promise<void> {
  const unconfigured = new Set<string>();
  for (const doc of docs) {
    if (unconfigured.has(doc.org_id)) continue;
    try {
      await reclassifyClauses(doc, userId, locale);
    } catch (err) {
      console.error(`[rebuild-clauses] ${doc.id}:`, (err as Error).message);
      if ((err as { code?: string }).code === 'ai_not_configured') unconfigured.add(doc.org_id);
    }
  }
}

/**
 * Re-extract page text for documents whose pages are missing or empty (from the stored PDF).
 * Returns the number of pages written.
 */
export async function rebuildSearch(budgetMs = 240_000): Promise<{ pages: number; documents: number }> {
  const started = Date.now();
  const docs = (await allDocuments()).filter((d) => d.storage_path);
  let pages = 0;
  let documents = 0;
  for (const doc of docs) {
    if (Date.now() - started > budgetMs) break;
    const existing = must(await db().from('document_pages').select('page_number, text').eq('document_id', doc.id)) as { page_number: number; text: string }[];
    const filled = existing.filter((p) => p.text.trim().length > 0).length;
    if (existing.length >= (doc.page_count ?? 1) && filled > 0) continue;
    try {
      const texts = await extractPageTexts(await downloadBytes(doc.storage_path!));
      if (!texts.some((t) => t.trim())) continue;
      const rows = texts.map((text, i) => ({ document_id: doc.id, org_id: doc.org_id, page_number: i + 1, text }));
      for (let i = 0; i < rows.length; i += 200) {
        must(await db().from('document_pages').upsert(rows.slice(i, i + 200)), 'save pages');
      }
      pages += rows.length;
      documents += 1;
    } catch (err) {
      console.error(`[rebuild-search] ${doc.id}:`, (err as Error).message);
    }
  }
  return { pages, documents };
}
