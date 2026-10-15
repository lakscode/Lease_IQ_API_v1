// Clause classification of a stored document with the organization's chosen classifier (organizations.clause_classifier):
//   claude  → Claude AI (from the abstract step, or a re-classification call)
//   svm     → local SVM model (lib/clause-svm.ts), no AI key needed
//   gateway → an LLM through Vercel AI Gateway (organizations.clause_model)
// Each run replaces all of the document's clauses; clauses.source / clauses.model record what produced them.
import { getModel, languageInstruction, s, type AiProcess } from '../ai.ts';
import { callGatewayJson } from '../ai-gateway.ts';
import { abstractClauses, clauseSvmInfo } from '../clause-svm.ts';
import { db, must } from '../supabase.ts';
import type { Locale } from '../types.ts';
import { CLAUSE_SCHEMA, classifyClauses } from './ai-steps.ts';
import { withPageMarkers } from './pdf.ts';
import { documentInput, documentPages, replaceClauses, type ClauseSource } from './store.ts';
import type { ClauseResult } from './types.ts';

export type ClauseClassifier = ClauseSource;
export const CLAUSE_CLASSIFIERS: readonly ClauseClassifier[] = ['claude', 'svm', 'gateway'];

export interface OrgClassifier { classifier: ClauseClassifier; model: string | null }

export interface ClauseDoc {
  id: string;
  org_id: string;
  lease_id: string | null;
  file_id: string | null;
  storage_path: string | null;
  page_count: number | null;
  title: string | null;
}

/** Segments below this SVM confidence are not stored (≈90% accuracy above it in cross-validation). */
const SVM_MIN_CONFIDENCE = 0.5;
const SECTION_RE = /^\s*(?:(?:ARTICLE|Article|SECTION|Section|§)\s+([\dIVXLC]+(?:\.\d+)*)|(\d{1,2}(?:\.\d{1,3})+|\d{1,2})[.)]\s)/;

export async function orgClauseClassifier(orgId: string): Promise<OrgClassifier> {
  const { data, error } = await db().from('organizations').select('clause_classifier, clause_model').eq('id', orgId).maybeSingle();
  // Don't silently fall back to Claude: a missing column means migration 0202 has not been applied.
  if (error) throw new Error(`Could not read the organization's clause classifier (apply migrations 0201/0202): ${error.message}`);
  const value = data?.clause_classifier as ClauseClassifier | undefined;
  const classifier = value && CLAUSE_CLASSIFIERS.includes(value) ? value : 'svm'; // column default (migration 0203)
  return { classifier, model: classifier === 'gateway' ? ((data?.clause_model as string | null) ?? null) : null };
}

/** Classify one document's pages with the SVM and replace its clauses. Returns the clause count. */
export async function classifyDocumentSvm(orgId: string, documentId: string, leaseId: string | null): Promise<number> {
  const pages = await documentPages(documentId);
  const { trained_at } = await clauseSvmInfo();
  const model = `lease-clauses-svm@${trained_at.slice(0, 10)}`;
  if (!pages.some((p) => p.text?.trim())) return replaceClauses(orgId, documentId, leaseId, [], 'svm', model);
  const texts: string[] = [];
  for (const p of pages) texts[p.page - 1] = p.text ?? '';
  const result = await abstractClauses(Array.from(texts, (t) => t ?? ''), { minConfidence: SVM_MIN_CONFIDENCE });
  const keep = new Set(result.clauses.flatMap((g) => g.segments));
  const clauses: ClauseResult[] = result.segments.filter((seg) => keep.has(seg.index)).map((seg) => {
    const m = SECTION_RE.exec(seg.text);
    return {
      clause_type: seg.clause_name,
      confidence: seg.confidence,
      alternatives: seg.alternatives.filter((a) => a.confidence >= 0.05).map((a) => ({ type: a.clause_name, confidence: a.confidence })),
      section: m ? (m[1] ?? m[2]) : null,
      page: pages.length > 1 ? seg.page : 1,
      paragraph: null,
      line: null,
      excerpt: seg.text,
    };
  });
  return replaceClauses(orgId, documentId, leaseId, clauses, 'svm', model);
}

/** Classify a document's page text with a Vercel AI Gateway model (CLAUSE_TYPES taxonomy, same schema as Claude). */
async function classifyClausesGateway(doc: ClauseDoc, model: string, opts: { userId: string | null; locale: Locale; process: AiProcess }): Promise<ClauseResult[]> {
  const pages = await documentPages(doc.id);
  if (!pages.some((p) => p.text?.trim())) return [];
  const data = await callGatewayJson<{ clauses: ClauseResult[] }>(
    { process: opts.process, orgId: doc.org_id, userId: opts.userId, fileId: doc.file_id, leaseId: doc.lease_id },
    {
      model,
      instructions: 'You are an expert commercial lease abstractor who classifies lease clauses. ' + languageInstruction(opts.locale),
      prompt: `${withPageMarkers(pages)}\n\n---\n\nClassify every substantive clause of this document into the allowed clause types, ` +
        'with confidence, up to 3 alternatives when uncertain, and its location. ' +
        'Page numbers are 1-based and relative to the material you were given (the first page you see is page 1).',
      jsonSchema: s.object({ clauses: s.array(CLAUSE_SCHEMA) }),
    },
  );
  return data.clauses ?? [];
}

/**
 * Classify a document's clauses with its organization's classifier and store them.
 * `claudeClauses`: clauses the abstract step already produced (used when the classifier is Claude).
 * A failing gateway call falls back to the SVM so the document still gets clauses.
 */
export async function classifyDocumentClauses(doc: ClauseDoc, opts: {
  userId: string | null; locale: Locale; process: AiProcess; claudeClauses?: ClauseResult[];
}): Promise<{ source: ClauseClassifier; count: number; note?: string }> {
  const { classifier, model } = await orgClauseClassifier(doc.org_id);
  if (classifier === 'claude') {
    const clauses = opts.claudeClauses ?? await classifyClauses(
      { process: opts.process, orgId: doc.org_id, userId: opts.userId, fileId: doc.file_id, leaseId: doc.lease_id },
      await documentInput(doc, { visual: false }), opts.locale);
    return { source: 'claude', count: await replaceClauses(doc.org_id, doc.id, doc.lease_id, clauses, 'claude', await getModel()) };
  }
  if (classifier === 'gateway' && model) {
    try {
      const clauses = await classifyClausesGateway(doc, model, opts);
      return { source: 'gateway', count: await replaceClauses(doc.org_id, doc.id, doc.lease_id, clauses, 'gateway', model) };
    } catch (err) {
      const note = `gateway ${model} failed (${(err as Error).message}); used SVM`;
      console.error(`[clauses] ${doc.id}: ${note}`);
      return { source: 'svm', count: await classifyDocumentSvm(doc.org_id, doc.id, doc.lease_id), note };
    }
  }
  return { source: 'svm', count: await classifyDocumentSvm(doc.org_id, doc.id, doc.lease_id) };
}

/** Load a document row in the shape classifyDocumentClauses needs. */
export async function loadClauseDoc(documentId: string, orgId?: string): Promise<ClauseDoc | null> {
  let q = db().from('documents').select('id, org_id, lease_id, file_id, storage_path, page_count, title').eq('id', documentId);
  if (orgId) q = q.eq('org_id', orgId);
  return must(await q.maybeSingle()) as ClauseDoc | null;
}
