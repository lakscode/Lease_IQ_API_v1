// Trainer of the lease clause classifier: TF-IDF + one-vs-rest linear SVM. Pure TypeScript with no imports beyond the
// shared feature pipeline, so it runs in Node (scripts/svm-train.ts, npm run svm:train) and in the super admin's
// browser (Settings → Train model, a Web Worker), where it can include clauses users added, re-typed or verified.
// Supabase Edge Functions limit CPU time per request, so the deployed API never trains.
//
// The SVM is liblinear's dual coordinate descent for L2-regularised squared-hinge loss (what sklearn's LinearSVC runs),
// with a regularised bias feature and "balanced" class weights. Confidence is a softmax over the scores with a
// temperature fitted on cross-validation.
import { MODEL_FORMAT, NGRAM_RANGE, TOKEN_PATTERN, termCounts, tfidf, type SvmModel } from './clause-svm-features.ts';

export const TRAIN_CONFIG = {
  minDf: 2,
  maxFeatures: 15000,
  C: 1,
  eps: 0.01,          // dual coordinate descent stopping tolerance (projected-gradient gap)
  maxIter: 1000,
  pruneBelow: 0.02,   // |weight| below this is dropped from the export (no measurable accuracy loss)
  cvFolds: 5,
  seed: 7,
};

export interface Example { text: string; label: string }

/** Deduplicated examples: known labels only, at least two words, one copy per (label, words). */
export function prepareExamples(rows: Example[], clauseMap: Record<string, string>): { examples: Example[]; skipped: Map<string, number> } {
  const examples: Example[] = [];
  const skipped = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of rows) {
    const text = row.text?.trim();
    const label = row.label?.trim().replace(/^__label__/, '').trim();
    if (!text || !label || label === 'label') continue;
    if (!(label in clauseMap)) { skipped.set(label, (skipped.get(label) ?? 0) + 1); continue; }
    const words = text.toLowerCase().match(/[a-z]{2,}/g) ?? [];
    const key = `${label}\u0000${words.join(' ')}`;
    if (words.length < 2 || seen.has(key)) continue;
    seen.add(key);
    examples.push({ text, label });
  }
  return { examples, skipped };
}

// ---- TF-IDF -----------------------------------------------------------------------------------

interface Vectorizer { terms: string[]; index: Map<string, number>; idf: Float64Array }
interface Sparse { idx: number[]; val: number[] }

function fitVectorizer(counts: Map<string, number>[]): Vectorizer {
  const df = new Map<string, number>();
  const total = new Map<string, number>();
  for (const doc of counts) {
    for (const [t, n] of doc) {
      df.set(t, (df.get(t) ?? 0) + 1);
      total.set(t, (total.get(t) ?? 0) + n);
    }
  }
  const terms = [...df.keys()].filter((t) => df.get(t)! >= TRAIN_CONFIG.minDf)
    .sort((a, b) => total.get(b)! - total.get(a)! || (a < b ? -1 : 1))
    .slice(0, TRAIN_CONFIG.maxFeatures)
    .sort();
  const n = counts.length;
  const idf = Float64Array.from(terms, (t) => Math.log((1 + n) / (1 + df.get(t)!)) + 1); // smooth idf
  return { terms, index: new Map(terms.map((t, i) => [t, i])), idf };
}

// ---- Linear SVM (one-vs-rest, dual coordinate descent) ----------------------------------------

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Binary L2-loss SVM. y ∈ {+1,-1}; cPos/cNeg are the per-class C. Returns weights (last entry = bias). */
function trainBinary(X: Sparse[], y: Int8Array, dim: number, cPos: number, cNeg: number, random: () => number): Float64Array {
  const l = X.length;
  const w = new Float64Array(dim + 1);
  const alpha = new Float64Array(l);
  const diag = (yi: number) => 0.5 / (yi > 0 ? cPos : cNeg);
  const QD = new Float64Array(l);
  for (let i = 0; i < l; i++) {
    let sq = 1; // bias feature
    for (const v of X[i].val) sq += v * v;
    QD[i] = sq + diag(y[i]);
  }
  const index = Int32Array.from({ length: l }, (_, i) => i);
  let active = l;
  let pgMaxOld = Infinity; // shrinking threshold (L2 loss has no upper bound, so only the alpha = 0 side shrinks)
  for (let iter = 0; iter < TRAIN_CONFIG.maxIter; iter++) {
    let pgMax = -Infinity;
    let pgMin = Infinity;
    for (let s = active - 1; s > 0; s--) {
      const r = Math.floor(random() * (s + 1));
      [index[s], index[r]] = [index[r], index[s]];
    }
    for (let s = 0; s < active; s++) {
      const i = index[s];
      const yi = y[i];
      const { idx, val } = X[i];
      let dot = w[dim];
      for (let k = 0; k < idx.length; k++) dot += w[idx[k]] * val[k];
      const G = yi * dot - 1 + alpha[i] * diag(yi);
      let PG = 0;
      if (alpha[i] === 0) {
        if (G > pgMaxOld) { // shrink: this variable is likely to stay at the bound
          active--;
          [index[s], index[active]] = [index[active], index[s]];
          s--;
          continue;
        }
        if (G < 0) PG = G;
      } else {
        PG = G;
      }
      pgMax = Math.max(pgMax, PG);
      pgMin = Math.min(pgMin, PG);
      if (Math.abs(PG) > 1e-12) {
        const old = alpha[i];
        alpha[i] = Math.max(old - G / QD[i], 0);
        const d = (alpha[i] - old) * yi;
        for (let k = 0; k < idx.length; k++) w[idx[k]] += d * val[k];
        w[dim] += d;
      }
    }
    if (pgMax - pgMin <= TRAIN_CONFIG.eps) {
      if (active === l) break;
      active = l; // re-check every variable before stopping
      pgMaxOld = Infinity;
      continue;
    }
    pgMaxOld = pgMax <= 0 ? Infinity : pgMax;
  }
  return w;
}

