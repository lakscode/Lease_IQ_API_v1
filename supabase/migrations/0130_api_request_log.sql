-- API request log: one row per API request, successful or not (method, path, status, duration, who, which org,
-- and the error for 4xx/5xx). Written by the API's request middleware (app.ts); readable by super admins
-- (Logs → API logs, GET /api/logs/api). Rows older than 30 days are pruned by the API as it writes.

create table if not exists public.api_request_log (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  method         text not null,
  path           text not null,                -- without the query string
  query          text,                         -- the query string, if any
  status         integer not null,
  duration_ms    integer not null,
  user_id        uuid,                         -- no FKs so entries survive user/org deletion
  email          text,
  org_id         uuid,
  error_code     text,                         -- `code` of an error response ({ error, code })
  error_message  text,
  ip             text,
  user_agent     text,
  runtime        text                          -- 'edge' (Supabase) or 'node' (local server)
);
create index if not exists api_request_log_created_idx on public.api_request_log (created_at desc);
create index if not exists api_request_log_status_idx on public.api_request_log (status, created_at desc);
create index if not exists api_request_log_path_idx on public.api_request_log (path, created_at desc);

alter table public.api_request_log enable row level security;
drop policy if exists "super admin read" on public.api_request_log;
create policy "super admin read" on public.api_request_log for select using (public.is_super_admin());
revoke insert, update, delete on public.api_request_log from anon, authenticated;
