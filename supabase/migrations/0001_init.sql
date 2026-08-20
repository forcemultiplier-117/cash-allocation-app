-- Cash Allocation App — initial schema
-- Run via `supabase db push`, or paste into the Supabase SQL editor.

-- One settings row per user: cash balance + display preferences.
create table if not exists public.ca_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  cash_balance numeric not null default 0,
  fractional_shares boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Each row is one ticker in one user's allocation model.
create table if not exists public.ca_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  weight numeric not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ca_positions_user_id_idx on public.ca_positions(user_id);

-- Shared price cache, one row per ticker, written only by the refresh-prices
-- Edge Function (via the service role key, which bypasses RLS). Every user's
-- app reads from the same cache, since a quote for AAPL doesn't vary by user.
create table if not exists public.ca_prices (
  ticker text primary key,
  price numeric,
  updated_at timestamptz not null default now(),
  error text
);

-- Row Level Security: users can only see/edit their own settings and positions.
alter table public.ca_settings enable row level security;
alter table public.ca_positions enable row level security;
alter table public.ca_prices enable row level security;

create policy "ca_settings_select_own" on public.ca_settings
  for select using (auth.uid() = user_id);
create policy "ca_settings_upsert_own" on public.ca_settings
  for insert with check (auth.uid() = user_id);
create policy "ca_settings_update_own" on public.ca_settings
  for update using (auth.uid() = user_id);

create policy "ca_positions_select_own" on public.ca_positions
  for select using (auth.uid() = user_id);
create policy "ca_positions_insert_own" on public.ca_positions
  for insert with check (auth.uid() = user_id);
create policy "ca_positions_update_own" on public.ca_positions
  for update using (auth.uid() = user_id);
create policy "ca_positions_delete_own" on public.ca_positions
  for delete using (auth.uid() = user_id);

-- Prices are readable by any signed-in user; writes only happen via the
-- service role key inside the Edge Function, so no insert/update policy is
-- defined here for regular users on purpose.
create policy "ca_prices_select_authenticated" on public.ca_prices
  for select using (auth.role() = 'authenticated');

-- Keep updated_at fresh on edit.
create or replace function public.ca_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger ca_settings_set_updated_at
  before update on public.ca_settings
  for each row execute function public.ca_set_updated_at();

create trigger ca_positions_set_updated_at
  before update on public.ca_positions
  for each row execute function public.ca_set_updated_at();
