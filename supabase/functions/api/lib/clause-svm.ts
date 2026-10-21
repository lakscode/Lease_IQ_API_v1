import { MODEL_JSON } from './clause-svm-model.ts';
import { MODEL_FORMAT, termCounts, tfidf, type SvmModel } from './clause-svm-features.ts';
import { getSetting, SETTINGS } from './settings.ts';
import { db, must } from './supabase.ts';
import { errorFields, log } from './log.ts';

// Local clause classifier: TF-IDF + linear SVM trained by API/scripts/svm-train.ts on API/svm/training_data,
// labelled with the clause ids in API/svm/lease_clauses.json. Runs in-process (Node and Edge), no AI key needed.
// A super admin can retrain it with users' clauses (Settings → Train model); the active retrained model
// (clause_models, app_settings.svm_model) replaces the bundled one without a redeploy.
// Training and prediction share one feature pipeline (clause-svm-features.ts).

export { MODEL_FORMAT, NGRAM_RANGE, TOKEN_PATTERN, termCounts, tfidf, type SvmModel } from './clause-svm-features.ts';

interface LoadedModel {
  raw: SvmModel;
  index: Map<string, number>;
  source: 'bundled' | 'retrained';
}

export interface ClauseScore {
  clause_id: string;
  clause_name: string;
  /** Softmax over temperature-scaled SVM scores (calibrated on cross-validation). */
  confidence: number;
}

export interface ClausePrediction extends ClauseScore {
  alternatives: ClauseScore[];
}

export interface ClauseSegment extends ClausePrediction {
  index: number;
  page: number | null;
  text: string;
}

export interface ClauseAbstract {
  model: { trained_at: string; clause_types: number };
  segments: ClauseSegment[];
  /** Segments grouped by predicted clause, ordered by first appearance. */
  clauses: { clause_id: string; clause_name: string; best_confidence: number; segments: number[] }[];
  /** Segments below min_confidence (indexes into `segments`). */
  unclassified: number[];
}

/** app_settings.svm_model: the active retrained model; { id: null } (or no row) = the bundled model. */
export interface ActiveModelRef { id: string; trained_at: string }

export async function activeModelRef(): Promise<ActiveModelRef | null> {
  const ref = await getSetting<{ id: string | null; trained_at?: string | null } | null>(SETTINGS.svmModel, null);
  return ref?.id ? { id: ref.id, trained_at: ref.trained_at ?? '' } : null;
}

function parseModel(json: string, source: LoadedModel['source']): LoadedModel {
  const m = JSON.parse(json) as SvmModel;
  if (m.format !== MODEL_FORMAT) throw new Error(`clause model format ${m.format}, expected ${MODEL_FORMAT}`);
  return { raw: m, index: new Map(m.terms.map((t, i) => [t, i])), source };
}

let bundled: Promise<LoadedModel> | null = null;
let current: { key: string; promise: Promise<LoadedModel> } | null = null;

/**
 * The active model: a retrained one when a super admin published it, else the bundled ~3 MB model (parsed on first use,
 * so routes that never classify don't pay for it). The bundled model is a static import of a generated .ts module
 * (not a .json file or a dynamic import), because the Supabase Edge bundler only ships files it reaches through static
 * imports. The active model id is re-read at most every 30 s (settings cache); a model that fails to load falls back
 * to the bundled one.
 */
function loadModel(): Promise<LoadedModel> {
  bundled ??= Promise.resolve().then(() => parseModel(MODEL_JSON, 'bundled'));
  return (async () => {
    let ref: ActiveModelRef | null = null;
    try {
      ref = await activeModelRef();
    } catch {
      // no database (e.g. scripts/svm-check.ts): the bundled model
    }
    const key = ref?.id ?? 'bundled';
    if (current?.key !== key) {
      current = {
        key,
        promise: !ref ? bundled! : (async () => {
          try {
            const row = must(await db().from('clause_models').select('model').eq('id', ref.id).single(), 'load clause model') as { model: string };
            return parseModel(row.model, 'retrained');
          } catch (err) {
            log.error('clauses.svm', `Retrained clause model ${ref.id} could not be loaded; using the bundled model`, errorFields(err));
            return bundled!;
          }
        })(),
      };
    }
    return current.promise;
  })();
}

function score(model: LoadedModel, text: string): number[] {
  const { raw, index } = model;
  const { idx, val } = tfidf(termCounts(text, raw.tokenizer.pattern, raw.tokenizer.ngram_range), index, raw.idf);
  const scores = raw.intercept.slice();
  for (let k = 0; k < idx.length; k++) {
    const w = raw.weights[idx[k]];
    for (let m = 0; m < w.length; m += 2) scores[w[m]] += val[k] * w[m + 1];
  }
  return scores;
}

