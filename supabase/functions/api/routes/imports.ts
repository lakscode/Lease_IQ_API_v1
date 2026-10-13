// /api/imports — rent roll import (Yardi Voyager, MRI or any CSV) and lease matching.
//   GET    /                              list imports (viewer+)
//   POST   /preview  {csv, mapping?}      parse + auto-map + sample rows with proposed matches (editor)
//   POST   /         {source, file_name, csv, mapping?}   import + auto-match (editor)
//   GET    /:id                           import with its records and match status (viewer+)
//   DELETE /:id                           delete an import and its records (editor)
//   PATCH  /records/:id {lease_id|null}   manual (re-)match (editor)
//   GET    /records/by-lease/:leaseId     newest matched record + field comparison (viewer+; see CONTRACT.md)
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { getOrgRow, requireRole, withOrg } from '../lib/auth.ts';
import { db } from '../lib/supabase.ts';
import { ApiError, badRequest, notFound, readJson } from '../lib/http.ts';
import { RENT_ROLL_FIELDS, parseRentRoll, type ColumnMapping } from '../lib/analytics-csv.ts';
import { bestMatch, compareRecord, type RentRollRecordRow } from '../lib/analytics-match.ts';
import { loadLease, loadLeases, today } from '../lib/analytics-core.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Malformed ids are a 404, not a database error.
for (const path of ['/:id', '/records/:id', '/records/by-lease/:leaseId']) {
  router.use(path, async (c, next) => {
    const id = c.req.param('leaseId') ?? c.req.param('id');
    if (id && !UUID_RE.test(id) && id !== 'preview') throw notFound();
    await next();
  });
}

const SOURCES = ['yardi', 'mri', 'csv'] as const;
const MAX_CSV_CHARS = 8_000_000;
const MAX_ROWS = 20_000;

function readMapping(value: unknown): ColumnMapping | null {
  if (!value || typeof value !== 'object') return null;
  const out: ColumnMapping = {};
  for (const field of RENT_ROLL_FIELDS) {
    const v = (value as Record<string, unknown>)[field];
    if (typeof v === 'string') out[field] = v;
    else if (v === null || v === '') out[field] = undefined; // explicitly unmapped
  }
  return out;
}

function readCsv(body: { csv?: unknown }): string {
  if (typeof body.csv !== 'string' || !body.csv.trim()) throw badRequest('CSV content is required.');
  if (body.csv.length > MAX_CSV_CHARS) throw new ApiError('payload_too_large', 'The CSV file is too large (8 MB maximum).');
  return body.csv;
}

router.get('/', async (c) => {
  const { data, error } = await db()
    .from('rent_roll_imports')
    .select('id, source, file_name, mapping, row_count, matched_count, created_by, created_at')
    .eq('org_id', c.get('orgId'))
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return c.json(data ?? []);
});

router.post('/preview', requireRole('editor'), async (c) => {
  const body = await readJson<{ csv?: unknown; mapping?: unknown }>(c);
  const parsed = parseRentRoll(readCsv(body), readMapping(body.mapping));
  const leases = await loadLeases(c.get('orgId'));
  const names = new Map(leases.map((l) => [l.id, l.tenant_name]));
  const sample = parsed.records.slice(0, 50).map((r) => {
    const m = bestMatch(r, leases);
    return { ...r, raw: undefined, match_lease_id: m.lease_id, match_tenant: m.lease_id ? names.get(m.lease_id) ?? null : null, match_confidence: m.confidence };
  });
  return c.json({
    delimiter: parsed.delimiter,
    header_row: parsed.header_row,
    headers: parsed.headers,
    mapping: parsed.mapping,
    charge_columns: parsed.charge_columns,
    row_count: parsed.records.length,
    skipped_rows: parsed.skipped_rows,
    sample,
    matched_in_sample: sample.filter((s) => s.match_lease_id).length,
  });
});

