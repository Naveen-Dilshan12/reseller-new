'use client'

import { AdminPageHeader } from '@/components/admin/AdminPageHeader'
import { NotificationInbox } from '@/components/notifications/NotificationInbox'

export default function NotificationsPage() {
  return (
    <main className="container">
      <AdminPageHeader title="Notifications" subtitle="Alerts about applications, activations, integration failures and demo requests." />
      <NotificationInbox />
    </main>
  )
}
