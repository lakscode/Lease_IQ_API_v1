-- Which AI provider and model abstracted each document, and the lease's latest one (organizations.ai_provider, 0211).
-- Null = abstracted before this migration (Claude) or not by AI.
alter table public.documents add column if not exists ai_provider text;
alter table public.documents add column if not exists ai_model text;
alter table public.documents drop constraint if exists documents_ai_provider_check;
alter table public.documents add constraint documents_ai_provider_check check (ai_provider is null or ai_provider in ('claude', 'openai'));

alter table public.leases add column if not exists ai_provider text;
alter table public.leases add column if not exists ai_model text;
alter table public.leases drop constraint if exists leases_ai_provider_check;
alter table public.leases add constraint leases_ai_provider_check check (ai_provider is null or ai_provider in ('claude', 'openai'));

-- Documents abstracted so far were all abstracted by Claude: record the provider (the model is unknown).
update public.documents set ai_provider = 'claude' where ai_provider is null and abstract is not null and abstract <> '{}'::jsonb;
update public.leases l set ai_provider = 'claude'
  where ai_provider is null and exists (select 1 from public.documents d where d.lease_id = l.id and d.ai_provider is not null);
