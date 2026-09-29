'use client'

import { ActivationList } from '@/components/activations/ActivationList'

export default function AdminActivationsPage() {
  return (
    <main className="container">
      <h1>Activation requests</h1>
      <p className="muted">
        Paid subscription requests submitted by resellers with a bank slip. Verify the payment against the company bank
        statement, approve or reject, then activate the subscription through the SaaS.
      </p>
      <div className="card">
        <ActivationList basePath="/admin/activations" showReseller defaultStatus="PENDING_REVIEW,UNDER_REVIEW" />
      </div>
    </main>
  )
}
