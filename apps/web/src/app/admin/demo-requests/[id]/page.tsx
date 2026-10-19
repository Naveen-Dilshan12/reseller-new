'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import type { AdminDemoRequest } from '@/lib/demo-types'
import { DemoHistory, DemoSteps, StatusBadge, WelcomeMessagePreview } from '@/components/demos/DemoRequestParts'
import { Modal } from '@/components/ui/Modal'

type Dialog = 'approve' | 'reject' | 'message' | 'confirm' | null
type Message = { kind: 'success' | 'error' | 'info'; text: string }

const WELCOME_MESSAGE_MAX = 4000

const person = (p: { name: string; email: string } | null) => (p ? `${p.name} (${p.email})` : '—')

export default function AdminDemoRequestPage() {
  const { id } = useParams<{ id: string }>()
  const admin = useAdminUser()
  const canReview = admin.permissions.includes('demos:review')

  const [item, setItem] = useState<AdminDemoRequest | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const [welcomeMessage, setWelcomeMessage] = useState('')
  const [tenantId, setTenantId] = useState('')

  const load = useCallback(() => {
    api<AdminDemoRequest>(`/demo-requests/${id}`)
      .then(setItem)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load the request'))
  }, [id])
  useEffect(load, [load])

  const openDialog = (d: Dialog) => {
    setNote('')
    setWelcomeMessage('')
    setTenantId('')
    setDialogError(null)
    setDialog(d)
  }

  const post = async <T,>(path: string, body?: unknown) =>
    api<T>(`/demo-requests/${id}/${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setDialogError(null)
    try {
      await action()
      setDialog(null)
    } catch (err) {
      setDialogError(err instanceof ApiError ? err.message : fallback)
      load()
    } finally {
      setBusy(false)
    }
  }

  const submitDialog = () => {
    if (dialog === 'approve') {
      return run(async () => {
        setItem(await post<AdminDemoRequest>('approve', note.trim() ? { note: note.trim() } : {}))
        setMessage({ kind: 'success', text: 'Approved. Add the customer welcome message so the seller can send it.' })
      }, 'Approval failed')
    }
    if (dialog === 'reject') {
      if (note.trim().length < 10) return setDialogError('Give the partner a clear reason (at least 10 characters)')
      return run(async () => {
        setItem(await post<AdminDemoRequest>('reject', { reason: note.trim() }))
        setMessage({ kind: 'info', text: 'Request rejected. The partner has been notified.' })
      }, 'Rejection failed')
    }
    if (dialog === 'message') {
      if (!welcomeMessage.trim()) return setDialogError('Customer Welcome Message is required')
      if (welcomeMessage.length > WELCOME_MESSAGE_MAX) return setDialogError(`Customer Welcome Message must be ${WELCOME_MESSAGE_MAX} characters or fewer`)
      return run(async () => {
        setItem(await post<AdminDemoRequest>('welcome-message', { welcomeMessage }))
        setMessage({ kind: 'success', text: 'Welcome message saved. The seller can now copy it or open WhatsApp with it.' })
      }, 'Could not save the welcome message')
    }
    if (dialog === 'confirm') {
      if (!tenantId.trim()) return setDialogError('Enter the SaaS tenant ID of the demo shop')
      return run(async () => {
        const confirmed = await post<AdminDemoRequest>('confirm', {
          externalTenantId: tenantId.trim(),
          ...(note.trim() ? { note: note.trim() } : {}),
        })
        setItem(confirmed)
        const linked = confirmed.linkedAccount
        setMessage({
          kind: 'success',
          text: linked
            ? `Confirmed. ${linked.displayName}${linked.customerCode ? ` (${linked.customerCode})` : ''} is now in the seller's My Customers as a trial account${linked.accountCreated ? '' : ' (existing account linked, no duplicate created)'}.`
            : 'Confirmed. The partner sees this as complete.',
        })
      }, 'Could not confirm the request')
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

  return (
    <main className="container">
      <Link href="/admin/demo-requests" className="small">
        ← Demo requests
      </Link>
      <div className="row">
        <h1>{item.businessName}</h1>
        <StatusBadge status={s} />
      </div>
      <DemoSteps status={s} />
      {message && <div className={`alert ${message.kind}`}>{message.text}</div>}

      {canReview && s === 'PENDING' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Next step</h2>
          <div className="row">
            <span>Review the request and approve or reject it.</span>
            <span className="spacer" />
            <button className="btn secondary" onClick={() => openDialog('reject')} disabled={busy}>
              Reject
            </button>
            <button className="btn" onClick={() => openDialog('approve')} disabled={busy}>
              Approve
            </button>
          </div>
        </div>
      )}

      {canReview && s === 'APPROVED' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Next step</h2>
          <p className="small">
            Paste the complete, prepared welcome message for the customer. Saving it moves this to{' '}
            <strong>Welcome message saved</strong> and shows the exact message to the seller.
          </p>
          <div className="row">
            <span className="spacer" />
            <button className="btn" onClick={() => openDialog('message')} disabled={busy}>
              Add customer welcome message
            </button>
          </div>
        </div>
      )}

      {canReview && s === 'DEMO_CREATED' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Next step</h2>
          <p className="small">
            Once the demo shop exists in the SaaS console, confirm it with its tenant ID. Confirming creates nothing in the SaaS; it
            links the customer and a trial account to the seller and notifies them.
          </p>
          <div className="row">
            <span className="spacer" />
            <button className="btn" onClick={() => openDialog('confirm')} disabled={busy}>
              Confirm completion
            </button>
          </div>
        </div>
      )}

      {s === 'REJECTED' && (
        <div className="alert error">
          <strong>Rejected</strong> {item.decidedAt ? `on ${new Date(item.decidedAt).toLocaleString()}` : ''} by {person(item.people.reviewedBy)}:{' '}
          {item.rejectionReason}
        </div>
      )}

      {(s === 'DEMO_CREATED' || s === 'CONFIRMED') && item.welcomeMessage && (
        <WelcomeMessagePreview message={item.welcomeMessage} whatsappLink={null} />
      )}

      <div className="grid-2 gap">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Prospect</h2>
          <dl className="details">
            <dt>Business / customer</dt>
            <dd>{item.businessName}</dd>
            <dt>Contact</dt>
            <dd>
              {item.contactName}
              <div className="muted small">
                {item.contactEmail} · {item.contactPhone}
              </div>
            </dd>
            <dt>Product</dt>
            <dd>{item.product.name}</dd>
            <dt>Partner</dt>
            <dd>
              {item.reseller.businessName} <span className="muted mono small">{item.reseller.code}</span>
            </dd>
            <dt>Submitted</dt>
            <dd>
              {new Date(item.submittedAt).toLocaleString()} by {person(item.people.requestedBy)}
            </dd>
            {item.notes && (
              <>
                <dt>Partner notes</dt>
                <dd>{item.notes}</dd>
              </>
            )}
          </dl>
        </div>

        {(s === 'DEMO_CREATED' || s === 'CONFIRMED') && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Welcome message</h2>
            <dl className="details">
              <dt>Saved</dt>
              <dd>{item.demoCreatedAt ? `${new Date(item.demoCreatedAt).toLocaleString()} by ${person(item.people.demoCreatedBy)}` : '—'}</dd>
              {s === 'CONFIRMED' && (
                <>
                  <dt>Confirmed</dt>
                  <dd>{item.confirmedAt ? `${new Date(item.confirmedAt).toLocaleString()} by ${person(item.people.confirmedBy)}` : '—'}</dd>
                </>
              )}
            </dl>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Status history</h2>
        <DemoHistory history={item.history} showActors />
      </div>

      {dialog && (
        <Modal label={dialog === 'approve' ? 'Approve request' : dialog === 'reject' ? 'Reject request' : dialog === 'message' ? 'Customer welcome message' : 'Confirm completion'} onClose={() => setDialog(null)}>
            {dialog === 'approve' && (
              <>
                <h2>Approve request</h2>
                <p className="small">
                  Approving does not create anything in the SaaS. After approving, add the customer welcome message for
                  the seller to send.
                </p>
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
                  <textarea id="dlg-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </>
            )}
            {dialog === 'message' && (
              <>
                <h2>Customer welcome message</h2>
                <p className="small">
                  Paste the complete message exactly as the customer should receive it. The seller sees it word for word.
                </p>
                <div className="field">
                  <label htmlFor="dlg-message">Customer Welcome Message</label>
                  <textarea
                    id="dlg-message"
                    rows={12}
                    maxLength={WELCOME_MESSAGE_MAX}
                    required
                    value={welcomeMessage}
                    onChange={(e) => setWelcomeMessage(e.target.value)}
                  />
                </div>
              </>
            )}
            {dialog === 'confirm' && (
              <>
                <h2>Confirm completion</h2>
                <div className="alert warning small">
                  <strong>The demo shop must already exist in {item.product.name}.</strong> Create it in the SaaS console
                  first. This platform does not create or check anything in the SaaS: confirming only records the tenant
                  ID you enter below.
                </div>
                <p className="small">
                  Confirming then adds the customer to the seller&apos;s My Customers as a <strong>trial account</strong>{' '}
                  linked to that tenant (an existing customer or account is reused, never duplicated), so the seller can
                  start a paid activation.
                </p>
                <div className="field">
                  <label htmlFor="dlg-tenant">SaaS tenant ID</label>
                  <input
                    id="dlg-tenant"
                    maxLength={100}
                    required
                    placeholder="Tenant ID copied from the SaaS console"
                    value={tenantId}
                    onChange={(e) => setTenantId(e.target.value)}
                  />
                  <span className="hint">
                    Required. Copy it exactly from the existing tenant: nothing here verifies it, and paid activation
                    will use it.
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="dlg-note">Internal note (optional)</label>
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
                  : dialog === 'approve'
                    ? 'Approve'
                    : dialog === 'reject'
                      ? 'Reject request'
                      : dialog === 'message'
                        ? 'Save welcome message'
                        : 'Confirm completion'}
              </button>
            </div>
        </Modal>
      )}
    </main>
  )
}
