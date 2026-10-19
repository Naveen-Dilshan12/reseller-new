'use client'

import Link from 'next/link'
import { ResellerShell } from '@/components/ResellerShell'
import { TrialList } from '@/components/trials/TrialList'

export default function TrialsPage() {
  return (
    <ResellerShell>
      {(user) => {
        const canCreate = user.permissions.includes('trials:create')

        return (
          <main className="container">
            {/* ── Main Trials Content with Embedded Translucent KPIs in Scenic Backdrop ── */}
            <TrialList
              canAct={canCreate}
              heroProps={{
                tag: 'TRIAL OPERATIONS',
                title: 'Free Trials',
                subtitle: 'Provision, monitor, and manage zero-commitment client trial accounts directly across Hexalyte SaaS products.',
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                ),
                actions: canCreate ? (
                  <Link
                    href="/trials/new"
                    className="btn small"
                    style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontWeight: 600 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    <span>New Trial</span>
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
