// Minimal .xlsx reader for the SVM trainer: every worksheet → rows of cell strings (column A = index 0).
// Handles shared/inline/formula strings and numbers; ignores styles, dates and formulas. No dependencies.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/** Unzip the entries of a zip archive (stored or deflated). */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, dec, hex, name) =>
      dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16))
        : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()])
    .replace(/_x([0-9A-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Concatenated <t> runs of a shared/inline string, skipping phonetic hints. */
const runText = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

const colIndex = (ref: string) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** All worksheets of a workbook, in sheet-file order. Each row is a sparse array of cell strings. */
export function readXlsx(path: string): { sheet: string; rows: (string | undefined)[][] }[] {
  const zip = unzip(readFileSync(path));
  const shared = [...(zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]));
  const sheets = [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return sheets.map((name) => {
    const xml = zip.get(name)!.toString('utf8');
    const rows: (string | undefined)[][] = [];
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: (string | undefined)[] = [];
      let next = 0;
      for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? '';
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const col = ref ? colIndex(ref) : next;
        next = col + 1;
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: string | undefined;
        if (type === 's') value = v === undefined ? undefined : shared[Number(v)];
        else if (type === 'inlineStr') value = runText(body);
        else if (v !== undefined) value = decode(v);
        if (value !== undefined) cells[col] = value;
      }
      rows.push(cells);
    }
    return { sheet: name, rows };
  });
}
