'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import { trialLabel, type ResellerProduct } from '@/lib/product-types'
import { ResellerShell } from '@/components/ResellerShell'

export default function ResellerProductsPage() {
  const [products, setProducts] = useState<ResellerProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<ResellerProduct[]>('/products')
      .then((data) => {
        setProducts(data)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load products'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          <div className="dash-head">
            <div>
              <h1>SaaS Products Catalogue</h1>
              <p className="muted small">
                Explore the Hexalyte SaaS products you are authorized to sell. Create trials or submit activations for your clients.
              </p>
            </div>
          </div>

          {error && <div className="alert error">{error}</div>}

          {loading ? (
            <p className="muted">Loading products…</p>
          ) : products.length === 0 ? (
            <div className="card">
              <p className="muted">No products available in your catalogue at this time.</p>
            </div>
          ) : (
            <div className="product-grid">
              {products.map((p) => (
                <div key={p.id} className="card product-card">
                  <div className="row" style={{ marginBottom: '0.5rem' }}>
                    <span className="mono small muted">{p.code}</span>
                    <span className="spacer" />
                    <span className="badge ACTIVE">{trialLabel(p)}</span>
                  </div>

                  <h3>{p.name}</h3>

                  <div className="price">
                    {formatMoney(p.monthlyPrice, p.currency)}
                    <span className="small muted"> / month</span>
                  </div>

                  {p.description && <p className="muted small" style={{ minHeight: '3rem' }}>{p.description}</p>}

                  <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {p.canCreateTrial && user.permissions.includes('trials:create') ? (
                      <Link href={`/trials/new?productId=${p.id}`} className="btn" style={{ flex: 1, textAlign: 'center' }}>
                        Start Trial
                      </Link>
                    ) : (
                      <button className="btn secondary" disabled style={{ flex: 1 }} title={p.reason ?? 'Trial unavailable'}>
                        {p.trialAvailable ? 'Trial via Console' : 'No Free Trial'}
                      </button>
                    )}

                    {user.permissions.includes('activations:create') && (
                      <Link href={`/activations/new?productId=${p.id}`} className="btn secondary" style={{ flex: 1, textAlign: 'center' }}>
                        Activate
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      )}
    </ResellerShell>
  )
}
