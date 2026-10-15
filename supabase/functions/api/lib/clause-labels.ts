// Shared by the LLM segment labellers (clause-langchain.ts, clause-llama.ts): the clause list, the instructions,
// batching, and validation of the labels a model returns. Segments come from the SVM's splitter; models return
// only a lease_clauses.json id per segment (not the clause text), which keeps output tokens low.
import { LEASE_CLAUSES } from './lease-clauses.ts';

/** Segments per call, and characters of each segment sent (the clause type is clear from its opening). */
export const LABEL_BATCH = 20;
const SEGMENT_CHARS = 1200;

export interface SegmentLabel {
  index: number;
  clause_id: string;
  confidence: number;
  alternatives: { clause_id: string; confidence: number }[];
}

export const CLAUSE_LIST = Object.entries(LEASE_CLAUSES).map(([id, name]) => `${id} | ${name}`).join('\n');

/** System instructions; `{clauses}` is replaced by the clause list. */
export const LABEL_INSTRUCTIONS =
  'You classify commercial lease clauses. Allowed clause types (id | name):\n{clauses}\n\n' +
  'For every numbered segment, choose the single best clause type id, or "none" when the segment is a heading, ' +
  'signature block, boilerplate, or fits no type. Give a confidence from 0 to 1 and up to 2 alternative ids when unsure.\n' +
  'Answer with JSON only, exactly in this shape: ' +
  '{"labels":[{"index":0,"clause_id":"<id or none>","confidence":0.9,"alternatives":[{"clause_id":"<id>","confidence":0.1}]}]}';

/** The numbered segments of one batch, as the user message. */
export function segmentsMessage(batch: string[], start: number): string {
  return batch.map((t, i) => `[${start + i}] ${t.slice(0, SEGMENT_CHARS)}`).join('\n\n');
}

const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));

/** First JSON object in a model reply (tolerates code fences or text around it). */
export function parseJsonReply(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/** Keep valid labels for segments [start, start + count): known ids only; "none" and unknown ids are dropped. */
export function validLabels(parsed: unknown, start: number, count: number): SegmentLabel[] {
  const labels = (parsed as { labels?: unknown })?.labels;
  const out: SegmentLabel[] = [];
  for (const l of (Array.isArray(labels) ? labels : []) as Record<string, unknown>[]) {
    const index = Number(l?.index);
    const id = String(l?.clause_id ?? '');
    if (!Number.isInteger(index) || index < start || index >= start + count || !(id in LEASE_CLAUSES)) continue;
    const alternatives = (Array.isArray(l.alternatives) ? l.alternatives : [])
      .map((a: Record<string, unknown>) => ({ clause_id: String(a?.clause_id ?? ''), confidence: clamp(a?.confidence) }))
      .filter((a) => a.clause_id in LEASE_CLAUSES && a.clause_id !== id)
      .slice(0, 2);
    out.push({ index, clause_id: id, confidence: clamp(l.confidence), alternatives });
  }
  return out;
}
