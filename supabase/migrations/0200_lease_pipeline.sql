-- Lease ingestion pipeline state (owned by the leases area).
-- lease_files.work holds the resumable pipeline state between steps:
--   { mode: 'analysis'|'reanalysis', documents: [{index, doc_type, title, effective_date, page_start, page_end, document_id}],
--     previous: [{lease_id, doc_type, page_start, page_end}], touched_lease_ids: [] }
-- lease_file_pages holds the per-page text of the original upload (extracted or OCR'd).

alter table public.lease_files add column if not exists work jsonb not null default '{}'::jsonb;

create table if not exists public.lease_file_pages (
  file_id      uuid not null references public.lease_files (id) on delete cascade,
  org_id       uuid not null references public.organizations (id) on delete cascade,
  page_number  integer not null,          -- 1-based within the uploaded file
  text         text not null default '',
  source       text not null default 'text' check (source in ('text','ocr')),
  primary key (file_id, page_number)
);
create index if not exists lease_file_pages_org_idx on public.lease_file_pages (org_id);

alter table public.lease_file_pages enable row level security;
drop policy if exists "org read" on public.lease_file_pages;
create policy "org read" on public.lease_file_pages for select using (public.can_read_org(org_id));
drop policy if exists "org write" on public.lease_file_pages;
create policy "org write" on public.lease_file_pages for all using (public.can_edit_org(org_id)) with check (public.can_edit_org(org_id));
