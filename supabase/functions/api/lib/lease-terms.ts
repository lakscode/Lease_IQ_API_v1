// "As amended" lease terms: each field comes from the latest document in the family that states it.
// recomputeLease() must be called after any change to a lease's documents or abstracts.
import { ABSTRACT_FIELDS } from './abstract.ts';
import { db } from './supabase.ts';
import type { DocType, LeaseStatus } from './types.ts';

export interface FamilyDocument {
  id: string;
  doc_type: DocType;
  title: string | null;
  effective_date: string | null;
  created_at: string;
  page_start: number | null;
  abstract: Record<string, unknown>;
  changes_made: string | null;
  file_id: string | null;
}

export interface TermValue {
  value: string | number;
  source_document_id: string;
  source_title: string | null;
  source_doc_type: DocType;
}

const ORDER: Record<DocType, number> = { main_lease: 0, commencement_letter: 1, amendment: 2, addendum: 2, other: 3 };

/** Chronological order: main lease, then later documents by effective date (undated last, by upload). */
export function sortFamily<T extends FamilyDocument>(docs: T[]): T[] {
  return [...docs].sort((a, b) => {
    if (a.doc_type === 'main_lease' && b.doc_type !== 'main_lease') return -1;
    if (b.doc_type === 'main_lease' && a.doc_type !== 'main_lease') return 1;
    const da = a.effective_date ?? '9999-12-31';
    const dbb = b.effective_date ?? '9999-12-31';
    if (da !== dbb) return da < dbb ? -1 : 1;
    if (ORDER[a.doc_type] !== ORDER[b.doc_type]) return ORDER[a.doc_type] - ORDER[b.doc_type];
    return a.created_at < b.created_at ? -1 : 1;
  });
}

export function mergeTerms(docs: FamilyDocument[]): Record<string, TermValue> {
  const terms: Record<string, TermValue> = {};
  for (const doc of sortFamily(docs)) {
    if (doc.doc_type === 'other') continue;
    for (const field of ABSTRACT_FIELDS) {
      if (field.key === 'changes_made') continue;
      const value = doc.abstract?.[field.key];
      if (value === null || value === undefined || value === '') continue;
      terms[field.key] = {
        value: value as string | number,
        source_document_id: doc.id,
        source_title: doc.title,
        source_doc_type: doc.doc_type,
      };
    }
  }
  return terms;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}

export function computeStatus(docs: FamilyDocument[], terms: Record<string, TermValue>): LeaseStatus {
  const expiration = terms.expiration_date?.value as string | undefined;
  if (!expiration) return 'unknown';
  const now = today();
  if (expiration < now) return 'expired';
  const main = docs.find((d) => d.doc_type === 'main_lease');
  const originalExpiry = main?.abstract?.expiration_date as string | undefined;
  if (originalExpiry && expiration > originalExpiry && terms.expiration_date.source_doc_type !== 'main_lease') {
    return 'renewed';
  }
  return expiration <= addMonths(now, 12) ? 'expiring' : 'active';
}

/** Date by which renewal notice must be given (expiration minus notice months), if known. */
export function noticeByDate(terms: Record<string, TermValue>): string | null {
  const expiration = terms.expiration_date?.value as string | undefined;
  const months = Number(terms.renewal_notice_months?.value);
  if (!expiration || !Number.isFinite(months) || months <= 0) return null;
  return addMonths(expiration, -months);
}

export async function loadFamily(leaseId: string): Promise<FamilyDocument[]> {
  const { data, error } = await db()
    .from('documents')
    .select('id, doc_type, title, effective_date, created_at, page_start, abstract, changes_made, file_id')
    .eq('lease_id', leaseId);
  if (error) throw new Error(error.message);
  return (data ?? []) as FamilyDocument[];
}

/** Recompute and store a lease's current terms, denormalised columns and status. Deletes empty leases. */
export async function recomputeLease(leaseId: string): Promise<void> {
  const docs = await loadFamily(leaseId);
  if (docs.length === 0) {
    await db().from('leases').delete().eq('id', leaseId);
    return;
  }
  const terms = mergeTerms(docs);
  const main = docs.find((d) => d.doc_type === 'main_lease') ?? null;
  const update: Record<string, unknown> = {
    main_document_id: main?.id ?? null,
    current_terms: terms,
    status: computeStatus(docs, terms),
  };
  for (const field of ABSTRACT_FIELDS) {
    if (field.leaseColumn) update[field.leaseColumn] = terms[field.key]?.value ?? null;
  }
  const { error } = await db().from('leases').update(update).eq('id', leaseId);
  if (error) throw new Error(error.message);
}

export interface LeaseAlert {
  code: string;
  severity: 'urgent' | 'normal';
  message: string;
  due_date?: string | null;
}

/** On-screen alerts and tasks for a lease (computed, not stored). */
export function computeAlerts(input: {
  status: LeaseStatus;
  terms: Record<string, TermValue>;
  hasMainLease: boolean;
  failedFiles: { id: string; file_name: string }[];
}): LeaseAlert[] {
  const alerts: LeaseAlert[] = [];
  const now = today();
  const expiration = input.terms.expiration_date?.value as string | undefined;

  if (input.status === 'expired') {
    alerts.push({ code: 'expired', severity: 'urgent', message: 'Lease has expired. Confirm holdover or renewal.', due_date: expiration });
  } else if (expiration && expiration <= addMonths(now, 12)) {
    alerts.push({ code: 'expiring', severity: expiration <= addMonths(now, 6) ? 'urgent' : 'normal', message: 'Lease ends within 12 months. Decide on renewal or exit.', due_date: expiration });
  }

  const noticeBy = noticeByDate(input.terms);
  if (input.terms.renewal_options && input.status !== 'expired') {
    if (noticeBy) {
      if (noticeBy < now) {
        alerts.push({ code: 'notice_passed', severity: 'urgent', message: 'Renewal notice date has passed. Check whether notice was given.', due_date: noticeBy });
      } else if (noticeBy <= addMonths(now, 6)) {
        alerts.push({ code: 'notice_due', severity: 'urgent', message: 'Renewal notice period is approaching.', due_date: noticeBy });
      }
    } else {
      alerts.push({ code: 'notice_check', severity: 'normal', message: 'Lease has renewal options. Check the renewal notice period.' });
    }
  }

  if (!expiration) {
    alerts.push({ code: 'confirm_expiration', severity: 'normal', message: 'Expiration date not found. Confirm it from the documents.' });
  }
  for (const f of input.failedFiles) {
    alerts.push({ code: 'file_failed', severity: 'urgent', message: `Processing failed for ${f.file_name}. Retry the file.` });
  }
  if (!input.hasMainLease) {
    alerts.push({ code: 'main_lease_missing', severity: 'urgent', message: 'Main lease is missing. Upload the original lease.' });
  }
  return alerts;
}
