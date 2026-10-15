// SVM clause prediction (lib/clause-svm.ts) using the lease_clauses.json taxonomy. Runs locally, no AI key needed.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { requireRole, withOrg } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { badRequest, notFound, num, readJson, str } from '../lib/http.ts';
import { abstractClauses, clauseSvmInfo, predictClauses } from '../lib/clause-svm.ts';
import { CLAUSE_TYPES } from '../lib/abstract.ts';
import { LEASE_CLAUSES } from '../lib/lease-clauses.ts';
import { classifyDocumentClauses, loadClauseDoc } from '../lib/pipeline/clauses.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

const MAX_TEXTS = 500;
const MAX_CHARS = 2_000_000;

const topK = (v: unknown) => Math.min(10, Math.max(1, Math.trunc(num(v) ?? 3)));
const minConfidence = (v: unknown) => Math.min(1, Math.max(0, num(v) ?? 0.5));

// GET /api/clauses/taxonomies → clause types a user can pick when editing a clause:
//   lease = lease_clauses.json (SVM, LangChain, Llama), standard = CLAUSE_TYPES (Claude, Vercel AI Gateway)
router.get('/taxonomies', (c) => c.json({
  lease: [...new Set(Object.values(LEASE_CLAUSES))].sort((a, b) => a.localeCompare(b)),
  standard: [...CLAUSE_TYPES],
}));

// GET /api/clauses/types → clause types the model predicts
router.get('/types', async (c) => c.json(await clauseSvmInfo()));

// POST /api/clauses/predict { text } | { texts: [] }, top_k? → one prediction per text
router.post('/predict', async (c) => {
  const body = await readJson(c);
  const texts = Array.isArray(body.texts) ? body.texts.map((t) => (typeof t === 'string' ? t : '')) : [str(body.text) ?? ''];
  if (!texts.length || texts.every((t) => !t.trim())) throw badRequest('Send `text` or a non-empty `texts` array');
  if (texts.length > MAX_TEXTS) throw badRequest(`At most ${MAX_TEXTS} texts per request`);
  const predictions = await predictClauses(texts, topK(body.top_k));
  return c.json(Array.isArray(body.texts) ? { predictions } : predictions[0]);
});

// POST /api/clauses/abstract { text } | { pages: [] } | { document_id }, min_confidence?, top_k?
//   → lease text split into clauses, each classified, grouped by clause type
router.post('/abstract', async (c) => {
  const body = await readJson(c);
  let pages: string[];
  const documentId = str(body.document_id);
  if (documentId) {
    const doc = must(await db().from('documents').select('id').eq('id', documentId).eq('org_id', c.get('orgId')).maybeSingle());
    if (!doc) throw notFound('Document');
    const rows = must(await db().from('document_pages').select('page_number, text').eq('document_id', documentId).order('page_number')) as { page_number: number; text: string }[];
    pages = rows.map((r) => r.text ?? '');
  } else if (Array.isArray(body.pages)) {
    pages = body.pages.map((p) => (typeof p === 'string' ? p : ''));
  } else {
    pages = [str(body.text) ?? ''];
  }
  if (pages.every((p) => !p.trim())) throw badRequest('Send `text`, `pages` or a `document_id` that has extracted text');
  if (pages.reduce((n, p) => n + p.length, 0) > MAX_CHARS) throw badRequest('Text is too long');
  return c.json(await abstractClauses(pages, { minConfidence: minConfidence(body.min_confidence), topK: topK(body.top_k) }));
});

// POST /api/clauses/documents/:id/classify → re-classify a stored document with the organization's classifier
//   (Claude AI, SVM or Vercel AI Gateway, chosen by super admins) → { document_id, source, count, note? }
router.post('/documents/:id/classify', requireRole('editor'), async (c) => {
  const doc = await loadClauseDoc(c.req.param('id'), c.get('orgId'));
  if (!doc) throw notFound('Document');
  const profile = c.get('profile');
  const result = await classifyDocumentClauses(doc, { userId: profile.id, locale: profile.locale, process: 'reanalysis' });
  return c.json({ document_id: doc.id, ...result });
});

export default router;
