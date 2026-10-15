// Local SVM clause classification of a stored document (source 'svm'). Reads document_pages, so it needs no AI key.
import { db, must } from '../supabase.ts';
import { abstractClauses } from '../clause-svm.ts';
import { replaceClauses } from './store.ts';

/** Segments below this confidence are not stored (≈90% accuracy above it in cross-validation). */
const MIN_CONFIDENCE = 0.5;
const SECTION_RE = /^\s*(?:(?:ARTICLE|Article|SECTION|Section|§)\s+([\dIVXLC]+(?:\.\d+)*)|(\d{1,2}(?:\.\d{1,3})+|\d{1,2})[.)]\s)/;

/** Classify one document's pages with the SVM and replace its 'svm' clauses. Returns the clause count. */
export async function classifyDocumentSvm(orgId: string, documentId: string, leaseId: string | null): Promise<number> {
  const pages = must(await db().from('document_pages').select('page_number, text').eq('document_id', documentId).order('page_number'), 'load pages') as { page_number: number; text: string }[];
  if (!pages.some((p) => p.text?.trim())) return replaceClauses(orgId, documentId, leaseId, [], 'svm');
  const texts: string[] = [];
  for (const p of pages) texts[p.page_number - 1] = p.text ?? '';
  const result = await abstractClauses(Array.from(texts, (t) => t ?? ''), { minConfidence: MIN_CONFIDENCE });
  const keep = new Set(result.clauses.flatMap((g) => g.segments));
  const clauses = result.segments.filter((s) => keep.has(s.index)).map((s) => {
    const m = SECTION_RE.exec(s.text);
    return {
      clause_type: s.clause_name,
      confidence: s.confidence,
      alternatives: s.alternatives.filter((a) => a.confidence >= 0.05).map((a) => ({ type: a.clause_name, confidence: a.confidence })),
      section: m ? (m[1] ?? m[2]) : null,
      page: pages.length > 1 ? s.page : 1,
      paragraph: null,
      line: null,
      excerpt: s.text,
    };
  });
  return replaceClauses(orgId, documentId, leaseId, clauses, 'svm');
}

/** Same as classifyDocumentSvm, but never throws (the SVM pass must not fail an AI pipeline step). */
export async function classifyDocumentSvmSafe(orgId: string, documentId: string, leaseId: string | null): Promise<number> {
  try {
    return await classifyDocumentSvm(orgId, documentId, leaseId);
  } catch (err) {
    console.error(`[svm-clauses] ${documentId}:`, (err as Error).message);
    return 0;
  }
}
