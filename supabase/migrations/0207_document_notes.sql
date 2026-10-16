-- Notes on lease document PDFs (owned by the leases area): a user selects text on a page of a document's PDF and
-- attaches a note to it. The highlight is stored as rectangles in page coordinates normalized to 0..1 (x, y from the
-- top-left, w, h), so it lines up at any zoom level. A note without rectangles is a note on the whole page (used for
-- scanned pages, which have no selectable text). Notes belong to the document: re-processing the source file
-- replaces its documents and removes their notes.

create table if not exists public.document_notes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  lease_id     uuid references public.leases (id) on delete set null,
  document_id  uuid not null references public.documents (id) on delete cascade,
  page         integer not null check (page >= 1),
  quote        text,                                    -- the selected text (up to 2000 characters)
  rects        jsonb not null default '[]'::jsonb,      -- [{ x, y, w, h }] normalized to the page
  color        text not null default 'yellow' check (color in ('yellow', 'green', 'blue', 'pink')),
  body         text not null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.document_notes
  drop constraint if exists document_notes_profile_fk,
  add constraint document_notes_profile_fk foreign key (created_by) references public.profiles (id) on delete set null;
create index if not exists document_notes_document_idx on public.document_notes (document_id, page, created_at);
create index if not exists document_notes_lease_idx on public.document_notes (org_id, lease_id);

alter table public.document_notes enable row level security;
drop policy if exists "org read" on public.document_notes;
create policy "org read" on public.document_notes for select using (public.can_read_org(org_id));
drop policy if exists "org write" on public.document_notes;
create policy "org write" on public.document_notes for all using (public.can_edit_org(org_id)) with check (public.can_edit_org(org_id));
