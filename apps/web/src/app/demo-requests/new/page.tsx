'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { ResellerProduct } from '@/lib/product-types'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'
import { Field } from '@/components/Field'

function NewDemoRequestForm() {
  const router = useRouter()
  const [products, setProducts] = useState<ResellerProduct[] | null>(null)

  // "Request Demo" on a product card links here with ?productId=… to preselect it.
  const initialProductId = useSearchParams().get('productId') || ''
  const [productId, setProductId] = useState(initialProductId)
  const [businessName, setBusinessName] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [notes, setNotes] = useState('')

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<ResellerProduct[]>('/products')
      .then((list) => {
        setProducts(list)
        // Ignore a preselected product the reseller cannot actually sell
        setProductId((current) => (list.some((p) => p.id === current) ? current : ''))
      })
      .catch(() => setProducts([]))
  }, [])

  const validate = () => {
    const v: Record<string, string> = {}
    if (!productId) v.productId = 'Select a SaaS product'
    if (businessName.trim().length < 2) v.businessName = 'Enter the business / customer name'
    if (contactName.trim().length < 2) v.contactName = 'Enter the contact name'
    if (!/^\S+@\S+\.\S+$/.test(contactEmail.trim())) v.contactEmail = 'Enter a valid email address'
    if (contactPhone.trim().length < 9) v.contactPhone = 'Enter a valid phone number, e.g. 0771234567'
    return v
  }

  const submit = async () => {
    const v = validate()
    setErrors(v)
    setFormError(null)
    if (Object.keys(v).length) return

    setBusy(true)
    try {
      const created = await api<{ id: string }>('/demo-requests', {
        method: 'POST',
        body: JSON.stringify({
          productId,
          businessName: businessName.trim(),
          contactName: contactName.trim(),
          contactEmail: contactEmail.trim(),
          contactPhone: contactPhone.trim(),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      })
      router.push(`/demo-requests/${created.id}?submitted=1`)
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors())
        setFormError(err.message)
      } else {
        setFormError('Could not submit the demo request')
      }
      setBusy(false)
    }
  }

  if (!products) return <p className="muted">Loading…</p>

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Prospect details</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Hexalyte staff review this request and, once approved, manually create the demo shop in the SaaS. No account is
          created automatically.
        </p>
        <div className="form-grid">
          <Field label="Business / customer name" name="businessName" value={businessName} onChange={(_, v) => setBusinessName(v)} error={errors.businessName} maxLength={150} />
          <Field label="Contact name" name="contactName" value={contactName} onChange={(_, v) => setContactName(v)} error={errors.contactName} maxLength={150} />
          <div className="field">
            <label htmlFor="dr-product">SaaS product</label>
            <select id="dr-product" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Choose a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {errors.productId && <span className="error-text">{errors.productId}</span>}
          </div>
          <Field label="Contact email" name="contactEmail" type="email" value={contactEmail} onChange={(_, v) => setContactEmail(v)} error={errors.contactEmail} maxLength={150} />
          <Field
            label="Contact phone"
            name="contactPhone"
            value={contactPhone}
            onChange={(_, v) => setContactPhone(v)}
            error={errors.contactPhone}
            hint="Used to open WhatsApp with the welcome message once the demo is ready."
            maxLength={20}
          />
          <Field
            label="Notes for Hexalyte (optional)"
            name="notes"
            value={notes}
            onChange={(_, v) => setNotes(v)}
            multiline
            maxLength={500}
          />
        </div>
      </div>

      {formError && <div className="alert error">{formError}</div>}

      <div
        className="card"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}
      >
        <span className="small muted">Hexalyte will review this request and notify you once it is approved or rejected.</span>
        <button className="btn" onClick={submit} disabled={busy} style={{ minWidth: '200px', fontWeight: 700 }}>
          {busy ? 'Submitting…' : 'Submit Demo Request'}
        </button>
      </div>
    </>
  )
}

export default function NewDemoRequestPage() {
  return (
    <ResellerShell>
      {() => (
        <main className="container">
          <PageHero
            tag="SALES ENABLEMENT"
            title="New Demo Request"
            subtitle="Ask Hexalyte to manually create a demo shop in a SaaS product for a prospective customer."
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18" />
                <path d="m9 15 2 2 4-4" />
              </svg>
            }
            actions={
              <Link href="/demo-requests" className="btn secondary small" style={{ display: 'inline-flex', gap: '0.45rem', alignItems: 'center', fontWeight: 600 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="19" y1="12" x2="5" y2="12" />
                  <polyline points="12 19 5 12 12 5" />
                </svg>
                <span>Back to Demo Requests</span>
              </Link>
            }
          />
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <NewDemoRequestForm />
          </Suspense>
        </main>
      )}
    </ResellerShell>
  )
}
