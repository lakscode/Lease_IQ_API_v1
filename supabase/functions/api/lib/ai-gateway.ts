// Vercel AI Gateway (AI SDK) for organizations whose clause classifier is 'gateway': one AI_GATEWAY_API_KEY,
// any gateway model (e.g. 'openai/gpt-5', 'google/gemini-2.5-pro'). Usage is recorded in ai_usage like Claude calls.
import { createGateway, generateText, jsonSchema, Output } from 'ai';
import type { AiContext } from './ai.ts';
import { env } from './env.ts';
import { ApiError } from './http.ts';
import { db } from './supabase.ts';
import { log } from './log.ts';

/** Gateway model ids look like "provider/model". */
export const GATEWAY_MODEL_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][\w.:-]*$/i;

let provider: ReturnType<typeof createGateway> | null = null;

export function gatewayConfigured(): boolean {
  return Boolean(env.aiGatewayApiKey);
}

/** OpenAI-compatible endpoint of the gateway (used by the LangChain classifier). */
export const GATEWAY_OPENAI_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

export function gatewayApiKey(): string {
  const apiKey = env.aiGatewayApiKey;
  if (!apiKey) throw new ApiError('ai_not_configured', 'Vercel AI Gateway is not configured. Set AI_GATEWAY_API_KEY on the API.');
  return apiKey;
}

function getGateway() {
  provider ??= createGateway({ apiKey: gatewayApiKey() });
  return provider;
}

/** Record one gateway call in ai_usage (input = non-cached input tokens, like Claude's usage). */
export async function recordGatewayUsage(
  ctx: AiContext, model: string,
  usage: { input: number; output: number; cacheWrite?: number; cacheRead?: number }, durationMs: number,
): Promise<void> {
  const { error } = await db().from('ai_usage').insert({
    org_id: ctx.orgId,
    user_id: ctx.userId,
    process: ctx.process,
    model,
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_creation_tokens: usage.cacheWrite ?? 0,
    cache_read_tokens: usage.cacheRead ?? 0,
    duration_ms: durationMs,
    file_id: ctx.fileId ?? null,
    lease_id: ctx.leaseId ?? null,
    conversation_id: ctx.conversationId ?? null,
  });
  if (error) log.error('ai.usage', `ai_usage insert failed: ${error.message}`, { process: ctx.process, model });
  log.info('ai.gateway', `Gateway call done (${ctx.process})`, {
    process: ctx.process, model, orgId: ctx.orgId, fileId: ctx.fileId ?? null, ms: durationMs,
    inputTokens: usage.input, outputTokens: usage.output,
  });
}

export interface GatewayStatus {
  configured: boolean;
  /** False when the gateway will refuse requests (no credits: Vercel requires a credit card / top-up). */
  ready: boolean;
  /** Remaining credit balance in USD, as reported by the gateway; null when unknown. */
  balance: string | null;
  error: string | null;
}

let statusCache: { at: number; status: GatewayStatus } | null = null;

/** Whether the gateway will actually serve requests (credit balance check, cached 5 minutes). */
export async function gatewayStatus(): Promise<GatewayStatus> {
  if (!gatewayConfigured()) return { configured: false, ready: false, balance: null, error: null };
  if (statusCache && Date.now() - statusCache.at < 300_000) return statusCache.status;
  let status: GatewayStatus;
  try {
    const { balance } = await getGateway().getCredits();
    status = { configured: true, ready: Number(balance) > 0, balance, error: null };
  } catch (err) {
    status = { configured: true, ready: false, balance: null, error: (err as Error).message.slice(0, 300) };
    log.warn('ai.gateway', `Gateway status check failed: ${status.error}`);
  }
  if (status.configured && !status.ready && !status.error) log.warn('ai.gateway', `Gateway has no credits (balance ${status.balance}); requests will be refused`);
  statusCache = { at: Date.now(), status };
  return status;
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
    log.warn('ai.gateway', `Could not list gateway models: ${(err as Error).message}`);
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
  await recordGatewayUsage(ctx, req.model, {
    input: u.inputTokenDetails?.noCacheTokens ?? u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheWrite: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    cacheRead: u.inputTokenDetails?.cacheReadTokens ?? 0,
  }, Date.now() - started);
  if (result.finishReason === 'length') throw new Error('AI response was cut off (max tokens). The document may be too long for a single pass.');
  return result.output;
}
