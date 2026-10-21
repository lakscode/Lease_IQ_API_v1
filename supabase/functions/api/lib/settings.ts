import { db } from './supabase.ts';

// app_settings keys
export const SETTINGS = {
  aiModel: 'ai_model',             // string model id
  aiMode: 'ai_mode',               // 'economy' | 'quality' — how much of each document Claude reads (pipeline/store.ts)
  svmModel: 'svm_model',           // { id, trained_at } of the active retrained clause SVM (clause_models); { id: null } = bundled
  email: 'email',                  // { provider: 'default' (SMTP mailbox) | 'sendgrid', from_name, from_email, smtp_* }
} as const;

const cache = new Map<string, { value: unknown; at: number }>();
const TTL_MS = 30_000;

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return (hit.value ?? fallback) as T;
  const { data } = await db().from('app_settings').select('value').eq('key', key).maybeSingle();
  cache.set(key, { value: data?.value ?? null, at: Date.now() });
  return (data?.value ?? fallback) as T;
}

export async function setSetting(key: string, value: unknown, userId: string | null): Promise<void> {
  const { error } = await db()
    .from('app_settings')
    .upsert({ key, value, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache.delete(key);
}

// app_secrets keys (service-role only; never returned to the browser)
export const SECRETS = {
  sendgridApiKey: 'sendgrid_api_key',
  smtpPassword: 'smtp_password',
} as const;

const secretCache = new Map<string, { value: string | null; at: number }>();

export async function getSecret(key: string): Promise<string | null> {
  const hit = secretCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const { data } = await db().from('app_secrets').select('value').eq('key', key).maybeSingle();
  const value = data?.value || null;
  secretCache.set(key, { value, at: Date.now() });
  return value;
}

/** Store a secret, or remove it when value is null. */
export async function setSecret(key: string, value: string | null, userId: string | null): Promise<void> {
  const { error } = value === null
    ? await db().from('app_secrets').delete().eq('key', key)
    : await db().from('app_secrets').upsert({ key, value, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  secretCache.delete(key);
}
