import { db } from './supabase.ts';

// app_settings keys
export const SETTINGS = {
  aiModel: 'ai_model',             // string model id
  email: 'email',                  // { provider: 'default' | 'sendgrid', from_name, from_email }
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
