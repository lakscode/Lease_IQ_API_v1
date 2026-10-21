-- Training examples for Settings → Train model (super admins), kept in the database rather than the Edge Function
-- bundle (the bundle has a size limit). `npm run svm:train` uploads the examples from svm/training_data as the 'base'
-- set: data = JSON { trained_at, examples: [text, clause id][] }.

create table if not exists public.clause_training_sets (
  name        text primary key,
  data        text not null,
  examples    integer not null,
  updated_at  timestamptz not null default now()
);

-- Service role only (the API and scripts); no browser access.
alter table public.clause_training_sets enable row level security;