function rank(model: LoadedModel, text: string, topK: number): ClausePrediction {
  const { classes, temperature } = model.raw;
  const scores = score(model, text);
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) * temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  const ranked = exps
    .map((e, i) => ({ clause_id: classes[i].id, clause_name: classes[i].name, confidence: Math.round((e / sum) * 10000) / 10000 }))
    .sort((a, b) => b.confidence - a.confidence);
  return { ...ranked[0], alternatives: ranked.slice(1, Math.max(1, topK)) };
}

/** Clause types the model can predict (lease_clauses.json ids that had training data). */
export async function clauseSvmInfo() {
  const { raw, source } = await loadModel();
  return { trained_at: raw.trained_at, clause_types: raw.classes, metrics: raw.metrics ?? null, source };
}

/** The bundled model (lib/clause-svm-model.ts), whichever model is active. */
export async function bundledSvmInfo() {
  bundled ??= Promise.resolve().then(() => parseModel(MODEL_JSON, 'bundled'));
  const { raw } = await bundled;
  return { trained_at: raw.trained_at, clause_types: raw.classes.length, examples: raw.classes.reduce((n, c) => n + c.examples, 0), metrics: raw.metrics ?? null };
}

/** Classify clause texts. `topK` = predicted clause + alternatives. */
export async function predictClauses(texts: string[], topK = 3): Promise<ClausePrediction[]> {
  const model = await loadModel();
  return texts.map((t) => rank(model, t, topK));
}

const MIN_SEGMENT_WORDS = 12;
const MAX_SEGMENT_WORDS = 350;
// "ARTICLE 5", "Section 12.1", "4.2 Rent", "(a) Tenant", or an all-caps heading line.
const HEADING_RE = /^\s*(?:(?:ARTICLE|Article|SECTION|Section|§)\s+[\dIVXLC]+\b|\d{1,2}(?:\.\d{1,3})*[.)]?\s+[A-Z]|\(?[a-z]\)\s+[A-Z]|[A-Z][A-Z &/,'-]{3,60}[.:]?\s*$)/;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Split lease text into clause-sized segments: blank lines and numbered/caps headings start a segment,
 * short fragments (headings) merge into the next one, and very long ones are split at sentence ends.
 */
export function splitClauses(pages: string[]): { text: string; page: number }[] {
  const raw: { text: string; page: number }[] = [];
  pages.forEach((pageText, p) => {
    let cur: string[] = [];
    const flush = () => {
      const t = cur.join(' ').replace(/\s+/g, ' ').trim();
      if (t) raw.push({ text: t, page: p + 1 });
      cur = [];
    };
    for (const line of pageText.replace(/\r\n?/g, '\n').split('\n')) {
      if (!line.trim()) flush();
      else {
        if (HEADING_RE.test(line) && cur.length) flush();
        cur.push(line.trim());
      }
    }
    flush();
  });

  const merged: { text: string; page: number }[] = [];
  let carry: { text: string; page: number } | null = null;
  for (const seg of raw) {
    const s: { text: string; page: number } = carry ? { text: `${carry.text} ${seg.text}`, page: carry.page } : seg;
    carry = words(s.text) < MIN_SEGMENT_WORDS ? s : null;
    if (!carry) merged.push(s);
  }
  if (carry) merged.push(carry);

  const out: { text: string; page: number }[] = [];
  for (const seg of merged) {
    if (words(seg.text) <= MAX_SEGMENT_WORDS) { out.push(seg); continue; }
    let chunk = '';
    for (const sentence of seg.text.match(/[^.;]+[.;]+["')\]]*\s*|[^.;]+$/g) ?? [seg.text]) {
      if (chunk && words(chunk) + words(sentence) > MAX_SEGMENT_WORDS) { out.push({ text: chunk.trim(), page: seg.page }); chunk = ''; }
      chunk += sentence;
    }
    if (chunk.trim()) out.push({ text: chunk.trim(), page: seg.page });
  }
  return out;
}

/**
 * Lease abstraction by clause: segment the document (one string per page, or one string for the whole text),
 * classify every segment and group them by clause type.
 */
export async function abstractClauses(pages: string[], opts: { minConfidence?: number; topK?: number } = {}): Promise<ClauseAbstract> {
  const minConfidence = opts.minConfidence ?? 0.5;
  const model = await loadModel();
  const segs = splitClauses(pages);
  const paged = pages.length > 1;
  const segments: ClauseSegment[] = segs.map((s, index) => ({ index, page: paged ? s.page : null, text: s.text, ...rank(model, s.text, opts.topK ?? 3) }));

  const groups = new Map<string, ClauseAbstract['clauses'][number]>();
  const unclassified: number[] = [];
  for (const s of segments) {
    if (s.confidence < minConfidence) { unclassified.push(s.index); continue; }
    const g = groups.get(s.clause_id) ?? { clause_id: s.clause_id, clause_name: s.clause_name, best_confidence: 0, segments: [] };
    g.best_confidence = Math.max(g.best_confidence, s.confidence);
    g.segments.push(s.index);
    groups.set(s.clause_id, g);
  }
  return { model: { trained_at: model.raw.trained_at, clause_types: model.raw.classes.length }, segments, clauses: [...groups.values()], unclassified };
}
