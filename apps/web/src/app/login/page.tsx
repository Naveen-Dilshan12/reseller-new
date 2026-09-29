'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ApiError } from '@/lib/api'
import { isPlatformUser, login } from '@/lib/auth'
import { Field } from '@/components/Field'

type Notice = { tone: 'error' | 'info' | 'warning'; title?: string; message: string }

function noticeFor(err: unknown): Notice {
  if (!(err instanceof ApiError)) return { tone: 'error', message: 'Could not reach the server. Please try again.' }
  switch (err.code) {
    case 'APPLICATION_PENDING':
      return { tone: 'info', title: 'Application pending approval', message: err.message }
    case 'APPLICATION_REJECTED':
      return { tone: 'warning', title: 'Application rejected', message: err.message }
    default:
      return { tone: 'error', message: err.message }
  }
}

export default function LoginPage() {
  const router = useRouter()
  const [values, setValues] = useState({ email: '', password: '' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setNotice(null)
    setLoading(true)
    try {
      const user = await login(values.email, values.password)
      router.replace(isPlatformUser(user) ? '/admin' : '/dashboard')
    } catch (err) {
      setNotice(noticeFor(err))
    } finally {
      setLoading(false)
    }
  }

  const fillCredentials = (email: string, pass: string) => {
    setValues({ email, password: pass })
  }

  return (
    <main className="container auth-box">
      <div
        style={{
          height: '4px',
          background: 'linear-gradient(90deg, #4f46e5 0%, #8b5cf6 50%, #d946ef 100%)',
          borderRadius: '8px 8px 0 0',
          marginBottom: '-4px',
        }}
      />
      <form className="card" onSubmit={submit} style={{ borderRadius: '0 0 12px 12px' }}>
        <div style={{ marginBottom: '1.25rem' }}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'var(--primary-gradient)',
                color: '#fff',
                fontSize: '1rem',
                fontWeight: 800,
              }}
            >
              H
            </span>
            Hexalyte Reseller
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            Central reseller & SaaS management platform.
          </p>
        </div>

        {notice && (
          <div className={`alert ${notice.tone}`}>
            {notice.title && <strong>{notice.title}. </strong>}
            {notice.message}
          </div>
        )}

        <Field
          label="Email address"
          name="email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={(_, v) => setValues((s) => ({ ...s, email: v }))}
          required
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={values.password}
          onChange={(_, v) => setValues((s) => ({ ...s, password: v }))}
          required
        />

        <button className="btn" type="submit" disabled={loading} style={{ width: '100%', marginTop: '0.5rem' }}>
          {loading ? 'Signing in…' : 'Sign in to platform'}
        </button>

        {/* Quick Demo Access Bar */}
        <div
          style={{
            marginTop: '1.5rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--border)',
          }}
        >
          <div className="small muted" style={{ marginBottom: '0.5rem', fontWeight: 600 }}>
            🚀 Instant Demo Logins:
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn secondary small"
              onClick={() => fillCredentials('admin@hexalyte.com', 'ChangeMe!12345')}
            >
              👑 Demo Admin
            </button>
            <button
              type="button"
              className="btn secondary small"
              onClick={() => fillCredentials('reseller@hexalyte.com', 'Demo12345!')}
            >
              💼 Demo Reseller
            </button>
          </div>
        </div>
      </form>

      <div style={{ textAlign: 'center', marginTop: '1rem' }}>
        <p className="muted small">
          Want to become an authorized reseller?{' '}
          <Link href="/register" style={{ fontWeight: 600 }}>
            Apply here
          </Link>
        </p>
      </div>
    </main>
  )
}
