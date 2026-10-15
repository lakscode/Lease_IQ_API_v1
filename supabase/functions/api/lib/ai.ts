// Claude access for every AI feature: model selection, refusal fallback, usage recording.
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { env } from './env.ts';
import { ApiError } from './http.ts';
import { db } from './supabase.ts';
import { getSetting, SETTINGS } from './settings.ts';
import type { Locale } from './types.ts';
import { errorFields, log } from './log.ts';

export const SUPPORTED_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Default. Best quality for lease abstraction.' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster and cheaper.' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest and cheapest; lower accuracy.' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'Most capable; highest cost.' },
] as const;

export const DEFAULT_MODEL = 'claude-opus-5-5';

export type AiProcess = 'analysis' | 'reanalysis' | 'chat' | 'insights' | 'attachment' | 'signature' | 'ocr';

export interface AiContext {
  process: AiProcess;
  orgId: string | null;
  userId: string | null;
  fileId?: string | null;
  leaseId?: string | null;
  conversationId?: string | null;
}

let client: Anthropic | null = null;

export function aiConfigured(): boolean {
  return Boolean(env.anthropicApiKey);
}

function getClient(): Anthropic {
  const apiKey = env.anthropicApiKey;
  if (!apiKey) throw new ApiError('ai_not_configured', 'AI is not configured. Set ANTHROPIC_API_KEY on the API.');
  client ??= new Anthropic({ apiKey });
  return client;
}

export async function getModel(): Promise<string> {
  const model = await getSetting<string>(SETTINGS.aiModel, DEFAULT_MODEL);
  return SUPPORTED_MODELS.some((m) => m.id === model) ? model : DEFAULT_MODEL;
}

const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English', de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
};

/** Instruction appended to system prompts so free-text output follows the user's language. */
export function languageInstruction(locale: Locale | null | undefined): string {
  const lang = LANGUAGE_NAMES[locale ?? 'en'] ?? 'English';
  return `Write all free-text values (summaries, descriptions, explanations) in ${lang}. Keep names, addresses, dates, numbers, enum values and quotations from the documents unchanged.`;
}

export interface ClaudeRequest {
  system: string | BetaTextBlockParam[];
  messages: BetaMessageParam[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** JSON schema for structured output. Not compatible with citations. */
  jsonSchema?: Record<string, unknown>;
  model?: string;
}

/**
 * One Claude call with server-side refusal fallback, streamed (so long outputs don't hit HTTP timeouts),
 * and recorded in ai_usage.
 */
export async function callClaude(ctx: AiContext, req: ClaudeRequest): Promise<BetaMessage> {
  const anthropic = getClient();
  const model = req.model ?? (await getModel());
  const started = Date.now();

  const where = { process: ctx.process, model, orgId: ctx.orgId, fileId: ctx.fileId ?? null, leaseId: ctx.leaseId ?? null, userId: ctx.userId };
  log.info('ai.claude', `Claude call started (${ctx.process})`, where);
  let message: BetaMessage;
  try {
    const stream = anthropic.beta.messages.stream({
      model,
      max_tokens: req.maxTokens ?? 32000,
      system: req.system,
      messages: req.messages,
      output_config: {
        effort: req.effort ?? 'medium',
        ...(req.jsonSchema ? { format: { type: 'json_schema' as const, schema: req.jsonSchema } } : {}),
      },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    message = await stream.finalMessage();
  } catch (err) {
    log.error('ai.claude', `Claude call failed (${ctx.process}): ${(err as Error)?.message}`, { ...where, ms: Date.now() - started, ...errorFields(err) });
    throw err;
  }

  await recordUsage(ctx, message.model || model, message.usage, Date.now() - started);
  log.info('ai.claude', `Claude call done (${ctx.process})`, {
    ...where, model: message.model || model, ms: Date.now() - started, stop: message.stop_reason,
    inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens,
  });
  if (message.stop_reason === 'max_tokens') log.warn('ai.claude', `Claude output cut off at max_tokens (${ctx.process})`, where);

  if (message.stop_reason === 'refusal') {
    log.warn('ai.claude', `Claude declined the request (${ctx.process})`, where);
    throw new ApiError('bad_request', 'The AI model declined to process this request.');
  }
  return message;
}

/** Structured-output call; returns the parsed JSON object. */
export async function callClaudeJson<T>(ctx: AiContext, req: ClaudeRequest & { jsonSchema: Record<string, unknown> }): Promise<{ data: T; message: BetaMessage }> {
  const message = await callClaude(ctx, req);
  if (message.stop_reason === 'max_tokens') {
    throw new Error('AI response was cut off (max_tokens). The document may be too long for a single pass.');
  }
  const text = textOf(message);
  try {
    return { data: JSON.parse(text) as T, message };
  } catch {
    throw new Error('AI returned invalid JSON');
  }
}

export function textOf(message: BetaMessage): string {
  return message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

async function recordUsage(
  ctx: AiContext,
  model: string,
  usage: BetaMessage['usage'],
  durationMs: number,
): Promise<void> {
  const { error } = await db().from('ai_usage').insert({
    org_id: ctx.orgId,
    user_id: ctx.userId,
    process: ctx.process,
    model,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    duration_ms: durationMs,
    file_id: ctx.fileId ?? null,
    lease_id: ctx.leaseId ?? null,
    conversation_id: ctx.conversationId ?? null,
  });
  if (error) log.error('ai.usage', `ai_usage insert failed: ${error.message}`, { process: ctx.process, model });
}

/** Base64 PDF document block (place before the text block in user content). */
export function pdfBlock(bytes: Uint8Array, opts: { title?: string; citations?: boolean; cache?: boolean } = {}): BetaContentBlockParam {
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) },
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.citations ? { citations: { enabled: true } } : {}),
    ...(opts.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
  };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---- JSON schema helpers for structured outputs -------------------------------------------
// Structured outputs need closed objects (additionalProperties: false) with every property required;
// optional values are expressed as nullable.

type Schema = Record<string, unknown>;

export const s = {
  string: (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) }),
  number: (description?: string): Schema => ({ type: 'number', ...(description ? { description } : {}) }),
  integer: (description?: string): Schema => ({ type: 'integer', ...(description ? { description } : {}) }),
  boolean: (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) }),
  enum: (values: readonly string[], description?: string): Schema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) }),
  nullable: (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] }),
  array: (items: Schema, description?: string): Schema => ({ type: 'array', items, ...(description ? { description } : {}) }),
  object: (properties: Record<string, Schema>, description?: string): Schema => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    ...(description ? { description } : {}),
  }),
};
