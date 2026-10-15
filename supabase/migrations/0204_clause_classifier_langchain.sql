-- LangChain (Llama) clause classifier (owned by the leases area): a LangChain.js chain labels clause segments with
-- lease_clauses.json types using a Llama model through Vercel AI Gateway. clause_model is the Llama model id
-- (null = the default, meta/llama-4-scout).
alter table public.organizations drop constraint if exists organizations_clause_classifier_check;
alter table public.organizations add constraint organizations_clause_classifier_check
  check (clause_classifier in ('claude', 'svm', 'gateway', 'langchain') and (clause_classifier <> 'gateway' or clause_model is not null));

alter table public.clauses drop constraint if exists clauses_source_check;
alter table public.clauses add constraint clauses_source_check check (source in ('claude', 'svm', 'gateway', 'langchain'));
