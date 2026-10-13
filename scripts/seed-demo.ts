// Seeds a "Demo Portfolio" organization with realistic lease families (no AI needed).
// Usage: npm run seed:demo            create (skips if the org already exists)
//        npm run seed:demo -- --reset delete the demo org first, then recreate
// Every existing user is added to the demo org with the same role they have in their first org.
import 'dotenv/config';
import { db } from '../supabase/functions/api/lib/supabase.ts';
import { recomputeLease, addMonths, today } from '../supabase/functions/api/lib/lease-terms.ts';

const ORG_NAME = 'Demo Portfolio';
const reset = process.argv.includes('--reset');

function monthsFromNow(m: number) {
  return addMonths(today(), m);
}

interface DemoDoc {
  doc_type: 'main_lease' | 'amendment' | 'commencement_letter';
  title: string;
  effective_date: string | null;
  abstract: Record<string, unknown>;
  changes_made?: string;
  pages: string[];
  clauses: { type: string; confidence: number; section: string; page: number; text: string; alt?: { type: string; confidence: number }[] }[];
  signature?: Record<string, unknown>;
}

interface DemoLease {
  property_type: string;
  docs: DemoDoc[];
}

function mainLease(o: {
  tenant: string; landlord: string; address: string; area: number; start: string; end: string; rent: number;
  escalation: string; deposit: number; renewal?: string; noticeMonths?: number; termination?: string; use: string; opex: string;
}): DemoDoc {
  const termMonths = Math.round((Date.parse(o.end) - Date.parse(o.start)) / (30.44 * 86_400_000));
  return {
    doc_type: 'main_lease',
    title: `Lease Agreement — ${o.tenant}`,
    effective_date: o.start,
    abstract: {
      landlord: o.landlord, tenant: o.tenant, premises_address: o.address, rentable_area: o.area,
      commencement_date: o.start, expiration_date: o.end, term_months: termMonths,
      base_rent_monthly: o.rent, base_rent_annual: o.rent * 12, rent_escalations: o.escalation,
      security_deposit: o.deposit, renewal_options: o.renewal ?? null,
      renewal_notice_window: o.noticeMonths ? `${o.noticeMonths} months prior written notice` : null,
      renewal_notice_months: o.noticeMonths ?? null, termination_options: o.termination ?? null,
      permitted_use: o.use, operating_expenses: o.opex,
      pages: { tenant: 1, landlord: 1, premises_address: 1, base_rent_monthly: 2, expiration_date: 1, renewal_options: 3 },
    },
    pages: [
      `LEASE AGREEMENT\n\nThis Lease is made between ${o.landlord} ("Landlord") and ${o.tenant} ("Tenant").\n\n1. PREMISES. Landlord leases to Tenant approximately ${o.area.toLocaleString('en-US')} rentable square feet located at ${o.address} (the "Premises").\n\n2. TERM. The term commences on ${o.start} and expires on ${o.end}, unless sooner terminated.`,
      `3. BASE RENT. Tenant shall pay monthly Base Rent of $${o.rent.toLocaleString('en-US')} in advance on the first day of each month.\n\n4. ESCALATION. ${o.escalation}\n\n5. SECURITY DEPOSIT. Tenant shall deposit $${o.deposit.toLocaleString('en-US')} as security.\n\n6. OPERATING EXPENSES. ${o.opex}`,
      `7. USE. ${o.use}\n\n8. RENEWAL. ${o.renewal ?? 'Tenant has no option to renew.'}${o.noticeMonths ? ` Tenant must give written notice no later than ${o.noticeMonths} months before expiration.` : ''}\n\n9. TERMINATION. ${o.termination ?? 'No early termination right.'}\n\nIN WITNESS WHEREOF the parties have executed this Lease.\n\nLANDLORD: ${o.landlord}  By: ______  Date: ${o.start}\nTENANT: ${o.tenant}  By: ______  Date: ${o.start}`,
    ],
    clauses: [
      { type: 'Premises', confidence: 0.97, section: '1', page: 1, text: `Approximately ${o.area} RSF at ${o.address}.` },
      { type: 'Term', confidence: 0.96, section: '2', page: 1, text: `Commences ${o.start}, expires ${o.end}.` },
      { type: 'Base Rent', confidence: 0.98, section: '3', page: 2, text: `Monthly Base Rent of $${o.rent}.` },
      { type: 'Rent Escalation', confidence: 0.9, section: '4', page: 2, text: o.escalation },
      { type: 'Security Deposit', confidence: 0.95, section: '5', page: 2, text: `Deposit of $${o.deposit}.` },
      { type: 'Operating Expenses', confidence: 0.78, section: '6', page: 2, text: o.opex, alt: [{ type: 'CAM', confidence: 0.18 }] },
      { type: 'Use', confidence: 0.93, section: '7', page: 3, text: o.use },
      ...(o.renewal ? [{ type: 'Renewal Option', confidence: 0.94, section: '8', page: 3, text: o.renewal }] : []),
      ...(o.termination ? [{ type: 'Termination Option', confidence: 0.88, section: '9', page: 3, text: o.termination }] : []),
    ],
    signature: {
      status: 'signed', method: 'ink',
      parties: [
        { party: 'Landlord', signer: `${o.landlord} authorized signatory`, date: o.start },
        { party: 'Tenant', signer: `${o.tenant} authorized signatory`, date: o.start },
      ],
      checked_at: new Date().toISOString(), notes: 'Demo data',
    },
  };
}

