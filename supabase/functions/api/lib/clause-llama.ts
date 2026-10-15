// Llama clause classifier: a Meta Llama model, called directly through the Vercel AI SDK (no LangChain), labels
// clause segments with lease_clauses.json ids.
import { createGateway, generateText } from 'ai';
import type { AiContext } from './ai.ts';
import { gatewayApiKey, recordGatewayUsage } from './ai-gateway.ts';
import { CLAUSE_LIST, LABEL_BATCH, LABEL_INSTRUCTIONS, parseJsonReply, segmentsMessage, validLabels, type SegmentLabel } from './clause-labels.ts';

export const LLAMA_DEFAULT_MODEL = 'meta/llama-4-scout';
export const LLAMA_MODEL_RE = /^meta\/llama[\w.:-]*$/i;

/** Label clause segments with lease_clauses.json ids. Segments labelled "none" or with unknown ids are left out. */
export async function labelSegmentsLlama(ctx: AiContext, modelName: string, segments: string[]): Promise<SegmentLabel[]> {
  const gateway = createGateway({ apiKey: gatewayApiKey() });
  const instructions = LABEL_INSTRUCTIONS.replace('{clauses}', CLAUSE_LIST);
  const out: SegmentLabel[] = [];
  for (let start = 0; start < segments.length; start += LABEL_BATCH) {
    const batch = segments.slice(start, start + LABEL_BATCH);
    const started = Date.now();
    // Plain text + JSON parsing: Llama hosts differ in structured-output support, the instructions fix the shape.
    const result = await generateText({
      model: gateway(modelName),
      instructions,
      prompt: segmentsMessage(batch, start),
      temperature: 0,
      maxOutputTokens: 4000,
    });
    const u = result.totalUsage;
    await recordGatewayUsage(ctx, modelName, { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 }, Date.now() - started);
    out.push(...validLabels(parseJsonReply(result.text), start, batch.length));
  }
  return out;
}
