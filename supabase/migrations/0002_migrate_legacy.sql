-- One-time move from the v1 single-user model to organizations.
-- 1. Profiles for every existing auth user.
-- 2. A default organization "Lease IQ" holding every existing user.
--    admin@leaseiq.test becomes a super admin (or, failing that, the earliest user).
-- 3. Each legacy lease row becomes a queued lease_file in that org, so it is analysed by the new pipeline.

insert into public.profiles (id, email, display_name)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name')
from auth.users u
on conflict (id) do nothing;

do $$
declare
  v_org uuid;
  v_admin uuid;
begin
  if exists (select 1 from public.organizations) then
    return;  -- already migrated / fresh install with orgs
  end if;
  if not exists (select 1 from auth.users) then
    return;
  end if;

  select id into v_admin from auth.users where email = 'admin@leaseiq.test';
  if v_admin is null then
    select id into v_admin from auth.users order by created_at limit 1;
  end if;

  insert into public.organizations (name, created_by) values ('Lease IQ', v_admin) returning id into v_org;

  update public.profiles set is_super_admin = true where id = v_admin;

  insert into public.org_members (org_id, user_id, role)
  select v_org, u.id,
         case when u.id = v_admin then 'admin'
              when u.email like 'manager@%' then 'editor'
              else 'viewer' end
  from auth.users u
  on conflict do nothing;

  update public.profiles set default_org_id = v_org where default_org_id is null;

  if to_regclass('public.leases_legacy') is not null then
    execute format($f$
      insert into public.lease_files (org_id, uploaded_by, file_name, storage_path, file_size, status, created_at)
      select %L, l.user_id, l.file_name, l.file_path, l.file_size, 'queued', l.created_at
      from public.leases_legacy l
      where l.mime_type = 'application/pdf'
    $f$, v_org);
  end if;
end $$;
