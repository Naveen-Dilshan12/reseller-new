'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ResellerShell } from '@/components/ResellerShell'
import { api, ApiError } from '@/lib/api'
import { refreshCurrentUser, type CurrentUser } from '@/lib/auth'
import { Modal } from '@/components/ui/Modal'
import {
  User,
  CreditCard,
  Mail,
  Phone,
  Home,
  Building,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  ShieldCheck,
  Clock,
  Sparkles,
  Lock,
} from 'lucide-react'

const SRI_LANKA_BANKS = [
  'Commercial Bank of Ceylon',
  'Sampath Bank',
  'Hatton National Bank (HNB)',
  'Bank of Ceylon (BOC)',
  "People's Bank",
  'Nations Trust Bank (NTB)',
  'Seylan Bank',
  'DFCC Bank',
  'Union Bank of Colombo',
  'National Development Bank (NDB)',
  'Pan Asia Banking Corporation',
  'Amana Bank',
]

interface FormValues {
  // Step 1: Personal
  fullName: string
  nicOrPassport: string
  email: string
  mobile: string
  address: string

  // Step 2: Business
  businessName: string
  businessRegistrationNo: string
  businessAddress: string
  businessPhone: string
  businessEmail: string

  // Step 3: Bank
  bankName: string
  branch: string
  accountHolderName: string
  accountNumber: string

  // Step 4: Setup / Terms
  acceptTerms: boolean
}

const initialValues: FormValues = {
  fullName: '',
  nicOrPassport: '',
  email: '',
  mobile: '',
  address: '',
  businessName: '',
  businessRegistrationNo: '',
  businessAddress: '',
  businessPhone: '',
  businessEmail: '',
  bankName: 'Commercial Bank of Ceylon',
  branch: '',
  accountHolderName: '',
  accountNumber: '',
  acceptTerms: false,
}

const strip = (v: string) => v.replace(/[\s-]/g, '')

