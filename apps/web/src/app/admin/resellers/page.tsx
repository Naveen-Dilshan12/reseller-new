'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { formatDate, formatMoney } from '@/lib/format'
import type { AdminReseller } from '@/lib/admin-types'
import { ResellerStatusDialog } from '@/components/admin/ResellerStatusDialog'

const TABS = [
  { key: '', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'SUSPENDED', label: 'Suspended' },
]

export default function ResellersPage() {
  const admin = useAdminUser()
  const canManage = admin.permissions.includes('resellers:manage')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<AdminReseller[] | null>(null)
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, counts: {} as Record<string, number> })
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ reseller: AdminReseller; action: 'suspend' | 'reactivate' } | null>(null)

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: '25' })
    if (status) params.set('status', status)
    if (query) params.set('search', query)
    apiRequest<AdminReseller[]>(`/admin/resellers?${params}`)
      .then((res) => {
        setItems(res.data)
        setMeta({
          total: res.meta?.total ?? 0,
          totalPages: res.meta?.totalPages || 1,
          counts: (res.meta?.statusCounts as Record<string, number>) ?? {},
        })
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load resellers'))
  }, [status, query, page])

  useEffect(load, [load])

  const pending = meta.counts.PENDING ?? 0

  return (
    <main className="container">
      <div className="row" style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Resellers</h1>
        <span className="spacer" />
        <Link href="/admin/reseller-applications" className="btn secondary">
          Applications{pending > 0 ? ` (${pending} pending)` : ''}
        </Link>
      </div>
      {message && <div className="alert success">{message}</div>}

      <div className="card">
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab ${status === t.key ? 'active' : ''}`}
              onClick={() => {
                setStatus(t.key)
                setPage(1)
              }}
            >
              {t.label}
              {t.key && meta.counts[t.key] !== undefined ? ` (${meta.counts[t.key]})` : ''}
            </button>
          ))}
        </div>
        <form
          className="row"
          style={{ marginBottom: '1rem' }}
          onSubmit={(e) => {
            e.preventDefault()
            setPage(1)
            setQuery(search.trim())
          }}
        >
          <div className="field" style={{ margin: 0, flex: 1 }}>
            <input placeholder="Search by code, business, name, email or mobile" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="btn secondary" type="submit">
            Search
          </button>
        </form>

        {error && <div className="alert error">{error}</div>}
        {!items ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No resellers found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reseller</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Level</th>
                  <th className="num">Active / total customers</th>
                  <th className="num">Open activations</th>
                  <th className="num">Unpaid commission</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/admin/reseller-applications/${r.id}`}>
                        <strong>{r.businessName}</strong>
                      </Link>
                      <div className="muted small mono">{r.code}</div>
                    </td>
                    <td className="small">
                      {r.fullName}
                      <div className="muted">{r.email}</div>
                    </td>
                    <td>
                      <span className={`badge ${r.status}`}>{r.status}</span>
                      {r.suspendedAt && <div className="small muted">since {formatDate(r.suspendedAt)}</div>}
                    </td>
                    <td className="small">{r.levelName ?? '—'}</td>
                    <td className="num">
                      {r.activeCustomerCount} / {r.customers}
                    </td>
                    <td className="num">{r.openActivationRequests || '—'}</td>
                    <td className="num">{formatMoney(r.unpaidCommission)}</td>
                    <td>
                      <div className="row" style={{ gap: '0.5rem', flexWrap: 'nowrap' }}>
                        <Link href={`/admin/resellers/${r.id}/products`} className="small">
                          Products
                        </Link>
                        <Link href={`/admin/resellers/${r.id}/commissions`} className="small">
                          Commissions
                        </Link>
                        {canManage && r.status === 'ACTIVE' && (
                          <button className="btn link small negative" onClick={() => setDialog({ reseller: r, action: 'suspend' })}>
                            Suspend
                          </button>
                        )}
                        {canManage && r.status === 'SUSPENDED' && (
                          <button className="btn link small" onClick={() => setDialog({ reseller: r, action: 'reactivate' })}>
                            Reactivate
                          </button>
                        )}
                      </div>
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
              Page {page} of {meta.totalPages} · {meta.total} resellers
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

      {dialog && (
        <ResellerStatusDialog
          reseller={dialog.reseller}
          action={dialog.action}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null)
            setMessage(text)
            load()
          }}
        />
      )}
    </main>
  )
}
