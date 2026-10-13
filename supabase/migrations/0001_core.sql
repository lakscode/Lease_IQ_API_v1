-- Lease IQ core schema. Applied by `npm run db:migrate` (tracked in public.schema_migrations).
-- The API uses the service role and enforces roles itself; RLS policies below are defence in depth
-- for any direct access with a user JWT.

create extension if not exists pgcrypto;

-- v1 had a flat public.leases table (one row per uploaded file). Keep it as leases_legacy;
-- 0002_migrate_legacy.sql moves its rows into the new model.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'leases' and column_name = 'file_path') then
    alter table public.leases rename to leases_legacy;
    drop policy if exists "Users read own leases" on public.leases_legacy;
    drop policy if exists "Users insert own leases" on public.leases_legacy;
    drop policy if exists "Users update own leases" on public.leases_legacy;
    drop policy if exists "Users delete own leases" on public.leases_legacy;
    drop trigger if exists leases_set_updated_at on public.leases_legacy;
    alter index if exists leases_user_id_idx rename to leases_legacy_user_id_idx;
    alter index if exists leases_end_date_idx rename to leases_legacy_end_date_idx;
    alter table public.leases_legacy rename constraint leases_pkey to leases_legacy_pkey;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Accounts & organizations
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text,
  display_name    text,
  is_super_admin  boolean not null default false,
  default_org_id  uuid,
  locale          text not null default 'en' check (locale in ('en','de','es','pt','it')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  currency    text not null default 'USD',
  logo_path   text,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles
  drop constraint if exists profiles_default_org_fk,
  add constraint profiles_default_org_fk foreign key (default_org_id) references public.organizations (id) on delete set null;

create table if not exists public.org_members (
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('admin','editor','viewer')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on public.org_members (user_id);

-- People an admin removed are never re-added automatically by domain join.
create table if not exists public.org_member_removals (
  org_id      uuid not null references public.organizations (id) on delete cascade,
  email       text not null,
  removed_by  uuid references auth.users (id) on delete set null,
  removed_at  timestamptz not null default now(),
  primary key (org_id, email)
);

create table if not exists public.org_domains (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  domain        text not null unique,
  default_role  text not null default 'viewer' check (default_role in ('admin','editor','viewer')),
  ms_tenant_id  text,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create table if not exists public.org_invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  email        text not null,
  role         text not null check (role in ('admin','editor','viewer')),
  token_hash   text not null unique,
  status       text not null default 'pending' check (status in ('pending','accepted','revoked')),
  expires_at   timestamptz not null,
  invited_by   uuid references auth.users (id) on delete set null,
  accepted_by  uuid references auth.users (id) on delete set null,
  accepted_at  timestamptz,
  email_sent   boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists org_invites_org_idx on public.org_invites (org_id, status);

create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Lease ingestion
-- ---------------------------------------------------------------------------

-- One uploaded file (may be a bundle of several documents).
create table if not exists public.lease_files (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete cascade,
  uploaded_by        uuid references auth.users (id) on delete set null,
  file_name          text not null,
  storage_path       text not null,
  file_size          bigint,
  sha256             text,
  page_count         integer,
  is_scanned         boolean,
  source             text not null default 'computer' check (source in ('computer','google_drive','onedrive','sharepoint')),
  target_lease_id    uuid,             -- set when uploaded as an amendment to an existing lease
  status             text not null default 'queued' check (status in ('queued','processing','completed','failed')),
  error              text,
  steps              jsonb not null default '[]'::jsonb,  -- [{name,status,started_at,finished_at,detail}]
  lock_until         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  processed_at       timestamptz
);
create index if not exists lease_files_org_idx on public.lease_files (org_id, created_at desc);

create table if not exists public.processing_logs (
  id          bigserial primary key,
  org_id      uuid not null references public.organizations (id) on delete cascade,
  file_id     uuid not null references public.lease_files (id) on delete cascade,
  step        text,
  level       text not null default 'info' check (level in ('info','warn','error')),
  message     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists processing_logs_file_idx on public.processing_logs (file_id, id);

-- A lease "family": one main lease plus its amendments, addenda and letters.
create table if not exists public.leases (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations (id) on delete cascade,
  main_document_id     uuid,
  -- Current terms "as amended" (denormalised by the API after every change; see lib/lease-terms.ts)
  tenant_name          text,
  landlord_name        text,
  premises_address     text,
  rentable_area        numeric,
  commencement_date    date,
  expiration_date      date,
  base_rent_monthly    numeric,
  status               text not null default 'unknown' check (status in ('active','expiring','expired','renewed','unknown')),
  current_terms        jsonb not null default '{}'::jsonb,   -- {field: {value, source_document_id}}
  property_type        text,
  market_rate_id       uuid,
  market_rate_override numeric,      -- annual $/RSF override
  risk_score           integer,
  risk_reasons         jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists leases_org_idx on public.leases (org_id);
create index if not exists leases_expiration_idx on public.leases (org_id, expiration_date);

create table if not exists public.documents (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  file_id        uuid references public.lease_files (id) on delete set null,
  lease_id       uuid references public.leases (id) on delete set null,
  doc_type       text not null check (doc_type in ('main_lease','amendment','addendum','commencement_letter','other')),
  title          text,
  page_start     integer,
  page_end       integer,
  page_count     integer,
  storage_path   text,
  sha256         text,             -- document of record fingerprint (immutable, see trigger)
  effective_date date,
  abstract       jsonb not null default '{}'::jsonb,   -- see API lib/abstract.ts for the field list
  summary        text,
  changes_made   text,
  signature      jsonb,            -- {status, method, parties:[{party,signer,date}], checked_at, notes}
  is_scanned     boolean,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists documents_lease_idx on public.documents (lease_id);
create index if not exists documents_file_idx on public.documents (file_id);
create index if not exists documents_org_idx on public.documents (org_id, doc_type);

alter table public.leases
  drop constraint if exists leases_main_document_fk,
  add constraint leases_main_document_fk foreign key (main_document_id) references public.documents (id) on delete set null;

create or replace function public.prevent_sha_change() returns trigger language plpgsql as $$
begin
  if old.sha256 is not null and new.sha256 is distinct from old.sha256 then
    raise exception 'Document fingerprint is immutable';
  end if;
  return new;
end $$;
drop trigger if exists documents_sha_immutable on public.documents;
create trigger documents_sha_immutable before update on public.documents
  for each row execute function public.prevent_sha_change();

create table if not exists public.document_pages (
  document_id  uuid not null references public.documents (id) on delete cascade,
  org_id       uuid not null references public.organizations (id) on delete cascade,
  page_number  integer not null,          -- 1-based within the document
  text         text not null default '',
  tsv          tsvector generated always as (to_tsvector('simple', coalesce(text, ''))) stored,
  primary key (document_id, page_number)
);
create index if not exists document_pages_tsv_idx on public.document_pages using gin (tsv);
create index if not exists document_pages_org_idx on public.document_pages (org_id);

create table if not exists public.clauses (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  document_id   uuid not null references public.documents (id) on delete cascade,
  lease_id      uuid references public.leases (id) on delete set null,
  clause_type   text not null,
  confidence    numeric,
  alt_types     jsonb,               -- [{type, confidence}]
  section       text,
  page          integer,
  paragraph     integer,
  line          integer,
  text          text,
  created_at    timestamptz not null default now()
);
create index if not exists clauses_document_idx on public.clauses (document_id);
create index if not exists clauses_lease_type_idx on public.clauses (lease_id, clause_type);

create table if not exists public.abstract_edits (
  id           bigserial primary key,
  org_id       uuid not null references public.organizations (id) on delete cascade,
  document_id  uuid not null references public.documents (id) on delete cascade,
  lease_id     uuid,
  field        text not null,
  old_value    jsonb,
  new_value    jsonb,
  edited_by    uuid references auth.users (id) on delete set null,
  edited_at    timestamptz not null default now()
);
create index if not exists abstract_edits_document_idx on public.abstract_edits (document_id, edited_at desc);

-- Append-only access log. No FKs on lease/document/file so entries survive deletion.
create table if not exists public.access_log (
  id           bigserial primary key,
  org_id       uuid not null references public.organizations (id) on delete cascade,
  lease_id     uuid,
  document_id  uuid,
  file_id      uuid,
  user_id      uuid,
  action       text not null check (action in ('upload','view','download','report_download','save','email','edit','verify','delete')),
  details      jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists access_log_lease_idx on public.access_log (lease_id, created_at desc);
create index if not exists access_log_document_idx on public.access_log (document_id, created_at desc);

create or replace function public.access_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'access_log is append-only';
end $$;
drop trigger if exists access_log_no_update on public.access_log;
create trigger access_log_no_update before update or delete on public.access_log
  for each row execute function public.access_log_append_only();

-- ---------------------------------------------------------------------------
-- Supporting documents
-- ---------------------------------------------------------------------------

create table if not exists public.attachments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  lease_id      uuid not null references public.leases (id) on delete cascade,
  file_name     text not null,
  storage_path  text not null,
  mime_type     text,
  file_size     bigint,
  category      text check (category in ('exhibit','insurance','estoppel','snda','financial_statement','correspondence','notice','invoice','other')),
  doc_date      date,
  notes         text,
  status        text not null default 'queued' check (status in ('queued','processing','completed','failed')),
  error         text,
  ai_review     jsonb,      -- {summary,key_date,amount,fields:{},action_items:[{text,due_date}],issues:[{text,severity}],suggested_category}
  uploaded_by   uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists attachments_lease_idx on public.attachments (lease_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Lease Assistant
-- ---------------------------------------------------------------------------

create table if not exists public.chat_conversations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  title        text,
  lease_id     uuid references public.leases (id) on delete set null,
  document_id  uuid references public.documents (id) on delete set null,
  total_input_tokens   integer not null default 0,
  total_output_tokens  integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists chat_conversations_user_idx on public.chat_conversations (org_id, user_id, updated_at desc);

create table if not exists public.chat_messages (
  id               bigserial primary key,
  conversation_id  uuid not null references public.chat_conversations (id) on delete cascade,
  role             text not null check (role in ('user','assistant')),
  content          text not null,
  citations        jsonb,    -- [{document_id, lease_id, title, page, quote}]
  usage            jsonb,    -- {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}
  created_at       timestamptz not null default now()
);
create index if not exists chat_messages_conversation_idx on public.chat_messages (conversation_id, id);

-- ---------------------------------------------------------------------------
-- Opportunities & financial tools
-- ---------------------------------------------------------------------------

create table if not exists public.lease_insights (
  lease_id       uuid primary key references public.leases (id) on delete cascade,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  rent_schedule  jsonb,      -- [{start, end, monthly_rent, annual_rent, rent_psf, abatement, note}]
  cam_terms      jsonb,      -- {pro_rata_share, admin_fee_pct, gross_up_pct, cap_pct, cap_cumulative, cap_controllable_only, base_year, notes}
  status         text not null default 'none' check (status in ('none','processing','completed','failed')),
  error          text,
  generated_at   timestamptz,
  updated_at     timestamptz not null default now()
);

create table if not exists public.opportunities (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  lease_id    uuid not null references public.leases (id) on delete cascade,
  category    text not null,
  kind        text not null check (kind in ('revenue','risk')),
  status      text not null check (status in ('action','watch','none','needs_data')),
  priority    text check (priority in ('high','medium','low')),
  summary     text,
  due_date    date,
  amount      numeric,
  citations   jsonb,          -- [{document_id, page, quote}]
  created_at  timestamptz not null default now()
);
create index if not exists opportunities_lease_idx on public.opportunities (lease_id);
create index if not exists opportunities_org_idx on public.opportunities (org_id, status);

create table if not exists public.rent_audits (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  lease_id     uuid not null references public.leases (id) on delete cascade,
  start_month  date not null,
  end_month    date not null,
  rows         jsonb not null,     -- [{month, lease_rent, billed_rent, difference}]
  totals       jsonb not null,     -- {lease, billed, under, over, net}
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (lease_id, start_month, end_month)
);

create table if not exists public.cam_reconciliations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  lease_id    uuid not null references public.leases (id) on delete cascade,
  year        integer not null,
  inputs      jsonb not null,
  result      jsonb not null,
  created_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  unique (lease_id, year)
);

create table if not exists public.market_rates (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  property_type    text not null,
  rate_psf_annual  numeric not null,
  source           text,
  as_of            date,
  address_match    text,           -- optional substring/city match applied to premises address
  created_at       timestamptz not null default now()
);
create index if not exists market_rates_org_idx on public.market_rates (org_id);

alter table public.leases
  drop constraint if exists leases_market_rate_fk,
  add constraint leases_market_rate_fk foreign key (market_rate_id) references public.market_rates (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Rent roll import
-- ---------------------------------------------------------------------------

create table if not exists public.rent_roll_imports (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  source         text not null check (source in ('yardi','mri','csv')),
  file_name      text,
  mapping        jsonb,
  row_count      integer not null default 0,
  matched_count  integer not null default 0,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now()
);

create table if not exists public.rent_roll_records (
  id                    uuid primary key default gen_random_uuid(),
  import_id             uuid not null references public.rent_roll_imports (id) on delete cascade,
  org_id                uuid not null references public.organizations (id) on delete cascade,
  lease_id              uuid references public.leases (id) on delete set null,
  match_confidence      numeric,
  tenant                text,
  external_id           text,
  property              text,
  unit                  text,
  status                text,
  start_date            date,
  end_date              date,
  area                  numeric,
  monthly_base_rent     numeric,
  annual_base_rent      numeric,
  cam                   numeric,
  tax                   numeric,
  insurance             numeric,
  other_charges         numeric,
  security_deposit      numeric,
  next_escalation_date  date,
  next_escalation_rent  numeric,
  charge_codes          jsonb,
  raw                   jsonb
);
create index if not exists rent_roll_records_lease_idx on public.rent_roll_records (lease_id);
create index if not exists rent_roll_records_import_idx on public.rent_roll_records (import_id);

-- ---------------------------------------------------------------------------
-- AI usage
-- ---------------------------------------------------------------------------

create table if not exists public.ai_usage (
  id                     bigserial primary key,
  org_id                 uuid references public.organizations (id) on delete set null,
  user_id                uuid,
  process                text not null check (process in ('analysis','reanalysis','chat','insights','attachment','signature','ocr')),
  model                  text not null,
  input_tokens           integer not null default 0,
  output_tokens          integer not null default 0,
  cache_creation_tokens  integer not null default 0,
  cache_read_tokens      integer not null default 0,
  duration_ms            integer,
  file_id                uuid,
  lease_id               uuid,
  conversation_id        uuid,
  created_at             timestamptz not null default now()
);
create index if not exists ai_usage_org_created_idx on public.ai_usage (org_id, created_at desc);
create index if not exists ai_usage_file_idx on public.ai_usage (file_id);

-- ---------------------------------------------------------------------------
-- Helpers, triggers, RLS
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','organizations','lease_files','leases','documents','attachments','chat_conversations','lease_insights','cam_reconciliations'] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- Create a profile for every new auth user.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'))
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.handle_user_email_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email) execute function public.handle_user_email_change();

create or replace function public.is_super_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_super_admin from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.org_role(p_org uuid) returns text language sql stable security definer set search_path = public as $$
  select case when public.is_super_admin() then 'admin'
              else (select role from public.org_members where org_id = p_org and user_id = auth.uid()) end
$$;

create or replace function public.can_read_org(p_org uuid) returns boolean language sql stable as $$
  select public.org_role(p_org) is not null
$$;

create or replace function public.can_edit_org(p_org uuid) returns boolean language sql stable as $$
  select public.org_role(p_org) in ('admin','editor')
$$;

do $$
declare t text;
begin
  foreach t in array array['lease_files','processing_logs','leases','documents','document_pages','clauses','abstract_edits','access_log',
                           'attachments','lease_insights','opportunities','rent_audits','cam_reconciliations','market_rates',
                           'rent_roll_imports','rent_roll_records'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "org read" on public.%I', t);
    execute format('create policy "org read" on public.%I for select using (public.can_read_org(org_id))', t);
    execute format('drop policy if exists "org write" on public.%I', t);
    if t <> 'access_log' then
      execute format('create policy "org write" on public.%I for all using (public.can_edit_org(org_id)) with check (public.can_edit_org(org_id))', t);
    end if;
  end loop;
end $$;

alter table public.profiles enable row level security;
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (id = auth.uid() or public.is_super_admin());
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update using (id = auth.uid());

alter table public.organizations enable row level security;
drop policy if exists "member read" on public.organizations;
create policy "member read" on public.organizations for select using (public.can_read_org(id));
drop policy if exists "admin update" on public.organizations;
create policy "admin update" on public.organizations for update using (public.org_role(id) = 'admin');

alter table public.org_members enable row level security;
drop policy if exists "member read" on public.org_members;
create policy "member read" on public.org_members for select using (public.can_read_org(org_id));
drop policy if exists "admin write" on public.org_members;
create policy "admin write" on public.org_members for all using (public.org_role(org_id) = 'admin') with check (public.org_role(org_id) = 'admin');

alter table public.org_invites enable row level security;
drop policy if exists "admin all" on public.org_invites;
create policy "admin all" on public.org_invites for all using (public.org_role(org_id) = 'admin') with check (public.org_role(org_id) = 'admin');

alter table public.org_domains enable row level security;
drop policy if exists "super admin all" on public.org_domains;
create policy "super admin all" on public.org_domains for all using (public.is_super_admin()) with check (public.is_super_admin());

alter table public.org_member_removals enable row level security;
alter table public.app_settings enable row level security;
drop policy if exists "super admin all" on public.app_settings;
create policy "super admin all" on public.app_settings for all using (public.is_super_admin()) with check (public.is_super_admin());

alter table public.chat_conversations enable row level security;
drop policy if exists "own chats" on public.chat_conversations;
create policy "own chats" on public.chat_conversations for all using (user_id = auth.uid() and public.can_read_org(org_id)) with check (user_id = auth.uid() and public.can_read_org(org_id));

alter table public.chat_messages enable row level security;
drop policy if exists "own chat messages" on public.chat_messages;
create policy "own chat messages" on public.chat_messages for all
  using (exists (select 1 from public.chat_conversations c where c.id = conversation_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.chat_conversations c where c.id = conversation_id and c.user_id = auth.uid()));

alter table public.ai_usage enable row level security;
drop policy if exists "admin read" on public.ai_usage;
create policy "admin read" on public.ai_usage for select using (public.org_role(org_id) = 'admin');

-- Storage buckets: private documents, public logos (logos appear in emails).
insert into storage.buckets (id, name, public) values ('leases', 'leases', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-logos', 'org-logos', true, 1048576, array['image/png','image/jpeg'])
on conflict (id) do nothing;

-- Full-text page search across an organization (used by the Lease Assistant).
create or replace function public.search_document_pages(p_org uuid, p_query text, p_limit integer default 20, p_document uuid default null)
returns table (document_id uuid, lease_id uuid, title text, page_number integer, snippet text, rank real)
language sql stable as $$
  select dp.document_id, d.lease_id, d.title, dp.page_number,
         ts_headline('simple', dp.text, websearch_to_tsquery('simple', p_query), 'MaxFragments=2, MaxWords=40, MinWords=15') as snippet,
         ts_rank(dp.tsv, websearch_to_tsquery('simple', p_query)) as rank
  from public.document_pages dp
  join public.documents d on d.id = dp.document_id
  where dp.org_id = p_org
    and (p_document is null or dp.document_id = p_document)
    and dp.tsv @@ websearch_to_tsquery('simple', p_query)
  order by rank desc
  limit p_limit
$$;
