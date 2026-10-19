'use client'

import React, { Suspense, useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  Mail,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  Copy,
  Check,
  Code2,
} from 'lucide-react'
import { AuthLayout } from '@/components/auth/AuthLayout'
import { ApiError } from '@/lib/api'
import { verifyEmail, resendVerification, fetchDevOtp } from '@/lib/auth'

function VerifyEmailContent() {
  const searchParams = useSearchParams()
  const emailParam = searchParams.get('email') || ''
  // Set by the register page when the account was created but the SMS could not be sent.
  const codeNotSent = searchParams.get('sent') === '0'

  const [email, setEmail] = useState(emailParam)
  const [digits, setDigits] = useState(['', '', '', '', '', ''])
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  const [verifying, setVerifying] = useState(false)
  const [success, setSuccess] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Resend state & 60s cooldown timer
  const [resending, setResending] = useState(false)
  const [cooldown, setCooldown] = useState(codeNotSent ? 60 : 0)
  const [resendNotice, setResendNotice] = useState<{ message: string; tone: 'success' | 'error' } | null>(
    codeNotSent ? { message: 'Your account was created, but we could not send the verification SMS. Press "Resend OTP" when the timer ends.', tone: 'error' } : null,
  )

  // Development-only OTP panel state
  const [devOtp, setDevOtp] = useState<string | null>(null)
  const [isDevDebug, setIsDevDebug] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => {
      setCooldown((c) => Math.max(0, c - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  // Focus first digit on load
  useEffect(() => {
    if (inputRefs.current[0]) {
      inputRefs.current[0].focus()
    }
  }, [])

  // Fetch development OTP if in development mode
  const loadDevOtp = async (targetEmail: string) => {
    if (process.env.NODE_ENV === 'production') return
    if (!targetEmail.trim() || !targetEmail.includes('@')) return

    try {
      const res = await fetchDevOtp(targetEmail.trim().toLowerCase())
      setIsDevDebug(res.debugMode)
      setDevOtp(res.otp)
    } catch {
      setIsDevDebug(false)
      setDevOtp(null)
    }
  }

  useEffect(() => {
    if (email) {
      loadDevOtp(email)
    }
  }, [email])

  const handleCopyDevOtp = () => {
    if (!devOtp) return
    navigator.clipboard.writeText(devOtp)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDigitChange = (index: number, value: string) => {
    // Only accept numeric digits
    const cleaned = value.replace(/\D/g, '')

    if (!cleaned) {
      const next = [...digits]
      next[index] = ''
      setDigits(next)
      return
    }

    // Set the entered single digit
    const next = [...digits]
    next[index] = cleaned[cleaned.length - 1]
    setDigits(next)
    setErrorMessage(null)

    // Automatically focus the next input box
    if (index < 5 && inputRefs.current[index + 1]) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (digits[index]) {
        // Clear current digit
        const next = [...digits]
        next[index] = ''
        setDigits(next)
      } else if (index > 0) {
        // Focus previous input and clear it
        inputRefs.current[index - 1]?.focus()
        const next = [...digits]
        next[index - 1] = ''
        setDigits(next)
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault()
      inputRefs.current[index - 1]?.focus()
    } else if (e.key === 'ArrowRight' && index < 5) {
      e.preventDefault()
      inputRefs.current[index + 1]?.focus()
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (!pasted) return

    const next = [...digits]
    for (let i = 0; i < 6; i++) {
      next[i] = pasted[i] || ''
    }
    setDigits(next)
    setErrorMessage(null)

    // Focus last filled digit or final box
    const targetIdx = Math.min(pasted.length, 5)
    inputRefs.current[targetIdx]?.focus()
  }

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    const otp = digits.join('')
    if (otp.length !== 6) {
      setErrorMessage('Please enter all 6 digits of the verification code.')
      return
    }

    const cleanEmail = email.trim().toLowerCase()
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setErrorMessage('Please provide a valid registered email address.')
      return
    }

    setVerifying(true)
    setErrorMessage(null)
    setResendNotice(null)

    try {
      await verifyEmail(cleanEmail, otp)
      setSuccess(true)
      setDevOtp(null)
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : 'Failed to verify code. Please check and try again.'
      )
    } finally {
      setVerifying(false)
    }
  }

  const handleResend = async () => {
    if (cooldown > 0 || resending) return
    const targetEmail = email.trim().toLowerCase()
    if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      setErrorMessage('Please enter a valid email address to receive the verification code.')
      return
    }

    setResending(true)
    setResendNotice(null)
    setErrorMessage(null)

    try {
      const msg = await resendVerification(targetEmail)
      setResendNotice({ message: msg, tone: 'success' })
      setCooldown(60)
      setDigits(['', '', '', '', '', ''])
      inputRefs.current[0]?.focus()
      // Refresh development OTP in debug mode
      await loadDevOtp(targetEmail)
    } catch (err) {
      setResendNotice({
        message: err instanceof ApiError ? err.message : 'Could not resend verification code. Please try again.',
        tone: 'error',
      })
    } finally {
      setResending(false)
    }
  }

  return (
    <AuthLayout ariaLabel="Email Verification">

      {success ? (
        /* ─── Success Confirmation State ───────────────────────────────── */
        <div style={{ animation: 'fade-up 0.3s ease both' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'rgba(34, 197, 94, 0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#16a34a',
              marginBottom: '1.25rem',
            }}
          >
            <CheckCircle2 size={32} />
          </div>

          <h1 className="login-form-heading">Account Verified!</h1>
          <p className="login-form-subtitle" style={{ marginBottom: '1.5rem' }}>
            Your account has been successfully verified. You can now sign in to your Hexalyte account and access the Central Partner Platform.
          </p>

          <Link
            href="/login"
            className="login-submit"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textDecoration: 'none',
              gap: '0.5rem',
              width: '100%',
            }}
          >
            <span>Continue to Login</span>
            <ArrowRight size={18} />
          </Link>
        </div>
      ) : (
        /* ─── 6-Digit OTP Verification Form ────────────────────────────── */
        <div style={{ animation: 'fade-up 0.3s ease both' }}>
          {/* Desktop Header Badge */}
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: 'var(--theme-accent-soft, rgba(2, 132, 199, 0.12))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--theme-accent, #0284c7)',
              marginBottom: '1.25rem',
            }}
          >
            <ShieldCheck size={28} />
          </div>

          <h1 className="login-form-heading">Verify Your Account</h1>
          <p className="login-form-subtitle" style={{ marginBottom: '1rem' }}>
            Enter the 6-digit verification code we sent by SMS to your mobile number.
          </p>

          {/* Prominently displayed user email pill */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              background: 'var(--theme-accent-faint, rgba(2, 132, 199, 0.08))',
              border: '1px solid var(--theme-accent-line, rgba(2, 132, 199, 0.22))',
              borderRadius: '8px',
              padding: '0.45rem 0.85rem',
              fontSize: '0.88rem',
              fontWeight: 600,
              color: 'var(--theme-text-heading, #0f172a)',
              marginBottom: '1.25rem',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <Mail size={16} style={{ color: 'var(--theme-accent, #0284c7)', flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{email || 'your email'}</span>
          </div>

          {/* Development-Only Test OTP Panel */}
          {process.env.NODE_ENV !== 'production' && isDevDebug && devOtp && (
            <div
              style={{
                background: 'rgba(245, 158, 11, 0.12)',
                border: '1px dashed #d97706',
                borderRadius: '10px',
                padding: '0.75rem 0.85rem',
                marginBottom: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                width: '100%',
                boxSizing: 'border-box',
                overflow: 'hidden',
              }}
              role="region"
              aria-label="Development OTP Panel"
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    color: '#d97706',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  <Code2 size={14} />
                  <span>Development Mode — Your test OTP</span>
                </div>
                <button
                  type="button"
                  onClick={handleCopyDevOtp}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    background: copied ? '#16a34a' : 'rgba(217, 119, 6, 0.18)',
                    border: 'none',
                    color: copied ? '#ffffff' : '#b45309',
                    borderRadius: '6px',
                    padding: '0.2rem 0.5rem',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  title="Copy OTP to clipboard"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copied ? 'Copied!' : 'Copy OTP'}</span>
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    fontSize: '1.45rem',
                    fontWeight: 800,
                    letterSpacing: '0.15em',
                    color: 'var(--theme-text-heading, #0f172a)',
                  }}
                >
                  {devOtp}
                </div>
                <span style={{ fontSize: '0.74rem', color: '#92400e' }}>
                  Enter below to verify
                </span>
              </div>
            </div>
          )}

          {/* Error notice */}
          {errorMessage && (
            <div className="login-notice error" role="alert" style={{ marginBottom: '1.25rem' }}>
              <div className="login-notice-icon">
                <AlertCircle size={18} />
              </div>
              <div className="login-notice-content">{errorMessage}</div>
            </div>
          )}

          {/* Resend notice */}
          {resendNotice && (
            <div
              className={`login-notice ${resendNotice.tone === 'success' ? 'info' : 'error'}`}
              role="alert"
              style={{ marginBottom: '1.25rem' }}
            >
              <div className="login-notice-icon">
                {resendNotice.tone === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
              </div>
              <div className="login-notice-content">{resendNotice.message}</div>
            </div>
          )}

          <form onSubmit={handleVerify} style={{ width: '100%' }}>
            {/* Email Address Field (editable fallback if opened directly without query param) */}
            {!emailParam && (
              <div className="login-field" style={{ marginBottom: '1.25rem' }}>
                <label className="login-field-label" htmlFor="otp-email-input">
                  Registered Email Address
                </label>
                <div className="login-field-input-wrap">
                  <span className="login-field-icon">
                    <Mail size={18} />
                  </span>
                  <input
                    id="otp-email-input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@business.com"
                    className="login-field-input"
                    disabled={verifying}
                    required
                  />
                </div>
              </div>
            )}

            {/* 6-Digit OTP Box Grid */}
            <div className="login-field" style={{ marginBottom: '1.5rem', width: '100%' }}>
              <label className="login-field-label">Verification Code (6 Digits)</label>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                  gap: '0.4rem',
                  marginTop: '0.35rem',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              >
                {digits.map((digit, idx) => (
                  <input
                    key={idx}
                    ref={(el) => {
                      inputRefs.current[idx] = el
                    }}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleDigitChange(idx, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(idx, e)}
                    onPaste={handlePaste}
                    disabled={verifying}
                    style={{
                      width: '100%',
                      minWidth: 0,
                      height: '48px',
                      boxSizing: 'border-box',
                      padding: 0,
                      textAlign: 'center',
                      fontSize: '1.3rem',
                      fontWeight: 700,
                      borderRadius: '8px',
                      border: digit
                        ? '2px solid var(--theme-accent, #0284c7)'
                        : '1px solid var(--theme-card-border, #cbd5e1)',
                      background: 'var(--theme-input-bg, #ffffff)',
                      color: 'var(--theme-text-heading, #0f172a)',
                      outline: 'none',
                      transition: 'all 0.15s ease',
                      boxShadow: digit ? '0 0 0 2px var(--theme-accent-glow, rgba(2, 132, 199, 0.15))' : 'none',
                    }}
                    aria-label={`Digit ${idx + 1}`}
                  />
                ))}
              </div>
              <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: 'var(--theme-text-subtitle)' }}>
                Enter each digit, or paste the entire 6-digit code.
              </p>
            </div>

            {/* Verify Email Button */}
            <button
              type="submit"
              disabled={verifying || digits.join('').length !== 6}
              className="login-submit"
              style={{ width: '100%', marginBottom: '1rem' }}
            >
              {verifying ? (
                <>
                  <span className="login-spinner" aria-hidden="true" />
                  <span>Verifying Code...</span>
                </>
              ) : (
                <>
                  <span>Verify</span>
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>

          {/* Resend OTP Section */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.85rem 0',
              borderTop: '1px solid var(--theme-card-border, #e2e8f0)',
              fontSize: '0.86rem',
            }}
          >
            <span style={{ color: 'var(--theme-text-subtitle)' }}>Didn't receive the code?</span>
            <button
              type="button"
              onClick={handleResend}
              disabled={cooldown > 0 || resending}
              style={{
                background: 'none',
                border: 'none',
                color: cooldown > 0 ? 'var(--theme-text-subtitle)' : 'var(--theme-accent, #0284c7)',
                fontWeight: 600,
                cursor: cooldown > 0 ? 'not-allowed' : 'pointer',
                fontSize: '0.86rem',
                padding: 0,
              }}
            >
              {resending
                ? 'Sending...'
                : cooldown > 0
                ? `Resend OTP (${cooldown}s)`
                : 'Resend OTP'}
            </button>
          </div>

          {/* Back to Login Link */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              paddingTop: '0.75rem',
              borderTop: '1px solid var(--theme-card-border, #e2e8f0)',
            }}
          >
            <Link
              href="/login"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                color: 'var(--theme-text-subtitle, #64748b)',
                textDecoration: 'none',
                fontSize: '0.875rem',
                fontWeight: 500,
                transition: 'color 0.15s ease',
              }}
            >
              <ArrowLeft size={16} />
              <span>Back to Login</span>
            </Link>
          </div>
        </div>
      )}
    </AuthLayout>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="login-loading-screen" />}>
      <VerifyEmailContent />
    </Suspense>
  )
}
