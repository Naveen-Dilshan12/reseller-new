'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import {
  Mail,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  Info
} from 'lucide-react'
import { AuthLayout } from '@/components/auth/AuthLayout'
import { ApiError } from '@/lib/api'
import { requestPasswordReset } from '@/lib/auth'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success' | 'info'; message: string } | null>(null)

  const validate = () => {
    const trimmed = email.trim()
    if (!trimmed) {
      setEmailError('Email address is required.')
      return false
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError('Please enter a valid email address.')
      return false
    }
    setEmailError(null)
    return true
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFeedback(null)

    if (!validate()) return

    setLoading(true)
    try {
      const msg = await requestPasswordReset(email.trim())
      setSubmitted(true)
      setFeedback({
        tone: 'success',
        message: msg || 'If an account exists with that email address, password reset instructions have been sent.'
      })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not reach the server. Please try again.'
      setFeedback({ tone: 'error', message: msg })
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout ariaLabel="Forgot Password Form">

      <h1 className="login-form-heading">Forgot Password</h1>
      <p className="login-form-subtitle">
        Enter your account email address and we will send you secure instructions to reset your password.
      </p>

      {/* Feedback Alerts */}
      {feedback && (
        <div className={`login-notice ${feedback.tone}`} role="alert">
          <div className="login-notice-icon">
            {feedback.tone === 'error' && <AlertCircle size={18} />}
            {feedback.tone === 'success' && <CheckCircle2 size={18} />}
            {feedback.tone === 'info' && <Info size={18} />}
          </div>
          <div className="login-notice-content">
            {feedback.message}
          </div>
        </div>
      )}

      {!submitted ? (
        <form onSubmit={handleSubmit} noValidate>
          <div className="login-field">
            <label htmlFor="forgot-email" className="login-field-label">
              Email Address
            </label>
            <div className="login-field-input-wrap">
              <span className="login-field-icon">
                <Mail size={18} />
              </span>
              <input
                id="forgot-email"
                type="email"
                name="email"
                autoComplete="email"
                placeholder="name@business.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  if (emailError) setEmailError(null)
                }}
                className={`login-field-input ${emailError ? 'has-error' : ''}`}
                disabled={loading}
                required
              />
            </div>
            {emailError && <div className="login-field-error">{emailError}</div>}
          </div>

          <button
            type="submit"
            className="login-submit"
            disabled={loading}
            style={{ marginTop: '1.25rem' }}
          >
            {loading ? (
              <>
                <span className="login-spinner" aria-hidden="true" />
                <span>Sending instructions...</span>
              </>
            ) : (
              <>
                <span>Send Reset Instructions</span>
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>
      ) : (
        <div style={{ textAlign: 'center', padding: '1rem 0' }}>
          <p style={{ fontSize: '0.9rem', color: 'var(--theme-text-subtitle)', marginBottom: '1.5rem', lineHeight: '1.5' }}>
            Please check your inbox (and spam folder) for the password reset email. The link will remain active for 30 minutes.
          </p>
          <button
            type="button"
            className="login-register-btn"
            onClick={() => {
              setSubmitted(false)
              setEmail('')
              setFeedback(null)
            }}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            Send to another email
          </button>
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
