import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';

const CHECK_TIMEOUT_MS = 5000;

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${CHECK_TIMEOUT_MS / 1000}s`)), CHECK_TIMEOUT_MS),
    ),
  ]);
}

async function runCheck(name, description, fn) {
  const started = Date.now();
  try {
    const detail = await withTimeout(fn());
    return { name, description, ok: true, latencyMs: Date.now() - started, detail };
  } catch (err) {
    return { name, description, ok: false, latencyMs: Date.now() - started, detail: err.message };
  }
}

export async function getSystemStatus() {
  const checks = await Promise.all([
    runCheck('Supabase Auth', 'Sign-in and token verification', async () => {
      const { error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (error) throw error;
      return 'Reachable';
    }),
    runCheck('Database', '"leases" table in Postgres', async () => {
      const { count, error } = await supabaseAdmin
        .from('leases')
        .select('id', { count: 'exact', head: true });
      if (error) {
        throw new Error(
          error.code === '42P01' || error.code === 'PGRST205'
            ? 'Table "leases" not found. Run API/supabase/schema.sql'
            : error.message,
        );
      }
      return `${count ?? 0} lease record(s)`;
    }),
    runCheck('Storage', `"${env.storageBucket}" bucket`, async () => {
      const { data, error } = await supabaseAdmin.storage.getBucket(env.storageBucket);
      if (error) {
        throw new Error(`Bucket "${env.storageBucket}" not available: ${error.message}`);
      }
      return data.public ? 'Available (public, should be private)' : 'Available (private)';
    }),
  ]);

  return {
    status: checks.every((c) => c.ok) ? 'ok' : 'degraded',
    service: 'Lease IQ API',
    version: process.env.npm_package_version || '1.0.0',
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
    checks,
  };
}
