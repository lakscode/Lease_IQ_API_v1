// Lease Assistant (/api/chat). Conversations are private to the user within the active organization.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { withOrg } from '../lib/auth.ts';
import { db, must } from '../lib/supabase.ts';
import { ApiError, badRequest, notFound, readJson, str } from '../lib/http.ts';
import { aiConfigured } from '../lib/ai.ts';
import { retrievePages, type LeaseRef } from '../lib/intel-search.ts';
import { answerQuestion, type HistoryMessage } from '../lib/intel-chat.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

const CONVERSATION_COLUMNS = 'id, title, lease_id, document_id, total_input_tokens, total_output_tokens, created_at, updated_at';

async function ownConversation(c: Context<AppEnv>, id: string) {
  const { data, error } = await db()
    .from('chat_conversations').select(CONVERSATION_COLUMNS)
    .eq('id', id).eq('org_id', c.get('orgId')).eq('user_id', c.get('user').id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound('Conversation');
  return data as {
    id: string; title: string | null; lease_id: string | null; document_id: string | null;
    total_input_tokens: number; total_output_tokens: number; created_at: string; updated_at: string;
  };
}

/** Validate an optional lease/document scope; a document implies its lease. */
async function resolveScope(orgId: string, leaseId: string | null, documentId: string | null) {
  if (documentId) {
    const { data } = await db().from('documents').select('id, lease_id').eq('id', documentId).eq('org_id', orgId).maybeSingle();
    if (!data) throw notFound('Document');
    if (leaseId && data.lease_id && data.lease_id !== leaseId) throw badRequest('The document does not belong to that lease');
    return { lease_id: data.lease_id ?? leaseId, document_id: documentId };
  }
  if (leaseId) {
    const { data } = await db().from('leases').select('id').eq('id', leaseId).eq('org_id', orgId).maybeSingle();
    if (!data) throw notFound('Lease');
  }
  return { lease_id: leaseId, document_id: null };
}

async function scopeLabels(orgId: string, rows: { lease_id: string | null; document_id: string | null }[]) {
  const leaseIds = [...new Set(rows.map((r) => r.lease_id).filter(Boolean))] as string[];
  const docIds = [...new Set(rows.map((r) => r.document_id).filter(Boolean))] as string[];
  const leases = new Map<string, string | null>();
  const docs = new Map<string, string | null>();
  if (leaseIds.length) {
    const { data } = await db().from('leases').select('id, tenant_name').eq('org_id', orgId).in('id', leaseIds);
    for (const l of data ?? []) leases.set(l.id, l.tenant_name);
  }
  if (docIds.length) {
    const { data } = await db().from('documents').select('id, title').eq('org_id', orgId).in('id', docIds);
    for (const d of data ?? []) docs.set(d.id, d.title);
  }
  return (r: { lease_id: string | null; document_id: string | null }) => ({
    lease_name: r.lease_id ? leases.get(r.lease_id) ?? null : null,
    document_title: r.document_id ? docs.get(r.document_id) ?? null : null,
  });
}

router.get('/conversations', async (c) => {
  const rows = must(await db()
    .from('chat_conversations').select(CONVERSATION_COLUMNS)
    .eq('org_id', c.get('orgId')).eq('user_id', c.get('user').id)
    .order('updated_at', { ascending: false }).limit(200));
  const label = await scopeLabels(c.get('orgId'), rows ?? []);
  return c.json((rows ?? []).map((r) => ({ ...r, ...label(r) })));
});

router.post('/conversations', async (c) => {
  const body = await readJson(c);
  const scope = await resolveScope(c.get('orgId'), str(body.lease_id), str(body.document_id));
  const row = must(await db().from('chat_conversations').insert({
    org_id: c.get('orgId'),
    user_id: c.get('user').id,
    title: str(body.title)?.slice(0, 120) ?? null,
    ...scope,
  }).select(CONVERSATION_COLUMNS).single())!;
  const label = await scopeLabels(c.get('orgId'), [row]);
  return c.json({ ...row, ...label(row) }, 201);
});

router.get('/conversations/:id', async (c) => {
  const conversation = await ownConversation(c, c.req.param('id'));
  const messages = must(await db()
    .from('chat_messages').select('id, role, content, citations, usage, created_at')
    .eq('conversation_id', conversation.id).order('id'));
  const label = await scopeLabels(c.get('orgId'), [conversation]);
  return c.json({ conversation: { ...conversation, ...label(conversation) }, messages });
});

router.patch('/conversations/:id', async (c) => {
  const conversation = await ownConversation(c, c.req.param('id'));
  const body = await readJson(c);
  const title = str(body.title);
  if (!title) throw badRequest('Title is required');
  const row = must(await db().from('chat_conversations').update({ title: title.slice(0, 120) })
    .eq('id', conversation.id).select(CONVERSATION_COLUMNS).single())!;
  return c.json(row);
});

router.delete('/conversations/:id', async (c) => {
  const conversation = await ownConversation(c, c.req.param('id'));
  must(await db().from('chat_conversations').delete().eq('id', conversation.id));
  return c.json({ ok: true });
});

/** Lease data the assistant sees as plain context (not citable): one lease's current terms, or a portfolio overview. */
async function buildContext(orgId: string, leaseId: string | null, leases: (LeaseRef & Record<string, unknown>)[]): Promise<string> {
  if (leaseId) {
    const { data } = await db().from('leases').select('tenant_name, premises_address, status, property_type, current_terms')
      .eq('id', leaseId).eq('org_id', orgId).maybeSingle();
    if (!data) return '';
    const terms = Object.entries((data.current_terms ?? {}) as Record<string, { value: unknown; source_title?: string | null }>)
      .map(([k, v]) => `- ${k}: ${String(v.value)}${v.source_title ? ` (from ${v.source_title})` : ''}`)
      .join('\n');
    return `Question scope: one lease — ${data.tenant_name ?? 'unknown tenant'}, ${data.premises_address ?? 'unknown premises'} (status ${data.status}, ${data.property_type ?? 'type not set'}).\nCurrent terms as amended (extracted data, verify against the pages):\n${terms || '- none extracted'}`;
  }
  const lines = leases.slice(0, 150).map((l) =>
    `- ${l.tenant_name ?? 'Unknown tenant'} | ${l.premises_address ?? '—'} | ${l.property_type ?? '—'} | status ${l.status} | ${l.commencement_date ?? '?'} → ${l.expiration_date ?? '?'} | monthly base rent ${l.base_rent_monthly ?? '?'} | ${l.rentable_area ?? '?'} sq ft`);
  return `Portfolio overview (${leases.length} leases; extracted data, use it for portfolio-wide questions and cite pages where possible):\n${lines.join('\n') || '- no leases'}`;
}

async function orgLeases(orgId: string) {
  const { data } = await db().from('leases')
    .select('id, tenant_name, landlord_name, premises_address, property_type, status, commencement_date, expiration_date, base_rent_monthly, rentable_area')
    .eq('org_id', orgId).order('tenant_name').limit(1000);
  return (data ?? []) as (LeaseRef & Record<string, unknown>)[];
}

// Retrieval preview (no AI): which pages the assistant would read for a question.
router.get('/search', async (c) => {
  const q = str(c.req.query('q'));
  if (!q) throw badRequest('q is required');
  const orgId = c.get('orgId');
  const scope = await resolveScope(orgId, str(c.req.query('lease_id')), str(c.req.query('document_id')));
  const result = await retrievePages({ orgId, question: q, leaseId: scope.lease_id, documentId: scope.document_id, leases: await orgLeases(orgId) });
  return c.json({
    query: result.query,
    matched_lease_ids: result.matchedLeaseIds,
    pages: result.pages.map(({ text, ...p }) => ({ ...p, excerpt: text.slice(0, 300) })),
  });
});

router.post('/conversations/:id/messages', async (c) => {
  const conversation = await ownConversation(c, c.req.param('id'));
  const body = await readJson(c);
  const question = str(body.content);
  if (!question) throw badRequest('content is required');
  if (question.length > 4000) throw badRequest('Question is too long (max 4000 characters)');
  if (!aiConfigured()) throw new ApiError('ai_not_configured', 'AI is not configured. Set ANTHROPIC_API_KEY on the API.');

  const orgId = c.get('orgId');
  const userId = c.get('user').id;
  const leases = conversation.lease_id ? [] : await orgLeases(orgId);
  const [retrieval, context, history] = await Promise.all([
    retrievePages({ orgId, question, leaseId: conversation.lease_id, documentId: conversation.document_id, leases }),
    buildContext(orgId, conversation.lease_id, leases),
    db().from('chat_messages').select('role, content').eq('conversation_id', conversation.id).order('id', { ascending: false }).limit(20),
  ]);

  const userMsg = must(await db().from('chat_messages')
    .insert({ conversation_id: conversation.id, role: 'user', content: question })
    .select('id, role, content, citations, usage, created_at').single())!;

  let result;
  try {
    result = await answerQuestion({
      orgId, userId, conversationId: conversation.id, locale: c.get('profile').locale, question,
      history: ((history.data ?? []) as HistoryMessage[]).reverse(),
      pages: retrieval.pages, context,
    });
  } catch (err) {
    await db().from('chat_messages').delete().eq('id', userMsg.id);
    throw err;
  }

  const assistantMsg = must(await db().from('chat_messages').insert({
    conversation_id: conversation.id, role: 'assistant', content: result.answer, citations: result.sources, usage: result.usage,
  }).select('id, role, content, citations, usage, created_at').single())!;

  const u = result.usage;
  const updated = must(await db().from('chat_conversations').update({
    title: conversation.title ?? (question.length > 80 ? `${question.slice(0, 77)}…` : question),
    total_input_tokens: conversation.total_input_tokens + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
    total_output_tokens: conversation.total_output_tokens + u.output_tokens,
  }).eq('id', conversation.id).select(CONVERSATION_COLUMNS).single())!;

  return c.json({ conversation: updated, messages: [userMsg, assistantMsg] });
});

export default router;
