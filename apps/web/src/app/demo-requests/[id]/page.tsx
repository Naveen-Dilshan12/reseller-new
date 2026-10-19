'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { buildWhatsAppUrl, customerGreeting } from '@/lib/whatsapp'
import type { ResellerDemoRequest } from '@/lib/demo-types'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'
import { DemoHistory, DemoSteps, StatusBadge, WelcomeMessagePreview } from '@/components/demos/DemoRequestParts'

function Detail({ id, whatsappNumber }: { id: string; whatsappNumber: string | null }) {
  const submitted = useSearchParams().get('submitted') === '1'
  const [item, setItem] = useState<ResellerDemoRequest | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api<ResellerDemoRequest>(`/demo-requests/${id}`)
      .then(setItem)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the request'))
  }, [id])
  useEffect(load, [load])

  if (error && !item) return <div className="alert error">{error}</div>
  if (!item) return <p className="muted">Loading…</p>

  return (
    <>
      <PageHero
        tag="DEMO REQUEST"
        title={item.businessName}
        subtitle={`Demo request for ${item.product.name}`}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18" />
            <path d="m9 15 2 2 4-4" />
          </svg>
        }
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
            <StatusBadge status={item.status} />
            <Link href="/demo-requests" className="btn secondary small" style={{ display: 'inline-flex', gap: '0.45rem', alignItems: 'center', fontWeight: 600 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              <span>Back to Demo Requests</span>
            </Link>
          </div>
        }
      />

      <div>
        {submitted && item.status === 'PENDING' && (
          <div className="alert success" style={{ marginBottom: '1.25rem' }}>
            Submitted. Hexalyte will review this request and notify you.
          </div>
        )}
        {error && <div className="alert error" style={{ marginBottom: '1.25rem' }}>{error}</div>}
        <DemoSteps status={item.status} />

        {item.status === 'REJECTED' && (
          <div className="alert error" style={{ marginTop: '1.25rem' }}>
            <strong>Rejected:</strong> {item.rejectionReason}
          </div>
        )}
        {item.status === 'APPROVED' && (
          <div className="alert info" style={{ marginTop: '1.25rem' }}>
            Approved. Hexalyte is creating the demo shop in {item.product.name}.
          </div>
        )}

        {(item.status === 'DEMO_CREATED' || item.status === 'CONFIRMED') && item.welcomeMessage && (
          <div style={{ marginTop: '1.25rem' }}>
            <WelcomeMessagePreview message={item.welcomeMessage} whatsappLink={item.whatsappLink} senderNumber={whatsappNumber} />
          </div>
        )}
        {item.status === 'CONFIRMED' && (
          <div className="alert success" style={{ marginTop: '1.25rem' }}>
            Confirmed — this customer is now in <Link href="/customers">My Customers</Link> as a trial account. Activate it from there when they are ready to pay.
          </div>
        )}

        <div className="grid-2 gap" style={{ marginTop: '1.25rem' }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Request</h2>
            <dl className="details">
              <dt>Business / customer</dt>
              <dd>{item.businessName}</dd>
              <dt>Contact</dt>
              <dd>
                {item.contactName}
                <div className="muted small">
                  {item.contactEmail} · {item.contactPhone}
                </div>
                {(() => {
                  const url = buildWhatsAppUrl(item.contactPhone, customerGreeting(item.contactName))
                  return url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="btn small secondary" style={{ marginTop: '0.4rem' }}>
                      Contact on WhatsApp
                    </a>
                  ) : (
                    <div className="muted small">No valid WhatsApp number on file.</div>
                  )
                })()}
              </dd>
              <dt>Product</dt>
              <dd>{item.product.name}</dd>
              <dt>Submitted</dt>
              <dd>{new Date(item.submittedAt).toLocaleString()}</dd>
              {item.notes && (
                <>
                  <dt>Notes</dt>
                  <dd>{item.notes}</dd>
                </>
              )}
            </dl>
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>History</h2>
            <DemoHistory history={item.history} />
          </div>
        </div>
      </div>
    </>
  )
}

function Page() {
  const { id } = useParams<{ id: string }>()
  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Detail id={id} whatsappNumber={user.whatsappNumber} />
          </Suspense>
        </main>
      )}
    </ResellerShell>
  )
}

export default Page
