-- Run this in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).

create table if not exists public.leases (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  title            text not null,
  tenant_name      text,
  landlord_name    text,
  property_address text,
  start_date       date,
  end_date         date,
  monthly_rent     numeric(12, 2),
  notes            text,
  status           text not null default 'uploaded',
  file_name        text not null,
  file_path        text not null,
  file_size        bigint,
  mime_type        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists leases_user_id_idx on public.leases (user_id);
create index if not exists leases_end_date_idx on public.leases (end_date);

-- The API uses the service role (which bypasses RLS) and always filters by user_id.
-- These policies keep the table safe if it is ever queried directly with a user key.
alter table public.leases enable row level security;

drop policy if exists "Users read own leases" on public.leases;
create policy "Users read own leases" on public.leases
  for select using (auth.uid() = user_id);

drop policy if exists "Users insert own leases" on public.leases;
create policy "Users insert own leases" on public.leases
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users update own leases" on public.leases;
create policy "Users update own leases" on public.leases
  for update using (auth.uid() = user_id);

drop policy if exists "Users delete own leases" on public.leases;
create policy "Users delete own leases" on public.leases
  for delete using (auth.uid() = user_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leases_set_updated_at on public.leases;
create trigger leases_set_updated_at
  before update on public.leases
  for each row execute function public.set_updated_at();

-- Private storage bucket for lease documents.
insert into storage.buckets (id, name, public)
values ('leases', 'leases', false)
on conflict (id) do nothing;
