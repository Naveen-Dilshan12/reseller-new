'use client'

import { AdminPageHeader } from '@/components/admin/AdminPageHeader'
import { ActivationList } from '@/components/activations/ActivationList'

export default function AdminActivationsPage() {
  return (
    <main className="container">
      <AdminPageHeader
        title="Activation requests"
        subtitle="Paid subscription requests submitted by partners with a bank slip. Verify the payment against the company bank statement, approve or reject, then activate the subscription through the SaaS."
      />
      <ActivationList basePath="/admin/activations" showReseller defaultStatus="PENDING_REVIEW,UNDER_REVIEW" />
    </main>
  )
}
