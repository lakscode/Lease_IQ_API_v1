// PDF abstract report for one lease (pdf-lib, standard fonts). Covers the org header + logo, current terms
// "as amended", documents/timeline, alerts, opportunities and clauses.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { ABSTRACT_FIELDS } from './abstract.ts';
import type { LeaseAlert, TermValue } from './lease-terms.ts';

export interface ReportInput {
  org: { name: string; currency: string; logoUrl: string | null };
  lease: {
    id: string;
    tenant_name: string | null;
    premises_address: string | null;
    status: string;
    property_type: string | null;
    current_terms: Record<string, TermValue>;
  };
  noticeBy: string | null;
  documents: {
    id: string;
    doc_type: string;
    title: string | null;
    effective_date: string | null;
    page_count: number | null;
    changes_made: string | null;
    summary: string | null;
    signature: { status?: string; method?: string } | null;
    sha256: string | null;
  }[];
  alerts: LeaseAlert[];
  opportunities: { category: string; kind: string; status: string; priority: string | null; summary: string | null; due_date: string | null; amount: number | null }[];
  clauses: { clause_type: string; confidence: number | null; section: string | null; page: number | null; text: string | null; document_title: string | null }[];
  generatedBy: string | null;
}

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

const C = {
  text: rgb(0.06, 0.09, 0.16),
  muted: rgb(0.39, 0.45, 0.55),
  primary: rgb(0.15, 0.39, 0.92),
  border: rgb(0.89, 0.91, 0.94),
  soft: rgb(0.94, 0.96, 1),
  danger: rgb(0.73, 0.11, 0.11),
  warning: rgb(0.71, 0.33, 0.04),
};

// Characters the standard fonts (WinAnsi) can encode.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));
const REPLACE: Record<string, string> = { '≤': '<=', '≥': '>=', '→': '->', '←': '<-', '×': 'x', ' ': ' ', ' ': ' ', ' ': ' ', '−': '-', '‐': '-', '‑': '-', '…': '...' };

