-- Server-only secrets set from the admin UI (e.g. the SendGrid API key).
-- RLS is on with no policies, so only the service role (the API) can read or write them;
-- unlike app_settings, super admins cannot read these through the Supabase client.

create table if not exists public.app_secrets (
  key         text primary key,
  value       text not null,
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
