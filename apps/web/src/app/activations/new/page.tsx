'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { api, apiRequest, ApiError } from '@/lib/api'
import { currentPeriod, formatMoney, monthLabel } from '@/lib/format'
import { ACTIVATION_STATUS_LABELS, type ActivationListItem, type PaymentInfo } from '@/lib/activation-types'
import type { ResellerProduct } from '@/lib/product-types'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'
import { PaymentAccountNotice } from '@/components/activations/PaymentAccountNotice'

interface CustomerOption {
  id: string
  customerCode?: string | null
  displayName: string
  accounts: {
    id: string
    status: string
    externalTenantId: string | null
    product: { id: string; code: string; name: string; monthlyPrice: string; currency: string }
    trialRequests?: { id: string; status: string; errorMessage?: string | null; createdAt: string }[]
    activationRequests?: { id: string; reference: string; status: string; submittedAt: string }[]
  }[]
}

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf'

function shiftMonth(period: string, delta: number) {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function NewActivationForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialCustomerId = searchParams.get('customerId') || ''
  const initialProductId = searchParams.get('productId') || ''

  const [customers, setCustomers] = useState<CustomerOption[] | null>(null)
  const [products, setProducts] = useState<ResellerProduct[] | null>(null)
  const [info, setInfo] = useState<PaymentInfo | null>(null)
  const [openRequests, setOpenRequests] = useState<ActivationListItem[]>([])

  const [customerId, setCustomerId] = useState(initialCustomerId)
  const [customerSearch, setCustomerSearch] = useState('')

  const [productId, setProductId] = useState(initialProductId)
  const [periodMonth, setPeriodMonth] = useState(currentPeriod())
  const [payerName, setPayerName] = useState('')
  const [payerBank, setPayerBank] = useState('')
  const [transactionRef, setTransactionRef] = useState('')
  const [transferDate, setTransferDate] = useState(todayIso())
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<CustomerOption[]>('/customers?limit=100')
      .then((data) => {
        setCustomers(data)
        if (initialCustomerId) {
          const match = data.find((c) => c.id === initialCustomerId)
          if (match) {
            setCustomerId(match.id)
            if (match.customerCode) setCustomerSearch(match.customerCode)
            if (!payerName) setPayerName(match.displayName)
          }
        }
      })
      .catch(() => setCustomers([]))

    api<ResellerProduct[]>('/products')
      .then((prods) => {
        setProducts(prods)
        if (initialProductId) {
          const prodMatch = prods.find((p) => p.id === initialProductId)
          if (prodMatch) setProductId(prodMatch.id)
        }
      })
      .catch(() => setProducts([]))

    api<PaymentInfo>('/activation-requests/payment-info')
      .then(setInfo)
      .catch(() => setInfo(null))

    api<ActivationListItem[]>('/activation-requests?status=PENDING_REVIEW,UNDER_REVIEW,APPROVED&limit=100')
      .then(setOpenRequests)
      .catch(() => setOpenRequests([]))
  }, [initialCustomerId, initialProductId]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredCustomers = useMemo(() => {
    if (!customers) return []
    const term = customerSearch.trim().toLowerCase()
    if (!term) return customers
    return customers.filter(
      (c) =>
        c.displayName.toLowerCase().includes(term) ||
        (c.customerCode && c.customerCode.toLowerCase().includes(term)) ||
        c.id.toLowerCase().includes(term),
    )
  }, [customers, customerSearch])

  const customer = customers?.find((c) => c.id === customerId)
  const selectedProduct = products?.find((p) => p.id === productId)
  const account = customer?.accounts.find((a) => a.product.id === productId)
  const months = useMemo(() => [-1, 0, 1, 2].map((d) => shiftMonth(currentPeriod(), d)), [])

  const duplicate =
    selectedProduct &&
    openRequests.find(
      (r) =>
        r.customerAccount?.customer?.id === (customer?.id || '') &&
        r.product?.id === selectedProduct.id &&
        r.periodMonth === periodMonth,
    )

  const selectCustomer = (id: string) => {
    setCustomerId(id)
    setProductId('')
    const c = customers?.find((x) => x.id === id)
    if (c) {
      setPayerName(c.displayName)
      if (c.customerCode) setCustomerSearch(c.customerCode)
    } else {
      setPayerName('')
    }
  }

  const pickFile = (f: File | null) => {
    setErrors((e) => ({ ...e, slip: '' }))
    if (!f) return setFile(null)
    if (!ACCEPT.split(',').includes(f.type)) {
      setErrors((e) => ({ ...e, slip: 'Upload a JPG, PNG, WEBP or PDF file' }))
      return setFile(null)
    }
    if (info && f.size > info.maxUploadMb * 1024 * 1024) {
      setErrors((e) => ({ ...e, slip: `The file is larger than ${info.maxUploadMb} MB` }))
      return setFile(null)
    }
    setFile(f)
  }

  const validate = () => {
    const v: Record<string, string> = {}
    if (!customerId) v.customerId = 'Select a customer'
    if (!productId) v.productId = 'Select a SaaS product'
    if (payerName.trim().length < 2) v.payerName = 'Enter the name on the bank transfer'
    if (transactionRef.trim().length < 3) v.transactionRef = 'Enter the bank transaction / reference number'
    if (!transferDate) v.transferDate = 'Enter the transfer date'
    else if (transferDate > todayIso()) v.transferDate = 'The transfer date cannot be in the future'
    if (!file) v.slip = 'Upload the bank slip'
    if (!confirmed) v.confirmed = 'Please confirm'
    return v
  }

  const submit = async () => {
    const v = validate()
    setErrors(v)
    setFormError(null)
    if (Object.keys(v).length || !selectedProduct || !file) return

    if (!account || !account.externalTenantId) {
      setFormError('The customer must have a provisioned SaaS account before a paid activation can be submitted.')
      return
    }

    if (account.status === 'ACTIVE') {
      setFormError('This customer already has an active paid subscription for this product.')
      return
    }

    const hasOpenRequest = openRequests.some(
      (r) =>
        r.customerAccount?.id === account.id ||
        (r.customerAccount?.customer?.id === customerId && r.product?.id === productId),
    )
    if (hasOpenRequest) {
      setFormError('An activation request is already pending review for this customer account.')
      return
    }

    setBusy(true)
    const form = new FormData()
    form.set('customerId', customerId)
    form.set('productId', productId)
    form.set('periodMonth', periodMonth)
    form.set('amount', String(selectedProduct.monthlyPrice))
    form.set('payerName', payerName.trim())
    if (payerBank.trim()) form.set('payerBank', payerBank.trim())
    form.set('transactionRef', transactionRef.trim())
    form.set('transferDate', transferDate)
    if (notes.trim()) form.set('notes', notes.trim())
    form.set('slip', file)

    try {
      const created = await api<{ id: string; reference: string }>('/activation-requests', { method: 'POST', body: form })
      router.push(`/activations/${created.id}?submitted=1`)
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors())
        setFormError(err.message)
      } else {
        setFormError('Could not submit the activation request')
      }
      setBusy(false)
    }
  }

  if (!customers || !products) return <p className="muted">Loading…</p>

  const isCustomerSelected = Boolean(customerId)

  return (
    <>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '1.25rem' }}>
          <span
            style={{
              width: '26px',
              height: '26px',
              borderRadius: '7px',
              background: 'rgba(37, 99, 235, 0.16)',
              border: '1px solid rgba(59, 130, 246, 0.35)',
              color: 'var(--primary-light)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: '0.82rem',
            }}
          >
            1
          </span>
          <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-heading)' }}>
            Customer Search &amp; Selection
          </h2>
        </div>

        <div className="form-grid-2">
        {/* Customer ID Search Input */}
        <div className="field">
          <label htmlFor="customer-search-input">Search by Customer ID or Shop Name</label>
          <input
            id="customer-search-input"
            type="text"
            placeholder="e.g. CUS-000001 or Acme Store…"
            value={customerSearch}
            onChange={(e) => {
              const val = e.target.value
              setCustomerSearch(val)
              const exact = customers?.find((c) => c.customerCode?.toLowerCase() === val.trim().toLowerCase())
              if (exact) selectCustomer(exact.id)
            }}
            style={{ width: '100%' }}
          />
          <span className="hint">Search by unique Customer ID (e.g. CUS-000001) or business display name</span>
        </div>

        {/* Customer Dropdown (Filtered) */}
        <div className="field">
          <label htmlFor="na-customer">Authorized Customer</label>
          <select
            id="na-customer"
            value={customerId}
            onChange={(e) => selectCustomer(e.target.value)}
          >
            <option value="">Choose a customer…</option>
            {filteredCustomers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.customerCode ? `[${c.customerCode}] ` : ''}{c.displayName} ({c.accounts.length} {c.accounts.length === 1 ? 'account' : 'accounts'})
              </option>
            ))}
          </select>
          {errors.customerId && <span className="error-text">{errors.customerId}</span>}
        </div>
        </div>

        {/* Selected Customer Profile & Associated Accounts Card */}
        {customer && (
          <div
            style={{
              marginTop: '1.25rem',
              padding: '1.1rem',
              borderRadius: '8px',
              background: 'var(--surface-hover)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.85rem' }}>
              <div>
                <span className="muted small">Customer ID</span>
                <div className="mono" style={{ fontWeight: 700, color: 'var(--primary-light)', fontSize: '1rem' }}>
                  {customer.customerCode || customer.id}
                </div>
              </div>
              <div>
                <span className="muted small">Shop / Business Name</span>
                <div style={{ fontWeight: 700, color: 'var(--text-heading)', fontSize: '1rem' }}>
                  {customer.displayName}
                </div>
              </div>
              <div>
                <span className="muted small">Linked Product Accounts</span>
                <div style={{ fontWeight: 600, color: 'var(--text)' }}>
                  {customer.accounts.length} {customer.accounts.length === 1 ? 'Product Account' : 'Product Accounts'}
                </div>
              </div>
            </div>

            {/* Associated Product Accounts List */}
            {customer.accounts.length > 0 && (
              <div style={{ marginTop: '0.35rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                <span className="muted small" style={{ fontWeight: 600, display: 'block', marginBottom: '0.4rem' }}>
                  Associated SaaS Product Accounts:
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {customer.accounts.map((acc) => {
                    const latestActivation = acc.activationRequests?.[0]
                    const hasPendingReview = latestActivation && ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED'].includes(latestActivation.status)

                    return (
                      <div
                        key={acc.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          fontSize: '0.85rem',
                          padding: '0.45rem 0.65rem',
                          background: 'var(--surface)',
                          borderRadius: '6px',
                          border: '1px solid var(--border)',
                          flexWrap: 'wrap',
                          gap: '0.5rem',
                        }}
                      >
                        <div>
                          <strong>{acc.product.name}</strong>
                          <span className="muted small mono" style={{ marginLeft: '0.35rem' }}>({acc.product.code})</span>
                          {acc.externalTenantId ? (
                            <span className="muted small mono" style={{ marginLeft: '0.5rem', color: 'var(--primary-light)' }}>
                              Tenant: {acc.externalTenantId}
                            </span>
                          ) : (
                            <span className="muted small" style={{ marginLeft: '0.5rem', color: 'var(--muted)' }}>
                              (Pending Tenant Provisioning)
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                          <span className={`badge sub-${acc.status}`}>
                            {acc.status}
                          </span>
                          {hasPendingReview && (
                            <span className="badge sub-PENDING" title={`Activation ${latestActivation.reference} under review`}>
                              {latestActivation.reference} In Review
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: '0.65rem' }}>
          <span className="hint">
            Have a new prospect?{' '}
            <Link href="/demo-requests/new" style={{ color: 'var(--primary-light)', textDecoration: 'underline' }}>
              Request a Demo
            </Link>
          </span>
        </div>
      </div>

      {isCustomerSelected && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '1.25rem' }}>
            <span
              style={{
                width: '26px',
                height: '26px',
                borderRadius: '7px',
                background: 'rgba(37, 99, 235, 0.16)',
                border: '1px solid rgba(59, 130, 246, 0.35)',
                color: 'var(--primary-light)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.82rem',
              }}
            >
              2
            </span>
            <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-heading)' }}>
              SaaS Product Selection
            </h2>
          </div>

          {customer && customer.accounts.length === 0 && (
            <div className="alert info" style={{ marginBottom: '1.25rem' }}>
              <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                SaaS Account Setup Required
              </div>
              <p style={{ margin: '0.35rem 0 0', fontSize: '0.86rem', lineHeight: 1.5 }}>
                This customer has no SaaS account yet. Once a demo request for them is confirmed, they appear here as a trial customer you can activate.
              </p>
            </div>
          )}

          {customer && customer.accounts.length > 0 && !customer.accounts.some((a) => Boolean(a.externalTenantId)) && (
            <div className="alert warning" style={{ marginBottom: '1.25rem' }}>
              <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                SaaS Tenant Provisioning Incomplete
              </div>
              <p style={{ margin: '0.35rem 0 0', fontSize: '0.86rem', lineHeight: 1.5 }}>
                This customer&apos;s SaaS tenant is still being provisioned. A paid activation can be submitted once it is ready.
              </p>
            </div>
          )}

          {products.length === 0 ? (
            <p className="muted">No products are currently available for your account.</p>
          ) : (
            <div className="product-grid">
              {products.map((p) => {
                const acc = customer?.accounts.find((a) => a.product.id === p.id)
                const hasTenant = Boolean(acc?.externalTenantId)
                const isSelectable = hasTenant && acc?.status !== 'CANCELLED'

                if (isSelectable) {
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`card product-card selectable ${productId === p.id ? 'selected' : ''}`}
                      aria-pressed={productId === p.id}
                      onClick={() => setProductId(p.id)}
                    >
                      <h3>{p.name}</h3>
                      <div className="price">
                        {formatMoney(p.monthlyPrice, p.currency)} <span className="muted small">/ month</span>
                      </div>
                      <div className="small" style={{ marginTop: '0.35rem' }}>
                        <span className={`badge sub-${acc?.status || 'TRIAL'}`}>
                          {acc?.status === 'ACTIVE' ? 'Active Paid Tenant' : 'Trial Account'}
                        </span>
                        <span className="mono muted" style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.72rem' }}>
                          Tenant: {acc?.externalTenantId}
                        </span>
                      </div>
                    </button>
                  )
                }

                return (
                  <div
                    key={p.id}
                    className="card product-card"
                    style={{
                      opacity: 0.65,
                      borderStyle: 'dashed',
                      cursor: 'not-allowed',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <h3>{p.name}</h3>
                      <div className="price">
                        {formatMoney(p.monthlyPrice, p.currency)} <span className="muted small">/ month</span>
                      </div>
                    </div>
                    <div className="small" style={{ marginTop: '0.5rem' }}>
                      {!acc ? (
                        <>
                          <span
                            className="badge"
                            style={{
                              background: 'var(--surface-hover)',
                              color: 'var(--muted)',
                              border: '1px solid var(--border)',
                            }}
                          >
                            No Account
                          </span>
                        </>
                      ) : !acc.externalTenantId ? (
                        <>
                          <span className="badge sub-PENDING">Tenant Pending</span>
                          <span className="muted small" style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.72rem' }}>
                            Provisioning in progress
                          </span>
                        </>
                      ) : (
                        <span className="badge sub-CANCELLED">Cancelled</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {errors.productId && <div className="error-text" style={{ marginTop: '0.5rem' }}>{errors.productId}</div>}
        </div>
      )}

      {selectedProduct && (
        <>
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '1.25rem' }}>
              <span
                style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '7px',
                  background: 'rgba(37, 99, 235, 0.16)',
                  border: '1px solid rgba(59, 130, 246, 0.35)',
                  color: 'var(--primary-light)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: '0.82rem',
                }}
              >
                3
              </span>
              <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-heading)' }}>
                Payment &amp; Transfer Details
              </h2>
            </div>
            <div className="alert info">
              <div>
                Amount to pay: <strong>{formatMoney(selectedProduct.monthlyPrice, selectedProduct.currency)}</strong> for one month of{' '}
                {selectedProduct.name}.
              </div>
              <PaymentAccountNotice companyBankDetails={info?.companyBankDetails} />
            </div>
            <div className="form-grid" style={{ marginTop: '1rem' }}>
              <div className="field">
                <label htmlFor="na-period">Subscription month</label>
                <select id="na-period" value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)}>
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {monthLabel(m)}
                    </option>
                  ))}
                </select>
                {errors.periodMonth && <span className="error-text">{errors.periodMonth}</span>}
              </div>
              <div className="field">
                <label>Amount paid</label>
                <input value={formatMoney(selectedProduct.monthlyPrice, selectedProduct.currency)} readOnly />
                <span className="hint">The monthly fee is fixed. Contact Hexalyte if the customer paid a different amount.</span>
                {errors.amount && <span className="error-text">{errors.amount}</span>}
              </div>
              <div className="field">
                <label htmlFor="na-payer">Paid by (name on the transfer)</label>
                <input id="na-payer" maxLength={150} value={payerName} onChange={(e) => setPayerName(e.target.value)} />
                {errors.payerName && <span className="error-text">{errors.payerName}</span>}
              </div>
              <div className="field">
                <label htmlFor="na-bank">Paid from bank (optional)</label>
                <input id="na-bank" maxLength={100} placeholder="e.g. Commercial Bank" value={payerBank} onChange={(e) => setPayerBank(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="na-ref">Transaction / reference number</label>
                <input id="na-ref" maxLength={100} value={transactionRef} onChange={(e) => setTransactionRef(e.target.value)} />
                {errors.transactionRef && <span className="error-text">{errors.transactionRef}</span>}
              </div>
              <div className="field">
                <label htmlFor="na-date">Transfer date</label>
                <input id="na-date" type="date" max={todayIso()} value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
                {errors.transferDate && <span className="error-text">{errors.transferDate}</span>}
              </div>
              <div className="field span-all">
                <label htmlFor="na-notes">Notes for Hexalyte (optional)</label>
                <textarea id="na-notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '1.25rem' }}>
              <span
                style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '7px',
                  background: 'rgba(37, 99, 235, 0.16)',
                  border: '1px solid rgba(59, 130, 246, 0.35)',
                  color: 'var(--primary-light)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: '0.82rem',
                }}
              >
                4
              </span>
              <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-heading)' }}>
                Bank Deposit Slip Verification
              </h2>
            </div>
            <div className="form-grid-2">
              <div className="field">
                <label htmlFor="na-slip">Bank slip or transfer receipt</label>
                <input id="na-slip" type="file" accept={ACCEPT} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
                <span className="hint">
                  JPG, PNG, WEBP or PDF, up to {info?.maxUploadMb ?? 5} MB. Stored privately and only visible to you and Hexalyte finance.
                </span>
                {errors.slip && <span className="error-text">{errors.slip}</span>}
              </div>
              <div>
                <label className="checkbox" style={{ marginTop: '1.6rem' }}>
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  The customer has paid this amount into the Hexalyte company bank account and the slip is genuine.
                </label>
                {errors.confirmed && <div className="error-text">{errors.confirmed}</div>}
              </div>
            </div>
          </div>
        </>
      )}

      {duplicate && (
        <div className="alert warning">
          Request <Link href={`/activations/${duplicate.id}`}>{duplicate.reference}</Link> for {monthLabel(periodMonth)} is already{' '}
          {ACTIVATION_STATUS_LABELS[duplicate.status].toLowerCase()}.
        </div>
      )}
      {formError && <div className="alert error">{formError}</div>}
      <div
        className="card"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
          padding: '1.25rem 1.5rem',
          marginTop: '0.5rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--muted)', fontSize: '0.84rem' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>Hexalyte reviews the payment slip and activates the SaaS subscription upon verification.</span>
        </div>
        <button
          className="btn"
          onClick={submit}
          disabled={busy || !selectedProduct || !customerId || !account?.externalTenantId || Boolean(duplicate)}
          style={{ minWidth: '220px', fontWeight: 700 }}
        >
          {busy ? 'Submitting Request…' : 'Submit Activation Request'}
        </button>
      </div>
    </>
  )
}

export default function NewActivationPage() {
  return (
    <ResellerShell>
      {() => (
        <main className="container">
          {/* ── Compact Scenic Hero Banner (No KPIs on Creation Form Flow) ── */}
          <PageHero
            tag="REVENUE OPERATIONS"
            title="New Activation Request"
            subtitle="Submit customer payment details and bank transfer slip for verification and SaaS provisioning."
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                <line x1="12" y1="8" x2="12" y2="14" />
                <line x1="9" y1="11" x2="15" y2="11" />
              </svg>
            }
            actions={
              <Link
                href="/activations"
                className="btn secondary small"
                style={{ display: 'inline-flex', gap: '0.45rem', alignItems: 'center', fontWeight: 600 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="19" y1="12" x2="5" y2="12" />
                  <polyline points="12 19 5 12 12 5" />
                </svg>
                <span>Back to Paid Activations</span>
              </Link>
            }
          />

          {/* ── Full-width form layout (same structure as Commissions & Payouts) ── */}
          <Suspense fallback={<p className="muted">Loading activation form…</p>}>
            <NewActivationForm />
          </Suspense>
        </main>
      )}
    </ResellerShell>
  )
}
