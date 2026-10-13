// Shared lease-domain definitions: abstract fields, clause types, opportunity categories.
// documents.abstract is an object keyed by ABSTRACT_FIELDS[].key, plus `pages` ({field: page number}).

export type FieldKind = 'text' | 'longtext' | 'date' | 'number' | 'money';

export interface AbstractField {
  key: string;
  label: string;
  kind: FieldKind;
  group: 'parties' | 'property' | 'dates' | 'rent' | 'options' | 'other';
  /** Shown in the leases table / used for "as amended" denormalisation. */
  leaseColumn?: string;
}

export const ABSTRACT_FIELDS: AbstractField[] = [
  { key: 'landlord', label: 'Landlord', kind: 'text', group: 'parties', leaseColumn: 'landlord_name' },
  { key: 'tenant', label: 'Tenant', kind: 'text', group: 'parties', leaseColumn: 'tenant_name' },
  { key: 'guarantor', label: 'Guarantor', kind: 'text', group: 'parties' },
  { key: 'premises_address', label: 'Premises address', kind: 'text', group: 'property', leaseColumn: 'premises_address' },
  { key: 'property_name', label: 'Property name', kind: 'text', group: 'property' },
  { key: 'rentable_area', label: 'Rentable area (sq ft)', kind: 'number', group: 'property', leaseColumn: 'rentable_area' },
  { key: 'permitted_use', label: 'Permitted use', kind: 'longtext', group: 'property' },
  { key: 'commencement_date', label: 'Commencement date', kind: 'date', group: 'dates', leaseColumn: 'commencement_date' },
  { key: 'expiration_date', label: 'Expiration date', kind: 'date', group: 'dates', leaseColumn: 'expiration_date' },
  { key: 'term_months', label: 'Term (months)', kind: 'number', group: 'dates' },
  { key: 'base_rent_monthly', label: 'Base rent (monthly)', kind: 'money', group: 'rent', leaseColumn: 'base_rent_monthly' },
  { key: 'base_rent_annual', label: 'Base rent (annual)', kind: 'money', group: 'rent' },
  { key: 'rent_escalations', label: 'Rent escalations', kind: 'longtext', group: 'rent' },
  { key: 'security_deposit', label: 'Security deposit', kind: 'money', group: 'rent' },
  { key: 'operating_expenses', label: 'Operating expenses / CAM', kind: 'longtext', group: 'rent' },
  { key: 'renewal_options', label: 'Renewal options', kind: 'longtext', group: 'options' },
  { key: 'renewal_notice_window', label: 'Renewal notice window', kind: 'text', group: 'options' },
  { key: 'renewal_notice_months', label: 'Renewal notice (months before expiry)', kind: 'number', group: 'options' },
  { key: 'termination_options', label: 'Termination options', kind: 'longtext', group: 'options' },
  { key: 'changes_made', label: 'Changes made (amendments)', kind: 'longtext', group: 'other' },
];

export const ABSTRACT_FIELD_KEYS = ABSTRACT_FIELDS.map((f) => f.key);

export const DOC_TYPES = ['main_lease', 'amendment', 'addendum', 'commencement_letter', 'other'] as const;

/** 75 clause types used for clause classification. */
export const CLAUSE_TYPES = [
  'Parties', 'Premises', 'Term', 'Commencement', 'Base Rent', 'Rent Escalation', 'CPI Adjustment', 'Percentage Rent',
  'Additional Rent', 'Security Deposit', 'Letter of Credit', 'Guaranty', 'Late Charges', 'Operating Expenses', 'CAM',
  'Real Estate Taxes', 'Insurance', 'Utilities', 'Use', 'Exclusive Use', 'Prohibited Uses', 'Co-Tenancy',
  'Go Dark', 'Continuous Operation', 'Radius Restriction', 'Relocation', 'Expansion Option', 'ROFR', 'ROFO',
  'Renewal Option', 'Termination Option', 'Early Termination', 'Holdover', 'Surrender', 'Assignment and Subletting',
  'Change of Control', 'Alterations', 'Tenant Improvements', 'Improvement Allowance', 'Repairs and Maintenance',
  'Landlord Obligations', 'Compliance with Laws', 'Hazardous Materials', 'ADA Compliance', 'Signage', 'Parking',
  'Access', 'Services', 'Rules and Regulations', 'Quiet Enjoyment', 'Indemnification', 'Waiver of Subrogation',
  'Limitation of Liability', 'Casualty', 'Condemnation', 'Default', 'Remedies', 'Landlord Default',
  'Subordination', 'SNDA', 'Estoppel', 'Notices', 'Brokers', 'Force Majeure', 'Abatement', 'Free Rent',
  'Audit Rights', 'Confidentiality', 'Governing Law', 'Dispute Resolution', 'Mechanics Liens',
  'Landlord Entry', 'Mortgagee Protection', 'Sale of Premises', 'Miscellaneous',
] as const;

export const OPPORTUNITY_CATEGORIES = {
  revenue: [
    'rent_escalation', 'cpi_escalation', 'renewal_opportunity', 'market_rent_comparison', 'under_billing',
    'missing_cam_recovery', 'expired_concessions', 'security_deposit_changes', 'additional_rent', 'percentage_rent',
  ],
  risk: [
    'renewal_notice_deadline', 'termination_option', 'co_tenancy', 'exclusivity', 'rent_free_ending',
    'insurance_expiry', 'guarantee_expiry', 'obligations', 'cam_cap_violation', 'amendment_not_reflected',
  ],
} as const;

export const ATTACHMENT_CATEGORIES = [
  'exhibit', 'insurance', 'estoppel', 'snda', 'financial_statement', 'correspondence', 'notice', 'invoice', 'other',
] as const;

/** Coerce an AI- or user-supplied value to the field's kind. Returns null for empty/invalid. */
export function coerceFieldValue(field: AbstractField, value: unknown): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  if (field.kind === 'number' || field.kind === 'money') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (field.kind === 'date') {
    const s = String(value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}
