// The Claude calls of the lease pipeline: OCR, split & classify, abstract (+clauses, signature, linking),
// signature re-check and clause re-classification. Everything else in the pipeline is plain code (store.ts).
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { callClaudeJson, languageInstruction, pdfBlock, s, type AiContext } from '../ai.ts';
import { ABSTRACT_FIELDS, CLAUSE_TYPES, DOC_TYPES } from '../abstract.ts';
import type { Locale } from '../types.ts';
import type { AbstractResult, ClauseResult, SignatureResult, SplitResult } from './types.ts';
import { withPageMarkers } from './pdf.ts';

/** What Claude reads: either the PDF itself or page texts with page markers. */
export type DocumentInput =
  | { kind: 'pdf'; bytes: Uint8Array; title?: string }
  | { kind: 'text'; pages: { page: number; text: string }[] };

function inputBlocks(input: DocumentInput, instruction: string): BetaContentBlockParam[] {
  if (input.kind === 'pdf') {
    return [pdfBlock(input.bytes, { title: input.title }), { type: 'text', text: instruction }];
  }
  return [{ type: 'text', text: `${withPageMarkers(input.pages)}\n\n---\n\n${instruction}` }];
}

const PAGE_NOTE =
  'Page numbers are 1-based and relative to the material you were given (the first page you see is page 1).';

// ---- OCR ----------------------------------------------------------------------------------

const OCR_SCHEMA = s.object({
  pages: s.array(s.object({
    page: s.integer('1-based page number within the given PDF'),
    text: s.string('Full transcription of the page in reading order. Empty string for blank pages.'),
  })),
});

/** Transcribe a (sub-)PDF of scanned pages. Returns text per page (index 0 = first page of the sub-PDF). */
export async function ocrPdf(ctx: AiContext, bytes: Uint8Array, pageCount: number): Promise<string[]> {
  const { data } = await callClaudeJson<{ pages: { page: number; text: string }[] }>(ctx, {
    system:
      'You transcribe scanned commercial lease documents. Reproduce the text of every page faithfully, in reading order, ' +
      'keeping headings, numbering, and line breaks between paragraphs. Do not summarise, translate, or correct the text. ' +
      'Mark illegible words as [illegible]. Describe signatures as [signature] and stamps as [stamp].',
    messages: [{
      role: 'user',
      content: [pdfBlock(bytes), { type: 'text', text: `Transcribe all ${pageCount} page(s) of this PDF. Return one entry per page.` }],
    }],
    jsonSchema: OCR_SCHEMA,
    effort: 'low',
    maxTokens: 64000,
  });
  const out: string[] = Array.from({ length: pageCount }, () => '');
  for (const p of data.pages ?? []) {
    if (p.page >= 1 && p.page <= pageCount) out[p.page - 1] = p.text ?? '';
  }
  return out;
}

// ---- Split & classify -------------------------------------------------------------------------

const SPLIT_SCHEMA = s.object({
  documents: s.array(s.object({
    doc_type: s.enum(DOC_TYPES, 'main_lease = the original lease agreement; amendment = amends/extends/modifies a lease; addendum = rider/addendum/exhibit adding terms; commencement_letter = confirms commencement/expiration dates; other = anything else (guaranty, estoppel, SNDA, notice, cover page…)'),
    title: s.nullable(s.string('Title as written on the document, e.g. "Second Amendment to Lease"')),
    effective_date: s.nullable(s.string('Effective or execution date, YYYY-MM-DD')),
    page_start: s.integer('First page (1-based) of this document'),
    page_end: s.integer('Last page (1-based, inclusive)'),
  })),
});

export async function splitFile(ctx: AiContext, input: DocumentInput, totalPages: number, locale: Locale): Promise<SplitResult> {
  const { data } = await callClaudeJson<SplitResult>(ctx, {
    system:
      'You are a commercial real estate paralegal. An uploaded PDF may contain one document or a bundle of several ' +
      '(a main lease, amendments, addenda, commencement letters, other papers). Identify each separate document, in page order, ' +
      'with its page range. Exhibits and schedules attached to a lease belong to that lease unless they are clearly a separately ' +
      'executed instrument. Ranges must not overlap and together should cover every page. ' + PAGE_NOTE + ' ' +
      languageInstruction(locale),
    messages: [{
      role: 'user',
      content: inputBlocks(input, `The file has ${totalPages} page(s). List every document it contains with its type, title, effective date and page range.`),
    }],
    jsonSchema: SPLIT_SCHEMA,
    effort: 'medium',
    maxTokens: 16000,
  });
  return data;
}

