// Retraining the clause SVM from Settings → Train model (super admins). The API serves the training data — the bundled
// examples from svm/training_data plus clauses users added, re-typed or verified — the super admin's browser trains
// (lib/clause-svm-train.ts; Edge Functions limit CPU time per request), and the API stores and activates the result.
// Models are rows of clause_models (migration 0110); app_settings.svm_model points at the active one.
import { CLAUSE_TYPES } from './abstract.ts';
import { MODEL_FORMAT, NGRAM_RANGE, TOKEN_PATTERN, type SvmModel } from './clause-svm-features.ts';
import { badRequest } from './http.ts';
import { LEASE_CLAUSES } from './lease-clauses.ts';
import { setSetting, SETTINGS } from './settings.ts';
import type { ActiveModelRef } from './clause-svm.ts';
import { db, must } from './supabase.ts';

// ---- Users' clauses as training examples --------------------------------------------------------

const NAME_TO_ID = new Map(Object.entries(LEASE_CLAUSES).map(([id, name]) => [name.toLowerCase(), id]));

/**
 * Claude's clause types (CLAUSE_TYPES) that have a counterpart in lease_clauses.json under another name. Types with the
 * same name match directly; the rest have no SVM label and are skipped.
 */
const CLAUDE_ALIASES: Record<string, string> = {
  'Premises': 'Leased Premises',
  'Term': 'Lease Term',
  'Commencement': 'Lease Term',
  'Use': 'Permitted Uses',
  'Exclusive Use': 'Exclusive Rights',
  'Real Estate Taxes': 'Taxes',
  'CAM': 'Common Area Maintanence',
  'Repairs and Maintenance': 'Repairs',
  'Assignment and Subletting': 'Assignment and Subleasing',
  'Renewal Option': 'Renewal',
  'Holdover': 'HoldOver',
  'Expansion Option': 'Expansion Rights',
  'ROFR': 'Right of First Refusal',
  'ROFO': 'Right of First Offer',
  'Relocation': 'Right to Relocate',
  'Default': 'Events of Default',
  'Casualty': 'Damage/Destruction',
  'Abatement': 'Free Rent/Abatement',
  'Free Rent': 'Free Rent/Abatement',
  'Hazardous Materials': 'Environmental/Hazardous Materials',
  'Audit Rights': 'Audits',
  'SNDA': 'Subordination',
  'Continuous Operation': 'Store Operation',
  'Landlord Entry': 'Landlord Rights',
};

/** lease_clauses.json id for a clause type name from either taxonomy, or null. */
export function svmLabel(clauseType: string): string | null {
  const direct = NAME_TO_ID.get(clauseType.trim().toLowerCase());
  if (direct) return direct;
  const alias = (CLAUSE_TYPES as readonly string[]).includes(clauseType) ? CLAUDE_ALIASES[clauseType] : undefined;
  return alias ? NAME_TO_ID.get(alias.toLowerCase()) ?? null : null;
}

export type FeedbackKind = 'added' | 'retyped' | 'verified';

export interface FeedbackExample { text: string; label: string; kind: FeedbackKind; edited_at: string }

/** Clauses users added, re-typed or verified (not removed), in every organization, newest first. */
export async function feedbackClauses(): Promise<{ examples: FeedbackExample[]; unmapped: Record<string, number> }> {
  const examples: FeedbackExample[] = [];
  const unmapped: Record<string, number> = {};
  for (let from = 0; ; from += 1000) {
    const rows = must(await db().from('clauses')
      .select('clause_type, text, source, original_clause_type, verified, edited_at')
      .not('edited_at', 'is', null).eq('dismissed', false)
      .or('source.eq.user,original_clause_type.not.is.null,verified.eq.true')
      .order('edited_at', { ascending: false }).range(from, from + 999), 'feedback clauses') as {
      clause_type: string; text: string | null; source: string; original_clause_type: string | null; verified: boolean; edited_at: string;
    }[];
    for (const r of rows) {
      const text = r.text?.trim();
      if (!text) continue;
      const label = svmLabel(r.clause_type);
      if (!label) { unmapped[r.clause_type] = (unmapped[r.clause_type] ?? 0) + 1; continue; }
      const kind: FeedbackKind = r.source === 'user' ? 'added' : r.original_clause_type ? 'retyped' : 'verified';
      examples.push({ text, label, kind, edited_at: r.edited_at });
    }
    if (rows.length < 1000) break;
  }
  return { examples, unmapped };
}

/**
 * The examples from svm/training_data ([text, clause id] pairs, deduplicated), uploaded by `npm run svm:train`. Kept in
 * the database because the Edge Function bundle has a size limit.
 */
export async function baseExamples(): Promise<{ trained_at: string; examples: [string, string][] }> {
  const row = must(await db().from('clause_training_sets').select('data').eq('name', 'base').maybeSingle(), 'training examples') as { data: string } | null;
  if (!row) throw badRequest('The training data has not been uploaded yet. Run "npm run svm:train" in API/ once.');
  return JSON.parse(row.data) as { trained_at: string; examples: [string, string][] };
}

// ---- Stored models -------------------------------------------------------------------------------

