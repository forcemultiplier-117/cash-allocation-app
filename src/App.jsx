import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabaseClient'

const PALETTE = ['#4FD1B8', '#D4A054', '#6E93A8', '#A98BC4', '#8FAE8B', '#E8746B', '#C9A876', '#5FA8D3']

const ACCOUNT_TYPE_LABEL = { checking: 'Checking', savings: 'Savings', brokerage: 'Brokerage', other: 'Other' }

function fmtMoney(n, cents = false) {
  if (n === null || n === undefined || isNaN(n)) n = 0
  const sign = n < 0 ? '-' : ''
  const v = Math.abs(n)
  return sign + '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })
}

function formatRelativeTime(ts) {
  if (!ts) return null
  const diffMs = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins === 1) return '1 min ago'
  if (mins < 60) return mins + ' min ago'
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return hrs + (hrs === 1 ? ' hr ago' : ' hrs ago')
  const days = Math.floor(hrs / 24)
  return days + (days === 1 ? ' day ago' : ' days ago')
}

// Debounce a save so we don't fire a write on every keystroke.
function useDebouncedCallback(fn, delay) {
  const timer = useRef(null)
  return (...args) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => fn(...args), delay)
  }
}

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading, null = signed out

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (session === undefined) return null
  if (!session) return <AuthScreen />
  return <Dashboard session={session} />
}

function AuthScreen() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSignIn(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setBusy(false)
  }

  async function handleSignUp(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setError(error.message)
    } else {
      setNotice('Check your email to confirm the account, then sign in.')
      setMode('signin')
    }
    setBusy(false)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Cash Allocation</h1>
        <p>{mode === 'signin' ? 'Sign in to your allocation model.' : 'Create an account — you\'ll get your own private allocation model.'}</p>
        {error && <div className="auth-error">{error}</div>}
        {notice && <div className="auth-notice">{notice}</div>}
        <form onSubmit={mode === 'signin' ? handleSignIn : handleSignUp}>
          <div className="field">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
          </div>
          <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button
          className="btn ghost small"
          style={{ width: '100%', marginTop: 10 }}
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setNotice('') }}
        >
          {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  )
}

