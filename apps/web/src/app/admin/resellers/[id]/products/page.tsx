'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { formatDate, formatMoney } from '@/lib/format'
import { PRODUCT_STATUS_LABELS, type AccessStatus, type Product } from '@/lib/product-types'

interface AccessRow {
  product: Product
  access: { status: AccessStatus; note: string | null; statusChangedAt: string } | null
  customerAccounts: number
}

const ACCESS_LABELS: Record<AccessStatus, string> = { ACTIVE: 'Enabled', SUSPENDED: 'Suspended', REVOKED: 'Revoked' }

export default function ResellerProductAccessPage() {
  const { id } = useParams<{ id: string }>()
  const admin = useAdminUser()
  const canManage = admin.permissions.includes('resellers:manage')

  const [rows, setRows] = useState<AccessRow[] | null>(null)
  const [reseller, setReseller] = useState<{ businessName: string; code: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ row: AccessRow; status: AccessStatus; note: string } | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api<AccessRow[]>(`/admin/resellers/${id}/product-access`)
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load'))
  }, [id])

  useEffect(() => {
    load()
    api<{ code: string; business: { businessName: string } }>(`/admin/reseller-applications/${id}`)
      .then((r) => setReseller({ code: r.code, businessName: r.business.businessName }))
      .catch(() => setReseller(null))
  }, [id, load])

  const save = async () => {
    if (!editing) return
    setBusy(true)
    setDialogError(null)
    try {
      await api(`/admin/resellers/${id}/product-access/${editing.row.product.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: editing.status, ...(editing.note.trim() ? { note: editing.note.trim() } : {}) }),
      })
      setMessage(`${editing.row.product.name}: access ${ACCESS_LABELS[editing.status].toLowerCase()}.`)
      setEditing(null)
      load()
    } catch (err) {
      setDialogError(err instanceof ApiError ? (err.errors[0] ?? err.message) : 'Failed to update access')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <main className="container"><div className="alert error">{error}</div></main>

  return (
    <main className="container">
      <Link href={`/admin/reseller-applications/${id}`} className="small">
        ← Reseller profile
      </Link>
      <div className="row" style={{ margin: '0.75rem 0 1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>SaaS product access</h1>
          {reseller && (
            <span className="muted small">
              {reseller.businessName} · <span className="mono">{reseller.code}</span>
            </span>
          )}
        </div>
      </div>
      <p className="muted">
        Controls which products this reseller can sell. Suspending or revoking access blocks new customers for that product;
        existing customer accounts and earned commissions are not changed.
      </p>

      {message && <div className="alert success">{message}</div>}

      <div className="card">
        {!rows ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Product status</th>
                  <th>Price</th>
                  <th>Access</th>
                  <th>Customer accounts</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.product.id}>
                    <td>
                      {r.product.name}
                      <div className="muted small mono">{r.product.code}</div>
                    </td>
                    <td>
                      <span className={`badge ${r.product.status}`}>{PRODUCT_STATUS_LABELS[r.product.status]}</span>
                    </td>
                    <td className="small">{formatMoney(r.product.monthlyPrice, r.product.currency)}</td>
                    <td>
                      {r.access ? (
                        <>
                          <span className={`badge ${r.access.status}`}>{ACCESS_LABELS[r.access.status]}</span>
                          <div className="muted small">since {formatDate(r.access.statusChangedAt)}</div>
                          {r.access.note && <div className="small">{r.access.note}</div>}
                        </>
                      ) : (
                        <span className="muted small">Not granted</span>
                      )}
                    </td>
                    <td>{r.customerAccounts}</td>
                    <td>
                      {canManage && (
                        <button
                          className="btn link small"
                          onClick={() => {
                            setDialogError(null)
                            setEditing({ row: r, status: r.access?.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE', note: '' })
                          }}
                        >
                          Change access
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>{editing.row.product.name} access</h2>
            {dialogError && <div className="alert error">{dialogError}</div>}
            <div className="field">
              <label htmlFor="ac-status">Access</label>
              <select id="ac-status" value={editing.status} onChange={(e) => setEditing((s) => s && { ...s, status: e.target.value as AccessStatus })}>
                {(Object.keys(ACCESS_LABELS) as AccessStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {ACCESS_LABELS[s]}
                  </option>
                ))}
              </select>
              {editing.status === 'ACTIVE' && editing.row.product.status !== 'ACTIVE' && (
                <span className="hint">The product itself is not active, so the reseller cannot sell it yet.</span>
              )}
            </div>
            <div className="field">
              <label htmlFor="ac-note">Note to reseller (optional)</label>
              <textarea id="ac-note" rows={2} value={editing.note} onChange={(e) => setEditing((s) => s && { ...s, note: e.target.value })} />
            </div>
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </button>
              <button className={`btn ${editing.status === 'ACTIVE' ? 'success' : 'danger'}`} onClick={save} disabled={busy}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
