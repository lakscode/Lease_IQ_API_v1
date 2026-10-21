// Feature pipeline and model format of the local clause SVM, shared by prediction (clause-svm.ts), the Node trainer
// (scripts/svm-train.ts) and the in-browser trainer (clause-svm-train.ts, run from Settings → Train model).
// No imports, so the browser can use it without pulling in the bundled model.

export const MODEL_FORMAT = 1;
/** Lower-case ASCII words of 2+ letters; digits, punctuation and mojibake are separators. */
export const TOKEN_PATTERN = '[a-z]{2,}';
export const NGRAM_RANGE: [number, number] = [1, 2];

/** n-gram counts of a text (unigrams + space-joined bigrams by default). */
export function termCounts(text: string, pattern = TOKEN_PATTERN, [minN, maxN] = NGRAM_RANGE): Map<string, number> {
  const tokens = text.toLowerCase().match(new RegExp(pattern, 'g')) ?? [];
  const counts = new Map<string, number>();
  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const term = n === 1 ? tokens[i] : tokens.slice(i, i + n).join(' ');
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return counts;
}

/** Sparse TF-IDF vector: sublinear tf (1 + ln tf) × idf over known terms, L2-normalised. */
export function tfidf(counts: Map<string, number>, index: Map<string, number>, idf: ArrayLike<number>): { idx: number[]; val: number[] } {
  const idx: number[] = [];
  const val: number[] = [];
  let norm = 0;
  for (const [term, count] of counts) {
    const j = index.get(term);
    if (j === undefined) continue;
    const v = (1 + Math.log(count)) * idf[j];
    idx.push(j);
    val.push(v);
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < val.length; k++) val[k] /= norm;
  return { idx, val };
}

export interface SvmModel {
  format: number;
  trained_at: string;
  tokenizer: { pattern: string; lowercase: boolean; ngram_range: [number, number] };
  temperature: number;
  classes: { id: string; name: string; examples: number }[];
  intercept: number[];
  terms: string[];
  idf: number[];
  /** Per term: flat [classIndex, weight, classIndex, weight, ...] (near-zero weights pruned). */
  weights: number[][];
  /** Cross-validated quality (absent in models trained before it was added). f1 by clause id; missing = too few examples to test. */
  metrics?: { accuracy: number; macro_f1: number; examples: number; f1: Record<string, number> };
}
