'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { currentPeriod, formatMoney, monthLabel } from '@/lib/format'
import type { CommissionEntry, StatusTotals } from '@/lib/commission-types'

interface ResellerRow {
  reseller: { id: string; code: string; businessName: string; currentLevel: number | null; activeCustomerCount: number }
  paidCustomers: number
  totals: StatusTotals
}

type Report =
  | { month: string; rows: ResellerRow[]; totals: StatusTotals }
  | { month: string; resellerId: string; entries: CommissionEntry[]; totals: StatusTotals }

function Totals({ totals }: { totals: StatusTotals }) {
  return (
    <div className="stats">
      {(['net', 'pending', 'approved', 'payable', 'paid', 'reversed'] as const).map((k) => (
        <div key={k} className="card stat">
          <div className="muted small">{k === 'net' ? 'Net commission' : k[0].toUpperCase() + k.slice(1)}</div>
          <div className="stat-value">{formatMoney(totals[k])}</div>
        </div>
      ))}
    </div>
  )
}

/** Without `resellerId` (admin), shows one row per reseller; otherwise one line per customer. */
export function MonthlyReport({ resellerId, adminLinks }: { resellerId?: string; adminLinks?: boolean }) {
  const [month, setMonth] = useState(currentPeriod())
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let stale = false
    const params = new URLSearchParams({ month })
    if (resellerId) params.set('resellerId', resellerId)
    // Figures belong to one month: clear the previous ones so they are never shown under another month's label.
    setReport(null)
    setError(null)
    api<Report>(`/commissions/monthly-report?${params}`)
      .then((r) => {
        if (!stale) setReport(r)
      })
      .catch((err) => {
        if (!stale) setError(err instanceof ApiError ? err.message : 'Failed to load report')
      })
    // An answer for a month the user has already left must not replace the current one.
    return () => {
      stale = true
    }
  }, [month, resellerId, attempt])

  return (
    <div>
      <div className="filter-bar">
        <div className="field inline">
          <label htmlFor="report-month">Month</label>
          <input id="report-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </div>
        <strong>{monthLabel(month)}</strong>
      </div>
      {error && (
        <div className="alert error">
          {error}{' '}
          <button className="btn secondary small" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
      {!report ? (
        error ? null : <p className="muted">Loading…</p>
      ) : (
        <>
          <Totals totals={report.totals} />
          {'rows' in report ? (
            report.rows.length === 0 ? (
              <p className="muted">No commissions for this month.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Partner</th>
                      <th>Level</th>
                      <th>Active now</th>
                      <th>Customers earned</th>
                      <th style={{ textAlign: 'right' }}>Pending</th>
                      <th style={{ textAlign: 'right' }}>Approved</th>
                      <th style={{ textAlign: 'right' }}>Payable</th>
                      <th style={{ textAlign: 'right' }}>Paid</th>
                      <th style={{ textAlign: 'right' }}>Reversed</th>
                      <th style={{ textAlign: 'right' }}>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.reseller.id}>
                        <td>
                          {adminLinks ? (
                            <Link href={`/admin/resellers/${r.reseller.id}/commissions`}>{r.reseller.businessName}</Link>
                          ) : (
                            r.reseller.businessName
                          )}
                          <div className="muted small mono">{r.reseller.code}</div>
                        </td>
                        <td>{r.reseller.currentLevel ? `L${r.reseller.currentLevel}` : '—'}</td>
                        <td>{r.reseller.activeCustomerCount}</td>
                        <td>{r.paidCustomers}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(r.totals.pending)}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(r.totals.approved)}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(r.totals.payable)}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(r.totals.paid)}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(r.totals.reversed)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <strong>{formatMoney(r.totals.net)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : report.entries.length === 0 ? (
            <p className="muted">No commissions for this month.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Type</th>
                    <th>Level / rate</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {report.entries.map((e) => (
                    <tr key={e.id}>
                      <td>
                        {e.customerAccount.customer.displayName}
                        <div className="muted small">{e.product.name}</div>
                      </td>
                      <td className="small">{e.entryType === 'CLAWBACK' ? 'Clawback' : 'Monthly commission'}</td>
                      <td className="small">
                        L{e.level} · {Number(e.rate)}%
                      </td>
                      <td style={{ textAlign: 'right' }} className={Number(e.amount) < 0 ? 'negative' : undefined}>
                        {formatMoney(e.amount, e.currency)}
                      </td>
                      <td>
                        <span className={`badge ${e.status}`}>{e.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
