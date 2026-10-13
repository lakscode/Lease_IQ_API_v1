// Creates Lease IQ login users in Supabase Auth with random passwords.
// Usage: npm run users:create
// Existing users are skipped (their passwords are not changed).
import crypto from 'node:crypto';
import 'dotenv/config';
import { db } from '../supabase/functions/api/lib/supabase.ts';

const supabaseAdmin = db();

const USERS = [
  { email: 'admin@leaseiq.test', full_name: 'Lease IQ Admin' },
  { email: 'manager@leaseiq.test', full_name: 'Portfolio Manager' },
  { email: 'analyst@leaseiq.test', full_name: 'Lease Analyst' },
];

function generatePassword(length = 16) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%^&*'];
  const all = sets.join('');
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const chars = sets.map(pick); // at least one of each kind
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const { data: existing, error: listError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
if (listError) {
  console.error(`Could not list users: ${listError.message}`);
  process.exit(1);
}
const existingEmails = new Set(existing.users.map((u) => u.email?.toLowerCase()));

const results = [];
for (const user of USERS) {
  if (existingEmails.has(user.email)) {
    results.push({ email: user.email, name: user.full_name, password: '(already exists, unchanged)' });
    continue;
  }

  const password = generatePassword();
  const { error } = await supabaseAdmin.auth.admin.createUser({
    email: user.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: user.full_name },
  });

  results.push({
    email: user.email,
    name: user.full_name,
    password: error ? `ERROR: ${error.message}` : password,
  });
}

console.table(results);
