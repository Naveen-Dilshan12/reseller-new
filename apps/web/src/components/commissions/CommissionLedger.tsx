'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, apiRequest, ApiError } from '@/lib/api'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import type { CommissionEntry } from '@/lib/commission-types'

const STATUSES = ['', 'PENDING', 'APPROVED', 'PAYABLE', 'PAID', 'REVERSED']

interface Props {
  resellerId?: string
  /** Enables approve / reverse actions. */
  manage?: boolean
  showReseller?: boolean
  initialStatus?: string
  /** Changing this value reloads the table. */
  refreshKey?: number
  onChanged?: () => void
}

export function CommissionLedger({ resellerId, manage, showReseller, initialStatus = '', refreshKey, onChanged }: Props) {
  const [status, setStatus] = useState(initialStatus)
  const [month, setMonth] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<CommissionEntry[]>([])
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, netAmount: '0' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [reversing, setReversing] = useState<CommissionEntry | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: '25' })
    if (status) params.set('status', status)
    if (month) params.set('periodMonth', month)
    if (resellerId) params.set('resellerId', resellerId)
    apiRequest<CommissionEntry[]>(`/commissions?${params}`)
      .then((res) => {
        setItems(res.data)
        setMeta({ total: res.meta?.total ?? 0, totalPages: res.meta?.totalPages || 1, netAmount: String(res.meta?.netAmount ?? '0') })
        setSelected(new Set())
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load commissions'))
  }, [page, status, month, resellerId])

  useEffect(load, [load, refreshKey])

  const pendingIds = items.filter((i) => i.status === 'PENDING').map((i) => i.id)
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const approve = async () => {
    setBusy(true)
    try {
      const r = await api<{ approved: number; payable: number; skipped: number }>('/commissions/approve', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selected] }),
      })
      setMessage(`Approved ${r.approved + r.payable} commission(s): ${r.payable} payable now, ${r.approved} on refund hold.`)
      load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Approval failed')
    } finally {
      setBusy(false)
    }
  }

  const reverse = async () => {
    if (!reversing || reason.trim().length < 5) return
    setBusy(true)
    try {
      await api(`/commissions/${reversing.id}/reverse`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) })
      setMessage(
        reversing.status === 'PAID'
          ? 'Paid commission reversed: a clawback was added to the next payout.'
          : 'Commission reversed.',
      )
      setReversing(null)
      setReason('')
      load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reversal failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <div className="field inline">
          <label htmlFor="ledger-status">Status</label>
          <select
            id="ledger-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || 'All'}
              </option>
            ))}
          </select>
        </div>
        <div className="field inline">
          <label htmlFor="ledger-month">Month</label>
          <input
            id="ledger-month"
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value)
              setPage(1)
            }}
          />
        </div>
        <span className="spacer" />
        <span className="small muted">
          {meta.total} entries · net {formatMoney(meta.netAmount)}
        </span>
        {manage && (
          <button className="btn" disabled={selected.size === 0 || busy} onClick={approve}>
            Approve selected ({selected.size})
          </button>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}
      {message && <div className="alert success">{message}</div>}

      {items.length === 0 ? (
        <p className="muted">No commission entries.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {manage && (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all pending"
                      checked={pendingIds.length > 0 && pendingIds.every((id) => selected.has(id))}
                      onChange={(e) => setSelected(e.target.checked ? new Set(pendingIds) : new Set())}
                    />
                  </th>
                )}
                <th>Month</th>
                {showReseller && <th>Reseller</th>}
                <th>Customer</th>
                <th>Level / rate</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Status</th>
                <th>Details</th>
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  {manage && (
                    <td>
                      {c.status === 'PENDING' && (
                        <input type="checkbox" aria-label="Select" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                      )}
                    </td>
                  )}
                  <td>{monthLabel(c.periodMonth)}</td>
                  {showReseller && (
                    <td>
                      {c.reseller.businessName}
                      <div className="muted small mono">{c.reseller.code}</div>
                    </td>
                  )}
                  <td>
                    {c.customerAccount.customer.displayName}
                    <div className="muted small">{c.product.name}</div>
                  </td>
                  <td className="small">
                    {c.entryType === 'CLAWBACK' ? 'Clawback' : `L${c.level} · ${Number(c.rate)}% of ${formatMoney(c.baseAmount, c.currency)}`}
                  </td>
                  <td style={{ textAlign: 'right' }} className={Number(c.amount) < 0 ? 'negative' : undefined}>
                    {formatMoney(c.amount, c.currency)}
                  </td>
                  <td>
                    <span className={`badge ${c.status}`}>{c.status}</span>
                    {c.reversedAt && c.status === 'PAID' && <div className="small negative">clawed back</div>}
                  </td>
                  <td className="small muted">
                    {c.status === 'APPROVED' && `Payable from ${formatDate(c.payableAt)}`}
                    {c.payout && `Ref ${c.payout.paymentReference} · ${formatDate(c.payout.paidAt)}`}
                    {c.reversalReason && <div>{c.reversalReason}</div>}
                  </td>
                  {manage && (
                    <td>
                      {c.entryType === 'EARNING' && c.status !== 'REVERSED' && !c.reversedAt && (
                        <button className="btn link small" onClick={() => setReversing(c)}>
                          Reverse
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {meta.totalPages > 1 && (
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <span className="spacer" />
          <button className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span className="small muted">
            {page} / {meta.totalPages}
          </span>
          <button className="btn secondary" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}

      {reversing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Reverse commission</h2>
            <p className="small muted">
              {reversing.customerAccount.customer.displayName} · {monthLabel(reversing.periodMonth)} ·{' '}
              {formatMoney(reversing.amount, reversing.currency)}
            </p>
            {reversing.status === 'PAID' && (
              <div className="alert warning">
                This commission was already paid. A clawback of {formatMoney(reversing.amount, reversing.currency)} will be
                deducted from the reseller&apos;s next payout.
              </div>
            )}
            <div className="field">
              <label htmlFor="reverse-reason">Reason</label>
              <textarea id="reverse-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
              <span className="hint">Minimum 5 characters. Visible to the reseller.</span>
            </div>
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setReversing(null)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" onClick={reverse} disabled={busy || reason.trim().length < 5}>
                Reverse
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
