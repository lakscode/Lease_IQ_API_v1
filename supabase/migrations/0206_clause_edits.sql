-- Editing predicted clauses (owned by the leases area): users can change a clause's type, mark it verified, or
-- remove (dismiss) a wrong prediction. Every change is recorded in clause_edits and shown in the Activity tab.
-- User edits survive re-classification: replaceClauses re-applies them to clauses with the same text.

alter table public.clauses add column if not exists original_clause_type text;   -- predicted type, when a user changed it
alter table public.clauses add column if not exists verified boolean not null default false;
alter table public.clauses add column if not exists dismissed boolean not null default false;
alter table public.clauses add column if not exists edited_by uuid references auth.users (id) on delete set null;
alter table public.clauses add column if not exists edited_at timestamptz;

-- Append-only history. No FK on clause_id: clauses are replaced on re-classification, the history stays.
create table if not exists public.clause_edits (
  id           bigserial primary key,
  org_id       uuid not null references public.organizations (id) on delete cascade,
  document_id  uuid not null references public.documents (id) on delete cascade,
  lease_id     uuid,
  clause_id    uuid,
  clause_text  text,                 -- excerpt at the time of the edit (first 300 characters)
  action       text not null check (action in ('type', 'verify', 'unverify', 'dismiss', 'restore')),
  old_value    text,
  new_value    text,
  edited_by    uuid,
  edited_at    timestamptz not null default now()
);
alter table public.clause_edits
  drop constraint if exists clause_edits_profile_fk,
  add constraint clause_edits_profile_fk foreign key (edited_by) references public.profiles (id) on delete set null;
create index if not exists clause_edits_document_idx on public.clause_edits (document_id, edited_at desc);
create index if not exists clause_edits_lease_idx on public.clause_edits (org_id, lease_id, edited_at desc);

alter table public.clause_edits enable row level security;
drop policy if exists "org read" on public.clause_edits;
create policy "org read" on public.clause_edits for select using (public.can_read_org(org_id));
drop policy if exists "org write" on public.clause_edits;
create policy "org write" on public.clause_edits for all using (public.can_edit_org(org_id)) with check (public.can_edit_org(org_id));
