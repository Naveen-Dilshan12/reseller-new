'use client'

import Link from 'next/link'
import { ResellerShell } from '@/components/ResellerShell'
import { ActivationList } from '@/components/activations/ActivationList'

export default function ActivationsPage() {
  return (
    <ResellerShell>
      {(user) => (
        <main className="container">
          <div className="row">
            <h1>Paid activations</h1>
            <span className="spacer" />
            {user.permissions.includes('activations:create') && (
              <Link href="/activations/new" className="btn">
                New activation request
              </Link>
            )}
          </div>
          <p className="muted">
            After the customer pays the subscription fee into the Hexalyte company bank account, submit the bank slip here.
            Hexalyte verifies the payment and activates the subscription in the SaaS.
          </p>
          <div className="card">
            <ActivationList basePath="/activations" />
          </div>
        </main>
      )}
    </ResellerShell>
  )
}
