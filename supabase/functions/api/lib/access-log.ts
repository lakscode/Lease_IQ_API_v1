import { db } from './supabase.ts';

export type AccessAction =
  | 'upload' | 'view' | 'download' | 'report_download' | 'save' | 'email' | 'edit' | 'verify' | 'delete';

/** Append to the immutable access log. Never throws (logging must not break the request). */
export async function logAccess(entry: {
  orgId: string;
  userId: string | null;
  action: AccessAction;
  leaseId?: string | null;
  documentId?: string | null;
  fileId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db().from('access_log').insert({
    org_id: entry.orgId,
    user_id: entry.userId,
    action: entry.action,
    lease_id: entry.leaseId ?? null,
    document_id: entry.documentId ?? null,
    file_id: entry.fileId ?? null,
    details: entry.details ?? null,
  });
  if (error) console.error('access_log insert failed:', error.message);
}
