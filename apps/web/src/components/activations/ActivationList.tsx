'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import { ACTIVATION_STATUS_LABELS, type ActivationListItem, type ActivationStatus } from '@/lib/activation-types'

interface Props {
  basePath: '/activations' | '/admin/activations'
  showReseller?: boolean
  /** Comma-separated statuses selected initially. */
  defaultStatus?: string
}

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'PENDING_REVIEW,UNDER_REVIEW', label: 'Needs review' },
  { value: 'APPROVED', label: 'Approved – awaiting activation' },
  ...(['PENDING_REVIEW', 'UNDER_REVIEW', 'ACTIVATION_COMPLETED', 'REJECTED', 'CANCELLED'] as ActivationStatus[]).map((s) => ({
    value: s,
    label: ACTIVATION_STATUS_LABELS[s],
  })),
]

export function ActivationList({ basePath, showReseller, defaultStatus = '' }: Props) {
  const [items, setItems] = useState<ActivationListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState(defaultStatus)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: '50' })
    if (status) params.set('status', status)
    if (search.trim()) params.set('search', search.trim())
    apiRequest<ActivationListItem[]>(`/activation-requests?${params}`)
      .then((r) => {
        setItems(r.data)
        setTotal(r.meta?.total ?? r.data.length)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load activation requests'))
  }, [status, search])

  useEffect(load, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {error && <div className="alert error">{error}</div>}
      <form
        className="row"
        style={{ marginBottom: '0.75rem' }}
        onSubmit={(e) => {
          e.preventDefault()
          load()
        }}
      >
        <div className="field inline">
          <label htmlFor="ar-status">Status</label>
          <select id="ar-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field inline" style={{ flex: 1 }}>
          <label htmlFor="ar-search">Search</label>
          <input id="ar-search" placeholder="Reference, bank reference or customer" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="btn secondary" type="submit">
          Search
        </button>
      </form>

      {!items ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No activation requests.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Product</th>
                {showReseller && <th>Reseller</th>}
                <th>Month</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="mono">
                    <Link href={`${basePath}/${a.id}`}>{a.reference}</Link>
                  </td>
                  <td>{a.customerAccount.customer.displayName}</td>
                  <td>{a.product.name}</td>
                  {showReseller && (
                    <td className="small">
                      {a.reseller.businessName}
                      <div className="muted mono">{a.reseller.code}</div>
                    </td>
                  )}
                  <td>{monthLabel(a.periodMonth)}</td>
                  <td className="num">{formatMoney(a.amount, a.currency)}</td>
                  <td>
                    <span className={`badge act-${a.status}`}>{ACTIVATION_STATUS_LABELS[a.status]}</span>
                    {a.status === 'UNDER_REVIEW' && a.paymentVerifiedAt && <div className="small muted">Payment verified</div>}
                  </td>
                  <td className="small">{formatDate(a.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > items.length && <p className="small muted">Showing {items.length} of {total}. Narrow the search to see more.</p>}
        </div>
      )}
    </>
  )
}
