-- Sign-in history (owned by the account area). One row per Supabase Auth session, written by GET /api/me (which the
-- app calls right after signing in): how the user signed in, from where, and the organizations they belonged to at
-- the time (org_ids, for per-organization reports). last_seen_at moves forward when the app is opened again in the
-- same session; signed_out_at is set by POST /api/me/logout. Shown on Logs → Login activity (super admins, all
-- organizations) and Organization → Login activity (org admins, their organization).

create table if not exists public.login_events (
  id             bigint generated always as identity primary key,
  session_id     uuid not null unique,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  email          text,
  method         text,              -- password | oauth | sso/saml | otp | magiclink | invite | recovery | ...
  provider       text,              -- email | google | azure | ...
  ip             text,
  user_agent     text,
  org_ids        uuid[] not null default '{}',
  signed_in_at   timestamptz not null,
  last_seen_at   timestamptz not null default now(),
  signed_out_at  timestamptz
);
create index if not exists login_events_time_idx on public.login_events (signed_in_at desc);
create index if not exists login_events_user_idx on public.login_events (user_id, signed_in_at desc);
create index if not exists login_events_orgs_idx on public.login_events using gin (org_ids);

-- Service role only (the API); no browser access.
alter table public.login_events enable row level security;
