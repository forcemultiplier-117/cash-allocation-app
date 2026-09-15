-- Cash Allocation App — multi-account support
--
-- Adds ca_accounts: one row per real-world cash-bearing account (e.g. a
-- brokerage account, checking account, or savings account). Each account
-- carries its own cash balance and an `allocate` flag — accounts with
-- allocate = false are shown for visibility (e.g. checking/savings) but
-- render no allocation table; accounts with allocate = true get their own
-- ca_positions table, independent of every other account.
--
-- ca_positions gains account_id so each ticker/weight row belongs to a
-- specific account instead of one flat per-user list.

create table if not exists public.ca_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Account',
  -- Free-form external reference (e.g. a Kubera custodian id) so a future
  -- sync can find "this row" again without matching on name. Not
  -- interpreted by the app itself.
  external_id text,
  account_type text not null default 'other', -- 'checking' | 'savings' | 'brokerage' | 'other'
  cash_balance numeric not null default 0,
  allocate boolean not null default false,
  sort_order int not null default 0,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ca_accounts_user_id_idx on public.ca_accounts(user_id);

-- One row per (user, external_id) at most, so a sync can upsert by
-- external_id without creating duplicates. Accounts without an external_id
-- (manually added) are unaffected by this constraint.
create unique index if not exists ca_accounts_user_external_uidx
  on public.ca_accounts(user_id, external_id)
  where external_id is not null;

alter table public.ca_accounts enable row level security;

create policy "ca_accounts_select_own" on public.ca_accounts
  for select using (auth.uid() = user_id);
create policy "ca_accounts_insert_own" on public.ca_accounts
  for insert with check (auth.uid() = user_id);
create policy "ca_accounts_update_own" on public.ca_accounts
  for update using (auth.uid() = user_id);
create policy "ca_accounts_delete_own" on public.ca_accounts
  for delete using (auth.uid() = user_id);

create trigger ca_accounts_set_updated_at
  before update on public.ca_accounts
  for each row execute function public.ca_set_updated_at();

-- Each position now belongs to an account. Nullable during migration so
-- existing rows survive the alter; backfilled below, then no new position
-- should ever be inserted without one (enforced at the app layer).
alter table public.ca_positions
  add column if not exists account_id uuid references public.ca_accounts(id) on delete cascade;

create index if not exists ca_positions_account_id_idx on public.ca_positions(account_id);

-- Backfill: give every existing user (pre-dating multi-account support) one
-- account seeded from their current ca_settings.cash_balance, then attach
-- their existing positions to it. Generic on purpose — no real-world
-- account names/ids belong in a migration file in a public repo; those are
-- set afterward directly in the database, per account.
insert into public.ca_accounts (user_id, name, cash_balance, allocate, sort_order)
select s.user_id, 'Cash Account 1', s.cash_balance, true, 0
from public.ca_settings s
where not exists (
  select 1 from public.ca_accounts a where a.user_id = s.user_id
);

update public.ca_positions p
set account_id = (
  select a.id from public.ca_accounts a
  where a.user_id = p.user_id
  order by a.created_at asc
  limit 1
)
where p.account_id is null;
