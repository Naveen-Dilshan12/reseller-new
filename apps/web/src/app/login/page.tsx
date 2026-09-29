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

  return (
    <main className="container auth-box">
      <form className="card" onSubmit={submit}>
        <h1>Hexalyte Reseller</h1>
        <p className="muted">Log in to your reseller or admin account.</p>
        {notice && (
          <div className={`alert ${notice.tone}`}>
            {notice.title && <strong>{notice.title}. </strong>}
            {notice.message}
          </div>
        )}
        <Field
          label="Email"
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
        <button className="btn" type="submit" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="muted small">
        Want to sell Hexalyte products? <Link href="/register">Apply to become a reseller</Link>
      </p>
    </main>
  )
}
