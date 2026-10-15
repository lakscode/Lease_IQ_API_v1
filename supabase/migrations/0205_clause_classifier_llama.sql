-- Separate LangChain and Llama clause classifiers (owned by the leases area):
--   langchain: a LangChain.js chain with any Vercel AI Gateway model (clause_model; null = openai/gpt-5.4-mini)
--   llama:     a Meta Llama model called directly through the Vercel AI SDK (clause_model; null = meta/llama-4-scout)
alter table public.organizations drop constraint if exists organizations_clause_classifier_check;
alter table public.organizations add constraint organizations_clause_classifier_check
  check (clause_classifier in ('claude', 'svm', 'gateway', 'langchain', 'llama') and (clause_classifier <> 'gateway' or clause_model is not null));

alter table public.clauses drop constraint if exists clauses_source_check;
alter table public.clauses add constraint clauses_source_check check (source in ('claude', 'svm', 'gateway', 'langchain', 'llama'));
