'use client'

import React, { useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  Lock,
  Eye,
  EyeOff,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  CheckCircle2
} from 'lucide-react'
import { AuthLayout } from '@/components/auth/AuthLayout'
import { ApiError } from '@/lib/api'
import { completePasswordReset } from '@/lib/auth'

function ResetPasswordContent() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token') || ''

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const [errors, setErrors] = useState<{ newPassword?: string; confirmPassword?: string }>({})
  const [loading, setLoading] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success'; message: string } | null>(null)

  const validate = () => {
    const errs: { newPassword?: string; confirmPassword?: string } = {}

    if (!newPassword) {
      errs.newPassword = 'New password is required.'
    } else if (newPassword.length < 10) {
      errs.newPassword = 'Password must be at least 10 characters.'
    } else if (!/[a-z]/.test(newPassword)) {
      errs.newPassword = 'Password must contain at least one lowercase letter.'
    } else if (!/[A-Z]/.test(newPassword)) {
      errs.newPassword = 'Password must contain at least one uppercase letter.'
    } else if (!/\d/.test(newPassword)) {
      errs.newPassword = 'Password must contain at least one number.'
    }

    if (!confirmPassword) {
      errs.confirmPassword = 'Confirm your password.'
    } else if (newPassword && newPassword !== confirmPassword) {
      errs.confirmPassword = 'Passwords do not match.'
    }

    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFeedback(null)

    if (!token) {
      setFeedback({
        tone: 'error',
        message: 'Password reset token is missing. Please click the full link in your email or request a new one.'
      })
      return
    }

    if (!validate()) return

    setLoading(true)
    try {
      const msg = await completePasswordReset(token, newPassword)
      setIsSuccess(true)
      setFeedback({
        tone: 'success',
        message: msg || 'Your password has been successfully reset. You can now log in.'
      })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not reset password. The link may have expired or is invalid.'
      setFeedback({ tone: 'error', message: msg })
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout ariaLabel="Reset Password Form">

      <h1 className="login-form-heading">Set New Password</h1>
      <p className="login-form-subtitle">
        Create a strong, secure password for your account.
      </p>

      {/* Feedback Alerts */}
      {feedback && (
        <div className={`login-notice ${feedback.tone}`} role="alert">
          <div className="login-notice-icon">
            {feedback.tone === 'error' && <AlertCircle size={18} />}
            {feedback.tone === 'success' && <CheckCircle2 size={18} />}
          </div>
          <div className="login-notice-content">
            {feedback.message}
          </div>
        </div>
      )}

      {!token && !isSuccess && (
        <div className="login-notice error" role="alert">
          <div className="login-notice-icon">
            <AlertCircle size={18} />
          </div>
          <div className="login-notice-content">
            Missing password reset token in the URL. Please ensure you clicked the complete link in your email.
          </div>
        </div>
      )}

      {!isSuccess ? (
        <form onSubmit={handleSubmit} noValidate>
          {/* New Password */}
          <div className="login-field">
            <label htmlFor="reset-new-password" className="login-field-label">
              New Password
            </label>
            <div className="login-field-input-wrap">
              <span className="login-field-icon">
                <Lock size={18} />
              </span>
              <input
                id="reset-new-password"
                type={showPassword ? 'text' : 'password'}
                name="newPassword"
                autoComplete="new-password"
                placeholder="Enter new password (10+ characters)"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value)
                  if (errors.newPassword) setErrors((prev) => ({ ...prev, newPassword: undefined }))
                }}
                className={`login-field-input ${errors.newPassword ? 'has-error' : ''}`}
                disabled={loading || !token}
                required
              />
              <button
                type="button"
                className="login-pw-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {errors.newPassword && <div className="login-field-error">{errors.newPassword}</div>}
          </div>

          {/* Confirm Password */}
          <div className="login-field" style={{ marginTop: '1rem' }}>
            <label htmlFor="reset-confirm-password" className="login-field-label">
              Confirm Password
            </label>
            <div className="login-field-input-wrap">
              <span className="login-field-icon">
                <Lock size={18} />
              </span>
              <input
                id="reset-confirm-password"
                type={showConfirmPassword ? 'text' : 'password'}
                name="confirmPassword"
                autoComplete="new-password"
                placeholder="Confirm your new password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value)
                  if (errors.confirmPassword) setErrors((prev) => ({ ...prev, confirmPassword: undefined }))
                }}
                className={`login-field-input ${errors.confirmPassword ? 'has-error' : ''}`}
                disabled={loading || !token}
                required
              />
              <button
                type="button"
                className="login-pw-toggle"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showConfirmPassword}
              >
                {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {errors.confirmPassword && <div className="login-field-error">{errors.confirmPassword}</div>}
          </div>

          <div style={{ fontSize: '0.78rem', color: 'var(--theme-text-subtitle)', marginTop: '0.5rem', lineHeight: '1.4' }}>
            Requirements: Minimum 10 characters, at least 1 uppercase letter, 1 lowercase letter, and 1 number.
          </div>

          <button
            type="submit"
            className="login-submit"
            disabled={loading || !token}
            style={{ marginTop: '1.5rem' }}
          >
            {loading ? (
              <>
                <span className="login-spinner" aria-hidden="true" />
                <span>Updating password...</span>
              </>
            ) : (
              <>
                <span>Reset Password</span>
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>
      ) : (
        <div style={{ textAlign: 'center', padding: '1rem 0' }}>
          <Link
            href="/login"
            className="login-register-btn"
            style={{ width: '100%', justifyContent: 'center', textDecoration: 'none' }}
          >
            <span>Proceed to Login</span>
            <ArrowRight size={16} />
          </Link>
        </div>
      )}

      <div className="login-divider">or</div>

      <div style={{ textAlign: 'center' }}>
        <Link
          href="/login"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            color: 'var(--theme-link)',
            fontSize: '0.9rem',
            fontWeight: 600,
            textDecoration: 'none'
          }}
        >
          <ArrowLeft size={16} />
          <span>Back to Login</span>
        </Link>
      </div>
    </AuthLayout>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>}>
      <ResetPasswordContent />
    </Suspense>
  )
}
