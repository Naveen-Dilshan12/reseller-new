'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { formatDate, formatMoney } from '@/lib/format'
import type { AdminReseller } from '@/lib/admin-types'
import { ResellerStatusDialog } from '@/components/admin/ResellerStatusDialog'
import { AdminPageHeader } from '@/components/admin/AdminPageHeader'
import { createLatestLoader, INITIAL_LIST_VIEW, listQuery, outOfRangePage, withPage, withSearch, withStatus, type ListView } from '@/lib/paged-list'

const PAGE_SIZE = 25
const TABS = [
  { key: '', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'SUSPENDED', label: 'Suspended' },
]

export default function ResellersPage() {
  const admin = useAdminUser()
  const canManage = admin.permissions.includes('resellers:manage')
  const [view, setView] = useState<ListView>(INITIAL_LIST_VIEW)
  const [search, setSearch] = useState('')
  const [loadLatest] = useState(createLatestLoader)
  const [items, setItems] = useState<AdminReseller[] | null>(null)
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, counts: {} as Record<string, number> })
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ reseller: AdminReseller; action: 'suspend' | 'reactivate' } | null>(null)

  // Only the newest request may update the screen, so a slow older response cannot overwrite a newer one.
  const load = useCallback(() => {
    loadLatest(() => apiRequest<AdminReseller[]>(`/admin/resellers?${listQuery(view, PAGE_SIZE)}`), {
      onSuccess: (res) => {
        const lastPage = outOfRangePage(view.page, res.meta?.total, res.meta?.totalPages)
        if (lastPage !== null) {
          // The list shrank (e.g. the only row on this page was reactivated): go to the last real page, which reloads.
          setView((v) => withPage(v, lastPage))
          return
        }
        setItems(res.data)
        setMeta({
          total: res.meta?.total ?? 0,
          totalPages: res.meta?.totalPages || 1,
          counts: (res.meta?.statusCounts as Record<string, number>) ?? {},
        })
        setError(null)
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to load partners'),
    })
  }, [view, loadLatest])

  useEffect(load, [load])

  const pending = meta.counts.PENDING ?? 0

  return (
    <main className="container">
      <AdminPageHeader
        title="Partners"
        subtitle="Approved partner companies. Open a partner to manage product access and commissions, or suspend and reactivate the account."
        actions={
          <Link href="/admin/reseller-applications" className="btn secondary">
            Applications{pending > 0 ? ` (${pending} pending)` : ''}
          </Link>
        }
      />
      {message && <div className="alert success">{message}</div>}

      <div className="card">
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab ${view.status === t.key ? 'active' : ''}`}
              onClick={() => setView((v) => withStatus(v, t.key))}
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
            setView((v) => withSearch(v, search))
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
          <p className="muted">No partners found.</p>
        ) : (
          <div className="table-wrap table-cards">
            <table>
              <thead>
                <tr>
                  <th>Partner</th>
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
                    <td className="small" data-label="Contact">
                      <div>
                        {r.fullName}
                        <div className="muted">{r.email}</div>
                      </div>
                    </td>
                    <td data-label="Status">
                      <div>
                        <span className={`badge ${r.status}`}>{r.status}</span>
                        {r.suspendedAt && <div className="small muted">since {formatDate(r.suspendedAt)}</div>}
                      </div>
                    </td>
                    <td className="small" data-label="Level">{r.levelName ?? '—'}</td>
                    <td className="num" data-label="Active / total customers">
                      {r.activeCustomerCount} / {r.customerAccounts}
                    </td>
                    <td className="num" data-label="Open activations">{r.openActivationRequests || '—'}</td>
                    <td className="num" data-label="Unpaid commission">{formatMoney(r.unpaidCommission)}</td>
                    <td>
                      <div className="row row-actions">
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
              Page {view.page} of {meta.totalPages} · {meta.total} partners
            </span>
            <span className="spacer" />
            <button className="btn secondary" disabled={view.page <= 1} onClick={() => setView((v) => withPage(v, v.page - 1))}>
              Previous
            </button>
            <button className="btn secondary" disabled={view.page >= meta.totalPages} onClick={() => setView((v) => withPage(v, v.page + 1))}>
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
