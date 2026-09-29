'use client'

import Link from 'next/link'
import { useAdminUser } from '@/lib/admin-context'
import { CommissionLedger } from '@/components/commissions/CommissionLedger'

export default function AdminCommissionsPage() {
  const admin = useAdminUser()
  return (
    <main className="container">
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>Commissions</h1>
        <span className="spacer" />
        <Link href="/admin/commissions/report" className="btn secondary">
          Monthly report
        </Link>
      </div>
      <p className="muted">
        Commissions are generated only from verified subscription payments. Approve pending entries; approved entries
        become payable after the refund hold period.
      </p>
      <div className="card">
        <CommissionLedger manage={admin.permissions.includes('commissions:manage')} showReseller initialStatus="PENDING" />
      </div>
    </main>
  )
}
