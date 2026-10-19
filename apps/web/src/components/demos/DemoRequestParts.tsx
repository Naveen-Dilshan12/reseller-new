'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ACTION_LABELS, DEMO_STATUS_LABELS, STEPS, type DemoHistoryEntry, type DemoStatus } from '@/lib/demo-types'

export function StatusBadge({ status }: { status: DemoStatus }) {
  return <span className={`badge dem-${status}`}>{DEMO_STATUS_LABELS[status]}</span>
}

/** PENDING → APPROVED → DEMO_CREATED → CONFIRMED, with REJECTED as a terminal state. */
export function DemoSteps({ status }: { status: DemoStatus }) {
  const ended = status === 'REJECTED'
  const index = STEPS.indexOf(status)
  return (
    <div className="steps">
      {STEPS.map((s, i) => (
        <div key={s} className={`step ${!ended && i < index ? 'done' : !ended && i === index ? 'active' : ''}`}>
          {DEMO_STATUS_LABELS[s]}
        </div>
      ))}
      {ended && <div className="step failed">{DEMO_STATUS_LABELS[status]}</div>}
    </div>
  )
}

export function DemoHistory({ history, showActors }: { history: DemoHistoryEntry[]; showActors?: boolean }) {
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

/**
 * Shows the admin's saved welcome message exactly as saved, with a Copy Message
 * action and a "Send via WhatsApp" action that opens wa.me to the customer's
 * number with the message pre-filled. Opening WhatsApp never sends anything and
 * is never reported as "sent" or "delivered": the seller still has to press
 * Send inside WhatsApp, and there is no way to confirm they did.
 *
 * `senderNumber` is the seller's own linked WhatsApp number: `undefined` hides
 * the line (admin view), `null` prompts the seller to add it in their Profile.
 */
export function WelcomeMessagePreview({
  message,
  whatsappLink,
  senderNumber,
}: {
  message: string
  whatsappLink: string | null
  senderNumber?: string | null
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message)
      setCopyState('copied')
    } catch {
      // Clipboard access can be refused (insecure context, permissions); the text is still selectable above.
      setCopyState('failed')
    }
    setTimeout(() => setCopyState('idle'), 2500)
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Customer welcome message</h2>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          background: 'var(--surface-hover)',
          borderRadius: 'var(--radius)',
          padding: '1rem',
          fontFamily: 'inherit',
          fontSize: '0.92rem',
        }}
      >
        {message}
      </pre>
      <div className="row" style={{ marginTop: '0.75rem' }}>
        <span className="spacer" />
        <button type="button" className="btn secondary small" onClick={copy}>
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed — select the text above' : 'Copy Message'}
        </button>
        {whatsappLink && (
          <a href={whatsappLink} target="_blank" rel="noreferrer" className="btn small">
            Send via WhatsApp
          </a>
        )}
      </div>
      {whatsappLink && (
        <p className="small muted" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
          Opens WhatsApp to the customer&apos;s number with this message ready. Nothing is sent until you press Send in WhatsApp,
          and this page cannot tell whether you did.
        </p>
      )}
      {senderNumber !== undefined && (
        <p className="small muted" style={{ marginTop: '0.35rem', marginBottom: 0 }}>
          {senderNumber ? (
            <>
              Your linked WhatsApp number: <span className="mono">{senderNumber}</span>
            </>
          ) : (
            <>
              No WhatsApp number linked yet — <Link href="/profile">add it in your Profile</Link>.
            </>
          )}
        </p>
      )}
    </div>
  )
}
