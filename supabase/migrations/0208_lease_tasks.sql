-- Follow-up tasks on a lease (owned by the leases area). Created by hand or from an action item of a supporting
-- document's AI review ("Track"). Open tasks that are overdue or due soon show up as lease alerts.

create table if not exists public.lease_tasks (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  lease_id       uuid not null references public.leases (id) on delete cascade,
  title          text not null,
  due_date       date,
  done           boolean not null default false,
  done_at        timestamptz,
  attachment_id  uuid references public.attachments (id) on delete set null,   -- source supporting document, if any
  created_by     uuid,
  created_at     timestamptz not null default now()
);
alter table public.lease_tasks
  drop constraint if exists lease_tasks_profile_fk,
  add constraint lease_tasks_profile_fk foreign key (created_by) references public.profiles (id) on delete set null;
create index if not exists lease_tasks_lease_idx on public.lease_tasks (org_id, lease_id, done, due_date);

alter table public.lease_tasks enable row level security;
drop policy if exists "org read" on public.lease_tasks;
create policy "org read" on public.lease_tasks for select using (public.can_read_org(org_id));
drop policy if exists "org write" on public.lease_tasks;
create policy "org write" on public.lease_tasks for all using (public.can_edit_org(org_id)) with check (public.can_edit_org(org_id));
