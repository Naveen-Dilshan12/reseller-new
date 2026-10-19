'use client'

import React, { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Eye,
  EyeOff,
  Mail,
  Lock,
  ArrowRight,
  AlertCircle,
  Info
} from 'lucide-react'
import { AuthLayout } from '@/components/auth/AuthLayout'
import { ApiError } from '@/lib/api'
import { isPlatformUser, login } from '@/lib/auth'

type Notice = {
  tone: 'error' | 'info' | 'warning'
  title?: string
  message: string
}

function noticeFor(err: unknown): Notice {
  if (!(err instanceof ApiError)) {
    return { tone: 'error', message: 'Could not reach the server. Please try again.' }
  }
  switch (err.code) {
    case 'EMAIL_NOT_VERIFIED':
      return {
        tone: 'warning',
        title: 'Verification Required',
        message: err.message || 'Please verify your email address to log in. Check your inbox for the verification link.',
      }
    case 'APPLICATION_PENDING':
      return {
        tone: 'info',
        title: 'Application Pending Approval',
        message: err.message || 'Your partner application is currently pending review. Access will be granted once approved.'
      }
    case 'APPLICATION_REJECTED':
      return {
        tone: 'warning',
        title: 'Application Rejected',
        message: err.message || 'Your partner application was rejected. Please contact Hexalyte support.'
      }
    case 'ACCOUNT_INACTIVE':
      return {
        tone: 'error',
        title: 'Account Inactive',
        message: err.message || 'Your account is inactive. Please contact Hexalyte support.'
      }
    case 'RESELLER_SUSPENDED':
      return {
        tone: 'error',
        title: 'Account Suspended',
        message: err.message || 'Your partner account is suspended. Please contact Hexalyte support.'
      }
    case 'ACCOUNT_LOCKED':
      return {
        tone: 'error',
        title: 'Account Locked',
        message: err.message || 'Too many failed attempts. Please try again later.'
      }
    case 'INVALID_CREDENTIALS':
      return {
        tone: 'error',
        message: 'Invalid email address or password. Please verify your credentials.'
      }
    default:
      return { tone: 'error', message: err.message || 'An unexpected error occurred.' }
  }
}

export default function LoginPage() {
  const router = useRouter()
  const [, startTransition] = useTransition()

  // Unified Form state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  // Validation & feedback
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(false)

  const validateForm = () => {
    const errs: { email?: string; password?: string } = {}
    const trimmedEmail = email.trim()

    if (!trimmedEmail) {
      errs.email = 'Email address is required.'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errs.email = 'Please enter a valid email address.'
    }

    if (!password) {
      errs.password = 'Password is required.'
    }

    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  // Handle submit with real authentication API
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setNotice(null)

    if (!validateForm()) return

    setLoading(true)
    try {
      // Backend validates credentials and account status (assertCanLogin)
      // Throws 403 on APPLICATION_PENDING, APPLICATION_REJECTED, RESELLER_SUSPENDED, ACCOUNT_INACTIVE
      // Throws 423 on ACCOUNT_LOCKED, 401 on invalid credentials
      const user = await login(email.trim(), password, rememberMe)

      // Strict role-based navigation based on authenticated backend response only
      startTransition(() => {
        if (isPlatformUser(user)) {
          router.replace('/admin')
        } else {
          router.replace('/dashboard')
        }
      })
    } catch (err) {
      setNotice(noticeFor(err))
      setLoading(false)
    }
  }



  return (
    <AuthLayout ariaLabel="Sign In Form">

      <h1 className="login-form-heading">Welcome Back</h1>
      <p className="login-form-subtitle">Login to your account to continue.</p>

      {/* Error / Warning / Info Notice */}
      {notice && (
        <div className={`login-notice ${notice.tone}`} role="alert">
          <div className="login-notice-icon">
            {notice.tone === 'error' && <AlertCircle size={18} />}
            {notice.tone === 'warning' && <AlertCircle size={18} />}
            {notice.tone === 'info' && <Info size={18} />}
          </div>
          <div className="login-notice-content">
            {notice.title && <strong>{notice.title}</strong>}
            {notice.message}
          </div>
        </div>
      )}

      {/* Unified Login Form */}
      <form onSubmit={handleSubmit} noValidate>
        {/* Email Address */}
        <div className="login-field">
          <label htmlFor="login-email" className="login-field-label">
            Email Address
          </label>
          <div className="login-field-input-wrap">
            <span className="login-field-icon">
              <Mail size={18} />
            </span>
            <input
              id="login-email"
              type="email"
              name="email"
              autoComplete="email"
              placeholder="name@business.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }))
              }}
              className={`login-field-input ${errors.email ? 'has-error' : ''}`}
              disabled={loading}
              required
            />
          </div>
          {errors.email && <div className="login-field-error">{errors.email}</div>}
        </div>

        {/* Password */}
        <div className="login-field">
          <label htmlFor="login-password" className="login-field-label">
            Password
          </label>
          <div className="login-field-input-wrap">
            <span className="login-field-icon">
              <Lock size={18} />
            </span>
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }))
              }}
              className={`login-field-input ${errors.password ? 'has-error' : ''}`}
              disabled={loading}
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
          {errors.password && <div className="login-field-error">{errors.password}</div>}
        </div>

        {/* Actions: Remember Me & Forgot Password */}
        <div className="login-actions-row">
          <label className="login-remember" title="Stay signed in after you close the browser">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              disabled={loading}
              aria-describedby="remember-help"
            />
            <span>Remember Me</span>
          </label>
          <span className="visually-hidden" id="remember-help">
            When unchecked, you are signed out when you close this tab.
          </span>

          {/* Forgot password link */}
          <Link href="/forgot-password" className="login-forgot">
            Forgot Password?
          </Link>
        </div>

        {/* Static Single Login Button */}
        <button
          type="submit"
          className="login-submit"
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="login-spinner" aria-hidden="true" />
              <span>Signing in...</span>
            </>
          ) : (
            <>
              <span>Login</span>
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>

      {/* Registration Section */}
      <div className="login-divider">or</div>

      <div className="login-register-cta">
        <p>New to Hexalyte?</p>
        <div className="login-register-desc">
          Register as a Partner and start growing with us.
        </div>
        <Link href="/register" className="login-register-btn">
          <span>Create Partner Account</span>
          <ArrowRight size={16} />
        </Link>
      </div>
    </AuthLayout>
  )
}
