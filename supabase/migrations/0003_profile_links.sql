-- Extra foreign keys to profiles so PostgREST can embed user details, e.g.
--   org_members?select=role,profile:profiles(email,display_name)
alter table public.org_members
  drop constraint if exists org_members_profile_fk,
  add constraint org_members_profile_fk foreign key (user_id) references public.profiles (id) on delete cascade;

alter table public.abstract_edits
  drop constraint if exists abstract_edits_profile_fk,
  add constraint abstract_edits_profile_fk foreign key (edited_by) references public.profiles (id) on delete set null;

alter table public.org_invites
  drop constraint if exists org_invites_inviter_profile_fk,
  add constraint org_invites_inviter_profile_fk foreign key (invited_by) references public.profiles (id) on delete set null;

alter table public.lease_files
  drop constraint if exists lease_files_uploader_profile_fk,
  add constraint lease_files_uploader_profile_fk foreign key (uploaded_by) references public.profiles (id) on delete set null;
