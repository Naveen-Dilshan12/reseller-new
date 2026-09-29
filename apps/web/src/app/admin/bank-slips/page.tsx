'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'
import { formatMoney, monthLabel } from '@/lib/format'
import { ACTIVATION_STATUS_LABELS, formatBytes, type ActivationStatus, type BankSlipInfo } from '@/lib/activation-types'
import { BankSlipViewer } from '@/components/activations/ActivationParts'

interface SlipRow extends BankSlipInfo {
  uploadedTimes: number
  reseller: { id: string; code: string; businessName: string }
  activationRequest: {
    id: string
    reference: string
    status: ActivationStatus
    amount: string
    currency: string
    transactionRef: string
    periodMonth: string
    paymentVerifiedAt: string | null
    product: { name: string }
    customerAccount: { customer: { displayName: string } }
  }
}

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'PENDING_REVIEW,UNDER_REVIEW', label: 'Needs review' },
  { value: 'APPROVED', label: 'Approved – awaiting activation' },
  { value: 'ACTIVATION_COMPLETED', label: 'Activated' },
  { value: 'REJECTED', label: 'Rejected' },
]

export default function BankSlipsPage() {
  const [status, setStatus] = useState('')
  const [duplicatesOnly, setDuplicatesOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<SlipRow[] | null>(null)
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 })
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<SlipRow | null>(null)

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: '25' })
    if (status) params.set('status', status)
    if (duplicatesOnly) params.set('duplicatesOnly', 'true')
    if (search.trim()) params.set('search', search.trim())
    apiRequest<SlipRow[]>(`/bank-slips?${params}`)
      .then((r) => {
        setItems(r.data)
        setMeta({ total: r.meta?.total ?? 0, totalPages: r.meta?.totalPages || 1 })
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load bank slips'))
  }, [status, duplicatesOnly, search, page])

  useEffect(load, [status, duplicatesOnly, page]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="container">
      <h1>Bank slips</h1>
      <p className="muted">
        Slips uploaded with activation requests. Files are stored encrypted in private storage; every time a slip is
        opened, the viewer is recorded in the audit log.
      </p>
      <div className="card">
        <form
          className="row"
          style={{ marginBottom: '0.75rem' }}
          onSubmit={(e) => {
            e.preventDefault()
            setPage(1)
            load()
          }}
        >
          <div className="field inline">
            <label htmlFor="bs-status">Request status</label>
            <select
              id="bs-status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field inline" style={{ flex: 1 }}>
            <label htmlFor="bs-search">Search</label>
            <input id="bs-search" placeholder="Request reference, bank reference or customer" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <label className="checkbox" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={duplicatesOnly}
              onChange={(e) => {
                setDuplicatesOnly(e.target.checked)
                setPage(1)
              }}
            />
            Duplicates only
          </label>
          <button className="btn secondary" type="submit">
            Search
          </button>
        </form>

        {error && <div className="alert error">{error}</div>}
        {!items ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No bank slips found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Customer / product</th>
                  <th>Reseller</th>
                  <th className="num">Amount</th>
                  <th>Bank reference</th>
                  <th>File</th>
                  <th>Uploaded</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/admin/activations/${s.activationRequest.id}`} className="mono">
                        {s.activationRequest.reference}
                      </Link>
                      <div>
                        <span className={`badge act-${s.activationRequest.status}`}>{ACTIVATION_STATUS_LABELS[s.activationRequest.status]}</span>
                      </div>
                    </td>
                    <td className="small">
                      {s.activationRequest.customerAccount.customer.displayName}
                      <div className="muted">
                        {s.activationRequest.product.name} · {monthLabel(s.activationRequest.periodMonth)}
                      </div>
                    </td>
                    <td className="small">
                      {s.reseller.businessName}
                      <div className="muted mono">{s.reseller.code}</div>
                    </td>
                    <td className="num">{formatMoney(s.activationRequest.amount, s.activationRequest.currency)}</td>
                    <td className="small mono">{s.activationRequest.transactionRef}</td>
                    <td className="small">
                      {s.mimeType === 'application/pdf' ? 'PDF' : 'Image'} · {formatBytes(s.sizeBytes)}
                      {s.uploadedTimes > 1 && <div className="negative">Same file used {s.uploadedTimes}×</div>}
                    </td>
                    <td className="small">{new Date(s.createdAt).toLocaleString()}</td>
                    <td>
                      <button className="btn link small" onClick={() => setViewing(s)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {meta.totalPages > 1 && (
          <div className="row" style={{ marginTop: '1rem' }}>
            <span className="muted small">
              Page {page} of {meta.totalPages} · {meta.total} slips
            </span>
            <span className="spacer" />
            <button className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <button className="btn secondary" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        )}
      </div>

      {viewing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal wide">
            <div className="row">
              <h2 style={{ margin: 0 }}>
                Bank slip · <span className="mono">{viewing.activationRequest.reference}</span>
              </h2>
              <span className="spacer" />
              <button className="btn secondary small" onClick={() => setViewing(null)}>
                Close
              </button>
            </div>
            <BankSlipViewer requestId={viewing.activationRequest.id} slip={viewing} />
          </div>
        </div>
      )}
    </main>
  )
}
