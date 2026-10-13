// Lease Assistant retrieval: question → full-text query → ranked pages (document_pages) → page texts.
// Pure helpers (buildSearchQuery, pickLeaseMatches) are exported for testing.
import { db } from './supabase.ts';

// Stop words for the five UI languages (questions may be asked in any of them; the 'simple' FTS config keeps them).
const STOP_WORDS = new Set(`
a about above after again against all also am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers him his how i if in
into is it its itself just me more most my no nor not now of off on once only or other our out over own same she should so
some such than that the their them then there these they this those through to too under until up very was we were what
when where which while who whom why will with would you your yours tell show give find list please lease leases tenant
tenants document documents say says said does mention mentioned according much many there any whats what's
der die das den dem des ein eine einer eines einem einen und oder aber ist sind war waren wird werden hat haben mit von zu
im in am an auf aus bei für fur über uber unter nach vor wie was wer wo wann welche welcher welches warum nicht kein keine
ich du er sie es wir ihr mir mich dir uns euch sich auch noch nur schon sehr mehr gibt gilt bitte zeige nenne mietvertrag
el la los las un una unos unas y o pero es son fue era está estan están ser con de del al en por para sobre como qué que
quien quién cuándo cuando dónde donde cuál cual cuáles por qué no sí si se su sus mi mis le les lo me te nos muy más hay
o os a as um uma uns umas e ou mas é são foi era está estão ser com de do da dos das no na nos nas em por para sobre como
quem quando onde qual quais não sim se seu sua seus suas meu minha lhe muito mais há
il lo la i gli le un uno una e o ma è sono era essere con di del della dei delle da dal in nel nella su per come che chi
quando dove quale quali perché non sì se suo sua suoi sue mio mia mi ti ci vi si molto più c'è ci sono
`.split(/\s+/).filter(Boolean));

// Lease vocabulary: the question's word → extra words that lease text tends to use.
const SYNONYMS: Record<string, string[]> = {
  expire: ['expiration', 'expires', 'expiry'], expires: ['expiration'], expiry: ['expiration'], ends: ['expiration', 'term'],
  end: ['expiration', 'term'], renew: ['renewal', 'option'], renewal: ['renew', 'option'], extend: ['extension', 'extended', 'renewal'],
  extension: ['extended', 'renewal'], terminate: ['termination'], termination: ['terminate'], cancel: ['termination'],
  deposit: ['security'], security: ['deposit'], rent: ['rent'], escalation: ['increase', 'increases', 'escalation'],
  increase: ['escalation', 'increases'], increases: ['escalation'], cam: ['operating', 'expenses', 'cam'],
  opex: ['operating', 'expenses'], expenses: ['operating'], notice: ['notice', 'notices'], use: ['use', 'permitted'],
  start: ['commencement', 'commences'], commencement: ['commences'], begins: ['commencement'], landlord: ['landlord'],
  insurance: ['insurance', 'insure'], guarantor: ['guaranty', 'guarantee'], guaranty: ['guarantor', 'guarantee'],
  sublet: ['sublease', 'assignment', 'subletting'], assignment: ['assign', 'sublet'], parking: ['parking'],
  // A few common foreign-language question words mapped to English lease vocabulary.
  miete: ['rent'], kaution: ['deposit', 'security'], kündigung: ['termination'], verlängerung: ['renewal', 'extension'],
  ablauf: ['expiration'], renta: ['rent'], alquiler: ['rent'], depósito: ['deposit'], renovación: ['renewal'],
  aluguel: ['rent'], renovação: ['renewal'], affitto: ['rent'], canone: ['rent'], rinnovo: ['renewal'], deposito: ['deposit'],
};

export interface SearchQuery {
  /** Distinct keywords from the question (lower-case, stop words removed). */
  terms: string[];
  /** websearch_to_tsquery() input: keywords and their variants joined with "or". Empty if no keywords. */
  query: string;
}

