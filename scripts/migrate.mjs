// Applies supabase/migrations/*.sql in filename order, once each (tracked in public.schema_migrations).
// Usage: npm run db:migrate            apply pending migrations
//        npm run db:migrate -- --list  show applied/pending
// Needs DATABASEPASSWORD (the project's Postgres password) in API/.env.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'supabase', 'migrations');

const url = process.env.SUPABASE_URL;
const password = process.env.DATABASEPASSWORD || process.env.SUPABASE_DATABASE_PASSWORD;
if (!url || !password) {
  console.error('SUPABASE_URL and DATABASEPASSWORD must be set in API/.env');
  process.exit(1);
}
const ref = new URL(url).hostname.split('.')[0];

const client = new pg.Client({
  host: process.env.DATABASE_HOST || `db.${ref}.supabase.co`,
  port: Number(process.env.DATABASE_PORT) || 5432,
  user: process.env.DATABASE_USER || 'postgres',
  database: 'postgres',
  password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

await client.connect();
await client.query(`create table if not exists public.schema_migrations (
  name text primary key, applied_at timestamptz not null default now())`);

const applied = new Set((await client.query('select name from public.schema_migrations')).rows.map((r) => r.name));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

if (process.argv.includes('--list')) {
  for (const f of files) console.log(`${applied.has(f) ? 'applied' : 'pending'}  ${f}`);
  await client.end();
  process.exit(0);
}

let count = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  process.stdout.write(`Applying ${file} ... `);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into public.schema_migrations (name) values ($1)', [file]);
    await client.query('commit');
    console.log('ok');
    count += 1;
  } catch (err) {
    await client.query('rollback');
    console.log('FAILED');
    console.error(err.message);
    await client.end();
    process.exit(1);
  }
}

// Make PostgREST pick up new tables/functions immediately.
await client.query("notify pgrst, 'reload schema'");
console.log(count ? `Applied ${count} migration(s).` : 'Database is up to date.');
await client.end();
