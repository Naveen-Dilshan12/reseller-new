'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import { ACCOUNT_STATUS_LABELS, type AccountStatus } from '@/lib/dashboard-types'
import { ResellerShell } from '@/components/ResellerShell'

interface CustomerAccountSummary {
  id: string
  status: AccountStatus
  externalTenantId: string | null
  product: {
    id: string
    code: string
    name: string
    monthlyPrice: string
    currency: string
  }
}

interface CustomerItem {
  id: string
  displayName: string
  accounts: CustomerAccountSummary[]
}

export default function ResellerCustomersPage() {
  const [customers, setCustomers] = useState<CustomerItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''
    api<CustomerItem[]>(`/customers${q}`)
      .then((data) => {
        if (!cancelled) {
          setCustomers(data)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load customers')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [search])

  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          <div className="dash-head">
            <div>
              <h1>My Customers & Accounts</h1>
              <p className="muted small">
                All business customers registered under your reseller account and their SaaS product subscriptions.
              </p>
            </div>
            <span className="spacer" />
            <div className="dash-actions">
              {user.permissions.includes('trials:create') && (
                <Link href="/trials/new" className="btn secondary">
                  New Trial
                </Link>
              )}
              {user.permissions.includes('activations:create') && (
                <Link href="/activations/new" className="btn">
                  New Activation
                </Link>
              )}
            </div>
          </div>

          <div className="card filter-bar">
            <div className="field inline" style={{ flex: 1 }}>
              <label htmlFor="c-search">Search customer name</label>
              <input
                id="c-search"
                type="text"
                placeholder="Search by customer or business name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {error && <div className="alert error">{error}</div>}

          {loading ? (
            <p className="muted">Loading customers…</p>
          ) : customers.length === 0 ? (
            <div className="card">
              <p className="muted">
                {search ? 'No customers found matching your search.' : 'You have no registered customers yet. Create a trial to add your first customer!'}
              </p>
            </div>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer Name</th>
                    <th>Linked Products & Status</th>
                    <th>Tenant Reference</th>
                    <th>Subscription Price</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.displayName}</strong>
                        <div className="small muted">ID: {c.id.slice(0, 8)}…</div>
                      </td>
                      <td>
                        {c.accounts.length === 0 ? (
                          <span className="muted small">No active accounts</span>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            {c.accounts.map((a) => (
                              <div key={a.id} className="row" style={{ gap: '0.4rem' }}>
                                <span style={{ fontWeight: 600 }}>{a.product.name}</span>
                                <span className={`badge sub-${a.status}`}>
                                  {ACCOUNT_STATUS_LABELS[a.status]}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        {c.accounts.map((a) => (
                          <div key={a.id} className="mono small">
                            {a.externalTenantId || '—'}
                          </div>
                        ))}
                      </td>
                      <td>
                        {c.accounts.map((a) => (
                          <div key={a.id} className="small">
                            {formatMoney(a.product.monthlyPrice, a.product.currency)}
                          </div>
                        ))}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '0.4rem' }}>
                          {user.permissions.includes('activations:create') && (
                            <Link
                              href={`/activations/new?customerId=${c.id}`}
                              className="btn secondary small"
                            >
                              Activate
                            </Link>
                          )}
                          {user.permissions.includes('trials:create') && (
                            <Link
                              href={`/trials/new?customerId=${c.id}`}
                              className="btn secondary small"
                            >
                              Add Product
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      )}
    </ResellerShell>
  )
}