/** Turn a natural-language question into an OR full-text query (stop words removed, simple plural/synonym variants). */
export function buildSearchQuery(question: string, maxTerms = 12): SearchQuery {
  const words = question
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !/^\d{1,2}$/.test(w));
  const terms: string[] = [];
  for (const w of words) if (!terms.includes(w)) terms.push(w);
  const limited = terms.slice(0, maxTerms);

  const variants = new Set<string>();
  for (const term of limited) {
    variants.add(term);
    if (/^\p{L}+$/u.test(term) && term.length > 3) {
      if (term.endsWith('ies')) variants.add(`${term.slice(0, -3)}y`);
      else if (term.endsWith('s') && !term.endsWith('ss')) variants.add(term.slice(0, -1));
      else variants.add(`${term}s`);
    }
    for (const syn of SYNONYMS[term] ?? []) variants.add(syn);
  }
  return { terms: limited, query: [...variants].join(' or ') };
}

export interface LeaseRef {
  id: string;
  tenant_name: string | null;
  premises_address: string | null;
  landlord_name: string | null;
}

/** Leases whose tenant/landlord/premises contain any question keyword (≥ 3 chars), best match first. */
export function pickLeaseMatches(terms: string[], leases: LeaseRef[]): { id: string; score: number }[] {
  const keywords = terms.filter((t) => t.length >= 3);
  if (!keywords.length) return [];
  const out: { id: string; score: number }[] = [];
  for (const lease of leases) {
    const tenant = (lease.tenant_name ?? '').toLowerCase();
    const other = `${lease.premises_address ?? ''} ${lease.landlord_name ?? ''}`.toLowerCase();
    let score = 0;
    for (const k of keywords) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u');
      if (re.test(tenant)) score += 3;
      else if (re.test(other)) score += 1;
    }
    if (score > 0) out.push({ id: lease.id, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface RetrievedPage {
  document_id: string;
  lease_id: string | null;
  document_title: string | null;
  tenant_name: string | null;
  page_number: number;
  text: string;
  rank: number;
  /** How the page was found. */
  via: 'search' | 'scope' | 'lease_match';
}

interface Hit { document_id: string; lease_id: string | null; title: string | null; page_number: number; snippet?: string; rank: number }

async function ftsSearch(orgId: string, query: string, limit: number, documentId?: string | null): Promise<Hit[]> {
  if (!query) return [];
  const { data, error } = await db().rpc('search_document_pages', {
    p_org: orgId, p_query: query, p_limit: limit, p_document: documentId ?? null,
  });
  if (error) throw new Error(`Search failed: ${error.message}`);
  return (data ?? []) as Hit[];
}

/** First pages of each document in a lease family (main lease first), for page reading. */
async function familyPages(orgId: string, leaseId: string, limit: number): Promise<Hit[]> {
  const { data: docs } = await db()
    .from('documents').select('id, title, doc_type, effective_date, lease_id')
    .eq('org_id', orgId).eq('lease_id', leaseId);
  const sorted = (docs ?? []).sort((a, b) => {
    if (a.doc_type === 'main_lease' && b.doc_type !== 'main_lease') return -1;
    if (b.doc_type === 'main_lease' && a.doc_type !== 'main_lease') return 1;
    return String(a.effective_date ?? '9999').localeCompare(String(b.effective_date ?? '9999'));
  });
  const out: Hit[] = [];
  for (const d of sorted) {
    if (out.length >= limit) break;
    out.push(...(await documentPages(orgId, d.id, limit - out.length, d.title, d.lease_id)));
  }
  return out;
}

async function documentPages(orgId: string, documentId: string, limit: number, title?: string | null, leaseId?: string | null): Promise<Hit[]> {
  if (title === undefined) {
    const { data: d } = await db().from('documents').select('title, lease_id').eq('id', documentId).eq('org_id', orgId).maybeSingle();
    title = d?.title ?? null;
    leaseId = d?.lease_id ?? null;
  }
  const { data } = await db()
    .from('document_pages').select('page_number')
    .eq('org_id', orgId).eq('document_id', documentId)
    .order('page_number').limit(limit);
  return (data ?? []).map((p) => ({ document_id: documentId, lease_id: leaseId ?? null, title: title ?? null, page_number: p.page_number, rank: 0 }));
}

export interface RetrievalResult {
  query: SearchQuery;
  pages: RetrievedPage[];
  matchedLeaseIds: string[];
}

/**
 * Find up to `maxPages` pages to answer a question.
 * 1. Full-text search (scoped to the document, the lease's documents, or the whole org).
 * 2. Unscoped: boost leases whose tenant/premises/landlord match the question; read their pages if search found little.
 * 3. Scoped: if search found little, read the scope's pages in order.
 */
export async function retrievePages(input: {
  orgId: string;
  question: string;
  leaseId?: string | null;
  documentId?: string | null;
  maxPages?: number;
  leases?: LeaseRef[];
}): Promise<RetrievalResult> {
  const maxPages = input.maxPages ?? 10;
  const q = buildSearchQuery(input.question);
  const key = (h: { document_id: string; page_number: number }) => `${h.document_id}:${h.page_number}`;
  const chosen = new Map<string, Hit & { via: RetrievedPage['via'] }>();
  const add = (hits: Hit[], via: RetrievedPage['via']) => {
    for (const h of hits) {
      if (chosen.size >= maxPages) return;
      if (!chosen.has(key(h))) chosen.set(key(h), { ...h, via });
    }
  };
  let matchedLeaseIds: string[] = [];

  if (input.documentId) {
    add(await ftsSearch(input.orgId, q.query, maxPages, input.documentId), 'search');
    if (chosen.size < Math.min(4, maxPages)) add(await documentPages(input.orgId, input.documentId, maxPages), 'scope');
  } else if (input.leaseId) {
    const { data: docs } = await db().from('documents').select('id').eq('org_id', input.orgId).eq('lease_id', input.leaseId);
    const results = await Promise.all((docs ?? []).map((d) => ftsSearch(input.orgId, q.query, maxPages, d.id)));
    add(results.flat().sort((a, b) => b.rank - a.rank), 'search');
    if (chosen.size < Math.min(4, maxPages)) add(await familyPages(input.orgId, input.leaseId, maxPages), 'scope');
  } else {
    const leases = input.leases ?? [];
    const matches = pickLeaseMatches(q.terms, leases);
    const top = matches.length ? matches[0].score : 0;
    matchedLeaseIds = matches.filter((m) => m.score >= Math.max(1, top - 1)).slice(0, 3).map((m) => m.id);
    const hits = await ftsSearch(input.orgId, q.query, 40);
    if (matchedLeaseIds.length) {
      // Prefer pages of the leases the question names, then the rest.
      add(hits.filter((h) => h.lease_id && matchedLeaseIds.includes(h.lease_id)), 'search');
      const perLease = Math.max(2, Math.floor(maxPages / matchedLeaseIds.length));
      for (const id of matchedLeaseIds) {
        const have = [...chosen.values()].filter((h) => h.lease_id === id).length;
        if (have < 2) add((await familyPages(input.orgId, id, perLease)).slice(0, perLease - have), 'lease_match');
      }
    }
    add(hits, 'search');
  }

  const picked = [...chosen.values()];
  if (!picked.length) return { query: q, pages: [], matchedLeaseIds };

  // Load page texts and tenant names.
  const byDoc = new Map<string, number[]>();
  for (const h of picked) byDoc.set(h.document_id, [...(byDoc.get(h.document_id) ?? []), h.page_number]);
  const texts = new Map<string, string>();
  await Promise.all([...byDoc.entries()].map(async ([docId, pages]) => {
    const { data } = await db().from('document_pages').select('page_number, text')
      .eq('org_id', input.orgId).eq('document_id', docId).in('page_number', pages);
    for (const p of data ?? []) texts.set(`${docId}:${p.page_number}`, p.text ?? '');
  }));
  const leaseIds = [...new Set(picked.map((h) => h.lease_id).filter((x): x is string => Boolean(x)))];
  const tenants = new Map<string, string | null>();
  if (leaseIds.length) {
    const { data } = await db().from('leases').select('id, tenant_name').eq('org_id', input.orgId).in('id', leaseIds);
    for (const l of data ?? []) tenants.set(l.id, l.tenant_name);
  }

  return {
    query: q,
    matchedLeaseIds,
    pages: picked.map((h) => ({
      document_id: h.document_id,
      lease_id: h.lease_id,
      document_title: h.title,
      tenant_name: h.lease_id ? tenants.get(h.lease_id) ?? null : null,
      page_number: h.page_number,
      text: (texts.get(key(h)) ?? '').slice(0, 15_000),
      rank: h.rank,
      via: h.via,
    })),
  };
}

/** Title used for a page's citation document: "<tenant> — <document title> — p.<n>". */
export function pageTitle(p: Pick<RetrievedPage, 'tenant_name' | 'document_title' | 'page_number'>): string {
  return `${p.tenant_name ?? 'Unknown tenant'} — ${p.document_title ?? 'Document'} — p.${p.page_number}`;
}
