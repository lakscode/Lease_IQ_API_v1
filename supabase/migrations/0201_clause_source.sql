-- Which classifier produced a clause (owned by the leases area).
--   claude: Claude AI (abstract / re-classification steps, CLAUSE_TYPES taxonomy)
--   svm:    local SVM model (lib/clause-svm.ts, API/svm/lease_clauses.json taxonomy)
alter table public.clauses add column if not exists source text not null default 'claude';
alter table public.clauses drop constraint if exists clauses_source_check;
alter table public.clauses add constraint clauses_source_check check (source in ('claude', 'svm'));
create index if not exists clauses_document_source_idx on public.clauses (document_id, source);
