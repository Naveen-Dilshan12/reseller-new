'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

export default function SubmittedPage() {
  const [application, setApplication] = useState<{ code: string; email: string } | null>(null)

  useEffect(() => {
    const raw = sessionStorage.getItem('hxr_application')
    if (raw) setApplication(JSON.parse(raw))
  }, [])

  return (
    <main className="container auth-box">
      <div className="card">
        <h1>Application submitted</h1>
        <div className="alert info">Your application is <strong>pending approval</strong>.</div>
        {application && (
          <p>
            Reference: <strong className="mono">{application.code}</strong>
          </p>
        )}
        <p className="muted">
          Our team will review your personal, business and bank details. Once approved, you can log in
          {application ? (
            <>
              {' '}
              with <strong>{application.email}</strong>
            </>
          ) : null}{' '}
          and the password you chose.
        </p>
        <Link className="btn" href="/login">
          Go to login
        </Link>
      </div>
    </main>
  )
}
