'use client'

import Link from 'next/link'
import { ResellerShell } from '@/components/ResellerShell'
import { TrialList } from '@/components/trials/TrialList'

export default function TrialsPage() {
  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          <div className="row" style={{ marginBottom: '1rem' }}>
            <h1 style={{ margin: 0 }}>Trial accounts</h1>
            <span className="spacer" />
            {user.permissions.includes('trials:create') && (
              <Link href="/trials/new" className="btn">
                New trial
              </Link>
            )}
          </div>
          <p className="muted">
            Trials are created directly in the Hexalyte SaaS. Paid subscriptions are activated by Hexalyte after payment
            verification.
          </p>
          <div className="card">
            <TrialList canAct={user.permissions.includes('trials:create')} />
          </div>
        </main>
      )}
    </ResellerShell>
  )
}
