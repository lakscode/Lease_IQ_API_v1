// Rent roll CSV parsing: delimiter + header-row detection, column mapping by header synonyms,
// and robust money/date parsing (Yardi Voyager, MRI and generic exports).

export const RENT_ROLL_FIELDS = [
  'tenant', 'external_id', 'property', 'unit', 'status', 'start_date', 'end_date', 'area',
  'monthly_base_rent', 'annual_base_rent', 'cam', 'tax', 'insurance', 'other_charges', 'security_deposit',
  'next_escalation_date', 'next_escalation_rent',
] as const;
export type RentRollField = (typeof RENT_ROLL_FIELDS)[number];

const DATE_FIELDS: RentRollField[] = ['start_date', 'end_date', 'next_escalation_date'];
const MONEY_FIELDS: RentRollField[] = [
  'monthly_base_rent', 'annual_base_rent', 'cam', 'tax', 'insurance', 'other_charges', 'security_deposit', 'next_escalation_rent',
];
const NUMBER_FIELDS: RentRollField[] = ['area', ...MONEY_FIELDS];

/** Header synonyms (normalised: lower-case, alphanumerics separated by single spaces). */
const SYNONYMS: Record<RentRollField, string[]> = {
  tenant: ['tenant', 'tenant name', 'name', 'lessee', 'occupant', 'occupant name', 'occpname', 'occp name', 'resident', 'dba', 'tenant dba', 'trade name', 'company', 'customer', 'lessee name', 'tenant legal name'],
  external_id: ['lease id', 'leaseid', 'lease', 'tenant id', 'tenant code', 'lease code', 'external id', 'id', 'occupant id', 'occpid', 'lease number', 'lease no', 'account', 'account number', 'tenant number', 'code', 'resident id'],
  property: ['property', 'property name', 'property code', 'prop', 'prop code', 'building', 'bldg', 'bldgid', 'bldg id', 'building id', 'building name', 'site', 'center', 'property id', 'entity'],
  unit: ['unit', 'unit id', 'unit number', 'unit no', 'suite', 'suiteid', 'suite id', 'suite number', 'space', 'space id', 'premises', 'unit s', 'units'],
  status: ['status', 'lease status', 'occupancy status', 'unit status', 'occupancy', 'tenant status'],
  start_date: ['start', 'start date', 'lease start', 'lease start date', 'lease from', 'from', 'commencement', 'commencement date', 'begin date', 'lease begin', 'begin', 'move in', 'move in date', 'occupancy date', 'rent start'],
  end_date: ['end', 'end date', 'lease end', 'lease end date', 'lease to', 'to', 'expiration', 'expiration date', 'expiry', 'expiry date', 'lease expiration', 'exp date', 'expires', 'move out', 'move out date', 'termination date'],
  area: ['area', 'sq ft', 'sqft', 'square feet', 'square footage', 'rsf', 'gla', 'rentable area', 'rentable sf', 'unit sqft', 'unit sq ft', 'size', 'nla', 'leased area', 'sf', 'leased sf', 'area sf'],
  monthly_base_rent: ['monthly rent', 'monthly base rent', 'base rent', 'rent', 'current rent', 'base rent monthly', 'rent monthly', 'monthly base', 'lease rent', 'contract rent', 'rnt', 'brr', 'base rent mo', 'minimum rent', 'monthly minimum rent', 'actual rent', 'charge rent'],
  annual_base_rent: ['annual rent', 'annual base rent', 'base rent annual', 'yearly rent', 'rent annual', 'annual', 'annual minimum rent', 'annualized rent', 'rent per year', 'annual base'],
  cam: ['cam', 'common area maintenance', 'cam charges', 'cam monthly', 'opex', 'operating expenses', 'cam recovery', 'cam est'],
  tax: ['tax', 'taxes', 'real estate tax', 'real estate taxes', 're tax', 'ret', 'property tax', 'tax recovery'],
  insurance: ['insurance', 'ins', 'insurance charge', 'insurance recovery'],
  other_charges: ['other', 'other charges', 'misc', 'miscellaneous', 'additional rent', 'other rent', 'other income'],
  security_deposit: ['deposit', 'security deposit', 'sec dep', 'secdep', 'security', 'deposit held', 'deposits', 'deposit amount', 'sd'],
  next_escalation_date: ['next escalation date', 'next increase date', 'next rent increase', 'next rent increase date', 'escalation date', 'next step date', 'next bump date', 'increase date', 'next escalation', 'next rent change date'],
  next_escalation_rent: ['next escalation rent', 'next rent', 'next increase amount', 'new rent', 'escalation rent', 'next step rent', 'next monthly rent', 'next rent amount', 'next escalation amount', 'rent after increase'],
};