const LEASES: DemoLease[] = [
  {
    property_type: 'Office',
    docs: [
      mainLease({
        tenant: 'Northwind Analytics LLC', landlord: 'Harbor Point Properties LP', address: '100 Harbor Point Blvd, Suite 400, Boston, MA 02110',
        area: 12500, start: monthsFromNow(-50), end: monthsFromNow(4), rent: 52083, escalation: 'Base Rent increases 3% on each anniversary of the Commencement Date.',
        deposit: 104166, renewal: 'One option to renew for 5 years at 95% of fair market rent.', noticeMonths: 9, use: 'General office use.',
        opex: "Tenant pays its pro rata share (8.4%) of Operating Expenses over a 2022 base year; controllable expenses capped at 5% annually.",
      }),
    ],
  },
  {
    property_type: 'Retail',
    docs: [
      mainLease({
        tenant: 'Bluebird Coffee Co.', landlord: 'Westgate Retail Center LLC', address: '2200 Westgate Mall Dr, Unit 112, Denver, CO 80204',
        area: 1800, start: monthsFromNow(-70), end: monthsFromNow(-10), rent: 6300, escalation: 'Fixed increases of $0.50 per RSF per year.',
        deposit: 12600, renewal: 'Two 5-year renewal options at market rent.', noticeMonths: 6, use: 'Retail coffee shop and bakery.',
        opex: 'Tenant pays pro rata share (2.1%) of CAM, taxes and insurance. Percentage rent of 6% over $900,000 natural breakpoint.',
      }),
    ],
  },
  {
    property_type: 'Industrial',
    docs: [
      mainLease({
        tenant: 'Apex Logistics Inc.', landlord: 'Riverside Industrial REIT', address: '45 Riverside Industrial Pkwy, Building C, Columbus, OH 43215',
        area: 85000, start: monthsFromNow(-40), end: monthsFromNow(20), rent: 56666, escalation: 'Base Rent increases 2.5% annually.',
        deposit: 113333, renewal: 'One 5-year renewal option at fair market value.', noticeMonths: 12, termination: 'Tenant may terminate after month 60 with 9 months notice and payment of unamortized costs.',
        use: 'Warehouse, distribution and ancillary office.', opex: 'Triple net. Tenant pays 100% of taxes, insurance and CAM for Building C.',
      }),
      {
        doc_type: 'amendment', title: 'First Amendment to Lease — Apex Logistics', effective_date: monthsFromNow(-6),
        abstract: { expiration_date: monthsFromNow(44), base_rent_monthly: 61200, base_rent_annual: 734400, term_months: 84, pages: { expiration_date: 1, base_rent_monthly: 1 } },
        changes_made: 'Extends the term by 24 months and resets monthly Base Rent to $61,200 from the extension date.',
        pages: [`FIRST AMENDMENT TO LEASE\n\nRiverside Industrial REIT and Apex Logistics Inc. agree: (a) the Expiration Date is extended to ${monthsFromNow(44)}; (b) monthly Base Rent shall be $61,200 commencing ${monthsFromNow(-6)}. All other terms remain in effect.`],
        clauses: [
          { type: 'Term', confidence: 0.95, section: 'a', page: 1, text: `Expiration Date extended to ${monthsFromNow(44)}.` },
          { type: 'Base Rent', confidence: 0.96, section: 'b', page: 1, text: 'Monthly Base Rent shall be $61,200.' },
        ],
        signature: { status: 'partially_signed', method: 'docusign', parties: [{ party: 'Landlord', signer: 'J. Rivera', date: monthsFromNow(-6) }, { party: 'Tenant', signer: null, date: null }], checked_at: new Date().toISOString(), notes: 'Tenant signature block empty (demo data)' },
      },
    ],
  },
  {
    property_type: 'Office',
    docs: [
      mainLease({
        tenant: 'Greenleaf Health Partners', landlord: 'Harbor Point Properties LP', address: '100 Harbor Point Blvd, Suite 210, Boston, MA 02110',
        area: 6400, start: monthsFromNow(-14), end: monthsFromNow(70), rent: 25600, escalation: 'Annual CPI adjustment, minimum 2%, maximum 4%.',
        deposit: 51200, renewal: 'Right of first offer on adjacent Suite 220.', use: 'Medical office.', opex: 'Pro rata share (4.3%) of Operating Expenses over 2025 base year.',
      }),
    ],
  },
  {
    property_type: 'Retail',
    docs: [
      mainLease({
        tenant: 'Summit Outdoor Supply', landlord: 'Westgate Retail Center LLC', address: '2200 Westgate Mall Dr, Unit 140, Denver, CO 80204',
        area: 9200, start: monthsFromNow(-30), end: monthsFromNow(11), rent: 23000, escalation: 'Rent increases 3% every 24 months.',
        deposit: 46000, renewal: 'One 3-year renewal option at 100% of market.', noticeMonths: 12, use: 'Retail sale of outdoor goods.',
        opex: 'CAM capped at $6.50/RSF cumulative. Co-tenancy: rent reduces 50% if anchor tenant closes for 90+ days.',
      }),
    ],
  },
  {
    property_type: 'Office',
    docs: [
      {
        doc_type: 'commencement_letter', title: 'Commencement Date Letter — Quantum Labs', effective_date: monthsFromNow(-2),
        abstract: { tenant: 'Quantum Labs Inc.', landlord: 'Tech Square Holdings', premises_address: '1 Tech Square, Floor 6, Austin, TX 78701', commencement_date: monthsFromNow(-2), pages: { commencement_date: 1 } },
        pages: [`COMMENCEMENT DATE LETTER\n\nTech Square Holdings confirms that the Commencement Date of the Lease with Quantum Labs Inc. for Floor 6 of 1 Tech Square is ${monthsFromNow(-2)}.`],
        clauses: [{ type: 'Commencement', confidence: 0.92, section: '1', page: 1, text: `Commencement Date is ${monthsFromNow(-2)}.` }],
      },
    ],
  },
];

