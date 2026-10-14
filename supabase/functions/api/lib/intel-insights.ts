// Opportunities & insights: Claude reviews a lease family against the 20 opportunity categories and extracts the
// base rent schedule and CAM terms (stored in lease_insights; read by the financial tools, analytics and the PDF report).
//
// lease_insights.rent_schedule: RentPeriod[]  — percentages are plain percent numbers (8.4 = 8.4 %).
// lease_insights.cam_terms:     CamTerms
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { callClaudeJson, languageInstruction, pdfBlock, s } from './ai.ts';
import { OPPORTUNITY_CATEGORIES } from './abstract.ts';
import { db, must } from './supabase.ts';
import { downloadBytes } from './storage.ts';
import { sortFamily, type FamilyDocument } from './lease-terms.ts';
import { resolveMarketRate, type MarketRateRow } from './intel-market.ts';
import { latestRentRollRecord } from './intel-rent.ts';
import type { Locale } from './types.ts';

export interface RentPeriod {
  start: string;              // YYYY-MM-DD, first day of the period
  end: string | null;         // YYYY-MM-DD, last day (null = until expiration)
  monthly_rent: number | null; // contractual monthly base rent before any abatement
  annual_rent: number | null;
  rent_psf: number | null;     // annual rent per rentable sq ft
  abatement: boolean;          // true for free-rent / abated periods
  abatement_pct: number | null; // share of rent abated (100 = free rent); null with abatement=true means 100
  note: string | null;
}

export interface CamTerms {
  pro_rata_share: number | null;   // percent
  admin_fee_pct: number | null;    // percent of the tenant's share
  gross_up_pct: number | null;     // target occupancy percent for grossing up variable expenses
  cap_pct: number | null;          // annual cap percent
  cap_cumulative: boolean | null;
  cap_controllable_only: boolean | null;
  base_year: number | null;
  notes: string | null;
}

export const ALL_CATEGORIES = [...OPPORTUNITY_CATEGORIES.revenue, ...OPPORTUNITY_CATEGORIES.risk] as const;

export function kindOf(category: string): 'revenue' | 'risk' {
  return (OPPORTUNITY_CATEGORIES.revenue as readonly string[]).includes(category) ? 'revenue' : 'risk';
}

// Structured outputs allow at most 16 nullable (union-typed) properties per schema; keep this one under that.
const n = (d?: string) => s.nullable(s.number(d));

const INSIGHTS_SCHEMA = s.object({
  findings: s.array(s.object({
    category: s.enum(ALL_CATEGORIES),
    status: s.enum(['action', 'watch', 'none', 'needs_data'], 'action = act now, watch = monitor, none = not applicable / nothing found, needs_data = cannot assess without more data'),
    priority: s.enum(['high', 'medium', 'low']),
    summary: s.string('One or two sentences: what was found and what to do.'),
    due_date: s.nullable(s.string('YYYY-MM-DD deadline or key date, if any')),
    amount: n('Estimated annual amount in the lease currency, if quantifiable'),
    citations: s.array(s.object({
      document_number: s.integer('Number of the document as listed in the request (1-based)'),
      page: s.nullable(s.integer('1-based page within that document')),
      quote: s.string('Short verbatim quote'),
    })),
  }), 'Exactly one finding per category, in the category order given.'),
  rent_schedule: s.array(s.object({
    start: s.string('YYYY-MM-DD'),
    end: s.nullable(s.string('YYYY-MM-DD, last day of the period')),
    monthly_rent: n('Contractual monthly base rent before abatement'),
    annual_rent: n(),
    rent_psf: n('Annual rent per rentable sq ft'),
    abatement: s.boolean('True if rent is abated / free in this period'),
    abatement_pct: n('Percent of rent abated (100 = free rent)'),
    note: s.string('Empty string if none'),
  }), 'Base rent schedule over the whole term as amended, in date order, without gaps. Split abatement periods out.'),
  cam_terms: s.object({
    pro_rata_share: n('Tenant pro-rata share, percent'),
    admin_fee_pct: n('Administrative / management fee, percent'),
    gross_up_pct: n('Gross-up occupancy, percent'),
    cap_pct: n('Annual cap on (controllable) expense increases, percent'),
    cap_cumulative: s.nullable(s.boolean()),
    cap_controllable_only: s.nullable(s.boolean()),
    base_year: s.nullable(s.integer()),
    notes: s.string('Other CAM / operating expense terms; empty string if none'),
  }),
});

interface InsightsOutput {
  findings: {
    category: string; status: string; priority: string; summary: string; due_date: string | null; amount: number | null;
    citations: { document_number: number; page: number | null; quote: string }[];
  }[];
  rent_schedule: RentPeriod[];
  cam_terms: CamTerms;
}

