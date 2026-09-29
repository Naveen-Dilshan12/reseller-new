'use client'

import { useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { formatMoney, monthLabel } from '@/lib/format'
import type { CustomerCommissionRow } from '@/lib/commission-types'

export function CustomerCommissions({ resellerId, showReseller }: { resellerId?: string; showReseller?: boolean }) {
  const [month, setMonth] = useState('')
  const [rows, setRows] = useState<CustomerCommissionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams()
    if (resellerId) params.set('resellerId', resellerId)
    if (month) params.set('periodMonth', month)
    api<CustomerCommissionRow[]>(`/commissions/by-customer?${params}`)
      .then((r) => {
        setRows(r)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load'))
  }, [resellerId, month])

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <div className="field inline">
          <label htmlFor="cust-month">Month</label>
          <input id="cust-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <span className="muted small">{month ? `Showing ${monthLabel(month)}` : 'All time'}</span>
      </div>
      {error && <div className="alert error">{error}</div>}
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No customer commissions yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                {showReseller && <th>Reseller</th>}
                <th>Subscription</th>
                <th>Months</th>
                <th>Last month</th>
                <th style={{ textAlign: 'right' }}>Net earned</th>
                <th style={{ textAlign: 'right' }}>Paid</th>
                <th style={{ textAlign: 'right' }}>Reversed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.customerAccount.id}>
                  <td>
                    {r.customerAccount.customer.displayName}
                    <div className="muted small">{r.customerAccount.product.name}</div>
                  </td>
                  {showReseller && <td className="small">{r.customerAccount.reseller.businessName}</td>}
                  <td>
                    <span className={`badge sub-${r.customerAccount.status}`}>{r.customerAccount.status}</span>
                  </td>
                  <td>{r.entries}</td>
                  <td>{r.lastPeriod ? monthLabel(r.lastPeriod) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(r.netEarned)}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(r.paid)}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(r.reversed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
