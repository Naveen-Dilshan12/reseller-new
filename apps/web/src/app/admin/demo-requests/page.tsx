'use client'

import { useAdminUser } from '@/lib/admin-context'
import { AdminPageHeader } from '@/components/admin/AdminPageHeader'
import { DemoRequestList } from '@/components/demos/DemoRequestList'

export default function AdminDemoRequestsPage() {
  const admin = useAdminUser()
  return (
    <main className="container">
      <AdminPageHeader
        title="Demo requests"
        subtitle="Manual demo shop requests submitted by partners. Review and approve or reject, add the customer welcome message, then confirm with the SaaS tenant ID once the demo shop exists in the SaaS console (nothing is created in the SaaS from here)."
      />
      <DemoRequestList
        basePath="/admin/demo-requests"
        showReseller
        defaultStatus="PENDING"
        adminActions={{ canReview: admin.permissions.includes('demos:review') }}
      />
    </main>
  )
}
