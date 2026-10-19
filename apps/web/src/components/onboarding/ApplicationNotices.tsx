'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CheckCircle2, Clock, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { getCachedUser, refreshCurrentUser, setCachedUser, type CurrentUser } from '@/lib/auth'
import { Modal } from '@/components/ui/Modal'

const FORM_HREF = '/dashboard/become-reseller'

/** Browser-side mirror of "already shown", so a failed request never causes a repeat. The server copy is `welcomeSeen`. */
const welcomeKey = (userId: string) => `hxr_welcome_shown_${userId}`
/** Last application status this browser saw, used only to recognise "pending → approved" once. */
const statusKey = (userId: string) => `hxr_application_status_${userId}`

function readFlag(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeFlag(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* storage blocked: the server-side marker still applies */
  }
}

/**
 * The reseller application status (user.reseller) is the source of truth; nothing here decides who
 * is approved. This component only decides which one-time popup to show:
 *   - welcome popup:   application not submitted AND never shown before (recorded on the server the
 *                      moment it appears, so logging out or closing the tab also counts as "shown")
 *   - approved popup:  the application just went from pending to approved
 * and keeps the user's status fresh while the application is pending.
 */
export function ApplicationPopups({ user }: { user: CurrentUser }) {
  const pathname = usePathname()
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  const [approvedOpen, setApprovedOpen] = useState(false)
  const welcomeRecorded = useRef(false)
  const status = user.reseller?.status ?? null
  const onApplicationForm = pathname.startsWith(FORM_HREF)

  // ── Welcome popup (first time only) ──
  useEffect(() => {
    if (status !== null || onApplicationForm || welcomeRecorded.current) return
    if (user.welcomeSeen || readFlag(welcomeKey(user.id))) return
    welcomeRecorded.current = true
    setWelcomeOpen(true)
    writeFlag(welcomeKey(user.id), '1')
    api('/auth/me/welcome-shown', { method: 'POST' })
      .then(() => {
        const cached = getCachedUser()
        if (cached) setCachedUser({ ...cached, welcomeSeen: true })
      })
      .catch(() => {
        /* the browser-side flag above still prevents a repeat on this device */
      })
  }, [status, onApplicationForm, user.id, user.welcomeSeen])

  // ── Pending → approved: celebrate once ──
  useEffect(() => {
    if (!status) return
    const previous = readFlag(statusKey(user.id))
    if (status === 'PENDING') writeFlag(statusKey(user.id), 'PENDING')
    else if (status === 'ACTIVE' && previous === 'PENDING') {
      writeFlag(statusKey(user.id), 'ACTIVE')
      setApprovedOpen(true)
    }
  }, [status, user.id])

  // ── While pending, pick up an Admin approval without the user having to reload ──
  useEffect(() => {
    if (status !== 'PENDING') return
    const refresh = () => {
      if (document.visibilityState === 'visible') void refreshCurrentUser()
    }
    const timer = window.setInterval(refresh, 45_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [status])

  const firstName = user.name?.trim().split(/\s+/)[0] || 'there'

  return (
    <>
      {welcomeOpen && (
        <Modal label="Welcome to Hexalyte" onClose={() => setWelcomeOpen(false)}>
          <div className="apply-popup">
            <span className="apply-popup-icon">
              <Sparkles size={30} />
            </span>
            <span className="apply-popup-kicker">Hexalyte Partner Network</span>
            <h2>Welcome, {firstName}!</h2>
            <p>
              Your account is ready. To start selling Hexalyte SaaS you first need to{' '}
              <strong>complete and submit your partner application</strong> for Admin review.
            </p>
            <ol className="apply-popup-steps">
              <li>Personal details</li>
              <li>Business details</li>
              <li>Bank details</li>
              <li>Review &amp; submit</li>
            </ol>
            <p className="small muted">
              Once an Admin approves it, products, demo requests, customers, activations and commissions unlock automatically.
            </p>
            <div className="apply-popup-actions">
              <Link href={FORM_HREF} className="btn" onClick={() => setWelcomeOpen(false)}>
                Complete Partner Application
              </Link>
              <button type="button" className="btn secondary" onClick={() => setWelcomeOpen(false)}>
                Maybe later
              </button>
            </div>
          </div>
        </Modal>
      )}

      {approvedOpen && (
        <Modal label="Partner application approved" onClose={() => setApprovedOpen(false)}>
          <div className="apply-popup">
            <span className="apply-popup-icon approved">
              <CheckCircle2 size={32} />
            </span>
            <span className="apply-popup-kicker">Application approved</span>
            <h2>You&apos;re an approved partner!</h2>
            <p>
              Hexalyte has approved your application. SaaS products, demo requests, customers, activations and commissions are now unlocked
              for you.
            </p>
            <div className="apply-popup-actions">
              <button type="button" className="btn" onClick={() => setApprovedOpen(false)}>
                Start selling
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

/**
 * Persistent, non-intrusive status in the sidebar until the application is approved:
 * a reminder to complete it, or "Pending Admin Review" once it has been submitted.
 */
export function ApplicationStatusCard({ user }: { user: CurrentUser }) {
  const status = user.reseller?.status ?? null
  if (status === 'ACTIVE') return null

  if (status === 'PENDING') {
    return (
      <div className="apply-card pending" role="status">
        <div className="apply-card-head">
          <Clock size={15} />
          <strong>Pending Admin Review</strong>
        </div>
        <p>Your application was submitted. You&apos;ll be notified when it is approved, and your features unlock automatically.</p>
      </div>
    )
  }

  if (status === null) {
    return (
      <div className="apply-card reminder">
        <div className="apply-card-head">
          <Sparkles size={15} />
          <strong>Complete Your Partner Application</strong>
        </div>
        <p>Submit your application to unlock products, demos and commissions.</p>
        <Link href={FORM_HREF} className="btn small">
          Complete application
        </Link>
      </div>
    )
  }

  return null
}