/** Make text encodable with the standard PDF fonts. */
export function pdfSafe(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const ch of s.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')) {
    const code = ch.codePointAt(0)!;
    if (ch === '\n' || (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (REPLACE[ch]) out += REPLACE[ch];
    else if (code >= 0x300 && code <= 0x36f) continue; // combining marks
    else out += '?';
  }
  return out;
}

function fmtMoney(value: unknown, currency: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString('en-US')}`;
  }
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '-';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function label(code: string): string {
  return code.replace(/_/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase());
}

interface Writer {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  bold: PDFFont;
  footer: string;
}

function newPage(w: Writer): void {
  w.page = w.doc.addPage([PAGE_W, PAGE_H]);
  w.y = PAGE_H - MARGIN;
}

function ensure(w: Writer, height: number): void {
  if (w.y - height < MARGIN + 20) newPage(w);
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of pdfSafe(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // Break very long words.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

function text(w: Writer, value: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number } = {}): void {
  const size = opts.size ?? 10;
  const font = opts.bold ? w.bold : w.font;
  const x = opts.x ?? MARGIN;
  const width = opts.width ?? CONTENT_W - (x - MARGIN);
  const lh = size * 1.35;
  for (const line of wrap(value, font, size, width)) {
    ensure(w, lh);
    w.page.drawText(line, { x, y: w.y - size, size, font, color: opts.color ?? C.text });
    w.y -= lh;
  }
  w.y -= opts.gap ?? 0;
}

function heading(w: Writer, value: string): void {
  ensure(w, 40);
  w.y -= 10;
  w.page.drawText(pdfSafe(value), { x: MARGIN, y: w.y - 13, size: 13, font: w.bold, color: C.primary });
  w.y -= 19;
  w.page.drawLine({ start: { x: MARGIN, y: w.y }, end: { x: PAGE_W - MARGIN, y: w.y }, thickness: 0.8, color: C.border });
  w.y -= 8;
}

/** Two-column key/value row. */
function kv(w: Writer, key: string, value: string, note?: string): void {
  const keyW = 170;
  const size = 9.5;
  const lh = size * 1.35;
  const valueLines = wrap(value || '-', w.font, size, CONTENT_W - keyW - 8);
  const noteLines = note ? wrap(note, w.font, 7.5, CONTENT_W - keyW - 8) : [];
  const keyLines = wrap(key, w.bold, size, keyW - 8);
  const height = Math.max(keyLines.length, valueLines.length) * lh + noteLines.length * 10 + 4;
  ensure(w, Math.min(height, 200));
  const top = w.y;
  keyLines.forEach((line, i) => w.page.drawText(line, { x: MARGIN, y: top - size - i * lh, size, font: w.bold, color: C.muted }));
  let y = top;
  for (const line of valueLines) {
    if (y - lh < MARGIN + 20) {
      newPage(w);
      y = w.y;
    }
    w.page.drawText(line, { x: MARGIN + keyW, y: y - size, size, font: w.font, color: C.text });
    y -= lh;
  }
  for (const line of noteLines) {
    w.page.drawText(line, { x: MARGIN + keyW, y: y - 8, size: 7.5, font: w.font, color: C.muted });
    y -= 10;
  }
  w.y = Math.min(y, top - keyLines.length * lh) - 4;
}

async function fetchLogo(doc: PDFDocument, url: string | null): Promise<PDFImage | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes);
  } catch {
    // ignore logo errors
  }
  return null;
}

function termDisplay(key: string, value: unknown, currency: string): string {
  const field = ABSTRACT_FIELDS.find((f) => f.key === key);
  if (value === null || value === undefined || value === '') return '-';
  if (field?.kind === 'money') return fmtMoney(value, currency);
  if (field?.kind === 'date') return fmtDate(String(value));
  if (field?.kind === 'number') return Number(value).toLocaleString('en-US');
  return String(value);
}

export async function buildLeaseReport(input: ReportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`Lease abstract - ${input.lease.tenant_name ?? 'Lease'}`));
  doc.setProducer('Lease IQ');
  doc.setCreator('Lease IQ');
  const w: Writer = {
    doc,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: PAGE_H - MARGIN,
    font: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    footer: pdfSafe(`${input.org.name} · Lease abstract · Generated ${new Date().toISOString().slice(0, 10)}`),
  };

  // Header: logo (or brand mark) + org name.
  const logo = await fetchLogo(doc, input.org.logoUrl);
  let headerH = 34;
  if (logo) {
    const scale = Math.min(140 / logo.width, 40 / logo.height, 1);
    const lw = logo.width * scale;
    const lh = logo.height * scale;
    w.page.drawImage(logo, { x: MARGIN, y: w.y - lh, width: lw, height: lh });
    w.page.drawText(pdfSafe(input.org.name), { x: MARGIN + lw + 12, y: w.y - lh / 2 - 5, size: 13, font: w.bold, color: C.text });
    headerH = Math.max(lh, 20);
  } else {
    w.page.drawRectangle({ x: MARGIN, y: w.y - 30, width: 30, height: 30, color: C.primary });
    w.page.drawText('IQ', { x: MARGIN + 7, y: w.y - 20, size: 11, font: w.bold, color: rgb(1, 1, 1) });
    w.page.drawText(pdfSafe(input.org.name), { x: MARGIN + 40, y: w.y - 20, size: 13, font: w.bold, color: C.text });
  }
  w.y -= headerH + 18;

  text(w, 'Lease abstract', { size: 9, color: C.muted });
  text(w, input.lease.tenant_name || 'Unnamed lease', { size: 20, bold: true, gap: 2 });
  if (input.lease.premises_address) text(w, input.lease.premises_address, { size: 11, color: C.muted, gap: 4 });
  text(w, `Status: ${label(input.lease.status)}${input.lease.property_type ? `   ·   Property type: ${input.lease.property_type}` : ''}${input.noticeBy ? `   ·   Renewal notice by: ${fmtDate(input.noticeBy)}` : ''}`, { size: 9.5, color: C.muted, gap: 6 });

  // Current terms as amended.
  heading(w, 'Current terms (as amended)');
  const terms = input.lease.current_terms ?? {};
  const docTitles = new Map(input.documents.map((d) => [d.id, d.title || label(d.doc_type)]));
  let any = false;
  for (const field of ABSTRACT_FIELDS) {
    if (field.key === 'changes_made') continue;
    const t = terms[field.key];
    if (!t) continue;
    any = true;
    const source = docTitles.get(t.source_document_id) ?? t.source_title ?? label(t.source_doc_type);
    kv(w, field.label, termDisplay(field.key, t.value, input.org.currency), `Source: ${source}`);
  }
  if (!any) text(w, 'No terms have been extracted yet.', { color: C.muted });

  // Documents & timeline.
  heading(w, `Documents (${input.documents.length})`);
  if (!input.documents.length) text(w, 'No documents.', { color: C.muted });
  for (const d of input.documents) {
    ensure(w, 40);
    text(w, `${d.title || label(d.doc_type)}`, { bold: true, size: 10.5 });
    const meta = [
      label(d.doc_type),
      d.effective_date ? `Effective ${fmtDate(d.effective_date)}` : null,
      d.page_count ? `${d.page_count} page(s)` : null,
      d.signature?.status ? `Signature: ${label(d.signature.status)}${d.signature.method && d.signature.method !== 'unknown' ? ` (${label(d.signature.method)})` : ''}` : null,
    ].filter(Boolean).join('  ·  ');
    text(w, meta, { size: 8.5, color: C.muted });
    if (d.changes_made) text(w, `Changes: ${d.changes_made}`, { size: 9 });
    else if (d.summary) text(w, d.summary, { size: 9 });
    if (d.sha256) text(w, `SHA-256 ${d.sha256}`, { size: 7, color: C.muted });
    w.y -= 6;
  }

  // Alerts.
  heading(w, `Alerts & tasks (${input.alerts.length})`);
  if (!input.alerts.length) text(w, 'No open alerts.', { color: C.muted });
  for (const a of input.alerts) {
    text(w, `${a.severity === 'urgent' ? 'URGENT' : 'Normal'} · ${a.message}${a.due_date ? ` (${fmtDate(a.due_date)})` : ''}`, {
      size: 9.5, color: a.severity === 'urgent' ? C.danger : C.text, gap: 2,
    });
  }

  // Opportunities.
  const opps = input.opportunities.filter((o) => o.status !== 'none');
  heading(w, `Opportunities (${opps.length})`);
  if (!opps.length) text(w, 'No opportunities recorded. Run the opportunity review in the lease workspace.', { color: C.muted });
  for (const o of opps) {
    const head = [label(o.category), o.kind === 'revenue' ? 'Revenue' : 'Risk', label(o.status), o.priority ? `${label(o.priority)} priority` : null,
      o.due_date ? `Due ${fmtDate(o.due_date)}` : null, o.amount != null ? fmtMoney(o.amount, input.org.currency) : null].filter(Boolean).join('  ·  ');
    text(w, head, { bold: true, size: 9.5 });
    if (o.summary) text(w, o.summary, { size: 9 });
    w.y -= 4;
  }

  // Clauses grouped by type.
  heading(w, `Clauses (${input.clauses.length})`);
  if (!input.clauses.length) text(w, 'No clauses classified.', { color: C.muted });
  const groups = new Map<string, ReportInput['clauses']>();
  for (const cl of input.clauses) groups.set(cl.clause_type, [...(groups.get(cl.clause_type) ?? []), cl]);
  for (const [type, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    ensure(w, 30);
    text(w, `${type} (${list.length})`, { bold: true, size: 10 });
    for (const cl of list) {
      const loc = [cl.document_title, cl.section ? `§ ${cl.section}` : null, cl.page ? `p. ${cl.page}` : null,
        cl.confidence != null ? `${Math.round(Number(cl.confidence) * 100)}%` : null].filter(Boolean).join(' · ');
      text(w, loc, { size: 7.5, color: C.muted, x: MARGIN + 10 });
      if (cl.text) text(w, cl.text.length > 500 ? `${cl.text.slice(0, 500)}...` : cl.text, { size: 8.5, x: MARGIN + 10, gap: 3 });
    }
    w.y -= 3;
  }

  // Footer with page numbers.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN }, end: { x: PAGE_W - MARGIN, y: MARGIN }, thickness: 0.5, color: C.border });
    p.drawText(w.footer, { x: MARGIN, y: MARGIN - 14, size: 7.5, font: w.font, color: C.muted });
    const num = `Page ${i + 1} of ${pages.length}`;
    p.drawText(num, { x: PAGE_W - MARGIN - w.font.widthOfTextAtSize(num, 7.5), y: MARGIN - 14, size: 7.5, font: w.font, color: C.muted });
  });
  if (input.generatedBy) doc.setAuthor(pdfSafe(input.generatedBy));
  return doc.save();
}
