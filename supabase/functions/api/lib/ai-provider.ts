// The organization's AI provider (organizations.ai_provider / ai_model, migration 0211), chosen by super admins:
// structured-output calls (lease pipeline, insights, attachment reviews, lease review AI check) go to Claude or OpenAI.
// The assistant chat (citations, streaming) always uses Claude.
import { aiConfigured, callClaudeJson, getModel, SUPPORTED_MODELS, type AiContext, type ClaudeRequest } from './ai.ts';
import { callOpenAiJson, OPENAI_DEFAULT_MODEL, OPENAI_MODEL_RE, openaiConfigured } from './ai-openai.ts';
import { ApiError } from './http.ts';
import { db } from './supabase.ts';

export type AiProvider = 'claude' | 'openai';
export const AI_PROVIDERS: readonly AiProvider[] = ['claude', 'openai'];

export interface OrgAi { provider: AiProvider; model: string }

const cache = new Map<string, { value: OrgAi; at: number }>();
const TTL_MS = 30_000;

/** Provider and model for an organization (Claude with the app-wide model when there is no organization). */
export async function orgAi(orgId: string | null | undefined): Promise<OrgAi> {
  if (!orgId) return { provider: 'claude', model: await getModel() };
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const { data, error } = await db().from('organizations').select('ai_provider, ai_model').eq('id', orgId).maybeSingle();
  // Don't silently fall back to Claude: a missing column means migration 0211 has not been applied.
  if (error) throw new Error(`Could not read the organization's AI provider (apply migration 0211): ${error.message}`);
  const model = (data?.ai_model as string | null) ?? null;
  const value: OrgAi = data?.ai_provider === 'openai'
    ? { provider: 'openai', model: model && OPENAI_MODEL_RE.test(model) ? model : OPENAI_DEFAULT_MODEL }
    : { provider: 'claude', model: model && SUPPORTED_MODELS.some((m) => m.id === model) ? model : await getModel() };
  cache.set(orgId, { value, at: Date.now() });
  return value;
}

/** Forget a cached organization setting (after a super admin changes it). */
export function clearOrgAiCache(orgId: string): void {
  cache.delete(orgId);
}

export function providerConfigured(provider: AiProvider): boolean {
  return provider === 'openai' ? openaiConfigured() : aiConfigured();
}

/** Whether the organization's AI provider has its API key. */
export async function orgAiConfigured(orgId: string | null | undefined): Promise<boolean> {
  return providerConfigured((await orgAi(orgId)).provider);
}

/** Throw ai_not_configured when the organization's provider has no API key. */
export async function requireOrgAi(orgId: string | null | undefined): Promise<void> {
  const { provider } = await orgAi(orgId);
  if (providerConfigured(provider)) return;
  throw new ApiError('ai_not_configured', provider === 'openai'
    ? 'OpenAI is not configured. Set OPENAI_API_KEY on the API.'
    : 'AI is not configured. Set ANTHROPIC_API_KEY on the API.');
}

/** Structured-output call with the organization's provider and model; returns the parsed object and the model used. */
export async function callAiJson<T>(ctx: AiContext, req: ClaudeRequest & { jsonSchema: Record<string, unknown> }): Promise<{ data: T; model: string; provider: AiProvider }> {
  const ai = await orgAi(ctx.orgId);
  if (ai.provider === 'openai') {
    const { data, model } = await callOpenAiJson<T>(ctx, ai.model, req);
    return { data, model, provider: 'openai' };
  }
  const { data, message } = await callClaudeJson<T>(ctx, { ...req, model: req.model ?? ai.model });
  return { data, model: message.model || ai.model, provider: 'claude' };
}
