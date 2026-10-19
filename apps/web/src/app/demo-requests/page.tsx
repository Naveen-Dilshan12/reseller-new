'use client'

import Link from 'next/link'
import { ResellerShell } from '@/components/ResellerShell'
import { DemoRequestList } from '@/components/demos/DemoRequestList'

export default function DemoRequestsPage() {
  return (
    <ResellerShell>
      {(user) => {
        const canCreate = user.permissions.includes('demos:create')
        return (
          <main className="container">
            <DemoRequestList
              basePath="/demo-requests"
              heroProps={{
                tag: 'SALES ENABLEMENT',
                title: 'Demo Requests',
                subtitle: 'Ask Hexalyte to manually create a demo shop in a SaaS product for a prospective customer.',
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M3 9h18" />
                    <path d="m9 15 2 2 4-4" />
                  </svg>
                ),
                actions: canCreate ? (
                  <Link href="/demo-requests/new" className="btn small" style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontWeight: 600 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    <span>New Demo Request</span>
                  </Link>
                ) : undefined,
              }}
            />
          </main>
        )
      }}
    </ResellerShell>
  )
}
