'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'

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

const TABS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'ACTIVE', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: '', label: 'All' },
]

export default function ApplicationsPage() {
  const [status, setStatus] = useState('PENDING')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<ApplicationSummary[]>([])
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, pendingCount: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: '20' })
    if (status) params.set('status', status)
    if (query) params.set('search', query)
    setLoading(true)
    apiRequest<ApplicationSummary[]>(`/admin/reseller-applications?${params}`)
      .then((res) => {
        setItems(res.data)
        setMeta({
          total: res.meta?.total ?? 0,
          totalPages: res.meta?.totalPages || 1,
          pendingCount: Number(res.meta?.pendingCount ?? 0),
        })
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load applications'))
      .finally(() => setLoading(false))
  }, [status, query, page])

  return (
    <main className="container">
      <div className="row" style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Reseller applications</h1>
        {meta.pendingCount > 0 && <span className="badge PENDING">{meta.pendingCount} pending</span>}
      </div>

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
            <input
              placeholder="Search by name, business, email, code, NIC or registration number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button className="btn secondary" type="submit">
            Search
          </button>
        </form>

        {error && <div className="alert error">{error}</div>}

        {loading ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No applications found.</p>
        ) : (
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
                  <td className="small">{new Date(a.submittedAt).toLocaleString()}</td>
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
        )}

        {meta.totalPages > 1 && (
          <div className="row" style={{ marginTop: '1rem' }}>
            <span className="muted small">
              Page {page} of {meta.totalPages} · {meta.total} applications
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
    </main>
  )
}
