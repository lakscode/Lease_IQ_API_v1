import { getEnv } from './runtime.ts';

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

// Read lazily so Node can load .env before first use.
export const env = {
  get supabaseUrl() { return required('SUPABASE_URL'); },
  get anonKey() { return required('SUPABASE_ANON_KEY'); },
  get serviceRoleKey() { return required('SUPABASE_SERVICE_ROLE_KEY'); },
  get storageBucket() { return getEnv('STORAGE_BUCKET') || getEnv('SUPABASE_STORAGE_BUCKET') || 'leases'; },
  logoBucket: 'org-logos',
  get corsOrigins() { return list(getEnv('CORS_ORIGIN'), ['http://localhost:8080']); },
  /** Public URL of the UI, used in invitation and email links. */
  get appUrl() { return (getEnv('APP_URL') || this.corsOrigins[0]).replace(/\/$/, ''); },
  get maxUploadMb() { return Number(getEnv('MAX_UPLOAD_MB')) || 50; },
  get anthropicApiKey() { return getEnv('ANTHROPIC_API_KEY'); },
  /** Vercel AI Gateway key, for organizations whose clause classifier is 'gateway'. */
  get aiGatewayApiKey() { return getEnv('AI_GATEWAY_API_KEY') || getEnv('VERCEL_AI_GATEWAY_API_KEY'); },
  get sendgridApiKey() { return getEnv('SENDGRID_API_KEY'); },
  get jira() {
    return {
      baseUrl: getEnv('JIRA_BASE_URL'),
      email: getEnv('JIRA_EMAIL'),
      apiToken: getEnv('JIRA_API_TOKEN'),
      projectKey: getEnv('JIRA_PROJECT_KEY'),
    };
  },
};

function required(name: string): string {
  const value = getEnv(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
