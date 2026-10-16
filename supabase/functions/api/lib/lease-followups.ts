// Follow-up alerts for a lease (owned by the leases area): open tasks that are overdue or due soon, and supporting
// documents (attachments) that have expired or expire soon. Mirrors UI features/leases/workspace/attachments.ts
// expiryOf, so the badge in the Documents tab and the alert agree.
import { addMonths, today, type LeaseAlert } from './lease-terms.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXPIRY_FIELD_RE = /expir|valid until|valid through|end date|coverage end/i;

interface ReviewLike { key_date?: string | null; fields?: Record<string, string> | null }

/**
 * Expiry date of a supporting document, from its AI review: a reviewed field that names an expiry (e.g.
 * "Policy expiration": "2026-05-01"), else the key date of an insurance certificate. Null when unknown.
 */
export function expiryOf(category: string | null, review: ReviewLike | null): string | null {
  if (!review) return null;
  for (const [key, value] of Object.entries(review.fields ?? {})) {
    const v = String(value ?? '').trim().slice(0, 10);
    if (EXPIRY_FIELD_RE.test(key) && DATE_RE.test(v)) return v;
  }
  return category === 'insurance' && review.key_date && DATE_RE.test(review.key_date) ? review.key_date : null;
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function followUpAlerts(input: {
  tasks: { title: string; due_date: string | null }[];
  attachments: { file_name: string; category: string | null; ai_review: ReviewLike | null }[];
}): LeaseAlert[] {
  const now = today();
  const alerts: LeaseAlert[] = [];
  for (const task of input.tasks) {
    if (!task.due_date) continue;
    if (task.due_date < now) alerts.push({ code: 'task_overdue', severity: 'urgent', message: task.title, due_date: task.due_date });
    else if (task.due_date <= addDays(now, 30)) {
      alerts.push({ code: 'task_due', severity: task.due_date <= addDays(now, 14) ? 'urgent' : 'normal', message: task.title, due_date: task.due_date });
    }
  }
  for (const att of input.attachments) {
    const expiry = expiryOf(att.category, att.ai_review);
    if (!expiry) continue;
    if (expiry < now) alerts.push({ code: 'doc_expired', severity: 'urgent', message: att.file_name, due_date: expiry });
    else if (expiry <= addMonths(now, 2)) {
      alerts.push({ code: 'doc_expiring', severity: expiry <= addDays(now, 30) ? 'urgent' : 'normal', message: att.file_name, due_date: expiry });
    }
  }
  return alerts;
}
