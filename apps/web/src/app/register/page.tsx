'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { Field } from '@/components/Field'

type Values = Record<string, string>

interface FieldDef {
  name: string
  label: string
  type?: string
  hint?: string
  multiline?: boolean
  wide?: boolean
  autoComplete?: string
  validate: (v: string, all: Values) => string | undefined
}

const strip = (v: string) => v.replace(/[\s-]/g, '')
const required = (label: string, min = 2) => (v: string) => (v.trim().length < min ? `${label} is required` : undefined)
const emailRule = (v: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? undefined : 'Enter a valid email address')
const mobileRule = (v: string) => (/^(\+94|0)7\d{8}$/.test(strip(v)) ? undefined : 'Enter a valid mobile number, e.g. 0771234567')
const phoneRule = (v: string) => (/^(\+94|0)\d{9}$/.test(strip(v)) ? undefined : 'Enter a valid phone number, e.g. 0112345678')

const STEPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Personal details',
    fields: [
      { name: 'personal.fullName', label: 'Full name', autoComplete: 'name', validate: required('Full name', 3) },
      {
        name: 'personal.nicOrPassport',
        label: 'NIC / Passport number',
        hint: 'e.g. 123456789V, 200012345678 or N1234567',
        validate: (v) =>
          /^(\d{9}[VX]|\d{12}|[A-Z][A-Z0-9]{5,11})$/.test(strip(v).toUpperCase()) ? undefined : 'Enter a valid NIC or passport number',
      },
      { name: 'personal.email', label: 'Email', type: 'email', autoComplete: 'email', hint: 'Used to log in', validate: emailRule },
      { name: 'personal.mobile', label: 'Mobile number', type: 'tel', autoComplete: 'tel', validate: mobileRule },
      { name: 'personal.address', label: 'Address', multiline: true, wide: true, validate: required('Address', 5) },
    ],
  },
  {
    title: 'Business details',
    fields: [
      { name: 'business.businessName', label: 'Business name', autoComplete: 'organization', validate: required('Business name') },
      {
        name: 'business.businessRegistrationNo',
        label: 'Business registration number',
        validate: (v) =>
          /^[A-Z0-9][A-Z0-9 /-]{2,29}$/.test(v.trim().toUpperCase()) ? undefined : 'Enter a valid business registration number',
      },
      { name: 'business.businessPhone', label: 'Business phone', type: 'tel', validate: phoneRule },
      { name: 'business.businessEmail', label: 'Business email', type: 'email', validate: emailRule },
      { name: 'business.businessAddress', label: 'Business address', multiline: true, wide: true, validate: required('Business address', 5) },
    ],
  },
  {
    title: 'Bank details',
    fields: [
      { name: 'bank.bankName', label: 'Bank name', validate: required('Bank name') },
      { name: 'bank.branch', label: 'Branch', validate: required('Branch') },
      { name: 'bank.accountHolderName', label: 'Account holder name', validate: required('Account holder name', 3) },
      {
        name: 'bank.accountNumber',
        label: 'Account number',
        autoComplete: 'off',
        hint: 'Stored encrypted. Used only for commission payouts.',
        validate: (v) => (/^\d{6,20}$/.test(strip(v)) ? undefined : 'Account number must be 6-20 digits'),
      },
    ],
  },
  {
    title: 'Account & review',
    fields: [
      {
        name: 'password',
        label: 'Password',
        type: 'password',
        autoComplete: 'new-password',
        hint: 'At least 10 characters with upper case, lower case and a number',
        validate: (v) =>
          v.length >= 10 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)
            ? undefined
            : 'Use at least 10 characters with upper case, lower case and a number',
      },
      {
        name: 'confirmPassword',
        label: 'Confirm password',
        type: 'password',
        autoComplete: 'new-password',
        validate: (v, all) => (v && v === all.password ? undefined : 'Passwords do not match'),
      },
    ],
  },
]

const ALL_FIELDS = STEPS.flatMap((s) => s.fields)

function toPayload(values: Values, acceptTerms: boolean) {
  const payload: Record<string, unknown> = { acceptTerms }
  for (const [key, value] of Object.entries(values)) {
    const [group, field] = key.split('.')
    if (field) {
      payload[group] = { ...(payload[group] as object), [field]: value }
    } else {
      payload[group] = value
    }
  }
  return payload
}