interface Svm { classes: string[]; W: Float64Array[]; bias: number[] }

function trainSvm(X: Sparse[], labels: string[], dim: number): Svm {
  const classes = [...new Set(labels)].sort();
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const random = rng(TRAIN_CONFIG.seed);
  const W: Float64Array[] = [];
  const bias: number[] = [];
  for (const c of classes) {
    const y = Int8Array.from(labels, (l) => (l === c ? 1 : -1));
    // liblinear one-vs-rest: positives use the class-weighted C, negatives the plain C.
    const balanced = labels.length / (classes.length * counts.get(c)!);
    const w = trainBinary(X, y, dim, TRAIN_CONFIG.C * balanced, TRAIN_CONFIG.C, random);
    W.push(w.subarray(0, dim));
    bias.push(w[dim]);
  }
  return { classes, W, bias };
}

function scores(svm: Svm, x: Sparse): number[] {
  return svm.classes.map((_, c) => {
    let s = svm.bias[c];
    for (let k = 0; k < x.idx.length; k++) s += svm.W[c][x.idx[k]] * x.val[k];
    return s;
  });
}

function prune(svm: Svm): void {
  for (const w of svm.W) for (let j = 0; j < w.length; j++) if (Math.abs(w[j]) < TRAIN_CONFIG.pruneBelow) w[j] = 0;
}

function fit(texts: string[], labels: string[]) {
  const counts = texts.map((t) => termCounts(t));
  const vec = fitVectorizer(counts);
  const X = counts.map((c) => tfidf(c, vec.index, vec.idf));
  const svm = trainSvm(X, labels, vec.terms.length);
  prune(svm);
  return { vec, svm, predictScores: (t: string) => scores(svm, tfidf(termCounts(t), vec.index, vec.idf)) };
}

// ---- Evaluation helpers -----------------------------------------------------------------------

export function softmax(s: number[], t: number): number[] {
  const max = Math.max(...s);
  const e = s.map((v) => Math.exp((v - max) * t));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

/** Golden-section search for the softmax temperature minimising held-out negative log-likelihood (convex in t). */
function fitTemperature(held: { scores: number[]; truth: number }[]): number {
  const nll = (t: number) => -held.reduce((sum, h) => sum + Math.log(softmax(h.scores, t)[h.truth] + 1e-12), 0);
  let [a, b] = [0.1, 50];
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = nll(c);
  let fd = nll(d);
  while (b - a > 1e-3) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = nll(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = nll(d); }
  }
  return (a + b) / 2;
}

function stratifiedFolds(labels: string[], k: number, random: () => number): number[] {
  const fold = new Array<number>(labels.length);
  const byClass = new Map<string, number[]>();
  labels.forEach((l, i) => byClass.set(l, [...(byClass.get(l) ?? []), i]));
  let offset = 0;
  for (const idx of byClass.values()) {
    for (let s = idx.length - 1; s > 0; s--) {
      const r = Math.floor(random() * (s + 1));
      [idx[s], idx[r]] = [idx[r], idx[s]];
    }
    idx.forEach((i, n) => { fold[i] = (n + offset) % k; });
    offset += idx.length;
  }
  return fold;
}

export const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// ---- Training -----------------------------------------------------------------------------------

export interface TrainProgress { stage: 'cv' | 'final' | 'done'; step: number; steps: number }

export interface TrainResult {
  model: SvmModel;
  cross_validation: {
    folds: number; examples: number; accuracy: number; macro_f1: number;
    excluded_small_classes: string[];
    calibration: { min_confidence: number; coverage: number; accuracy: number | null }[];
  };
  per_clause: { id: string; name: string; examples: number; precision?: number; recall?: number; 'f1-score'?: number }[];
  nonzero_weights: number;
  /** Predict with the in-memory model (for parity checks against the exported JSON). */
  predict: (text: string) => { id: string; confidence: number };
}

