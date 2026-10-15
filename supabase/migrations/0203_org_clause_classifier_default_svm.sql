-- New organizations classify clauses with the local SVM by default (no AI tokens). Existing organizations keep
-- their current setting. Super admins can change it per organization in Settings -> Organizations.
alter table public.organizations alter column clause_classifier set default 'svm';
