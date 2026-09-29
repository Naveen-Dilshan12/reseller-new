'use client'

import { useAdminUser } from '@/lib/admin-context'
import { TrialList } from '@/components/trials/TrialList'

export default function AdminTrialsPage() {
  const admin = useAdminUser()
  return (
    <main className="container">
      <h1>Trial requests</h1>
      <p className="muted">
        Trials created by resellers through each SaaS&apos;s partner API. Failures caused by the integration (credentials,
        missing endpoint) are also sent to admins as notifications; see the product&apos;s integration log for details.
      </p>
      <div className="card">
        <TrialList showReseller canAct={admin.permissions.includes('trials:create')} />
      </div>
    </main>
  )
}