// ---- Abstract ----------------------------------------------------------------------------------

// Fields come back as a list of the values the document states rather than an object of nullable entries:
// structured outputs allow at most 16 union-typed (nullable) properties per schema, and two per field exceeds that.
// Values are strings; buildAbstract coerces numbers and dates per field kind.
const EXTRACTED_FIELDS = ABSTRACT_FIELDS.filter((f) => f.key !== 'changes_made');

const FIELD_GUIDE = EXTRACTED_FIELDS.map((f) =>
  `${f.key}: ${f.label}${f.kind === 'date' ? ' (YYYY-MM-DD)' : ''}${f.kind === 'number' ? ' (plain number)' : ''}${f.kind === 'money' ? ' (plain number in the lease currency)' : ''}`,
).join('; ');

const FIELDS_SCHEMA = s.array(s.object({
  key: s.enum(EXTRACTED_FIELDS.map((f) => f.key)),
  value: s.string(),
  page: s.integer('Page where the value is stated'),
}), `One entry per field this document states; omit fields it does not state. Fields: ${FIELD_GUIDE}`);

function fieldsRecord(entries: { key: string; value: string; page: number }[] | undefined): AbstractResult['fields'] {
  const fields: AbstractResult['fields'] = {};
  for (const e of entries ?? []) {
    if (!fields[e.key]) fields[e.key] = { value: e.value, page: e.page ?? null };
  }
  return fields;
}

const SIGNATURE_SCHEMA = s.object({
  status: s.enum(['signed', 'partially_signed', 'unsigned', 'unclear']),
  method: s.enum(['ink', 'digital', 'docusign', 'adobe_sign', 'none', 'unknown']),
  parties: s.array(s.object({
    party: s.string('Role in the document, e.g. Landlord, Tenant, Guarantor'),
    signer: s.nullable(s.string('Name of the person who signed, if legible')),
    date: s.nullable(s.string('Signature date, YYYY-MM-DD')),
  })),
  signature_pages: s.array(s.integer()),
  notes: s.nullable(s.string()),
});

const CLAUSE_SCHEMA = s.object({
  clause_type: s.enum(CLAUSE_TYPES),
  confidence: s.number('0 to 1'),
  alternatives: s.array(s.object({ type: s.enum(CLAUSE_TYPES), confidence: s.number() }), 'Up to 3 other likely types when uncertain (confidence < 0.85); otherwise empty'),
  section: s.nullable(s.string('Section number or heading, e.g. "4.2" or "Article 7"')),
  page: s.nullable(s.integer()),
  paragraph: s.nullable(s.integer('Paragraph number on the page (1-based)')),
  line: s.nullable(s.integer('Approximate first line on the page (1-based)')),
  excerpt: s.string('Short verbatim excerpt (max ~300 characters)'),
});

const ABSTRACT_SCHEMA = s.object({
  fields: FIELDS_SCHEMA,
  summary: s.nullable(s.string('3–6 sentence plain-language summary')),
  changes_made: s.nullable(s.string('For amendments/addenda/letters: what this document changes. Null for a main lease.')),
  effective_date: s.nullable(s.string('YYYY-MM-DD')),
  clauses: s.array(CLAUSE_SCHEMA),
  signature: SIGNATURE_SCHEMA,
  link: s.object({
    kind: s.enum(['new_lease', 'same_file', 'existing_lease']),
    document_index: s.nullable(s.integer('Index of the main document in the same file this document belongs to')),
    lease_id: s.nullable(s.string('Id of the existing lease this document belongs to')),
    reason: s.nullable(s.string()),
  }, 'Which lease family this document belongs to'),
});

export interface AbstractContext {
  docType: string;
  title: string | null;
  siblings: { index: number; doc_type: string; title: string | null; page_start: number; page_end: number }[];
  candidates: { id: string; tenant_name: string | null; landlord_name: string | null; premises_address: string | null; commencement_date: string | null; expiration_date: string | null }[];
  targetLeaseId: string | null;
}