export function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---- CSV ------------------------------------------------------------------------------------

export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 40);
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    // Score = number of lines whose (quote-aware) field count is ≥ 2, weighted by the most common count.
    const counts = new Map<number, number>();
    for (const line of sample) {
      if (!line.trim()) continue;
      const n = parseCsv(line, d)[0]?.length ?? 0;
      if (n >= 2) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    let score = 0;
    for (const [fields, lines] of counts) score = Math.max(score, lines * Math.log2(fields + 1));
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** RFC 4180-ish parser: quoted fields, doubled quotes, embedded delimiters and newlines. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

// ---- Values ---------------------------------------------------------------------------------

/** "$1,234.56", "(1,234.56)", "1.234,56 €", "-500", "1 234,5" → number. */
export function parseMoney(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || /^[-–—]+$/.test(s) || /^n\/?a$/i.test(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/-\s*$/.test(s)) {
    negative = true; // trailing minus (some accounting exports)
    s = s.replace(/-\s*$/, '');
  }
  s = s.replace(/[^0-9.,\-]/g, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Whichever comes last is the decimal separator.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // "1,234" / "1,234,567" are thousands; "1234,5" / "12,50" are decimals.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, ''); // "1.234.567"
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * ISO (2026-01-31), US (1/31/2026, 01-31-26), European with dots (31.01.2026), month names (Jan 31, 2026;
 * 31-Jan-2026), and Excel serial numbers. Slashed dates are read as US (M/D) unless the first part is > 12.
 */
export function parseDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(s);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    return a > 12 ? ymd(+m[3], b, a) : ymd(+m[3], a, b);
  }
  m = /^(\d{1,2})[\s-]([a-z]{3,9})\.?[\s,-]+(\d{2,4})$/i.exec(s); // "31-Jan-2026", "31 January 2026"
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return ymd(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  m = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/i.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return ymd(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  m = /^([a-z]{3,9})[\s-](\d{4})$/i.exec(s); // "Jan 2027"
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return ymd(+m[2], MONTHS[m[1].slice(0, 3).toLowerCase()], 1);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial > 20000 && serial < 80000) return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

// ---- Header detection & mapping ------------------------------------------------------------

function fieldScore(header: string, field: RentRollField): number {
  const h = normHeader(header);
  if (!h) return 0;
  const syns = SYNONYMS[field];
  if (syns.includes(h)) return 3;
  if (h.includes('market')) return 0; // "Market Rent" is not the contract rent
  // Multi-word synonym contained in the header ("Lease Start Date (MM/DD)") or vice versa.
  let best = 0;
  for (const syn of syns) {
    if (syn.length < 3) continue;
    const re = new RegExp(`(^| )${syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
    if (re.test(h)) best = Math.max(best, syn.includes(' ') ? 2 : 1);
  }
  return best;
}

function rowHeaderScore(cells: string[]): number {
  let score = 0;
  for (const cell of cells) {
    if (!cell || /\d{3,}/.test(cell)) continue;
    if (RENT_ROLL_FIELDS.some((f) => fieldScore(cell, f) >= 2)) score++;
  }
  return score;
}

/** The header is the row (within the first 40) that looks most like column titles. */
export function detectHeaderRow(rows: string[][]): number {
  let best = 0;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const score = rowHeaderScore(rows[i]);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export type ColumnMapping = Partial<Record<RentRollField, string>>;

/** Map headers to fields: exact synonyms first, then partial matches; each header is used once. */
export function autoMap(headers: string[]): ColumnMapping {
  const candidates: { field: RentRollField; header: string; score: number; index: number }[] = [];
  headers.forEach((header, index) => {
    for (const field of RENT_ROLL_FIELDS) {
      const score = fieldScore(header, field);
      if (score > 0) candidates.push({ field, header, score, index });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const mapping: ColumnMapping = {};
  const usedHeaders = new Set<string>();
  for (const c of candidates) {
    if (mapping[c.field] || usedHeaders.has(c.header)) continue;
    mapping[c.field] = c.header;
    usedHeaders.add(c.header);
  }
  return mapping;
}

export interface ParsedRecord {
  tenant: string | null;
  external_id: string | null;
  property: string | null;
  unit: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  area: number | null;
  monthly_base_rent: number | null;
  annual_base_rent: number | null;
  cam: number | null;
  tax: number | null;
  insurance: number | null;
  other_charges: number | null;
  security_deposit: number | null;
  next_escalation_date: string | null;
  next_escalation_rent: number | null;
  charge_codes: Record<string, number> | null;
  raw: Record<string, string>;
}

export interface ParseResult {
  delimiter: string;
  header_row: number;
  headers: string[];
  mapping: ColumnMapping;
  /** Unmapped columns kept as per-charge codes. */
  charge_columns: string[];
  records: ParsedRecord[];
  skipped_rows: number;
}

const TOTAL_RE = /^(grand\s+)?totals?\b|^subtotal|^summary\b|^property\s+total|^occupied|^vacant\s+units?\s+total/i;

export function parseRentRoll(text: string, override?: ColumnMapping | null): ParseResult {
  const clean = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(clean);
  const rows = parseCsv(clean, delimiter);
  const header_row = detectHeaderRow(rows);
  // Blank header cells get a positional name; duplicates get a suffix so raw keys stay unique.
  const seen = new Map<string, number>();
  const headers = (rows[header_row] ?? []).map((h, i) => {
    const base = h || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const auto = autoMap(headers);
  const mapping: ColumnMapping = {};
  for (const field of RENT_ROLL_FIELDS) {
    const chosen = override && field in override ? override[field] : auto[field];
    if (chosen && headers.includes(chosen)) mapping[field] = chosen;
  }
  const mappedHeaders = new Set(Object.values(mapping));
  const idx = (h: string) => headers.indexOf(h);

  const body = rows.slice(header_row + 1);
  // Charge columns: unmapped columns whose non-empty values are mostly numbers.
  const charge_columns = headers.filter((h) => {
    if (mappedHeaders.has(h) || /^Column \d+$/.test(h) || /market/i.test(h)) return false;
    const values = body.map((r) => r[idx(h)] ?? '').filter((v) => v !== '');
    if (!values.length) return false;
    const numeric = values.filter((v) => parseMoney(v) !== null && parseDate(v) === null && /^[\s$€£(\-–]*[\d.,\s]+[)\s€£-]*$/.test(v)).length;
    return numeric / values.length >= 0.8;
  });

  const records: ParsedRecord[] = [];
  let skipped = 0;
  for (const r of body) {
    if (r.every((c) => c === '')) {
      skipped++;
      continue;
    }
    const get = (field: RentRollField) => {
      const h = mapping[field];
      return h ? (r[idx(h)] ?? '') : '';
    };
    const tenant = get('tenant') || null;
    const firstCell = r.find((c) => c !== '') ?? '';
    if ((tenant && TOTAL_RE.test(tenant)) || TOTAL_RE.test(firstCell)) {
      skipped++;
      continue;
    }
    const rec: Record<string, unknown> = {};
    for (const field of RENT_ROLL_FIELDS) {
      const v = get(field);
      if (DATE_FIELDS.includes(field)) rec[field] = parseDate(v);
      else if (NUMBER_FIELDS.includes(field)) rec[field] = parseMoney(v);
      else rec[field] = v || null;
    }
    // A row with no tenant, unit or rent is a section header / junk line.
    if (!rec.tenant && !rec.unit && !rec.external_id && rec.monthly_base_rent === null && rec.annual_base_rent === null) {
      skipped++;
      continue;
    }
    if (rec.monthly_base_rent === null && typeof rec.annual_base_rent === 'number') rec.monthly_base_rent = Math.round((rec.annual_base_rent / 12) * 100) / 100;
    if (rec.annual_base_rent === null && typeof rec.monthly_base_rent === 'number') rec.annual_base_rent = Math.round(rec.monthly_base_rent * 12 * 100) / 100;
    const charges: Record<string, number> = {};
    for (const h of charge_columns) {
      const v = parseMoney(r[idx(h)]);
      if (v !== null) charges[h] = v;
    }
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (r[i] !== undefined && r[i] !== '') raw[h] = r[i];
    });
    records.push({ ...(rec as unknown as ParsedRecord), charge_codes: Object.keys(charges).length ? charges : null, raw });
  }
  return { delimiter, header_row, headers, mapping, charge_columns, records, skipped_rows: skipped };
}
