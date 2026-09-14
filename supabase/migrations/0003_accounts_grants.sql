-- ca_accounts was created without the table-level GRANTs that ca_positions
-- and ca_settings already had (likely a gap in this project's default
-- privileges for newly created tables). RLS policies do nothing without
-- the underlying GRANT — Postgres checks table privileges first — so every
-- request against ca_accounts failed with 42501 (permission denied)
-- regardless of the RLS policies being correct. This brings ca_accounts in
-- line with the other ca_ tables.

grant select, insert, update, delete on public.ca_accounts to authenticated;
grant select, insert, update, delete on public.ca_accounts to service_role;
