// Lease Assistant answer step: retrieved pages → citation-enabled Claude call → answer text + mapped sources.
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { callClaude, languageInstruction } from './ai.ts';
import { pageTitle, type RetrievedPage } from './intel-search.ts';
import type { Locale } from './types.ts';

export interface ChatSource {
  document_id: string;
  lease_id: string | null;
  title: string;
  page: number;
  quote: string;
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface HistoryMessage { role: 'user' | 'assistant'; content: string }

export const MAX_SOURCES = 10;

/** Merge consecutive same-role messages and make sure the history starts with a user turn. */
export function normalizeHistory(history: HistoryMessage[], maxMessages = 20): BetaMessageParam[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of history.slice(-maxMessages)) {
    const text = m.content.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${text}`;
    else out.push({ role: m.role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  // History must end with an assistant turn (the new question is appended as the next user turn).
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  return out.map((m) => ({ role: m.role, content: m.content }));
}

/** Map the answer's text blocks and citations to plain text with [n] markers and a deduplicated source list. */
export function mapCitations(message: Pick<BetaMessage, 'content'>, pages: RetrievedPage[]): { answer: string; sources: ChatSource[] } {
  const sources: ChatSource[] = [];
  const indexOf = new Map<string, number>();
  let answer = '';
  for (const block of message.content) {
    if (block.type !== 'text') continue;
    answer += block.text;
    const markers: number[] = [];
    for (const c of block.citations ?? []) {
      if (!('document_index' in c)) continue;
      const page = pages[c.document_index];
      if (!page) continue;
      const pageNo = c.type === 'page_location' ? c.start_page_number : page.page_number;
      const k = `${page.document_id}:${pageNo}`;
      let idx = indexOf.get(k);
      if (idx === undefined) {
        if (sources.length >= MAX_SOURCES) continue;
        sources.push({
          document_id: page.document_id,
          lease_id: page.lease_id,
          title: pageTitle(page),
          page: pageNo,
          quote: c.cited_text.trim().slice(0, 500),
        });
        idx = sources.length - 1;
        indexOf.set(k, idx);
      }
      if (!markers.includes(idx + 1)) markers.push(idx + 1);
    }
    if (markers.length) answer += markers.map((n) => `[${n}]`).join('');
  }
  return { answer: answer.trim(), sources };
}

export function usageOf(message: Pick<BetaMessage, 'usage'>): ChatUsage {
  return {
    input_tokens: message.usage.input_tokens ?? 0,
    output_tokens: message.usage.output_tokens ?? 0,
    cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

export async function answerQuestion(input: {
  orgId: string;
  userId: string;
  conversationId: string;
  locale: Locale;
  question: string;
  history: HistoryMessage[];
  pages: RetrievedPage[];
  /** Plain-text context (portfolio overview or the scoped lease's current terms). */
  context: string;
}): Promise<{ answer: string; sources: ChatSource[]; usage: ChatUsage }> {
  const documents: BetaContentBlockParam[] = input.pages.map((p) => ({
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: p.text || '(blank page)' },
    title: pageTitle(p),
    citations: { enabled: true },
  }));

  const system = [
    'You are the Lease Assistant in Lease IQ, a commercial lease management app.',
    'Answer questions about the organization\'s leases using the provided lease pages (each document is one page, titled "<tenant> — <document> — p.<page>") and the lease data summary below.',
    'Cite the pages that support each statement. If the pages do not contain the answer, say so plainly and suggest what to look for; never invent lease terms, dates or amounts.',
    'Be concise: lead with the direct answer, then the supporting details. Use short paragraphs or bullet lists. Amounts are in the organization currency unless the document says otherwise.',
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    languageInstruction(input.locale),
    'Write the answer itself in that language too.',
    '',
    input.context,
  ].join('\n');

  const content: BetaContentBlockParam[] = [...documents, { type: 'text', text: input.question }];
  const message = await callClaude(
    { process: 'chat', orgId: input.orgId, userId: input.userId, conversationId: input.conversationId },
    {
      system,
      messages: [...normalizeHistory(input.history), { role: 'user', content }],
      maxTokens: 16000,
      effort: 'medium',
    },
  );
  const { answer, sources } = mapCitations(message, input.pages);
  return { answer: answer || '—', sources, usage: usageOf(message) };
}
