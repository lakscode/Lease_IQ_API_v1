import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.ts';

const serverAuthOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

let admin: SupabaseClient | null = null;

/** Service-role client. Bypasses RLS: every query must be scoped by org_id (see lib/auth.ts). */
export function db(): SupabaseClient {
  admin ??= createClient(env.supabaseUrl, env.serviceRoleKey, serverAuthOptions);
  return admin;
}

/** Fresh anon client (used for password checks without touching the admin client's state). */
export function anonClient(): SupabaseClient {
  return createClient(env.supabaseUrl, env.anonKey, serverAuthOptions);
}

/** Throw on a Supabase error, return data otherwise. */
export function must<T>(result: { data: T; error: { message: string } | null }, context?: string): T {
  if (result.error) {
    throw new Error(context ? `${context}: ${result.error.message}` : result.error.message);
  }
  return result.data;
}
