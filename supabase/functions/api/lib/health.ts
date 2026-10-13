import { db } from './supabase.ts';
import { env } from './env.ts';
import { aiConfigured, getModel } from './ai.ts';
import { emailConfigured } from './email.ts';
import { isEdgeRuntime } from './runtime.ts';

const CHECK_TIMEOUT_MS = 5000;

export interface Check {
  name: string;
  description: string;
  ok: boolean;
  /** Optional checks report "not configured" without degrading overall status. */
  optional?: boolean;
  latencyMs: number;
  detail: string;
}

async function runCheck(name: string, description: string, fn: () => Promise<string>, optional = false): Promise<Check> {
  const started = Date.now();
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${CHECK_TIMEOUT_MS / 1000}s`)), CHECK_TIMEOUT_MS)),
    ]);
    return { name, description, ok: true, optional, latencyMs: Date.now() - started, detail };
  } catch (err) {
    return { name, description, ok: false, optional, latencyMs: Date.now() - started, detail: (err as Error).message };
  }
}

// Tables the current code needs; a missing one means migrations haven't been applied.
const REQUIRED_TABLES = [
  'profiles', 'organizations', 'org_members', 'lease_files', 'leases', 'documents', 'document_pages', 'clauses',
  'attachments', 'chat_conversations', 'opportunities', 'rent_roll_records', 'ai_usage',
];

export async function getSystemStatus() {
  const checks = await Promise.all([
    runCheck('Supabase Auth', 'Sign-in and token verification', async () => {
      const { error } = await db().auth.admin.listUsers({ page: 1, perPage: 1 });
      if (error) throw error;
      return 'Reachable';
    }),
    runCheck('Database', 'Schema up to date', async () => {
      const missing: string[] = [];
      await Promise.all(
        REQUIRED_TABLES.map(async (t) => {
          // Not a HEAD request: PostgREST returns no error body for HEAD, so a missing table would pass.
          const { error } = await db().from(t).select('*', { count: 'exact' }).limit(1);
          if (error) missing.push(t);
        }),
      );
      if (missing.length) throw new Error(`Missing tables: ${missing.join(', ')}. Run npm run db:migrate`);
      const { count } = await db().from('leases').select('id', { count: 'exact' }).limit(1);
      return `${REQUIRED_TABLES.length} core tables present · ${count ?? 0} lease(s)`;
    }),
    runCheck('Storage', `"${env.storageBucket}" and "${env.logoBucket}" buckets`, async () => {
      for (const bucket of [env.storageBucket, env.logoBucket]) {
        const { error } = await db().storage.getBucket(bucket);
        if (error) throw new Error(`Bucket "${bucket}" not available: ${error.message}`);
      }
      return 'Available';
    }),
    runCheck('AI (Claude)', 'Lease abstraction, assistant, insights', async () => {
      if (!aiConfigured()) throw new Error('ANTHROPIC_API_KEY is not set');
      return `Configured · model ${await getModel()}`;
    }, true),
    runCheck('Email (SendGrid)', 'Invitations and report delivery', async () => {
      if (!(await emailConfigured())) throw new Error('Not configured (invites fall back to copyable links)');
      return 'Configured';
    }, true),
    runCheck('Jira', 'Support tickets', async () => {
      const j = env.jira;
      if (!j.baseUrl || !j.email || !j.apiToken || !j.projectKey) throw new Error('Not configured');
      return `Project ${j.projectKey}`;
    }, true),
  ]);

  const required = checks.filter((c) => !c.optional);
  return {
    status: required.every((c) => c.ok) ? 'ok' : 'degraded',
    service: 'Lease IQ API',
    version: '2.0.0',
    runtime: isEdgeRuntime ? 'Supabase Edge Functions (Deno)' : `Node.js ${(globalThis as { process?: { version: string } }).process?.version ?? ''}`,
    uptimeSeconds: Math.round(((globalThis as { process?: { uptime(): number } }).process?.uptime() ?? 0)),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

export type SystemStatus = Awaited<ReturnType<typeof getSystemStatus>>;