function BecomeResellerContent({ user }: { user: CurrentUser }) {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [values, setValues] = useState<FormValues>(() => ({
    ...initialValues,
    fullName: user.name || '',
    email: user.email || '',
    accountHolderName: user.name || '',
  }))

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submittedCode, setSubmittedCode] = useState<string | null>(null)

  // Prefill if not already filled
  useEffect(() => {
    if (user) {
      setValues((prev) => ({
        ...prev,
        fullName: prev.fullName || user.name || '',
        email: prev.email || user.email || '',
        accountHolderName: prev.accountHolderName || user.name || '',
      }))
    }
  }, [user])

  // Success popup upon submission; the status then stays "Pending Admin Review" on every page
  if (submittedCode) {
    const goToDashboard = () => router.push('/dashboard')
    return (
      <Modal label="Application submitted" onClose={goToDashboard}>
        <div className="apply-popup">
          <span className="apply-popup-icon approved">
            <CheckCircle2 size={34} />
          </span>
          <span className="apply-popup-kicker">Application submitted</span>
          <h2>Thank you, we&apos;ve got it!</h2>
          <p>
            Your application reference is{' '}
            <strong style={{ color: 'var(--primary-light)', fontFamily: 'monospace' }}>{submittedCode}</strong>. Hexalyte partner operations will
            review it.
          </p>
          <span className="badge PENDING">Pending Admin Review</span>
          <p className="small muted">
            There is nothing else you need to do. You&apos;ll be notified once an Admin approves it, and your partner features unlock
            automatically.
          </p>
          <div className="apply-popup-actions">
            <button type="button" className="btn" onClick={goToDashboard}>
              Go to Dashboard
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  // If user already has an active or pending application
  if (user.reseller) {
    return (
      <div style={{ margin: '1rem 0 2rem' }}>
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg, 12px)',
            padding: '2.5rem',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1.25rem',
            boxShadow: 'var(--shadow)',
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: user.reseller.status === 'ACTIVE' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
              color: user.reseller.status === 'ACTIVE' ? '#10B981' : '#F59E0B',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {user.reseller.status === 'ACTIVE' ? <CheckCircle2 size={32} /> : <Clock size={32} />}
          </div>
          <h2 style={{ fontSize: '1.45rem', fontWeight: 700, color: 'var(--text-heading)', margin: 0 }}>
            {user.reseller.status === 'ACTIVE'
              ? 'You Are Already an Active Partner'
              : 'Pending Admin Review'}
          </h2>
          <p style={{ color: 'var(--text-secondary)', margin: 0, maxWidth: '480px', lineHeight: '1.5' }}>
            {user.reseller.status === 'ACTIVE'
              ? `Your partner account (${user.reseller.code}) is approved and active. You have full access to SaaS products, demo requests, and customer activations.`
              : `Your application (${user.reseller.code}) is under review by Hexalyte Partner Operations. You will be notified once reviewed.`}
          </p>
          <Link
            href="/dashboard"
            className="btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.65rem 1.4rem',
              marginTop: '0.5rem',
            }}
          >
            <span>Back to Dashboard</span>
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    )

  }

  const handleChange = (field: keyof FormValues, val: any) => {
    setValues((prev) => ({ ...prev, [field]: val }))
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: '' }))
    }
  }

  // Step Validations
  const validateStep = (s: number): boolean => {
    const errs: Record<string, string> = {}

    if (s === 1) {
      if (!values.fullName.trim() || values.fullName.trim().length < 3) {
        errs.fullName = 'Full Name is required (minimum 3 characters)'
      }
      const nic = strip(values.nicOrPassport).toUpperCase()
      if (!/^(\d{9}[VX]|\d{12}|[A-Z][A-Z0-9]{5,11})$/.test(nic)) {
        errs.nicOrPassport = 'Enter a valid Sri Lankan NIC (9 digits + V/X or 12 digits) or Passport'
      }
      if (!values.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
        errs.email = 'Enter a valid email address'
      }
      const mobile = strip(values.mobile)
      if (!/^(\+94|0)7\d{8}$/.test(mobile)) {
        errs.mobile = 'Enter a valid Sri Lankan mobile number (e.g. 0771234567)'
      }
      if (!values.address.trim() || values.address.trim().length < 5) {
        errs.address = 'Residential or business address is required'
      }
    }

    if (s === 2) {
      if (!values.businessName.trim() || values.businessName.trim().length < 2) {
        errs.businessName = 'Business or trade name is required'
      }
      const brn = values.businessRegistrationNo.trim().toUpperCase()
      if (!/^[A-Z0-9][A-Z0-9 /-]{2,29}$/.test(brn)) {
        errs.businessRegistrationNo = 'Enter a valid Business Registration Number (BRN)'
      }
      if (!values.businessAddress.trim() || values.businessAddress.trim().length < 5) {
        errs.businessAddress = 'Business address is required'
      }
      const bPhone = strip(values.businessPhone)
      if (!/^(\+94|0)\d{9}$/.test(bPhone)) {
        errs.businessPhone = 'Enter a valid business phone number (e.g. 0112345678)'
      }
      if (!values.businessEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.businessEmail.trim())) {
        errs.businessEmail = 'Enter a valid business email address'
      }
    }

    if (s === 3) {
      if (!values.bankName.trim()) {
        errs.bankName = 'Select or enter your bank name'
      }
      if (!values.branch.trim() || values.branch.trim().length < 2) {
        errs.branch = 'Bank branch name is required'
      }
      if (!values.accountHolderName.trim() || values.accountHolderName.trim().length < 3) {
        errs.accountHolderName = 'Account holder name is required'
      }
      const acc = strip(values.accountNumber)
      if (!/^\d{6,20}$/.test(acc)) {
        errs.accountNumber = 'Enter a valid account number (6 to 20 digits)'
      }
    }

    if (s === 4) {
      if (!values.acceptTerms) {
        errs.acceptTerms = 'You must review and agree to the Hexalyte Partner Agreement to proceed'
      }
    }

    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleNext = () => {
    if (validateStep(step)) {
      setStep((curr) => Math.min(4, curr + 1))
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const handleBack = () => {
    setStep((curr) => Math.max(1, curr - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError(null)

    if (!validateStep(1) || !validateStep(2) || !validateStep(3) || !validateStep(4)) {
      setSubmitError('Please review all steps and resolve the highlighted errors.')
      return
    }

    setSubmitting(true)

    const payload = {
      personal: {
        fullName: values.fullName.trim(),
        nicOrPassport: strip(values.nicOrPassport).toUpperCase(),
        email: values.email.trim().toLowerCase(),
        mobile: strip(values.mobile),
        address: values.address.trim(),
      },
      business: {
        businessName: values.businessName.trim(),
        businessRegistrationNo: values.businessRegistrationNo.trim().toUpperCase(),
        businessAddress: values.businessAddress.trim(),
        businessPhone: strip(values.businessPhone),
        businessEmail: values.businessEmail.trim().toLowerCase(),
      },
      bank: {
        bankName: values.bankName.trim(),
        branch: values.branch.trim(),
        accountHolderName: values.accountHolderName.trim(),
        accountNumber: strip(values.accountNumber),
      },
      acceptTerms: true,
    }

    try {
      const res = await api<{ code: string; email: string }>('/reseller-registration', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setSubmittedCode(res.code)
      // Pick up the new application status (PENDING) right away
      void refreshCurrentUser()
    } catch (err: any) {
      if (err instanceof ApiError) {
        setSubmitError(err.message)
      } else {
        setSubmitError('Failed to submit application. Please check your network and try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Mask bank account helper
  const maskedAccount = () => {
    const raw = strip(values.accountNumber)
    if (raw.length <= 4) return raw
    return `•••• •••• ${raw.slice(-4)}`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
          <Sparkles size={18} style={{ color: 'var(--primary)' }} />
          <span style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--primary-light)' }}>
            Hexalyte Partner Network
          </span>
        </div>
        <h1 style={{ fontSize: '1.85rem', fontWeight: 800, color: 'var(--text-heading)', margin: 0, letterSpacing: '-0.02em' }}>
          Partner Onboarding
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.94rem', margin: '0.4rem 0 0' }}>
          Complete the 4-step partner application to unlock enterprise SaaS distribution and recurring commissions.
        </p>
      </div>

      {/* Step Progress Bar */}
      <div
        className="onboard-steps"
        style={{
          display: 'grid',
          gap: '0.5rem',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius, 8px)',
          padding: '0.75rem 1rem',
        }}
      >
        {[
          { num: 1, title: 'Personal Details' },
          { num: 2, title: 'Business Details' },
          { num: 3, title: 'Bank Details' },
          { num: 4, title: 'Review & Submit' },
        ].map((s) => {
          const isDone = step > s.num
          const isCurrent = step === s.num
          return (
            <div
              key={s.num}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                opacity: isDone || isCurrent ? 1 : 0.45,
              }}
            >
              <div
                style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '50%',
                  background: isDone
                    ? 'var(--success)'
                    : isCurrent
                    ? 'var(--primary)'
                    : 'var(--toggle-bg)',
                  color: isDone || isCurrent ? '#ffffff' : 'var(--muted)',
                  fontSize: '0.78rem',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {isDone ? '✓' : s.num}
              </div>
              <span
                style={{
                  fontSize: '0.82rem',
                  fontWeight: isCurrent ? 700 : 500,
                  color: isCurrent ? 'var(--text-heading)' : 'var(--muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {s.title}
              </span>
            </div>
          )
        })}
      </div>

      {/* Form Card */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg, 12px)',
          padding: '2rem',
          boxShadow: 'var(--shadow)',
        }}
      >
        {submitError && (
          <div
            style={{
              padding: '0.85rem 1rem',
              borderRadius: '8px',
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              color: '#F87171',
              fontSize: '0.88rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              marginBottom: '1.5rem',
            }}
          >
            <AlertCircle size={18} />
            <span>{submitError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* ─── STEP 1: Personal Details ─────────────────────────────────── */}
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ borderBottom: '1px solid var(--border, #1E293B)', paddingBottom: '0.75rem' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text, #F8FAFC)', margin: 0 }}>
                  Personal & Identity Details
                </h2>
                <p style={{ color: 'var(--text-secondary, #94A3B8)', fontSize: '0.86rem', margin: '0.25rem 0 0' }}>
                  Please provide your personal contact information as the authorized applicant.
                </p>
              </div>

              <div className="form-grid-2" style={{ gap: '1.25rem 1.5rem' }}>
              {/* Full Name */}
              <div className={`field ${errors.fullName ? 'has-error' : ''}`}>
                <label>Full Name</label>
                <input
                  type="text"
                  value={values.fullName}
                  onChange={(e) => handleChange('fullName', e.target.value)}
                  placeholder="e.g. Ruwan Jayawardena"
                />
                {errors.fullName && <div className="error">{errors.fullName}</div>}
              </div>

              {/* NIC / Passport */}
              <div className={`field ${errors.nicOrPassport ? 'has-error' : ''}`}>
                <label>NIC / Passport Number</label>
                <input
                  type="text"
                  value={values.nicOrPassport}
                  onChange={(e) => handleChange('nicOrPassport', e.target.value)}
                  placeholder="123456789V or 200012345678"
                />
                <div className="hint">Used for official KYC identity verification.</div>
                {errors.nicOrPassport && <div className="error">{errors.nicOrPassport}</div>}
              </div>

              {/* Email & Mobile (take part in the two-column grid) */}
              <div style={{ display: 'contents' }}>
                <div className={`field ${errors.email ? 'has-error' : ''}`}>
                  <label>Email Address</label>
                  <input
                    type="email"
                    value={values.email}
                    onChange={(e) => handleChange('email', e.target.value)}
                    placeholder="name@business.com"
                  />
                  {errors.email && <div className="error">{errors.email}</div>}
                </div>

                <div className={`field ${errors.mobile ? 'has-error' : ''}`}>
                  <label>Mobile Number</label>
                  <input
                    type="tel"
                    value={values.mobile}
                    onChange={(e) => handleChange('mobile', e.target.value)}
                    placeholder="0771234567"
                  />
                  {errors.mobile && <div className="error">{errors.mobile}</div>}
                </div>
              </div>

              {/* Address */}
              <div className={`field span-all ${errors.address ? 'has-error' : ''}`}>
                <label>Residential / Business Address</label>
                <textarea
                  rows={3}
                  value={values.address}
                  onChange={(e) => handleChange('address', e.target.value)}
                  placeholder="Street address, City, Province"
                />
                {errors.address && <div className="error">{errors.address}</div>}
              </div>
              </div>
            </div>
          )}

          {/* ─── STEP 2: Business Details ─────────────────────────────────── */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ borderBottom: '1px solid var(--border, #1E293B)', paddingBottom: '0.75rem' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text, #F8FAFC)', margin: 0 }}>
                  Business Information
                </h2>
                <p style={{ color: 'var(--text-secondary, #94A3B8)', fontSize: '0.86rem', margin: '0.25rem 0 0' }}>
                  Provide company or sole proprietorship information for SaaS distribution agreements.
                </p>
              </div>

              <div className="form-grid-2" style={{ gap: '1.25rem 1.5rem' }}>
              <div className={`field ${errors.businessName ? 'has-error' : ''}`}>
                <label>Registered Business Name / Trade Name</label>
                <input
                  type="text"
                  value={values.businessName}
                  onChange={(e) => handleChange('businessName', e.target.value)}
                  placeholder="e.g. Apex Cloud Solutions (Pvt) Ltd"
                />
                {errors.businessName && <div className="error">{errors.businessName}</div>}
              </div>

              <div className={`field ${errors.businessRegistrationNo ? 'has-error' : ''}`}>
                <label>Business Registration Number (BRN)</label>
                <input
                  type="text"
                  value={values.businessRegistrationNo}
                  onChange={(e) => handleChange('businessRegistrationNo', e.target.value)}
                  placeholder="e.g. PV-123456 or W/12345"
                />
                {errors.businessRegistrationNo && <div className="error">{errors.businessRegistrationNo}</div>}
              </div>

              <div style={{ display: 'contents' }}>
                <div className={`field ${errors.businessPhone ? 'has-error' : ''}`}>
                  <label>Business Phone Number</label>
                  <input
                    type="tel"
                    value={values.businessPhone}
                    onChange={(e) => handleChange('businessPhone', e.target.value)}
                    placeholder="0112345678"
                  />
                  {errors.businessPhone && <div className="error">{errors.businessPhone}</div>}
                </div>

                <div className={`field ${errors.businessEmail ? 'has-error' : ''}`}>
                  <label>Business Invoicing Email</label>
                  <input
                    type="email"
                    value={values.businessEmail}
                    onChange={(e) => handleChange('businessEmail', e.target.value)}
                    placeholder="billing@company.lk"
                  />
                  {errors.businessEmail && <div className="error">{errors.businessEmail}</div>}
                </div>
              </div>

              <div className={`field span-all ${errors.businessAddress ? 'has-error' : ''}`}>
                <label>Registered Office Address</label>
                <textarea
                  rows={2}
                  value={values.businessAddress}
                  onChange={(e) => handleChange('businessAddress', e.target.value)}
                  placeholder="Physical office address"
                />
                {errors.businessAddress && <div className="error">{errors.businessAddress}</div>}
              </div>
              </div>
            </div>
          )}

          {/* ─── STEP 3: Bank Details ─────────────────────────────────────── */}
          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ borderBottom: '1px solid var(--border, #1E293B)', paddingBottom: '0.75rem' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text, #F8FAFC)', margin: 0 }}>
                  Bank Account & Payout Details
                </h2>
                <p style={{ color: 'var(--text-secondary, #94A3B8)', fontSize: '0.86rem', margin: '0.25rem 0 0' }}>
                  Commission earnings and payouts will be transferred directly to this account via CEFT/SLIPS.
                </p>
              </div>

              <div
                style={{
                  background: 'rgba(14, 165, 233, 0.08)',
                  border: '1px solid rgba(14, 165, 233, 0.2)',
                  borderRadius: '8px',
                  padding: '0.75rem 1rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.65rem',
                  fontSize: '0.84rem',
                  color: 'var(--primary-light, #38BDF8)',
                }}
              >
                <Lock size={16} style={{ flexShrink: 0 }} />
                <span>
                  Bank account details are stored using AES-256-GCM encryption and audited by platform security.
                </span>
              </div>

              <div className="form-grid-2" style={{ gap: '1.25rem 1.5rem' }}>
              <div className={`field ${errors.bankName ? 'has-error' : ''}`}>
                <label>Bank Name</label>
                <select
                  value={values.bankName}
                  onChange={(e) => handleChange('bankName', e.target.value)}
                >
                  {SRI_LANKA_BANKS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                {errors.bankName && <div className="error">{errors.bankName}</div>}
              </div>

              <div className={`field ${errors.branch ? 'has-error' : ''}`}>
                <label>Branch Name</label>
                <input
                  type="text"
                  value={values.branch}
                  onChange={(e) => handleChange('branch', e.target.value)}
                  placeholder="e.g. Colombo Fort or Kandy"
                />
                {errors.branch && <div className="error">{errors.branch}</div>}
              </div>

              <div className={`field ${errors.accountHolderName ? 'has-error' : ''}`}>
                <label>Account Holder Name</label>
                <input
                  type="text"
                  value={values.accountHolderName}
                  onChange={(e) => handleChange('accountHolderName', e.target.value)}
                  placeholder="As printed in bank passbook or statement"
                />
                {errors.accountHolderName && <div className="error">{errors.accountHolderName}</div>}
              </div>

              <div className={`field ${errors.accountNumber ? 'has-error' : ''}`}>
                <label>Account Number</label>
                <input
                  type="text"
                  value={values.accountNumber}
                  onChange={(e) => handleChange('accountNumber', e.target.value)}
                  placeholder="e.g. 1000123456"
                />
                {errors.accountNumber && <div className="error">{errors.accountNumber}</div>}
              </div>
              </div>
            </div>
          )}

          {/* ─── STEP 4: Review and Submit ─────────────────────────────────── */}
          {step === 4 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div style={{ borderBottom: '1px solid var(--border, #1E293B)', paddingBottom: '0.75rem' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text, #F8FAFC)', margin: 0 }}>
                  Review & Final Submission
                </h2>
                <p style={{ color: 'var(--text-secondary, #94A3B8)', fontSize: '0.86rem', margin: '0.25rem 0 0' }}>
                  Please review the details below before submitting your official partner partnership application.
                </p>
              </div>

              {/* Review Cards Grid (side by side on wide screens) */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1rem' }}>
                {/* Personal Review */}
                <div
                  style={{
                    background: 'var(--surface-hover)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '1rem',
                  }}
                >
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                    Personal Details
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '0.5rem', fontSize: '0.88rem' }}>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Name:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.fullName}</strong></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>NIC/Passport:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.nicOrPassport}</strong></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Email:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.email}</strong></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Mobile:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.mobile}</strong></div>
                  </div>
                </div>

                {/* Business Review */}
                <div
                  style={{
                    background: 'var(--surface-hover)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '1rem',
                  }}
                >
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                    Business Details
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '0.5rem', fontSize: '0.88rem' }}>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Business:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.businessName}</strong></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>BRN:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.businessRegistrationNo}</strong></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Phone:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.businessPhone}</strong></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Email:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.businessEmail}</strong></div>
                  </div>
                </div>

                {/* Bank Review (Masked Account Number) */}
                <div
                  style={{
                    background: 'var(--surface-hover)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '1rem',
                  }}
                >
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                    Bank Account (Masked)
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '0.5rem', fontSize: '0.88rem' }}>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Bank:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.bankName}</strong></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Branch:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.branch}</strong></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Holder:</span> <strong style={{ color: 'var(--text-heading)' }}>{values.accountHolderName}</strong></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Account:</span> <strong style={{ color: 'var(--text-heading)', fontFamily: 'monospace' }}>{maskedAccount()}</strong></div>
                  </div>
                </div>
              </div>

              {/* Terms Checkbox */}
              <div
                style={{
                  padding: '1rem',
                  borderRadius: '8px',
                  background: 'var(--surface-hover)',
                  border: errors.acceptTerms ? '1px solid var(--danger)' : '1px solid var(--border)',
                }}
              >
                <label style={{ display: 'flex', gap: '0.65rem', alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={values.acceptTerms}
                    onChange={(e) => handleChange('acceptTerms', e.target.checked)}
                    style={{ marginTop: '0.2rem', accentColor: 'var(--primary)' }}
                  />
                  <span style={{ fontSize: '0.88rem', color: 'var(--text)', lineHeight: '1.5' }}>
                    I agree to the <strong>Hexalyte Innovation Partner Terms and Partner Agreement</strong>. I confirm that all submitted business and banking information is accurate and authorized.
                  </span>
                </label>
                {errors.acceptTerms && <div className="error" style={{ marginTop: '0.4rem' }}>{errors.acceptTerms}</div>}
              </div>
            </div>
          )}

          {/* Action Navigation Buttons */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '2rem',
              paddingTop: '1.25rem',
              borderTop: '1px solid var(--border, #1E293B)',
            }}
          >
            {step > 1 ? (
              <button
                type="button"
                onClick={handleBack}
                disabled={submitting}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.55rem 1.1rem',
                  background: 'var(--surface, #111C2F)',
                  border: '1px solid var(--border, #1E293B)',
                  borderRadius: 'var(--radius, 8px)',
                  color: 'var(--text, #F8FAFC)',
                  fontWeight: 600,
                  fontSize: '0.88rem',
                  cursor: 'pointer',
                }}
              >
                <ArrowLeft size={16} />
                <span>Back</span>
              </button>
            ) : (
              <div />
            )}

            {step < 4 ? (
              <button
                key="continue-btn"
                type="button"
                onClick={handleNext}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.6rem 1.3rem',
                  background: 'var(--primary, #0EA5E9)',
                  border: 'none',
                  borderRadius: 'var(--radius, 8px)',
                  color: '#ffffff',
                  fontWeight: 600,
                  fontSize: '0.88rem',
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(14, 165, 233, 0.3)',
                }}
              >
                <span>Continue</span>
                <ArrowRight size={16} />
              </button>
            ) : (
              <button
                key="submit-btn"
                type="submit"
                disabled={submitting}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.65rem 1.5rem',
                  background: '#10B981',
                  border: 'none',
                  borderRadius: 'var(--radius, 8px)',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: '0.9rem',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 12px rgba(16, 185, 129, 0.35)',
                }}
              >
                {submitting ? (
                  <>
                    <span className="login-spinner" aria-hidden="true" />
                    <span>Submitting Application...</span>
                  </>
                ) : (
                  <>
                    <span>Submit Application</span>
                    <CheckCircle2 size={18} />
                  </>
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

export default function BecomeResellerPage() {
  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          <BecomeResellerContent user={user} />
        </main>
      )}
    </ResellerShell>
  )
}
