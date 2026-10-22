// OpenAI GPT for organizations whose AI provider is 'openai' (organizations.ai_provider): the same structured-output
// requests as Claude (ClaudeRequest: system, PDF/text/image blocks, JSON schema), sent to the OpenAI Responses API.
// Streamed, so long abstractions don't hit HTTP timeouts; usage is recorded in ai_usage like Claude calls.
import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiContext, ClaudeRequest } from './ai.ts';
import { env } from './env.ts';
import { ApiError } from './http.ts';
import { db } from './supabase.ts';
import { errorFields, log } from './log.ts';

const OPENAI_URL = 'https://api.openai.com/v1';

export interface OpenAiModel { id: string; label: string; note: string; reasoning: boolean }

export const OPENAI_MODELS: readonly OpenAiModel[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5', note: 'Default. Best OpenAI quality for lease abstraction.', reasoning: true },
  { id: 'gpt-5.4', label: 'GPT-5.4', note: 'Previous flagship; a little cheaper.', reasoning: true },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', note: 'Faster and cheaper.', reasoning: true },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', note: 'Fastest and cheapest; lower accuracy.', reasoning: true },
  { id: 'gpt-4.1', label: 'GPT-4.1', note: 'No reasoning; very long context.', reasoning: false },
];

export const OPENAI_DEFAULT_MODEL = 'gpt-5.5';

/** Model ids accepted for an organization (also newer ones from the account's model list). */
export const OPENAI_MODEL_RE = /^(gpt-[\w.:-]{1,60}|o\d[\w.:-]{0,60})$/i;
/** Chat models worth offering from the account's live list (no audio, realtime, image, search or dated snapshots). */
const OFFERED_RE = /^(gpt-5(\.\d+)?(-(mini|nano|pro))?|gpt-4\.1(-mini|-nano)?|o[34](-mini)?)$/;

const isReasoning = (model: string) => OPENAI_MODELS.find((m) => m.id === model)?.reasoning ?? !/^gpt-4/i.test(model);

export function openaiConfigured(): boolean {
  return Boolean(env.openaiApiKey);
}

function apiKey(): string {
  const key = env.openaiApiKey;
  if (!key) throw new ApiError('ai_not_configured', 'OpenAI is not configured. Set OPENAI_API_KEY on the API.');
  return key;
}

let modelsCache: { at: number; models: OpenAiModel[] } | null = null;

/** The curated models plus newer chat models the account can use (cached 10 minutes; curated only when unreachable). */
export async function openaiModels(): Promise<OpenAiModel[]> {
  if (!openaiConfigured()) return [...OPENAI_MODELS];
  if (modelsCache && Date.now() - modelsCache.at < 600_000) return modelsCache.models;
  let models: OpenAiModel[] = [...OPENAI_MODELS];
  try {
    const res = await fetch(`${OPENAI_URL}/models`, { headers: { authorization: `Bearer ${apiKey()}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = await res.json() as { data: { id: string }[] };
    const extra = data.map((m) => m.id).filter((id) => OFFERED_RE.test(id) && !OPENAI_MODELS.some((m) => m.id === id)).sort();
    models = [...models, ...extra.map((id) => ({ id, label: id, note: 'Available on this OpenAI account.', reasoning: isReasoning(id) }))];
  } catch (err) {
    log.warn('ai.openai', `Could not list OpenAI models: ${(err as Error).message}`);
  }
  modelsCache = { at: Date.now(), models };
  return models;
}

// ---- Request translation (Claude blocks → Responses API input) -------------------------------------

type InputPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_file'; filename: string; file_data: string }
  | { type: 'input_image'; image_url: string };

function toPart(block: BetaContentBlockParam, role: BetaMessageParam['role']): InputPart {
  if (block.type === 'text') return role === 'assistant' ? { type: 'output_text', text: block.text } : { type: 'input_text', text: block.text };
  if (block.type === 'document') {
    const src = block.source;
    if (src.type === 'base64') {
      const name = (block.title ?? 'document').replace(/[^\w .-]+/g, '_').slice(0, 80) || 'document';
      return { type: 'input_file', filename: `${name}.pdf`, file_data: `data:${src.media_type};base64,${src.data}` };
    }
    if (src.type === 'text') return { type: 'input_text', text: src.data };
  }
  if (block.type === 'image' && block.source.type === 'base64') {
    return { type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}` };
  }
  throw new Error(`Content of type "${block.type}" cannot be sent to OpenAI`);
}

function toInput(messages: BetaMessageParam[]) {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? [toPart({ type: 'text', text: m.content }, m.role)]
      : m.content.map((b) => toPart(b as BetaContentBlockParam, m.role)),
  }));
}

