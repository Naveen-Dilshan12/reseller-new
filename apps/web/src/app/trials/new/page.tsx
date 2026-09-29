'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatMoney } from '@/lib/format'
import { trialLabel, type ResellerProduct } from '@/lib/product-types'
import { emptyOwner, validateOwner, type TrialOutcomeResult, type TrialOwner } from '@/lib/trial-types'
import { ResellerShell } from '@/components/ResellerShell'
import { OwnerFields } from '@/components/trials/OwnerFields'

interface CustomerOption {
  id: string
  displayName: string
  accounts: { product: { code: string } }[]
}

function NewTrialForm() {
  const [products, setProducts] = useState<ResellerProduct[] | null>(null)
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [productId, setProductId] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [owner, setOwner] = useState<TrialOwner>(emptyOwner)
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TrialOutcomeResult | null>(null)

  useEffect(() => {
    api<ResellerProduct[]>('/products').then(setProducts).catch(() => setProducts([]))
    api<CustomerOption[]>('/customers?limit=100').then(setCustomers).catch(() => setCustomers([]))
  }, [])

  const product = products?.find((p) => p.id === productId)
  const selectCustomer = (id: string) => {
    setCustomerId(id)
    const c = customers.find((x) => x.id === id)
    setOwner((o) => ({ ...o, businessName: c ? c.displayName : '' }))
  }

  const submit = async () => {
    const v = validateOwner(owner)
    if (!productId) v.productId = 'Select a product'
    setErrors(v)
    setFormError(null)
    if (Object.keys(v).length) return
    setBusy(true)
    try {
      const r = await api<TrialOutcomeResult>('/trials', {
        method: 'POST',
        body: JSON.stringify({
          productId,
          ...(customerId ? { customerId } : {}),
          owner,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      })
      setResult(r)
      setOwner(emptyOwner)
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors())
        setFormError(err.errors.length && !err.errors[0].includes(': ') ? err.errors[0] : err.message)
      } else setFormError('Could not create the trial')
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    const kind = result.outcome === 'PROVISIONED' ? 'success' : result.outcome === 'FAILED' ? 'error' : 'info'
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          {result.outcome === 'PROVISIONED' ? 'Trial created' : result.outcome === 'FAILED' ? 'Trial not created' : 'Trial requested'}
        </h2>
        <div className={`alert ${kind}`}>{result.message}</div>
        <div className="grid-2" style={{ marginBottom: '1rem' }}>
          <div>
            <div className="muted small">Customer</div>
            {result.trial.customerAccount.customer.displayName}
          </div>
          <div>
            <div className="muted small">Product</div>
            {result.trial.product.name}
          </div>
          {result.trial.customerAccount.externalTenantId && (
            <div>
              <div className="muted small">SaaS tenant ID</div>
              <span className="mono">{result.trial.customerAccount.externalTenantId}</span>
            </div>
          )}
          {result.saas?.trialEndsAt && (
            <div>
              <div className="muted small">Trial ends</div>
              {formatDate(result.saas.trialEndsAt)}
            </div>
          )}
        </div>
        {result.outcome === 'PROVISIONED' && (
          <p className="small muted">The owner will receive login instructions from {result.trial.product.name} by email.</p>
        )}
        <div className="row">
          <Link href="/trials" className="btn secondary">
            View all trials
          </Link>
          <button
            className="btn"
            onClick={() => {
              setResult(null)
              setCustomerId('')
              setNotes('')
            }}
          >
            Create another trial
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>1. SaaS product</h2>
        {errors.productId && <div className="alert error small">{errors.productId}</div>}
        {!products ? (
          <p className="muted">Loading…</p>
        ) : products.length === 0 ? (
          <p className="muted">No products are enabled for your account.</p>
        ) : (
          <div className="product-grid">
            {products.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`card product-card selectable ${productId === p.id ? 'selected' : ''}`}
                disabled={!p.canCreateTrial}
                onClick={() => setProductId(p.id)}
                aria-pressed={productId === p.id}
              >
                <h3>{p.name}</h3>
                <div className="muted small">{p.description}</div>
                <div className="price">
                  {formatMoney(p.monthlyPrice, p.currency)} <span className="muted small">/ month after trial</span>
                </div>
                <div className="small">{p.canCreateTrial ? trialLabel(p) : p.reason}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>2. Customer</h2>
        <div className="field">
          <label htmlFor="nt-customer">Customer</label>
          <select id="nt-customer" value={customerId} onChange={(e) => selectCustomer(e.target.value)}>
            <option value="">New customer</option>
            {customers.map((c) => {
              const hasProduct = product && c.accounts.some((a) => a.product.code === product.code)
              return (
                <option key={c.id} value={c.id} disabled={Boolean(hasProduct)}>
                  {c.displayName}
                  {hasProduct ? ` (already has ${product!.name})` : ''}
                </option>
              )
            })}
          </select>
          <span className="hint">Choose an existing customer to give them another product, or create a new one.</span>
        </div>
        <OwnerFields value={owner} errors={errors} onChange={setOwner} />
        <div className="field">
          <label htmlFor="nt-notes">Internal notes (optional)</label>
          <textarea id="nt-notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      {formError && <div className="alert error">{formError}</div>}
      <div className="row">
        <span className="small muted">
          Creates a free trial only. Paid activation is handled by Hexalyte after payment verification.
        </span>
        <span className="spacer" />
        <button className="btn" onClick={submit} disabled={busy || !product?.canCreateTrial}>
          {busy ? 'Creating trial…' : 'Create trial'}
        </button>
      </div>
    </>
  )
}

export default function NewTrialPage() {
  return (
    <ResellerShell>
      {() => (
        <main className="container">
          <Link href="/trials" className="small">
            ← Trial accounts
          </Link>
          <h1>New trial account</h1>
          <NewTrialForm />
        </main>
      )}
    </ResellerShell>
  )
}
