'use client'

import { formatMoney, monthLabel } from '@/lib/format'
import type { CommissionSummary } from '@/lib/commission-types'

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  )
}

export function LevelSummary({ summary }: { summary: CommissionSummary }) {
  const { level, levels, totals } = summary
  const next = level.nextLevel
  const currentTier = levels.find((l) => l.level === level.level)
  const floor = currentTier?.minActiveCustomers ?? 0
  const nextMin = next ? level.activeCustomerCount + next.customersNeeded : 0
  const progress = next ? ((level.activeCustomerCount - floor) / (nextMin - floor)) * 100 : 100
  const maxMonthly = Math.max(1, ...summary.monthlyEarnings.map((m) => Number(m.earnings)))

  return (
    <>
      <div className="card level-card">
        <div className="row">
          <div>
            <div className="muted small">Current level</div>
            <div className="level-name">{level.name ?? 'No level yet'}</div>
          </div>
          <span className="spacer" />
          <div style={{ textAlign: 'right' }}>
            <div className="muted small">Commission rate</div>
            <div className="level-name">{Number(level.effectiveRatePercent)}%</div>
          </div>
        </div>
        <p style={{ margin: '0.75rem 0 0.4rem' }}>
          <strong>{level.activeCustomerCount}</strong> active customer{level.activeCustomerCount === 1 ? '' : 's'}
          {next ? (
            <span className="muted">
              {' '}
              · {next.customersNeeded} more to reach {next.name} ({Number(next.ratePercent)}%)
            </span>
          ) : (
            <span className="muted"> · highest level reached</span>
          )}
        </p>
        <div className="progress">
          <div style={{ width: `${progress}%` }} />
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {summary.commissionPerCustomer
            .map((p) => `${p.product}: ${formatMoney(p.amount, p.currency)} per customer / month (${Number(level.effectiveRatePercent)}% of ${formatMoney(p.baseAmount, p.currency)}); Hexalyte keeps ${formatMoney(p.hexalyteAmount, p.currency)}`)
            .join(' · ')}
        </p>
      </div>

      <div className="stats">
        <StatCard label={`Earnings ${monthLabel(summary.currentMonth.periodMonth)}`} value={formatMoney(summary.currentMonth.earnings)} />
        <StatCard label="Pending approval" value={formatMoney(totals.pending)} />
        <StatCard label="Approved (on hold)" value={formatMoney(totals.approved)} hint="Refund hold period" />
        <StatCard label="Payable" value={formatMoney(totals.payable)} hint="Included in next payout" />
        <StatCard label="Paid" value={formatMoney(totals.paid)} />
        <StatCard label="Reversed" value={formatMoney(totals.reversed)} />
      </div>

      <div className="grid-2 gap">
        <div className="card">
          <h2>Monthly earnings</h2>
          <div className="bars">
            {summary.monthlyEarnings.map((m) => (
              <div key={m.periodMonth} className="bar-row">
                <span className="small muted">{monthLabel(m.periodMonth)}</span>
                <div className="bar">
                  <div style={{ width: `${(Math.max(0, Number(m.earnings)) / maxMonthly) * 100}%` }} />
                </div>
                <span className="small">{formatMoney(m.earnings)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h2>Level structure</h2>
          <table>
            <thead>
              <tr>
                <th>Level</th>
                <th>Active customers</th>
                <th>Rate</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l.level} className={l.level === level.level ? 'highlight' : undefined}>
                  <td>{l.name}</td>
                  <td>
                    {l.minActiveCustomers}
                    {l.maxActiveCustomers ? `–${l.maxActiveCustomers}` : '+'}
                  </td>
                  <td>{Number(l.ratePercent)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
