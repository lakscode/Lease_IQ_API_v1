import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

const serverAuthOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

// Admin client: bypasses RLS. Only ever used server-side, always scoped by user_id.
export const supabaseAdmin = createClient(
  env.supabaseUrl,
  env.supabaseServiceRoleKey,
  serverAuthOptions,
);

// Fresh anon client per auth call so sessions never leak between requests.
export function createAnonClient() {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, serverAuthOptions);
}
