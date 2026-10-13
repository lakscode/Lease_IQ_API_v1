// Supporting documents: allowed types, text extraction (OOXML zip, e-mail, Outlook .msg) and the AI review.
// Zip entries are inflated with the Web DecompressionStream('deflate-raw') (Node ≥ 21 and Deno), so no zip dependency.
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { callClaudeJson, languageInstruction, pdfBlock, s, toBase64 } from './ai.ts';
import { ATTACHMENT_CATEGORIES } from './abstract.ts';
import { db, must } from './supabase.ts';
import { downloadBytes } from './storage.ts';
import type { Locale } from './types.ts';

export type AttachmentKind = 'pdf' | 'image' | 'docx' | 'xlsx' | 'text' | 'email' | 'msg' | 'legacy_office';

const EXTENSIONS: Record<string, { kind: AttachmentKind; mime: string }> = {
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  docx: { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  doc: { kind: 'legacy_office', mime: 'application/msword' },
  xlsx: { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  xls: { kind: 'legacy_office', mime: 'application/vnd.ms-excel' },
  csv: { kind: 'text', mime: 'text/csv' },
  txt: { kind: 'text', mime: 'text/plain' },
  md: { kind: 'text', mime: 'text/markdown' },
  eml: { kind: 'email', mime: 'message/rfc822' },
  msg: { kind: 'msg', mime: 'application/vnd.ms-outlook' },
};

export const ALLOWED_EXTENSIONS = Object.keys(EXTENSIONS);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function attachmentType(name: string): { kind: AttachmentKind; mime: string } | null {
  return EXTENSIONS[extensionOf(name)] ?? null;
}

// ---- Zip (OOXML) -------------------------------------------------------------------------------

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read the named entries (exact names or a predicate) from a zip file via its central directory. */
export async function unzipEntries(bytes: Uint8Array, want: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + compSize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflateRaw(data));
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export async function docxText(bytes: Uint8Array): Promise<string> {
  const files = await unzipEntries(bytes, (n) => n === 'word/document.xml' || /^word\/(header|footer|footnotes)\d*\.xml$/.test(n));
  const xml = new TextDecoder().decode(files.get('word/document.xml') ?? new Uint8Array());
  const toText = (x: string) => decodeXmlEntities(
    x.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<[^>]+>/g, ''),
  );
  let text = toText(xml);
  for (const [name, data] of files) {
    if (name !== 'word/document.xml') text += `\n\n[${name}]\n${toText(new TextDecoder().decode(data))}`;
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export async function xlsxText(bytes: Uint8Array): Promise<string> {
  const files = await unzipEntries(bytes, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const dec = new TextDecoder();
  const shared: string[] = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) {
    for (const si of dec.decode(ss).match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(decodeXmlEntities((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const sheetNames = [...dec.decode(files.get('xl/workbook.xml') ?? new Uint8Array()).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXmlEntities(m[1]));
  const sheets = [...files.keys()].filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  const parts: string[] = [];
  for (const [i, name] of sheets.entries()) {
    const xml = dec.decode(files.get(name) as Uint8Array);
    const rows: string[] = [];
    for (const row of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const cell of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const type = /\bt="([^"]+)"/.exec(cell)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
        const inline = /<is>([\s\S]*?)<\/is>/.exec(cell)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (inline) value = decodeXmlEntities(inline.replace(/<[^>]+>/g, ''));
        else if (v !== undefined) value = decodeXmlEntities(v);
        cells.push(value);
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
    }
    parts.push(`[Sheet: ${sheetNames[i] ?? name}]\n${rows.join('\n')}`);
  }
  return parts.join('\n\n').trim();
}

/** Best-effort printable text from a binary file (Outlook .msg, legacy .doc/.xls): UTF-16LE and ASCII runs. */
export function printableText(bytes: Uint8Array, minRun = 5): string {
  const runs: string[] = [];
  // UTF-16LE runs (MSG property streams are mostly Unicode)
  let cur = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    // Latin scripts only (the app's five languages); other ranges are usually mis-aligned binary data.
    if ((code >= 0x20 && code < 0x0250) || (code >= 0x2010 && code <= 0x20cf) || code === 0x0a || code === 0x0d || code === 0x09) cur += String.fromCharCode(code);
    else {
      if (cur.trim().length >= minRun && /[a-zA-Z]{3}/.test(cur)) runs.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim().length >= minRun) runs.push(cur.trim());
  // ASCII runs
  cur = '';
  for (const b of bytes) {
    if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09) cur += String.fromCharCode(b);
    else {
      if (cur.trim().length >= minRun * 2 && /[a-zA-Z]{3}/.test(cur)) runs.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim().length >= minRun * 2) runs.push(cur.trim());
  const seen = new Set<string>();
  return runs.filter((r) => !seen.has(r) && seen.add(r)).join('\n');
}

/** Turn an attachment into Claude content blocks. */
export async function attachmentContent(name: string, bytes: Uint8Array): Promise<BetaContentBlockParam[]> {
  const type = attachmentType(name);
  if (!type) throw new Error('Unsupported file type');
  const textBlock = (text: string): BetaContentBlockParam[] => {
    const t = text.trim();
    if (!t) throw new Error('No readable text found in this file');
    return [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: t.slice(0, 300_000) }, title: name }];
  };
  switch (type.kind) {
    case 'pdf':
      return [pdfBlock(bytes, { title: name })];
    case 'image':
      return [{ type: 'image', source: { type: 'base64', media_type: type.mime as 'image/png', data: toBase64(bytes) } }];
    case 'docx':
      return textBlock(await docxText(bytes));
    case 'xlsx':
      return textBlock(await xlsxText(bytes));
    case 'text':
    case 'email':
      return textBlock(new TextDecoder().decode(bytes));
    case 'msg':
    case 'legacy_office':
      return textBlock(printableText(bytes));
  }
}

// ---- AI review ----------------------------------------------------------------------------------

export interface AttachmentReview {
  summary: string;
  key_date: string | null;
  amount: number | null;
  fields: Record<string, string>;
  action_items: { text: string; due_date: string | null }[];
  issues: { text: string; severity: 'high' | 'medium' | 'low' }[];
  suggested_category: string;
  reviewed_at: string;
}

const REVIEW_SCHEMA = s.object({
  summary: s.string('2–4 sentence summary of the document and why it matters for the lease'),
  key_date: s.nullable(s.string('Most important date (YYYY-MM-DD), e.g. expiry, notice or invoice date')),
  amount: s.nullable(s.number('Most important amount (e.g. invoice total, coverage limit)')),
  fields: s.array(s.object({ name: s.string(), value: s.string() }), 'Key facts extracted (parties, policy number, coverage, period, references…)'),
  action_items: s.array(s.object({ text: s.string(), due_date: s.nullable(s.string('YYYY-MM-DD')) })),
  issues: s.array(s.object({ text: s.string(), severity: s.enum(['high', 'medium', 'low']) }), 'Problems or inconsistencies with the lease (e.g. coverage below the lease requirement, expired certificate)'),
  suggested_category: s.enum(ATTACHMENT_CATEGORIES),
});

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Review one attachment and store ai_review / status. Never throws (status 'failed' with the error instead). */
export async function reviewAttachment(input: { orgId: string; userId: string; attachmentId: string; locale: Locale }): Promise<void> {
  const { orgId, attachmentId } = input;
  try {
    const att = must(await db().from('attachments').select('*').eq('id', attachmentId).eq('org_id', orgId).single())!;
    await db().from('attachments').update({ status: 'processing', error: null }).eq('id', attachmentId);
    const lease = must(await db().from('leases')
      .select('tenant_name, landlord_name, premises_address, commencement_date, expiration_date, current_terms')
      .eq('id', att.lease_id).single())!;
    const bytes = await downloadBytes(att.storage_path);
    const content = await attachmentContent(att.file_name, bytes);
    const terms = Object.entries((lease.current_terms ?? {}) as Record<string, { value: unknown }>)
      .map(([k, v]) => `- ${k}: ${String(v.value)}`).join('\n');
    const system = [
      'You review supporting documents attached to a commercial lease (insurance certificates, estoppels, SNDAs, financial statements, correspondence, notices, invoices, exhibits).',
      'Summarize the document, extract the key date, amount and facts, list action items with due dates, and flag issues against the lease terms.',
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
      languageInstruction(input.locale),
    ].join('\n');
    const text = [
      `Attachment: ${att.file_name}${att.doc_date ? ` (dated ${att.doc_date})` : ''}${att.category ? `, filed as ${att.category}` : ''}.`,
      att.notes ? `User notes: ${att.notes}` : '',
      `Lease: ${lease.tenant_name ?? 'unknown tenant'} / ${lease.landlord_name ?? 'unknown landlord'}, ${lease.premises_address ?? ''}.`,
      `Lease terms:\n${terms || '- none extracted'}`,
    ].filter(Boolean).join('\n\n');

    const { data } = await callClaudeJson<Omit<AttachmentReview, 'fields' | 'reviewed_at'> & { fields: { name: string; value: string }[] }>(
      { process: 'attachment', orgId, userId: input.userId, leaseId: att.lease_id },
      { system, messages: [{ role: 'user', content: [...content, { type: 'text', text }] }], jsonSchema: REVIEW_SCHEMA, maxTokens: 16000, effort: 'medium' },
    );
    const review: AttachmentReview = {
      summary: data.summary,
      key_date: isDate(data.key_date) ? data.key_date : null,
      amount: Number.isFinite(Number(data.amount)) && data.amount !== null ? Number(data.amount) : null,
      fields: Object.fromEntries((data.fields ?? []).filter((f) => f.name).map((f) => [f.name, f.value])),
      action_items: (data.action_items ?? []).map((a) => ({ text: a.text, due_date: isDate(a.due_date) ? a.due_date : null })),
      issues: data.issues ?? [],
      suggested_category: (ATTACHMENT_CATEGORIES as readonly string[]).includes(data.suggested_category) ? data.suggested_category : 'other',
      reviewed_at: new Date().toISOString(),
    };
    await db().from('attachments').update({ status: 'completed', error: null, ai_review: review }).eq('id', attachmentId);
  } catch (err) {
    const message = (err as Error).message || 'Review failed';
    await db().from('attachments').update({ status: 'failed', error: message.slice(0, 500) }).eq('id', attachmentId).eq('org_id', orgId);
  }
}
