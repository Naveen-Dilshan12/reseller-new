'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { AdminPageHeader } from '@/components/admin/AdminPageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pagination, type PaginationMeta } from '@/components/ui/Pagination'
import { createLatestLoader, INITIAL_LIST_VIEW, listQuery, outOfRangePage, withPage, withSearch, withStatus, type ListView } from '@/lib/paged-list'

interface ApplicationSummary {
  id: string
  code: string
  fullName: string
  email: string
  mobile: string
  businessName: string
  businessRegistrationNo: string
  status: string
  submittedAt: string
  reviewedAt: string | null
}

const PAGE_SIZE = 20
const TABS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'ACTIVE', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: '', label: 'All' },
]

export default function ApplicationsPage() {
  const [view, setView] = useState<ListView>({ ...INITIAL_LIST_VIEW, status: 'PENDING' })
  const [search, setSearch] = useState('')
  const [loadLatest] = useState(createLatestLoader)
  const [items, setItems] = useState<ApplicationSummary[] | null>(null)
  const [meta, setMeta] = useState<PaginationMeta | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Only the newest request may update the screen, so a slow older response cannot overwrite a newer one.
  const load = useCallback(() => {
    setLoading(true)
    loadLatest(() => apiRequest<ApplicationSummary[]>(`/admin/reseller-applications?${listQuery(view, PAGE_SIZE)}`), {
      onSuccess: (res) => {
        const lastPage = outOfRangePage(view.page, res.meta?.total, res.meta?.totalPages)
        if (lastPage !== null) {
          // The list shrank while the admin was on a later page: go to the last real page, which reloads.
          setView((v) => withPage(v, lastPage))
          return
        }
        setItems(res.data)
        setMeta({
          total: res.meta?.total ?? 0,
          page: res.meta?.page ?? view.page,
          limit: res.meta?.limit ?? PAGE_SIZE,
          totalPages: res.meta?.totalPages || 1,
        })
        setPendingCount(Number(res.meta?.pendingCount ?? 0))
        setError(null)
        setLoading(false)
      },
      onError: (err) => {
        setError(err instanceof ApiError ? err.message : 'Failed to load applications')
        setLoading(false)
      },
    })
  }, [view, loadLatest])

  useEffect(load, [load])

  return (
    <main className="container">
      <AdminPageHeader
        title="Partner applications"
        subtitle="New partner sign-ups waiting for review. Open an application to approve or reject it; approved partners move to the Partners list."
        actions={
          <Link href="/admin/resellers" className="btn secondary">
            Partners
          </Link>
        }
      />

      <div className="card">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab ${view.status === t.key ? 'active' : ''}`} onClick={() => setView((v) => withStatus(v, t.key))}>
              {t.label}
              {t.key === 'PENDING' && pendingCount > 0 ? ` (${pendingCount})` : ''}
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
            <input
              id="app-search"
              aria-label="Search applications"
              placeholder="Search by name, business, email, code, NIC or registration number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button className="btn secondary" type="submit">
            Search
          </button>
        </form>

        {error && (
          <div className="alert error" role="alert">
            {error}{' '}
            <button className="btn secondary small" onClick={load} disabled={loading}>
              Retry
            </button>
          </div>
        )}

        {!items ? (
          error ? null : <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState
            title="No applications found"
            hint={view.query || view.status !== 'PENDING' ? 'No applications match the current filters.' : 'There are no applications waiting for review.'}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Business</th>
                  <th>Applicant</th>
                  <th>Submitted</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.code}</td>
                    <td>
                      <strong>{a.businessName}</strong>
                      <div className="muted small">{a.businessRegistrationNo}</div>
                    </td>
                    <td>
                      {a.fullName}
                      <div className="muted small">{a.email}</div>
                    </td>
                    <td className="small">{formatDate(a.submittedAt)}</td>
                    <td>
                      <span className={`badge ${a.status}`}>{a.status === 'ACTIVE' ? 'APPROVED' : a.status}</span>
                    </td>
                    <td>
                      <Link href={`/admin/reseller-applications/${a.id}`}>{a.status === 'PENDING' ? 'Review' : 'View'}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination meta={meta} onPage={(p) => setView((v) => withPage(v, p))} noun="applications" busy={loading} />
          </div>
        )}
      </div>
    </main>
  )
}
