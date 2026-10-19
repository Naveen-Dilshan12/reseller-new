'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import type { ResellerActivation } from '@/lib/activation-types'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'
import { ActivationHistory, ActivationSteps, BankSlipViewer, StatusBadge } from '@/components/activations/ActivationParts'

function Detail({ id, canCancel }: { id: string; canCancel: boolean }) {
  const submitted = useSearchParams().get('submitted') === '1'
  const [item, setItem] = useState<ResellerActivation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api<ResellerActivation>(`/activation-requests/${id}`)
      .then(setItem)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the request'))
  }, [id])
  useEffect(load, [load])

  const cancel = async () => {
    if (!item || !confirm(`Cancel activation request ${item.reference}?`)) return
    setBusy(true)
    try {
      setItem(await api<ResellerActivation>(`/activation-requests/${id}/cancel`, { method: 'POST' }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cancel failed')
    } finally {
      setBusy(false)
    }
  }

  if (error && !item) return <div className="alert error">{error}</div>
  if (!item) return <p className="muted">Loading…</p>

  return (
    <>
      {/* ── Compact Scenic Hero Banner (No KPIs on Activation Detail) ── */}
      <PageHero
        tag="ACTIVATION RECORD"
        title={item.reference}
        subtitle={`Activation request for ${item.customerAccount.customer.displayName} · ${item.product.name} (${monthLabel(item.periodMonth)})`}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        }
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
            <StatusBadge status={item.status} />
            {canCancel && item.status === 'PENDING_REVIEW' && (
              <button className="btn secondary small" onClick={cancel} disabled={busy}>
                {busy ? 'Cancelling…' : 'Cancel Request'}
              </button>
            )}
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
          </div>
        }
      />

      <div>
        {submitted && item.status === 'PENDING_REVIEW' && (
          <div className="alert success" style={{ marginBottom: '1.25rem' }}>
            Submitted. Hexalyte will review the payment and notify you.
          </div>
        )}
        {error && <div className="alert error" style={{ marginBottom: '1.25rem' }}>{error}</div>}
        <ActivationSteps status={item.status} />

        {item.status === 'REJECTED' && (
          <div className="alert error" style={{ marginTop: '1.25rem' }}>
            <strong>Rejected:</strong> {item.rejectionReason}
            <div className="small">If the issue can be fixed, submit a new request with the correct details.</div>
          </div>
        )}
        {item.status === 'APPROVED' && (
          <div className="alert info" style={{ marginTop: '1.25rem' }}>
            Payment verified and approved. Hexalyte is activating the subscription in {item.product.name}.
          </div>
        )}
        {item.status === 'ACTIVATION_COMPLETED' && (
          <div className="alert success" style={{ marginTop: '1.25rem' }}>
            {item.customerAccount.customer.displayName}&apos;s {item.product.name} subscription is active for {monthLabel(item.periodMonth)}
            {item.activatedAt ? ` (activated ${formatDate(item.activatedAt)})` : ''}.
            {item.activationReference && <div className="small">SaaS reference: {item.activationReference}</div>}
          </div>
        )}

        <div className="grid-2 gap" style={{ marginTop: '1.25rem' }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Request</h2>
            <dl className="details">
              <dt>Customer</dt>
              <dd>{item.customerAccount.customer.displayName}</dd>
              <dt>Product</dt>
              <dd>{item.product.name}</dd>
              <dt>Month</dt>
              <dd>{monthLabel(item.periodMonth)}</dd>
              <dt>Amount</dt>
              <dd>{formatMoney(item.amount, item.currency)}</dd>
              <dt>Paid by</dt>
              <dd>
                {item.payerName}
                {item.payerBank ? ` · ${item.payerBank}` : ''}
              </dd>
              <dt>Bank reference</dt>
              <dd className="mono">{item.transactionRef}</dd>
              <dt>Transfer date</dt>
              <dd>{formatDate(item.transferDate)}</dd>
              <dt>Submitted</dt>
              <dd>{new Date(item.submittedAt).toLocaleString()}</dd>
              {item.notes && (
                <>
                  <dt>Notes</dt>
                  <dd>{item.notes}</dd>
                </>
              )}
            </dl>
            {item.bankSlips.map((s) => (
              <BankSlipViewer key={s.id} requestId={item.id} slip={s} />
            ))}
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>History</h2>
            <ActivationHistory history={item.history} />
          </div>
        </div>
      </div>
    </>
  )
}

function Page() {
  const { id } = useParams<{ id: string }>()
  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Detail id={id} canCancel={user.permissions.includes('activations:create')} />
          </Suspense>
        </main>
      )}
    </ResellerShell>
  )
}

export default Page
