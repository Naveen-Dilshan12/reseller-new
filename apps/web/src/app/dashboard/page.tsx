'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import type { CurrentUser } from '@/lib/auth'
import { currentPeriod, formatDate, formatMoney, monthLabel } from '@/lib/format'
import { ACTIVATION_STATUS_LABELS, type ActivationStatus } from '@/lib/activation-types'
import { TRIAL_STATUS_LABELS, type TrialStatus } from '@/lib/trial-types'
import type { CommissionStatus } from '@/lib/commission-types'
import {
  ACCOUNT_STATUS_LABELS,
  COMMISSION_STATUS_LABELS,
  type AccountStatus,
  type ResellerDashboard,
} from '@/lib/dashboard-types'
import { ResellerShell } from '@/components/ResellerShell'

// ─── Date presets ────────────────────────────────────────────────────────────

type Preset = 'all' | 'today' | '7d' | '30d' | 'month' | 'last-month' | 'year' | 'custom'

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom range' },
]

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function presetRange(preset: Preset): { from: string; to: string } {
  const now = new Date()
  const today = iso(now)
  const daysAgo = (n: number) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n))
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: daysAgo(6), to: today }
    case '30d':
      return { from: daysAgo(29), to: today }
    case 'month':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
    case 'last-month':
      return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) }
    case 'year':
      return { from: iso(new Date(now.getFullYear(), 0, 1)), to: today }
    default:
      return { from: '', to: '' }
  }
}

// ─── Small building blocks ───────────────────────────────────────────────────

function Kpi({ label, value, hint, href, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; href?: string; tone?: 'primary' | 'warning' }) {
  const accent = tone === 'primary' ? 'linear-gradient(90deg, #4f46e5, #8b5cf6)' : tone === 'warning' ? '#f59e0b' : '#6366f1'
  const body = (
    <div
      style={{
        position: 'relative',
        background: '#0f1523',
        borderRadius: '16px',
        padding: '1.35rem 1.45rem',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
        overflow: 'hidden',
        transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: accent, boxShadow: tone === 'primary' ? '0 0 10px rgba(99, 102, 241, 0.5)' : undefined }} />
      <div className="kpi-label" style={{ fontSize: '0.74rem', letterSpacing: '0.05em', color: '#94a3b8', fontWeight: 700 }}>{label}</div>
      <div className="kpi-value" style={{ fontSize: '1.75rem', fontWeight: 800, color: tone === 'primary' ? '#a5b4fc' : '#ffffff', letterSpacing: '-0.02em' }}>{value}</div>
      {hint && <div className="kpi-hint" style={{ fontSize: '0.78rem', color: '#64748b' }}>{hint}</div>}
    </div>
  )
  return href ? (
    <Link href={href} style={{ textDecoration: 'none' }} className="kpi-link">
      {body}
    </Link>
  ) : (
    body
  )
}

