// Lease review after abstraction (owned by the leases area): checks that the basic abstract fields and the expected
// clauses were predicted, and records a reviewer's verdict on each. What is checked comes from review-checklist.json
// (edit that file to change the fields and clauses). Automatic checks are plain code; the optional AI check asks
// Claude to compare the predictions with the documents. Review state is one lease_reviews row per lease (migration 0210).
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import checklistJson from './review-checklist.json' with { type: 'json' };
import { ABSTRACT_FIELDS, type AbstractField, type FieldKind } from './abstract.ts';
import { callClaudeJson, languageInstruction, pdfBlock, s, type AiContext } from './ai.ts';
import { badRequest } from './http.ts';
import { log } from './log.ts';
import { db, must } from './supabase.ts';
import { downloadBytes } from './storage.ts';
import type { TermValue } from './lease-terms.ts';
import type { DocType, Locale } from './types.ts';
import { documentPages } from './pipeline/store.ts';
import { fitsAiPdfLimits, hasUsableText, withPageMarkers } from './pipeline/pdf.ts';

// ---- Checklist ----------------------------------------------------------------------------------

export interface ChecklistField { key: string; label: string; kind: FieldKind; required: boolean }
export interface ChecklistClause { name: string; required: boolean; match: string[] }
export interface Checklist { minClauseConfidence: number; fields: ChecklistField[]; clauses: ChecklistClause[] }

function loadChecklist(raw: unknown): Checklist {
  const json = (raw ?? {}) as { min_clause_confidence?: unknown; fields?: unknown; clauses?: unknown };
  const fields: ChecklistField[] = [];
  for (const f of Array.isArray(json.fields) ? json.fields : []) {
    const key = typeof f?.key === 'string' ? f.key : '';
    const def: AbstractField | undefined = ABSTRACT_FIELDS.find((a) => a.key === key);
    if (!def) {
      log.warn('leases.review', `review-checklist.json: unknown abstract field "${key}" ignored`);
      continue;
    }
    if (fields.some((x) => x.key === key)) continue;
    fields.push({ key, label: typeof f.label === 'string' && f.label.trim() ? f.label.trim() : def.label, kind: def.kind, required: f.required === true });
  }
  const clauses: ChecklistClause[] = [];
  for (const cl of Array.isArray(json.clauses) ? json.clauses : []) {
    const name = typeof cl?.name === 'string' ? cl.name.trim() : '';
    if (!name || clauses.some((x) => x.name === name)) continue;
    const match = (Array.isArray(cl.match) ? cl.match : []).filter((m: unknown): m is string => typeof m === 'string' && m.trim() !== '').map((m: string) => m.trim());
    clauses.push({ name, required: cl.required === true, match: match.length ? match : [name] });
  }
  const min = Number(json.min_clause_confidence);
  return { minClauseConfidence: Number.isFinite(min) && min >= 0 && min <= 1 ? min : 0.5, fields, clauses };
}

export const CHECKLIST: Checklist = loadChecklist(checklistJson);

// ---- Types ------------------------------------------------------------------------------------

export type ItemKind = 'field' | 'clause';
export type FieldVerdict = 'correct' | 'incorrect' | 'not_applicable';
export type ClauseVerdict = 'correct' | 'incorrect' | 'missing' | 'not_applicable';
const VERDICTS: Record<ItemKind, readonly string[]> = {
  field: ['correct', 'incorrect', 'not_applicable'],
  clause: ['correct', 'incorrect', 'missing', 'not_applicable'],
};

interface StoredVerdict { verdict: string; note: string | null; by: string | null; at: string }
interface ReviewItems { fields: Record<string, StoredVerdict>; clauses: Record<string, StoredVerdict> }

interface AiFieldResult { status: 'correct' | 'incorrect' | 'not_in_document'; correct_value: string | null; document_id: string | null; page: number | null; note: string }
interface AiClauseResult { present: boolean; document_id: string | null; page: number | null; note: string }
interface AiResults { checked_at: string; fields: Record<string, AiFieldResult>; clauses: Record<string, AiClauseResult> }

