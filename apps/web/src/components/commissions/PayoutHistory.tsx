'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiRequest, ApiError } from '@/lib/api'
import { formatDate, formatMoney } from '@/lib/format'
import { createLatestLoader, outOfRangePage } from '@/lib/paged-list'
import type { Payout } from '@/lib/commission-types'

const PAGE_SIZE = 50

interface Loaded {
  /** Which page + reseller this answer is for; an answer is only shown while it still matches the screen. */
  key: string
  items: Payout[]
  totalPages: number
}

export function PayoutHistory({ resellerId, showReseller, refreshKey }: { resellerId?: string; showReseller?: boolean; refreshKey?: number }) {
  const [page, setPage] = useState(1)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  // Only the newest request may update the screen, so a slow older answer cannot replace a newer one.
  const [loadLatest] = useState(createLatestLoader)
  const key = `${page}|${resellerId ?? ''}`

  const load = useCallback(() => {
    const requestKey = `${page}|${resellerId ?? ''}`
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })
    if (resellerId) params.set('resellerId', resellerId)
    setFailure(null)
    loadLatest(() => apiRequest<Payout[]>(`/commissions/payouts?${params}`), {
      onSuccess: (res) => {
        const lastPage = outOfRangePage(page, res.meta?.total, res.meta?.totalPages)
        if (lastPage !== null) {
          setPage(lastPage) // the list is shorter than it was: go to the last real page, which reloads
          return
        }
        setLoaded({ key: requestKey, items: res.data, totalPages: res.meta?.totalPages || 1 })
      },
      onError: (err) => {
        setLoaded(null)
        setFailure({ key: requestKey, message: err instanceof ApiError ? err.message : 'Failed to load payouts' })
      },
    })
  }, [page, resellerId, loadLatest])

  useEffect(load, [load, refreshKey])

  const current = loaded?.key === key ? loaded : null
  const failed = failure?.key === key ? failure.message : null

  if (failed) {
    return (
      <div>
        <div className="alert error">{failed}</div>
        <button className="btn secondary small" onClick={load}>
          Retry
        </button>
      </div>
    )
  }
  if (!current) return <p className="muted">Loading…</p>
  if (current.items.length === 0) return <p className="muted">No payouts yet.</p>

  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Paid on</th>
              {showReseller && <th>Partner</th>}
              <th>Payment reference</th>
              <th>Entries</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {current.items.map((p) => (
              <tr key={p.id}>
                <td>{formatDate(p.paidAt)}</td>
                {showReseller && (
                  <td>
                    {p.reseller.businessName}
                    <div className="muted small mono">{p.reseller.code}</div>
                  </td>
                )}
                <td className="mono">{p.paymentReference}</td>
                <td>{p._count.commissions}</td>
                <td style={{ textAlign: 'right' }}>{formatMoney(p.totalAmount, p.currency)}</td>
                <td className="small muted">{p.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {current.totalPages > 1 && (
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <span className="spacer" />
          <button className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span className="small muted">
            {page} / {current.totalPages}
          </span>
          <button className="btn secondary" disabled={page >= current.totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  )
}
