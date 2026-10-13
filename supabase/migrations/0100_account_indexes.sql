-- Account & administration: lookup indexes (idempotent).
-- Case-insensitive email lookups (add-or-invite, domain join, user search).
create index if not exists profiles_email_lower_idx on public.profiles (lower(email));
create index if not exists org_invites_email_idx on public.org_invites (org_id, lower(email), status);
-- AI usage report across all organizations by date.
create index if not exists ai_usage_created_idx on public.ai_usage (created_at);