const systemText = (system: ClaudeRequest['system']) => typeof system === 'string' ? system : system.map((b) => b.text).join('\n\n');

/** Claude effort → OpenAI reasoning effort (OpenAI tops out at 'high'). */
const reasoningEffort = (effort: ClaudeRequest['effort']) => effort === 'low' ? 'low' : effort === 'medium' || !effort ? 'medium' : 'high';

// ---- Call ---------------------------------------------------------------------------------------

interface OpenAiResponse {
  model: string;
  status: 'completed' | 'incomplete' | 'failed' | string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}

/** POST /responses with stream: true; returns the final response object (retries 429/5xx before the stream starts). */
async function createResponse(body: Record<string, unknown>): Promise<OpenAiResponse> {
  let res: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${OPENAI_URL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (res.ok || attempt >= 2 || !(res.status === 429 || res.status >= 500)) break;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = text.slice(0, 500);
    try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* not JSON */ }
    throw new Error(`OpenAI request failed (HTTP ${res.status}): ${message}`);
  }

  // Server-sent events: keep the response from the terminal event.
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let final: OpenAiResponse | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data) as { type: string; response?: OpenAiResponse; message?: string };
      if (event.type === 'error') throw new Error(`OpenAI error: ${event.message ?? 'unknown'}`);
      if (event.response && (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed')) {
        final = event.response;
      }
    }
    if (done) break;
  }
  if (!final) throw new Error('OpenAI stream ended without a response');
  return final;
}

/** One structured-output call to OpenAI; returns the parsed JSON object and the model that answered. */
export async function callOpenAiJson<T>(ctx: AiContext, model: string, req: ClaudeRequest & { jsonSchema: Record<string, unknown> }): Promise<{ data: T; model: string }> {
  const started = Date.now();
  const where = { process: ctx.process, model, orgId: ctx.orgId, fileId: ctx.fileId ?? null, leaseId: ctx.leaseId ?? null, userId: ctx.userId };
  log.info('ai.openai', `OpenAI call started (${ctx.process})`, where);
  let response: OpenAiResponse;
  try {
    response = await createResponse({
      model,
      instructions: systemText(req.system),
      input: toInput(req.messages),
      max_output_tokens: req.maxTokens ?? 32000,
      ...(isReasoning(model) ? { reasoning: { effort: reasoningEffort(req.effort) } } : {}),
      text: { format: { type: 'json_schema', name: 'result', schema: req.jsonSchema, strict: true } },
      store: false,
    });
  } catch (err) {
    log.error('ai.openai', `OpenAI call failed (${ctx.process}): ${(err as Error)?.message}`, { ...where, ms: Date.now() - started, ...errorFields(err) });
    throw err;
  }

  const u = response.usage ?? {};
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  await recordUsage(ctx, response.model || model, { input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cacheRead: cached }, Date.now() - started);
  log.info('ai.openai', `OpenAI call done (${ctx.process})`, {
    ...where, model: response.model || model, ms: Date.now() - started, status: response.status,
    inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
  });

  if (response.status === 'failed') throw new Error(`OpenAI call failed: ${response.error?.message ?? 'unknown error'}`);
  const reason = response.incomplete_details?.reason;
  if (response.status === 'incomplete' && reason === 'max_output_tokens') {
    throw new Error('AI response was cut off (max tokens). The document may be too long for a single pass.');
  }
  const parts = (response.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
  if (reason === 'content_filter' || parts.some((p) => p.type === 'refusal')) {
    log.warn('ai.openai', `OpenAI declined the request (${ctx.process})`, where);
    throw new ApiError('bad_request', 'The AI model declined to process this request.');
  }
  const text = parts.filter((p) => p.type === 'output_text').map((p) => p.text ?? '').join('');
  try {
    return { data: JSON.parse(text) as T, model: response.model || model };
  } catch {
    throw new Error('AI returned invalid JSON');
  }
}

async function recordUsage(ctx: AiContext, model: string, usage: { input: number; output: number; cacheRead: number }, durationMs: number): Promise<void> {
  const { error } = await db().from('ai_usage').insert({
    org_id: ctx.orgId,
    user_id: ctx.userId,
    process: ctx.process,
    model,
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_creation_tokens: 0,
    cache_read_tokens: usage.cacheRead,
    duration_ms: durationMs,
    file_id: ctx.fileId ?? null,
    lease_id: ctx.leaseId ?? null,
    conversation_id: ctx.conversationId ?? null,
  });
  if (error) log.error('ai.usage', `ai_usage insert failed: ${error.message}`, { process: ctx.process, model });
}
