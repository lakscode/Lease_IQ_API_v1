-- Lease review after abstraction (owned by the leases area): one row per lease with the reviewer's verdict on each
-- checklist item (basic abstract fields and expected clauses, from lib/review-checklist.json), the last AI check and
-- a summary for the leases list. Automatic checks are computed on read and not stored.

create table if not exists public.lease_reviews (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  lease_id      uuid not null references public.leases (id) on delete cascade,
  status        text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  items         jsonb not null default '{"fields": {}, "clauses": {}}'::jsonb,  -- { fields|clauses: { key: { verdict, note, by, at } } }
  ai            jsonb,                                                        -- last AI check: { checked_at, fields, clauses }
  summary       jsonb,                                                        -- { issues, reviewed, total, correct, incorrect }
  started_by    uuid,
  completed_by  uuid,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists lease_reviews_lease_idx on public.lease_reviews (lease_id);
create index if not exists lease_reviews_org_idx on public.lease_reviews (org_id, status);
alter table public.lease_reviews
  drop constraint if exists lease_reviews_started_by_fk,
  add constraint lease_reviews_started_by_fk foreign key (started_by) references public.profiles (id) on delete set null;
alter table public.lease_reviews
  drop constraint if exists lease_reviews_completed_by_fk,
  add constraint lease_reviews_completed_by_fk foreign key (completed_by) references public.profiles (id) on delete set null;

alter table public.lease_reviews enable row level security;
drop policy if exists "org read" on public.lease_reviews;
create policy "org read" on public.lease_reviews for select using (public.can_read_org(org_id));
drop policy if exists "org write" on public.lease_reviews;
create policy "org write" on public.lease_reviews for all using (public.can_edit_org(org_id)) with check (public.can_edit_org(org_id));