const MAX_PDF_BYTES = 24 * 1024 * 1024;
const MAX_PDF_PAGES = 300;

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function cleanSchedule(rows: Partial<RentPeriod>[]): RentPeriod[] {
  return rows
    .filter((r) => isDate(r.start))
    .map((r) => {
      const monthly = Number.isFinite(Number(r.monthly_rent)) && r.monthly_rent !== null ? Number(r.monthly_rent) : null;
      const annual = Number.isFinite(Number(r.annual_rent)) && r.annual_rent !== null ? Number(r.annual_rent) : null;
      const pct = r.abatement_pct === null || r.abatement_pct === undefined ? null : Math.min(100, Math.max(0, Number(r.abatement_pct)));
      return {
        start: r.start as string,
        end: isDate(r.end) ? r.end : null,
        monthly_rent: monthly ?? (annual !== null ? Math.round((annual / 12) * 100) / 100 : null),
        annual_rent: annual ?? (monthly !== null ? Math.round(monthly * 12 * 100) / 100 : null),
        rent_psf: r.rent_psf === null || r.rent_psf === undefined || !Number.isFinite(Number(r.rent_psf)) ? null : Number(r.rent_psf),
        abatement: Boolean(r.abatement) || (pct !== null && pct > 0),
        abatement_pct: Number.isFinite(pct as number) ? pct : null,
        note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : null,
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function cleanCamTerms(t: Partial<CamTerms> | null | undefined): CamTerms {
  const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
  return {
    pro_rata_share: num(t?.pro_rata_share),
    admin_fee_pct: num(t?.admin_fee_pct),
    gross_up_pct: num(t?.gross_up_pct),
    cap_pct: num(t?.cap_pct),
    cap_cumulative: bool(t?.cap_cumulative),
    cap_controllable_only: bool(t?.cap_controllable_only),
    base_year: num(t?.base_year) === null ? null : Math.round(Number(t?.base_year)),
    notes: typeof t?.notes === 'string' && t.notes.trim() ? t.notes.trim() : null,
  };
}

type Doc = FamilyDocument & { storage_path: string | null; page_count: number | null };

/** Build the document blocks: stored PDFs when present (within limits), else the extracted page texts. */
async function documentBlocks(orgId: string, docs: Doc[]): Promise<{ blocks: BetaContentBlockParam[]; listing: string }> {
  const blocks: BetaContentBlockParam[] = [];
  const listing: string[] = [];
  let pdfBytes = 0;
  let pdfPages = 0;
  for (const [i, d] of docs.entries()) {
    const label = `Document ${i + 1}: ${d.title ?? d.doc_type} (${d.doc_type}${d.effective_date ? `, effective ${d.effective_date}` : ''})`;
    listing.push(label);
    let bytes: Uint8Array | null = null;
    if (d.storage_path && pdfPages + (d.page_count ?? 0) <= MAX_PDF_PAGES) {
      try {
        bytes = await downloadBytes(d.storage_path);
        if (pdfBytes + bytes.length > MAX_PDF_BYTES) bytes = null;
      } catch {
        bytes = null;
      }
    }
    if (bytes) {
      pdfBytes += bytes.length;
      pdfPages += d.page_count ?? 0;
      blocks.push(pdfBlock(bytes, { title: label }));
      continue;
    }
    const { data: pages } = await db().from('document_pages').select('page_number, text')
      .eq('org_id', orgId).eq('document_id', d.id).order('page_number');
    const text = (pages ?? []).map((p) => `[Page ${p.page_number}]\n${p.text}`).join('\n\n').slice(0, 400_000);
    blocks.push({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: text || '(no text extracted)' },
      title: label,
    });
  }
  return { blocks, listing: listing.join('\n') };
}

/** Run the insights review for one lease and store the result. Throws on failure (caller marks status). */
export async function generateInsights(input: { orgId: string; userId: string; leaseId: string; locale: Locale }): Promise<void> {
  const { orgId, leaseId } = input;
  const lease = must(await db().from('leases')
    .select('id, tenant_name, premises_address, property_type, rentable_area, base_rent_monthly, commencement_date, expiration_date, status, current_terms, market_rate_id, market_rate_override')
    .eq('id', leaseId).eq('org_id', orgId).single())!;
  const { data: docRows } = await db().from('documents')
    .select('id, doc_type, title, effective_date, created_at, page_start, abstract, changes_made, file_id, storage_path, page_count')
    .eq('org_id', orgId).eq('lease_id', leaseId);
  const docs = sortFamily((docRows ?? []) as Doc[]);
  if (!docs.length) throw new Error('This lease has no documents to review.');

  const [{ blocks, listing }, record, ratesRes, org] = await Promise.all([
    documentBlocks(orgId, docs),
    latestRentRollRecord(orgId, leaseId),
    db().from('market_rates').select('*').eq('org_id', orgId),
    db().from('organizations').select('currency').eq('id', orgId).single(),
  ]);
  const market = resolveMarketRate(lease, (ratesRes.data ?? []) as MarketRateRow[]);
  const currency = org.data?.currency ?? 'USD';

  const terms = Object.entries((lease.current_terms ?? {}) as Record<string, { value: unknown }>)
    .map(([k, v]) => `- ${k}: ${String(v.value)}`).join('\n');
  const recordText = record.record
    ? Object.entries(record.record)
      .filter(([k, v]) => v !== null && !['id', 'org_id', 'import_id', 'lease_id', 'raw'].includes(k))
      .map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n')
    : 'No rent roll record imported for this lease (billing findings may need data).';
  const marketText = market.rate_psf !== null
    ? `Market rent: ${market.rate_psf} ${currency}/RSF/year (${market.source}${market.rate?.source ? `, ${market.rate.source}` : ''}${market.rate?.as_of ? `, as of ${market.rate.as_of}` : ''}).`
    : 'No market rate available.';

  const categories = [
    'Revenue categories:', ...OPPORTUNITY_CATEGORIES.revenue.map((c) => `- ${c}`),
    'Risk categories:', ...OPPORTUNITY_CATEGORIES.risk.map((c) => `- ${c}`),
  ].join('\n');

  const system = [
    'You are a commercial lease analyst. Review the whole lease family (main lease plus amendments and letters; later documents override earlier ones) for revenue opportunities and risks.',
    `Return exactly one finding for each of the 20 categories. Today is ${new Date().toISOString().slice(0, 10)}. Amounts are in ${currency}.`,
    'Use the rent roll (system billing) record to check billing: compare billed rent, CAM and escalations with the lease. Use the market rate for market rent comparison and renewal opportunity.',
    'Cite the document number and page for every finding that relies on the lease text. If something cannot be assessed, use status needs_data.',
    'Also extract the base rent schedule for the whole term as amended (including future steps and abatement/free-rent periods) and the CAM / operating expense terms. Percentages are plain percent numbers (8.4 means 8.4%).',
    languageInstruction(input.locale),
  ].join('\n');

  const text = [
    `Lease: ${lease.tenant_name ?? 'unknown tenant'} at ${lease.premises_address ?? 'unknown premises'} (${lease.property_type ?? 'property type not set'}, status ${lease.status}).`,
    `Documents in this request:\n${listing}`,
    `Current terms as amended (extracted):\n${terms || '- none'}`,
    `System billing record:\n${recordText}`,
    marketText,
    `Categories:\n${categories}`,
  ].join('\n\n');

  const { data } = await callClaudeJson<InsightsOutput>(
    { process: 'insights', orgId, userId: input.userId, leaseId },
    { system, messages: [{ role: 'user', content: [...blocks, { type: 'text', text }] }], jsonSchema: INSIGHTS_SCHEMA, maxTokens: 32000, effort: 'high' },
  );

  const seen = new Set<string>();
  const rows = data.findings
    .filter((f) => (ALL_CATEGORIES as readonly string[]).includes(f.category) && !seen.has(f.category) && seen.add(f.category))
    .map((f) => ({
      org_id: orgId,
      lease_id: leaseId,
      category: f.category,
      kind: kindOf(f.category),
      status: ['action', 'watch', 'none', 'needs_data'].includes(f.status) ? f.status : 'needs_data',
      priority: ['high', 'medium', 'low'].includes(f.priority) ? f.priority : null,
      summary: f.summary,
      due_date: isDate(f.due_date) ? f.due_date : null,
      amount: Number.isFinite(Number(f.amount)) && f.amount !== null ? Number(f.amount) : null,
      citations: (f.citations ?? [])
        .map((ct) => ({ document_id: docs[ct.document_number - 1]?.id ?? null, page: ct.page, quote: ct.quote }))
        .filter((ct) => ct.document_id),
    }));

  // Replace the previous opportunities only after a successful run.
  must(await db().from('opportunities').delete().eq('lease_id', leaseId).eq('org_id', orgId));
  if (rows.length) must(await db().from('opportunities').insert(rows));
  must(await db().from('lease_insights').upsert({
    lease_id: leaseId,
    org_id: orgId,
    rent_schedule: cleanSchedule(data.rent_schedule ?? []),
    cam_terms: cleanCamTerms(data.cam_terms),
    status: 'completed',
    error: null,
    generated_at: new Date().toISOString(),
  }));
}
