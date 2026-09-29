'use client'

import { useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { ResellerShell } from '@/components/ResellerShell'
import { Field } from '@/components/Field'

export default function ResellerProfilePage() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        <main className="container narrow">
          <div className="dash-head">
            <div>
              <h1>My Account & Security</h1>
              <p className="muted small">
                Manage your credentials, view your reseller profile, and update your security settings.
              </p>
            </div>
          </div>

          <div className="card">
            <h2>Reseller Profile</h2>
            <dl className="details" style={{ marginTop: '1rem' }}>
              <dt>Business Name</dt>
              <dd><strong>{user.reseller?.businessName || '—'}</strong></dd>

              <dt>Reseller Code</dt>
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

          <div className="card">
            <h2>Change Password</h2>
            <p className="muted small">
              Ensure your password is at least 10 characters long and contains uppercase, lowercase, and numeric characters.
            </p>

            {message && <div className="alert success">{message}</div>}
            {error && <div className="alert error">{error}</div>}

            <form onSubmit={handleChangePassword} style={{ marginTop: '1rem' }}>
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

              <button className="btn" type="submit" disabled={loading} style={{ marginTop: '0.5rem' }}>
                {loading ? 'Updating Password…' : 'Update Password'}
              </button>
            </form>
          </div>
        </main>
      )}
    </ResellerShell>
  )
}
