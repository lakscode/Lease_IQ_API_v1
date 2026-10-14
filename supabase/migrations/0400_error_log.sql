-- Application error log: failures reported by the UI (e.g. sign-up) and the API.
-- Written only by the API (service role); readable by super admins (Settings → Error log).

create table if not exists public.error_log (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  source      text not null check (source in ('ui', 'api')),
  area        text not null,                 -- e.g. 'signup', 'signup.sso', 'signup.oauth'
  level       text not null default 'error' check (level in ('error', 'warning')),
  code        text,                          -- provider / API error code, e.g. 'over_email_send_rate_limit'
  message     text not null,
  details     jsonb,
  user_id     uuid,                          -- no FK so entries survive user deletion
  email       text,                          -- the address involved (sign-up has no user yet)
  path        text,                          -- page or API path
  user_agent  text
);
create index if not exists error_log_created_idx on public.error_log (created_at desc);
create index if not exists error_log_area_idx on public.error_log (area, created_at desc);

alter table public.error_log enable row level security;
drop policy if exists "super admin read" on public.error_log;
create policy "super admin read" on public.error_log for select using (public.is_super_admin());
revoke insert, update, delete on public.error_log from anon, authenticated;
