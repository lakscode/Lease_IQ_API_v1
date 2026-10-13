// /api/reports — the lease report (every lease as amended) with filters, charts and CSV export.
//   GET  /leases?search&tenant&landlord&status&start_from&start_to&end_from&end_to&rent_min&rent_max
//   GET  /leases.csv?…same filters…   (download)
//   POST /leases/email { to: string[] (≤10), message, filters }  → CSV attached, branded email
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { withOrg } from '../lib/auth.ts';
import { db } from '../lib/supabase.ts';
import { badRequest, readJson } from '../lib/http.ts';
import { escapeHtml, renderEmail, sendEmail } from '../lib/email.ts';
import { publicLogoUrl } from '../lib/storage.ts';
import { env } from '../lib/env.ts';
import { buildReport, describeFilters, parseFilters, reportCsv } from '../lib/analytics-reports.ts';

const router = new Hono<AppEnv>();
router.use('*', withOrg);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function queryRecord(url: string): Record<string, unknown> {
  const params = new URL(url).searchParams;
  const out: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

router.get('/leases', async (c) => {
  return c.json(await buildReport(c.get('orgId'), parseFilters(queryRecord(c.req.url))));
});

router.get('/leases.csv', async (c) => {
  const report = await buildReport(c.get('orgId'), parseFilters(queryRecord(c.req.url)));
  return new Response(reportCsv(report.rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lease-report-${report.as_of}.csv"`,
    },
  });
});

router.post('/leases/email', async (c) => {
  const body = await readJson<{ to?: unknown; message?: unknown; filters?: Record<string, unknown> }>(c);
  const to = Array.isArray(body.to) ? body.to.map((x) => String(x).trim()).filter(Boolean) : [];
  if (!to.length || to.some((x) => !EMAIL_RE.test(x))) throw badRequest('Enter valid email addresses.');
  if (to.length > 10) throw badRequest('You can send to at most 10 recipients.');
  const message = typeof body.message === 'string' ? body.message.slice(0, 5000) : '';
  const filters = parseFilters(body.filters && typeof body.filters === 'object' ? body.filters : {});

  const orgId = c.get('orgId');
  const [report, orgRes] = await Promise.all([
    buildReport(orgId, filters),
    db().from('organizations').select('name, logo_path').eq('id', orgId).single(),
  ]);
  if (orgRes.error) throw new Error(orgRes.error.message);
  const org = orgRes.data as { name: string; logo_path: string | null };
  const profile = c.get('profile');
  const sender = profile.display_name || profile.email || 'A colleague';

  const csv = reportCsv(report.rows);
  const bytes = new TextEncoder().encode(csv);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const filename = `lease-report-${report.as_of}.csv`;

  const filterLines = describeFilters(filters);
  const bodyHtml = [
    `<p>${escapeHtml(sender)} sent you the lease report for <strong>${escapeHtml(org.name)}</strong> (${report.rows.length} leases). The CSV file is attached.</p>`,
    message ? `<p style="white-space:pre-wrap;border-left:3px solid #e3e8f0;padding-left:12px">${escapeHtml(message)}</p>` : '',
    filterLines.length ? `<p style="font-size:13px;color:#64748b">Filters: ${filterLines.map(escapeHtml).join(' · ')}</p>` : '',
  ].join('');

  await sendEmail({
    to,
    subject: `Lease report — ${org.name}`,
    html: renderEmail({
      title: 'Lease report',
      bodyHtml,
      orgName: org.name,
      logoUrl: publicLogoUrl(org.logo_path),
      cta: { label: 'Open reports', url: `${env.appUrl}/reports` },
    }),
    text: `${sender} sent you the lease report for ${org.name} (${report.rows.length} leases). The CSV file is attached.${message ? `\n\n${message}` : ''}`,
    replyTo: profile.email ?? undefined,
    attachments: [{ filename, content: btoa(binary), type: 'text/csv' }],
  });
  return c.json({ sent: to.length, rows: report.rows.length });
});

export default router;
