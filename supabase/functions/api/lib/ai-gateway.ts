// Vercel AI Gateway (AI SDK) for organizations whose clause classifier is 'gateway': one AI_GATEWAY_API_KEY,
// any gateway model (e.g. 'openai/gpt-5', 'google/gemini-2.5-pro'). Usage is recorded in ai_usage like Claude calls.
import { createGateway, generateText, jsonSchema, Output } from 'ai';
import type { AiContext } from './ai.ts';
import { env } from './env.ts';
import { ApiError } from './http.ts';
import { db } from './supabase.ts';

/** Gateway model ids look like "provider/model". */
export const GATEWAY_MODEL_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][\w.:-]*$/i;

let provider: ReturnType<typeof createGateway> | null = null;

export function gatewayConfigured(): boolean {
  return Boolean(env.aiGatewayApiKey);
}

function getGateway() {
  const apiKey = env.aiGatewayApiKey;
  if (!apiKey) throw new ApiError('ai_not_configured', 'Vercel AI Gateway is not configured. Set AI_GATEWAY_API_KEY on the API.');
  provider ??= createGateway({ apiKey });
  return provider;
}

let modelsCache: { at: number; models: { id: string; name: string }[] } | null = null;

/** Language models available through the gateway (cached 10 minutes; empty when not configured or unreachable). */
export async function gatewayModels(): Promise<{ id: string; name: string }[]> {
  if (!gatewayConfigured()) return [];
  if (modelsCache && Date.now() - modelsCache.at < 600_000) return modelsCache.models;
  try {
    const { models } = await getGateway().getAvailableModels();
    const list = models
      .filter((m) => !m.modelType || m.modelType === 'language')
      .map((m) => ({ id: m.id, name: m.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    modelsCache = { at: Date.now(), models: list };
    return list;
  } catch (err) {
    console.error('[ai-gateway] list models:', (err as Error).message);
    return [];
  }
}

/** One structured-output call through the gateway; returns the parsed object. */
export async function callGatewayJson<T>(ctx: AiContext, req: {
  model: string; instructions: string; prompt: string; jsonSchema: Record<string, unknown>; maxOutputTokens?: number;
}): Promise<T> {
  const gateway = getGateway();
  const started = Date.now();
  const result = await generateText({
    model: gateway(req.model),
    instructions: req.instructions,
    prompt: req.prompt,
    output: Output.object({ schema: jsonSchema<T>(req.jsonSchema) }),
    maxOutputTokens: req.maxOutputTokens ?? 32000,
  });
  const u = result.totalUsage;
  const { error } = await db().from('ai_usage').insert({
    org_id: ctx.orgId,
    user_id: ctx.userId,
    process: ctx.process,
    model: req.model,
    input_tokens: u.inputTokenDetails?.noCacheTokens ?? u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    cache_creation_tokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    cache_read_tokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    duration_ms: Date.now() - started,
    file_id: ctx.fileId ?? null,
    lease_id: ctx.leaseId ?? null,
    conversation_id: ctx.conversationId ?? null,
  });
  if (error) console.error('ai_usage insert failed:', error.message);
  if (result.finishReason === 'length') throw new Error('AI response was cut off (max tokens). The document may be too long for a single pass.');
  return result.output;
}
