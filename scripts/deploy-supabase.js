// Deploys supabase/functions/api as a Supabase Edge Function.
// Usage: npm run deploy:supabase
// Requires the Supabase CLI to be logged in (npx supabase login) or SUPABASE_ACCESS_TOKEN to be set.
// Function settings come from API/.env:
//   FUNCTION_CORS_ORIGIN  deployed UI origin(s), comma-separated (falls back to CORS_ORIGIN)
//   FUNCTION_APP_URL      public UI URL used in invitation/email links (falls back to APP_URL, then the first origin)
//   ANTHROPIC_API_KEY, SENDGRID_API_KEY, JIRA_*  copied when set
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided to functions by Supabase automatically.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUPABASE_CLI = ['-y', 'supabase@2.20.12'];

const url = process.env.SUPABASE_URL;
if (!url) {
  console.error('SUPABASE_URL is not set in API/.env');
  process.exit(1);
}
const projectRef = new URL(url).hostname.split('.')[0];

const corsOrigin = process.env.FUNCTION_CORS_ORIGIN || process.env.CORS_ORIGIN || 'http://localhost:8080';
const secrets = {
  CORS_ORIGIN: corsOrigin,
  APP_URL: process.env.FUNCTION_APP_URL || process.env.APP_URL || corsOrigin.split(',')[0].trim(),
  STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || 'leases',
  MAX_UPLOAD_MB: process.env.MAX_UPLOAD_MB || '50',
};
for (const key of ['ANTHROPIC_API_KEY', 'SENDGRID_API_KEY', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'JIRA_ISSUE_TYPES']) {
  if (process.env[key]) secrets[key] = process.env[key];
}

function supabase(args) {
  console.log(`\n> supabase ${args.join(' ')}`);
  execFileSync('npx', [...SUPABASE_CLI, ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
}

// Pass secrets through a temporary env file so values never appear on the command line.
const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leaseiq-')), 'function.env');
fs.writeFileSync(envFile, Object.entries(secrets).map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, '')}`).join('\n'), { mode: 0o600 });
try {
  console.log(`Setting function secrets: ${Object.keys(secrets).join(', ')}`);
  supabase(['secrets', 'set', '--env-file', envFile, '--project-ref', projectRef]);
} finally {
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
}

// --no-verify-jwt: some routes are public (status, invite preview); the app verifies tokens itself.
supabase(['functions', 'deploy', 'api', '--project-ref', projectRef, '--no-verify-jwt', '--use-api']);

console.log(`\nDeployed: https://${projectRef}.supabase.co/functions/v1/api/status`);
console.log(`Point the UI at it with VITE_API_URL=https://${projectRef}.supabase.co/functions/v1`);