export async function abstractDocument(ctx: AiContext, input: DocumentInput, info: AbstractContext, locale: Locale): Promise<AbstractResult> {
  const isMain = info.docType === 'main_lease';
  const linking = [
    `Other documents in the same uploaded file: ${info.siblings.length ? JSON.stringify(info.siblings) : 'none'}.`,
    `Existing leases in this organization: ${info.candidates.length ? JSON.stringify(info.candidates) : 'none'}.`,
    info.targetLeaseId ? `The user uploaded this file as an amendment to existing lease ${info.targetLeaseId}.` : '',
  ].filter(Boolean).join('\n');

  const instruction = [
    `This document was classified as "${info.docType}"${info.title ? ` titled "${info.title}"` : ''}.`,
    'Extract the lease abstract. For each field this document states (or changes), give the value and the page; leave out fields it does not state.',
    isMain
      ? 'For a main lease, state the full original terms.'
      : 'For an amendment or other later document, only list fields this document sets or changes (e.g. a new expiration date or new rent). Describe the changes in changes_made.',
    'Compute base_rent_annual = 12 × monthly (or vice versa) when only one is given. renewal_notice_months is the number of months before expiration by which renewal notice must be given.',
    `Classify the document's clauses into the allowed clause types (one entry per clause; skip boilerplate headings). ${PAGE_NOTE}`,
    'Check signatures: look at the likely signature pages (usually the end of the document), including ink signatures on scans, digital signatures and DocuSign or Adobe Sign markers. Report each party with signer and date.',
    'Linking: say which lease family this document belongs to. A main lease is normally a new_lease unless it is clearly the missing main lease of an existing lease. ' +
      'An amendment belongs to its main lease: same_file (give document_index) when that main lease is in this file, existing_lease (give lease_id) when it matches an existing lease by tenant, landlord and premises, otherwise new_lease.',
    linking,
  ].join('\n\n');

  const { data } = await callClaudeJson<Omit<AbstractResult, 'fields'> & { fields: { key: string; value: string; page: number }[] }>(ctx, {
    system:
      'You are an expert commercial lease abstractor. Be precise: values must be supported by the document. Dates as YYYY-MM-DD, money and areas as plain numbers. ' +
      languageInstruction(locale),
    messages: [{ role: 'user', content: inputBlocks(input, instruction) }],
    jsonSchema: ABSTRACT_SCHEMA,
    effort: 'high',
    maxTokens: 48000,
  });
  return { ...data, fields: fieldsRecord(data.fields) };
}

// ---- Signature re-check -----------------------------------------------------------------------

export async function checkSignatures(ctx: AiContext, input: DocumentInput, locale: Locale): Promise<SignatureResult> {
  const { data } = await callClaudeJson<SignatureResult>(ctx, {
    system:
      'You verify the execution of commercial lease documents. Look at the likely signature pages, including ink signatures on scanned pages, ' +
      'digital signatures, and DocuSign or Adobe Sign envelopes/markers. Unsigned blank signature lines mean unsigned. ' + languageInstruction(locale),
    messages: [{ role: 'user', content: inputBlocks(input, `Check whether this document is signed. Report status, method, each party with signer and date, and the signature pages. ${PAGE_NOTE}`) }],
    jsonSchema: SIGNATURE_SCHEMA,
    effort: 'medium',
    maxTokens: 8000,
  });
  return data;
}

// ---- Clause re-classification -----------------------------------------------------------------

export async function classifyClauses(ctx: AiContext, input: DocumentInput, locale: Locale): Promise<ClauseResult[]> {
  const { data } = await callClaudeJson<{ clauses: ClauseResult[] }>(ctx, {
    system: 'You are an expert commercial lease abstractor who classifies lease clauses. ' + languageInstruction(locale),
    messages: [{ role: 'user', content: inputBlocks(input, `Classify every substantive clause of this document into the allowed clause types, with confidence, up to 3 alternatives when uncertain, and its location. ${PAGE_NOTE}`) }],
    jsonSchema: s.object({ clauses: s.array(CLAUSE_SCHEMA) }),
    effort: 'medium',
    maxTokens: 32000,
  });
  return data.clauses ?? [];
}
