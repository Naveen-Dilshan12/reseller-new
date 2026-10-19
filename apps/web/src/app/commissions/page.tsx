'use client'

import { useEffect, useState } from 'react'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'
import { Tabs } from '@/components/Tabs'
import { CommissionLedger } from '@/components/commissions/CommissionLedger'
import { CustomerCommissions } from '@/components/commissions/CustomerCommissions'
import { MonthlyReport } from '@/components/commissions/MonthlyReport'
import { PayoutHistory } from '@/components/commissions/PayoutHistory'
import { LevelBadge } from '@/components/commissions/LevelBadge'
import { CommissionSplit } from '@/components/commissions/CommissionSplit'
import { api, ApiError } from '@/lib/api'
import { formatMoney, monthLabel, currentPeriod } from '@/lib/format'
import type { CommissionSummary } from '@/lib/commission-types'

type Tab = 'history' | 'customers' | 'monthly' | 'payouts'

function CommissionKpis({ summary }: { summary: CommissionSummary }) {
  const { level, totals, currentMonth } = summary
  const currency = 'LKR'

  return (
    <div className="kpi-grid">
      {/* 1. Partner Level & Rate */}
      <div className="card kpi-ref">
        <div className="kpi-ref-top">
          <span className="kpi-ref-label">Partner Level & Rate</span>
          <LevelBadge level={level.level} name={level.name} size="sm" />
        </div>
        <div className="kpi-ref-main">
          <div className="kpi-ref-value" style={{ color: 'var(--primary-light)' }}>
            {level.name ?? (level.level !== null ? `Level ${level.level}` : 'No level yet')}
          </div>
        </div>
        <div className="kpi-ref-footer">
          <span className="kpi-ref-badge neutral">
            {level.effectiveRatePercent ? `${Number(level.effectiveRatePercent)}% rate` : '—'}
          </span>
          <span className="kpi-ref-desc">
            {level.nextLevel ? `${level.nextLevel.customersNeeded} more active for ${level.nextLevel.name}` : 'Highest tier reached'}
          </span>
        </div>
      </div>

      {/* 2. This Month's Commission */}
      <div className="card kpi-ref">
        <div className="kpi-ref-top">
          <span className="kpi-ref-label">Commission This Month</span>
          <div className="kpi-ref-icon indigo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <line x1="2" y1="10" x2="22" y2="10" />
            </svg>
          </div>
        </div>
        <div className="kpi-ref-main">
          <div className="kpi-ref-value">
            {formatMoney(currentMonth?.earnings ?? 0, currency)}
          </div>
        </div>
        <div className="kpi-ref-footer">
          <span className="kpi-ref-badge neutral">{monthLabel(currentMonth?.periodMonth ?? currentPeriod())}</span>
          <span className="kpi-ref-desc">Accrued monthly earnings</span>
        </div>
      </div>

      {/* 3. Pending Commission */}
      <div className="card kpi-ref">
        <div className="kpi-ref-top">
          <span className="kpi-ref-label">Pending Commission</span>
          <div className="kpi-ref-icon amber">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
        </div>
        <div className="kpi-ref-main">
          <div className="kpi-ref-value">
            {formatMoney(totals?.pending ?? 0, currency)}
          </div>
        </div>
        <div className="kpi-ref-footer">
          <span className="kpi-ref-badge neutral">On Hold</span>
          <span className="kpi-ref-desc">Awaiting verification / clearance</span>
        </div>
      </div>

      {/* 4. Paid Commission */}
      <div className="card kpi-ref">
        <div className="kpi-ref-top">
          <span className="kpi-ref-label">Paid Commission</span>
          <div className="kpi-ref-icon emerald">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
        </div>
        <div className="kpi-ref-main">
          <div className="kpi-ref-value">
            {formatMoney(totals?.paid ?? 0, currency)}
          </div>
        </div>
        <div className="kpi-ref-footer">
          <span className="kpi-ref-badge positive">Disbursed</span>
          <span className="kpi-ref-desc">Total payouts to date</span>
        </div>
      </div>
    </div>
  )
}

function CommissionKpisSkeleton() {
  return (
    <div className="kpi-grid">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="card kpi-ref" style={{ opacity: 0.75 }}>
          <div className="kpi-ref-top">
            <div className="skel skel-line" style={{ width: '80px', height: '12px', margin: 0 }} />
            <div className="skel" style={{ width: '28px', height: '28px', borderRadius: '8px' }} />
          </div>
          <div className="kpi-ref-main" style={{ margin: '0.35rem 0' }}>
            <div className="skel skel-line lg" style={{ width: '130px', margin: 0 }} />
          </div>
          <div className="kpi-ref-footer">
            <div className="skel skel-line" style={{ width: '60px', height: '12px', margin: 0 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function ResellerCommissionsPage() {
  const [tab, setTab] = useState<Tab>('history')
  const [summary, setSummary] = useState<CommissionSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setSummaryError(null)
    api<CommissionSummary>('/commissions/summary')
      .then((s) => active && setSummary(s))
      .catch((err) => active && setSummaryError(err instanceof ApiError ? err.message : 'Please try again.'))
    return () => {
      active = false
    }
  }, [attempt])

  return (
    <ResellerShell>
      {() => (
        <main className="container">
          {/* ── Compact Scenic Hero Banner with Embedded Translucent KPIs ── */}
          <PageHero
            tag="PARTNER EARNINGS"
            title="Commissions & Payouts"
            subtitle="Commission is earned each month for every active customer once their subscription payment is verified, held for the refund period, and disbursed."
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="2" x2="12" y2="22" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            }
          >
            {summary ? <CommissionKpis summary={summary} /> : summaryError ? undefined : <CommissionKpisSkeleton />}
          </PageHero>

          {/* A failed summary is said out loud, with a way to try again, instead of leaving the cards as skeletons for ever. */}
          {!summary && summaryError && (
            <div className="alert error" role="alert">
              Your commission summary could not be loaded. {summaryError}{' '}
              <button className="btn secondary small" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            </div>
          )}

          {summary && <CommissionSplit summary={summary} />}

          <div className="card">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: 'history', label: 'Commission history' },
                { key: 'customers', label: 'By customer' },
                { key: 'monthly', label: 'Monthly report' },
                { key: 'payouts', label: 'Payouts' },
              ]}
            />
            {tab === 'history' && <CommissionLedger />}
            {tab === 'customers' && <CustomerCommissions />}
            {tab === 'monthly' && <MonthlyReport />}
            {tab === 'payouts' && <PayoutHistory />}
          </div>
        </main>
      )}
    </ResellerShell>
  )
}
