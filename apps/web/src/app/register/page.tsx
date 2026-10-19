'use client'

import React, { useState } from 'react'
import { AuthLayout } from '@/components/auth/AuthLayout'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Eye,
  EyeOff,
  Mail,
  Phone,
  Lock,
  User,
  ArrowRight,
  AlertCircle,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'

export default function RegisterPage() {
  const router = useRouter()

  // Form state
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  // Registration success state (Check your email screen)

  // Validation & feedback state
  const [errors, setErrors] = useState<{
    name?: string
    email?: string
    phone?: string
    password?: string
    confirmPassword?: string
    acceptTerms?: string
  }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const validate = () => {
    const nextErrors: typeof errors = {}
    const trimmedName = name.trim()
    const trimmedEmail = email.trim()

    if (!trimmedName || trimmedName.length < 2) {
      nextErrors.name = 'Full name is required (at least 2 characters).'
    }

    if (!trimmedEmail) {
      nextErrors.email = 'Email address is required.'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      nextErrors.email = 'Please enter a valid email address.'
    }

    const phoneDigits = phone.replace(/[\s\-().]/g, '')
    if (!phoneDigits) {
      nextErrors.phone = 'Mobile number is required.'
    } else if (!/^(\+94|0094|0)?7\d{8}$/.test(phoneDigits)) {
      nextErrors.phone = 'Enter a valid Sri Lankan mobile number, e.g. 0771234567.'
    }

    if (!password) {
      nextErrors.password = 'Password is required.'
    } else if (password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      nextErrors.password = 'Password must be at least 10 characters with uppercase, lowercase and a number.'
    }

    if (!confirmPassword) {
      nextErrors.confirmPassword = 'Confirm password is required.'
    } else if (password !== confirmPassword) {
      nextErrors.confirmPassword = 'Passwords do not match.'
    }

    if (!acceptTerms) {
      nextErrors.acceptTerms = 'You must accept the terms and conditions to create an account.'
    }

    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)

    if (!validate()) return

    setSubmitting(true)
    try {
      const response = await api<{
        message?: string
        email?: string
        codeSent?: boolean
      }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          password,
          confirmPassword,
          acceptTerms,
        }),
      })

      // Account created and an SMS code sent; redirect to the OTP entry page
      const targetEmail = response.email || email.trim().toLowerCase()
      // The account exists either way; when the SMS could not be sent, the verification page explains and offers a resend.
      const unsent = response.codeSent === false ? '&sent=0' : ''
      router.push(`/verify-email?email=${encodeURIComponent(targetEmail)}${unsent}`)
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message || 'Registration failed. Please check the information provided.')
      } else {
        setFormError('Could not reach the server. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout ariaLabel="Register Account">

          <h1 className="login-form-heading">Create Account</h1>
          <p className="login-form-subtitle">Register to start your journey as a partner partner.</p>

      {/* Error Notice */}
      {formError && (
        <div className="login-notice error" role="alert">
          <div className="login-notice-icon">
            <AlertCircle size={18} />
          </div>
          <div className="login-notice-content">
            <strong>Registration Incomplete</strong>
            {formError}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        {/* Full Name */}
        <div className="login-field">
          <label htmlFor="register-name" className="login-field-label">
            Full Name
          </label>
          <div className="login-field-input-wrap">
            <span className="login-field-icon">
              <User size={18} />
            </span>
            <input
              id="register-name"
              type="text"
              name="name"
              autoComplete="name"
              placeholder="e.g. Ruwan Jayawardena"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }))
              }}
              className={`login-field-input ${errors.name ? 'has-error' : ''}`}
              disabled={submitting}
              required
            />
          </div>
          {errors.name && <div className="login-field-error">{errors.name}</div>}
        </div>

        {/* Email Address */}
        <div className="login-field">
          <label htmlFor="register-email" className="login-field-label">
            Email Address
          </label>
          <div className="login-field-input-wrap">
            <span className="login-field-icon">
              <Mail size={18} />
            </span>
            <input
              id="register-email"
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
              disabled={submitting}
              required
            />
          </div>
          {errors.email && <div className="login-field-error">{errors.email}</div>}
        </div>

        {/* Mobile number: receives the SMS verification code */}
        <div className="login-field">
          <label htmlFor="register-phone" className="login-field-label">
            Mobile Number
          </label>
          <div className="login-field-input-wrap">
            <span className="login-field-icon">
              <Phone size={18} />
            </span>
            <input
              id="register-phone"
              type="tel"
              name="phone"
              autoComplete="tel"
              inputMode="tel"
              placeholder="0771234567"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value)
                if (errors.phone) setErrors((prev) => ({ ...prev, phone: undefined }))
              }}
              className={`login-field-input ${errors.phone ? 'has-error' : ''}`}
              disabled={submitting}
              required
            />
          </div>
          {errors.phone ? (
            <div className="login-field-error">{errors.phone}</div>
          ) : (
            <div className="login-field-hint" style={{ fontSize: '0.78rem', opacity: 0.75, marginTop: '0.3rem' }}>
              We will text a 6-digit verification code to this number.
            </div>
          )}
        </div>

        {/* Password */}
        <div className="login-field">
          <label htmlFor="register-password" className="login-field-label">
            Password
          </label>
          <div className="login-field-input-wrap">
            <span className="login-field-icon">
              <Lock size={18} />
            </span>
            <input
              id="register-password"
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="new-password"
              placeholder="At least 10 characters"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }))
              }}
              className={`login-field-input ${errors.password ? 'has-error' : ''}`}
              disabled={submitting}
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

        {/* Confirm Password */}
        <div className="login-field">
          <label htmlFor="register-confirm-password" className="login-field-label">
            Confirm Password
          </label>
          <div className="login-field-input-wrap">
            <span className="login-field-icon">
              <Lock size={18} />
            </span>
            <input
              id="register-confirm-password"
              type={showConfirmPassword ? 'text' : 'password'}
              name="confirmPassword"
              autoComplete="new-password"
              placeholder="Re-enter your password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value)
                if (errors.confirmPassword) setErrors((prev) => ({ ...prev, confirmPassword: undefined }))
              }}
              className={`login-field-input ${errors.confirmPassword ? 'has-error' : ''}`}
              disabled={submitting}
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

        {/* Terms and Conditions Checkbox */}
        <div style={{ marginBottom: '1.5rem' }}>
          <label className="register-terms-label" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={acceptTerms}
              onChange={(e) => {
                setAcceptTerms(e.target.checked)
                if (errors.acceptTerms) setErrors((prev) => ({ ...prev, acceptTerms: undefined }))
              }}
              disabled={submitting}
            />
            <span>
              I accept the{' '}
              <a href="#" onClick={(e) => e.preventDefault()}>
                Hexalyte Innovation Terms and Conditions
              </a>{' '}
              and Privacy Policy.
            </span>
          </label>
          {errors.acceptTerms && (
            <div className="login-field-error" style={{ marginTop: '0.4rem' }}>
              {errors.acceptTerms}
            </div>
          )}
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          className="login-submit"
          disabled={submitting}
        >
          {submitting ? (
            <>
              <span className="login-spinner" aria-hidden="true" />
              <span>Creating Account...</span>
            </>
          ) : (
            <>
              <span>Create Account</span>
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>

      {/* Divider */}
      <div className="login-divider">Already have an account?</div>

          <div className="login-register-cta">
            <Link href="/login" className="login-register-btn">
              <span>Sign In to Existing Account</span>
              <ArrowRight size={16} />
            </Link>
          </div>
    </AuthLayout>
  )
}