function maskAccount(v: string) {
  const digits = strip(v)
  return digits.length > 4 ? `•••• ${digits.slice(-4)}` : digits
}

export default function RegisterPage() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [values, setValues] = useState<Values>(() => Object.fromEntries(ALL_FIELDS.map((f) => [f.name, ''])))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const onChange = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }))
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: '' }))
  }

  const validateStep = (index: number) => {
    const stepErrors: Record<string, string> = {}
    for (const f of STEPS[index].fields) {
      const err = f.validate(values[f.name] ?? '', values)
      if (err) stepErrors[f.name] = err
    }
    setErrors((prev) => ({ ...prev, ...stepErrors }))
    return Object.keys(stepErrors).length === 0
  }

  const next = () => {
    if (validateStep(step)) setStep((s) => s + 1)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (step < STEPS.length - 1) return next()
    if (!STEPS.every((_, i) => validateStep(i))) return
    if (!acceptTerms) {
      setFormError('You must accept the reseller terms to continue.')
      return
    }

    setSubmitting(true)
    try {
      const result = await api<{ code: string; email: string }>('/reseller-registration', {
        method: 'POST',
        body: JSON.stringify(toPayload(values, acceptTerms)),
      })
      sessionStorage.setItem('hxr_application', JSON.stringify(result))
      router.push('/register/submitted')
    } catch (err) {
      if (err instanceof ApiError) {
        const fieldErrors = err.fieldErrors()
        setErrors(fieldErrors)
        const firstStep = STEPS.findIndex((s) => s.fields.some((f) => fieldErrors[f.name]))
        if (firstStep >= 0) setStep(firstStep)
        setFormError(err.message === 'Validation error' ? 'Please correct the highlighted fields.' : err.message)
      } else {
        setFormError('Could not reach the server. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const current = STEPS[step]

  return (
    <main className="container narrow">
      <h1>Become a Hexalyte reseller</h1>
      <p className="muted">
        Submit your application. Our team will review it and you can log in once it has been approved.
      </p>

      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s.title} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}>
            {i + 1}. {s.title}
          </div>
        ))}
      </div>

      <form className="card" onSubmit={submit} noValidate>
        <h2>{current.title}</h2>
        {formError && <div className="alert error">{formError}</div>}

        <div className="grid-2">
          {current.fields.map((f) => (
            <Field
              key={f.name}
              name={f.name}
              label={f.label}
              type={f.type ?? 'text'}
              hint={f.hint}
              multiline={f.multiline}
              autoComplete={f.autoComplete}
              className={f.wide ? 'span-2' : undefined}
              value={values[f.name]}
              error={errors[f.name]}
              onChange={onChange}
            />
          ))}
        </div>

        {step === STEPS.length - 1 && (
          <>
            <h2>Review</h2>
            <dl className="details" style={{ marginBottom: '1rem' }}>
              <dt>Full name</dt>
              <dd>{values['personal.fullName']}</dd>
              <dt>NIC / Passport</dt>
              <dd>{values['personal.nicOrPassport']}</dd>
              <dt>Email</dt>
              <dd>{values['personal.email']}</dd>
              <dt>Business</dt>
              <dd>
                {values['business.businessName']} ({values['business.businessRegistrationNo']})
              </dd>
              <dt>Bank account</dt>
              <dd>
                {values['bank.bankName']} – {values['bank.branch']}, {values['bank.accountHolderName']},{' '}
                <span className="mono">{maskAccount(values['bank.accountNumber'])}</span>
              </dd>
            </dl>
            <label className="row small" style={{ marginBottom: '1rem' }}>
              <input type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} />
              I confirm these details are accurate and accept the Hexalyte reseller terms.
            </label>
          </>
        )}

        <div className="row">
          {step > 0 && (
            <button type="button" className="btn secondary" onClick={() => setStep((s) => s - 1)} disabled={submitting}>
              Back
            </button>
          )}
          <span className="spacer" />
          <button type="submit" className="btn" disabled={submitting}>
            {step < STEPS.length - 1 ? 'Continue' : submitting ? 'Submitting…' : 'Submit application'}
          </button>
        </div>
      </form>

      <p className="muted small">
        Already registered? <Link href="/login">Log in</Link>
      </p>
    </main>
  )
}
