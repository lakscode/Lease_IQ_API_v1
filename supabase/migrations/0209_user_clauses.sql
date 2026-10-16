-- Clauses added by a user (owned by the leases area): text selected on a page of a document's PDF, tagged with a
-- clause type. They are stored with source 'user' next to the classifier predictions, keep the highlight position
-- (rects normalized to the page, as in document_notes), and are never replaced when the document is re-classified.
-- Adding or deleting one is recorded in clause_edits ('add' / 'delete').

alter table public.clauses drop constraint if exists clauses_source_check;
alter table public.clauses add constraint clauses_source_check check (source in ('claude', 'svm', 'gateway', 'langchain', 'llama', 'user'));
alter table public.clauses add column if not exists rects jsonb;            -- [{ x, y, w, h }] for user clauses
alter table public.clauses add column if not exists created_by uuid references auth.users (id) on delete set null;

alter table public.clause_edits drop constraint if exists clause_edits_action_check;
alter table public.clause_edits add constraint clause_edits_action_check
  check (action in ('type', 'verify', 'unverify', 'dismiss', 'restore', 'add', 'delete'));
