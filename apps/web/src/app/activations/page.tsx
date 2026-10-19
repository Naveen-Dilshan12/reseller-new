'use client'

import Link from 'next/link'
import { ResellerShell } from '@/components/ResellerShell'
import { ActivationList } from '@/components/activations/ActivationList'

export default function ActivationsPage() {
  return (
    <ResellerShell>
      {(user) => {
        const canActivate = user.permissions.includes('activations:create')

        return (
          <main className="container">
            {/* ── Main Activations Content with Embedded Translucent KPIs in Scenic Backdrop ── */}
            <ActivationList
              basePath="/activations"
              heroProps={{
                tag: 'REVENUE OPERATIONS',
                title: 'Paid Activations',
                subtitle: 'After the customer pays the subscription fee into the Hexalyte company bank account, submit the bank slip here for verification.',
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                ),
                actions: canActivate ? (
                  <Link
                    href="/activations/new"
                    className="btn small"
                    style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontWeight: 600 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                      <path d="m9 12 2 2 4-4" />
                    </svg>
                    <span>New Activation</span>
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
