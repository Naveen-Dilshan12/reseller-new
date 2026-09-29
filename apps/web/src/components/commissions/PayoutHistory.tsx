'use client'

import { useEffect, useState } from 'react'
import { apiRequest, ApiError } from '@/lib/api'
import { formatDate, formatMoney } from '@/lib/format'
import type { Payout } from '@/lib/commission-types'

export function PayoutHistory({ resellerId, showReseller, refreshKey }: { resellerId?: string; showReseller?: boolean; refreshKey?: number }) {
  const [items, setItems] = useState<Payout[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams({ limit: '50' })
    if (resellerId) params.set('resellerId', resellerId)
    apiRequest<Payout[]>(`/commissions/payouts?${params}`)
      .then((r) => setItems(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load payouts'))
  }, [resellerId, refreshKey])

  if (error) return <div className="alert error">{error}</div>
  if (!items) return <p className="muted">Loading…</p>
  if (items.length === 0) return <p className="muted">No payouts yet.</p>

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Paid on</th>
            {showReseller && <th>Reseller</th>}
            <th>Payment reference</th>
            <th>Entries</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>{formatDate(p.paidAt)}</td>
              {showReseller && <td>{p.reseller.businessName}</td>}
              <td className="mono">{p.paymentReference}</td>
              <td>{p._count.commissions}</td>
              <td style={{ textAlign: 'right' }}>{formatMoney(p.totalAmount, p.currency)}</td>
              <td className="small muted">{p.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
