-- Per-organization AI provider for document processing (OCR, split, abstract, signatures, clauses, insights, reviews),
-- chosen by super admins:
--   claude: Anthropic Claude (ai_model: a Claude model id; null = the app-wide model in app_settings.ai_model)
--   openai: OpenAI GPT through the Responses API (ai_model: an OpenAI model id; null = the default, gpt-5.5)
alter table public.organizations add column if not exists ai_provider text not null default 'claude';
alter table public.organizations add column if not exists ai_model text;
alter table public.organizations drop constraint if exists organizations_ai_provider_check;
alter table public.organizations add constraint organizations_ai_provider_check check (ai_provider in ('claude', 'openai'));

-- clauses.source gains 'openai': clauses classified by GPT during abstraction (clause classifier 'claude' = the org's AI).
alter table public.clauses drop constraint if exists clauses_source_check;
alter table public.clauses add constraint clauses_source_check check (source in ('claude', 'svm', 'gateway', 'langchain', 'llama', 'openai', 'user'));
