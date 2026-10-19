'use client'

import { useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { getCachedUser, setCachedUser } from '@/lib/auth'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'
import { Field } from '@/components/Field'
import { toWhatsAppNumber } from '@/lib/whatsapp'

const PHONE_EXAMPLE = 'e.g. 0771234567 or +94771234567'
const PHONE_INVALID = 'Enter a valid mobile number, e.g. 0771234567 or +94771234567'

/**
 * The seller's own WhatsApp number. Only the number is stored: no WhatsApp login, password,
 * token or API is involved. Messages are sent from the seller's own WhatsApp app.
 */
function WhatsappCard({ initial }: { initial: string | null }) {
  const [saved, setSaved] = useState<string | null>(initial)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // Keep the app-wide cached user in step so other pages (e.g. the demo request page) show the change.
  const syncCache = (whatsappNumber: string | null) => {
    const cached = getCachedUser()
    if (cached) setCachedUser({ ...cached, whatsappNumber })
  }

  const startEdit = () => {
    setValue(saved ?? '')
    setError(null)
    setFieldError(null)
    setMessage(null)
    setEditing(true)
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setFieldError(null)
    setMessage(null)
    if (!toWhatsAppNumber(value)) {
      setFieldError(PHONE_INVALID)
      return
    }
    setBusy(true)
    try {
      const res = await api<{ whatsappNumber: string }>('/auth/me/whatsapp', {
        method: 'PUT',
        body: JSON.stringify({ whatsappNumber: value.trim() }),
      })
      setSaved(res.whatsappNumber)
      syncCache(res.whatsappNumber)
      setEditing(false)
      setMessage('WhatsApp number saved.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the WhatsApp number.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (
      !window.confirm(
        'Remove your WhatsApp number?\n\n' +
          'This number is the phone number stored on your Partner account, which may be the mobile number you registered with. ' +
          'Removing it also deletes that stored phone number from your account. ' +
          'Your partner business record is not changed.\n\nContinue?',
      )
    ) {
      return
    }
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      await api('/auth/me/whatsapp', { method: 'DELETE' })
      setSaved(null)
      syncCache(null)
      setEditing(false)
      setMessage('WhatsApp number removed. The phone number stored on your Partner account has also been cleared.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the WhatsApp number.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2>WhatsApp Number</h2>
      <p className="muted small">
        Link the WhatsApp number you use to message customers. Only the number is saved. Hexalyte never asks for your
        WhatsApp password or codes, and nothing is sent on your behalf.
      </p>
      <p className="small" style={{ marginTop: 0 }}>
        <strong>Note:</strong> this is the same phone number stored on your Partner account (it may already be the mobile you
        registered with). Editing it changes that stored number, and removing it deletes the stored number as well.
      </p>

      {message && <div className="alert success">{message}</div>}
      {error && <div className="alert error">{error}</div>}

      {editing || !saved ? (
        <form onSubmit={save} style={{ marginTop: '1rem' }}>
          <Field
            label="WhatsApp number"
            name="whatsappNumber"
            type="tel"
            value={value}
            onChange={(_, v) => {
              setValue(v)
              if (fieldError) setFieldError(null)
            }}
            hint={PHONE_EXAMPLE}
            error={fieldError ?? undefined}
            maxLength={40}
            required
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem', marginTop: '1rem' }}>
            {saved && (
              <button type="button" className="btn secondary" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : saved ? 'Save Changes' : 'Save WhatsApp Number'}
            </button>
          </div>
        </form>
      ) : (
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginTop: '1rem' }}
        >
          <div>
            <span className="muted small" style={{ display: 'block' }}>Linked number</span>
            <strong className="mono">{saved}</strong>
          </div>
          <div style={{ display: 'flex', gap: '0.65rem' }}>
            <button type="button" className="btn secondary small" onClick={startEdit} disabled={busy}>
              Edit
            </button>
            <button type="button" className="btn secondary small" onClick={remove} disabled={busy}>
              {busy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ResellerProfilePage() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.')
      return
    }

    setLoading(true)
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      setMessage('Password updated successfully. Please use your new password next time you log in.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          {/* ── Compact Scenic Hero Banner (No KPIs on Profile Page) ── */}
          <PageHero
            tag="PARTNER ACCOUNT"
            title="My Account &amp; Security"
            subtitle="Manage your credentials, view your partner profile, and update your security settings."
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="5" />
                <path d="M20 21a8 8 0 1 0-16 0" />
              </svg>
            }
            actions={
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                <span className="mono" style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--primary-light)' }}>
                  {user.reseller?.code || '—'}
                </span>
                <span
                  className={`badge ${user.reseller?.status || 'ACTIVE'}`}
                  style={{ fontSize: '0.68rem', padding: '0.15rem 0.55rem', borderRadius: '9999px' }}
                >
                  {user.reseller?.status || 'Active'}
                </span>
              </div>
            }
          />

          <div className="page-grid">
            <div className="card">
              <h2>Partner Profile</h2>
              <dl className="details" style={{ marginTop: '1rem' }}>
                <dt>Business Name</dt>
                <dd><strong>{user.reseller?.businessName || '—'}</strong></dd>

                <dt>Partner Code</dt>
                <dd><span className="mono">{user.reseller?.code || '—'}</span></dd>

                <dt>Status</dt>
                <dd>
                  <span className={`badge ${user.reseller?.status || 'PENDING'}`}>
                    {user.reseller?.status || 'Active'}
                  </span>
                </dd>

                <dt>Your Name</dt>
                <dd>{user.name}</dd>

                <dt>Login Email</dt>
                <dd>{user.email}</dd>

                <dt>Your Role</dt>
                <dd><span className="badge ACTIVE">{user.role.replace('_', ' ')}</span></dd>
              </dl>
            </div>

            <WhatsappCard initial={user.whatsappNumber} />

            <div className="card span-all">
              <h2>Change Password</h2>
              <p className="muted small">
                Ensure your password is at least 10 characters long and contains uppercase, lowercase, and numeric characters.
              </p>

              {message && <div className="alert success">{message}</div>}
              {error && <div className="alert error">{error}</div>}

              <form onSubmit={handleChangePassword} style={{ marginTop: '1rem' }}>
                <div className="form-grid">
                  <Field
                    label="Current Password"
                    name="currentPassword"
                    type="password"
                    value={currentPassword}
                    onChange={(_, v) => setCurrentPassword(v)}
                    required
                  />

                  <Field
                    label="New Password"
                    name="newPassword"
                    type="password"
                    value={newPassword}
                    onChange={(_, v) => setNewPassword(v)}
                    hint="Minimum 10 characters with uppercase, lowercase, and numbers"
                    required
                  />

                  <Field
                    label="Confirm New Password"
                    name="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(_, v) => setConfirmPassword(v)}
                    required
                  />
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
                  <button type="submit" className="btn" disabled={loading}>
                    {loading ? 'Updating…' : 'Update Password'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </main>
      )}
    </ResellerShell>
  )
}
