-- Fund administration (owned by the fund area): funds, investors (LPs) and their commitments, capital calls and
-- distributions split pro rata by commitment, NAV history, and the leases (properties) each fund holds.
-- Money is in the organization's currency. Capital accounts and fund metrics are computed by the API
-- (lib/fund-accounts.ts), not stored.

create table if not exists public.funds (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  name             text not null,
  strategy         text,                                    -- e.g. core, value-add, opportunistic, debt
  vintage_year     integer,
  inception_date   date,
  target_size      numeric(18,2),
  status           text not null default 'active' check (status in ('fundraising','active','harvesting','closed')),
  management_fee_pct numeric(6,3),                          -- annual, % of commitments
  carry_pct        numeric(6,3),                            -- carried interest, % of profits
  hurdle_pct       numeric(6,3),                            -- preferred return, % per year
  notes            text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists funds_org_idx on public.funds (org_id, name);

create table if not exists public.fund_investors (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  name             text not null,
  investor_type    text not null default 'institution'
                   check (investor_type in ('institution','pension','endowment','family_office','individual','fund_of_funds','gp','other')),
  contact_name     text,
  email            text,
  phone            text,
  notes            text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists fund_investors_org_idx on public.fund_investors (org_id, name);

create table if not exists public.fund_commitments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  fund_id          uuid not null references public.funds (id) on delete cascade,
  investor_id      uuid not null references public.fund_investors (id) on delete cascade,
  amount           numeric(18,2) not null check (amount > 0),
  commitment_date  date,
  created_at       timestamptz not null default now(),
  unique (fund_id, investor_id)
);
create index if not exists fund_commitments_org_idx on public.fund_commitments (org_id, fund_id);

create table if not exists public.fund_capital_calls (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  fund_id          uuid not null references public.funds (id) on delete cascade,
  call_number      integer not null,
  call_date        date not null,
  due_date         date,
  amount           numeric(18,2) not null check (amount > 0),
  purpose          text not null default 'investment' check (purpose in ('investment','management_fee','expenses','other')),
  notes            text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  unique (fund_id, call_number)
);
create index if not exists fund_capital_calls_org_idx on public.fund_capital_calls (org_id, fund_id, call_date);

create table if not exists public.fund_call_allocations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  call_id          uuid not null references public.fund_capital_calls (id) on delete cascade,
  investor_id      uuid not null references public.fund_investors (id) on delete cascade,
  amount           numeric(18,2) not null,
  paid_amount      numeric(18,2) not null default 0,
  paid_date        date,
  unique (call_id, investor_id)
);
create index if not exists fund_call_allocations_org_idx on public.fund_call_allocations (org_id, call_id);

create table if not exists public.fund_distributions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  fund_id             uuid not null references public.funds (id) on delete cascade,
  distribution_number integer not null,
  distribution_date   date not null,
  amount              numeric(18,2) not null check (amount > 0),
  distribution_type   text not null default 'income' check (distribution_type in ('income','return_of_capital','capital_gain','other')),
  notes               text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  unique (fund_id, distribution_number)
);
create index if not exists fund_distributions_org_idx on public.fund_distributions (org_id, fund_id, distribution_date);

create table if not exists public.fund_distribution_allocations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  distribution_id  uuid not null references public.fund_distributions (id) on delete cascade,
  investor_id      uuid not null references public.fund_investors (id) on delete cascade,
  amount           numeric(18,2) not null,
  unique (distribution_id, investor_id)
);
create index if not exists fund_distribution_allocations_org_idx on public.fund_distribution_allocations (org_id, distribution_id);

create table if not exists public.fund_valuations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  fund_id          uuid not null references public.funds (id) on delete cascade,
  as_of_date       date not null,
  nav              numeric(18,2) not null check (nav >= 0),
  notes            text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  unique (fund_id, as_of_date)
);
create index if not exists fund_valuations_org_idx on public.fund_valuations (org_id, fund_id, as_of_date);

-- A lease (property) belongs to at most one fund.
create table if not exists public.fund_leases (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  fund_id          uuid not null references public.funds (id) on delete cascade,
  lease_id         uuid not null references public.leases (id) on delete cascade,
  created_at       timestamptz not null default now(),
  unique (lease_id)
);
create index if not exists fund_leases_org_idx on public.fund_leases (org_id, fund_id);

do $$
declare t text;
begin
  foreach t in array array['funds','fund_investors','fund_commitments','fund_capital_calls','fund_call_allocations',
                           'fund_distributions','fund_distribution_allocations','fund_valuations','fund_leases'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "org read" on public.%I', t);
    execute format('create policy "org read" on public.%I for select using (public.can_read_org(org_id))', t);
    execute format('drop policy if exists "org write" on public.%I', t);
    execute format('create policy "org write" on public.%I for all using (public.can_edit_org(org_id)) with check (public.can_edit_org(org_id))', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['funds','fund_investors','fund_capital_calls','fund_distributions','fund_valuations'] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_profile_fk');
    execute format('alter table public.%I add constraint %I foreign key (created_by) references public.profiles (id) on delete set null', t, t || '_profile_fk');
  end loop;
end $$;