export interface ReviewRow {
  id: string;
  lease_id: string;
  status: 'in_progress' | 'completed';
  items: ReviewItems;
  ai: AiResults | null;
  summary: ReviewSummary | null;
  started_by: string | null;
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewSummary {
  issues: number;
  reviewed: number;
  total: number;
  correct: number;
  incorrect: number;
}

/** Automatic check result: `code` is translated by the UI (leases.review.check.<code>), `params` fill it in. */
interface CheckMessage { code: string; params?: Record<string, string | number> }
type CheckStatus = 'ok' | 'missing' | 'not_found' | 'invalid' | 'warning' | 'low_confidence';

export interface ReviewDoc {
  id: string;
  doc_type: DocType;
  title: string | null;
  page_start: number | null;
  page_count: number | null;
  storage_path: string | null;
  abstract: Record<string, unknown> | null;
}

export interface ReviewClause {
  id: string;
  document_id: string;
  clause_type: string;
  source: string;
  confidence: number | null;
  page: number | null;
  text: string | null;
  verified: boolean;
}

// ---- Automatic checks --------------------------------------------------------------------------

const ISSUE: CheckStatus[] = ['missing', 'invalid', 'warning', 'low_confidence'];

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Whole months from commencement to the day after expiration (a 5-year lease from 2020-01-01 ends 2024-12-31 = 60). */
function termMonths(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  b.setUTCDate(b.getUTCDate() + 1);
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return months + (b.getUTCDate() - a.getUTCDate()) / 30;
}

function fieldChecks(field: ChecklistField, terms: Record<string, TermValue>): { status: CheckStatus; messages: CheckMessage[] } {
  const raw = terms[field.key]?.value;
  if (raw === undefined || raw === null || raw === '') {
    return field.required ? { status: 'missing', messages: [{ code: 'missing' }] } : { status: 'not_found', messages: [{ code: 'notFound' }] };
  }
  const errors: CheckMessage[] = [];
  const warnings: CheckMessage[] = [];
  const num = (key: string) => {
    const n = Number(terms[key]?.value);
    return terms[key] && Number.isFinite(n) ? n : null;
  };
  const date = (key: string) => {
    const v = terms[key]?.value;
    return typeof v === 'string' && isRealDate(v) ? v : null;
  };

  if (field.kind === 'date' && !(typeof raw === 'string' && isRealDate(raw))) errors.push({ code: 'invalidDate' });
  if (field.kind === 'number' || field.kind === 'money') {
    const n = Number(raw);
    if (!Number.isFinite(n)) errors.push({ code: 'invalidNumber' });
    else if (n <= 0 && field.key !== 'renewal_notice_months') errors.push({ code: 'notPositive' });
  }
  if ((field.kind === 'text' || field.kind === 'longtext') && String(raw).trim().length < 2) errors.push({ code: 'tooShort' });

  const start = date('commencement_date');
  const end = date('expiration_date');
  if (field.key === 'expiration_date' && start && end && end <= start) errors.push({ code: 'dateOrder' });
  if (field.key === 'term_months' && start && end && end > start) {
    const expected = Math.round(termMonths(start, end));
    const n = num('term_months');
    if (n !== null && Math.abs(n - expected) > 1) warnings.push({ code: 'termMismatch', params: { expected } });
  }
  if (field.key === 'base_rent_annual') {
    const monthly = num('base_rent_monthly');
    const annual = num('base_rent_annual');
    if (monthly && annual && Math.abs(annual - monthly * 12) > monthly * 12 * 0.02) {
      warnings.push({ code: 'annualMismatch', params: { expected: Math.round(monthly * 12 * 100) / 100 } });
    }
  }
  if (field.key === 'renewal_notice_months') {
    const n = num('renewal_notice_months');
    if (n !== null && (n < 0 || n > 60)) warnings.push({ code: 'outOfRange' });
  }
  if (field.key === 'tenant' && terms.landlord && String(terms.landlord.value).trim().toLowerCase() === String(raw).trim().toLowerCase()) {
    errors.push({ code: 'sameParties' });
  }
  if (errors.length) return { status: 'invalid', messages: [...errors, ...warnings] };
  if (warnings.length) return { status: 'warning', messages: warnings };
  return { status: 'ok', messages: [] };
}

function matchingClauses(item: ChecklistClause, clauses: ReviewClause[]): ReviewClause[] {
  const names = new Set(item.match.map((m) => m.toLowerCase()));
  return clauses.filter((c) => names.has(c.clause_type.toLowerCase()));
}

// ---- Payload ------------------------------------------------------------------------------------

function verdictOut(v: StoredVerdict | undefined, names: Map<string, string>) {
  return {
    verdict: v?.verdict ?? null,
    note: v?.note ?? null,
    reviewed_by_name: v?.by ? names.get(v.by) ?? null : null,
    reviewed_at: v?.at ?? null,
  };
}

/** The review of one lease: checklist items with predictions, automatic checks, AI results and verdicts. */
export function buildReview(input: {
  terms: Record<string, TermValue>;
  docs: ReviewDoc[];
  clauses: ReviewClause[];
  row: ReviewRow | null;
  names: Map<string, string>;
}) {
  const { terms, docs, clauses, row, names } = input;
  const items: ReviewItems = row?.items ?? { fields: {}, clauses: {} };
  const ai = row?.ai ?? null;
  const docById = new Map(docs.map((d) => [d.id, d]));
  const min = CHECKLIST.minClauseConfidence;

  const fields = CHECKLIST.fields.map((f) => {
    const term = terms[f.key];
    const sourceDoc = term ? docById.get(term.source_document_id) : undefined;
    const pages = (sourceDoc?.abstract?.pages ?? {}) as Record<string, number>;
    return {
      key: f.key,
      label: f.label,
      kind: f.kind,
      required: f.required,
      value: term?.value ?? null,
      source_document_id: term?.source_document_id ?? null,
      source_title: term?.source_title ?? null,
      source_doc_type: term?.source_doc_type ?? null,
      page: typeof pages[f.key] === 'number' ? pages[f.key] : null,
      auto: fieldChecks(f, terms),
      ai: ai?.fields?.[f.key] ?? null,
      ...verdictOut(items.fields?.[f.key], names),
    };
  });

  const matchedIds = new Set<string>();
  const clauseItems = CHECKLIST.clauses.map((cl) => {
    const found = matchingClauses(cl, clauses);
    for (const c of found) matchedIds.add(c.id);
    const confident = found.filter((c) => c.verified || c.source === 'user' || c.confidence === null || c.confidence >= min);
    const best = found.reduce<number | null>((m, c) => (c.confidence !== null && (m === null || c.confidence > m) ? c.confidence : m), null);
    const status: CheckStatus = !found.length ? (cl.required ? 'missing' : 'not_found') : confident.length ? 'ok' : 'low_confidence';
    const samples = [...found]
      .sort((a, b) => Number(b.verified) - Number(a.verified) || (b.confidence ?? 1) - (a.confidence ?? 1))
      .slice(0, 3)
      .map((c) => ({
        id: c.id,
        document_id: c.document_id,
        document_title: docById.get(c.document_id)?.title ?? null,
        clause_type: c.clause_type,
        page: c.page,
        confidence: c.confidence,
        verified: c.verified,
        text: (c.text ?? '').slice(0, 280),
      }));
    return {
      name: cl.name,
      required: cl.required,
      match: cl.match,
      found: found.length,
      verified: found.filter((c) => c.verified).length,
      best_confidence: best,
      pages: [...new Set(found.map((c) => c.page).filter((p): p is number => p !== null))].sort((a, b) => a - b).slice(0, 12),
      samples,
      auto: {
        status,
        messages: status === 'missing' ? [{ code: 'clauseMissing' }]
          : status === 'not_found' ? [{ code: 'notFound' }]
          : status === 'low_confidence' ? [{ code: 'lowConfidence', params: { min: Math.round(min * 100) } }]
          : [],
      },
      ai: ai?.clauses?.[cl.name] ?? null,
      ...verdictOut(items.clauses?.[cl.name], names),
    };
  });

  // Clauses the checklist doesn't ask about, by type (for information).
  const extra = new Map<string, number>();
  for (const c of clauses) if (!matchedIds.has(c.id)) extra.set(c.clause_type, (extra.get(c.clause_type) ?? 0) + 1);

  const all = [...fields, ...clauseItems];
  const counts = {
    fields_total: fields.length,
    fields_found: fields.filter((f) => f.value !== null).length,
    fields_required_missing: fields.filter((f) => f.auto.status === 'missing').length,
    clauses_total: clauseItems.length,
    clauses_found: clauseItems.filter((c) => c.found > 0).length,
    clauses_required_missing: clauseItems.filter((c) => c.auto.status === 'missing').length,
    ai_disagreements: fields.filter((f) => f.ai?.status === 'incorrect').length
      + clauseItems.filter((c) => c.ai && c.ai.present !== c.found > 0).length,
  };
  const summary: ReviewSummary = {
    issues: all.filter((i) => ISSUE.includes(i.auto.status)).length,
    reviewed: all.filter((i) => i.verdict).length,
    total: all.length,
    correct: all.filter((i) => i.verdict === 'correct').length,
    incorrect: all.filter((i) => i.verdict === 'incorrect' || i.verdict === 'missing').length,
  };

  return {
    review: row && {
      id: row.id,
      status: row.status,
      started_by_name: row.started_by ? names.get(row.started_by) ?? null : null,
      completed_by_name: row.completed_by ? names.get(row.completed_by) ?? null : null,
      completed_at: row.completed_at,
      ai_checked_at: row.ai?.checked_at ?? null,
      updated_at: row.updated_at,
    },
    min_clause_confidence: min,
    fields,
    clauses: clauseItems,
    extra_clauses: [...extra.entries()].map(([clause_type, count]) => ({ clause_type, count })).sort((a, b) => b.count - a.count),
    summary: { ...summary, ...counts },
  };
}

// ---- Storage ------------------------------------------------------------------------------------

const ROW_COLUMNS = 'id, lease_id, status, items, ai, summary, started_by, completed_by, completed_at, created_at, updated_at';

export async function loadReviewRow(orgId: string, leaseId: string): Promise<ReviewRow | null> {
  return must(await db().from('lease_reviews').select(ROW_COLUMNS).eq('org_id', orgId).eq('lease_id', leaseId).maybeSingle(), 'load review') as ReviewRow | null;
}

/** Insert or update the lease's review row; returns the saved row. */
export async function saveReviewRow(orgId: string, leaseId: string, userId: string, patch: Partial<Pick<ReviewRow, 'status' | 'items' | 'ai' | 'summary' | 'completed_by' | 'completed_at'>>): Promise<ReviewRow> {
  const existing = await loadReviewRow(orgId, leaseId);
  const now = new Date().toISOString();
  if (existing) {
    return must(await db().from('lease_reviews').update({ ...patch, updated_at: now }).eq('id', existing.id).select(ROW_COLUMNS).single(), 'save review') as ReviewRow;
  }
  return must(await db().from('lease_reviews').insert({
    org_id: orgId, lease_id: leaseId, status: 'in_progress', items: { fields: {}, clauses: {} }, started_by: userId, ...patch, updated_at: now,
  }).select(ROW_COLUMNS).single(), 'start review') as ReviewRow;
}

/** Review items with one verdict set (or cleared with verdict null). Throws for unknown items/verdicts. */
export function withVerdict(items: ReviewItems | undefined, body: { kind: unknown; key: unknown; verdict: unknown; note: unknown }, userId: string): ReviewItems {
  const kind = body.kind === 'field' || body.kind === 'clause' ? body.kind : null;
  if (!kind) throw badRequest('kind must be "field" or "clause"');
  const key = typeof body.key === 'string' ? body.key : '';
  const known = kind === 'field' ? CHECKLIST.fields.some((f) => f.key === key) : CHECKLIST.clauses.some((c) => c.name === key);
  if (!known) throw badRequest('Not on the review checklist');
  const verdict = body.verdict === null ? null : typeof body.verdict === 'string' && VERDICTS[kind].includes(body.verdict) ? body.verdict : undefined;
  if (verdict === undefined) throw badRequest('Invalid verdict');
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 1000) : null;
  const next: ReviewItems = { fields: { ...(items?.fields ?? {}) }, clauses: { ...(items?.clauses ?? {}) } };
  const bucket = kind === 'field' ? next.fields : next.clauses;
  if (verdict === null) delete bucket[key];
  else bucket[key] = { verdict, note, by: userId, at: new Date().toISOString() };
  return next;
}