async function main() {
  const { data: existing } = await db().from('organizations').select('id').eq('name', ORG_NAME).maybeSingle();
  if (existing && !reset) {
    console.log(`"${ORG_NAME}" already exists (${existing.id}). Use --reset to recreate it.`);
    return;
  }
  if (existing && reset) {
    const { error } = await db().from('organizations').delete().eq('id', existing.id);
    if (error) throw new Error(error.message);
    console.log(`Deleted existing "${ORG_NAME}".`);
  }

  const { data: users } = await db().auth.admin.listUsers({ perPage: 1000 });
  const admin = users.users.find((u) => u.email === 'admin@leaseiq.test') ?? users.users[0];
  const { data: org, error: orgErr } = await db().from('organizations').insert({ name: ORG_NAME, currency: 'USD', created_by: admin?.id ?? null }).select('id').single();
  if (orgErr) throw new Error(orgErr.message);
  const orgId = org.id as string;

  // Same role as in each user's first org.
  for (const u of users.users) {
    const { data: m } = await db().from('org_members').select('role').eq('user_id', u.id).order('created_at').limit(1).maybeSingle();
    await db().from('org_members').upsert({ org_id: orgId, user_id: u.id, role: m?.role ?? 'viewer' });
  }

  let docCount = 0;
  for (const demo of LEASES) {
    const { data: lease, error } = await db().from('leases').insert({ org_id: orgId, property_type: demo.property_type }).select('id').single();
    if (error) throw new Error(error.message);
    for (const d of demo.docs) {
      const { data: doc, error: docErr } = await db().from('documents').insert({
        org_id: orgId, lease_id: lease.id, doc_type: d.doc_type, title: d.title, effective_date: d.effective_date,
        page_start: 1, page_end: d.pages.length, page_count: d.pages.length, abstract: d.abstract, changes_made: d.changes_made ?? null,
        summary: `${d.title} (demo data).`, signature: d.signature ?? null, is_scanned: false,
      }).select('id').single();
      if (docErr) throw new Error(docErr.message);
      docCount += 1;
      await db().from('document_pages').insert(d.pages.map((text, i) => ({ document_id: doc.id, org_id: orgId, page_number: i + 1, text })));
      await db().from('clauses').insert(d.clauses.map((cl, i) => ({
        org_id: orgId, document_id: doc.id, lease_id: lease.id, clause_type: cl.type, confidence: cl.confidence,
        alt_types: cl.alt ?? null, section: cl.section, page: cl.page, paragraph: i + 1, line: 1, text: cl.text,
      })));
    }
    await recomputeLease(lease.id);
  }

  // A market rate per property type for the Market Rent Engine.
  await db().from('market_rates').insert([
    { org_id: orgId, property_type: 'Office', rate_psf_annual: 54, source: 'Demo broker survey', as_of: today() },
    { org_id: orgId, property_type: 'Retail', rate_psf_annual: 44, source: 'Demo broker survey', as_of: today() },
    { org_id: orgId, property_type: 'Industrial', rate_psf_annual: 9.5, source: 'Demo broker survey', as_of: today() },
  ]);

  console.log(`Created "${ORG_NAME}" (${orgId}) with ${LEASES.length} leases and ${docCount} documents.`);
  console.log('Note: demo documents have no PDF files in storage; PDF viewing/report download will show "file missing" for them.');
}

await main();
