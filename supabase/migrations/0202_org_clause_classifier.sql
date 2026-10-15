-- Per-organization clause classifier, chosen by super admins (owned by the leases area).
--   claude:  Claude AI (the abstract step classifies clauses into CLAUSE_TYPES)
--   svm:     local SVM model (lib/clause-svm.ts, lease_clauses.json taxonomy)
--   gateway: an LLM through Vercel AI Gateway; clause_model is the gateway model id, e.g. 'openai/gpt-5'
alter table public.organizations add column if not exists clause_classifier text not null default 'claude';
alter table public.organizations add column if not exists clause_model text;
alter table public.organizations drop constraint if exists organizations_clause_classifier_check;
alter table public.organizations add constraint organizations_clause_classifier_check
  check (clause_classifier in ('claude', 'svm', 'gateway') and (clause_classifier <> 'gateway' or clause_model is not null));

-- clauses.source (0201) gains 'gateway'; clauses.model records the model that produced the clause.
alter table public.clauses add column if not exists model text;
alter table public.clauses drop constraint if exists clauses_source_check;
alter table public.clauses add constraint clauses_source_check check (source in ('claude', 'svm', 'gateway'));
