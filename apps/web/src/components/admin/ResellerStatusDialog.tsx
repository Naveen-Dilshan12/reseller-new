'use client'

import { useState } from 'react'
import { api, ApiError } from '@/lib/api'

interface Props {
  reseller: { id: string; businessName: string; code: string }
  action: 'suspend' | 'reactivate'
  onClose: () => void
  onDone: (message: string) => void
}

/** Suspend (reason required) or reactivate a reseller. Both actions are audited server-side. */
export function ResellerStatusDialog({ reseller, action, onClose, onDone }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const suspend = action === 'suspend'

  const submit = async () => {
    if (suspend && text.trim().length < 10) return setError('Give a reason of at least 10 characters.')
    setBusy(true)
    setError(null)
    try {
      await api(`/admin/resellers/${reseller.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(suspend ? { reason: text.trim() } : text.trim() ? { note: text.trim() } : {}),
      })
      onDone(suspend ? `${reseller.businessName} suspended. Their users were logged out.` : `${reseller.businessName} reactivated.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>
          {suspend ? 'Suspend' : 'Reactivate'} {reseller.businessName}
        </h2>
        <p className="small muted">
          {suspend
            ? 'All reseller users are logged out and cannot sign in or submit requests. Their customers’ SaaS accounts and existing commissions are not affected.'
            : 'The reseller’s users can sign in again immediately.'}
        </p>
        <div className="field">
          <label htmlFor="rs-text">{suspend ? 'Reason (internal)' : 'Note (optional)'}</label>
          <textarea id="rs-text" rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {error && <div className="alert error small">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={`btn ${suspend ? 'danger' : 'success'}`} onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : suspend ? 'Suspend reseller' : 'Reactivate'}
          </button>
        </div>
      </div>
    </div>
  )
}
