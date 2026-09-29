'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import {
  INTEGRATION_STATUS_LABELS,
  PRODUCT_STATUS_LABELS,
  trialLabel,
  type ProductDetail,
  type ProductListItem,
} from '@/lib/product-types'

const emptyForm = {
  code: '',
  name: '',
  description: '',
  monthlyPrice: '5500',
  status: 'INACTIVE',
  trialAvailable: false,
  trialDays: '',
}

export default function ProductsPage() {
  const router = useRouter()
  const [items, setItems] = useState<ProductListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api<ProductListItem[]>('/admin/saas-products')
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load products'))
  }, [])
  useEffect(load, [load])

  const create = async () => {
    setBusy(true)
    setFormError(null)
    try {
      const product = await api<ProductDetail>('/admin/saas-products', {
        method: 'POST',
        body: JSON.stringify({
          code: form.code.trim(),
          name: form.name.trim(),
          description: form.description.trim() || null,
          monthlyPrice: Number(form.monthlyPrice),
          status: form.status,
          trialAvailable: form.trialAvailable,
          trialDays: form.trialAvailable && form.trialDays ? Number(form.trialDays) : null,
        }),
      })
      router.push(`/admin/products/${product.id}`)
    } catch (err) {
      setFormError(err instanceof ApiError ? (err.errors[0] ?? err.message) : 'Failed to create product')
      setBusy(false)
    }
  }

  return (
    <main className="container">
      <div className="row" style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>SaaS products</h1>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => {
            setForm(emptyForm)
            setFormError(null)
            setOpen(true)
          }}
        >
          New product
        </button>
      </div>
      <p className="muted">
        Existing Hexalyte SaaS products resellers can sell. Each SaaS stays the source of truth for its tenants, billing and
        business data; this platform only keeps the catalogue entry and the server-side connection settings.
      </p>

      {error && <div className="alert error">{error}</div>}

      <div className="card">
        {!items ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No products yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Status</th>
                  <th>Monthly price</th>
                  <th>Trial</th>
                  <th>Integration</th>
                  <th>Resellers</th>
                  <th>Accounts</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/admin/products/${p.id}`}>{p.name}</Link>
                      <div className="muted small mono">{p.code}</div>
                    </td>
                    <td>
                      <span className={`badge ${p.status}`}>{PRODUCT_STATUS_LABELS[p.status]}</span>
                    </td>
                    <td>{formatMoney(p.monthlyPrice, p.currency)}</td>
                    <td className="small">{trialLabel(p)}</td>
                    <td>
                      <span className={`badge ${p.integrationStatus}`}>{INTEGRATION_STATUS_LABELS[p.integrationStatus]}</span>
                      <div className="muted small">{p.integration?.provider ?? '—'}</div>
                    </td>
                    <td>{p._count.resellerAccess}</td>
                    <td>{p._count.accounts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal wide">
            <h2>New SaaS product</h2>
            <p className="small muted">
              Registers an existing Hexalyte SaaS. It starts in manual fulfilment; connect its partner API afterwards.
            </p>
            {formError && <div className="alert error">{formError}</div>}
            <div className="grid-2">
              <div className="field">
                <label htmlFor="np-code">Code</label>
                <input id="np-code" placeholder="e.g. PHARMACY" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} />
                <span className="hint">Permanent identifier; cannot be changed later.</span>
              </div>
              <div className="field">
                <label htmlFor="np-name">Name</label>
                <input id="np-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="field span-2">
                <label htmlFor="np-desc">Description</label>
                <textarea id="np-desc" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="np-price">Monthly price (LKR)</label>
                <input id="np-price" type="number" min="1" step="0.01" value={form.monthlyPrice} onChange={(e) => setForm((f) => ({ ...f, monthlyPrice: e.target.value }))} />
                <span className="hint">Commission is calculated on this amount.</span>
              </div>
              <div className="field">
                <label htmlFor="np-status">Status</label>
                <select id="np-status" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                  {Object.entries(PRODUCT_STATUS_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <label className="row small">
                <input type="checkbox" checked={form.trialAvailable} onChange={(e) => setForm((f) => ({ ...f, trialAvailable: e.target.checked }))} />
                Free trial available
              </label>
              {form.trialAvailable && (
                <div className="field">
                  <label htmlFor="np-trial">Trial days (optional)</label>
                  <input id="np-trial" type="number" min="1" max="90" value={form.trialDays} onChange={(e) => setForm((f) => ({ ...f, trialDays: e.target.value }))} />
                </div>
              )}
            </div>
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn" onClick={create} disabled={busy}>
                Create product
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
