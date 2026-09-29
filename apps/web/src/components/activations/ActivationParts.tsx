'use client'

import { useEffect, useState } from 'react'
import { apiBlob, ApiError } from '@/lib/api'
import {
  ACTION_LABELS,
  ACTIVATION_STATUS_LABELS,
  STEPS,
  formatBytes,
  type ActivationStatus,
  type BankSlipInfo,
  type HistoryEntry,
} from '@/lib/activation-types'

export function StatusBadge({ status }: { status: ActivationStatus }) {
  return <span className={`badge act-${status}`}>{ACTIVATION_STATUS_LABELS[status]}</span>
}

/** PENDING_REVIEW → UNDER_REVIEW → APPROVED → ACTIVATION_COMPLETED, with REJECTED/CANCELLED as terminal states. */
export function ActivationSteps({ status }: { status: ActivationStatus }) {
  const ended = status === 'REJECTED' || status === 'CANCELLED'
  const index = STEPS.indexOf(status)
  return (
    <div className="steps">
      {STEPS.map((s, i) => (
        <div key={s} className={`step ${!ended && (i < index || s === 'ACTIVATION_COMPLETED' && i === index) ? 'done' : !ended && i === index ? 'active' : ''}`}>
          {s === 'APPROVED' ? 'Approved' : ACTIVATION_STATUS_LABELS[s]}
        </div>
      ))}
      {ended && <div className="step failed">{ACTIVATION_STATUS_LABELS[status]}</div>}
    </div>
  )
}

/** Loads a bank slip through the authenticated API only when asked; each view is audited server-side. */
export function BankSlipViewer({ requestId, slip }: { requestId: string; slip: BankSlipInfo }) {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])

  const open = async () => {
    setBusy(true)
    setError(null)
    try {
      const blob = await apiBlob(`/activation-requests/${requestId}/bank-slips/${slip.id}`)
      setUrl(URL.createObjectURL(blob))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the bank slip')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="slip">
      <div className="row">
        <div>
          <strong>{slip.originalName}</strong>
          <div className="small muted">
            {slip.mimeType === 'application/pdf' ? 'PDF' : 'Image'} · {formatBytes(slip.sizeBytes)}
          </div>
        </div>
        <span className="spacer" />
        {url ? (
          <button className="btn secondary small" onClick={() => setUrl(null)}>
            Hide
          </button>
        ) : (
          <button className="btn secondary small" onClick={open} disabled={busy}>
            {busy ? 'Loading…' : 'View bank slip'}
          </button>
        )}
      </div>
      {error && <div className="alert error small">{error}</div>}
      {url &&
        (slip.mimeType === 'application/pdf' ? (
          <iframe className="slip-frame" src={url} title="Bank slip" sandbox="allow-same-origin" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="slip-image" src={url} alt={`Bank slip ${slip.originalName}`} />
        ))}
    </div>
  )
}

export function ActivationHistory({ history, showActors }: { history: HistoryEntry[]; showActors?: boolean }) {
  return (
    <ul className="history">
      {[...history].reverse().map((h) => (
        <li key={h.id}>
          <div className="row">
            <strong>{ACTION_LABELS[h.action] ?? h.action}</strong>
            {h.internal && <span className="badge INACTIVE">internal</span>}
            <span className="spacer" />
            <span className="small muted">{new Date(h.createdAt).toLocaleString()}</span>
          </div>
          {showActors && h.actor && (
            <div className="small muted">
              {h.actor.name} ({h.actor.email})
            </div>
          )}
          {h.note && <div className="small">{h.note}</div>}
        </li>
      ))}
    </ul>
  )
}
