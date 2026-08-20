# Cash Allocation App

Deploy a cash balance across custom-weighted tickers, with real prices refreshed
server-side (Finnhub → Supabase Edge Function → Postgres) instead of fetched
from the browser. Same stack pattern as macro-tracker: React/Vite on Vercel,
Supabase for Postgres/Auth/Edge Functions.

## How it works

- **Frontend** (`src/`) reads/writes `ca_positions` and `ca_settings` in
  Supabase, and reads `ca_prices` — it never talks to Finnhub directly.
- **`refresh-prices` Edge Function** (`supabase/functions/refresh-prices`)
  fetches a quote from Finnhub for every ticker in use and upserts it into
  `ca_prices`, using the service role key server-side. Callable on demand
  from the app's "Refresh prices" button, and on a schedule via a Cron
  Trigger.
- **Realtime**: the frontend subscribes to changes on `ca_prices`, so once
  the Edge Function writes a new quote, every open tab updates without a
  reload.

## 0. Pick a Supabase project — reuse one you already pay for

Supabase's Pro plan is $25/mo and includes one project; each additional
project is $10/mo. Rather than pay for a 3rd/4th project, **this app's
tables are already prefixed `ca_`** specifically so they can live inside
a project you're already running — e.g. the same project as macro-tracker
or the ledger app — at zero marginal cost. A Supabase project is just a
Postgres database plus auth plus functions; nothing stops multiple unrelated
apps from sharing one, as long as table names don't collide, which the
prefix guarantees.

**To reuse an existing project:** skip step 1 below, and in steps 2–6 use
that project's URL/keys instead of creating a new one. The `ca_` tables and
the `refresh-prices` function will sit alongside macro-tracker's `meals`/
`profiles` (or the ledger app's tables) without touching them. You'll also
get single sign-on for free — signing up in this app creates a row in the
same `auth.users` table, so if you're already signed into macro-tracker
with an email, that account can sign into this app too (they just won't
share any data, since RLS scopes `ca_positions`/`ca_settings` per user
regardless of which app created the session).

**Only spin up a new project (step 1) if** you want this fully isolated
from your other apps — e.g. a separate billing/quota boundary, or you're
handing this specific app to someone else to manage independently.

## 1. (Optional) Create a new Supabase project

Skip this entirely if you're reusing an existing project per step 0.

1. [supabase.com](https://supabase.com) → New Project. Note the project ref
   and database password.
2. Project Settings → API → copy the **Project URL** and **anon public key**
   into a local `.env.local` (copy `.env.example` as a starting point).

## 2. Apply the database schema

Easiest path — paste `supabase/migrations/0001_init.sql` into the SQL
Editor of whichever project you're using (new or existing) and run it.
(Or via CLI: `supabase link --project-ref YOUR_REF` then `supabase db push`.)

This creates `ca_settings`, `ca_positions`, and `ca_prices`, with row-level
security so each signed-in user only sees their own settings/positions.
`ca_prices` is shared and read-only to users — only the Edge Function (via
the service role key) writes to it. All three names, plus their policies
and trigger function, are prefixed `ca_` so they won't collide with an
existing project's tables.

## 3. Create your user(s)

The app has a "Sign up" link, so anyone with the app's URL can create their
own account and get their own private allocation model — `ca_positions` and
`ca_settings` are row-level-secured per user, so nobody sees anyone else's
weights or cash balance.

By default, Supabase's own email confirmation applies: after signing up,
you have to click the link in the confirmation email before you can sign
in. That alone keeps out anyone who doesn't control the email address they
signed up with.

**If you want it invite-only instead of open to whoever has the link**,
turn off self-serve signups entirely: Supabase dashboard →
**Authentication → Providers → Email → disable "Allow new users to sign
up."** Then create accounts yourself under **Authentication → Users → Add
user** and share the password out of band. The app's sign-up form will
still be visible but Supabase will reject the request, so you'd want to
also hide/remove the "Sign up" link in `AuthScreen` at that point (a couple
lines in `src/App.jsx`) so it doesn't dead-end people.

## 4. Shared price cache — how it scales with more users

`ca_prices` is one table shared by everyone, keyed by ticker — a quote for
AAPL doesn't need to be fetched separately per user. `refresh-prices`
already dedupes tickers across every user's positions before calling
Finnhub, and skips re-fetching any ticker refreshed in the last 20 seconds,
so several people clicking "Refresh prices" close together doesn't multiply
API calls. The app also puts each user's own refresh button on a 20-second
cooldown.

Where this could still bite you: Finnhub's free tier is 60 calls/min, and
`refresh-prices` calls it sequentially with a small delay per ticker. If
the combined *distinct* ticker count across everyone's portfolios grows
into the hundreds, a single refresh run could take a while and start
pushing on Finnhub's rate limit or the function's execution timeout. Not a
concern for a handful of people with normal-sized watchlists — just
something to revisit (e.g. batching, a paid Finnhub tier, or fetching only
tickers that are actually stale) if this grows a lot past that.

## 5. Get a Finnhub API key

1. Sign up free at [finnhub.io](https://finnhub.io/register) — no card
   required for the free tier (60 calls/min, real-time US quotes).
2. Copy your API key from the dashboard.

## 6. Deploy the Edge Function

With the [Supabase CLI](https://supabase.com/docs/guides/cli) installed:

```bash
supabase link --project-ref YOUR_REF
supabase secrets set FINNHUB_API_KEY=your-finnhub-key
supabase functions deploy refresh-prices
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically at
runtime — you don't set those yourself.

Test it manually once deployed:

```bash
supabase functions invoke refresh-prices
```

## 7. Schedule it to run automatically

In the Supabase dashboard: **Edge Functions → refresh-prices → Add Cron
Trigger**, e.g. every 5 minutes: `*/5 * * * *`. (If your project doesn't
show that option yet, the equivalent via SQL is `pg_cron` + `pg_net` calling
the function URL — see [Supabase's scheduling docs](https://supabase.com/docs/guides/functions/schedule-functions)
for the exact statement, since the syntax has moved around across versions.)

This is what makes prices update in the background even with no browser tab
open — the in-app button is for on-demand refreshes on top of that.

## 8. Run it locally

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL + anon key
npm run dev
```

## 9. Deploy the frontend to Vercel

Push this repo to GitHub, import it in Vercel, and set the same two
environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) in the
Vercel project settings. Build command and output directory are Vite's
defaults — no extra config needed.

## Notes

- Whole-share allocation rounds down by default; toggle "allow fractional
  shares" in the app if you don't need whole-lot precision.
- Weight % is applied directly against your cash balance — weights don't
  have to sum to 100%; anything under that shows as idle cash. Anything over
  100% is flagged rather than silently allowed.
- `ca_prices` is a single shared cache keyed by ticker — if you ever add a
  second user, they benefit from the same refreshed quotes rather than
  doubling API calls.
