// Supabase Edge Function: refresh-prices
//
// Pulls the distinct set of tickers across every user's positions table,
// fetches a current quote for each from Finnhub, and upserts into the
// shared `prices` table. Meant to run on a schedule (see README for how to
// wire up a Cron Trigger) — the frontend never calls Finnhub directly.
//
// Required secrets (set via `supabase secrets set`):
//   FINNHUB_API_KEY        — your Finnhub API key
//   SUPABASE_URL            — auto-provided by Supabase at deploy time
//   SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase at deploy time

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const FINNHUB_API_KEY = Deno.env.get('FINNHUB_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!)

// If a ticker was refreshed more recently than this, reuse the cached price
// instead of calling Finnhub again. Protects the shared rate limit when
// several users' "Refresh prices" clicks land close together.
const FRESHNESS_WINDOW_MS = 20_000

// Browsers enforce CORS on cross-origin fetches (localhost:5173 -> the
// project's supabase.co domain counts as cross-origin). Without these
// headers, the browser blocks the request before it's even sent and
// supabase-js surfaces it as a generic "Failed to send a request" error —
// curl/PowerShell never hit this since CORS is a browser-only mechanism.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function fetchQuote(ticker: string) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_API_KEY}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Finnhub returned ${res.status} for ${ticker}`)
  }
  const data = await res.json()
  // Finnhub returns all zeros for an unrecognized symbol rather than an
  // error status, so treat that as "not found" explicitly.
  if (!data || (data.c === 0 && data.pc === 0)) {
    throw new Error(`No quote data for ${ticker} (symbol may be invalid)`)
  }
  return data.c as number // current price
}

Deno.serve(async (req) => {
  // Browser sends an OPTIONS preflight before the real POST — must answer
  // it with the CORS headers or the browser never sends the actual request.
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (!FINNHUB_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'FINNHUB_API_KEY secret is not set' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const { data: positions, error: posError } = await supabase
    .from('ca_positions')
    .select('ticker')

  if (posError) {
    return new Response(JSON.stringify({ error: posError.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const tickers = [
    ...new Set(
      (positions ?? [])
        .map((p) => (p.ticker || '').trim().toUpperCase())
        .filter(Boolean)
    ),
  ]

  const { data: existing } = await supabase
    .from('ca_prices')
    .select('ticker, price, updated_at')
    .in('ticker', tickers.length ? tickers : [''])

  const freshMap = new Map((existing ?? []).map((p) => [p.ticker, p]))
  const now = Date.now()

  const results: Record<string, { price?: number; error?: string; cached?: boolean }> = {}

  // Finnhub's free tier allows 60 calls/min — sequential with a small delay
  // keeps this comfortably under that even for a fairly large ticker list.
  for (const ticker of tickers) {
    const cached = freshMap.get(ticker)
    if (cached && now - new Date(cached.updated_at).getTime() < FRESHNESS_WINDOW_MS) {
      results[ticker] = { price: cached.price, cached: true }
      continue
    }
    try {
      const price = await fetchQuote(ticker)
      await supabase
        .from('ca_prices')
        .upsert({ ticker, price, updated_at: new Date().toISOString(), error: null })
      results[ticker] = { price }
    } catch (err) {
      await supabase
        .from('ca_prices')
        .upsert({ ticker, updated_at: new Date().toISOString(), error: String(err) })
      results[ticker] = { error: String(err) }
    }
    // Small pacing delay to stay well within rate limits.
    await new Promise((r) => setTimeout(r, 250))
  }

  const fetchedCount = Object.values(results).filter((r) => !r.cached).length
  return new Response(
    JSON.stringify({ refreshed: fetchedCount, cached: tickers.length - fetchedCount, results }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