function Panel<S extends string>({
  title,
  href,
  status,
  statuses,
  onStatus,
  children,
}: {
  title: string
  href?: string
  status: S | ''
  statuses: Record<S, string>
  onStatus: (s: S | '') => void
  children: React.ReactNode
}) {
  const id = `st-${title.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <section className="card panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="spacer" />
        <label htmlFor={id} className="sr-only">
          {title} status
        </label>
        <select id={id} className="compact-select" value={status} onChange={(e) => onStatus(e.target.value as S | '')}>
          <option value="">All statuses</option>
          {(Object.keys(statuses) as S[]).map((s) => (
            <option key={s} value={s}>
              {statuses[s]}
            </option>
          ))}
        </select>
        {href && (
          <Link href={href} className="small">
            View all
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="muted small empty">{children}</p>

// ─── Dashboard ───────────────────────────────────────────────────────────────

function Dashboard({ user }: { user: CurrentUser }) {
  const [preset, setPreset] = useState<Preset>('all')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [productId, setProductId] = useState('')
  const [customerStatus, setCustomerStatus] = useState<AccountStatus | ''>('')
  const [trialStatus, setTrialStatus] = useState<TrialStatus | ''>('')
  const [activationStatus, setActivationStatus] = useState<ActivationStatus | ''>('')
  const [commissionStatus, setCommissionStatus] = useState<CommissionStatus | ''>('')

  const [data, setData] = useState<ResellerDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const range = preset === 'custom' ? custom : presetRange(preset)
  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (range.from) p.set('from', range.from)
    if (range.to) p.set('to', range.to)
    if (productId) p.set('productId', productId)
    if (customerStatus) p.set('customerStatus', customerStatus)
    if (trialStatus) p.set('trialStatus', trialStatus)
    if (activationStatus) p.set('activationStatus', activationStatus)
    if (commissionStatus) p.set('commissionStatus', commissionStatus)
    return p.toString()
  }, [range.from, range.to, productId, customerStatus, trialStatus, activationStatus, commissionStatus])

  useEffect(() => {
    if (preset === 'custom' && custom.from && custom.to && custom.from > custom.to) {
      setError('The start date must be on or before the end date.')
      return
    }
    let cancelled = false
    setLoading(true)
    api<ResellerDashboard>(`/dashboard/reseller${query ? `?${query}` : ''}`)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Failed to load the dashboard'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = preset !== 'all' || productId !== ''
  const resetFilters = () => {
    setPreset('all')
    setCustom({ from: '', to: '' })
    setProductId('')
  }

  const periodLabel =
    preset === 'all'
      ? 'All time'
      : preset === 'custom'
        ? `${custom.from ? formatDate(custom.from) : 'Start'} – ${custom.to ? formatDate(custom.to) : 'today'}`
        : PRESETS.find((p) => p.value === preset)!.label
  const productName = data?.products.find((p) => p.id === productId)?.name

  const can = (p: string) => user.permissions.includes(p)

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Dashboard</h1>
          <div className="muted small">
            {user.name}
            {user.reseller && (
              <>
                {' '}
                · {user.reseller.businessName} · <span className="mono">{user.reseller.code}</span>
              </>
            )}
          </div>
        </div>
        <span className="spacer" />
        <div className="dash-actions">
          {can('trials:create') && (
            <Link href="/trials/new" className="btn secondary">
              New trial
            </Link>
          )}
          {can('activations:create') && (
            <Link href="/activations/new" className="btn">
              New activation request
            </Link>
          )}
        </div>
      </div>

      <div className="card filter-bar">
        <div className="field inline">
          <label htmlFor="f-date">Date</label>
          <select id="f-date" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {preset === 'custom' && (
          <>
            <div className="field inline">
              <label htmlFor="f-from">From</label>
              <input id="f-from" type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </div>
            <div className="field inline">
              <label htmlFor="f-to">To</label>
              <input id="f-to" type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </div>
          </>
        )}
        <div className="field inline">
          <label htmlFor="f-product">SaaS product</label>
          <select id="f-product" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">All products</option>
            {data?.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <span className="spacer" />
        {loading && data && <span className="small muted">Updating…</span>}
        {filtered && (
          <button className="btn link small" onClick={resetFilters}>
            Clear filters
          </button>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}
      {!data ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <DashboardBody
          data={data}
          periodLabel={periodLabel}
          productName={productName}
          panels={{
            customerStatus,
            setCustomerStatus,
            trialStatus,
            setTrialStatus,
            activationStatus,
            setActivationStatus,
            commissionStatus,
            setCommissionStatus,
          }}
        />
      )}
    </>
  )
}

interface PanelState {
  customerStatus: AccountStatus | ''
  setCustomerStatus: (s: AccountStatus | '') => void
  trialStatus: TrialStatus | ''
  setTrialStatus: (s: TrialStatus | '') => void
  activationStatus: ActivationStatus | ''
  setActivationStatus: (s: ActivationStatus | '') => void
  commissionStatus: CommissionStatus | ''
  setCommissionStatus: (s: CommissionStatus | '') => void
}

function DashboardBody({ data, periodLabel, productName, panels }: { data: ResellerDashboard; periodLabel: string; productName?: string; panels: PanelState }) {
  const { kpis, period, recent } = data
  const level = kpis.level
  const money = (v: string | null | undefined) => formatMoney(v ?? 0, kpis.commission?.currency ?? 'LKR')
  const scope = productName ? ` · ${productName}` : ''

  return (
    <>
      <div className="kpi-grid">
        <Kpi
          tone="primary"
          label="Current reseller level"
          value={level.name ?? 'No level yet'}
          hint={level.nextLevel ? `${level.nextLevel.customersNeeded} more active to reach ${level.nextLevel.name}` : level.level ? 'Highest level reached' : undefined}
          href={kpis.commission ? '/commissions' : undefined}
        />
        {level.ratePercent !== null && (
          <Kpi tone="primary" label="Current commission" value={`${Number(level.ratePercent)}%`} hint={level.level ? `Level ${level.level} rate` : 'Rate for your first active customer'} />
        )}
        <Kpi label="Active customers" value={kpis.activeCustomers} hint={`${level.activeCount} active subscription${level.activeCount === 1 ? '' : 's'} count toward your level`} />
        <Kpi label="Total customers" value={kpis.totalCustomers} hint={productName ? `With ${productName}` : undefined} />
        <Kpi label="Trial customers" value={kpis.trialCustomers} href="/trials" />
        <Kpi label="Active subscriptions" value={kpis.activeSubscriptions} />
        {kpis.pendingActivationRequests !== null && (
          <Kpi
            label="Pending activation requests"
            value={kpis.pendingActivationRequests}
            hint="Awaiting Hexalyte review or activation"
            href="/activations"
            tone={kpis.pendingActivationRequests > 0 ? 'warning' : undefined}
          />
        )}
        {kpis.commission && (
          <>
            <Kpi label={`This month's commission`} value={money(kpis.commission.thisMonth)} hint={monthLabel(currentPeriod())} href="/commissions" />
            <Kpi label="Pending commission" value={money(kpis.commission.pending)} hint="Earned, not yet paid out" href="/commissions" />
            <Kpi label="Paid commission" value={money(kpis.commission.paid)} hint="Total paid to you" href="/commissions" />
          </>
        )}
      </div>

      <div className="card period-strip">
        <div className="period-title">
          <strong>{periodLabel}</strong>
          <span className="muted small">{scope}</span>
        </div>
        <div className="period-items">
          <div>
            <span className="period-value">{period.newCustomers}</span> new customers
          </div>
          {period.trialsCreated !== null && (
            <div>
              <span className="period-value">{period.trialsCreated}</span> trial requests
            </div>
          )}
          {period.activationsSubmitted !== null && (
            <div>
              <span className="period-value">{period.activationsSubmitted}</span> activation requests
            </div>
          )}
          {period.commissionEarned !== null && (
            <div>
              <span className="period-value">{money(period.commissionEarned)}</span> commission earned
            </div>
          )}
          {period.commissionPaid !== null && (
            <div>
              <span className="period-value">{money(period.commissionPaid)}</span> paid out
            </div>
          )}
        </div>
      </div>

      <div className="dash-grid">
        <Panel title="Recent customers" status={panels.customerStatus} statuses={ACCOUNT_STATUS_LABELS} onStatus={panels.setCustomerStatus}>
          {recent.customers.length === 0 ? (
            <Empty>No customers match these filters.</Empty>
          ) : (
            <ul className="recent-list">
              {recent.customers.map((c) => (
                <li key={c.id}>
                  <div className="recent-main">
                    <strong>{c.displayName}</strong>
                    <span className="muted small">Added {formatDate(c.createdAt)}</span>
                  </div>
                  <div className="recent-tags">
                    {c.accounts.map((a) => (
                      <span key={a.id} className={`badge sub-${a.status}`} title={a.product.name}>
                        {a.product.name}: {ACCOUNT_STATUS_LABELS[a.status]}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {recent.trials && (
          <Panel title="Recent trial requests" href="/trials" status={panels.trialStatus} statuses={TRIAL_STATUS_LABELS} onStatus={panels.setTrialStatus}>
            {recent.trials.length === 0 ? (
              <Empty>No trial requests match these filters.</Empty>
            ) : (
              <ul className="recent-list">
                {recent.trials.map((t) => (
                  <li key={t.id}>
                    <div className="recent-main">
                      <strong>{t.customerAccount.customer.displayName}</strong>
                      <span className="muted small">
                        {t.product.name} · {formatDate(t.createdAt)}
                      </span>
                      {t.status === 'FAILED' && t.errorMessage && <span className="small negative">{t.errorMessage}</span>}
                    </div>
                    <span className={`badge trial-${t.status}`}>{TRIAL_STATUS_LABELS[t.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {recent.activations && (
          <Panel title="Recent activation requests" href="/activations" status={panels.activationStatus} statuses={ACTIVATION_STATUS_LABELS} onStatus={panels.setActivationStatus}>
            {recent.activations.length === 0 ? (
              <Empty>No activation requests match these filters.</Empty>
            ) : (
              <ul className="recent-list">
                {recent.activations.map((a) => (
                  <li key={a.id}>
                    <div className="recent-main">
                      <Link href={`/activations/${a.id}`}>
                        <strong>{a.customerAccount.customer.displayName}</strong>
                      </Link>
                      <span className="muted small">
                        <span className="mono">{a.reference}</span> · {a.product.name} · {monthLabel(a.periodMonth)} · {formatMoney(a.amount, a.currency)}
                      </span>
                    </div>
                    <span className={`badge act-${a.status}`}>{ACTIVATION_STATUS_LABELS[a.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {recent.commissions && (
          <Panel title="Recent commission transactions" href="/commissions" status={panels.commissionStatus} statuses={COMMISSION_STATUS_LABELS} onStatus={panels.setCommissionStatus}>
            {recent.commissions.length === 0 ? (
              <Empty>No commission transactions match these filters.</Empty>
            ) : (
              <ul className="recent-list">
                {recent.commissions.map((c) => (
                  <li key={c.id}>
                    <div className="recent-main">
                      <strong>{c.customerAccount.customer.displayName}</strong>
                      <span className="muted small">
                        {c.entryType === 'CLAWBACK' ? 'Clawback' : `${Number(c.rate)}% commission`} · {c.product.name} · {monthLabel(c.periodMonth)}
                      </span>
                    </div>
                    <div className="recent-amount">
                      <strong className={Number(c.amount) < 0 ? 'negative' : undefined}>{formatMoney(c.amount, c.currency)}</strong>
                      <span className={`badge ${c.status}`}>{COMMISSION_STATUS_LABELS[c.status]}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>
    </>
  )
}

export default function DashboardPage() {
  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          <Dashboard user={user} />
        </main>
      )}
    </ResellerShell>
  )
}
