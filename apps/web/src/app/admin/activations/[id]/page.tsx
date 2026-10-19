'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import { ACTIVATION_STATUS_LABELS, type ActivationRunResult, type AdminActivation } from '@/lib/activation-types'
import { ActivationHistory, ActivationSteps, BankSlipViewer, StatusBadge } from '@/components/activations/ActivationParts'
import { Modal } from '@/components/ui/Modal'

type Dialog = 'verify' | 'approve' | 'reject' | 'complete' | null
type Message = { kind: 'success' | 'error' | 'info' | 'warning'; text: string }

const person = (p: { name: string; email: string } | null) => (p ? `${p.name} (${p.email})` : '—')

export default function AdminActivationPage() {
  const { id } = useParams<{ id: string }>()
  const admin = useAdminUser()
  const canReview = admin.permissions.includes('activations:review')
  const canActivate = admin.permissions.includes('activations:activate')

  const [item, setItem] = useState<AdminActivation | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [reference, setReference] = useState('')
  const [externalTenantId, setExternalTenantId] = useState('')

  const load = useCallback(() => {
    api<AdminActivation>(`/activation-requests/${id}`)
      .then(setItem)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load the request'))
  }, [id])
  useEffect(load, [load])

  const openDialog = (d: Dialog) => {
    setNote('')
    setReference('')
    setExternalTenantId('')
    setConfirmed(false)
    setDialogError(null)
    setDialog(d)
  }

  const post = async <T,>(path: string, body?: unknown) =>
    api<T>(`/activation-requests/${id}/${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })

  const run = async (action: () => Promise<void>, fallback: string, inDialog = false) => {
    setBusy(true)
    if (inDialog) setDialogError(null)
    else setMessage(null)
    try {
      await action()
      if (inDialog) setDialog(null)
    } catch (err) {
      const text = err instanceof ApiError ? err.message : fallback
      if (inDialog) setDialogError(text)
      else setMessage({ kind: 'error', text })
      load()
    } finally {
      setBusy(false)
    }
  }

  const startReview = () =>
    run(async () => {
      setItem(await post<AdminActivation>('start-review'))
    }, 'Could not start the review')

  const activateRemote = () =>
    run(async () => {
      const r = await post<ActivationRunResult>('activate')
      setItem(r.request)
      setMessage({ kind: r.outcome === 'ACTIVATED' ? 'success' : r.outcome === 'PENDING' ? 'info' : 'error', text: r.message })
    }, 'Activation failed')

  const syncRemote = () =>
    run(async () => {
      const r = await post<ActivationRunResult>('sync')
      setItem(r.request)
      setMessage({ kind: r.outcome === 'ACTIVATED' ? 'success' : r.outcome === 'PENDING' ? 'info' : 'error', text: r.message })
    }, 'Status check failed')

  const submitDialog = () => {
    if (dialog === 'verify') {
      if (!confirmed) return setDialogError('Confirm that the payment is in the company account')
      if (note.trim().length < 5) return setDialogError('Describe how the payment was verified (at least 5 characters)')
      return run(async () => {
        setItem(await post<AdminActivation>('verify-payment', { confirmed: true, note: note.trim() }))
        setMessage({ kind: 'success', text: 'Payment verified. You can now approve the request.' })
      }, 'Verification failed', true)
    }
    if (dialog === 'approve') {
      return run(async () => {
        setItem(await post<AdminActivation>('approve', note.trim() ? { note: note.trim() } : {}))
        setMessage({ kind: 'success', text: 'Approved. Activate the subscription in the SaaS next.' })
      }, 'Approval failed', true)
    }
    if (dialog === 'reject') {
      if (note.trim().length < 10) return setDialogError('Give the partner a clear reason (at least 10 characters)')
      return run(async () => {
        setItem(await post<AdminActivation>('reject', { reason: note.trim() }))
        setMessage({ kind: 'info', text: 'Request rejected. The partner has been notified.' })
      }, 'Rejection failed', true)
    }
    if (dialog === 'complete') {
      if (!item) return
      if (!item.customerAccount.externalTenantId && externalTenantId.trim().length < 1) {
        return setDialogError('Enter the SaaS tenant ID created in the SaaS console')
      }
      if (reference.trim().length < 2) return setDialogError('Enter the SaaS invoice / subscription reference')
      return run(async () => {
        setItem(
          await post<AdminActivation>('complete', {
            activationReference: reference.trim(),
            ...(!item.customerAccount.externalTenantId ? { externalTenantId: externalTenantId.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          }),
        )
        setMessage({ kind: 'success', text: 'Activation recorded. The customer account is active and the partner commission was generated.' })
      }, 'Could not complete the activation', true)
    }
  }

  if (loadError && !item) {
    return (
      <main className="container">
        <div className="alert error">{loadError}</div>
      </main>
    )
  }
  if (!item) {
    return (
      <main className="container">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  const s = item.status
  const open = s === 'PENDING_REVIEW' || s === 'UNDER_REVIEW'
  const verified = Boolean(item.paymentVerifiedAt)
  const hasWarnings = item.warnings.slipReusedIn.length > 0 || item.warnings.transactionRefUsedIn.length > 0

  return (
    <main className="container">
      <Link href="/admin/activations" className="small">
        ← Activation requests
      </Link>
      <div className="row">
        <h1 className="mono">{item.reference}</h1>
        <StatusBadge status={s} />
      </div>
      <ActivationSteps status={s} />
      {message && <div className={`alert ${message.kind}`}>{message.text}</div>}

      {hasWarnings && (
        <div className="alert warning">
          <strong>Check for duplicate payment claims.</strong>
          {item.warnings.slipReusedIn.length > 0 && (
            <div>
              The same bank slip file was uploaded on:{' '}
              {item.warnings.slipReusedIn.map((w) => (
                <Link key={w.id} href={`/admin/activations/${w.id}`} className="mono" style={{ marginRight: '0.5rem' }}>
                  {w.reference} ({ACTIVATION_STATUS_LABELS[w.status]})
                </Link>
              ))}
            </div>
          )}
          {item.warnings.transactionRefUsedIn.length > 0 && (
            <div>
              The same bank reference was used on:{' '}
              {item.warnings.transactionRefUsedIn.map((w) => (
                <Link key={w.id} href={`/admin/activations/${w.id}`} className="mono" style={{ marginRight: '0.5rem' }}>
                  {w.reference} ({ACTIVATION_STATUS_LABELS[w.status]})
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
      {!item.amountMatchesPrice && (
        <div className="alert warning">
          The amount ({formatMoney(item.amount, item.currency)}) does not match the current monthly price of{' '}
          {formatMoney(item.product.monthlyPrice, item.product.currency)}.
        </div>
      )}

      {(canReview || canActivate) && (open || s === 'APPROVED') && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Next step</h2>
          {s === 'PENDING_REVIEW' && canReview && (
            <div className="row">
              <span>Start the review to take ownership of this request before checking the bank statement.</span>
              <span className="spacer" />
              <button className="btn secondary" onClick={() => openDialog('reject')} disabled={busy}>
                Reject
              </button>
              <button className="btn" onClick={startReview} disabled={busy}>
                Start review
              </button>
            </div>
          )}
          {s === 'UNDER_REVIEW' && canReview && (
            <div className="row">
              <span>
                {verified
                  ? 'Payment verified. Approve the request so the subscription can be activated.'
                  : `Find ${formatMoney(item.amount, item.currency)} with reference “${item.transactionRef}” in the company bank statement.`}
              </span>
              <span className="spacer" />
              <button className="btn secondary" onClick={() => openDialog('reject')} disabled={busy}>
                Reject
              </button>
              {verified ? (
                <button className="btn" onClick={() => openDialog('approve')} disabled={busy}>
                  Approve
                </button>
              ) : (
                <button className="btn" onClick={() => openDialog('verify')} disabled={busy}>
                  Verify payment
                </button>
              )}
            </div>
          )}
          {s === 'APPROVED' &&
            (canActivate ? (
              <>
                {item.activation.remoteAvailable ? (
                  <p className="small">
                    {item.product.name} is connected through its partner API. Activation runs the SaaS&apos;s own subscription
                    approval for tenant <span className="mono">{item.customerAccount.externalTenantId}</span>.
                  </p>
                ) : (
                  <p className="small">
                    {item.product.name} has no partner API yet. Open the {item.product.name} admin console, confirm the payment for tenant{' '}
                    <span className="mono">{item.customerAccount.externalTenantId}</span> ({monthLabel(item.periodMonth)}, bank reference{' '}
                    <span className="mono">{item.transactionRef}</span>), then record the SaaS invoice or subscription reference here.
                  </p>
                )}
                {item.activationError && <div className="alert error small">Last attempt: {item.activationError}</div>}
                <div className="row">
                  <span className="spacer" />
                  {item.saasRequestId && (
                    <button className="btn secondary" onClick={syncRemote} disabled={busy}>
                      Check status
                    </button>
                  )}
                  <button className={`btn ${item.activation.remoteAvailable ? 'secondary' : ''}`} onClick={() => openDialog('complete')} disabled={busy}>
                    Mark activation completed
                  </button>
                  {item.activation.remoteAvailable && (
                    <button className="btn" onClick={activateRemote} disabled={busy}>
                      {busy ? 'Activating…' : item.activationAttempts > 0 ? 'Retry activation via SaaS' : 'Activate via SaaS'}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="muted small">Approved. An administrator will activate the subscription in the SaaS.</p>
            ))}
        </div>
      )}

      {s === 'REJECTED' && (
        <div className="alert error">
          <strong>Rejected</strong> {item.decidedAt ? `on ${new Date(item.decidedAt).toLocaleString()}` : ''} by {person(item.people.decidedBy)}:{' '}
          {item.rejectionReason}
        </div>
      )}

      {(s === 'ACTIVATION_COMPLETED' || item.activationAttempts > 0 || item.activationMethod) && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Activation result</h2>
          <dl className="details">
            <dt>Result</dt>
            <dd>
              {s === 'ACTIVATION_COMPLETED' ? (
                <span className="positive">Activated</span>
              ) : item.activationError ? (
                <span className="negative">Failed – {item.activationError}</span>
              ) : item.saasRequestId ? (
                'Processing in the SaaS'
              ) : (
                'Not activated yet'
              )}
            </dd>
            <dt>Method</dt>
            <dd>{item.activationMethod === 'PARTNER_API' ? 'SaaS partner API' : item.activationMethod === 'MANUAL' ? 'SaaS admin console (manual)' : '—'}</dd>
            <dt>SaaS reference</dt>
            <dd className="mono">{item.activationReference ?? '—'}</dd>
            {item.saasRequestId && (
              <>
                <dt>SaaS request ID</dt>
                <dd className="mono">{item.saasRequestId}</dd>
              </>
            )}
            {item.activationAttempts > 0 && (
              <>
                <dt>API attempts</dt>
                <dd>{item.activationAttempts}</dd>
              </>
            )}
            <dt>Activated</dt>
            <dd>{item.activatedAt ? `${new Date(item.activatedAt).toLocaleString()} by ${person(item.people.activatedBy)}` : '—'}</dd>
            {item.activationNote && (
              <>
                <dt>Note</dt>
                <dd>{item.activationNote}</dd>
              </>
            )}
            <dt>Customer account</dt>
            <dd>
              <span className={`badge sub-${item.customerAccount.status}`}>{item.customerAccount.status}</span>
            </dd>
          </dl>
        </div>
      )}

      <div className="grid-2 gap">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Payment</h2>
          <dl className="details">
            <dt>Amount</dt>
            <dd>
              <strong>{formatMoney(item.amount, item.currency)}</strong>{' '}
              {item.amountMatchesPrice ? <span className="small positive">matches monthly price</span> : <span className="small negative">price mismatch</span>}
            </dd>
            <dt>Month</dt>
            <dd>{monthLabel(item.periodMonth)}</dd>
            <dt>Paid by</dt>
            <dd>{item.payerName}</dd>
            <dt>Paid from</dt>
            <dd>{item.payerBank ?? '—'}</dd>
            <dt>Bank reference</dt>
            <dd className="mono">{item.transactionRef}</dd>
            <dt>Transfer date</dt>
            <dd>{formatDate(item.transferDate)}</dd>
            <dt>Verified</dt>
            <dd>
              {item.paymentVerifiedAt ? (
                <>
                  {new Date(item.paymentVerifiedAt).toLocaleString()} by {person(item.people.paymentVerifiedBy)}
                  {item.paymentVerificationNote && <div className="small muted">{item.paymentVerificationNote}</div>}
                </>
              ) : (
                'Not yet'
              )}
            </dd>
            {item.notes && (
              <>
                <dt>Partner notes</dt>
                <dd>{item.notes}</dd>
              </>
            )}
          </dl>
          {item.bankSlips.map((slip) => (
            <BankSlipViewer key={slip.id} requestId={item.id} slip={slip} />
          ))}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Customer &amp; product</h2>
          <dl className="details">
            <dt>Customer</dt>
            <dd>{item.customerAccount.customer.displayName}</dd>
            <dt>Account status</dt>
            <dd>
              <span className={`badge sub-${item.customerAccount.status}`}>{item.customerAccount.status}</span>
            </dd>
            <dt>SaaS tenant ID</dt>
            <dd className="mono">{item.customerAccount.externalTenantId ?? '—'}</dd>
            <dt>Product</dt>
            <dd>
              {item.product.name} <span className="muted mono small">{item.product.code}</span>
            </dd>
            <dt>Monthly price</dt>
            <dd>{formatMoney(item.product.monthlyPrice, item.product.currency)}</dd>
            <dt>Integration</dt>
            <dd>
              {item.activation.provider ?? 'none'} <span className={`badge ${item.activation.integrationStatus}`}>{item.activation.integrationStatus}</span>
            </dd>
            <dt>Partner</dt>
            <dd>
              {item.reseller.businessName} <span className="muted mono small">{item.reseller.code}</span>
            </dd>
            <dt>Submitted</dt>
            <dd>
              {new Date(item.submittedAt).toLocaleString()} by {person(item.people.requestedBy)}
            </dd>
            <dt>Reviewer</dt>
            <dd>{person(item.people.reviewer)}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Status history</h2>
        <ActivationHistory history={item.history} showActors />
      </div>

      {dialog && (
        <Modal label={dialog === 'verify' ? 'Verify payment' : dialog === 'approve' ? 'Approve request' : dialog === 'reject' ? 'Reject request' : 'Mark activation completed'} onClose={() => setDialog(null)}>
            {dialog === 'verify' && (
              <>
                <h2>Verify payment</h2>
                <p className="small">
                  Confirm that {formatMoney(item.amount, item.currency)} (reference <span className="mono">{item.transactionRef}</span>, {formatDate(item.transferDate)})
                  has been received in the company bank account.
                </p>
                <label className="checkbox">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  I checked the company bank statement and the payment is there.
                </label>
                <div className="field">
                  <label htmlFor="dlg-note">Verification note</label>
                  <textarea id="dlg-note" rows={3} maxLength={500} placeholder="e.g. BOC statement 28 Sep, line 14" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </>
            )}
            {dialog === 'approve' && (
              <>
                <h2>Approve request</h2>
                <p className="small">The payment has been verified. After approval the subscription can be activated in {item.product.name}.</p>
                <div className="field">
                  <label htmlFor="dlg-note">Internal note (optional)</label>
                  <textarea id="dlg-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </>
            )}
            {dialog === 'reject' && (
              <>
                <h2>Reject request</h2>
                <p className="small">The reason is shown to the partner.</p>
                <div className="field">
                  <label htmlFor="dlg-note">Rejection reason</label>
                  <textarea
                    id="dlg-note"
                    rows={3}
                    maxLength={500}
                    placeholder="e.g. No matching payment found in the company account for this reference."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              </>
            )}
            {dialog === 'complete' && (
              <>
                <h2>Mark activation completed</h2>
                <p className="small">
                  Only do this after the subscription is active in {item.product.name}. The customer account becomes active and the
                  partner&apos;s commission is generated.
                </p>
                {!item.customerAccount.externalTenantId && (
                  <div className="field">
                    <label htmlFor="dlg-tenant">SaaS Tenant ID</label>
                    <input
                      id="dlg-tenant"
                      maxLength={100}
                      placeholder="e.g. TENANT-001 or business subdomain"
                      value={externalTenantId}
                      onChange={(e) => setExternalTenantId(e.target.value)}
                    />
                    <div className="hint small muted">This account does not have a tenant ID linked yet. Enter the tenant ID created in the SaaS.</div>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="dlg-ref">SaaS invoice / subscription reference</label>
                  <input id="dlg-ref" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="dlg-note">Note (optional)</label>
                  <textarea id="dlg-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </>
            )}
            {dialogError && <div className="alert error small">{dialogError}</div>}
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setDialog(null)} disabled={busy}>
                Close
              </button>
              <button className={`btn ${dialog === 'reject' ? 'danger' : ''}`} onClick={submitDialog} disabled={busy}>
                {busy
                  ? 'Saving…'
                  : dialog === 'verify'
                    ? 'Confirm payment verified'
                    : dialog === 'approve'
                      ? 'Approve'
                      : dialog === 'reject'
                        ? 'Reject request'
                        : 'Mark completed'}
              </button>
            </div>
        </Modal>
      )}
    </main>
  )
}