/**
 * Cross-validate (classes with at least `cvFolds` examples), fit the softmax temperature on the held-out scores, then
 * train the final model on all examples. `examples` should come from prepareExamples().
 */
export function trainModel(examples: Example[], clauseMap: Record<string, string>, onProgress?: (p: TrainProgress) => void): TrainResult {
  const { cvFolds, seed } = TRAIN_CONFIG;
  const counts = new Map<string, number>();
  for (const e of examples) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
  const steps = cvFolds + 1;

  const cvSet = examples.filter((e) => counts.get(e.label)! >= cvFolds);
  const folds = stratifiedFolds(cvSet.map((e) => e.label), cvFolds, rng(seed));
  const pred = new Array<string>(cvSet.length);
  const held: { scores: number[]; truth: number }[] = new Array(cvSet.length);
  for (let f = 0; f < cvFolds; f++) {
    onProgress?.({ stage: 'cv', step: f, steps });
    const train = cvSet.filter((_, i) => folds[i] !== f);
    const model = fit(train.map((e) => e.text), train.map((e) => e.label));
    cvSet.forEach((e, i) => {
      if (folds[i] !== f) return;
      const s = model.predictScores(e.text);
      pred[i] = model.svm.classes[s.indexOf(Math.max(...s))];
      held[i] = { scores: s, truth: model.svm.classes.indexOf(e.label) };
    });
  }
  const temperature = fitTemperature(held);
  const correct = cvSet.map((e, i) => pred[i] === e.label);
  const conf = held.map((h) => Math.max(...softmax(h.scores, temperature)));
  const accuracy = correct.filter(Boolean).length / cvSet.length;

  const perClass = new Map<string, { precision: number; recall: number; f1: number }>();
  for (const c of new Set([...cvSet.map((e) => e.label), ...pred])) {
    const tp = cvSet.filter((e, i) => e.label === c && pred[i] === c).length;
    const fp = pred.filter((p, i) => p === c && cvSet[i].label !== c).length;
    const fn = cvSet.filter((e, i) => e.label === c && pred[i] !== c).length;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    perClass.set(c, { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 });
  }
  const macroF1 = [...perClass.values()].reduce((a, p) => a + p.f1, 0) / perClass.size;
  const calibration = [0, 0.3, 0.5, 0.7, 0.9].map((min) => {
    const keep = conf.map((c) => c >= min);
    const n = keep.filter(Boolean).length;
    return { min_confidence: min, coverage: round(n / cvSet.length, 4), accuracy: n ? round(correct.filter((ok, i) => ok && keep[i]).length / n, 4) : null };
  });

  onProgress?.({ stage: 'final', step: cvFolds, steps });
  const final = fit(examples.map((e) => e.text), examples.map((e) => e.label));
  const { vec, svm } = final;
  const weights = vec.terms.map((_, j) => {
    const flat: number[] = [];
    svm.W.forEach((w, c) => { if (w[j] !== 0) flat.push(c, round(w[j], 4)); });
    return flat;
  });
  const model: SvmModel = {
    format: MODEL_FORMAT,
    trained_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    tokenizer: { pattern: TOKEN_PATTERN, lowercase: true, ngram_range: NGRAM_RANGE },
    temperature: round(temperature, 4),
    classes: svm.classes.map((id) => ({ id, name: clauseMap[id], examples: counts.get(id)! })),
    intercept: svm.bias.map((b) => round(b, 5)),
    terms: vec.terms,
    idf: Array.from(vec.idf, (v) => round(v, 5)),
    weights,
    metrics: {
      accuracy: round(accuracy, 4),
      macro_f1: round(macroF1, 4),
      examples: cvSet.length,
      f1: Object.fromEntries([...perClass].filter(([id]) => counts.has(id)).map(([id, p]) => [id, round(p.f1, 3)])),
    },
  };
  onProgress?.({ stage: 'done', step: steps, steps });

  return {
    model,
    cross_validation: {
      folds: cvFolds, examples: cvSet.length, accuracy: round(accuracy, 4), macro_f1: round(macroF1, 4),
      excluded_small_classes: [...counts].filter(([, n]) => n < cvFolds).map(([id]) => clauseMap[id]).sort(),
      calibration,
    },
    per_clause: svm.classes.map((id) => {
      const p = perClass.get(id);
      return { id, name: clauseMap[id], examples: counts.get(id)!, ...(p ? { precision: round(p.precision, 3), recall: round(p.recall, 3), 'f1-score': round(p.f1, 3) } : {}) };
    }).sort((a, b) => (a['f1-score'] ?? -1) - (b['f1-score'] ?? -1)),
    nonzero_weights: weights.reduce((n, w) => n + w.length / 2, 0),
    predict: (text: string) => {
      const p = softmax(final.predictScores(text), temperature);
      const best = p.indexOf(Math.max(...p));
      return { id: svm.classes[best], confidence: round(p[best], 4) };
    },
  };
}