function Dashboard({ session }) {
  const [fractional, setFractional] = useState(false)
  const [accounts, setAccounts] = useState([]) // ca_accounts rows, cash_balance kept as string for editing
  const [positions, setPositions] = useState([]) // ca_positions rows, all accounts, flat
  const [prices, setPrices] = useState({}) // ticker -> { price, updated_at, error }
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState('')
  const [lastRefreshed, setLastRefreshed] = useState(null)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [cooldownTick, setCooldownTick] = useState(0)
  const [loadError, setLoadError] = useState('')

  // Re-render once a second while a cooldown is active so the button's
  // disabled state and label clear on their own when it expires.
  useEffect(() => {
    if (!cooldownUntil) return
    const id = setInterval(() => setCooldownTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [cooldownUntil])

  const cooldownRemaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))

  const userId = session.user.id

  // --- initial load ---
  useEffect(() => {
    let cancelled = false

    async function load() {
      let { data: settings } = await supabase
        .from('ca_settings')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      if (!settings) {
        const { data: created } = await supabase
          .from('ca_settings')
          .insert({ user_id: userId, fractional_shares: false })
          .select()
          .single()
        settings = created
      }

      const { data: acctRows, error: acctError } = await supabase
        .from('ca_accounts')
        .select('*')
        .eq('user_id', userId)
        .order('sort_order', { ascending: true })

      const { data: posRows, error: posError } = await supabase
        .from('ca_positions')
        .select('*')
        .eq('user_id', userId)
        .order('sort_order', { ascending: true })

      const tickers = [...new Set((posRows || []).map((p) => p.ticker).filter(Boolean))]
      let priceRows = []
      if (tickers.length) {
        const { data } = await supabase.from('ca_prices').select('*').in('ticker', tickers)
        priceRows = data || []
      }

      if (cancelled) return
      if (acctError || posError) {
        const parts = []
        if (acctError) parts.push(`ca_accounts: ${acctError.message} (code ${acctError.code || '?'})`)
        if (posError) parts.push(`ca_positions: ${posError.message} (code ${posError.code || '?'})`)
        setLoadError(parts.join(' | '))
      }
      setFractional(!!settings.fractional_shares)
      setAccounts((acctRows || []).map((a) => ({ ...a, cash_balance: String(a.cash_balance ?? 0) })))
      setPositions(posRows || [])
      const priceMap = {}
      priceRows.forEach((p) => { priceMap[p.ticker] = p })
      setPrices(priceMap)
      const latest = priceRows.reduce((max, p) => {
        const t = new Date(p.updated_at).getTime()
        return t > max ? t : max
      }, 0)
      if (latest) setLastRefreshed(latest)
      setLoaded(true)
    }

    load()
    return () => { cancelled = true }
  }, [userId])

  // --- realtime price updates ---
  useEffect(() => {
    const channel = supabase
      .channel('prices-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ca_prices' }, (payload) => {
        const row = payload.new
        if (!row) return
        setPrices((prev) => ({ ...prev, [row.ticker]: row }))
        setLastRefreshed(Date.now())
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // --- debounced writes ---
  const saveFractional = useDebouncedCallback(async (frac) => {
    await supabase.from('ca_settings').update({ fractional_shares: frac }).eq('user_id', userId)
  }, 500)

  const saveAccountCash = useDebouncedCallback(async (accountId, cash) => {
    await supabase.from('ca_accounts').update({ cash_balance: parseFloat(cash) || 0 }).eq('id', accountId)
  }, 500)

  const savePosition = useDebouncedCallback(async (id, fields) => {
    await supabase.from('ca_positions').update(fields).eq('id', id)
  }, 500)

  function onFractionalToggle(checked) {
    setFractional(checked)
    saveFractional(checked)
  }

  function onAccountCashChange(accountId, v) {
    const cleaned = v.replace(/[^0-9.]/g, '')
    setAccounts((prev) => prev.map((a) => (a.id === accountId ? { ...a, cash_balance: cleaned } : a)))
    saveAccountCash(accountId, cleaned)
  }

  async function onAccountAllocateToggle(accountId, checked) {
    setAccounts((prev) => prev.map((a) => (a.id === accountId ? { ...a, allocate: checked } : a)))
    await supabase.from('ca_accounts').update({ allocate: checked }).eq('id', accountId)
  }

  function updatePositionLocal(id, field, value) {
    setPositions((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)))
    savePosition(id, { [field]: field === 'ticker' ? value.toUpperCase() : value })
  }

  async function addPosition(accountId) {
    const sameAccount = positions.filter((p) => p.account_id === accountId)
    const { data } = await supabase
      .from('ca_positions')
      .insert({ user_id: userId, account_id: accountId, ticker: '', weight: 0, sort_order: sameAccount.length })
      .select()
      .single()
    if (data) setPositions((prev) => [...prev, data])
  }

  async function deletePosition(id) {
    setPositions((prev) => prev.filter((p) => p.id !== id))
    await supabase.from('ca_positions').delete().eq('id', id)
  }

  async function clearAccountPositions(accountId) {
    const ids = positions.filter((p) => p.account_id === accountId).map((p) => p.id)
    setPositions((prev) => prev.filter((p) => p.account_id !== accountId))
    if (ids.length) await supabase.from('ca_positions').delete().in('id', ids)
  }

  const REFRESH_COOLDOWN_MS = 20_000

  async function refreshNow() {
    if (Date.now() < cooldownUntil) return
    setRefreshing(true)
    setRefreshMsg('')
    try {
      const { data, error } = await supabase.functions.invoke('refresh-prices')
      if (error) throw error
      const cachedNote = data?.cached ? `, ${data.cached} served from cache` : ''
      setRefreshMsg(`Refreshed ${data?.refreshed ?? 0} ticker${data?.refreshed === 1 ? '' : 's'}${cachedNote}.`)
      setLastRefreshed(Date.now())
      setCooldownUntil(Date.now() + REFRESH_COOLDOWN_MS)
      // Realtime subscription will push the updated rows in, but re-fetch
      // as a fallback in case the channel missed anything.
      const tickers = [...new Set(positions.map((p) => (p.ticker || '').trim().toUpperCase()).filter(Boolean))]
      if (tickers.length) {
        const { data: priceRows } = await supabase.from('ca_prices').select('*').in('ticker', tickers)
        const priceMap = {}
        ;(priceRows || []).forEach((p) => { priceMap[p.ticker] = p })
        setPrices((prev) => ({ ...prev, ...priceMap }))
      }
    } catch (err) {
      setRefreshMsg('Refresh failed: ' + (err.message || String(err)))
    } finally {
      setRefreshing(false)
    }
  }

  const positionsByAccount = useMemo(() => {
    const map = {}
    positions.forEach((p) => {
      if (!map[p.account_id]) map[p.account_id] = []
      map[p.account_id].push(p)
    })
    return map
  }, [positions])

  const totalCash = accounts.reduce((s, a) => s + (parseFloat(a.cash_balance) || 0), 0)
  const allocatableCash = accounts.filter((a) => a.allocate).reduce((s, a) => s + (parseFloat(a.cash_balance) || 0), 0)

  const checkingSavings = accounts.filter((a) => a.account_type === 'checking' || a.account_type === 'savings')
  const other = accounts.filter((a) => a.account_type !== 'checking' && a.account_type !== 'savings')

  if (!loaded) return null

  return (
    <div className="wrap">
      <div className="masthead">
        <div>
          <h1>Cash Allocation</h1>
          <div className="sub">Deploy cash across target positions by weight, per account</div>
        </div>
        <div className="actions">
          <span className="who">{session.user.email}</span>
          <button className="btn ghost small" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>

      {loadError && <div className="warn-banner">Failed to load data — {loadError}</div>}

      <div className="cash-card">
        <div>
          <div className="cash-label">Total cash across accounts</div>
          <div className="cash-input-row">
            <span className="cash-total-figure">{fmtMoney(totalCash)}</span>
          </div>
        </div>
        <div className="headline-stats">
          <div className="stat"><div className="n">{fmtMoney(allocatableCash)}</div><div className="l">Allocatable</div></div>
          <div className="stat"><div className="n">{fmtMoney(totalCash - allocatableCash)}</div><div className="l">Held, not allocated</div></div>
          <div className="stat"><div className="n">{accounts.filter((a) => a.allocate).length}</div><div className="l">Active tables</div></div>
        </div>
      </div>

      <div className="live-bar">
        <div className="live-left">
          <span className={`live-dot ${refreshing ? 'loading' : lastRefreshed ? 'ok' : ''}`} />
          <span>
            {refreshing
              ? 'Fetching current quotes…'
              : lastRefreshed
                ? `Prices updated ${formatRelativeTime(lastRefreshed)}`
                : 'Prices not yet fetched'}
          </span>
        </div>
        <button className="btn primary small" onClick={refreshNow} disabled={refreshing || cooldownRemaining > 0}>
          {refreshing ? 'Refreshing…' : cooldownRemaining > 0 ? `Wait ${cooldownRemaining}s` : 'Refresh prices'}
        </button>
      </div>
      {refreshMsg && <div className="warn-banner">{refreshMsg}</div>}

      <div className="section-label">
        <span>Accounts</span>
        <label className="frac-toggle">
          <input type="checkbox" checked={fractional} onChange={(e) => onFractionalToggle(e.target.checked)} />
          Allow fractional shares (applies to every account)
        </label>
      </div>

      {checkingSavings.length > 0 && (
        <>
          <div className="acct-group-label">Checking &amp; savings — visible, not allocated</div>
          <div className="acct-list">
            {checkingSavings.map((a) => (
              <AccountBlock
                key={a.id}
                account={a}
                positions={positionsByAccount[a.id] || []}
                prices={prices}
                fractional={fractional}
                onCashChange={onAccountCashChange}
                onAllocateToggle={onAccountAllocateToggle}
                onUpdatePosition={updatePositionLocal}
                onAddPosition={addPosition}
                onDeletePosition={deletePosition}
                onClearPositions={clearAccountPositions}
              />
            ))}
          </div>
        </>
      )}

      {other.length > 0 && (
        <>
          <div className="acct-group-label">Investment &amp; retirement</div>
          <div className="acct-list">
            {other.map((a) => (
              <AccountBlock
                key={a.id}
                account={a}
                positions={positionsByAccount[a.id] || []}
                prices={prices}
                fractional={fractional}
                onCashChange={onAccountCashChange}
                onAllocateToggle={onAccountAllocateToggle}
                onUpdatePosition={updatePositionLocal}
                onAddPosition={addPosition}
                onDeletePosition={deletePosition}
                onClearPositions={clearAccountPositions}
              />
            ))}
          </div>
        </>
      )}

      <div className="footnote">
        <b>On cash balances:</b> each account's cash is whatever was last synced from Kubera (see "synced" timestamp on
        the account), or a manual edit if you've typed one in since. There's no automatic background sync — ask Claude
        to "sync cash from Kubera" and it'll pull current balances and write them straight in. <b>On the allocate
        checkbox:</b> only checked accounts render an allocation table below; unchecked accounts (like checking/savings)
        still show their cash for visibility. <b>On prices:</b> "Refresh prices" calls a Supabase Edge Function that
        fetches current quotes from Finnhub for every ticker across every account's table — no API key ever touches the
        browser. <b>On weights:</b> weight % is applied against that account's own cash balance; if weights sum to less
        than 100%, the remainder shows as idle cash for that account.
      </div>
    </div>
  )
}

function AccountBlock({
  account, positions, prices, fractional,
  onCashChange, onAllocateToggle, onUpdatePosition, onAddPosition, onDeletePosition, onClearPositions,
}) {
  const cash = parseFloat(account.cash_balance) || 0

  const rows = useMemo(() => {
    return positions.map((p, i) => {
      const priceRow = prices[(p.ticker || '').toUpperCase()]
      const price = priceRow?.price ?? 0
      const weight = parseFloat(p.weight) || 0
      const dollarAlloc = cash * (weight / 100)
      let shares, spent
      if (fractional) {
        shares = price > 0 ? dollarAlloc / price : 0
        spent = dollarAlloc
      } else {
        shares = price > 0 ? Math.floor(dollarAlloc / price) : 0
        spent = shares * price
      }
      const leftover = dollarAlloc - spent
      return {
        ...p,
        price,
        priceError: priceRow?.error,
        weight,
        dollarAlloc,
        shares,
        spent,
        leftover,
        color: PALETTE[i % PALETTE.length],
      }
    })
  }, [positions, prices, cash, fractional])

  const totalWeight = rows.reduce((s, r) => s + r.weight, 0)
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0)
  const totalShares = rows.reduce((s, r) => s + r.shares, 0)
  const totalLeftover = rows.reduce((s, r) => s + r.leftover, 0)
  const overAllocated = totalWeight > 100
  const idleWeight = Math.max(0, 100 - totalWeight)
  const idleCash = overAllocated ? 0 : cash * (idleWeight / 100)
  const totalCashRemaining = idleCash + Math.max(0, totalLeftover)

  return (
    <div className="acct-card">
      <div className="acct-head">
        <div className="acct-head-left">
          <span className={`acct-badge acct-badge-${account.account_type}`}>{ACCOUNT_TYPE_LABEL[account.account_type] || 'Other'}</span>
          <span className="acct-name">{account.name}</span>
          {account.synced_at && <span className="acct-synced">synced {formatRelativeTime(account.synced_at)}</span>}
        </div>
        <div className="acct-head-right">
          <div className="acct-cash-input-row">
            <span className="prefix">$</span>
            <input value={account.cash_balance} onChange={(e) => onCashChange(account.id, e.target.value)} inputMode="decimal" />
          </div>
          <label className="acct-allocate-toggle">
            <input
              type="checkbox"
              checked={!!account.allocate}
              onChange={(e) => onAllocateToggle(account.id, e.target.checked)}
            />
            Allocate
          </label>
        </div>
      </div>

      {account.allocate && (
        <div className="acct-body">
          {overAllocated && (
            <div className="warn-banner">
              Weights total {totalWeight.toFixed(1)}% — that's {(totalWeight - 100).toFixed(1)} points over this
              account's cash. Reduce a weight before this allocates cleanly.
            </div>
          )}

          <div className="strip-wrap">
            <div className="strip">
              {overAllocated
                ? rows.map((r) => (
                    <div key={r.id} className="strip-seg" style={{ width: `${(r.weight * 100) / totalWeight}%`, background: r.color }}>
                      <span>{r.ticker || '—'} {r.weight.toFixed(0)}%</span>
                    </div>
                  ))
                : (
                  <>
                    {rows.filter((r) => r.weight > 0).map((r) => (
                      <div key={r.id} className="strip-seg" style={{ width: `${r.weight}%`, background: r.color }}>
                        <span>{r.ticker || '—'} {r.weight.toFixed(0)}%</span>
                      </div>
                    ))}
                    {idleWeight > 0.01 && (
                      <div className="strip-seg idle" style={{ width: `${idleWeight}%` }}>
                        <span>Idle {idleWeight.toFixed(0)}%</span>
                      </div>
                    )}
                  </>
                )}
            </div>
          </div>

          <div className="tbl">
            <div className="row head">
              <span></span><span>Ticker</span><span>Last price</span><span>Weight</span>
              <span>$ Allocated</span><span>Shares</span><span>$ Spent / Idle</span><span></span>
            </div>
            <div>
              {rows.map((r) => (
                <div className="row" key={r.id}>
                  <span className="swatch" style={{ background: r.color }} />
                  <input
                    className="ticker-input"
                    value={r.ticker || ''}
                    maxLength={6}
                    placeholder="TICK"
                    onChange={(e) => onUpdatePosition(r.id, 'ticker', e.target.value)}
                  />
                  <span className="cell-value dim">
                    {r.price ? fmtMoney(r.price, true) : r.priceError ? 'error' : '—'}
                  </span>
                  <span className="pct-wrap">
                    <input
                      value={r.weight || ''}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(e) => onUpdatePosition(r.id, 'weight', e.target.value)}
                    />
                  </span>
                  <span className="cell-value">{fmtMoney(r.dollarAlloc)}</span>
                  <span className="cell-value">
                    {fractional ? r.shares.toLocaleString('en-US', { maximumFractionDigits: 4 }) : r.shares.toLocaleString('en-US')}
                  </span>
                  <span className="cell-value dim">
                    {fmtMoney(r.spent)}
                    {r.leftover > 0.005 && <span style={{ color: 'var(--amber)' }}> (+{fmtMoney(r.leftover, true)})</span>}
                  </span>
                  <button className="del-btn" onClick={() => onDeletePosition(r.id)} title="Remove">×</button>
                </div>
              ))}
            </div>
          </div>

          <div className="add-row">
            <button className="btn" onClick={() => onAddPosition(account.id)}>+ Add position</button>
            <button className="btn ghost" onClick={() => onClearPositions(account.id)}>Clear all</button>
          </div>

          <div className="summary">
            <div className="cell"><div className="n">{fmtMoney(totalSpent)}</div><div className="l">Deployed</div></div>
            <div className="cell"><div className="n">{totalShares.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div><div className="l">Total shares</div></div>
            <div className="cell"><div className="n">{fmtMoney(totalLeftover, true)}</div><div className="l">Rounding remainder</div></div>
            <div className="cell"><div className="n">{fmtMoney(totalCashRemaining, true)}</div><div className="l">Cash remaining</div></div>
          </div>
        </div>
      )}
    </div>
  )
}
