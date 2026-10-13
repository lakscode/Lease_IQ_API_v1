// PDF helpers for the lease pipeline (pdf-lib for structure, unpdf for text). Web APIs only.
import { PDFDocument } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';

/** Claude PDF limits (per request) with a margin. */
export const PDF_MAX_PAGES_FOR_AI = 100;
export const PDF_MAX_BYTES_FOR_AI = 30 * 1024 * 1024;
/** Pages per OCR call. */
export const OCR_CHUNK_PAGES = 20;
/** A page with fewer extractable characters than this counts as "image only". */
const MIN_PAGE_CHARS = 40;

export function isPdf(bytes: Uint8Array): boolean {
  // %PDF- may be preceded by a little junk; look in the first 1 KB.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await loadPdf(bytes)).getPageCount();
}

/** Text per page (index 0 = page 1). Returns empty strings when the PDF has no text layer. */
export async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
  // pdf.js may transfer (detach) the buffer it's given, so hand it a copy.
  const proxy = await getDocumentProxy(bytes.slice());
  try {
    const { text } = await extractText(proxy, { mergePages: false });
    return text.map((t) => normalizeText(t));
  } finally {
    await proxy.destroy().catch(() => undefined);
  }
}

export function normalizeText(text: string): string {
  return text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Scanned when most pages have (almost) no extractable text. */
export function looksScanned(pageTexts: string[]): boolean {
  if (pageTexts.length === 0) return true;
  const empty = pageTexts.filter((t) => t.replace(/\s+/g, '').length < MIN_PAGE_CHARS).length;
  return empty / pageTexts.length > 0.5;
}

/** Pages that need OCR (1-based). */
export function pagesNeedingOcr(pageTexts: string[]): number[] {
  const out: number[] = [];
  pageTexts.forEach((t, i) => {
    if (t.replace(/\s+/g, '').length < MIN_PAGE_CHARS) out.push(i + 1);
  });
  return out;
}

/** Group sorted page numbers into ranges of at most `size` consecutive-in-list pages. */
export function chunkPages(pages: number[], size = OCR_CHUNK_PAGES): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < pages.length) {
    const start = pages[i];
    let end = start;
    let n = 1;
    while (i + 1 < pages.length && pages[i + 1] === end + 1 && n < size) {
      i += 1;
      end = pages[i];
      n += 1;
    }
    ranges.push({ start, end });
    i += 1;
  }
  return ranges;
}

/** New PDF with pages [start..end] (1-based, inclusive) of the source. */
export async function subPdf(source: PDFDocument | Uint8Array, start: number, end: number): Promise<Uint8Array> {
  const src = source instanceof Uint8Array ? await loadPdf(source) : source;
  const total = src.getPageCount();
  const from = Math.max(1, Math.min(start, total));
  const to = Math.max(from, Math.min(end, total));
  const out = await PDFDocument.create();
  const indices = Array.from({ length: to - from + 1 }, (_, k) => from - 1 + k);
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

/** Whether a PDF of this size can be sent to Claude as a document block. */
export function fitsAiPdfLimits(pages: number, bytes: number): boolean {
  return pages <= PDF_MAX_PAGES_FOR_AI && bytes <= PDF_MAX_BYTES_FOR_AI;
}

/** Page texts joined with explicit page markers, for text-only AI prompts. */
export function withPageMarkers(pageTexts: { page: number; text: string }[], maxChars = 600_000): string {
  let out = '';
  for (const p of pageTexts) {
    const chunk = `\n\n=== PAGE ${p.page} ===\n${p.text || '[no text]'}`;
    if (out.length + chunk.length > maxChars) {
      out += `\n\n[... truncated after page ${p.page - 1} ...]`;
      break;
    }
    out += chunk;
  }
  return out.trim();
}