/** lease id → { status, summary } for the leases list. Never fails the list (e.g. before migration 0210). */
export async function reviewStatuses(orgId: string): Promise<Map<string, { status: ReviewRow['status']; summary: ReviewSummary | null }>> {
  const { data, error } = await db().from('lease_reviews').select('lease_id, status, summary').eq('org_id', orgId);
  if (error) {
    log.warn('leases.review', `Reviews unavailable: ${error.message}`);
    return new Map();
  }
  return new Map((data as { lease_id: string; status: ReviewRow['status']; summary: ReviewSummary | null }[]).map((r) => [r.lease_id, { status: r.status, summary: r.summary }]));
}

// ---- AI check -----------------------------------------------------------------------------------

const MAX_TEXT_CHARS = 400_000;

/** Claude input for the lease family: page texts per document, or the main lease's PDF when there is no text. */
async function familyInput(docs: ReviewDoc[]): Promise<{ blocks: BetaContentBlockParam[]; docIndex: Map<number, string> }> {
  const docIndex = new Map<number, string>();
  const parts: string[] = [];
  let budget = MAX_TEXT_CHARS;
  for (const [i, doc] of docs.entries()) {
    if (budget <= 0) break;
    const pages = await documentPages(doc.id);
    if (!hasUsableText(pages.map((p) => p.text))) continue;
    const body = withPageMarkers(pages, budget);
    budget -= body.length;
    docIndex.set(i + 1, doc.id);
    parts.push(`##### DOCUMENT ${i + 1}: ${doc.title ?? 'Untitled'} (${doc.doc_type}) #####\n${body}`);
  }
  if (parts.length) return { blocks: [{ type: 'text', text: parts.join('\n\n') }], docIndex };

  const main = docs.find((d) => d.doc_type === 'main_lease' && d.storage_path) ?? docs.find((d) => d.storage_path);
  if (main?.storage_path) {
    const bytes = await downloadBytes(main.storage_path);
    if (fitsAiPdfLimits(main.page_count ?? 0, bytes.length)) {
      docIndex.set(1, main.id);
      return { blocks: [{ type: 'text', text: `DOCUMENT 1: ${main.title ?? 'Untitled'} (${main.doc_type}) is the attached PDF.` }, pdfBlock(bytes, { title: main.title ?? undefined })], docIndex };
    }
  }
  throw badRequest('There is no document text to check against. Re-analyze the file first.');
}