const KEEP_MODELS = 6;
const MAX_MODEL_BYTES = 25 * 1024 * 1024;

/** Reject anything that isn't a well-formed model the classifier can load. */
export function validateModel(raw: unknown): SvmModel {
  const m = raw as SvmModel;
  const fail = (why: string) => { throw badRequest(`Invalid model: ${why}`); };
  if (!m || typeof m !== 'object') fail('not an object');
  if (m.format !== MODEL_FORMAT) fail(`format ${m.format}, expected ${MODEL_FORMAT}`);
  if (m.tokenizer?.pattern !== TOKEN_PATTERN || JSON.stringify(m.tokenizer?.ngram_range) !== JSON.stringify(NGRAM_RANGE)) fail('different tokenizer');
  if (!Array.isArray(m.classes) || m.classes.length < 2) fail('needs at least two clause types');
  if (m.classes.some((c) => !(c?.id in LEASE_CLAUSES))) fail('unknown clause id');
  if (!Array.isArray(m.intercept) || m.intercept.length !== m.classes.length) fail('intercepts do not match the clause types');
  if (!Array.isArray(m.terms) || !Array.isArray(m.idf) || !Array.isArray(m.weights)) fail('missing terms, idf or weights');
  if (m.idf.length !== m.terms.length || m.weights.length !== m.terms.length) fail('terms, idf and weights differ in length');
  const n = m.classes.length;
  for (const w of m.weights) {
    if (!Array.isArray(w) || w.length % 2) fail('bad weight row');
    for (let k = 0; k < w.length; k += 2) if (!Number.isInteger(w[k]) || w[k] < 0 || w[k] >= n || !Number.isFinite(w[k + 1])) fail('bad weight');
  }
  if (!Number.isFinite(m.temperature) || m.temperature <= 0) fail('bad temperature');
  if (!m.metrics || !Number.isFinite(m.metrics.accuracy)) fail('missing cross-validation metrics');
  return m;
}

export interface ModelSummary {
  id: string;
  created_at: string;
  created_by_name: string | null;
  trained_at: string;
  examples: number;
  feedback_examples: number;
  feedback_through: string | null;
  metrics: { accuracy: number; macro_f1: number; examples: number; calibration?: unknown } | null;
  active: boolean;
}

export async function listModels(): Promise<ModelSummary[]> {
  const rows = must(await db().from('clause_models')
    .select('id, created_at, trained_at, examples, feedback_examples, feedback_through, metrics, active, creator:profiles!clause_models_profile_fk(email, display_name)')
    .order('created_at', { ascending: false }).limit(KEEP_MODELS), 'clause models') as unknown as (Omit<ModelSummary, 'created_by_name'> & { creator: { email: string | null; display_name: string | null } | null })[];
  return rows.map(({ creator, ...r }) => ({ ...r, created_by_name: creator?.display_name || creator?.email || null }));
}

/** Store a trained model; with `activate`, every classifier uses it from now on. Older inactive models are pruned. */
export async function saveModel(input: {
  modelJson: string;
  model: SvmModel;
  feedbackExamples: number;
  feedbackThrough: string | null;
  calibration: unknown;
  activate: boolean;
  userId: string;
}): Promise<string> {
  if (input.modelJson.length > MAX_MODEL_BYTES) throw badRequest('Model is too large');
  const examples = input.model.classes.reduce((n, c) => n + (c.examples ?? 0), 0);
  const row = must(await db().from('clause_models').insert({
    created_by: input.userId,
    trained_at: input.model.trained_at,
    model: input.modelJson,
    examples,
    feedback_examples: input.feedbackExamples,
    feedback_through: input.feedbackThrough,
    metrics: { accuracy: input.model.metrics!.accuracy, macro_f1: input.model.metrics!.macro_f1, examples: input.model.metrics!.examples, calibration: input.calibration ?? null },
    active: false,
  }).select('id').single(), 'save clause model') as { id: string };
  if (input.activate) await activateModel(row.id, input.userId);

  const old = must(await db().from('clause_models').select('id').eq('active', false).order('created_at', { ascending: false }).range(KEEP_MODELS, KEEP_MODELS + 100), 'old models') as { id: string }[];
  if (old.length) must(await db().from('clause_models').delete().in('id', old.map((o) => o.id)), 'prune models');
  return row.id;
}

/** Make a stored model the active one, or go back to the bundled model with id null. */
export async function activateModel(id: string | null, userId: string): Promise<void> {
  if (id) {
    const row = must(await db().from('clause_models').select('id, trained_at').eq('id', id).maybeSingle(), 'load model') as { id: string; trained_at: string } | null;
    if (!row) throw badRequest('Model not found');
    must(await db().from('clause_models').update({ active: false }).eq('active', true).neq('id', id), 'deactivate models');
    must(await db().from('clause_models').update({ active: true }).eq('id', id), 'activate model');
    await setSetting(SETTINGS.svmModel, { id: row.id, trained_at: row.trained_at } satisfies ActiveModelRef, userId);
  } else {
    must(await db().from('clause_models').update({ active: false }).eq('active', true), 'deactivate models');
    await setSetting(SETTINGS.svmModel, { id: null, trained_at: null }, userId);
  }
}