router.post('/', requireRole('editor'), async (c) => {
  const body = await readJson<{ source?: unknown; file_name?: unknown; csv?: unknown; mapping?: unknown }>(c);
  const source = SOURCES.includes(body.source as (typeof SOURCES)[number]) ? (body.source as string) : 'csv';
  const fileName = typeof body.file_name === 'string' ? body.file_name.slice(0, 255) : null;
  const parsed = parseRentRoll(readCsv(body), readMapping(body.mapping));
  if (!parsed.mapping.tenant) throw badRequest('Choose the tenant column before importing.');
  if (!parsed.records.length) throw badRequest('No data rows were found in the file.');
  if (parsed.records.length > MAX_ROWS) throw badRequest(`Too many rows (${parsed.records.length}); the maximum is ${MAX_ROWS}.`);

  const orgId = c.get('orgId');
  const leases = await loadLeases(orgId);
  const { data: imp, error } = await db()
    .from('rent_roll_imports')
    .insert({
      org_id: orgId,
      source,
      file_name: fileName,
      mapping: { columns: parsed.mapping, header_row: parsed.header_row, delimiter: parsed.delimiter, charge_columns: parsed.charge_columns, skipped_rows: parsed.skipped_rows },
      row_count: parsed.records.length,
      matched_count: 0,
      created_by: c.get('user').id,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  let matched = 0;
  const rows = parsed.records.map((r) => {
    const m = bestMatch(r, leases);
    if (m.lease_id) matched++;
    return { ...r, import_id: imp.id, org_id: orgId, lease_id: m.lease_id, match_confidence: m.confidence };
  });
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const { error: insErr } = await db().from('rent_roll_records').insert(rows.slice(i, i + 500));
      if (insErr) throw new Error(insErr.message);
    }
  } catch (err) {
    await db().from('rent_roll_imports').delete().eq('id', imp.id);
    throw err;
  }
  const { data: updated } = await db().from('rent_roll_imports').update({ matched_count: matched }).eq('id', imp.id).select('*').single();
  return c.json({ import: updated ?? { ...imp, matched_count: matched }, row_count: rows.length, matched_count: matched }, 201);
});

router.get('/records/by-lease/:leaseId', async (c) => {
  const orgId = c.get('orgId');
  const lease = await loadLease(orgId, c.req.param('leaseId'));
  if (!lease) throw notFound('Lease');
  const { data, error } = await db()
    .from('rent_roll_records')
    .select('*, rent_roll_imports!inner(id, source, file_name, created_at)')
    .eq('org_id', orgId)
    .eq('lease_id', lease.id);
  if (error) throw new Error(error.message);
  type Row = RentRollRecordRow & { rent_roll_imports: { id: string; source: string; file_name: string | null; created_at: string } };
  const rows = ((data ?? []) as Row[]).sort((a, b) =>
    a.rent_roll_imports.created_at < b.rent_roll_imports.created_at ? 1 : a.rent_roll_imports.created_at > b.rent_roll_imports.created_at ? -1 : 0,
  );
  const newest = rows[0];
  if (!newest) return c.json({ record: null, import: null, comparison: [] });
  const { rent_roll_imports: imp, ...record } = newest;
  return c.json({ record, import: imp, comparison: compareRecord(record, lease, today()) });
});

router.patch('/records/:id', requireRole('editor'), async (c) => {
  const orgId = c.get('orgId');
  const record = await getOrgRow<{ id: string; import_id: string }>(c, 'rent_roll_records', c.req.param('id'), 'id, import_id');
  const body = await readJson<{ lease_id?: unknown }>(c);
  let leaseId: string | null = null;
  if (body.lease_id !== null && body.lease_id !== undefined && body.lease_id !== '') {
    if (typeof body.lease_id !== 'string' || !UUID_RE.test(body.lease_id)) throw badRequest('lease_id must be a lease id or null.');
    await getOrgRow(c, 'leases', body.lease_id, 'id');
    leaseId = body.lease_id;
  }
  const { data, error } = await db()
    .from('rent_roll_records')
    .update({ lease_id: leaseId, match_confidence: leaseId ? 1 : null })
    .eq('id', record.id)
    .eq('org_id', orgId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  const { count } = await db()
    .from('rent_roll_records')
    .select('id', { count: 'exact', head: true })
    .eq('import_id', record.import_id)
    .not('lease_id', 'is', null);
  await db().from('rent_roll_imports').update({ matched_count: count ?? 0 }).eq('id', record.import_id).eq('org_id', orgId);
  return c.json({ record: data, matched_count: count ?? 0 });
});

router.get('/:id', async (c) => {
  const orgId = c.get('orgId');
  const imp = await getOrgRow(c, 'rent_roll_imports', c.req.param('id'));
  const { data, error } = await db()
    .from('rent_roll_records')
    .select('*')
    .eq('import_id', c.req.param('id'))
    .eq('org_id', orgId)
    .order('tenant', { ascending: true });
  if (error) throw new Error(error.message);
  const { data: leases } = await db().from('leases').select('id, tenant_name, premises_address').eq('org_id', orgId);
  const byId = new Map((leases ?? []).map((l) => [l.id as string, l]));
  const records = (data ?? []).map((r) => {
    const l = r.lease_id ? byId.get(r.lease_id as string) : null;
    return { ...r, lease_tenant_name: l?.tenant_name ?? null, lease_premises: l?.premises_address ?? null };
  });
  return c.json({ import: imp, records });
});

router.delete('/:id', requireRole('editor'), async (c) => {
  const imp = await getOrgRow<{ id: string }>(c, 'rent_roll_imports', c.req.param('id'), 'id');
  const { error } = await db().from('rent_roll_imports').delete().eq('id', imp.id).eq('org_id', c.get('orgId'));
  if (error) throw new Error(error.message);
  return c.json({ deleted: true });
});

export default router;