function formatPrediction(value: unknown, kind: FieldKind): string {
  if (value === null || value === undefined || value === '') return '(not found)';
  return kind === 'money' ? `${value} (money)` : String(value);
}

/** Ask Claude whether each predicted field value and expected clause matches the documents (process 'reanalysis'). */
export async function aiReviewCheck(ctx: AiContext, input: {
  docs: ReviewDoc[];
  terms: Record<string, TermValue>;
  clauses: ReviewClause[];
  locale: Locale;
}): Promise<AiResults> {
  const { blocks, docIndex } = await familyInput(input.docs);
  const fieldKeys = CHECKLIST.fields.map((f) => f.key);
  const clauseNames = CHECKLIST.clauses.map((c) => c.name);
  const schema = s.object({
    fields: s.array(s.object({
      key: s.enum(fieldKeys),
      status: s.enum(['correct', 'incorrect', 'not_in_document'], 'correct: the prediction matches the documents (as amended); incorrect: it is wrong, incomplete or missing although the documents state it; not_in_document: the documents do not state it and the prediction is empty'),
      correct_value: s.nullable(s.string('When incorrect: the right value as the documents state it (dates YYYY-MM-DD, plain numbers without currency symbols)')),
      document: s.nullable(s.integer('DOCUMENT number where the value is stated')),
      page: s.nullable(s.integer('Page number within that document (=== PAGE n === marker)')),
      note: s.string('One short sentence explaining the verdict'),
    })),
    clauses: s.array(s.object({
      name: s.enum(clauseNames),
      present: s.boolean('Whether the documents contain such a clause'),
      document: s.nullable(s.integer('DOCUMENT number of the main occurrence')),
      page: s.nullable(s.integer('Page number within that document')),
      note: s.string('One short sentence: where it is, or why it is absent'),
    })),
  });

  const fieldLines = CHECKLIST.fields.map((f) => `- ${f.key} (${f.label}, ${f.kind}): ${formatPrediction(input.terms[f.key]?.value, f.kind)}`);
  const clauseLines = CHECKLIST.clauses.map((cl) => {
    const found = matchingClauses(cl, input.clauses);
    const pages = [...new Set(found.map((c) => c.page).filter(Boolean))].slice(0, 8);
    return `- ${cl.name} (counts: ${cl.match.join(', ')}): ${found.length ? `predicted ${found.length}× ${pages.length ? `on page(s) ${pages.join(', ')}` : ''}` : 'not predicted'}`;
  });

  const { data } = await callClaudeJson<{
    fields: { key: string; status: AiFieldResult['status']; correct_value: string | null; document: number | null; page: number | null; note: string }[];
    clauses: { name: string; present: boolean; document: number | null; page: number | null; note: string }[];
  }>(ctx, {
    system:
      'You are a meticulous commercial lease abstractor reviewing another abstractor\'s work. Compare each predicted value with the ' +
      'documents. Later documents (amendments, commencement letters) override earlier ones, so a value is correct when it matches the ' +
      'lease as amended. Treat equivalent formats as correct (e.g. "$10,000.00" and 10000; "123 Main St." and "123 Main Street"). ' +
      'Base rent is the current or initial base rent stated. Answer every field and every clause exactly once. ' + languageInstruction(input.locale),
    messages: [{
      role: 'user',
      content: [
        ...blocks,
        {
          type: 'text',
          text: `Predicted abstract fields:\n${fieldLines.join('\n')}\n\nExpected clauses and what the classifier predicted:\n${clauseLines.join('\n')}\n\n` +
            'For each field, say whether the prediction is correct. For each clause, say whether the documents contain it.',
        },
      ],
    }],
    jsonSchema: schema,
    effort: 'medium',
    maxTokens: 16000,
  });

  const out: AiResults = { checked_at: new Date().toISOString(), fields: {}, clauses: {} };
  for (const f of data.fields ?? []) {
    if (!fieldKeys.includes(f.key)) continue;
    out.fields[f.key] = {
      status: f.status,
      correct_value: f.status === 'incorrect' ? f.correct_value ?? null : null,
      document_id: f.document ? docIndex.get(f.document) ?? null : null,
      page: f.page ?? null,
      note: f.note ?? '',
    };
  }
  for (const cl of data.clauses ?? []) {
    if (!clauseNames.includes(cl.name)) continue;
    out.clauses[cl.name] = { present: cl.present, document_id: cl.document ? docIndex.get(cl.document) ?? null : null, page: cl.page ?? null, note: cl.note ?? '' };
  }
  return out;
}
