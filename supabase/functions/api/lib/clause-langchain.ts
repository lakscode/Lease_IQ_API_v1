// LangChain clause classifier: a LangChain.js chain (prompt template → chat model → JSON output parser) labels clause
// segments with lease_clauses.json ids, using any model on Vercel AI Gateway's OpenAI-compatible endpoint.
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import type { AiContext } from './ai.ts';
import { GATEWAY_OPENAI_BASE_URL, gatewayApiKey, recordGatewayUsage } from './ai-gateway.ts';
import { CLAUSE_LIST, LABEL_BATCH, LABEL_INSTRUCTIONS, segmentsMessage, validLabels, type SegmentLabel } from './clause-labels.ts';

export const LANGCHAIN_DEFAULT_MODEL = 'openai/gpt-5.4-mini';

// LangChain templates treat single braces as variables: keep {clauses}, double the JSON example's braces.
const PROMPT = ChatPromptTemplate.fromMessages([
  ['system', LABEL_INSTRUCTIONS.replace(/[{}]/g, (b) => b + b).replace('{{clauses}}', '{clauses}')],
  ['user', '{segments}'],
]);

/** Label clause segments with lease_clauses.json ids. Segments labelled "none" or with unknown ids are left out. */
export async function labelSegmentsLangchain(ctx: AiContext, modelName: string, segments: string[]): Promise<SegmentLabel[]> {
  const llm = new ChatOpenAI({
    model: modelName,
    apiKey: gatewayApiKey(),
    configuration: { baseURL: GATEWAY_OPENAI_BASE_URL },
    temperature: 0,
    maxTokens: 4000,
    maxRetries: 2,
  });
  // JSON mode (validated by validLabels) works across providers; strict json_schema support varies by model.
  const chain = PROMPT.pipe(llm.withStructuredOutput<Record<string, unknown>>(
    { type: 'object', properties: { labels: { type: 'array' } } },
    { method: 'jsonMode', includeRaw: true },
  ));
  const out: SegmentLabel[] = [];
  for (let start = 0; start < segments.length; start += LABEL_BATCH) {
    const batch = segments.slice(start, start + LABEL_BATCH);
    const started = Date.now();
    const { raw, parsed } = await chain.invoke({ clauses: CLAUSE_LIST, segments: segmentsMessage(batch, start) });
    const usage = (raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
    await recordGatewayUsage(ctx, modelName, { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 }, Date.now() - started);
    out.push(...validLabels(parsed, start, batch.length));
  }
  return out;
}
