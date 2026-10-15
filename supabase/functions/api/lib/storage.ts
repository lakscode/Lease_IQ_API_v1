import { db } from './supabase.ts';
import { env } from './env.ts';
import { log } from './log.ts';

// Storage layout in the private `leases` bucket (all paths start with the org id):
//   {org}/files/{file_id}/{safe-name}.pdf      original upload
//   {org}/documents/{document_id}.pdf          one PDF per detected document
//   {org}/attachments/{attachment_id}/{name}   supporting documents
// Logos go in the public `org-logos` bucket: {org}/logo-{timestamp}.{png|jpg}

export function safeName(name: string, max = 80): string {
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, max) || 'file';
  const ext = dot > 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
  return `${base}${ext}`;
}

export async function downloadBytes(path: string, bucket = env.storageBucket): Promise<Uint8Array> {
  const { data, error } = await db().storage.from(bucket).download(path);
  if (error || !data) throw new Error(`Could not read ${path}: ${error?.message ?? 'missing'}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function uploadBytes(path: string, bytes: Uint8Array, contentType: string, bucket = env.storageBucket): Promise<void> {
  const { error } = await db().storage.from(bucket).upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`Could not save ${path}: ${error.message}`);
}

export async function removePaths(paths: string[], bucket = env.storageBucket): Promise<void> {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  const { error } = await db().storage.from(bucket).remove(list);
  if (error) log.warn('storage', `Storage remove failed: ${error.message}`);
}

export async function signedUrl(path: string, seconds = 300, download?: string): Promise<string> {
  const { data, error } = await db()
    .storage.from(env.storageBucket)
    .createSignedUrl(path, seconds, download ? { download } : undefined);
  if (error || !data) throw new Error(`Could not sign ${path}: ${error?.message}`);
  return data.signedUrl;
}

/** Signed upload URL so the browser can upload large files straight to storage. */
export async function signedUploadUrl(path: string): Promise<{ path: string; token: string; signedUrl: string }> {
  const { data, error } = await db().storage.from(env.storageBucket).createSignedUploadUrl(path);
  if (error || !data) throw new Error(`Could not create upload URL: ${error?.message}`);
  return { path: data.path, token: data.token, signedUrl: data.signedUrl };
}

export function publicLogoUrl(path: string | null): string | null {
  if (!path) return null;
  return db().storage.from(env.logoBucket).getPublicUrl(path).data.publicUrl;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
