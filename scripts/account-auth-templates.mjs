// Applies Lease IQ's Supabase Auth settings through the Management API (idempotent):
//   - Site URL and redirect allow-list
//   - branded password recovery email (subject + docs/email-templates/recovery.html)
// Usage: node scripts/account-auth-templates.mjs [--dry-run] [--site-url=http://localhost:8080] [--redirect=https://app.example.com/**]
// Needs SUPABASE_URL and SUPABASE_ACCESS_TOKEN (a personal access token) in API/.env.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const dryRun = args.includes('--dry-run');

const url = process.env.SUPABASE_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!url || !token) {
  console.error('SUPABASE_URL and SUPABASE_ACCESS_TOKEN must be set in API/.env');
  process.exit(1);
}
const ref = new URL(url).hostname.split('.')[0];
const siteUrl = (arg('site-url')[0] || process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '');
const extraRedirects = arg('redirect');

const templatePath = path.join(here, '..', '..', 'docs', 'email-templates', 'recovery.html');
const recoveryHtml = fs.readFileSync(templatePath, 'utf8');
const endpoint = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const current = await fetch(endpoint, { headers });
if (!current.ok) {
  console.error(`Could not read auth config (${current.status}): ${await current.text()}`);
  process.exit(1);
}
const config = await current.json();

// Merge the allow-list instead of replacing it.
const existing = String(config.uri_allow_list || '').split(',').map((s) => s.trim()).filter(Boolean);
const wanted = [siteUrl, `${siteUrl}/**`, ...extraRedirects];
const allowList = [...new Set([...existing, ...wanted])].join(',');

const patch = {
  site_url: siteUrl,
  uri_allow_list: allowList,
  mailer_subjects_recovery: 'Reset your Lease IQ password',
  mailer_templates_recovery_content: recoveryHtml,
};

const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => config[k] !== v));
if (!Object.keys(changed).length) {
  console.log('Auth settings are already up to date.');
  process.exit(0);
}
console.log(`Project ${ref}: updating ${Object.keys(changed).join(', ')}`);
console.log(`  site_url        ${config.site_url} -> ${patch.site_url}`);
console.log(`  uri_allow_list  ${config.uri_allow_list || '(empty)'} -> ${patch.uri_allow_list}`);
if (dryRun) {
  console.log('Dry run: nothing changed.');
  process.exit(0);
}
const res = await fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify(changed) });
if (!res.ok) {
  console.error(`Update failed (${res.status}): ${await res.text()}`);
  process.exit(1);
}
console.log('Done.');
