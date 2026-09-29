'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { currentPeriod, formatMoney, monthLabel } from '@/lib/format'
import { ACTIVATION_STATUS_LABELS, type ActivationListItem, type PaymentInfo } from '@/lib/activation-types'
import { ResellerShell } from '@/components/ResellerShell'

interface CustomerOption {
  id: string
  displayName: string
  accounts: {
    id: string
    status: string
    externalTenantId: string | null
    product: { id: string; code: string; name: string; monthlyPrice: string; currency: string }
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
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null)
  const [info, setInfo] = useState<PaymentInfo | null>(null)
  const [openRequests, setOpenRequests] = useState<ActivationListItem[]>([])
  const [customerId, setCustomerId] = useState('')
  const [productId, setProductId] = useState('')
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
    api<CustomerOption[]>('/customers?limit=100').then(setCustomers).catch(() => setCustomers([]))
    api<PaymentInfo>('/activation-requests/payment-info').then(setInfo).catch(() => setInfo(null))
    api<ActivationListItem[]>('/activation-requests?status=PENDING_REVIEW,UNDER_REVIEW,APPROVED&limit=100')
      .then(setOpenRequests)
      .catch(() => setOpenRequests([]))
  }, [])

  const customer = customers?.find((c) => c.id === customerId)
  const account = customer?.accounts.find((a) => a.product.id === productId)
  const months = useMemo(() => [-1, 0, 1, 2].map((d) => shiftMonth(currentPeriod(), d)), [])
  const duplicate = account && openRequests.find((r) => r.customerAccount.id === account.id && r.periodMonth === periodMonth)

  const selectCustomer = (id: string) => {
    setCustomerId(id)
    const c = customers?.find((x) => x.id === id)
    const eligible = c?.accounts.filter((a) => a.externalTenantId) ?? []
    setProductId(eligible.length === 1 ? eligible[0].product.id : '')
    if (c && !payerName) setPayerName(c.displayName)
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
    if (!productId) v.productId = 'Select a product'
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
    if (Object.keys(v).length || !account || !file) return
    const form = new FormData()
    form.set('customerId', customerId)
    form.set('productId', productId)
    form.set('periodMonth', periodMonth)
    form.set('amount', String(account.product.monthlyPrice))
    form.set('payerName', payerName.trim())
    if (payerBank.trim()) form.set('payerBank', payerBank.trim())
    form.set('transactionRef', transactionRef.trim())
    form.set('transferDate', transferDate)
    if (notes.trim()) form.set('notes', notes.trim())
    form.set('slip', file)
    setBusy(true)
    try {
      const created = await api<{ id: string; reference: string }>('/activation-requests', { method: 'POST', body: form })
      router.push(`/activations/${created.id}?submitted=1`)
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors())
        setFormError(err.message)
      } else setFormError('Could not submit the activation request')
      setBusy(false)
    }
  }

  if (!customers) return <p className="muted">Loading…</p>

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>1. Customer</h2>
        {customers.length === 0 ? (
          <p className="muted">
            You have no customers yet. <Link href="/trials/new">Create a trial account</Link> first.
          </p>
        ) : (
          <div className="field">
            <label htmlFor="na-customer">Customer</label>
            <select id="na-customer" value={customerId} onChange={(e) => selectCustomer(e.target.value)}>
              <option value="">Select a customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
            {errors.customerId && <span className="error-text">{errors.customerId}</span>}
          </div>
        )}
      </div>

      {customer && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>2. SaaS product</h2>
          {customer.accounts.length === 0 ? (
            <p className="muted">This customer has no SaaS account yet. Create a trial first.</p>
          ) : (
            <div className="product-grid">
              {customer.accounts.map((a) => {
                const ready = Boolean(a.externalTenantId) && a.status !== 'CANCELLED'
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`card product-card selectable ${productId === a.product.id ? 'selected' : ''}`}
                    disabled={!ready}
                    aria-pressed={productId === a.product.id}
                    onClick={() => setProductId(a.product.id)}
                  >
                    <h3>{a.product.name}</h3>
                    <div className="price">
                      {formatMoney(a.product.monthlyPrice, a.product.currency)} <span className="muted small">/ month</span>
                    </div>
                    <div className="small">
                      <span className={`badge sub-${a.status}`}>{a.status}</span>{' '}
                      {!a.externalTenantId ? 'SaaS account not created yet' : a.status === 'CANCELLED' ? 'Account cancelled' : ''}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
          {errors.productId && <div className="error-text">{errors.productId}</div>}
        </div>
      )}

      {account && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>3. Payment details</h2>
            <div className="alert info">
              <div>
                Amount to pay: <strong>{formatMoney(account.product.monthlyPrice, account.product.currency)}</strong> for one month of{' '}
                {account.product.name}.
              </div>
              {info?.companyBankDetails ? (
                <div className="pre-line" style={{ marginTop: '0.5rem' }}>
                  <strong>Pay only into the Hexalyte company account:</strong>
                  <br />
                  {info.companyBankDetails}
                </div>
              ) : (
                <div style={{ marginTop: '0.5rem' }}>Pay only into the official Hexalyte company bank account.</div>
              )}
            </div>
            <div className="grid-2">
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
                <input value={formatMoney(account.product.monthlyPrice, account.product.currency)} readOnly />
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
            </div>
            <div className="field">
              <label htmlFor="na-notes">Notes for Hexalyte (optional)</label>
              <textarea id="na-notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>4. Bank slip</h2>
            <div className="field">
              <label htmlFor="na-slip">Bank slip or transfer receipt</label>
              <input id="na-slip" type="file" accept={ACCEPT} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
              <span className="hint">
                JPG, PNG, WEBP or PDF, up to {info?.maxUploadMb ?? 5} MB. Stored privately and only visible to you and Hexalyte finance.
              </span>
              {errors.slip && <span className="error-text">{errors.slip}</span>}
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              The customer has paid this amount into the Hexalyte company bank account and the slip is genuine.
            </label>
            {errors.confirmed && <div className="error-text">{errors.confirmed}</div>}
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
      <div className="row">
        <span className="small muted">Hexalyte reviews the payment and activates the subscription. You will be notified of the result.</span>
        <span className="spacer" />
        <button className="btn" onClick={submit} disabled={busy || !account || Boolean(duplicate)}>
          {busy ? 'Submitting…' : 'Submit activation request'}
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
          <Link href="/activations" className="small">
            ← Paid activations
          </Link>
          <h1>New activation request</h1>
          <NewActivationForm />
        </main>
      )}
    </ResellerShell>
  )
}
