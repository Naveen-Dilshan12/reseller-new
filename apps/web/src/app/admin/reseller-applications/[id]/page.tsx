'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { ResellerStatusDialog } from '@/components/admin/ResellerStatusDialog'

interface Application {
  id: string
  code: string
  status: string
  submittedAt: string
  personal: { fullName: string; nicOrPassport: string; email: string; mobile: string; address: string }
  business: {
    businessName: string
    businessRegistrationNo: string
    businessAddress: string
    businessPhone: string
    businessEmail: string
  }
  bank: { bankName: string; branch: string; accountHolderName: string; accountNumberMasked: string } | null
  review: {
    reviewedAt: string | null
    reviewedBy: { name: string; email: string } | null
    approvedAt: string | null
    rejectionReason: string | null
    reviewNote: string | null
  }
  level: { currentLevel: number | null; activeCustomerCount: number }
  suspension: { suspendedAt: string; reason: string | null } | null
}

type Dialog = 'approve' | 'reject' | null

function Details({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="details">
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function ApplicationReviewPage() {
  const { id } = useParams<{ id: string }>()
  const admin = useAdminUser()
  const canManage = admin.permissions.includes('resellers:manage')
  const canReveal = admin.permissions.includes('resellers:bank-reveal')

  const [app, setApp] = useState<Application | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [statusAction, setStatusAction] = useState<'suspend' | 'reactivate' | null>(null)

  const load = useCallback(() => {
    api<Application>(`/admin/reseller-applications/${id}`)
      .then(setApp)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load application'))
  }, [id])

  useEffect(load, [load])

  // Hide the revealed number again after 30 seconds.
  useEffect(() => {
    if (!revealed) return
    const t = setTimeout(() => setRevealed(null), 30_000)
    return () => clearTimeout(t)
  }, [revealed])

  const reveal = async () => {
    try {
      const { accountNumber } = await api<{ accountNumber: string }>(`/admin/reseller-applications/${id}/bank-account/reveal`, {
        method: 'POST',
      })
      setRevealed(accountNumber)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reveal account number')
    }
  }

  const decide = async () => {
    setDialogError(null)
    if (dialog === 'reject' && reason.trim().length < 10) {
      setDialogError('Please give a rejection reason of at least 10 characters.')
      return
    }
    setBusy(true)
    try {
      if (dialog === 'approve') {
        await api(`/admin/reseller-applications/${id}/approve`, {
          method: 'POST',
          body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
        })
        setSuccess('Application approved. The reseller can now log in.')
      } else {
        await api(`/admin/reseller-applications/${id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason.trim() }),
        })
        setSuccess('Application rejected. The applicant will see the reason when trying to log in.')
      }
      setDialog(null)
      load()
    } catch (err) {
      setDialogError(err instanceof ApiError ? err.errors[0]?.split(': ')[1] ?? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  if (error && !app) {
    return (
      <main className="container">
        <div className="alert error">{error}</div>
        <Link href="/admin/reseller-applications">← Back to applications</Link>
      </main>
    )
  }
  if (!app) return <main className="container muted">Loading…</main>

  const isPending = app.status === 'PENDING'

  return (
    <main className="container narrow">
      <Link href="/admin/reseller-applications" className="small">
        ← Back to applications
      </Link>

      <div className="row" style={{ margin: '0.75rem 0 1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>{app.business.businessName}</h1>
          <span className="muted small">
            <span className="mono">{app.code}</span> · submitted {new Date(app.submittedAt).toLocaleString()}
          </span>
        </div>
        <span className="spacer" />
        <span className={`badge ${app.status}`}>{app.status === 'ACTIVE' ? 'APPROVED' : app.status}</span>
      </div>

      {success && <div className="alert success">{success}</div>}
      {error && <div className="alert error">{error}</div>}

      {app.suspension && (
        <div className="alert error">
          <strong>Suspended</strong> since {new Date(app.suspension.suspendedAt).toLocaleString()}
          {app.suspension.reason && <div className="small">Reason: {app.suspension.reason}</div>}
        </div>
      )}

      {app.status === 'REJECTED' && app.review.rejectionReason && (
        <div className="alert warning">
          <strong>Rejection reason:</strong> {app.review.rejectionReason}
        </div>
      )}

      <section className="card">
        <h2>Personal details</h2>
        <Details
          rows={[
            ['Full name', app.personal.fullName],
            ['NIC / Passport', <span className="mono">{app.personal.nicOrPassport}</span>],
            ['Email', app.personal.email],
            ['Mobile', app.personal.mobile],
            ['Address', app.personal.address],
          ]}
        />
      </section>

      <section className="card">
        <h2>Business details</h2>
        <Details
          rows={[
            ['Business name', app.business.businessName],
            ['Registration number', <span className="mono">{app.business.businessRegistrationNo}</span>],
            ['Business address', app.business.businessAddress],
            ['Business phone', app.business.businessPhone],
            ['Business email', app.business.businessEmail],
          ]}
        />
      </section>

      <section className="card">
        <h2>Bank details</h2>
        {app.bank ? (
          <Details
            rows={[
              ['Bank', app.bank.bankName],
              ['Branch', app.bank.branch],
              ['Account holder', app.bank.accountHolderName],
              [
                'Account number',
                <span className="row">
                  <span className="mono">{revealed ?? app.bank.accountNumberMasked}</span>
                  {canReveal &&
                    (revealed ? (
                      <button className="btn link small" onClick={() => setRevealed(null)}>
                        Hide
                      </button>
                    ) : (
                      <button className="btn link small" onClick={reveal}>
                        Reveal (logged)
                      </button>
                    ))}
                </span>,
              ],
            ]}
          />
        ) : (
          <p className="muted">No bank details provided.</p>
        )}
      </section>

      {!isPending && (
        <section className="card">
          <h2>Review</h2>
          <Details
            rows={[
              ['Reviewed by', app.review.reviewedBy ? `${app.review.reviewedBy.name} (${app.review.reviewedBy.email})` : null],
              ['Reviewed at', app.review.reviewedAt ? new Date(app.review.reviewedAt).toLocaleString() : null],
              ['Note', app.review.reviewNote],
            ]}
          />
          {app.status === 'ACTIVE' && (
            <p style={{ marginTop: '1rem', marginBottom: 0 }}>
              <Link href={`/admin/resellers/${app.id}/commissions`}>
                View level & commission history ({app.level.activeCustomerCount} active customers)
              </Link>
              {' · '}
              <Link href={`/admin/resellers/${app.id}/products`}>Manage SaaS product access</Link>
            </p>
          )}
        </section>
      )}

      {canManage && (app.status === 'ACTIVE' || app.status === 'SUSPENDED') && (
        <div className="row">
          <span className="spacer" />
          {app.status === 'ACTIVE' ? (
            <button className="btn danger" onClick={() => setStatusAction('suspend')}>
              Suspend reseller
            </button>
          ) : (
            <button className="btn success" onClick={() => setStatusAction('reactivate')}>
              Reactivate reseller
            </button>
          )}
        </div>
      )}

      {statusAction && (
        <ResellerStatusDialog
          reseller={{ id: app.id, businessName: app.business.businessName, code: app.code }}
          action={statusAction}
          onClose={() => setStatusAction(null)}
          onDone={(text) => {
            setStatusAction(null)
            setSuccess(text)
            load()
          }}
        />
      )}

      {isPending && canManage && (
        <div className="row">
          <span className="spacer" />
          <button className="btn danger" onClick={() => setDialog('reject')}>
            Reject
          </button>
          <button className="btn success" onClick={() => setDialog('approve')}>
            Approve
          </button>
        </div>
      )}

      {dialog && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>{dialog === 'approve' ? 'Approve application' : 'Reject application'}</h2>
            {dialogError && <div className="alert error">{dialogError}</div>}

            {dialog === 'approve' ? (
              <>
                <p className="muted small">
                  {app.business.businessName} will be activated and can log in immediately. The commission rate is
                  set automatically from the reseller level, and access to all active SaaS products is granted (adjustable
                  afterwards).
                </p>
                <div className="field">
                  <label htmlFor="note">Internal note (optional)</label>
                  <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </>
            ) : (
              <div className="field">
                <label htmlFor="reason">Rejection reason</label>
                <textarea
                  id="reason"
                  rows={4}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Shown to the applicant, e.g. Business registration number could not be verified."
                />
                <span className="hint">Minimum 10 characters. The applicant sees this reason when they try to log in.</span>
              </div>
            )}

            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </button>
              <button className={`btn ${dialog === 'approve' ? 'success' : 'danger'}`} onClick={decide} disabled={busy}>
                {busy ? 'Saving…' : dialog === 'approve' ? 'Approve' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
