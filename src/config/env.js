import 'dotenv/config';

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy API/.env.example to API/.env and fill in your Supabase credentials.');
  process.exit(1);
}

export const env = {
  port: Number(process.env.PORT) || 3000,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  storageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'leases',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:8080',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 20,
};
