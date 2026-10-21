-- Retrained clause SVM models (Settings → Train model, super admins). The super admin's browser trains the model on
-- svm/training_data plus clauses users added, re-typed or verified, and uploads it here. At most one row is active;
-- app_settings.svm_model = { id, trained_at } points at it, and lib/clause-svm.ts loads it instead of the bundled
-- model (lib/clause-svm-model.ts). No active row = the bundled model.

create table if not exists public.clause_models (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  created_by         uuid,
  trained_at         timestamptz not null,
  model              text not null,                 -- SvmModel JSON (lib/clause-svm-features.ts)
  examples           integer not null,              -- training examples in total
  feedback_examples  integer not null default 0,    -- of which from users' clauses
  feedback_through   timestamptz,                   -- newest user clause change included
  metrics            jsonb,                         -- cross-validation: accuracy, macro_f1, examples, calibration
  active             boolean not null default false
);
create unique index if not exists clause_models_one_active on public.clause_models (active) where active;
create index if not exists clause_models_created_idx on public.clause_models (created_at desc);
alter table public.clause_models
  drop constraint if exists clause_models_profile_fk,
  add constraint clause_models_profile_fk foreign key (created_by) references public.profiles (id) on delete set null;

-- Service role only (the API); no browser access.
alter table public.clause_models enable row level security;

-- Finding users' clauses for training: changed or added clauses across all organizations.
create index if not exists clauses_feedback_idx on public.clauses (edited_at) where edited_at is not null;
