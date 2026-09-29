'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import type { ResellerActivation } from '@/lib/activation-types'
import { ResellerShell } from '@/components/ResellerShell'
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
      <div className="row">
        <h1 className="mono">{item.reference}</h1>
        <StatusBadge status={item.status} />
        <span className="spacer" />
        {canCancel && item.status === 'PENDING_REVIEW' && (
          <button className="btn secondary" onClick={cancel} disabled={busy}>
            Cancel request
          </button>
        )}
      </div>
      {submitted && item.status === 'PENDING_REVIEW' && (
        <div className="alert success">Submitted. Hexalyte will review the payment and notify you.</div>
      )}
      {error && <div className="alert error">{error}</div>}
      <ActivationSteps status={item.status} />

      {item.status === 'REJECTED' && (
        <div className="alert error">
          <strong>Rejected:</strong> {item.rejectionReason}
          <div className="small">If the issue can be fixed, submit a new request with the correct details.</div>
        </div>
      )}
      {item.status === 'APPROVED' && (
        <div className="alert info">Payment verified and approved. Hexalyte is activating the subscription in {item.product.name}.</div>
      )}
      {item.status === 'ACTIVATION_COMPLETED' && (
        <div className="alert success">
          {item.customerAccount.customer.displayName}&apos;s {item.product.name} subscription is active for {monthLabel(item.periodMonth)}
          {item.activatedAt ? ` (activated ${formatDate(item.activatedAt)})` : ''}.
          {item.activationReference && <div className="small">SaaS reference: {item.activationReference}</div>}
        </div>
      )}

      <div className="grid-2 gap">
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
    </>
  )
}

function Page() {
  const { id } = useParams<{ id: string }>()
  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          <Link href="/activations" className="small">
            ← Paid activations
          </Link>
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Detail id={id} canCancel={user.permissions.includes('activations:create')} />
          </Suspense>
        </main>
      )}
    </ResellerShell>
  )
}

export default Page
